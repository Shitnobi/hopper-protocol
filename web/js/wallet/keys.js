// BIP39/BIP32/BIP84/BIP86 key material for HOPPER.
//
//   m/84'/coin'/0'/0/i   receive (P2WPKH)
//   m/84'/coin'/0'/1/i   change  (P2WPKH)
//   m/84'/coin'/0'/2/0   ordinals/frog key (BIP86 P2TR)
//
// The ordinals key is the mint commit owner, the state-leaf owner, and the
// key that signs crossings. Its BIP86 *output* key is the frog address and
// the x-only key embedded in every script (`owner_xonly`, SPEC §3.1).

import {
  HDKey, english, generateMnemonic, mnemonicToSeedSync, secp256k1, schnorr, validateMnemonic,
} from '../vendor/bitcoin-lib.js';
import { concatBytes, sha256, utf8 } from '../core/hex.js';
import {
  hash160, p2trAddress, p2wpkhAddress, p2wpkhScriptFromHash,
} from './addresses.js';

export const COIN_TYPES = { mainnet: 0, testnet: 1, signet: 1, regtest: 1 };

export function newMnemonic(words = 12) {
  return generateMnemonic(english, words === 24 ? 256 : 128);
}

export function isValidMnemonic(mnemonic) {
  try {
    return validateMnemonic(mnemonic.trim().toLowerCase().replace(/\s+/g, ' '), english);
  } catch {
    return false;
  }
}

const N = secp256k1.CURVE.n;
const mod = (a, m = N) => ((a % m) + m) % m;

export const tagged = (tag, ...msgs) => Uint8Array.from(schnorr.utils.taggedHash(tag, ...msgs));

export function bytesToNumber(bytes) {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

export function numberTo32(n) {
  let x = mod(n);
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { out[i] = Number(x & 255n); x >>= 8n; }
  return out;
}

export function bytesCompare(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

export function tapTweakHash(xonly, merkleRoot = null) {
  return tagged('TapTweak', merkleRoot ? concatBytes([xonly, merkleRoot]) : xonly);
}

// Legacy derivation used by released HOPPER wallets. It tweaks the raw
// private point without BIP341/86's even-Y normalization. Kept only so a
// recovery scan can find old outputs; never use it for new addresses.
export function taprootTweakedKeyLegacy(privateKey, merkleRoot = null) {
  const priv = bytesToNumber(privateKey);
  const P = secp256k1.ProjectivePoint.fromPrivateKey(privateKey);
  const xonly = Uint8Array.from(P.toRawBytes(true).slice(1, 33));
  const t = bytesToNumber(tapTweakHash(xonly, merkleRoot));
  const Q = P.add(secp256k1.ProjectivePoint.BASE.multiply(t));
  return {
    internalXonly: xonly,
    internalPrivate: Uint8Array.from(privateKey),
    outputXonly: Uint8Array.from(Q.toRawBytes(true).slice(1, 33)),
    // For BIP340, sign with the scalar for the even-Y lift of Q.
    outputPrivate: numberTo32(Q.hasEvenY() ? priv + t : -(priv + t)),
    parity: Q.hasEvenY() ? 0 : 1,
    tweak: t,
    legacy: true,
  };
}

// BIP86: normalize the internal point to even Y before tweaking.
// Q = P_even + H_TapTweak(P_even)*G. Returns the output key and the secret
// that signs for the even-Y lift of Q (the key BIP340 verification uses).
export function taprootTweakedKey(privateKey, merkleRoot = null) {
  const priv = bytesToNumber(privateKey);
  const raw = secp256k1.ProjectivePoint.fromPrivateKey(privateKey);
  const scalar = raw.hasEvenY() ? priv : mod(-priv);
  const P = raw.hasEvenY() ? raw : raw.negate();
  const xonly = Uint8Array.from(P.toRawBytes(true).slice(1, 33));
  const t = bytesToNumber(tapTweakHash(xonly, merkleRoot));
  const Q = P.add(secp256k1.ProjectivePoint.BASE.multiply(t));
  const q = mod(scalar + t);
  return {
    internalXonly: xonly,
    internalPrivate: numberTo32(scalar),
    outputXonly: Uint8Array.from(Q.toRawBytes(true).slice(1, 33)),
    outputPrivate: numberTo32(Q.hasEvenY() ? q : -q),
    parity: Q.hasEvenY() ? 0 : 1,
    tweak: t,
    legacy: false,
  };
}

// Output key for an arbitrary internal x-only key (the state output uses
// NUMS as its internal key and can never be spent by a key path).
export function taprootOutputKey(internalXonly, merkleRoot = null) {
  const P = secp256k1.ProjectivePoint.fromHex(concatBytes([Uint8Array.of(0x02), internalXonly]));
  const t = bytesToNumber(tapTweakHash(internalXonly, merkleRoot));
  const Q = P.add(secp256k1.ProjectivePoint.BASE.multiply(t));
  return { outputXonly: Uint8Array.from(Q.toRawBytes(true).slice(1, 33)), parity: Q.hasEvenY() ? 0 : 1 };
}

export function compactSize(n) {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 255, (n >> 8) & 255);
  const out = new Uint8Array(5);
  out[0] = 0xfe;
  for (let i = 0; i < 4; i++) out[i + 1] = (n >>> (8 * i)) & 255;
  return out;
}

export function leafHash(script, leafVersion = 0xc0) {
  return tagged('TapLeaf', Uint8Array.of(leafVersion), compactSize(script.length), script);
}

export function branchHash(a, b) {
  const [x, y] = bytesCompare(a, b) <= 0 ? [a, b] : [b, a];
  return tagged('TapBranch', x, y);
}

export function controlBlock(internalXonly, merklePath, parity) {
  return concatBytes([Uint8Array.of(0xc0 | (parity & 1)), internalXonly, ...merklePath]);
}

// Derive the wallet's key set from a mnemonic.
export function deriveWallet(mnemonic, network = 'regtest') {
  const seed = mnemonicToSeedSync(mnemonic);
  const root = HDKey.fromMasterSeed(seed);
  const coin = COIN_TYPES[network] ?? 1;

  const account = `m/84'/${coin}'/0'`;
  const ordPath = `${account}/2/0`;
  const ordNode = root.derive(ordPath);
  const ord = taprootTweakedKey(ordNode.privateKey);
  ord.ownerXonly = ord.outputXonly;
  ord.ownerPrivate = ord.outputPrivate;
  // F-03: keep the released derivation for recovery scans. New outputs
  // always use `ord` (BIP86 even-Y); `legacyOrd` is only for finding and
  // explicitly migrating old coins.
  const legacyOrd = taprootTweakedKeyLegacy(ordNode.privateKey);
  legacyOrd.ownerXonly = legacyOrd.outputXonly;
  legacyOrd.ownerPrivate = legacyOrd.outputPrivate;

  return {
    network,
    coinType: coin,
    fingerprint: root.fingerprint,
    account,
    ordPath,
    root,
    ordNode,
    ord,
    legacyOrd,
    receive(index = 0) {
      return keyInfo(root.derive(`${account}/0/${index}`), 'receive', index, network);
    },
    change(index = 0) {
      return keyInfo(root.derive(`${account}/1/${index}`), 'change', index, network);
    },
    frogAddress() {
      return p2trAddress(ord.outputXonly, network);
    },
    legacyFrogAddress() {
      return p2trAddress(legacyOrd.outputXonly, network);
    },
    ordInfo() {
      return {
        path: ordPath,
        address: p2trAddress(ord.outputXonly, network),
        internalXonly: ord.internalXonly,
        ownerXonly: ord.outputXonly,
        privateKey: ord.internalPrivate,
        ownerPrivate: ord.outputPrivate,
        parity: ord.parity,
        legacyAddress: p2trAddress(legacyOrd.outputXonly, network),
        legacyOwnerXonly: legacyOrd.outputXonly,
        legacyOwnerPrivate: legacyOrd.outputPrivate,
        legacyParity: legacyOrd.parity,
      };
    },
  };
}

function keyInfo(node, branch, index, network) {
  const publicKey = Uint8Array.from(node.publicKey);
  return {
    branch,
    index,
    path: node.derivationPath,
    privateKey: Uint8Array.from(node.privateKey),
    publicKey,
    xonly: publicKey.slice(1, 33),
    address: p2wpkhAddress(publicKey, network),
    script: p2wpkhScriptFromHash(hash160(publicKey)),
  };
}

// Deterministic identity for a seed (used by the mock chain's NPC frogs).
export function seedFromString(text) {
  const h = sha256(utf8(String(text)));
  return ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
}
