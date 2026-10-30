// Tiny DOM helpers: formatting, toasts, overlays, sprites.

import { bytesToBase64, hexToBytes } from '../core/hex.js';
import { renderSprite } from '../core/art.js';
import { encodePng } from '../core/png.js';
import { requiredAt } from '../core/params.js';
import { decorate } from './theme.js';

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function sats(n) {
  const v = typeof n === 'bigint' ? n : BigInt(Math.round(Number(n) || 0));
  return v.toLocaleString('en-US');
}

export function btc(n) {
  const v = Number(n) / 1e8;
  return v.toLocaleString('en-US', { minimumFractionDigits: 8, maximumFractionDigits: 8 });
}

export function shortHash(s, n = 8) {
  if (!s) return '—';
  return s.length > n * 2 + 3 ? `${s.slice(0, n)}…${s.slice(-n)}` : s;
}

export function stateLabel(state) {
  return {
    idle: 'ON THE BANK', crossing: 'ON THE ROAD', home: 'HOME · IMMORTAL',
    dead: 'ROADKILL', burned: 'BURNED', retired: 'RETIRED',
  }[state] || String(state || '').toUpperCase();
}

export function stateClass(state) {
  return ['idle', 'crossing', 'home', 'dead', 'burned', 'retired'].includes(state) ? state : 'idle';
}

const spriteCache = new Map();

export function spriteUri(seed, state = 'idle') {
  const key = `${seed}:${state}`;
  if (spriteCache.has(key)) return spriteCache.get(key);
  const png = encodePng(16, 16, renderSprite(seed, state).data);
  const uri = `data:image/png;base64,${bytesToBase64(png)}`;
  spriteCache.set(key, uri);
  return uri;
}

export function frogImg(seed, state, className = 'sprite', alt = '') {
  return `<img class="${esc(className)}" src="${spriteUri(seed, state)}" alt="${esc(alt)}" loading="lazy">`;
}

/**
 * One dot per hop the Hopper must complete, filled up to its current
 * crossing count. Targets grow from 5 to 25, so the dots scale down and
 * wrap instead of being capped at five. The exact count is always printed
 * beside them, as FROGGER's pips intended.
 */
export function pipPlan(dist, target) {
  const completed = Math.max(0, Math.floor(Number(dist) || 0));
  const needed = Math.max(1, Math.floor(Number(target) || 0));
  const total = Math.max(completed, needed, 1);
  const size = total <= 10 ? 7 : total <= 20 ? 5 : 4;
  const gap = total <= 10 ? 4 : total <= 20 ? 3 : 2;
  return { completed, target: total, total, size, gap };
}

export function pips(dist, target) {
  const p = pipPlan(dist, target);
  const dots = Array.from({ length: p.total }, (_, i) =>
    `<i class="${i < p.completed ? 'on' : ''}"></i>`).join('');
  const text = `${p.completed} of ${p.total} crossings complete`;
  return `<span class="pips" role="img" aria-label="${text}" title="${text}" style="--pip-size:${p.size}px;--pip-gap:${p.gap}px"><span class="pip-dots" aria-hidden="true">${dots}</span><b>×${p.completed} / ${p.total}</b></span>`;
}

/**
 * The target for the pips. An idle frog is measured against the next
 * crossing's requirement, so new empty dots appear as the chain raises
 * the toll. A crossing keeps the target frozen at T; home keeps the
 * target it reached; dead/burned frogs keep the last target they faced.
 */
export function targetOf(record, tip) {
  const next = requiredAt((tip || 0) + 1);
  if (!record) return next;
  if (record.in_flight?.target_hops) {
    return Math.max(1, Math.floor(Number(record.in_flight.target_hops) || 0));
  }
  const state = String(record.state || 'idle');
  if (state === 'home') return Math.max(1, Math.floor(Number(record.dist) || 0));
  if (state === 'dead' || state === 'burned' || state === 'retired') {
    const last = Math.floor(Number(record.last_target_hops) || 0);
    if (last > 0) return last;
  }
  return next;
}

export function frogProgress(record, tip) {
  const target = targetOf(record, tip);
  const dist = Number(record?.dist || 0);
  return { target, dist, pct: Math.max(0, Math.min(100, (dist / Math.max(1, target)) * 100)) };
}

export function chip(text, kind = '') {
  return `<span class="state-chip ${esc(kind)}">${esc(text)}</span>`;
}

export function badge(text, kind = '') {
  return `<span class="badge ${esc(kind)}">${esc(text)}</span>`;
}

export function toast(message, kind = '') {
  const host = document.getElementById('toasts');
  if (!host) return;
  while (host.children.length >= 5) host.firstElementChild.remove();
  const node = document.createElement('div');
  node.className = `toast ${kind === 'err' ? 'err' : ''}`;
  const text = document.createElement('span');
  text.textContent = message;
  const count = document.createElement('span');
  count.className = 'tiny muted';
  node.append(text, count);
  host.appendChild(node);
  let secs = 4;
  const paint = () => { count.textContent = `  ·  ${secs}s`; };
  paint();
  const timer = setInterval(() => {
    secs -= 1;
    if (secs <= 0) {
      clearInterval(timer);
      node.remove();
    } else paint();
  }, 1000);
}

export function busy(on, text = 'working…') {
  const node = document.getElementById('busy');
  if (!node) return;
  node.hidden = !on;
  const t = document.getElementById('busy-text');
  if (t) t.textContent = text;
  const frog = document.getElementById('busy-frog');
  if (frog) frog.src = spriteUri(0x9058d0fa, 'idle');
  if (on) decorate(node);
}

export function openOverlay(html, { dismissable = true, type = 'modal', lily = 'accent' } = {}) {
  const node = document.getElementById('overlay');
  if (!node) return;
  const cls = type === 'sheet' ? 'sheet' : 'modal';
  node.innerHTML = `<div class="${cls}" data-modal data-lily="${esc(lily)}">${html}</div>`;
  node.hidden = false;
  node.dataset.dismissable = dismissable ? '1' : '0';
  node.classList.toggle('bottom', type === 'sheet');
  decorate(node);
}

export function closeOverlay() {
  const node = document.getElementById('overlay');
  if (!node) return;
  node.hidden = true;
  node.innerHTML = '';
}

export async function copyText(text, label = 'copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label, 'ok');
  } catch {
    // Fallback for non-secure contexts.
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast(label, 'ok'); } catch { toast('copy failed', 'err'); }
    ta.remove();
  }
}

export function hexSeed(text) {
  const s = String(text || '').trim().toLowerCase();
  if (!s) return (crypto.getRandomValues(new Uint32Array(1))[0]) >>> 0;
  if (/^0x[0-9a-f]{1,8}$/.test(s) || /^[0-9a-f]{1,8}$/.test(s)) return parseInt(s.replace(/^0x/, ''), 16) >>> 0;
  if (/^\d+$/.test(s)) return Number(s) >>> 0;
  // Any other text is hashed deterministically.
  let h = 2166136261;
  for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function seedText(seed) {
  return `${Number(seed) >>> 0} · 0x${(Number(seed) >>> 0).toString(16).padStart(8, '0')}`;
}

export function timeAgo(iso) {
  if (!iso) return '';
  const d = Date.now() - new Date(iso).getTime();
  if (d < 60000) return 'just now';
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
  return `${Math.floor(d / 86400000)}d ago`;
}
