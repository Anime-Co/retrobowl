// Cosmetic on-field effects: particle bursts (turf, hits, confetti, sparks), floating text pops
// and full-screen flashes. World-space (yards) like the sprites; Math.random is fine here because
// nothing in this module affects game logic.

import { drawText } from './font.js';

const GRAVITY = 26; // yd/s^2 for debris

const KINDS = {
  turf: {
    n: 9, life: [0.35, 0.6], speed: [1.5, 4], up: [3, 6.5], g: GRAVITY, drag: 1.5, size: [1, 1],
    colors: ['#2f7d39', '#46a854', '#255f2c', '#6b4a2a', '#8a6a3a'],
  },
  hit: {
    n: 10, life: [0.18, 0.36], speed: [4, 9], up: [1, 4], g: 8, drag: 5, size: [1, 2],
    colors: ['#ffffff', '#fff3b0', '#ffd23a'],
  },
  confetti: {
    n: 70, life: [2.2, 3.6], speed: [2, 7], up: [3, 9], g: 3.2, drag: 1.8, size: [1, 2], z0: [1.5, 5],
    colors: ['#ff4d6d', '#ffd23a', '#3fa7ff', '#5fd068', '#ffffff', '#c77dff', '#ff9f1c'],
  },
  spark: {
    n: 7, life: [0.12, 0.25], speed: [5, 11], up: [0, 3], g: 0, drag: 7, size: [1, 1],
    colors: ['#ffffff', '#ffe066'],
  },
};

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

export class Fx {
  constructor() {
    /** @type {any[]} */
    this.parts = [];
    /** @type {any[]} */
    this.pops = [];
    this.flashColor = '#fff';
    this.flashT = 0;
    this.flashDur = 0;
    this.time = 0;
    this.maxParts = 600;
  }

  /**
   * Spawn a burst of particles at world (x, y) on the turf.
   * @param {number} x
   * @param {number} y
   * @param {{kind?:'turf'|'hit'|'confetti'|'spark', n?:number, z?:number, colors?:string[]}} [opts]
   */
  burst(x, y, opts = {}) {
    const kind = KINDS[opts.kind] ? opts.kind : 'turf';
    const K = KINDS[kind];
    const n = Math.max(0, Math.round(opts.n != null ? opts.n : K.n));
    const colors = opts.colors || K.colors;
    for (let i = 0; i < n; i++) {
      if (this.parts.length >= this.maxParts) this.parts.shift();
      const a = Math.random() * Math.PI * 2;
      const sp = rand(K.speed[0], K.speed[1]);
      const life = rand(K.life[0], K.life[1]);
      this.parts.push({
        kind,
        x, y,
        z: opts.z != null ? opts.z : K.z0 ? rand(K.z0[0], K.z0[1]) : rand(0, 0.4),
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        vz: rand(K.up[0], K.up[1]),
        g: K.g,
        drag: K.drag,
        life,
        max: life,
        size: Math.round(rand(K.size[0], K.size[1])),
        color: pick(colors),
        phase: Math.random() * 6.28,
        spin: rand(6, 14),
      });
    }
  }

  /**
   * Floating text at world (x, y) that rises and fades (e.g. "+12 YDS", "TOUCHDOWN!").
   * @param {number} x
   * @param {number} y
   * @param {string} text
   * @param {{color?:string, size?:'small'|'big', dur?:number, scale?:number, z?:number}} [opts]
   */
  pop(x, y, text, opts = {}) {
    this.pops.push({
      x, y, text: String(text),
      z: opts.z != null ? opts.z : 1.8,
      color: opts.color || '#ffffff',
      size: opts.size === 'small' ? 'small' : 'big',
      scale: opts.scale || 1,
      dur: opts.dur || 1.1,
      t: 0,
    });
    if (this.pops.length > 24) this.pops.shift();
  }

  /**
   * Full-screen colour flash that fades out.
   * @param {string} [color='#ffffff']
   * @param {number} [dur=0.18]
   */
  flash(color = '#ffffff', dur = 0.18) {
    this.flashColor = color;
    this.flashDur = Math.max(0.01, dur);
    this.flashT = this.flashDur;
  }

  /** @param {number} dt seconds */
  update(dt) {
    this.time += dt;
    const ps = this.parts;
    let w = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      p.life -= dt;
      if (p.life <= 0) continue;
      const k = Math.exp(-p.drag * dt);
      p.vx *= k;
      p.vy *= k;
      p.vz -= p.g * dt;
      if (p.kind === 'confetti') {
        // terminal velocity + flutter
        if (p.vz < -1.6) p.vz = -1.6;
        p.x += Math.sin(this.time * 3 + p.phase) * dt * 1.2;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.z < 0) {
        p.z = 0;
        if (p.kind === 'confetti') { p.vz = 0; p.vx *= 0.2; p.vy *= 0.2; p.g = 0; } else { p.vz *= -0.3; p.vx *= 0.5; p.vy *= 0.5; }
      }
      ps[w++] = p;
    }
    ps.length = w;
    let j = 0;
    for (let i = 0; i < this.pops.length; i++) {
      const p = this.pops[i];
      p.t += dt;
      if (p.t < p.dur) this.pops[j++] = p;
    }
    this.pops.length = j;
    if (this.flashT > 0) this.flashT = Math.max(0, this.flashT - dt);
  }

  /**
   * Draw particles, pops and the flash overlay.
   * @param {CanvasRenderingContext2D} ctx
   * @param {import('./camera.js').Camera} camera
   */
  render(ctx, camera) {
    const prev = ctx.globalAlpha;
    for (const p of this.parts) {
      const s = camera.toScreen(p.x, p.y, p.z);
      const x = Math.round(s.x);
      const y = Math.round(s.y);
      if (x < -4 || y < -4 || x > camera.viewW + 4 || y > camera.viewH + 4) continue;
      const f = p.life / p.max;
      if (p.kind === 'confetti') {
        ctx.globalAlpha = prev * Math.min(1, f * 3);
        ctx.fillStyle = p.color;
        const flip = Math.sin(this.time * p.spin + p.phase) > 0;
        if (flip) ctx.fillRect(x, y, 2, 1); else ctx.fillRect(x, y, 1, 2);
      } else if (p.kind === 'hit' || p.kind === 'spark') {
        ctx.globalAlpha = prev * Math.min(1, f * 2);
        ctx.fillStyle = p.color;
        ctx.fillRect(x, y, p.size, p.size);
        if (p.kind === 'hit' && f > 0.5) {
          // streak toward the motion direction
          const t = camera.toScreen(p.x - p.vx * 0.03, p.y - p.vy * 0.03, p.z - p.vz * 0.03);
          ctx.fillRect(Math.round(t.x), Math.round(t.y), 1, 1);
        }
      } else {
        ctx.globalAlpha = prev * Math.min(1, f * 2.5);
        ctx.fillStyle = p.color;
        ctx.fillRect(x, y, p.size, p.size);
      }
    }
    ctx.globalAlpha = prev;
    for (const p of this.pops) {
      const k = p.t / p.dur;
      const rise = 1 - (1 - Math.min(1, k * 1.6)) ** 3; // ease-out
      const s = camera.toScreen(p.x, p.y, p.z + rise * 1.6);
      // blink out during the last 25%
      if (k > 0.75 && Math.floor(p.t * 16) % 2) continue;
      drawText(ctx, p.text, Math.round(s.x), Math.round(s.y), {
        size: p.size, scale: p.scale, color: p.color, align: 'center', shadow: '#10121a',
      });
    }
    if (this.flashT > 0) {
      ctx.globalAlpha = prev * 0.65 * (this.flashT / this.flashDur);
      ctx.fillStyle = this.flashColor;
      ctx.fillRect(0, 0, camera.viewW, camera.viewH);
      ctx.globalAlpha = prev;
    }
  }

  /** Remove every particle, pop and flash. */
  clear() {
    this.parts.length = 0;
    this.pops.length = 0;
    this.flashT = 0;
  }

  /** Number of live particles + pops (for tooling/tests). */
  get count() {
    return this.parts.length + this.pops.length;
  }
}
