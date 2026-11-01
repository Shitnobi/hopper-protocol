// Recognise a HOPPER mint directly from the reveal transaction.
//
// A HOPPER mint is a taproot script spend whose leaf carries the canonical
// v7 HTML document, and whose output 0 pays 1,000 sats to the wallet's
// ordinals address. The committed leaf is visible in the reveal witness,
// so the wallet can identify its own mint without an indexer or ord's
// `/r/utxo` endpoint. This is a discovery fallback only: when a HOPPER
// indexer answers, its record (state, distance, crossings) is authoritative.

import { equalBytes, fromUtf8, utf8 } from '../core/hex.js';
import { rangesValue } from '../core/satmath.js';
import { decodeMint } from '../core/envelope.js';
import { parseInscriptions } from '../core/inscription.js';
import { liveV7Html, liveV8Html } from '../core/mintdoc.js';
import {
  ANCHOR_OUTPUT_VALUE, LEGACY_WIRE_VERSION, V7_CONTENT_TYPE, V8_CONTENT_TYPE,
  WIRE_VERSION, generationAt, isGrandfatheredSat,
} from '../core/params.js';
import { opReturnPush, parseTx, witnessTapscript } from './txparse.js';

export const LOCAL_MINT_SOURCE = 'ord-address-mint';

function mintEnvelopeOf(tx) {
  for (const out of tx.outputs) {
    const push = opReturnPush(out.script);
    if (!push) continue;
    try {
      return decodeMint(push);
    } catch {
      // Another OP_RETURN is not a HOPPER mint.
    }
  }
  return null;
}

/**
 * Return a minimal idle record when `utxo` is the output of a HOPPER mint
 * reveal, otherwise null. All consensus-bearing fields (sat, seed, name,
 * mint outpoint and inscription id) come from the transaction itself.
 *
 * `script` is the wallet's current ordinals output script. Passing it makes
 * the check independent of any address string supplied by a backend.
 */
export function parseLocalMint({ hex, utxo, script = null, mintHeight = null } = {}) {
  if (!hex || !utxo) return null;
  const txid = String(utxo.txid || '').toLowerCase();
  const vout = Number(utxo.vout);
  if (!/^[0-9a-f]{64}$/.test(txid) || !Number.isSafeInteger(vout) || vout < 0) return null;
  // The reveal's inscription sits on output 0. Reject a later output even
  // if a caller hands us one.
  if (vout !== 0) return null;

  let tx;
  try { tx = parseTx(hex); } catch { return null; }
  if (tx.txid !== txid) return null;

  const out = tx.outputs[vout];
  if (!out || BigInt(out.value) !== ANCHOR_OUTPUT_VALUE) return null;
  if (utxo.value != null && Number(out.value) !== Number(utxo.value)) return null;
  if (script && !equalBytes(out.script, script)) return null;

  const envelope = mintEnvelopeOf(tx);
  if (!envelope) return null;

  let ordinal = 0;
  for (const input of tx.inputs) {
    const tapscript = witnessTapscript(input);
    if (!tapscript) continue;
    for (const inscription of parseInscriptions(tapscript)) {
      const index = ordinal++;
      const contentType = typeof inscription.content_type === 'string'
        ? inscription.content_type
        : fromUtf8(inscription.content_type || new Uint8Array());
      if (contentType !== V7_CONTENT_TYPE || !inscription.body) continue;
      const body = fromUtf8(inscription.body);
      const found = /var (V7|V8)=\{sat:(\d+),genHint:(\d+),name:/.exec(body);
      if (!found) continue;
      const legacyDoc = found[1] === 'V7';
      const sat = Number(found[2]);
      const genHint = Number(found[3]);
      if (!Number.isSafeInteger(sat) || sat <= 0) continue;
      // A v7 document is accepted only for the one grandfathered sat. A v8
      // document is the current protocol.
      if (legacyDoc !== isGrandfatheredSat(sat)) continue;
      if (legacyDoc && envelope.version !== LEGACY_WIRE_VERSION) continue;
      if (!legacyDoc && envelope.version !== WIRE_VERSION) continue;
      // Re-render the canonical document for this seed, sat, name and
      // hint. A random inscription that merely contains "V7"/"V8" cannot
      // pass.
      const doc = legacyDoc
        ? liveV7Html(envelope.seed, sat, envelope.name, genHint)
        : liveV8Html(envelope.seed, sat, envelope.name, genHint);
      if (!equalBytes(inscription.body, utf8(doc))) continue;
      // F-07: the document's claimed sat is not proof of location. If the
      // caller supplied complete ranges, the claimed sat must be the first
      // sat of the 1,000-sat reveal output and the ranges must sum to its
      // value. Without ranges the record is recognized but explicitly
      // unverified; the wallet will not stage or spend it.
      const ranges = Array.isArray(utxo.ranges)
        ? utxo.ranges.map(([a, b]) => [Number(a), Number(b)]) : null;
      let satVerified = false;
      if (ranges && ranges.length) {
        if (rangesValue(ranges) !== Number(out.value)) continue;
        if (ranges[0][0] !== sat) continue;
        satVerified = true;
      }
      const height = Number(mintHeight ?? utxo.status?.block_height ?? 0);
      const commit = String(tx.inputs[0]?.txid || '').toLowerCase();
      return {
        sat,
        seed: envelope.seed >>> 0,
        name: envelope.name,
        gen: height > 0 ? generationAt(height) : genHint || 1,
        state: 'idle',
        dist: 0,
        crossings_entered: 0,
        crossings_settled: 0,
        deaths: 0,
        mint_height: Number.isInteger(height) && height > 0 ? height : 0,
        mint_txid: tx.txid,
        commit: /^[0-9a-f]{64}$/.test(commit) ? commit : null,
        mint_index: index,
        inscription_id: `${tx.txid}i${index}`,
        location: { txid: tx.txid, vout },
        wire_version: legacyDoc ? LEGACY_WIRE_VERSION : WIRE_VERSION,
        legacy_wire: legacyDoc,
        legacy_path: utxo.legacy_path === true,
        sat_verified: satVerified,
        ranges_exact: satVerified,
        local: true,
        source: LOCAL_MINT_SOURCE,
      };
    }
  }
  return null;
}
