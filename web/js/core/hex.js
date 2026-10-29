// Byte/hex/utf8/base64 helpers shared by every HOPPER module.
// No dependencies on the DOM: this file also runs under Node for tests.

import { sha256 as nobleSha256 } from '../vendor/bitcoin-lib.js';

const HEX = '0123456789abcdef';

export function bytesToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
  return out;
}

export function hexToBytes(hex) {
  const s = String(hex).trim().toLowerCase().replace(/^0x/, '');
  if (s.length % 2 !== 0) throw new Error(`hex: odd length (${s.length})`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) throw new Error(`hex: bad byte at ${i * 2}`);
    out[i] = b;
  }
  return out;
}

export function reverseBytes(bytes) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[bytes.length - 1 - i];
  return out;
}

export function concatBytes(list) {
  let len = 0;
  for (const b of list) len += b.length;
  const out = new Uint8Array(len);
  let at = 0;
  for (const b of list) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

export const utf8 = (s) => new TextEncoder().encode(s);
export const fromUtf8 = (b) => new TextDecoder().decode(b);

export function u16le(n) {
  const out = new Uint8Array(2);
  out[0] = n & 255;
  out[1] = (n >>> 8) & 255;
  return out;
}

export function u32le(n) {
  const out = new Uint8Array(4);
  let v = Number(n) >>> 0;
  for (let i = 0; i < 4; i++) {
    out[i] = v & 255;
    v >>>= 8;
  }
  return out;
}

export function u64le(n) {
  const v = BigInt(n);
  const out = new Uint8Array(8);
  let x = BigInt.asUintN(64, v);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(x & 255n);
    x >>= 8n;
  }
  return out;
}

export function readU32LE(bytes, off = 0) {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
}

export function readU64LE(bytes, off = 0) {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[off + i]);
  return v;
}

export function equalBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function sha256(bytes) {
  return Uint8Array.from(nobleSha256(bytes));
}

export function sha256d(bytes) {
  return sha256(sha256(bytes));
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(input) {
  let out = '';
  for (let at = 0; at < input.length; at += 3) {
    const n = input[at] << 16 | (input[at + 1] ?? 0) << 8 | (input[at + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += at + 1 < input.length ? B64[(n >> 6) & 63] : '=';
    out += at + 2 < input.length ? B64[n & 63] : '=';
  }
  return out;
}

export function base64ToBytes(text) {
  const clean = String(text).replace(/[^A-Za-z0-9+/=]/g, '');
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((clean.length / 4) * 3 - pad);
  let at = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12) |
      ((B64.indexOf(clean[i + 2]) & 63) << 6) | (B64.indexOf(clean[i + 3]) & 63);
    out[at++] = (n >> 16) & 255;
    if (at < out.length) out[at++] = (n >> 8) & 255;
    if (at < out.length) out[at++] = n & 255;
  }
  return out;
}

// Display-order txids: Bitcoin prints hashes in reverse byte order.
export function displayTxid(internalBytes) {
  return bytesToHex(reverseBytes(internalBytes));
}

export function internalTxid(displayHex) {
  return reverseBytes(hexToBytes(displayHex));
}

export function bigintHex(v, pad = 0) {
  let s = BigInt(v).toString(16);
  while (s.length < pad) s = '0' + s;
  return s;
}
