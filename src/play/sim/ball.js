// Passing: aim (slingshot target -> predicted 3D arc), release with accuracy scatter, ballistic
// flight (lob vs bullet), and catch / drop / deflect / interception resolution (MECHANICS 2.4-2.6).

import { clamp } from '../../core/util.js';
import { FIELD, TUNING } from './tuning.js';
import { attr, endurance, skill } from './squads.js';

const P = TUNING.pass;
const C = TUNING.catch;

/** Effective QB arm 0..1 (fades late in the game with low stamina). */
export function effectiveArm(sim, qb) {
  const arm = attr(qb.squad, 'arm', 0.2);
  const prog = clamp(sim.setup.gameProgress ?? 0, 0, 1);
  return arm * (1 - P.armFade * prog * (1 - endurance(qb.squad)));
}

/** Max air distance (yd) from the QB: [D] 22 + 4 * arm(1..10). */
export function maxThrowDist(sim, qb) {
  return P.maxDistBase + P.maxDistSpan * effectiveArm(sim, qb);
}

/** Fraction of the arc the player can see (accuracy, difficulty trim). */
export function visibleFrac(sim, qb) {
  const acc = attr(qb.squad, 'accuracy', 0.2);
  return clamp(P.visBase + P.visSpan * acc - sim.diff.arcTrim, 0.15, 1);
}

/** Horizontal ball speed for a throw of `dist` yards. */
export function ballSpeed(dist, bullet, arm) {
  const k = P.armSpeedBase + P.armSpeedSpan * arm;
  return (bullet ? P.bulletBase + P.bulletPerYd * dist : P.lobBase + P.lobPerYd * dist) * k;
}

/**
 * Plan a throw from (fx,fy) to land head-high at (tx,ty).
 * @returns {{T:number, vx:number, vy:number, vz:number, g:number, z0:number, dist:number}}
 */
export function planThrow(fx, fy, tx, ty, bullet, arm) {
  const dx = tx - fx;
  const dy = ty - fy;
  const dist = Math.hypot(dx, dy);
  const vh = ballSpeed(dist, bullet, arm);
  const T = Math.max(P.minFlight, dist / vh);
  const g = bullet ? P.bulletGravity : P.gravity;
  const z0 = P.releaseZ;
  const vz = (P.arriveZ - z0 + 0.5 * g * T * T) / T;
  return { T, vx: dx / T, vy: dy / T, vz, g, z0, dist };
}

/** Sample a planned throw into a path of {x,y,z} points (0..T inclusive). */
export function samplePath(fx, fy, plan, n = P.pathSamples) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = (plan.T * i) / n;
    pts.push({ x: fx + plan.vx * t, y: fy + plan.vy * t, z: plan.z0 + plan.vz * t - 0.5 * plan.g * t * t });
  }
  return pts;
}

/** Where the ball leaves the QB's hand. */
export function releasePoint(qb) {
  return { x: qb.x + qb.face.x * 0.3, y: qb.y + qb.face.y * 0.3 };
}

/**
 * Build / refresh sim.aim for a target. Clamps to arm range.
 */
export function computeAim(sim, qb, tx, ty, runMode, bullet) {
  const maxDist = maxThrowDist(sim, qb);
  const rp = releasePoint(qb);
  let dx = tx - rp.x;
  let dy = ty - rp.y;
  let d = Math.hypot(dx, dy);
  if (!Number.isFinite(d)) {
    dx = 1;
    dy = 0;
    d = 1;
  }
  if (d > maxDist) {
    dx *= maxDist / d;
    dy *= maxDist / d;
    d = maxDist;
  }
  const ax = rp.x + dx;
  const ay = rp.y + dy;
  const valid = !runMode && d >= P.minThrow;
  const arm = effectiveArm(sim, qb);
  const plan = planThrow(rp.x, rp.y, ax, ay, bullet, arm);
  const vf = visibleFrac(sim, qb);
  return {
    tx: ax,
    ty: ay,
    valid,
    runMode: !!runMode,
    bullet: !!bullet,
    path: runMode ? [] : samplePath(rp.x, rp.y, plan),
    visibleFrac: vf,
    showMarker: vf >= 0.999,
    maxDist,
    dist: d,
    flightTime: plan.T,
    clamped: Math.hypot(tx - rp.x, ty - rp.y) > maxDist + 1e-6,
  };
}

/** Accuracy scatter radius (yd) for a throw. */
export function scatterRadius(sim, qb, dist, bullet, pressured) {
  const acc = attr(qb.squad, 'accuracy', 0.2);
  let r = P.scatterMax - (P.scatterMax - P.scatterMin) * acc;
  r *= 0.55 + dist / (2 * P.scatterDistRef);
  if (bullet) r *= P.bulletScatter;
  if (pressured) r *= P.scatterPressure;
  return r;
}

/** Launch the ball along a planned throw. */
export function launchBall(sim, fx, fy, plan, bullet, tipped = false) {
  const b = sim.ball;
  b.state = tipped ? 'loose' : 'air';
  b.holder = null;
  b.bullet = !!bullet;
  b.x0 = fx;
  b.y0 = fy;
  b.z0 = plan.z0;
  b.fvx = plan.vx;
  b.fvy = plan.vy;
  b.fvz = plan.vz;
  b.g = plan.g;
  b.ft = 0;
  b.T = plan.T;
  b.x = fx;
  b.y = fy;
  b.z = plan.z0;
  b.vx = plan.vx;
  b.vy = plan.vy;
  b.vz = plan.vz;
  b.serial = (b.serial || 0) + 1;
  b.tipped = tipped;
}

/** Ball position at flight time ft (current launch). */
export function ballAt(b, ft) {
  return { x: b.x0 + b.fvx * ft, y: b.y0 + b.fvy * ft, z: b.z0 + b.fvz * ft - 0.5 * b.g * ft * ft };
}

/** Advance a flying ball one step. */
export function stepBall(b, dt) {
  b.ft += dt;
  const p = ballAt(b, b.ft);
  b.x = p.x;
  b.y = p.y;
  b.z = p.z;
  b.vx = b.fvx;
  b.vy = b.fvy;
  b.vz = b.fvz - b.g * b.ft;
}

// DL only bat balls at the line (resolved at release); they never pick passes out of the air
export const isEligible = (p) => (p.side === 'def' ? p.pos !== 'DL' && p.pos !== 'K' : p.pos === 'WR' || p.pos === 'TE' || p.pos === 'RB');

export function reachOf(p) {
  if (p.side === 'off') return C.offReachBase + C.offReachSpan * attr(p.squad, 'hands', 0.2);
  const skill = p.pos === 'DL' ? 0.5 * attr(p.squad, 'passRush', 0.2) : attr(p.squad, 'coverage', 0.2);
  return C.defReachBase + C.defReachSpan * skill;
}

/** Closest horizontal approach between a player (moving linearly) and the ball over the look-ahead. */
function closestApproach(b, p) {
  let best = Math.hypot(p.x - b.x, p.y - b.y);
  const n = 6;
  for (let i = 1; i <= n; i++) {
    const tau = (C.lookAheadT * i) / n;
    const q = ballAt(b, b.ft + tau);
    if (q.z < C.groundZ || q.z > C.reachZ) continue;
    const d = Math.hypot(p.x + p.vx * tau - q.x, p.y + p.vy * tau - q.y);
    if (d < best) best = d;
  }
  return best;
}

function nearestDefender(sim, p, range) {
  let best = null;
  let bd = range;
  for (const d of sim.players) {
    if (d.side !== 'def' || d.down || d.ai.eng) continue;
    const dd = Math.hypot(d.x - p.x, d.y - p.y);
    if (dd < bd) {
      bd = dd;
      best = d;
    }
  }
  return best ? { d: best, dist: bd } : null;
}

/** Probability an offensive player in reach completes the catch. */
export function catchChance(sim, p, q, contested) {
  const b = sim.ball;
  const hands = skill(p.squad, 'hands', 0.2);
  let pc = C.pCatchBase - C.pCatchDist * q * q;
  if (b.bullet) pc -= C.bulletPenalty + C.bulletHands * (1 - hands);
  const sp = Math.hypot(p.vx, p.vy);
  if (sp > 2) {
    const rx = b.x - p.x;
    const ry = b.y - p.y;
    const rl = Math.hypot(rx, ry) || 1;
    const behind = -((p.vx / sp) * (rx / rl) + (p.vy / sp) * (ry / rl));
    if (behind > 0) pc -= C.underthrowPenalty * (1 - hands) * behind;
  }
  if (hands < C.fillerHands) pc -= 0.35 * q;
  if (contested) pc -= C.contestedPenalty - C.contestedHands * hands;
  if (sim.weather === 'rain') pc -= C.rainPenalty;
  if (sim.weather === 'snow') pc -= C.snowPenalty;
  if (b.tipped) pc -= 0.1;
  pc += sim.diff.catchBonus;
  return clamp(pc, 0.05, 0.98);
}

/** Probability a defender in reach intercepts. */
export function intChance(sim, d, q) {
  const b = sim.ball;
  const cov = d.pos === 'DL' ? 0.5 * skill(d.squad, 'passRush', 0.2) : skill(d.squad, 'coverage', 0.2);
  let pi = (C.pIntBase + C.pIntCover * cov) * (1 - C.pIntDist * q);
  if (b.bullet) pi += C.pIntBullet;
  if (b.tipped) pi += C.pIntTipped;
  pi += sim.diff.intBonus;
  return clamp(pi, 0.02, 0.85);
}

/**
 * Per-step catch check for a ball in the air ('air' or 'loose'). Calls back into the sim for
 * outcomes: sim._onCatch(p, contested), sim._onInt(d), sim._onDeflect(p), sim._onDrop(p).
 */
export function catchCheck(sim) {
  const b = sim.ball;
  if (b.z > C.reachZ || b.z < C.groundZ) return;
  // nobody can catch a ball still right at the passer's hand
  if (!b.tipped && Math.hypot(b.x - b.x0, b.y - b.y0) < 1.5) return;
  const cands = [];
  for (const p of sim.players) {
    if (p.down || p.ai.eng || p.hasBall || !isEligible(p)) continue;
    if (p.ai.triedBall === b.serial) continue;
    if (p.id === b.thrower) continue;
    const r = reachOf(p);
    const d0 = Math.hypot(p.x - b.x, p.y - b.y);
    if (d0 > r) continue;
    const dmin = closestApproach(b, p);
    const q = clamp(dmin / r, 0, 1);
    const sk = p.side === 'off' ? skill(p.squad, 'hands', 0.2) : skill(p.squad, 'coverage', 0.2);
    let w = ((1 - q) * (1 - q) + 0.05) * (0.6 + sk);
    if (p.side === 'off') w *= C.offWeight;
    cands.push({ p, q, w });
  }
  if (!cands.length) return;
  const rng = sim.rng;
  while (cands.length) {
    const idx = rng.weightedIndex(cands.map((c) => c.w));
    const c = cands.splice(idx, 1)[0];
    const p = c.p;
    p.ai.triedBall = b.serial;
    if (p.side === 'off') {
      const near = nearestDefender(sim, p, C.contestedRange);
      const pc = catchChance(sim, p, c.q, !!near);
      if (rng.chance(pc)) {
        sim._onCatch(p, near);
        return;
      }
      if (rng.chance(C.dropDeflect)) sim._onDeflect(p);
      else sim._onDrop(p);
      return;
    }
    const pi = intChance(sim, p, c.q);
    const r = rng.next();
    if (r < pi) {
      sim._onInt(p);
      return;
    }
    if (r < pi + C.pDeflect * (1 - 0.5 * c.q)) {
      sim._onDeflect(p);
      return;
    }
    // whiffed: the ball goes past him
  }
}

/** Pop the ball up off a player's hands (tip / bat). */
export function deflectBall(sim, p) {
  const b = sim.ball;
  const rng = sim.rng;
  const keep = C.deflectKeep;
  const ang = rng.float(-Math.PI, Math.PI);
  const lat = rng.float(0.5, 2.5);
  const vx = b.vx * keep + Math.cos(ang) * lat;
  const vy = b.vy * keep + Math.sin(ang) * lat;
  const vz = rng.float(C.deflectVz[0], C.deflectVz[1]);
  const x = b.x;
  const y = b.y;
  const z = Math.max(b.z, 1.2);
  launchBall(sim, x, y, { T: 1, vx, vy, vz, g: P.gravity, z0: z }, b.bullet, true);
  b.ft = 0;
  p.ai.triedBall = b.serial;
  b.thrower = null;
}

/** Is the ball (x,y) out of the field of play? */
export const ballOut = (b) => b.y < 0 || b.y > FIELD.W || b.x > FIELD.END_LINE || b.x < 0;
