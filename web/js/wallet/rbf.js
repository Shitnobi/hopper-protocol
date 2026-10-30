// BIP125 fee bumps for ordinary HOPPER sends.
//
// This module is deliberately narrower than a generic RBF implementation.
// It only replaces a wallet-created plain send, and it never removes value
// from any output of the original transaction. Instead it appends confirmed
// plain BIP84 funding and one new change output. That gives the important
// ordinal invariant:
//
//   every original output keeps its script and its exact value
//
// so no sat range can move out of an output into the fee. The builder also
// recomputes the FIFO range assignment and refuses a bump if a known Hopper
// sat would land in the fee, or if any original/added input is not a plain,
// confirmed, range-known BIP84 coin without frogs.
//
// The game transactions (MINT, PREPARE, CROSS, TRANSFER) stay non-RBF and
// have no bump path at all. They can spend a state card or an inscription,
// and a generic "shave the change" bump is exactly how an ordinal gets
// burned by accident.

import { bytesToHex, hexToBytes, reverseBytes } from '../core/hex.js';
import { DUST_P2WPKH } from '../core/params.js';
import { assignRanges, containsSat } from '../core/satmath.js';
import { parseTx } from './txparse.js';
import {
  RBF_SEQUENCE, inputFromUtxo, makeTx, output, serializeTx, signP2wpkh,
  txid, vsize,
} from './tx.js';

export const RBF_POLICY = 'plain-send-v1';

export class RbfSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RbfSafetyError';
    this.code = 'RBF_UNSAFE';
  }
}

function insufficient(message) {
  const e = new Error(message);
  e.name = 'RbfFundingError';
  e.code = 'RBF_INSUFFICIENT_FUNDING';
  return e;
}

const hex = (bytes) => bytesToHex(bytes);
const outpoint = (txidValue, vout) => `${String(txidValue || '').toLowerCase()}:${Number(vout)}`;
function inputTxid(input) {
  if (input?.txidBytes) return bytesToHex(reverseBytes(input.txidBytes));
  if (input?.txid instanceof Uint8Array) return bytesToHex(reverseBytes(input.txid));
  return String(input?.txid || '').toLowerCase();
}
const isP2wpkhScript = (script) => !!script && script.length === 22
  && script[0] === 0x00 && script[1] === 0x14;

function safeInt(n, what, { positive = false } = {}) {
  if (!Number.isSafeInteger(n) || (positive && n <= 0)) {
    throw new RbfSafetyError(`${what} is not a safe integer`);
  }
  return n;
}

function safeRanges(raw, what) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new RbfSafetyError(`${what} has no known sat ranges`);
  }
  return raw.map((pair) => {
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new RbfSafetyError(`${what} has a malformed sat range`);
    }
    const a = safeInt(Number(pair[0]), `${what} range start`);
    const b = safeInt(Number(pair[1]), `${what} range end`);
    if (a < 0 || b < a) throw new RbfSafetyError(`${what} has an empty sat range`);
    return [a, b];
  });
}

export function rangesContainAny(ranges, sats) {
  for (const sat of sats || []) {
    const n = Number(sat);
    if (Number.isSafeInteger(n) && containsSat(ranges, n)) return n;
  }
  return null;
}

/** Snapshot only the fields a later bump may trust. No private keys. */
export function fundingSnapshot(u, protectedSats = []) {
  const ranges = Array.isArray(u?.ranges) && u.ranges.length
    ? u.ranges.map(([a, b]) => [Number(a), Number(b)])
    : null;
  const keyRef = u?.keyRef && Number.isInteger(Number(u.keyRef.branch))
    && Number.isInteger(Number(u.keyRef.index))
    ? { branch: Number(u.keyRef.branch), index: Number(u.keyRef.index) }
    : null;
  const frogs = Array.isArray(u?.frogs) ? u.frogs.map(Number) : [];
  const script = u?.script instanceof Uint8Array ? u.script : null;
  const protectedHit = ranges && rangesContainAny(ranges, protectedSats);
  const value = Number(u?.value);
  const rangesTotal = ranges ? ranges.reduce((a, [x, y]) => a + (y - x + 1), 0) : -1;
  const rangesOrdered = !!ranges && ranges.every(([a, b], i) => i === 0 || a > ranges[i - 1][1]);
  const assetFree = !!(
    u?.kind === 'p2wpkh'
    && u?.exact === true
    && u?.spendable !== false
    && keyRef && (keyRef.branch === 0 || keyRef.branch === 1)
    && script && isP2wpkhScript(script)
    && ranges && ranges.length > 0
    && Number.isSafeInteger(value) && value > 0 && rangesTotal === value
    && rangesOrdered
    && frogs.length === 0
    && protectedHit == null
  );
  return {
    txid: String(u?.txid || '').toLowerCase(),
    vout: Number(u?.vout),
    value: Number(u?.value),
    scriptHex: script ? hex(script) : '',
    address: String(u?.address || ''),
    keyRef,
    ranges: ranges || [],
    frogs,
    assetFree,
  };
}

function snapshotFromEnvelope(raw, what) {
  if (!raw || typeof raw !== 'object') throw new RbfSafetyError(`${what} is missing`);
  const keyRef = raw.keyRef && (Number(raw.keyRef.branch) === 0 || Number(raw.keyRef.branch) === 1)
    && Number.isSafeInteger(Number(raw.keyRef.index)) && Number(raw.keyRef.index) >= 0
    ? { branch: Number(raw.keyRef.branch), index: Number(raw.keyRef.index) } : null;
  return {
    txid: typeof raw.txid === 'string' ? raw.txid.toLowerCase() : '',
    vout: Number(raw.vout),
    value: Number(raw.value),
    scriptHex: String(raw.scriptHex || '').toLowerCase(),
    address: String(raw.address || ''),
    keyRef,
    ranges: Array.isArray(raw.ranges) ? raw.ranges.map(([a, b]) => [Number(a), Number(b)]) : [],
    frogs: Array.isArray(raw.frogs) ? raw.frogs.map(Number) : [],
    assetFree: raw.assetFree === true,
  };
}

function checkSnapshot(s, what) {
  if (!/^[0-9a-f]{64}$/.test(s.txid)) throw new RbfSafetyError(`${what} has no valid txid`);
  safeInt(s.vout, `${what} vout`);
  if (s.vout < 0) throw new RbfSafetyError(`${what} has a negative vout`);
  safeInt(s.value, `${what} value`, { positive: true });
  if (!/^[0-9a-f]{44}$/.test(s.scriptHex)) throw new RbfSafetyError(`${what} is not a P2WPKH script`);
  const script = hexToBytes(s.scriptHex);
  if (!isP2wpkhScript(script)) throw new RbfSafetyError(`${what} is not P2WPKH`);
  if (!s.keyRef) throw new RbfSafetyError(`${what} has no wallet key reference`);
  s.ranges = safeRanges(s.ranges, what);
  if (!s.ranges.every(([a], i) => i === 0 || a > s.ranges[i - 1][1])) {
    throw new RbfSafetyError(`${what} sat ranges are unsorted or overlapping`);
  }
  const rangesTotal = s.ranges.reduce((a, [x, y]) => a + (y - x + 1), 0);
  if (rangesTotal !== s.value) throw new RbfSafetyError(`${what} sat ranges do not sum to its value`);
  if (s.frogs.length) throw new RbfSafetyError(`${what} carries a Hopper`);
  if (s.assetFree !== true) throw new RbfSafetyError(`${what} is not a plain funding coin`);
  return s;
}

/**
 * Build the durable metadata recorded with a send. It does not throw when a
 * coin cannot be categorised as plain; it records `eligible:false` and the
 * history simply has no BUMP FEE button. The transaction itself is unchanged.
 */
export function buildSendRbfEnvelope({
  tx, hex: txHex, fee, inputs, to, amount, network, changeIndex = null,
  protectedSats = [],
}) {
  if (!tx || !Array.isArray(inputs)) throw new RbfSafetyError('send envelope needs a transaction and its inputs');
  if (inputs.length !== tx.inputs.length) throw new RbfSafetyError('send envelope input count does not match the transaction');
  const snapshots = inputs.map((u) => fundingSnapshot(u, protectedSats));
  snapshots.forEach((s, i) => {
    const input = tx.inputs[i];
    if (s.txid !== inputTxid(input) || s.vout !== Number(input.vout)) {
      throw new RbfSafetyError('send envelope input order does not match the transaction');
    }
  });
  return envelopeFromSnapshots({
    tx, txHex, fee, inputs: snapshots, to, amount, network, changeIndex,
  });
}

function envelopeFromSnapshots({
  tx, txHex, fee, inputs, to, amount, network, changeIndex,
}) {
  if (!Number.isSafeInteger(Number(fee)) || Number(fee) <= 0) {
    throw new RbfSafetyError('a send envelope needs a positive integer fee');
  }
  if (typeof txHex !== 'string' || !/^[0-9a-f]+$/i.test(txHex)) {
    throw new RbfSafetyError('a send envelope needs its serialized bytes');
  }
  const outputs = tx.outputs.map((o) => ({
    value: Number(o.value),
    scriptHex: hex(o.script),
  }));
  const totalIn = inputs.reduce((a, s) => a + BigInt(s.value), 0n);
  const totalOut = tx.outputs.reduce((a, o) => a + o.value, 0n);
  const derivedFee = totalIn - totalOut;
  const allSignaled = tx.inputs.every((i) => Number(i.sequence) <= RBF_SEQUENCE);
  const allPlain = inputs.every((s) => s.assetFree === true);
  const feeMatches = Number.isSafeInteger(Number(fee)) && BigInt(fee) === derivedFee;
  const vs = vsize(tx);
  const txId = txid(tx);
  let reason = '';
  if (!allPlain) reason = 'one or more inputs are not plain BIP84 funding';
  else if (!allSignaled) reason = 'the transaction did not opt into BIP125';
  else if (!feeMatches) reason = 'the recorded fee does not match the transaction';
  else if (changeIndex != null && (!Number.isInteger(changeIndex) || changeIndex < 0 || changeIndex >= outputs.length)) {
    reason = 'the change index is invalid';
  }
  return {
    version: 1,
    policy: RBF_POLICY,
    kind: 'send',
    eligible: reason === '',
    reason,
    txid: txId,
    hex: String(txHex || ''),
    vsize: vs,
    fee: Number(fee),
    feeRate: vs > 0 ? Number(fee) / vs : 0,
    inputs,
    outputs,
    changeIndex: changeIndex == null ? null : Number(changeIndex),
    to: String(to || ''),
    amount: String(amount ?? ''),
    network: String(network || ''),
    createdAt: new Date().toISOString(),
  };
}

/**
 * Validate the persisted envelope against the exact original bytes and the
 * wallet's CURRENT ordinal view. The current view matters: a frog discovered
 * after broadcast must make an old send unbumpable.
 */
export function validateSendRbf(action, {
  protectedOutpoints = new Set(), protectedSats = [], keys = null,
} = {}) {
  if (!action || action.kind !== 'send' || action.sat != null) {
    throw new RbfSafetyError('RBF is only available for plain Bitcoin sends, never a Hopper action');
  }
  const r = action.rbf;
  if (!r || r.policy !== RBF_POLICY || r.kind !== 'send') {
    throw new RbfSafetyError('this transaction has no plain-send RBF record');
  }
  if (r.eligible !== true) throw new RbfSafetyError(`RBF is not available: ${r.reason || 'not a plain send'}`);
  if (!r.hex || !r.txid || action.txid !== r.txid
    || typeof r.hex !== 'string' || !Array.isArray(r.inputs) || !Array.isArray(r.outputs)) {
    throw new RbfSafetyError('the RBF record does not match the action txid');
  }
  if (!Number.isSafeInteger(Number(r.fee)) || Number(r.fee) <= 0
    || !Number.isSafeInteger(Number(r.vsize)) || Number(r.vsize) <= 0) {
    throw new RbfSafetyError('the RBF record has an invalid fee or size');
  }
  const tx = parseTx(r.hex);
  if (tx.txid !== r.txid) throw new RbfSafetyError('the RBF record hex does not hash to its txid');
  if (tx.inputs.length !== r.inputs.length) throw new RbfSafetyError('the RBF record input count is wrong');
  if (tx.outputs.length !== r.outputs.length) throw new RbfSafetyError('the RBF record output count is wrong');
  if (!tx.inputs.every((i) => Number(i.sequence) <= RBF_SEQUENCE)) {
    throw new RbfSafetyError('the original transaction did not opt into BIP125');
  }
  const snapshots = r.inputs.map((raw, i) => {
    const s = checkSnapshot(snapshotFromEnvelope(raw, `input ${i}`), `input ${i}`);
    const input = tx.inputs[i];
    if (s.txid !== inputTxid(input) || s.vout !== Number(input.vout)) {
      throw new RbfSafetyError(`input ${i} does not match the original transaction`);
    }
    if (protectedOutpoints instanceof Set
      ? protectedOutpoints.has(outpoint(s.txid, s.vout))
      : (protectedOutpoints || []).includes(outpoint(s.txid, s.vout))) {
      throw new RbfSafetyError(`input ${i} is a known Hopper or ordinal-bearing output`);
    }
    const hit = rangesContainAny(s.ranges, protectedSats);
    if (hit != null) throw new RbfSafetyError(`input ${i} contains Hopper sat ${hit}`);
    if (keys) {
      const key = refKey(keys, s.keyRef, `input ${i}`);
      if (hex(key.script) !== s.scriptHex) throw new RbfSafetyError(`input ${i} does not belong to this wallet key`);
    }
    return s;
  });
  const outputs = tx.outputs.map((o, i) => {
    const raw = r.outputs[i];
    if (!raw || Number(raw.value) !== Number(o.value) || String(raw.scriptHex).toLowerCase() !== hex(o.script)) {
      throw new RbfSafetyError(`output ${i} does not match the original transaction`);
    }
    return { value: o.value, script: o.script };
  });
  const totalIn = snapshots.reduce((a, s) => a + BigInt(s.value), 0n);
  const totalOut = outputs.reduce((a, o) => a + o.value, 0n);
  const fee = totalIn - totalOut;
  if (fee <= 0n || BigInt(Number(r.fee)) !== fee) throw new RbfSafetyError('the original fee does not match its inputs and outputs');
  if (Number(r.vsize) !== vsize(tx)) throw new RbfSafetyError('the original vsize does not match its bytes');
  const assigned = assignRanges(snapshots.map((s) => s.ranges), outputs.map((o) => Number(o.value)));
  if (!assigned) throw new RbfSafetyError('the original transaction cannot be range-audited');
  for (const sat of protectedSats || []) {
    if (containsSat(assigned.feeRanges, Number(sat))) {
      throw new RbfSafetyError(`the original already assigns Hopper sat ${sat} to its fee`);
    }
  }
  return { tx, r, snapshots, outputs, fee };
}

function refKey(keys, ref, what) {
  if (!ref || (ref.branch !== 0 && ref.branch !== 1)
    || !Number.isSafeInteger(ref.index) || ref.index < 0 || ref.index > 1_000_000) {
    throw new RbfSafetyError(`${what} has no valid wallet derivation path`);
  }
  const key = ref.branch === 0 ? keys.receive(ref.index) : keys.change(ref.index);
  if (!key) throw new RbfSafetyError(`${what} cannot be derived`);
  return key;
}

function isConfirmed(u) {
  const st = u?.status || {};
  return st.confirmed === true || Number(st.height) > 0 || Number(st.block_height) > 0;
}

function isOriginalOutpoint(u, original) {
  return (original.inputs || []).some((i) => i.txid === u.txid && i.vout === u.vout)
    || (original.outputs || []).some((o) => o.txid === u.txid && o.vout === u.vout);
}

/**
 * Add one or more confirmed plain coins. Returns the snapshots and keys so
 * the caller can sign. This never reuses an original input/output, a known
 * Hopper outpoint, or an unconfirmed output.
 */
export function safeBumpFunding(utxos, {
  keys, original, protectedOutpoints = new Set(), protectedSats = [],
}) {
  const inputs = original.inputs || [];
  const outputs = (original.outputs || []).map((o, vout) => ({ txid: original.txid, vout }));
  const picked = [];
  for (const u of utxos || []) {
    const s = fundingSnapshot(u, protectedSats);
    if (!s.assetFree) continue;
    if (inputs.some((i) => i.txid === s.txid && i.vout === s.vout)) continue;
    if (outputs.some((o) => o.txid === s.txid && o.vout === s.vout)) continue;
    if (protectedOutpoints instanceof Set
      ? protectedOutpoints.has(outpoint(s.txid, s.vout))
      : (protectedOutpoints || []).includes(outpoint(s.txid, s.vout))) continue;
    if (!isConfirmed(u)) continue;
    if (isOriginalOutpoint(s, original)) continue;
    const key = refKey(keys, s.keyRef, `funding ${s.txid}:${s.vout}`);
    if (hex(key.script) !== s.scriptHex) continue;
    if (picked.some((p) => p.snapshot.txid === s.txid && p.snapshot.vout === s.vout)) continue;
    picked.push({ snapshot: s, key });
  }
  return picked;
}

/**
 * Build and sign a BIP125 replacement. All original outputs are preserved
 * exactly; a new change output is appended and paid for by the added coins.
 * The extra fee is therefore taken only from the newly added funds.
 */
export function buildReplacement({
  action, keys, addedInputs, feeRate = 2, changeScript,
  protectedOutpoints = new Set(), protectedSats = [], dust = Number(DUST_P2WPKH),
}) {
  if (!Array.isArray(addedInputs) || addedInputs.length === 0) {
    throw insufficient('no confirmed plain funding coin is available for a fee bump');
  }
  if (!changeScript || !isP2wpkhScript(changeScript)) {
    throw new RbfSafetyError('the bump needs a wallet P2WPKH change script');
  }
  const { tx: original, r, snapshots, outputs } = validateSendRbf(action, {
    protectedOutpoints, protectedSats, keys,
  });
  const originalOutpoints = new Set(original.inputs.map((i) => outpoint(i.txid, i.vout)));
  const originalOutputOutpoints = new Set(outputs.map((_, vout) => outpoint(r.txid, vout)));
  const seen = new Set();
  for (const u of addedInputs) {
    const s = fundingSnapshot(u, protectedSats);
    checkSnapshot(s, `funding ${s.txid}:${s.vout}`);
    if (!isConfirmed(u)) throw new RbfSafetyError(`funding ${s.txid}:${s.vout} is not confirmed`);
    if (originalOutpoints.has(outpoint(s.txid, s.vout)) || originalOutputOutpoints.has(outpoint(s.txid, s.vout))) {
      throw new RbfSafetyError('an added input reuses an original outpoint or its unconfirmed child');
    }
    if (protectedOutpoints instanceof Set
      ? protectedOutpoints.has(outpoint(s.txid, s.vout))
      : (protectedOutpoints || []).includes(outpoint(s.txid, s.vout))) {
      throw new RbfSafetyError('an added input is a known Hopper or ordinal-bearing output');
    }
    if (seen.has(outpoint(s.txid, s.vout))) throw new RbfSafetyError('duplicate funding input');
    seen.add(outpoint(s.txid, s.vout));
    const key = refKey(keys, s.keyRef, `funding ${s.txid}:${s.vout}`);
    if (hex(key.script) !== s.scriptHex) {
      throw new RbfSafetyError(`funding ${s.txid}:${s.vout} key does not match its script`);
    }
  }
  const addedSnapshots = addedInputs.map((u) => fundingSnapshot(u, protectedSats));
  const addedTotal = addedSnapshots.reduce((a, s) => a + BigInt(s.value), 0n);
  const oldFee = BigInt(r.fee);
  const oldVsize = Number(r.vsize);
  if (oldVsize <= 0) throw new RbfSafetyError('the original has no vsize');
  const requested = Number(feeRate);
  // Strictly higher integer sat/vB, and at least +1 sat/vB over the old
  // transaction. The latter also satisfies BIP125's incremental-relay rule
  // on nodes whose minimum relay fee is 1 sat/vB.
  const minRate = Math.max(1, Number.isFinite(requested) ? Math.floor(requested) : 1,
    Math.floor(Number(oldFee) / oldVsize) + 1);

  const tx = makeTx({
    version: original.version,
    locktime: original.locktime,
    inputs: [
      ...snapshots.map((s) => inputFromUtxo(s, RBF_SEQUENCE)),
      ...addedSnapshots.map((s) => inputFromUtxo(s, RBF_SEQUENCE)),
    ],
    outputs: outputs.map((o) => output(o.value, o.script)),
  });
  const changeOut = output(0n, changeScript);
  tx.outputs.push(changeOut);
  const changeIndex = tx.outputs.length - 1;

  const sign = () => {
    snapshots.forEach((s, i) => {
      const key = refKey(keys, s.keyRef, `input ${i}`);
      if (hex(key.script) !== s.scriptHex) throw new RbfSafetyError(`input ${i} key does not match its script`);
      signP2wpkh(tx, i, key.privateKey, key.publicKey, s.value);
    });
    addedSnapshots.forEach((s, i) => {
      const key = refKey(keys, s.keyRef, `funding ${s.txid}:${s.vout}`);
      signP2wpkh(tx, snapshots.length + i, key.privateKey, key.publicKey, s.value);
    });
  };

  // Size the fee against a small upper bound, not the exact DER length of
  // the first signature. A single-byte signature-length change must not make
  // the target and change value chase each other.
  sign();
  let bound = vsize(tx) + 2;
  let target = oldFee + BigInt(bound);
  const rateTarget = BigInt(Math.ceil(bound * minRate));
  if (rateTarget > target) target = rateTarget;
  let extra = target - oldFee;
  if (extra <= 0n) throw new RbfSafetyError('the replacement would not pay a higher absolute fee');
  if (addedTotal < extra + BigInt(dust)) {
    throw insufficient(`not enough added funding: need ${extra + BigInt(dust)} sats, have ${addedTotal}`);
  }
  let changeValue = addedTotal - extra;
  if (changeValue < BigInt(dust)) throw insufficient('the added funding would leave a dust change output');
  changeOut.value = changeValue;
  sign();
  let actualVsize = vsize(tx);
  if (actualVsize > bound) {
    // Extremely unlikely with P2WPKH, but if it happens enlarge the bound
    // once and charge for the larger bytes.
    bound = actualVsize + 2;
    target = oldFee + BigInt(bound);
    const rateTarget2 = BigInt(Math.ceil(bound * minRate));
    if (rateTarget2 > target) target = rateTarget2;
    extra = target - oldFee;
    if (addedTotal < extra + BigInt(dust)) {
      throw insufficient(`not enough added funding: need ${extra + BigInt(dust)} sats, have ${addedTotal}`);
    }
    changeValue = addedTotal - extra;
    if (changeValue < BigInt(dust)) throw insufficient('the added funding would leave a dust change output');
    changeOut.value = changeValue;
    sign();
    actualVsize = vsize(tx);
  }
  const totalIn = snapshots.reduce((a, s) => a + BigInt(s.value), 0n) + addedTotal;
  const totalOut = outputs.reduce((a, o) => a + o.value, 0n) + changeValue;
  const fee = totalIn - totalOut;
  if (fee !== oldFee + extra || fee <= oldFee) {
    throw new RbfSafetyError('the replacement fee does not equal the requested bump');
  }
  if (fee < target) throw new RbfSafetyError('the replacement fee is below its target');
  if (fee * BigInt(oldVsize) <= oldFee * BigInt(actualVsize)) {
    throw new RbfSafetyError('the replacement does not improve the feerate');
  }
  const settled = { actualVsize, target, extra, changeValue };

  // Re-prove the ordinal invariant on the actual replacement bytes.
  const before = assignRanges(snapshots.map((s) => s.ranges), outputs.map((o) => Number(o.value)));
  const after = assignRanges(
    [...snapshots, ...addedSnapshots].map((s) => s.ranges),
    tx.outputs.map((o) => Number(o.value)),
  );
  if (!before || !after) throw new RbfSafetyError('cannot prove ordinal ranges survive the replacement');
  for (let i = 0; i < outputs.length; i++) {
    if (JSON.stringify(before.outputs[i]) !== JSON.stringify(after.outputs[i])) {
      throw new RbfSafetyError(`output ${i} would receive a different sat range`);
    }
  }
  for (const sat of protectedSats || []) {
    if (containsSat(after.feeRanges, Number(sat))) {
      throw new RbfSafetyError(`the replacement would burn Hopper sat ${sat}`);
    }
  }

  const txHex = hex(serializeTx(tx, true));
  const replacementId = txid(tx);
  if (replacementId === r.txid) throw new RbfSafetyError('the replacement has the same txid');
  const replacement = envelopeFromSnapshots({
    tx,
    txHex,
    fee: Number(fee),
    inputs: [...snapshots, ...addedSnapshots],
    to: r.to,
    amount: r.amount,
    network: r.network,
    changeIndex,
  });
  if (!replacement.eligible) throw new RbfSafetyError(`replacement envelope failed: ${replacement.reason}`);

  return {
    tx,
    hex: txHex,
    txid: replacementId,
    fee: Number(fee),
    vsize: settled.actualVsize,
    feeRate: Number(fee) / settled.actualVsize,
    changeValue: Number(settled.changeValue),
    changeIndex,
    addedInputs: addedSnapshots,
    rbf: replacement,
    amount: r.amount,
  };
}

/** UI predicate. It cannot prove safety by itself; buildReplacement redoes it. */
export function canBumpSend(action, isPending) {
  return !!isPending && action?.kind === 'send' && action.sat == null
    && action.rbf?.eligible === true && action.rbf?.policy === RBF_POLICY;
}
