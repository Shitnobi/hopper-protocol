// The wallet's music, ported from frogger-wallet-pwa/web/sound.js.
//
// `music.mid` (checked in beside this module) is the score; a browser has
// no MIDI synthesizer, so this module is the player: it parses the file
// once, maps ticks to seconds through the tempo map, and schedules each
// note on the WebAudio clock with a short lookahead, looping at the
// score's own length. The synth voice is the egui player's wave (a
// struck, plucked harmonic stack), not a sampled piano.
//
// Four rules:
//  1. Nothing sounds before a gesture. arm() is called from a pointer/key
//     handler; the context is created there.
//  2. The mute and volume are the person's (the wallet persists them in
//     its settings); both end at one master gain.
//  3. Silence is not a crash. A browser without AudioContext (headless,
//     a blocker) leaves this module present and inert.
//  4. The score is data. A malformed file is one console line and no
//     music, never an exception into the wallet.
//
// The short SFX the old HOPPER interface used (mint / cross / settle /
// error / tap / win) still play through the same master gain.

const GAIN = 1.6;
// Perceptual slider -> linear gain: half the slider is half the loudness.
const CURVE = 2;
const LOOKAHEAD = 0.4; // seconds of score scheduled ahead of the playhead
const TICK = 80; // scheduler interval, ms
const MUSIC_URL = new URL('../music.mid', import.meta.url).href;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const gainFor = (v) => GAIN * Math.pow(clamp01(v), CURVE);
const Hz = (note) => 440 * Math.pow(2, (note - 69) / 12);

// ---- MIDI -------------------------------------------------------------
//
// Format 0/1, PPQ timing. Only what the score needs to sound: note on/off,
// tempo, program, pan and channel volume. Every other event is skipped by
// its own length, which is what makes skipping it safe.

const readVar = (b, i) => {
  let v = 0;
  let x;
  do {
    x = b[i++];
    v = (v << 7) | (x & 0x7f);
  } while (x & 0x80);
  return [v, i];
};

export function parseMidi(buffer) {
  const u8 = new Uint8Array(buffer);
  if (u8.length < 14 || String.fromCharCode(...u8.subarray(0, 4)) !== 'MThd') {
    throw new Error('not a MIDI file');
  }
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const hlen = dv.getUint32(4);
  const ntrks = dv.getUint16(10);
  const division = dv.getUint16(12);
  if (division & 0x8000) throw new Error('SMPTE timing is not supported');
  const ppq = division || 96;

  const raw = [];
  const tempos = [];
  let i = 8 + hlen;
  for (let t = 0; t < ntrks; t++) {
    if (i + 8 > u8.length || String.fromCharCode(...u8.subarray(i, i + 4)) !== 'MTrk') break;
    const len = dv.getUint32(i + 4);
    let j = i + 8;
    const stop = Math.min(u8.length, j + len);
    let tick = 0;
    let status = 0;
    let running = false;
    while (j < stop) {
      let delta;
      [delta, j] = readVar(u8, j);
      tick += delta;
      if (j >= stop) break;
      const hi = u8[j];
      if (hi === 0xff) {
        const kind = u8[j + 1];
        let ln;
        [ln, j] = readVar(u8, j + 2);
        if (kind === 0x51) {
          tempos.push({ tick, us: (u8[j] << 16) | (u8[j + 1] << 8) | u8[j + 2] });
        }
        j += ln;
        running = false;
      } else if (hi === 0xf0 || hi === 0xf7) {
        let ln;
        [ln, j] = readVar(u8, j + 1);
        j += ln;
        running = false;
      } else {
        if (hi & 0x80) {
          status = hi;
          j += 1;
          running = true;
        } else if (!running) {
          throw new Error('running status with no status');
        }
        const kind = status & 0xf0;
        const ch = status & 0x0f;
        if (kind === 0x90 || kind === 0x80) {
          const note = u8[j];
          const vel = u8[j + 1];
          j += 2;
          raw.push({ tick, on: kind === 0x90 && vel > 0, ch, note, vel });
        } else if (kind === 0xb0) {
          raw.push({ tick, cc: u8[j], val: u8[j + 1], ch });
          j += 2;
        } else if (kind === 0xc0) {
          raw.push({ tick, prog: u8[j], ch });
          j += 1;
        } else if (kind === 0xd0) {
          j += 1;
        } else {
          j += 2; // pitch bend / channel pressure: not used here
        }
      }
    }
    i = stop;
  }

  // ticks -> seconds through the tempo map.
  tempos.sort((a, b) => a.tick - b.tick);
  const seconds = (tick) => {
    let s = 0;
    let last = 0;
    let us = 500000;
    for (const t of tempos) {
      if (t.tick > tick) break;
      s += ((t.tick - last) * us) / ppq / 1e6;
      last = t.tick;
      us = t.us;
    }
    return s + ((tick - last) * us) / ppq / 1e6;
  };

  const notes = [];
  const open = new Map();
  const prog = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const pan = [[], [], [], []];
  const chanVol = [[], [], [], []];
  raw.sort((a, b) => a.tick - b.tick);
  for (const e of raw) {
    if (e.prog !== undefined) {
      prog[e.ch] = e.prog;
    } else if (e.cc !== undefined) {
      if (e.ch < 4) {
        if (e.cc === 10) pan[e.ch].push({ t: seconds(e.tick), v: e.val });
        else if (e.cc === 7) chanVol[e.ch].push({ t: seconds(e.tick), v: e.val });
      }
    } else {
      const key = e.ch + ':' + e.note;
      if (e.on) {
        open.set(key, e);
      } else {
        const start = open.get(key);
        if (!start) continue;
        open.delete(key);
        notes.push({
          t0: seconds(start.tick),
          t1: seconds(e.tick),
          ch: e.ch,
          note: start.note,
          vel: start.vel,
          prog: prog[e.ch],
        });
      }
    }
  }
  notes.sort((a, b) => a.t0 - b.t0);
  const dur = notes.reduce((m, n) => Math.max(m, n.t1), 0);
  return { notes, pan, chanVol, dur };
}

function ring(note) {
  return Math.min(0.9, Math.max(0.14, 0.62 * Math.pow(2, -(note - 60) / 22)));
}

export class Sound {
  constructor({ volume = 0.55, mute = false } = {}) {
    this.volume = clamp01(volume);
    this.mute = !!mute;
    this.ctx = null;
    this.master = null;
    this.wave = null;
    this.song = null;
    this.timer = null;
    this.loading = null;
    this.cycleStart = 0;
    this.cursor = 0;
    this.step = 0;
    this.armed = false;
    this.unlocked = false;
    // Every completed gesture counts. iOS Safari is much stricter than a
    // desktop browser about which gesture may start an AudioContext.
    this.gestures = 0;
    // The score is the app's soundtrack, not a wallet-only effect: FROGGER
    // starts it on the first gesture and keeps it across lock/onboarding.
    this.wanted = true;
    this.lastError = '';
    this.resumeError = '';
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (!this.ctx) return;
        if (document.hidden) {
          this.unlocked = false;
          this.ctx.suspend().catch(() => {});
        } else if (!this.mute) {
          this._resume();
          if (this.song && this.wanted) this._transport();
        }
      });
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      // Coming back through the iOS back/forward cache does not necessarily
      // fire visibilitychange. Resuming here is harmless if it is refused;
      // the next completed tap tries again with a real gesture.
      window.addEventListener('pageshow', () => {
        if (!this.ctx || this.mute || document.hidden) return;
        this._resume();
        if (this.song && this.wanted) this._transport();
      });
    }
  }

  // ---- lifecycle ----------------------------------------------------

  arm() {
    this.gestures += 1;
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) {
      this.armed = true;
      return false;
    }
    // A context created by touchstart (not a completed tap on iOS) or whose
    // resume() was refused can stay blocked forever. A later tap builds a
    // fresh context instead of retrying a poisoned one.
    if (this.ctx && (this.ctx.state === 'closed'
      || (this.resumeError && this.ctx.state !== 'running'))) {
      this._discard();
    }
    if (!this.ctx && !this._open()) return false;
    this._resume();
    this._unlock();
    if (!this.mute) {
      this._load();
      if (this.wanted) this._transport();
    }
    return true;
  }

  _open() {
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) {
      this.armed = true;
      return false;
    }
    let ctx = null;
    try {
      ctx = new AC();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.mute ? 0.0001 : gainFor(this.volume);
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.knee.value = 10;
      comp.ratio.value = 3.5;
      comp.attack.value = 0.004;
      comp.release.value = 0.2;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 45;
      hp.Q.value = 0.7;
      const shelf = ctx.createBiquadFilter();
      shelf.type = 'highshelf';
      shelf.frequency.value = 1500;
      shelf.gain.value = 2.5;
      this.master.connect(hp).connect(shelf).connect(comp).connect(ctx.destination);
      this.wave = this._shape();
    } catch (e) {
      this.lastError = e && e.message ? e.message : String(e);
      try { ctx?.close?.(); } catch (_) { /* ignore */ }
      this.ctx = null;
      this.master = null;
      this.wave = null;
      this.armed = true;
      return false;
    }
    // A replaced context has its own currentTime; clear the old transport so
    // the score starts from the new context's zero, not minutes in its past.
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.cycleStart = 0;
    this.cursor = 0;
    this.silent = null;
    this.unlocked = false;
    this.resumeError = '';
    this.armed = true;
    ctx.onstatechange = () => {
      if (this.ctx !== ctx) return;
      if (ctx.state === 'running') {
        this.resumeError = '';
        if (!this.mute) {
          this._load();
          if (this.wanted) this._transport();
        }
      } else {
        this.unlocked = false;
      }
    };
    return true;
  }

  _discard() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const old = this.ctx;
    this.ctx = null;
    this.master = null;
    this.wave = null;
    this.silent = null;
    this.cycleStart = 0;
    this.cursor = 0;
    this.unlocked = false;
    this.resumeError = '';
    this.armed = false;
    if (!old) return;
    try { old.onstatechange = null; } catch (_) { /* ignore */ }
    try {
      const p = old.close();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) { /* ignore */ }
  }

  startLoop() {
    this.wanted = true;
    if (!this.ctx) return;
    this._resume();
    if (!this.mute) this._load();
    this._transport();
  }

  stopLoop() {
    // Pause the transport, but do not turn the soundtrack off. Every
    // gesture arms the player again, so a locked screen, a failed unlock
    // or a wiped wallet cannot silence the app until a reload.
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
  }

  setVolume(v) {
    const next = clamp01(Number(v));
    if (!Number.isFinite(next)) return;
    this.volume = next;
    this._apply();
  }

  setMute(m) {
    this.mute = !!m;
    this._apply();
    if (!this.mute && this.ctx) {
      this._resume();
      this._load();
      if (this.wanted) this._transport();
    }
  }

  _resume() {
    if (!this.ctx || this.ctx.state === 'closed') return;
    // Resume every time, not only for suspended/interrupted: iOS can report
    // "running" while the audio session is actually interrupted. resume()
    // on an already-running context is harmless.
    const ctx = this.ctx;
    let p;
    try {
      p = ctx.resume();
    } catch (e) {
      this.resumeError = e && e.message ? e.message : String(e);
      return;
    }
    if (p && typeof p.then === 'function') {
      p.then(() => {
        if (this.ctx === ctx) this.resumeError = '';
      }, (e) => {
        // A late rejection from a context that was already replaced must not
        // poison the fresh one.
        if (this.ctx === ctx) this.resumeError = e && e.message ? e.message : String(e);
      });
    }
  }

  _unlock() {
    if (!this.ctx || (this.ctx.state === 'running' && this.unlocked)) return;
    // iOS needs an actual source started inside the gesture. A silent buffer
    // is the canonical unlock; it is connected straight to the destination so
    // the app mute/fader cannot turn the unlock itself into a no-op.
    try {
      if (!this.silent) {
        const rate = this.ctx.sampleRate || 44100;
        const frames = Math.max(1, Math.round(rate * 0.05));
        this.silent = this.ctx.createBuffer(1, frames, rate);
      }
      const src = this.ctx.createBufferSource();
      src.buffer = this.silent;
      src.connect(this.ctx.destination);
      src.start(0);
      this.unlocked = true;
    } catch (_) {
      // The music can still start on a browser that does not need the kick.
    }
  }

  _apply(initial = false) {
    if (!this.master || !this.ctx) return;
    const t = this.ctx.currentTime;
    const target = this.mute ? 0.0001 : Math.max(0.0001, gainFor(this.volume));
    try { this.master.gain.cancelScheduledValues(t); } catch (_) { /* ignore */ }
    if (initial) {
      this.master.gain.setValueAtTime(target, t);
      return;
    }
    this.master.gain.setValueAtTime(Math.max(0.0001, this.master.gain.value), t);
    this.master.gain.linearRampToValueAtTime(target, t + 0.12);
  }

  // ---- score --------------------------------------------------------

  _shape() {
    const n = 16;
    const real = new Float32Array(n + 1);
    const imag = new Float32Array(n + 1);
    for (let k = 1; k <= n; k++) {
      // 1/k^1.15 with a small even-harmonic tilt: dark enough to read as
      // struck, bright enough that the score (which lives low) does not
      // turn into a rumble on a phone speaker.
      imag[k] = Math.pow(k, -1.15) * (k % 2 === 0 ? 0.72 : 1);
    }
    return this.ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  }

  _load() {
    if (!this.ctx) return Promise.resolve();
    if (this.song) {
      if (this.wanted) this._transport();
      return Promise.resolve();
    }
    if (this.loading) return this.loading;
    // `no-cache` keeps a stale 404, an SPA fallback page or a half-written
    // file in the HTTP cache from poisoning the score forever.
    this.loading = fetch(MUSIC_URL, { cache: 'no-cache' })
      .then((r) => {
        if (!r.ok) throw new Error('music ' + r.status);
        return r.arrayBuffer();
      })
      .then((b) => {
        this.song = parseMidi(b);
        this.lastError = '';
        if (this.wanted) this._transport();
      })
      .catch((e) => {
        // A transient fetch/parse failure must not poison every later
        // gesture: clear the in-flight promise so the next one retries.
        this.loading = null;
        this.lastError = e && e.message ? e.message : String(e);
        console.warn('hopper: no music —', this.lastError);
      });
    return this.loading;
  }

  _transport() {
    if (!this.song || this.timer || !this.ctx || !this.wanted) return;
    this.cycleStart = this.ctx.currentTime + 0.1;
    this.cursor = 0;
    this.timer = setInterval(() => this._schedule(), TICK);
    this._schedule();
  }

  _schedule() {
    if (!this.ctx || !this.song || this.mute || !this.wanted) return;
    if (this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    // Coming back after a mute or a hidden tab: do not replay from the
    // beginning as a burst — jump to the next loop boundary.
    if (this.cycleStart + this.song.dur < now) {
      this.cycleStart += Math.ceil((now - this.cycleStart) / this.song.dur) * this.song.dur;
      this.cursor = 0;
    }
    const horizon = now + LOOKAHEAD;
    while (this.cursor < this.song.notes.length) {
      const n = this.song.notes[this.cursor];
      const at = this.cycleStart + n.t0;
      if (at > horizon) return;
      if (at >= now - 0.02) this._note(n, at);
      this.cursor += 1;
      if (this.cursor >= this.song.notes.length) {
        this.cursor = 0;
        this.cycleStart += this.song.dur;
      }
    }
  }

  _note(n, at) {
    if (!this.ctx || !this.master || !this.wave) return;
    const f = Hz(n.note);
    if (!Number.isFinite(f) || f < 20 || f > 12000) return;
    const hold = Math.max(0.02, Math.min(0.6, n.t1 - n.t0));
    const life = hold + ring(n.note);
    const peak = 0.22 * Math.pow(n.vel / 127, 1.5) * (n.prog < 8 ? 1 : 0.85);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(peak, at + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, at + life);
    let out = g;
    const p = this._panOf(n.ch, n.t0);
    if (p !== 0) {
      const sp = this.ctx.createStereoPanner();
      sp.pan.value = p;
      g.connect(sp);
      out = sp;
    }
    out.connect(this.master);
    const osc = this.ctx.createOscillator();
    osc.setPeriodicWave(this.wave);
    osc.frequency.value = f;
    osc.detune.value = ((n.note * 37) % 7) - 3;
    osc.connect(g);
    osc.start(at);
    osc.stop(at + life + 0.02);
  }

  _panOf(ch, t) {
    const list = this.song && this.song.pan[ch];
    if (!list || !list.length) return 0;
    let v = list[0].v;
    for (const e of list) {
      if (e.t > t) break;
      v = e.v;
    }
    return (v - 64) / 64;
  }

  // ---- sfx ----------------------------------------------------------

  sfx(name) {
    this.arm();
    if (!this.ctx || this.mute) return;
    const chord = {
      mint: [523, 659, 784],
      cross: [392, 523, 659],
      settle: [440, 554, 659],
      error: [220, 196],
      tap: [660],
      win: [523, 659, 784, 1046],
    }[name] || [440];
    chord.forEach((f, i) => this._sfxNote(f, i * 0.06, 0.18, 0.16, 'square'));
  }

  _sfxNote(freq, start, dur, gain = 0.16, type = 'square') {
    if (!this.ctx || this.mute) return;
    const t = this.ctx.currentTime + Math.max(0, start);
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
    const h = this.ctx.createOscillator();
    const hg = this.ctx.createGain();
    h.type = 'triangle';
    h.frequency.value = freq * 2;
    hg.gain.setValueAtTime(gain * 0.28, t);
    hg.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.8);
    h.connect(hg).connect(this.master);
    h.start(t);
    h.stop(t + dur);
  }

  /** For tests and the console: one glance at the player's state. */
  status() {
    return {
      armed: this.armed,
      unlocked: this.unlocked,
      gestures: this.gestures,
      wanted: this.wanted,
      mute: this.mute,
      volume: this.volume,
      state: this.ctx ? this.ctx.state : 'none',
      rate: this.ctx ? this.ctx.sampleRate : 0,
      notes: this.song ? this.song.notes.length : 0,
      dur: this.song ? this.song.dur : 0,
      timer: !!this.timer,
      error: this.lastError,
      resumeError: this.resumeError,
    };
  }

  /** For tests/probes: the parsed score once loaded (null before). */
  songInfo() {
    return this.song ? { notes: this.song.notes.length, dur: this.song.dur } : null;
  }
}
