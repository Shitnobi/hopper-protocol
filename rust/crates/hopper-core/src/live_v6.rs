//! v6 mint body: a self-contained document that folds the chain.
//!
//! Unlike v5 there is **no origin**. The body embeds the frog's seed and
//! sat, the whole parameter block, and [`FOLD_JS`]. It then reads the
//! viewer's own ord node through same-origin `/r/` endpoints. The bytes
//! are consensus-visible: the indexer recomputes this function exactly.

use crate::params::{DEATH_BPS, PROTOCOL, VERSION_V6};
use crate::{encode_png, render_sprite, FrogState, SPRITE_H, SPRITE_W};
use sha2::{Digest, Sha256};

/// Content type of a v6 mint inscription.
pub const V6_CONTENT_TYPE: &str = "text/html;charset=utf-8";

/// The fold, verbatim. Kept in a `.js` file so the golden-vector test can
/// load the *same* source with Node — no second implementation.
pub const FOLD_JS: &str = include_str!("live_v6.js");

/// The fold as it was inscribed by every frog minted before the v6.0 boot
/// fix (`tests/v6_doc_boot.mjs`). **Frozen forever**: those bytes are on
/// chain, the indexer still accepts their digest, and rewriting them
/// would be a lie about what a past inscription says. `live_v6_v1.js` is
/// byte-identical to the shipped file (`git show` pinned in a test).
pub const FOLD_JS_V1: &str = include_str!("live_v6_v1.js");

/// The canonical v6 documents's static card caption.
pub const CAPTION: &str = "STATE FROM THE CHAIN";

/// Basis-point table as a JS array literal (101 entries, ≤ 4 digits each).
fn death_table_literal() -> String {
    let mut s = String::with_capacity(DEATH_BPS.len() * 5);
    s.push('[');
    for (i, b) in DEATH_BPS.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&b.to_string());
    }
    s.push(']');
    s
}

/// The parameter block embedded in the body. These are the same numbers
/// `params_hash` commits to; changing any of them is a wire change.
#[must_use]
pub fn params_literal() -> String {
    let h = PROTOCOL.hops;
    format!(
        "{{g:{},b:{},s1:{},u1:{},s2:{},u2:{},s3:{},cap:{},fin:{},bps:{}}}",
        h.genesis,
        h.base,
        h.step1,
        h.until1,
        h.step2,
        h.until2,
        h.step3,
        h.ceiling,
        PROTOCOL.cross_finality,
        death_table_literal()
    )
}

/// `data:image/png;base64,…` — the static card layer needs no network.
fn data_uri(png: &[u8]) -> String {
    format!("data:image/png;base64,{}", base64(png))
}

/// Standard base64 (no line breaks), kept local so this crate needs no
/// extra dependency, and pinned by `base64_matches_known_vectors`.
fn base64(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// The v6 mint body. Deterministic: no clock, no environment, no origin.
#[must_use]
pub fn live_v6_html(seed: u32, sat: u64) -> String {
    html_with(FOLD_JS, seed, sat)
}

/// The v6 mint body as minted before the boot fix: same document, the
/// original fold. Kept so the wire can validate frogs already inscribed.
#[must_use]
pub fn live_v6_html_v1(seed: u32, sat: u64) -> String {
    html_with(FOLD_JS_V1, seed, sat)
}

/// The document around a given fold source.
fn html_with(js: &str, seed: u32, sat: u64) -> String {
    let alive = data_uri(&encode_png(
        SPRITE_W as u32,
        SPRITE_H as u32,
        render_sprite(seed, FrogState::Idle).as_rgba(),
    ));
    let dead = data_uri(&encode_png(
        SPRITE_W as u32,
        SPRITE_H as u32,
        render_sprite(seed, FrogState::Dead).as_rgba(),
    ));
    format!(
        "<!doctype html><meta charset=\"utf-8\"><title>FROGGER v6</title>\
<style>\
html,body{{margin:0;height:100%;background:#0b0e12}}\
.f{{position:relative;width:256px;height:256px;margin:0 auto;image-rendering:pixelated}}\
.f>*{{position:absolute;inset:0;width:256px;height:256px;image-rendering:pixelated}}\
.f .a,.f .d{{animation:q 1.4s steps(1,end) infinite}}\
.f .d{{animation-delay:-.7s}}\
.f .t{{top:auto;height:22px;font:600 11px/22px monospace;letter-spacing:.12em;text-align:center;color:#e8f1ff;background:rgba(4,7,12,.86);border-top:1px solid #33475f}}\
html[data-frogger=idle] .d,html[data-frogger=home] .d{{display:none}}\
html[data-frogger=dead] .a{{display:none}}\
html[data-frogger=idle] .a,html[data-frogger=home] .a,html[data-frogger=dead] .d{{animation:none;opacity:1}}\
@keyframes q{{0%,49.9%{{opacity:1}}50%,100%{{opacity:0}}}}\
</style>\
<div class=\"f\">\
<img class=\"a\" src=\"{alive}\" alt=\"\">\
<img class=\"d\" src=\"{dead}\" alt=\"\">\
<div class=\"t\" id=\"band\">{caption}</div>\
</div>\
<script>var V6={{sat:{sat},p:{params}}};\n{js}</script>",
        caption = CAPTION,
        params = params_literal(),
        js = js,
        sat = sat,
    )
}

/// SHA-256 of [`live_v6_html`] — the digest a NEW v6 mint must carry.
#[must_use]
pub fn live_v6_html_digest(seed: u32, sat: u64) -> [u8; 32] {
    Sha256::digest(live_v6_html(seed, sat).as_bytes()).into()
}

/// Every mint body the wire accepts for `(seed, sat)`: the current one
/// first, then the pre-fix one still carried by every frog minted before
/// the fix. The indexer accepts the set; a wallet can only mint the
/// first.
#[must_use]
pub fn live_v6_html_digests(seed: u32, sat: u64) -> [[u8; 32]; 2] {
    [
        live_v6_html_digest(seed, sat),
        Sha256::digest(live_v6_html_v1(seed, sat).as_bytes()).into(),
    ]
}

/// The wire version this body belongs to (asserted at the call site).
pub const BODY_VERSION: u8 = VERSION_V6;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_has_no_external_origin() {
        let html = live_v6_html(7, 123_456);
        for bad in ["http://", "https://", "//art.", "frogger.land"] {
            assert!(!html.contains(bad), "v6 body must not contain {bad}");
        }
        assert!(html.contains("/r/blockheight"));
        assert!(html.contains("/r/children/"));
        assert!(html.contains("FRG3-CROSS"));
    }

    #[test]
    fn body_is_deterministic_and_bound_to_seed_and_sat() {
        assert_eq!(live_v6_html(1, 2), live_v6_html(1, 2));
        assert_ne!(live_v6_html(1, 2), live_v6_html(2, 2));
        assert_ne!(live_v6_html(1, 2), live_v6_html(1, 3));
        assert_ne!(live_v6_html_digest(1, 2), live_v6_html_digest(1, 3));
    }

    /// The bug this pins: the document sets `V6 = {sat, p}`, then the
    /// fold source used to declare `var V6 = {sat: 0, p: null}` — hoisted
    /// into the same scope it CLOBBERED them, `requiredAt(tip+1, null)`
    /// threw, the catch swallowed it, and the card stayed in the quantum
    /// alive/dead animation forever (every frog minted before the fix).
    #[test]
    fn the_document_owns_v6_and_the_fold_never_assigns_it() {
        let html = live_v6_html(0x1234, 987_654_321);
        assert!(
            html.contains("var V6={sat:987654321,p:{"),
            "the document must hand the fold its sat and params"
        );
        // The fold may only *default* V6, never overwrite the document's:
        // exactly one assignment, and it must sit inside the guard.
        assert_eq!(
            FOLD_JS.matches("var V6 = { sat:").count(),
            1,
            "the fold must declare its V6 default exactly once"
        );
        let guard = FOLD_JS
            .find("if (typeof V6 === \"undefined\")")
            .expect("the default must be guarded by a typeof check");
        let assign = FOLD_JS
            .find("var V6 = { sat:")
            .expect("the default is declared");
        assert!(
            guard < assign,
            "the V6 default must be the GUARDED one; an unguarded assignment clobbers the document"
        );
        // The frozen v1 fold is exactly the text that DID clobber it —
        // keep it that way, it is what the chain says.
        assert!(
            FOLD_JS_V1.contains("var V6 = {"),
            "live_v6_v1.js is the pre-fix source verbatim; it must keep the bad initializer"
        );
        assert_ne!(live_v6_html(1, 2), live_v6_html_v1(1, 2));
    }

    #[test]
    fn the_wire_accepts_the_current_body_and_the_ones_already_minted() {
        let [now, old] = live_v6_html_digests(0x0000_5EED, 2_099_999_999_999);
        assert_eq!(now, live_v6_html_digest(0x0000_5EED, 2_099_999_999_999));
        assert_ne!(now, old, "the fix changed the bytes, so the digests differ");
        // The old digest is a fact about blocks already mined.
        let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
        assert_eq!(
            hex(&old),
            "0ad5fa4ef00442b59be9719e8d26033f3d0e8929e71ce4bbc923f3f388506a04",
            "the pre-fix mint body must never drift"
        );
    }

    #[test]
    fn params_literal_matches_the_compiled_schedule() {
        let p = params_literal();
        assert!(p.contains("cap:100"));
        assert!(p.contains(&format!("b:{}", PROTOCOL.hops.base)));
        assert_eq!(death_table_literal().split(',').count(), DEATH_BPS.len());
    }
}
