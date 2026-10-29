// Address encoding/decoding and scriptPubKey construction.
// Mainnet = bc, testnet/signet = tb, regtest = bcrt.

import { bech32, bech32m, ripemd160 } from '../vendor/bitcoin-lib.js';
import { concatBytes, sha256 } from '../core/hex.js';

export const PREFIX = { mainnet: 'bc', testnet: 'tb', signet: 'tb', regtest: 'bcrt' };

export function uprefix(network) {
  return PREFIX[network] || 'bcrt';
}

export function hash160(bytes) {
  return Uint8Array.from(ripemd160(sha256(bytes)));
}

export function p2wpkhAddress(publicKey, network = 'regtest') {
  const program = hash160(publicKey);
  return bech32.encode(uprefix(network), [0, ...bech32.toWords(program)]);
}

export function p2trAddress(outputXonly, network = 'regtest') {
  return bech32m.encode(uprefix(network), [1, ...bech32m.toWords(outputXonly)]);
}

export function p2wpkhScriptFromHash(hash) {
  return concatBytes([Uint8Array.of(0x00, 0x14), hash]);
}

export function p2trScript(key) {
  return concatBytes([Uint8Array.of(0x51, 0x20), key]);
}

export function p2wpkhScript(publicKey) {
  return p2wpkhScriptFromHash(hash160(publicKey));
}

// Decode any supported address into { type, program, script }.
export function decodeAddress(address, network = 'regtest') {
  const prefix = uprefix(network);
  let decoded = null;
  let encoding = 'bech32';
  try { decoded = bech32m.decode(address, 90); encoding = 'bech32m'; }
  catch { decoded = bech32.decode(address, 90); }
  if (decoded.prefix !== prefix) {
    throw new Error(`address is for ${decoded.prefix}, wallet is ${prefix}`);
  }
  const version = decoded.words[0];
  const program = Uint8Array.from(bech32.fromWords(decoded.words.slice(1)));
  if (version === 0 && program.length === 20) {
    return { type: 'p2wpkh', program, script: p2wpkhScriptFromHash(program), encoding };
  }
  if (version === 0 && program.length === 32) {
    return { type: 'p2wsh', program, script: concatBytes([Uint8Array.of(0x00, 0x20), program]), encoding };
  }
  if (version === 1 && program.length === 32 && encoding === 'bech32m') {
    return { type: 'p2tr', program, script: p2trScript(program), encoding };
  }
  throw new Error(`unsupported address version/length (v${version}, ${program.length} bytes)`);
}

export function scriptToAddress(script, network = 'regtest') {
  if (script.length === 22 && script[0] === 0x00 && script[1] === 0x14) {
    return p2wpkhAddressFromHash(script.slice(2), network);
  }
  if (script.length === 34 && script[0] === 0x51 && script[1] === 0x20) {
    return p2trAddress(script.slice(2), network);
  }
  return null;
}

function p2wpkhAddressFromHash(hash, network) {
  return bech32.encode(uprefix(network), [0, ...bech32.toWords(hash)]);
}

export function isP2TR(address, network) {
  try { return decodeAddress(address, network).type === 'p2tr'; } catch { return false; }
}
