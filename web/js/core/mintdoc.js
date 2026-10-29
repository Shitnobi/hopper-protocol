// The v6 mint body — a self-contained fold document with no external
// origin. Byte-identical to hopper_core::live_v6::live_v6_html, which is
// what the indexer checks before accepting a mint.

import { bytesToBase64, sha256, utf8 } from './hex.js';
import { renderSprite } from './art.js';
import { encodePng } from './png.js';
import { paramsLiteral, V6_CONTENT_TYPE } from './params.js';
import { FOLD_JS } from './fold_source.js';

export { V6_CONTENT_TYPE };

const STYLE = 'html,body{margin:0;height:100%;background:#0b0e12}'
  + '.f{position:relative;width:256px;height:256px;margin:0 auto;image-rendering:pixelated}'
  + '.f>*{position:absolute;inset:0;width:256px;height:256px;image-rendering:pixelated}'
  + '.f .a,.f .d{animation:q 1.4s steps(1,end) infinite}'
  + '.f .d{animation-delay:-.7s}'
  + '.f .t{top:auto;height:22px;font:600 11px/22px monospace;letter-spacing:.12em;'
  + 'text-align:center;color:#e8f1ff;background:rgba(4,7,12,.86);border-top:1px solid #33475f}'
  + 'html[data-frogger=idle] .d,html[data-frogger=home] .d{display:none}'
  + 'html[data-frogger=dead] .a{display:none}'
  + 'html[data-frogger=idle] .a,html[data-frogger=home] .a,html[data-frogger=dead] .d{animation:none;opacity:1}'
  + '@keyframes q{0%,49.9%{opacity:1}50%,100%{opacity:0}}';

export function spriteDataUri(seed, state) {
  const sprite = renderSprite(seed, state);
  return `data:image/png;base64,${bytesToBase64(encodePng(16, 16, sprite.data))}`;
}

export function liveV6Html(seed, sat) {
  const alive = spriteDataUri(seed, 'idle');
  const dead = spriteDataUri(seed, 'dead');
  return '<!doctype html><meta charset="utf-8"><title>FROGGER v6</title>'
    + `<style>${STYLE}</style>`
    + '<div class="f">'
    + `<img class="a" src="${alive}" alt="">`
    + `<img class="d" src="${dead}" alt="">`
    + '<div class="t" id="band">STATE FROM THE CHAIN</div>'
    + '</div>'
    + `<script>var V6={sat:${sat},p:${paramsLiteral()}};\n${FOLD_JS}</script>`;
}

export function mintBody(seed, sat) {
  return { contentType: V6_CONTENT_TYPE, body: utf8(liveV6Html(seed, sat)) };
}

export function mintBodyDigest(seed, sat) {
  return sha256(utf8(liveV6Html(seed, sat)));
}
