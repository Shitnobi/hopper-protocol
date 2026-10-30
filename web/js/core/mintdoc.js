// The v7 mint body — a self-contained fold document with no external
// origin. Byte-identical to hopper_core::live_v7::live_v7_html, which is
// what the indexer re-renders before accepting a mint.

import { bytesToBase64, sha256, utf8 } from './hex.js';
import { renderSprite } from './art.js';
import { encodePng } from './png.js';
import { paramsLiteral, V7_CONTENT_TYPE } from './params.js';
import { FOLD_JS } from './fold_source.js';

export { V7_CONTENT_TYPE };

const STYLE = 'html,body{margin:0;height:100%;background:#0b0e12}'
  + '.f{position:relative;width:256px;height:256px;margin:0 auto;image-rendering:pixelated}'
  + '.f>*{position:absolute;inset:0;width:256px;height:256px;image-rendering:pixelated}'
  + '.f .a,.f .d{animation:q 1.4s steps(1,end) infinite}'
  + '.f .d{animation-delay:-.7s}'
  + '.f .g{inset:auto;top:6px;left:6px;width:auto;height:auto;padding:0 6px;'
  + 'font:700 11px/18px monospace;color:#0b0e12;background:#f0c83c}'
  + '.f .t{top:auto;height:22px;font:600 11px/22px monospace;letter-spacing:.12em;'
  + 'text-align:center;color:#e8f1ff;background:rgba(4,7,12,.86);border-top:1px solid #33475f}'
  + 'html[data-frogger=idle] .d,html[data-frogger=home] .d{display:none}'
  + 'html[data-frogger=dead] .a{display:none}'
  + 'html[data-frogger=idle] .a,html[data-frogger=home] .a,html[data-frogger=dead] .d{animation:none;opacity:1}'
  + '@keyframes q{0%,49.9%{opacity:1}50%,100%{opacity:0}}';

function htmlEscape(s) {
  let out = '';
  for (const c of String(s)) {
    if (c === '&') out += '&amp;';
    else if (c === '<') out += '&lt;';
    else if (c === '>') out += '&gt;';
    else if (c === '"') out += '&quot;';
    else if (c === "'") out += '&#39;';
    else out += c;
  }
  return out;
}

function jsString(s) {
  let out = '"';
  for (const c of String(s)) {
    const code = c.codePointAt(0);
    if (c === '"') out += '\\"';
    else if (c === '\\') out += '\\\\';
    else if (c === '<') out += '\\u003c';
    else if (c === '>') out += '\\u003e';
    else if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\r';
    else if (c === '\t') out += '\\t';
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += c;
  }
  return `${out}"`;
}

export function spriteDataUri(seed, state) {
  const sprite = renderSprite(seed, state);
  return `data:image/png;base64,${bytesToBase64(encodePng(16, 16, sprite.data))}`;
}

export function liveV7Html(seed, sat, name = '', genHint = 1) {
  const alive = spriteDataUri(seed, 'idle');
  const dead = spriteDataUri(seed, 'dead');
  const band = `${htmlEscape(name)} · G${genHint} · 🛣 —`;
  return '<!doctype html><meta charset="utf-8"><title>HOPPER v7</title>'
    + `<style>${STYLE}</style>`
    + '<div class="f">'
    + `<img class="a" src="${alive}" alt="">`
    + `<img class="d" src="${dead}" alt="">`
    + `<div class="g" id="gen">G${genHint}</div>`
    + `<div class="t" id="band">${band}</div>`
    + '</div>'
    + `<script>var V7={sat:${sat},genHint:${genHint},name:${jsString(name)},p:${paramsLiteral()}};\n${FOLD_JS}</script>`;
}

export function mintBody(seed, sat, name = '', genHint = 1) {
  return { contentType: V7_CONTENT_TYPE, body: utf8(liveV7Html(seed, sat, name, genHint)) };
}

export function mintBodyDigest(seed, sat, name = '', genHint = 1) {
  return sha256(utf8(liveV7Html(seed, sat, name, genHint)));
}

// Read the genHint the document embeds (the indexer re-renders with it).
export function parseV7GenHint(htmlText) {
  const at = String(htmlText).indexOf('var V7={sat:');
  if (at < 0) return null;
  const rest = String(htmlText).slice(at + 'var V7={sat:'.length);
  const c = rest.indexOf(',genHint:');
  if (c < 0) return null;
  const m = /^(\d+)/.exec(rest.slice(c + ',genHint:'.length));
  return m ? Number(m[1]) : null;
}
