// The 12-word vault: AES-256-GCM under a PBKDF2-derived non-extractable
// WebCrypto KEK (SPEC §5.1). The KEK is cached in IndexedDB only when the
// user asks to stay unlocked; the ciphertext and salt are public metadata.

import { bytesToBase64, base64ToBytes, utf8, fromUtf8 } from '../core/hex.js';
import { idbDelete, idbGet, idbPut, KEYS, loadJson, removeKey, saveJson } from './storage.js';

const ITERATIONS = 210_000;

function subtle() {
  if (!globalThis.crypto || !crypto.subtle) throw new Error('WebCrypto is unavailable (use a secure context)');
  return crypto.subtle;
}

async function deriveKek(password, salt) {
  const s = subtle();
  const base = await s.importKey('raw', utf8(password), 'PBKDF2', false, ['deriveKey']);
  return s.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable
    ['encrypt', 'decrypt'],
  );
}

export function hasVault() {
  return !!loadJson(KEYS.vault);
}

export function vaultInfo() {
  const v = loadJson(KEYS.vault);
  if (!v) return null;
  return {
    network: v.network,
    fingerprint: v.fingerprint,
    createdAt: v.createdAt,
    words: v.words,
  };
}

export async function createVault({ mnemonic, password, network, fingerprint, remember = false }) {
  if (!password || password.length < 6) throw new Error('Use a password of at least 6 characters');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const kek = await deriveKek(password, salt);
  const payload = utf8(JSON.stringify({ mnemonic, network, fingerprint }));
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, kek, payload);
  saveJson(KEYS.vault, {
    v: 1,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(ct)),
    network,
    fingerprint,
    words: mnemonic.trim().split(/\s+/).length,
    createdAt: new Date().toISOString(),
    iterations: ITERATIONS,
  });
  if (remember) await idbPut('keys', 'kek', kek);
  return { mnemonic, network, fingerprint };
}

export async function unlockVault(password, { remember = false } = {}) {
  const v = loadJson(KEYS.vault);
  if (!v) throw new Error('No vault on this device');
  const salt = base64ToBytes(v.salt);
  let kek = await idbGet('keys', 'kek');
  let autolocked = false;
  if (!kek) kek = await deriveKek(password, salt);
  else autolocked = true;
  const iv = base64ToBytes(v.iv);
  const ct = base64ToBytes(v.ct);
  try {
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv }, kek, ct);
    const data = JSON.parse(fromUtf8(new Uint8Array(plain)));
    if (!autolocked && remember) await idbPut('keys', 'kek', kek);
    return { ...data, autolocked };
  } catch (err) {
    await idbDelete('keys', 'kek');
    throw new Error('Wrong password');
  }
}

export async function lockVault() {
  await idbDelete('keys', 'kek');
}

export function destroyVault() {
  removeKey(KEYS.vault);
  idbDelete('keys', 'kek').catch(() => {});
}
