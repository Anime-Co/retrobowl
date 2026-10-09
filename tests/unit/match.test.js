// Unit tests for src/match/logic (Match state machine, simDrive, playModel, gameSim).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match, downLabel, hashFrom, toOppFrame, fromOppFrame, ballOnToX, xToBallOn } from '../../src/match/logic/Match.js';
import { simDrive } from '../../src/match/logic/simDrive.js';
import { playModel } from '../../src/match/logic/playModel.js';
import { simulateGame } from '../../src/match/logic/gameSim.js';
import { autoPlayMatch } from '../../src/match/logic/autoplay.js';
import { CFG, HASH_Y, FIELD_MID_Y, kickerMaxFg, onsideChance, timeoutsPerHalf } from '../../src/match/logic/config.js';
import { Rng } from '../../src/core/rng.js';

// ---- helpers ---------------------------------------------------------------------------------

/** A PlayResult with sensible defaults. */
function res(outcome, endX, extra = {}) {
  return {
    outcome,
    endX,
    endY: FIELD_MID_Y,
    yards: 0,
    elapsed: 4,
    clockStops: ['incomplete', 'oob', 'td', 'interception', 'safety', 'touchback', 'return_td', 'fg_good', 'fg_miss', 'pat_good', 'pat_miss'].includes(outcome),
    turnover: outcome === 'interception',
    type: 'pass',
    passer: null,
    receiver: null,
    rusher: null,
    kicker: null,
    stats: {},
    highlights: [],
    ...extra,
  };
}

function newMatch(opts = {}) {
  return new Match({
    seed: opts.seed ?? 11,
    userTeam: { id: 'USR', abbr: 'USR', city: 'Home' },
    oppTeam: { id: 'OPP', abbr: 'OPP', city: 'Away' },
    settings: { quarterMinutes: 2, difficultyStep: 6, wind: 'off', ...(opts.settings || {}) },
    playoff: !!opts.playoff,
    userKicker: opts.userKicker ?? { id: 'k1', range: 6, accuracy: 6 },
    userDefenders: opts.userDefenders,
  });
}

/** Resolve steps (touchbacks on returns, acks) until the user has a scrimmage play pending. */
function toUserPlay(m) {
  for (let i = 0; i < 200; i++) {
    const s = m.next();
    if (s.type === 'play' && !s.twoPoint) return s;
    if (s.type === 'kick_return') m.submitPlay(res('touchback', 35, { type: 'return' }));
    else if (s.type === 'decision') m.choose(s.options[s.options.length - 1].id);
    else if (s.type === 'kick') m.submitPlay(res(s.kind === 'pat' ? 'pat_good' : 'fg_good', s.setup.losX, { type: 'kick' }));
    else if (s.type === 'play') m.submitPlay(res('incomplete', s.setup.losX));
    else if (s.type === 'final') throw new Error('match ended');
    else m.ack();
  }
  throw new Error('no user play reached');
}

/**
 * Re-spot the pending user play (test-only: withdraws the cached step and edits state).
 * @param {Match} m
 */
function place(m, patch) {
  toUserPlay(m);
  m._resolve();
  m._phase = { k: 'user_down' };
  m._fourthChoice = null;
  m._runoffPending = !!patch.running;
  const st = m.state;
  for (const k of ['ballOn', 'down', 'toGo', 'quarter', 'clock', 'half']) if (patch[k] != null) st[k] = patch[k];
  if (patch.score) st.score = { ...patch.score };
  if (patch.quarter >= 3 && patch.half == null) st.half = 2;
  return m.next();
}

// ---- frames & setups -------------------------------------------------------------------------

test('frame conversions and PlaySetup geometry', () => {
  assert.equal(toOppFrame(30), 70);
  assert.equal(fromOppFrame(70), 30);
  assert.equal(ballOnToX(25), 35);
  assert.equal(xToBallOn(35), 25);
  const m = newMatch();
  let s = place(m, { ballOn: 40, down: 2, toGo: 7 });
  assert.equal(s.type, 'play');
  assert.equal(s.setup.kind, 'scrimmage');
  assert.equal(s.setup.losX, 50);
  assert.equal(s.setup.firstDownX, 57);
  assert.equal(s.setup.down, 2);
  assert.equal(s.setup.quarter, m.state.quarter);
  assert.ok(s.setup.gameProgress >= 0 && s.setup.gameProgress <= 1);
  assert.ok(Number.isInteger(s.setup.seed) && s.setup.seed > 0);
  assert.equal(s.setup.difficultyStep, 6);
  assert.equal(s.setup.difficulty, 1);
  for (const k of ['offense', 'defense', 'wind', 'weather', 'hashY']) assert.ok(k in s.setup, k);
  // goal to go
  s = place(m, { ballOn: 95, down: 1, toGo: 5 });
  assert.equal(s.setup.losX, 105);
  assert.equal(s.setup.firstDownX, 110);
  assert.equal(downLabel(m.state), '1st & Goal');
  assert.equal(downLabel({ down: 3, toGo: 0.3, ballOn: 40 }), '3rd & inches');
  assert.equal(downLabel({ down: 4, toGo: 6.4, ballOn: 40 }), '4th & 6');
});

test('hash selection snaps to the hashes and keeps between-hash spots', () => {
  assert.equal(hashFrom(2), HASH_Y[0]);
  assert.equal(hashFrom(51), HASH_Y[1]);
  assert.equal(hashFrom(26), 26);
  assert.equal(hashFrom(NaN), FIELD_MID_Y);
  const m = newMatch();
  place(m, { ballOn: 30, down: 1, toGo: 10 });
  m.submitPlay(res('tackle', 44, { endY: 3, type: 'run', yards: 4 }));
  const s = m.next();
  assert.equal(s.setup.hashY, HASH_Y[0]);
  assert.equal(s.setup.losX, 44);
  assert.equal(m.state.down, 2);
  assert.equal(m.state.toGo, 6);
});

// ---- clock -----------------------------------------------------------------------------------

test('clock: in-bounds tackle keeps running through pre-snap; incomplete and OOB stop it', () => {
  const m = newMatch();
  let s = place(m, { ballOn: 30, down: 1, toGo: 10, clock: 100 });
  assert.equal(m.state.clockRunning, false, 'stopped before the first snap of a drive');
  m.onSnap();
  assert.equal(m.state.clockRunning, true);
  m.tickClock(5);
  assert.equal(m.state.clock, 95);
  m.submitPlay(res('tackle', 45, { type: 'run', yards: 5 }));
  assert.equal(m.state.clockRunning, false, 'paused between submit and next()');
  s = m.next();
  assert.equal(s.type, 'play');
  assert.equal(m.state.clockRunning, true, 'pre-snap runoff after an in-bounds tackle');
  m.tickClock(3);
  assert.equal(m.state.clock, 92);
  m.onSnap();
  m.tickClock(2);
  m.submitPlay(res('incomplete', 45));
  m.next();
  assert.equal(m.state.clockRunning, false, 'incomplete stops the clock');
  assert.equal(m.tickClock(5), false);
  assert.equal(m.state.clock, 90);
  m.onSnap();
  m.tickClock(4);
  m.submitPlay(res('oob', 52, { yards: 7 }));
  m.next();
  assert.equal(m.state.clockRunning, false, 'out of bounds stops the clock');
  m.onSnap();
  m.submitPlay(res('tackle', 53, { clockStops: true, yards: 1 }));
  m.next();
  assert.equal(m.state.clockRunning, false, 'engine clockStops is honoured');
});

test('clock never goes below zero; a live play finishes after 0:00', () => {
  const m = newMatch();
  place(m, { ballOn: 30, down: 1, toGo: 10, clock: 3, quarter: 1 });
  m.onSnap();
  m.tickClock(2);
  m.tickClock(5);
  assert.equal(m.state.clock, 0);
  assert.equal(m.state.clockRunning, false);
  assert.ok(m.submitPlay(res('tackle', 50, { yards: 10, type: 'run' })), 'live play still resolves');
  const s = m.next();
  assert.equal(s.type, 'quarter_end');
  assert.equal(s.quarter, 1);
  m.ack();
  assert.equal(m.state.quarter, 2);
  assert.equal(m.state.clock, 120);
  const p = m.next();
  assert.equal(p.type, 'play', 'possession and spot carry into Q2');
  assert.equal(p.setup.losX, 50);
  assert.equal(m.state.down, 1);
  assert.equal(m.state.clockRunning, false, 'new quarter starts with the clock stopped');
});

test('clock expiring before the snap withdraws the play step and ends the half', () => {
  const m = newMatch();
  place(m, { ballOn: 30, down: 2, toGo: 4, clock: 6, quarter: 2, running: true });
  assert.equal(m.state.clockRunning, true);
  assert.equal(m.tickClock(4), false);
  assert.equal(m.tickClock(4), true, 'withdrawn');
  assert.equal(m.state.clock, 0);
  assert.equal(m.onSnap(), false);
  const s = m.next();
  assert.equal(s.type, 'halftime');
  m.ack();
  assert.equal(m.state.quarter, 3);
  assert.equal(m.state.half, 2);
  assert.equal(m.state.clock, 120);
});

test('clock pauses during decisions and resumes after GO FOR IT; conversions are untimed', () => {
  const m = newMatch();
  place(m, { ballOn: 30, down: 3, toGo: 8, clock: 90 });
  m.onSnap();
  m.submitPlay(res('tackle', 42, { yards: 2, type: 'run' }));
  let s = m.next();
  assert.equal(s.type, 'decision');
  assert.equal(s.kind, 'fourth');
  assert.equal(m.state.clockRunning, false, 'paused while the pop-up is open');
  assert.equal(m.tickClock(10), false);
  assert.equal(m.state.clock, 90);
  m.choose('go');
  s = m.next();
  assert.equal(s.type, 'play');
  assert.equal(s.canFieldGoal, false);
  assert.equal(m.state.clockRunning, true, 'runoff resumes after the decision');
  // TD → conversions do not run the clock
  m.onSnap();
  m.submitPlay(res('td', 110, { yards: 68 }));
  s = m.next();
  assert.equal(s.kind, 'conversion');
  m.choose('two');
  s = m.next();
  assert.equal(s.twoPoint, true);
  m.onSnap();
  assert.equal(m.state.clockRunning, false);
  const before = m.state.clock;
  m.tickClock(3);
  assert.equal(m.state.clock, before);
});

// ---- timeouts & audibles ---------------------------------------------------------------------

test('timeouts: only between plays while the clock runs, decrement, stop clock, reset at halftime', () => {
  const m = newMatch();
  assert.equal(m.state.timeouts.user, 2);
  place(m, { ballOn: 30, down: 1, toGo: 10, clock: 100 });
  assert.equal(m.canCallTimeout(), false, 'clock already stopped');
  assert.equal(m.callTimeout(), false);
  m.onSnap();
  assert.equal(m.callTimeout(), false, 'not during a live play');
  m.submitPlay(res('tackle', 44, { yards: 4, type: 'run' }));
  m.next();
  assert.equal(m.state.clockRunning, true);
  assert.equal(m.callTimeout(), true);
  assert.equal(m.state.timeouts.user, 1);
  assert.equal(m.state.clockRunning, false);
  assert.equal(m.callTimeout(), false, 'clock already stopped by the timeout');
  m.onSnap();
  m.submitPlay(res('tackle', 47, { yards: 3, type: 'run' }));
  m.next();
  assert.equal(m.callTimeout(), true);
  assert.equal(m.state.timeouts.user, 0);
  m.onSnap();
  m.submitPlay(res('tackle', 49, { yards: 2, type: 'run' }));
  m.next();
  assert.equal(m.callTimeout(), false, 'none left');
  // halftime reset
  m._resolve();
  m.state.quarter = 2;
  m.state.clock = 0;
  m._phase = { k: 'user_down' };
  assert.equal(m.next().type, 'halftime');
  m.ack();
  assert.equal(m.state.timeouts.user, timeoutsPerHalf(2));
  assert.equal(timeoutsPerHalf(1), 2);
  assert.equal(timeoutsPerHalf(3), 3);
  assert.equal(newMatch({ settings: { quarterMinutes: 3 } }).state.timeouts.user, 3);
});

test('audibles: pre-snap only, limited count', () => {
  const m = new Match({ seed: 3, audibles: 2, settings: { wind: 'off' } });
  toUserPlay(m);
  assert.equal(m.state.audiblesLeft, 2);
  assert.equal(m.useAudible(), true);
  assert.equal(m.useAudible(), true);
  assert.equal(m.useAudible(), false);
  assert.equal(m.state.audiblesLeft, 0);
  const m2 = new Match({ seed: 3, audibles: 3 });
  toUserPlay(m2);
  m2.onSnap();
  assert.equal(m2.useAudible(), false, 'not after the snap');
});

// ---- field goals & 4th down ------------------------------------------------------------------

test('FG availability: 4th down in range, or the end-of-half window', () => {
  const m = newMatch({ userKicker: { id: 'k', range: 6, accuracy: 6 } });
  const max = kickerMaxFg(6); // 54.8
  assert.ok(Math.abs(max - 54.8) < 1e-9);
  assert.equal(kickerMaxFg(10), 66);
  assert.equal(kickerMaxFg(12), 66, 'capped at 66');
  // mid-quarter 1st down in range: no FG
  let s = place(m, { ballOn: 70, down: 1, toGo: 10, quarter: 1, clock: 60 });
  assert.equal(s.canFieldGoal, false);
  assert.equal(m.fieldGoalAvailable(), false);
  assert.equal(m.choose('fg'), false);
  // Q2 with 15 s left, in range (47 yd): available
  s = place(m, { ballOn: 70, down: 1, toGo: 10, quarter: 2, clock: 15 });
  assert.equal(s.canFieldGoal, true);
  assert.equal(m.fieldGoalDistance(), 47);
  // Q2, 15 s, out of range (60 yd)
  s = place(m, { ballOn: 57, down: 1, toGo: 10, quarter: 2, clock: 15 });
  assert.equal(s.canFieldGoal, false);
  // Q3 window does not exist
  s = place(m, { ballOn: 70, down: 2, toGo: 10, quarter: 3, clock: 10 });
  assert.equal(s.canFieldGoal, false);
  // Q4 window, window opens while the clock runs pre-snap
  s = place(m, { ballOn: 70, down: 2, toGo: 10, quarter: 4, clock: 24, running: true });
  assert.equal(s.canFieldGoal, false);
  m.tickClock(5);
  assert.equal(m.fieldGoalAvailable(), true, 'live check');
  assert.equal(m.choose('fg'), true);
  s = m.next();
  assert.equal(s.type, 'kick');
  assert.equal(s.kind, 'fg');
  assert.equal(s.setup.kind, 'fg');
  assert.equal(s.setup.losX, 80);
  assert.equal(s.distance, 47);
  assert.equal(m.state.clockRunning, false, 'FG unit comes on with the clock stopped');
  const before = m.state.score.user;
  m.onSnap();
  assert.equal(m.state.clockRunning, true);
  m.tickClock(3);
  m.submitPlay(res('fg_good', 80, { type: 'kick' }));
  assert.equal(m.state.score.user, before + 3);
});

test('4th-down options: punt on own side, FG in range, both at the opp 45 with a big leg', () => {
  let m = newMatch({ userKicker: { id: 'k', range: 6, accuracy: 6 } });
  let s = place(m, { ballOn: 35, down: 4, toGo: 5 });
  assert.equal(s.type, 'decision');
  assert.deepEqual(s.options.map((o) => o.id), ['punt', 'go']);
  s = place(m, { ballOn: 75, down: 4, toGo: 5 });
  assert.deepEqual(s.options.map((o) => o.id), ['fg', 'go'], 'opp 25: FG, no punt');
  s = place(m, { ballOn: 66, down: 4, toGo: 5 });
  assert.deepEqual(s.options.map((o) => o.id), ['fg', 'go'], 'opp 34: 51 yd is within 54.8');
  s = place(m, { ballOn: 60, down: 4, toGo: 5 });
  assert.deepEqual(s.options.map((o) => o.id), ['punt', 'go'], 'opp 40: 57 yd is out of range');
  s = place(m, { ballOn: 70, down: 4, toGo: 5 });
  assert.ok(s.options.some((o) => o.id === 'fg'));
  m = newMatch({ userKicker: { id: 'k', range: 1, accuracy: 1 } });
  s = place(m, { ballOn: 70, down: 4, toGo: 5 });
  assert.deepEqual(s.options.map((o) => o.id), ['punt', 'go'], 'weak leg at the opp 30: punt allowed (no FG)');
  s = place(m, { ballOn: 75, down: 4, toGo: 5 });
  assert.deepEqual(s.options.map((o) => o.id), ['go'], 'deep in opp territory without range: go only');
  m = newMatch({ userKicker: { id: 'k', range: 10, accuracy: 9 } });
  s = place(m, { ballOn: 55, down: 4, toGo: 5 });
  assert.deepEqual(s.options.map((o) => o.id), ['punt', 'fg', 'go'], 'opp 45 with a 66-yd leg: both');
  s = place(m, { ballOn: 48, down: 4, toGo: 5 });
  assert.deepEqual(s.options.map((o) => o.id), ['punt', 'go'], '69 yd is beyond the 66-yd max');
  s = place(m, { ballOn: 85, down: 4, toGo: 2 });
  assert.ok(s.options.find((o) => o.id === 'fg').detail.includes('32'));
});

test('user kicker input: 1–10 attributes, 0..1 squad skills, generic fallback', () => {
  assert.equal(newMatch({ userKicker: { id: 'k', range: 1, accuracy: 1 } }).userKicker.range, 1);
  assert.equal(new Match({ userKicker: { id: 'k', kickPower: 1, kickAccuracy: 0 } }).userKicker.range, 10);
  const squad = { offense: { K: { id: 'kk', kickPower: 0.5, kickAccuracy: 0.5 } } };
  assert.deepEqual(new Match({ userSquad: squad }).userKicker, { id: 'kk', range: 5.5, accuracy: 5.5 });
  assert.deepEqual(new Match({}).userKicker, CFG.kicking.genericKicker);
});

test('4th-down: punt is automatic, opponent takes over; turnover on downs; missed FG spot', () => {
  let m = newMatch({ userKicker: { id: 'k', range: 5, accuracy: 5 } });
  place(m, { ballOn: 30, down: 4, toGo: 6 });
  m.choose('punt');
  let s = m.next();
  assert.equal(s.type, 'auto');
  assert.equal(s.kind, 'punt');
  assert.equal(m.state.possession, 'opp');
  assert.ok(m.state.stats.k.punts === 1 && m.state.stats.k.puntYds > 0);
  m.ack();
  s = m.next();
  assert.equal(s.type, 'opp_drive');
  assert.ok(s.startYard >= 1 && s.startYard <= 40, `opp start ${s.startYard}`);
  // turnover on downs at the user 40 → opp at their 60
  m = newMatch();
  place(m, { ballOn: 38, down: 4, toGo: 5 });
  m.choose('go');
  m.next();
  m.onSnap();
  m.submitPlay(res('tackle', 50, { yards: 2, type: 'run' }));
  s = m.next();
  assert.equal(s.type, 'opp_drive');
  assert.equal(s.startYard, 60);
  assert.equal(m.drives.at(-2).result, 'downs');
  // missed FG from the opp 30 (ballOn 70): opp at their 37 (spot of kick); from the opp 10 → their 20
  m = newMatch();
  place(m, { ballOn: 70, down: 4, toGo: 5 });
  m.choose('fg');
  m.next();
  m.onSnap();
  m.submitPlay(res('fg_miss', 80, { type: 'kick' }));
  s = m.next();
  assert.equal(s.type, 'opp_drive');
  assert.equal(s.startYard, 37);
  // the engine's turnoverX (offense frame) wins when present: x 73 → opp at their 37
  m = newMatch();
  place(m, { ballOn: 70, down: 4, toGo: 5 });
  m.choose('fg');
  m.next();
  m.submitPlay(res('kick_blocked', 80, { type: 'kick', turnover: true, turnoverX: 73 }));
  assert.equal(m.next().startYard, 37);
  m = newMatch();
  place(m, { ballOn: 90, down: 4, toGo: 5 });
  m.choose('fg');
  m.next();
  m.submitPlay(res('fg_miss', 100, { type: 'kick' }));
  assert.equal(m.next().startYard, 20);
});

// ---- conversions, onside, safety -------------------------------------------------------------

test('conversion flow: PAT from the 15 and 2-pt from the 2', () => {
  const m = newMatch();
  place(m, { ballOn: 80, down: 1, toGo: 10, score: { user: 0, opp: 0 } });
  m.onSnap();
  m.submitPlay(res('td', 110, { yards: 20 }));
  assert.equal(m.state.score.user, 6);
  let s = m.next();
  assert.equal(s.type, 'decision');
  assert.equal(s.kind, 'conversion');
  assert.deepEqual(s.options.map((o) => o.id), ['pat', 'two']);
  assert.equal(m.choose('nope'), false);
  m.choose('pat');
  s = m.next();
  assert.equal(s.type, 'kick');
  assert.equal(s.kind, 'pat');
  assert.equal(s.setup.kind, 'pat');
  assert.equal(s.setup.losX, 95);
  assert.equal(s.distance, 32);
  m.onSnap();
  m.submitPlay(res('pat_good', 95, { type: 'kick' }));
  assert.equal(m.state.score.user, 7);
  s = m.next();
  assert.equal(s.type, 'opp_drive', 'user kickoff is automatic → opponent possession');
  assert.ok(s.beats[0].text.toLowerCase().includes('kickoff'));
  // 2-pt
  const m2 = newMatch();
  place(m2, { ballOn: 80, down: 1, toGo: 10 });
  m2.submitPlay(res('td', 110, { yards: 20 }));
  m2.next();
  m2.choose('two');
  s = m2.next();
  assert.equal(s.type, 'play');
  assert.equal(s.twoPoint, true);
  assert.equal(s.setup.twoPoint, true);
  assert.equal(s.setup.kind, 'scrimmage');
  assert.equal(s.setup.losX, 108);
  assert.equal(s.setup.firstDownX, 110);
  assert.equal(s.canFieldGoal, false);
  assert.equal(m2.canCallTimeout(), false);
  m2.submitPlay(res('td', 110, { yards: 2 }));
  assert.equal(m2.state.score.user, 8);
  // failed 2-pt
  const m3 = newMatch();
  place(m3, { ballOn: 80, down: 1, toGo: 10 });
  m3.submitPlay(res('td', 110, { yards: 20 }));
  m3.next();
  m3.choose('two');
  m3.next();
  m3.submitPlay(res('incomplete', 108));
  assert.equal(m3.state.score.user, 6);
  // the scoring log adds up
  const sum = (mm) => mm.state.log.filter((e) => e.team === 'user' && e.points).reduce((a, e) => a + e.points, 0);
  assert.equal(sum(m), 7);
  assert.equal(sum(m2), 8);
  assert.equal(sum(m3), 6);
});

test('onside decision after a user score while trailing in Q4; automatic resolution', () => {
  assert.ok(Math.abs(onsideChance({ range: 1, accuracy: 1 }) - 0.05) < 1e-9);
  assert.ok(Math.abs(onsideChance({ range: 10, accuracy: 10 }) - 0.15) < 1e-9);
  let recovered = 0;
  let failed = 0;
  for (let seed = 1; seed <= 400 && (!recovered || !failed); seed++) {
    const m = newMatch({ seed, userKicker: { id: 'k', range: 10, accuracy: 10 } });
    place(m, { ballOn: 70, down: 1, toGo: 10, quarter: 4, clock: 50, score: { user: 0, opp: 14 } });
    m.submitPlay(res('td', 110, { yards: 30 }));
    m.next();
    m.choose('pat');
    m.next();
    m.submitPlay(res('pat_good', 95, { type: 'kick' }));
    const s = m.next();
    assert.equal(s.type, 'decision');
    assert.equal(s.kind, 'onside');
    assert.ok(s.chance >= 0.05 && s.chance <= 0.15);
    assert.ok(s.options[0].detail.includes(`${Math.round(s.chance * 100)}%`));
    m.choose('onside');
    const a = m.next();
    assert.equal(a.type, 'auto');
    assert.equal(a.kind, 'onside');
    m.ack();
    const n = m.next();
    if (a.success) {
      recovered++;
      assert.equal(m.state.possession, 'user');
      assert.equal(n.type, 'play');
      assert.equal(n.setup.losX, CFG.field.onsideSpotBallOn + 10);
      assert.equal(m.drives.at(-1).how, 'onside');
    } else {
      failed++;
      assert.equal(n.type, 'opp_drive');
      assert.equal(n.startYard, 100 - CFG.field.onsideSpotBallOn);
    }
  }
  assert.ok(recovered > 0 && failed > 0);
  // not offered when leading, or before Q4
  const m = newMatch();
  place(m, { ballOn: 70, down: 1, toGo: 10, quarter: 3, clock: 50, score: { user: 0, opp: 14 } });
  m.submitPlay(res('td', 110, { yards: 30 }));
  m.next();
  m.choose('pat');
  m.next();
  m.submitPlay(res('pat_good', 95, { type: 'kick' }));
  assert.equal(m.next().type, 'opp_drive');
});

test('safety: opponent +2 and a possession from their 35', () => {
  const m = newMatch();
  place(m, { ballOn: 3, down: 2, toGo: 10, score: { user: 0, opp: 0 } });
  m.onSnap();
  m.submitPlay(res('sack', 8, { yards: -5 }));
  assert.equal(m.state.score.opp, 2);
  let s = m.next();
  assert.equal(s.type, 'auto');
  assert.equal(s.kind, 'safety');
  m.ack();
  s = m.next();
  assert.equal(s.type, 'opp_drive');
  assert.equal(s.startYard, 35);
  assert.equal(m.drives.at(-2).result, 'safety');
  const m2 = newMatch();
  place(m2, { ballOn: 5, down: 1, toGo: 10, score: { user: 0, opp: 0 } });
  m2.submitPlay(res('safety', 9, { yards: -6, type: 'run' }));
  assert.equal(m2.state.score.opp, 2);
});

// ---- kick returns & turnovers ----------------------------------------------------------------

function toKickReturn(m) {
  for (let i = 0; i < 400; i++) {
    const s = m.next();
    if (s.type === 'kick_return') return s;
    if (s.type === 'play') m.submitPlay(res('td', 110, { yards: 10 }));
    else if (s.type === 'decision') m.choose(s.options[0].id);
    else if (s.type === 'kick') m.submitPlay(res('pat_good', 95, { type: 'kick' }));
    else if (s.type === 'final') throw new Error('ended');
    else m.ack();
  }
  throw new Error('no kick return');
}

test('kick returns: touchback → 25, endX → ballOn = endX − 10, return TD, fumble', () => {
  let m = newMatch();
  let s = toKickReturn(m);
  assert.equal(s.setup.kind, 'kick_return');
  assert.equal(s.setup.losX, CFG.field.oppKickoffLosX);
  m.onSnap();
  m.submitPlay(res('touchback', 35, { type: 'return', elapsed: 0 }));
  s = m.next();
  assert.equal(s.type, 'play');
  assert.equal(m.state.ballOn, 25);
  assert.equal(s.setup.losX, 35);
  assert.equal(m.state.down, 1);
  assert.equal(m.state.toGo, 10);
  m = newMatch();
  toKickReturn(m);
  m.onSnap();
  m.tickClock(6);
  m.submitPlay(res('tackle', 41.2, { type: 'return', endY: 10 }));
  s = m.next();
  assert.equal(m.state.ballOn, 31.2);
  assert.equal(s.setup.losX, 41.2);
  assert.equal(s.setup.hashY, HASH_Y[0]);
  assert.equal(m.state.clockRunning, false, 'change of possession: clock stopped until the snap');
  m = newMatch();
  toKickReturn(m);
  const before = m.state.score.user;
  m.submitPlay(res('return_td', 110, { type: 'return', yards: 100 }));
  assert.equal(m.state.score.user, before + 6);
  assert.equal(m.next().kind, 'conversion');
  m = newMatch();
  toKickReturn(m);
  const opp0 = m.state.score.opp;
  m.submitPlay(res('safety', 10, { type: 'return' }));
  assert.equal(m.state.score.opp, opp0 + 2, 'returner downed back in his end zone after leaving it');
  assert.equal(m.next().kind, 'safety');
  m = newMatch();
  toKickReturn(m);
  m.submitPlay(res('fumble', 30, { type: 'return', turnover: true, turnoverX: 30 }));
  s = m.next();
  assert.equal(s.type, 'opp_drive');
  assert.equal(s.startYard, 80);
});

test('interceptions: spot conversion, end-zone touchback, pick-six', () => {
  let m = newMatch();
  place(m, { ballOn: 40, down: 1, toGo: 10 });
  m.submitPlay(res('interception', 70, { turnoverX: 65 }));
  let s = m.next();
  assert.equal(s.type, 'opp_drive');
  assert.equal(s.startYard, 45);
  assert.equal(m.state.possession, 'opp');
  m = newMatch();
  place(m, { ballOn: 80, down: 1, toGo: 10 });
  m.submitPlay(res('interception', 115, { turnoverX: 115 }));
  assert.equal(m.next().startYard, 20);
  m = newMatch();
  place(m, { ballOn: 30, down: 1, toGo: 10, score: { user: 0, opp: 0 } });
  m.submitPlay(res('interception', 5, { turnoverX: 5 }));
  assert.ok(m.state.score.opp >= 6);
  s = m.next();
  assert.equal(s.type, 'auto');
  assert.equal(s.kind, 'defensive_td');
  m.ack();
  assert.equal(m.next().type, 'kick_return', 'opponent kicks off after scoring');
});

// ---- opponent drives -------------------------------------------------------------------------

test('opp_drive step: beats carry clock/score progression; ack applies the drive', () => {
  for (let seed = 1; seed < 40; seed++) {
    const m = newMatch({ seed });
    let s = m.next();
    m.ack(); // coin
    s = m.next();
    if (s.type !== 'opp_drive') continue;
    assert.ok(s.beats.length >= 3 && s.beats.length <= 6, `beats ${s.beats.length}`);
    const clock0 = m.state.clock;
    let prev = clock0;
    for (const b of s.beats) {
      assert.equal(typeof b.text, 'string');
      if (b.quarterAfter === m.state.quarter) {
        assert.ok(b.clockAfter <= prev + 1e-9);
        prev = b.clockAfter;
      }
    }
    const last = s.beats.at(-1);
    assert.equal(m.state.score.opp, 0, 'not applied until ack');
    m.ack();
    assert.equal(m.state.score.opp, last.scoreAfter.opp);
    assert.equal(m.state.score.opp, s.points);
    if (s.points === 0 && s.userBallOn != null) assert.equal(m.state.ballOn, s.userBallOn);
  }
});

test('simDrive: outcomes, beats, runoff scaling, end of half, defensive credit', () => {
  const rng = new Rng(5);
  const outcomes = new Set();
  const defs = [
    { id: 'dl1', name: 'A. ROCK', pos: 'DL', number: 91 },
    { id: 'db1', name: 'C. HAWK', pos: 'DB', number: 24 },
  ];
  const credit = { tackles: 0, sacks: 0, defInt: 0, ff: 0 };
  let tdLongT = 0;
  let nLong = 0;
  for (let i = 0; i < 4000; i++) {
    const r = simDrive({ offStars: 2.75, defStars: 2.75, startYard: 25, clockLeft: 1e6, rng, userDefenders: defs, oppAbbr: 'SEA' });
    outcomes.add(r.outcome);
    assert.ok(r.beats.length >= 3 && r.beats.length <= 6, `${r.beats.length} beats`);
    assert.ok(r.timeUsed > 0);
    for (const b of r.beats) assert.ok(b.t >= 0 && b.t <= r.timeUsed + 1e-9);
    if (r.outcome === 'td') {
      assert.ok(r.points >= 6 && r.points <= 8);
      assert.equal(r.userBallOn, null);
      tdLongT += r.timeUsed;
      nLong++;
    } else if (r.outcome === 'fg') assert.equal(r.points, 3);
    else {
      assert.equal(r.points, 0);
      assert.ok(r.userBallOn >= 1 && r.userBallOn <= 99);
    }
    for (const s of Object.values(r.defStats)) for (const k of Object.keys(credit)) credit[k] += s[k];
    if (r.outcome === 'int' && r.defStats.db1?.defInt) assert.ok(r.beats.some((b) => b.text.includes('C. HAWK')));
  }
  for (const o of ['td', 'fg', 'punt', 'int', 'fumble', 'downs', 'fg_miss']) assert.ok(outcomes.has(o), o);
  for (const k of Object.keys(credit)) assert.ok(credit[k] > 0, `credited ${k}`);
  const avgTd = tdLongT / nLong;
  assert.ok(avgTd > 35 && avgTd < 55, `75-yd TD drive runoff ${avgTd}`);
  // short field is quick; quarter-length scaling
  let shortT = 0;
  let t1 = 0;
  let t3 = 0;
  for (let i = 0; i < 2000; i++) {
    const a = simDrive({ offStars: 2.75, defStars: 2.75, startYard: 80, clockLeft: 1e6, rng, quarterMinutes: 2 });
    if (a.outcome === 'td') shortT += a.timeUsed;
    t1 += simDrive({ offStars: 2.75, defStars: 2.75, startYard: 25, clockLeft: 1e6, rng, quarterMinutes: 1 }).timeUsed;
    t3 += simDrive({ offStars: 2.75, defStars: 2.75, startYard: 25, clockLeft: 1e6, rng, quarterMinutes: 3 }).timeUsed;
  }
  assert.ok(t3 / t1 > 2.6 && t3 / t1 < 3.4, `3-min / 1-min runoff ratio ${t3 / t1}`);
  // time runs out: never exceeds clockLeft, mostly end_half from a long field
  let endHalf = 0;
  for (let i = 0; i < 1000; i++) {
    const r = simDrive({ offStars: 2.75, defStars: 2.75, startYard: 20, clockLeft: 6, rng, half: 1 });
    assert.ok(r.timeUsed <= 6 + 1e-9);
    if (r.outcome === 'end_half') endHalf++;
  }
  assert.ok(endHalf > 800, `end_half ${endHalf}`);
  // a big ratings edge matters
  const avgPts = (off, def) => {
    let p = 0;
    for (let i = 0; i < 3000; i++) p += simDrive({ offStars: off, defStars: def, startYard: 25, clockLeft: 1e6, rng }).points;
    return p / 3000;
  };
  assert.ok(avgPts(4.5, 1) > avgPts(2.75, 2.75) + 1);
  assert.ok(avgPts(1, 4.5) < avgPts(2.75, 2.75) - 1);
  // deterministic for a seed
  const x = simDrive({ offStars: 3, defStars: 2, startYard: 30, clockLeft: 100, seed: 42 });
  const y = simDrive({ offStars: 3, defStars: 2, startYard: 30, clockLeft: 100, seed: 42 });
  assert.deepEqual(x, y);
  assert.ok(shortT > 0);
});

test('playModel returns well-formed PlayResults for every kind', () => {
  const rng = new Rng(9);
  const base = { losX: 35, firstDownX: 45, hashY: 26.67, down: 1, offense: null, defense: null, difficulty: 1, difficultyStep: 6, wind: { x: 0, y: 0 }, weather: 'clear', quarter: 1, gameProgress: 0 };
  const kinds = [{ kind: 'scrimmage' }, { kind: 'scrimmage', twoPoint: true, losX: 108 }, { kind: 'fg', losX: 80 }, { kind: 'pat', losX: 95 }, { kind: 'kick_return', losX: 75 }];
  for (const k of kinds) {
    for (let i = 0; i < 300; i++) {
      const r = playModel({ ...base, ...k, seed: i + 1 }, { rng });
      for (const f of ['outcome', 'endX', 'endY', 'yards', 'elapsed', 'clockStops', 'turnover', 'type', 'stats', 'highlights']) assert.ok(f in r, `${k.kind} ${f}`);
      assert.ok(Number.isFinite(r.endX) && Number.isFinite(r.elapsed) && r.elapsed >= 0);
      if (k.kind === 'fg') assert.ok(['fg_good', 'fg_miss', 'kick_blocked'].includes(r.outcome));
      if (k.kind === 'pat') assert.ok(['pat_good', 'pat_miss', 'kick_blocked'].includes(r.outcome));
    }
  }
});

// ---- overtime --------------------------------------------------------------------------------

test('OT: easy gives the user the first possession; regular season can tie after one period', () => {
  const m = newMatch({ settings: { easyOtFirst: true, difficultyStep: 2 } });
  toUserPlay(m);
  m._resolve();
  m.state.quarter = 4;
  m.state.half = 2;
  m.state.clock = 0;
  m.state.score = { user: 10, opp: 10 };
  m._phase = { k: 'user_down' };
  let s = m.next();
  assert.equal(s.type, 'ot_start');
  assert.equal(s.userReceives, true);
  assert.equal(s.period, 1);
  m.ack();
  assert.equal(m.state.quarter, 5);
  assert.equal(m.state.clock, 120);
  s = m.next();
  assert.equal(s.type, 'kick_return');
  assert.equal(s.setup.quarter, 5);
  m.submitPlay(res('touchback', 35, { type: 'return' }));
  // user FG on the first OT possession: game continues (opp has not had the ball)
  m._resolve();
  m.state.ballOn = 80;
  m._phase = { k: 'user_down' };
  m.state.down = 4;
  m.next();
  m.choose('fg');
  m.next();
  m.submitPlay(res('fg_good', 90, { type: 'kick' }));
  assert.equal(m.state.score.user, 13);
  s = m.next();
  assert.equal(s.type, 'opp_drive', 'opponent still gets its possession');
  m.ack();
  s = m.next();
  if (m.state.score.opp === 13) assert.notEqual(s.type, 'final', 'tied → sudden death continues');
  else if (m.state.score.opp > 13 || s.type === 'final') assert.equal(s.type, 'final');
});

test('OT regular-season tie and playoff repeat', () => {
  const mk = (playoff) => {
    const m = newMatch({ playoff });
    toUserPlay(m);
    m._resolve();
    m.state.quarter = 5;
    m.state.half = 3;
    m.state.otPeriod = 1;
    m._ot = { done: { user: 1, opp: 1 }, firstReceiver: 'user' };
    m.state.clock = 0;
    m.state.score = { user: 17, opp: 17 };
    m._phase = { k: 'user_down' };
    return m;
  };
  const reg = mk(false);
  let s = reg.next();
  assert.equal(s.type, 'final');
  assert.equal(s.result.tie, true);
  assert.equal(s.result.ot, true);
  const po = mk(true);
  s = po.next();
  assert.equal(s.type, 'ot_start');
  assert.equal(s.period, 2);
  po.ack();
  assert.equal(po.state.quarter, 6);
  assert.equal(po.state.otPeriod, 2);
});

test('OT: a TD that wins outright skips the try; scoring after both possessed ends it', () => {
  const m = newMatch();
  toUserPlay(m);
  m._resolve();
  m.state.quarter = 5;
  m.state.half = 3;
  m.state.otPeriod = 1;
  m._ot = { done: { user: 0, opp: 1 }, firstReceiver: 'opp' };
  m.state.score = { user: 20, opp: 23 };
  m._openDrive('user', 'kickoff', 70);
  m.state.ballOn = 70;
  m.state.down = 1;
  m.state.toGo = 10;
  m._phase = { k: 'user_down' };
  m.next();
  m.submitPlay(res('td', 110, { yards: 30 }));
  const s = m.next();
  assert.equal(s.type, 'final');
  assert.equal(s.result.userScore, 26);
  assert.equal(s.result.userWon, true);
  // second team trailing by 3 keeps playing its drive (no premature final), then a FG ties → sudden death
  const m2 = newMatch();
  toUserPlay(m2);
  m2._resolve();
  m2.state.quarter = 5;
  m2.state.half = 3;
  m2.state.otPeriod = 1;
  m2._ot = { done: { user: 0, opp: 1 }, firstReceiver: 'opp' };
  m2.state.score = { user: 20, opp: 23 };
  m2._openDrive('user', 'kickoff', 50);
  m2.state.ballOn = 50;
  m2.state.down = 1;
  m2.state.toGo = 10;
  m2._phase = { k: 'user_down' };
  assert.equal(m2.next().type, 'play');
  m2.submitPlay(res('tackle', 85, { yards: 25, type: 'run' }));
  assert.equal(m2.next().type, 'play', 'drive continues while trailing');
  m2.submitPlay(res('incomplete', 85));
  m2.next();
  m2.submitPlay(res('incomplete', 85));
  m2.next();
  m2.submitPlay(res('incomplete', 85));
  assert.equal(m2.next().kind, 'fourth');
  m2.choose('fg');
  m2.next();
  m2.submitPlay(res('fg_good', 85, { type: 'kick' }));
  assert.equal(m2.state.score.user, 23);
  assert.equal(m2.next().type, 'opp_drive', 'tied after both possessed → sudden death continues');
  // a trailing TD still gets its try
  const m3 = newMatch();
  toUserPlay(m3);
  m3._resolve();
  m3.state.quarter = 5;
  m3.state.half = 3;
  m3.state.otPeriod = 1;
  m3._ot = { done: { user: 0, opp: 1 }, firstReceiver: 'opp' };
  m3.state.score = { user: 20, opp: 27 };
  m3._openDrive('user', 'kickoff', 80);
  m3.state.ballOn = 80;
  m3.state.down = 1;
  m3.state.toGo = 10;
  m3._phase = { k: 'user_down' };
  m3.next();
  m3.submitPlay(res('td', 110, { yards: 20 }));
  assert.equal(m3.next().kind, 'conversion', 'trailing by 1: try for the tie or the win');
  m3.choose('two');
  m3.next();
  m3.submitPlay(res('td', 110, { yards: 2 }));
  assert.equal(m3.next().type, 'final');
  assert.equal(m3.result.userScore, 28);
});

// ---- result ----------------------------------------------------------------------------------

test('MatchResult aggregates stats, hits, sim-drive defensive credit and a box score', () => {
  const m = new Match({
    seed: 21,
    gameId: 'g1',
    settings: { quarterMinutes: 1, difficultyStep: 6 },
    userDefenders: [{ id: 'dl1', name: 'A. ROCK', pos: 'DL' }, { id: 'lb1', name: 'B. STONE', pos: 'LB' }],
  });
  let hits = 0;
  for (let i = 0; i < 5000; i++) {
    const s = m.next();
    if (s.type === 'final') break;
    if (s.type === 'play' || s.type === 'kick' || s.type === 'kick_return') {
      m.onSnap();
      const r = playModel(s.setup, { rng: new Rng(i + 1) });
      if (s.type === 'play' && !s.twoPoint) {
        r.stats = { qb1: { passAtt: 1, passYds: 5 } };
        r.hits = [{ playerId: 'qb1', force: 1 }];
        hits++;
      }
      m.tickClock(r.elapsed);
      m.submitPlay(r);
    } else if (s.type === 'decision') m.choose(s.options[0].id);
    else m.ack();
  }
  const r = m.result;
  assert.ok(r);
  assert.equal(r.gameId, 'g1');
  assert.equal(r.userScore, m.state.score.user);
  assert.equal(r.hits.length, hits);
  assert.equal(r.stats.qb1.passAtt, hits);
  // "…Long" stat keys keep the max instead of summing
  const m2 = newMatch();
  m2._addStats('k9', { fgMade: 1, fgLong: 40 });
  m2._addStats('k9', { fgMade: 1, fgLong: 52 });
  m2._addStats('k9', { fgMade: 0, fgLong: 31 });
  assert.deepEqual(m2.state.stats.k9, { fgMade: 2, fgLong: 52 });
  assert.ok((r.stats.dl1?.tackles ?? 0) + (r.stats.lb1?.tackles ?? 0) > 0, 'defenders credited');
  for (const k of ['user', 'opp']) {
    assert.equal(r.summary.byQuarter[k].reduce((a, b) => a + b, 0), k === 'user' ? r.userScore : r.oppScore);
    assert.ok(r.summary[k].possessions > 0);
  }
  assert.ok(Array.isArray(r.log) && r.log.every((e) => 'quarter' in e && 'text' in e && 'team' in e));
  assert.ok(Array.isArray(r.summary.scoringPlays));
});

test('matches are deterministic for a seed and bot', () => {
  const run = () => autoPlayMatch(new Match({ seed: 99, settings: { quarterMinutes: 2, difficultyStep: 8, wind: 'high' } }), { seed: 5 });
  const a = run();
  const b = run();
  assert.deepEqual(a, b);
});

test('gameSim: plausible AI-vs-AI scores, no playoff ties', () => {
  let total = 0;
  for (let i = 0; i < 500; i++) {
    const r = simulateGame({ home: { off: 3, def: 2.5 }, away: { off: 2.5, def: 3 }, seed: i + 1, playoff: i % 2 === 0 });
    total += r.homeScore + r.awayScore;
    if (i % 2 === 0) assert.equal(r.tie, false);
    assert.equal(r.scoring.filter((e) => e.team === 'home').reduce((a, e) => a + e.points, 0), r.homeScore);
  }
  const avg = total / 500;
  assert.ok(avg > 30 && avg < 90, `combined ${avg}`);
});
