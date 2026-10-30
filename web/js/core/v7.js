// v7 state body, parent tag, and the four state-output leaves.
// Mirrors rust/crates/hopper-core/src/v7.rs.

import {
  concatBytes, readU32LE, readU64LE, reverseBytes, u32le, u64le, utf8,
} from './hex.js';
import { buildInscriptionScript } from './inscription.js';
import { NUMS_XONLY, STATE_CONTENT_TYPE, STATE_MAGIC, WIRE_VERSION } from './params.js';

export const STATE_BODY_LEN = 55;

export function encodeStateBody({ sat, mintTxid, mintIndex, dir = 0 }) {
  if (!(mintTxid instanceof Uint8Array) || mintTxid.length !== 32) {
    throw new Error('mintTxid must be 32 bytes (internal order)');
  }
  if (!Number.isInteger(dir) || dir < 0 || dir > 2) {
    throw new Error('dir must be 0 (left), 1 (straight) or 2 (right)');
  }
  const out = new Uint8Array(STATE_BODY_LEN);
  out.set(utf8(STATE_MAGIC), 0);
  out[9] = WIRE_VERSION;
  out.set(u64le(sat), 10);
  out.set(mintTxid, 18);
  out.set(u32le(mintIndex), 50);
  out[54] = dir;
  return out;
}

export function decodeStateBody(bytes) {
  if (bytes.length !== STATE_BODY_LEN) throw new Error('state body must be 55 bytes');
  if (new TextDecoder().decode(bytes.subarray(0, 9)) !== STATE_MAGIC) {
    throw new Error('state body magic is FRG7CROSS');
  }
  if (bytes[9] !== WIRE_VERSION) throw new Error('state body version must be 0x07');
  const dir = bytes[54];
  if (dir > 2) throw new Error('state body direction must be 0, 1 or 2');
  return {
    sat: Number(readU64LE(bytes, 10)),
    mintTxid: bytes.slice(18, 50),
    mintIndex: readU32LE(bytes, 50),
    dir,
  };
}

// ord tag-3 value: bare 32-byte txid for index 0, otherwise txid||u32LE.
export function encodeParentTag(mintTxid, mintIndex = 0) {
  // ord's rule: the index is minimal little-endian (SPEC §2.2).
  const index = u32le(mintIndex);
  let n = 4;
  while (n > 0 && index[n - 1] === 0) n -= 1;
  return concatBytes([mintTxid, index.slice(0, n)]);
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

// One crossing leaf: <owner> OP_CHECKSIGVERIFY OP_FALSE OP_IF <ord
// envelope> OP_ENDIF OP_TRUE. The body's last byte is the direction.
export function crossLeafScript(ownerXonly, body, dir = body.dir ?? 0) {
  if (ownerXonly.length !== 32) throw new Error('owner must be 32 bytes');
  const envelope = buildInscriptionScript(
    STATE_CONTENT_TYPE,
    encodeStateBody({ ...body, dir }),
    [encodeParentTag(body.mintTxid, body.mintIndex)],
  );
  return concatBytes([
    Uint8Array.of(0x20), ownerXonly, Uint8Array.of(0xad),
    envelope,
    Uint8Array.of(0x51),
  ]);
}

// Convenience: the leaf for an explicit direction (overrides body.dir).
export function stateLeafScript(ownerXonly, body, dir = body.dir ?? 0) {
  return crossLeafScript(ownerXonly, body, dir);
}

// The send leaf: <owner> OP_CHECKSIG
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
export const DIR = Object.freeze({ LEFT: 0, STRAIGHT: 1, RIGHT: 2 });
export const DIR_NAMES = Object.freeze(['LEFT', 'STRAIGHT', 'RIGHT']);
