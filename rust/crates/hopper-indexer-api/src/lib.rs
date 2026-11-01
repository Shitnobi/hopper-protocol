//! # hopper-indexer-api — REST + ingest layer over the pure indexer
//! (Workstreams B3+B4)
//!
//! Thin axum wrapper around [`hopper_indexer::Indexer`]. The pure core
//! stays network-free and Android-checkable; this crate owns HTTP, JSON
//! DTOs, PNG art rendering, the bitcoind ZMQ/RPC ingest wire, and
//! snapshot persistence.
//!
//! Ingest paths (both funnel through the same `wire::to_block`
//! conversion and the same write lock):
//! * `POST /v1/admin/block` — operator/debug wire;
//! * the ZMQ `hashblock` subscriber (`zmq.rs`) — production wire,
//!   driving [`sync::sync_to_tip`] against bitcoind RPC.
//!
//! Concurrency: one `std::sync::RwLock<Indexer>`. Reads serialize over
//! BTreeMaps; writes (block ingest, reorg rollback) hold the lock for
//! the state-machine replay — and, on the ZMQ path, for the block
//! fetches of a sync pass. Acceptable at this scale; a future
//! walk-outside/apply-inside split is a B5+ optimization.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use hopper_core::satmath::SatRange;
use hopper_indexer::state_machine::{Indexer, IndexerError};
use hopper_indexer::types::ChainEvent;
#[cfg(feature = "redb")]
use hopper_indexer::types::UtxoEntry;

/// Events kept in the core's in-memory tail (durable segments hold the
/// rest). 4096 events is a few hundred KiB — enough for SSE/live reads
/// and for restart reconciliation.
pub const EVENT_TAIL: usize = 4096;

pub mod dto;
pub mod engine;
pub mod eventlog;
pub mod mempool;
pub mod metrics;
pub mod ord;
pub mod persist;
pub mod routes;
pub mod rpc;
pub mod sse;
pub mod sync;
pub mod wire;
pub mod zmq;

/// Leaderboard cache key: tip height + hash (a same-height reorg must
/// rebuild the order).
type LeaderboardKey = (Option<u32>, Option<[u8; 32]>);
/// One materialised order per tip.
type LeaderboardCache = Mutex<Option<(LeaderboardKey, Arc<Vec<u64>>)>>;

/// What chain this deployment is serving. A wallet compares it against
/// its own Electrum view before trusting any "this coin is not yours"
/// answer: a mismatched indexer would otherwise make every frog look
/// sent away (FIX_CONSENSUS G4/A6).
#[derive(Clone, Debug, Default)]
pub struct ChainIdentity {
    /// bitcoind's `getblockchaininfo.chain`: `main`, `test`, `testnet4`,
    /// `signet`, `regtest`.
    pub network: Option<String>,
    /// Display-order hex of block 0, when known.
    pub genesis: Option<String>,
}

/// Shared API state: the indexer behind a RwLock, plus its snapshot
/// store (persistence is part of the state's lifecycle, not a route's).
pub struct ApiState {
    indexer: RwLock<engine::Engine>,
    snapshots: persist::SnapshotStore,
    /// Append-only event segments (P1.4). `None` in tests/operator-only
    /// runs: the endpoint then serves the in-memory tail only.
    events: Option<Mutex<eventlog::EventStore>>,
    /// Ingest/protocol metrics (B4 leftovers; `/metrics`).
    pub metrics: metrics::Metrics,
    /// Push bus for SSE subscribers (`/v1/events/stream`). Ingest
    /// paths publish while holding the indexer write lock — `send` is
    /// non-blocking.
    events_tx: tokio::sync::broadcast::Sender<sse::PushMessage>,
    /// Undo-journal retention in heights beyond the retained chain. The
    /// ingest path prunes below `tip - undo_retain` at checkpoints.
    undo_retain: u32,
    /// Event segments to keep (`0` = unlimited). Pruned at 64-block
    /// checkpoints; events are re-derivable, so this bounds disk only.
    event_retain: usize,
    /// Optional durable state mirror (P2.3d-4d). When present, every
    /// accepted block's after-images and undo journal are committed in
    /// one transaction; rollbacks undo the journal in reverse. The
    /// in-memory indexer stays the consensus authority.
    #[cfg(feature = "redb")]
    durable: Option<std::sync::Arc<hopper_indexer::store::redb_store::RedbStore>>,
    /// The bitcoind RPC endpoint, when configured — used by the
    /// mempool preview (`/v1/mempool`) and fee suggestions
    /// (`/v1/fees`). Set by the binary from env; absent in tests and
    /// operator-only setups.
    rpc: RwLock<Option<std::sync::Arc<rpc::BitcoinRpc>>>,
    /// Optional ord server used to seed coins the indexer has not seen
    /// (notably coinbase-descended funding coins). See `ord.rs`.
    ord: Option<ord::OrdClient>,
    /// Leaderboard order materialised per tip: `(height, hash) → sats`.
    /// The ranking is a pure function of the state, so a new tip (or a
    /// same-height reorg) is the only invalidation key. Bounded to one
    /// entry.
    leaderboard: LeaderboardCache,
    /// The chain this deployment ingests (published on `/v1/params`).
    chain: RwLock<ChainIdentity>,
    /// Per-caller public-route budget. Entries are pruned on access.
    rate: Mutex<HashMap<String, (Instant, u32)>>,
    /// Bearer token required for `/v1/admin/*` when configured.
    ///
    /// `None` means "open", which [`serve`] only allows on a loopback
    /// bind: an indexer must never expose block injection, rollback or
    /// seeding to the network (see `frogger-pwa-assessment` §STOP). Set
    /// it from `HOPPER_ADMIN_TOKEN`.
    admin_token: Option<String>,
}

pub type SharedState = Arc<ApiState>;

impl ApiState {
    /// Require `Authorization: Bearer <token>` on the admin routes.
    #[must_use]
    pub fn with_admin_token(mut self, token: impl Into<String>) -> Self {
        let token = token.into();
        self.admin_token = (!token.is_empty()).then_some(token);
        self
    }

    /// The configured admin token, if any.
    pub fn admin_token(&self) -> Option<&str> {
        self.admin_token.as_deref()
    }

    /// Configure the lazy sat-range oracle. An empty URL disables it.
    #[must_use]
    pub fn with_ord_url(mut self, url: impl Into<String>) -> Self {
        let url = url.into();
        let url = url.trim();
        self.ord = (!url.is_empty()).then(|| ord::OrdClient::new(url));
        self
    }

    /// The configured ord oracle, if any.
    pub fn ord(&self) -> Option<&ord::OrdClient> {
        self.ord.as_ref()
    }

    /// Seed a coin discovered from ord. Unlike the admin seed path this
    /// is called with a live `/v1/utxo` request, so it must update the
    /// durable mirror too. `Engine::Store` persists its own seeds; a
    /// memory engine with a mirror needs the coin written separately.
    pub fn seed_utxo(&self, outpoint: hopper_indexer::types::OutPoint, ranges: Vec<SatRange>) {
        #[cfg(feature = "redb")]
        let value: u64 = ranges.iter().map(|r| r.len()).sum();
        #[cfg(feature = "redb")]
        let entry = UtxoEntry {
            value,
            ranges: ranges.clone(),
            frogs: Default::default(),
        };
        #[cfg(feature = "redb")]
        let store_engine;
        {
            let mut idx = self.indexer.write().expect("indexer lock poisoned");
            #[cfg(feature = "redb")]
            {
                store_engine = idx.is_store();
            }
            idx.seed_utxo(outpoint, ranges);
        }
        #[cfg(feature = "redb")]
        if !store_engine {
            if let Some(store) = &self.durable {
                if let Err(e) = store.seed_coin(outpoint, entry) {
                    eprintln!(
                        "[ord] durable seed {}:{}: {e}",
                        crate::dto::hex_display(&outpoint.txid),
                        outpoint.vout
                    );
                }
            }
        }
    }

    pub fn new(indexer: Indexer) -> Self {
        Self::with_snapshots(indexer, persist::SnapshotStore::disabled())
    }

    pub fn with_snapshots(indexer: Indexer, snapshots: persist::SnapshotStore) -> Self {
        Self::with_engine(engine::Engine::memory(indexer), snapshots)
    }

    /// Construct around an explicit engine shape (memory or store-backed).
    pub fn with_engine(engine: engine::Engine, snapshots: persist::SnapshotStore) -> Self {
        Self {
            indexer: RwLock::new(engine),
            snapshots,
            events: None,
            metrics: metrics::Metrics::new(),
            events_tx: tokio::sync::broadcast::channel(1024).0,
            undo_retain: 288 + 6,
            event_retain: 0,
            #[cfg(feature = "redb")]
            durable: None,
            rpc: RwLock::new(None),
            ord: None,
            chain: RwLock::new(ChainIdentity::default()),
            leaderboard: Mutex::new(None),
            rate: Mutex::new(HashMap::new()),
            admin_token: None,
        }
    }

    /// Publish the chain identity (network label + genesis), read by
    /// `/v1/params`. Absent fields are honest: "this deployment did not
    /// tell us".
    pub fn set_chain_identity(&self, network: Option<String>, genesis: Option<String>) {
        let mut chain = self.chain.write().expect("chain lock poisoned");
        if network.is_some() {
            chain.network = network;
        }
        if genesis.is_some() {
            chain.genesis = genesis;
        }
    }

    /// The published chain identity.
    pub fn chain_identity(&self) -> ChainIdentity {
        self.chain.read().expect("chain lock poisoned").clone()
    }

    /// Like [`ApiState::with_persistence`], around an explicit engine.
    pub fn with_persistence_engine(
        engine: engine::Engine,
        snapshots: persist::SnapshotStore,
        events: eventlog::EventStore,
    ) -> Self {
        let mut state = Self::with_engine(engine, snapshots);
        state.events = Some(Mutex::new(events));
        state
    }

    /// The production constructor: state snapshots plus durable event
    /// segments.
    pub fn with_persistence(
        indexer: Indexer,
        snapshots: persist::SnapshotStore,
        events: eventlog::EventStore,
    ) -> Self {
        let mut state = Self::with_snapshots(indexer, snapshots);
        state.events = Some(Mutex::new(events));
        state
    }

    /// Attach a durable state mirror. A fresh store is bootstrapped with
    /// the indexer's current image, so the mirror starts in lockstep.
    #[cfg(feature = "redb")]
    pub fn attach_durable(
        &mut self,
        store: hopper_indexer::store::redb_store::RedbStore,
    ) -> Result<(), hopper_indexer::store::StoreError> {
        if hopper_indexer::store::StateView::tip(&store)?.0.is_none() {
            let idx = self.indexer.get_mut().expect("indexer lock poisoned");
            let state = idx
                .state()
                .expect("attach_durable is the mirror path (memory engine)");
            store.save_state(state)?;
            // The parameter commitment is part of the state identity: the
            // mirror MUST carry its engine's config or the two roots
            // diverge on the first read.
            store.set_params_hash(&hopper_indexer::store::StateView::params_hash(state)?)?;
        }
        self.durable = Some(std::sync::Arc::new(store));
        Ok(())
    }

    /// Share an already store-backed engine's store with the read paths.
    #[cfg(feature = "redb")]
    pub fn attach_store(
        &mut self,
        store: std::sync::Arc<hopper_indexer::store::redb_store::RedbStore>,
    ) {
        self.durable = Some(store);
    }

    /// Replace the engine with a store-backed one over `store`, and use
    /// the same handle for the read-through paths. The engine commits each
    /// block itself, so there is no separate mirror to feed.
    #[cfg(feature = "redb")]
    pub fn attach_store_engine(
        &mut self,
        store: std::sync::Arc<hopper_indexer::store::redb_store::RedbStore>,
        config: hopper_indexer::state_machine::IndexerConfig,
        seeds: Vec<(
            hopper_indexer::types::OutPoint,
            Vec<hopper_core::satmath::SatRange>,
        )>,
    ) -> Result<(), hopper_indexer::store::StoreError> {
        let engine = engine::Engine::store(std::sync::Arc::clone(&store), config, seeds)?;
        *self.indexer.get_mut().expect("indexer lock poisoned") = engine;
        self.durable = Some(store);
        Ok(())
    }

    /// The mirror's state image, when a mirror is attached. Used by tests
    /// and ops checks to assert the store tracks the engine.
    #[cfg(feature = "redb")]
    pub fn durable_image(
        &self,
    ) -> Result<Option<hopper_indexer::state_machine::IndexState>, hopper_indexer::store::StoreError>
    {
        let Some(store) = &self.durable else {
            return Ok(None);
        };
        let config = self.read().config().clone();
        Ok(Some(store.load_state(config)?))
    }

    /// The ingest target for [`sync::sync_to_tip`]: memory-only, or the
    /// engine plus a locked durable mirror.
    pub fn sync_target<'a>(&'a self, indexer: &'a mut engine::Engine) -> SyncTarget<'a> {
        #[cfg(feature = "redb")]
        if !indexer.is_store() {
            if let Some(store) = &self.durable {
                return SyncTarget::Durable {
                    indexer,
                    store: std::sync::Arc::clone(store),
                };
            }
        }
        SyncTarget::Memory(indexer)
    }

    /// Retain this many undo journals beyond the tip (rollback window).
    pub fn set_undo_retention(&mut self, blocks: u32) {
        self.undo_retain = blocks;
    }

    /// Keep at most this many event segments (`0` = keep all). Events are
    /// re-derivable from chain, so this is a disk bound, not state.
    pub fn set_event_retention(&mut self, keep: usize) {
        self.event_retain = keep;
    }

    /// Delete the oldest event segments beyond `keep`. Returns how many
    /// were removed (0 when nothing was pruned or pruning is off).
    pub fn prune_events(&self, keep: usize) -> usize {
        if keep == 0 {
            return 0;
        }
        match &self.events {
            Some(store) => match store
                .lock()
                .expect("event store lock")
                .prune_to_segments(keep)
            {
                Ok(n) => n,
                Err(e) => {
                    eprintln!("[events] prune failed: {e}");
                    0
                }
            },
            None => 0,
        }
    }

    /// Shared read access to the durable mirror (MVCC: redb readers do
    /// not block the ingest writer for long). `None` when no mirror is
    /// attached.
    #[cfg(feature = "redb")]
    pub fn durable_store_read(
        &self,
    ) -> Option<std::sync::Arc<hopper_indexer::store::redb_store::RedbStore>> {
        self.durable.clone()
    }

    /// Persist the retained hash window (call at checkpoints or on
    /// shutdown). Cheap: one meta row.
    #[cfg(feature = "redb")]
    pub fn flush_durable(&self, idx: &engine::Engine) {
        if let Some(store) = &self.durable {
            if let Err(e) = store.save_retained_heights(&idx.retained_heights()) {
                eprintln!("[durable] retained heights: {e}");
            }
        }
    }

    /// The mirror's retained undo window, when attached.
    #[cfg(feature = "redb")]
    pub fn durable_undo_range(
        &self,
    ) -> Result<Option<(u32, u32)>, hopper_indexer::store::StoreError> {
        let Some(store) = &self.durable else {
            return Ok(None);
        };
        store.undo_range()
    }

    /// Apply one block: the engine first, then the mirror batch + journal.
    /// Without a mirror this is exactly [`Indexer::apply_block`].
    pub fn commit_block(
        &self,
        idx: &mut engine::Engine,
        block: hopper_indexer::types::Block,
    ) -> Result<hopper_indexer::types::BlockReport, ApiError> {
        #[cfg(feature = "redb")]
        if idx.is_store() {
            // The engine writes through the store itself (one transaction
            // per block); the read path shares that same handle.
            return Ok(idx.apply_block(block)?);
        }
        #[cfg(feature = "redb")]
        if let Some(store) = &self.durable {
            let (report, effects, write) = idx.apply_block_recorded(block)?;
            store
                .commit_block_with_undo(&write, &effects)
                .map_err(|e| ApiError::Internal(format!("durable commit: {e}")))?;
            // Crash-injection failpoint (debug builds): die *after* the
            // store transaction and *before* any in-memory bookkeeping.
            // Restart must recover the committed block exactly once.
            #[cfg(debug_assertions)]
            if std::env::var_os("HOPPER_TEST_ABORT_AFTER_COMMIT").is_some() {
                std::process::abort();
            }
            // Finality pruning: undo rows are only needed for rollbacks
            // within the retained window. Chunked so ingest pays for it
            // rarely (one extra transaction every 64 blocks).
            if let Some(tip) = idx.tip_height() {
                if tip % 64 == 0 {
                    let below = tip.saturating_sub(self.undo_retain);
                    if let Err(e) = store.trim_undo_below(below) {
                        eprintln!("[durable] undo trim failed: {e}");
                    }
                    if let Err(e) = store.save_retained_heights(&idx.retained_heights()) {
                        eprintln!("[durable] retained heights: {e}");
                    }
                    let keep = self.event_retain;
                    if keep > 0 {
                        self.prune_events(keep);
                    }
                }
            }
            return Ok(report);
        }
        Ok(idx.apply_block(block)?)
    }

    /// Roll back `n` blocks, undoing the mirror's journals in reverse.
    pub fn rollback_blocks(&self, idx: &mut engine::Engine, n: usize) -> Result<(), ApiError> {
        #[cfg(feature = "redb")]
        if idx.is_store() {
            return Ok(idx.rollback(n)?);
        }
        #[cfg(feature = "redb")]
        if let Some(store) = &self.durable {
            let tip = idx
                .tip_height()
                .ok_or_else(|| ApiError::Conflict("indexer has no tip".into()))?;
            let n32 =
                u32::try_from(n).map_err(|_| ApiError::BadRequest("rollback too large".into()))?;
            if n32 == 0 {
                return Ok(());
            }
            let from = tip
                .checked_sub(n32 - 1)
                .ok_or_else(|| ApiError::Conflict("rollback below genesis".into()))?;
            let mut journals = Vec::with_capacity(n);
            {
                for height in from..=tip {
                    let effects = store
                        .undo(height)
                        .map_err(|e| ApiError::Internal(format!("undo journal: {e}")))?
                        .ok_or_else(|| {
                            ApiError::Conflict(format!(
                                "undo journal for height {height} is not retained \
                                 (kept tip - {retain}); re-sync from an older checkpoint \
                                 or reindex",
                                retain = self.undo_retain
                            ))
                        })?;
                    journals.push(effects);
                }
            }
            for effects in journals.iter().rev() {
                idx.undo_top(effects)
                    .map_err(|e| ApiError::Internal(format!("engine undo: {e}")))?;
                store
                    .apply_inverse(effects)
                    .map_err(|e| ApiError::Internal(format!("durable undo: {e}")))?;
            }
            if let Err(e) = store.save_retained_heights(&idx.retained_heights()) {
                eprintln!("[durable] retained heights: {e}");
            }
            return Ok(());
        }
        idx.rollback(n)?;
        Ok(())
    }

    /// Append events to the durable log (no-op without a store).
    pub fn append_events(&self, events: &[ChainEvent]) {
        if let Some(store) = &self.events {
            if let Err(e) = store.lock().expect("event store lock").append(events) {
                eprintln!("[events] append failed: {e}");
            }
        }
    }

    /// Append any events the store does not already have. The store's
    /// last height is the dedupe key: a block's events are written in
    /// one call, so all-or-nothing per height.
    pub fn append_events_after_stored(&self, events: &[ChainEvent]) {
        let Some(store) = &self.events else {
            return;
        };
        let mut store = store.lock().expect("event store lock");
        let last = store.last_height();
        let missing: Vec<ChainEvent> = events
            .iter()
            .filter(|e| last.is_none_or(|h| e.height > h))
            .cloned()
            .collect();
        if let Err(e) = store.append(&missing) {
            eprintln!("[events] append failed: {e}");
        }
    }

    /// Drop stored events above `height` (after a rollback).
    pub fn truncate_events(&self, height: u32) {
        if let Some(store) = &self.events {
            if let Err(e) = store
                .lock()
                .expect("event store lock")
                .truncate_above(height)
            {
                eprintln!("[events] truncate failed: {e}");
            }
        }
    }

    /// The last `n` events from storage, if a store is configured.
    pub fn event_tail(&self, n: usize) -> Option<Vec<ChainEvent>> {
        let store = self.events.as_ref()?;
        match store.lock().expect("event store lock").tail(n) {
            Ok(events) => Some(events),
            Err(e) => {
                eprintln!("[events] tail read failed: {e}");
                None
            }
        }
    }

    /// Reconcile the store with a restored snapshot: drop events the
    /// snapshot does not cover (uncommitted after a crash), then append
    /// any snapshot-tail events the store is missing (a failed append).
    pub fn reconcile_events(&self, tip: Option<u32>, tail: &[ChainEvent]) {
        let Some(store) = &self.events else {
            return;
        };
        let mut store = store.lock().expect("event store lock");
        if let Err(e) = store.truncate_above(tip.unwrap_or(0)) {
            eprintln!("[events] reconcile truncate failed: {e}");
            return;
        }
        let last = store.last_height();
        let missing: Vec<ChainEvent> = tail
            .iter()
            .filter(|e| last.is_none_or(|h| e.height > h))
            .cloned()
            .collect();
        if let Err(e) = store.append(&missing) {
            eprintln!("[events] reconcile append failed: {e}");
        }
    }

    /// The leaderboard order for the current tip (top first), cached so
    /// repeated requests do not re-sort every frog. The cache key is the
    /// tip (height + hash): a reorg at the same height rebuilds it.
    pub fn leaderboard_order(&self, idx: &engine::Engine) -> Arc<Vec<u64>> {
        let key = (idx.tip_height(), idx.tip_hash());
        let mut cache = self.leaderboard.lock().expect("leaderboard lock");
        if let Some((cached_key, order)) = cache.as_ref() {
            if *cached_key == key {
                return Arc::clone(order);
            }
        }
        let frogs = idx.all_froggers();
        let mut sats: Vec<u64> = frogs.iter().map(|(sat, _)| *sat).collect();
        sats.sort_by_key(|sat| {
            let record = &frogs
                .iter()
                .find(|(s, _)| s == sat)
                .map(|(_, r)| r)
                .expect("sat from the same scan");
            (
                std::cmp::Reverse(record.gen),
                std::cmp::Reverse(record.dist),
                std::cmp::Reverse(record.crossings_entered),
                *sat,
            )
        });
        let order = Arc::new(sats);
        *cache = Some((key, Arc::clone(&order)));
        order
    }

    /// The leaderboard order, scanned from the durable mirror (P2.5c).
    /// Same ranking and the same per-tip cache as [`Self::leaderboard_order`];
    /// `None` when the backend read fails (the caller falls back).
    #[cfg(feature = "redb")]
    pub fn leaderboard_order_from_store(
        &self,
        store: &hopper_indexer::store::redb_store::RedbStore,
    ) -> Option<Arc<Vec<u64>>> {
        use hopper_indexer::store::StateView;
        let (tip_height, tip_hash) = store.tip().ok()?;
        let key = (tip_height, tip_hash);
        let mut cache = self.leaderboard.lock().expect("leaderboard lock");
        if let Some((cached_key, order)) = cache.as_ref() {
            if *cached_key == key {
                return Some(Arc::clone(order));
            }
        }
        let mut rows: Vec<(u64, u32, u32, u32)> = Vec::new();
        let mut after = None;
        loop {
            let page = store.frogs_after(after, 4096).ok()?;
            if page.is_empty() {
                break;
            }
            for (sat, record) in &page {
                rows.push((*sat, record.gen, record.dist, record.crossings_entered));
            }
            after = page.last().map(|(sat, _)| *sat);
            if page.len() < 4096 {
                break;
            }
        }
        rows.sort_by_key(|(sat, gen, dist, entered)| {
            (
                std::cmp::Reverse(*gen),
                std::cmp::Reverse(*dist),
                std::cmp::Reverse(*entered),
                *sat,
            )
        });
        let order = Arc::new(rows.into_iter().map(|(sat, ..)| sat).collect());
        *cache = Some((key, Arc::clone(&order)));
        Some(order)
    }

    /// Clear the store (fresh start with no snapshot).
    pub fn clear_events(&self) {
        if let Some(store) = &self.events {
            if let Err(e) = store.lock().expect("event store lock").clear() {
                eprintln!("[events] clear failed: {e}");
            }
        }
    }

    /// Publish one message to all SSE subscribers (no-op if none).
    pub fn push(&self, msg: sse::PushMessage) {
        // SendError just means "no subscribers" — not an error for us.
        let _ = self.events_tx.send(msg);
    }

    /// Subscribe to the SSE push bus.
    pub fn subscribe_events(&self) -> tokio::sync::broadcast::Receiver<sse::PushMessage> {
        self.events_tx.subscribe()
    }

    /// Configure the bitcoind RPC endpoint (enables `/v1/mempool`).
    pub fn set_rpc(&self, rpc: std::sync::Arc<rpc::BitcoinRpc>) {
        *self.rpc.write().expect("rpc lock poisoned") = Some(rpc);
    }

    /// The configured bitcoind RPC endpoint, if any.
    pub fn rpc(&self) -> Option<std::sync::Arc<rpc::BitcoinRpc>> {
        self.rpc.read().expect("rpc lock poisoned").clone()
    }

    pub fn read(&self) -> std::sync::RwLockReadGuard<'_, engine::Engine> {
        self.indexer.read().expect("indexer lock poisoned")
    }

    pub fn write(&self) -> std::sync::RwLockWriteGuard<'_, engine::Engine> {
        self.indexer.write().expect("indexer lock poisoned")
    }

    /// The snapshot store. Take snapshots while holding the *same*
    /// (read or write) guard you used for the indexer — the store is
    /// internally synchronized, but the indexer view must be consistent.
    pub fn snapshots(&self) -> &persist::SnapshotStore {
        &self.snapshots
    }
}

/// Where a sync pass applies its blocks: the pure engine, or the engine
/// plus a durable store guard.
pub enum SyncTarget<'a> {
    /// In-memory only.
    Memory(&'a mut engine::Engine),
    /// Engine plus the mirror store (feature `redb`).
    #[cfg(feature = "redb")]
    Durable {
        indexer: &'a mut engine::Engine,
        store: std::sync::Arc<hopper_indexer::store::redb_store::RedbStore>,
    },
}

impl SyncTarget<'_> {
    fn indexer(&self) -> &engine::Engine {
        match self {
            SyncTarget::Memory(indexer) => indexer,
            #[cfg(feature = "redb")]
            SyncTarget::Durable { indexer, .. } => indexer,
        }
    }

    #[cfg(feature = "redb")]
    fn undo_journals(
        store: &hopper_indexer::store::redb_store::RedbStore,
        tip: u32,
        n: usize,
    ) -> Result<Vec<hopper_indexer::store::BlockEffects>, String> {
        if n == 0 {
            return Ok(Vec::new());
        }
        let n32 = u32::try_from(n).map_err(|_| "rollback too large".to_string())?;
        let from = tip
            .checked_sub(n32 - 1)
            .ok_or_else(|| "rollback below genesis".to_string())?;
        let mut journals = Vec::with_capacity(n);
        for height in from..=tip {
            let effects = store
                .undo(height)
                .map_err(|e| format!("undo journal: {e}"))?
                .ok_or_else(|| format!("undo journal for height {height} is not retained"))?;
            journals.push(effects);
        }
        Ok(journals)
    }
}

impl sync::BlockTarget for SyncTarget<'_> {
    fn tip_hash(&self) -> Option<[u8; 32]> {
        self.indexer().tip_hash()
    }

    fn tip_height(&self) -> Option<u32> {
        self.indexer().tip_height()
    }

    fn block_height(&self, hash: &[u8; 32]) -> Option<u32> {
        self.indexer().block_height(hash)
    }

    fn apply(&mut self, block: hopper_indexer::types::Block) -> Result<(), sync::SyncError> {
        match self {
            SyncTarget::Memory(indexer) => {
                indexer.apply_block(block).map(|_| ()).map_err(Into::into)
            }
            #[cfg(feature = "redb")]
            SyncTarget::Durable { indexer, store } => {
                let (_report, effects, write) = indexer
                    .apply_block_recorded(block)
                    .map_err(sync::SyncError::from)?;
                store
                    .commit_block_with_undo(&write, &effects)
                    .map_err(|e| sync::SyncError::Source(format!("durable commit: {e}")))
            }
        }
    }

    fn rollback(&mut self, n: usize) -> Result<(), sync::SyncError> {
        match self {
            SyncTarget::Memory(indexer) => indexer.rollback(n).map_err(sync::SyncError::from),
            #[cfg(feature = "redb")]
            SyncTarget::Durable { indexer, store } => {
                let tip = indexer
                    .tip_height()
                    .ok_or_else(|| sync::SyncError::Source("no tip".into()))?;
                let journals =
                    Self::undo_journals(store, tip, n).map_err(sync::SyncError::Source)?;
                indexer.rollback(n).map_err(sync::SyncError::from)?;
                for effects in journals.iter().rev() {
                    store
                        .apply_inverse(effects)
                        .map_err(|e| sync::SyncError::Source(format!("durable undo: {e}")))?;
                }
                Ok(())
            }
        }
    }
}

/// API error → HTTP response.
#[derive(Debug)]
pub enum ApiError {
    NotFound(String),
    BadRequest(String),
    Conflict(String),
    /// A backend (durable store) failed.
    Internal(String),
}

impl ApiError {
    pub fn status(&self) -> axum::http::StatusCode {
        match self {
            ApiError::NotFound(_) => axum::http::StatusCode::NOT_FOUND,
            ApiError::BadRequest(_) => axum::http::StatusCode::BAD_REQUEST,
            ApiError::Conflict(_) => axum::http::StatusCode::CONFLICT,
            ApiError::Internal(_) => axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            ApiError::NotFound(m)
            | ApiError::BadRequest(m)
            | ApiError::Conflict(m)
            | ApiError::Internal(m) => m,
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let body = serde_json::json!({ "error": self.message() });
        (self.status(), axum::Json(body)).into_response()
    }
}

impl From<IndexerError> for ApiError {
    fn from(err: IndexerError) -> Self {
        ApiError::Conflict(format!("indexer rejected: {err:?}"))
    }
}

use axum::response::IntoResponse;

/// Constant-time comparison for the admin bearer token.
fn token_matches(presented: &str, expected: &str) -> bool {
    let (a, b) = (presented.as_bytes(), expected.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Guard for `/v1/admin/*` (see [`ApiState::admin_token`]).
async fn require_admin(
    axum::extract::State(state): axum::extract::State<SharedState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let Some(expected) = state.admin_token() else {
        // No token configured: reachable only on a loopback bind (enforced
        // by `serve`), which is the operator/debug case.
        return next.run(req).await;
    };
    let ok = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|presented| token_matches(presented, expected));
    if ok {
        next.run(req).await
    } else {
        (
            axum::http::StatusCode::UNAUTHORIZED,
            axum::Json(serde_json::json!({ "error": "missing or invalid admin token" })),
        )
            .into_response()
    }
}

/// Browser read policy for the *public* API routes.
///
/// Public reads are consumed from pages on other origins: the inscription's
/// live viewer (a plain `<img>` on an ord content page) and — with a PWA
/// hosted on a static site — the wallet itself. The data is read-only
/// chain data and the wallet never trusts it for value, so the default
/// stays `*`, exactly as before.
///
/// `HOPPER_CORS_ORIGINS=https://a.example,https://b.example` narrows it:
/// the header then names the *matching* origin and `Vary: Origin` is sent
/// so caches cannot hand one origin's answer to another. A request from an
/// origin not in the list gets no CORS headers at all (the browser blocks
/// the read; other clients are unaffected).
///
/// CORS is a *browser* rule, not access control: it stops a page from
/// reading a cross-origin response, it does not stop `curl`. What keeps a
/// public indexer healthy is rate limiting and, if wanted, keeping it off
/// the open internet — see `docs/SELF-HOST.md`.
///
/// `/v1/admin/*`, `/healthz`, `/readyz` and `/metrics` are outside the
/// layer: the admin routes keep their bearer token and no CORS, and the
/// operational endpoints are not for pages.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CorsPolicy {
    /// `None` = answer every origin with `*` (the default).
    origins: Option<Vec<String>>,
}

impl CorsPolicy {
    /// `*` for every origin (the historical behaviour).
    pub fn wildcard() -> Self {
        Self { origins: None }
    }

    /// Narrow to an explicit allowlist. Empty input stays `*` (an operator
    /// setting the variable to nothing has not narrowed anything).
    pub fn allow<I, S>(origins: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let list: Vec<String> = origins
            .into_iter()
            .map(Into::into)
            .map(|o| o.trim().trim_end_matches('/').to_string())
            .filter(|o| !o.is_empty())
            .collect();
        if list.is_empty() {
            Self::wildcard()
        } else {
            Self {
                origins: Some(list),
            }
        }
    }

    /// Read `HOPPER_CORS_ORIGINS` (comma-separated, exact origins).
    pub fn from_env() -> Self {
        match std::env::var("HOPPER_CORS_ORIGINS")
            .or_else(|_| std::env::var("FROGGER_CORS_ORIGINS"))
        {
            Ok(value) => Self::allow(value.split(',')),
            Err(_) => Self::wildcard(),
        }
    }

    /// The `Access-Control-Allow-Origin` value to send for this request, or
    /// `None` when the origin is not allowed (no header = browser blocks).
    pub fn allow_origin(&self, origin: Option<&str>) -> Option<String> {
        match &self.origins {
            None => Some("*".to_string()),
            Some(list) => {
                let origin = origin?.trim_end_matches('/');
                list.iter().find(|o| o == &origin).cloned()
            }
        }
    }

    /// True when the answer depends on the request's `Origin` (so `Vary`
    /// must say so).
    pub fn varies(&self) -> bool {
        self.origins.is_some()
    }
}

async fn allow_cross_origin(
    axum::extract::State(policy): axum::extract::State<CorsPolicy>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::http::header::{HeaderName, HeaderValue};
    use axum::response::IntoResponse;

    let origin = req
        .headers()
        .get(axum::http::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let allowed = policy.allow_origin(origin.as_deref());

    // Preflight: answer it here, before routing, so it works for every GET
    // route (and for a `Range`/`Accept` variant the browser may add).
    if req.method() == axum::http::Method::OPTIONS {
        let mut res = axum::http::StatusCode::NO_CONTENT.into_response();
        if let Some(allowed) = allowed {
            let headers = res.headers_mut();
            headers.insert(
                axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN,
                HeaderValue::from_str(&allowed).unwrap_or(HeaderValue::from_static("*")),
            );
            headers.insert(
                axum::http::header::ACCESS_CONTROL_ALLOW_METHODS,
                HeaderValue::from_static("GET, OPTIONS"),
            );
            headers.insert(
                axum::http::header::ACCESS_CONTROL_ALLOW_HEADERS,
                req.headers()
                    .get(axum::http::header::ACCESS_CONTROL_REQUEST_HEADERS)
                    .cloned()
                    .unwrap_or_else(|| HeaderValue::from_static("content-type, accept")),
            );
            headers.insert(
                axum::http::header::ACCESS_CONTROL_MAX_AGE,
                HeaderValue::from_static("600"),
            );
            // Chrome's Private Network Access: a public page asking a
            // LAN/Tailscale address needs this answered *on the preflight*
            // or the GET never leaves the browser.
            if req
                .headers()
                .get(HeaderName::from_static(
                    "access-control-request-private-network",
                ))
                .is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"true"))
            {
                headers.insert(
                    HeaderName::from_static("access-control-allow-private-network"),
                    HeaderValue::from_static("true"),
                );
            }
            if policy.varies() {
                headers.append(axum::http::header::VARY, HeaderValue::from_static("origin"));
            }
        }
        return res;
    }

    let mut res = next.run(req).await;
    if let Some(allowed) = allowed {
        if let Ok(value) = HeaderValue::from_str(&allowed) {
            res.headers_mut()
                .insert(axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
        }
        if policy.varies() {
            res.headers_mut()
                .append(axum::http::header::VARY, HeaderValue::from_static("origin"));
        }
    }
    res
}

/// A tiny fixed-window limiter for public reads. `HOPPER_RATE_LIMIT_PER_MIN`
/// is the only knob; 0 disables it (loopback tests).
async fn rate_limit(
    axum::extract::State(state): axum::extract::State<SharedState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let limit = std::env::var("HOPPER_RATE_LIMIT_PER_MIN")
        .ok().and_then(|v| v.parse::<u32>().ok()).unwrap_or(300);
    if limit == 0 {
        return next.run(req).await;
    }
    let key = req
        .headers()
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .or_else(|| req.headers().get("x-real-ip").and_then(|v| v.to_str().ok()))
        .unwrap_or("local")
        .to_string();
    let allowed = {
        let now = Instant::now();
        let mut map = state.rate.lock().expect("rate lock poisoned");
        if map.len() > 4096 {
            map.retain(|_, (at, _)| now.duration_since(*at) < Duration::from_secs(60));
        }
        let entry = map.entry(key).or_insert((now, 0));
        if now.duration_since(entry.0) >= Duration::from_secs(60) {
            *entry = (now, 0);
        }
        entry.1 += 1;
        entry.1 <= limit
    };
    if !allowed {
        return (axum::http::StatusCode::TOO_MANY_REQUESTS, "rate limit exceeded")
            .into_response();
    }
    next.run(req).await
}

/// The full v1 router, reading the CORS policy from the environment.
pub fn app(state: SharedState) -> axum::Router {
    app_with_cors(state, CorsPolicy::from_env())
}

/// The full v1 router with an explicit browser read policy (tests, and any
/// embedder that does not want to set process env).
pub fn app_with_cors(state: SharedState, cors: CorsPolicy) -> axum::Router {
    use axum::routing::{get, post};
    let admin = axum::Router::new()
        .route("/v1/admin/block", post(routes::ingest_block))
        .route("/v1/admin/seed", post(routes::seed))
        .route("/v1/admin/rollback", post(routes::rollback))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            require_admin,
        ));
    axum::Router::new()
        .route("/v1/status", get(routes::status))
        .route("/v1/params", get(routes::params))
        .route("/v1/generation/{height}", get(routes::generation))
        .route("/v1/wrap/{height}", get(routes::wrap_at))
        .route("/v1/froggers", get(routes::list_froggers))
        .route("/v1/frogger/{sat}", get(routes::get_frogger))
        .route("/v1/road", get(routes::road))
        .route("/v1/leaderboard", get(routes::leaderboard))
        .route("/v1/state/root", get(routes::state_root))
        .route("/v1/events", get(routes::events))
        .route("/v1/events/stream", get(sse::events_stream))
        .route("/v1/mempool", get(routes::mempool))
        .route("/v1/fees", get(routes::fees))
        .route("/v1/utxo/{txid}/{vout}", get(routes::get_utxo))
        // Public routes only: /v1/admin/* keeps its own gate and no CORS.
        .layer(axum::middleware::from_fn_with_state(
            cors,
            allow_cross_origin,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            rate_limit,
        ))
        .merge(admin)
        .route("/healthz", get(routes::healthz))
        .route("/readyz", get(routes::readyz))
        .route("/metrics", get(routes::metrics))
        .with_state(state)
}

/// Run the API server over an already-built shared state (the binary
/// restores its indexer from a snapshot and spawns the ZMQ ingester
/// against the same state before calling this).
pub async fn serve(
    state: SharedState,
    addr: std::net::SocketAddr,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if !addr.ip().is_loopback() && state.admin_token().is_none() {
        return Err(format!(
            "refusing to bind {addr}: /v1/admin/* would be world-writable without a token \
             (set HOPPER_ADMIN_TOKEN, or bind to loopback behind a proxy)"
        )
        .into());
    }
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app(state)).await?;
    Ok(())
}

#[cfg(all(test, feature = "redb"))]
mod durable_api_tests {
    use super::*;
    use hopper_core::satmath::SatRange;
    use hopper_core::{encode_mint, envelope, Action};
    use hopper_indexer::state_machine::IndexerConfig;
    use hopper_indexer::types::{Block, OutPoint, Tx, TxInput, TxOut};

    fn op(txid: u8, vout: u32) -> OutPoint {
        OutPoint {
            txid: [txid; 32],
            vout,
        }
    }

    fn empty(height: u32, hash: u8) -> Block {
        Block {
            hash: [hash; 32],
            height,
            txs: vec![],
        }
    }

    fn mint_block(height: u32, hash: u8) -> Block {
        let payload = envelope(Action::Mint, &encode_mint(0xABCD, "Testfrog"));
        Block {
            hash: [hash; 32],
            height,
            txs: vec![Tx {
                txid: [2u8; 32],
                inputs: vec![TxInput {
                    prevout: op(1, 0),
                    value: 100,
                    inscription: None,
                }],
                outputs: vec![
                    TxOut {
                        value: 100,
                        op_return: None,
                    },
                    TxOut {
                        value: 0,
                        op_return: Some(payload),
                    },
                ],
            }],
        }
    }

    #[test]
    fn ingest_mirrors_state_and_rollback_undoes_it() {
        let dir = std::env::temp_dir().join(format!("frogger-api-durable-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("api.redb");

        let mut engine = Indexer::new(IndexerConfig::default());
        engine.seed_utxo(op(1, 0), vec![SatRange::new(1000, 1100)]);
        engine.apply_block(mint_block(100, 1)).unwrap();
        let mut state = ApiState::new(engine);
        let store = hopper_indexer::store::redb_store::RedbStore::create(&path).unwrap();
        state.attach_durable(store).unwrap();

        {
            let mut idx = state.write();
            state.commit_block(&mut idx, empty(101, 2)).unwrap();
            state.commit_block(&mut idx, empty(102, 3)).unwrap();
            assert_eq!(idx.tip_height(), Some(102));
        }
        let image = bincode::serialize(state.read().state().unwrap()).unwrap();
        let mirrored = bincode::serialize(&state.durable_image().unwrap().unwrap()).unwrap();
        assert_eq!(mirrored, image, "mirror diverged after ingest");

        {
            let mut idx = state.write();
            state.rollback_blocks(&mut idx, 2).unwrap();
            assert_eq!(idx.tip_height(), Some(100));
        }
        let image = bincode::serialize(state.read().state().unwrap()).unwrap();
        let mirrored = bincode::serialize(&state.durable_image().unwrap().unwrap()).unwrap();
        assert_eq!(mirrored, image, "mirror diverged after rollback");

        // Finality pruning: with a 4-block window, the 64-block checkpoints
        // trim the journal to the retention horizon.
        state.set_undo_retention(4);
        {
            let mut idx = state.write();
            for height in 101..=192u32 {
                state
                    .commit_block(&mut idx, empty(height, height as u8))
                    .unwrap();
            }
            assert_eq!(idx.tip_height(), Some(192));
        }
        assert_eq!(state.durable_undo_range().unwrap(), Some((188, 192)));
        let image = bincode::serialize(state.read().state().unwrap()).unwrap();
        let mirrored = bincode::serialize(&state.durable_image().unwrap().unwrap()).unwrap();
        assert_eq!(mirrored, image, "mirror diverged after pruning");

        // A reorg past the undo horizon must fail before touching either
        // side (the journals are collected first).
        {
            let mut idx = state.write();
            let err = state.rollback_blocks(&mut idx, 10).unwrap_err();
            assert!(
                matches!(err, ApiError::Conflict(_)),
                "expected a conflict, got {err:?}"
            );
            assert!(
                err.message().contains("not retained"),
                "message should name the horizon: {}",
                err.message()
            );
            assert_eq!(idx.tip_height(), Some(192));
        }
        assert_eq!(
            bincode::serialize(state.read().state().unwrap()).unwrap(),
            image
        );
        assert_eq!(
            bincode::serialize(&state.durable_image().unwrap().unwrap()).unwrap(),
            image
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn restart_from_the_store_undoes_with_journals() {
        let dir = std::env::temp_dir().join(format!("frogger-api-restart-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("api.redb");

        let mut engine = Indexer::new(IndexerConfig::default());
        engine.seed_utxo(op(1, 0), vec![SatRange::new(1000, 1100)]);
        engine.apply_block(mint_block(100, 1)).unwrap();
        let mut state = ApiState::new(engine);
        let store = hopper_indexer::store::redb_store::RedbStore::create(&path).unwrap();
        state.attach_durable(store).unwrap();

        let at_101;
        {
            let mut idx = state.write();
            state.commit_block(&mut idx, empty(101, 2)).unwrap();
            at_101 = bincode::serialize(idx.state().unwrap()).unwrap();
            state.commit_block(&mut idx, empty(102, 3)).unwrap();
            state.flush_durable(&idx);
        }
        let at_102 = bincode::serialize(state.read().state().unwrap()).unwrap();
        drop(state);

        // Reopen with nothing but the store: state image plus the retained
        // hash window. No snapshot, no replay.
        let store = hopper_indexer::store::redb_store::RedbStore::create(&path).unwrap();
        let loaded = store.load_state(IndexerConfig::default()).unwrap();
        let heights = store.load_retained_heights().unwrap();
        assert_eq!(heights.len(), 3, "tip hash plus the retained window");
        let mut idx = Indexer::from_loaded_state(loaded, vec![]);
        idx.register_heights(heights);
        assert_eq!(idx.tip_height(), Some(102));
        let mut state = ApiState::new(idx);
        state.attach_durable(store).unwrap();

        {
            let mut idx = state.write();
            state.rollback_blocks(&mut idx, 1).unwrap();
            assert_eq!(idx.tip_height(), Some(101));
        }
        assert_eq!(
            bincode::serialize(state.read().state().unwrap()).unwrap(),
            at_101
        );
        {
            let mut idx = state.write();
            state.commit_block(&mut idx, empty(102, 3)).unwrap();
        }
        assert_eq!(
            bincode::serialize(state.read().state().unwrap()).unwrap(),
            at_102
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
