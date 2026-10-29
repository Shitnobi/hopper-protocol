#!/usr/bin/env node
/* Indexer ↔ fold parity, over the SAME chain.
 *
 * The fold is what the inscription renders (live_v6.js), and the indexer
 * is what /v1/frogger answers. They are separate implementations of the
 * same consensus rules, so a divergence is a real bug: a frog would show
 * one state in its own inscription and another on the wallet's card.
 *
 * The fixture is written by frogger-e2e/examples/ord_v6.rs from a live
 * regtest run (real ord 0.22.2, real indexer): the ord data the fold is
 * fed, plus the indexer's verdict for that same crossing.
 *
 * Run: node frogger/crates/hopper-core/tests/v6_fold_parity.mjs <fixture.json>
 */
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "src", "live_v6.js"), "utf8");
const { foldFrog } = new Function(src + "\nreturn {foldFrog};")();

const fixturePath = process.argv[2];
if (!fixturePath) {
  console.error("usage: v6_fold_parity.mjs <fixture.json>");
  process.exit(2);
}
const fx = JSON.parse(readFileSync(fixturePath, "utf8"));
const got = await foldFrog(fx.fold);
const want = fx.indexer;
const same = got.state === want.state && got.dist === want.dist;
console.log(
  `fold:    state=${got.state} dist=${got.dist} target=${got.target} pending=${!!got.pending}`
);
console.log(`indexer: state=${want.state} dist=${want.dist} (${want.url})`);
console.log(`crossings folded: ${(fx.fold.children || []).length}`);
if (!same) {
  console.error("V6 PARITY: MISMATCH");
  process.exit(1);
}
console.log("V6 PARITY: OK");
