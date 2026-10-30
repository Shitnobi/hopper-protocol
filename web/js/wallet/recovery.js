// Automatic layout recovery packs for staged Hoppers (SPEC §5.5).
//
// A pack is the public description of one staged Hopper's taproot output:
// the four leaves, their control blocks, the output key, the owner path and
// the current state outpoint. It never contains a seed or private key.
//
// The wallet reconciles this store on every completed scan, and records a
// local pack immediately after PREPARE or a cross (so the first copy does
// not wait for an indexer to catch up). When a later transaction moves the
// state output, the previous layout is kept in `history` and the pack is
// updated in place.

export const RECOVERY_STORE_TYPE = 'hopper-v7-recovery-store';
export const RECOVERY_PACK_TYPE = 'hopper-v7-recovery-pack';
export const RECOVERY_VERSION = 1;
export const MAX_RECOVERY_PACKS = 200;
export const MAX_RECOVERY_HISTORY = 6;
// A locally broadcast state outpoint is authoritative while the indexer
// catches up. If the chain disagrees for this many blocks, accept the chain.
export const PENDING_RECOVERY_BLOCKS = 6;

const OUTPOINT_RE = /^[0-9a-f]{64}:\d+$/;

export function isStateOutpoint(value) {
  return OUTPOINT_RE.test(String(value || '').toLowerCase());
}

export function emptyRecoveryStore({ fingerprint = '', network = '' } = {}) {
  return {
    type: RECOVERY_STORE_TYPE,
    version: RECOVERY_VERSION,
    fingerprint: String(fingerprint || '').toLowerCase(),
    network: String(network || ''),
    updated_at: null,
    last_scan_tip: null,
    packs: {},
  };
}

function cleanLeaves(leaves) {
  if (!Array.isArray(leaves)) return [];
  return leaves.slice(0, 3).filter((l) => l && Number.isInteger(Number(l.dir))).map((l) => ({
    dir: Number(l.dir),
    script_hex: String(l.script_hex || ''),
    leaf_hash: String(l.leaf_hash || ''),
    control_block: String(l.control_block || ''),
  }));
}

function cleanLeaf(leaf) {
  if (!leaf || typeof leaf !== 'object') return null;
  return {
    script_hex: String(leaf.script_hex || ''),
    leaf_hash: String(leaf.leaf_hash || ''),
    control_block: String(leaf.control_block || ''),
  };
}

function cleanSnapshot(raw) {
  if (!raw || !isStateOutpoint(raw.state_outpoint)) return null;
  return {
    state_outpoint: String(raw.state_outpoint).toLowerCase(),
    state_value: Number(raw.state_value) || 0,
    descriptor: String(raw.descriptor || ''),
    output_key: String(raw.output_key || ''),
    owner_xonly: String(raw.owner_xonly || ''),
    leaves: cleanLeaves(raw.leaves),
    send_leaf: cleanLeaf(raw.send_leaf),
    last_seen_tip: Number.isSafeInteger(Number(raw.last_seen_tip)) ? Number(raw.last_seen_tip) : null,
    updated_at: raw.updated_at ? String(raw.updated_at) : null,
  };
}

function cleanPack(raw, fingerprint, network) {
  if (!raw || raw.type !== RECOVERY_PACK_TYPE || Number(raw.version) !== RECOVERY_VERSION) return null;
  const sat = Number(raw.sat);
  if (!Number.isSafeInteger(sat) || sat < 0) return null;
  if (!isStateOutpoint(raw.state_outpoint)) return null;
  if (!raw.descriptor || typeof raw.descriptor !== 'string') return null;
  const history = Array.isArray(raw.history)
    ? raw.history.map(cleanSnapshot).filter(Boolean).slice(0, MAX_RECOVERY_HISTORY)
    : [];
  return {
    type: RECOVERY_PACK_TYPE,
    version: RECOVERY_VERSION,
    network: String(network || raw.network || ''),
    fingerprint: String(fingerprint || raw.fingerprint || '').toLowerCase(),
    sat,
    gen: Number(raw.gen) || 0,
    dist: Number(raw.dist) || 0,
    state: String(raw.state || ''),
    name: String(raw.name || ''),
    mint_id: String(raw.mint_id || ''),
    state_outpoint: String(raw.state_outpoint).toLowerCase(),
    state_value: Number(raw.state_value) || 0,
    owner_xonly: String(raw.owner_xonly || ''),
    internal_key: String(raw.internal_key || ''),
    output_key: String(raw.output_key || ''),
    descriptor: String(raw.descriptor),
    leaves: cleanLeaves(raw.leaves),
    send_leaf: cleanLeaf(raw.send_leaf),
    created_at: raw.created_at ? String(raw.created_at) : null,
    updated_at: raw.updated_at ? String(raw.updated_at) : null,
    first_staged_tip: Number.isSafeInteger(Number(raw.first_staged_tip))
      ? Number(raw.first_staged_tip) : null,
    last_seen_tip: Number.isSafeInteger(Number(raw.last_seen_tip))
      ? Number(raw.last_seen_tip) : null,
    pending_outpoint: isStateOutpoint(raw.pending_outpoint)
      ? String(raw.pending_outpoint).toLowerCase() : null,
    pending_tip: raw.pending_outpoint && Number.isSafeInteger(Number(raw.pending_tip))
      ? Number(raw.pending_tip) : null,
    history,
  };
}

export function normalizeRecoveryStore(raw, { fingerprint = '', network = '' } = {}) {
  const fp = String(fingerprint || raw?.fingerprint || '').toLowerCase();
  const base = emptyRecoveryStore({ fingerprint: fp, network });
  if (!raw || typeof raw !== 'object') return base;
  if (raw.type !== RECOVERY_STORE_TYPE || Number(raw.version) !== RECOVERY_VERSION) return base;
  if (raw.fingerprint && String(raw.fingerprint).toLowerCase() !== fp) return base;
  const entries = Array.isArray(raw.packs) ? raw.packs : Object.values(raw.packs || {});
  for (const entry of entries) {
    const pack = cleanPack(entry, fp, network);
    if (pack) base.packs[String(pack.sat)] = pack;
  }
  base.updated_at = raw.updated_at ? String(raw.updated_at) : null;
  base.last_scan_tip = Number.isSafeInteger(Number(raw.last_scan_tip))
    ? Number(raw.last_scan_tip) : null;
  return base;
}

function entryFromFrog(f, doc) {
  const sat = Number(f.sat);
  if (!Number.isSafeInteger(sat) || sat < 0 || !isStateOutpoint(f.state_outpoint)) return null;
  return {
    type: RECOVERY_PACK_TYPE,
    version: RECOVERY_VERSION,
    network: String(doc.network || ''),
    fingerprint: String(doc.fingerprint || '').toLowerCase(),
    sat,
    gen: Number(f.gen) || 0,
    dist: Number(f.dist) || 0,
    state: String(f.state || ''),
    name: String(f.name || ''),
    mint_id: String(f.mint_id || ''),
    state_outpoint: String(f.state_outpoint).toLowerCase(),
    state_value: Number(f.state_value) || 0,
    owner_xonly: String(f.owner_xonly || ''),
    internal_key: String(f.internal_key || ''),
    output_key: String(f.output_key || ''),
    descriptor: String(f.descriptor || ''),
    leaves: cleanLeaves(f.leaves),
    send_leaf: cleanLeaf(f.send_leaf),
  };
}

function historySnapshot(pack) {
  return {
    state_outpoint: pack.state_outpoint,
    state_value: pack.state_value,
    descriptor: pack.descriptor,
    output_key: pack.output_key,
    owner_xonly: pack.owner_xonly,
    leaves: cleanLeaves(pack.leaves),
    send_leaf: cleanLeaf(pack.send_leaf),
    last_seen_tip: pack.last_seen_tip,
    updated_at: pack.updated_at,
  };
}

function samePack(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Merge the current staged layout snapshot into the store.
 *
 * `doc` is the shape returned by WalletSession.emergencyDescriptors().
 * Packs that are not in this snapshot are deliberately kept: a partial
 * scan, a transfer out, or a reorg must not destroy the last recovery copy.
 */
export function reconcileRecoveryStore(store, doc, {
  tipHeight = 0, now = new Date().toISOString(), local = false,
} = {}) {
  const out = normalizeRecoveryStore(store, {
    fingerprint: doc?.fingerprint, network: doc?.network,
  });
  const packs = { ...out.packs };
  const seen = new Set();
  const tip = Number.isSafeInteger(Number(tipHeight)) ? Number(tipHeight) : 0;
  let changed = false;
  let created = 0;
  let moved = 0;

  for (const f of Array.isArray(doc?.frogs) ? doc.frogs : []) {
    const base = entryFromFrog(f, doc || {});
    if (!base || seen.has(base.sat)) continue;
    seen.add(base.sat);
    const prev = packs[String(base.sat)];
    const pending = !!(prev?.pending_outpoint && Number.isSafeInteger(prev.pending_tip));
    const pendingAge = pending ? Math.max(0, tip - prev.pending_tip) : 0;
    // A PREPARE/HOP is recorded locally before the indexer names its new
    // location. Its post-broadcast refresh can still see the old state
    // output; do not let that stale answer walk the pack backwards.
    const holdPending = !local && pending
      && base.state_outpoint !== prev.pending_outpoint
      && pendingAge <= PENDING_RECOVERY_BLOCKS;
    if (holdPending) {
      const kept = { ...prev, last_seen_tip: tip };
      if (!samePack(prev, kept)) {
        packs[String(base.sat)] = kept;
        changed = true;
      }
      continue;
    }
    const history = prev ? [...(prev.history || [])] : [];
    const layoutMoved = !!prev && (
      prev.state_outpoint !== base.state_outpoint
      || prev.descriptor !== base.descriptor
      || prev.output_key !== base.output_key
    );
    if (layoutMoved) {
      history.unshift(historySnapshot(prev));
      moved += 1;
    }
    if (history.length > MAX_RECOVERY_HISTORY) history.length = MAX_RECOVERY_HISTORY;
    const next = {
      ...base,
      created_at: prev?.created_at || now,
      // A moved layout is a new recovery fact. A re-seen one keeps the
      // timestamp of its last actual change; last_seen_tip still advances.
      updated_at: layoutMoved || !prev ? now : (prev.updated_at || now),
      first_staged_tip: Number.isSafeInteger(prev?.first_staged_tip)
        ? prev.first_staged_tip : tip,
      last_seen_tip: tip,
      // A local broadcast owns the pack until the indexer confirms it. The
      // chain can then clear the pending marker; a non-local snapshot never
      // carries one.
      pending_outpoint: local ? base.state_outpoint : null,
      pending_tip: local ? tip : null,
      history,
    };
    if (!prev || !samePack(prev, next)) {
      packs[String(base.sat)] = next;
      changed = true;
      if (!prev) created += 1;
    }
  }

  const keys = Object.keys(packs);
  if (keys.length > MAX_RECOVERY_PACKS) {
    const removable = keys.filter((key) => !seen.has(Number(key))).sort((a, b) => {
      const pa = packs[a];
      const pb = packs[b];
      return (Number(pa.last_seen_tip) || 0) - (Number(pb.last_seen_tip) || 0)
        || String(pa.updated_at || '').localeCompare(String(pb.updated_at || ''));
    });
    for (const key of removable) {
      if (Object.keys(packs).length <= MAX_RECOVERY_PACKS) break;
      delete packs[key];
      changed = true;
    }
  }

  if (out.last_scan_tip !== tip) {
    out.last_scan_tip = tip;
    changed = true;
  }
  if (changed) out.updated_at = now;
  out.packs = packs;
  return { store: out, changed, created, moved, current: seen.size };
}

export function recoverySummary(store) {
  const packs = Object.values(store?.packs || {});
  const lastTip = packs.reduce((max, pack) => {
    const tip = Number(pack.last_seen_tip);
    return Number.isSafeInteger(tip) ? Math.max(max, tip) : max;
  }, -1);
  return {
    count: packs.length,
    current_tip: Number.isSafeInteger(Number(store?.last_scan_tip))
      ? Number(store.last_scan_tip) : null,
    last_seen_tip: lastTip >= 0 ? lastTip : null,
    updated_at: store?.updated_at || null,
  };
}

/** The export shape. `packs` is an array here; the persisted shape is a map. */
export function recoveryPackDoc(store, { now = new Date().toISOString() } = {}) {
  const packs = Object.values(store?.packs || {}).sort((a, b) =>
    (Number(b.last_seen_tip) || 0) - (Number(a.last_seen_tip) || 0) || a.sat - b.sat);
  return {
    type: RECOVERY_STORE_TYPE,
    version: RECOVERY_VERSION,
    network: store?.network || '',
    fingerprint: store?.fingerprint || '',
    generated_at: now,
    updated_at: store?.updated_at || null,
    last_scan_tip: store?.last_scan_tip ?? null,
    packs,
  };
}
