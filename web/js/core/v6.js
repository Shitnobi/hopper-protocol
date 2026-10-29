// v6 state body, parent tag, and the two state-output leaves.
// Mirrors rust/crates/hopper-core/src/v6.rs.

import {
  concatBytes, hexToBytes, readU32LE, readU64LE, reverseBytes, u32le, u64le, utf8,
} from './hex.js';
import { buildInscriptionScript } from './inscription.js';
import { NUMS_XONLY, STATE_CONTENT_TYPE, STATE_MAGIC, WIRE_VERSION } from './params.js';

export const STATE_BODY_LEN = 54;

export function encodeStateBody({ sat, mintTxid, mintIndex }) {
  if (!(mintTxid instanceof Uint8Array) || mintTxid.length !== 32) {
    throw new Error('mintTxid must be 32 bytes (internal order)');
  }
  const out = new Uint8Array(STATE_BODY_LEN);
  out.set(utf8(STATE_MAGIC), 0);
  out[9] = WIRE_VERSION;
  out.set(u64le(sat), 10);
  out.set(mintTxid, 18);
  out.set(u32le(mintIndex), 50);
  return out;
}

export function decodeStateBody(bytes) {
  if (bytes.length !== STATE_BODY_LEN) throw new Error('state body must be 54 bytes');
  if (new TextDecoder().decode(bytes.subarray(0, 9)) !== STATE_MAGIC) {
    throw new Error('state body magic is FRG6CROSS');
  }
  if (bytes[9] !== WIRE_VERSION) throw new Error('state body version must be 0x06');
  return {
    sat: Number(readU64LE(bytes, 10)),
    mintTxid: bytes.slice(18, 50),
    mintIndex: readU32LE(bytes, 50),
  };
}

// ord tag-3 value: bare 32-byte txid for index 0, otherwise txid||u32LE.
export function encodeParentTag(mintTxid, mintIndex = 0) {
  if (mintIndex === 0) return mintTxid.slice();
  return concatBytes([mintTxid, u32le(mintIndex)]);
}

export function decodeParentTag(bytes) {
  if (bytes.length < 32 || bytes.length > 36) throw new Error('parent tag must be 32..=36 bytes');
  const mintTxid = bytes.slice(0, 32);
  if (bytes.length === 32) return { mintTxid, mintIndex: 0 };
  const index = bytes.slice(32);
  if (index.length !== 4 && index[index.length - 1] === 0) {
    throw new Error('parent tag index must be minimal');
  }
  const buf = new Uint8Array(4);
  buf.set(index);
  return { mintTxid, mintIndex: readU32LE(buf, 0) };
}

export function mintIdString(mintTxidInternal, mintIndex) {
  const hex = Array.from(reverseBytes(mintTxidInternal), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex}i${mintIndex}`;
}

// Leaf 0: <owner> OP_CHECKSIGVERIFY OP_FALSE OP_IF <ord envelope> OP_ENDIF OP_TRUE
export function stateLeafScript(ownerXonly, body) {
  if (ownerXonly.length !== 32) throw new Error('owner must be 32 bytes');
  const envelope = buildInscriptionScript(
    STATE_CONTENT_TYPE,
    encodeStateBody(body),
    [encodeParentTag(body.mintTxid, body.mintIndex)],
  );
  return concatBytes([
    Uint8Array.of(0x20), ownerXonly, Uint8Array.of(0xad),
    envelope,
    Uint8Array.of(0x51),
  ]);
}

// Leaf 1: <owner> OP_CHECKSIG
export function sendLeafScript(ownerXonly) {
  if (ownerXonly.length !== 32) throw new Error('owner must be 32 bytes');
  return concatBytes([Uint8Array.of(0x20), ownerXonly, Uint8Array.of(0xac)]);
}

// The commit leaf: <owner> OP_CHECKSIG OP_FALSE OP_IF <mint envelope> OP_ENDIF
export function mintCommitLeafScript(ownerXonly, contentType, body) {
  return concatBytes([
    Uint8Array.of(0x20), ownerXonly, Uint8Array.of(0xac),
    buildInscriptionScript(contentType, body),
  ]);
}

export const NUMS = NUMS_XONLY;
