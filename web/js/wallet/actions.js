// HOPPER action builders: MINT (commit+reveal), PREPARE, CROSS, TRANSFER.
//
// Every builder returns signed transactions plus the metadata the wallet
// needs to follow them. Nothing here touches the network; the caller
// broadcasts and refreshes.

import { bytesToHex, concatBytes, hexToBytes, reverseBytes, sha256 } from '../core/hex.js';
import { mintEnvelope } from '../core/envelope.js';
import { mintBody } from '../core/mintdoc.js';
import { crossLeafScript, legacyCrossLeafScript, mintCommitLeafScript, sendLeafScript } from '../core/v7.js';
import { CARD_VALUE, DUST_P2WPKH, NUMS_XONLY } from '../core/params.js';
import { assignRanges, rangeLen, rangesValue } from '../core/satmath.js';
import { p2trScript } from './addresses.js';
import {
  branchHash, controlBlock, leafHash, taprootOutputKey, taprootTweakedKey,
} from './keys.js';
import {
  RBF_SEQUENCE, inputFromUtxo, makeTx, output, serializeTx, signP2wpkh,
  signTaprootKeyPath, signTapscript, txid, vsize,
} from './tx.js';

export const FEE_FLOOR = 1;

// --- state output ---------------------------------------------------------

export function frogBody(frog, dir = 0) {
  return {
    sat: Number(frog.sat),
    mintTxid: reverseBytes(hexToBytes(frog.mint_txid)),
    mintIndex: frog.mint_index ?? 0,
    dir,
  };
}

// The four-leaf state output (SPEC §3.1):
//
//   hL = leaf(L)   hS = leaf(S)   hR = leaf(R)   hX = leaf(X)
//   hLS = branch(hL, hS)   hRX = branch(hR, hX)   root = branch(hLS, hRX)
//
// The three crossing leaves differ only in the direction byte of the body
// they push, so their hashes are fixed when the output is created.
export function stateScripts(frog, ownerXonly, { legacy = false } = {}) {
  const body = frogBody(frog, 0);
  const leaf = legacy ? legacyCrossLeafScript : crossLeafScript;
  const crosses = [leaf(ownerXonly, body), ...([1, 2].map((dir) => leaf(ownerXonly, body, dir)))];
  const send = sendLeafScript(ownerXonly);
  const [hL, hS, hR] = crosses.map((script) => leafHash(script));
  const hX = leafHash(send);
  const hLS = branchHash(hL, hS);
  const hRX = branchHash(hR, hX);
  const root = branchHash(hLS, hRX);
  const { outputXonly, parity } = taprootOutputKey(NUMS_XONLY, root);
  // Sibling order from the SPEC §3.1 table.
  const paths = [[hS, hRX], [hL, hRX], [hX, hLS]];
  return {
    script: p2trScript(outputXonly),
    outputXonly,
    internalXonly: NUMS_XONLY,
    leafHashes: [hL, hS, hR, hX],
    root,
    crossLeaves: crosses,
    crossControls: paths.map((path) => controlBlock(NUMS_XONLY, path, parity)),
    sendLeaf: send,
    sendControl: controlBlock(NUMS_XONLY, [hR, hLS], parity),
    body,
  };
}

// --- fees -----------------------------------------------------------------

export function estimateVsize(tx, inputTypes) {
  // Witness item lengths are CompactSize varints: a 13.5 KB mint leaf needs
  // three bytes, not one. Counting only the byte itself made the reveal
  // estimate one vB short even after the control-block fix.
  const varintLen = (n) => (n < 0xfd ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9);
  const pushLen = (n) => varintLen(n) + n;
  const base = serializeTx(tx, false).length;
  let witness = 2;
  for (const type of inputTypes) {
    if (type.type === 'p2wpkh') witness += 1 + pushLen(72) + pushLen(33);
    else if (type.type === 'p2tr-key') witness += 1 + pushLen(65);
    else if (type.type === 'tapscript') {
      // The control block is 33 bytes for a depth-0 leaf (mint reveal) and
      // 97 bytes for the depth-2 state leaves (CROSS/TRANSFER). Assuming 65
      // undercounts a state spend by 32 bytes (8 vB) and overcounts a mint
      // reveal by the same amount. Callers pass the real length; 65 remains
      // the conservative default for any older tapscript caller.
      const controlLen = type.controlLen ?? 65;
      witness += 1 + pushLen(65) + pushLen(type.scriptLen) + pushLen(controlLen);
    } else throw new Error(`unknown input type ${type.type}`);
  }
  return Math.ceil((base * 4 + witness) / 4);
}

function feeFor(vsize, rate) {
  return BigInt(Math.max(FEE_FLOOR, Math.ceil(vsize * rate)));
}

// Real witness sizes after signing (tapscript script length).
function actualTypes(tx, types) {
  return types.map((t, i) => {
    if (t.type !== 'tapscript') return t;
    const w = tx.inputs[i].witness;
    return { ...t, scriptLen: w && w[1] ? w[1].length : t.scriptLen };
  });
}

// --- coin selection -------------------------------------------------------

export function isFundingUtxo(u, { allowUnconfirmed = false } = {}) {
  // Funding is BIP84 P2WPKH only. The frog address (P2TR) and every state
  // card are excluded here as well as in Wallet._funding(), so no ordinary
  // send, mint, TRAVEL TO ROAD or CROSS can ever select the anchor sat as a
  // fee input. There is deliberately no burn builder in this file.
  if (u.kind !== 'p2wpkh' || (u.frogs && u.frogs.length)) return false;
  // F-02: an empty indexer/ord answer is not proof of "no inscription".
  // Every funding input must carry complete ordinal ranges whose total
  // equals its value. An unknown-ranged mempool coin is never funding,
  // even when the user has opted into spending unconfirmed coins.
  if (!Array.isArray(u.ranges) || !u.ranges.length || u.exact === false
      || u.spendable === false) return false;
  if (rangesValue(u.ranges) !== Number(u.value)) return false;
  return u.unconfirmed !== true || allowUnconfirmed;
}

/** Every input must name complete, value-matched ordinal ranges. This is
 *  the precondition for the FIFO assignment proof below. */
export function requireExactRanges(inputs, label = 'transaction') {
  for (const u of inputs) {
    if (!u || !Array.isArray(u.ranges) || !u.ranges.length || u.exact === false) {
      throw new Error(`${label}: input ${u?.txid || '?'}:${u?.vout ?? '?'} has no exact ordinal ranges`);
    }
    if (!Number.isSafeInteger(Number(u.value)) || Number(u.value) < 0) {
      throw new Error(`${label}: input ${u.txid}:${u.vout} has an invalid value`);
    }
    for (const r of u.ranges) {
      if (!Array.isArray(r) || r.length !== 2 || !Number.isSafeInteger(r[0])
          || !Number.isSafeInteger(r[1]) || r[0] > r[1] || r[0] < 0) {
        throw new Error(`${label}: input ${u.txid}:${u.vout} has a malformed ordinal range`);
      }
    }
    if (rangesValue(u.ranges) !== Number(u.value)) {
      throw new Error(`${label}: input ${u.txid}:${u.vout} ranges do not sum to its value`);
    }
  }
}

/** Prove the exact FIFO destination of `sat` and every protected sat.
 *  Returns the assignment so callers can inspect every output/fee range. */
export function proveAssignment({
  inputs, outputValues, sat = null, outputIndex = 0, protectedSats = [], label = 'transaction',
}) {
  requireExactRanges(inputs, label);
  const assignment = assignRanges(inputs.map((u) => u.ranges), outputValues.map(Number));
  if (!assignment) throw new Error(`${label}: inputs cannot cover the outputs`);
  if (sat != null) {
    const wanted = Number(sat);
    if (!Number.isSafeInteger(wanted)) throw new Error(`${label}: invalid anchor sat`);
    if (!assignment.outputs[outputIndex]?.some(([a, b]) => wanted >= a && wanted <= b)) {
      throw new Error(`${label}: the Hopper sat would not land in output ${outputIndex}; refusing to build`);
    }
  }
  for (const value of protectedSats) {
    const s = Number(value);
    if (!Number.isSafeInteger(s)) continue;
    for (const [a, b] of assignment.feeRanges) {
      if (s >= a && s <= b) throw new Error(`${label}: a protected Hopper sat would be paid to fees; refusing to build`);
    }
    for (const out of assignment.outputs) {
      for (const [a, b] of out) {
        if (s >= a && s <= b) throw new Error(`${label}: a protected Hopper sat would leave the wallet; refusing to build`);
      }
    }
  }
  return assignment;
}

export function assertAnchorFirst(input, sat, label = 'transaction') {
  if (!input || !Array.isArray(input.ranges) || !input.ranges.length) {
    throw new Error(`${label}: the Hopper coin has no exact ordinal ranges`);
  }
  const first = [...input.ranges].sort((a, b) => a[0] - b[0])[0][0];
  if (Number(first) !== Number(sat)) {
    throw new Error(`${label}: the Hopper sat is not the first sat of the coin; move it to its own output first`);
  }
}

export function selectFunding(utxos, target, exclude = [], opts = {}) {
  const skip = new Set(exclude);
  const pool = utxos
    .filter((u) => isFundingUtxo(u, opts) && !skip.has(`${u.txid}:${u.vout}`))
    .sort((a, b) => b.value - a.value);
  const picked = [];
  let total = 0n;
  for (const u of pool) {
    picked.push(u);
    total += BigInt(u.value);
    if (total >= target) break;
  }
  if (total < target) throw new Error(`insufficient funds: need ${target} sats, have ${total}`);
  return picked;
}

// The anchor sat is the first sat of input 0 (ordinals move FIFO).
export function anchorSatOf(utxo) {
  if (!utxo.ranges || !utxo.ranges.length) throw new Error('anchor coin has no ordinal ranges');
  return utxo.ranges[0][0];
}

// Position of `sat` inside a coin's known ordinal ranges (inclusive ends).
// `null` means the ranges do not cover the sat. A non-zero position is a
// problem for PREPARE/CROSS because the consensus state output expects the
// frog at offset 0; reject it before broadcasting an unspendable card.
export function anchorOffsetOf(utxo, sat) {
  if (!utxo || !utxo.ranges || !utxo.ranges.length) return null;
  const ranges = [...utxo.ranges].sort((a, b) => a[0] - b[0]);
  let offset = 0;
  const target = Number(sat);
  for (const [start, end] of ranges) {
    if (target >= start && target <= end) return offset + (target - start);
    offset += end - start + 1;
  }
  return null;
}

// --- finalization ---------------------------------------------------------

// Sign, measure, and shrink change until the fee covers `rate` sat/vB.
function finalize({ tx, inputs, sign, inputTypes, changeIndex, rate, dust = DUST_P2WPKH }) {
  const totalIn = inputs.reduce((a, u) => a + BigInt(u.value), 0n);
  const fixedOut = tx.outputs.reduce((a, o, i) => (i === changeIndex ? a : a + o.value), 0n);
  if (changeIndex == null) {
    sign(tx);
    return { tx, fee: totalIn - tx.outputs.reduce((a, o) => a + o.value, 0n) };
  }
  let change = totalIn - fixedOut - feeFor(estimateVsize(tx, inputTypes), rate);
  for (let pass = 0; pass < 6; pass++) {
    if (change < dust) {
      tx.outputs.splice(changeIndex, 1);
      sign(tx);
      break;
    }
    tx.outputs[changeIndex].value = change;
    sign(tx);
    const needed = feeFor(estimateVsize(tx, actualTypes(tx, inputTypes)), rate);
    const actual = totalIn - tx.outputs.reduce((a, o) => a + o.value, 0n);
    if (actual >= needed) break;
    change -= needed - actual;
  }
  const fee = totalIn - tx.outputs.reduce((a, o) => a + o.value, 0n);
  const needed = feeFor(estimateVsize(tx, actualTypes(tx, inputTypes)), rate);
  if (fee < needed) throw new Error(`cannot pay the fee: ${fee} < ${needed} sats`);
  return { tx, fee };
}

// --- MINT -----------------------------------------------------------------

export function buildMint({
  keys, utxos, seed, name = '', feeRate = 2, changeIndex = 0, revealFeeRate = null,
  genHint = 1, protectedSats = [],
}) {
  const rate = Math.max(FEE_FLOOR, feeRate);
  const revealRate = Math.max(FEE_FLOOR, revealFeeRate ?? feeRate);
  const ord = keys.ord;
  const owner = ord.ownerXonly;
  const change = keys.change(changeIndex);

  // 1. Pick the anchor coin: input 0 must have real ordinal ranges.
  const anchors = utxos
    .filter((u) => isFundingUtxo(u) && u.ranges && u.ranges.length)
    .sort((a, b) => b.value - a.value);
  if (!anchors.length) throw new Error('mint needs a tracked coin with known ordinal ranges');

  let chosen = null;
  for (const anchor of anchors) {
    const sat = anchorSatOf(anchor);
    const { contentType, body } = mintBody(seed, sat, name, genHint);
    const leaf = mintCommitLeafScript(owner, contentType, body);
    const leafH = leafHash(leaf);
    const commitOut = taprootOutputKey(owner, leafH);
    const commitControl = controlBlock(owner, [], commitOut.parity);
    const commitScript = p2trScript(commitOut.outputXonly);

    // 2. Size the reveal, which the commit output funds.
    const revealDraft = makeTx({
      inputs: [{
        txid: new Uint8Array(32), vout: 0, sequence: 0xffffffff,
        scriptSig: new Uint8Array(), witness: [],
      }],
      outputs: [
        output(1000n, p2trScript(owner)),
        output(0n, opReturnScript(mintEnvelope(seed, name))),
      ],
    });
    const revealVsize = estimateVsize(revealDraft, [{
      type: 'tapscript', scriptLen: leaf.length, controlLen: commitControl.length,
    }]);
    const revealFee = feeFor(revealVsize, revealRate);
    const commitValue = 1000n + revealFee;

    const commitDraft = makeTx({
      inputs: [inputFromUtxo(anchor)],
      outputs: [output(commitValue, commitScript), output(0n, change.script)],
    });
    const commitFee = feeFor(estimateVsize(commitDraft, [{ type: 'p2wpkh' }]), rate);

    let funding = [];
    try {
      funding = selectFunding(utxos, commitValue + commitFee - BigInt(anchor.value), [
        `${anchor.txid}:${anchor.vout}`,
      ]);
    } catch {
      continue;
    }
    chosen = {
      anchor, sat, leaf, leafH, commitOut, commitControl, commitScript,
      contentType, body, revealFee, commitValue, commitFee, funding,
    };
    break;
  }
  if (!chosen) throw new Error('no anchor coin can fund this mint');

  const { anchor, sat, leaf, commitOut, commitControl, commitScript, body, commitValue, funding } = chosen;
  const inputs = [anchor, ...funding];
  const totalIn = inputs.reduce((a, u) => a + BigInt(u.value), 0n);

  // 3. Commit transaction.
  const commitTx = makeTx({
    inputs: inputs.map((u) => inputFromUtxo(u)),
    outputs: [output(commitValue, commitScript), output(0n, change.script)],
  });
  const commitFinal = finalize({
    tx: commitTx,
    inputs,
    inputTypes: inputs.map(() => ({ type: 'p2wpkh' })),
    changeIndex: 1,
    rate,
    sign: (tx) => inputs.forEach((u, i) => signP2wpkh(tx, i, u.key.privateKey, u.key.publicKey, u.value)),
  });
  const commit = commitFinal.tx;
  // F-01/F-07: prove the anchor sat really lands at offset 0 of the commit
  // output, using the complete FIFO ranges, before signing anything else.
  const commitProof = proveAssignment({
    inputs,
    outputValues: commit.outputs.map((o) => Number(o.value)),
    sat,
    outputIndex: 0,
    protectedSats: protectedSats.filter((x) => Number(x) !== Number(sat)),
    label: 'mint commit',
  });
  const commitId = txid(commit);

  // 4. Reveal transaction (script path spends the commit leaf).
  const reveal = makeTx({
    inputs: [{
      txid: reverseBytes(hexToBytes(commitId)),
      vout: 0,
      sequence: 0xffffffff,
      scriptSig: new Uint8Array(),
      witness: [],
    }],
    outputs: [
      output(1000n, p2trScript(owner)),
      output(0n, opReturnScript(mintEnvelope(seed, name))),
      output(0n, change.script),
    ],
  });
  const revealPrevouts = [{ value: commitValue, script: commitScript }];
  const revealFinal = finalize({
    tx: reveal,
    inputs: [{ value: commitValue }],
    inputTypes: [{
      type: 'tapscript', scriptLen: leaf.length, controlLen: commitControl.length,
    }],
    changeIndex: 2,
    rate: revealRate,
    sign: (tx) => signTapscript(tx, 0, ord.ownerPrivate, leaf, commitControl, revealPrevouts),
  });
  proveAssignment({
    inputs: [{
      txid: commitId, vout: 0, value: commitValue, exact: true,
      ranges: commitProof.outputs[0],
    }],
    outputValues: revealFinal.tx.outputs.map((o) => Number(o.value)),
    sat,
    outputIndex: 0,
    label: 'mint reveal',
  });
  const revealId = txid(revealFinal.tx);
  const commitVsize = vsize(commit);
  const revealVsize = vsize(revealFinal.tx);
  const commitChange = commit.outputs[1] || null;
  const revealChange = revealFinal.tx.outputs[2] || null;
  const sanitizedInputs = inputs.map((u) => ({
    txid: String(u.txid).toLowerCase(),
    vout: Number(u.vout),
    value: Number(u.value),
    script: bytesToHex(u.script),
    kind: u.kind,
    ranges: Array.isArray(u.ranges)
      ? u.ranges.map(([a, b]) => [Number(a), Number(b)]) : null,
  }));

  return {
    sat,
    seed,
    name,
    commit: {
      tx: commit,
      hex: bytesToHex(serializeTx(commit, true)),
      txid: commitId,
      fee: commitFinal.fee,
      vsize: commitVsize,
      changeAddress: commitChange ? change.address : null,
      changeValue: commitChange ? commitChange.value : 0n,
    },
    reveal: {
      tx: revealFinal.tx,
      hex: bytesToHex(serializeTx(revealFinal.tx, true)),
      txid: revealId,
      inscriptionId: `${revealId}i0`,
      bodyDigest: bytesToHex(sha256(body)),
      contentType: chosen.contentType,
      body,
      tapscript: leaf,
      controlBlock: commitControl,
      fee: revealFinal.fee,
      vsize: revealVsize,
      changeAddress: revealChange ? change.address : null,
      changeValue: revealChange ? revealChange.value : 0n,
    },
    inputs: sanitizedInputs,
    anchor: {
      txid: String(anchor.txid).toLowerCase(),
      vout: Number(anchor.vout),
      ranges: Array.isArray(anchor.ranges)
        ? anchor.ranges.map(([a, b]) => [Number(a), Number(b)]) : null,
    },
    anchorUtxo: anchor,
    fee: commitFinal.fee + revealFinal.fee,
    vsize: commitVsize + revealVsize,
  };
}

function opReturnScript(push) {
  if (push.length > 75) throw new Error('OP_RETURN push exceeds 75 bytes');
  return concatBytes([Uint8Array.of(0x6a, push.length), push]);
}

// --- MINT refund ----------------------------------------------------------

/** Spend the commit output back to the wallet by its key path, without
 *  revealing the mint leaf. This is the documented recovery for a commit
 *  whose reveal was rejected or cannot be replayed. */
export function buildMintRefund({
  keys, commit, recipientScript, feeRate = 2,
}) {
  if (!keys?.ordNode?.privateKey) throw new Error('mint refund needs the ordinals key');
  const commitTxid = String(commit.txid || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(commitTxid)) throw new Error('mint refund needs the commit txid');
  const value = BigInt(commit.value);
  if (value <= 0n) throw new Error('mint refund commit has no value');
  const script = commit.script;
  const leaf = commit.leaf;
  if (!script || !leaf) throw new Error('mint refund needs the commit script and leaf');
  const rate = Math.max(FEE_FLOOR, feeRate);
  const tweaked = taprootTweakedKey(keys.ord.ownerPrivate, leafHash(leaf));
  const tx = makeTx({
    inputs: [{
      txid: reverseBytes(hexToBytes(commitTxid)), vout: Number(commit.vout || 0),
      sequence: 0xffffffff, scriptSig: new Uint8Array(), witness: [],
    }],
    outputs: [output(0n, recipientScript)],
  });
  const fee = feeFor(estimateVsize(tx, [{ type: 'p2tr-key' }]), rate);
  if (value <= fee) throw new Error('mint refund commit is too small to pay its own fee');
  tx.outputs[0].value = value - fee;
  signTaprootKeyPath(tx, 0, tweaked.outputPrivate, [{ value, script }]);
  return {
    tx,
    hex: bytesToHex(serializeTx(tx, true)),
    txid: txid(tx),
    fee,
    vsize: vsize(tx),
    valueToRecipient: tx.outputs[0].value,
    outputs: tx.outputs.map((o) => ({ value: o.value, script: o.script })),
    inputs: [{ txid: commitTxid, vout: Number(commit.vout || 0), value: Number(value), script }],
  };
}

// --- PREPARE --------------------------------------------------------------

// Move a frog from its mint/ordinary output into a fresh state output.
export function buildPrepare({
  keys, utxo, frog, funding = [], feeRate = 2, changeIndex = 0, ownerXonly = null,
  legacy = false, protectedSats = [],
}) {
  const ord = keys.ord;
  const owner = ownerXonly || ord.ownerXonly;
  const state = stateScripts(frog, owner, { legacy });
  const change = keys.change(changeIndex);
  const rate = Math.max(FEE_FLOOR, feeRate);
  const isKeyPath = utxo.kind === 'p2tr' || utxo.kind === 'frog';
  const inputType = isKeyPath ? 'p2tr-key' : 'p2wpkh';

  // Fund the card plus a fee buffer.
  let picked = [];
  const missing = CARD_VALUE - BigInt(utxo.value) + 4000n;
  if (missing > 0) picked = selectFunding(funding, missing, [`${utxo.txid}:${utxo.vout}`]);
  const inputs = [utxo, ...picked];
  const totalIn = inputs.reduce((a, u) => a + BigInt(u.value), 0n);
  if (totalIn < CARD_VALUE) throw new Error('not enough sats to fund the frog card');

  const tx = makeTx({
    inputs: inputs.map((u) => inputFromUtxo(u)),
    outputs: [output(CARD_VALUE, state.script), output(0n, change.script)],
  });
  const types = inputs.map((u, i) => (i === 0 ? { type: inputType } : { type: 'p2wpkh' }));
  const prevouts = inputs.map((u, i) => ({
    value: BigInt(u.value),
    script: i === 0 ? utxo.script : u.script,
  }));

  const final = finalize({
    tx,
    inputs,
    inputTypes: types,
    changeIndex: 1,
    rate,
    sign: (t) => {
      if (isKeyPath) signTaprootKeyPath(t, 0, ord.ownerPrivate, prevouts);
      else signP2wpkh(t, 0, utxo.key.privateKey, utxo.key.publicKey, utxo.value);
      picked.forEach((u, i) => signP2wpkh(t, i + 1, u.key.privateKey, u.key.publicKey, u.value));
    },
  });

  assertAnchorFirst(utxo, frog.sat, 'prepare');
  proveAssignment({
    inputs,
    outputValues: final.tx.outputs.map((o) => Number(o.value)),
    sat: frog.sat,
    outputIndex: 0,
    protectedSats,
    label: 'prepare',
  });

  return {
    tx: final.tx,
    hex: bytesToHex(serializeTx(final.tx, true)),
    txid: txid(final.tx),
    stateScript: state.script,
    stateValue: CARD_VALUE,
    fee: final.fee,
  };
}

// --- CROSS ----------------------------------------------------------------

export function buildCross({
  keys, stateUtxo, frog, funding = [], feeRate = 2, changeIndex = 0,
  newOwnerXonly = null, ownerXonly = null, dir = 0, legacy = false,
  protectedSats = [],
}) {
  if (!Number.isInteger(dir) || dir < 0 || dir > 2) {
    throw new Error('dir must be 0 (left), 1 (straight) or 2 (right)');
  }
  const ord = keys.ord;
  const owner = ownerXonly || ord.ownerXonly;
  const nextOwner = newOwnerXonly || owner;
  const rate = Math.max(FEE_FLOOR, feeRate);
  const state = stateScripts(frog, owner, { legacy });
  const next = stateScripts(frog, nextOwner, { legacy });
  const change = keys.change(changeIndex);

  const picked = selectFunding(funding, 4000n, [`${stateUtxo.txid}:${stateUtxo.vout}`]);
  const inputs = [stateUtxo, ...picked];
  const totalIn = inputs.reduce((a, u) => a + BigInt(u.value), 0n);

  const tx = makeTx({
    inputs: inputs.map((u) => inputFromUtxo(u)),
    outputs: [output(CARD_VALUE, next.script), output(0n, change.script)],
  });
  const types = inputs.map((u, i) => (i === 0
    ? {
      type: 'tapscript',
      scriptLen: state.crossLeaves[dir].length,
      controlLen: state.crossControls[dir].length,
    }
    : { type: 'p2wpkh' }));
  const prevouts = inputs.map((u) => ({ value: BigInt(u.value), script: u.script }));

  const final = finalize({
    tx,
    inputs,
    inputTypes: types,
    changeIndex: 1,
    rate,
    sign: (t) => {
      signTapscript(t, 0, ord.ownerPrivate, state.crossLeaves[dir], state.crossControls[dir], prevouts);
      picked.forEach((u, i) => signP2wpkh(t, i + 1, u.key.privateKey, u.key.publicKey, u.value));
    },
  });

  assertAnchorFirst(stateUtxo, frog.sat, 'hop');
  proveAssignment({
    inputs,
    outputValues: final.tx.outputs.map((o) => Number(o.value)),
    sat: frog.sat,
    outputIndex: 0,
    protectedSats,
    label: 'hop',
  });

  return {
    tx: final.tx,
    hex: bytesToHex(serializeTx(final.tx, true)),
    txid: txid(final.tx),
    stateScript: next.script,
    inputs: inputs.map((u) => ({
      txid: u.txid, vout: Number(u.vout), value: u.value, script: u.script,
    })),
    changeIndex: 1,
    vsize: estimateVsize(final.tx, actualTypes(final.tx, types)),
    dir,
    fee: final.fee,
  };
}

// --- TRANSFER -------------------------------------------------------------

// Move a coin (state output, mint output, or ordinary coin) to a recipient
// address. No inscription, no state change: the fold cannot see it.
export function buildTransfer({
  keys, utxo, frog = null, recipientScript, feeRate = 2, legacy = false,
  protectedSats = [],
}) {
  const ord = keys.ord;
  const rate = Math.max(FEE_FLOOR, feeRate);
  const kind = utxo.kind || (frog ? 'state' : 'p2wpkh');
  const state = kind === 'state' ? stateScripts(frog, ord.ownerXonly, { legacy }) : null;
  const script = kind === 'state' ? state.sendLeaf : null;

  const tx = makeTx({
    inputs: [inputFromUtxo(utxo)],
    outputs: [output(0n, recipientScript)],
  });
  const type = kind === 'state'
    ? { type: 'tapscript', scriptLen: script.length, controlLen: state.sendControl.length }
    : kind === 'p2wpkh' ? { type: 'p2wpkh' } : { type: 'p2tr-key' };

  const total = BigInt(utxo.value);
  const fee = feeFor(estimateVsize(tx, [type]), rate);
  if (total <= fee) throw new Error('coin too small to pay its own fee');
  tx.outputs[0].value = total - fee;

  if (kind === 'state') {
    signTapscript(tx, 0, ord.ownerPrivate, script, state.sendControl, [{
      value: total, script: utxo.script,
    }]);
  } else if (kind === 'p2tr' || kind === 'frog') {
    signTaprootKeyPath(tx, 0, ord.ownerPrivate, [{ value: total, script: utxo.script }]);
  } else {
    signP2wpkh(tx, 0, utxo.key.privateKey, utxo.key.publicKey, utxo.value);
  }

  if (frog && Number.isSafeInteger(Number(frog.sat))) {
    assertAnchorFirst(utxo, frog.sat, 'transfer');
    proveAssignment({
      inputs: [utxo],
      outputValues: tx.outputs.map((o) => Number(o.value)),
      sat: frog.sat,
      outputIndex: 0,
      protectedSats,
      label: 'transfer',
    });
  }

  return {
    tx,
    hex: bytesToHex(serializeTx(tx, true)),
    txid: txid(tx),
    fee,
    vsize: vsize(tx),
    valueToRecipient: tx.outputs[0].value,
    // Public metadata for a pre-broadcast preview/revalidation. Never expose
    // the private key held by coin selection.
    inputs: [{ txid: utxo.txid, vout: utxo.vout, value: utxo.value, script: utxo.script }],
  };
}

// --- ordinary send (never touches a frog) ---------------------------------

export function buildSend({
  keys, utxos, recipientScript, amount, feeRate = 2, changeIndex = 0,
  allowUnconfirmed = false, protectedSats = [],
}) {
  if (!Number.isSafeInteger(Number(amount)) || Number(amount) < 546) {
    throw new Error('send amount must be at least 546 sats');
  }
  const change = keys.change(changeIndex);
  const rate = Math.max(FEE_FLOOR, feeRate);
  const target = BigInt(amount) + 2000n;
  const picked = selectFunding(utxos, target, [], { allowUnconfirmed });
  const totalIn = picked.reduce((a, u) => a + BigInt(u.value), 0n);
  if (totalIn < BigInt(amount)) throw new Error('insufficient funds');

  const tx = makeTx({
    // A plain send is the one wallet transaction that opts into BIP125 RBF.
    // It never carries a frog; the bump builder keeps every output here and
    // adds funding instead of reducing change. Game actions stay 0xffffffff.
    inputs: picked.map((u) => inputFromUtxo(u, RBF_SEQUENCE)),
    outputs: [output(BigInt(amount), recipientScript), output(0n, change.script)],
  });
  const final = finalize({
    tx,
    inputs: picked,
    inputTypes: picked.map(() => ({ type: 'p2wpkh' })),
    changeIndex: 1,
    rate,
    sign: (t) => picked.forEach((u, i) => signP2wpkh(t, i, u.key.privateKey, u.key.publicKey, u.value)),
  });
  // F-01/F-02: prove the final signed bytes never pay a known Hopper sat
  // to a recipient, change, or the fee. This is the last line of defence
  // after discovery and coin selection.
  proveAssignment({
    inputs: picked,
    outputValues: final.tx.outputs.map((o) => Number(o.value)),
    protectedSats,
    label: 'send',
  });
  return {
    tx: final.tx,
    hex: bytesToHex(serializeTx(final.tx, true)),
    txid: txid(final.tx),
    fee: final.fee,
    vsize: vsize(final.tx),
    changeIndex: final.tx.outputs.length > 1 ? 1 : null,
    // Public funding metadata for the RBF envelope. Never return the
    // private key objects that coin selection happens to hold.
    inputs: picked.map(({ key, ...rest }) => rest),
  };
}

/** Sweep every eligible plain-BTC coin into one recipient output. There is
 *  no change: the recipient gets the sum of the inputs minus the actual fee.
 *  Hopper/state outputs and every protected sat are excluded by the same
 *  fail-closed funding predicate as a normal SEND. */
export function buildSendAll({
  utxos, recipientScript, feeRate = 2, allowUnconfirmed = false, protectedSats = [],
}) {
  const rate = Math.max(FEE_FLOOR, feeRate);
  const picked = utxos
    .filter((u) => isFundingUtxo(u, { allowUnconfirmed }))
    .sort((a, b) => b.value - a.value);
  if (!picked.length) throw new Error('no spendable plain BTC to send');
  const totalIn = picked.reduce((a, u) => a + BigInt(u.value), 0n);
  const tx = makeTx({
    inputs: picked.map((u) => inputFromUtxo(u, RBF_SEQUENCE)),
    // `finalize` treats output 0 as its change target, so it computes the
    // recipient amount as totalIn - fee. The recipient's script never changes.
    outputs: [output(0n, recipientScript)],
  });
  const final = finalize({
    tx,
    inputs: picked,
    inputTypes: picked.map(() => ({ type: 'p2wpkh' })),
    changeIndex: 0,
    rate,
    sign: (t) => picked.forEach((u, i) => signP2wpkh(t, i, u.key.privateKey, u.key.publicKey, u.value)),
  });
  if (final.tx.outputs.length !== 1) {
    throw new Error('the fee would consume the entire balance');
  }
  const amount = final.tx.outputs[0].value;
  if (amount < DUST_P2WPKH) {
    throw new Error(`the fee leaves only ${amount} sats, below the ${DUST_P2WPKH}-sat dust limit`);
  }
  proveAssignment({
    inputs: picked,
    outputValues: final.tx.outputs.map((o) => Number(o.value)),
    protectedSats,
    label: 'send all',
  });
  return {
    tx: final.tx,
    hex: bytesToHex(serializeTx(final.tx, true)),
    txid: txid(final.tx),
    fee: final.fee,
    vsize: vsize(final.tx),
    totalIn,
    valueToRecipient: amount,
    changeIndex: null,
    // Public funding metadata for the RBF envelope. Never return the
    // private key objects that coin selection happens to hold.
    inputs: picked.map(({ key, ...rest }) => rest),
  };
}
