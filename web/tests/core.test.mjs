// Pins the JS protocol port to Rust-generated vectors.
// Regenerate: cargo run -p hopper-core --example vectors > web/tests/rust-vectors.json

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

import {
  GENESIS, DEATH_BPS, PROTOCOL, paramsHash, paramsHashHex, paramsLiteral,
  requiredAt, anchor1, anchor2, anchor3, foldParams,
} from '../js/core/params.js';
import { crossDigest, dies } from '../js/core/settle.js';
import { mintEnvelope, decodeMint } from '../js/core/envelope.js';
import {
  encodeStateBody, stateLeafScript, sendLeafScript, encodeParentTag, decodeStateBody,
} from '../js/core/v6.js';
import { buildInscriptionScript, parseInscriptions } from '../js/core/inscription.js';
import { liveV6Html } from '../js/core/mintdoc.js';
import { foldFrog } from '../js/core/fold.js';
import { bytesToHex, hexToBytes, utf8 } from '../js/core/hex.js';

const here = dirname(fileURLToPath(import.meta.url));
const v = JSON.parse(readFileSync(join(here, 'rust-vectors.json'), 'utf8'));

let checks = 0;
function eq(what, got, want) {
  assert.deepEqual(got, want, `${what}\n got: ${JSON.stringify(got)}\nwant: ${JSON.stringify(want)}`);
  checks++;
}

// --- parameters -----------------------------------------------------------
eq('wire version', 6, v.wire_version);
eq('genesis', GENESIS, v.genesis);
eq('anchor1', anchor1(), v.anchors[0]);
eq('anchor2', anchor2(), v.anchors[1]);
eq('anchor3', anchor3(), v.anchors[2]);
eq('params_hash', paramsHashHex(), v.params_hash);
eq('params_literal', paramsLiteral(), v.params_literal);
eq('death table', DEATH_BPS, v.death_bps);
for (const [height, want] of v.required) eq(`required(${height})`, requiredAt(height), want);

// --- settlement -----------------------------------------------------------
for (const c of v.settle) {
  const digest = crossDigest(c.sat, hexToBytes(c.hash));
  eq(`digest sat=${c.sat} t=${c.target}`, bytesToHex(digest), c.digest);
  eq(`dies sat=${c.sat} t=${c.target}`, dies(c.sat, hexToBytes(c.hash), c.target), c.dead);
}

// --- wire bytes -----------------------------------------------------------
const body = { sat: 1_234_567_890, mintTxid: hexToBytes(v.mint_txid), mintIndex: 2 };
eq('state body', bytesToHex(encodeStateBody(body)), v.state_body);
eq('decode body', decodeStateBody(hexToBytes(v.state_body)).sat, body.sat);
eq('state leaf', bytesToHex(stateLeafScript(hexToBytes(v.owner), body)), v.state_leaf);
eq('send leaf', bytesToHex(sendLeafScript(hexToBytes(v.owner))), v.send_leaf);
for (const [i, index] of [0, 1, 255, 256, 65535, 0xffffffff].entries()) {
  eq(`parent tag i=${index}`, bytesToHex(encodeParentTag(hexToBytes(v.mint_txid), index)), v.parent_tags[i]);
}

// The state leaf parses back as exactly one ord envelope with the mint parent.
const parsed = parseInscriptions(hexToBytes(v.state_leaf));
eq('state leaf envelope count', parsed.length, 1);
eq('state leaf parent', bytesToHex(parsed[0].parents[0]), bytesToHex(encodeParentTag(hexToBytes(v.mint_txid), 2)));
eq('state leaf body', bytesToHex(parsed[0].body), v.state_body);

// --- mint envelope --------------------------------------------------------
for (const m of v.mint_envelopes) {
  eq(`mint envelope ${m.seed}`, bytesToHex(mintEnvelope(m.seed, m.name)), m.hex);
  eq(`mint decode ${m.seed}`, decodeMint(hexToBytes(m.hex)), { seed: m.seed, name: m.name });
}

// --- mint bodies (the consensus-visible document) -------------------------
for (const m of v.mint_bodies) {
  const html = liveV6Html(m.seed, m.sat);
  eq(`mint body content-type ${m.seed}`, m.content_type, 'text/html;charset=utf-8');
  eq(`mint body bytes ${m.seed}`, utf8(html).length, m.html_len);
  const { mintBodyDigest } = await import('../js/core/mintdoc.js');
  eq(`mint body digest ${m.seed}/${m.sat}`, bytesToHex(mintBodyDigest(m.seed, m.sat)), m.digest);
  // no external origin, ever
  assert(!/https?:\/\/|\/\/[a-z0-9-]+\.[a-z]/i.test(html), 'mint body must not contain an external origin');
}

// --- ord envelope bytes ---------------------------------------------------
eq('inscription script', bytesToHex(buildInscriptionScript('image/png', utf8('ok'))), v.inscription_script);

// --- fold parity ----------------------------------------------------------
const P = foldParams();
const SP = 'aa'.repeat(32) + ':0:0';
const child = (height) => ({ id: `${'aa'.repeat(32)}i0`, height, sequence: height, satpoint: SP, bodyOk: true });
const h42display = Buffer.from(hexToBytes(v.settle[1].hash)).reverse().toString('hex');
eq('fold dead', foldFrog({
  sat: 42, tip: GENESIS + 6, me: { satpoint: SP }, children: [child(GENESIS)], hash: { [GENESIS + 1]: h42display }, p: P,
}), { state: 'dead', dist: 0, target: 5, pending: false });
eq('fold pending', foldFrog({
  sat: 42, tip: GENESIS + 5, me: { satpoint: SP }, children: [child(GENESIS)], hash: { [GENESIS + 1]: h42display }, p: P,
}), { state: 'crossing', dist: 0, target: 5, pending: true });
eq('fold idle', foldFrog({ sat: 7, tip: GENESIS, me: { satpoint: SP }, children: [], hash: {}, p: P }),
  { state: 'idle', dist: 0, target: 5, pending: false });

console.log(`core: ${checks} checks passed`);
