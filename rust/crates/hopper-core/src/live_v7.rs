//! v8 mint body: a self-contained proof-checking document that folds the chain.
//!
//! There is **no origin**. The body embeds the Hopper's seed and sat, its
//! name and generation hint, the whole parameter block, and [`FOLD_JS`].
//! It then reads the viewer's own ord node through same-origin `/r/`
//! endpoints. The bytes are consensus-visible: the indexer recomputes this
//! function exactly.
//!
//! There is no `STATE FROM THE CHAIN` caption in v7. The static band
//! states only what the mint transaction itself can prove: the name, the
//! generation hint, and that the crossing count is unknown. It never
//! prints a count there. (SPEC §2.3)

use crate::params::{PROTOCOL, VERSION_V7, VERSION_V8};
use crate::{encode_png, render_sprite, FrogState, SPRITE_H, SPRITE_W};
use sha2::{Digest, Sha256};

/// Content type of a v8 mint inscription.
pub const V7_CONTENT_TYPE: &str = "text/html;charset=utf-8";
pub const V8_CONTENT_TYPE: &str = V7_CONTENT_TYPE;

/// The current v8 fold, verbatim.
pub const FOLD_JS: &str = include_str!("live_v8.js");
/// The frozen v7 fold, used only to re-render the grandfathered Hopper.
pub const LEGACY_FOLD_JS: &str = include_str!("live_v7.js");

/// Basis point scale used by the display helpers (kept for API parity).
pub const BPS_SCALE: u32 = 10_000;

/// The parameter block embedded in the body. These are the same numbers
/// `params_hash` commits to; changing any of them is a wire change.
///
/// `{g,b,gi,cap,hold,gl,fin}` — the exact literal SPEC §2.3 requires.
#[must_use]
pub fn params_literal() -> String {
    let g = PROTOCOL.generations;
    format!(
        "{{g:{},b:{},gi:{},cap:{},hold:{},gl:{},fin:{}}}",
        g.genesis, g.base, g.growth_interval, g.ceiling, g.hold, g.generation_len,
        PROTOCOL.cross_finality
    )
}

/// `data:image/png;base64,…` — the static card layer needs no network.
fn data_uri(png: &[u8]) -> String {
    format!("data:image/png;base64,{}", base64(png))
}

/// Standard base64 (no line breaks), kept local so this crate needs no
/// extra dependency.
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

/// HTML text escaping for the static band.
fn html_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// A JS string literal that cannot break out of the `<script>` element.
fn js_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '<' => out.push_str("\\u003c"),
            '>' => out.push_str("\\u003e"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

const STYLE: &str = "html,body{margin:0;height:100%;background:#0b0e12}\
.f{position:relative;width:256px;height:256px;margin:0 auto;image-rendering:pixelated}\
.f>*{position:absolute;inset:0;width:256px;height:256px;image-rendering:pixelated}\
.f .a,.f .d{animation:q 1.4s steps(1,end) infinite}\
.f .d{animation-delay:-.7s}\
.f .g{inset:auto;top:6px;left:6px;width:auto;height:auto;padding:0 6px;\
font:700 11px/18px monospace;color:#0b0e12;background:#f0c83c}\
.f .t{top:auto;height:22px;font:600 11px/22px monospace;letter-spacing:.12em;\
text-align:center;color:#e8f1ff;background:rgba(4,7,12,.86);border-top:1px solid #33475f}\
html[data-frogger=idle] .d,html[data-frogger=home] .d{display:none}\
html[data-frogger=dead] .a{display:none}\
html[data-frogger=idle] .a,html[data-frogger=home] .a,html[data-frogger=dead] .d{animation:none;opacity:1}\
@keyframes q{0%,49.9%{opacity:1}50%,100%{opacity:0}}";

/// The v7 mint body. Deterministic: no clock, no environment, no origin.
///
/// `gen_hint` is the generation of the height the wallet expects the mint
/// to confirm at. It is a display hint, never consensus.
fn document_html(
    title: &str,
    variable: &str,
    fold: &str,
    seed: u32,
    sat: u64,
    name: &str,
    gen_hint: u32,
    grandfathered_sat: Option<u64>,
) -> String {
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
    // The static band proves only what the mint transaction proves.
    let band = format!("{} · G{} · 🛣 —", html_escape(name), gen_hint);
    format!(
        "<!doctype html><meta charset=\"utf-8\"><title>{title}</title>\
<style>{STYLE}</style>\
<div class=\"f\">\
<img class=\"a\" src=\"{alive}\" alt=\"\">\
<img class=\"d\" src=\"{dead}\" alt=\"\">\
<div class=\"g\" id=\"gen\">G{gen_hint}</div>\
<div class=\"t\" id=\"band\">{band}</div>\
</div>\
<script>var {variable}={{sat:{sat},genHint:{gen_hint},name:{name},{legacy}p:{params}}};\n{js}</script>",
        name = js_string(name),
        params = params_literal(),
        js = fold,
        legacy = grandfathered_sat
            .map(|s| format!("grandfatheredSat:{s},"))
            .unwrap_or_default(),
    )
}

/// The frozen v7 mint body, used only to recognise the grandfathered Hopper.
#[must_use]
pub fn live_v7_html(seed: u32, sat: u64, name: &str, gen_hint: u32) -> String {
    document_html("HOPPER v7", "V7", LEGACY_FOLD_JS, seed, sat, name, gen_hint, None)
}

/// The current v8 mint body.
#[must_use]
pub fn live_v8_html(seed: u32, sat: u64, name: &str, gen_hint: u32) -> String {
    document_html(
        "HOPPER v8", "V8", FOLD_JS, seed, sat, name, gen_hint,
        (crate::params::GRANDFATHERED_SAT != 0).then_some(crate::params::GRANDFATHERED_SAT),
    )
}

/// SHA-256 of the frozen v7 body.
#[must_use]
pub fn live_v7_html_digest(seed: u32, sat: u64, name: &str, gen_hint: u32) -> [u8; 32] {
    Sha256::digest(live_v7_html(seed, sat, name, gen_hint).as_bytes()).into()
}

/// SHA-256 of the current v8 body.
#[must_use]
pub fn live_v8_html_digest(seed: u32, sat: u64, name: &str, gen_hint: u32) -> [u8; 32] {
    Sha256::digest(live_v8_html(seed, sat, name, gen_hint).as_bytes()).into()
}

/// Parse the `genHint` the document embeds.
///
/// The document is canonical (the digest check re-renders it), but this
/// parser must still be total and never panic on hostile bytes: it looks
/// for the exact `var V7={sat:` marker and reads the decimal after the
/// following `,genHint:`.
fn parse_gen_hint(html: &[u8], variable: &str) -> Option<u32> {
    let text = std::str::from_utf8(html).ok()?;
    let marker = format!("var {variable}={{sat:");
    let at = text.find(&marker)? + marker.len();
    let rest = &text[at..];
    let comma = rest.find(",genHint:")? + ",genHint:".len();
    let digits = &rest[comma..];
    let end = digits
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(digits.len());
    if end == 0 || end > 10 {
        return None;
    }
    digits[..end].parse().ok()
}

#[must_use]
pub fn parse_v7_gen_hint(html: &[u8]) -> Option<u32> {
    parse_gen_hint(html, "V7")
}

#[must_use]
pub fn parse_v8_gen_hint(html: &[u8]) -> Option<u32> {
    parse_gen_hint(html, "V8")
}

/// The current wire version this body belongs to.
pub const BODY_VERSION: u8 = VERSION_V8;
/// The released wire version accepted only for the grandfathered Hopper.
pub const LEGACY_BODY_VERSION: u8 = VERSION_V7;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_has_no_external_origin() {
        let html = live_v7_html(7, 123_456, "Hopkinson", 2);
        for bad in ["http://", "https://", "//art.", "hopper.land"] {
            assert!(!html.contains(bad), "v7 body must not contain {bad}");
        }
        assert!(html.contains("/r/blockheight"));
        assert!(html.contains("/r/children/"));
        assert!(html.contains("FRG7CROSS"));
        assert!(html.contains("/r/blockhash/"));
    }

    #[test]
    fn body_is_deterministic_and_bound_to_every_input() {
        assert_eq!(
            live_v7_html(1, 2, "Frog", 1),
            live_v7_html(1, 2, "Frog", 1)
        );
        assert_ne!(live_v7_html(1, 2, "Frog", 1), live_v7_html(2, 2, "Frog", 1));
        assert_ne!(live_v7_html(1, 2, "Frog", 1), live_v7_html(1, 3, "Frog", 1));
        assert_ne!(
            live_v7_html(1, 2, "Frog", 1),
            live_v7_html(1, 2, "Toad", 1)
        );
        assert_ne!(
            live_v7_html(1, 2, "Frog", 1),
            live_v7_html(1, 2, "Frog", 2)
        );
    }

    #[test]
    fn the_static_band_names_the_hopper_and_never_counts_crossings() {
        let html = live_v7_html(0x1234, 987_654_321, "Ribbit", 3);
        assert!(html.contains(">Ribbit · G3 · 🛣 —<"));
        assert!(!html.contains("STATE FROM THE CHAIN"));
        // The live band may render a number; the static one must not.
        assert!(!html.contains("🛣 0"));
    }

    #[test]
    fn the_document_owns_v8_and_the_fold_never_assigns_it() {
        let html = live_v8_html(0x1234, 987_654_321, "Ribbit", 2);
        assert!(html.contains("var V8={sat:987654321,genHint:2,name:\"Ribbit\",p:{"));
        assert_eq!(
            FOLD_JS.matches("var V8 = { sat:").count(),
            1,
            "the fold must declare its V8 default exactly once"
        );
        let guard = FOLD_JS
            .find("if (typeof V8 === \"undefined\")")
            .expect("the default must be guarded by a typeof check");
        let assign = FOLD_JS
            .find("var V8 = { sat:")
            .expect("the default is declared");
        assert!(
            guard < assign,
            "the V8 default must be the GUARDED one; an unguarded assignment clobbers the document"
        );
    }

    #[test]
    fn gen_hint_round_trips_and_rejects_junk() {
        for hint in [1u32, 2, 17, 4_294_967_295] {
            let html = live_v7_html(9, 10, "N", hint);
            assert_eq!(parse_v7_gen_hint(html.as_bytes()), Some(hint));
        }
        assert_eq!(parse_v7_gen_hint(b"<html>nothing</html>"), None);
        assert_eq!(parse_v7_gen_hint(b"var V7={sat:1,genHint:}"), None);
    }

    #[test]
    fn a_name_cannot_break_out_of_the_html_or_the_script() {
        let nasty = "</script><script>alert(1)</script>&\"'";
        let html = live_v7_html(1, 2, nasty, 1);
        assert!(!html.contains("</script><script>alert"));
        assert!(html.contains("&lt;/script&gt;"));
        assert!(html.contains("var V7={sat:2,genHint:1,name:\"\\u003c/script"));
    }

    #[test]
    fn params_literal_matches_the_compiled_schedule() {
        let p = params_literal();
        assert!(p.contains("cap:25"));
        assert!(p.contains("gi:144"));
        assert!(p.contains("hold:3600"));
        assert!(p.contains("gl:6480"));
        assert!(p.contains("fin:6"));
    }
}
