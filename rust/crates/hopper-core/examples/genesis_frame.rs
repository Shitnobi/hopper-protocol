//! Print every value that changes when `PROTOCOL.hops.genesis` moves.
//!
//! `scripts/params/frame-genesis.sh <height>` is the only supported way to
//! change the deployment height; it runs this example and splices the
//! output into the pinned tests. Running it by hand is fine — it prints
//! plain key/value lines and touches nothing.
//!
//! Why the digests move: the mint body embeds `live_v6::params_literal`,
//! which includes `g:<genesis>`. Every frog inscribes that body, so the
//! activation height is part of the wire format, not a runtime knob.

use hopper_core::inscription::mint_body_digest;
use hopper_core::params::{params_hash, PROTOCOL};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn main() {
    let h = PROTOCOL.hops;
    println!("genesis={}", h.genesis);
    println!("anchor1={}", h.anchor1());
    println!("anchor2={}", h.anchor2());
    println!("anchor3={}", h.anchor3());
    println!("params_hash={}", hex(&params_hash(&PROTOCOL)));
    println!("params_literal={}", hopper_core::live_v6::params_literal());
    // The cases pinned by `tests/golden.rs::golden_v6_mint_body`.
    for (seed, sat) in [
        (0x9058_D0FAu32, 1_000_000_000_000u64),
        (0x0000_5EED, 2_099_999_999_999),
    ] {
        println!(
            "mint_digest {seed:08x} {sat} {}",
            hex(&mint_body_digest(seed, sat))
        );
    }
}
