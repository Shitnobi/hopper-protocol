//! # hopper-core
//!
//! HOPPER v7 protocol core: the envelope, the generations, the road's
//! wrap, the four-leaf state output, the fold document, and the
//! deterministic frog art.
//!
//! This crate is the single source of truth shared by the indexer, the
//! wallet and the Android client. It is deliberately dependency-minimal
//! (sha2 only).
//!
//! Protocol reference: `SPEC.md` (v7, wire `0x07`). Earlier wire
//! versions are not implemented by this build.

pub mod art;
pub mod envelope;
pub mod generations;
pub mod inscription;
pub mod live_v7;
pub mod params;
pub mod png;
pub mod rng;
pub mod satmath;
pub mod sprite;
pub mod v7;
pub mod wrap;

pub use art::{
    derive_traits, palette, render_sprite, Eyes, FrogState, Mouth, Pattern, Rarity, Traits,
};
pub use envelope::{decode, encode_mint, envelope, Action, DecodeError, Message, MAGIC, VERSION};
pub use generations::{generation, generation_start, next_increment, required_hops};
pub use inscription::{
    build_frog_mint_script, build_frog_mint_script_from_body, build_inscription_script,
    build_inscription_script_with_parents, inscription_id, mint_body, mint_body_digest,
    parse_inscriptions, Inscription, MAX_SCRIPT_ELEMENT_SIZE, PROTOCOL_ID,
};
pub use live_v7::{
    live_v7_html, live_v7_html_digest, parse_v7_gen_hint, V7_CONTENT_TYPE,
};
pub use params::{
    canonical_bytes, params_hash, protocol_hash, validate, GenerationParams, ParamsError,
    ProtocolParams, MAX_TARGET, NUMS_XONLY, PROTOCOL, VERSION_V7,
};
pub use png::{crc32, encode_png, render_png, render_png_digest};
pub use rng::SplitMix64;
pub use satmath::{anchor_sat, assign, locate_sat, SatRange};
pub use sprite::{Sprite, SPRITE_H, SPRITE_W};
pub use v7::{
    branch_hash, control_block, control_path, cross_leaf_script, decode_parent_tag,
    decode_state_body, encode_parent_tag, encode_state_body, leaf_hash, mint_id_string,
    send_leaf_script, state_leaf_hashes, state_leaf_script, state_tree_root, tagged_hash,
    ParentTagError, StateBody, StateBodyError, STATE_BODY_LEN, STATE_CONTENT_TYPE, STATE_MAGIC,
    STATE_VERSION,
};
pub use wrap::{dies, wrap, wrap_display_hex, DIR_LEFT, DIR_RIGHT, DIR_STRAIGHT, DIRECTIONS};
