// Headless soak: 3,000 full matches driven exactly like the UI would (playModel for user snaps),
// across quarter lengths, difficulties and playoff/regular season. Checks the match invariants
// and prints calibration numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../../src/match/logic/Match.js';
import { autoStep } from '../../src/match/logic/autoplay.js';
import { timeoutsPerHalf } from '../../src/match/logic/config.js';
import { Rng } from '../../src/core/rng.js';

const QUARTERS = [1, 2, 3];
const STEPS = [2, 6, 10, 16]; // easy, medium, hard, extreme
const DIFF_NAME = { 2: 'easy', 6: 'medium', 10: 'hard', 16: 'extreme' };
const PER_CELL = 125; // 3 × 4 × 2 × 125 = 3,000 matches

function playChecked(m, botSeed, calib) {
  const allowance = timeoutsPerHalf(m.settings.quarterMinutes);
  let lastQ = m.state.quarter;
  let lastClock = m.state.clock;
  let otStarts = 0;
  const checkClock = () => {
    const st = m.state;
    assert.ok(st.clock >= 0, `clock negative ${st.clock}`);
    assert.ok(Number.isFinite(st.clock));
    assert.ok(st.quarter >= lastQ, 'quarter went backwards');
    if (st.quarter === lastQ) assert.ok(st.clock <= lastClock + 1e-9, `clock went up within Q${st.quarter}: ${lastClock} → ${st.clock}`);
    lastQ = st.quarter;
    lastClock = st.clock;
    assert.ok(st.timeouts.user >= 0 && st.timeouts.user <= allowance, `timeouts ${st.timeouts.user}`);
  };
  const opts = { rng: new Rng(botSeed), onTick: checkClock };
  for (let i = 0; i < 20000; i++) {
    const s = autoStep(m, opts);
    checkClock();
    if (s.type === 'ot_start') {
      otStarts++;
      assert.equal(m.state.score.user, m.state.score.opp, 'OT only when tied');
      if (m.settings.easyOtFirst) assert.equal(s.userReceives, true);
    }
    if (s.type === 'opp_drive') {
      calib.drives.push({ outcome: s.outcome, timeUsed: s.timeUsed, qm: m.settings.quarterMinutes, step: m.settings.difficultyStep, start: s.startYard });
      assert.ok(s.beats.length >= 3 && s.beats.length <= 6);
    }
    if (s.type === 'final') return { result: s.result, otStarts };
  }
  throw new Error('match did not reach final');
}

function checkResult(m, result, otStarts) {
  const st = m.state;
  // scores equal the sum of logged scoring events
  for (const team of ['user', 'opp']) {
    const logged = result.log.filter((e) => e.team === team && e.points).reduce((a, e) => a + e.points, 0);
    assert.equal(logged, st.score[team], `${team} score vs log`);
    assert.equal(result.summary.byQuarter[team].reduce((a, b) => a + b, 0), st.score[team]);
  }
  assert.equal(result.userScore, st.score.user);
  assert.equal(result.oppScore, st.score.opp);
  assert.equal(result.userScore >= 0 && result.oppScore >= 0, true);
  // timeouts never exceed the allowance per half / OT period
  const allowance = timeoutsPerHalf(m.settings.quarterMinutes);
  for (const used of m._timeoutsUsed.slice(0, 2)) assert.ok(used <= allowance);
  // possession alternates after scores / turnovers; exceptions: new half / OT kickoffs, onside recovery
  const drives = m.drives;
  assert.ok(drives.length >= 2);
  for (let i = 0; i < drives.length; i++) {
    const d = drives[i];
    assert.ok(d.result, 'every drive is closed');
    if (i === 0) {
      assert.equal(d.how, 'opening');
      continue;
    }
    const p = drives[i - 1];
    if (d.how === 'half' || d.how === 'ot') continue;
    if (d.how === 'onside') {
      assert.equal(d.team, 'user');
      assert.equal(p.team, 'user');
      assert.ok(p.result === 'td' || p.result === 'fg');
      continue;
    }
    assert.notEqual(d.team, p.team, `drive ${i} (${d.how}) follows ${p.team} ${p.result}`);
  }
  // overtime rules
  assert.equal(result.ot, otStarts > 0);
  if (!result.ot) assert.notEqual(result.userScore, result.oppScore, 'regulation cannot end tied');
  if (m.playoff) assert.equal(result.tie, false, 'playoff games never tie');
  if (result.ot) {
    const otDrives = drives.filter((d) => d.quarter >= 5);
    if (m.settings.easyOtFirst) assert.equal(otDrives[0].team, 'user', 'easy: user gets the first OT possession');
    if (result.tie) {
      assert.equal(m.playoff, false);
      assert.equal(result.summary.otPeriods, 1, 'regular season: one OT period');
      assert.equal(st.clock, 0);
    } else if (st.clock > 0) {
      // ended early: both teams completed a possession in OT
      assert.ok(otDrives.some((d) => d.team === 'user') && otDrives.some((d) => d.team === 'opp'), 'both teams possess in OT');
    }
  }
}

test('soak: 3,000 headless matches keep every match invariant (and print calibration)', () => {
  const calib = { drives: [], games: {} };
  let n = 0;
  const seedRng = new Rng(20261009);
  for (const qm of QUARTERS) {
    for (const step of STEPS) {
      for (const playoff of [false, true]) {
        const key = `${qm}:${step}`;
        const g = (calib.games[key] ||= { n: 0, user: 0, opp: 0, possU: 0, possO: 0, ot: 0, ties: 0, userWins: 0 });
        for (let i = 0; i < PER_CELL; i++) {
          const m = new Match({
            seed: seedRng.int(1, 2 ** 31 - 1),
            gameId: `soak-${n}`,
            playoff,
            settings: { quarterMinutes: qm, difficultyStep: step, wind: seedRng.pick(['off', 'low', 'normal', 'high']), easyOtFirst: step <= 2 },
            userDefenders: [
              { id: 'dl', name: 'D. LINE', pos: 'DL' },
              { id: 'db', name: 'D. BACK', pos: 'DB' },
            ],
            audibles: seedRng.int(1, 5),
          });
          const { result, otStarts } = playChecked(m, seedRng.int(1, 2 ** 31 - 1), calib);
          checkResult(m, result, otStarts);
          g.n++;
          g.user += result.userScore;
          g.opp += result.oppScore;
          g.possU += result.summary.user.possessions;
          g.possO += result.summary.opp.possessions;
          g.ot += result.ot ? 1 : 0;
          g.ties += result.tie ? 1 : 0;
          g.userWins += result.userWon ? 1 : 0;
          n++;
        }
      }
    }
  }
  assert.equal(n, 3000);

  // ---- calibration printout ----
  const lines = ['', 'MATCH CALIBRATION (equal 2.75★ ratings, playModel skill 0.7 "typical human")'];
  lines.push('qtr diff     | user  opp   comb | poss u/o   | userWin% OT%  ties');
  for (const qm of QUARTERS) {
    for (const step of STEPS) {
      const g = calib.games[`${qm}:${step}`];
      const f = (v) => (v / g.n).toFixed(1).padStart(5);
      lines.push(
        `${qm}m  ${DIFF_NAME[step].padEnd(8)} |${f(g.user)}${f(g.opp)} ${f(g.user + g.opp)} | ${(g.possU / g.n).toFixed(2)}/${(g.possO / g.n).toFixed(2)} | ${((100 * g.userWins) / g.n).toFixed(0).padStart(5)}  ${((100 * g.ot) / g.n).toFixed(1).padStart(4)}  ${g.ties}`,
      );
    }
  }
  lines.push('', 'Opponent drive outcomes in-match (2-min quarters):');
  for (const step of STEPS) {
    const ds = calib.drives.filter((d) => d.qm === 2 && d.step === step);
    const cnt = {};
    for (const d of ds) cnt[d.outcome] = (cnt[d.outcome] || 0) + 1;
    const order = ['td', 'fg', 'fg_miss', 'punt', 'int', 'fumble', 'downs', 'end_half'];
    lines.push(`  ${DIFF_NAME[step].padEnd(8)} ` + order.map((k) => `${k} ${((100 * (cnt[k] || 0)) / ds.length).toFixed(1)}%`).join('  '));
  }
  lines.push('', 'Avg runoff per sim drive (all difficulties):');
  for (const qm of QUARTERS) {
    const ds = calib.drives.filter((d) => d.qm === qm);
    const avg = ds.reduce((a, d) => a + d.timeUsed, 0) / ds.length;
    const td = ds.filter((d) => d.outcome === 'td' && d.start <= 30);
    const avgTd = td.reduce((a, d) => a + d.timeUsed, 0) / td.length;
    lines.push(`  ${qm}-min quarters: ${avg.toFixed(1)} s avg, ${avgTd.toFixed(1)} s for long TD drives (start ≤ own 30)`);
  }
  console.log(lines.join('\n'));
  const easy2 = calib.games['2:2'];
  const poss = easy2.possU / easy2.n;
  assert.ok(poss >= 4 && poss <= 8.5, `user possessions at 2-min ${poss}`);
});
