// Balance regression checks (small, fast versions of tools/balance.mjs). Loose bounds: these catch
// a tuning regression (e.g. sim drives scoring on 80% of possessions again, a new team rating
// 1★ on defense, Hard being easier than Easy), not small drift. Full numbers: `npm run balance`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../../src/franchise/index.js';
import { Rng } from '../../src/core/rng.js';
import { simDrive } from '../../src/match/logic/simDrive.js';
import { createPlayer } from '../../src/franchise/players.js';
import {
  SKILL, driveTable, aiTable, ratingTable, ratedMatchTask, summarizeMatches, runCareer,
} from '../../tools/balance.mjs';

const pct = (v) => `${(100 * v).toFixed(0)}%`;

test('balance: simulated opponent drives (Medium ~45% scoring, difficulty and ratings ordered)', () => {
  const { rows } = driveTable({
    n: 3000,
    cells: [
      { d: 0, step: 6, start: 25 }, { d: 0, step: 2, start: 25 }, { d: 0, step: 10, start: 25 }, { d: 0, step: 16, start: 25 },
      { d: -2, step: 6, start: 25 }, { d: 2, step: 6, start: 25 }, { d: 0, step: 6, start: 60 },
    ],
  });
  const at = (d, step, start = 25) => rows.find((r) => r.d === d && r.step === step && r.start === start);
  const med = at(0, 6);
  console.log(`[balance] sim drive @ equal ratings, Medium, own 25: score ${pct(med.score)} (TD ${pct(med.td)}, FG ${pct(med.fg)}), TO ${pct(med.to)}`);
  assert.ok(med.score > 0.33 && med.score < 0.55, `Medium p(score) ${med.score}`);
  assert.ok(med.td > med.fg * 1.8, 'TDs outnumber FGs');
  // below Medium the sim bias is 0 (Easy weakens the opponent through its rating offset instead)
  assert.ok(Math.abs(at(0, 2).score - med.score) < 0.04, 'no extra sim bias below Medium');
  assert.ok(med.score < at(0, 10).score && at(0, 10).score < at(0, 16).score, 'difficulty bias grows above Medium');
  assert.ok(at(-2, 6).score < med.score - 0.12 && at(2, 6).score > med.score + 0.12, 'a 2★ gap matters');
  assert.ok(at(0, 6, 60).score > med.score + 0.1, 'short field scores more');
});

test('balance: new team ratings are weak but not hopeless, and stars move them', () => {
  const { row } = ratingTable({ seeds: 8 });
  console.log(`[balance] new team OFF ${row.off.toFixed(2)} DEF ${row.def.toFixed(2)} (AI avg ${row.aiOff.toFixed(2)}/${row.aiDef.toFixed(2)}); `
    + `+3★ DB DEF +${row.deltas.DB3.def.toFixed(2)}, +4★ DB +${row.deltas.DB4.def.toFixed(2)}, +3★ DL +${row.deltas.DL3.def.toFixed(2)}; `
    + `12 stars @4 → ${row.built['12 stars @4'].off.toFixed(2)}/${row.built['12 stars @4'].def.toFixed(2)}`);
  assert.ok(row.def >= 1.4 && row.def <= 2.4, `new DEF ${row.def}`);
  assert.ok(row.off >= 1.8 && row.off <= 2.9, `new OFF ${row.off}`);
  assert.ok(row.def < row.aiDef - 0.5 && row.off < row.aiOff, 'a new team starts below the league average');
  for (const k of ['DL3', 'LB3', 'DB3']) assert.ok(row.deltas[k].def >= 0.15 && row.deltas[k].def <= 0.55, `${k} +${row.deltas[k].def}`);
  assert.ok(row.deltas.DB4.def > row.deltas.DB3.def && row.deltas.DB4.def <= 0.65);
  const four = row.built['12 stars @4'];
  assert.ok(four.off >= 3.6 && four.def >= 3.6, 'a roster of 4★ stars rates like a 4★ team');
});

test('balance: the team rating never drops when a better-than-filler star joins', () => {
  const save = F.newFranchise({ coachName: 'Mono', seed: 4242, teamId: 'SEA' });
  const rng = new Rng(9);
  const team = F.userTeam(save);
  for (let i = 0; i < 40; i++) {
    const pos = rng.pick(['QB', 'RB', 'WR', 'TE', 'OL', 'K', 'DL', 'LB', 'DB']);
    const p = createPlayer(save, rng, { pos, stars: rng.pick([1.5, 2, 2.5, 3, 4, 5]), age: 26 });
    const before = F.teamRatings(save);
    team.roster.push(p);
    const after = F.teamRatings(save);
    assert.ok(after.off >= before.off - 0.05 && after.def >= before.def - 0.05, `${pos} ${F.stars(p)}★: ${before.off}/${before.def} → ${after.off}/${after.def}`);
    if (team.roster.length > 14) team.roster.shift();
  }
});

test('balance: full real-engine matches (Medium 3v3 average bot; Easy vs Hard ordering)', () => {
  const run = (step, skill, n, base) => summarizeMatches(Array.from({ length: n }, (_, i) => ratedMatchTask({ i: base + i, seed: 77, step, skill, qm: 2 })));
  const med = run(6, SKILL.average, 14, 0);
  const easy = run(2, SKILL.casual, 6, 500);
  const hard = run(10, SKILL.average, 6, 900);
  console.log(`[balance] Medium avg bot (n=${med.n}): ${med.user.toFixed(1)}-${med.opp.toFixed(1)} (combined ${med.combined.toFixed(1)}), win ${pct(med.winPct)}, `
    + `possessions ${med.userPoss.toFixed(1)}/${med.oppPoss.toFixed(1)}, opp drives score ${pct(med.oppScore)} (TD ${pct(med.oppTd)}), user drives score ${pct(med.userScorePct)}`);
  console.log(`[balance] Easy casual: ${easy.user.toFixed(1)}-${easy.opp.toFixed(1)} win ${pct(easy.winPct)} | Hard avg: ${hard.user.toFixed(1)}-${hard.opp.toFixed(1)} win ${pct(hard.winPct)}`);
  assert.ok(med.oppScore > 0.28 && med.oppScore < 0.62, `Medium opp drive scoring ${med.oppScore}`);
  assert.ok(med.combined > 25 && med.combined < 65, `Medium combined ${med.combined}`);
  assert.ok(med.userPoss >= 6 && med.userPoss <= 11, `possessions ${med.userPoss}`);
  assert.ok(med.winPct > 0.15 && med.winPct < 0.9, `Medium win% ${med.winPct}`);
  assert.ok(easy.user - easy.opp > hard.user - hard.opp + 5, 'Easy (casual) is clearly easier than Hard (average)');
});

test('balance: AI-vs-AI league games look like football', () => {
  const { row } = aiTable({ seasons: 1, seed: 21 });
  console.log(`[balance] AI-vs-AI: combined ${row.combined.toFixed(1)} (p10 ${row.p10}, p90 ${row.p90}), margin ${row.margin.toFixed(1)}, home ${pct(row.homeWin)}, wins SD ${row.winsSd.toFixed(2)}`);
  assert.ok(row.combined > 34 && row.combined < 56, `combined ${row.combined}`);
  assert.ok(row.homeWin > 0.45 && row.homeWin < 0.66);
  assert.ok(row.winsSd > 1.8 && row.winsSd < 4.2, `standings spread ${row.winsSd}`);
});

test('balance: a new Dynamic career with the real engine can compete in season 1', () => {
  const c = runCareer({ seed: 5, skill: SKILL.average, seasons: 1 });
  const s = c.seasons[0];
  console.log(`[balance] season 1 (average bot, Dynamic): ${s.w}-${s.l}${s.t ? `-${s.t}` : ''}, PF/PA ${s.pf.toFixed(1)}/${s.pa.toFixed(1)}, `
    + `step avg ${s.stepAvg.toFixed(1)}, OFF/DEF ${s.off0}/${s.def0} → ${s.off1}/${s.def1}, CC earned ${s.ccEarned}, purchases ${c.purchases.filter((p) => p.season === 1).length}`);
  assert.ok(s.w >= 2 && s.w <= 14, `season-1 wins ${s.w}`);
  assert.ok(s.pa < 34, `points allowed ${s.pa}`);
  assert.ok(s.def1 >= s.def0, 'management improves the defense');
});

test('balance: sim drive defensive stats and points stay sane at extreme rating gaps', () => {
  const rng = new Rng(5);
  for (const [off, def] of [[0.5, 5], [5, 0.5]]) {
    let pts = 0;
    for (let i = 0; i < 500; i++) pts += simDrive({ offStars: off, defStars: def, startYard: 25, clockLeft: 300, rng, difficultyStep: 6 }).points;
    const ppd = pts / 500;
    assert.ok(ppd >= 0 && ppd <= 7, `pts/drive ${ppd}`);
    if (off > def) assert.ok(ppd > 3.5, `5★ vs 0.5★ offense ${ppd}`);
    else assert.ok(ppd < 1.5, `0.5★ vs 5★ offense ${ppd}`);
  }
});
