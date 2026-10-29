//! Machine-readable protocol vectors for the JavaScript wallet/PWA.
//!
//! `cargo run -p hopper-core --example vectors > web/tests/rust-vectors.json`
//!
//! Every value is produced by the Rust implementation, so the webapp's
//! `tests/core.test.mjs` pins the JS port to consensus bytes instead of
//! to a second hand-written copy.

use hopper_core::inscription::{
    build_inscription_script, mint_body, mint_body_digest, mint_body_digests,
};
use hopper_core::params::{params_hash, PROTOCOL};
use hopper_core::v6::{
    encode_parent_tag, encode_state_body, send_leaf_script, state_leaf_script, StateBody,
};
use hopper_core::{encode_mint, envelope, Action, DEATH_BPS, MAX_TARGET};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn js(s: &str) -> String {
    // Minimal JSON string escaping for the identifiers used here.
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn main() {
    let h = PROTOCOL.hops;
    let owner = [0x11u8; 32];
    let mint_txid = [0xabu8; 32];
    let body = StateBody {
        sat: 1_234_567_890,
        mint_txid,
        mint_index: 2,
    };

    println!("{{");
    println!("  \"wire_version\": {},", hopper_core::VERSION);
    println!("  \"genesis\": {},", h.genesis);
    println!(
        "  \"anchors\": [{}, {}, {}],",
        h.anchor1(),
        h.anchor2(),
        h.anchor3()
    );
    println!("  \"params_hash\": \"{}\",", hex(&params_hash(&PROTOCOL)));
    println!(
        "  \"params_literal\": \"{}\",",
        js(&hopper_core::live_v6::params_literal())
    );
    println!(
        "  \"death_bps\": [{}],",
        DEATH_BPS
            .iter()
            .map(|b| b.to_string())
            .collect::<Vec<_>>()
            .join(",")
    );
    println!("  \"max_target\": {},", MAX_TARGET);

    // required(h) at every boundary-relevant offset from genesis.
    let offsets = [
        0u32, 1, 63, 64, 1279, 1280, 2000, 4879, 4880, 105679, 105680, 200_000,
    ];
    let req: Vec<String> = offsets
        .iter()
        .map(|off| format!("[{}, {}]", h.genesis + off, h.required(h.genesis + off)))
        .collect();
    println!("  \"required\": [{}],", req.join(","));

    // Frozen settlement vectors (sat, H internal hex, target, digest, dead).
    let zero = [0u8; 32];
    let h42: [u8; 32] = [
        0x7d, 0xc9, 0x6f, 0x77, 0x6c, 0x84, 0x23, 0xe5, 0x7a, 0x27, 0x85, 0x48, 0x9a, 0x3f, 0x9c,
        0x43, 0xfb, 0x6e, 0x75, 0x68, 0x76, 0xd6, 0xad, 0x9a, 0x9c, 0xac, 0x4a, 0xa4, 0xe7, 0x2e,
        0xc1, 0x93,
    ];
    let cases: Vec<String> = [
        (0u64, zero, 5u32),
        (42, h42, 5),
        (42, h42, 25),
        (42, h42, 50),
        (0, zero, 100),
        (29, zero, 100),
        (35, zero, 100),
    ]
    .iter()
    .map(|(sat, hash, target)| {
        let digest = hopper_core::cross_digest(*sat, hash);
        format!(
            "{{\"sat\":{},\"hash\":\"{}\",\"target\":{},\"digest\":\"{}\",\"dead\":{}}}",
            sat,
            hex(hash),
            target,
            hex(&digest),
            hopper_core::settle::dies_v3(*sat, hash, *target)
        )
    })
    .collect();
    println!("  \"settle\": [{}],", cases.join(","));

    // Wire bytes.
    println!("  \"owner\": \"{}\",", hex(&owner));
    println!("  \"mint_txid\": \"{}\",", hex(&mint_txid));
    println!("  \"state_body\": \"{}\",", hex(&encode_state_body(&body)));
    println!(
        "  \"state_leaf\": \"{}\",",
        hex(&state_leaf_script(&owner, &body))
    );
    println!("  \"send_leaf\": \"{}\",", hex(&send_leaf_script(&owner)));
    let tags: Vec<String> = [0u32, 1, 255, 256, 65_535, u32::MAX]
        .iter()
        .map(|i| format!("\"{}\"", hex(&encode_parent_tag(&mint_txid, *i))))
        .collect();
    println!("  \"parent_tags\": [{}],", tags.join(","));

    // MINT envelopes and bodies.
    let envs: Vec<String> = [(0x9058_D0FAu32, "Hopkinson"), (42, "")]
        .iter()
        .map(|(seed, name)| {
            let push = envelope(Action::Mint, &encode_mint(*seed, name));
            format!(
                "{{\"seed\":{},\"name\":\"{}\",\"hex\":\"{}\"}}",
                seed,
                name,
                hex(&push)
            )
        })
        .collect();
    println!("  \"mint_envelopes\": [{}],", envs.join(","));

    println!(
        "  \"mint_content_type\": \"{}\",",
        hopper_core::V6_CONTENT_TYPE
    );
    let mints: Vec<String> = [
        (0x9058_D0FAu32, 1_000_000_000_000u64),
        (0x0000_5EED, 2_099_999_999_999),
        (1, 2),
    ]
    .iter()
    .map(|(seed, sat)| {
        let (ct, bytes) = mint_body(*seed, *sat);
        let [now, old] = mint_body_digests(*seed, *sat);
        format!(
            "{{\"seed\":{},\"sat\":{},\"content_type\":\"{}\",\"html_len\":{},\"digest\":\"{}\",\"old_digest\":\"{}\",\"html_sha\":\"{}\"}}",
            seed,
            sat,
            ct,
            bytes.len(),
            hex(&now),
            hex(&old),
            hex(&mint_body_digest(*seed, *sat)),
        )
    })
    .collect();
    println!("  \"mint_bodies\": [{}],", mints.join(","));

    // A pinned inscription script for the ord-decoder tests.
    println!(
        "  \"inscription_script\": \"{}\",",
        hex(&build_inscription_script(b"image/png", b"ok"))
    );
    println!("  \"mint_name_max\": 38");
    println!("}}");
}
