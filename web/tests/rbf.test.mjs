// Fee bumps are the highest-risk wallet action here: a wrong output change
// can send a Hopper sat to the miner. These tests pin the conservative
// policy, the byte-level invariants, and the user-facing gate.
import assert from 'node:assert/strict';
import { deriveWallet } from '../js/wallet/keys.js';
import { buildSend } from '../js/wallet/actions.js';
import {
  RBF_POLICY, buildReplacement, buildSendRbfEnvelope, canBumpSend,
  fundingSnapshot, safeBumpFunding, validateSendRbf,
} from '../js/wallet/rbf.js';
import { parseTx } from '../js/wallet/txparse.js';
import { assignRanges, containsSat } from '../js/core/satmath.js';
import { DUST_P2WPKH } from '../js/core/params.js';
import { bumpFeeSheet, history } from '../js/ui/screens.js';

const MEM = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
globalThis.localStorage = MEM;

const MNEMONIC = 'deliver cat inch coyote consider beyond extend fence fish grain million stock';
const keys = deriveWallet(MNEMONIC, 'regtest');

let checks = 0;
const ok = (cond, message) => { checks += 1; assert.ok(cond, message); };
const reject = (fn, pattern, message) => { checks += 1; assert.throws(fn, pattern, message); };

function coin({ branch = 0, index = 0, value = 100000, start = 1000000, txid = '11'.repeat(32), vout = 0, ...over } = {}) {
  const key = branch === 0 ? keys.receive(index) : keys.change(index);
  return {
    txid, vout, value, script: key.script, address: key.address,
    kind: 'p2wpkh', exact: true, spendable: true, frogs: [], ranges: [[start, start + value - 1]],
    key, keyRef: { branch, index }, status: { confirmed: true }, ...over,
  };
}

function fixture() {
  const one = coin({ index: 0, value: 100000, start: 1000000, txid: '01'.repeat(32) });
  const two = coin({ index: 1, value: 80000, start: 2000000, txid: '02'.repeat(32) });
  const three = coin({ index: 2, value: 60000, start: 3000000, txid: '03'.repeat(32) });
  const recipient = keys.receive(7);
  const send = buildSend({
    keys, utxos: [one, two, three], recipientScript: recipient.script,
    amount: 10000n, feeRate: 2,
  });
  const rbf = buildSendRbfEnvelope({
    tx: send.tx, hex: send.hex, fee: Number(send.fee), inputs: send.inputs,
    to: recipient.address, amount: 10000, network: 'regtest',
    changeIndex: send.changeIndex, protectedSats: [],
  });
  const action = {
    kind: 'send', txid: send.txid, to: recipient.address, amount: '10000',
    fee: Number(send.fee), rbf, height: 100,
  };
  return { one, two, three, recipient, send, rbf, action };
}

function replacement(f, over = {}) {
  const a = over.action || f.action;
  return buildReplacement({
    action: a, keys, addedInputs: over.addedInputs || [f.two],
    feeRate: over.feeRate ?? 3, changeScript: keys.change(0).script,
    protectedOutpoints: over.protectedOutpoints || new Set(),
    protectedSats: over.protectedSats || [],
  });
}

// --- the normal path ------------------------------------------------------
{
  const f = fixture();
  ok(f.send.tx.inputs.every((i) => i.sequence === 0xfffffffd), 'a send opts into BIP125');
  ok(f.rbf.eligible && f.rbf.reason === '', 'a plain range-known send is bumpable');
  ok(f.rbf.fee === Number(f.send.fee) && f.rbf.vsize === f.send.vsize, 'envelope fee and size are exact');
  ok(f.rbf.outputs.length === f.send.tx.outputs.length, 'envelope records every output');
  ok(canBumpSend(f.action, true) && !canBumpSend(f.action, false), 'the UI gate needs a pending send');

  const rep = replacement(f);
  const orig = parseTx(f.send.hex);
  const next = parseTx(rep.hex);
  ok(rep.txid !== f.send.txid, 'the replacement txid differs');
  ok(rep.fee > Number(f.send.fee), 'absolute fee increases');
  ok(rep.feeRate > f.rbf.feeRate, 'feerate strictly increases');
  ok(rep.fee >= Number(f.send.fee) + rep.vsize, 'pays at least the +1 sat/vB incremental relay margin');
  ok(next.inputs.length === orig.inputs.length + 1, 'exactly one funding input is appended');
  ok(next.outputs.length === orig.outputs.length + 1, 'exactly one new change output is appended');
  ok(next.inputs.every((i) => i.sequence === 0xfffffffd), 'every replacement input signals RBF');
  for (let i = 0; i < orig.outputs.length; i++) {
    ok(next.outputs[i].value === orig.outputs[i].value, `output ${i} value is byte-for-byte preserved`);
    ok(Buffer.from(next.outputs[i].script).equals(Buffer.from(orig.outputs[i].script)), `output ${i} script is preserved`);
  }
  ok(next.outputs.at(-1).script.length === 22 && next.outputs.at(-1).value >= DUST_P2WPKH, 'new change is a non-dust P2WPKH output');
  ok(rep.rbf.eligible && rep.rbf.inputs.length === orig.inputs.length + 1, 'the replacement is itself recordable');
  ok(rep.rbf.outputs.length === next.outputs.length && rep.rbf.fee === rep.fee, 'the new envelope matches the new bytes');
  ok(JSON.parse(JSON.stringify(rep.rbf)).eligible === true, 'the replacement envelope is JSON-safe for the ledger');
  ok(JSON.parse(JSON.stringify({ ...f.action, rbf: rep.rbf })).rbf.hex === rep.hex, 'the action envelope survives localStorage JSON');

  const before = assignRanges(f.rbf.inputs.map((i) => i.ranges), orig.outputs.map((o) => Number(o.value)));
  const after = assignRanges(rep.rbf.inputs.map((i) => i.ranges), next.outputs.map((o) => Number(o.value)));
  ok(before && after, 'both transactions have complete range assignments');
  for (let i = 0; i < orig.outputs.length; i++) {
    ok(JSON.stringify(before.outputs[i]) === JSON.stringify(after.outputs[i]), `output ${i} keeps its exact sat ranges`);
  }
  ok(after.outputs.length === before.outputs.length + 1, 'the new output owns only added ranges');

  const lower = replacement(f, { feeRate: 1 });
  ok(lower.feeRate > f.rbf.feeRate, 'a low requested rate is raised above the original');
}

// A send that already consumes two coins keeps both, and only appends the
// new top-up. This pins input ordering for the range audit.
{
  const a = coin({ index: 3, value: 100000, start: 7000000, txid: '04'.repeat(32) });
  const b = coin({ index: 4, value: 80000, start: 8000000, txid: '05'.repeat(32) });
  const top = coin({ index: 5, value: 60000, start: 9000000, txid: '06'.repeat(32) });
  const r = keys.receive(8);
  const send = buildSend({ keys, utxos: [a, b], recipientScript: r.script, amount: 150000n, feeRate: 2 });
  const env = buildSendRbfEnvelope({
    tx: send.tx, hex: send.hex, fee: Number(send.fee), inputs: send.inputs,
    to: r.address, amount: 150000, network: 'regtest', changeIndex: send.changeIndex,
  });
  const action = { kind: 'send', txid: send.txid, to: r.address, amount: '150000', fee: Number(send.fee), rbf: env };
  const rep = buildReplacement({
    action, keys, addedInputs: [top], feeRate: 3, changeScript: keys.change(0).script,
  });
  const orig = parseTx(send.hex);
  const next = parseTx(rep.hex);
  ok(orig.inputs.length === 2 && next.inputs.length === 3, 'both original inputs are kept and one is appended');
  ok(orig.outputs.every((o, i) => o.value === next.outputs[i].value
    && Buffer.from(o.script).equals(Buffer.from(next.outputs[i].script))), 'multi-input original outputs are preserved');
}

// Funding can come from the change branch; the builder derives and checks it.
{
  const c = coin({ branch: 1, index: 0, value: 100000, start: 10000000, txid: '07'.repeat(32) });
  const top = coin({ branch: 1, index: 1, value: 80000, start: 11000000, txid: '08'.repeat(32) });
  const r = keys.receive(9);
  const send = buildSend({ keys, utxos: [c], recipientScript: r.script, amount: 10000n, feeRate: 2 });
  const env = buildSendRbfEnvelope({
    tx: send.tx, hex: send.hex, fee: Number(send.fee), inputs: send.inputs,
    to: r.address, amount: 10000, network: 'regtest', changeIndex: send.changeIndex,
  });
  ok(env.eligible, 'a change-branch input is still plain funding');
  const action = { kind: 'send', txid: send.txid, to: r.address, amount: '10000', fee: Number(send.fee), rbf: env };
  const rep = buildReplacement({
    action, keys, addedInputs: [top], feeRate: 3, changeScript: keys.change(0).script,
  });
  ok(rep.rbf.eligible && rep.addedInputs[0].keyRef.branch === 1, 'change-branch top-up is derived correctly');
}

// Two small coins can be combined when neither alone covers fee + dust.
{
  const f = fixture();
  const small1 = coin({ index: 10, value: 700, start: 12000000, txid: '09'.repeat(32) });
  const small2 = coin({ index: 11, value: 700, start: 13000000, txid: '0a'.repeat(32) });
  const rep = replacement(f, { addedInputs: [small1, small2] });
  ok(rep.tx.inputs.length === 3 && rep.changeValue >= Number(DUST_P2WPKH), 'multiple small top-ups are accepted when their sum is sufficient');
}

// A known Hopper sat anywhere in an original input makes the send ineligible
// and blocks the bump even though its bytes are otherwise valid.
{
  const f = fixture();
  const sat = f.one.ranges[0][0] + 100;
  const env = buildSendRbfEnvelope({
    tx: f.send.tx, hex: f.send.hex, fee: Number(f.send.fee), inputs: f.send.inputs,
    to: f.recipient.address, amount: 10000, network: 'regtest',
    changeIndex: f.send.changeIndex, protectedSats: [sat],
  });
  ok(env.eligible === false, 'a protected sat in a send input makes the envelope ineligible');
  ok(/not plain|Hopper|range/i.test(env.reason), 'the reason names the unsafe coin');
  const a = { ...f.action, rbf: env };
  reject(() => replacement(f, { action: a }), /not available|not a plain|Hopper|range/i,
    'an ineligible envelope cannot be bumped');
}

// The original fee range must not already hold a known Hopper sat.
{
  const f = fixture();
  const orig = parseTx(f.send.hex);
  const assigned = assignRanges(f.rbf.inputs.map((i) => i.ranges), orig.outputs.map((o) => Number(o.value)));
  const feeSat = assigned.feeRanges[0][1];
  reject(() => replacement(f, { protectedSats: [feeSat] }), /already assigns Hopper sat|contains Hopper sat/i,
    'a Hopper sat already in the original fee blocks a bump');
}

// Every game action is out of scope, even if a caller forges an envelope.
for (const kind of ['mint', 'prepare', 'cross', 'transfer']) {
  const f = fixture();
  reject(() => replacement(f, { action: { ...f.action, kind } }), /only available for plain Bitcoin sends/i,
    `${kind} has no RBF path`);
}
{
  const f = fixture();
  reject(() => replacement(f, { action: { ...f.action, sat: 42 } }), /only available for plain Bitcoin sends/i,
    'a send-shaped action carrying a sat is rejected');
}

// --- malformed or tampered originals -------------------------------------
{
  const f = fixture();
  const no = { ...f.action, rbf: null };
  reject(() => replacement(f, { action: no }), /no plain-send RBF record/i, 'missing envelope is rejected');
}
{
  const f = fixture();
  const bad = { ...f.action, rbf: { ...f.rbf, policy: 'generic-v1' } };
  reject(() => replacement(f, { action: bad }), /no plain-send RBF record/i, 'unknown policy is rejected');
}
{
  const f = fixture();
  const bad = { ...f.action, rbf: { ...f.rbf, eligible: false, reason: 'test' } };
  reject(() => replacement(f, { action: bad }), /not available: test/i, 'ineligible envelope is rejected');
}
{
  const f = fixture();
  reject(() => validateSendRbf({ ...f.action, txid: 'ff'.repeat(32) }), /does not match/i, 'action txid mismatch is rejected');
}
{
  const f = fixture();
  reject(() => validateSendRbf({ ...f.action, rbf: { ...f.rbf, hex: f.rbf.hex.replace(/.$/, (c) => c === '0' ? '1' : '0') } }),
    /does not hash|does not match/i, 'tampered original bytes are rejected');
}
{
  const f = fixture();
  const inputs = f.rbf.inputs.map((i, n) => n === 0 ? { ...i, txid: 'ff'.repeat(32) } : i);
  reject(() => validateSendRbf({ ...f.action, rbf: { ...f.rbf, inputs } }), /does not match/i, 'tampered input outpoint is rejected');
}
{
  const f = fixture();
  const inputs = f.rbf.inputs.map((i, n) => n === 0
    ? { ...i, value: i.value + 1, ranges: [[i.ranges[0][0], i.ranges[0][1] + 1]] } : i);
  reject(() => validateSendRbf({ ...f.action, rbf: { ...f.rbf, inputs } }), /fee does not match/i, 'tampered input value is rejected');
}
{
  const f = fixture();
  const outputs = f.rbf.outputs.map((o, n) => n === 0 ? { ...o, value: o.value + 1 } : o);
  reject(() => validateSendRbf({ ...f.action, rbf: { ...f.rbf, outputs } }), /output 0 does not match/i, 'tampered output value is rejected');
}
{
  const f = fixture();
  reject(() => validateSendRbf({ ...f.action, rbf: { ...f.rbf, vsize: f.rbf.vsize + 1 } }), /vsize does not match/i, 'tampered vsize is rejected');
}
{
  const f = fixture();
  const inputs = f.rbf.inputs.map((i, n) => n === 0 ? { ...i, assetFree: false } : i);
  reject(() => validateSendRbf({ ...f.action, rbf: { ...f.rbf, inputs } }), /not a plain funding coin/i, 'an input marked unsafe is rejected');
}
{
  const f = fixture();
  const inputs = f.rbf.inputs.map((i, n) => n === 0 ? { ...i, frogs: [7] } : i);
  reject(() => validateSendRbf({ ...f.action, rbf: { ...f.rbf, inputs } }), /carries a Hopper/i, 'an input with a frog is rejected');
}
{
  const f = fixture();
  const inputs = f.rbf.inputs.map((i, n) => n === 0 ? { ...i, scriptHex: '5120' + '11'.repeat(32) } : i);
  reject(() => validateSendRbf({ ...f.action, rbf: { ...f.rbf, inputs } }), /P2WPKH/i, 'a P2TR original input is rejected');
}
{
  const f = fixture();
  const inputs = f.rbf.inputs.map((i, n) => n === 0 ? { ...i, keyRef: { branch: 'ord', index: 0 } } : i);
  reject(() => validateSendRbf({ ...f.action, rbf: { ...f.rbf, inputs } }), /derivation path|wallet key reference/i, 'an ord derivation path is rejected');
}
{
  const f = fixture();
  const inputs = f.rbf.inputs.map((i, n) => n === 0 ? { ...i, ranges: [[i.ranges[0][0], i.ranges[0][1] - 1]] } : i);
  reject(() => validateSendRbf({ ...f.action, rbf: { ...f.rbf, inputs } }), /ranges do not sum/i, 'input ranges that do not sum to the value are rejected');
}
{
  const f = fixture();
  const inputs = f.rbf.inputs.map((i, n) => n === 0
    ? { ...i, ranges: [[i.ranges[0][0], i.ranges[0][1]], [i.ranges[0][1] + 1, i.ranges[0][1] + 1]] } : i);
  reject(() => validateSendRbf({ ...f.action, rbf: { ...f.rbf, inputs } }), /unsorted or overlapping|do not sum/i, 'overlapping input ranges are rejected');
}
{
  const f = fixture();
  const inPoint = `${f.rbf.inputs[0].txid}:${f.rbf.inputs[0].vout}`;
  reject(() => validateSendRbf(f.action, { protectedOutpoints: new Set([inPoint]) }), /known Hopper/i, 'a current frog outpoint blocks the bump');
}
{
  const f = fixture();
  const sat = f.rbf.inputs[0].ranges[0][0] + 1;
  reject(() => validateSendRbf(f.action, { protectedSats: [sat] }), /contains Hopper sat/i, 'a newly discovered frog sat blocks the bump');
}

// --- added funding safety -------------------------------------------------
{
  const f = fixture();
  reject(() => buildReplacement({
    action: f.action, keys, addedInputs: [], feeRate: 3, changeScript: keys.change(0).script,
  }), /no confirmed plain funding/i, 'a bump needs at least one added coin');
}
{
  const f = fixture();
  reject(() => replacement(f, { addedInputs: [coin({ ...f.two, kind: 'frog' })] }), /not a plain funding coin/i, 'a frog coin cannot be added');
}
{
  const f = fixture();
  reject(() => replacement(f, { addedInputs: [coin({ ...f.two, frogs: [9] })] }), /carries a Hopper/i, 'a coin carrying a frog cannot be added');
}
{
  const f = fixture();
  reject(() => replacement(f, { addedInputs: [coin({ ...f.two, status: { confirmed: false } })] }), /not confirmed/i, 'unconfirmed top-up funding is rejected');
}
{
  const f = fixture();
  reject(() => replacement(f, { addedInputs: [coin({ ...f.two, exact: false })] }), /not a plain funding coin/i, 'a coin without exact ranges cannot be added');
}
{
  const f = fixture();
  reject(() => replacement(f, { addedInputs: [coin({ ...f.two, range: null, ranges: [] })] }), /no known sat ranges|not a plain/i, 'a coin without ranges cannot be added');
}
{
  const f = fixture();
  reject(() => replacement(f, { addedInputs: [coin({ ...f.two, keyRef: { branch: 1, index: 9 } })] }), /key does not match|not a plain/i, 'a top-up script must match its wallet key');
}
{
  const f = fixture();
  reject(() => replacement(f, { addedInputs: [coin({ ...f.two, keyRef: null })] }), /key reference|not a plain/i, 'a top-up needs a wallet derivation path');
}
{
  const f = fixture();
  const p = `${f.two.txid}:${f.two.vout}`;
  reject(() => replacement(f, { addedInputs: [f.two], protectedOutpoints: new Set([p]) }), /known Hopper/i, 'a protected outpoint cannot be added');
}
{
  const f = fixture();
  const sat = f.two.ranges[0][0] + 1;
  reject(() => replacement(f, { addedInputs: [f.two], protectedSats: [sat] }), /not a plain funding coin|contains Hopper/i, 'a top-up containing a frog sat is rejected');
}
{
  const f = fixture();
  const broken = { ...f.two, ranges: [[f.two.ranges[0][0], f.two.ranges[0][1] - 1]] };
  reject(() => replacement(f, { addedInputs: [broken] }), /ranges do not sum|not a plain/i, 'a top-up whose ranges undercount its value is rejected');
}
{
  const f = fixture();
  const overlapping = { ...f.two, ranges: [[f.two.ranges[0][0], f.two.ranges[0][1]], [f.two.ranges[0][1], f.two.ranges[0][1]]] };
  reject(() => replacement(f, { addedInputs: [overlapping] }), /overlapping|ranges do not sum|not a plain/i, 'a top-up with overlapping ranges is rejected');
}
{
  const f = fixture();
  reject(() => replacement(f, { addedInputs: [f.one] }), /reuses an original outpoint/i, 'an original input cannot be reused as top-up');
}
{
  const f = fixture();
  const originalOutput = coin({ ...f.two, txid: f.send.txid, vout: 0, status: { confirmed: true } });
  reject(() => replacement(f, { addedInputs: [originalOutput] }), /reuses an original outpoint/i, 'an original output cannot be added as funding');
}
{
  const f = fixture();
  reject(() => replacement(f, { addedInputs: [f.two, f.two] }), /duplicate funding/i, 'duplicate top-up inputs are rejected');
}
{
  const f = fixture();
  const tiny = coin({ ...f.two, value: 100, ranges: [[5000000, 5000099]] });
  reject(() => replacement(f, { addedInputs: [tiny] }), /not enough added funding|dust/i, 'a top-up too small to pay the fee and dust is rejected');
}

// Current-wallet discovery changes the answer.
{
  const f = fixture();
  const w = { frogs: [{ sat: 5, location: { txid: f.one.txid, vout: 0 } }], utxos: [f.one, f.two] };
  const picks = safeBumpFunding([f.one, f.two], {
    keys, original: { txid: f.send.txid, inputs: f.send.tx.inputs },
    protectedOutpoints: new Set([`${f.one.txid}:0`]), protectedSats: [5],
  });
  ok(w.frogs.length === 1 && picks.length === 1 && picks[0].snapshot.txid === f.two.txid,
    'a discovered frog outpoint and sat are excluded from the top-up pool');
}
{
  const f = fixture();
  const snap = fundingSnapshot(f.two, [f.two.ranges[0][0]]);
  ok(snap.assetFree === false, 'a protected sat invalidates a funding snapshot');
}

// --- wallet orchestration -------------------------------------------------
function ledgerWallet() {
  MEM._d = {};
  return import('../js/wallet/wallet.js').then(({ WalletSession }) => {
    const w = new WalletSession({ mnemonic: MNEMONIC, network: 'regtest' });
    w.refresh = async () => w;
    return w;
  });
}

{
  const f = fixture();
  const w = await ledgerWallet();
  const action = structuredClone(f.action);
  w.actions = [action];
  w.pending = [{ txid: f.send.txid, sinceTip: 100, at: Date.now() }];
  w.utxos = [f.one, f.two, f.three];
  w.frogs = [];
  let broadcast = null;
  let broadcasts = 0;
  w.backend = {
    getTx: async () => ({ status: { confirmed: false } }),
    getTxHex: async () => action.rbf.hex,
    broadcast: async (hex) => { broadcast = hex; broadcasts += 1; return 'ok'; },
  };
  const built = await w.bumpFee(f.send.txid, { feeRate: 3 });
  ok(broadcast === built.hex && broadcasts === 1, 'the replacement is what was broadcast, exactly once');
  ok(action.txid === built.txid && action.rbf.hex === built.hex, 'the action now points at the replacement');
  ok(action.bumps === 1 && action.replaced.includes(f.send.txid), 'the action records the bump chain');
  ok(!w.pending.some((p) => p.txid === f.send.txid) && w.pending.some((p) => p.txid === built.txid),
    'pending now tracks only the replacement');
  ok(action.fee === built.fee && action.rbf.eligible === true, 'the new fee and envelope are persisted');

  const first = parseTx(built.hex);
  const again = await w.bumpFee(action.txid, { feeRate: 4 });
  const second = parseTx(again.hex);
  ok(broadcasts === 2, 'a successful second bump broadcasts exactly once');
  ok(action.bumps === 2 && action.replaced.length === 2, 'a second bump extends the chain');
  ok(first.outputs.every((o, i) => o.value === second.outputs[i].value
    && Buffer.from(o.script).equals(Buffer.from(second.outputs[i].script))), 'a second bump also preserves every prior output');
  ok(again.fee > built.fee && again.feeRate > built.feeRate, 'a second bump raises fee and feerate again');
}

async function walletReject(mutator, pattern, label) {
  const f = fixture();
  const w = await ledgerWallet();
  const action = structuredClone(f.action);
  w.actions = [action];
  w.pending = [{ txid: f.send.txid, sinceTip: 100, at: Date.now() }];
  w.utxos = [f.one, f.two, f.three];
  w.frogs = [];
  let broadcasts = 0;
  w.backend = {
    getTx: async () => ({ status: { confirmed: false } }),
    getTxHex: async () => action.rbf.hex,
    broadcast: async () => { broadcasts += 1; return 'ok'; },
  };
  const ctx = { f, w, action };
  if (mutator) await mutator(ctx);
  checks += 1;
  await assert.rejects(() => w.bumpFee(action.txid, { feeRate: 3 }), pattern, label);
  checks += 1;
  assert.equal(broadcasts, 0, `${label}: nothing may be broadcast when the safety check fails`);
}

await walletReject(({ w }) => { w.actions = []; }, /only an unconfirmed plain send/i, 'an unknown action is rejected');
await walletReject(({ action }) => { action.kind = 'prepare'; }, /only an unconfirmed plain send/i, 'a game action is never sent to the bump path');
await walletReject(({ action }) => { action.rbf = null; }, /RBF is not available/i, 'an action without an envelope is rejected');
await walletReject(({ action }) => { action.rbf.eligible = false; action.rbf.reason = 'unsafe'; }, /not available: unsafe/i, 'an ineligible action is rejected');
await walletReject(({ w }) => { w.pending = []; }, /not pending/i, 'a non-pending action is rejected');
await walletReject(({ w, f }) => { w.history = [{ txid: f.send.txid }]; }, /already confirmed/i, 'an indexer-confirmed action is rejected');
await walletReject(({ w }) => { w.backend.getTx = async () => null; }, /no longer in the mempool/i, 'a missing original is rejected');
await walletReject(({ w }) => { w.backend.getTx = async () => { throw new Error('404'); }; }, /no longer in the mempool/i, 'a backend error fetching the original is rejected');
await walletReject(({ w }) => { w.backend.getTx = async () => ({ status: { confirmed: true } }); }, /already confirmed/i, 'a confirmed original is rejected');
await walletReject(({ w }) => { w.backend.getTxHex = async () => '00'; }, /bytes do not match/i, 'different bytes under the txid are rejected');
await walletReject(({ w }) => { w.backend.getTxHex = async () => { throw new Error('no'); }; }, /would not return the original bytes/i, 'a backend that cannot prove the bytes is rejected');
await walletReject(({ w }) => { delete w.backend.getTxHex; }, /cannot prove the original bytes/i, 'a backend without getTxHex is rejected');
await walletReject(({ w }) => { w.utxos = []; }, /no confirmed plain funding/i, 'no spare confirmed coin means no bump');
await walletReject(({ w, f }) => { w.utxos = [{ ...f.two, status: { confirmed: false } }]; }, /no confirmed plain funding/i, 'unconfirmed top-up funding is unavailable');
await walletReject(({ w, f }) => { w.frogs = [{ sat: 6, location: { txid: f.one.txid, vout: 0 } }]; }, /known Hopper|contains Hopper/i, 'a current frog outpoint blocks the wallet bump');
await walletReject(({ w, f }) => { w.imported = new Set([f.one.ranges[0][0] + 3]); }, /contains Hopper sat/i, 'a current frog sat in an input blocks the wallet bump');

// --- UI gate --------------------------------------------------------------
{
  const f = fixture();
  const w = {
    actions: [f.action], pending: [{ txid: f.action.txid }], history: [], mempool: [], frogs: [],
    frogBySat: () => null, balance: {},
  };
  const html = history({ w, settings: { feeRate: 2 } });
  ok(html.includes('data-action="bump-fee"') && html.includes('IN MEMPOOL'), 'history offers BUMP FEE on a pending plain send');
  const confirmed = history({ w: { ...w, pending: [] }, settings: { feeRate: 2 } });
  ok(!confirmed.includes('data-action="bump-fee"'), 'history does not offer a bump after confirmation');
  const prep = { ...f.action, kind: 'prepare', sat: 42 };
  const ordinal = history({ w: { ...w, actions: [prep] }, settings: { feeRate: 2 } });
  ok(!ordinal.includes('data-action="bump-fee"'), 'history never offers a bump on a game action');
  const unsafe = { ...f.action, rbf: { ...f.rbf, eligible: false, reason: 'protected sat' } };
  ok(!history({ w: { ...w, actions: [unsafe] }, settings: { feeRate: 2 } }).includes('data-action="bump-fee"'),
    'history hides the button for an ineligible envelope');
  const sheet = bumpFeeSheet({ settings: { feeRate: 2 } }, f.action);
  ok(sheet.includes('REPLACE TRANSACTION') && sheet.includes('NO KNOWN HOPPER') && sheet.includes(`data-txid="${f.action.txid}"`),
    'the bump sheet is an explicit approval step, not an immediate broadcast');
  ok(fundingSnapshot(f.one).assetFree === true, 'a normal funding snapshot is safe');
  ok(fundingSnapshot({ ...f.one, ranges: [[f.one.ranges[0][0], f.one.ranges[0][1] - 1]] }).assetFree === false,
    'a snapshot whose ranges undercount its value is not eligible');
  ok(containsSat(f.two.ranges, f.two.ranges[0][0]), 'the fixture ranges are usable by the range audit');
  ok(RBF_POLICY === 'plain-send-v1', 'the policy id is stable');
}

console.log(`rbf: ${checks} checks passed`);
