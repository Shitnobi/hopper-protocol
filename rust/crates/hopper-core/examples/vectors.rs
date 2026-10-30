//! Machine-readable protocol vectors for the JavaScript wallet/PWA.
//!
//! `cargo run -p hopper-core --example vectors > web/tests/rust-vectors.json`
//!
//! Every value is produced by the Rust implementation, so the webapp's
//! `tests/core.test.mjs` pins the JS port to consensus bytes instead of
//! to a second hand-written copy.

use hopper_core::inscription::{build_inscription_script, mint_body, mint_body_digest};
use hopper_core::params::{params_hash, PROTOCOL};
use hopper_core::v7::{
    control_block, control_path, cross_leaf_script, encode_parent_tag, encode_state_body,
    send_leaf_script, state_leaf_hashes, state_tree_root, StateBody,
};
use hopper_core::{encode_mint, envelope, Action, MAX_TARGET};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn js(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn main() {
    let g = PROTOCOL.generations;
    let owner = [0x11u8; 32];
    let mint_txid = [0xabu8; 32];

    println!("{{");
    println!("  \"wire_version\": {},", hopper_core::VERSION);
    println!("  \"genesis\": {},", g.genesis);
    println!(
        "  \"generations\": {{\"base\":{},\"growth_interval\":{},\"ceiling\":{},\"hold\":{},\"generation_len\":{}}},",
        g.base, g.growth_interval, g.ceiling, g.hold, g.generation_len
    );
    println!("  \"params_hash\": \"{}\",", hex(&params_hash(&PROTOCOL)));
    println!(
        "  \"params_literal\": \"{}\",",
        js(&hopper_core::live_v7::params_literal())
    );
    println!("  \"max_target\": {},", MAX_TARGET);

    // required(h) at every boundary-relevant offset from genesis.
    let offsets = [
        0u32,
        1,
        143,
        144,
        20 * 144 - 1,
        20 * 144,
        20 * 144 + 3_599,
        6_480,
        6_480 + 144,
        12_960,
    ];
    let req: Vec<String> = offsets
        .iter()
        .map(|off| format!("[{}, {}]", g.genesis + off, g.required(g.genesis + off)))
        .collect();
    println!("  \"required\": [{}],", req.join(","));

    // Wrap vectors: (block hash internal hex, wrap).
    let mut wraps = Vec::new();
    for hi in 0u32..8 {
        let mut h = [0u8; 32];
        h[..4].copy_from_slice(&(hi.wrapping_mul(1_431_655_765)).to_le_bytes());
        h[8] = 0x42;
        wraps.push(format!("{{\"hash\":\"{}\",\"wrap\":{}}}", hex(&h), hopper_core::wrap::wrap(&h)));
    }
    for hi in [0xffff_fffeu32, 0xffff_ffff, 0x8000_0000] {
        let mut h = [0u8; 32];
        h[..4].copy_from_slice(&hi.to_le_bytes());
        wraps.push(format!("{{\"hash\":\"{}\",\"wrap\":{}}}", hex(&h), hopper_core::wrap::wrap(&h)));
    }
    println!("  \"wraps\": [{}],", wraps.join(","));

    // Wire bytes for all three directions plus the send leaf.
    println!("  \"owner\": \"{}\",", hex(&owner));
    println!("  \"mint_txid\": \"{}\",", hex(&mint_txid));
    let mut bodies = Vec::new();
    let mut leaves = Vec::new();
    let mut hashes = Vec::new();
    let mut controls = Vec::new();
    for dir in 0u8..3 {
        let body = StateBody {
            sat: 1_234_567_890,
            mint_txid,
            mint_index: 2,
            dir,
        };
        bodies.push(format!("\"{}\"", hex(&encode_state_body(&body))));
        leaves.push(format!("\"{}\"", hex(&cross_leaf_script(&owner, &body, dir))));
        let hs = state_leaf_hashes(&owner, &body);
        hashes = hs.iter().map(|h| format!("\"{}\"", hex(h))).collect();
        let root = state_tree_root(&hs);
        let cb = control_block(&hopper_core::NUMS_XONLY, &control_path(&hs, dir), 1);
        controls.push(format!("\"{}\"", hex(&cb)));
        if dir == 0 {
            println!("  \"state_root\": \"{}\",", hex(&root));
        }
    }
    println!("  \"state_bodies\": [{}],", bodies.join(","));
    println!("  \"state_leaves\": [{}],", leaves.join(","));
    println!("  \"leaf_hashes\": [{}],", hashes.join(","));
    println!("  \"cross_controls\": [{}],", controls.join(","));
    let send = send_leaf_script(&owner);
    println!("  \"send_leaf\": \"{}\",", hex(&send));
    let send_cb = control_block(
        &hopper_core::NUMS_XONLY,
        &control_path(&state_leaf_hashes(&owner, &StateBody { sat: 1_234_567_890, mint_txid, mint_index: 2, dir: 0 }), 0xff),
        1,
    );
    println!("  \"send_control\": \"{}\",", hex(&send_cb));

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
        hopper_core::V7_CONTENT_TYPE
    );
    let mints: Vec<String> = [
        (0x9058_D0FAu32, 1_000_000_000_000u64, "Hopkinson", 1u32),
        (0x0000_5EED, 2_099_999_999_999, "", 1),
        (1, 2, "Ribbit", 2),
        (7, 8, "<script>&\"'", 3),
    ]
    .iter()
    .map(|(seed, sat, name, gen_hint)| {
        let (ct, bytes) = mint_body(*seed, *sat, name, *gen_hint);
        format!(
            "{{\"seed\":{},\"sat\":{},\"name\":\"{}\",\"gen_hint\":{},\"content_type\":\"{}\",\"html_len\":{},\"digest\":\"{}\"}}",
            seed,
            sat,
            js(name),
            gen_hint,
            ct,
            bytes.len(),
            hex(&mint_body_digest(*seed, *sat, name, *gen_hint)),
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
