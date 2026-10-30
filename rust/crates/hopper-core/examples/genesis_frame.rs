//! Print every value that changes when `PROTOCOL.generations.genesis`
//! moves.
//!
//! `scripts/params/frame-genesis.sh <height>` is the only supported way to
//! change the deployment height; it runs this example and splices the
//! output into the pinned tests. Running it by hand is fine — it prints
//! plain key/value lines and touches nothing.

use hopper_core::params::{params_hash, PROTOCOL};
use hopper_core::{live_v7_html_digest, send_leaf_script, state_leaf_script, StateBody};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn main() {
    let g = PROTOCOL.generations;
    println!("genesis={}", g.genesis);
    println!("generation_len={}", g.generation_len);
    println!("params_hash={}", hex(&params_hash(&PROTOCOL)));
    println!("params_literal={}", hopper_core::live_v7::params_literal());
    // The cases pinned by `tests/golden.rs::golden_v7_mint_body`.
    for (seed, sat, name, gen_hint) in [
        (0x9058_D0FAu32, 1_000_000_000_000u64, "Hopkinson", 1u32),
        (0x0000_5EED, 2_099_999_999_999, "", 1),
    ] {
        println!(
            "mint_digest {seed:08x} {sat} {}",
            hex(&live_v7_html_digest(seed, sat, name, gen_hint))
        );
    }
    // Wire bytes for the leaf templates are pinned in `tests/golden.rs`;
    // this line makes the shape visible when re-framing.
    let body = StateBody {
        sat: 0,
        mint_txid: [0u8; 32],
        mint_index: 0,
        dir: 0,
    };
    let owner = [0u8; 32];
    println!("state_leaf_len={}", state_leaf_script(&owner, &body).len());
    println!("send_leaf_len={}", send_leaf_script(&owner).len());
}
