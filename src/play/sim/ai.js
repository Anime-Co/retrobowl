// Scrimmage AI (MECHANICS 2.5, 3.2): one-on-one blocking engagements with shed / beat timers,
// pass rush and LB blitzes, LB run/pass read, DB man coverage with deep help and hook zones,
// reaction to the throw (break on the ball), pursuit with lead angles. Tackling / lunges live in
// carrier.js. Each routine only sets an entity's desired velocity (see entity.js).

import { clamp } from '../../core/util.js';
import { FIELD, TUNING } from './tuning.js';
import { skill } from './squads.js';
import { chase, distE, holdAnim, observe, seek, setAnim, stop } from './entity.js';

const B = TUNING.block;
const CV = TUNING.coverage;
const W = FIELD.W;

// ------------------------------------------------------------------ ratings used by blocking

export function blockPower(e) {
  return 0.55 * skill(e.squad, 'blocking', 0.2) + 0.45 * skill(e.squad, 'strength', 0.2);
}

export function rushPower(e) {
  if (e.pos === 'DL') return 0.55 * skill(e.squad, 'passRush', 0.2) + 0.45 * skill(e.squad, 'strength', 0.2);
  if (e.pos === 'LB') return 0.4 * skill(e.squad, 'passRush', 0.2) + 0.3 * skill(e.squad, 'strength', 0.2) + 0.3 * skill(e.squad, 'tackling', 0.2);
  return 0.5 * skill(e.squad, 'tackling', 0.2) + 0.5 * skill(e.squad, 'strength', 0.2);
}

/** Per-defender reaction delay (s): difficulty base scaled by coverage / tackling skill. */
export function reactionOf(sim, d) {
  const sk = d.pos === 'DB' ? skill(d.squad, 'coverage', 0.2) : 0.5 * (skill(d.squad, 'coverage', 0.2) + skill(d.squad, 'tackling', 0.2));
  return sim.diff.react * (1.4 - CV.reactCoverSkill * sk);
}

// ------------------------------------------------------------------ engagements

/**
 * Start a one-on-one engagement.
 * @param {'pass'|'run'|'stalk'|'kick'} kind
 * @param {number} dur seconds until the defender sheds / beats the block
 */
export function engage(sim, blk, def, kind, dur) {
  if (blk.ai.eng || def.ai.eng) return null;
  const skill = rushPower(def) - blockPower(blk);
  let drift;
  if (kind === 'pass') drift = B.pocketDrift + B.driftSkill * skill;
  else drift = B.runDrift + B.driftSkill * skill;
  const eng = { blk, def, kind, start: sim.t, until: sim.t + Math.max(0.15, dur), drift: clamp(drift, -1.6, 1.6) };
  blk.ai.eng = eng;
  def.ai.eng = eng;
  blk.blocking = def.id;
  def.blocking = blk.id;
  def.lunging = false;
  def.ai.lunge = null;
  sim.engagements.push(eng);
  return eng;
}

export function releaseEngagement(sim, eng, beaten) {
  const { blk, def } = eng;
  blk.ai.eng = null;
  def.ai.eng = null;
  blk.blocking = null;
  def.blocking = null;
  def.ai.noEngageUntil = sim.t + B.reengageCooldown;
  if (beaten) {
    blk.ai.stumbleUntil = sim.t + B.beatenStumble;
    // swim move: the defender pops a little to the side of the blocker
    const side = def.y >= blk.y ? 1 : -1;
    def.y += side * 0.35;
  }
  if (blk.ai.role !== 'carrier') blk.ai.role = 'seek';
  const i = sim.engagements.indexOf(eng);
  if (i >= 0) sim.engagements.splice(i, 1);
}

/** Beat timer for a pass-rush matchup (MECHANICS 2.5 [D]). */
export function passBeatTime(sim, blk, def, mult = 1) {
  const f = clamp(1 + B.passBeatSkill * (blockPower(blk) - rushPower(def)), 0.45, 1.8);
  const t = B.passBeatBase * f * sim.diff.rushMult * mult * (1 + sim.rng.float(-B.passBeatVar, B.passBeatVar));
  // occasional blown block (more likely for a better rusher)
  const pq = B.quickBeatChance * clamp(1 + 2 * (rushPower(def) - blockPower(blk)), 0.3, 2.5) / sim.diff.rushMult;
  if (sim.rng.chance(pq)) return Math.min(t, sim.rng.float(B.quickBeatTime[0], B.quickBeatTime[1]));
  return t;
}

/** Shed timer for a run / stalk block. */
export function runShedTime(sim, blk, def, base = B.runShedBase) {
  const f = clamp(1 + B.runShedSkill * (blockPower(blk) - rushPower(def)), 0.45, 1.8);
  return base * f * sim.diff.rushMult * (1 + sim.rng.float(-B.runShedVar, B.runShedVar));
}

/** Point an engaged / free defender is trying to reach. */
export function defGoal(sim) {
  if (sim.carrier) return sim.carrier;
  const b = sim.ball;
  if ((b.state === 'air' || b.state === 'loose') && b.landX !== undefined) return { x: b.landX, y: b.landY };
  if (b.holder) {
    const h = sim.byId[b.holder];
    if (h) return h;
  }
  return { x: b.x, y: b.y };
}

export function updateEngagements(sim, dt) {
  const goal = defGoal(sim);
  for (let i = sim.engagements.length - 1; i >= 0; i--) {
    const eng = sim.engagements[i];
    const { blk, def } = eng;
    if (sim.t >= eng.until || blk.down || def.down) {
      releaseEngagement(sim, eng, sim.t >= eng.until && (eng.kind === 'pass' || eng.kind === 'run'));
      continue;
    }
    let ux = goal.x - def.x;
    let uy = goal.y - def.y;
    const ul = Math.hypot(ux, uy);
    if (ul < 1e-6) {
      ux = -1;
      uy = 0;
    } else {
      ux /= ul;
      uy /= ul;
    }
    const drift = eng.drift;
    def.ai.wvx = ux * drift;
    def.ai.wvy = uy * drift;
    def.ai.accelMult = 2;
    def.ai.faceX = ux;
    def.ai.faceY = uy;
    // the blocker keeps himself between the defender and the goal
    const tx = def.x + ux * B.pairGap;
    const ty = def.y + uy * B.pairGap;
    const k = 9;
    blk.ai.wvx = clamp((tx - blk.x) * k + ux * drift, -blk.top, blk.top);
    blk.ai.wvy = clamp((ty - blk.y) * k + uy * drift, -blk.top, blk.top);
    blk.ai.accelMult = 2.5;
    blk.ai.faceX = -ux;
    blk.ai.faceY = -uy;
    setAnim(blk, 'block');
    setAnim(def, 'block');
  }
}

/** Try to latch a block; the defender may slip it. */
export function tryEngage(sim, blk, def, kind, dur) {
  if (def.ai.eng || blk.ai.eng || def.down || sim.t < def.ai.noEngageUntil) return false;
  const dsp = skill(def.squad, 'speed', 0.2) - skill(blk.squad, 'speed', 0.2);
  const pAvoid = clamp(B.avoidBase + B.avoidSpeed * dsp, 0.03, 0.6);
  if (sim.rng.chance(pAvoid)) {
    def.ai.noEngageUntil = sim.t + 0.6;
    return false;
  }
  return !!engage(sim, blk, def, kind, dur);
}

// ------------------------------------------------------------------ pursuit

/**
 * Lead-angle pursuit point toward a moving target, using delayed perception.
 */
export function pursuitPoint(sim, d, target, delay) {
  const o = observe(target, delay);
  const px = o.x + o.vx * delay;
  const py = o.y + o.vy * delay;
  const rx = px - d.x;
  const ry = py - d.y;
  const s = d.top;
  const a = o.vx * o.vx + o.vy * o.vy - s * s;
  const b = 2 * (rx * o.vx + ry * o.vy);
  const c = rx * rx + ry * ry;
  let t = Math.sqrt(c) / s;
  if (Math.abs(a) > 1e-6) {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      const t1 = (-b - sq) / (2 * a);
      const t2 = (-b + sq) / (2 * a);
      const cand = [t1, t2].filter((v) => v > 0);
      if (cand.length) t = Math.min(...cand);
    }
  }
  t = Math.min(t, TUNING.tackle.pursuitMaxLead);
  const bias = (d.ai.pbias || 0) * TUNING.tackle.pursuitNoise * t;
  return { x: px + o.vx * t, y: clamp(py + o.vy * t + bias, -0.5, W + 0.5) };
}

export function pursue(sim, d, target) {
  const p = pursuitPoint(sim, d, target, d.ai.react ?? sim.diff.react);
  const T = TUNING.tackle;
  if (target === sim.carrier && Math.hypot(target.x - d.x, target.y - d.y) < T.closeRange) {
    d.ai.speedMult = T.closeBurst;
    chase(d, p.x, p.y, T.closeBurst);
  } else chase(d, p.x, p.y, 1);
}

// ------------------------------------------------------------------ helpers

function setRole(e, role) {
  e.ai.role = role;
  e.role = role;
}

/** Schedule a role change after a reaction delay. */
export function roleAfter(sim, e, role, delay, extra) {
  e.ai.pending = { role, at: sim.t + delay, extra };
}

function nearestThreat(sim, blk, protect) {
  let best = null;
  let bs = Infinity;
  for (const d of sim.players) {
    if (d.side !== 'def' || d.down || d.ai.eng || sim.t < d.ai.noEngageUntil) continue;
    // in pass protection only pick up rushers; never chase cover men downfield
    if (sim.phase === 'dropback' && d.ai.role !== 'rush') continue;
    const db = distE(d, blk);
    if (db > (sim.kind === 'kick_return' ? 14 : B.blockSeekRange)) continue;
    const dp = Math.hypot(d.x - protect.x, d.y - protect.y);
    // only block defenders that are not already behind the protected player
    if (protect.vx !== undefined && d.x < protect.x - 1.5 && sim.carrier) continue;
    const s = db + 0.6 * dp;
    if (s < bs) {
      bs = s;
      best = d;
    }
  }
  return best;
}

// ------------------------------------------------------------------ offense

function followRoute(sim, e) {
  const a = e.ai;
  const pts = a.route;
  if (!pts) {
    stop(e);
    return;
  }
  if (sim.t < a.routeStartAt) {
    // RB run fake: step toward the mesh before releasing
    if (a.fakeTo) seek(e, a.fakeTo.x, a.fakeTo.y, 0.7, 0.6);
    else stop(e);
    return;
  }
  if (a.ri >= pts.length) {
    // route finished: settle and face the QB
    stop(e);
    const qb = sim.byId.QB;
    if (qb) {
      a.faceX = qb.x - e.x;
      a.faceY = qb.y - e.y;
    }
    return;
  }
  const tp = pts[a.ri];
  const dx = tp.x - e.x;
  const dy = tp.y - e.y;
  const d = Math.hypot(dx, dy);
  // passed the waypoint plane along the current segment?
  const prev = a.ri > 0 ? pts[a.ri - 1] : { x: e.x, y: e.y };
  const sx = tp.x - prev.x;
  const sy = tp.y - prev.y;
  const passed = sx * dx + sy * dy < 0;
  if (d < 0.8 || passed) {
    a.ri += 1;
    if (a.ri < pts.length) {
      // plant and cut: lose speed depending on the cut angle (elusiveness keeps more)
      const nx = pts[a.ri].x - tp.x;
      const ny = pts[a.ri].y - tp.y;
      const l1 = Math.hypot(sx, sy) || 1;
      const l2 = Math.hypot(nx, ny) || 1;
      const cos = (sx * nx + sy * ny) / (l1 * l2);
      const ang = Math.acos(clamp(cos, -1, 1)) / (Math.PI / 2); // 1 = 90 degrees
      const base = TUNING.routes.cutSlow + TUNING.routes.cutSlowElusive * skill(e.squad, 'elusiveness', 0.2);
      const keep = clamp(1 - (1 - base) * Math.min(ang, 1.6), 0.3, 1);
      e.vx *= keep;
      e.vy *= keep;
      a.cutBoostUntil = sim.t + 0.35;
    }
    followRoute(sim, e);
    return;
  }
  if (sim.t < (a.cutBoostUntil || 0)) a.accelMult = 1.7;
  const last = a.ri === pts.length - 1;
  if (last && a.settleAtEnd) seek(e, tp.x, tp.y, 1, 1.5);
  else chase(e, tp.x, tp.y, 1);
}

function adjustToBall(sim, e) {
  const b = sim.ball;
  followRoute(sim, e);
  const rvx = e.ai.wvx;
  const rvy = e.ai.wvy;
  const f = clamp(TUNING.catch.adjustBase + TUNING.catch.adjustSpan * skill(e.squad, 'hands', 0.2), 0, 1);
  if (b.landX === undefined) return;
  // run to the spot, timing the arrival: no need to sprint if early
  const tLeft = Math.max(0.05, b.T - b.ft);
  const dx = b.landX - e.x;
  const dy = b.landY - e.y;
  const d = Math.hypot(dx, dy);
  let sp = e.top;
  if (d / e.top < tLeft) sp = Math.max(d / tLeft, Math.min(e.top, 2 + d * 2));
  const sx = d > 1e-6 ? (dx / d) * sp : 0;
  const sy = d > 1e-6 ? (dy / d) * sp : 0;
  e.ai.wvx = f * sx + (1 - f) * rvx;
  e.ai.wvy = f * sy + (1 - f) * rvy;
}

export function protectPoint(sim, e) {
  return sim.carrier || sim.byId.QB || sim.byId.KR || e;
}

export function blockSeek(sim, e) {
  const protect = protectPoint(sim, e);
  const a = e.ai;
  let tgt = a.blockTarget && !a.blockTarget.down && !a.blockTarget.ai.eng ? a.blockTarget : null;
  if (!tgt || sim.t >= (a.retargetAt || 0)) {
    tgt = nearestThreat(sim, e, protect);
    a.blockTarget = tgt;
    a.retargetAt = sim.t + 0.25;
  }
  if (!tgt) {
    // drift with the play
    if (sim.carrier && sim.carrier !== e) seek(e, sim.carrier.x + 3, sim.carrier.y + (e.y > sim.carrier.y ? 3 : -3), 0.8, 2);
    else stop(e);
    return;
  }
  // get between the threat and the protected player
  const ux = protect.x - tgt.x;
  const uy = protect.y - tgt.y;
  const ul = Math.hypot(ux, uy) || 1;
  const px = tgt.x + (ux / ul) * 0.8;
  const py = tgt.y + (uy / ul) * 0.8;
  chase(e, px, py, 1);
  if (distE(e, tgt) <= B.climbEngageDist) {
    const kind = sim.phase === 'dropback' ? 'pass' : sim.kind === 'kick_return' ? 'kick' : 'run';
    let dur;
    if (kind === 'pass') dur = passBeatTime(sim, e, tgt, 0.8);
    else if (kind === 'kick') dur = runShedTime(sim, e, tgt, TUNING.kickoff.blockerShed * 0.8);
    else dur = runShedTime(sim, e, tgt, B.secondLevelShed);
    tryEngage(sim, e, tgt, kind, dur);
  }
}

function targetBlock(sim, e) {
  // climb / stalk / blitz pickup onto a specific defender
  const a = e.ai;
  const tgt = a.blockTarget;
  if (!tgt || tgt.down || (tgt.ai.eng && tgt.ai.eng.blk !== e)) {
    setRole(e, 'seek');
    blockSeek(sim, e);
    return;
  }
  const protect = protectPoint(sim, e);
  if (a.role === 'pickup' && sim.t < (a.pickupWaitUntil || 0) && distE(tgt, protect) > 6) {
    // pass pro: hold the set point until the blitzer shows
    seek(e, a.setX, a.setY, 0.6, 0.8);
    a.faceX = 1;
    return;
  }
  const ux = protect.x - tgt.x;
  const uy = protect.y - tgt.y;
  const ul = Math.hypot(ux, uy) || 1;
  const lead = a.role === 'stalk' ? 1.2 : 0.7;
  chase(e, tgt.x + (ux / ul) * lead, tgt.y + (uy / ul) * lead, a.role === 'stalk' ? 0.85 : 1);
  if (distE(e, tgt) <= (a.role === 'pickup' ? B.engageDist : B.climbEngageDist)) {
    let kind = 'run';
    let dur;
    if (a.role === 'pickup') {
      kind = 'pass';
      dur = passBeatTime(sim, e, tgt, B.tePassBeat);
    } else if (a.role === 'stalk') {
      kind = 'stalk';
      dur = runShedTime(sim, e, tgt, B.stalkShed);
    } else dur = runShedTime(sim, e, tgt, B.secondLevelShed * 1.2);
    tryEngage(sim, e, tgt, kind, dur);
  }
}

function offenseRole(sim, e) {
  const a = e.ai;
  switch (a.role) {
    case 'qb_drop': {
      seek(e, a.dropX, a.dropY, a.dropFrac, 0.7);
      a.faceX = 1;
      a.faceY = 0;
      if (sim.aim && sim.aim.valid) {
        a.faceX = sim.aim.tx - e.x;
        a.faceY = sim.aim.ty - e.y;
      }
      break;
    }
    case 'qb_mesh': {
      seek(e, a.meshX, a.meshY, 0.9, 0.6);
      break;
    }
    case 'qb_fake': {
      seek(e, a.fakeX, a.fakeY, 0.6, 1);
      break;
    }
    case 'route':
      followRoute(sim, e);
      break;
    case 'adjust':
      adjustToBall(sim, e);
      break;
    case 'help': {
      // centre helping on a double team: sit beside the pair
      const eng = a.helpEng;
      if (!eng || !sim.engagements.includes(eng)) {
        setRole(e, 'seek');
        blockSeek(sim, e);
        break;
      }
      const side = e.y >= eng.blk.y ? 1 : -1;
      seek(e, eng.blk.x - 0.3, eng.blk.y + side * 0.9, 1, 0.6);
      a.faceX = 1;
      holdAnim(e, 'block', 0.05, sim.t);
      break;
    }
    case 'pickup':
    case 'climb':
    case 'stalk':
      targetBlock(sim, e);
      break;
    case 'seek':
      blockSeek(sim, e);
      break;
    case 'hold':
      stop(e);
      break;
    default:
      stop(e);
  }
}

// ------------------------------------------------------------------ defense

function manCover(sim, d, r) {
  const a = d.ai;
  const react = a.react;
  const o = observe(r, react);
  const lead = react + CV.lookAhead;
  const ex = o.x + o.vx * lead;
  const ey = o.y + o.vy * lead;
  const cush = Math.max(CV.trailCushion, a.cushion0 - CV.cushionDecay * sim.t);
  const inside = Math.sign(sim.by - ey) || 1;
  const tx = Math.min(ex + cush, FIELD.END_LINE - 0.5);
  const ty = clamp(ey + inside * CV.insideShade, 0.5, W - 0.5);
  // backpedal while the receiver is still in front of him
  if (r.x < d.x - 1.5 && tx > d.x) {
    a.speedMult = TUNING.backpedalFrac;
    a.faceX = -1;
    a.faceY = 0;
  }
  seek(d, tx, ty, 1, 0.6);
}

function deepHelp(sim, d) {
  // single-high (half 0) covers the deepest threat anywhere; two-deep halves only their side
  const half = d.ai.half || 0;
  let deepest = null;
  for (const id of ['WR1', 'WR2', 'TE2', 'RB']) {
    const r = sim.byId[id];
    if (!r || (r.ai.role !== 'route' && r.ai.role !== 'adjust')) continue;
    if (half && Math.sign(r.y - sim.by) !== half && Math.abs(r.y - sim.by) > 2) continue;
    if (!deepest || r.x > deepest.x) deepest = r;
  }
  const baseX = sim.losX + TUNING.formation.fsDepth - (half ? 1.5 : 0);
  const tx = Math.min(Math.max(baseX, (deepest ? deepest.x : 0) + CV.fsDepthOverDeepest), FIELD.END_LINE - 1);
  const homeY = half ? sim.by + half * 9 : sim.by;
  const ty = deepest ? clamp(0.6 * deepest.y + 0.4 * homeY, 2, W - 2) : homeY;
  seek(d, tx, ty, 0.95, 1.5);
  d.ai.faceX = -1;
}

function hookZone(sim, d) {
  const a = d.ai;
  let zx = a.zoneX;
  let zy = a.zoneY;
  let best = null;
  let bd = CV.hookRange;
  for (const id of ['WR1', 'WR2', 'TE2', 'RB']) {
    const r = sim.byId[id];
    if (!r || (r.ai.role !== 'route' && r.ai.role !== 'adjust')) continue;
    const dd = Math.hypot(r.x - zx, r.y - zy);
    if (dd < bd) {
      bd = dd;
      best = r;
    }
  }
  if (best) {
    const qb = sim.byId.QB;
    const ux = (qb ? qb.x : sim.losX) - best.x;
    const uy = (qb ? qb.y : sim.by) - best.y;
    const ul = Math.hypot(ux, uy) || 1;
    zx = best.x + (ux / ul) * 1.4;
    zy = best.y + (uy / ul) * 1.4;
  }
  seek(d, zx, zy, 0.95, 1);
  a.faceX = -1;
}

function defenseRole(sim, d) {
  const a = d.ai;
  switch (a.role) {
    case 'rush': {
      const tgt = sim.carrier || (sim.ball.holder ? sim.byId[sim.ball.holder] : null);
      if (!tgt) {
        stop(d);
        break;
      }
      if (sim.carrier && sim.carrier.ai.role === 'carrier' && sim.phase === 'carry') pursue(sim, d, tgt);
      else chase(d, tgt.x, tgt.y, 1);
      break;
    }
    case 'read':
      seek(d, a.homeX - 0.3, a.homeY + (sim.by - a.homeY) * 0.1, 0.35, 0.5);
      d.ai.faceX = -1;
      break;
    case 'man': {
      const r = a.cover;
      if (!r) {
        stop(d);
        break;
      }
      if (r.ai.role !== 'route' && r.ai.role !== 'adjust') {
        // receiver stayed in / is blocking: help underneath
        hookZone(sim, d);
        break;
      }
      manCover(sim, d, r);
      break;
    }
    case 'deep':
      deepHelp(sim, d);
      break;
    case 'zone':
      hookZone(sim, d);
      break;
    case 'ball': {
      const b = sim.ball;
      if (b.landX === undefined || (b.state !== 'air' && b.state !== 'loose')) {
        setRole(d, 'pursue');
        break;
      }
      if (b.state === 'loose') chase(d, b.x + b.vx * 0.3, b.y + b.vy * 0.3, 1);
      else {
        // attack the catch point if he can get there in time (undercut the path), otherwise
        // rally to a spot just past it to cut off the run after the catch
        const ux = b.x0 - b.landX;
        const uy = b.y0 - b.landY;
        const ul = Math.hypot(ux, uy) || 1;
        const tLeft = Math.max(0, b.T - b.ft);
        const dl = Math.hypot(d.x - b.landX, d.y - b.landY);
        const under = d.pos === 'DB' ? 0.4 : -0.6; // DBs undercut the path; LBs play through the receiver
        if (dl / d.top <= tLeft + 0.15) chase(d, b.landX + (ux / ul) * under, b.landY + (uy / ul) * under, 1);
        else chase(d, b.landX + 2.5, b.landY + (d.y - b.landY) * 0.2, 1);
      }
      break;
    }
    case 'pursue': {
      const tgt = sim.carrier || (sim.ball.holder ? sim.byId[sim.ball.holder] : null);
      if (tgt) pursue(sim, d, tgt);
      else if (sim.ball.state === 'air' || sim.ball.state === 'loose') chase(d, sim.ball.landX ?? sim.ball.x, sim.ball.landY ?? sim.ball.y, 1);
      else stop(d);
      break;
    }
    case 'watch_ball': {
      const b = sim.ball;
      seek(d, b.landX ?? b.x, b.landY ?? b.y, 0.45, 2);
      break;
    }
    default:
      stop(d);
  }
}

// ------------------------------------------------------------------ snap / transitions

/**
 * Assign roles at the snap. `kind` = 'run' (handoff) or 'pass' (drop back).
 */
export function assignSnapRoles(sim, kind) {
  const id = sim.byId;
  const play = sim.play;
  const call = sim.defCall;
  const rng = sim.rng;
  const losX = sim.losX;
  const by = sim.by;
  for (const e of sim.players) {
    e.ai.react = e.side === 'def' ? reactionOf(sim, e) : 0.1;
    e.ai.pbias = rng.float(-1, 1);
    e.ai.homeX = e.x;
    e.ai.homeY = e.y;
  }
  const dl = ['DL1', 'DL2', 'DL3', 'DL4'].map((k) => id[k]);
  const ol = ['OL1', 'OL2', 'OL3', 'OL4', 'OL5'].map((k) => id[k]);
  const pairs = [[ol[0], dl[0]], [ol[1], dl[1]], [ol[3], dl[2]], [ol[4], dl[3]]];
  const blitzers = call.blitzers.map((k) => id[k]);
  const m = play.mirror;

  // ---- defense
  for (const d of dl) setRole(d, 'rush');
  for (const k of ['LB1', 'LB2', 'LB3']) {
    const lb = id[k];
    if (blitzers.includes(lb)) setRole(lb, 'rush');
    else setRole(lb, 'read');
  }
  // man assignments for receivers that release; FS deep; others zone
  const routeIds = new Set(play.routes.map((r) => r.playerId));
  const man = {};
  man.DB1 = 'WR1';
  man.DB2 = 'WR2';
  if (routeIds.has('TE2')) man.DB3 = 'TE2';
  const lbFree = ['LB1', 'LB3', 'LB2'].filter((k) => !call.blitzers.includes(k));
  if (lbFree.length) man[lbFree[0]] = 'RB';
  for (const k of ['DB1', 'DB2', 'DB3', 'DB4']) {
    const d = id[k];
    d.ai.cushion0 = Math.max(1.2, d.x - losX);
    if (man[k]) {
      setRole(d, 'man');
      d.ai.cover = id[man[k]];
    } else if (k === 'DB4' || k === 'DB3') setRole(d, 'deep');
  }
  // two-deep shell when the strong safety isn't in man; single-high otherwise
  if (!man.DB3) {
    setRole(id.DB3, 'deep');
    id.DB3.ai.half = Math.sign(id.DB3.y - by) || m;
    id.DB4.ai.half = -id.DB3.ai.half;
  } else id.DB4.ai.half = 0;
  for (const k of ['LB1', 'LB2', 'LB3']) {
    const lb = id[k];
    lb.ai.cushion0 = 1.0;
    lb.ai.zoneX = Math.min(losX + CV.hookDepth, FIELD.END_LINE - 1);
    lb.ai.zoneY = lb.y;
    if (lb.ai.role === 'read') {
      const readT = CV.readDelay + (sim.diff.react - 0.24) + rng.float(0, 0.12);
      if (kind === 'run') roleAfter(sim, lb, 'pursue', readT);
      else if (man[k]) roleAfter(sim, lb, 'man', readT, { cover: id[man[k]] });
      else roleAfter(sim, lb, 'zone', readT);
    }
  }
  if (kind === 'run') {
    for (const k of ['DB1', 'DB2', 'DB3', 'DB4']) {
      const d = id[k];
      roleAfter(sim, d, 'pursue', CV.dbRunRead + d.ai.react + rng.float(0, 0.15));
    }
  }

  // ---- offense
  const qb = id.QB;
  if (kind === 'pass') {
    const P = TUNING.pass;
    setRole(qb, 'qb_drop');
    qb.ai.dropX = losX - (play.formation === 'shotgun' ? P.dropDepthShotgun : P.dropDepthCenter);
    qb.ai.dropY = qb.y;
    qb.ai.dropFrac = Math.min(1, P.dropSpeed / qb.top);
    for (const [o, d] of pairs) {
      setRole(o, 'pass_pro');
      engage(sim, o, d, 'pass', passBeatTime(sim, o, d));
    }
    // centre: first blitzer, else double the stronger DT
    const pickers = [ol[2], id.TE1];
    if (play.teBlocks) pickers.push(id.TE2);
    const left = [...blitzers];
    for (const pk of pickers) {
      const b = left.shift();
      if (b) {
        setRole(pk, 'pickup');
        pk.ai.blockTarget = b;
        pk.ai.setX = pk === ol[2] ? losX - 2 : losX - 1.5;
        pk.ai.setY = pk.y;
        pk.ai.pickupWaitUntil = sim.t + 1.2;
      } else if (pk === ol[2]) {
        const dt = rushPower(dl[1]) >= rushPower(dl[2]) ? 1 : 2;
        const eng = dl[dt].ai.eng;
        if (eng) {
          eng.until = eng.start + (eng.until - eng.start) * B.doubleTeam;
          setRole(pk, 'help');
          pk.ai.helpEng = eng;
        } else setRole(pk, 'seek');
      } else {
        // chip the end man on his side, then help
        const end = pk.y >= by ? dl[3] : dl[0];
        const eng = end.ai.eng;
        if (eng) eng.until = eng.start + (eng.until - eng.start) * B.chip;
        setRole(pk, 'seek');
      }
    }
    for (const r of play.routes) {
      const e = id[r.playerId];
      setRole(e, 'route');
      e.ai.route = r.points;
      e.ai.ri = 1;
      e.ai.routeStartAt = sim.t;
      e.ai.settleAtEnd = r.type === 'curl' || r.type === 'checkdown';
      if (r.playerId === 'RB') {
        e.ai.routeStartAt = sim.t + TUNING.routes.rbFakeTime;
        const mesh = play.runLane.points[0];
        e.ai.fakeTo = { x: mesh.x, y: mesh.y };
      }
    }
    if (!routeIds.has('TE2') && id.TE2.ai.role !== 'pickup') setRole(id.TE2, 'seek');
  } else {
    // run: OL fire out on the DL, centre + TEs climb to linebackers, WRs stalk the corners
    for (const [o, d] of pairs) {
      setRole(o, 'run_block');
      engage(sim, o, d, 'run', runShedTime(sim, o, d));
    }
    const lbStrong = m > 0 ? id.LB3 : id.LB2;
    const lbWeak = m > 0 ? id.LB2 : id.LB3;
    const climb = (e, tgt) => {
      setRole(e, 'climb');
      e.ai.blockTarget = tgt;
    };
    climb(ol[2], id.LB1);
    climb(id.TE1, lbStrong);
    if (play.teBlocks) climb(id.TE2, lbWeak);
    else climb(id.TE2, id.DB3);
    for (const [wr, db] of [[id.WR1, id.DB1], [id.WR2, id.DB2]]) {
      setRole(wr, 'stalk');
      wr.ai.blockTarget = db;
    }
    setRole(qb, 'qb_mesh');
  }
}

/** Defensive / offensive reaction to a thrown ball. */
export function onThrow(sim, intended) {
  const b = sim.ball;
  for (const e of sim.players) {
    if (e.side === 'def') {
      if (e.ai.eng) continue;
      const dl = Math.hypot(e.x - b.landX, e.y - b.landY);
      const delay = e.ai.react + CV.ballReactExtra;
      if (e.ai.role === 'rush') roleAfter(sim, e, 'watch_ball', delay);
      else if (dl <= CV.breakRange) roleAfter(sim, e, 'ball', delay);
      else roleAfter(sim, e, 'pursue', delay + 0.1);
    } else if (e === intended) {
      e.ai.pending = { role: 'adjust', at: sim.t + 0.12 };
    }
  }
}

/** Everyone reacts to a new ball carrier (handoff complete, catch, tuck, return catch). */
export function onNewCarrier(sim, carrier, kind) {
  for (const e of sim.players) {
    if (e === carrier) continue;
    if (e.side === 'def') {
      if (e.ai.eng) continue;
      if (kind === 'tuck' && e.ai.role === 'man') {
        e.ai.waitLos = true;
        continue;
      }
      if (kind === 'handoff' && (e.ai.role === 'read' || e.ai.pending)) continue; // still reading
      if (e.ai.role === 'pursue' || e.ai.role === 'rush') {
        setRole(e, e.ai.role);
        e.ai.pending = null;
        continue;
      }
      // defenders right on top of the catch react at once
      const near = Math.hypot(e.x - carrier.x, e.y - carrier.y) < 4;
      roleAfter(sim, e, 'pursue', near ? 0.05 : e.ai.react + 0.05);
    } else if (kind !== 'handoff') {
      if (e.ai.eng) continue;
      if (e.ai.role === 'route' || e.ai.role === 'adjust' || e.ai.role === 'qb_drop') roleAfter(sim, e, 'seek', 0.25);
    }
  }
}

/** Main per-step AI pass for scrimmage plays. */
export function updateScrimmageAI(sim) {
  for (const e of sim.players) {
    const a = e.ai;
    a.speedMult = 1;
    a.accelMult = 1;
    a.faceX = 0;
    a.faceY = 0;
    if (a.pending && sim.t >= a.pending.at) {
      setRole(e, a.pending.role);
      if (a.pending.extra && a.pending.extra.cover) a.cover = a.pending.extra.cover;
      a.pending = null;
    }
    if (a.waitLos && sim.carrier && sim.carrier.x > sim.losX) {
      a.waitLos = false;
      roleAfter(sim, e, 'pursue', a.react);
    }
    if (e.down) {
      stop(e);
      a.accelMult = 2.5;
      continue;
    }
    if (e === sim.carrier || a.eng || a.lunge) continue;
    if (sim.t < a.stumbleUntil) a.speedMult = 0.25;
    if (e.side === 'off') offenseRole(sim, e);
    else defenseRole(sim, e);
  }
}

export { setRole };
