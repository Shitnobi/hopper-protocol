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
import { PROTOCOL, requiredAt } from '../core/params.js';
import { decodeParentTag, decodeStateBodyVersioned } from '../core/v7.js';
import { wrapOfDisplayHex } from '../core/wrap.js';
import { parseTx, witnessControl, witnessTapscript } from './txparse.js';
import { stateScripts } from './actions.js';

/**
 * Identify the HOPPER transaction in one state-address history row.
 * Returns `{ tx, crossing, stateOut }` where `crossing` is present only
 * when input 0 carries the canonical body for this frog.
 */
export function frogTxRole({
  record, hex, stateScript, ownerXonly = null, legacy = false, txid = null,
}) {
  if (!record || !hex || !stateScript || !ownerXonly) return null;
  let tx;
  try { tx = parseTx(hex); } catch { return null; }
  if (txid && String(tx.txid).toLowerCase() !== String(txid).toLowerCase()) return null;
  const sat = Number(record.sat);
  const mintTxid = String(record.mint_txid || '').toLowerCase();
  const mintIndex = Number(record.mint_index ?? 0);
  if (!Number.isSafeInteger(sat) || !/^[0-9a-f]{64}$/.test(mintTxid)) return null;
  if (!tx.inputs.length) return null;

  // F-06: only input 0 can be the crossing, and it must reveal exactly
  // one canonical state leaf for this frog and direction. A matching body
  // in some other input, or an output-only deposit, is never a crossing.
  let crossing = null;
  const tapscript = witnessTapscript(tx.inputs[0]);
  const control = witnessControl(tx.inputs[0]);
  if (tapscript && control) {
    let inscriptions = [];
    try { inscriptions = parseInscriptions(tapscript); } catch { inscriptions = []; }
    if (inscriptions.length === 1 && !inscriptions[0].pointer && inscriptions[0].body) {
      let versioned = null;
      try { versioned = decodeStateBodyVersioned(inscriptions[0].body); } catch { versioned = null; }
      if (versioned && versioned.legacy === !!legacy) {
        const body = versioned.body;
        const bodyMint = bytesToHex(reverseBytes(body.mintTxid));
        const parent = inscriptions[0].parents?.[0];
        let parentOk = false;
        if (parent) {
          try {
            const decoded = decodeParentTag(parent);
            parentOk = bytesToHex(reverseBytes(decoded.mintTxid)) === mintTxid
              && Number(decoded.mintIndex) === mintIndex;
          } catch { parentOk = false; }
        }
        if (Number(body.sat) === sat && bodyMint === mintTxid
            && Number(body.mintIndex) === mintIndex && parentOk
            && Number(body.dir) >= 0 && Number(body.dir) <= 2) {
          const state = stateScripts(record, ownerXonly, { legacy: !!legacy });
          if (equalBytes(tapscript, state.crossLeaves[body.dir])
              && equalBytes(control, state.crossControls[body.dir])) {
            crossing = { dir: Number(body.dir), input: 0 };
          }
        }
      }
    }
  }

  const out0 = tx.outputs[0];
  const stateOut = !!(out0 && equalBytes(out0.script, stateScript));
  // A crossing must create the next state output. A canonical leaf that
  // pays an ordinary script is a protocol-invalid crossing (audit item 5),
  // not a handoff.
  if (crossing && !stateOut) return null;
  if (!crossing && !stateOut) return null;
  return {
    tx,
    crossing,
    stateOut,
    input0: `${String(tx.inputs[0].txid).toLowerCase()}:${Number(tx.inputs[0].vout)}`,
    out0: `${String(tx.txid).toLowerCase()}:0`,
  };
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
export function replayFrogChain({
  record, rows, txHex, hashByHeight, tip, stateScript, ownerXonly = null, legacy = false,
}) {
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
  // Every row's output 0 is a possible next frog outpoint. A crossing must
  // spend one of those (or the mint outpoint) in input 0; an output-only
  // deposit can never qualify.
  const knownOutpoints = new Set([`${String(record.mint_txid || '').toLowerCase()}:0`]);
  let lastCrossHeight = null;
  for (const row of ordered) {
    const hex = hexOf(row.txid);
    if (!hex) return null;
    const role = frogTxRole({
      record, hex, stateScript, ownerXonly, legacy, txid: row.txid,
    });
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
      if (!knownOutpoints.has(role.input0)) return null;
      if (lastCrossHeight != null && row.height - lastCrossHeight < PROTOCOL.crossFinality) return null;
      lastCrossHeight = row.height;
      crossings.push({ txid: row.txid, height: row.height, dir: role.crossing.dir });
    } else if (role.stateOut) {
      prepares.push({ txid: row.txid, height: row.height });
    }
    knownOutpoints.add(role.out0);
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
  const crossActions = [];

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
    const settlesAt = c.height + 6;
    if (settlesAt > tip) {
      state = 'crossing';
      inFlight = {
        txid: c.txid, height: c.height, dir: c.dir,
        target_hops: target, settle_height: settlesAt,
      };
      outcomeBlockHash = hash;
      outcomeWrap = wrap;
      provisionalDead = provisional;
      crossActions.push({
        kind: 'cross', sat: Number(record.sat), txid: c.txid, height: c.height,
        dir: c.dir, outcome: null, settled: false, settle_height: null, mempool: false,
      });
      break;
    }
    settled += 1;
    crossActions.push({
      kind: 'cross', sat: Number(record.sat), txid: c.txid, height: c.height,
      dir: c.dir, outcome: provisional ? 'dead' : 'crossed',
      settled: true, settle_height: settlesAt, mempool: false,
    });
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
    ...crossActions,
    ...pendingCrossings.map((c) => ({
      kind: 'cross', sat: Number(record.sat), txid: c.txid, height: null,
      dir: c.dir, settled: false, settle_height: null, mempool: true,
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
