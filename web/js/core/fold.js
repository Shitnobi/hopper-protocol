// The canonical pure fold, network-free. Same algorithm as live_v8.js and the
// Rust indexer: a hop is genuine only when its body is canonical AND its
// satpoint equals the mint's satpoint. The fold is stateless over heights,
// so a reorg is handled by asking again.

import { foldParams, requiredAt, generationAt } from './params.js';
import { wrapOfDisplayHex } from './wrap.js';

// live_v8.js uses the compact {g,b,gi,...} parameter shape.
function requiredAtFold(h, p) {
  if (h < p.g) return p.b;
  const k = h < p.g ? 1 : 1 + Math.floor((h - p.g) / p.gl);
  const start = p.g + (k - 1) * p.gl;
  const r = p.b + Math.floor((h - start) / p.gi);
  return r > p.cap ? p.cap : r;
}

export function foldFrog({ sat, tip, me, children = [], hash = {}, p = foldParams(), incomplete = false }) {
  const targetNow = requiredAtFold((tip || 0) + 1, p);
  const unverified = (reason) => ({
    state: 'unverified', dist: 0, dir: null, target: targetNow,
    pending: true, reason,
  });
  if (incomplete) return unverified('incomplete children');
  const bodyValid = children.filter((c) => c && c.bodyOk === true);
  if (bodyValid.some((c) => c.proofOk !== true)) return unverified('unverified child');
  const seen = bodyValid
    .filter((c) => c.bodyOk === true && Number.isInteger(c.dir) && c.dir >= 0 && c.dir <= 2
      && c.height != null && me && me.satpoint && c.satpoint === me.satpoint)
    .sort((a, b) => a.height - b.height || (a.sequence || 0) - (b.sequence || 0));

  let state = 'idle';
  let dist = 0;
  let lastT = null;
  const txids = new Set();

  for (const c of seen) {
    const T = c.height;
    if (c.id && txids.has(c.id)) return unverified('duplicate crossing');
    if (lastT != null && T - lastT < p.fin) return unverified('crossing before finality');
    const target = requiredAtFold(T, p);
    if (T + p.fin > tip) {
      return { state: 'crossing', dist, dir: c.dir, target, pending: true };
    }
    const h = hash[String(T + 1)];
    if (!h) {
      return { state: 'crossing', dist, dir: c.dir, target, pending: true, reason: 'missing hash' };
    }
    if (c.dir === wrapOfDisplayHex(h)) {
      return { state: 'dead', dist, dir: c.dir, target, pending: false };
    }
    dist += 1;
    if (c.id) txids.add(c.id);
    lastT = T;
    if (dist >= target) return { state: 'home', dist, dir: c.dir, target, pending: false };
    state = 'idle';
  }

  return { state, dist, dir: null, target: requiredAtFold((tip || 0) + 1, p), pending: false };
}

// The indexer's record already carries the settled state; this helper
// prefers it and only uses the fold for independently verifiable state.
export function stateForRecord(record, tip) {
  if (!record) {
    return {
      state: 'idle', dist: 0, gen: generationAt(tip || 0),
      target: requiredAt((tip || 0) + 1),
    };
  }
  if (record.state === 'crossing' && record.in_flight) {
    return {
      state: 'crossing',
      dist: record.dist || 0,
      gen: record.gen ?? generationAt(record.mint_height ?? tip ?? 0),
      target: record.in_flight.target_hops,
      dir: record.in_flight.dir ?? null,
      pending: true,
      settleHeight: record.in_flight.height + 6,
    };
  }
  return {
    state: record.state,
    dist: record.dist || 0,
    gen: record.gen ?? generationAt(record.mint_height ?? tip ?? 0),
    target: record.target_hops ?? requiredAt((tip || 0) + 1),
    pending: false,
  };
}
