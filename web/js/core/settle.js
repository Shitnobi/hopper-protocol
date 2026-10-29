// Settlement: SHA256("FRG3-CROSS" || u64LE(sat) || H(T+1) internal).
// x = u32LE(digest[0..4]); dead iff x*10000 < death_bps(target)*2^32.

import { concatBytes, hexToBytes, reverseBytes, sha256, u64le } from './hex.js';
import { CROSS_DOMAIN, deathBps } from './params.js';

export function crossDigest(sat, outcomeBlockHash) {
  return sha256(concatBytes([
    new TextEncoder().encode(CROSS_DOMAIN),
    u64le(sat),
    outcomeBlockHash, // 32 bytes, internal order
  ]));
}

// `outcomeBlockHash` is internal byte order (the reverse of explorer hex).
export function dies(sat, outcomeBlockHash, target) {
  const d = crossDigest(sat, outcomeBlockHash);
  const x = (d[0] | (d[1] << 8) | (d[2] << 16) | (d[3] << 24)) >>> 0;
  return BigInt(x) * 10000n < (BigInt(deathBps(target)) << 32n);
}

// Convenience for block hashes as served by explorers/ord (display hex).
export function diesDisplayHash(sat, displayHashHex, target) {
  return dies(sat, reverseBytes(hexToBytes(displayHashHex)), target);
}
