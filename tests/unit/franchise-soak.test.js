// Franchise soak: 10 auto-played seasons with random-but-legal management decisions and full
// offseasons. Checks invariants every season and prints an economy sanity table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../../src/franchise/index.js';
import { Rng } from '../../src/core/rng.js';

function deepFinite(v, path = 'save') {
  if (typeof v === 'number') assert.ok(Number.isFinite(v), `non-finite number at ${path}`);
  else if (Array.isArray(v)) v.forEach((x, i) => deepFinite(x, `${path}[${i}]`));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) deepFinite(x, `${path}.${k}`);
  else assert.notEqual(v, undefined, `undefined at ${path}`);
}

function assertRoundTrip(save) {
  const copy = JSON.parse(JSON.stringify(save));
  assert.deepStrictEqual(copy, save);
}

function assertRosterOk(save) {
  const r = F.roster(save);
  assert.ok(r.length <= F.ROSTER.cap, `roster ${r.length}`);
  assert.equal(new Set(r.map((p) => p.id)).size, r.length, 'unique player ids');
  assert.equal(new Set(r.map((p) => p.number)).size, r.length, 'unique jersey numbers');
}

/** Random-but-legal in-season management. `bot` is the test's own rng (decisions only). */
function manage(save, bot, stats) {
  for (const n of F.pendingNews(save)) {
    const ok = n.choices.map((c, i) => (F.choiceAvailable(save, c) ? i : -1)).filter((i) => i >= 0);
    if (ok.length && bot.chance(0.85)) assert.ok(F.resolveNews(save, n.id, bot.pick(ok)).ok);
  }
  for (const p of F.roster(save)) {
    let guard = 0;
    while (p.skillPoints > 0 && guard++ < 20) {
      const attrs = F.ATTRS[p.pos].filter((a) => p.attrs[a] < 10);
      if (!attrs.length) break;
      const r = F.applySkillPoint(save, p.id, bot.pick(attrs));
      if (!r.ok) break;
      stats.pointsSpent += 1;
    }
  }
  if (bot.chance(0.25)) {
    const kind = bot.pick(['stadium', 'training', 'rehab']);
    if (F.upgradeFacility(save, kind).ok) stats.upgrades += 1;
  }
  if (bot.chance(0.3)) {
    const fa = F.freeAgents(save).filter((f) => f.canSign);
    if (fa.length) {
      const pick = fa.reduce((b, f) => (f.stars > b.stars ? f : b), fa[0]);
      if (F.signFreeAgent(save, pick.id, bot.int(1, 3)).ok) stats.signings += 1;
    }
  }
  if (bot.chance(0.1)) {
    const cand = F.roster(save).filter((p) => F.canExtend(p));
    if (cand.length && F.extendContract(save, bot.pick(cand).id, bot.int(1, 3)).ok) stats.extensions += 1;
  }
  if (bot.chance(0.03) && F.roster(save).length >= 10) {
    const worst = F.roster(save).reduce((w, p) => (F.stars(p) < F.stars(w) ? p : w));
    if (F.releasePlayer(save, worst.id).ok) stats.releases += 1;
  }
  for (const p of F.roster(save)) {
    if (p.injury && save.cc > 12 && bot.chance(0.5) && F.rushTreatment(save, p.id).ok) stats.rushes += 1;
    if (p.morale < 30 && save.cc > 8 && F.boostMorale(save, p.id).ok) stats.boosts += 1;
  }
}

function playSeason(save, bot, stats, { forceFire = false } = {}) {
  let guard = 0;
  while (save.season.phase !== 'offseason' && guard++ < 40) {
    manage(save, bot, stats);
    const mr = F.simulateUserGame(save);
    if (mr) {
      const sum = F.applyUserGameResult(save, mr);
      stats.cc += sum.ccEarned;
      stats.games += 1;
      stats.injuries += sum.injuries.length;
      stats.levelUps += sum.xpGains.reduce((s, x) => s + x.levelUps, 0);
      stats.news += sum.news.length;
      stats.records += sum.records.length;
      if (sum.won) stats.wins += 1;
      for (const x of sum.xpGains) assert.ok(Number.isFinite(x.xp) && x.xp >= 0);
    }
    assertRosterOk(save);
    if (forceFire && save.season.phase !== 'offseason' && save.season.week >= 16) save.jobSecurity = 0;
    const r = F.advanceWeek(save);
    assert.ok(r.ok, JSON.stringify(r));
    if (forceFire) save.jobSecurity = Math.min(save.jobSecurity, 1);
  }
  assert.equal(save.season.phase, 'offseason');
}

function assertOneChampion(save) {
  const finals = save.season.schedule.filter((g) => g.playoff && g.round === 'final');
  assert.equal(finals.length, 1, 'exactly one final');
  const champ = F.gameWinner(finals[0]);
  assert.ok(champ);
  assert.equal(save.season.playoffs.champion, champ);
  assert.equal(save.history[save.history.length - 1].champion, champ);
  const unplayed = save.season.schedule.filter((g) => !g.played);
  assert.equal(unplayed.length, 0, 'every game played');
}

function runOffseason(save, bot, stats) {
  const agesBefore = new Map(F.roster(save).map((p) => [p.id, p.age]));
  let guard = 0;
  let aged = false;
  while (save.offseason && guard++ < 50) {
    if (save.fired) {
      const offers = F.jobOffers(save);
      assert.ok(offers.length >= 1);
      assert.ok(F.takeJob(save, bot.pick(offers).teamId).ok);
      stats.firings += 1;
      agesBefore.clear();
      continue;
    }
    const step = F.currentOffseasonStep(save);
    const data = F.offseasonData(save);
    let choice = null;
    if (step === 'contracts') {
      choice = { resign: Object.fromEntries((data || []).filter((c) => c.demand.willing && bot.chance(0.75)).map((c) => [c.playerId, bot.int(1, c.demand.maxYears)])) };
    } else if (step === 'facilities') {
      choice = { maintain: (data || []).filter(() => bot.chance(0.6)).map((f) => f.kind) };
    } else if (step === 'staff') {
      const hire = {};
      for (const role of ['oc', 'dc']) {
        const cands = F.coordinatorCandidates(save, role).filter((c) => c.cost <= save.cc / 2);
        const cur = save.staff[role];
        const best = cands.reduce((b, c) => (!b || c.stars > b.stars ? c : b), null);
        if (best && (!cur || cur.years <= 1 || best.stars > cur.stars) && bot.chance(0.8)) hire[role] = best.id;
      }
      choice = { hire };
    } else if (step === 'draft') {
      let g = 0;
      while (F.userOnClock(save) && g++ < 10) {
        const prospects = F.draftProspects(save);
        if (save.cc > 3 && prospects.length && bot.chance(0.5)) F.scoutProspect(save, prospects[0].id);
        if (F.roster(save).length < F.ROSTER.cap && prospects.length && bot.chance(0.8)) {
          const r = F.draftPlayer(save, prospects[0].id);
          if (r.ok) stats.drafted += 1; else assert.ok(F.passPick(save).ok);
        } else {
          assert.ok(F.passPick(save).ok);
        }
      }
    } else if (step === 'freeAgency') {
      const fa = F.freeAgents(save).filter((f) => f.canSign).sort((a, b) => b.stars - a.stars);
      choice = { sign: fa.slice(0, bot.int(0, 2)).map((f) => f.id) };
    }
    const res = F.runOffseasonStep(save, step, choice);
    assert.ok(res.ok, `${step}: ${JSON.stringify(res)}`);
    if (step === 'retirements') stats.retired += res.result.retired.length;
    if (step === 'progression') {
      aged = true;
      for (const p of F.roster(save)) {
        if (agesBefore.has(p.id)) assert.equal(p.age, agesBefore.get(p.id) + 1, 'ages advance by one');
      }
    }
    if (step === 'freeAgency') stats.signings += res.result.signed.length;
    assertRosterOk(save);
  }
  assert.ok(aged, 'progression step ran');
  assert.equal(save.offseason, null);
  assert.equal(save.season.phase, 'regular');
  assert.equal(save.season.week, 1);
}

function starDistribution(save) {
  const dist = {};
  for (const p of F.roster(save)) {
    const s = F.stars(p);
    dist[s] = (dist[s] || 0) + 1;
  }
  return Object.keys(dist).map(Number).sort((a, b) => a - b).map((s) => `${s}:${dist[s]}`).join(' ');
}

test('10-season soak: invariants hold every season', () => {
  const save = F.newFranchise({ coachName: 'Soak', teamId: 'DEN', seed: 2024, difficulty: 'dynamic' });
  const bot = new Rng(99);
  const rows = [];
  const totals = { retired: 0, firings: 0 };
  let prevYear = save.season.year;
  for (let season = 0; season < 10; season++) {
    const stats = { cc: 0, games: 0, wins: 0, injuries: 0, levelUps: 0, news: 0, records: 0, pointsSpent: 0, upgrades: 0, signings: 0, extensions: 0, releases: 0, rushes: 0, boosts: 0, drafted: 0, retired: 0, firings: 0 };
    playSeason(save, bot, stats);
    assertOneChampion(save);
    deepFinite(save);
    assertRoundTrip(save);
    const hist = save.history[save.history.length - 1];
    runOffseason(save, bot, stats);
    totals.retired += stats.retired;
    totals.firings += stats.firings;
    assert.equal(save.season.year, prevYear + 1);
    prevYear = save.season.year;
    const cap = F.capUsage(save);
    assert.ok(cap.used <= cap.cap, `payroll ${cap.used} over cap ${cap.cap}`);
    assert.equal(save.salaryCap, F.CAP.base + F.CAP.perSeason * (season + 1));
    assertRosterOk(save);
    assert.ok(F.roster(save).length >= 1);
    deepFinite(save);
    assertRoundTrip(save);
    assert.ok(save.cc >= 0);
    for (const k of ['stadium', 'training', 'rehab']) assert.ok(save.facilities[k] >= 1 && save.facilities[k] <= 5);
    assert.ok(save.fans >= 0 && save.fans <= 100 && save.jobSecurity >= 0 && save.jobSecurity <= 100);
    rows.push({
      year: hist.year,
      team: hist.abbr,
      rec: `${hist.w}-${hist.l}${hist.t ? `-${hist.t}` : ''}`,
      result: hist.result,
      diff: hist.difficulty,
      ccEarned: stats.cc,
      ccNow: save.cc,
      fac: `${save.facilities.stadium}/${save.facilities.training}/${save.facilities.rehab}`,
      roster: F.roster(save).length,
      stars: starDistribution(save),
      rating: `${F.teamRatings(save).off}/${F.teamRatings(save).def}`,
      cap: `${(cap.used / 1000).toFixed(1)}/${(cap.cap / 1000).toFixed(0)}M (${Math.round((100 * cap.used) / cap.cap)}%)`,
      inj: stats.injuries,
      lvl: stats.levelUps,
      ret: stats.retired,
      draft: stats.drafted,
      fa: stats.signings,
      js: Math.round(save.jobSecurity),
      fans: Math.round(save.fans),
    });
  }
  assert.ok(totals.retired > 0, 'some players retire over 10 seasons');
  assert.equal(save.history.length, 10);
  assert.ok(save.coach.seasons === 10);
  console.log('\nFranchise economy over 10 seasons (seed 2024, dynamic difficulty):');
  console.table(rows);
  const avgCc = rows.reduce((s, r) => s + r.ccEarned, 0) / rows.length;
  console.log(`avg CC earned/season: ${avgCc.toFixed(1)}; retirements: ${totals.retired}; Hall of Fame: ${save.hallOfFame.length}; firings: ${totals.firings}`);
  assert.ok(avgCc > 15 && avgCc < 80, `avg CC ${avgCc}`);
});

test('firing path: forced low confidence -> offers from weaker teams -> new job', () => {
  const save = F.newFranchise({ coachName: 'Hot Seat', teamId: 'KCY', seed: 77, difficulty: 'hard' });
  const bot = new Rng(5);
  const stats = { cc: 0, games: 0, wins: 0, injuries: 0, levelUps: 0, news: 0, records: 0, pointsSpent: 0, upgrades: 0, signings: 0, extensions: 0, releases: 0, rushes: 0, boosts: 0, drafted: 0, retired: 0, firings: 0 };
  // Season 1 is a grace season: no firing even at zero confidence.
  playSeason(save, bot, stats, { forceFire: true });
  assert.equal(F.runOffseasonStep(save, 'summary').result.fired, false);
  while (save.offseason) assert.ok(F.runOffseasonStep(save).ok);
  // Season 2: forced to zero -> fired at the season review.
  playSeason(save, bot, stats, { forceFire: true });
  assert.ok(F.offseasonData(save, 'summary').atRisk);
  const res = F.runOffseasonStep(save, 'summary');
  assert.ok(res.ok && res.result.fired);
  assert.ok(save.fired);
  assert.equal(F.runOffseasonStep(save).reason, 'fired', 'pipeline waits for a new job');
  const offers = F.jobOffers(save);
  assert.equal(offers.length, 3);
  const oldId = save.userTeamId;
  const oldStrength = F.teamRatings(save, oldId);
  const sorted = [...save.teams].filter((t) => t.id !== oldId).sort((a, b) => a.off + a.def - (b.off + b.def));
  const weakest = new Set(sorted.slice(0, 12).map((t) => t.id));
  for (const o of offers) assert.ok(weakest.has(o.teamId), 'offers come from weaker teams');
  const coachBefore = { ...save.coach, teams: [...save.coach.teams] };
  const historyLen = save.history.length;
  const target = offers[0].teamId;
  const tj = F.takeJob(save, target);
  assert.ok(tj.ok);
  assert.equal(save.userTeamId, target);
  assert.equal(save.fired, null);
  assert.equal(F.teamById(save, oldId).roster, undefined, 'old team is AI again');
  assert.ok(Number.isFinite(F.teamById(save, oldId).off) && oldStrength);
  const r = F.roster(save);
  assert.ok(r.length >= 8 && r.some((p) => p.pos === 'QB'));
  assert.equal(save.coach.wins, coachBefore.wins);
  assert.equal(save.coach.firings, 1);
  assert.deepEqual(save.coach.teams, [...coachBefore.teams, target]);
  assert.equal(save.history.length, historyLen);
  assert.ok(F.capUsage(save).used <= save.salaryCap);
  assertRoundTrip(save);
  // Finish the offseason and a full season with the new team.
  while (save.offseason) {
    const step = F.currentOffseasonStep(save);
    if (step === 'draft') while (F.userOnClock(save)) F.passPick(save);
    assert.ok(F.runOffseasonStep(save, step).ok);
  }
  assert.equal(save.history.length, historyLen);
  playSeason(save, bot, stats);
  assert.equal(save.history[save.history.length - 1].teamId, target);
  deepFinite(save);
  assertRoundTrip(save);
});

test('determinism: same seed and decisions give identical saves', () => {
  const run = () => {
    const save = F.newFranchise({ coachName: 'Det', teamId: 'SEA', seed: 555 });
    const bot = new Rng(1);
    const stats = { cc: 0, games: 0, wins: 0, injuries: 0, levelUps: 0, news: 0, records: 0, pointsSpent: 0, upgrades: 0, signings: 0, extensions: 0, releases: 0, rushes: 0, boosts: 0, drafted: 0, retired: 0, firings: 0 };
    for (let i = 0; i < 2; i++) {
      playSeason(save, bot, stats);
      runOffseason(save, bot, stats);
    }
    return JSON.stringify(save);
  };
  assert.equal(run(), run());
});
