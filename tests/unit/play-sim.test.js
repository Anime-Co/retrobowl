// PLAY-SIM: soak (bot-driven plays never hang / NaN, results well-formed), determinism and unit
// tests of key pieces (routes, jukes, kicking, rulings). Calibration lives in
// play-sim-calibration.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaySim } from '../../src/play/sim/PlaySim.js';
import { SimBot, runBotPlay } from '../../src/play/sim/bot.js';
import { makeSetup } from '../../src/play/sim/calibrate.js';
import { makeTestSquad, makeFiller, normalizeSquad } from '../../src/play/sim/squads.js';
import { buildRoute, buildRunLane, rollPlay, ROUTE_LABEL } from '../../src/play/sim/plays.js';
import { FIELD, TUNING } from '../../src/play/sim/tuning.js';
import { Rng } from '../../src/core/rng.js';
import { tri01, triSigned } from '../../src/play/sim/kicking.js';

const DT = 1 / 60;
const W = FIELD.W;
const OUTCOMES = new Set(['tackle', 'oob', 'incomplete', 'td', 'interception', 'sack', 'safety', 'fumble', 'fg_good',
  'fg_miss', 'pat_good', 'pat_miss', 'kick_blocked', 'touchback', 'return_td']);
const STAT_KEYS = ['passAtt', 'passCmp', 'passYds', 'passTd', 'int', 'rushAtt', 'rushYds', 'rushTd', 'rec', 'recYds',
  'recTd', 'fgAtt', 'fgMade', 'fgLong', 'patAtt', 'patMade', 'sacked', 'fumbles', 'retYds', 'retTd'];
const PHASES = new Set(['presnap', 'dropback', 'air', 'carry', 'kick', 'return', 'dead']);
const HIGHLIGHT_RE = /^[0-9A-Z.,:!?+\-/'&()#% ]+$/;

const fin = (v) => typeof v === 'number' && Number.isFinite(v);

function checkFinite(sim, where) {
  for (const e of sim.players) {
    for (const k of ['x', 'y', 'z', 'vx', 'vy', 'animT', 'top']) {
      if (!fin(e[k])) assert.fail(`${where}: ${e.id}.${k} = ${e[k]}`);
    }
    if (!fin(e.face.x) || !fin(e.face.y)) assert.fail(`${where}: ${e.id}.face not finite`);
  }
  const b = sim.ball;
  for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz']) if (!fin(b[k])) assert.fail(`${where}: ball.${k} = ${b[k]}`);
  if (sim.aim) {
    for (const k of ['tx', 'ty', 'visibleFrac', 'maxDist']) if (!fin(sim.aim[k])) assert.fail(`${where}: aim.${k}`);
    for (const p of sim.aim.path) if (!fin(p.x) || !fin(p.y) || !fin(p.z)) assert.fail(`${where}: aim.path`);
  }
  if (sim.kick) {
    for (const k of ['power', 'aim', 'pressure', 'aimAngle']) if (!fin(sim.kick[k])) assert.fail(`${where}: kick.${k}`);
  }
  if (!PHASES.has(sim.phase)) assert.fail(`${where}: bad phase ${sim.phase}`);
}

function checkResult(r, sim, where) {
  assert.ok(r, `${where}: no result`);
  assert.ok(OUTCOMES.has(r.outcome), `${where}: outcome ${r.outcome}`);
  for (const k of ['endX', 'endY', 'yards', 'elapsed']) assert.ok(fin(r[k]), `${where}: ${k}=${r[k]}`);
  assert.ok(r.endX >= 0 && r.endX <= 120, `${where}: endX ${r.endX}`);
  assert.ok(r.endY >= 0 && r.endY <= W, `${where}: endY ${r.endY}`);
  assert.ok(r.elapsed >= 0 && r.elapsed <= TUNING.maxPlayTime + 0.1, `${where}: elapsed ${r.elapsed}`);
  assert.equal(typeof r.clockStops, 'boolean');
  assert.equal(typeof r.turnover, 'boolean');
  if (r.turnover) assert.ok(fin(r.turnoverX) && r.turnoverX >= 0 && r.turnoverX <= 120, `${where}: turnoverX`);
  assert.ok(['pass', 'run', 'kick', 'return'].includes(r.type), `${where}: type ${r.type}`);
  for (const k of ['passer', 'receiver', 'rusher', 'kicker']) assert.ok(r[k] === null || typeof r[k] === 'string', `${where}: ${k}`);
  assert.ok(r.stats && typeof r.stats === 'object');
  for (const [id, line] of Object.entries(r.stats)) {
    assert.equal(typeof id, 'string');
    for (const k of STAT_KEYS) assert.ok(fin(line[k]), `${where}: stats.${id}.${k}`);
  }
  assert.ok(Array.isArray(r.highlights) && r.highlights.length >= 1, `${where}: highlights`);
  for (const h of r.highlights) assert.match(h, HIGHLIGHT_RE, `${where}: highlight charset "${h}"`);
  assert.ok(Array.isArray(r.hits));
  for (const h of r.hits) assert.ok(typeof h.playerId === 'string' && fin(h.power) && h.power >= 0 && h.power <= 1);
  assert.equal(sim.phase, 'dead');
  // kind-specific sanity
  if (sim.kind === 'fg') assert.ok(['fg_good', 'fg_miss', 'kick_blocked'].includes(r.outcome));
  if (sim.kind === 'pat') assert.ok(['pat_good', 'pat_miss', 'kick_blocked'].includes(r.outcome));
  if (sim.kind === 'kick_return') assert.ok(['tackle', 'oob', 'return_td', 'touchback', 'fumble', 'safety'].includes(r.outcome), `${where}: ${r.outcome}`);
  if (r.outcome === 'td') assert.equal(r.endX, 110);
  if (r.outcome === 'touchback') assert.equal(r.endX, TUNING.kickoff.touchbackX);
  if (r.twoPoint) assert.equal(r.twoPointGood, r.outcome === 'td');
}

// ------------------------------------------------------------------ soak

test('soak: 2,700 bot-driven plays (2,000+ scrimmage) across kinds, difficulty steps and squad strengths terminate cleanly', () => {
  const rng = new Rng(20240611);
  const squads = [0.2, 0.35, 0.5, 0.65, 0.85].map((r, i) => makeTestSquad({ rating: r, seed: 100 + i, prefix: `s${i}`, starFrac: i === 0 ? 0.3 : 1 }));
  const counts = {};
  const N = 2700;
  let scrimmage = 0;
  for (let i = 0; i < N; i++) {
    const roll = rng.next();
    const kind = roll < 0.78 ? 'scrimmage' : roll < 0.86 ? 'fg' : roll < 0.9 ? 'pat' : 'kick_return';
    const twoPoint = kind === 'scrimmage' && rng.chance(0.05);
    if (kind === 'scrimmage') scrimmage++;
    const losX = rng.float(10.5, 109.5);
    const setup = {
      kind,
      twoPoint,
      losX,
      firstDownX: Math.min(110, losX + rng.float(1, 15)),
      hashY: rng.pick([FIELD.HASH_L, W / 2, FIELD.HASH_R, 3, W - 3]),
      down: rng.int(1, 4),
      offense: rng.pick(squads),
      defense: rng.pick(squads),
      difficulty: rng.int(0, 2),
      difficultyStep: rng.int(1, 16),
      wind: { x: rng.float(-20, 20), y: rng.float(-20, 20) },
      seed: rng.int(1, 2 ** 31),
      weather: rng.pick(['clear', 'clear', 'rain', 'snow']),
      quarter: rng.int(1, 5),
      gameProgress: rng.next(),
    };
    const sim = new PlaySim(setup);
    const bot = new SimBot({
      seed: i + 1,
      skill: rng.next(),
      mode: rng.pick(['auto', 'auto', 'run', 'pass', 'hold']),
      touchbackRate: rng.next(),
    });
    let frames = 0;
    while (!sim.result && frames < 60 * 40) {
      bot.step(sim, DT);
      // the controller may also fire random (even inapplicable) commands
      if (frames % 37 === 5 && rng.chance(0.3)) {
        const c = rng.int(0, 9);
        if (c === 0) sim.sideStep(rng.chance(0.5) ? 1 : -1);
        else if (c === 1) sim.drift(rng.int(-1, 1));
        else if (c === 2) sim.truck(rng.chance(0.5));
        else if (c === 3) sim.toggleBullet();
        else if (c === 4) sim.aimAt(sim.ball.x + rng.float(-30, 50), rng.float(-10, 60));
        else if (c === 5) sim.aimCancel();
        else if (c === 6) sim.changePlay();
        else if (c === 7) sim.stutter();
        else if (c === 8) sim.drainEvents();
        else sim.kickTap();
      }
      sim.update(DT);
      frames++;
      if (frames % 10 === 0) checkFinite(sim, `play ${i} (${kind}) f${frames}`);
    }
    if (!sim.result && (sim.kind === 'scrimmage') && sim.phase === 'presnap') {
      // hold-mode bots still snap; a presnap sim never times out by design
      assert.fail(`play ${i} never snapped`);
    }
    checkFinite(sim, `play ${i} end`);
    checkResult(sim.result, sim, `play ${i} (${kind}${twoPoint ? ' 2pt' : ''})`);
    // a few more updates after the whistle are harmless
    sim.update(DT);
    checkFinite(sim, `play ${i} post`);
    counts[sim.result.outcome] = (counts[sim.result.outcome] || 0) + 1;
  }
  console.log(`[play-sim soak] ${N} plays (${scrimmage} scrimmage) outcomes:`, JSON.stringify(counts));
  assert.ok(scrimmage >= 2000, `only ${scrimmage} scrimmage plays`);
  for (const o of ['tackle', 'incomplete', 'td', 'interception', 'sack', 'fg_good', 'fg_miss', 'pat_good']) {
    assert.ok(counts[o] > 0, `soak never produced outcome ${o}`);
  }
});

// ------------------------------------------------------------------ determinism

function scriptedRun(setup) {
  // fixed command timing (not a bot): drop back, aim at a spot, throw at 1.6 s; juke + dive later
  const sim = new PlaySim(setup);
  const ev = [];
  for (let f = 0; f < 60 * 30 && !sim.result; f++) {
    if (f === 20) sim.dropBack();
    if (f === 60) sim.aimAt(sim.losX + 14, setup.hashY + 6);
    if (f === 80) sim.toggleBullet();
    if (f === 96) sim.release();
    if (f === 150) sim.sideStep(1);
    if (f === 175) sim.sideStep(-1);
    if (f === 230) sim.dive();
    sim.update(DT);
    ev.push(...sim.drainEvents().map((e) => `${e.type}@${e.t.toFixed(3)}`));
  }
  return { result: sim.result, ev, pos: sim.players.map((p) => [p.x, p.y]) };
}

test('determinism: same seed + same command timing => identical result, events and positions', () => {
  for (const seed of [1, 77, 4242]) {
    const mk = () => makeSetup({ seed, losX: 40, firstDownX: 50, hashY: 23.58 });
    const a = scriptedRun(mk());
    const b = scriptedRun(mk());
    assert.deepEqual(a.result, b.result);
    assert.deepEqual(a.ev, b.ev);
    assert.deepEqual(a.pos, b.pos);
    const c = runBotPlay(makeSetup({ seed, kind: 'kick_return' }), { skill: 0.7 }).result;
    const d = runBotPlay(makeSetup({ seed, kind: 'kick_return' }), { skill: 0.7 }).result;
    assert.deepEqual(c, d);
    const e = runBotPlay(makeSetup({ seed, kind: 'fg', losX: 75 })).result;
    const g = runBotPlay(makeSetup({ seed, kind: 'fg', losX: 75 })).result;
    assert.deepEqual(e, g);
  }
  // different seeds usually differ
  const r1 = runBotPlay(makeSetup({ seed: 11 })).result;
  const r2 = runBotPlay(makeSetup({ seed: 12 })).result;
  assert.notDeepEqual([r1.outcome, r1.yards, r1.elapsed], [r2.outcome, r2.yards, r2.elapsed]);
});

test('determinism: update(dt) chunking does not depend on frame grouping for whole steps', () => {
  const setup = makeSetup({ seed: 5 });
  const a = new PlaySim(setup);
  const b = new PlaySim(setup);
  a.update(DT);
  b.update(DT);
  a.handoff();
  b.handoff();
  for (let i = 0; i < 120; i++) a.update(DT);
  for (let i = 0; i < 60; i++) b.update(2 * DT);
  assert.ok(Math.abs(a.byId.RB.x - b.byId.RB.x) < 1e-6 || a.result || b.result);
});

// ------------------------------------------------------------------ plays / routes

test('routes and run lanes stay inside the field for every catalog route, alignment and LOS', () => {
  const rng = new Rng(9);
  const types = Object.keys(ROUTE_LABEL);
  for (let i = 0; i < 400; i++) {
    const losX = rng.float(10.5, 109.5);
    const by = rng.pick([FIELD.HASH_L, W / 2, FIELD.HASH_R, 6, W - 6]);
    const s = { x: losX - 1, y: rng.float(2, W - 2) };
    for (const t of types) {
      const pts = buildRoute(t, s, losX, rng.chance(0.5) ? 1 : -1, rng);
      assert.ok(pts.length >= 2, `${t} too short`);
      for (const p of pts) {
        assert.ok(p.y >= FIELD.INSET - 1e-9 && p.y <= W - FIELD.INSET + 1e-9, `${t} y out ${p.y}`);
        assert.ok(p.x <= FIELD.END_LINE - 1.5 + 0.02, `${t} x out ${p.x}`);
        assert.ok(fin(p.x) && fin(p.y));
      }
    }
    for (const lane of ['dive', 'offtackle', 'sweep']) {
      for (const p of buildRunLane(lane, rng.chance(0.5) ? 1 : -1, losX, by, rng.chance(0.5))) {
        assert.ok(p.y >= FIELD.INSET - 1e-9 && p.y <= W - FIELD.INSET + 1e-9);
      }
    }
    const play = rollPlay(rng, losX, by);
    assert.ok(play.name.length > 0 && play.routes.length >= 3);
    assert.ok(play.routes.some((r) => r.playerId === 'RB'));
    assert.ok(play.teBlocks === !play.routes.some((r) => r.playerId === 'TE2'));
  }
});

test('route geometry: cuts happen at the catalog depths', () => {
  const rng = new Rng(3);
  const losX = 40;
  const s = { x: 39.2, y: 12 };
  const out = -1; // toward y=0
  const depth = (pts) => pts[1].x - losX;
  for (let i = 0; i < 50; i++) {
    const post = buildRoute('post', s, losX, out, rng);
    assert.ok(depth(post) >= 10 && depth(post) <= 12);
    assert.ok(post[2].y > post[1].y, 'post breaks inside');
    const corner = buildRoute('corner', { x: 39.2, y: 20 }, losX, out, rng);
    assert.ok(corner[2].y < corner[1].y, 'corner breaks outside');
    const slant = buildRoute('slant', s, losX, out, rng);
    assert.ok(depth(slant) >= 2 && depth(slant) <= 3);
    const qi = buildRoute('quick_in', s, losX, out, rng);
    assert.ok(depth(qi) >= 5 && depth(qi) <= 7 && Math.abs(qi[2].x - qi[1].x) < 1e-9, 'quick in is a 90 degree cut');
    const di = buildRoute('deep_in', s, losX, out, rng);
    assert.ok(depth(di) >= 12 && depth(di) <= 15);
    const curl = buildRoute('curl', s, losX, out, rng);
    assert.ok(curl[2].x < curl[1].x - 2.9, 'curl comes back toward the QB');
  }
});

test('changePlay re-rolls the play pre-snap only; filler squads fill missing slots', () => {
  const sim = new PlaySim(makeSetup({ seed: 21 }));
  const names = new Set([sim.play.name]);
  for (let i = 0; i < 8; i++) {
    assert.equal(sim.changePlay(), true);
    names.add(sim.play.name);
    assert.equal(sim.players.length, 22);
  }
  assert.ok(names.size > 1);
  sim.handoff();
  assert.equal(sim.changePlay(), false);
  // a squad with missing pieces is normalized with fillers
  const sq = normalizeSquad({ offense: { QB: makeFiller('QB', 7), WR: [], TE: { id: 'te1', name: 'T. END', number: 88, pos: 'TE' } }, defense: {} });
  assert.equal(sq.WR.length, 2);
  assert.equal(sq.TE.length, 2);
  assert.equal(sq.TE[0].id, 'te1');
  assert.equal(sq.DB.length, 4);
  const sim2 = new PlaySim({ kind: 'scrimmage', losX: 30, seed: 3, offense: {}, defense: null });
  assert.equal(sim2.players.length, 22);
  const r = runBotPlay({ kind: 'scrimmage', losX: 30, seed: 3, offense: {}, defense: {} }).result;
  checkResult(r, { phase: 'dead', kind: 'scrimmage' }, 'empty squads');
});

// ------------------------------------------------------------------ carrier moves

function runToCarrier(seed) {
  const sim = new PlaySim(makeSetup({ seed, losX: 30 }));
  sim.update(DT);
  sim.handoff();
  for (let i = 0; i < 120 && !sim.carrier; i++) sim.update(DT);
  return sim;
}

test('juke: diminishing returns (1.0, 0.7, 0.5, 0.35...) and recovery after ~0.8 s of straight running', () => {
  const sim = runToCarrier(31);
  assert.ok(sim.carrier, 'handoff completed');
  const effs = [];
  for (let k = 0; k < 4; k++) {
    sim.sideStep(1);
    effs.push(sim.drainEvents().find((e) => e.type === 'juke').eff);
    for (let i = 0; i < 6; i++) sim.update(DT);
  }
  assert.deepEqual(effs, TUNING.carrier.jukeChain.slice(0, 4));
  for (let i = 0; i < 70; i++) sim.update(DT);
  if (!sim.result) {
    sim.sideStep(-1);
    assert.equal(sim.drainEvents().find((e) => e.type === 'juke').eff, 1);
  }
  // lateral displacement of a fresh juke ~1.2 yd
  const s2 = runToCarrier(32);
  const y0 = s2.carrier.y;
  s2.sideStep(1);
  for (let i = 0; i < Math.round(TUNING.carrier.jukeTime / DT) + 1 && !s2.result; i++) s2.update(DT);
  if (!s2.result) assert.ok(Math.abs(s2.carrier.y - y0 - TUNING.carrier.jukeDist) < 0.45, `juke moved ${s2.carrier.y - y0}`);
});

test('dive gains 1.5-2 yd, never fumbles and ends the play', () => {
  for (const seed of [41, 42, 43, 44, 45]) {
    const sim = runToCarrier(seed);
    if (sim.result) continue;
    const x0 = sim.carrier.x;
    sim.dive();
    for (let i = 0; i < 60 && !sim.result; i++) sim.update(DT);
    assert.ok(sim.result);
    if (sim.result.outcome === 'tackle') {
      const gain = sim.result.endX - x0;
      assert.ok(gain >= 1.3 && gain <= 2.3, `dive gain ${gain}`);
      assert.ok(!sim.eventLog.some((e) => e.type === 'fumble'));
    }
  }
});

test('stutter: taunts when nobody is within ~4 yd; truck charges while held', () => {
  const sim = runToCarrier(51);
  // move every defender far away to force a taunt
  for (const d of sim.players) if (d.side === 'def') { d.x = 100; d.y = 5; }
  sim.stutter();
  const ev = sim.drainEvents().find((e) => e.type === 'stutter');
  assert.equal(ev.taunt, true);
  sim.truck(true);
  for (let i = 0; i < 90; i++) sim.update(DT);
  assert.ok(sim.result || sim.carrierState.truckCharge > 0.99);
});

// ------------------------------------------------------------------ rulings

test('safety: QB sacked / carrier downed in his own end zone', () => {
  let safeties = 0;
  for (let i = 0; i < 20; i++) {
    const r = runBotPlay(makeSetup({ seed: 600 + i, losX: 11, firstDownX: 21 }), { mode: 'hold' }).result;
    if (r.outcome === 'safety') {
      safeties++;
      assert.equal(r.endX, 10);
      assert.equal(r.clockStops, true);
    }
  }
  assert.ok(safeties >= 15, `only ${safeties} safeties`);
});

test('touchback: stutter in own end zone before leaving it => own 25 (endX 35)', () => {
  let tb = 0;
  for (let i = 0; i < 30 && tb < 3; i++) {
    const sim = new PlaySim(makeSetup({ kind: 'kick_return', seed: 900 + i }));
    let fired = false;
    for (let f = 0; f < 60 * 30 && !sim.result; f++) {
      if (sim.phase === 'carry' && !fired) {
        fired = true;
        sim.stutter();
      }
      sim.update(DT);
    }
    if (sim.kickoff.catchX < 10) {
      tb++;
      assert.equal(sim.result.outcome, 'touchback');
      assert.equal(sim.result.endX, 35);
      assert.equal(sim.result.type, 'return');
    } else assert.notEqual(sim.result.outcome, 'touchback');
  }
  assert.ok(tb > 0);
});

test('2-pt try: scrimmage from the 2; TD = good, anything else fails; no box-score stats', () => {
  const seen = new Set();
  for (let i = 0; i < 60; i++) {
    const { result: r, sim } = runBotPlay(makeSetup({ seed: 700 + i, losX: 60, twoPoint: true }));
    assert.equal(sim.losX, 108);
    assert.equal(r.twoPoint, true);
    assert.equal(r.twoPointGood, r.outcome === 'td');
    assert.equal(r.turnover, false);
    assert.deepEqual(r.stats, {});
    seen.add(r.twoPointGood);
  }
  assert.ok(seen.has(true) && seen.has(false));
});

test('touchdown when the carrier crosses x=110; out of bounds stops the clock', () => {
  let td = 0;
  let oob = 0;
  for (let i = 0; i < 80; i++) {
    const r = runBotPlay(makeSetup({ seed: 800 + i, losX: 104, firstDownX: 110 })).result;
    if (r.outcome === 'td') {
      td++;
      assert.equal(r.endX, 110);
      assert.equal(r.clockStops, true);
      assert.ok(r.firstDown);
    }
    if (r.outcome === 'oob') {
      oob++;
      assert.equal(r.clockStops, true);
    }
    if (r.outcome === 'tackle') assert.equal(r.clockStops, false);
  }
  assert.ok(td > 10, `only ${td} TDs from the 6`);
  void oob;
});

test('passing: aim clamps to arm range, path is a full 3D arc, bullets fly flatter and faster', () => {
  const sim = new PlaySim(makeSetup({ seed: 4 }));
  sim.update(DT);
  sim.dropBack();
  sim.update(DT);
  const qb = sim.qb;
  sim.aimAt(qb.x + 200, qb.y);
  const a = sim.aim;
  assert.ok(a.valid && a.clamped);
  assert.ok(Math.abs(a.dist - a.maxDist) < 1e-6);
  assert.ok(a.maxDist >= 26 && a.maxDist <= 62);
  assert.ok(a.visibleFrac > 0 && a.visibleFrac <= 1);
  assert.equal(a.path.length, TUNING.pass.pathSamples + 1);
  const end = a.path[a.path.length - 1];
  assert.ok(Math.abs(end.x - a.tx) < 1e-6 && Math.abs(end.z - TUNING.pass.arriveZ) < 1e-6);
  const apexLob = Math.max(...a.path.map((p) => p.z));
  sim.aimAt(qb.x + 20, qb.y + 3);
  const lobT = sim.aim.flightTime;
  const lobApex = Math.max(...sim.aim.path.map((p) => p.z));
  sim.toggleBullet();
  assert.equal(sim.aim.bullet, true);
  assert.ok(sim.aim.flightTime < lobT * 0.75);
  assert.ok(Math.max(...sim.aim.path.map((p) => p.z)) < lobApex);
  assert.ok(apexLob > lobApex);
  // run mode: release tucks
  sim.aimRunMode(true);
  assert.equal(sim.aim.valid, false);
  sim.release();
  assert.equal(sim.phase, 'carry');
  assert.equal(sim.carrier.id, 'QB');
  // visible arc shrinks at higher difficulty
  const easy = new PlaySim(makeSetup({ seed: 4, difficultyStep: 2 }));
  const hard = new PlaySim(makeSetup({ seed: 4, difficultyStep: 16 }));
  for (const s of [easy, hard]) {
    s.update(DT);
    s.dropBack();
    s.update(DT);
    s.aimAt(s.qb.x + 15, s.qb.y);
  }
  assert.ok(hard.aim.visibleFrac < easy.aim.visibleFrac - 0.15);
});

test('kicking: meters animate, PAT from the 15, pressure => kick_blocked, wind pushes the ball', () => {
  // triangle helpers
  assert.equal(tri01(0), 0);
  assert.equal(tri01(0.5), 1);
  assert.ok(Math.abs(triSigned(0.25) - 1) < 1e-9 && Math.abs(triSigned(0.75) + 1) < 1e-9);
  const sim = new PlaySim(makeSetup({ kind: 'pat', seed: 2, losX: 30 }));
  assert.equal(sim.losX, 95);
  assert.equal(sim.kick.distance, 32);
  const vals = [];
  for (let i = 0; i < 60; i++) {
    sim.update(DT);
    vals.push(sim.kick.power);
  }
  assert.ok(Math.max(...vals) > 0.6 && sim.phase === 'presnap');
  sim.kickTap();
  assert.equal(sim.phase, 'kick');
  assert.equal(sim.kick.stage, 'aim');
  const aims = [];
  for (let i = 0; i < 40; i++) {
    sim.update(DT);
    aims.push(sim.kick.aim);
  }
  assert.ok(Math.max(...aims) - Math.min(...aims) > 0.5, 'aim arrow sweeps');
  for (let i = 0; i < 400 && !sim.result; i++) sim.update(DT);
  assert.equal(sim.result.outcome, 'kick_blocked');
  assert.ok(Math.abs(sim.result.elapsed - TUNING.kick.pressureLimit) < 0.05);
  // wind: a perfectly centred, full-power kick drifts with a strong crosswind
  const drift = (wy) => {
    const s = new PlaySim(makeSetup({ kind: 'fg', seed: 3, losX: 85, wind: { x: 0, y: wy }, hashY: W / 2 }));
    s.kick.clock = s.kick.powerPeriod / 2 - DT;
    s.update(DT);
    s.kickTap();
    s.update(DT);
    s.kick.aimClock = s.kick.sweepPeriod * 2 - DT; // aim ~0 next frame
    s.update(DT);
    s.kickTap();
    for (let i = 0; i < 600 && !s.result; i++) s.update(DT);
    return s;
  };
  const calm = drift(0);
  const windy = drift(20);
  const yAt = (s) => s.kick.path.find((p) => p.x >= 119.9)?.y ?? s.kick.path[s.kick.path.length - 1].y;
  assert.equal(calm.result.outcome, 'fg_good');
  assert.ok(yAt(windy) - yAt(calm) > 1, 'crosswind pushes the ball toward +y');
});

test('kick return: returner is the fastest WR/RB/DB, catches automatically and becomes the carrier', () => {
  const off = makeTestSquad({ rating: 0.5, seed: 1, prefix: 'k' });
  off.defense.DB[2].speed = 0.99;
  const sim = new PlaySim(makeSetup({ kind: 'kick_return', seed: 8, offense: off }));
  assert.equal(sim.byId.KR.squad, off.defense.DB[2]);
  assert.equal(sim.phase, 'return');
  for (let i = 0; i < 60 * 8 && sim.phase === 'return'; i++) sim.update(DT);
  assert.equal(sim.phase, 'carry');
  assert.equal(sim.carrier.id, 'KR');
  assert.ok(sim.eventLog.some((e) => e.type === 'kick') && sim.eventLog.some((e) => e.type === 'catch'));
  const landX = sim.kickoff.landX;
  assert.ok(landX >= 75 - 72 - 0.01 && landX <= 75 - 60 + 0.01);
});

test('results carry franchise ids, stats and injury hits for stars', () => {
  let sawPass = false;
  let sawRun = false;
  for (let i = 0; i < 60 && !(sawPass && sawRun); i++) {
    const { result: r } = runBotPlay(makeSetup({ seed: 1200 + i }));
    if (r.type === 'pass' && r.outcome === 'tackle' && r.receiver) {
      sawPass = true;
      assert.equal(r.stats[r.passer].passCmp, 1);
      assert.equal(r.stats[r.receiver].rec, 1);
      assert.equal(r.stats[r.receiver].recYds, Math.round(r.yards));
      assert.ok(r.hits.some((h) => h.playerId === r.receiver));
    }
    if (r.type === 'run' && r.outcome === 'tackle' && r.rusher) {
      sawRun = true;
      assert.equal(r.stats[r.rusher].rushAtt, 1);
      assert.equal(r.stats[r.rusher].rushYds, Math.round(r.yards));
    }
  }
  assert.ok(sawPass && sawRun);
  // fillers never appear in stats
  const filler = makeTestSquad({ rating: 0.2, seed: 2, starFrac: 0 });
  const r = runBotPlay(makeSetup({ seed: 5, offense: filler })).result;
  assert.deepEqual(r.stats, {});
  assert.deepEqual(r.hits, []);
});
