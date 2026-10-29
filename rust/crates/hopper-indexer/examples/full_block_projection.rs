//! Worst-case projection: blocks filled with nothing but frog txs.
//!
//! Shape per tx: one P2TR keypath input, one OP_RETURN carrying the FRG
//! envelope, one P2TR change output.
//!
//! ```text
//! base   = 4 + 1 + 41 + 1 + (8+1+47) + (8+1+34) + 4 = 150 bytes (600 WU)
//!        ^ver ^in ^P2TR  ^outs ^CROSS push  ^change
//! witness= 1 + (1+64) + (1+33)                     = 100 WU
//! weight = 700 WU  =>  4_000_000 / 700 = 5,714 txs per 4M-WU block
//! ```
//!
//! `TARGET` is 6,000 — ~5% above the consensus ceiling, so the numbers
//! are slightly conservative. REVEAL/MINT envelopes are shorter, giving
//! ~6,300. Measures per-block index time, retained memory, event
//! volume, state growth, and v3 snapshot size (state + event log, no blocks).
//!
//! ```text
//! cargo run --release -p hopper-indexer --example full_block_projection
//! ```

use std::time::Instant;

use hopper_core::satmath::SatRange;
use hopper_core::{encode_mint, envelope, Action};
use hopper_indexer::state_machine::{Indexer, IndexerConfig};
use hopper_indexer::types::{Block, OutPoint, Tx, TxInput, TxOut};

const TARGET: usize = 6_000;
const VALUE: u64 = 1_000;
const SPACING: u64 = 2_000;
const BLOCKS: usize = 10;

fn b32(n: u64) -> [u8; 32] {
    let mut b = [0u8; 32];
    b[..8].copy_from_slice(&n.to_le_bytes());
    b
}

fn op(n: u64, vout: u32) -> OutPoint {
    OutPoint { txid: b32(n), vout }
}

fn plain_out(value: u64) -> TxOut {
    TxOut {
        value,
        op_return: None,
    }
}

fn env_out(payload: Vec<u8>) -> TxOut {
    TxOut {
        value: 0,
        op_return: Some(payload),
    }
}

fn rss_kib() -> u64 {
    let statm = std::fs::read_to_string("/proc/self/statm").unwrap_or_default();
    let pages: u64 = statm
        .split_whitespace()
        .nth(1)
        .and_then(|p| p.parse().ok())
        .unwrap_or(0);
    pages * 4
}

fn block(height: u32, txs: Vec<Tx>) -> Block {
    Block {
        hash: b32(1_000_000 + height as u64),
        height,
        txs,
    }
}

/// MINT tx: funding input → anchor output (output 0) + envelope.
fn mint_tx(id: u64, fund: OutPoint, seed: u32) -> Tx {
    Tx {
        txid: b32(id),
        inputs: vec![TxInput {
            prevout: fund,
            value: VALUE,
            inscription: None,
        }],
        outputs: vec![
            plain_out(VALUE),
            env_out(envelope(Action::Mint, &encode_mint(seed, "w"))),
        ],
    }
}

/// Transfer tx: spends the anchor UTXO, keeps the sat in output 0.
/// (The sat-tracking path is what a full block of frog movement costs;
/// the envelope is irrelevant to it.)
fn move_tx(id: u64, anchor: OutPoint) -> Tx {
    Tx {
        txid: b32(id),
        inputs: vec![TxInput {
            prevout: anchor,
            value: VALUE,
            inscription: None,
        }],
        outputs: vec![plain_out(VALUE)],
    }
}

fn env_f64(name: &str, default: f64) -> f64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn main() {
    // `--check` gate: generous defaults for CI, PERF_STRICT=1 for release.
    let check = std::env::args().any(|a| a == "--check");
    let strict = std::env::var("PERF_STRICT").is_ok_and(|v| v == "1");
    let max_us = env_f64("PERF_MAX_US_PER_TX", if strict { 5.0 } else { 20.0 });
    let max_kib_per_tx = env_f64("PERF_MAX_KIB_PER_TX", if strict { 2.0 } else { 8.0 });
    let max_bpf = env_f64(
        "PERF_MAX_BYTES_PER_FROG",
        if strict { 400.0 } else { 800.0 },
    );
    let mut idx = Indexer::new(IndexerConfig::default());
    let mut height = 0u32;
    let mut next_id = 1u64;
    let mut next_sat = 0u64;
    let mut anchors = Vec::new();

    println!("{TARGET} frog txs per block, {BLOCKS} blocks\n");

    // ---- block 1: 6000 mints (each mints a frog, the state-max path) ----
    let mut txs = Vec::with_capacity(TARGET);
    for _ in 0..TARGET {
        let fund = op(next_id, 1);
        idx.seed_utxo(fund, vec![SatRange::new(next_sat, next_sat + VALUE)]);
        let sat = next_sat;
        next_sat += SPACING;
        let id = next_id;
        next_id += 1;
        txs.push(mint_tx(id, fund, (sat / SPACING) as u32));
        // The mint anchors the frog sat in output 0 of its own tx.
        anchors.push((
            OutPoint {
                txid: b32(id),
                vout: 0,
            },
            sat,
        ));
    }
    height += 1;
    let before = rss_kib();
    let t0 = Instant::now();
    let report = idx.apply_block_unrecorded(block(height, txs)).unwrap();
    let mint_block = t0.elapsed();
    let after = rss_kib();
    println!(
        "mint block:   {:6.1} ms  {:5.2} µs/tx  events {:6}  RSS +{} MiB ({:.2} KiB/tx)",
        mint_block.as_secs_f64() * 1e3,
        mint_block.as_secs_f64() * 1e6 / TARGET as f64,
        report.events.len(),
        (after - before) / 1024,
        (after - before) as f64 / TARGET as f64
    );

    // ---- block 2: 6000 transfers of those frogs (highest-work path) ----
    let mut txs = Vec::with_capacity(TARGET);
    for &(anchor, _sat) in &anchors {
        let id = next_id;
        next_id += 1;
        txs.push(move_tx(id, anchor));
    }
    height += 1;
    let before = rss_kib();
    let t0 = Instant::now();
    let report = idx.apply_block_unrecorded(block(height, txs)).unwrap();
    let cross_block = t0.elapsed();
    let after = rss_kib();
    println!(
        "move block:   {:6.1} ms  {:5.2} µs/tx  events {:6}  RSS +{} MiB ({:.2} KiB/tx)",
        cross_block.as_secs_f64() * 1e3,
        cross_block.as_secs_f64() * 1e6 / TARGET as f64,
        report.events.len(),
        (after - before) / 1024,
        (after - before) as f64 / TARGET as f64
    );

    // ---- blocks 3..: fresh mints every block (sustained full blocks) ----
    let before = rss_kib();
    let t0 = Instant::now();
    let mut total = 0usize;
    for _ in 0..BLOCKS {
        let mut txs = Vec::with_capacity(TARGET);
        for _ in 0..TARGET {
            let fund = op(next_id, 1);
            idx.seed_utxo(fund, vec![SatRange::new(next_sat, next_sat + VALUE)]);
            let sat = next_sat;
            next_sat += SPACING;
            let id = next_id;
            next_id += 1;
            txs.push(mint_tx(id, fund, (sat / SPACING) as u32));
        }
        height += 1;
        idx.apply_block_unrecorded(block(height, txs)).unwrap();
        total += TARGET;
    }
    let sustained = t0.elapsed();
    let after = rss_kib();
    println!(
        "sustained:    {:6.1} ms/block  {:5.2} µs/tx  RSS +{} MiB ({:.2} KiB/tx), {} blocks retained",
        sustained.as_secs_f64() * 1e3 / BLOCKS as f64,
        sustained.as_secs_f64() * 1e6 / total as f64,
        (after - before) / 1024,
        (after - before) as f64 / total as f64,
        idx.chain().len(),
    );

    // ---- persistence cost (v3 snapshot = derived state + event tail) ----
    // No blocks are stored: restore is replay-free. The API keeps only a
    // bounded tail in memory (the rest is in append-only segments).
    idx.trim_events(4096);
    let t0 = Instant::now();
    let snap = idx.snapshot();
    let clone_time = t0.elapsed();
    let t0 = Instant::now();
    let bytes = bincode::serialize(&snap).unwrap().len();
    let ser_time = t0.elapsed();
    let frogs = idx.froggers().len();
    let events = idx.event_log().len();
    let txs_applied: usize = (BLOCKS + 2) * TARGET;
    println!(
        "snapshot:     {:.1} MiB for {} frogs + {} tail events ({} txs applied, {:.0} B/tx); blocks NOT stored",
        bytes as f64 / (1024.0 * 1024.0),
        frogs,
        events,
        txs_applied,
        bytes as f64 / txs_applied as f64,
    );
    println!(
        "serialize:    clone {:5.1} ms + bincode {:5.1} ms for {:.1} MiB (every-N snapshot rewrites it)",
        clone_time.as_secs_f64() * 1e3,
        ser_time.as_secs_f64() * 1e3,
        bytes as f64 / (1024.0 * 1024.0),
    );

    // ---- projection: 144 blocks/day, all full of frog txs ----
    let per_block_ram = after.saturating_sub(before) as f64 / BLOCKS as f64; // KiB/block
    let per_block_snap = bytes as f64 / BLOCKS as f64;
    let per_block_txs = TARGET as f64;
    let per_block_time_ms = sustained.as_secs_f64() * 1e3 / BLOCKS as f64;
    println!(
        "\nPer full block: {:.2} ms index, {:.1} MiB state RAM, {:.2} MiB state+events snapshot",
        sustained.as_secs_f64() * 1e3 / BLOCKS as f64,
        per_block_ram / 1024.0,
        per_block_snap / (1024.0 * 1024.0),
    );
    println!(
        "{:>6}  {:>12}  {:>14}  {:>16}  {:>24}",
        "day", "txs/day", "index CPU/day", "state RAM", "state+events snapshot"
    );
    for day in [1u64, 30, 365] {
        let blocks = 144 * day;
        let txs = blocks as f64 * per_block_txs;
        let ram = per_block_ram * blocks as f64 / (1024.0 * 1024.0); // KiB -> GiB
        let snap_gib = per_block_snap * blocks as f64 / (1024.0 * 1024.0);
        println!(
            "{:>6}  {:>12.0}  {:>13.1}s  {:>13.1} GiB  {:>20.0} GiB",
            day,
            txs,
            txs * 1.5e-6,
            ram,
            snap_gib / 1024.0,
        );
    }
    // v3 stores the state once plus a bounded event tail; the snapshot is
    // O(state), not O(chain). The state itself still grows with froggers.
    let peak_kib_per_block = per_block_ram * 1.0 + 2.0 * per_block_snap / 1024.0;
    let oom = |host_gib: f64| host_gib * 1024.0 * 1024.0 / peak_kib_per_block / 144.0;
    println!(
        "OOM (state growth): {:.1} MiB/block (state + 2x snapshot) => {:.0} d (16 GiB), {:.0} d (32 GiB), {:.0} d (64 GiB); the chain is retention-bounded",
        peak_kib_per_block / 1024.0,
        oom(16.0),
        oom(32.0),
        oom(64.0),
    );
    println!(
        "reorg undo: journal-driven (O(touched keys), no state clone); retention bounds the window ({:.1} ms/block to reapply)",
        per_block_time_ms,
    );
    println!(
        "chain retention: {} headers retained (no bodies, no base-state clone; production ring: HOPPER_RETAIN_BLOCKS, default 288)",
        idx.chain().len(),
    );
    if check {
        let us_per_tx = sustained.as_secs_f64() * 1e6 / (BLOCKS * TARGET) as f64;
        let kib_per_tx = per_block_ram / per_block_txs;
        let bytes_per_frog = bytes as f64 / frogs as f64;
        println!("\nPERF CHECK (full_block_projection, strict={strict})");
        let mut ok = true;
        for (name, value, limit, unit, hint) in [
            (
                "sustained per tx",
                us_per_tx,
                max_us,
                "µs/tx",
                "PERF_MAX_US_PER_TX",
            ),
            (
                "state RAM per tx",
                kib_per_tx,
                max_kib_per_tx,
                "KiB/tx",
                "PERF_MAX_KIB_PER_TX",
            ),
            (
                "snapshot per frog",
                bytes_per_frog,
                max_bpf,
                "B/frog",
                "PERF_MAX_BYTES_PER_FROG",
            ),
        ] {
            let pass = value <= limit;
            ok &= pass;
            println!(
                "  {name:<20} {value:>10.2} {unit:<8} limit {limit:>8.2}  {} ({hint})",
                if pass { "ok" } else { "FAIL" }
            );
        }
        if !ok {
            eprintln!("PERF CHECK FAILED: full_block_projection exceeded a threshold");
            std::process::exit(1);
        }
        println!("PERF CHECK OK");
    }
}
