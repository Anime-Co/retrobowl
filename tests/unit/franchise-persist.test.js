// Franchise persistence: the Save survives a JSON round trip (what localStorage does) at every
// point of the loop without losing or double-applying anything, and the post-game recap kept in
// the save (save.pendingPostGame) is valid exactly until the week is advanced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../../src/franchise/index.js';

const fresh = (seed = 11) => F.newFranchise({ coachName: 'Persist', teamId: 'CHI', seed });
const clone = (s) => JSON.parse(JSON.stringify(s));

function userGames(save) {
  return save.season.schedule.filter((g) => g.played && (g.home === save.userTeamId || g.away === save.userTeamId)).length;
}

function allPlayerIds(save) {
  const ids = [];
  for (const t of save.teams) for (const p of t.roster || []) ids.push(p.id);
  for (const p of save.freeAgents || []) ids.push(p.id);
  for (const p of (save.draft && save.draft.prospects) || []) ids.push(p.id);
  return ids;
}

function noDuplicates(save, where) {
  const ids = allPlayerIds(save);
  assert.equal(new Set(ids).size, ids.length, `duplicate player ids ${where}`);
}

test('post-game recap: stored after the game, survives a reload, cleared by advancing the week', () => {
  const save = fresh();
  const mr = F.simulateUserGame(save);
  const sum = F.applyUserGameResult(save, mr);
  F.setPendingPostGame(save, sum, { ...mr, log: new Array(500).fill({ text: 'x' }), hits: [{ playerId: 'p1', power: 1 }] });
  const reloaded = clone(save);
  const pg = F.pendingPostGame(reloaded);
  assert.ok(pg, 'recap available after reload');
  assert.equal(pg.gameId, mr.gameId);
  assert.equal(pg.summary.userScore, mr.userScore);
  assert.equal(pg.result.oppScore, mr.oppScore);
  assert.equal(pg.result.log, undefined, 'the play log is not stored');
  assert.equal(pg.result.hits, undefined, 'injury hits are not stored');
  // Reopening the recap applies nothing: the game counts once.
  assert.equal(userGames(reloaded), 1);
  assert.equal(reloaded.coach.wins + reloaded.coach.losses + reloaded.coach.ties, 1);
  const r = F.advanceWeek(reloaded);
  assert.ok(r.ok);
  assert.equal(reloaded.pendingPostGame, undefined, 'advancing the week drops the recap');
  assert.equal(F.pendingPostGame(reloaded), null);
  // A stale recap from an older week is ignored.
  reloaded.pendingPostGame = pg;
  assert.equal(F.pendingPostGame(reloaded), null, 'recap of last week is not offered');
});

test('post-game summary deltas are clean decimals (no float noise)', () => {
  const save = fresh(5);
  for (let i = 0; i < 12 && save.season.phase === 'regular'; i++) {
    const mr = F.simulateUserGame(save);
    if (mr) {
      const sum = F.applyUserGameResult(save, mr);
      for (const k of ['fansDelta', 'jobSecurityDelta']) {
        const v = sum[k] * 10;
        assert.ok(Math.abs(v - Math.round(v)) < 1e-9, `${k} ${sum[k]} has float noise`);
      }
    }
    F.advanceWeek(save);
  }
});

test('reloading at any point of a season gives the same future (no lost or doubled results)', () => {
  const a = fresh(21);
  let guard = 0;
  while (a.season.phase !== 'offseason' && guard++ < 40) {
    const b = clone(a); // "reload" here
    for (const s of [a, b]) {
      const mr = F.simulateUserGame(s);
      if (mr) {
        const sum = F.applyUserGameResult(s, mr);
        F.setPendingPostGame(s, sum, mr);
      }
    }
    assert.deepEqual(clone(b), clone(a), `diverged after a reload in week ${a.season.week}`);
    const c = clone(a); // reload between the game and Continue
    F.advanceWeek(a);
    F.advanceWeek(c);
    assert.deepEqual(clone(c), clone(a), 'advancing after a reload differs');
    // the played game can never be applied twice
    const g = a.season.schedule.find((x) => x.played && x.week === a.season.week - 1 && (x.home === a.userTeamId || x.away === a.userTeamId));
    if (g && a.season.phase === 'regular') {
      assert.throws(() => F.applyUserGameResult(a, { gameId: g.id, userScore: 1, oppScore: 0, ot: false, stats: {} }));
    }
    noDuplicates(a, `week ${a.season.week}`);
  }
  assert.equal(a.season.phase, 'offseason');
});

test('offseason: every step resumes identically after a reload; draft picks are never duplicated', () => {
  const save = fresh(33);
  let guard = 0;
  while (save.season.phase !== 'offseason' && guard++ < 40) {
    const mr = F.simulateUserGame(save);
    if (mr) F.applyUserGameResult(save, mr);
    F.advanceWeek(save);
  }
  save.cc = 50;
  guard = 0;
  while (save.offseason && guard++ < 20) {
    const step = F.currentOffseasonStep(save);
    const reloaded = clone(save);
    assert.equal(F.currentOffseasonStep(reloaded), step, 'same step after reload');
    if (step === 'draft') {
      for (const s of [save, reloaded]) {
        if (F.userOnClock(s)) {
          const pick = F.draftProspects(s)[0];
          const r = F.draftPlayer(s, pick.id);
          if (r.ok) {
            assert.equal(F.roster(s).filter((p) => p.id === pick.id).length, 1, 'drafted once');
            assert.ok(!s.draft.prospects.some((p) => p.id === pick.id), 'removed from the board');
          }
        }
      }
      noDuplicates(save, 'after a draft pick');
      assert.deepEqual(clone(reloaded), clone(save), 'draft pick differs after reload');
    }
    const r1 = F.runOffseasonStep(save, step);
    const r2 = F.runOffseasonStep(reloaded, step);
    assert.ok(r1.ok && r2.ok, `${step}: ${r1.message || ''}`);
    assert.deepEqual(clone(reloaded), clone(save), `step ${step} differs after reload`);
    noDuplicates(save, `after ${step}`);
    // A step can't run twice (a double tap / reload never repeats it)
    if (save.offseason) assert.equal(F.runOffseasonStep(save, step).ok, false, `${step} ran twice`);
  }
  assert.equal(save.season.phase, 'regular');
  assert.equal(save.season.week, 1);
});

test('fired: the offer survives a reload and the offseason resumes with the new team', () => {
  const save = fresh(44);
  let guard = 0;
  while (save.season.phase !== 'offseason' && guard++ < 40) {
    const mr = F.simulateUserGame(save);
    if (mr) F.applyUserGameResult(save, mr);
    F.advanceWeek(save);
  }
  save.jobSecurity = 0;
  save.coach.seasons = 5;
  const r = F.runOffseasonStep(save, 'summary');
  assert.ok(r.ok && r.result.fired);
  const reloaded = clone(save);
  assert.ok(reloaded.fired);
  assert.equal(F.runOffseasonStep(reloaded).ok, false, 'pipeline waits for a new job');
  const offer = F.jobOffers(reloaded)[0];
  assert.ok(F.takeJob(reloaded, offer.teamId).ok);
  const again = clone(reloaded);
  assert.equal(again.fired, null);
  assert.equal(again.userTeamId, offer.teamId);
  assert.ok(F.roster(again).length > 0);
  assert.equal(F.takeJob(again, offer.teamId).ok, false, 'cannot take a job twice');
  guard = 0;
  while (again.offseason && guard++ < 20) assert.ok(F.runOffseasonStep(again).ok);
  assert.equal(again.season.phase, 'regular');
  noDuplicates(again, 'after the new job');
});
