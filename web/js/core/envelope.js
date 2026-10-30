// FRG OP_RETURN envelope: "FRG" | version 0x07 | action 0x01 | payload.
// This is the MINT message only; a crossing is a state inscription.

import { concatBytes, fromUtf8, readU32LE, u32le, utf8 } from './hex.js';
import { MAGIC, WIRE_VERSION } from './params.js';

export const ACTION_MINT = 0x01;
export const MAX_NAME_BYTES = 38;

export function mintPayload(seed, name = '') {
  const bytes = utf8(name);
  if (bytes.length > MAX_NAME_BYTES) throw new Error(`name exceeds ${MAX_NAME_BYTES} bytes`);
  return concatBytes([u32le(seed), Uint8Array.of(bytes.length), bytes]);
}

// Full envelope push (the bytes inside the OP_RETURN push).
export function mintEnvelope(seed, name = '') {
  return concatBytes([
    utf8(MAGIC), Uint8Array.of(WIRE_VERSION, ACTION_MINT), mintPayload(seed, name),
  ]);
}

// The complete OP_RETURN output script: OP_RETURN OP_PUSHBYTES_n <envelope>.
export function mintOpReturnScript(seed, name = '') {
  const env = mintEnvelope(seed, name);
  if (env.length > 75) throw new Error('envelope exceeds the 80-byte OP_RETURN budget');
  return concatBytes([Uint8Array.of(0x6a, env.length), env]);
}

export function decodeMint(push) {
  if (!push || push.length < 5) throw new Error('envelope shorter than 5 bytes');
  if (fromUtf8(push.slice(0, 3)) !== MAGIC) throw new Error('bad FRG magic');
  if (push[3] !== WIRE_VERSION) throw new Error(`unsupported version ${push[3]}`);
  if (push[4] !== ACTION_MINT) throw new Error(`unknown action ${push[4]}`);
  if (push.length < 10) throw new Error('truncated mint payload');
  const seed = readU32LE(push, 5);
  const nlen = push[9];
  if (nlen > MAX_NAME_BYTES) throw new Error('mint name too long');
  if (push.length < 10 + nlen) throw new Error('truncated mint name');
  return { seed, name: fromUtf8(push.slice(10, 10 + nlen)) };
}
