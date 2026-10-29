// The canonical fold, network-free. Same algorithm as live_v6.js and the
// Rust indexer: a crossing is genuine only when its body is canonical AND
// its satpoint equals the mint's satpoint. The fold is stateless over
// heights, so a reorg is handled by asking again.

import { foldParams, requiredAt } from './params.js';

// live_v6.js uses the compact {g,b,s1,...} parameter shape.
function requiredAtFold(h, p) {
  if (h <= p.g) return p.b;
  const a1 = p.g + (p.u1 - p.b) * p.s1;
  const a2 = a1 + (p.u2 - p.u1) * p.s2;
  const a3 = a2 + (p.cap - p.u2) * p.s3;
  if (h < a1) return p.b + Math.floor((h - p.g) / p.s1);
  if (h < a2) return p.u1 + Math.floor((h - a1) / p.s2);
  if (h < a3) return p.u2 + Math.floor((h - a2) / p.s3);
  return p.cap;
}
import { diesDisplayHash } from './settle.js';

export function foldFrog({ sat, tip, me, children = [], hash = {}, p = foldParams() }) {
  const seen = children
    .filter((c) => c.bodyOk === true && c.height != null && me && me.satpoint && c.satpoint === me.satpoint)
    .sort((a, b) => a.height - b.height || (a.sequence || 0) - (b.sequence || 0));

  let state = 'idle';
  let dist = 0;

  for (const c of seen) {
    const T = c.height;
    const target = requiredAtFold(T, p);
    if (T + p.fin > tip) return { state: 'crossing', dist, target, pending: true };
    const h = hash[String(T + 1)];
    if (!h) return { state: 'crossing', dist, target, pending: true, reason: 'missing hash' };
    if (diesDisplayHash(sat, h, target)) return { state: 'dead', dist, target, pending: false };
    dist += 1;
    if (dist >= target) return { state: 'home', dist, target, pending: false };
    state = 'idle';
  }

  return { state, dist, target: requiredAtFold((tip || 0) + 1, p), pending: false };
}

// The indexer's record already carries the settled state; this helper
// prefers it and only uses the fold for independently verifiable state.
export function stateForRecord(record, tip) {
  if (!record) return { state: 'idle', dist: 0, target: requiredAt((tip || 0) + 1) };
  if (record.state === 'crossing' && record.in_flight) {
    return {
      state: 'crossing',
      dist: record.dist || 0,
      target: record.in_flight.target_hops,
      pending: true,
      settleHeight: record.in_flight.height + 6,
    };
  }
  return {
    state: record.state,
    dist: record.dist || 0,
    target: record.target_hops ?? requiredAt((tip || 0) + 1),
    pending: false,
  };
}
