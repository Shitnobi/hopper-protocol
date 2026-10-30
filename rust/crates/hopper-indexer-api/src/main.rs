//! `hopper-indexer-api` server binary.
//!
//! Startup order matters:
//! 1. **Restore** the indexer from the snapshot file (`HOPPER_SNAPSHOT_PATH`)
//!    if one exists; otherwise start fresh and apply bootstrap seeds from
//!    `HOPPER_SEEDS_FILE` (fresh starts only — snapshots embed seeds).
//! 2. **Spawn the ZMQ ingester** if `HOPPER_ZMQ_ADDR` is set: it
//!    catches up to bitcoind's tip and follows blocks and reorgs.
//! 3. **Serve** the REST API.
//!
//! Env:
//! - `HOPPER_API_ADDR` — bind address (default `127.0.0.1:9770`)
//! - `HOPPER_ACTIVATION_HEIGHT` — protocol genesis height H₀
//!   (default 900_000)
//! - `HOPPER_INSCRIPTION_ACTIVATION_HEIGHT` — Change B cutover: the
//!   block height from which MINTs must carry an ord inscription
//!   reveal on input 0 (unset = enforcement off, legacy mints
//!   accepted; inscriptions present are still recorded)
//! - `HOPPER_SNAPSHOT_PATH` — snapshot file (default
//!   `hopper-indexer.snapshot.bin`; v3 is binary, v2 JSON files are
//!   refused and must be reindexed)
//! - `HOPPER_SNAPSHOT_EVERY` — snapshot after this many new blocks
//!   (default 10)
//! - `HOPPER_RETAIN_BLOCKS` — retained block window for reorg replay
//!   (default 288; 0 = keep every block)
//! - `HOPPER_EVENT_SEGMENT` — events per append-only segment file
//!   (default 4096; the core keeps only the newest tail in memory)
//! - `HOPPER_SEEDS_FILE` — bootstrap seeds JSON for fresh starts
//! - `HOPPER_ZMQ_ADDR` — bitcoind `zmqpubhashblock` address; setting
//!   it enables the ingest wire (e.g. `tcp://127.0.0.1:28332`)
//! - `HOPPER_RPC_URL` / `HOPPER_RPC_COOKIE` / `HOPPER_RPC_USER` +
//!   `HOPPER_RPC_PASS` — bitcoind RPC for block fetches
//! - `HOPPER_ORD_URL` — optional ord server used to lazily seed coins
//!   the indexer has not seen (e.g. `http://127.0.0.1:8080`, or
//!   `https://ordinals.com`). Empty/unset disables the oracle; a fresh
//!   coinbase-descended wallet then needs an operator seed.
//! - `HOPPER_INGEST_START_HEIGHT` — **must be 0 or unset**. The
//!   indexer always ingests from the chain's genesis block: a later
//!   start can never name the coins created before it, which would make
//!   owned frogs look sent away (FIX_CONSENSUS A2). A non-zero value
//!   refuses to boot.

use std::sync::Arc;

use hopper_indexer::state_machine::{Indexer, IndexerConfig};
use hopper_indexer_api::engine;
use hopper_indexer_api::eventlog::EventStore;
use hopper_indexer_api::persist::{load_seeds_file, SnapshotStore};
use hopper_indexer_api::rpc::BitcoinRpc;
use hopper_indexer_api::zmq::{run_zmq_ingest, IngestConfig};
use hopper_indexer_api::{serve, ApiState};

/// Read a `HOPPER_*` setting, falling back to the legacy `FROGGER_*`
/// spelling so an existing deployment can migrate without editing its
/// service file.
fn env_var(name: &str) -> Result<String, std::env::VarError> {
    match std::env::var(name) {
        Ok(value) => Ok(value),
        Err(err) => {
            let legacy = name.replacen("HOPPER_", "FROGGER_", 1);
            std::env::var(legacy).map_err(|_| err)
        }
    }
}

fn env_u32(name: &str, default: u32) -> u32 {
    env_var(name)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}

fn env_usize(name: &str, default: usize) -> usize {
    env_var(name)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let addr: std::net::SocketAddr = env_var("HOPPER_API_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:9770".into())
        .parse()
        .expect("HOPPER_API_ADDR must be host:port");
    // H₀ for v2.0 (0x03). Future wire versions ship with their own
    // announced heights (SPEC §3.1 version schedule).
    let activation_height: u32 = env_u32("HOPPER_ACTIVATION_HEIGHT", 900_000);
    // Change B: height from which MINTs must carry an ord inscription
    // reveal (None / unset = enforcement off — legacy mints accepted).
    let inscription_activation_height: Option<u32> =
        env_var("HOPPER_INSCRIPTION_ACTIVATION_HEIGHT")
            .ok()
            .and_then(|v| v.parse().ok());
    let snapshot_path =
        env_var("HOPPER_SNAPSHOT_PATH").unwrap_or_else(|_| "hopper-indexer.snapshot.bin".into());
    let snapshot_every = env_u32("HOPPER_SNAPSHOT_EVERY", 10);
    // Genesis-only ingest, always. A fresh indexer that starts later can
    // never name the coins created before its start height: every such
    // coin would look "not tracked", and a wallet hiding frogs on that
    // answer would hide owned frogs (FIX_CONSENSUS A2). The env var is
    // kept only to fail loudly on old deployments instead of silently
    // changing their coverage.
    let start_height = match env_var("HOPPER_INGEST_START_HEIGHT") {
        Ok(v) if v.trim() != "0" => {
            return Err(format!(
                "HOPPER_INGEST_START_HEIGHT={v} is not supported: the indexer always \
                 ingests from genesis so every coin can be attributed"
            )
            .into());
        }
        _ => 0,
    };
    // 0 disables trimming (the old behavior). With a nonzero window the
    // ingest loop drops old blocks in chunks; state is unaffected.
    let retain_blocks = env_usize("HOPPER_RETAIN_BLOCKS", 288);
    let event_segment = env_usize("HOPPER_EVENT_SEGMENT", 4096);
    // 0 = keep every segment (events are re-derivable; this bounds disk).
    let event_retain = env_usize("HOPPER_EVENT_RETAIN_SEGMENTS", 0);

    // There is one wire version (`0x07`): nothing to schedule and no
    // origin to freeze. `HOPPER_ACTIVATION_HEIGHT` is the hop-schedule
    // genesis, which lives in the compiled parameters.
    let _ = activation_height;

    let config = IndexerConfig {
        inscription_activation_height,
        ..Default::default()
    };
    let seeds = match env_var("HOPPER_SEEDS_FILE") {
        Ok(seeds_file) => load_seeds_file(std::path::Path::new(&seeds_file))
            .map_err(|e| format!("HOPPER_SEEDS_FILE: {e}"))?,
        Err(_) => Vec::new(),
    };

    // 1. Restore. The durable store wins when it has a tip (P2.4): its
    // state image plus retained hash window is the whole index, so no
    // snapshot read and no block replay. Otherwise restore the snapshot,
    // or start fresh with the bootstrap seeds.
    let reindex = env_var("HOPPER_REINDEX")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    // `HOPPER_DB_CACHE_MIB` bounds redb's page cache (0/unset = redb's
    // 1 GiB default). A bound trades re-reads for RAM; the engine image
    // itself is the consensus working set.
    #[cfg(feature = "redb")]
    let cache_bytes = env_var("HOPPER_DB_CACHE_MIB")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|mib| *mib > 0)
        .map(|mib| mib * 1024 * 1024);
    #[cfg(feature = "redb")]
    let mut api_store_handle: Option<
        std::sync::Arc<hopper_indexer::store::redb_store::RedbStore>,
    > = None;
    #[cfg(feature = "redb")]
    let db_path_env = env_var("HOPPER_DB").ok();
    // `HOPPER_REINDEX=1` removes the store FILE: a schema bump changes the
    // bincode layout, so there is nothing to salvage and `RedbStore::create`
    // refuses an older schema on purpose.
    #[cfg(feature = "redb")]
    if reindex {
        if let Some(db_path) = &db_path_env {
            let path = std::path::Path::new(db_path);
            if path.exists() {
                std::fs::remove_file(path)
                    .map_err(|e| format!("HOPPER_REINDEX {}: {e}", path.display()))?;
            }
            println!("reindex: removed the durable store at {db_path}");
        }
    }
    #[cfg(feature = "redb")]
    let mut durable_store = match db_path_env {
        Some(db_path) => Some(
            hopper_indexer::store::redb_store::RedbStore::create_with_cache(
                std::path::Path::new(&db_path),
                cache_bytes,
            )
            .map_err(|e| format!("HOPPER_DB {db_path}: {e}"))?,
        ),
        None => None,
    };
    #[cfg(feature = "redb")]
    let durable_tip = if reindex {
        None
    } else {
        match &durable_store {
            Some(store) => {
                hopper_indexer::store::StateView::tip(store)
                    .map_err(|e| format!("HOPPER_DB: {e}"))?
                    .0
            }
            None => None,
        }
    };

    let load_snapshot =
        || -> Result<(Indexer, Option<u32>), Box<dyn std::error::Error + Send + Sync>> {
            if !reindex {
                match SnapshotStore::load_with_params(
                    std::path::Path::new(&snapshot_path),
                    &config.params,
                ) {
                    Ok(Some(indexer)) => {
                        let tip = indexer.tip_height();
                        println!(
                            "restored indexer from {snapshot_path}: tip {:?}, {} blocks, {} seed(s)",
                            tip,
                            indexer.chain().len(),
                            indexer.seeds().len()
                        );
                        return Ok((indexer, tip));
                    }
                    Ok(None) => {}
                    Err(e) => return Err(format!("snapshot {snapshot_path}: {e}").into()),
                }
            }
            let mut indexer = Indexer::new(config.clone());
            for (outpoint, ranges) in &seeds {
                indexer.seed_utxo(*outpoint, ranges.clone());
            }
            println!(
                "fresh indexer (activation H₀={activation_height}), {} seed(s){}",
                seeds.len(),
                if reindex { " [reindex]" } else { "" }
            );
            Ok((indexer, None))
        };

    // `HOPPER_ENGINE=store` makes the store the consensus state: the
    // process holds only the block being applied, not a second full image.
    // The default keeps the engine in memory with the store as a mirror.
    #[cfg(feature = "redb")]
    let store_engine = durable_store.is_some()
        && env_var("HOPPER_ENGINE")
            .map(|v| v.eq_ignore_ascii_case("store"))
            .unwrap_or(false);

    #[cfg(feature = "redb")]
    let (engine, restored_tip) = if store_engine {
        let store = std::sync::Arc::new(durable_store.take().expect("store mode needs HOPPER_DB"));
        let tip = hopper_indexer::store::StateView::tip(&*store)
            .map_err(|e| format!("HOPPER_DB: {e}"))?
            .0;
        let mut engine =
            engine::Engine::store(std::sync::Arc::clone(&store), config.clone(), seeds.clone())
                .map_err(|e| format!("HOPPER_DB: {e}"))?;
        engine.register_heights(
            store
                .load_retained_heights()
                .map_err(|e| format!("HOPPER_DB: {e}"))?,
        );
        println!("store-backed engine: tip {tip:?}, no state image in memory");
        api_store_handle = Some(store);
        (engine, tip)
    } else if let (Some(store), Some(tip)) = (&durable_store, durable_tip) {
        let state = store
            .load_state(config.clone())
            .map_err(|e| format!("HOPPER_DB: {e}"))?;
        let mut indexer = Indexer::from_loaded_state(state, seeds.clone());
        indexer.register_heights(
            store
                .load_retained_heights()
                .map_err(|e| format!("HOPPER_DB: {e}"))?,
        );
        println!("restored from durable store: tip {tip}, no replay");
        (engine::Engine::memory(indexer), Some(tip))
    } else {
        let (indexer, tip) = load_snapshot()?;
        (engine::Engine::memory(indexer), tip)
    };
    #[cfg(not(feature = "redb"))]
    let (engine, restored_tip) = {
        let (indexer, tip) = load_snapshot()?;
        (engine::Engine::memory(indexer), tip)
    };

    // Event segments live beside the snapshot. On restart they are
    // reconciled to the restored tip: events appended after the last
    // checkpoint are dropped (the source re-emits them deterministically).
    let restored = restored_tip.is_some();
    let tip = engine.tip_height();
    let tail = engine.event_log().to_vec();
    let event_dir = std::path::PathBuf::from(format!("{snapshot_path}.events"));
    let event_store = EventStore::open(event_dir.clone(), event_segment)
        .map_err(|e| format!("event log {}: {e}", event_dir.display()))?;
    if event_store.recovered_bytes() > 0 {
        eprintln!(
            "event log: dropped a torn tail record ({} bytes) from {}",
            event_store.recovered_bytes(),
            event_dir.display()
        );
    }
    #[cfg_attr(not(feature = "redb"), allow(unused_mut))]
    let mut api = ApiState::with_persistence_engine(
        engine,
        SnapshotStore::new(
            std::path::PathBuf::from(&snapshot_path),
            snapshot_every,
            restored_tip,
        ),
        event_store,
    );
    // Attach the mirror. A fresh store is bootstrapped from the restored
    // image; a store that disagrees with it is rebuilt (the restored
    // engine is authoritative at this point).
    #[cfg(feature = "redb")]
    if let Some(store) = api_store_handle.take() {
        api.attach_store(store);
        api.set_undo_retention(retain_blocks as u32 + 6);
        println!("store-backed engine attached (reads share the store)");
    } else if let Some(store) = durable_store.take() {
        use hopper_indexer::store::StateView;
        let engine_tip = api.read().tip_height();
        let store_tip = StateView::tip(&store)
            .map_err(|e| format!("HOPPER_DB: {e}"))?
            .0;
        if store_tip.is_some() && store_tip != engine_tip {
            eprintln!(
                "[durable] store tip {store_tip:?} != engine tip {engine_tip:?}; rebuilding the mirror"
            );
            let image = api
                .read()
                .state()
                .cloned()
                .ok_or("mirror rebuild needs a memory engine")?;
            store
                .save_state(&image)
                .map_err(|e| format!("HOPPER_DB: {e}"))?;
        }
        api.attach_durable(store)
            .map_err(|e| format!("HOPPER_DB: {e}"))?;
        api.set_undo_retention(retain_blocks as u32 + 6);
        println!("durable state mirror attached");
    }
    // Admin surface: a token makes `/v1/admin/*` require
    // `Authorization: Bearer <token>`; without one, `serve` refuses a
    // non-loopback bind (never expose rollback/block injection).
    if let Ok(token) = env_var("HOPPER_ADMIN_TOKEN") {
        api = api.with_admin_token(token);
        println!("admin routes require HOPPER_ADMIN_TOKEN");
    }
    if let Ok(ord_url) = env_var("HOPPER_ORD_URL") {
        if !ord_url.trim().is_empty() {
            api = api.with_ord_url(&ord_url);
            println!("ord: lazy sat-range seeding from {ord_url}");
        }
    }
    // The protocol commitment (V3-FINAL-SPEC §2.3): print it so deployment
    // notes and the browser wallet can compare. Changing `genesis` or any
    // schedule constant changes this hash.
    println!(
        "params_hash={} (wire v{}, genesis {})",
        hopper_core::params::params_hash(&hopper_core::params::PROTOCOL)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>(),
        hopper_core::VERSION,
        hopper_core::params::PROTOCOL.generations.genesis,
    );
    let state = Arc::new(api);
    if restored {
        state.reconcile_events(tip, &tail);
    } else {
        state.clear_events();
    }
    if event_retain > 0 {
        let pruned = state.prune_events(event_retain);
        if pruned > 0 {
            println!("event log: pruned {pruned} old segment(s), keeping {event_retain}");
        }
    }

    // 2. ZMQ ingest (optional). The RPC is also kept on the shared
    //    state either way when env credentials exist — /v1/mempool
    //    (B4 leftovers) needs it even without the ZMQ wire.
    let rpc = BitcoinRpc::from_env();
    if let Ok(rpc) = rpc.clone() {
        // Chain identity for the wallet's trust check (A6): the network
        // name and block 0. Best-effort — absent is honest.
        let network = rpc
            .call("getblockchaininfo", serde_json::json!([]))
            .ok()
            .and_then(|v| v["chain"].as_str().map(str::to_owned))
            .or_else(|| env_var("HOPPER_NETWORK").ok());
        let genesis = rpc
            .call("getblockhash", serde_json::json!([0]))
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .or_else(|| env_var("HOPPER_GENESIS_HASH").ok());
        state.set_chain_identity(network, genesis);
        state.set_rpc(Arc::new(rpc));
    } else if let Ok(network) = env_var("HOPPER_NETWORK") {
        state.set_chain_identity(Some(network), env_var("HOPPER_GENESIS_HASH").ok());
    }
    if let Ok(zmq_addr) = env_var("HOPPER_ZMQ_ADDR") {
        let rpc = rpc.map_err(|e| format!("HOPPER_ZMQ_ADDR set but {e}"))?;
        let rpc_url = env_var("HOPPER_RPC_URL").unwrap_or_else(|_| "http://127.0.0.1:18443".into());
        println!("ingest: ZMQ {zmq_addr} via RPC {rpc_url} (start height {start_height})");
        let cfg = IngestConfig {
            zmq_addr,
            rpc,
            start_height,
            retain_blocks,
        };
        tokio::spawn(run_zmq_ingest(state.clone(), cfg));
    } else {
        println!("ingest: POST /v1/admin/block (set HOPPER_ZMQ_ADDR for the ZMQ wire)");
    }

    // 3. Serve.
    println!(
        "FROGGER indexer API on http://{addr} (snapshot: {snapshot_path}, every {snapshot_every})"
    );
    serve(state, addr).await
}
