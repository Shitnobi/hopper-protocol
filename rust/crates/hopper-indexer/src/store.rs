//! Store abstraction over the index state (IR plan P2.1).
//!
//! The Phase-1 engine mutates [`IndexState`] directly. Before a database
//! backend can be introduced, every state access a block application needs
//! must be expressible through a trait with an **owned-value** read side:
//!
//! * `StateView` — point reads, bounded ordered ranges, counts.
//! * `StateStore` — the same plus put/remove for frogs and coins.
//!
//! Owned values (rather than `&FroggerRecord`) are deliberate: an embedded
//! key-value store (redb) cannot hand out references into its pages. The
//! in-memory oracle pays a clone per read; it is the correctness reference
//! and the benchmark baseline, not the production hot path (P2.5 moves the
//! API and P2.3 the engine onto the backend).
//!
//! Ordering is part of the contract: ranges are ascending keyset scans
//! (`BTreeMap` order over sat / [`OutPoint`]). Nothing here iterates a hash
//! map, so two stores with the same contents yield identical sequences.

use std::collections::BTreeMap;

use crate::state_machine::IndexState;
use crate::types::{FroggerRecord, OutPoint, UtxoEntry};

/// A store failure. The in-memory backend never fails; a database backend
/// maps I/O and transaction errors here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    Backend(String),
    /// The store's parameters are not this node's parameters (V3 §8.6):
    /// sharing the file would silently fork the state.
    ParamsMismatch {
        stored: [u8; 32],
        configured: [u8; 32],
    },
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Backend(message) => write!(f, "state store error: {message}"),
            StoreError::ParamsMismatch { stored, configured } => write!(
                f,
                "state store error: parameters mismatch (store {}, node {}); \
                 this store belongs to another road — reindex into a new file",
                hex(stored),
                hex(configured)
            ),
        }
    }
}

impl std::error::Error for StoreError {}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl From<String> for StoreError {
    fn from(message: String) -> Self {
        StoreError::Backend(message)
    }
}

/// Result alias for store operations.
pub type Result<T> = std::result::Result<T, StoreError>;

/// A forward (after-image) batch for one block (P2.3d).
///
/// Produced by the same mutation path as the undo journal: `None` means the
/// key is absent after the block, `Some` is its final value. Applied
/// atomically by a backend, together with the block's undo row.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct BlockWrite {
    /// Height of the block this batch belongs to.
    pub height: u32,
    /// Frogs whose value changed (final value, or `None` if removed).
    pub frogs: BTreeMap<u64, Option<FroggerRecord>>,
    /// Coins that were created or spent.
    pub coins: BTreeMap<OutPoint, Option<UtxoEntry>>,
    /// Tip after the block.
    pub tip: (Option<u32>, Option<[u8; 32]>),
}

impl BlockWrite {
    /// An empty batch for `height`.
    pub fn new(height: u32) -> Self {
        Self {
            height,
            ..Self::default()
        }
    }

    /// Record a frog's final value (`None` = removed).
    pub fn put_frog(&mut self, sat: u64, record: Option<FroggerRecord>) {
        self.frogs.insert(sat, record);
    }

    /// Record a coin's final value (`None` = spent).
    pub fn put_coin(&mut self, outpoint: OutPoint, entry: Option<UtxoEntry>) {
        self.coins.insert(outpoint, entry);
    }

    /// Record the post-block tip.
    pub fn set_tip(&mut self, height: Option<u32>, hash: Option<[u8; 32]>) {
        self.tip = (height, hash);
    }

    /// Whether the batch touches nothing but the tip.
    pub fn is_empty(&self) -> bool {
        self.frogs.is_empty() && self.coins.is_empty() && self.tip == (None, None)
    }
}

/// Apply a batch to a store in one unit of work (P2.3d).
/// Read side of the state: point lookups and bounded, ordered scans.
pub trait StateView {
    /// The frog at `sat`.
    fn frog(&self, sat: u64) -> Result<Option<FroggerRecord>>;
    /// Up to `limit` frogs with `sat > after`, in ascending sat order.
    fn frogs_after(&self, after: Option<u64>, limit: usize) -> Result<Vec<(u64, FroggerRecord)>>;
    /// The coin at `outpoint`.
    fn coin(&self, outpoint: &OutPoint) -> Result<Option<UtxoEntry>>;
    /// Up to `limit` coins with `outpoint > after`, in ascending order.
    fn coins_after(
        &self,
        after: Option<&OutPoint>,
        limit: usize,
    ) -> Result<Vec<(OutPoint, UtxoEntry)>>;
    /// Number of frogs.
    fn frog_count(&self) -> Result<usize>;
    /// Number of unspent coins.
    fn coin_count(&self) -> Result<usize>;
    /// The current tip: `(height, hash)`.
    fn tip(&self) -> Result<(Option<u32>, Option<[u8; 32]>)>;
    /// The protocol commitment (V3 §8.6): two nodes with different
    /// parameters must produce different roots, so a snapshot or a
    /// cross-check can never be shared across roads.
    fn params_hash(&self) -> Result<[u8; 32]>;
}

impl StateView for IndexState {
    fn params_hash(&self) -> Result<[u8; 32]> {
        Ok(hopper_core::params::params_hash(&self.config().params))
    }

    fn frog(&self, sat: u64) -> Result<Option<FroggerRecord>> {
        Ok(self.frog(sat).cloned())
    }

    fn frogs_after(&self, after: Option<u64>, limit: usize) -> Result<Vec<(u64, FroggerRecord)>> {
        let range: Box<dyn Iterator<Item = (&u64, &FroggerRecord)>> = match after {
            Some(after) => Box::new(
                self.frogs()
                    .range((std::ops::Bound::Excluded(after), std::ops::Bound::Unbounded)),
            ),
            None => Box::new(self.frogs().iter()),
        };
        Ok(range
            .take(limit)
            .map(|(sat, record)| (*sat, record.clone()))
            .collect())
    }

    fn coin(&self, outpoint: &OutPoint) -> Result<Option<UtxoEntry>> {
        Ok(self.tracker().utxo(outpoint).cloned())
    }

    fn coins_after(
        &self,
        after: Option<&OutPoint>,
        limit: usize,
    ) -> Result<Vec<(OutPoint, UtxoEntry)>> {
        let coins = self.tracker().coins();
        let range: Box<dyn Iterator<Item = (&OutPoint, &UtxoEntry)>> = match after {
            Some(after) => Box::new(coins.range((
                std::ops::Bound::Excluded(*after),
                std::ops::Bound::Unbounded,
            ))),
            None => Box::new(coins.iter()),
        };
        Ok(range
            .take(limit)
            .map(|(outpoint, entry)| (*outpoint, entry.clone()))
            .collect())
    }

    fn frog_count(&self) -> Result<usize> {
        Ok(self.frogs().len())
    }

    fn coin_count(&self) -> Result<usize> {
        Ok(self.tracker().coin_count())
    }

    fn tip(&self) -> Result<(Option<u32>, Option<[u8; 32]>)> {
        Ok((self.tip_height(), self.tip_hash()))
    }
}

/// Read/write side: used by block application (P2.2 records these calls to
/// build undo data) and by the database backend (P2.3).
pub trait StateStore: StateView {
    /// Insert or replace a frog.
    fn put_frog(&mut self, record: FroggerRecord) -> Result<()>;
    /// Remove and return the frog at `sat`.
    fn remove_frog(&mut self, sat: u64) -> Result<Option<FroggerRecord>>;
    /// Insert or replace a coin.
    fn put_coin(&mut self, outpoint: OutPoint, entry: UtxoEntry) -> Result<()>;
    /// Remove and return the coin at `outpoint`.
    fn remove_coin(&mut self, outpoint: &OutPoint) -> Result<Option<UtxoEntry>>;
    /// Set the tip fields.
    fn set_tip(&mut self, height: Option<u32>, hash: Option<[u8; 32]>) -> Result<()>;
    /// Apply one block's forward batch atomically. Backends must make the
    /// batch all-or-nothing; the in-memory oracle applies in order.
    fn commit_block(&mut self, write: &BlockWrite) -> Result<()>;

    /// Undo one journaled block. The default restores each group as its
    /// own unit; transactional backends override it to be atomic.
    fn commit_undo(&mut self, effects: &BlockEffects) -> Result<()> {
        undo(self, effects)?;
        self.set_tip(effects.before_tip.0, effects.before_tip.1)
    }
}

impl StateStore for IndexState {
    fn put_frog(&mut self, record: FroggerRecord) -> Result<()> {
        let sat = record.sat;
        self.frogs_mut().insert(sat, record);
        Ok(())
    }

    fn remove_frog(&mut self, sat: u64) -> Result<Option<FroggerRecord>> {
        Ok(self.frogs_mut().remove(&sat))
    }

    fn put_coin(&mut self, outpoint: OutPoint, entry: UtxoEntry) -> Result<()> {
        self.tracker_mut().put_coin(outpoint, entry);
        Ok(())
    }

    fn remove_coin(&mut self, outpoint: &OutPoint) -> Result<Option<UtxoEntry>> {
        Ok(self.tracker_mut().remove_coin(outpoint))
    }

    fn set_tip(&mut self, height: Option<u32>, hash: Option<[u8; 32]>) -> Result<()> {
        self.set_tip(height, hash);
        Ok(())
    }

    fn commit_block(&mut self, write: &BlockWrite) -> Result<()> {
        for (sat, record) in &write.frogs {
            match record {
                Some(record) => {
                    self.frogs_mut().insert(*sat, record.clone());
                }
                None => {
                    self.frogs_mut().remove(sat);
                }
            }
        }
        for (outpoint, entry) in &write.coins {
            match entry {
                Some(entry) => {
                    self.tracker_mut().put_coin(*outpoint, entry.clone());
                }
                None => {
                    self.tracker_mut().remove_coin(outpoint);
                }
            }
        }
        self.set_tip(write.tip.0, write.tip.1);
        Ok(())
    }
}

/// `MemStore` is `IndexState` in Phase 1: the direct, deterministic
/// reference implementation every future backend is tested against.
pub type MemStore = IndexState;

/// Before-images for one block (IR plan P2.2).
///
/// Each key is recorded **once, at first touch**, with the value it had
/// before the block. A later mutation in the same block does not overwrite
/// the entry, so undoing the map restores the pre-block state exactly.
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub struct BlockEffects {
    /// Height of the block these effects belong to.
    pub height: u32,
    frogs: BTreeMap<u64, Option<FroggerRecord>>,
    coins: BTreeMap<OutPoint, Option<UtxoEntry>>,
    /// Pre-block tip (height, hash).
    pub(crate) before_tip: (Option<u32>, Option<[u8; 32]>),
}

impl BlockEffects {
    /// Empty effects for `height`.
    pub fn new(height: u32) -> Self {
        Self {
            height,
            ..Self::default()
        }
    }

    /// Record a frog's pre-block value the first time it is touched.
    pub fn record_frog(&mut self, sat: u64, before: Option<&FroggerRecord>) {
        self.frogs.entry(sat).or_insert_with(|| before.cloned());
    }

    /// Record a coin's pre-block value the first time it is touched.
    pub fn record_coin(&mut self, outpoint: OutPoint, before: Option<&UtxoEntry>) {
        self.coins
            .entry(outpoint)
            .or_insert_with(|| before.cloned());
    }

    /// Number of recorded keys (frogs + coins).
    pub fn len(&self) -> usize {
        self.frogs.len() + self.coins.len()
    }

    /// No mutations were recorded.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Frog before-images in ascending sat order.
    pub fn frogs(&self) -> impl Iterator<Item = (&u64, &Option<FroggerRecord>)> {
        self.frogs.iter()
    }

    /// Coin before-images in ascending outpoint order.
    pub fn coins(&self) -> impl Iterator<Item = (&OutPoint, &Option<UtxoEntry>)> {
        self.coins.iter()
    }
}

/// Undo one journaled block through the store trait (P2.3e).
///
/// Restores crossings, truncates history, restores per-frog position lists,
/// then frogs/coins, then the tip. Each trait call is its own unit in a
/// backend that commits per call; atomic per-block undo arrives with the
/// engine write path.
pub fn undo_block<S: StateStore>(store: &mut S, effects: &BlockEffects) -> Result<()> {
    store.commit_undo(effects)
}

/// Bump when the canonical digest encoding changes.
pub const STATE_ROOT_VERSION: u8 = 4;

/// Domain-separated, length-framed canonical state digest.
///
/// Cross-indexer verification (IR plan Phase 3): two implementations that
/// agree on consensus must agree on this value. The scan order is the
/// `BTreeMap` contract (ascending sat / outpoint), never hash order, and
/// every record is `bincode` (fixed-width, deterministic). Covers frogs
/// (including forward locations), coins, active crossings, history in end
/// order, per-sat finished positions and the tip.
pub fn state_root<S: StateView + ?Sized>(view: &S) -> Result<[u8; 32]> {
    use sha2::{Digest, Sha256};

    fn put(h: &mut Sha256, bytes: &[u8]) {
        h.update((bytes.len() as u64).to_le_bytes());
        h.update(bytes);
    }
    fn put_record<T: serde::Serialize>(h: &mut Sha256, tag: &[u8], value: &T) -> Result<()> {
        put(h, tag);
        put(
            h,
            &bincode::serialize(value)
                .map_err(|e| StoreError::Backend(format!("state root encode: {e}")))?,
        );
        Ok(())
    }

    let mut h = Sha256::new();
    h.update(b"FRGSTATE");
    h.update([STATE_ROOT_VERSION]);

    let (height, hash) = view.tip()?;
    put(&mut h, b"tip");
    put(&mut h, &height.unwrap_or(u32::MAX).to_le_bytes());
    put(&mut h, &hash.unwrap_or([0u8; 32]));

    put(&mut h, b"params");
    put(&mut h, &view.params_hash()?);

    put(&mut h, b"frogs");
    let mut after = None;
    loop {
        let page = view.frogs_after(after, 1024)?;
        if page.is_empty() {
            break;
        }
        for (sat, record) in &page {
            put(&mut h, b"frog");
            put(&mut h, &sat.to_le_bytes());
            put_record(&mut h, b"record", record)?;
        }
        after = page.last().map(|(sat, _)| *sat);
    }

    put(&mut h, b"coins");
    let mut after = None;
    loop {
        let page = view.coins_after(after.as_ref(), 1024)?;
        if page.is_empty() {
            break;
        }
        for (outpoint, entry) in &page {
            put(&mut h, b"coin");
            put(&mut h, &outpoint.txid);
            put(&mut h, &outpoint.vout.to_be_bytes());
            put_record(&mut h, b"entry", entry)?;
        }
        after = page.last().map(|(outpoint, _)| *outpoint);
    }

    Ok(h.finalize().into())
}

/// Restore the pre-block values. Used for in-memory undo and, from P2.3,
/// by the backend's undo table.
pub fn undo<S: StateStore + ?Sized>(store: &mut S, effects: &BlockEffects) -> Result<()> {
    for (sat, before) in effects.frogs.iter().rev() {
        match before {
            Some(record) => store.put_frog(record.clone())?,
            None => {
                store.remove_frog(*sat)?;
            }
        }
    }
    for (outpoint, before) in effects.coins.iter().rev() {
        match before {
            Some(entry) => store.put_coin(*outpoint, entry.clone())?,
            None => {
                store.remove_coin(outpoint)?;
            }
        }
    }
    Ok(())
}

/// A [`StateStore`] that records before-images while delegating writes.
///
/// Block application will hold one of these for the duration of a block
/// (P2.2 wiring); `into_effects()` yields the undo journal.
pub struct Recorder<'a, S: StateStore> {
    store: &'a mut S,
    effects: BlockEffects,
}

impl<'a, S: StateStore> Recorder<'a, S> {
    /// Wrap `store`, recording effects for `height`.
    pub fn new(store: &'a mut S, height: u32) -> Self {
        Self {
            store,
            effects: BlockEffects::new(height),
        }
    }

    /// The wrapped store (read-only).
    pub fn view(&self) -> &S {
        self.store
    }

    /// The recorded effects so far.
    pub fn effects(&self) -> &BlockEffects {
        &self.effects
    }

    /// Finish recording and return the journal.
    pub fn into_effects(self) -> BlockEffects {
        self.effects
    }

    /// Insert or replace a frog, recording its first-touch value.
    pub fn put_frog(&mut self, record: FroggerRecord) -> Result<()> {
        let sat = record.sat;
        let before = StateView::frog(self.store, sat)?;
        self.effects.record_frog(sat, before.as_ref());
        self.store.put_frog(record)
    }

    /// Remove a frog, recording its first-touch value.
    pub fn remove_frog(&mut self, sat: u64) -> Result<Option<FroggerRecord>> {
        let before = StateView::frog(self.store, sat)?;
        self.effects.record_frog(sat, before.as_ref());
        self.store.remove_frog(sat)
    }

    /// Insert or replace a coin, recording its first-touch value.
    pub fn put_coin(&mut self, outpoint: OutPoint, entry: UtxoEntry) -> Result<()> {
        let before = StateView::coin(self.store, &outpoint)?;
        self.effects.record_coin(outpoint, before.as_ref());
        self.store.put_coin(outpoint, entry)
    }

    /// Remove a coin, recording its first-touch value.
    pub fn remove_coin(&mut self, outpoint: &OutPoint) -> Result<Option<UtxoEntry>> {
        let before = StateView::coin(self.store, outpoint)?;
        self.effects.record_coin(*outpoint, before.as_ref());
        self.store.remove_coin(outpoint)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state_machine::IndexerConfig;
    use crate::types::SatLocation;
    use hopper_core::satmath::SatRange;

    fn record(sat: u64) -> FroggerRecord {
        FroggerRecord {
            sat,
            seed: sat as u32,
            name: format!("frog-{sat}"),
            state: crate::types::FroggerState::Idle,
            dist: 0,
            crossings_entered: 0,
            mint_height: 0,
            mint_txid: [0u8; 32],
            inscription_id: None,
            location: SatLocation::Burned,
            wire_version: crate::types::LEGACY_WIRE_VERSION,
            mint_index: 0,
            crossings_settled: 0,
            deaths: 0,
            in_flight: None,
            outcome_block_hash: None,
            provisional_dead: None,
            immortal_height: None,
            death_height: None,
            burn_height: None,
            burn_txid: None,
            last_target_hops: None,
        }
    }

    /// Disambiguate from the inherent `IndexState::frog` (which returns a
    /// reference): the store contract is the owned-value `StateView`.
    fn view_frog(store: &MemStore, sat: u64) -> Option<FroggerRecord> {
        StateView::frog(store, sat).unwrap()
    }

    fn outpoint(id: u8) -> OutPoint {
        OutPoint {
            txid: [id; 32],
            vout: 0,
        }
    }

    fn coin(value: u64) -> UtxoEntry {
        UtxoEntry {
            value,
            ranges: vec![SatRange::new(0, value)],
            frogs: Default::default(),
        }
    }

    #[test]
    fn reads_and_writes_round_trip_through_the_trait() {
        let mut store = MemStore::new(IndexerConfig::default());
        assert_eq!(view_frog(&store, 1), None);
        assert_eq!(store.frog_count().unwrap(), 0);

        store.put_frog(record(7)).unwrap();
        store.put_frog(record(1)).unwrap();
        store.put_frog(record(3)).unwrap();
        assert_eq!(store.frog_count().unwrap(), 3);
        assert_eq!(view_frog(&store, 3).unwrap().name, "frog-3");

        // Ordered, exclusive keyset scans are the pagination contract.
        let page = store.frogs_after(None, 2).unwrap();
        assert_eq!(page.iter().map(|(sat, _)| *sat).collect::<Vec<_>>(), [1, 3]);
        let page = store.frogs_after(Some(3), 10).unwrap();
        assert_eq!(page.iter().map(|(sat, _)| *sat).collect::<Vec<_>>(), [7]);

        assert_eq!(store.remove_frog(3).unwrap().unwrap().sat, 3);
        assert_eq!(store.remove_frog(3).unwrap(), None);
        assert_eq!(store.frog_count().unwrap(), 2);
    }

    #[test]
    fn coins_round_trip_and_scan_in_outpoint_order() {
        let mut store = MemStore::new(IndexerConfig::default());
        store.put_coin(outpoint(9), coin(50)).unwrap();
        store.put_coin(outpoint(2), coin(20)).unwrap();
        store.put_coin(outpoint(5), coin(30)).unwrap();
        assert_eq!(store.coin_count().unwrap(), 3);
        assert_eq!(store.coin(&outpoint(5)).unwrap().unwrap().value, 30);

        let order: Vec<u8> = store
            .coins_after(None, 10)
            .unwrap()
            .iter()
            .map(|(op, _)| op.txid[0])
            .collect();
        assert_eq!(order, [2, 5, 9]);
        let after: Vec<u8> = store
            .coins_after(Some(&outpoint(2)), 10)
            .unwrap()
            .iter()
            .map(|(op, _)| op.txid[0])
            .collect();
        assert_eq!(after, [5, 9]);

        assert_eq!(store.remove_coin(&outpoint(5)).unwrap().unwrap().value, 30);
        assert_eq!(store.coin(&outpoint(5)).unwrap(), None);
        assert_eq!(store.coin_count().unwrap(), 2);
    }

    #[test]
    fn trait_operations_match_direct_state_access() {
        // The oracle and the trait must not diverge: drive a direct state and
        // a trait-driven state with the same edits and compare snapshots.
        let mut direct = MemStore::new(IndexerConfig::default());
        for sat in [4u64, 1, 9, 2] {
            direct.frogs_mut().insert(sat, record(sat));
        }
        direct.tracker_mut().put_coin(outpoint(1), coin(10));
        direct.tracker_mut().put_coin(outpoint(3), coin(30));

        let mut via_trait = MemStore::new(IndexerConfig::default());
        for sat in [9u64, 2, 4, 1] {
            via_trait.put_frog(record(sat)).unwrap();
        }
        via_trait.put_coin(outpoint(3), coin(30)).unwrap();
        via_trait.put_coin(outpoint(1), coin(10)).unwrap();

        assert_eq!(direct, via_trait);
        let direct_map: BTreeMap<u64, FroggerRecord> = direct
            .frogs()
            .iter()
            .map(|(k, v)| (*k, v.clone()))
            .collect();
        let trait_map: BTreeMap<u64, FroggerRecord> = via_trait
            .frogs_after(None, 100)
            .unwrap()
            .into_iter()
            .collect();
        assert_eq!(direct_map, trait_map);
    }

    #[cfg(feature = "redb")]
    #[test]
    fn store_schema_is_stamped_and_newer_schemas_are_refused() {
        use super::redb_store::{RedbStore, SCHEMA_KEY, SCHEMA_VERSION};
        let dir = std::env::temp_dir().join(format!("frogger-schema-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("schema.redb");

        let store = RedbStore::create(&path).unwrap();
        let stamped = store.meta_get(SCHEMA_KEY).unwrap().unwrap();
        assert_eq!(stamped, bincode::serialize(&SCHEMA_VERSION).unwrap());

        // save_state (clear_state) must not erase the stamp.
        store.clear_state().unwrap();
        assert_eq!(
            store.meta_get(SCHEMA_KEY).unwrap().unwrap(),
            bincode::serialize(&SCHEMA_VERSION).unwrap()
        );

        // A store written by a future indexer is refused, not misread.
        let future = bincode::serialize(&(SCHEMA_VERSION + 1)).unwrap();
        store.meta_set(SCHEMA_KEY, &future).unwrap();
        drop(store);
        let err = match RedbStore::create(&path) {
            Ok(_) => panic!("a newer schema must be refused"),
            Err(e) => e,
        };
        assert!(err.to_string().contains("newer"), "{err}");

        // An older schema is refused too: bincode values cannot be
        // reinterpreted across a layout change.
        let stale_path = dir.join("stale.redb");
        let stale_store = RedbStore::create(&stale_path).unwrap();
        let stale = bincode::serialize(&(SCHEMA_VERSION - 1)).unwrap();
        stale_store.meta_set(SCHEMA_KEY, &stale).unwrap();
        drop(stale_store);
        let err = match RedbStore::create(&stale_path) {
            Ok(_) => panic!("an older schema must demand a reindex"),
            Err(e) => e,
        };
        assert!(err.to_string().contains("older"), "{err}");
        assert!(err.to_string().contains("HOPPER_REINDEX"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(feature = "redb")]
    #[test]
    fn empty_engine_and_store_roots_agree() {
        use crate::store::redb_store::RedbStore;
        let dir = std::env::temp_dir().join(format!("frogger-root-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = RedbStore::create(&dir.join("root.redb")).unwrap();
        let mut idx =
            crate::state_machine::Indexer::new(crate::state_machine::IndexerConfig::default());
        let (_, effects, write) = idx
            .apply_block_recorded(crate::types::Block {
                hash: [4; 32],
                height: 100,
                txs: vec![],
            })
            .unwrap();
        db.commit_block_with_undo(&write, &effects).unwrap();
        assert_eq!(idx.state_root(), crate::store::state_root(&db).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(feature = "redb")]
    #[test]
    fn redb_and_mem_agree_on_a_random_stream() {
        use super::redb_store::RedbStore;
        let dir = std::env::temp_dir().join(format!("frogger-redb-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut mem = MemStore::new(IndexerConfig::default());
        let mut db = RedbStore::create(&dir.join("state.redb")).unwrap();

        let mut seed = 0x1234_5678_9ABC_DEF0u64;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for step in 0..200 {
            let key = next() % 20;
            match next() % 8 {
                0 => {
                    let record = record(key);
                    mem.put_frog(record.clone()).unwrap();
                    db.put_frog(record).unwrap();
                }
                1 => {
                    mem.remove_frog(key).unwrap();
                    db.remove_frog(key).unwrap();
                }
                2 => {
                    let entry = coin(next() % 1_000 + 1);
                    mem.put_coin(outpoint(key as u8), entry.clone()).unwrap();
                    db.put_coin(outpoint(key as u8), entry).unwrap();
                }
                3 => {
                    mem.remove_coin(&outpoint(key as u8)).unwrap();
                    db.remove_coin(&outpoint(key as u8)).unwrap();
                }
                _ => {
                    let tip_height = Some(next() as u32 % 1_000);
                    StateStore::set_tip(&mut mem, tip_height, Some([key as u8; 32])).unwrap();
                    db.set_tip(tip_height, Some([key as u8; 32])).unwrap();
                }
            }
            if step % 20 == 0 {
                assert_eq!(
                    mem.frogs_after(None, 1_000).unwrap(),
                    db.frogs_after(None, 1_000).unwrap(),
                    "frogs diverged at step {step}"
                );
                assert_eq!(
                    mem.coins_after(None, 1_000).unwrap(),
                    db.coins_after(None, 1_000).unwrap(),
                    "coins diverged at step {step}"
                );
                assert_eq!(mem.frog_count().unwrap(), db.frog_count().unwrap());
                assert_eq!(mem.coin_count().unwrap(), db.coin_count().unwrap());
                assert_eq!(mem.tip().unwrap(), db.tip().unwrap());
                assert_eq!(
                    state_root(&mem).unwrap(),
                    state_root(&db).unwrap(),
                    "state root diverged at step {step}"
                );
            }
        }
        // One extra coin must change the digest.
        let root = state_root(&mem).unwrap();
        let before = mem.coin_count().unwrap();
        mem.put_coin(outpoint(250), coin(1)).unwrap();
        assert_eq!(mem.coin_count().unwrap(), before + 1);
        assert_ne!(state_root(&mem).unwrap(), root);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(feature = "redb")]
    #[test]
    fn a_burned_frog_round_trips_and_enters_the_root() {
        use super::redb_store::RedbStore;
        let dir = std::env::temp_dir().join(format!("frogger-redb-burn-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut mem = MemStore::new(IndexerConfig::default());
        let mut db = RedbStore::create(&dir.join("state.redb")).unwrap();

        let mut rec = record(7);
        rec.state = crate::types::FroggerState::Burned;
        rec.location = SatLocation::Burned;
        rec.burn_height = Some(101);
        rec.burn_txid = Some([9u8; 32]);
        mem.put_frog(rec.clone()).unwrap();
        db.put_frog(rec.clone()).unwrap();

        assert_eq!(
            mem.frogs_after(None, 10).unwrap(),
            db.frogs_after(None, 10).unwrap(),
            "the burn metadata survives the value encoding"
        );
        assert_eq!(state_root(&mem).unwrap(), state_root(&db).unwrap());

        // It is consensus data, so it must be in the digest.
        let root = state_root(&mem).unwrap();
        rec.burn_txid = Some([10u8; 32]);
        mem.put_frog(rec).unwrap();
        assert_ne!(state_root(&mem).unwrap(), root);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(feature = "redb")]
    #[test]
    fn redb_undo_journal_round_trips_and_prunes() {
        use super::redb_store::RedbStore;
        let dir = std::env::temp_dir().join(format!("frogger-undo-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = RedbStore::create(&dir.join("undo.redb")).unwrap();

        let mut effects = BlockEffects::new(102);
        let mut record = record(7);
        record.dist = 3;
        effects.record_frog(7, None);
        effects.record_frog(8, Some(&record));
        effects.record_coin(outpoint(1), Some(&coin(500)));
        effects.before_tip = (Some(101), Some([9u8; 32]));

        db.put_undo(102, &effects).unwrap();
        db.put_undo(103, &BlockEffects::new(103)).unwrap();
        assert_eq!(db.undo(102).unwrap().as_ref(), Some(&effects));
        assert_eq!(db.undo_range().unwrap(), Some((102, 103)));

        assert_eq!(db.trim_undo_below(103).unwrap(), 1);
        assert!(db.undo(102).unwrap().is_none());
        assert_eq!(db.undo_range().unwrap(), Some((103, 103)));
        let _ = std::fs::remove_dir_all(&dir);
    }
    type Snapshot = (
        Vec<(u64, FroggerRecord)>,
        Vec<(OutPoint, UtxoEntry)>,
        usize,
        usize,
    );

    fn snapshot(store: &MemStore) -> Snapshot {
        (
            store.frogs_after(None, usize::MAX).unwrap(),
            store.coins_after(None, usize::MAX).unwrap(),
            store.frog_count().unwrap(),
            store.coin_count().unwrap(),
        )
    }

    #[test]
    fn recorder_undo_restores_the_pre_block_state() {
        let mut store = MemStore::new(IndexerConfig::default());
        store.put_frog(record(1)).unwrap();
        store.put_coin(outpoint(1), coin(10)).unwrap();
        let before = snapshot(&store);

        let mut rec = Recorder::new(&mut store, 5);
        rec.put_frog(record(2)).unwrap();
        rec.put_frog(record(1)).unwrap(); // replace
        rec.remove_frog(1).unwrap();
        rec.put_coin(outpoint(2), coin(20)).unwrap();
        rec.remove_coin(&outpoint(1)).unwrap();
        let effects = rec.into_effects();

        assert_eq!(effects.height, 5);
        // Two sats and two outpoints, each recorded once.
        assert_eq!(effects.len(), 4);
        undo(&mut store, &effects).unwrap();
        assert_eq!(snapshot(&store), before);
    }

    #[test]
    fn first_touch_wins_for_repeated_mutations() {
        let mut store = MemStore::new(IndexerConfig::default());
        let mut rec = Recorder::new(&mut store, 0);
        rec.put_frog(record(1)).unwrap();
        rec.put_frog(record(1)).unwrap();
        let effects = rec.into_effects();
        assert_eq!(effects.len(), 1);
        assert_eq!(effects.frogs().next().unwrap().1, &None);
        undo(&mut store, &effects).unwrap();
        assert_eq!(store.frog_count().unwrap(), 0);
    }

    #[test]
    fn undo_is_identity_over_a_random_corpus() {
        // Deterministic xorshift: no rand dependency, reproducible failures.
        let mut seed = 0x9E37_79B9_7F4A_7C15u64;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };

        let mut store = MemStore::new(IndexerConfig::default());
        for sat in 0..12u64 {
            if next() & 1 == 0 {
                store.put_frog(record(sat)).unwrap();
            }
        }
        for id in 0..12u8 {
            if next() & 1 == 0 {
                store
                    .put_coin(outpoint(id), coin(next() % 1_000 + 1))
                    .unwrap();
            }
        }
        let before = snapshot(&store);

        for height in 0..20u32 {
            let mut rec = Recorder::new(&mut store, height);
            for _ in 0..20 {
                let key = next() % 12;
                match next() % 8 {
                    0 => rec.put_frog(record(key)).unwrap(),
                    1 => {
                        rec.remove_frog(key).unwrap();
                    }
                    2 => rec
                        .put_coin(outpoint(key as u8), coin(next() % 1_000 + 1))
                        .unwrap(),
                    _ => {
                        rec.remove_coin(&outpoint(key as u8)).unwrap();
                    }
                }
            }
            let effects = rec.into_effects();
            undo(&mut store, &effects).unwrap();
            assert_eq!(snapshot(&store), before, "height {height} did not undo");
        }
    }

    #[cfg(feature = "redb")]
    #[test]
    fn copy_to_preserves_state_undo_and_retained_heights() {
        use super::redb_store::RedbStore;
        let dir = std::env::temp_dir().join(format!("frogger-copy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let mut mem = MemStore::new(IndexerConfig::default());
        mem.put_frog(record(7)).unwrap();
        mem.put_coin(outpoint(7), coin(70)).unwrap();
        StateStore::set_tip(&mut mem, Some(9), Some([9u8; 32])).unwrap();

        let src = RedbStore::create(&dir.join("src.redb")).unwrap();
        src.save_state(&mem).unwrap();
        src.save_retained_heights(&[(8, [8u8; 32]), (9, [9u8; 32])])
            .unwrap();
        src.put_undo(9, &BlockEffects::new(9)).unwrap();

        let dst_path = dir.join("dst.redb");
        src.copy_to(&dst_path).unwrap();
        let dst = RedbStore::create(&dst_path).unwrap();
        assert_eq!(state_root(&src).unwrap(), state_root(&dst).unwrap());
        assert_eq!(StateView::tip(&dst).unwrap(), (Some(9), Some([9u8; 32])));
        assert_eq!(
            dst.load_retained_heights().unwrap(),
            vec![(8, [8u8; 32]), (9, [9u8; 32])]
        );
        assert_eq!(dst.undo_range().unwrap(), Some((9, 9)));
        assert_eq!(dst.frog_count().unwrap(), 1);
        assert_eq!(dst.coin_count().unwrap(), 1);

        // Never clobber an existing database.
        assert!(src.copy_to(&dst_path).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(feature = "redb")]
    #[test]
    fn commit_block_batches_agree_between_backends() {
        use super::redb_store::RedbStore;
        let dir = std::env::temp_dir().join(format!("frogger-batch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut mem = MemStore::new(IndexerConfig::default());
        let mut db = RedbStore::create(&dir.join("batch.redb")).unwrap();

        // Seed a frog and a coin so the main batch exercises removals.
        let mut seed = BlockWrite::new(49);
        seed.put_frog(2, Some(record(2)));
        seed.put_coin(outpoint(4), Some(coin(40)));
        mem.commit_block(&seed).unwrap();
        db.commit_block(&seed).unwrap();

        let mut batch = BlockWrite::new(50);
        batch.put_frog(1, Some(record(1)));
        batch.put_frog(2, None);
        batch.put_coin(outpoint(3), Some(coin(30)));
        batch.put_coin(outpoint(4), None);
        batch.set_tip(Some(50), Some([5u8; 32]));
        mem.commit_block(&batch).unwrap();
        db.commit_block(&batch).unwrap();

        assert_eq!(
            mem.frogs_after(None, 100).unwrap(),
            db.frogs_after(None, 100).unwrap()
        );
        assert_eq!(
            mem.coins_after(None, 100).unwrap(),
            db.coins_after(None, 100).unwrap()
        );
        assert_eq!(mem.tip().unwrap(), (Some(50), Some([5u8; 32])));

        // A second batch over an empty diff still agrees.
        let mut second = BlockWrite::new(51);
        second.set_tip(Some(51), None);
        mem.commit_block(&second).unwrap();
        db.commit_block(&second).unwrap();
        assert_eq!(mem.tip().unwrap(), (Some(51), None));

        // State batch + undo row commit together (P2.3d-2).
        let mut third = BlockWrite::new(52);
        third.put_frog(9, Some(record(9)));
        third.set_tip(Some(52), Some([7u8; 32]));
        let mut effects = BlockEffects::new(52);
        effects.record_frog(9, None);
        db.commit_block_with_undo(&third, &effects).unwrap();
        assert_eq!(db.undo(52).unwrap().as_ref(), Some(&effects));
        assert_eq!(db.undo_range().unwrap(), Some((52, 52)));
        let frogs = db.frogs_after(Some(8), 10).unwrap();
        assert_eq!(frogs.len(), 1);
        assert_eq!(frogs[0].0, 9);
        assert_eq!(db.tip().unwrap(), (Some(52), Some([7u8; 32])));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(feature = "redb")]
pub mod redb_store {
    //! Embedded redb backend for the Phase-2 store traits (P2.3a).
    //!
    //! Frogs are keyed by sat (`u64`); coins by a 36-byte
    //! `txid || vout_be` key. Values are bincode. Each trait call is its
    //! own transaction for now; the per-block transaction and undo table
    //! land with the engine migration (P2.3b).

    use super::{BlockEffects, BlockWrite, Result, StateStore, StateView, StoreError};
    use crate::types::{FroggerRecord, OutPoint, UtxoEntry};
    use redb::{Database, ReadableTable, ReadableTableMetadata, TableDefinition};
    use std::path::Path;

    const FROGS: TableDefinition<'static, u64, &[u8]> = TableDefinition::new("frogs");
    const COINS: TableDefinition<'static, &[u8], &[u8]> = TableDefinition::new("coins");
    const META: TableDefinition<'static, &'static str, &'static [u8]> =
        TableDefinition::new("meta");
    const UNDO: TableDefinition<'static, u64, &[u8]> = TableDefinition::new("undo");

    /// On-disk store schema. Bump when a table's value encoding changes;
    /// older stores are reindexed, newer stores are refused.
    /// Bumped whenever a stored VALUE's bincode layout changes (not just
    /// the table set). v2: `FroggerRecord` gained the v3 fields
    /// (`wire_version`, `in_flight`, outcome/immortality markers).
    pub const SCHEMA_VERSION: u32 = 3;
    pub(crate) const SCHEMA_KEY: &str = "schema_version";

    fn backend(error: impl std::fmt::Display) -> StoreError {
        StoreError::Backend(error.to_string())
    }

    fn coin_key(outpoint: &OutPoint) -> [u8; 36] {
        let mut key = [0u8; 36];
        key[..32].copy_from_slice(&outpoint.txid);
        key[32..].copy_from_slice(&outpoint.vout.to_be_bytes());
        key
    }

    fn outpoint_from_key(key: &[u8]) -> OutPoint {
        let mut txid = [0u8; 32];
        txid.copy_from_slice(&key[..32]);
        let mut vout = [0u8; 4];
        vout.copy_from_slice(&key[32..]);
        OutPoint {
            txid,
            vout: u32::from_be_bytes(vout),
        }
    }

    /// A redb-backed frog/coin store.
    pub struct RedbStore {
        db: Database,
    }

    impl RedbStore {
        /// The parameters this store was committed to, if it has been
        /// bound to a `StoreState` yet.
        pub fn params_hash_opt(&self) -> Result<Option<[u8; 32]>> {
            match self.meta_get("params_hash")? {
                Some(bytes) => Ok(Some(bincode::deserialize(&bytes).map_err(backend)?)),
                None => Ok(None),
            }
        }

        /// Bind the store to a parameter set (first use only).
        pub fn set_params_hash(&self, hash: &[u8; 32]) -> Result<()> {
            self.meta_set("params_hash", &bincode::serialize(hash).map_err(backend)?)
        }

        /// Open or create a store at `path`.
        pub fn create(path: &Path) -> Result<Self> {
            Self::create_with_cache(path, None)
        }

        /// Create a store with an explicit page-cache bound. `None` keeps
        /// redb's default (1 GiB); a bound trades re-reads for RAM, which
        /// is what keeps a large mirror from doubling the process image.
        pub fn create_with_cache(path: &Path, cache_bytes: Option<usize>) -> Result<Self> {
            let mut builder = Database::builder();
            if let Some(bytes) = cache_bytes {
                builder.set_cache_size(bytes);
            }
            let db = builder.create(path).map_err(backend)?;
            let write = db.begin_write().map_err(backend)?;
            {
                write.open_table(FROGS).map_err(backend)?;
                write.open_table(COINS).map_err(backend)?;
                write.open_table(META).map_err(backend)?;
                write.open_table(UNDO).map_err(backend)?;
            }
            write.commit().map_err(backend)?;
            let store = Self { db };
            let encoded = bincode::serialize(&SCHEMA_VERSION).map_err(backend)?;
            match store.meta_get(SCHEMA_KEY)? {
                Some(bytes) => {
                    let found: u32 = bincode::deserialize(&bytes).map_err(backend)?;
                    if found > SCHEMA_VERSION {
                        return Err(StoreError::Backend(format!(
                            "store schema {found} is newer than {SCHEMA_VERSION}; \
                             use a newer indexer or reindex with HOPPER_REINDEX=1"
                        )));
                    }
                    if found < SCHEMA_VERSION {
                        // Values are bincode: an older layout must not be
                        // decoded as the new one. Reindex from seeds/genesis.
                        return Err(StoreError::Backend(format!(
                            "store schema {found} is older than {SCHEMA_VERSION}; \
                             reindex with HOPPER_REINDEX=1 (this deletes the store)"
                        )));
                    }
                }
                None => store.meta_set(SCHEMA_KEY, &encoded)?,
            }
            Ok(store)
        }

        pub(crate) fn meta_get(&self, key: &str) -> Result<Option<Vec<u8>>> {
            let read = self.db.begin_read().map_err(backend)?;
            let table = read.open_table(META).map_err(backend)?;
            Ok(table
                .get(key)
                .map_err(backend)?
                .map(|value| value.value().to_vec()))
        }

        pub(crate) fn meta_set(&self, key: &str, value: &[u8]) -> Result<()> {
            let write = self.db.begin_write().map_err(backend)?;
            {
                let mut table = write.open_table(META).map_err(backend)?;
                table.insert(key, value).map_err(backend)?;
            }
            write.commit().map_err(backend)
        }

        /// Persist one block's undo journal (`BlockEffects`) under its height.
        pub fn put_undo(&self, height: u32, effects: &BlockEffects) -> Result<()> {
            let value = bincode::serialize(effects).map_err(backend)?;
            let write = self.db.begin_write().map_err(backend)?;
            {
                let mut table = write.open_table(UNDO).map_err(backend)?;
                table
                    .insert(height as u64, value.as_slice())
                    .map_err(backend)?;
            }
            write.commit().map_err(backend)
        }

        /// Persist the retained hash→height window (fork detection across
        /// restarts).
        pub fn save_retained_heights(&self, heights: &[(u32, [u8; 32])]) -> Result<()> {
            let value = bincode::serialize(heights).map_err(backend)?;
            self.meta_set("retained_heights", &value)
        }

        /// Load the retained window saved by [`RedbStore::save_retained_heights`].
        pub fn load_retained_heights(&self) -> Result<Vec<(u32, [u8; 32])>> {
            match self.meta_get("retained_heights")? {
                Some(bytes) => bincode::deserialize(&bytes).map_err(backend),
                None => Ok(Vec::new()),
            }
        }

        /// Drop every state row and the undo journal (keeps the tables).
        pub fn clear_state(&self) -> Result<()> {
            let write = self.db.begin_write().map_err(backend)?;
            {
                write
                    .open_table(FROGS)
                    .map_err(backend)?
                    .retain(|_, _| false)
                    .map_err(backend)?;
                write
                    .open_table(COINS)
                    .map_err(backend)?
                    .retain(|_, _| false)
                    .map_err(backend)?;
                write
                    .open_table(UNDO)
                    .map_err(backend)?
                    .retain(|_, _| false)
                    .map_err(backend)?;
                let mut meta = write.open_table(META).map_err(backend)?;
                meta.retain(|_, _| false).map_err(backend)?;
                // The schema stamp is store identity, not state.
                let version = bincode::serialize(&SCHEMA_VERSION).map_err(backend)?;
                meta.insert(SCHEMA_KEY, version.as_slice())
                    .map_err(backend)?;
            }
            write.commit().map_err(backend)
        }

        /// Write a full state image as one batch (bootstrap a store from a
        /// snapshot-restored indexer, or a compaction pass).
        pub fn save_state(&self, state: &crate::state_machine::IndexState) -> Result<()> {
            self.clear_state()?;
            let mut write = BlockWrite::new(0);
            for (sat, record) in StateView::frogs_after(state, None, usize::MAX)? {
                write.put_frog(sat, Some(record));
            }
            for (outpoint, entry) in StateView::coins_after(state, None, usize::MAX)? {
                write.put_coin(outpoint, Some(entry));
            }
            let (height, hash) = StateView::tip(state)?;
            write.set_tip(height, hash);
            self.apply_write(&write, None)
        }

        /// Rehydrate a full state image from the store (restart without
        /// replay). Map iteration follows redb key order, which matches
        /// the `BTreeMap` order of the in-memory state.
        pub fn load_state(
            &self,
            config: crate::state_machine::IndexerConfig,
        ) -> Result<crate::state_machine::IndexState> {
            let mut state = crate::state_machine::IndexState::with_config(config);
            let read = self.db.begin_read().map_err(backend)?;
            {
                let table = read.open_table(FROGS).map_err(backend)?;
                for row in table.iter().map_err(backend)? {
                    let (_sat, value) = row.map_err(backend)?;
                    let record = bincode::deserialize(value.value()).map_err(backend)?;
                    StateStore::put_frog(&mut state, record)?;
                }
            }
            {
                let table = read.open_table(COINS).map_err(backend)?;
                for row in table.iter().map_err(backend)? {
                    let (key, value) = row.map_err(backend)?;
                    let outpoint = outpoint_from_key(key.value());
                    let entry = bincode::deserialize(value.value()).map_err(backend)?;
                    StateStore::put_coin(&mut state, outpoint, entry)?;
                }
            }
            let (height, hash) = StateView::tip(self)?;
            StateStore::set_tip(&mut state, height, hash)?;
            Ok(state)
        }

        /// Load the undo journal for `height`.
        pub fn undo(&self, height: u32) -> Result<Option<BlockEffects>> {
            let read = self.db.begin_read().map_err(backend)?;
            let table = read.open_table(UNDO).map_err(backend)?;
            match table.get(height as u64).map_err(backend)? {
                Some(bytes) => Ok(Some(bincode::deserialize(bytes.value()).map_err(backend)?)),
                None => Ok(None),
            }
        }

        /// Drop undo journals below `height` (finality pruning). Returns the
        /// number of entries removed.
        pub fn trim_undo_below(&self, height: u32) -> Result<usize> {
            let write = self.db.begin_write().map_err(backend)?;
            let removed = {
                let mut table = write.open_table(UNDO).map_err(backend)?;
                let keys: Vec<u64> = table
                    .range(..height as u64)
                    .map_err(backend)?
                    .map(|item| item.map(|(key, _)| key.value()).map_err(backend))
                    .collect::<Result<_>>()?;
                for key in &keys {
                    table.remove(*key).map_err(backend)?;
                }
                keys.len()
            };
            write.commit().map_err(backend)?;
            Ok(removed)
        }

        /// Every retained undo journal, ascending by height (backup/debug).
        pub fn undo_entries(&self) -> Result<Vec<(u32, BlockEffects)>> {
            let read = self.db.begin_read().map_err(backend)?;
            let table = read.open_table(UNDO).map_err(backend)?;
            let mut out = Vec::new();
            for row in table.iter().map_err(backend)? {
                let (key, value) = row.map_err(backend)?;
                out.push((
                    key.value() as u32,
                    bincode::deserialize(value.value()).map_err(backend)?,
                ));
            }
            Ok(out)
        }

        /// Copy this store's complete image — state, undo journal and the
        /// retained hash window — into a new database file. Refuses to
        /// overwrite. The source may be live: redb gives a consistent MVCC
        /// snapshot for the duration of each read transaction.
        pub fn copy_to(&self, path: &Path) -> Result<()> {
            if path.exists() {
                return Err(StoreError::Backend(format!(
                    "refusing to overwrite {}",
                    path.display()
                )));
            }
            let state = self.load_state(crate::state_machine::IndexerConfig::default())?;
            let heights = self.load_retained_heights()?;
            let undo = self.undo_entries()?;
            let dst = RedbStore::create(path)?;
            dst.save_state(&state)?;
            // The parameter commitment is part of the state identity: a
            // backup MUST carry its source's, never the local default.
            dst.set_params_hash(&self.params_hash()?)?;
            dst.save_retained_heights(&heights)?;
            for (height, effects) in &undo {
                dst.put_undo(*height, effects)?;
            }
            Ok(())
        }

        /// Lowest and highest retained undo heights, if any.
        pub fn undo_range(&self) -> Result<Option<(u32, u32)>> {
            let read = self.db.begin_read().map_err(backend)?;
            let table = read.open_table(UNDO).map_err(backend)?;
            let first = table
                .first()
                .map_err(backend)?
                .map(|(key, _)| key.value() as u32);
            let last = table
                .last()
                .map_err(backend)?
                .map(|(key, _)| key.value() as u32);
            Ok(match (first, last) {
                (Some(first), Some(last)) => Some((first, last)),
                _ => None,
            })
        }

        /// Apply one block's forward batch and its undo journal in a single
        /// transaction (P2.3d-2): state and undo can never diverge.
        pub fn commit_block_with_undo(
            &self,
            write: &BlockWrite,
            effects: &BlockEffects,
        ) -> Result<()> {
            self.apply_write(write, Some(effects))
        }

        /// Restore a journal's before-images in one transaction.
        ///
        /// `BlockEffects` names every key the block touched, so the inverse
        /// is a plain forward batch: put the before-image (or delete when
        /// the key did not exist), truncate history, restore the tip.
        pub fn apply_inverse(&self, effects: &BlockEffects) -> Result<()> {
            let mut write = BlockWrite::new(effects.height);
            for (sat, before) in effects.frogs() {
                write.put_frog(*sat, before.clone());
            }
            for (outpoint, before) in effects.coins() {
                write.put_coin(*outpoint, before.clone());
            }
            write.set_tip(effects.before_tip.0, effects.before_tip.1);
            self.apply_write(&write, None)
        }

        pub(crate) fn apply_write(
            &self,
            write: &BlockWrite,
            undo: Option<&BlockEffects>,
        ) -> Result<()> {
            // One redb transaction: state, history edits, meta, and (when
            // the caller uses `commit_block_with_undo`) the undo row.
            let db_write = self.db.begin_write().map_err(backend)?;
            {
                let mut table = db_write.open_table(FROGS).map_err(backend)?;
                for (sat, record) in &write.frogs {
                    match record {
                        Some(record) => {
                            let value = bincode::serialize(record).map_err(backend)?;
                            table.insert(*sat, value.as_slice()).map_err(backend)?;
                        }
                        None => {
                            table.remove(*sat).map_err(backend)?;
                        }
                    }
                }
            }
            {
                let mut table = db_write.open_table(COINS).map_err(backend)?;
                for (outpoint, entry) in &write.coins {
                    let key = coin_key(outpoint);
                    match entry {
                        Some(entry) => {
                            let value = bincode::serialize(entry).map_err(backend)?;
                            table
                                .insert(key.as_slice(), value.as_slice())
                                .map_err(backend)?;
                        }
                        None => {
                            table.remove(key.as_slice()).map_err(backend)?;
                        }
                    }
                }
            }
            {
                let mut table = db_write.open_table(META).map_err(backend)?;
                let height = bincode::serialize(&write.tip.0).map_err(backend)?;
                let hash = bincode::serialize(&write.tip.1).map_err(backend)?;
                table
                    .insert("tip_height", height.as_slice())
                    .map_err(backend)?;
                table.insert("tip_hash", hash.as_slice()).map_err(backend)?;
            }
            if let Some(effects) = undo {
                let mut table = db_write.open_table(UNDO).map_err(backend)?;
                let value = bincode::serialize(effects).map_err(backend)?;
                table
                    .insert(write.height as u64, value.as_slice())
                    .map_err(backend)?;
            }
            db_write.commit().map_err(backend)
        }
    }

    impl StateView for RedbStore {
        fn params_hash(&self) -> Result<[u8; 32]> {
            // The store records the commitment it was opened with; a
            // store written by another build must not share a root.
            match self.params_hash_opt()? {
                Some(hash) => Ok(hash),
                None => Ok(hopper_core::params::protocol_hash()),
            }
        }

        fn frog(&self, sat: u64) -> Result<Option<FroggerRecord>> {
            let read = self.db.begin_read().map_err(backend)?;
            let table = read.open_table(FROGS).map_err(backend)?;
            let value = table.get(sat).map_err(backend)?;
            match value {
                Some(bytes) => Ok(Some(bincode::deserialize(bytes.value()).map_err(backend)?)),
                None => Ok(None),
            }
        }

        fn frogs_after(
            &self,
            after: Option<u64>,
            limit: usize,
        ) -> Result<Vec<(u64, FroggerRecord)>> {
            let read = self.db.begin_read().map_err(backend)?;
            let table = read.open_table(FROGS).map_err(backend)?;
            let start = after.map(|a| a.saturating_add(1)).unwrap_or(0);
            let mut out = Vec::new();
            for item in table.range(start..).map_err(backend)? {
                let (key, value) = item.map_err(backend)?;
                out.push((
                    key.value(),
                    bincode::deserialize(value.value()).map_err(backend)?,
                ));
                if out.len() == limit {
                    break;
                }
            }
            Ok(out)
        }

        fn coin(&self, outpoint: &OutPoint) -> Result<Option<UtxoEntry>> {
            let read = self.db.begin_read().map_err(backend)?;
            let table = read.open_table(COINS).map_err(backend)?;
            let key = coin_key(outpoint);
            let value = table.get(key.as_slice()).map_err(backend)?;
            match value {
                Some(bytes) => Ok(Some(bincode::deserialize(bytes.value()).map_err(backend)?)),
                None => Ok(None),
            }
        }

        fn coins_after(
            &self,
            after: Option<&OutPoint>,
            limit: usize,
        ) -> Result<Vec<(OutPoint, UtxoEntry)>> {
            let read = self.db.begin_read().map_err(backend)?;
            let table = read.open_table(COINS).map_err(backend)?;
            let after_key = after.map(coin_key);
            let mut out = Vec::new();
            for item in table.iter().map_err(backend)? {
                let (key, value) = item.map_err(backend)?;
                let key_bytes = key.value();
                if let Some(after) = &after_key {
                    if key_bytes <= after.as_slice() {
                        continue;
                    }
                }
                out.push((
                    outpoint_from_key(key_bytes),
                    bincode::deserialize(value.value()).map_err(backend)?,
                ));
                if out.len() == limit {
                    break;
                }
            }
            Ok(out)
        }

        fn frog_count(&self) -> Result<usize> {
            let read = self.db.begin_read().map_err(backend)?;
            let table = read.open_table(FROGS).map_err(backend)?;
            Ok(table.len().map_err(backend)? as usize)
        }

        fn coin_count(&self) -> Result<usize> {
            let read = self.db.begin_read().map_err(backend)?;
            let table = read.open_table(COINS).map_err(backend)?;
            Ok(table.len().map_err(backend)? as usize)
        }

        fn tip(&self) -> Result<(Option<u32>, Option<[u8; 32]>)> {
            let height = match self.meta_get("tip_height")? {
                Some(bytes) => bincode::deserialize(&bytes).map_err(backend)?,
                None => None,
            };
            let hash = match self.meta_get("tip_hash")? {
                Some(bytes) => bincode::deserialize(&bytes).map_err(backend)?,
                None => None,
            };
            Ok((height, hash))
        }
    }

    impl StateStore for RedbStore {
        fn put_frog(&mut self, record: FroggerRecord) -> Result<()> {
            let value = bincode::serialize(&record).map_err(backend)?;
            let write = self.db.begin_write().map_err(backend)?;
            {
                let mut table = write.open_table(FROGS).map_err(backend)?;
                table
                    .insert(record.sat, value.as_slice())
                    .map_err(backend)?;
            }
            write.commit().map_err(backend)
        }

        fn remove_frog(&mut self, sat: u64) -> Result<Option<FroggerRecord>> {
            // Read first (own transaction), then delete: avoids holding a
            // redb access guard across the write transaction.
            let before = self.frog(sat)?;
            let write = self.db.begin_write().map_err(backend)?;
            {
                let mut table = write.open_table(FROGS).map_err(backend)?;
                table.remove(sat).map_err(backend)?;
            }
            write.commit().map_err(backend)?;
            Ok(before)
        }

        fn put_coin(&mut self, outpoint: OutPoint, entry: UtxoEntry) -> Result<()> {
            let key = coin_key(&outpoint);
            let value = bincode::serialize(&entry).map_err(backend)?;
            let write = self.db.begin_write().map_err(backend)?;
            {
                let mut table = write.open_table(COINS).map_err(backend)?;
                table
                    .insert(key.as_slice(), value.as_slice())
                    .map_err(backend)?;
            }
            write.commit().map_err(backend)
        }

        fn remove_coin(&mut self, outpoint: &OutPoint) -> Result<Option<UtxoEntry>> {
            let before = self.coin(outpoint)?;
            let key = coin_key(outpoint);
            let write = self.db.begin_write().map_err(backend)?;
            {
                let mut table = write.open_table(COINS).map_err(backend)?;
                table.remove(key.as_slice()).map_err(backend)?;
            }
            write.commit().map_err(backend)?;
            Ok(before)
        }

        fn set_tip(&mut self, height: Option<u32>, hash: Option<[u8; 32]>) -> Result<()> {
            let height = bincode::serialize(&height).map_err(backend)?;
            let hash = bincode::serialize(&hash).map_err(backend)?;
            self.meta_set("tip_height", &height)?;
            self.meta_set("tip_hash", &hash)
        }

        fn commit_block(&mut self, write: &BlockWrite) -> Result<()> {
            self.apply_write(write, None)
        }

        fn commit_undo(&mut self, effects: &BlockEffects) -> Result<()> {
            let mut write = BlockWrite::new(effects.height);
            for (sat, before) in effects.frogs() {
                write.put_frog(*sat, before.clone());
            }
            for (outpoint, before) in effects.coins() {
                write.put_coin(*outpoint, before.clone());
            }
            write.set_tip(effects.before_tip.0, effects.before_tip.1);
            self.apply_write(&write, None)
        }
    }
}
