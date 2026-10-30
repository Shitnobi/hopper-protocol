// The road's wrap (SPEC §1.2).
//
//   wrap(B) = u32LE(H(B)_internal[0..4]) mod 3
//   dead    = in_flight.dir == wrap(T + 1)
//
// There is no per-Hopper randomness: each block picks one direction and
// every Hopper that hopped that way dies. The exact integer is
// load-bearing; do not substitute a wider word or a hash of the hash.

import { hexToBytes, reverseBytes } from './hex.js';

export const DIRECTIONS = 3;
export const DIR_LEFT = 0;
export const DIR_STRAIGHT = 1;
export const DIR_RIGHT = 2;

// `blockHash` is 32 bytes in INTERNAL order.
export function wrapOfBytes(blockHash) {
  const x = (blockHash[0] | (blockHash[1] << 8) | (blockHash[2] << 16) | (blockHash[3] << 24)) >>> 0;
  return x % DIRECTIONS;
}

// The display hex ord/explorers return is reversed before the wrap.
export function wrapOfDisplayHex(displayHex) {
  return wrapOfBytes(reverseBytes(hexToBytes(displayHex)));
}

export function dies(dir, blockHashInternal) {
  return Number(dir) === wrapOfBytes(blockHashInternal);
}

export function diesDisplay(dir, displayHex) {
  return Number(dir) === wrapOfDisplayHex(displayHex);
}
