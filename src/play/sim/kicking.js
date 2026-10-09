// Field goals / extra points (MECHANICS 4.1): two-tap timing. A power meter cycles 0->1->0 in
// presnap; the 1st kickTap() snaps and locks power, an aim arrow then sweeps +-22 deg (accuracy ->
// sweep speed); the 2nd kickTap() locks aim and the kicker strikes after a Speed-based release
// delay. Range -> max distance (faded by stamina over the game), wind drifts the ball, uprights /
// crossbar can "doink", and the rush tackles the kicker if the kick isn't away by the pressure
// limit. Also the CPU kickoff for kick returns (MECHANICS 4.3).

import { clamp } from '../../core/util.js';
import { FIELD, TUNING } from './tuning.js';
import { attr, endurance } from './squads.js';
import { chase, distE, holdAnim, seek, setAnim, stop } from './entity.js';
import { engage, onNewCarrier, rushPower, blockPower, blockSeek, pursue } from './ai.js';
import { makeCarrierState } from './carrier.js';

const K = TUNING.kick;
const KO = TUNING.kickoff;
const W = FIELD.W;
const DEG = Math.PI / 180;

/** 0 -> 1 -> 0 triangle over one period (u in cycles). */
export const tri01 = (u) => 1 - Math.abs(1 - 2 * (u - Math.floor(u)));
/** 0 -> 1 -> 0 -> -1 -> 0 triangle (u in cycles). */
export function triSigned(u) {
  const v = u + 0.25 - Math.floor(u + 0.25);
  return 1 - Math.abs(4 * v - 2);
}

export function sweepPeriod(kicker) {
  return K.sweepPeriodMin + (K.sweepPeriodMax - K.sweepPeriodMin) * attr(kicker.squad, 'kickAccuracy', 0.2);
}

export function releaseDelay(kicker) {
  return K.releaseDelayMax * (1 - attr(kicker.squad, 'speed', 0.2));
}

/** Max FG distance (yd) for a kicker at full power right now. */
export function kickRange(sim, kicker) {
  const prog = clamp(sim.setup.gameProgress ?? 0, 0, 1);
  const st = endurance(kicker.squad);
  const fade = 1 - (K.staminaFadeFresh + (K.staminaFade - K.staminaFadeFresh) * (1 - st)) * prog;
  return (K.rangeBase + K.rangeSpan * attr(kicker.squad, 'kickPower', 0.2)) * fade;
}

export function powerFactor(power) {
  if (power >= K.greenBand) return 1;
  return K.lowPowerFloor + (1 - K.lowPowerFloor) * Math.pow(clamp(power / K.greenBand, 0, 1), K.powerExp);
}

/**
 * Deterministic kick trajectory (without the doink roll).
 * @returns {{vh:number, vz:number, ax:number, ay:number, cos:number, sin:number, ay2:number}}
 */
export function kickPlan(sim, power, aimAngle, wind = sim.setup.wind) {
  const kicker = sim.byId.K;
  const D = Math.max(8, kickRange(sim, kicker) * powerFactor(power));
  const th = K.launchDeg * DEG;
  const c = Math.cos(th);
  const denom = 2 * c * c * (D * Math.tan(th) - K.crossbarZ);
  let v = Math.sqrt((K.gravity * D * D) / Math.max(1e-3, denom));
  v *= 1 + K.windLong * (wind?.x || 0);
  return {
    vh: v * c,
    vz: v * Math.sin(th),
    cos: Math.cos(aimAngle),
    sin: Math.sin(aimAngle),
    ay: K.windLat * (wind?.y || 0),
    maxDist: D,
  };
}

export function kickPos(sim, plan, tau) {
  const k = sim.kick;
  return {
    x: k.spotX + plan.vh * plan.cos * tau,
    y: k.spotY + plan.vh * plan.sin * tau + 0.5 * plan.ay * tau * tau,
    z: plan.vz * tau - 0.5 * K.gravity * tau * tau,
  };
}

/** Predicted ball position at the posts plane for an aim value -1..1 (bot / UI helper). */
export function predictPostY(sim, aim, power = 1, wind = sim.setup.wind) {
  const k = sim.kick;
  const plan = kickPlan(sim, power, k.baseAngle + aim * K.sweepDeg * DEG, wind);
  if (plan.cos <= 0.05) return null;
  const tau = (K.postX - k.spotX) / (plan.vh * plan.cos);
  return kickPos(sim, plan, tau);
}

// ------------------------------------------------------------------ FG / PAT

export function initKick(sim) {
  const kicker = sim.byId.K;
  const sx = sim.losX - K.holdDepth;
  const sy = sim.by;
  const baseAngle = Math.atan2(W / 2 - sy, K.postX - sx);
  sim.kick = {
    stage: 'power',
    power: 0,
    aim: 0,
    wind: { x: sim.setup.wind?.x || 0, y: sim.setup.wind?.y || 0 },
    pressure: 0,
    path: [],
    spotX: sx,
    spotY: sy,
    distance: Math.round(K.postX - sx),
    maxDist: kickRange(sim, kicker),
    baseAngle,
    aimAngle: baseAngle,
    sweepDeg: K.sweepDeg,
    sweepPeriod: sweepPeriod(kicker),
    powerPeriod: K.powerPeriod,
    greenBand: K.greenBand,
    pressureLimit: K.pressureLimit,
    releaseDelay: releaseDelay(kicker),
    powerLocked: false,
    aimLocked: false,
    clock: 0,
    aimClock: 0,
    lockT: 0,
    kickT: 0,
    result: null,
    missDir: null,
    doink: false,
  };
  sim.ball.state = 'held';
  sim.ball.holder = 'OL3';
}

export function kickPresnap(sim, dt) {
  const k = sim.kick;
  k.clock += dt;
  k.power = tri01(k.clock / K.powerPeriod);
}

/** First tap: snap + lock power. Second tap: lock aim. */
export function kickTap(sim) {
  const k = sim.kick;
  if (!k) return false;
  if (sim.phase === 'presnap' && k.stage === 'power') {
    k.powerLocked = true;
    k.stage = 'aim';
    // the arrow starts at one edge and swings in toward the centre (a reflexive double tap must
    // not lock a centred kick); the side is fixed per kick (seed parity: no rng draw)
    k.aimClock = k.sweepPeriod * (((sim.setup.seed >>> 0) & 1) ? 0.75 : 0.25);
    k.aim = triSigned(k.aimClock / k.sweepPeriod);
    sim._snapKick();
    return true;
  }
  if (sim.phase === 'kick' && k.stage === 'aim' && !k.aimLocked) {
    k.aimLocked = true;
    k.lockT = sim.t;
    k.kickT = Math.max(sim.t + k.releaseDelay, K.snapTime + 0.12);
    return true;
  }
  return false;
}

function doKick(sim) {
  const k = sim.kick;
  const rng = sim.rng;
  k.stage = 'flight';
  k.aimAngle = k.baseAngle + k.aim * K.sweepDeg * DEG;
  const plan = kickPlan(sim, k.power, k.aimAngle);
  k.plan = plan;
  k.maxDist = plan.maxDist;
  const tLand = (2 * plan.vz) / K.gravity;
  let tPost = Infinity;
  if (plan.cos > 0.05) tPost = (K.postX - k.spotX) / (plan.vh * plan.cos);
  let good = false;
  let doink = null;
  let missDir = null;
  let tDecide;
  if (tPost >= tLand) {
    missDir = 'short';
    tDecide = tLand;
  } else {
    tDecide = tPost;
    const p = kickPos(sim, plan, tPost);
    const dy = p.y - W / 2;
    const ady = Math.abs(dy);
    const band = K.doinkBand;
    if (p.z < K.crossbarZ - band) missDir = 'short';
    else if (p.z <= K.crossbarZ + band && ady < K.uprightHalf) {
      doink = 'bar';
      good = rng.chance(clamp((p.z - (K.crossbarZ - band)) / (2 * band), 0, 1));
      if (!good) missDir = 'short';
    } else if (ady >= K.uprightHalf - band && ady <= K.uprightHalf + band && p.z <= K.uprightTop) {
      doink = 'post';
      good = rng.chance(clamp((K.uprightHalf + band - ady) / (2 * band), 0, 1));
      if (!good) missDir = dy < 0 ? 'left' : 'right';
    } else if (ady < K.uprightHalf) good = true;
    else missDir = dy < 0 ? 'left' : 'right';
  }
  k.decided = { good, doink, missDir, tDecide, tPost, tLand };
  // path: until a little past the posts (or the bounce), for drawing / ball motion
  const pts = [];
  const tEnd = Math.min(tLand, tDecide + 0.8);
  const n = 40;
  for (let i = 0; i <= n; i++) {
    const tau = (tEnd * i) / n;
    let q = kickPos(sim, plan, tau);
    if (doink && tau > tDecide) {
      const at = kickPos(sim, plan, tDecide);
      const dt2 = tau - tDecide;
      if (good) q = { x: at.x + plan.vh * plan.cos * 0.35 * dt2, y: at.y + plan.vh * plan.sin * 0.35 * dt2, z: Math.max(0, at.z - 3 * dt2 * dt2) };
      else q = { x: at.x - plan.vh * plan.cos * 0.25 * dt2, y: at.y + (at.y < W / 2 ? -1 : 1) * 2 * dt2, z: Math.max(0, at.z + 1.5 * dt2 - 5.35 * dt2 * dt2) };
    }
    pts.push(q);
  }
  k.path = pts;
  k.tEnd = tEnd;
  k.flightT = 0;
  const b = sim.ball;
  b.state = 'kicked';
  b.holder = null;
  b.x = k.spotX;
  b.y = k.spotY;
  b.z = 0.2;
  const kicker = sim.byId.K;
  holdAnim(kicker, 'kick', 0.5, sim.t);
  sim._emit('kick', k.spotX, k.spotY, { id: kicker.id, distance: k.distance, power: k.power, aim: k.aim });
}

function pathAt(path, u) {
  const f = clamp(u, 0, 1) * (path.length - 1);
  const i = Math.min(path.length - 2, Math.floor(f));
  const r = f - i;
  const a = path[i];
  const b2 = path[i + 1];
  return { x: a.x + (b2.x - a.x) * r, y: a.y + (b2.y - a.y) * r, z: a.z + (b2.z - a.z) * r };
}

/** Phase 'kick' step: aim sweep, approach, flight, pressure. Moves all players. */
export function updateKick(sim, dt) {
  const k = sim.kick;
  const kicker = sim.byId.K;
  const holder = sim.byId.H;
  const b = sim.ball;
  for (const e of sim.players) {
    e.ai.speedMult = 1;
    e.ai.accelMult = 1;
    e.ai.faceX = 0;
    e.ai.faceY = 0;
  }
  if (k.stage === 'aim') {
    k.pressure = clamp(sim.t / K.pressureLimit, 0, 1);
    if (!k.aimLocked) {
      k.aimClock += dt;
      k.aim = triSigned(k.aimClock / k.sweepPeriod);
    }
    k.aimAngle = k.baseAngle + k.aim * K.sweepDeg * DEG;
    // snap: ball to the holder
    if (sim.t < K.snapTime) {
      const u = sim.t / K.snapTime;
      b.state = 'held';
      b.holder = null;
      b.x = sim.losX + (k.spotX - sim.losX) * u;
      b.y = sim.by + (k.spotY - sim.by) * u;
      b.z = 0.4 + 0.5 * Math.sin(Math.PI * u);
    } else {
      b.holder = 'H';
      b.x = k.spotX;
      b.y = k.spotY;
      b.z = 0.15;
    }
    if (k.aimLocked) {
      // kicker approach to the ball
      const ax = k.spotX - 0.6 * Math.cos(k.aimAngle);
      const ay = k.spotY - 0.6 * Math.sin(k.aimAngle);
      const left = Math.max(0.05, k.kickT - sim.t);
      const d = distE(kicker, { x: ax, y: ay });
      kicker.ai.speedMult = 3;
      seek(kicker, ax, ay, Math.min(3, d / left / kicker.top), 0.2);
      if (sim.t >= k.kickT && sim.t < K.pressureLimit) doKick(sim);
    } else {
      stop(kicker);
      holdAnim(kicker, 'stance', 0.05, sim.t);
      kicker.ai.faceX = Math.cos(k.aimAngle);
      kicker.ai.faceY = Math.sin(k.aimAngle);
    }
    if (k.stage === 'aim' && sim.t >= K.pressureLimit) {
      // the rush gets home: kicker swarmed
      k.stage = 'done';
      k.result = 'blocked';
      kicker.down = true;
      setAnim(kicker, 'down');
      sim._emit('tackle', kicker.x, kicker.y, { id: kicker.id, kick: true });
      sim._kickResult('kick_blocked');
      return;
    }
  } else if (k.stage === 'flight') {
    k.flightT += dt;
    const u = k.flightT / Math.max(0.05, k.tEnd);
    const p = pathAt(k.path, u);
    b.x = p.x;
    b.y = p.y;
    b.z = p.z;
    const dec = k.decided;
    if (!k.result && k.flightT >= dec.tDecide) {
      k.result = dec.good ? 'good' : 'miss';
      k.missDir = dec.missDir;
      k.doink = !!dec.doink;
      if (dec.doink) sim._emit('doink', b.x, b.y, { what: dec.doink, good: dec.good });
      sim._emit(dec.good ? 'kick_good' : 'kick_miss', b.x, b.y, { distance: k.distance, dir: dec.missDir });
    }
    if (k.result && k.flightT >= Math.min(k.tEnd, dec.tDecide + K.flightPad)) {
      k.stage = 'done';
      const pat = sim.kind === 'pat';
      sim._kickResult(k.result === 'good' ? (pat ? 'pat_good' : 'fg_good') : pat ? 'pat_miss' : 'fg_miss');
      return;
    }
  }
  // holder kneels, line blocks, rush closes in so the first man arrives at the pressure limit
  stop(holder);
  holder.ai.faceX = -1;
  if (sim.t >= holder.ai.animHold) holdAnim(holder, 'stance', 0.05, sim.t);
  const rushOn = k.stage === 'aim';
  for (const e of sim.players) {
    if (e === kicker || e === holder) continue;
    if (e.side === 'off') {
      stop(e);
      e.ai.faceX = 1;
      if (rushOn) holdAnim(e, 'block', 0.05, sim.t);
    } else if (rushOn) {
      const tLeft = Math.max(0.1, K.pressureLimit - sim.t);
      const d = distE(e, kicker);
      const frac = clamp((d - 0.8) / tLeft / e.top, 0.05, 1) * (e.ai.rushPace || 1);
      chase(e, kicker.x, kicker.y, frac);
    } else {
      seek(e, b.x, b.y, 0.35, 3);
    }
  }
}

// ------------------------------------------------------------------ kick return

/** Pick the returner: the squad's designated `returner` if any, else the fastest of the user's
 * WR / RB / DB (stars first). */
export function pickReturner(sq) {
  if (sq.returner) return sq.returner;
  const cands = [sq.RB, ...sq.WR, ...sq.DB].filter(Boolean);
  let best = null;
  let bs = -1;
  for (const p of cands) {
    const s = attr(p, 'speed', 0.2) + (p.id ? 0.001 : 0);
    if (s > bs) {
      bs = s;
      best = p;
    }
  }
  return best;
}

export function initKickoff(sim) {
  sim.kickoff = {
    kicked: false,
    landX: 0,
    landY: 0,
    hang: 0,
    catchX: null,
  };
  const b = sim.ball;
  const kicker = sim.byId.K;
  b.state = 'held';
  b.holder = null;
  b.x = KO.kickX;
  b.y = W / 2;
  b.z = 0.2;
  kicker.ai.role = 'ko_kicker';
}

function launchKickoff(sim) {
  const rng = sim.rng;
  const ko = sim.kickoff;
  const depth = rng.float(KO.depthMin, KO.depthMax);
  ko.landX = KO.kickX - depth;
  ko.landY = W / 2 + rng.float(-KO.lateral, KO.lateral);
  ko.hang = rng.float(KO.hangMin, KO.hangMax);
  ko.kicked = true;
  const b = sim.ball;
  const g = TUNING.pass.gravity;
  const T = ko.hang;
  const z0 = 0.2;
  const zEnd = 1.5;
  b.state = 'kicked';
  b.holder = null;
  b.x0 = KO.kickX;
  b.y0 = W / 2;
  b.z0 = z0;
  b.fvx = (ko.landX - KO.kickX) / T;
  b.fvy = (ko.landY - W / 2) / T;
  b.fvz = (zEnd - z0 + 0.5 * g * T * T) / T;
  b.g = g;
  b.ft = 0;
  b.T = T;
  b.landX = ko.landX;
  b.landY = ko.landY;
  b.serial = (b.serial || 0) + 1;
  const kicker = sim.byId.K;
  holdAnim(kicker, 'kick', 0.5, sim.t);
  sim._emit('kick', b.x, b.y, { id: kicker.id, landX: ko.landX, landY: ko.landY, hang: T });
  // assign return blockers to coverage men by lane
  const cover = sim.players.filter((e) => e.side === 'def' && e.id !== 'K');
  const blockers = sim.players.filter((e) => e.side === 'off' && e.id !== 'KR');
  const free = new Set(cover);
  // nearest-first greedy by lateral alignment, front line first
  blockers.sort((a, c) => c.x - a.x);
  for (const bl of blockers) {
    let best = null;
    let bd = Infinity;
    for (const cv of free) {
      const d = Math.abs(cv.y - bl.y) + 0.15 * Math.abs(cv.x - bl.x);
      if (d < bd) {
        bd = d;
        best = cv;
      }
    }
    if (best) {
      free.delete(best);
      bl.ai.role = 'ko_block';
      bl.role = 'ko_block';
      bl.ai.blockTarget = best;
      bl.ai.homeY = bl.y;
      bl.ai.setDepth = bl.x > 50 ? KO.wallDepth[0] : bl.x > 35 ? KO.wallDepth[1] : KO.wallDepth[2];
    } else {
      bl.ai.role = 'seek';
      bl.role = 'seek';
    }
  }
  for (const cv of cover) {
    cv.ai.role = 'ko_cover';
    cv.role = 'ko_cover';
    cv.ai.laneY = cv.y;
    cv.ai.react = sim.diff.react;
  }
}

function koBlock(sim, e) {
  const a = e.ai;
  const tgt = a.blockTarget;
  const kr = sim.carrier || sim.byId.KR;
  const b = sim.ball;
  if (!tgt || tgt.down || (tgt.ai.eng && tgt.ai.eng.blk !== e)) {
    a.role = 'seek';
    e.role = 'seek';
    return;
  }
  const ux = kr.x - tgt.x;
  const uy = kr.y - tgt.y;
  const ul = Math.hypot(ux, uy) || 1;
  if (!sim.carrier) {
    // set up the wall in front of the catch point; engage only as the ball comes down
    const tLeft = (b.T ?? 0) - (b.ft ?? 0);
    const setX = (b.landX ?? kr.x) + a.setDepth;
    const setY = clamp(0.5 * a.homeY + 0.5 * tgt.y, 2, W - 2);
    if (tLeft > KO.engageBeforeCatch || distE(e, tgt) > 3.5) {
      seek(e, setX, setY, 1, 1.5);
      e.ai.faceX = 1;
      return;
    }
  }
  if (sim.carrier && distE(tgt, kr) < distE(e, kr) - 1.5) {
    // lost my man: block whoever threatens the returner near me
    a.role = 'seek';
    e.role = 'seek';
    blockSeek(sim, e);
    return;
  }
  chase(e, tgt.x + (ux / ul) * 0.8, tgt.y + (uy / ul) * 0.8, 1);
  if (distE(e, tgt) <= TUNING.block.climbEngageDist && !tgt.ai.eng && sim.t >= tgt.ai.noEngageUntil) {
    const f = clamp(1 + (blockPower(e) - rushPower(tgt)), 0.5, 1.6);
    const dur = KO.blockerShed * f * sim.diff.rushMult * (1 + sim.rng.float(-KO.blockerShedVar, KO.blockerShedVar));
    if (sim.rng.chance(KO.slipChance)) tgt.ai.noEngageUntil = sim.t + 0.5;
    else engage(sim, e, tgt, 'kick', dur);
  }
}

/** Kick return AI step (phases 'return' and 'carry'). */
export function updateKickoffAI(sim) {
  const ko = sim.kickoff;
  const kr = sim.byId.KR;
  const b = sim.ball;
  const kicker = sim.byId.K;
  if (!ko.kicked && sim.t >= KO.approach) launchKickoff(sim);
  for (const e of sim.players) {
    const a = e.ai;
    a.speedMult = 1;
    a.accelMult = 1;
    a.faceX = 0;
    a.faceY = 0;
    if (a.pending && sim.t >= a.pending.at) {
      a.role = a.pending.role;
      e.role = a.role;
      a.pending = null;
    }
    if (e.down) {
      stop(e);
      a.accelMult = 2.5;
      continue;
    }
    if (e === sim.carrier || a.eng || a.lunge) continue;
    if (!ko.kicked) {
      // kicker run-up; everyone else waits, coverage creeps
      if (e === kicker) chase(e, KO.kickX + 0.3, W / 2, 0.8);
      else if (e.side === 'def') chase(e, e.x - 1, e.y, 0.5);
      else stop(e);
      if (e.side === 'off') a.faceX = 1;
      continue;
    }
    if (e === kr && !sim.carrier) {
      seek(e, b.landX, b.landY, 1, 1.5);
      a.faceX = 1;
      continue;
    }
    if (e.side === 'off') {
      a.homeX ??= e.x;
      if (a.role === 'ko_block') koBlock(sim, e);
      else blockSeek(sim, e);
      continue;
    }
    // coverage
    if (e === kicker) {
      const tgt = sim.carrier || { x: b.landX, y: b.landY, vx: 0, vy: 0 };
      if (sim.carrier && distE(e, tgt) < 12) pursue(sim, e, sim.carrier);
      else seek(e, Math.max(tgt.x + 12, 25), clamp(tgt.y, 3, W - 3), 0.85, 2);
      continue;
    }
    if (!sim.carrier) {
      const ty = a.laneY + (b.landY - a.laneY) * (1 - KO.coverLaneHold) * clamp((KO.kickX - e.x) / 50, 0, 1);
      chase(e, b.landX + 3, ty, KO.coverSpeed);
    } else pursue(sim, e, sim.carrier);
  }
  // returner catch
  if (!sim.carrier && ko.kicked && (b.state === 'kicked')) {
    const near = Math.hypot(kr.x - b.x, kr.y - b.y);
    if ((b.ft >= b.T - 0.05 && near < 2.5) || b.ft >= b.T + 0.6) {
      kr.x = near < 2.5 ? kr.x : b.landX;
      kr.y = near < 2.5 ? kr.y : b.landY;
      catchKickoff(sim);
    }
  }
}

function catchKickoff(sim) {
  const kr = sim.byId.KR;
  const b = sim.ball;
  b.state = 'held';
  b.holder = kr.id;
  b.landX = undefined;
  kr.hasBall = true;
  kr.controlled = true;
  sim.kickoff.catchX = kr.x;
  sim.carrier = kr;
  sim.cs = makeCarrierState(sim, kr, 'free');
  sim.cs.leftEndZone = kr.x >= FIELD.OWN_GOAL;
  sim.carrierState = sim.cs;
  kr.ai.role = 'carrier';
  kr.role = 'carrier';
  sim.phase = 'carry';
  holdAnim(kr, 'catch', TUNING.catch.catchAnim, sim.t);
  sim._emit('catch', kr.x, kr.y, { id: kr.id, kick: true });
  if (sim.touchbackPending && kr.x < FIELD.OWN_GOAL) {
    sim._touchback();
    return;
  }
  onNewCarrier(sim, kr, 'return');
}
