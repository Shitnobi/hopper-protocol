// SPEC §5.5: the emergency descriptor export is a LAYOUT backup. A tool
// must be able to rebuild every leaf, control block and output key from
// the JSON alone, and the document must never carry key material.
import assert from 'node:assert/strict';
import { deriveWallet } from '../js/wallet/keys.js';
import { DemoBackend } from '../js/wallet/backend.js';
import { buildMint, buildPrepare, stateScripts } from '../js/wallet/actions.js';
import { WalletSession } from '../js/wallet/wallet.js';
import { CARD_VALUE } from '../js/core/params.js';
import { NUMS_XONLY } from '../js/core/params.js';
import { p2trScript } from '../js/wallet/addresses.js';
import { branchHash, controlBlock, leafHash, taprootOutputKey } from '../js/wallet/keys.js';
import { bytesToHex, hexToBytes, equalBytes } from '../js/core/hex.js';
import { descriptorChecksumOk } from '../js/core/descriptor.js';
import { qrModules } from '../js/ui/qr.js';
import { emergencySheet, recoverySheet } from '../js/ui/screens.js';
import {
  emptyRecoveryStore, normalizeRecoveryStore, reconcileRecoveryStore, recoveryPackDoc,
  PENDING_RECOVERY_BLOCKS,
} from '../js/wallet/recovery.js';

const MNEMONIC = 'deliver cat inch coyote consider beyond extend fence fish grain million stock';
let checks = 0;
const ok = (cond, message) => { checks += 1; if (!cond) throw new Error(message); };
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks += 1; };

const wallet = deriveWallet(MNEMONIC, 'regtest');
const backend = new DemoBackend('regtest', { fresh: true });
const chain = backend.chain;

async function scan() {
  const out = [];
  const fk = { address: wallet.frogAddress(), script: p2trScript(wallet.ord.outputXonly) };
  for (const u of await backend.addressUtxos(fk.address, fk.script)) {
    out.push({ ...u, kind: 'frog', key: wallet.ord, ranges: [], exact: true, frogs: [] });
  }
  for (const branch of ['receive', 'change']) {
    for (let i = 0; i < 5; i += 1) {
      const key = wallet[branch](i);
      for (const u of await backend.addressUtxos(key.address, key.script)) {
        let dto = null;
        try { dto = await backend.utxo(u.txid, u.vout); } catch { /* untracked */ }
        out.push({
          ...u, kind: 'p2wpkh', key, script: u.script,
          ranges: dto ? dto.ranges.map(([a, b]) => [a, b - 1]) : [],
          exact: true, frogs: dto ? dto.frogs : [],
        });
      }
    }
  }
  return out;
}

chain.fund({ script: wallet.receive(0).script, value: 200000, count: 8 });
let utxos = await scan();
const mint = buildMint({ keys: wallet, utxos, seed: 0xABCD, name: 'Cold Frog', feeRate: 2, genHint: 1 });
chain.submit(mint.commit.hex);
chain.submit(mint.reveal.hex);
let frog = chain.record(mint.sat);
const mintOut = (await scan()).find((u) => u.kind === 'frog' && u.txid === mint.reveal.txid);
const prep = buildPrepare({ keys: wallet, utxo: mintOut, frog, funding: await scan(), feeRate: 2 });
chain.submit(prep.hex);
frog = chain.record(mint.sat);
const stateUtxo = chain.utxo(prep.txid, 0);

const staged = {
  keys: wallet,
  network: 'regtest',
  frogs: [frog],
  tipHeight: chain.tipHeight(),
  _emergencyEntry: WalletSession.prototype._emergencyEntry,
  _emergencyFingerprint: WalletSession.prototype._emergencyFingerprint,
  _frogUtxo: () => ({ kind: 'state', value: CARD_VALUE, txid: prep.txid, vout: 0 }),
};
const doc = WalletSession.prototype.emergencyDescriptors.call(staged, { now: '2026-10-30T00:00:00Z' });

eq(doc.type, 'hopper-v7-emergency', 'document type');
eq(doc.version, 1, 'version');
eq(doc.network, 'regtest', 'network');
eq(doc.owner_path, `m/84'/${wallet.coinType}'/0'/2/0`, 'owner path');
assert.match(doc.fingerprint, /^[0-9a-f]{8}$/); checks += 1;
eq(doc.tip_height, chain.tipHeight(), 'tip stamped');
eq(doc.frogs.length, 1, 'one staged Hopper');
eq(doc.descriptor, doc.frogs[0].descriptor, 'single staged Hopper gets a wallet-level descriptor');
ok(descriptorChecksumOk(doc.descriptor), 'wallet-level descriptor checksum');

const e = doc.frogs[0];
eq(e.sat, frog.sat, 'sat');
eq(e.state_outpoint, `${prep.txid}:0`, 'state outpoint');
eq(e.internal_key, bytesToHex(NUMS_XONLY), 'internal key');
eq(e.owner_xonly, bytesToHex(wallet.ord.ownerXonly), 'owner key');
eq(e.leaves.length, 3, 'three crossing leaves');
eq(e.send_leaf.script_hex.length, 68, 'send leaf is <owner> OP_CHECKSIG');

// Rebuild the tree from the export's own bytes and compare with the chain.
const scripts = stateScripts(frog, wallet.ord.ownerXonly);
const hashes = e.leaves.map((leaf) => leafHash(hexToBytes(leaf.script_hex)));
eq(hashes, [0, 1, 2].map((dir) => leafHash(scripts.crossLeaves[dir])), 'leaf hashes rebuild');
const hX = leafHash(hexToBytes(e.send_leaf.script_hex));
const root = branchHash(branchHash(hashes[0], hashes[1]), branchHash(hashes[2], hX));
const { outputXonly } = taprootOutputKey(NUMS_XONLY, root);
eq(bytesToHex(outputXonly), e.output_key, 'output key rebuilds from the export');
eq(bytesToHex(p2trScript(outputXonly)), stateUtxo.scriptHex, 'output key matches the chain scriptPubKey');

// Rebuild the control blocks from the SPEC §3.1 sibling table.
const hLS = branchHash(hashes[0], hashes[1]);
const hRX = branchHash(hashes[2], hX);
const paths = [[hashes[1], hRX], [hashes[0], hRX], [hX, hLS]];
for (const leaf of e.leaves) {
  eq(leaf.leaf_hash, bytesToHex(hashes[leaf.dir]), `leaf ${leaf.dir} hash`);
  const cb = hexToBytes(leaf.control_block);
  eq(cb.length, 97, 'control block is 97 bytes');
  ok(equalBytes(cb.slice(1, 33), NUMS_XONLY), 'control block internal key');
  ok(equalBytes(cb.slice(33, 65), paths[leaf.dir][0]), 'first sibling');
  ok(equalBytes(cb.slice(65, 97), paths[leaf.dir][1]), 'second sibling');
  ok(descriptorChecksumOk(e.descriptor), 'per-frog descriptor checksum');
}
const sendCb = hexToBytes(e.send_leaf.control_block);
ok(equalBytes(sendCb.slice(33, 65), hashes[2]) && equalBytes(sendCb.slice(65, 97), hLS),
  'send control block');

// No key material, ever.
const text = JSON.stringify(doc);
ok(!/xprv|private[_-]?key|mnemonic|seed words/i.test(text), 'no key material in the export');
for (const word of MNEMONIC.split(' ')) {
  ok(!new RegExp(`\\b${word}\\b`, 'i').test(text), `mnemonic word leaked: ${word}`);
}
ok(!text.includes(bytesToHex(wallet.ord.ownerPrivate)), 'private key bytes are absent');

// The snapshot stale check.
eq(WalletSession.prototype.emergencyIsStale.call(staged, doc, doc.tip_height), false, 'same tip is fresh');
eq(WalletSession.prototype.emergencyIsStale.call(staged, doc, doc.tip_height + 1), true, 'a new block makes it stale');

// Two staged Hopper cannot share one descriptor (bodies differ).
const second = {
  ...e,
  sat: e.sat + 1,
  mint_id: `${'ab'.repeat(32)}i0`,
  descriptor: `tr(${e.internal_key},{raw(00),raw(01),raw(02),raw(03)})#${'q'.repeat(8)}`,
};
const multi = WalletSession.prototype.emergencyDescriptors.call({
  ...staged,
  frogs: [frog, { ...frog, sat: frog.sat + 1, mint_txid: 'ab'.repeat(32), mint_index: 0 }],
}, { now: '2026-10-30T00:00:01Z' });
eq(multi.frogs.length, 2, 'two staged Hopper exported');
eq(multi.descriptor, null, 'no single wallet-level descriptor for two Hopper');
ok(multi.frogs.every((f) => descriptorChecksumOk(f.descriptor)), 'each Hopper carries its own descriptor');
void second;

// The sheet must produce a QR that a camera can actually hold: either the
// full compact document or the one-Hopper layout summary.
const html = emergencySheet({ w: staged }, doc);
ok(html.includes('data-qr='), 'the export sheet shows a QR');
const payload = /data-qr="([^"]*)"/.exec(html)?.[1] || '';
ok(payload.length > 0 && payload.length <= 2300, `QR payload fits (${payload.length} bytes)`);
ok(qrModules(payload.replaceAll('&quot;', '"')) !== null, 'the QR encoder accepts the payload');
ok(html.includes('JSON above is authoritative') || payload.length <= 2300, 'the sheet names the authoritative form');


// --- automatic recovery packs -------------------------------------------
const store0 = emptyRecoveryStore({ fingerprint: doc.fingerprint, network: 'regtest' });
const r1 = reconcileRecoveryStore(store0, doc, {
  tipHeight: doc.tip_height, now: '2026-10-30T00:00:02Z',
});
eq(r1.created, 1, 'first staged layout creates one pack');
const pack1 = r1.store.packs[String(e.sat)];
eq(pack1.state_outpoint, `${prep.txid}:0`, 'pack records the staged outpoint');
eq(pack1.descriptor, e.descriptor, 'pack carries the descriptor');
eq(pack1.first_staged_tip, doc.tip_height, 'pack records the first staged tip');
eq(pack1.history.length, 0, 'a new pack has no history');

const r2 = reconcileRecoveryStore(r1.store, doc, {
  tipHeight: doc.tip_height, now: '2026-10-30T00:00:03Z',
});
eq(r2.changed, false, 're-seeing the same layout does not rewrite it');
eq(r2.store.packs[String(e.sat)].updated_at, '2026-10-30T00:00:02Z', 'created timestamp survives');

const nextTxid = 'ef'.repeat(32);
const movedDoc = {
  ...doc,
  frogs: [{ ...e, state_outpoint: `${nextTxid}:0`, state_value: CARD_VALUE }],
};
const r3 = reconcileRecoveryStore(r2.store, movedDoc, {
  tipHeight: doc.tip_height + 1, now: '2026-10-30T00:00:04Z',
});
eq(r3.moved, 1, 'a moved state output is recorded');
const pack2 = r3.store.packs[String(e.sat)];
eq(pack2.state_outpoint, `${nextTxid}:0`, 'pack follows the new staged outpoint');
eq(pack2.history.length, 1, 'the old layout is kept in history');
eq(pack2.history[0].state_outpoint, `${prep.txid}:0`, 'history names the old outpoint');
eq(pack2.history[0].descriptor, e.descriptor, 'history keeps the old descriptor');
eq(pack2.created_at, pack1.created_at, 'the pack keeps its creation time');
eq(pack2.first_staged_tip, pack1.first_staged_tip, 'the first staged tip is preserved');

const exportedPacks = recoveryPackDoc(r3.store, { now: '2026-10-30T00:00:05Z' });
ok(Array.isArray(exportedPacks.packs) && exportedPacks.packs.length === 1, 'export has a packs array');
ok(exportedPacks.packs[0].history.length === 1, 'export carries layout history');
ok(!/xprv|private[_-]?key|mnemonic|seed words/i.test(JSON.stringify(exportedPacks)),
  'recovery packs carry no key material');
for (const word of MNEMONIC.split(' ')) {
  ok(!new RegExp(`\\b${word}\\b`, 'i').test(JSON.stringify(exportedPacks)), `pack leaked mnemonic word: ${word}`);
}

// A malformed persisted pack is dropped instead of being trusted.
const badStore = normalizeRecoveryStore({
  type: 'hopper-v7-recovery-store', version: 1, fingerprint: doc.fingerprint,
  packs: [{ ...pack1, sat: 'not-a-sat', descriptor: '' }, pack1],
}, { fingerprint: doc.fingerprint, network: 'regtest' });
eq(Object.keys(badStore.packs).length, 1, 'only the valid stored pack survives');

// The wallet-side local record used immediately after PREPARE/HOP.
const fake = {
  keys: wallet,
  network: 'regtest',
  fingerprint: wallet.fingerprint,
  tipHeight: chain.tipHeight(),
  recovery: emptyRecoveryStore({ fingerprint: doc.fingerprint, network: 'regtest' }),
  saved: 0,
  _emergencyEntry: WalletSession.prototype._emergencyEntry,
  _emergencyFingerprint: WalletSession.prototype._emergencyFingerprint,
  _rememberRecovery: WalletSession.prototype._rememberRecovery,
  _saveRecovery() { this.saved += 1; },
};
WalletSession.prototype._rememberRecovery.call(fake, frog, {
  txid: prep.txid, vout: 0, value: CARD_VALUE, tipHeight: chain.tipHeight(),
});
const local1 = fake.recovery.packs[String(frog.sat)];
eq(local1.state_outpoint, `${prep.txid}:0`, 'PREPARE writes a pack before the indexer answers');
eq(fake.saved, 1, 'the local pack is persisted');
const hopTxid = 'cd'.repeat(32);
WalletSession.prototype._rememberRecovery.call(fake, frog, {
  txid: hopTxid, vout: 0, value: CARD_VALUE, tipHeight: chain.tipHeight() + 1,
});
const local2 = fake.recovery.packs[String(frog.sat)];
eq(local2.state_outpoint, `${hopTxid}:0`, 'HOP updates the local pack');
eq(local2.history.length, 1, 'HOP keeps the previous staged outpoint');
eq(local2.history[0].state_outpoint, `${prep.txid}:0`, 'history is the PREPARE output');

// A post-broadcast refresh may still see the old indexer location. It must
// not walk a locally recorded pack backwards while the new tx confirms.
const staleDoc = { ...doc, tip_height: chain.tipHeight() + 1, frogs: [e] };
const held = reconcileRecoveryStore(fake.recovery, staleDoc, {
  tipHeight: chain.tipHeight() + 1, now: '2026-10-30T00:00:09Z',
});
eq(held.store.packs[String(frog.sat)].state_outpoint, `${hopTxid}:0`,
  'stale indexer answer does not move a pending pack backwards');
eq(held.store.packs[String(frog.sat)].history.length, 1,
  'stale indexer answer adds no history');
const confirmedDoc = { ...doc, tip_height: chain.tipHeight() + 2,
  frogs: [{ ...e, state_outpoint: `${hopTxid}:0` }] };
const confirmed = reconcileRecoveryStore(held.store, confirmedDoc, {
  tipHeight: chain.tipHeight() + 2, now: '2026-10-30T00:00:10Z',
});
eq(confirmed.store.packs[String(frog.sat)].state_outpoint, `${hopTxid}:0`,
  'the confirmed indexer answer keeps the new outpoint');
eq(confirmed.store.packs[String(frog.sat)].pending_outpoint, null,
  'confirmation clears the pending marker');
const expired = reconcileRecoveryStore(fake.recovery, staleDoc, {
  tipHeight: Number(local2.pending_tip) + PENDING_RECOVERY_BLOCKS + 1,
  now: '2026-10-30T00:00:11Z',
});
eq(expired.store.packs[String(frog.sat)].state_outpoint, `${prep.txid}:0`,
  'after the pending window the chain answer wins');
eq(expired.store.packs[String(frog.sat)].pending_outpoint, null,
  'expiry clears the pending marker');

const recoveryHtml = recoverySheet({ w: staged }, exportedPacks);
ok(recoveryHtml.includes('data-recovery-json') && recoveryHtml.includes('COPY JSON'),
  'the recovery sheet exposes the saved JSON');
ok(recoveryHtml.includes('1 saved pack'), 'the recovery sheet counts packs');

console.log(`emergency: ${checks} checks passed`);
