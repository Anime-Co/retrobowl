// On-field entity: public fields read by the view + an `ai` bag of internal state. Movement is
// "desired velocity" steering with acceleration limits so players speed up, brake and curve
// plausibly; every AI routine only sets ai.wvx/ai.wvy (+ speed/accel multipliers) each frame.

import { clamp } from '../../core/util.js';
import { TUNING } from './tuning.js';
import { attr, stamina } from './squads.js';

/**
 * @typedef {Object} Entity
 * @property {string} id  slot-based id, unique across both sides ('QB','WR1','DB3','KR','CV4',...)
 * @property {'off'|'def'} side
 * @property {string} pos Position (QB, RB, WR, TE, OL, DL, LB, DB, K)
 * @property {string} slot
 * @property {number} x
 * @property {number} y
 * @property {number} z   jump / dive height (yd)
 * @property {number} vx
 * @property {number} vy
 * @property {{x:number,y:number}} face  unit facing vector (world)
 * @property {string} anim  sprite anim name (idle, run, throw, catch, block, tackle, down, dive, celebrate, kick, stance)
 * @property {number} animT seconds since the anim started
 * @property {number} number
 * @property {object} squad SquadPlayer
 * @property {string} name
 * @property {boolean} hasBall
 * @property {boolean} controlled
 * @property {boolean} down
 * @property {boolean} lunging
 * @property {string|null} blocking id of the player this one is engaged with (either side)
 * @property {string} role  current AI role (informational)
 * @property {number} top   top speed yd/s
 */

/** Speed attribute through the mid-flattening curve (see TUNING.speedCurve). */
export function speedCurve(s) {
  const u = 2 * s - 1;
  return 0.5 + 0.5 * Math.sign(u) * Math.pow(Math.abs(u), TUNING.speedCurve);
}

export function topSpeedFor(sp, pos, weather, isDefense, diff) {
  const [base, span] = TUNING.speed[pos] || TUNING.speed.WR;
  let v = base + span * speedCurve(attr(sp, 'speed', 0.2));
  v *= 1 - TUNING.staminaSpeed * (1 - stamina(sp));
  if (weather === 'snow') v *= TUNING.snowSpeed;
  if (isDefense && diff) v *= diff.defSpeed;
  return v;
}

/** @returns {Entity} */
export function makeEntity(sim, id, side, pos, sp, x, y) {
  const top = topSpeedFor(sp, pos, sim.weather, side === 'def', sim.diff);
  const n = TUNING.histFrames;
  const e = {
    id,
    side,
    pos,
    slot: id,
    x,
    y,
    z: 0,
    vx: 0,
    vy: 0,
    face: { x: side === 'off' ? 1 : -1, y: 0 },
    anim: pos === 'OL' || pos === 'DL' ? 'stance' : 'idle',
    animT: 0,
    number: sp.number ?? 0,
    squad: sp,
    name: sp.name || `#${sp.number ?? 0}`,
    hasBall: false,
    controlled: false,
    down: false,
    lunging: false,
    blocking: null,
    role: 'idle',
    top,
    accel: TUNING.accelBase + TUNING.accelSpan * speedCurve(attr(sp, 'speed', 0.2)),
    ai: {
      wvx: 0,
      wvy: 0,
      speedMult: 1,
      accelMult: 1,
      faceX: 0, // optional forced facing
      faceY: 0,
      downUntil: 0,
      eng: null,
      noEngageUntil: 0,
      stumbleUntil: 0,
      lunge: null,
      lungeReadyAt: 0,
      inRangeT: 0,
      triedBall: -1,
      animHold: 0,
      animHoldName: '',
      hist: new Float64Array(n * 2),
      histN: 0,
      histI: 0,
    },
  };
  for (let i = 0; i < n; i++) {
    e.ai.hist[i * 2] = x;
    e.ai.hist[i * 2 + 1] = y;
  }
  return e;
}

export function pushHist(e) {
  const a = e.ai;
  const n = TUNING.histFrames;
  a.histI = (a.histI + 1) % n;
  a.hist[a.histI * 2] = e.x;
  a.hist[a.histI * 2 + 1] = e.y;
  if (a.histN < n) a.histN += 1;
}

/**
 * Position + velocity as observed `delay` seconds ago (delayed perception for reaction times).
 * @returns {{x:number,y:number,vx:number,vy:number}}
 */
export function observe(e, delay) {
  const a = e.ai;
  const n = TUNING.histFrames;
  const step = TUNING.step;
  const k = clamp(Math.round(delay / step), 0, n - 7);
  const avail = Math.max(0, a.histN - 1);
  const k0 = Math.min(k, avail);
  const k1 = Math.min(k0 + 6, avail);
  const i0 = (a.histI - k0 + n * 4) % n;
  const i1 = (a.histI - k1 + n * 4) % n;
  const x = a.hist[i0 * 2];
  const y = a.hist[i0 * 2 + 1];
  const dt = (k1 - k0) * step;
  if (dt <= 0) return { x, y, vx: e.vx, vy: e.vy };
  return { x, y, vx: (x - a.hist[i1 * 2]) / dt, vy: (y - a.hist[i1 * 2 + 1]) / dt };
}

/** Desired velocity toward a point with arrival slow-down. */
export function seek(e, tx, ty, frac = 1, slowR = 1.2) {
  const dx = tx - e.x;
  const dy = ty - e.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) {
    e.ai.wvx = 0;
    e.ai.wvy = 0;
    return 0;
  }
  const s = e.top * frac * Math.min(1, d / slowR);
  e.ai.wvx = (dx / d) * s;
  e.ai.wvy = (dy / d) * s;
  return d;
}

/** Desired velocity toward a point at full (fractional) speed, no arrival slow-down. */
export function chase(e, tx, ty, frac = 1) {
  return seek(e, tx, ty, frac, 0.01);
}

export function stop(e) {
  e.ai.wvx = 0;
  e.ai.wvy = 0;
}

/** Integrate one step with acceleration limits. */
export function integrate(e, dt) {
  const a = e.ai;
  let wvx = a.wvx;
  let wvy = a.wvy;
  const cap = e.top * a.speedMult;
  const ws = Math.hypot(wvx, wvy);
  if (ws > cap && ws > 1e-9) {
    wvx *= cap / ws;
    wvy *= cap / ws;
  }
  const dvx = wvx - e.vx;
  const dvy = wvy - e.vy;
  const dl = Math.hypot(dvx, dvy);
  if (dl > 1e-9) {
    const cur2 = e.vx * e.vx + e.vy * e.vy;
    const braking = wvx * e.vx + wvy * e.vy < cur2 * 0.98;
    const acc = e.accel * a.accelMult * (braking ? TUNING.decelMult : 1);
    const m = acc * dt;
    if (dl <= m) {
      e.vx = wvx;
      e.vy = wvy;
    } else {
      e.vx += (dvx / dl) * m;
      e.vy += (dvy / dl) * m;
    }
  }
  e.x += e.vx * dt;
  e.y += e.vy * dt;
  const sp = Math.hypot(e.vx, e.vy);
  if (a.faceX || a.faceY) {
    const l = Math.hypot(a.faceX, a.faceY);
    e.face.x = a.faceX / l;
    e.face.y = a.faceY / l;
  } else if (sp > 0.4) {
    e.face.x = e.vx / sp;
    e.face.y = e.vy / sp;
  }
}

/** Set the sprite animation, resetting animT on change. */
export function setAnim(e, name) {
  if (e.anim !== name) {
    e.anim = name;
    e.animT = 0;
  }
}

/** Hold an animation for `dur` seconds (throw, catch, kick, celebrate...). */
export function holdAnim(e, name, dur, now) {
  e.ai.animHoldName = name;
  e.ai.animHold = now + dur;
  setAnim(e, name);
}

export const speedOf = (e) => Math.hypot(e.vx, e.vy);
export const distE = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
