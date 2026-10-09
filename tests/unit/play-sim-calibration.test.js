// PLAY-SIM calibration: bot-driven batches vs the tuning targets in the PLAY-SIM brief. Prints a
// report (visible with `node --test`) and asserts loose bounds so tuning drift is caught.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrimmageBatch, kickBatch, returnBatch, pocketBatch } from '../../src/play/sim/calibrate.js';

const pc = (v) => `${(v * 100).toFixed(1)}%`;
const f = (v, d = 2) => v.toFixed(d);

test('calibration: average bot vs average defense (step 6)', () => {
  const a = scrimmageBatch({ n: 1600, seed: 1 });
  console.log(`[calibration] avg vs avg: passes ${a.att}, cmp ${pc(a.cmpPct)} (target 55-70), INT ${pc(a.intPct)} (2-5), `
    + `sack ${pc(a.sackPct)} of dropbacks (5-10), run avg ${f(a.ypc)} yd (3-5), pass-play avg ${f(a.passPlayAvg)} yd (6-9), `
    + `avg throw at ${f(a.avgThrowT)} s, TD ${a.td}, lost fumbles ${a.fumblesLost}`);
  assert.ok(a.cmpPct >= 0.52 && a.cmpPct <= 0.74, `completion ${a.cmpPct}`);
  assert.ok(a.intPct >= 0.012 && a.intPct <= 0.065, `INT ${a.intPct}`);
  assert.ok(a.sackPct >= 0.03 && a.sackPct <= 0.13, `sacks ${a.sackPct}`);
  assert.ok(a.ypc >= 2.8 && a.ypc <= 5.5, `run avg ${a.ypc}`);
  assert.ok(a.passPlayAvg >= 5.5 && a.passPlayAvg <= 10, `pass play avg ${a.passPlayAvg}`);
});

test('calibration: pocket time ~3-4 s with ~25% spread', () => {
  const p = pocketBatch({ n: 240 });
  console.log(`[calibration] pocket time (QB never throws): mean ${f(p.mean)} s, sd ${f(p.sd)}, p10 ${f(p.p10)}, p50 ${f(p.p50)}, p90 ${f(p.p90)}`);
  assert.ok(p.mean >= 2.8 && p.mean <= 4.4, `pocket mean ${p.mean}`);
  assert.ok(p.sd / p.mean >= 0.1 && p.sd / p.mean <= 0.4, `pocket spread ${p.sd}`);
});

test('calibration: field goals by distance for a mid kicker', () => {
  const b = kickBatch({ n: 120 });
  console.log(`[calibration] FG make % (mid kicker, bot timing noise, ~6 mph wind): ${b.map((x) => `${x.lo}-${x.hi}: ${pc(x.pct)}`).join(', ')}`);
  const at = (lo) => b.find((x) => x.lo === lo).pct;
  assert.ok(at(18) >= 0.88, `short FG ${at(18)}`);
  assert.ok(at(45) >= 0.42 && at(45) <= 0.82, `45-52 FG ${at(45)}`);
  assert.ok(at(60) <= 0.1, `60+ FG ${at(60)}`);
  assert.ok(at(18) >= at(35) && at(35) >= at(45) && at(45) >= at(53), 'make % falls with distance');
  const strong = kickBatch({ n: 60, rating: 0.95, buckets: [[60, 66]] })[0];
  console.log(`[calibration] FG 60-66 for a 0.95 kicker: ${pc(strong.pct)}`);
  assert.ok(strong.pct > 0 && strong.pct < 0.6, 'a big leg can make the occasional 60+');
});

test('calibration: kick returns start around the own 20-30', () => {
  const r = returnBatch({ n: 400 });
  console.log(`[calibration] kick return: avg start own ${f(r.avgStart, 1)} (20-30), TB ${pc(r.touchbacks)}, return TD ${pc(r.returnTds)}, turnovers ${pc(r.turnovers)}`);
  assert.ok(r.avgStart >= 17 && r.avgStart <= 33, `return start ${r.avgStart}`);
});

test('calibration: strong squads clearly beat weak squads; difficulty matters', () => {
  const sw = scrimmageBatch({ n: 400, seed: 3, offRating: 0.7, defRating: 0.3 });
  const ws = scrimmageBatch({ n: 400, seed: 3, offRating: 0.3, defRating: 0.7 });
  const mid1 = scrimmageBatch({ n: 400, seed: 3, offRating: 0.6, defRating: 0.4 });
  const mid2 = scrimmageBatch({ n: 400, seed: 3, offRating: 0.4, defRating: 0.6 });
  console.log(`[calibration] yards/play: strong O vs weak D ${f(sw.avgYards)} (cmp ${pc(sw.cmpPct)}), 0.6 vs 0.4 ${f(mid1.avgYards)}, `
    + `0.4 vs 0.6 ${f(mid2.avgYards)}, weak O vs strong D ${f(ws.avgYards)} (cmp ${pc(ws.cmpPct)}, sacks ${pc(ws.sackPct)})`);
  assert.ok(sw.avgYards > ws.avgYards + 6, 'strong offense out-gains weak offense');
  assert.ok(mid1.avgYards > mid2.avgYards + 2);
  assert.ok(sw.cmpPct > ws.cmpPct + 0.08, 'strong offense completes more passes');
  const easy = scrimmageBatch({ n: 400, seed: 4, step: 2 });
  const hard = scrimmageBatch({ n: 400, seed: 4, step: 16 });
  console.log(`[calibration] difficulty: step 2 ${f(easy.avgYards)} yd/play, step 16 ${f(hard.avgYards)} yd/play`);
  assert.ok(easy.avgYards > hard.avgYards + 1.5);
});
