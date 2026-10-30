// Pins the JS protocol port to Rust-generated vectors.
// Regenerate: cargo run -p hopper-core --example vectors > web/tests/rust-vectors.json

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

import {
  GENESIS, PROTOCOL, paramsHash, paramsHashHex, paramsLiteral,
  requiredAt, generationAt, generationStart, nextIncrement, foldParams,
  hopDeathBps, completionBps,
} from '../js/core/params.js';
import { wrapOfBytes, wrapOfDisplayHex, dies } from '../js/core/wrap.js';
import { mintEnvelope, decodeMint } from '../js/core/envelope.js';
import {
  encodeStateBody, decodeStateBody, crossLeafScript, stateLeafScript,
  sendLeafScript, encodeParentTag, decodeStateBody as decodeBody,
} from '../js/core/v7.js';
import { buildInscriptionScript, parseInscriptions } from '../js/core/inscription.js';
import { liveV7Html, mintBodyDigest, parseV7GenHint } from '../js/core/mintdoc.js';
import { foldFrog } from '../js/core/fold.js';
import { leafHash, branchHash } from '../js/wallet/keys.js';
import { bytesToHex, hexToBytes, utf8, reverseBytes } from '../js/core/hex.js';

const here = dirname(fileURLToPath(import.meta.url));
const v = JSON.parse(readFileSync(join(here, 'rust-vectors.json'), 'utf8'));

let checks = 0;
function eq(what, got, want) {
  assert.deepEqual(got, want, `${what}\n got: ${JSON.stringify(got)}\nwant: ${JSON.stringify(want)}`);
  checks++;
}

// --- parameters -----------------------------------------------------------
eq('wire version', 7, v.wire_version);
eq('genesis', GENESIS, v.genesis);
eq('generation_len', PROTOCOL.generations.generationLen, v.generations.generation_len);
eq('params_hash', paramsHashHex(), v.params_hash);
eq('params_literal', paramsLiteral(), v.params_literal);
for (const [height, want] of v.required) eq(`required(${height})`, requiredAt(height), want);
eq('generation(genesis)', generationAt(GENESIS), 1);
eq('generation(genesis+len)', generationAt(GENESIS + 28080), 2);
eq('generation_start(2)', generationStart(2), GENESIS + 28080);
eq('next_increment at ceiling', nextIncrement(GENESIS + 95 * 144 + 14400 - 1), [GENESIS + 28080, 5]);
eq('hop risk', hopDeathBps(), 3333);
eq('completion(5)', completionBps(5), 1317);

// --- the road's wrap ------------------------------------------------------
for (const w of v.wraps) {
  eq(`wrap ${w.hash.slice(0, 8)}`, wrapOfBytes(hexToBytes(w.hash)), w.wrap);
  const display = bytesToHex(reverseBytes(hexToBytes(w.hash)));
  eq(`wrap display ${w.hash.slice(0, 8)}`, wrapOfDisplayHex(display), w.wrap);
  for (let dir = 0; dir < 3; dir++) eq(`dies ${dir}`, dies(dir, hexToBytes(w.hash)), dir === w.wrap);
}

// --- wire bytes -----------------------------------------------------------
const owner = hexToBytes(v.owner);
const mintTxid = hexToBytes(v.mint_txid);
for (let dir = 0; dir < 3; dir++) {
  const body = { sat: 1_234_567_890, mintTxid, mintIndex: 2, dir };
  eq(`state body ${dir}`, bytesToHex(encodeStateBody(body)), v.state_bodies[dir]);
  eq(`decode body ${dir}`, decodeStateBody(hexToBytes(v.state_bodies[dir])).dir, dir);
  eq(`cross leaf ${dir}`, bytesToHex(crossLeafScript(owner, body)), v.state_leaves[dir]);
  eq(`state leaf ${dir}`, bytesToHex(stateLeafScript(owner, body, dir)), v.state_leaves[dir]);

  // The leaf parses back as exactly one ord envelope with the mint parent.
  const parsed = parseInscriptions(hexToBytes(v.state_leaves[dir]));
  eq('state leaf envelope count', parsed.length, 1);
  eq('state leaf parent', bytesToHex(parsed[0].parents[0]), bytesToHex(encodeParentTag(mintTxid, 2)));
  eq('state leaf body', bytesToHex(parsed[0].body), v.state_bodies[dir]);
}
eq('send leaf', bytesToHex(sendLeafScript(owner)), v.send_leaf);
for (const [i, index] of [0, 1, 255, 256, 65535, 0xffffffff].entries()) {
  eq(`parent tag i=${index}`, bytesToHex(encodeParentTag(mintTxid, index)), v.parent_tags[i]);
}

// The four-leaf tree: the Rust vectors pin the sibling paths both sides
// use to build and check control blocks.
const dir0 = { sat: 1_234_567_890, mintTxid, mintIndex: 2, dir: 0 };
const hL = leafHash(crossLeafScript(owner, dir0, 0));
const hS = leafHash(crossLeafScript(owner, dir0, 1));
const hR = leafHash(crossLeafScript(owner, dir0, 2));
const hX = leafHash(sendLeafScript(owner));
eq('leaf hashes L', bytesToHex(hL), v.leaf_hashes[0]);
eq('leaf hashes S', bytesToHex(hS), v.leaf_hashes[1]);
eq('leaf hashes R', bytesToHex(hR), v.leaf_hashes[2]);
eq('leaf hashes X', bytesToHex(hX), v.leaf_hashes[3]);
eq('tree root', bytesToHex(branchHash(branchHash(hL, hS), branchHash(hR, hX))), v.state_root);

// A body with dir > 2 is malformed.
const bad = encodeStateBody({ ...dir0, dir: 0 });
bad[54] = 9;
assert.throws(() => decodeBody(bad), /direction/);

// --- mint envelope --------------------------------------------------------
for (const m of v.mint_envelopes) {
  eq(`mint envelope ${m.seed}`, bytesToHex(mintEnvelope(m.seed, m.name)), m.hex);
  eq(`mint decode ${m.seed}`, decodeMint(hexToBytes(m.hex)), { seed: m.seed, name: m.name });
}

// --- mint bodies (the consensus-visible document) -------------------------
for (const m of v.mint_bodies) {
  const html = liveV7Html(m.seed, m.sat, m.name, m.gen_hint);
  eq(`mint body content-type ${m.seed}`, 'text/html;charset=utf-8', m.content_type);
  eq(`mint body bytes ${m.seed}`, utf8(html).length, m.html_len);
  eq(`mint body digest ${m.seed}/${m.sat}`, bytesToHex(mintBodyDigest(m.seed, m.sat, m.name, m.gen_hint)), m.digest);
  eq(`gen hint ${m.seed}`, parseV7GenHint(html), m.gen_hint);
  // no external origin, ever
  assert(!/https?:\/\/|\/\/[a-z0-9-]+\.[a-z]/i.test(html), 'mint body must not contain an external origin');
  assert(!html.includes('STATE FROM THE CHAIN'), 'v7 has no chain caption');
  // The static band names the Hopper and never counts crossings. A name
  // with HTML characters is escaped, never injected.
  if (!/[<>&"']/.test(m.name)) {
    assert(html.includes(`${m.name} · G${m.gen_hint} · 🛣 —`), 'static band');
  } else {
    assert(html.includes('&lt;script&gt;'), 'the static band escapes the name');
    assert(!html.includes('<script>&"'), 'the raw name never reaches the HTML');
  }
}

// --- ord envelope bytes ---------------------------------------------------
eq('inscription script', bytesToHex(buildInscriptionScript('image/png', utf8('ok'))), v.inscription_script);

// --- fold parity ----------------------------------------------------------
const P = foldParams();
const SP = 'aa'.repeat(32) + ':0:0';
const id = `${'aa'.repeat(32)}i0`;
const mk = (height, dir) => ({ id, height, sequence: height, satpoint: SP, bodyOk: true, dir });
// A hash whose wrap is `dir`: internal bytes dir,0,0,0 -> display hex.
const hashFor = (dir) => bytesToHex(reverseBytes(Uint8Array.of(dir, 0, 0, 0, ...new Uint8Array(28))));
const against = (dir) => hashFor((dir + 1) % 3);

eq('fold dead', foldFrog({
  sat: 42, tip: GENESIS + 6, me: { satpoint: SP },
  children: [mk(GENESIS, 1)], hash: { [GENESIS + 1]: hashFor(1) }, p: P,
}), { state: 'dead', dist: 0, dir: 1, target: 5, pending: false });

eq('fold alive but pending', foldFrog({
  sat: 42, tip: GENESIS + 5, me: { satpoint: SP },
  children: [mk(GENESIS, 1)], hash: { [GENESIS + 1]: hashFor(1) }, p: P,
}), { state: 'crossing', dist: 0, dir: 1, target: 5, pending: true });

eq('fold idle', foldFrog({ sat: 7, tip: GENESIS, me: { satpoint: SP }, children: [], hash: {}, p: P }),
  { state: 'idle', dist: 0, dir: null, target: 5, pending: false });

// Every frog in a block faces the same wrap: a frog that picked the wrap
// dies, a frog that picked another direction survives.
const survivors = [];
for (let dir = 0; dir < 3; dir += 1) {
  const r = foldFrog({
    sat: 1, tip: GENESIS + 6, me: { satpoint: SP },
    children: [mk(GENESIS, dir)], hash: { [GENESIS + 1]: hashFor(2) }, p: P,
  });
  survivors.push(r.state);
}
eq('one direction dies for everyone', survivors, ['idle', 'idle', 'dead']);

// The fold never consults the indexer: it recomputes from the hash.
const noHash = foldFrog({
  sat: 1, tip: GENESIS + 6, me: { satpoint: SP }, children: [mk(GENESIS, 0)], hash: {}, p: P,
});
eq('missing hash is pending, never a lie', noHash.state, 'crossing');
eq('missing hash reason', noHash.reason, 'missing hash');

console.log(`core: ${checks} checks passed`);
