// HOPPER action builders: MINT (commit+reveal), PREPARE, CROSS, TRANSFER.
//
// Every builder returns signed transactions plus the metadata the wallet
// needs to follow them. Nothing here touches the network; the caller
// broadcasts and refreshes.

import { bytesToHex, concatBytes, hexToBytes, reverseBytes, sha256 } from '../core/hex.js';
import { mintEnvelope } from '../core/envelope.js';
import { mintBody } from '../core/mintdoc.js';
import { mintCommitLeafScript, sendLeafScript, stateLeafScript } from '../core/v6.js';
import { CARD_VALUE, DUST_P2WPKH, NUMS_XONLY } from '../core/params.js';
import { p2trScript } from './addresses.js';
import { branchHash, controlBlock, leafHash, taprootOutputKey } from './keys.js';
import {
  inputFromUtxo, makeTx, output, serializeTx, signP2wpkh, signTaprootKeyPath,
  signTapscript, txid,
} from './tx.js';

export const FEE_FLOOR = 1;

// --- state output ---------------------------------------------------------

export function frogBody(frog) {
  return {
    sat: Number(frog.sat),
    mintTxid: reverseBytes(hexToBytes(frog.mint_txid)),
    mintIndex: frog.mint_index ?? 0,
  };
}

export function stateScripts(frog, ownerXonly) {
  const body = frogBody(frog);
  const cross = stateLeafScript(ownerXonly, body);
  const send = sendLeafScript(ownerXonly);
  const crossHash = leafHash(cross);
  const sendHash = leafHash(send);
  const root = branchHash(crossHash, sendHash);
  const { outputXonly, parity } = taprootOutputKey(NUMS_XONLY, root);
  return {
    script: p2trScript(outputXonly),
    outputXonly,
    crossLeaf: cross,
    sendLeaf: send,
    crossControl: controlBlock(NUMS_XONLY, [sendHash], parity),
    sendControl: controlBlock(NUMS_XONLY, [crossHash], parity),
    body,
  };
}

// --- fees -----------------------------------------------------------------

export function estimateVsize(tx, inputTypes) {
  const base = serializeTx(tx, false).length;
  let witness = 2;
  for (const type of inputTypes) {
    if (type.type === 'p2wpkh') witness += 1 + (1 + 72) + (1 + 33);
    else if (type.type === 'p2tr-key') witness += 1 + (1 + 65);
    else if (type.type === 'tapscript') witness += 1 + (1 + 65) + (1 + type.scriptLen) + (1 + 65);
    else throw new Error(`unknown input type ${type.type}`);
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
    return { type: 'tapscript', scriptLen: w && w[1] ? w[1].length : t.scriptLen };
  });
}

// --- coin selection -------------------------------------------------------

export function isFundingUtxo(u) {
  // Funding is BIP84 P2WPKH only. The frog address (P2TR) and every state
  // card are excluded here as well as in Wallet._funding(), so no ordinary
  // send, mint, TRAVEL TO ROAD or CROSS can ever select the anchor sat as a
  // fee input. There is deliberately no burn builder in this file.
  return u.kind === 'p2wpkh'
    && u.spendable !== false
    && !(u.frogs && u.frogs.length)
    && u.exact !== false;
}

export function selectFunding(utxos, target, exclude = []) {
  const skip = new Set(exclude);
  const pool = utxos
    .filter((u) => isFundingUtxo(u) && !skip.has(`${u.txid}:${u.vout}`))
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
    const { contentType, body } = mintBody(seed, sat);
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
    const revealVsize = estimateVsize(revealDraft, [{ type: 'tapscript', scriptLen: leaf.length }]);
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
    inputs: inputs.map(inputFromUtxo),
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
    inputTypes: [{ type: 'tapscript', scriptLen: leaf.length }],
    changeIndex: 2,
    rate: revealRate,
    sign: (tx) => signTapscript(tx, 0, ord.ownerPrivate, leaf, commitControl, revealPrevouts),
  });
  const revealId = txid(revealFinal.tx);

  return {
    sat,
    seed,
    name,
    commit: { tx: commit, hex: bytesToHex(serializeTx(commit, true)), txid: commitId },
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
    },
    anchorUtxo: anchor,
    fee: commitFinal.fee + revealFinal.fee,
  };
}

function opReturnScript(push) {
  if (push.length > 75) throw new Error('OP_RETURN push exceeds 75 bytes');
  return concatBytes([Uint8Array.of(0x6a, push.length), push]);
}

// --- PREPARE --------------------------------------------------------------

// Move a frog from its mint/ordinary output into a fresh state output.
export function buildPrepare({
  keys, utxo, frog, funding = [], feeRate = 2, changeIndex = 0, ownerXonly = null,
}) {
  const ord = keys.ord;
  const owner = ownerXonly || ord.ownerXonly;
  const state = stateScripts(frog, owner);
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
    inputs: inputs.map(inputFromUtxo),
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
  newOwnerXonly = null, ownerXonly = null,
}) {
  const ord = keys.ord;
  const owner = ownerXonly || ord.ownerXonly;
  const nextOwner = newOwnerXonly || owner;
  const rate = Math.max(FEE_FLOOR, feeRate);
  const state = stateScripts(frog, owner);
  const next = stateScripts(frog, nextOwner);
  const change = keys.change(changeIndex);

  const picked = selectFunding(funding, 4000n, [`${stateUtxo.txid}:${stateUtxo.vout}`]);
  const inputs = [stateUtxo, ...picked];
  const totalIn = inputs.reduce((a, u) => a + BigInt(u.value), 0n);

  const tx = makeTx({
    inputs: inputs.map(inputFromUtxo),
    outputs: [output(CARD_VALUE, next.script), output(0n, change.script)],
  });
  const types = inputs.map((u, i) => (i === 0
    ? { type: 'tapscript', scriptLen: state.crossLeaf.length }
    : { type: 'p2wpkh' }));
  const prevouts = inputs.map((u) => ({ value: BigInt(u.value), script: u.script }));

  const final = finalize({
    tx,
    inputs,
    inputTypes: types,
    changeIndex: 1,
    rate,
    sign: (t) => {
      signTapscript(t, 0, ord.ownerPrivate, state.crossLeaf, state.crossControl, prevouts);
      picked.forEach((u, i) => signP2wpkh(t, i + 1, u.key.privateKey, u.key.publicKey, u.value));
    },
  });

  return {
    tx: final.tx,
    hex: bytesToHex(serializeTx(final.tx, true)),
    txid: txid(final.tx),
    stateScript: next.script,
    fee: final.fee,
  };
}

// --- TRANSFER -------------------------------------------------------------

// Move a coin (state output, mint output, or ordinary coin) to a recipient
// address. No inscription, no state change: the fold cannot see it.
export function buildTransfer({
  keys, utxo, frog = null, recipientScript, feeRate = 2,
}) {
  const ord = keys.ord;
  const rate = Math.max(FEE_FLOOR, feeRate);
  const kind = utxo.kind || (frog ? 'state' : 'p2wpkh');
  const state = kind === 'state' ? stateScripts(frog, ord.ownerXonly) : null;
  const script = kind === 'state' ? state.sendLeaf : null;

  const tx = makeTx({
    inputs: [inputFromUtxo(utxo)],
    outputs: [output(0n, recipientScript)],
  });
  const type = kind === 'state'
    ? { type: 'tapscript', scriptLen: script.length }
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

  return {
    tx,
    hex: bytesToHex(serializeTx(tx, true)),
    txid: txid(tx),
    fee,
    valueToRecipient: tx.outputs[0].value,
  };
}

// --- ordinary send (never touches a frog) ---------------------------------

export function buildSend({
  keys, utxos, recipientScript, amount, feeRate = 2, changeIndex = 0,
}) {
  if (!Number.isSafeInteger(Number(amount)) || Number(amount) < 546) {
    throw new Error('send amount must be at least 546 sats');
  }
  const change = keys.change(changeIndex);
  const rate = Math.max(FEE_FLOOR, feeRate);
  const target = BigInt(amount) + 2000n;
  const picked = selectFunding(utxos, target);
  const totalIn = picked.reduce((a, u) => a + BigInt(u.value), 0n);
  if (totalIn < BigInt(amount)) throw new Error('insufficient funds');

  const tx = makeTx({
    inputs: picked.map(inputFromUtxo),
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
  return {
    tx: final.tx,
    hex: bytesToHex(serializeTx(final.tx, true)),
    txid: txid(final.tx),
    fee: final.fee,
  };
}
