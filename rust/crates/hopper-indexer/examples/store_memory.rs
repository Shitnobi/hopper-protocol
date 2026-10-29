//! Memory cost of the durable mirror: engine state alone vs. engine + store.
//!
//! Both modes apply the same mint-only workload (each tx mints one frog, the
//! state-max path). `--mode memory` runs the plain [`Indexer`]; `--mode
//! durable` runs [`DurableIndexer`], which keeps the engine image *and*
//! mirrors every block into redb.
//!
//! Reported live (not peak) figures come from `/proc/self/status`:
//! `RssAnon` is the engine image (must fit in RAM); `RssFile` is mostly the
//! redb mmap (reclaimable page cache).
//!
//! ```text
//! cargo run -q --release -p hopper-indexer --features redb --example store_memory -- --mode memory
//! cargo run -q --release -p hopper-indexer --features redb --example store_memory -- --mode durable
//! ```

use std::time::Instant;

use hopper_core::satmath::SatRange;
use hopper_core::{encode_mint, envelope, Action};
use hopper_indexer::durable::DurableIndexer;
use hopper_indexer::state_machine::{Indexer, IndexerConfig};
use hopper_indexer::store::redb_store::RedbStore;
use hopper_indexer::store_state::StoreState;
use hopper_indexer::types::{Block, OutPoint, Tx, TxInput, TxOut};

const VALUE: u64 = 1_000;
const SPACING: u64 = 2_000;

fn b32(n: u64) -> [u8; 32] {
    let mut b = [0u8; 32];
    b[..8].copy_from_slice(&n.to_le_bytes());
    b
}

fn op(n: u64, vout: u32) -> OutPoint {
    OutPoint { txid: b32(n), vout }
}

fn block(height: u32, txs: Vec<Tx>) -> Block {
    Block {
        hash: b32(1_000_000 + height as u64),
        height,
        txs,
    }
}

fn mint_tx(id: u64, fund: OutPoint, seed: u32) -> Tx {
    Tx {
        txid: b32(id),
        inputs: vec![TxInput {
            prevout: fund,
            value: VALUE,
            inscription: None,
        }],
        outputs: vec![
            TxOut {
                value: VALUE,
                op_return: None,
            },
            TxOut {
                value: 0,
                op_return: Some(envelope(Action::Mint, &encode_mint(seed, "w"))),
            },
        ],
    }
}

fn status_kib(field: &str) -> u64 {
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix(field) {
            return rest
                .split_whitespace()
                .next()
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
        }
    }
    0
}

fn env_f64(name: &str, default: f64) -> f64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = args
        .iter()
        .position(|a| a == "--mode")
        .and_then(|i| args.get(i + 1))
        .cloned()
        .unwrap_or_else(|| "memory".into());
    let durable = mode == "durable";
    let store_mode = mode == "store";
    let check = std::env::args().any(|a| a == "--check");
    let check_inner = std::env::args().any(|a| a == "--check-inner");
    let blocks = env_usize("MEM_BLOCKS", 20);
    let per_block = env_usize("MEM_TXS", 2_000);

    // One funding coin per mint: the frog sat lives in output 0 of the mint.
    let mut fundings = Vec::with_capacity(blocks * per_block);
    let mut next_sat = 0u64;
    for id in (1u64..).take(blocks * per_block) {
        fundings.push((id, next_sat));
        next_sat += SPACING;
    }

    let dir = std::env::temp_dir().join(format!("frogger-store-memory-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let t_seed = Instant::now();
    let cache_mib: usize = std::env::var("MEM_CACHE_MIB")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let cache_bytes = (cache_mib > 0).then_some(cache_mib * 1024 * 1024);
    let mut memory = if durable {
        let path = dir.join("memory.redb");
        let mut indexer = DurableIndexer::open_with_cache(
            &path,
            IndexerConfig::default(),
            Vec::new(),
            cache_bytes,
        )
        .unwrap();
        indexer
            .seed_utxos(
                fundings
                    .iter()
                    .map(|&(id, sat)| (op(id, 1), vec![SatRange::new(sat, sat + VALUE)])),
            )
            .unwrap();
        Some((indexer, path))
    } else {
        None
    };
    // Store-backed engine: the consensus state *is* the store; only the
    // block being applied is buffered.
    let mut stored: Option<Indexer<StoreState>> = if store_mode {
        let path = dir.join("state.redb");
        let store = RedbStore::create_with_cache(&path, cache_bytes).unwrap();
        let state = StoreState::new(IndexerConfig::default(), std::sync::Arc::new(store)).unwrap();
        let mut engine = Indexer::from_loaded_state(state, Vec::new());
        for &(id, sat) in &fundings {
            engine.seed_utxo(op(id, 1), vec![SatRange::new(sat, sat + VALUE)]);
        }
        Some(engine)
    } else {
        None
    };
    let mut plain = Indexer::new(IndexerConfig::default());
    if !durable {
        for &(id, sat) in &fundings {
            plain.seed_utxo(op(id, 1), vec![SatRange::new(sat, sat + VALUE)]);
        }
    }
    let seed_time = t_seed.elapsed();

    let started = Instant::now();
    let mut applied = 0usize;
    for b in 0..blocks {
        let mut txs = Vec::with_capacity(per_block);
        for i in 0..per_block {
            let (id, sat) = fundings[b * per_block + i];
            txs.push(mint_tx(id, op(id, 1), (sat / SPACING) as u32));
        }
        let height = 100 + b as u32;
        match (&mut memory, &mut stored) {
            (Some((indexer, _)), _) => {
                indexer.apply_block(block(height, txs)).unwrap();
            }
            (None, Some(engine)) => {
                let (_, effects, write) = engine.apply_block_recorded(block(height, txs)).unwrap();
                engine.state_mut().commit(&write, &effects).unwrap();
            }
            (None, None) => {
                plain.apply_block_unrecorded(block(height, txs)).unwrap();
            }
        }
        applied += per_block;
    }
    let elapsed = started.elapsed();
    let root = match (&memory, &stored) {
        (Some((indexer, _)), _) => indexer.state().state_root(),
        (None, Some(engine)) => engine.state_root(),
        (None, None) => plain.state_root(),
    };
    let db_kib = memory
        .as_ref()
        .and_then(|(_, path)| std::fs::metadata(path).ok())
        .map(|m| m.len() / 1024)
        .or_else(|| {
            stored.as_ref().and_then(|_| {
                std::fs::metadata(dir.join("state.redb"))
                    .ok()
                    .map(|m| m.len() / 1024)
            })
        })
        .unwrap_or(0);

    let us_per_tx = elapsed.as_secs_f64() * 1e6 / applied as f64;
    let anon = status_kib("RssAnon:");
    println!(
        "mode={} blocks={} txs={} seed={:.1}ms apply={:.1}ms {:.2}us/tx \
         rss={} anon={} file={} db={} root={}",
        if durable {
            "durable"
        } else if store_mode {
            "store"
        } else {
            "memory"
        },
        blocks,
        applied,
        seed_time.as_secs_f64() * 1e3,
        elapsed.as_secs_f64() * 1e3,
        us_per_tx,
        status_kib("VmRSS:"),
        anon,
        status_kib("RssFile:"),
        db_kib,
        root.iter()
            .take(4)
            .map(|b| format!("{b:02x}"))
            .collect::<String>(),
    );
    // Cross-process comparison gate: run the other mode and compare the
    // anonymous (non-reclaimable) images. `MEM_MAX_RATIO` (default 2.0) is
    // deliberately generous — it catches a second full state image, not
    // allocator noise.
    if check && !durable && !check_inner {
        let ratio_max = env_f64("MEM_MAX_RATIO", 2.0);
        let other = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--mode", "durable", "--check-inner"])
            .env("MEM_BLOCKS", blocks.to_string())
            .env("MEM_TXS", per_block.to_string())
            .output()
            .expect("re-run in durable mode");
        let line = String::from_utf8_lossy(&other.stdout);
        let durable_anon = line
            .split_whitespace()
            .find_map(|f| f.strip_prefix("anon="))
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        let ratio = durable_anon as f64 / anon.max(1) as f64;
        println!(
            "\nMEM CHECK anon durable/memory = {ratio:.2}x (limit {ratio_max:.2}x); \
             durable {durable_anon} KiB, memory {anon} KiB"
        );
        if ratio > ratio_max {
            eprintln!("MEM CHECK FAILED: durable mirror holds a second full image");
            std::process::exit(1);
        }
        println!("MEM CHECK OK");
    }

    let _ = std::fs::remove_dir_all(&dir);
}
