// A local, deterministic HOPPER chain for the demo / offline mode.
//
// It implements the same consensus rules as hopper-indexer (v6):
// sat tracking FIFO, MINT via an ord inscription + FRG OP_RETURN,
// CROSS via the state inscription, the T+1 outcome and T+6 settlement,
// transfers and burns. It is not a Bitcoin node: no PoW, no mempool, no
// script execution. It exists so the wallet and UI can be exercised
// end-to-end without a regtest rig.

import {
  bytesToHex, concatBytes, equalBytes, hexToBytes, reverseBytes, sha256,
} from '../core/hex.js';
import { decodeMint } from '../core/envelope.js';
import { decodeStateBody, encodeParentTag, decodeParentTag, mintIdString } from '../core/v6.js';
import { parseInscriptions } from '../core/inscription.js';
import {
  CARD_VALUE, DEATH_BPS, GENESIS, MAGIC, NUMS_XONLY, V6_CONTENT_TYPE, WIRE_VERSION,
  requiredAt,
} from '../core/params.js';
import { diesDisplayHash } from '../core/settle.js';
import { mintBodyDigest, liveV6Html } from '../core/mintdoc.js';
import { assignRanges } from '../core/satmath.js';
import { scriptToAddress } from '../wallet/addresses.js';
import { opReturnPush, parseTx, witnessControl, witnessTapscript } from '../wallet/txparse.js';

const STORE_KEY = 'hopper.mockchain.v1';
const SHADOW_BASE = 4_000_000_000_000_000;
const FAUCET_BASE = 9_000_000_000;

export function displayHash(h) {
  return bytesToHex(reverseBytes(h));
}

export class MockChain {
  constructor({ network = 'regtest', fresh = false } = {}) {
    this.network = network;
    this.loaded = false;
    if (!fresh) this.load();
    if (!this.loaded) this.reset();
  }

  reset() {
    this.height = GENESIS;
    this.salt = 'hopper-demo';
    this.utxos = new Map();
    this.frogs = new Map(); // sat -> record
    this.txs = [];
    this.events = [];
    this.faucetIndex = 0;
    this.npcIndex = 0;
    this.registered = new Set();
    this.seedNpcs();
    this.persist();
  }

  // --- chain geometry -----------------------------------------------------
  blockHash(height = this.height) {
    return sha256(new TextEncoder().encode(`hopper:${this.salt}:${height}`));
  }

  tipHeight() { return this.height; }
  tipHash() { return displayHash(this.blockHash()); }
  blockHashAt(height) { return displayHash(this.blockHash(height)); }

  mine(count = 1) {
    for (let i = 0; i < count; i++) {
      this.height += 1;
      this.runTimers(this.height);
      this.maybeNpcCross();
      this.persist();
    }
  }

  // --- coins --------------------------------------------------------------
  keyFor(outpoint) { return `${outpoint.txid}:${outpoint.vout}`; }

  addCoin({ txid, vout, value, script, ranges, frogs = [] }) {
    this.utxos.set(this.keyFor({ txid, vout }), {
      txid, vout, value: Number(value), scriptHex: bytesToHex(script), ranges, frogs,
      address: scriptToAddress(script, this.network),
    });
  }

  utxosForScript(scriptHex) {
    return [...this.utxos.values()].filter((u) => u.scriptHex === scriptHex);
  }

  utxosForAddress(address) {
    return [...this.utxos.values()].filter((u) => u.address === address);
  }

  utxo(txid, vout) {
    return this.utxos.get(`${txid}:${vout}`) || null;
  }

  // A faucet coin with real ordinal ranges: the demo wallet needs at least
  // one tracked anchor before it can mint.
  fund({ script, address, value = 200000, count = 8 }) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const n = this.faucetIndex++;
      const start = FAUCET_BASE + n * 1_000_000;
      const txid = bytesToHex(reverseBytes(sha256(new TextEncoder().encode(`faucet:${this.salt}:${n}`))));
      this.addCoin({ txid, vout: 0, value, script, ranges: [[start, start + value - 1]] });
      this.txs.push({ txid, height: null, action: 'faucet', detail: { value } });
      out.push({ txid, vout: 0, value, ranges: [[start, start + value - 1]] });
    }
    this.persist();
    return out;
  }

  // --- block application --------------------------------------------------
  submit(hex) {
    const tx = parseTx(hex);
    this.height += 1;
    this.runTimers(this.height);
    this.applyTx(tx, this.height);
    this.maybeNpcCross();
    this.persist();
    return tx.txid;
  }

  applyTx(tx, height) {
    const inputRanges = [];
    const prevouts = [];
    for (const input of tx.inputs) {
      const coin = this.utxo(input.txid, input.vout);
      if (coin) {
        inputRanges.push(coin.ranges);
        prevouts.push({ value: coin.value, script: hexToBytes(coin.scriptHex) });
      } else {
        // Shadow sat range: keeps FIFO placement, never a real ordinal.
        inputRanges.push([[SHADOW_BASE + this.faucetIndex * 1000, SHADOW_BASE + this.faucetIndex * 1000 + 999]]);
        prevouts.push({ value: 0, script: new Uint8Array() });
      }
    }
    const values = tx.outputs.map((o) => Number(o.value));
    const assignment = assignRanges(inputRanges, values);
    if (!assignment) throw new Error('transaction outputs exceed its inputs');

    // Which frogs are being spent, and where did their sats go?
    const spentFrogs = [];
    for (const input of tx.inputs) {
      for (const [sat, frog] of this.frogs) {
        if (frog.location && frog.location.txid === input.txid && frog.location.vout === input.vout) {
          spentFrogs.push([sat, frog]);
        }
      }
    }
    for (const input of tx.inputs) this.utxos.delete(`${input.txid}:${input.vout}`);

    const reveal = this.revealOf(tx);
    const isCross = reveal && reveal.body && bytesToHex(reveal.body.slice(0, 9)) === bytesToHex(new TextEncoder().encode('FRG6CROSS'));

    // Record outputs.
    tx.outputs.forEach((output, vout) => {
      const ranges = assignment.outputs[vout];
      const frogs = [];
      for (const [sat] of spentFrogs) {
        if (ranges.some(([a, b]) => sat >= a && sat <= b)) frogs.push(sat);
      }
      this.addCoin({
        txid: tx.txid, vout, value: Number(output.value), script: output.script, ranges, frogs,
      });
    });

    // Frog movement.
    for (const [sat, frog] of spentFrogs) {
      const dest = this.outputContaining(tx, assignment, sat);
      if (dest == null) {
        frog.location = null;
        frog.burn_height ??= height;
        frog.burn_txid ??= tx.txid;
        this.event(height, tx.txid, 'burn', { frogger_sat: sat });
        if (frog.state === 'idle') frog.state = 'burned';
      } else {
        frog.location = { txid: tx.txid, vout: dest };
        this.event(height, tx.txid, 'transfer', { frogger_sat: sat });
      }
    }

    // MINT: a valid reveal carrying the v6 document + the FRG envelope.
    const mintMsg = tx.outputs.map((o) => opReturnPush(o.script)).find((p) => p && p.length >= 3 && new TextDecoder().decode(p.slice(0, 3)) === MAGIC && p[3] === WIRE_VERSION);
    if (mintMsg && reveal && reveal.contentType === V6_CONTENT_TYPE) {
      try {
        const { seed, name } = decodeMint(mintMsg);
        const anchor = assignment.outputs[0] && assignment.outputs[0][0] ? assignment.outputs[0][0][0] : null;
        if (anchor != null && !this.frogs.has(anchor) && reveal.body) {
          const digest = bytesToHex(sha256(reveal.body));
          const want = bytesToHex(mintBodyDigest(seed, anchor));
          if (digest === want) this.createFrog({ sat: anchor, seed, name, height, txid: tx.txid, index: 0 });
        }
      } catch { /* malformed mints move sats only */ }
    }

    // CROSS
    if (isCross && reveal) {
      try {
        const body = decodeStateBody(reveal.body);
        const frog = this.frogs.get(body.sat);
        if (frog && frog.state === 'idle' && reveal.inputIndex === 0 && reveal.parents.length) {
          const [parent] = reveal.parents;
          const decoded = decodeParentTag(parent);
          const ownerOk = stateLeafShapeOk(reveal.tapscript, reveal.control);
          const out0 = assignment.outputs[0] || [];
          const anchorFirst = out0.length && out0[0][0] === body.sat;
          const parentOk = bytesToHex(decoded.mintTxid) === bytesToHex(reverseBytes(hexToBytes(frog.mint_txid)))
            && decoded.mintIndex === frog.mint_index;
          const bodyOk = body.mintTxid.length === 32
            && bytesToHex(body.mintTxid) === bytesToHex(reverseBytes(hexToBytes(frog.mint_txid)));
          const fundingCarriesFrog = spentFrogs.some(([sat]) => sat !== body.sat);
          const mixed = tx.outputs.some((o) => {
            const p = opReturnPush(o.script);
            return p && p.length >= 3 && new TextDecoder().decode(p.slice(0, 3)) === MAGIC;
          });
          if (ownerOk && anchorFirst && parentOk && bodyOk && !fundingCarriesFrog && !mixed) {
            frog.state = 'crossing';
            frog.crossings_entered += 1;
            frog.in_flight = {
              txid: tx.txid, height, target_hops: requiredAt(height),
            };
            frog.last_target_hops = requiredAt(height);
            frog.outcome_block_hash = null;
            frog.provisional_dead = null;
            frog.location = { txid: tx.txid, vout: 0 };
            this.event(height, tx.txid, 'cross', { frogger_sat: body.sat });
          }
        }
      } catch { /* not a crossing */ }
    }

    this.txs.push({
      txid: tx.txid, height, action: isCross ? 'cross' : mintMsg ? 'mint' : 'transfer', hex: tx.hex,
    });
  }

  revealOf(tx) {
    for (let i = 0; i < tx.inputs.length; i++) {
      const script = witnessTapscript(tx.inputs[i]);
      if (!script) continue;
      const parsed = parseInscriptions(script);
      if (!parsed.length) continue;
      return {
        inputIndex: i,
        contentType: parsed[0].content_type ? new TextDecoder().decode(parsed[0].content_type) : null,
        body: parsed[0].body,
        parents: parsed[0].parents || [],
        tapscript: script,
        control: witnessControl(tx.inputs[i]),
      };
    }
    return null;
  }

  outputContaining(tx, assignment, sat) {
    for (let vout = 0; vout < assignment.outputs.length; vout++) {
      if (assignment.outputs[vout].some(([a, b]) => sat >= a && sat <= b)) return vout;
    }
    return null;
  }

  createFrog({ sat, seed, name, height, txid, index, npc = false, dist = 0, state = 'idle' }) {
    this.frogs.set(sat, {
      sat, seed, name,
      state,
      dist,
      crossings_entered: dist,
      crossings_settled: dist,
      deaths: state === 'dead' ? 1 : 0,
      mint_height: height,
      mint_txid: txid,
      mint_index: index,
      inscription_id: `${txid}i${index}`,
      location: state === 'home' || state === 'dead' ? null : { txid, vout: 0 },
      in_flight: null,
      outcome_block_hash: null,
      provisional_dead: null,
      last_target_hops: requiredAt(height),
      immortal_height: state === 'home' ? height : null,
      death_height: state === 'dead' ? height : null,
      burn_height: null,
      burn_txid: null,
      npc,
    });
    const coin = this.utxo(txid, 0);
    if (coin && !coin.frogs.includes(sat)) coin.frogs.push(sat);
    this.event(height, txid, 'mint', { frogger_sat: sat, seed, name });
  }

  // --- timers (SPEC §4.4) -------------------------------------------------
  runTimers(height) {
    const hash = this.blockHash(height);
    const hashDisplay = displayHash(hash);
    for (const frog of this.frogs.values()) {
      const f = frog.in_flight;
      if (!f) continue;
      if (f.height + 1 === height) {
        frog.outcome_block_hash = hashDisplay;
        frog.provisional_dead = diesDisplayHash(frog.sat, hashDisplay, f.target_hops);
      }
      if (f.height + 6 === height) {
        frog.crossings_settled += 1;
        if (frog.location == null || frog.provisional_dead) {
          frog.state = frog.location == null ? 'burned' : 'dead';
          if (frog.state === 'dead') { frog.deaths = 1; frog.death_height = f.height; }
          this.event(height, null, 'settle', { frogger_sat: frog.sat, outcome: 'dead' });
        } else {
          frog.dist += 1;
          if (frog.dist >= f.target_hops) {
            frog.state = 'home';
            frog.immortal_height = f.height;
          } else {
            frog.state = 'idle';
          }
          this.event(height, null, 'settle', { frogger_sat: frog.sat, outcome: 'crossed' });
        }
        frog.in_flight = null;
        frog.provisional_dead = null;
      }
    }
  }

  // --- NPC life (demo only) ----------------------------------------------
  seedNpcs() {
    const names = ['Hopkinson', 'Marsh', 'Toadly', 'Puddle', 'Croakley', 'Lily', 'Bogart', 'Pip'];
    names.forEach((name, i) => {
      const seed = (0x1234567 + i * 0x9e3779b1) >>> 0;
      const sat = 50_000_000 + i * 977;
      const txid = bytesToHex(reverseBytes(sha256(new TextEncoder().encode(`npc:${i}:${this.salt}`))));
      this.createFrog({
        sat, seed, name, height: GENESIS - 100, txid, index: 0, npc: true,
        dist: [0, 2, 5, 1, 9, 3, 12, 0][i], state: i === 2 ? 'home' : 'idle',
      });
    });
  }

  maybeNpcCross() {
    // A deterministic trickle: one NPC crosses every third block. No tx is
    // built (these frogs are not owned by the user); their timer math is
    // the same, so The Road and the Leaderboard stay alive.
    if (this.height % 3 !== 0) return;
    const idle = [...this.frogs.values()].filter((f) => f.npc && f.state === 'idle');
    if (!idle.length) return;
    const frog = idle[this.height % idle.length];
    frog.state = 'crossing';
    frog.crossings_entered += 1;
    frog.in_flight = { txid: `npc${this.height}`, height: this.height, target_hops: requiredAt(this.height) };
    frog.last_target_hops = requiredAt(this.height);
  }

  // --- indexer-shaped queries --------------------------------------------
  record(sat) {
    const frog = this.frogs.get(Number(sat));
    if (!frog) return null;
    return { ...frog, location: frog.location ? { ...frog.location } : null, in_flight: frog.in_flight ? { ...frog.in_flight } : null };
  }

  listFrogs({ limit = 50, offset = 0, afterSat = null, toSat = null } = {}) {
    const all = [...this.frogs.values()].sort((a, b) => a.sat - b.sat);
    let filtered = all;
    if (afterSat != null) filtered = filtered.filter((f) => f.sat > afterSat);
    if (toSat != null) filtered = filtered.filter((f) => f.sat <= toSat);
    const items = filtered.slice(offset, offset + limit).map((f) => this.record(f.sat));
    const next = filtered.length > offset + limit ? filtered[offset + limit].sat : null;
    return { total: all.length, items, next_after_sat: next };
  }

  road() {
    return [...this.frogs.values()]
      .filter((f) => f.state === 'crossing' && f.in_flight)
      .map((f) => ({
        sat: f.sat, seed: f.seed, name: f.name, dist: f.dist,
        in_flight: {
          txid: f.in_flight.txid, height: f.in_flight.height,
          target_hops: f.in_flight.target_hops, settle_height: f.in_flight.height + 6,
        },
        provisional_dead: f.provisional_dead,
      }));
  }

  leaderboard(limit = 25) {
    return [...this.frogs.values()]
      .sort((a, b) => b.dist - a.dist || a.sat - b.sat)
      .slice(0, limit)
      .map((f, i) => ({ rank: i + 1, sat: f.sat, name: f.name, seed: f.seed, dist: f.dist, state: f.state }));
  }

  status() {
    return {
      tip_height: this.height,
      tip_hash: this.tipHash(),
      finality_depth: 6,
      froggers: this.frogs.size,
      active_crossings: this.road().length,
      wire_version: 6,
    };
  }

  utxoDto(txid, vout) {
    const u = this.utxo(txid, vout);
    if (!u) throw new Error('utxo not tracked');
    return {
      value: u.value,
      ranges: u.ranges.map(([a, b]) => [a, b + 1]),
      exact: u.ranges.every(([a]) => a < SHADOW_BASE),
      frogs: u.frogs,
    };
  }

  // --- persistence --------------------------------------------------------
  persist() {
    if (typeof localStorage === 'undefined') return;
    const data = {
      height: this.height, salt: this.salt, faucetIndex: this.faucetIndex, npcIndex: this.npcIndex,
      utxos: [...this.utxos.values()],
      frogs: [...this.frogs.values()],
      txs: this.txs.slice(-500),
      events: this.events.slice(-500),
    };
    try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch { /* quota */ }
  }

  load() {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      this.height = data.height;
      this.salt = data.salt;
      this.faucetIndex = data.faucetIndex;
      this.npcIndex = data.npcIndex;
      this.utxos = new Map(data.utxos.map((u) => [`${u.txid}:${u.vout}`, u]));
      this.frogs = new Map(data.frogs.map((f) => [f.sat, f]));
      this.txs = data.txs || [];
      this.events = data.events || [];
      this.loaded = true;
      this.registered = new Set();
    } catch { /* corrupt demo state: start fresh */ }
  }

  event(height, txid, action, payload) {
    this.events.push({ height, block_hash: this.blockHashAt(height), txid, action: { action, ...payload } });
  }
}

function stateLeafShapeOk(tapscript, control) {
  if (!tapscript || !control) return false;
  if (control.length !== 65 || (control[0] & 0xfe) !== 0xc0) return false;
  if (!equalBytes(control.slice(1, 33), NUMS_XONLY)) return false;
  if (tapscript.length < 36) return false;
  if (tapscript[0] !== 0x20 || tapscript[33] !== 0xad) return false;
  if (tapscript[34] !== 0x00 || tapscript[35] !== 0x63) return false;
  if (tapscript[tapscript.length - 2] !== 0x68 || tapscript[tapscript.length - 1] !== 0x51) return false;
  return parseInscriptions(tapscript).length === 1;
}

export { CARD_VALUE, DEATH_BPS, V6_CONTENT_TYPE, mintIdString };
