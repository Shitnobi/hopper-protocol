// HOPPER v7 protocol parameters — one source of truth for the webapp.
// Mirrors rust/crates/hopper-core/src/params.rs + generations.rs + wrap.rs.
// Every constant here is consensus: never change a value without a
// wire-version bump.

import {
  concatBytes, hexToBytes, sha256, u32le, u64le, bytesToHex,
} from './hex.js';

export const WIRE_VERSION = 0x07;
export const MAGIC = 'FRG';
export const STATE_MAGIC = 'FRG7CROSS';
export const V7_CONTENT_TYPE = 'text/html;charset=utf-8';
export const STATE_CONTENT_TYPE = 'application/octet-stream';

export const MAX_TARGET = 25;
export const ANCHOR_OUTPUT_VALUE = 1000n;
export const CARD_VALUE = 25000n;
export const DUST_P2WPKH = 546n;
export const DUST_P2TR = 330n;

export const NUMS_XONLY = hexToBytes(
  '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0',
);

export const PROTOCOL = Object.freeze({
  generations: Object.freeze({
    genesis: 974034,
    base: 5,
    growthInterval: 144,
    ceiling: 25,
    hold: 3600,
    generationLen: 6480,
  }),
  crossFinality: 6,
  cardValue: CARD_VALUE,
});

export const GENESIS = PROTOCOL.generations.genesis;

export function generationStart(k, g = PROTOCOL.generations) {
  return g.genesis + (Number(k) - 1) * g.generationLen;
}

// Generation of a height (1-based). Heights below genesis are G1.
export function generationAt(height, g = PROTOCOL.generations) {
  const h = Number(height);
  if (h < g.genesis) return 1;
  return 1 + Math.floor((h - g.genesis) / g.generationLen);
}

// required(h): a sawtooth, not monotonic. The reset is load-bearing.
export function requiredAt(height, g = PROTOCOL.generations) {
  const h = Number(height);
  if (h < g.genesis) return g.base;
  const start = generationStart(generationAt(h, g), g);
  const r = g.base + Math.floor((h - start) / g.growthInterval);
  return r > g.ceiling ? g.ceiling : r;
}

// The next height at which `required` changes, and its new value.
export function nextIncrement(height, g = PROTOCOL.generations) {
  const h = Number(height);
  if (h < g.genesis) return [g.genesis, g.base];
  const k = generationAt(h, g);
  const start = generationStart(k, g);
  const r = requiredAt(h, g);
  if (r < g.ceiling) {
    const next = start + (r - g.base + 1) * g.growthInterval;
    return [next, requiredAt(next, g)];
  }
  const next = generationStart(k + 1, g);
  return [next, g.base];
}

// The canonical little-endian ProtocolParams encoding (SPEC §1.3):
// genesis, base, growth_interval, ceiling, hold, generation_len,
// cross_finality, card_value.
export function canonicalBytes(p = PROTOCOL) {
  const g = p.generations;
  return concatBytes([
    u32le(g.genesis), u32le(g.base), u32le(g.growthInterval),
    u32le(g.ceiling), u32le(g.hold), u32le(g.generationLen),
    u32le(p.crossFinality),
    u64le(p.cardValue),
  ]);
}

export function paramsHash(p = PROTOCOL) {
  return sha256(canonicalBytes(p));
}

export function paramsHashHex(p = PROTOCOL) {
  return bytesToHex(paramsHash(p));
}

// The parameter block embedded in the mint body (byte-identical to
// hopper_core::live_v7::params_literal).
export function paramsLiteral(p = PROTOCOL) {
  const g = p.generations;
  return `{g:${g.genesis},b:${g.base},gi:${g.growthInterval},cap:${g.ceiling},hold:${g.hold},gl:${g.generationLen},fin:${p.crossFinality}}`;
}

// The shape live_v7.js consumes: {g,b,gi,cap,hold,gl,fin}
export function foldParams(p = PROTOCOL) {
  const g = p.generations;
  return {
    g: g.genesis, b: g.base, gi: g.growthInterval, cap: g.ceiling,
    hold: g.hold, gl: g.generationLen, fin: p.crossFinality,
  };
}

// Every hop has a one-in-three chance of meeting the block's direction.
// Display only (consensus compares the chosen dir with the block wrap).
export function hopDeathBps() {
  return 3333;
}

// Chance of surviving `target` consecutive hops, in basis points.
export function completionBps(target) {
  let p = 1;
  for (let i = 0; i < Number(target); i++) p *= 2 / 3;
  return Math.round(p * 10000);
}
