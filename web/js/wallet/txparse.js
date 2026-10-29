// Minimal Bitcoin transaction deserializer (segwit + taproot witnesses).
// Used by the mock chain and by wallet history rendering.

import { bytesToHex, concatBytes, hexToBytes, reverseBytes, sha256d } from '../core/hex.js';
import { serializeTx } from './tx.js';

function readCompact(buf, pos) {
  const first = buf[pos];
  if (first < 0xfd) return [first, pos + 1];
  if (first === 0xfd) return [buf[pos + 1] | (buf[pos + 2] << 8), pos + 3];
  if (first === 0xfe) {
    return [(buf[pos + 1] | (buf[pos + 2] << 8) | (buf[pos + 3] << 16) | (buf[pos + 4] << 24)) >>> 0, pos + 5];
  }
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(buf[pos + 1 + i]);
  return [Number(v), pos + 9];
}

export function parseTx(hexOrBytes) {
  const buf = typeof hexOrBytes === 'string' ? hexToBytes(hexOrBytes) : hexOrBytes;
  let pos = 0;
  const u32 = () => {
    const v = (buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16) | (buf[pos + 3] << 24)) >>> 0;
    pos += 4;
    return v;
  };
  const u64 = () => {
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(buf[pos + i]);
    pos += 8;
    return v;
  };
  const version = u32();
  let segwit = false;
  if (buf[pos] === 0x00 && buf[pos + 1] === 0x01) { segwit = true; pos += 2; }
  const [nIn, p1] = readCompact(buf, pos); pos = p1;
  const inputs = [];
  for (let i = 0; i < nIn; i++) {
    const txidBytes = buf.slice(pos, pos + 32);
    const txid = bytesToHex(reverseBytes(txidBytes)); pos += 32;
    const vout = u32();
    const [slen, p2] = readCompact(buf, pos); pos = p2;
    const scriptSig = buf.slice(pos, pos + slen); pos += slen;
    const sequence = u32();
    inputs.push({ txid, txidBytes, vout, scriptSig, sequence, witness: [] });
  }
  const [nOut, p3] = readCompact(buf, pos); pos = p3;
  const outputs = [];
  for (let i = 0; i < nOut; i++) {
    const value = u64();
    const [slen, p4] = readCompact(buf, pos); pos = p4;
    outputs.push({ value, script: buf.slice(pos, pos + slen) });
    pos += slen;
  }
  if (segwit) {
    for (const input of inputs) {
      const [n, p5] = readCompact(buf, pos); pos = p5;
      for (let i = 0; i < n; i++) {
        const [len, p6] = readCompact(buf, pos); pos = p6;
        input.witness.push(buf.slice(pos, pos + len));
        pos += len;
      }
    }
  }
  const locktime = u32();
  const tx = { version, locktime, inputs, outputs };
  return {
    ...tx,
    segwit,
    txid: bytesToHex(reverseBytes(sha256d(serializeTx(tx, false)))),
    hex: typeof hexOrBytes === 'string' ? hexOrBytes : bytesToHex(hexOrBytes),
  };
}

export function opReturnPush(script) {
  if (!script || script[0] !== 0x6a) return null;
  let pos = 1;
  let len = script[pos++];
  if (len === 0x4c) { len = script[pos++]; }
  else if (len === 0x4d) { len = script[pos] | (script[pos + 1] << 8); pos += 2; }
  return script.slice(pos, pos + len);
}

export function witnessTapscript(input) {
  const w = input.witness || [];
  return w.length >= 2 ? w[w.length - 2] : null;
}

export function witnessControl(input) {
  const w = input.witness || [];
  return w.length >= 1 ? w[w.length - 1] : null;
}

export { concatBytes };
