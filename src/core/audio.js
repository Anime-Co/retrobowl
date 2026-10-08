// Procedural chiptune SFX via WebAudio (no audio files, no copyrighted music).
// API: audio.play(name, opts?) where name is one of SFX keys below; audio.setEnabled(bool);
// audio.unlock() must be called from a user gesture (done automatically on first pointerdown).
// The presentation module may extend SFX with more sounds; keep names stable.

export class Audio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.musicEnabled = true;
    this.master = null;
    this._crowd = null;
    const unlock = () => this.unlock();
    window.addEventListener('pointerdown', unlock, { once: false, passive: true });
    window.addEventListener('keydown', unlock, { once: false });
  }

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
    }
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!on) this.stopCrowd();
  }

  /** Short tone helper. */
  tone({ freq = 440, to = null, dur = 0.1, type = 'square', vol = 0.25, delay = 0 }) {
    const c = this.ctx;
    if (!c || !this.enabled) return;
    const t0 = c.currentTime + delay;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (to) o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.master);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  noise({ dur = 0.15, vol = 0.3, delay = 0, filter = 1200, q = 0.7, type = 'lowpass' }) {
    const c = this.ctx;
    if (!c || !this.enabled) return;
    const t0 = c.currentTime + delay;
    const len = Math.max(1, Math.floor(c.sampleRate * dur));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.value = filter;
    f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t0);
  }

  play(name, opts = {}) {
    if (!this.ctx || !this.enabled) return;
    const fn = SFX[name];
    if (fn) fn(this, opts);
  }

  startCrowd() {
    // Low filtered noise bed; gain raised by cheer().
    const c = this.ctx;
    if (!c || !this.enabled || this._crowd) return;
    const len = c.sampleRate * 2;
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 700;
    f.Q.value = 0.5;
    const g = c.createGain();
    g.gain.value = 0.035;
    src.connect(f).connect(g).connect(this.master);
    src.start();
    this._crowd = { src, g };
  }

  cheer(level = 1, dur = 1.5) {
    if (!this._crowd || !this.ctx) return;
    const g = this._crowd.g.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0.035 + 0.12 * level, t + 0.15);
    g.linearRampToValueAtTime(0.035, t + dur);
  }

  stopCrowd() {
    if (this._crowd) {
      try { this._crowd.src.stop(); } catch { /* ignore */ }
      this._crowd = null;
    }
  }
}

/** Sound recipes. Keep names stable; other modules call these. */
export const SFX = {
  click: (a) => a.tone({ freq: 660, dur: 0.05, vol: 0.12 }),
  select: (a) => { a.tone({ freq: 523, dur: 0.06, vol: 0.12 }); a.tone({ freq: 784, dur: 0.08, vol: 0.12, delay: 0.06 }); },
  back: (a) => a.tone({ freq: 392, to: 262, dur: 0.1, vol: 0.12 }),
  whistle: (a) => { a.tone({ freq: 2300, dur: 0.28, type: 'sine', vol: 0.18 }); a.tone({ freq: 2500, dur: 0.2, type: 'sine', vol: 0.08, delay: 0.02 }); },
  hike: (a) => a.tone({ freq: 180, to: 120, dur: 0.12, type: 'sawtooth', vol: 0.15 }),
  throw: (a) => a.noise({ dur: 0.18, vol: 0.18, filter: 2500, type: 'bandpass', q: 1.5 }),
  catch: (a) => { a.tone({ freq: 330, dur: 0.05, vol: 0.2 }); a.noise({ dur: 0.05, vol: 0.2, filter: 800 }); },
  hit: (a, o) => { a.noise({ dur: 0.16, vol: 0.35 * (o.power || 1), filter: 500 }); a.tone({ freq: 90, to: 50, dur: 0.15, type: 'triangle', vol: 0.3 }); },
  juke: (a) => a.tone({ freq: 880, to: 1320, dur: 0.07, vol: 0.12 }),
  dive: (a) => a.tone({ freq: 520, to: 260, dur: 0.18, vol: 0.12 }),
  kick: (a) => { a.noise({ dur: 0.1, vol: 0.35, filter: 600 }); a.tone({ freq: 140, to: 70, dur: 0.12, type: 'triangle', vol: 0.3 }); },
  incomplete: (a) => a.tone({ freq: 300, to: 200, dur: 0.25, vol: 0.12 }),
  firstdown: (a) => [523, 659, 784].forEach((f, i) => a.tone({ freq: f, dur: 0.08, vol: 0.14, delay: i * 0.07 })),
  touchdown: (a) => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => a.tone({ freq: f, dur: 0.12, vol: 0.16, delay: i * 0.1 })),
  bad: (a) => [392, 330, 262].forEach((f, i) => a.tone({ freq: f, dur: 0.14, vol: 0.14, delay: i * 0.12 })),
  good: (a) => [659, 988].forEach((f, i) => a.tone({ freq: f, dur: 0.1, vol: 0.14, delay: i * 0.08 })),
  coin: (a) => { a.tone({ freq: 988, dur: 0.06, vol: 0.12 }); a.tone({ freq: 1319, dur: 0.18, vol: 0.12, delay: 0.06 }); },
  buzzer: (a) => a.tone({ freq: 110, dur: 0.6, type: 'sawtooth', vol: 0.2 }),
};
