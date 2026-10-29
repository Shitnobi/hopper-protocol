// Tiny chip soundtrack + SFX. Nothing sounds before a user gesture.
// Gain law: 0.5 * volume^2 (SPEC §5.4); mute always wins.

export class Sound {
  constructor({ volume = 0.55, mute = false } = {}) {
    this.volume = volume;
    this.mute = mute;
    this.ctx = null;
    this.master = null;
    this.timer = null;
    this.step = 0;
    this.armed = false;
  }

  setVolume(v) { this.volume = Math.max(0, Math.min(1, Number(v))); this._apply(); }
  setMute(m) { this.mute = !!m; this._apply(); }

  _apply() {
    if (!this.master || !this.ctx) return;
    const g = this.mute ? 0 : 0.5 * this.volume * this.volume;
    this.master.gain.setTargetAtTime(g, this.ctx.currentTime, 0.02);
  }

  arm() {
    if (this.armed) return;
    this.armed = true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 3.5;
    const shelf = this.ctx.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 1500;
    shelf.gain.value = 2.5;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 45;
    this.master.connect(hp).connect(shelf).connect(comp).connect(this.ctx.destination);
    this._apply();
    this.startLoop();
  }

  note(freq, start, dur, gain = 0.22, type = 'square') {
    if (!this.ctx || this.mute) return;
    const t = this.ctx.currentTime + start;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    // 4 ms attack, pitch-dependent decay; a small harmonic stack.
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

  startLoop() {
    if (this.timer || !this.ctx) return;
    // A two-bar hopper tune at 112 BPM (16th notes, 134 ms).
    const melody = [
      392, 0, 523, 0, 587, 0, 523, 0, 392, 0, 349, 0, 392, 0, 0, 0,
      440, 0, 523, 0, 659, 0, 587, 0, 523, 0, 440, 0, 392, 0, 0, 0,
    ];
    const bass = [98, 0, 0, 0, 131, 0, 0, 0, 87, 0, 0, 0, 98, 0, 0, 0,
      110, 0, 0, 0, 131, 0, 0, 0, 98, 0, 0, 0, 87, 0, 0, 0];
    const tick = 0.134;
    this.timer = setInterval(() => {
      if (!this.ctx || this.mute) { this.step = (this.step + 1) % melody.length; return; }
      const f = melody[this.step];
      if (f) this.note(f, 0, 0.12, 0.10, 'square');
      const b = bass[this.step];
      if (b) this.note(b, 0, 0.22, 0.07, 'triangle');
      this.step = (this.step + 1) % melody.length;
    }, tick * 1000);
  }

  sfx(name) {
    this.arm();
    if (!this.ctx) return;
    const chord = {
      mint: [523, 659, 784],
      cross: [392, 523, 659],
      settle: [440, 554, 659],
      error: [220, 196],
      tap: [660],
      win: [523, 659, 784, 1046],
    }[name] || [440];
    chord.forEach((f, i) => this.note(f, i * 0.06, 0.18, 0.09, 'square'));
  }
}
