// PlaySim: headless, deterministic simulation of ONE play (MECHANICS 2-4; contract in
// docs/ARCHITECTURE.md "PLAY-SIM contract"). Offense always attacks +x. DOM-free.
//
//   const sim = new PlaySim(setup);  sim.update(1/60);  ...commands...;  sim.result
//
// Phases: presnap -> (handoff() -> carry) | (dropBack() -> dropback -> air -> carry | dead)
//         fg/pat: presnap (power meter) -> kickTap() -> kick -> dead
//         kick_return: return (ball in the air) -> carry -> dead
//
// Notes for the view / controller (additions to the ARCHITECTURE contract):
//  - Ids are slot names: QB RB WR1 WR2 TE1 TE2 OL1..OL5 (OL3 = centre) / DL1..4 LB1..3 DB1..4;
//    kicks: K (kicker) and H (holder); kick return: KR (returner, side 'off'), KB1..10 blockers,
//    CV1..10 + K coverage. sim.getPlayer(id), sim.byId, sim.qb, sim.rb (the RB tap target).
//    changePlay() REBUILDS sim.players (new entity objects) - re-read the array after it.
//  - After handoff() the phase is already 'carry' but the ball stays with the QB for the mesh
//    (<= 0.75 s); the RB is `controlled` immediately, carrier moves apply once sim.carrier is set
//    (event 'handoff').
//  - Entities also have z (hop / dive height), name, role, top (yd/s); `blocking` is the id of the
//    engaged opponent (both sides) or null; `lunging` covers the dive telegraph + burst.
//  - sim.carrier / sim.carrierState: {truckCharge 0..1, trucking, jukeEff (next juke 1..0.25),
//    diving, stuttering, taunting, stiffLeft, hurdleLeft, brokenTackles}.
//  - aim extras: showMarker (visibleFrac >= 1), dist, flightTime, clamped. The arc re-anchors to
//    the QB every step while aiming. sim.maxThrowDist() helps scale slingshot drag -> aimAt.
//  - kick extras: spotX/spotY, distance, maxDist, baseAngle, aimAngle (world radians of the
//    arrow), sweepDeg, sweepPeriod, powerPeriod, greenBand, pressureLimit, releaseDelay,
//    powerLocked, aimLocked, result ('good'|'miss'|'blocked'), missDir ('left'|'right'|'short'),
//    doink. The power meter cycles in presnap; the first kickTap() is the snap.
//  - Result extras: returner, defender, hits [{playerId, power}], twoPoint, twoPointGood, firstDown,
//    playName, kickDistance, fumbleLost, defensiveTd, dive.
//  - Extra events: tuck, whiff (lunge missed without a move), broken_tackle, incomplete,
//    turnover, recover. sim.eventLog keeps every event of the play.

import { Rng } from '../../core/rng.js';
import { clamp } from '../../core/util.js';
import { FIELD, TUNING, diffParams } from './tuning.js';
import { normalizeSquad, attr, skill } from './squads.js';
import { makeEntity, integrate, pushHist, setAnim, holdAnim, distE } from './entity.js';
import { alignDefense, alignKick, alignKickoff } from './formations.js';
import { rollPlay, rollDefenseCall } from './plays.js';
import {
  assignSnapRoles, updateScrimmageAI, updateEngagements, onThrow, onNewCarrier, releaseEngagement,
} from './ai.js';
import {
  computeAim, releasePoint, planThrow, effectiveArm, scatterRadius, launchBall, stepBall, catchCheck,
  deflectBall, samplePath, maxThrowDist,
} from './ball.js';
import {
  makeCarrierState, cmdSideStep, cmdDrift, cmdDive, cmdStutter, cmdTruck, updateCarrier, updateTackling,
  updateSacks, checkBounds, updateDive,
} from './carrier.js';
import { initKick, kickPresnap, kickTap, updateKick, initKickoff, updateKickoffAI, pickReturner } from './kicking.js';

const W = FIELD.W;
const STAT_KEYS = ['passAtt', 'passCmp', 'passYds', 'passTd', 'int', 'rushAtt', 'rushYds', 'rushTd', 'rec', 'recYds',
  'recTd', 'fgAtt', 'fgMade', 'fgLong', 'patAtt', 'patMade', 'sacked', 'fumbles', 'retYds', 'retTd'];

export class PlaySim {
  /** @param {import('../../types.js').PlaySetup} setup */
  constructor(setup) {
    this.setup = setup || {};
    const s = this.setup;
    this.kind = s.kind || 'scrimmage';
    this.twoPoint = !!s.twoPoint && this.kind === 'scrimmage';
    this.rng = new Rng((Number(s.seed) >>> 0) || 1);
    this.weather = s.weather || 'clear';
    const legacy = TUNING.difficulty.legacyStep[clamp(Math.round(s.difficulty ?? 1), 0, 2)];
    this.diff = diffParams(Number.isFinite(s.difficultyStep) ? s.difficultyStep : legacy);
    let losX = Number.isFinite(s.losX) ? s.losX : 35;
    if (this.kind === 'pat') losX = TUNING.kick.patLosX;
    if (this.twoPoint) losX = 108;
    if (this.kind === 'kick_return') losX = TUNING.kickoff.kickX;
    this.losX = clamp(losX, 10.5, 109.5);
    this.firstDownX = this.twoPoint ? FIELD.OPP_GOAL : Number.isFinite(s.firstDownX) ? s.firstDownX : Math.min(this.losX + 10, FIELD.OPP_GOAL);
    this.by = clamp(Number.isFinite(s.hashY) ? s.hashY : W / 2, 6, W - 6);
    this.phase = 'presnap';
    this.t = 0;
    this.result = null;
    this.players = [];
    this.byId = {};
    this.engagements = [];
    this.aim = null;
    this.kick = null;
    this.kickoff = null;
    this.carrier = null;
    this.cs = null;
    this.carrierState = null;
    this.controlledId = null;
    this.touchbackPending = false;
    this._events = [];
    this.eventLog = [];
    this._bullet = false;
    this._runMode = false;
    this._aimTarget = null;
    this._hits = [];
    this._type = this.kind === 'fg' || this.kind === 'pat' ? 'kick' : this.kind === 'kick_return' ? 'return' : 'run';
    this._passer = null;
    this._receiver = null;
    this._rusher = null;
    this._thrown = false;
    this._completed = false;
    this._sacked = false;
    this._tackler = null;
    this.offSquad = normalizeSquad(s.offense);
    this.defSquad = normalizeSquad(s.defense);
    this.ball = { x: this.losX, y: this.by, z: 0.2, vx: 0, vy: 0, vz: 0, state: 'held', holder: null, bullet: false, serial: 0 };

    if (this.kind === 'fg' || this.kind === 'pat') this._buildKick();
    else if (this.kind === 'kick_return') this._buildKickoff();
    else this._buildScrimmage(true);
  }

  // =================================================================== building

  _add(id, side, pos, sp, p) {
    const e = makeEntity(this, id, side, pos, sp, p.x, p.y);
    this.players.push(e);
    this.byId[id] = e;
    return e;
  }

  _buildScrimmage(first) {
    const o = this.offSquad;
    const d = this.defSquad;
    if (!first) {
      this.players = [];
      this.byId = {};
    }
    this.play = rollPlay(this.rng, this.losX, this.by);
    const toGo = this.firstDownX - this.losX;
    this.defCall = rollDefenseCall(this.rng, { down: this.setup.down ?? 1, toGo, losX: this.losX }, this.play);
    const a = this.play.align;
    const da = alignDefense(a, this.losX, this.by, this.defCall);
    this._add('QB', 'off', 'QB', o.QB, a.QB);
    this._add('RB', 'off', 'RB', o.RB, a.RB);
    this._add('WR1', 'off', 'WR', o.WR[0], a.WR1);
    this._add('WR2', 'off', 'WR', o.WR[1], a.WR2);
    this._add('TE1', 'off', 'TE', o.TE[0], a.TE1);
    this._add('TE2', 'off', 'TE', o.TE[1], a.TE2);
    for (let i = 0; i < 5; i++) this._add(`OL${i + 1}`, 'off', 'OL', o.OL[i], a[`OL${i + 1}`]);
    for (let i = 0; i < 4; i++) this._add(`DL${i + 1}`, 'def', 'DL', d.DL[i], da[`DL${i + 1}`]);
    for (let i = 0; i < 3; i++) this._add(`LB${i + 1}`, 'def', 'LB', d.LB[i], da[`LB${i + 1}`]);
    for (let i = 0; i < 4; i++) this._add(`DB${i + 1}`, 'def', 'DB', d.DB[i], da[`DB${i + 1}`]);
    this.ball.holder = 'OL3';
    this.ball.state = 'held';
    this.ball.x = this.losX;
    this.ball.y = this.by;
    this.ball.z = 0.2;
    this.rbId = 'RB';
    this.qbId = 'QB';
  }

  _buildKick() {
    const o = this.offSquad;
    const d = this.defSquad;
    const al = alignKick(this.losX, this.by);
    this._add('K', 'off', 'K', o.K, al.off.K);
    this._add('H', 'off', 'QB', o.QB, al.off.H);
    for (let i = 0; i < 5; i++) this._add(`OL${i + 1}`, 'off', 'OL', o.OL[i], al.off[`OL${i + 1}`]);
    this._add('TE1', 'off', 'TE', o.TE[0], al.off.TE1);
    this._add('TE2', 'off', 'TE', o.TE[1], al.off.TE2);
    this._add('WR1', 'off', 'WR', o.WR[0], al.off.WR1);
    this._add('WR2', 'off', 'WR', o.WR[1], al.off.WR2);
    for (let i = 0; i < 4; i++) this._add(`DL${i + 1}`, 'def', 'DL', d.DL[i], al.def[`DL${i + 1}`]);
    for (let i = 0; i < 3; i++) this._add(`LB${i + 1}`, 'def', 'LB', d.LB[i], al.def[`LB${i + 1}`]);
    for (let i = 0; i < 4; i++) this._add(`DB${i + 1}`, 'def', 'DB', d.DB[i], al.def[`DB${i + 1}`]);
    for (const e of this.players) {
      e.ai.rushPace = e.side === 'def' ? this.rng.float(0.75, 1) : 1;
      e.face.x = e.side === 'off' ? 1 : -1;
    }
    this.byId.K.face = { x: 1, y: 0 };
    this.byId.H.anim = 'stance';
    this.play = { name: this.kind === 'pat' ? 'EXTRA POINT' : 'FIELD GOAL', formation: 'kick', qbDepth: 0, routes: [], runLane: null, teBlocks: true };
    this._kicker = this.byId.K;
    this.controlledId = 'K';
    this.byId.K.controlled = true;
    initKick(this);
  }

  _buildKickoff() {
    const o = this.offSquad;
    const opp = this.defSquad;
    const al = alignKickoff();
    const ret = pickReturner(o);
    const pool = [...o.LB, ...o.DB, ...o.TE, ...o.WR, o.RB, ...o.DL].filter((p) => p !== ret && !(ret.id && p.id === ret.id));
    const kr = this._add('KR', 'off', ret.pos || 'WR', ret, al.off.KR);
    for (let i = 0; i < 10; i++) {
      const sp = pool[i];
      this._add(`KB${i + 1}`, 'off', sp.pos || 'LB', sp, al.off[`RB${i + 1}`]);
    }
    this._add('K', 'def', 'K', opp.K, al.def.K);
    const cov = [...opp.LB, ...opp.DB, ...opp.DL.slice(0, 3)];
    for (let i = 0; i < 10; i++) this._add(`CV${i + 1}`, 'def', cov[i].pos || 'LB', cov[i], al.def[`CV${i + 1}`]);
    for (const e of this.players) e.face.x = e.side === 'off' ? 1 : -1;
    kr.controlled = true;
    this.controlledId = 'KR';
    this._returner = kr;
    this.play = { name: 'KICK RETURN', formation: 'kickoff', qbDepth: 0, routes: [], runLane: null, teBlocks: true };
    this.phase = 'return';
    initKickoff(this);
    for (const e of this.players) e.ai.react = this.diff.react;
  }

  // =================================================================== public helpers

  /** @returns {import('./entity.js').Entity|undefined} */
  getPlayer(id) {
    return this.byId[id];
  }

  get rb() {
    return this.byId.RB || null;
  }

  get qb() {
    return this.byId.QB || null;
  }

  /** Max pass distance for the current QB (yd). */
  maxThrowDist() {
    const qb = this.byId.QB;
    return qb ? maxThrowDist(this, qb) : 0;
  }

  drainEvents() {
    const ev = this._events;
    this._events = [];
    return ev;
  }

  _emit(type, x, y, extra) {
    const ev = { type, x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0, t: this.t, ...(extra || {}) };
    this._events.push(ev);
    this.eventLog.push(ev);
    if (this._events.length > 400) this._events.shift();
  }

  _hit(e, power) {
    if (e && e.squad && e.squad.id) this._hits.push({ playerId: e.squad.id, power: Math.round(clamp(power, 0, 1) * 100) / 100 });
  }

  // =================================================================== commands

  changePlay() {
    if (this.phase !== 'presnap' || this.kind !== 'scrimmage') return false;
    this._buildScrimmage(false);
    return true;
  }

  handoff() {
    if (this.phase !== 'presnap' || this.kind !== 'scrimmage') return false;
    this._snap('run');
    return true;
  }

  dropBack() {
    if (this.phase !== 'presnap' || this.kind !== 'scrimmage') return false;
    this._snap('pass');
    return true;
  }

  _snap(kind) {
    this.t = 0;
    this._emit('snap', this.losX, this.by, { kind });
    const qb = this.byId.QB;
    this.ball.holder = 'QB';
    this._passer = qb;
    assignSnapRoles(this, kind);
    if (kind === 'pass') {
      this.phase = 'dropback';
      this._type = 'pass';
      qb.controlled = true;
      this.controlledId = 'QB';
    } else {
      this.phase = 'carry';
      this._type = 'run';
      const rb = this.byId.RB;
      rb.controlled = true;
      this.controlledId = 'RB';
      rb.ai.role = 'mesh';
      rb.role = 'mesh';
      const lane = this.play.runLane.points;
      this._mesh = { x: lane[0].x, y: lane[0].y };
      const side = this.play.runLane.side;
      qb.ai.meshX = lane[0].x + 0.2;
      qb.ai.meshY = lane[0].y - side * 0.8;
      qb.ai.fakeX = lane[0].x - 2.5;
      qb.ai.fakeY = lane[0].y - side * 2.5;
    }
  }

  aimAt(x, y) {
    if (this.phase !== 'dropback' || !Number.isFinite(x) || !Number.isFinite(y)) return;
    this._aimTarget = { x, y };
    this._refreshAim();
  }

  aimRunMode(on) {
    if (this.phase !== 'dropback') return;
    this._runMode = !!on;
    if (!this._aimTarget) {
      const qb = this.byId.QB;
      this._aimTarget = { x: qb.x + 10, y: qb.y };
    }
    this._refreshAim();
  }

  toggleBullet() {
    if (this.phase !== 'dropback') return;
    this._bullet = !this._bullet;
    if (this.aim) this._refreshAim();
  }

  aimCancel() {
    this.aim = null;
    this._aimTarget = null;
    this._runMode = false;
  }

  _refreshAim() {
    const qb = this.byId.QB;
    if (!qb || !this._aimTarget) return;
    this.aim = computeAim(this, qb, this._aimTarget.x, this._aimTarget.y, this._runMode, this._bullet);
  }

  release() {
    if (this.phase !== 'dropback' || !this.aim) return false;
    if (this.aim.runMode) {
      this.tuck();
      return true;
    }
    if (!this.aim.valid) {
      this.aimCancel();
      return false;
    }
    this._throw();
    return true;
  }

  tuck() {
    if (this.phase !== 'dropback') return false;
    const qb = this.byId.QB;
    this.aim = null;
    this._aimTarget = null;
    this._type = 'run';
    this._scramble = true;
    this._setCarrier(qb, 'free', 'tuck');
    this._emit('tuck', qb.x, qb.y, { id: qb.id });
    return true;
  }

  sideStep(dir) {
    return cmdSideStep(this, dir);
  }

  drift(dir) {
    cmdDrift(this, dir);
  }

  dive() {
    return cmdDive(this);
  }

  stutter() {
    return cmdStutter(this);
  }

  truck(on) {
    cmdTruck(this, on);
  }

  kickTap() {
    if (this.kind !== 'fg' && this.kind !== 'pat') return false;
    return kickTap(this);
  }

  _snapKick() {
    this.phase = 'kick';
    this.t = 0;
    this._emit('snap', this.losX, this.by, { kind: 'kick' });
  }

  // =================================================================== transitions

  _setCarrier(e, mode, how, lane) {
    if (this.carrier && this.carrier !== e) {
      this.carrier.hasBall = false;
      this.carrier.controlled = false;
    }
    for (const p of this.players) p.controlled = false;
    this.carrier = e;
    e.hasBall = true;
    e.controlled = true;
    this.controlledId = e.id;
    if (e.ai.eng) releaseEngagement(this, e.ai.eng, false);
    e.ai.role = 'carrier';
    e.role = 'carrier';
    e.ai.pending = null;
    this.ball.state = 'held';
    this.ball.holder = e.id;
    this.ball.landX = undefined;
    this.cs = makeCarrierState(this, e, mode, lane);
    this.carrierState = this.cs;
    this.phase = 'carry';
    if (how === 'tuck' || how === 'handoff') this._rusher = e;
    onNewCarrier(this, e, how);
  }

  _throw() {
    const qb = this.byId.QB;
    const aim = this.aim;
    const rng = this.rng;
    const rp = releasePoint(qb);
    let pressured = false;
    for (const d of this.players) {
      if (d.side === 'def' && !d.ai.eng && !d.down && distE(d, qb) < 2.5) pressured = true;
    }
    // accuracy scatter
    const r = scatterRadius(this, qb, aim.dist, aim.bullet, pressured);
    const sx = clamp(rng.normal(0, r * 0.5), -r, r);
    const sy = clamp(rng.normal(0, r * 0.5), -r, r);
    const tx = aim.tx + sx;
    const ty = aim.ty + sy;
    const plan = planThrow(rp.x, rp.y, tx, ty, aim.bullet, effectiveArm(this, qb));
    launchBall(this, rp.x, rp.y, plan, aim.bullet, false);
    const b = this.ball;
    b.landX = tx;
    b.landY = ty;
    b.thrower = qb.id;
    b.path = samplePath(rp.x, rp.y, plan);
    this._thrown = true;
    this._throwT = this.t;
    this._throwFrom = { x: qb.x, y: qb.y };
    qb.hasBall = false;
    qb.controlled = false;
    this.controlledId = null;
    holdAnim(qb, 'throw', TUNING.pass.throwAnim, this.t);
    this.phase = 'air';
    this.aim = null;
    this._aimTarget = null;
    // intended receiver: eligible offensive player projected closest to the landing spot
    let best = null;
    let bd = 8;
    for (const e of this.players) {
      if (e.side !== 'off' || !(e.pos === 'WR' || e.pos === 'TE' || e.pos === 'RB')) continue;
      const px = e.x + e.vx * plan.T;
      const py = e.y + e.vy * plan.T;
      const d = Math.hypot(px - tx, py - ty);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    this._intended = best;
    this._emit('throw', rp.x, rp.y, { id: qb.id, tx, ty, bullet: aim.bullet, target: best ? best.id : null, T: plan.T });
    onThrow(this, best);
    // batted at the line
    const P = TUNING.pass;
    for (const d of this.players) {
      if (d.side !== 'def' || (d.pos !== 'DL' && d.pos !== 'LB') || d.down) continue;
      const dd = distE(d, qb);
      if (dd > P.batRange) continue;
      const ux = (tx - rp.x) / (plan.dist || 1);
      const uy = (ty - rp.y) / (plan.dist || 1);
      const along = (d.x - rp.x) * ux + (d.y - rp.y) * uy;
      const perp = Math.abs(-(d.x - rp.x) * uy + (d.y - rp.y) * ux);
      if (along < 0.2 || perp > 1.1) continue;
      const pBat = (aim.bullet ? P.batChanceBullet : P.batChanceLob) * (0.5 + skill(d.squad, 'passRush', 0.2));
      if (rng.chance(pBat)) {
        stepBall(b, 0.08);
        deflectBall(this, d);
        this._emit('deflect', b.x, b.y, { id: d.id, batted: true });
        break;
      }
    }
  }

  _onCatch(p, near) {
    const b = this.ball;
    if (p.y < 0 || p.y > W || p.x > FIELD.END_LINE) {
      this._incomplete('oob');
      return;
    }
    if (p.side !== 'off') return;
    this._completed = true;
    this._receiver = p;
    this._catchX = p.x;
    p.vx *= TUNING.carrier.catchSpeedKeep;
    p.vy *= TUNING.carrier.catchSpeedKeep;
    holdAnim(p, 'catch', TUNING.catch.catchAnim, this.t);
    this._emit('catch', p.x, p.y, { id: p.id, contested: !!near, tipped: !!b.tipped });
    this._setCarrier(p, 'free', 'catch');
    // fumble on a big hit at the catch
    if (near && near.dist < 1.0) {
      const hands = skill(p.squad, 'hands', 0.2);
      if (this.rng.chance(TUNING.catch.catchFumble * (1.6 - 1.2 * hands))) {
        this._fumble(p, near.d);
        return;
      }
    }
    if (p.x >= FIELD.OPP_GOAL) this._touchdown(p);
  }

  _onInt(d) {
    const b = this.ball;
    this._intBy = d;
    b.state = 'held';
    b.holder = d.id;
    d.hasBall = true;
    holdAnim(d, 'catch', 0.4, this.t);
    this._emit('int', d.x, d.y, { id: d.id });
    let tx;
    let defensiveTd = false;
    if (d.x >= FIELD.OPP_GOAL) tx = TUNING.result.intTouchbackX;
    else {
      const ret = this.rng.float(0, TUNING.result.intReturnMax) * (0.5 + attr(d.squad, 'speed', 0.2));
      tx = d.x - ret;
      // returned into the offense's end zone = pick-six
      if (tx <= FIELD.OWN_GOAL) {
        defensiveTd = true;
        tx = FIELD.OWN_GOAL;
      } else tx = clamp(tx, FIELD.OWN_GOAL + 1, FIELD.OPP_GOAL - 1);
    }
    this._finish('interception', { endX: tx, endY: d.y, turnover: true, turnoverX: tx, defensiveTd });
  }

  _onDeflect(p) {
    deflectBall(this, p);
    this._emit('deflect', p.x, p.y, { id: p.id });
  }

  _onDrop(p) {
    this._emit('drop', p.x, p.y, { id: p.id });
    this._incomplete('drop');
  }

  _incomplete(reason) {
    this._emit('incomplete', this.ball.x, this.ball.y, { reason });
    this._finish('incomplete', { endX: this.losX, endY: this.by });
  }

  _sack(qb, d) {
    this._sacked = true;
    this._tackler = d;
    setAnim(d, 'tackle');
    holdAnim(qb, 'down', 2, this.t);
    qb.down = true;
    this._hit(qb, clamp(0.45 + Math.hypot(d.vx, d.vy) / 20, 0, 1));
    this.aim = null;
    this._emit('sack', qb.x, qb.y, { id: qb.id, by: d.id });
    if (this.rng.chance(TUNING.rush.stripChance)) {
      this._fumble(qb, d, true);
      return;
    }
    if (qb.x <= FIELD.OWN_GOAL) {
      this._emit('safety', qb.x, qb.y, {});
      this._finish('safety', { endX: FIELD.OWN_GOAL, endY: qb.y });
      return;
    }
    this._finish('sack', { endX: qb.x, endY: qb.y });
  }

  /** Ball carrier (or sacked QB) fumbles; defense recovers ~65%. */
  _fumble(C, d, sack = false) {
    const x = C.x;
    this._fumbled = C;
    this._emit('fumble', C.x, C.y, { id: C.id, by: d ? d.id : null });
    const lost = this.rng.chance(TUNING.fumble.defRecover);
    this.ball.state = 'loose';
    if (lost) {
      this._emit('turnover', x, C.y, { recoveredBy: 'def' });
      // recovered by the defense in the offense's own end zone = defensive TD
      const defensiveTd = x <= FIELD.OWN_GOAL;
      const tx = defensiveTd ? FIELD.OWN_GOAL : clamp(x, FIELD.OWN_GOAL + 0.5, FIELD.OPP_GOAL - 0.5);
      this._finish('fumble', { endX: tx, endY: C.y, turnover: true, turnoverX: tx, fumbleLost: true, defensiveTd });
      return;
    }
    this._emit('recover', x, C.y, { recoveredBy: 'off' });
    if (sack) this._sacked = true;
    this._downedAt(C, x, sack ? 'sack' : 'tackle');
  }

  _downed(C, how) {
    this._downedAt(C, C.x, how);
  }

  _downedAt(C, x, how) {
    const cs = this.cs;
    if (x >= FIELD.OPP_GOAL && this.carrier === C) {
      this._touchdown(C);
      return;
    }
    if (x <= FIELD.OWN_GOAL) {
      if (this.kind === 'kick_return' && cs && !cs.leftEndZone) {
        this._touchback();
        return;
      }
      this._emit('safety', x, C.y, {});
      this._finish('safety', { endX: FIELD.OWN_GOAL, endY: C.y });
      return;
    }
    this._finish(how === 'sack' ? 'sack' : 'tackle', { endX: x, endY: C.y, dive: how === 'dive' });
  }

  _oob(C, y) {
    const cs = this.cs;
    C.y = y;
    this._emit('oob', C.x, y, { id: C.id });
    if (C.x <= FIELD.OWN_GOAL) {
      if (this.kind === 'kick_return' && cs && !cs.leftEndZone) {
        this._touchback();
        return;
      }
      this._emit('safety', C.x, y, {});
      this._finish('safety', { endX: FIELD.OWN_GOAL, endY: y });
      return;
    }
    this._finish('oob', { endX: Math.min(C.x, FIELD.OPP_GOAL - 0.01), endY: y });
  }

  _touchdown(C) {
    holdAnim(C, 'celebrate', 3, this.t);
    this._emit('td', C.x, C.y, { id: C.id });
    this._finish(this.kind === 'kick_return' ? 'return_td' : 'td', { endX: FIELD.OPP_GOAL, endY: clamp(C.y, 0, W) });
  }

  _touchback() {
    this._emit('touchback', this.ball.x, this.ball.y, {});
    this._finish('touchback', { endX: TUNING.kickoff.touchbackX, endY: W / 2 });
  }

  _kickResult(outcome) {
    const k = this.kick;
    const kx = k.spotX;
    if (outcome === 'fg_miss' || outcome === 'kick_blocked') {
      if (this.kind === 'fg') {
        const tx = Math.min(kx, TUNING.kick.missTurnoverMax);
        this._finish(outcome, { endX: tx, endY: this.by, turnover: true, turnoverX: tx });
        return;
      }
    }
    this._finish(outcome, { endX: this.losX, endY: this.by });
  }

  // =================================================================== stepping

  update(dt) {
    if (!(dt > 0)) return;
    let left = Math.min(dt, 0.25);
    const step = TUNING.step;
    while (left > 1e-9) {
      const h = Math.min(step, left);
      this._step(h);
      left -= h;
    }
  }

  _step(dt) {
    if (this.phase === 'presnap') {
      if (this.kick) kickPresnap(this, dt);
      this._animTick(dt);
      return;
    }
    if (this.phase === 'dead') {
      // cosmetic: a kicked ball finishes its flight after the whistle
      if (this.kick && this.kick.path.length && this.ball.state === 'kicked') {
        const k = this.kick;
        k.flightT = Math.min(k.tEnd, (k.flightT || 0) + dt);
        const p = k.path[Math.min(k.path.length - 1, Math.round((k.flightT / Math.max(0.05, k.tEnd)) * (k.path.length - 1)))];
        this.ball.x = p.x;
        this.ball.y = p.y;
        this.ball.z = p.z;
      }
      this._animTick(dt);
      return;
    }
    this.t += dt;
    for (const e of this.players) pushHist(e);

    if (this.kind === 'fg' || this.kind === 'pat') {
      updateKick(this, dt);
      if (this.phase !== 'dead') for (const e of this.players) integrate(e, dt);
      this._animTick(dt);
      this._cap();
      return;
    }

    if (this.kind === 'kick_return') updateKickoffAI(this, dt);
    else updateScrimmageAI(this);
    if (this.phase === 'dead') return;
    updateEngagements(this, dt);
    // RB heading to the mesh (handoff exchange)
    if (this._mesh && !this.carrier) {
      const rb = this.byId.RB;
      const dx = this._mesh.x - rb.x;
      const dy = this._mesh.y - rb.y;
      const d = Math.hypot(dx, dy) || 1;
      rb.ai.wvx = (dx / d) * rb.top;
      rb.ai.wvy = (dy / d) * rb.top;
      rb.ai.accelMult = TUNING.run.rbMeshBoost;
    }
    if (this.carrier) updateCarrier(this, dt);
    updateTackling(this, dt);
    if (this.phase === 'dead') return this._animTick(dt);
    for (const e of this.players) integrate(e, dt);
    this._postMove(dt);
    // keep the predicted arc anchored to the (moving) QB while aiming
    if (this.phase === 'dropback' && this._aimTarget) this._refreshAim();
    this._animTick(dt);
    this._cap();
  }

  _postMove(dt) {
    const b = this.ball;
    // handoff exchange
    if (this._mesh && !this.carrier && this.phase === 'carry') {
      const rb = this.byId.RB;
      if (Math.hypot(rb.x - this._mesh.x, rb.y - this._mesh.y) <= TUNING.run.meshDist || this.t >= TUNING.run.meshTimeMax) {
        const lane = this.play.runLane.points.slice(1);
        this._emit('handoff', rb.x, rb.y, { id: rb.id });
        this._setCarrier(rb, 'lane', 'handoff', lane);
        const qb = this.byId.QB;
        qb.ai.role = 'qb_fake';
        qb.role = 'qb_fake';
      }
    }
    if (b.state === 'held') {
      const h = b.holder ? this.byId[b.holder] : null;
      if (h) {
        b.x = h.x + h.face.x * 0.25;
        b.y = h.y + h.face.y * 0.25;
        b.z = h.z + (h.pos === 'OL' && this.phase === 'presnap' ? 0.2 : 1.0);
        b.vx = h.vx;
        b.vy = h.vy;
        b.vz = 0;
      }
    } else if (b.state === 'air' || b.state === 'loose') {
      stepBall(b, dt);
      catchCheck(this);
      if (this.phase === 'dead') return;
      if (b.state === 'air' || b.state === 'loose') {
        if (b.z <= 0) {
          b.z = 0;
          this._incomplete(b.y < 0 || b.y > W || b.x > FIELD.END_LINE ? 'oob' : 'ground');
          return;
        }
        if (b.x < -5 || b.x > FIELD.END_LINE + 5 || b.y < -5 || b.y > W + 5) {
          this._incomplete('oob');
          return;
        }
      }
    } else if (b.state === 'kicked' && this.kind === 'kick_return') {
      stepBall(b, dt);
      if (b.z < 0) b.z = 0;
    }
    if (this.phase === 'dropback') updateSacks(this);
    if (this.phase === 'carry') {
      updateDive(this);
      checkBounds(this);
    }
  }

  _animTick(dt) {
    for (const e of this.players) {
      e.animT += dt;
      const a = e.ai;
      if (e.down && this.t >= a.downUntil && a.downUntil > 0 && this.phase !== 'dead') {
        e.down = false;
        a.downUntil = 0;
      }
      if (this.t < a.animHold) continue;
      if (this.phase === 'presnap') continue;
      if (e.down) setAnim(e, 'down');
      else if (e.lunging && a.lunge) setAnim(e, 'tackle');
      else if (e.ai.eng) setAnim(e, 'block');
      else if (e === this.carrier && this.cs && this.cs.taunting) setAnim(e, 'celebrate');
      else if (e === this.carrier && this.cs && this.cs.dive) setAnim(e, 'dive');
      else if (Math.hypot(e.vx, e.vy) > 0.8) setAnim(e, 'run');
      else setAnim(e, 'idle');
      if (!a.lunge && e.lunging && this.phase !== 'dropback') e.lunging = false;
    }
  }

  _cap() {
    if (this.phase === 'dead' || this.t < TUNING.maxPlayTime) return;
    this._emit('whistle', this.ball.x, this.ball.y, { reason: 'cap' });
    if (this.kick) {
      this._kickResult(this.kind === 'pat' ? 'pat_miss' : 'fg_miss');
      return;
    }
    if (this.phase === 'air') {
      this._incomplete('cap');
      return;
    }
    const C = this.carrier || this.byId.QB;
    if (this.phase === 'dropback') {
      this._sacked = true;
      this._finish(C.x <= FIELD.OWN_GOAL ? 'safety' : 'sack', { endX: C.x <= FIELD.OWN_GOAL ? FIELD.OWN_GOAL : C.x, endY: C.y });
      return;
    }
    if (this.phase === 'return') {
      this._touchback();
      return;
    }
    if (C) this._downed(C, 'tackle');
    else this._finish('tackle', { endX: this.losX, endY: this.by });
  }

  // =================================================================== result

  _finish(outcome, o = {}) {
    if (this.result) return;
    const ox = Number.isFinite(o.endX) ? o.endX : this.losX;
    const endX = clamp(ox, 0, FIELD.LEN);
    const endY = clamp(Number.isFinite(o.endY) ? o.endY : this.by, 0, W);
    this.phase = 'dead';
    const b = this.ball;
    if (b.state !== 'kicked') b.state = 'dead';
    for (const e of this.players) {
      e.lunging = false;
      e.ai.lunge = null;
    }
    const kind = this.kind;
    const type = this._type;
    const turnover = !!o.turnover && !this.twoPoint;
    const scoring = outcome === 'td' || outcome === 'return_td' || outcome === 'safety' || outcome === 'fg_good' || outcome === 'pat_good';
    const isKick = kind === 'fg' || kind === 'pat';
    let clockStops = scoring || turnover || isKick || outcome === 'incomplete' || outcome === 'oob' || outcome === 'touchback' || outcome === 'interception';
    if (this.twoPoint) clockStops = true;
    let yards = 0;
    if (kind === 'kick_return') {
      const cx = this.kickoff?.catchX ?? endX;
      yards = outcome === 'touchback' ? 0 : endX - cx;
    } else if (!isKick && outcome !== 'incomplete' && outcome !== 'interception') {
      yards = endX - this.losX;
    }
    yards = Math.round(yards * 10) / 10;

    const qb = this.byId.QB;
    const passer = type === 'pass' && qb ? qb.squad.id : null;
    const receiver = this._receiver ? this._receiver.squad.id : null;
    const rusher = this._rusher ? this._rusher.squad.id : null;
    const kicker = this._kicker ? this._kicker.squad.id : null;
    const returner = this._returner ? this._returner.squad.id : null;

    // ---- stats (franchise ids only; 2-pt tries don't count toward box-score yards)
    const stats = {};
    const line = (sp) => {
      if (!sp || !sp.id) return null;
      if (!stats[sp.id]) {
        stats[sp.id] = {};
        for (const k of STAT_KEYS) stats[sp.id][k] = 0;
      }
      return stats[sp.id];
    };
    const yd = Math.round(yards);
    const td = outcome === 'td' || outcome === 'return_td';
    if (!this.twoPoint) {
      if (type === 'pass' && qb) {
        const q = line(qb.squad);
        if (q) {
          if (this._thrown) q.passAtt += 1;
          if (this._completed) {
            q.passCmp += 1;
            q.passYds += yd;
            if (td) q.passTd += 1;
          }
          if (outcome === 'interception') q.int += 1;
          if (this._sacked) q.sacked += 1;
        }
        if (this._completed && this._receiver) {
          const r = line(this._receiver.squad);
          if (r) {
            r.rec += 1;
            r.recYds += yd;
            if (td) r.recTd += 1;
          }
        }
      } else if (type === 'run' && this._rusher) {
        const r = line(this._rusher.squad);
        if (r) {
          r.rushAtt += 1;
          r.rushYds += yd;
          if (td) r.rushTd += 1;
        }
      } else if (type === 'kick' && this._kicker) {
        const k = line(this._kicker.squad);
        if (k) {
          if (kind === 'pat') {
            k.patAtt += 1;
            if (outcome === 'pat_good') k.patMade += 1;
          } else {
            k.fgAtt += 1;
            if (outcome === 'fg_good') {
              k.fgMade += 1;
              k.fgLong = Math.max(k.fgLong, this.kick.distance);
            }
          }
        }
      } else if (type === 'return' && this._returner && outcome !== 'touchback') {
        const r = line(this._returner.squad);
        if (r) {
          r.retYds += yd;
          if (td) r.retTd += 1;
        }
      }
      if (this._fumbled) {
        const f = line(this._fumbled.squad);
        if (f) f.fumbles += 1;
      }
    }

    const firstDown = kind === 'scrimmage' && !turnover && !this.twoPoint
      && (td || ((outcome === 'tackle' || outcome === 'oob' || outcome === 'sack') && endX >= this.firstDownX));
    const res = {
      outcome,
      endX: Math.round(endX * 100) / 100,
      endY: Math.round(endY * 100) / 100,
      yards,
      elapsed: Math.round(this.t * 100) / 100,
      clockStops,
      turnover,
      turnoverX: turnover ? Math.round((o.turnoverX ?? endX) * 100) / 100 : undefined,
      type,
      passer,
      receiver,
      rusher,
      kicker,
      returner,
      defender: (this._intBy || this._tackler)?.squad?.id ?? null,
      stats,
      highlights: [],
      hits: this._hits.slice(),
      twoPoint: this.twoPoint,
      twoPointGood: this.twoPoint ? outcome === 'td' : undefined,
      firstDown,
      playName: this.play ? this.play.name : '',
      kickDistance: this.kick ? this.kick.distance : undefined,
      fumbleLost: !!o.fumbleLost,
      defensiveTd: !!o.defensiveTd && !this.twoPoint,
      dive: !!o.dive,
    };
    res.highlights = this._highlights(res);
    this.result = res;
    this._emit('whistle', endX, endY, { outcome });
  }

  _highlights(r) {
    const nm = (e) => (e ? (e.squad && e.squad.name) || e.name || `#${e.number}` : '');
    const ydTxt = (y) => {
      const v = Math.round(y);
      return v >= 0 ? `${v}-YD` : `${-v}-YD LOSS ON`;
    };
    const out = [];
    const C = this.carrier;
    const cs = this.cs;
    const td = r.outcome === 'td' || r.outcome === 'return_td';
    switch (r.outcome) {
      case 'incomplete':
        out.push(this._intended ? `INCOMPLETE TO ${nm(this._intended)}` : 'PASS INCOMPLETE');
        break;
      case 'interception':
        out.push(`INTERCEPTED BY #${this._intBy ? this._intBy.number : ''}${r.defensiveTd ? ' - PICK SIX!' : ''}`);
        break;
      case 'sack':
        out.push(`${nm(this.byId.QB)} SACKED FOR ${Math.abs(Math.round(r.yards))}${this._tackler ? ` BY #${this._tackler.number}` : ''}`);
        break;
      case 'fg_good':
        out.push(`${this.kick.distance}-YD FIELD GOAL IS GOOD${this.kick.doink ? ' OFF THE POST!' : '!'}`);
        break;
      case 'fg_miss':
        out.push(`${this.kick.distance}-YD FIELD GOAL ${this.kick.missDir === 'short' ? 'FALLS SHORT' : `WIDE ${(this.kick.missDir || '').toUpperCase()}`}`);
        break;
      case 'pat_good':
        out.push('EXTRA POINT GOOD');
        break;
      case 'pat_miss':
        out.push('EXTRA POINT NO GOOD');
        break;
      case 'kick_blocked':
        out.push('KICKER SWARMED - NO KICK');
        break;
      case 'touchback':
        out.push('TOUCHBACK');
        break;
      case 'safety':
        out.push(`SAFETY! ${nm(C || this.byId.QB)} DOWNED IN THE END ZONE`);
        break;
      case 'fumble':
        out.push(`FUMBLE! ${nm(this._fumbled)} COUGHS IT UP${r.defensiveTd ? ' - RECOVERED FOR A TD' : ''}`);
        break;
      default: {
        if (!C) break;
        let what;
        if (this.kind === 'kick_return') what = 'RETURN';
        else if (this._completed) what = 'CATCH';
        else if (C.pos === 'QB') what = this._scramble ? 'SCRAMBLE' : 'RUN';
        else what = 'RUN';
        const y = r.yards;
        if (td) out.push(`TOUCHDOWN! ${nm(C)} ${Math.max(0, Math.round(y))}-YD ${what}`);
        else out.push(`${nm(C)} ${ydTxt(y)} ${what}${r.outcome === 'oob' ? ', OUT OF BOUNDS' : ''}`);
      }
    }
    if (cs && cs.brokenTackles >= 2) out.push(`${nm(C)} BROKE ${cs.brokenTackles} TACKLES`);
    if (this.twoPoint) out.push(r.outcome === 'td' ? '2-PT TRY IS GOOD' : '2-PT TRY FAILS');
    else if (r.firstDown && !td) out.push('FIRST DOWN');
    if (r.fumbleLost === false && this._fumbled && r.outcome !== 'fumble') out.push('FUMBLE - OFFENSE RECOVERS');
    return out;
  }
}

export { STAT_KEYS };
