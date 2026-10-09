// Animated pixel backdrop for the title screen: a scrolling strip of turf with a looping pass
// play (snap, drop back, deep throw, catch, chase, tackle) between two random clubs. Drawn into a
// small canvas and integer-scaled with nearest-neighbour sampling. Purely cosmetic (Math.random
// is fine here).

import { drawPlayer, drawBall } from '../../render/sprites.js';
import { drawText } from '../../render/font.js';
import { FIELD_COLORS } from '../../render/field.js';
import { TEAM_TEMPLATES } from '../../data/teams.js';

const PERIOD = 7.6;
const SNAP = 0.9;
const THROW = 2.0;
const CATCH = 3.2;
const TACKLE = 5.7;

const lookOf = (t) => ({ abbr: t.abbr, city: t.city, primary: t.primary, secondary: t.secondary, helmet: t.helmet });
const ease = (k) => k * k * (3 - 2 * k);
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function pickTeams() {
  const a = Math.floor(Math.random() * TEAM_TEMPLATES.length);
  let b = Math.floor(Math.random() * TEAM_TEMPLATES.length);
  if (b === a) b = (b + 7) % TEAM_TEMPLATES.length;
  return [lookOf(TEAM_TEMPLATES[a]), lookOf(TEAM_TEMPLATES[b])];
}

export class FieldBackdrop {
  /** @param {HTMLCanvasElement} canvas @param {{still?:boolean, focusY?:number}} [opts] */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.still = !!opts.still;
    this.autoFocus = opts.focusY == null;
    this.focusY = opts.focusY ?? 0.36; // where the play happens, as a fraction of the height
    this.t = this.still ? 3.6 : 0.2;
    this.loops = 0;
    [this.off, this.def] = pickTeams();
    this.camX = 40;
    this.w = 0;
    this.h = 0;
    this.ppy = 7;
    this.resize();
  }

  resize() {
    const parent = this.canvas.parentElement;
    const r = parent ? parent.getBoundingClientRect() : { width: innerWidth, height: innerHeight };
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const physW = Math.max(1, Math.round(r.width * dpr));
    const physH = Math.max(1, Math.round(r.height * dpr));
    const s = Math.max(1, Math.round(Math.min(physW, physH) / 190));
    this.w = Math.ceil(physW / s);
    this.h = Math.ceil(physH / s);
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.canvas.style.width = `${(this.w * s) / dpr}px`;
    this.canvas.style.height = `${(this.h * s) / dpr}px`;
    this.ppy = Math.max(5, Math.round(Math.min(this.w, this.h * 1.6) / 34));
    if (this.autoFocus) this.focusY = this.w > this.h ? 0.5 : 0.36;
    this.ctx.imageSmoothingEnabled = false;
    this.draw();
  }

  frame(dt) {
    if (this.still) return;
    this.t += Math.min(dt, 0.1);
    if (this.t >= PERIOD) {
      this.t -= PERIOD;
      this.loops += 1;
      [this.off, this.def] = pickTeams();
    }
    this.draw();
  }

  /** Entities for scene time t (world yards; y = 0 is the play's centre row). */
  scene(t) {
    const los = 30;
    const live = t >= SNAP;
    const ts = Math.max(0, t - SNAP);
    const ents = [];
    const O = this.off;
    const D = this.def;
    // Lines
    for (let i = -2; i <= 2; i++) {
      const push = live ? Math.min(0.8, ts * 1.2) : 0;
      ents.push({ look: O, x: los - 0.8 + push, y: i * 1.3, face: 'right', anim: live ? 'block' : 'stance', at: ts, skin: (i + 5) % 5 });
      if (i !== 0 && Math.abs(i) <= 2) ents.push({ look: D, x: los + 0.9 + push, y: i * 1.3 + 0.4, face: 'left', anim: live ? 'block' : 'stance', at: ts, skin: (i + 8) % 5 });
    }
    // QB: drop back, throw
    const drop = live ? ease(clamp01(ts / 0.8)) : 0;
    const qbX = los - 3 - drop * 3.5;
    const throwing = t >= THROW - 0.25 && t < THROW + 0.5;
    ents.push({ look: O, x: qbX, y: 0, face: live && ts < 0.8 ? 'left' : 'right', anim: throwing ? 'throw' : live && ts < 0.8 ? 'run' : 'idle', at: throwing ? t - (THROW - 0.25) : t, skin: 1, qb: true });
    // RB swings to the flat
    const rbK = live ? clamp01(ts / 2.2) : 0;
    ents.push({ look: O, x: los - 5 + rbK * 6, y: 2.2 + rbK * 6, face: live ? 'right' : 'right', anim: live && rbK < 1 ? 'run' : 'idle', at: t, skin: 3 });
    // WR go route and the catch-and-run
    const wr = this.receiverAt(t, los);
    const caught = t >= CATCH;
    const down = t >= TACKLE;
    ents.push({ look: O, x: wr.x, y: wr.y, face: 'right', anim: down ? 'down' : live ? (caught && t < CATCH + 0.2 ? 'catch' : 'run') : 'stance', at: down ? t - TACKLE : t, skin: 2, carrier: caught });
    // DB in chase, closing slowly and diving at the end
    const dbStart = { x: los + 7, y: -7.5 };
    const dbK = live ? ts : 0;
    const dbX = live ? Math.min(wr.x - 1.2 + Math.max(0, (TACKLE - t)) * 0.9, dbStart.x + dbK * 7.6) : dbStart.x;
    const dbY = live ? wr.y + 1.4 * (1 - clamp01((t - CATCH) / 2.4)) : dbStart.y;
    ents.push({ look: D, x: down ? wr.x - 0.6 : dbX, y: down ? wr.y + 0.3 : dbY, face: live ? 'right' : 'left', anim: down ? 'tackle' : live ? 'run' : 'stance', at: down ? t - TACKLE : t, skin: 4 });
    // LB reading the play
    const lbK = live ? clamp01(ts / 3) : 0;
    ents.push({ look: D, x: los + 5 + lbK * 9, y: 1.5 - lbK * 6, face: 'right', anim: live ? 'run' : 'stance', at: t + 0.3, skin: 0 });
    return { ents, los, wr, qbX };
  }

  receiverAt(t, los) {
    const ts = Math.max(0, t - SNAP);
    const x0 = los - 0.4;
    const y0 = -9;
    if (t < SNAP) return { x: x0, y: y0 };
    const speed = 8.2;
    const x = x0 + ts * speed;
    const weave = t > CATCH ? Math.sin((t - CATCH) * 3.2) * 1.2 : 0;
    const tackleT = Math.min(t, TACKLE);
    const xs = x0 + (tackleT - SNAP) * speed + (t > TACKLE ? Math.min(0.8, (t - TACKLE) * 3) : 0);
    return { x: t > TACKLE ? xs : x, y: y0 + weave + (t > CATCH ? (t - CATCH) * 0.6 : 0) };
  }

  ballAt(t, s) {
    if (t < THROW) return { holder: 'qb' };
    if (t >= CATCH) return { holder: 'wr' };
    const k = (t - THROW) / (CATCH - THROW);
    const from = { x: s.qbX + 0.4, y: 0 };
    const to = this.receiverAt(CATCH, s.los);
    return { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k, z: 1.8 + Math.sin(Math.PI * k) * 5.5, angle: 0 };
  }

  draw() {
    const { ctx, w, h, ppy } = this;
    if (!w || !h) return;
    const t = this.t;
    const s = this.scene(t);
    const ball = this.ballAt(t, s);
    const focus = ball.holder === 'wr' ? s.wr.x : ball.holder === 'qb' ? s.los + 2 : ball.x;
    const target = focus + (ball.holder === 'wr' ? 3 : 4);
    const lerp = this.still ? 1 : 0.06;
    this.camX += (target - this.camX) * lerp;
    if (t < 0.25 && !this.still) this.camX = s.los + 3;
    const yScale = 0.78;
    const cy = Math.round(h * this.focusY);
    const sx = (x) => Math.round((x - this.camX) * ppy + w / 2);
    const sy = (y) => Math.round(cy + y * ppy * yScale);
    const C = FIELD_COLORS;

    // Turf bands every 5 yards
    const x0 = Math.floor((this.camX - w / 2 / ppy) / 5) * 5 - 5;
    const x1 = this.camX + w / 2 / ppy + 5;
    for (let x = x0; x < x1; x += 5) {
      ctx.fillStyle = Math.round(x / 5) % 2 === 0 ? C.turfA : C.turfB;
      ctx.fillRect(sx(x), 0, Math.ceil(5 * ppy) + 1, h);
    }
    // Yard lines, hashes and numbers
    ctx.fillStyle = C.line;
    for (let x = x0; x < x1; x += 5) ctx.fillRect(sx(x), 0, 1, h);
    const hashRows = [sy(-6), sy(6), sy(-24), sy(24)];
    for (let x = x0; x < x1; x += 1) {
      if (x % 5 === 0) continue;
      for (const hy of hashRows) ctx.fillRect(sx(x), hy, 1, 2);
    }
    for (let x = Math.ceil(x0 / 10) * 10; x < x1; x += 10) {
      const yard = ((x % 100) + 100) % 100;
      const label = String(yard <= 50 ? yard : 100 - yard);
      if (label === '0') continue;
      for (const ny of w < h ? [sy(15)] : [sy(-15), sy(15)]) drawText(ctx, label, sx(x), ny, { size: 'big', color: 'rgba(244,244,238,0.85)', align: 'center' });
    }
    // Line of scrimmage
    ctx.fillStyle = C.los;
    ctx.fillRect(sx(s.los), sy(-11), 1, sy(11) - sy(-11));

    // Players back to front
    const ents = s.ents.slice().sort((a, b) => a.y - b.y);
    for (const e of ents) {
      drawPlayer(ctx, sx(e.x), sy(e.y), e.look, { facing: e.face, anim: e.anim, t: e.at, skin: e.skin, time: t });
      if (e.carrier && ball.holder === 'wr' && t < TACKLE) drawBall(ctx, sx(e.x) + 3, sy(e.y) - 1, 0.9, { ppy, shadow: false, spinning: false });
    }
    if (ball.holder === 'qb' && t < THROW - 0.2) drawBall(ctx, sx(s.qbX) + 3, sy(0) - 1, 1.1, { ppy, shadow: false, spinning: false });
    if (ball.x != null) drawBall(ctx, sx(ball.x), sy(ball.y), ball.z, { ppy, spin: t, angle: -0.3 });

    // Fade between loops
    const fade = t < 0.35 ? 1 - t / 0.35 : t > PERIOD - 0.35 ? (t - (PERIOD - 0.35)) / 0.35 : 0;
    if (fade > 0 && !this.still) {
      ctx.fillStyle = `rgba(5,6,10,${Math.min(1, fade).toFixed(2)})`;
      ctx.fillRect(0, 0, w, h);
    }
  }
}
