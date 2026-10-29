#!/usr/bin/env node
/* Pins the v6 fold's integer core to the Rust implementation.
 *
 * Run: node frogger/crates/hopper-core/tests/v6_fold_check.mjs
 *
 * The vectors are the frozen cases from
 * hopper-core/src/settle.rs (v3_golden_vectors_12_2), so a drift in the
 * domain string, the u64 LE encoding, the block-hash byte order, or the
 * death threshold fails here as well as in `cargo test`.
 */
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "src", "live_v6.js"), "utf8");
const api = new Function(src + "\nreturn {requiredAt, deathBps, isDead, foldFrog};")();

/* The production schedule. `G` is `PROTOCOL.hops.genesis`; every case
 * below is expressed as an offset from it, so re-framing the deployment
 * (signet -> mainnet, `scripts/params/frame-genesis.sh`) needs exactly one
 * edit here: the `g:` line. */
const G = 973_263;
const H = (n) => G + n;

const p = {
  g: G,
  b: 5,
  s1: 64,
  u1: 25,
  s2: 144,
  u2: 50,
  s3: 2016,
  cap: 100,
  fin: 6,
  bps: [], // filled from Rust's table below
};

/* DEATH_BPS, copied verbatim from hopper-core/src/params.rs. The Rust
 * test `params::tests::...` pins the same array, so this is a mirror,
 * not a second source of truth. */
p.bps = [
  2500, 2500, 2500, 2500, 2500, 2500, 2153, 1896, 1697, 1539, 1410, 1304, 1214, 1137, 1071, 1013,
  962, 917, 877, 840, 808, 778, 751, 726, 703, 682, 663, 645, 628, 612, 597, 584, 571, 559, 547,
  537, 526, 517, 508, 499, 491, 483, 475, 468, 461, 455, 448, 442, 437, 431, 426, 421, 416, 411,
  407, 402, 398, 394, 390, 386, 382, 379, 375, 372, 369, 366, 363, 360, 357, 354, 351, 349, 346,
  344, 341, 339, 337, 334, 332, 330, 328, 326, 324, 322, 320, 318, 317, 315, 313, 311, 310, 308,
  307, 305, 304, 302, 301, 299, 298, 296, 295,
];

let failures = 0;
function eq(what, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) {
    failures++;
    console.error(`FAIL ${what}\n  got  ${a}\n  want ${b}`);
  }
}

/* required() — heights chosen to straddle every anchor of the schedule. */
const requiredCases = [
  [0, 5],       // below (and at) genesis is the base
  [63, 5],
  [64, 6],
  [1000, 20],
  [1279, 24],
  [1280, 25],   // A1
  [2000, 30],
  [4879, 49],
  [4880, 50],   // A2
  [5000, 50],
  [105679, 99],
  [105680, 100], // A3
  [200000, 100],
];
for (const [off, want] of requiredCases) eq(`required(+${off})`, api.requiredAt(H(off), p), want);
eq("required(0) clamps", api.requiredAt(0, p), 5);

/* Frozen settlement vectors (settle.rs). */
const zero = "0000000000000000000000000000000000000000000000000000000000000000";
const rev = (h) => h.match(/../g).reverse().join("");
/* settle.rs stores the block hash in INTERNAL order; ord serves display
 * order, so the vector is reversed here exactly as the fold reverses it. */
const h42 = rev("7dc96f776c8423e57a2785489a3f9c43fb6e756876d6ad9a9cac4aa4e72ec193");
const deathCases = [
  [0, zero, 5, false],
  [42, h42, 5, true],
  [42, h42, 25, true],
  [42, h42, 50, false],
  [0, zero, 100, false],
  [29, zero, 100, true],
  [35, zero, 100, true],
];
for (const [sat, hash, target, want] of deathCases) {
  eq(`dies(sat=${sat}, t=${target})`, await api.isDead(sat, hash, target, p), want);
}

const SP = "aa".repeat(32) + ":0:0";
function child(height, satpoint = SP) {
  return { id: `${"aa".repeat(32)}i0`, height, sequence: height, satpoint, bodyOk: true };
}
async function fold(over) {
  return api.foldFrog({ sat: 0, id: "x", tip: 0, me: { satpoint: SP }, children: [], hash: {}, p, ...over });
}

/* 1. A dead first crossing (sat 42 at target 5). */
eq(
  "dead first crossing",
  await fold({ sat: 42, tip: H(6), children: [child(H(0))], hash: { [H(1)]: h42 } }),
  { state: "dead", dist: 0, target: 5, pending: false }
);

/* 2. Not final yet: the outcome exists but is not committed. */
eq(
  "pending until finality",
  await fold({ sat: 42, tip: H(5), children: [child(H(0))], hash: { [H(1)]: h42 } }),
  { state: "crossing", dist: 0, target: 5, pending: true }
);

/* 3. A forged child on another sat is ignored (satpoint mismatch). */
eq(
  "foreign satpoint ignored",
  await fold({ sat: 42, tip: H(105680), children: [child(H(0), "bb".repeat(32) + ":0:0")], hash: { [H(1)]: h42 } }),
  { state: "idle", dist: 0, target: 100, pending: false }
);

/* 4. A non-canonical body is ignored. */
eq(
  "bad body ignored",
  await fold({ sat: 42, tip: H(105680), children: [{ ...child(H(0)), bodyOk: false }], hash: { [H(1)]: h42 } }),
  { state: "idle", dist: 0, target: 100, pending: false }
);

/* 5. Five surviving crossings at target 5 reach HOME (dist >= target). */
const heights = [0, 1, 2, 3, 4];
eq(
  "home after five survivors",
  await fold({
    sat: 0,
    tip: H(10),
    children: heights.map((h) => child(H(h))),
    hash: Object.fromEntries(heights.map((h) => [String(H(h + 1)), zero])),
  }),
  { state: "home", dist: 5, target: 5, pending: false }
);

/* 6. An empty history is idle at the tip's requirement. */
eq("empty history", await fold({ sat: 0, tip: H(0) }), { state: "idle", dist: 0, target: 5, pending: false });

/* 7. Two crossings on one sat. Input deliberately out of order: the fold
 *    sorts by (height, sequence) and accumulates dist, and its bank target
 *    is the NEXT block's requirement (required(3001) = 36), not the frozen
 *    target of the last crossing (required(2000) = 30). A fold that kept
 *    the crossing's target would tell the player 2/30 forever. */
eq(
  "two crossings accumulate",
  await fold({
    sat: 0,
    tip: H(3000),
    children: [child(H(2000)), child(H(1000))],
    hash: { [H(1001)]: zero, [H(2001)]: zero },
  }),
  { state: "idle", dist: 2, target: 36, pending: false }
);

/* 8. The second crossing is not final yet: the fold must freeze at that
 *    crossing with the dist earned so far — never count it early. */
eq(
  "second crossing pending",
  await fold({
    sat: 0,
    tip: H(2003),
    children: [child(H(1000)), child(H(2000))],
    hash: { [H(1001)]: zero, [H(2001)]: zero },
  }),
  { state: "crossing", dist: 1, target: 30, pending: true }
);

if (failures) {
  console.error(`v6 fold: ${failures} failure(s)`);
  process.exit(1);
}
console.log("v6 fold: OK (required, death byte-order, satpoint filter, home, pending, multi-cross)");
