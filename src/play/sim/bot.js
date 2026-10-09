// Automated "player" for tests, soak runs and QA: issues the same commands a human would.
//   const bot = new SimBot({ seed, skill: 0.6 });  each frame: bot.step(sim, dt); sim.update(dt);
// Pass plays: drop back, read receivers along their drawn routes, lead the most open one around
// 1.5-2.5 s (hot throw under pressure, throw-away / scramble when nothing is open). Carrier: juke
// when a defender lunges, dive near the sticks / goal line, slip off the sideline. Kicks: taps the
// meters with configurable timing noise. Kick returns: optional touchback from deep in the end zone.
// Uses its own Rng so it never perturbs the simulation's random stream.

import { Rng } from '../../core/rng.js';
import { clamp } from '../../core/util.js';
import { FIELD, TUNING } from './tuning.js';
import { attr } from './squads.js';
import { ballSpeed, effectiveArm, maxThrowDist, planThrow, releasePoint } from './ball.js';
import { predictPostY, triSigned } from './kicking.js';
import { PlaySim } from './PlaySim.js';

const W = FIELD.W;

/** Walk a receiver's remaining route `s` yards from his current position. */
function alongRoute(r, s) {
  const pts = r.ai.route;
  let x = r.x;
  let y = r.y;
  if (!pts || r.ai.ri >= pts.length || r.ai.role !== 'route') {
    return { x: x + r.vx * (s / Math.max(1, Math.hypot(r.vx, r.vy))), y: y + r.vy * (s / Math.max(1, Math.hypot(r.vx, r.vy))) };
  }
  let left = s;
  for (let i = r.ai.ri; i < pts.length; i++) {
    const dx = pts[i].x - x;
    const dy = pts[i].y - y;
    const d = Math.hypot(dx, dy);
    if (d >= left) return { x: x + (dx / d) * left, y: y + (dy / d) * left };
    left -= d;
    x = pts[i].x;
    y = pts[i].y;
  }
  return { x, y }; // settles at the route end
}

export class SimBot {
  /**
   * @param {{seed?:number, skill?:number, passRate?:number, mode?:'auto'|'run'|'pass'|'hold',
   *   powerNoise?:number, aimNoise?:number, windComp?:number, touchbackRate?:number, juke?:boolean}} [opts]
   */
  constructor(opts = {}) {
    this.rng = new Rng((opts.seed ?? 7) >>> 0 || 7);
    this.skill = clamp(opts.skill ?? 0.6, 0, 1);
    this.passRate = opts.passRate ?? 0.55;
    this.mode = opts.mode || 'auto';
    this.powerNoise = opts.powerNoise ?? 0.065;
    this.aimNoise = opts.aimNoise ?? 0.055;
    this.windComp = opts.windComp ?? 0.8;
    this.touchbackRate = opts.touchbackRate ?? 0.6;
    this.useJukes = opts.juke ?? true;
    this.snapDelay = this.rng.float(0.2, 0.6);
    this.clock = 0;
    this.decided = null;
    this.throwStart = this.rng.float(1.35, 1.8);
    this.throwEnd = this.rng.float(2.2, 2.7);
    this.lastJukeT = -10;
    this.juked = new Set();
    this.powerTapAt = null;
    this.aimTapAt = null;
    this.tbChecked = false;
    this.truckOn = false;
    this.log = { throwT: null, target: null, open: null, sackT: null, action: null };
  }

  /** Issue commands for this frame (call before sim.update). */
  step(sim, dt) {
    this.clock += dt;
    if (sim.phase === 'dead') return;
    if (sim.kind === 'fg' || sim.kind === 'pat') {
      this._kick(sim);
      return;
    }
    if (sim.phase === 'presnap') {
      if (this.clock < this.snapDelay) return;
      let mode = this.mode;
      if (mode === 'auto') {
        let p = this.passRate;
        const toGo = sim.firstDownX - sim.losX;
        if ((sim.setup.down ?? 1) >= 3 && toGo > 5) p += 0.25;
        if (toGo <= 2) p -= 0.2;
        mode = this.rng.chance(clamp(p, 0.05, 0.95)) ? 'pass' : 'run';
      }
      this.log.action = mode;
      if (mode === 'run') sim.handoff();
      else sim.dropBack();
      return;
    }
    if (sim.phase === 'dropback') {
      this._pocket(sim);
      return;
    }
    if (sim.phase === 'carry' && sim.carrier && sim.carrier.controlled) this._carry(sim);
  }

  // ---------------------------------------------------------------- passing

  /** Rank throw options: [{x, y, bullet, open, score, id}] best first. */
  options(sim) {
    const qb = sim.byId.QB;
    const rp = releasePoint(qb);
    const arm = effectiveArm(sim, qb);
    const maxD = maxThrowDist(sim, qb);
    const out = [];
    for (const id of ['WR1', 'WR2', 'TE2', 'RB']) {
      const r = sim.byId[id];
      if (!r || r.down || (r.ai.role !== 'route' && r.ai.role !== 'adjust')) continue;
      const sp = Math.max(Math.hypot(r.vx, r.vy), r.top * 0.85);
      for (const bullet of [false, true]) {
        let p = { x: r.x, y: r.y };
        let T = 0;
        for (let k = 0; k < 4; k++) {
          const d = Math.hypot(p.x - rp.x, p.y - rp.y);
          T = Math.max(TUNING.pass.minFlight, d / ballSpeed(d, bullet, arm));
          p = alongRoute(r, sp * T);
        }
        const d = Math.hypot(p.x - rp.x, p.y - rp.y);
        if (d > maxD - 0.5 || d < 3) continue;
        if (p.y < 1.2 || p.y > W - 1.2 || p.x > FIELD.END_LINE - 0.8) continue;
        let open = 9;
        const plan = planThrow(rp.x, rp.y, p.x, p.y, bullet, arm);
        for (const df of sim.players) {
          if (df.side !== 'def' || df.down) continue;
          const dd = Math.max(0, Math.hypot(df.x - p.x, df.y - p.y) - 1.0);
          const tD = dd / df.top + (df.ai.eng ? 0.7 : 0) + 0.2;
          open = Math.min(open, tD - T);
          // a defender who can get into the ball's path while it is low enough to pick off
          if (df.pos === 'DL' || this.skill < 0.25) continue;
          const reach = 1.2 + 0.5 * this.skill;
          for (let k = 2; k < 10; k++) {
            const tt = (plan.T * k) / 10;
            const bz = plan.z0 + plan.vz * tt - 0.5 * plan.g * tt * tt;
            if (bz > TUNING.catch.reachZ) continue;
            const bx = rp.x + plan.vx * tt;
            const by = rp.y + plan.vy * tt;
            const lag = 0.25;
            const dist = Math.hypot(df.x - bx, df.y - by) - df.top * Math.max(0, tt - lag) * 0.8;
            if (dist < reach && Math.hypot(bx - p.x, by - p.y) > 1.5) {
              open = Math.min(open, -0.5);
              break;
            }
          }
        }
        // long, hanging throws need a bigger window
        open -= 0.2 * Math.max(0, T - 1.0);
        const gain = p.x - sim.losX;
        let score = open * 2 + gain * 0.025 + (p.x >= sim.firstDownX ? 0.25 : 0) - (bullet ? 0.35 : 0);
        if (p.x >= FIELD.OPP_GOAL) score += 0.4;
        out.push({ id, x: p.x, y: p.y, bullet, open, score, T });
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  _throw(sim, o) {
    const noise = 0.45 + (1 - this.skill) * 2.0;
    const tx = o.x + this.rng.normal(0, noise);
    const ty = o.y + this.rng.normal(0, noise);
    if (o.bullet !== sim._bullet) sim.toggleBullet();
    sim.aimAt(tx, ty);
    this.log.throwT = sim.t;
    this.log.target = o.id;
    this.log.open = o.open;
    sim.release();
  }

  _throwAway(sim) {
    const qb = sim.byId.QB;
    if (sim._bullet) sim.toggleBullet();
    sim.aimAt(qb.x + 14, qb.y < W / 2 ? -4 : W + 4);
    this.log.throwT = sim.t;
    this.log.target = 'away';
    sim.release();
  }

  _pocket(sim) {
    if (this.mode === 'hold') return;
    const qb = sim.byId.QB;
    const t = sim.t;
    let pressure = Infinity;
    for (const d of sim.players) {
      if (d.side !== 'def' || d.ai.eng || d.down) continue;
      pressure = Math.min(pressure, Math.hypot(d.x - qb.x, d.y - qb.y));
    }
    if (t < 0.45) return;
    // pressure is noticed only after a human-like reaction delay
    if (pressure < 3.0) {
      if (this.pressureSince === undefined) this.pressureSince = t;
    } else this.pressureSince = undefined;
    const hot = this.pressureSince !== undefined && t - this.pressureSince >= 0.22 + (1 - this.skill) * 0.35;
    if (!hot && t < this.throwStart && t <= 0.9) return;
    const opts = this.options(sim);
    const best = opts[0];
    if (hot) {
      if (best && (best.open > -0.35 || this.skill < 0.5)) this._throw(sim, best);
      else if (this.skill >= 0.5 && this.rng.chance(0.5)) this._throwAway(sim);
      else if (best) this._throw(sim, best);
      else sim.tuck();
      return;
    }
    if (t < this.throwStart) {
      if (best && best.open > 0.9 && t > 0.9) this._throw(sim, best);
      return;
    }
    if (best && best.open > 0.25 - 0.15 * (t - this.throwStart)) {
      this._throw(sim, best);
      return;
    }
    if (t >= this.throwEnd) {
      if (best && best.open > -0.3) this._throw(sim, best);
      else if (this.skill > 0.55 && attr(qb.squad, 'speed', 0.2) > 0.55 && this.rng.chance(0.4)) sim.tuck();
      else if (this.skill > 0.45) this._throwAway(sim);
      else if (best) this._throw(sim, best);
      else this._throwAway(sim);
    }
  }

  // ---------------------------------------------------------------- carrying

  _carry(sim) {
    const C = sim.carrier;
    const cs = sim.cs;
    if (!cs || cs.dive) return;
    const t = sim.t;
    // kick return: take a knee deep in the end zone
    if (sim.kind === 'kick_return' && !this.tbChecked) {
      this.tbChecked = true;
      if (C.x < 3 && this.rng.chance(this.touchbackRate)) {
        sim.stutter();
        return;
      }
    }
    let nearest = Infinity;
    let threat = null;
    for (const d of sim.players) {
      if (d.side !== 'def' || d.down || d.ai.eng) continue;
      const dist = Math.hypot(d.x - C.x, d.y - C.y);
      if (dist < nearest) nearest = dist;
      if (d.lunging && d.ai.lunge && !this.juked.has(d.ai.lunge)) {
        const age = t - d.ai.lunge.t0;
        const react = 0.06 + (1 - this.skill) * 0.25;
        if (age >= react) {
          this.juked.add(d.ai.lunge);
          if (this.useJukes && this.rng.chance(0.1 + 0.5 * this.skill)) threat = d;
        }
      }
    }
    const goalDist = FIELD.OPP_GOAL - C.x;
    const stickDist = sim.firstDownX - C.x;
    const reachDive = TUNING.carrier.diveDistBase + 0.2;
    const lunged = threat !== null || [...sim.players].some((d) => d.side === 'def' && d.ai.lunge && Math.hypot(d.x - C.x, d.y - C.y) < 2);
    if (nearest < 2.2 && goalDist > 0 && (goalDist < reachDive || (lunged && goalDist < 3.5))) {
      sim.dive();
      return;
    }
    if (sim.kind === 'scrimmage' && stickDist > 0 && stickDist < reachDive && nearest < 2.2) {
      sim.dive();
      return;
    }
    if (threat) {
      let dir = C.y >= threat.y ? 1 : -1;
      if ((dir < 0 && C.y < 2.5) || (dir > 0 && C.y > W - 2.5)) dir = -dir;
      sim.sideStep(dir);
      this.lastJukeT = t;
      return;
    }
    if ((C.y < 1.6 || C.y > W - 1.6) && t - this.lastJukeT > 0.7 && Math.abs(C.vx) > 1) {
      sim.sideStep(C.y < W / 2 ? 1 : -1);
      this.lastJukeT = t;
      return;
    }
    // power backs truck through a lone defender straight ahead
    if (attr(C.squad, 'strength', 0.2) > 0.65 && this.skill > 0.4) {
      let ahead = false;
      for (const d of sim.players) {
        if (d.side !== 'def' || d.down || d.ai.eng) continue;
        const dx = d.x - C.x;
        if (dx > 0 && dx < 4 && Math.abs(d.y - C.y) < 1.2) ahead = true;
      }
      if (ahead !== this.truckOn) {
        sim.truck(ahead);
        this.truckOn = ahead;
      }
    }
  }

  // ---------------------------------------------------------------- kicking

  _kick(sim) {
    const k = sim.kick;
    if (!k) return;
    if (sim.phase === 'presnap') {
      if (this.powerTapAt === null) {
        const P = k.powerPeriod;
        let peak = (Math.floor(k.clock / P) + 0.5) * P;
        while (peak < k.clock + 0.4) peak += P;
        this.powerTapAt = peak + this.rng.normal(0, this.powerNoise);
      }
      if (k.clock >= this.powerTapAt) sim.kickTap();
      return;
    }
    if (sim.phase !== 'kick' || k.stage !== 'aim' || k.aimLocked) return;
    if (this.aimTapAt === null) {
      // aim that centres the ball between the uprights with this power (wind-compensated)
      let bestA = 0;
      let bestErr = Infinity;
      for (let i = -40; i <= 40; i++) {
        const a = i / 40;
        const p = predictPostY(sim, a, k.power);
        if (!p) continue;
        const err = Math.abs(p.y - W / 2);
        if (err < bestErr) {
          bestErr = err;
          bestA = a;
        }
      }
      let a0 = 0;
      let e0 = Infinity;
      const calm = { x: sim.setup.wind?.x || 0, y: 0 };
      for (let i = -40; i <= 40; i++) {
        const a = i / 40;
        const p = predictPostY(sim, a, k.power, calm);
        if (!p) continue;
        const err = Math.abs(p.y - W / 2);
        if (err < e0) {
          e0 = err;
          a0 = a;
        }
      }
      const want = a0 + (bestA - a0) * this.windComp;
      // next time the sweeping arrow passes `want`
      let tc = k.aimClock + 0.25;
      const step = 1 / 600;
      let prev = triSigned(tc / k.sweepPeriod);
      for (let i = 0; i < 6000; i++) {
        tc += step;
        const v = triSigned(tc / k.sweepPeriod);
        if ((prev - want) * (v - want) <= 0) break;
        prev = v;
      }
      this.aimTapAt = tc + this.rng.normal(0, this.aimNoise);
      this.aimTapAt = Math.min(this.aimTapAt, TUNING.kick.pressureLimit - k.releaseDelay - 0.25);
    }
    if (k.aimClock >= this.aimTapAt) sim.kickTap();
  }
}

/**
 * Run one complete play with a bot. Returns { sim, result, bot }.
 * @param {import('../../types.js').PlaySetup} setup
 */
export function runBotPlay(setup, botOpts = {}) {
  const sim = new PlaySim(setup);
  const bot = new SimBot({ seed: ((setup.seed >>> 0) ^ 0x5bd1e995) >>> 0, ...botOpts });
  const dt = TUNING.step;
  for (let i = 0; i < 60 * 60 && !sim.result; i++) {
    bot.step(sim, dt);
    sim.update(dt);
  }
  return { sim, result: sim.result, bot };
}
