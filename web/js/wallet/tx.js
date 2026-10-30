// Bitcoin transaction serialization, segwit v0 and taproot (BIP341/342)
// sighashes, and signing. Pure: no network, no DOM.

import { secp256k1, schnorr, randomBytes, ripemd160 } from '../vendor/bitcoin-lib.js';
import {
  bytesToHex, concatBytes, reverseBytes, sha256, sha256d, u32le, u64le,
} from '../core/hex.js';
import { compactSize, leafHash as tapLeafHash, tagged } from './keys.js';

export const SIGHASH_DEFAULT = 0x00;
export const SIGHASH_ALL = 0x01;

// BIP125 opt-in: strictly below 0xfffffffe. 0xfffffffd is also
// Sequence::ENABLE_RBF_NO_LOCKTIME in rust-bitcoin, which ord uses for its
// own transactions. Only ordinary HOPPER sends use it today; the game
// transactions stay non-replaceable on purpose.
export const RBF_SEQUENCE = 0xfffffffd;

export function varint(n) {
  return compactSize(n);
}

export function serializeOutputs(outputs) {
  const parts = [varint(outputs.length)];
  for (const o of outputs) {
    parts.push(u64le(o.value), varint(o.script.length), o.script);
  }
  return concatBytes(parts);
}

// BIP-143 `hashOutputs` and BIP-341 `sha_outputs` hash the CTxOuts
// themselves, WITHOUT the compactSize output count that transaction
// serialization includes.
export function serializeOutputsForSighash(outputs) {
  return concatBytes(outputs.map((o) => concatBytes([
    u64le(o.value), varint(o.script.length), o.script,
  ])));
}

export function serializeInputs(inputs) {
  const parts = [varint(inputs.length)];
  for (const i of inputs) {
    parts.push(i.txidBytes || i.txid, u32le(i.vout), varint((i.scriptSig || new Uint8Array()).length), i.scriptSig || new Uint8Array(), u32le(i.sequence ?? 0xffffffff));
  }
  return concatBytes(parts);
}

export function serializeTx(tx, withWitness = false) {
  const hasWitness = withWitness && tx.inputs.some((i) => i.witness && i.witness.length);
  const parts = [u32le(tx.version ?? 2)];
  if (hasWitness) parts.push(Uint8Array.of(0x00, 0x01));
  parts.push(serializeInputs(tx.inputs), serializeOutputs(tx.outputs));
  if (hasWitness) {
    for (const input of tx.inputs) {
      const stack = input.witness || [];
      parts.push(varint(stack.length));
      for (const item of stack) parts.push(varint(item.length), item);
    }
  }
  parts.push(u32le(tx.locktime ?? 0));
  return concatBytes(parts);
}

export function txid(tx) {
  return bytesToHex(reverseBytes(sha256d(serializeTx(tx, false))));
}

export function wtxid(tx) {
  return bytesToHex(reverseBytes(sha256d(serializeTx(tx, true))));
}

export function vsize(tx) {
  const base = serializeTx(tx, false).length;
  const full = serializeTx(tx, true).length;
  return Math.ceil((base * 4 + (full - base)) / 4);
}

export function makeTx({ version = 2, locktime = 0, inputs = [], outputs = [] }) {
  return { version, locktime, inputs, outputs };
}

export function inputFromUtxo(utxo, sequence = 0xffffffff) {
  return {
    txid: reverseBytes(hexToBytesSafe(utxo.txid)),
    vout: utxo.vout,
    sequence,
    scriptSig: new Uint8Array(),
    witness: [],
  };
}

function hexToBytesSafe(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function output(value, script) {
  return { value: BigInt(value), script };
}

// --- BIP143 (segwit v0) ---------------------------------------------------

export function bip143Sighash(tx, index, scriptCode, amount, hashType = SIGHASH_ALL) {
  const hashPrevouts = sha256d(concatBytes(tx.inputs.map((i) => concatBytes([i.txidBytes || i.txid, u32le(i.vout)]))));
  const hashSequence = sha256d(concatBytes(tx.inputs.map((i) => u32le(i.sequence ?? 0xffffffff))));
  const hashOutputs = sha256d(serializeOutputsForSighash(tx.outputs));
  const input = tx.inputs[index];
  const preimage = concatBytes([
    u32le(tx.version ?? 2),
    hashPrevouts,
    hashSequence,
    input.txidBytes || input.txid, u32le(input.vout),
    varint(scriptCode.length), scriptCode,
    u64le(amount),
    u32le(input.sequence ?? 0xffffffff),
    hashOutputs,
    u32le(tx.locktime ?? 0),
    u32le(hashType),
  ]);
  return sha256d(preimage);
}

// Sign a P2WPKH input in place. `prevout` = {value, publicKey}.
export function signP2wpkh(tx, index, privateKey, publicKey, amount) {
  // BIP143 scriptCode is the P2WPKH script itself; bip143Sighash adds
  // the compactSize length. Do not include 0x19 here (that would make
  // the preimage claim a 26-byte script beginning with OP_PUSHBYTES_25).
  const scriptCode = concatBytes([
    Uint8Array.of(0x76, 0xa9, 0x14),
    hash160(publicKey),
    Uint8Array.of(0x88, 0xac),
  ]);
  const hash = bip143Sighash(tx, index, scriptCode, amount, SIGHASH_ALL);
  const sig = secp256k1.sign(hash, privateKey, { lowS: true });
  const der = Uint8Array.from(sig.toDERRawBytes());
  tx.inputs[index].witness = [concatBytes([der, Uint8Array.of(SIGHASH_ALL)]), publicKey];
  return tx;
}

function hash160(bytes) {
  return Uint8Array.from(ripemd160(sha256(bytes)));
}

// --- BIP341/342 (taproot) -------------------------------------------------

function sha256Concat(items) {
  return sha256(concatBytes(items));
}

// `prevouts` = [{value, script}] for EVERY input, in order.
// `opts.leafScript` present => tapscript (ext_flag 1); otherwise key path.
export function taprootSighash(tx, index, prevouts, opts = {}) {
  const hashType = opts.hashType ?? SIGHASH_ALL;
  const extFlag = opts.leafScript ? 1 : 0;
  const annex = opts.annex || null;
  const spendType = extFlag * 2 + (annex ? 1 : 0);

  const shaPrevouts = sha256Concat(tx.inputs.map((i) => concatBytes([i.txidBytes || i.txid, u32le(i.vout)])));
  const shaAmounts = sha256Concat(prevouts.map((p) => u64le(p.value)));
  const shaScripts = sha256Concat(prevouts.map((p) => concatBytes([varint(p.script.length), p.script])));
  const shaSequences = sha256Concat(tx.inputs.map((i) => u32le(i.sequence ?? 0xffffffff)));
  const shaOutputs = sha256(serializeOutputsForSighash(tx.outputs));

  const msg = [
    Uint8Array.of(hashType),
    u32le(tx.version ?? 2),
    u32le(tx.locktime ?? 0),
    shaPrevouts,
    shaAmounts,
    shaScripts,
    shaSequences,
    shaOutputs,
    Uint8Array.of(spendType),
    u32le(index),
  ];
  if (extFlag === 1) {
    msg.push(tapLeafHash(opts.leafScript));
    msg.push(Uint8Array.of(0x00)); // key_version
    msg.push(u32le(0xffffffff)); // codesep_pos: none
  }
  return tagged('TapSighash', Uint8Array.of(0x00), concatBytes(msg));
}

// Key-path spend of a taproot output whose key we control.
export function signTaprootKeyPath(tx, index, outputPrivateKey, prevouts) {
  const sighash = taprootSighash(tx, index, prevouts, { hashType: SIGHASH_ALL });
  const sig = schnorr.sign(sighash, outputPrivateKey, randomBytes(32));
  tx.inputs[index].witness = [concatBytes([sig, Uint8Array.of(SIGHASH_ALL)])];
  return tx;
}

// Script-path spend: signature by the leaf's owner key over the BIP342
// sighash of that leaf.
export function signTapscript(tx, index, ownerPrivateKey, leafScript, control, prevouts) {
  const sighash = taprootSighash(tx, index, prevouts, { hashType: SIGHASH_ALL, leafScript });
  const sig = schnorr.sign(sighash, ownerPrivateKey, randomBytes(32));
  tx.inputs[index].witness = [
    concatBytes([sig, Uint8Array.of(SIGHASH_ALL)]),
    leafScript,
    control,
  ];
  return tx;
}

export { bytesToHex, reverseBytes };
