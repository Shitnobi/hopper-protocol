//! Durability tax: per-block commit cost of [`DurableIndexer`] versus the
//! in-memory engine. Blocks are empty (no txs): this isolates the cost the
//! store adds — batch construction, one redb transaction, and the undo row.
//!
//! ```text
//! cargo run --release -p hopper-indexer --features redb --example durable_ingest
//! cargo run --release -p hopper-indexer --features redb --example durable_ingest -- --check
//! ```
//!
//! `PERF_MAX_DURABLE_US` (default 2000) bounds µs/block under `--check`;
//! `DURABLE_BLOCKS` (default 2000) sets the run length.

use std::path::PathBuf;
use std::time::Instant;

use hopper_core::satmath::SatRange;
use hopper_indexer::durable::DurableIndexer;
use hopper_indexer::state_machine::{Indexer, IndexerConfig};
use hopper_indexer::types::{Block, OutPoint};

fn op(txid: u8, vout: u32) -> OutPoint {
    OutPoint {
        txid: [txid; 32],
        vout,
    }
}

fn empty(height: u32) -> Block {
    Block {
        hash: [height as u8; 32],
        height,
        txs: vec![],
    }
}

fn main() {
    let check = std::env::args().any(|a| a == "--check");
    let blocks: u32 = std::env::var("DURABLE_BLOCKS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(2000);
    let max_us: f64 = std::env::var("PERF_MAX_DURABLE_US")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(2000.0);

    let dir = std::env::temp_dir().join(format!("frogger-durable-bench-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path: PathBuf = dir.join("bench.redb");
    let seeds = vec![(op(1, 0), vec![SatRange::new(0, 100_000)])];

    let mut durable = DurableIndexer::open(&path, IndexerConfig::default(), seeds.clone()).unwrap();
    let start = 100u32;
    let t0 = Instant::now();
    for height in start..start + blocks {
        durable.apply_block(empty(height)).unwrap();
    }
    let durable_elapsed = t0.elapsed();
    let file_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);

    let mut memory = Indexer::new(IndexerConfig::default());
    memory.seed_utxo(op(1, 0), vec![SatRange::new(0, 100_000)]);
    let t0 = Instant::now();
    for height in start..start + blocks {
        memory.apply_block(empty(height)).unwrap();
    }
    let memory_elapsed = t0.elapsed();

    let durable_us = durable_elapsed.as_secs_f64() * 1e6 / blocks as f64;
    let memory_us = memory_elapsed.as_secs_f64() * 1e6 / blocks as f64;
    println!(
        "blocks={blocks} durable={durable_us:.1} us/block memory={memory_us:.1} us/block \
         ratio={:.1}x db={:.1} KiB",
        durable_us / memory_us.max(f64::MIN_POSITIVE),
        file_bytes as f64 / 1024.0
    );

    let _ = std::fs::remove_dir_all(&dir);

    if check && durable_us > max_us {
        eprintln!("durable ingest {durable_us:.1} us/block exceeds {max_us:.1}");
        std::process::exit(1);
    }
}
