// Rebuild a Hopper's road history from the chain, without an indexer.
//
// The state output always pays the same derived state address for a given
// (sat, mint, owner). Every TRAVEL and every HOP therefore appears in that
// address's transaction history. The crossing body in input 0 names the
// frog, its mint and its direction; the block hash at T+1 decides survival.
// This is the same fold the inscription runs, applied by the wallet so a
// second device (or a reload after the local action ledger was lost) can
// still show the crossings that are already on chain.

import { bytesToHex, equalBytes, reverseBytes } from '../core/hex.js';
import { parseInscriptions } from '../core/inscription.js';
import { requiredAt } from '../core/params.js';
import { decodeStateBody } from '../core/v7.js';
import { wrapOfDisplayHex } from '../core/wrap.js';
import { parseTx, witnessTapscript } from './txparse.js';

/**
 * Identify the HOPPER transaction in one state-address history row.
 * Returns `{ tx, crossing, stateOut }` where `crossing` is present only
 * when input 0 carries the canonical body for this frog.
 */
export function frogTxRole({ record, hex, stateScript }) {
  if (!record || !hex || !stateScript) return null;
  let tx;
  try { tx = parseTx(hex); } catch { return null; }
  const sat = Number(record.sat);
  const mintTxid = String(record.mint_txid || '').toLowerCase();
  const mintIndex = Number(record.mint_index ?? 0);
  if (!Number.isSafeInteger(sat) || !/^[0-9a-f]{64}$/.test(mintTxid)) return null;

  let crossing = null;
  for (let i = 0; i < tx.inputs.length; i++) {
    const tapscript = witnessTapscript(tx.inputs[i]);
    if (!tapscript) continue;
    let inscriptions = [];
    try { inscriptions = parseInscriptions(tapscript); } catch { inscriptions = []; }
    for (const inscription of inscriptions) {
      if (!inscription?.body) continue;
      let body;
      try { body = decodeStateBody(inscription.body); } catch { continue; }
      if (Number(body.sat) !== sat) continue;
      const bodyMint = bytesToHex(reverseBytes(body.mintTxid));
      if (bodyMint !== mintTxid || Number(body.mintIndex) !== mintIndex) continue;
      if (Number(body.dir) < 0 || Number(body.dir) > 2) continue;
      crossing = { dir: Number(body.dir), input: i };
      break;
    }
    if (crossing) break;
  }

  const stateOut = tx.outputs.some((out) => equalBytes(out.script, stateScript));
  if (!crossing && !stateOut) return null;
  return { tx, crossing, stateOut };
}

/**
 * Replay the ordered state-address history.
 *
 * `rows`      [{ txid, height }]
 * `txHex`     Map/object txid -> raw hex
 * `hashByHeight` object/Map height -> display block hash
 *
 * Returns null when a transaction needed for the replay is missing, so the
 * caller can keep the last good state instead of inventing one.
 */
export function replayFrogChain({ record, rows, txHex, hashByHeight, tip, stateScript }) {
  if (!record || !Array.isArray(rows) || !stateScript) return null;
  const hexOf = (txid) => {
    if (txHex instanceof Map) return txHex.get(txid) || null;
    return txHex?.[txid] || null;
  };
  const hashOf = (height) => {
    if (hashByHeight instanceof Map) {
      return hashByHeight.get(Number(height))
        || hashByHeight.get(String(height))
        || null;
    }
    return hashByHeight?.[String(height)] || hashByHeight?.[Number(height)] || null;
  };

  const ordered = rows
    .filter((r) => r && /^[0-9a-f]{64}$/i.test(String(r.txid || '')))
    .map((r) => ({
      txid: String(r.txid).toLowerCase(),
      height: Number.isInteger(Number(r.height)) && Number(r.height) > 0
        ? Number(r.height) : null,
    }))
    .sort((a, b) => (a.height ?? Infinity) - (b.height ?? Infinity)
      || a.txid.localeCompare(b.txid));

  const prepares = [];
  const crossings = [];
  const pendingCrossings = [];
  for (const row of ordered) {
    const hex = hexOf(row.txid);
    if (!hex) return null;
    const role = frogTxRole({ record, hex, stateScript });
    if (!role) {
      if (row.height == null) continue;
      return null;
    }
    if (row.height == null) {
      // A crossing can sit in the mempool while the address history already
      // names the new state output. Show it as in flight and, critically,
      // keep the pond from offering a second HOP that would conflict with it.
      if (role.crossing) {
        pendingCrossings.push({ txid: row.txid, height: null, dir: role.crossing.dir, mempool: true });
      }
      continue;
    }
    if (role.crossing) {
      crossings.push({ txid: row.txid, height: row.height, dir: role.crossing.dir });
    } else if (role.stateOut) {
      prepares.push({ txid: row.txid, height: row.height });
    }
  }

  let state = 'idle';
  let dist = 0;
  let entered = 0;
  let settled = 0;
  let deaths = 0;
  let lastTarget = null;
  let inFlight = null;
  let immortalHeight = null;
  let deathHeight = null;
  let outcomeBlockHash = null;
  let outcomeWrap = null;
  let provisionalDead = null;
  const settles = [];

  for (const c of crossings) {
    const target = requiredAt(c.height);
    entered += 1;
    lastTarget = target;
    let hash = null;
    let wrap = null;
    let provisional = null;
    if (c.height + 1 <= tip) {
      hash = hashOf(c.height + 1);
      if (!hash) return null;
      wrap = wrapOfDisplayHex(hash);
      provisional = c.dir === wrap;
    }
    if (c.height + 6 > tip) {
      state = 'crossing';
      inFlight = {
        txid: c.txid, height: c.height, dir: c.dir,
        target_hops: target, settle_height: c.height + 6,
      };
      outcomeBlockHash = hash;
      outcomeWrap = wrap;
      provisionalDead = provisional;
      break;
    }
    settled += 1;
    if (provisional) {
      state = 'dead';
      deaths = 1;
      deathHeight = c.height;
      outcomeBlockHash = hash;
      outcomeWrap = wrap;
      provisionalDead = null;
      settles.push({
        kind: 'settle', sat: Number(record.sat), height: c.height + 6, dir: c.dir,
        outcome: 'dead',
      });
      break;
    }
    dist += 1;
    if (dist >= target) {
      state = 'home';
      immortalHeight = c.height;
    } else {
      state = 'idle';
    }
    settles.push({
      kind: 'settle', sat: Number(record.sat), height: c.height + 6, dir: c.dir,
      outcome: 'crossed',
    });
    outcomeBlockHash = hash;
    outcomeWrap = wrap;
    provisionalDead = null;
  }

  // A confirmed crossing in flight wins. Otherwise the newest mempool
  // crossing is the live state; it is reported, never counted as settled.
  if (!inFlight && pendingCrossings.length) {
    const c = pendingCrossings[pendingCrossings.length - 1];
    const target = requiredAt(Number(tip) + 1);
    state = 'crossing';
    inFlight = {
      txid: c.txid, height: null, dir: c.dir,
      target_hops: target, settle_height: null, pending: true,
    };
    lastTarget = target;
    outcomeBlockHash = null;
    outcomeWrap = null;
    provisionalDead = null;
  }

  const actions = [
    ...prepares.map((p) => ({ kind: 'prepare', sat: Number(record.sat), txid: p.txid, height: p.height })),
    ...crossings.map((c) => ({
      kind: 'cross', sat: Number(record.sat), txid: c.txid, height: c.height, dir: c.dir,
    })),
    ...pendingCrossings.map((c) => ({
      kind: 'cross', sat: Number(record.sat), txid: c.txid, height: null,
      dir: c.dir, mempool: true,
    })),
    ...settles,
  ];

  return {
    state, dist,
    crossingsEntered: entered,
    crossingsSettled: settled,
    deaths,
    lastTarget,
    inFlight,
    immortalHeight,
    deathHeight,
    outcomeBlockHash,
    outcomeWrap,
    provisionalDead,
    actions,
    crossings,
    prepares,
  };
}
