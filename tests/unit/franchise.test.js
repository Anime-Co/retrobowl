// Franchise unit tests: new-franchise invariants, schedule, standings/tiebreakers, playoffs,
// game sim, squads, players, progression, economy, news, draft, free agency, difficulty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../../src/franchise/index.js';
import { Rng } from '../../src/core/rng.js';
import { TEAM_TEMPLATES } from '../../src/data/teams.js';
import { FIRST_NAMES, LAST_NAMES, pickJersey, JERSEY_RANGES } from '../../src/data/names.js';
import { generateSchedule, createTeams, makeGame } from '../../src/franchise/league.js';
import { newsContext, applyEffects } from '../../src/franchise/news.js';
import { refreshFreeAgents } from '../../src/franchise/freeAgency.js';
import { updateDynamicDifficulty } from '../../src/franchise/difficulty.js';

const fresh = (seed = 7, extra = {}) => F.newFranchise({ coachName: 'Tester', teamId: 'CHI', seed, ...extra });

function deepFinite(v, path = 'save') {
  if (typeof v === 'number') assert.ok(Number.isFinite(v), `non-finite number at ${path}`);
  else if (Array.isArray(v)) v.forEach((x, i) => deepFinite(x, `${path}[${i}]`));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) deepFinite(x, `${path}.${k}`);
  else assert.notEqual(v, undefined, `undefined at ${path}`);
}

function playRegularSeason(save) {
  while (save.season.phase === 'regular') {
    const mr = F.simulateUserGame(save);
    if (mr) F.applyUserGameResult(save, mr);
    const r = F.advanceWeek(save);
    assert.ok(r.ok, JSON.stringify(r));
    if (save.season.phase !== 'regular') break;
  }
}

function playToOffseason(save) {
  let guard = 0;
  while (save.season.phase !== 'offseason' && guard++ < 40) {
    const mr = F.simulateUserGame(save);
    if (mr) F.applyUserGameResult(save, mr);
    assert.ok(F.advanceWeek(save).ok);
  }
  assert.equal(save.season.phase, 'offseason');
}

test('names: large original pools and jersey picker respects ranges', () => {
  assert.ok(FIRST_NAMES.length >= 150 && new Set(FIRST_NAMES).size === FIRST_NAMES.length);
  assert.ok(LAST_NAMES.length >= 150 && new Set(LAST_NAMES).size === LAST_NAMES.length);
  const rng = new Rng(3);
  for (const pos of F.POSITIONS) {
    const taken = new Set();
    for (let i = 0; i < 6; i++) {
      const n = pickJersey(rng, pos, taken);
      assert.ok(!taken.has(n));
      taken.add(n);
      assert.ok(JERSEY_RANGES[pos].some(([lo, hi]) => n >= lo && n <= hi), `${pos} #${n}`);
    }
  }
});

test('new franchise invariants', () => {
  const save = fresh(11);
  assert.equal(save.teams.length, 32);
  assert.equal(save.userTeamId, 'CHI');
  const team = F.userTeam(save);
  assert.ok(Array.isArray(team.roster));
  assert.ok(team.roster.length >= 8 && team.roster.length <= 9);
  assert.ok(team.roster.some((p) => p.pos === 'QB'));
  for (const p of team.roster) {
    assert.ok(F.stars(p) >= 1.5 && F.stars(p) <= 3, `start stars ${F.stars(p)}`);
    assert.deepEqual(Object.keys(p.attrs).sort(), [...F.ATTRS[p.pos]].sort());
    for (const v of Object.values(p.attrs)) assert.ok(Number.isInteger(v) && v >= 1 && v <= 10);
    assert.ok(p.potential >= F.attrSum(p) && p.potential <= 40);
    assert.ok(p.contract.salary >= 500 && p.contract.years >= 1);
    assert.equal(p.contract.salary % 100, 0);
  }
  const mostlyLow = team.roster.filter((p) => F.stars(p) <= 2.5).length;
  assert.ok(mostlyLow >= team.roster.length - 2);
  assert.deepEqual(save.facilities, { stadium: 1, training: 1, rehab: 1 });
  assert.equal(save.cc, 6);
  assert.equal(save.fans, 50);
  assert.equal(save.jobSecurity, 60);
  assert.equal(save.staff.oc.stars, 1);
  assert.equal(save.staff.dc.stars, 1);
  assert.equal(save.salaryCap, 60000);
  assert.ok(F.capUsage(save).used <= save.salaryCap);
  assert.ok(save.freeAgents.length >= 10 && save.freeAgents.length <= 14);
  assert.equal(save.season.phase, 'regular');
  assert.equal(save.season.week, 1);
  assert.ok(save.news.some((n) => n.template === 'preseason'));
  assert.equal(save.difficulty.mode, 'dynamic');
  const ai = save.teams.filter((t) => t.id !== save.userTeamId);
  const ratings = ai.flatMap((t) => [t.off, t.def]);
  assert.ok(Math.min(...ratings) >= 1.5 && Math.max(...ratings) <= 4.5);
  assert.ok(Math.max(...ratings) - Math.min(...ratings) >= 2.2, 'AI ratings should spread out');
  deepFinite(save);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(save)), save);
  // Same seed -> same franchise.
  assert.equal(JSON.stringify(fresh(11)), JSON.stringify(save));
  assert.notEqual(JSON.stringify(fresh(12)), JSON.stringify(save));
});

test('difficulty mapping and dynamic steps', () => {
  const steps = { easy: 2, medium: 6, hard: 10, extreme: 16 };
  for (const [mode, step] of Object.entries(steps)) assert.equal(F.difficultyStep(fresh(1, { difficulty: mode })), step);
  const save = fresh(1, { difficulty: 'dynamic' });
  save.difficulty.step = 8;
  assert.deepEqual(updateDynamicDifficulty(save, 'W'), { from: 8, to: 9 });
  assert.deepEqual(updateDynamicDifficulty(save, 'W'), { from: 9, to: 9 }, 'capped at 9 before a title');
  assert.deepEqual(updateDynamicDifficulty(save, 'L'), { from: 9, to: 8 });
  assert.deepEqual(updateDynamicDifficulty(save, 'T'), { from: 8, to: 8 });
  save.coach.titles = 1;
  save.difficulty.step = 15;
  updateDynamicDifficulty(save, 'W');
  updateDynamicDifficulty(save, 'W');
  assert.equal(F.difficultyStep(save), 16);
  save.difficulty.step = 1;
  updateDynamicDifficulty(save, 'L');
  assert.equal(F.difficultyStep(save), 1);
  const fixed = fresh(1, { difficulty: 'hard' });
  assert.deepEqual(updateDynamicDifficulty(fixed, 'W'), { from: 10, to: 10 });
  assert.equal(F.difficultyRating(3, 16), 5);
  assert.ok(F.difficultyRating(3, 2) < 3 && F.difficultyRating(3, 10) > 3);
  assert.equal(F.normalizeDifficulty(2), 'hard');
  assert.equal(F.normalizeDifficulty('Normal'), 'medium');
});

test('schedule: 16 games per team, one per week, balanced home/away, division twice', () => {
  const rng = new Rng(5);
  const teams = createTeams(rng);
  for (let year = 2026; year < 2032; year++) {
    const sched = generateSchedule(teams, year, rng, null);
    assert.equal(sched.length, 256);
    const ids = new Set();
    for (const g of sched) {
      assert.notEqual(g.home, g.away);
      assert.ok(!ids.has(g.id));
      ids.add(g.id);
    }
    for (let w = 1; w <= 16; w++) {
      const games = sched.filter((g) => g.week === w);
      assert.equal(games.length, 16);
      const seen = new Set();
      for (const g of games) {
        assert.ok(!seen.has(g.home) && !seen.has(g.away), `team twice in week ${w}`);
        seen.add(g.home); seen.add(g.away);
      }
      assert.equal(seen.size, 32);
    }
    for (const t of teams) {
      const mine = sched.filter((g) => g.home === t.id || g.away === t.id);
      assert.equal(mine.length, 16);
      assert.equal(mine.filter((g) => g.home === t.id).length, 8, `${t.id} home games ${year}`);
      const opp = mine.map((g) => (g.home === t.id ? g.away : g.home));
      const divMates = teams.filter((o) => o.id !== t.id && o.conf === t.conf && o.div === t.div);
      for (const d of divMates) {
        const vs = mine.filter((g) => g.home === d.id || g.away === d.id);
        assert.equal(vs.length, 2);
        assert.equal(vs.filter((g) => g.home === t.id).length, 1);
      }
      const nonDiv = opp.filter((id) => !divMates.some((d) => d.id === id));
      assert.equal(new Set(nonDiv).size, 10, 'non-division opponents are distinct');
      const otherConf = opp.filter((id) => teams.find((x) => x.id === id).conf !== t.conf);
      assert.equal(otherConf.length, 4);
    }
    const divRound16 = sched.filter((g) => g.week === 16);
    for (const g of divRound16) {
      const a = teams.find((x) => x.id === g.home);
      const b = teams.find((x) => x.id === g.away);
      assert.ok(a.conf === b.conf && a.div === b.div, 'season finale is a division game');
    }
  }
});

test('standings sum and records consistent after a full season', () => {
  const save = fresh(21);
  playRegularSeason(save);
  let w = 0; let l = 0; let t = 0; let pf = 0; let pa = 0;
  for (const team of save.teams) {
    const r = team.record;
    assert.equal(r.w + r.l + r.t, 16);
    w += r.w; l += r.l; t += r.t; pf += r.pf; pa += r.pa;
  }
  assert.equal(w, l);
  assert.equal(t % 2, 0);
  assert.equal(pf, pa);
  const snap = JSON.stringify(save.teams.map((x) => x.record));
  F.recomputeRecords(save);
  assert.equal(JSON.stringify(save.teams.map((x) => x.record)), snap);
  const rows = F.standings(save);
  assert.equal(rows.length, 32);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].pct >= rows[i].pct);
  for (const d of F.divisionStandings(save)) assert.equal(d.rows.length, 4);
});

test('tiebreakers are deterministic and use head-to-head', () => {
  const save = fresh(31);
  for (const t of save.teams) t.record = { w: 8, l: 8, t: 0, pf: 300, pa: 300, divW: 3, divL: 3, divT: 0, confW: 6, confL: 6, confT: 0, streak: 0 };
  const g = makeGame(save.season.year, 1, 'BOS', 'NYC');
  Object.assign(g, { played: true, homeScore: 10, awayScore: 20 });
  save.season.schedule = [g];
  const ids = save.teams.map((t) => t.id);
  const a = F.rankTeams(save, ids);
  const b = F.rankTeams(save, new Rng(9).shuffle([...ids]));
  assert.deepEqual(a, b);
  const pair = F.rankTeams(save, ['BOS', 'NYC']);
  assert.deepEqual(pair, ['NYC', 'BOS'], 'head-to-head winner ranks first');
  // Point differential breaks a tie when h2h is even.
  save.season.schedule = [];
  F.teamById(save, 'PHI').record.pf = 320;
  assert.equal(F.rankTeams(save, ['PHI', 'BAL'])[0], 'PHI');
});

test('playoffs: 7 seeds per conference, #1 bye, exactly one champion', () => {
  const save = fresh(41);
  playRegularSeason(save);
  const pl = save.season.playoffs;
  assert.ok(pl, 'bracket exists');
  for (const c of [0, 1]) {
    assert.equal(pl.seeds[c].length, 7);
    assert.equal(new Set(pl.seeds[c]).size, 7);
    for (const id of pl.seeds[c]) assert.equal(F.teamById(save, id).conf, c);
    const divs = pl.seeds[c].slice(0, 4).map((id) => F.teamById(save, id).div);
    assert.deepEqual([...divs].sort(), [0, 1, 2, 3]);
  }
  if (save.season.phase === 'playoffs') {
    const wc = save.season.schedule.filter((g) => g.round === 'wildcard');
    assert.equal(wc.length, 6);
    for (const c of [0, 1]) assert.ok(!wc.some((g) => g.home === pl.seeds[c][0] || g.away === pl.seeds[c][0]), '#1 seed has a bye');
  }
  playToOffseason(save);
  const finals = save.season.schedule.filter((g) => g.round === 'final');
  assert.equal(finals.length, 1);
  assert.ok(finals[0].played && finals[0].neutral);
  assert.equal(F.gameWinner(finals[0]), save.season.playoffs.champion);
  const playoffGames = save.season.schedule.filter((g) => g.playoff);
  assert.equal(playoffGames.length, 6 + 4 + 2 + 1);
  for (const g of playoffGames) assert.notEqual(g.homeScore, g.awayScore);
  assert.equal(save.history.length, 1);
  assert.equal(save.history[0].champion, save.season.playoffs.champion);
  const pic = F.playoffPicture(save);
  assert.equal(pic.champion, save.season.playoffs.champion);
});

test('gameSim: realistic scores, no playoff ties, ratings matter', () => {
  const rng = new Rng(77);
  const even = { off: 3, def: 3 };
  let total = 0;
  let ties = 0;
  const n = 3000;
  for (let i = 0; i < n; i++) {
    const r = F.simulateGame(even, even, rng);
    total += r.homeScore + r.awayScore;
    if (r.homeScore === r.awayScore) ties += 1;
    assert.ok(Number.isInteger(r.homeScore) && r.homeScore >= 0);
  }
  const avg = total / n;
  assert.ok(avg > 36 && avg < 54, `avg combined ${avg}`);
  assert.ok(ties / n < 0.02);
  for (let i = 0; i < 2000; i++) {
    const r = F.simulateGame({ off: 2, def: 2 }, { off: 2, def: 2 }, rng, { playoff: true });
    assert.notEqual(r.homeScore, r.awayScore);
  }
  let strongWins = 0;
  for (let i = 0; i < 1000; i++) {
    const r = F.simulateGame({ off: 4.5, def: 4.5 }, { off: 1.5, def: 1.5 }, rng, { neutral: true });
    if (r.homeScore > r.awayScore) strongWins += 1;
  }
  assert.ok(strongWins > 900, `strong team wins ${strongWins}/1000`);
  const p1 = F.winProbability({ off: 3, def: 3 }, { off: 3, def: 3 });
  const p2 = F.winProbability({ off: 4, def: 3 }, { off: 3, def: 3 });
  assert.ok(Math.abs(p1 - 0.5) < 1e-9 && p2 > 0.6);
  // Difficulty: the user's opponent is harder at a high step.
  let easyWins = 0;
  let hardWins = 0;
  for (let i = 0; i < 1000; i++) {
    const a = F.simulateGame(even, even, rng, { userSide: 'home', difficultyStep: 2 });
    if (a.homeScore > a.awayScore) easyWins += 1;
    const b = F.simulateGame(even, even, rng, { userSide: 'home', difficultyStep: 16 });
    if (b.homeScore > b.awayScore) hardWins += 1;
  }
  assert.ok(easyWins > hardWins * 2, `easy ${easyWins} vs extreme ${hardWins}`);
});

function checkSquadPlayer(sp) {
  const fields = ['speed', 'strength', 'hands', 'arm', 'accuracy', 'blocking', 'passRush', 'coverage', 'tackling', 'elusiveness', 'kickPower', 'kickAccuracy', 'stamina'];
  for (const f of fields) {
    assert.equal(typeof sp[f], 'number', f);
    assert.ok(sp[f] >= 0 && sp[f] <= 1, `${sp.pos}.${f}=${sp[f]}`);
  }
  assert.equal(typeof sp.name, 'string');
  assert.ok(Number.isInteger(sp.number));
}

function allSquadPlayers(sq) {
  const o = sq.offense;
  const d = sq.defense;
  return [o.QB, o.RB, ...o.WR, ...o.TE, ...o.OL, o.K, ...d.DL, ...d.LB, ...d.DB];
}

test('squad: user stars fill slots, fillers elsewhere, skills normalized', () => {
  const save = fresh(51);
  const sq = F.buildSquad(save, save.userTeamId);
  const all = allSquadPlayers(sq);
  assert.equal(all.length, 23);
  all.forEach(checkSquadPlayer);
  assert.equal(sq.offense.WR.length, 2);
  assert.equal(sq.offense.TE.length, 2);
  assert.equal(sq.offense.OL.length, 5);
  assert.equal(sq.defense.DL.length, 4);
  assert.equal(sq.defense.LB.length, 3);
  assert.equal(sq.defense.DB.length, 4);
  const starIds = new Set(F.roster(save).map((p) => p.id));
  const used = all.filter((p) => p.id);
  assert.equal(used.length, F.roster(save).length - F.depthChart(F.roster(save)).bench.length);
  for (const p of used) assert.ok(starIds.has(p.id));
  const qb = F.roster(save).find((p) => p.pos === 'QB');
  assert.equal(sq.offense.QB.id, qb.id);
  const fillers = all.filter((p) => !p.id);
  assert.ok(fillers.length > 10);
  for (const f of fillers) {
    const key = { QB: 'accuracy', RB: 'speed', WR: 'hands', TE: 'hands', OL: 'blocking', DL: 'tackling', LB: 'tackling', DB: 'tackling', K: 'kickPower' }[f.pos];
    assert.ok(f[key] >= 0.05 && f[key] <= 0.2, `filler ${f.pos} ${key} ${f[key]}`);
  }
  const nums = all.map((p) => p.number);
  assert.equal(new Set(nums).size, nums.length, 'unique jersey numbers');
  assert.ok(sq.offRating >= 0 && sq.offRating <= 1 && sq.defRating >= 0 && sq.defRating <= 1);
  assert.deepEqual(Object.keys(sq.look).sort(), ['abbr', 'city', 'helmet', 'primary', 'secondary']);
  assert.ok(sq.returner && ['WR', 'RB', 'DB'].includes(sq.returner.pos));
  // Injured QB -> filler QB; morale changes skills by about +-8%.
  qb.injury = { weeks: 2, type: 'Ankle sprain' };
  assert.equal(F.buildSquad(save, save.userTeamId).offense.QB.id, null);
  qb.injury = null;
  qb.morale = 100;
  const hi = F.buildSquad(save, save.userTeamId).offense.QB.accuracy;
  qb.morale = 0;
  const lo = F.buildSquad(save, save.userTeamId).offense.QB.accuracy;
  assert.ok(hi / lo > 1.15 && hi / lo < 1.2, `morale ratio ${hi / lo}`);
  qb.morale = 60;
  qb.condition = 40;
  assert.ok(F.buildSquad(save, save.userTeamId).offense.QB.stamina < 0.5);
  // Deterministic for the same week.
  assert.equal(JSON.stringify(F.buildSquad(save, 'NYC')), JSON.stringify(F.buildSquad(save, 'NYC')));
});

test('squad: AI skill follows star ratings; extreme = 5 stars', () => {
  const save = fresh(52, { difficulty: 'medium' });
  const weak = F.teamById(save, 'NYC');
  const strong = F.teamById(save, 'BOS');
  weak.off = 1.5; weak.def = 1.5; strong.off = 4.5; strong.def = 4.5;
  const w = F.buildSquad(save, 'NYC');
  const s = F.buildSquad(save, 'BOS');
  allSquadPlayers(w).forEach(checkSquadPlayer);
  allSquadPlayers(s).forEach(checkSquadPlayer);
  assert.ok(s.offRating > w.offRating + 0.4);
  assert.ok(s.offense.QB.accuracy > w.offense.QB.accuracy);
  const avg = (sq, k) => sq.defense.DB.reduce((a, p) => a + p[k], 0) / 4;
  assert.ok(avg(s, 'coverage') > avg(w, 'coverage'));
  const ext = F.buildSquad(save, 'NYC', { difficultyStep: 16 });
  assert.equal(ext.offStars, 5);
  assert.ok(ext.offRating > 0.99 && ext.offense.QB.arm > 0.85);
  assert.ok(allSquadPlayers(w).every((p) => p.id === null));
  // Team ratings incl. coordinator boost
  const r = F.teamRatings(save);
  assert.ok(Math.abs(r.off - Math.min(5, r.offBase + r.ocBoost)) < 0.11);
  assert.equal(r.ocBoost, 0.1);
});

test('players: stars, generation targets, salary formula, labels', () => {
  const save = fresh(61);
  const rng = new Rng(61);
  for (const pos of F.POSITIONS) {
    for (let s = 0.5; s <= 5; s += 0.5) {
      const p = F.createPlayer(save, rng, { pos, stars: s, age: 24 });
      assert.equal(F.stars(p), s, `${pos} target ${s}`);
    }
  }
  const p = F.createPlayer(save, rng, { pos: 'QB', stars: 3, age: 27 });
  for (const k of F.ATTRS.QB) p.attrs[k] = 10;
  assert.equal(F.stars(p), 5);
  for (const k of F.ATTRS.QB) p.attrs[k] = 1;
  assert.equal(F.stars(p), 0.5);
  for (const k of F.ATTRS.QB) p.attrs[k] = 6;
  p.morale = 60;
  // 0.3 + 0.9 * 3^1.6 = 5.51 -> $5.5M at peak age
  assert.equal(F.askingSalary(p), 5500);
  p.morale = 10;
  assert.ok(F.askingSalary(p) > 5500);
  assert.equal(F.rookieSalary(0.5), 500);
  assert.equal(F.rookieSalary(5), 1500);
  assert.equal(F.shortName({ first: 'Jordan', last: 'Smith' }), 'J. SMITH');
  assert.deepEqual([0, 25, 50, 70, 95].map((m) => F.moraleLabel(m).level), [0, 1, 2, 3, 4]);
  assert.equal(F.starsText(3.5), '★★★½');
  assert.deepEqual([...F.ATTRS.QB], ['arm', 'accuracy', 'speed', 'stamina']);
  assert.deepEqual([...F.ATTRS.WR], ['speed', 'strength', 'catching', 'stamina']);
  assert.deepEqual([...F.ATTRS.OL], ['blocking', 'strength', 'speed', 'stamina']);
  assert.deepEqual([...F.ATTRS.LB], ['tackling', 'strength', 'speed', 'stamina']);
  assert.deepEqual([...F.ATTRS.K], ['range', 'accuracy', 'speed', 'stamina']);
});

test('progression: XP curve, level-ups, skill points, potential cap, aging', () => {
  const save = fresh(71);
  assert.equal(F.xpForLevel(1), 100);
  assert.equal(F.xpForLevel(10), Math.round(100 * 10 ** 0.8));
  const p = F.roster(save).find((x) => x.pos === 'WR');
  p.level = 1; p.xp = 0; p.skillPoints = 0;
  p.potential = F.attrSum(p) + 2;
  const r = F.addXp(save, p, 1000);
  assert.ok(r.levelUps >= 4);
  assert.equal(p.skillPoints, 2, 'points capped by potential room');
  const attr = F.ATTRS.WR.find((k) => p.attrs[k] < 10);
  const before = p.attrs[attr];
  assert.ok(F.applySkillPoint(save, p.id, attr).ok);
  assert.equal(p.attrs[attr], before + 1);
  assert.ok(F.trainPlayer(save, p.id, attr).ok);
  assert.equal(F.applySkillPoint(save, p.id, attr).reason, 'noPoints');
  p.skillPoints = 1;
  assert.equal(F.applySkillPoint(save, p.id, attr).reason, 'potential');
  assert.equal(F.applySkillPoint(save, p.id, 'arm').reason, 'badAttr');
  assert.ok(F.retirementChance({ ...p, age: 25 }) === 0);
  assert.ok(F.retirementChance({ ...p, age: 35 }) > F.retirementChance({ ...p, age: 33 }));
  assert.equal(F.retirementChance({ ...p, age: 38 }), 1);
  const k = { ...p, pos: 'K', attrs: { range: 6, accuracy: 6, speed: 5, stamina: 5 } };
  assert.ok(F.retirementChance({ ...k, age: 35 }) < F.retirementChance({ ...p, age: 35 }), 'kickers last longer');
});

test('applyUserGameResult: summary shape, CC, injuries from hits, records', () => {
  const save = fresh(81);
  const g = F.nextUserGame(save);
  const team = F.userTeam(save);
  const qb = team.roster.find((p) => p.pos === 'QB');
  const rb = team.roster.find((p) => p.pos === 'RB');
  const ccBefore = save.cc;
  const sum = F.applyUserGameResult(save, {
    gameId: g.id,
    userScore: 35,
    oppScore: 10,
    ot: false,
    stats: { [qb.id]: { passAtt: 34, passCmp: 27, passYds: 480, passTd: 4, int: 0 }, [rb.id]: { rushAtt: 18, rushYds: 90, rushTd: 1, rec: 2, recYds: 15 }, bogus: { passYds: 99 } },
    hits: [...Array(400)].map(() => ({ playerId: rb.id, power: 1 })),
    log: [],
  });
  assert.equal(sum.won, true);
  assert.equal(sum.ccEarned, 1 + 2 + 1);
  assert.equal(save.cc >= ccBefore + 4 - 1, true);
  assert.ok(sum.injuries.some((i) => i.playerId === rb.id), 'heavy hits injure');
  assert.ok(rb.injury && rb.injury.weeks >= 1);
  assert.ok(sum.injuries.every((i) => i.playerId === rb.id), 'only hit players can be injured');
  assert.equal(qb.season.passYds, 480);
  assert.equal(qb.career.passTd, 4);
  assert.ok(sum.xpGains.find((x) => x.playerId === qb.id).xp > 50);
  assert.ok(sum.records.some((r) => r.stat === 'passYds' && r.scope === 'game'), 'beat the single-game passing record');
  assert.equal(save.records.game.passYds.value, 480);
  assert.ok(Array.isArray(sum.news) && sum.news.length <= 2);
  assert.ok(g.played && (g.home === team.id ? g.homeScore : g.awayScore) === 35);
  assert.throws(() => F.applyUserGameResult(save, { gameId: g.id, userScore: 1, oppScore: 0, stats: {} }));
  assert.equal(F.userWeekStatus(save), 'played');
  assert.equal(F.advanceWeek(save).ok, true);
  assert.equal(save.season.week, 2);
  deepFinite(save);
  // advanceWeek refuses while the user's game is pending
  assert.equal(F.advanceWeek(save).reason, 'userGamePending');
});

test('matchSetup: options for the match screen', () => {
  const save = fresh(85);
  const ms = F.matchSetup(save);
  const g = F.userGameThisWeek(save);
  assert.equal(ms.gameId, g.id);
  assert.equal(ms.userIsHome, g.home === save.userTeamId);
  assert.equal(ms.userTeam.id, save.userTeamId);
  assert.equal(ms.oppTeam.id, F.opponentOf(save, g).id);
  assert.equal(ms.userSquad.teamId, save.userTeamId);
  assert.equal(ms.audibles, Math.min(5, 1 + Math.floor(F.roster(save).find((p) => p.pos === 'QB').level / 3)));
  for (const d of ms.userDefenders) assert.ok(['DL', 'LB', 'DB'].includes(d.pos) && F.findPlayer(save, d.id));
  assert.equal(ms.snowEligible, false, 'no snow in week 1');
  assert.equal(ms.seed, F.matchSetup(save).seed);
  assertNoUndefined(ms);
  F.applyUserGameResult(save, F.simulateUserGame(save));
  assert.equal(F.matchSetup(save), null);
  // Events from this week's game stay open after advancing one week, then lapse.
  const open = F.pendingNews(save).map((n) => n.id);
  F.advanceWeek(save);
  for (const id of open) assert.ok(F.pendingNews(save).some((n) => n.id === id));
  F.applyUserGameResult(save, F.simulateUserGame(save));
  F.advanceWeek(save);
  for (const id of open) assert.ok(!F.pendingNews(save).some((n) => n.id === id));
});

function assertNoUndefined(v, path = 'x') {
  if (v === undefined) assert.fail(`undefined at ${path}`);
  if (typeof v === 'number') assert.ok(Number.isFinite(v), path);
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) assertNoUndefined(x, `${path}.${k}`);
}

test('economy: facilities, release dead money, contracts, coordinators, boosts', () => {
  const save = fresh(91);
  save.cc = 50;
  assert.equal(F.facilityUpgradeCost(save, 'training'), 4);
  assert.ok(F.upgradeFacility(save, 'training').ok);
  assert.equal(save.facilities.training, 2);
  assert.equal(save.cc, 46);
  assert.ok(F.trainingXpMult(save) > 1.14);
  save.facilities.stadium = 5;
  assert.equal(F.upgradeFacility(save, 'stadium').reason, 'maxed');
  save.cc = 0;
  assert.equal(F.upgradeFacility(save, 'rehab').reason, 'cc');

  const p = F.roster(save)[0];
  p.contract = { salary: 4000, years: 2 };
  const n0 = F.roster(save).length;
  const rel = F.releasePlayer(save, p.id);
  assert.ok(rel.ok);
  assert.equal(rel.deadMoney, 2000, '50% of the full season remaining in week 1');
  assert.equal(F.roster(save).length, n0 - 1);
  assert.equal(F.capUsage(save).deadMoney, 2000);

  const q = F.roster(save)[0];
  q.contract.years = 1;
  q.age = 26;
  q.morale = 10;
  assert.equal(F.extendContract(save, q.id, 2).reason, 'refuses');
  q.morale = 70;
  const ext = F.extendContract(save, q.id, 2);
  assert.ok(ext.ok);
  assert.equal(q.contract.years, 3);
  assert.ok(q.contract.salary >= F.askingSalary(q) - 100);
  assert.equal(F.extendContract(save, q.id, 1).reason, 'notYet');
  q.contract.years = 2;
  q.age = 34;
  assert.equal(F.extendContract(save, q.id, 1).reason, 'maxYears', 'veterans cap contract length');

  assert.equal(F.hireCoordinator(save, 'oc', 'x').reason, 'closed');
  save.cc = 2;
  assert.ok(F.boostMorale(save, q.id).ok);
  assert.equal(save.cc, 1);
  assert.equal(F.boostTeamMorale(save).reason, 'cc');
  q.injury = { weeks: 2, type: 'Ankle sprain' };
  assert.ok(F.rushTreatment(save, q.id).ok);
  assert.equal(q.injury.weeks, 1);
  assert.equal(F.rushTreatment(save, q.id).reason, 'used');
});

test('news: >= 25 original templates, all buildable, effects apply visibly', () => {
  assert.ok(F.NEWS_TEMPLATES.length >= 25);
  assert.equal(new Set(F.NEWS_TEMPLATES.map((t) => t.id)).size, F.NEWS_TEMPLATES.length);
  const save = fresh(101);
  const r = F.roster(save);
  const rng = new Rng(1);
  const ctx = newsContext(save, rng, {});
  Object.assign(ctx, {
    post: true, won: true, lost: true, margin: 2, us: 24, them: 31, score: '24-31', streak: 4,
    opp: F.teamById(save, 'NYC'), next: F.teamById(save, 'DET'), rival: true, inRace: true, upset: true,
    top: { p: r[0], line: 'ran for 140 yards' }, qbInts: { p: r[0], n: 3 }, injured: { p: r[1], weeks: 3 },
    contractYear: r[2], lowTouch: r[3], rookieStar: { p: r[4], line: 'made 11 tackles' }, kick: { p: r[5], made: 1, att: 3 },
    vet: r[6], rookie: r[7], unhappy: r[2], star: r[3], any: r[4], young: r[5], longInjured: r[1], defStar: r[6],
    js: 30, preseason: true, week: 8, playoff: false, record: '4-4',
  });
  for (const t of F.NEWS_TEMPLATES) {
    const ev = t.make(ctx);
    assert.ok(ev.title && ev.body, t.id);
    assert.ok(ev.choices.length >= 2 && ev.choices.length <= 3, `${t.id} choices`);
    for (const c of ev.choices) {
      assert.ok(c.label && c.reply);
      assert.ok(F.effectsText(save, c.effects).length >= 1, `${t.id} choice has a visible effect`);
    }
  }
  // Resolve a generated event.
  const ev = save.news.find((n) => !n.resolved);
  const fans = save.fans;
  const res = F.resolveNews(save, ev.id, 0);
  assert.ok(res.ok && res.effects.length >= 1);
  assert.ok(ev.resolved);
  assert.equal(F.resolveNews(save, ev.id, 0).reason, 'resolved');
  assert.ok(save.fans !== fans || res.effects.length);
  // CC-costing choices require CC.
  save.cc = 0;
  assert.equal(F.choiceAvailable(save, { effects: { cc: -1 } }), false);
  applyEffects(save, { players: [{ id: r[0].id, delta: -500 }] });
  assert.equal(r[0].morale, 0);
});

test('draft: order, prospects, scouting, roster space, rookie deals', () => {
  const save = fresh(111);
  playToOffseason(save);
  const order = F.draftOrder(save);
  assert.equal(order.length, 32);
  assert.equal(new Set(order).size, 32);
  assert.equal(order[31], save.season.playoffs.champion);
  assert.equal(order[30], save.season.playoffs.runnerUp);
  // advance to the draft step with neutral choices
  while (F.currentOffseasonStep(save) !== 'draft') assert.ok(F.runOffseasonStep(save).ok);
  const d = save.draft;
  assert.ok(d.prospects.length <= 60 && d.prospects.length >= 30);
  assert.equal(d.picks.length, 96);
  assert.ok(F.userOnClock(save));
  const views = F.draftProspects(save);
  for (const v of views) {
    assert.ok(v.age >= 21 && v.age <= 23);
    assert.ok(v.estimate.lo <= v.estimate.hi);
    assert.equal(v.stars, null);
    const real = d.prospects.find((p) => p.id === v.id);
    assert.ok(F.stars(real) >= v.estimate.lo && F.stars(real) <= v.estimate.hi);
    assert.equal(real.contract.years, 3);
    assert.ok(real.contract.salary >= 500 && real.contract.salary <= 1500);
  }
  save.cc = 1;
  const sc = F.scoutProspect(save, views[0].id);
  assert.ok(sc.ok && save.cc === 0);
  assert.equal(F.draftProspects(save).find((v) => v.id === views[0].id).stars, sc.stars);
  // Full roster blocks the pick.
  const team = F.userTeam(save);
  const real = team.roster.slice();
  while (team.roster.length < 12) team.roster.push({ ...real[0], id: `dummy${team.roster.length}` });
  assert.equal(F.draftPlayer(save, views[0].id).reason, 'rosterFull');
  team.roster = real;
  const pickRes = F.draftPlayer(save, views[0].id);
  assert.ok(pickRes.ok);
  assert.ok(team.roster.some((p) => p.id === views[0].id && p.rookie));
  assert.ok(!F.userOnClock(save) || save.draft.picks[save.draft.index].round > 1);
  assert.ok(F.runOffseasonStep(save, 'draft').ok);
  assert.ok(save.draft.done);
});

test('offseason contracts: re-sign, let go, extensions before the step are honoured', () => {
  const save = fresh(131);
  playToOffseason(save);
  while (F.currentOffseasonStep(save) !== 'contracts') {
    if (save.fired) break;
    assert.ok(F.runOffseasonStep(save).ok);
  }
  const team = F.userTeam(save);
  const [a, b, c] = team.roster;
  for (const p of [a, b, c]) { p.contract.years = 1; p.morale = 70; p.age = 27; }
  c.contract.years = 2; // extend c now: no longer expiring
  const ext = F.extendContract(save, c.id, 2);
  assert.ok(ext.ok, JSON.stringify(ext));
  const others = team.roster.filter((p) => ![a.id, b.id, c.id].includes(p.id));
  const yearsBefore = new Map(others.map((p) => [p.id, p.contract.years]));
  const res = F.runOffseasonStep(save, 'contracts', { resign: { [a.id]: 2 } });
  assert.ok(res.ok);
  assert.ok(team.roster.some((p) => p.id === a.id && p.contract.years === 2));
  assert.ok(!team.roster.some((p) => p.id === b.id), 'not re-signed -> leaves');
  assert.ok(team.roster.some((p) => p.id === c.id), 'extended player stays');
  for (const p of team.roster) if (yearsBefore.has(p.id)) assert.equal(p.contract.years, Math.max(1, yearsBefore.get(p.id) - 1));
  // Departed players enter the free-agent pool at the free-agency step.
  while (F.currentOffseasonStep(save) !== 'freeAgency') {
    const step = F.currentOffseasonStep(save);
    if (step === 'draft') while (F.userOnClock(save)) F.passPick(save);
    assert.ok(F.runOffseasonStep(save).ok);
  }
  assert.ok(save.freeAgents.some((p) => p.id === b.id));
});

test('free agency: pool size, fee, cap/roster/CC checks', () => {
  const save = fresh(121);
  const rng = new Rng(4);
  for (let i = 0; i < 5; i++) {
    refreshFreeAgents(save, rng);
    assert.ok(save.freeAgents.length >= 10 && save.freeAgents.length <= 14);
  }
  const fa = F.freeAgents(save);
  for (const f of fa) assert.equal(f.fee, Math.ceil(f.stars));
  save.cc = 0;
  assert.equal(F.signFreeAgent(save, fa[0].id).reason, 'cc');
  save.cc = 99;
  save.deadMoney = save.salaryCap;
  assert.equal(F.signFreeAgent(save, fa[0].id).reason, 'cap');
  save.deadMoney = 0;
  const n = F.roster(save).length;
  const res = F.signFreeAgent(save, fa[0].id);
  assert.ok(res.ok);
  assert.equal(F.roster(save).length, n + 1);
  assert.equal(save.cc, 99 - fa[0].fee);
  assert.ok(!save.freeAgents.some((p) => p.id === fa[0].id));
  assert.equal(res.player.ask, undefined);
  deepFinite(save);
});

test('any star beats a generic filler on key attributes', () => {
  // Design invariant (MECHANICS §6.1): signing a star always upgrades the position.
  for (let seed = 1; seed <= 20; seed++) {
    const save = F.newFranchise({ coachName: 'T', teamId: 'BOS', seed });
    const sq = F.buildSquad(save, 'BOS', { opponent: false });
    const all = [sq.offense.QB, sq.offense.RB, ...sq.offense.WR, ...sq.offense.TE, ...sq.offense.OL, sq.offense.K, ...sq.defense.DL, ...sq.defense.LB, ...sq.defense.DB];
    const key = { QB: 'accuracy', RB: 'speed', WR: 'hands', TE: 'hands', OL: 'blocking', DL: 'tackling', LB: 'tackling', DB: 'tackling', K: 'kickPower' };
    const fillerMax = Math.max(...all.filter((p) => !p.id).map((p) => p[key[p.pos]]));
    for (const p of all.filter((x) => x.id)) assert.ok(p[key[p.pos]] > fillerMax - 0.02, `${p.pos} ${p[key[p.pos]]} vs filler ${fillerMax}`);
  }
});

test('release cost preview and rush-treatment checks match the actions', () => {
  const save = F.newFranchise({ coachName: 'T', teamId: 'BOS', seed: 5 });
  const p = F.roster(save)[1];
  const preview = F.releaseCost(save, p.id);
  const r = F.releasePlayer(save, p.id);
  assert.equal(r.deadMoney, preview);
  const q = F.roster(save)[0];
  assert.equal(F.canRushTreatment(save, q.id).reason, 'healthy');
  q.injury = { weeks: 30, type: 'Broken leg', seasonEnding: true };
  assert.equal(F.canRushTreatment(save, q.id).reason, 'seasonEnding');
  q.injury = { weeks: 3, type: 'Sprain' };
  save.cc = 50;
  assert.equal(F.canRushTreatment(save, q.id).ok, true);
  assert.equal(F.rushTreatment(save, q.id).ok, true);
  assert.equal(F.canRushTreatment(save, q.id).reason, 'used');
  assert.deepEqual(F.previewLeague(77).map((t) => [t.id, t.off, t.def]), F.newFranchise({ teamId: 'BOS', seed: 77 }).teams.map((t) => [t.id, t.off, t.def]));
});
