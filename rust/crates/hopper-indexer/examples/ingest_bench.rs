//! Synthetic ingest benchmark for the pure indexer core.
//!
//! Measures the two paths that dominate steady-state indexing:
//!
//! 1. **per-transaction cost vs. frogger population** — every tx walks
//!    the frogger-location index to find anchors it spends;
//! 2. **rollback cost** — reorgs re-derive state by replaying the
//!    retained chain.
//!
//! Run with:
//!
//! ```text
//! cargo run --release -p hopper-indexer --example ingest_bench
//! ```

use std::collections::HashMap;
use std::time::Instant;

use hopper_core::satmath::SatRange;
use hopper_core::{encode_mint, envelope, Action};
use hopper_indexer::state_machine::{Indexer, IndexerConfig};
use hopper_indexer::types::{Block, OutPoint, Tx, TxInput, TxOut};

const VALUE: u64 = 1_000;
/// One frogger per `SPACING` sats, so ranges never overlap.
const SPACING: u64 = 2_000;
const TXS: usize = 20_000;

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

/// Resident set size in KiB (Linux), for the retention/memory audit.
fn rss_kib() -> u64 {
    let statm = std::fs::read_to_string("/proc/self/statm").unwrap_or_default();
    let pages: u64 = statm
        .split_whitespace()
        .nth(1)
        .and_then(|p| p.parse().ok())
        .unwrap_or(0);
    pages * 4 // 4 KiB pages
}

fn block(height: u32, txs: Vec<Tx>) -> Block {
    Block {
        hash: b32(1_000_000 + height as u64),
        height,
        txs,
    }
}

fn env_f64(name: &str, default: f64) -> f64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn main() {
    // `--check` turns the benchmark into a regression gate. Thresholds are
    // deliberately generous by default (noisy CI runners); PERF_STRICT=1
    // applies the release ceilings. Every limit is env-overridable.
    let check = std::env::args().any(|a| a == "--check");
    let strict = std::env::var("PERF_STRICT").is_ok_and(|v| v == "1");
    let max_us = env_f64("PERF_MAX_US_PER_TX", if strict { 1.5 } else { 5.0 });
    let max_bpf = env_f64(
        "PERF_MAX_BYTES_PER_FROG",
        if strict { 400.0 } else { 800.0 },
    );
    let max_rollback = env_f64("PERF_MAX_ROLLBACK_MS", if strict { 50.0 } else { 500.0 });
    let mut worst_us = 0.0f64;
    let mut worst_bpf = 0.0f64;
    let mut worst_rollback = 0.0f64;
    let frogger_counts = [100usize, 1_000, 10_000];
    println!("{TXS} noise txs per run\n");
    println!(
        "{:>10}  {:>12}  {:>12}  {:>10}",
        "froggers", "mint+apply", "noise apply", "per tx"
    );
    for &n in &frogger_counts {
        let mut idx = Indexer::new(IndexerConfig::default());
        let mut height = 0u32;
        let mut mint_cursor = 0u64;

        // --- mints: seed a funding UTXO, then a MINT tx spending it ---
        let t0 = Instant::now();
        for chunk_start in (0..n).step_by(500) {
            let mut txs = Vec::new();
            for i in chunk_start..(chunk_start + 500).min(n) {
                let fund = op(mint_cursor, 0);
                mint_cursor += 1;
                idx.seed_utxo(
                    fund,
                    vec![SatRange::new(
                        (i as u64) * SPACING,
                        (i as u64) * SPACING + VALUE,
                    )],
                );
                txs.push(Tx {
                    txid: b32(mint_cursor),
                    inputs: vec![TxInput {
                        prevout: fund,
                        value: VALUE,
                        inscription: None,
                    }],
                    outputs: vec![
                        plain_out(VALUE),
                        env_out(envelope(Action::Mint, &encode_mint(i as u32, "bench"))),
                    ],
                });
                mint_cursor += 1;
            }
            height += 1;
            idx.apply_block(block(height, txs)).unwrap();
        }
        let mint_time = t0.elapsed();

        // --- noise: one plain spend chain, touching no frogger sat ---
        // Funding input is untracked (shadow); each tx spends the
        // previous output, so the UTXO set stays O(1) for the noise leg.
        let mut prev = op(mint_cursor, 0);
        height += 1;
        idx.apply_block(block(
            height,
            vec![Tx {
                txid: b32(mint_cursor),
                inputs: vec![TxInput {
                    prevout: prev,
                    value: VALUE,
                    inscription: None,
                }],
                outputs: vec![plain_out(VALUE)],
            }],
        ))
        .unwrap();
        prev = OutPoint {
            txid: b32(mint_cursor),
            vout: 0,
        };

        let t1 = Instant::now();
        for ids in (mint_cursor + 1..)
            .take(TXS)
            .collect::<Vec<_>>()
            .chunks(100)
        {
            height += 1;
            let mut txs = Vec::with_capacity(ids.len());
            for &id in ids {
                txs.push(Tx {
                    txid: b32(id),
                    inputs: vec![TxInput {
                        prevout: prev,
                        value: VALUE,
                        inscription: None,
                    }],
                    outputs: vec![plain_out(VALUE)],
                });
                prev = OutPoint {
                    txid: b32(id),
                    vout: 0,
                };
            }
            idx.apply_block(block(height, txs)).unwrap();
        }
        let noise = t1.elapsed();
        let us_per_tx = noise.as_secs_f64() * 1e6 / TXS as f64;
        worst_us = worst_us.max(us_per_tx);
        println!(
            "{:>10}  {:>10.1}ms  {:>10.1}ms  {:>8.2}µs",
            n,
            mint_time.as_secs_f64() * 1e3,
            noise.as_secs_f64() * 1e3,
            us_per_tx
        );

        // --- rollback: replay from the base state (bounded window) ---
        // Persistence cost: v3 stores derived state + a bounded event tail.
        idx.trim_events(4096);
        let snap = idx.snapshot();
        let bytes = bincode::serialize(&snap).unwrap().len();
        println!(
            "{:>10}  snapshot (state+events): {:.3} MiB, {} frogs, {} events, {} blocks retained",
            "",
            bytes as f64 / (1024.0 * 1024.0),
            idx.froggers().len(),
            idx.event_log().len(),
            idx.chain().len(),
        );

        let bytes_per_frog = bytes as f64 / n as f64;
        worst_bpf = worst_bpf.max(bytes_per_frog);
        let t2 = Instant::now();
        idx.rollback(1).unwrap();
        let rollback_ms = t2.elapsed().as_secs_f64() * 1e3;
        worst_rollback = worst_rollback.max(rollback_ms);
        println!(
            "{:>10}  rollback(1) over {} blocks: {:.1}ms; RSS {} MiB ({} blocks)",
            "",
            idx.chain().len(),
            rollback_ms,
            rss_kib() / 1024,
            idx.chain().len()
        );
    }

    if check {
        println!("\nPERF CHECK (ingest_bench, strict={strict})");
        let mut ok = true;
        for (name, value, limit, unit, hint) in [
            (
                "noise per tx",
                worst_us,
                max_us,
                "µs/tx",
                "PERF_MAX_US_PER_TX",
            ),
            (
                "snapshot per frog",
                worst_bpf,
                max_bpf,
                "B/frog",
                "PERF_MAX_BYTES_PER_FROG",
            ),
            (
                "rollback(1)",
                worst_rollback,
                max_rollback,
                "ms",
                "PERF_MAX_ROLLBACK_MS",
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
            eprintln!("PERF CHECK FAILED: ingest_bench exceeded a threshold");
            std::process::exit(1);
        }
        println!("PERF CHECK OK");
    }

    // Silence the unused-import lint in case the noise leg changes.
    let _ = HashMap::<u8, u8>::new();
}
