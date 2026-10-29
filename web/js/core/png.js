// Canonical deterministic PNG encoder (stored deflate, filter 0).
// Mirrors rust/crates/hopper-core/src/png.rs byte-for-byte.

import { concatBytes } from './hex.js';

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const STORED_MAX = 65535;

export function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let k = 0; k < 8; k++) {
      const mask = -(crc & 1) >>> 0;
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (~crc) >>> 0;
}

export function adler32(data) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function pushChunk(out, kind, data) {
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, data.length, false);
  const body = concatBytes([kind, data]);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(body), false);
  out.push(len, kind, data, crc);
}

function zlibStored(raw) {
  const out = [Uint8Array.of(0x78, 0x01)];
  if (raw.length === 0) out.push(Uint8Array.of(0x01, 0x00, 0x00, 0xff, 0xff));
  let at = 0;
  while (at < raw.length) {
    const block = raw.subarray(at, Math.min(raw.length, at + STORED_MAX));
    const bfinal = at + block.length >= raw.length ? 1 : 0;
    const len = block.length;
    out.push(Uint8Array.of(bfinal, len & 255, (len >> 8) & 255, (~len) & 255, ((~len) >> 8) & 255));
    out.push(block);
    at += block.length;
  }
  const adler = new Uint8Array(4);
  new DataView(adler.buffer).setUint32(0, adler32(raw), false);
  out.push(adler);
  return concatBytes(out);
}

export function encodePng(width, height, rgba) {
  const stride = width * 4;
  if (rgba.length !== stride * height) throw new Error('RGBA buffer must be w*h*4');
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const out = [];
  pushChunk(out, Uint8Array.of(0x49, 0x48, 0x44, 0x52), concatBytes([
    uint32be(width), uint32be(height), Uint8Array.of(8, 6, 0, 0, 0),
  ]));
  pushChunk(out, Uint8Array.of(0x49, 0x44, 0x41, 0x54), zlibStored(raw));
  pushChunk(out, Uint8Array.of(0x49, 0x45, 0x4e, 0x44), new Uint8Array(0));
  return concatBytes([SIGNATURE, ...out]);
}

function uint32be(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}

export function pngDataUri(rgba, width = 16, height = 16) {
  // Caller base64-encodes; kept here so the encoder is one module.
  return encodePng(width, height, rgba);
}
