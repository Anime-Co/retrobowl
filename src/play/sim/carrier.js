// Ball carrier (MECHANICS 3.1): auto-run toward the goal, side-step jukes with diminishing
// returns, drift, dive, stutter (taunt / kick-return touchback), truck (hold), automatic
// stiff-arms (Strength) and hurdles (Speed) with per-run budgets, proximity slow-down. Also the
// defenders' lunge / dive tackles with whiff + recovery, sacks, fumbles and boundary rulings.

import { clamp } from '../../core/util.js';
import { FIELD, TUNING } from './tuning.js';
import { attr, isStar, skill } from './squads.js';
import { distE, holdAnim, setAnim } from './entity.js';

const CT = TUNING.carrier;
const TK = TUNING.tackle;
const W = FIELD.W;

/**
 * Carrier state (exposed read-only as sim.carrierState).
 * @param {'lane'|'free'} mode lane = follow the designed run lane (handoff)
 */
export function makeCarrierState(sim, e, mode, lane) {
  const str = attr(e.squad, 'strength', 0.2);
  const spd = attr(e.squad, 'speed', 0.2);
  return {
    id: e.id,
    t0: sim.t,
    mode,
    lane: lane || null,
    li: 0,
    laneOffset: 0,
    targetY: e.y + e.vy * 0.25,
    juke: null,
    jukeCount: 0,
    lastJukeEnd: -10,
    jukeEff: 1,
    dive: null,
    diving: false,
    stutter: null,
    stuttering: false,
    taunting: false,
    truckHeld: false,
    trucking: false,
    truckCharge: 0,
    truckUses: 0,
    truckChargeTime: CT.truckCharge,
    driftDir: 0,
    staminaMult: 1,
    stiffLeft: str >= CT.stiffBudgetHi ? 2 : str >= CT.stiffBudgetLo ? 1 : 0,
    hurdleLeft: spd >= CT.hurdleBudgetHi ? 2 : spd >= CT.hurdleBudgetLo ? 1 : 0,
    shakeUntil: 0,
    lastMoveT: -10,
    lastMove: '',
    isQB: e.pos === 'QB',
    startX: e.x,
    maxX: e.x,
    leftEndZone: e.x >= FIELD.OWN_GOAL,
    brokenTackles: 0,
    jukesMade: 0,
  };
}

function jukeEffNext(sim, cs) {
  const chain = CT.jukeChain;
  const count = sim.t - cs.lastJukeEnd >= CT.jukeRecover && !cs.juke ? 0 : cs.jukeCount;
  return chain[Math.min(count, chain.length - 1)];
}

// ------------------------------------------------------------------ commands

export function cmdSideStep(sim, dir) {
  const C = sim.carrier;
  const cs = sim.cs;
  if (!C || !cs || cs.dive || sim.phase !== 'carry') return false;
  const d = dir < 0 ? -1 : 1;
  if (sim.t - cs.lastJukeEnd >= CT.jukeRecover && !cs.juke) cs.jukeCount = 0;
  const eff = CT.jukeChain[Math.min(cs.jukeCount, CT.jukeChain.length - 1)];
  cs.jukeCount += 1;
  cs.juke = { dir: d, t0: sim.t, dur: CT.jukeTime, lat: CT.jukeDist * eff, y0: C.y };
  // a well-timed juke fools defenders who already committed to a dive
  for (const p of sim.players) {
    const L = p.ai.lunge;
    if (p.side === 'def' && L && !L.juked && sim.t <= Math.max(L.t0 + TK.jukeWindow, L.end - 0.04)) {
      L.juked = true;
      L.jukeEff = eff;
    }
  }
  cs.staminaMult = Math.max(0.85, cs.staminaMult - CT.jukeStamina);
  cs.lastMoveT = sim.t;
  cs.lastMove = 'juke';
  cs.jukesMade += 1;
  cs.stutter = null;
  sim._emit('juke', C.x, C.y, { id: C.id, dir: d, eff });
  return true;
}

export function cmdDrift(sim, dir) {
  if (!sim.cs) return;
  sim.cs.driftDir = dir < 0 ? -1 : dir > 0 ? 1 : 0;
}

export function cmdDive(sim) {
  const C = sim.carrier;
  const cs = sim.cs;
  if (!C || !cs || cs.dive || sim.phase !== 'carry') return false;
  const fwd = Math.max(C.vx, 1);
  const lat = clamp(C.vy / fwd, -0.6, 0.6) * 0.5;
  const l = Math.hypot(1, lat);
  const dist = CT.diveDistBase + CT.diveDistSpan * attr(C.squad, 'speed', 0.2);
  const slide = cs.isQB && C.x > sim.losX;
  cs.dive = { t0: sim.t, dur: CT.diveTime, dx: 1 / l, dy: lat / l, dist, slide };
  cs.diving = true;
  cs.juke = null;
  cs.stutter = null;
  cs.lastMoveT = sim.t;
  cs.lastMove = 'dive';
  setAnim(C, 'dive');
  sim._emit('dive', C.x, C.y, { id: C.id, slide });
  return true;
}

export function cmdStutter(sim) {
  const C = sim.carrier;
  const cs = sim.cs;
  if (sim.kind === 'kick_return' && sim.phase === 'return') {
    // back-swipe before the catch while the ball is coming down in the end zone
    if (sim.ball.landX !== undefined && sim.ball.landX < FIELD.OWN_GOAL) sim.touchbackPending = true;
    return true;
  }
  if (!C || !cs || cs.dive || sim.phase !== 'carry') return false;
  if (sim.kind === 'kick_return' && !cs.leftEndZone && C.x < FIELD.OWN_GOAL) {
    sim._emit('stutter', C.x, C.y, { id: C.id, taunt: false });
    sim._touchback();
    return true;
  }
  let clear = true;
  for (const d of sim.players) {
    if (d.side === 'def' && !d.down && distE(d, C) < CT.tauntClear) {
      clear = false;
      break;
    }
  }
  cs.stutter = { t0: sim.t, dur: CT.stutterTime, taunt: clear };
  cs.juke = null;
  cs.lastMoveT = sim.t;
  cs.lastMove = 'stutter';
  sim._emit('stutter', C.x, C.y, { id: C.id, taunt: clear });
  return true;
}

export function cmdTruck(sim, on) {
  const C = sim.carrier;
  const cs = sim.cs;
  if (!C || !cs) return;
  if (on && !cs.truckHeld) {
    const weak = cs.isQB || !isStar(C.squad);
    cs.truckChargeTime = CT.truckCharge * (1 + cs.truckUses * CT.truckChargeGrow) * (weak ? CT.truckNonStar : 1);
    cs.truckCharge = 0;
  }
  if (!on) cs.truckCharge = 0;
  cs.truckHeld = !!on;
}

// ------------------------------------------------------------------ movement

export function updateCarrier(sim, dt) {
  const C = sim.carrier;
  const cs = sim.cs;
  if (!C || !cs) return;
  const a = C.ai;
  a.speedMult = 1;
  a.accelMult = 1.3;
  a.faceX = 0;
  a.faceY = 0;
  cs.maxX = Math.max(cs.maxX, C.x);
  if (C.x >= FIELD.OWN_GOAL) cs.leftEndZone = true;

  if (cs.dive) {
    const u = (sim.t - cs.dive.t0) / cs.dive.dur;
    const sp = cs.dive.dist / cs.dive.dur;
    C.vx = cs.dive.dx * sp;
    C.vy = cs.dive.dy * sp;
    a.wvx = C.vx;
    a.wvy = C.vy;
    a.speedMult = 10;
    a.accelMult = 100;
    C.z = 0.55 * Math.sin(Math.PI * clamp(u, 0, 1));
    setAnim(C, 'dive');
    return;
  }

  const runT = sim.t - cs.t0;
  const fatigue = runT > CT.fatigueAfter ? Math.max(CT.fatigueMin, 1 - CT.fatigueRate * (runT - CT.fatigueAfter)) : 1;
  let speed = C.top * cs.staminaMult * CT.ballSpeed * fatigue;
  cs.trucking = cs.truckHeld;
  if (cs.truckHeld) {
    speed *= CT.truckSpeed;
    cs.truckCharge = Math.min(1, cs.truckCharge + dt / cs.truckChargeTime);
  }
  let n = 0;
  for (const d of sim.players) {
    if (d.side !== 'def' || d.down || d.ai.eng) continue;
    if (Math.abs(d.x - C.x) < CT.proxRange && Math.abs(d.y - C.y) < CT.proxRange && distE(d, C) < CT.proxRange) n++;
  }
  if (n) speed *= Math.max(CT.proxMin, 1 - CT.proxSlow * n);
  if (sim.t < cs.shakeUntil) speed *= CT.shakeSlow;
  cs.taunting = false;
  cs.stuttering = false;
  if (cs.stutter) {
    if (sim.t - cs.stutter.t0 < cs.stutter.dur) {
      speed *= CT.stutterSpeed;
      cs.stuttering = true;
      cs.taunting = cs.stutter.taunt;
    } else cs.stutter = null;
  }
  // hurdle hop
  if (C.z > 0 && !cs.dive) C.z = Math.max(0, C.z - dt * 2.2);

  if (cs.juke) {
    const j = cs.juke;
    const u = (sim.t - j.t0) / j.dur;
    if (u >= 1) {
      cs.juke = null;
      cs.lastJukeEnd = sim.t;
      if (cs.mode === 'lane') cs.laneOffset += C.y - j.y0;
      cs.targetY = C.y;
    } else {
      const lat = (j.lat / j.dur) * j.dir * 1.15;
      a.wvx = speed * CT.jukeForward;
      a.wvy = lat;
      a.speedMult = 3;
      a.accelMult = 9;
      cs.jukeEff = jukeEffNext(sim, cs);
      animFor(sim, C, cs);
      return;
    }
  }
  cs.jukeEff = jukeEffNext(sim, cs);

  if (cs.mode === 'lane' && cs.lane) {
    while (cs.li < cs.lane.length) {
      const p = cs.lane[cs.li];
      const ty = p.y + cs.laneOffset;
      if (C.x >= p.x - 0.3 || Math.hypot(p.x - C.x, ty - C.y) < TUNING.run.laneReach) cs.li += 1;
      else break;
    }
    if (cs.li >= cs.lane.length || C.x > sim.losX + 2) {
      cs.mode = 'free';
      cs.targetY = C.y;
    } else {
      const p = cs.lane[cs.li];
      let dx = p.x - C.x;
      let dy = p.y + cs.laneOffset - C.y;
      if (cs.driftDir) {
        cs.laneOffset += cs.driftDir * CT.driftSpeed * dt;
        dy += cs.driftDir * 0.5;
      }
      const l = Math.hypot(dx, dy) || 1;
      a.wvx = (dx / l) * speed;
      a.wvy = (dy / l) * speed;
      animFor(sim, C, cs);
      return;
    }
  }

  // free auto-run toward the goal with lateral correction toward the target lane
  let lat;
  if (cs.driftDir) {
    lat = cs.driftDir * Math.min(CT.driftSpeed, speed * 0.6);
    cs.targetY = C.y + lat * 0.1;
  } else {
    lat = clamp((cs.targetY - C.y) * TUNING.run.autoLateralGain, -TUNING.run.autoLateralMax * speed, TUNING.run.autoLateralMax * speed);
  }
  const fwd = Math.sqrt(Math.max(0, speed * speed - lat * lat));
  a.wvx = fwd;
  a.wvy = lat;
  animFor(sim, C, cs);
}

function animFor(sim, C, cs) {
  if (sim.t < C.ai.animHold) return;
  if (cs.taunting) setAnim(C, 'celebrate');
  else setAnim(C, 'run');
}

// ------------------------------------------------------------------ tackling

function lungeIntercept(d, C, speed, windup, reach) {
  // where should a committed dive go so it gets within `reach` of the carrier (who keeps running)?
  const px = C.x + C.vx * windup;
  const py = C.y + C.vy * windup;
  const rx = px - d.x;
  const ry = py - d.y;
  // |r + v t| = speed * t + reach  ->  quadratic in t
  const a = C.vx * C.vx + C.vy * C.vy - speed * speed;
  const b = 2 * (rx * C.vx + ry * C.vy) - 2 * speed * reach;
  const c = rx * rx + ry * ry - reach * reach;
  if (c <= 0) return { t: 0, x: px, y: py };
  let t = -1;
  if (Math.abs(a) < 1e-6) t = b < 0 ? -c / b : -1;
  else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      const ts = [(-b - sq) / (2 * a), (-b + sq) / (2 * a)].filter((v) => v > 0);
      if (ts.length) t = Math.min(...ts);
    }
  }
  if (t < 0) return null;
  return { t, x: px + C.vx * t, y: py + C.vy * t };
}

function startLunge(sim, d, C) {
  const speed = d.top * TK.lungeBurst;
  const windup = clamp(TK.lungeWindupPerYd * distE(d, C), TK.lungeWindup, TK.lungeWindupMax);
  const hit = lungeIntercept(d, C, speed, windup, TK.reach * 0.9);
  if (!hit || hit.t > TK.lungeTime + 0.05) return false;
  const dx = hit.x - d.x;
  const dy = hit.y - d.y;
  const l = Math.hypot(dx, dy) || 1;
  const cv = Math.hypot(C.vx, C.vy) || 1;
  const front = ((d.x - C.x) * C.vx + (d.y - C.y) * C.vy) / (cv * (distE(d, C) || 1));
  d.ai.lunge = { t0: sim.t, windup, end: sim.t + windup + TK.lungeTime, dx: dx / l, dy: dy / l, speed, front, moveAt: sim.cs ? sim.cs.lastMoveT : -10 };
  d.lunging = true;
  setAnim(d, 'tackle');
  return true;
}

function endWhiff(sim, d, C, burned, silent = false) {
  d.ai.lunge = null;
  d.lunging = false;
  d.down = true;
  d.ai.downUntil = sim.t + TK.whiffDown + sim.rng.float(-TK.whiffDownVar, TK.whiffDownVar);
  setAnim(d, 'down');
  if (silent) return;
  if (burned) sim._emit('burn', d.x, d.y, { id: d.id, carrier: C ? C.id : null });
  else sim._emit('whiff', d.x, d.y, { id: d.id });
}

function knockDown(sim, d, dur) {
  d.ai.lunge = null;
  d.lunging = false;
  d.down = true;
  d.ai.downUntil = sim.t + dur;
  setAnim(d, 'down');
}

/**
 * Contact between a defender and the carrier: truck / hurdle / stiff-arm / tackle rolls.
 */
function contact(sim, d, C) {
  const cs = sim.cs;
  const rng = sim.rng;
  if (cs.dive) return;
  const sp = Math.hypot(C.vx, C.vy);
  const cx = sp > 0.5 ? C.vx / sp : 1;
  const cy = sp > 0.5 ? C.vy / sp : 0;
  const rl = distE(d, C) || 1;
  const front = ((d.x - C.x) / rl) * cx + ((d.y - C.y) / rl) * cy;
  const str = skill(C.squad, 'strength', 0.2);
  const spd = skill(C.squad, 'speed', 0.2);
  const tkl = skill(d.squad, 'tackling', 0.2);
  const lunging = !!d.ai.lunge;

  if (cs.truckHeld && cs.truckCharge >= 1 && front > 0.25) {
    const p = CT.truckBase + CT.truckStr * str - CT.truckTkl * tkl;
    if (rng.chance(p)) {
      knockDown(sim, d, 1.2);
      d.vx = cx * 2;
      d.vy = cy * 2;
      cs.truckCharge = 0;
      cs.truckUses += 1;
      cs.truckChargeTime = CT.truckCharge * (1 + cs.truckUses * CT.truckChargeGrow) * (cs.isQB || !isStar(C.squad) ? CT.truckNonStar : 1);
      cs.shakeUntil = sim.t + CT.shakeTime;
      cs.brokenTackles += 1;
      sim._emit('truck_hit', C.x, C.y, { id: C.id, defender: d.id });
      if (isStar(C.squad)) sim._hit(C, 0.25);
      return;
    }
  }
  if (lunging && front > 0.2 && cs.hurdleLeft > 0) {
    if (rng.chance(CT.hurdleBase + CT.hurdleSpd * spd)) {
      cs.hurdleLeft -= 1;
      cs.brokenTackles += 1;
      C.z = 0.7;
      endWhiff(sim, d, C, false, true);
      sim._emit('hurdle', C.x, C.y, { id: C.id, defender: d.id });
      return;
    }
  }
  if (front > -0.3 && cs.stiffLeft > 0) {
    if (rng.chance(clamp(CT.stiffBase + CT.stiffStr * str - CT.stiffTkl * tkl, 0.02, 0.8))) {
      cs.stiffLeft -= 1;
      cs.brokenTackles += 1;
      knockDown(sim, d, TK.brokenDown + 0.2);
      cs.shakeUntil = sim.t + CT.shakeTime;
      sim._emit('stiffarm', C.x, C.y, { id: C.id, defender: d.id });
      return;
    }
  }
  let p = TK.pBase + TK.pTkl * tkl - TK.pStr * str + sim.diff.tackleBonus;
  if (front < -0.3) p += TK.pBehind + (cs.truckHeld ? CT.truckBehind : 0);
  for (const o of sim.players) {
    if (o !== d && o.side === 'def' && !o.down && !o.ai.eng && distE(o, C) < 1.5) {
      p += TK.pGang;
      break;
    }
  }
  p = clamp(p, TK.pMin, TK.pMax);
  if (rng.chance(p)) {
    tackle(sim, d, C, front);
    return;
  }
  // broken tackle
  knockDown(sim, d, TK.brokenDown);
  cs.shakeUntil = sim.t + CT.shakeTime;
  cs.brokenTackles += 1;
  sim._emit('broken_tackle', C.x, C.y, { id: C.id, defender: d.id });
}

function fumbleChance(sim, C) {
  const F = TUNING.fumble;
  const hands = skill(C.squad, 'hands', 0.2);
  let p = F.base * (F.handsA - F.handsB * hands);
  if (sim.weather === 'rain') p *= F.rain;
  if (sim.weather === 'snow') p *= F.snow;
  if (C.pos === 'QB') p *= F.qbRun;
  return Math.max(0, p);
}

function tackle(sim, d, C, front) {
  setAnim(d, 'tackle');
  d.lunging = false;
  d.ai.lunge = null;
  // fall forward when hit from the side / behind while moving upfield
  const fall = clamp(C.vx * 0.1, 0, TK.fallForwardMax) * (front > 0.6 ? 0.3 : 1);
  const closing = Math.hypot(C.vx - d.vx, C.vy - d.vy);
  if (isStar(C.squad)) {
    sim._hit(C, clamp(TUNING.result.hitPowerBase + closing / 30 + 0.2 * attr(d.squad, 'strength', 0.2), 0, 1));
  }
  sim._tackler = d;
  if (sim.rng.chance(fumbleChance(sim, C))) {
    sim._fumble(C, d);
    return;
  }
  C.x += fall;
  sim._emit('tackle', C.x, C.y, { id: C.id, by: d.id });
  sim._downed(C, 'tackle');
}

/**
 * Lunges, wrap-up contacts and lunge whiffs vs the ball carrier.
 */
export function updateTackling(sim, dt) {
  const C = sim.carrier;
  if (!C || sim.phase !== 'carry') {
    // clean up stale lunges
    for (const d of sim.players) {
      if (d.ai.lunge && sim.t >= d.ai.lunge.end) {
        d.ai.lunge = null;
        d.lunging = false;
      }
    }
    return;
  }
  const cs = sim.cs;
  for (const d of sim.players) {
    if (d.side !== 'def' || d.down || d.ai.eng) continue;
    const a = d.ai;
    const dist = distE(d, C);
    if (a.lunge) {
      const L = a.lunge;
      if (sim.t < L.t0 + L.windup) {
        // telegraph: a diver in front gathers (plants), a chaser keeps his momentum
        const sp0 = L.front > 0 ? d.top * TK.windupSpeed : Math.max(Math.hypot(d.vx, d.vy), d.top * 0.6);
        a.wvx = L.dx * sp0;
        a.wvy = L.dy * sp0;
        a.accelMult = 3;
      } else {
        // committed dive: may bend only slightly toward the carrier (not at all once fooled)
        const tx = L.juked ? L.dx : C.x - d.x;
        const ty = L.juked ? L.dy : C.y - d.y;
        const cross = L.dx * ty - L.dy * tx;
        const turn = clamp(Math.atan2(cross, L.dx * tx + L.dy * ty), -TK.lungeHoming * dt, TK.lungeHoming * dt);
        const c = Math.cos(turn);
        const s2 = Math.sin(turn);
        const nx = L.dx * c - L.dy * s2;
        const ny = L.dx * s2 + L.dy * c;
        L.dx = nx;
        L.dy = ny;
        a.wvx = L.dx * L.speed;
        a.wvy = L.dy * L.speed;
        a.speedMult = TK.lungeBurst + 0.2;
        a.accelMult = 12;
      }
      a.faceX = L.dx;
      a.faceY = L.dy;
      const reach = L.juked ? TK.reach * (1 - TK.jukedReach * L.jukeEff) : TK.reach;
      if (dist <= reach && sim.t >= L.t0 + L.windup * 0.5 && !cs.dive) {
        contact(sim, d, C);
        if (sim.phase !== 'carry') return;
        continue;
      }
      if (sim.t >= L.end) {
        const burned = cs.lastMoveT > L.moveAt && cs.lastMoveT >= L.t0 - 0.05;
        endWhiff(sim, d, C, burned);
      }
      continue;
    }
    if (cs.dive) continue;
    if (dist <= TK.reach * 0.85) {
      contact(sim, d, C);
      if (sim.phase !== 'carry') return;
      continue;
    }
    const closing = -(((d.x - C.x) * (d.vx - C.vx) + (d.y - C.y) * (d.vy - C.vy)) / (dist || 1));
    const range = Math.min(TK.lungeRangeMax, sim.diff.lungeRange + Math.max(0, closing) * TK.lungeClosing);
    if (dist <= range && sim.t >= a.lungeReadyAt) {
      const sp = Math.hypot(C.vx, C.vy);
      const cx = sp > 0.5 ? C.vx / sp : 1;
      const cy = sp > 0.5 ? C.vy / sp : 0;
      const front = ((d.x - C.x) / dist) * cx + ((d.y - C.y) / dist) * cy;
      if (front >= TK.lungeFrontDot) {
        a.inRangeT += dt;
        if (a.inRangeT >= TK.lungeDelay) {
          if (!startLunge(sim, d, C)) a.lungeReadyAt = sim.t + 0.15;
          a.inRangeT = 0;
        }
      }
    } else a.inRangeT = 0;
  }
}

/** Free rushers vs a QB holding the ball in the pocket. */
export function updateSacks(sim) {
  const qb = sim.byId.QB;
  if (!qb || sim.phase !== 'dropback' || sim.ball.holder !== qb.id) return;
  for (const d of sim.players) {
    if (d.side !== 'def' || d.down || d.ai.eng) continue;
    const dist = distE(d, qb);
    if (dist <= sim.diff.lungeRange) {
      d.lunging = true;
      setAnim(d, 'tackle');
    }
    if (dist <= TUNING.rush.sackReach) {
      sim._sack(qb, d);
      return;
    }
  }
}

/** Boundary rulings for the carrier: TD, out of bounds. */
export function checkBounds(sim) {
  const C = sim.carrier;
  if (!C || sim.phase !== 'carry') return;
  if (C.y < 0 || C.y > W) {
    // spot where he crossed the sideline
    const y = clamp(C.y, 0, W);
    sim._oob(C, y);
    return;
  }
  if (C.x >= FIELD.OPP_GOAL) {
    sim._touchdown(C);
  }
}

/** Dive / slide completion. */
export function updateDive(sim) {
  const C = sim.carrier;
  const cs = sim.cs;
  if (!C || !cs || !cs.dive || sim.phase !== 'carry') return;
  if (sim.t - cs.dive.t0 >= cs.dive.dur) {
    C.z = 0;
    C.vx = 0;
    C.vy = 0;
    holdAnim(C, cs.dive.slide ? 'down' : 'dive', 1, sim.t);
    sim._downed(C, 'dive');
  }
}
