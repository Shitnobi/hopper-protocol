// HOPPER v6 protocol parameters — one source of truth for the webapp.
// Mirrors rust/crates/hopper-core/src/params.rs. Every constant here is
// consensus: do not "simplify" the schedule and never change a value
// without a wire-version bump.

import {
  concatBytes, hexToBytes, sha256, u16le, u32le, u64le, bytesToHex,
} from './hex.js';

export const WIRE_VERSION = 0x06;
export const MAGIC = 'FRG';
export const STATE_MAGIC = 'FRG6CROSS';
export const V6_CONTENT_TYPE = 'text/html;charset=utf-8';
export const STATE_CONTENT_TYPE = 'application/octet-stream';
export const CROSS_DOMAIN = 'FRG3-CROSS';

export const MAX_TARGET = 100;
export const ANCHOR_OUTPUT_VALUE = 1000n;
export const CARD_VALUE = 25000n;
export const DUST_P2WPKH = 546n;
export const DUST_P2TR = 330n;

export const NUMS_XONLY = hexToBytes(
  '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0',
);

// 101 entries, indexed by the frozen target. Values above 100 clamp.
export const DEATH_BPS = [
  2500, 2500, 2500, 2500, 2500, 2500, 2153, 1896, 1697, 1539, 1410, 1304, 1214, 1137, 1071, 1013,
  962, 917, 877, 840, 808, 778, 751, 726, 703, 682, 663, 645, 628, 612, 597, 584, 571, 559, 547,
  537, 526, 517, 508, 499, 491, 483, 475, 468, 461, 455, 448, 442, 437, 431, 426, 421, 416, 411,
  407, 402, 398, 394, 390, 386, 382, 379, 375, 372, 369, 366, 363, 360, 357, 354, 351, 349, 346,
  344, 341, 339, 337, 334, 332, 330, 328, 326, 324, 322, 320, 318, 317, 315, 313, 311, 310, 308,
  307, 305, 304, 302, 301, 299, 298, 296, 295,
];

export const PROTOCOL = Object.freeze({
  hops: Object.freeze({
    genesis: 973263,
    base: 5,
    step1: 64,
    until1: 25,
    step2: 144,
    until2: 50,
    step3: 2016,
    ceiling: 100,
  }),
  // 0 = flat_25, 1 = hybrid_floor (this deployment)
  deathModelTag: 1,
  deathModel: 'hybrid_floor',
  successFloorBps: 500,
  crossFinality: 6,
  cardValue: CARD_VALUE,
});

export function anchor1(p = PROTOCOL.hops) {
  return p.genesis + (p.until1 - p.base) * p.step1;
}
export function anchor2(p = PROTOCOL.hops) {
  return anchor1(p) + (p.until2 - p.until1) * p.step2;
}
export function anchor3(p = PROTOCOL.hops) {
  return anchor2(p) + (p.ceiling - p.until2) * p.step3;
}

// required(h): monotone, hard-capped at 100. Load-bearing consensus.
export function requiredAt(height, hops = PROTOCOL.hops) {
  const h = Number(height);
  if (h <= hops.genesis) return hops.base;
  const a1 = anchor1(hops);
  const a2 = anchor2(hops);
  const a3 = anchor3(hops);
  if (h < a1) return hops.base + Math.floor((h - hops.genesis) / hops.step1);
  if (h < a2) return hops.until1 + Math.floor((h - a1) / hops.step2);
  if (h < a3) return hops.until2 + Math.floor((h - a2) / hops.step3);
  return hops.ceiling;
}

export function deathBps(target) {
  return DEATH_BPS[Math.min(Number(target), MAX_TARGET)];
}

// Chance of surviving `target` consecutive hops, in basis points.
// Display only (consensus uses deathBps); float is fine here.
export function completionBps(target) {
  let p = 1;
  for (let i = 0; i < Number(target); i++) p *= 1 - deathBps(i) / 10000;
  return Math.round(p * 10000);
}

export function nextIncrement(height, hops = PROTOCOL.hops) {
  const h = Number(height);
  if (h < anchor1(hops)) {
    const elapsed = Math.max(0, h - hops.genesis);
    const next = hops.genesis + (Math.floor(elapsed / hops.step1) + 1) * hops.step1;
    return [next, requiredAt(next, hops)];
  }
  if (h < anchor2(hops)) {
    const next = anchor1(hops) + (Math.floor((h - anchor1(hops)) / hops.step2) + 1) * hops.step2;
    return [next, requiredAt(next, hops)];
  }
  if (h < anchor3(hops)) {
    const next = anchor2(hops) + (Math.floor((h - anchor2(hops)) / hops.step3) + 1) * hops.step3;
    return [next, requiredAt(next, hops)];
  }
  return null;
}

// The canonical little-endian ProtocolParams encoding (SPEC §1.3).
export function canonicalBytes(p = PROTOCOL) {
  const h = p.hops;
  return concatBytes([
    u32le(h.genesis), u32le(h.base), u32le(h.step1), u32le(h.until1),
    u32le(h.step2), u32le(h.until2), u32le(h.step3), u32le(h.ceiling),
    Uint8Array.of(p.deathModelTag),
    u16le(p.successFloorBps),
    u32le(p.crossFinality),
    u64le(p.cardValue),
  ]);
}

export function deathTableBytes() {
  const out = new Uint8Array(DEATH_BPS.length * 2);
  DEATH_BPS.forEach((bps, i) => out.set(u16le(bps), i * 2));
  return out;
}

export function paramsHash(p = PROTOCOL) {
  const table = p.deathModelTag === 0 ? new Uint8Array() : sha256(deathTableBytes());
  return sha256(concatBytes([canonicalBytes(p), table]));
}

export function paramsHashHex(p = PROTOCOL) {
  return bytesToHex(paramsHash(p));
}

// The parameter block embedded in the mint body (byte-identical to
// hopper_core::live_v6::params_literal).
export function paramsLiteral(p = PROTOCOL) {
  const h = p.hops;
  return `{g:${h.genesis},b:${h.base},s1:${h.step1},u1:${h.until1},s2:${h.step2},u2:${h.until2},s3:${h.step3},cap:${h.ceiling},fin:${p.crossFinality},bps:[${DEATH_BPS.join(',')}]}`;
}

// The shape live_v6.js consumes: {g,b,s1,u1,s2,u2,s3,cap,fin,bps}
export function foldParams(p = PROTOCOL) {
  const h = p.hops;
  return {
    g: h.genesis, b: h.base, s1: h.step1, u1: h.until1, s2: h.step2,
    u2: h.until2, s3: h.step3, cap: h.ceiling, fin: p.crossFinality, bps: DEATH_BPS,
  };
}

export const GENESIS = PROTOCOL.hops.genesis;
