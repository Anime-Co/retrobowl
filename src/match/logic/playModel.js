// Statistical stand-in for the on-field engine: turns a PlaySetup into a plausible PlayResult
// without simulating players. Used by headless tests, AI soak runs and as an "auto-play"
// fallback (e.g. sim the rest of a game). It models a typical human offense; quality scales with
// `opts.skill`, squad ratings and the difficulty step. DOM-free, deterministic per rng.

import { Rng } from '../../core/rng.js';
import { clamp } from '../../core/util.js';
import { CFG, kickerMaxFg } from './config.js';

const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const GOAL_X = 110;

/**
 * @param {import('../../types.js').PlaySetup} setup
 * @param {{rng?:Rng, skill?:number, hurry?:boolean}} [opts]
 *   skill 0..1 (0.7 ≈ a typical human), hurry = sideline-minded (more out-of-bounds)
 * @returns {import('../../types.js').PlayResult}
 */
export function playModel(setup, opts = {}) {
  const rng = opts.rng || new Rng(setup.seed || 1);
  const pm = CFG.playModel;
  const offR = setup.offense?.offRating ?? 0.5;
  const defR = setup.defense?.defRating ?? 0.5;
  const q = (opts.skill ?? pm.defaultSkill) + pm.ratingK * (offR - defR) - pm.diffPerStep * ((setup.difficultyStep ?? 6) - 6);
  const e = clamp(q - 0.5, -0.45, 0.45);
  if (setup.kind === 'fg' || setup.kind === 'pat') return kickPlay(setup, rng, e);
  if (setup.kind === 'kick_return') return kickReturnPlay(setup, rng, e);
  if (setup.twoPoint) return twoPointPlay(setup, rng, e);
  return scrimmagePlay(setup, rng, e, !!opts.hurry);
}

function roster(setup) {
  const o = setup.offense?.offense || {};
  const wr = Array.isArray(o.WR) ? o.WR : [];
  return { qb: o.QB?.id ?? null, rb: o.RB?.id ?? null, wr1: wr[0]?.id ?? null, wr2: wr[1]?.id ?? null, te: o.TE?.id ?? null, k: o.K?.id ?? null };
}

function base(setup, fields) {
  return {
    outcome: 'tackle',
    endX: setup.losX,
    endY: setup.hashY ?? 26.67,
    yards: 0,
    elapsed: 4,
    clockStops: false,
    turnover: false,
    type: 'run',
    passer: null,
    receiver: null,
    rusher: null,
    kicker: null,
    stats: {},
    highlights: [],
    hits: [],
    ...fields,
  };
}

function add(stats, id, k, v) {
  if (!id) return;
  const s = (stats[id] ||= {});
  s[k] = (s[k] || 0) + v;
}

function scrimmagePlay(setup, rng, e, hurry) {
  const pm = CFG.playModel;
  const ids = roster(setup);
  const losX = setup.losX;
  const toGoal = GOAL_X - losX;
  const wet = setup.weather === 'rain' || setup.weather === 'snow';
  const stats = {};
  const endYFor = (oob) => (oob ? (rng.chance(0.5) ? 0.5 : 52.8) : rng.float(10, 43));
  const oobP = hurry ? pm.oobHurry : pm.oob;
  const breakaway = clamp(pm.breakaway + pm.breakawayK * e, 0.01, 0.12);

  if (rng.chance(pm.passShare)) {
    // ---- pass ----
    const sackP = clamp(pm.sack + pm.sackK * e, 0.02, 0.15);
    const intP = clamp(pm.interception + pm.interceptionK * e, 0.005, 0.08);
    const cmpP = clamp(pm.completion + pm.completionK * e - (wet ? 0.03 : 0), 0.35, 0.85);
    if (rng.chance(sackP)) {
      const loss = rng.int(3, 10);
      const endX = losX - loss;
      add(stats, ids.qb, 'sacked', 1);
      if (endX <= 10) {
        return base(setup, { outcome: 'safety', endX: Math.max(8, endX), yards: -loss, elapsed: rng.float(2.5, 4), clockStops: true, type: 'pass', passer: ids.qb, stats, highlights: ['SAFETY'] });
      }
      return base(setup, { outcome: 'sack', endX, endY: rng.float(18, 35), yards: -loss, elapsed: rng.float(2.5, 4.2), clockStops: false, type: 'pass', passer: ids.qb, stats, highlights: [`SACK -${loss}`] });
    }
    const depthRoll = rng.next();
    const depth = depthRoll < pm.shortShare ? rng.int(3, 9) : depthRoll < pm.shortShare + pm.mediumShare ? rng.int(10, 19) : rng.int(20, 45);
    const target = rng.weighted([ids.wr1, ids.wr2, ids.te, ids.rb], [0.36, 0.28, 0.18, 0.18]);
    add(stats, ids.qb, 'passAtt', 1);
    if (rng.chance(intP)) {
      add(stats, ids.qb, 'int', 1);
      let tx = Math.min(losX + depth, 115);
      if (tx < GOAL_X) tx = Math.max(1, tx - Math.max(0, rng.normal(8, 9)));
      if (rng.chance(0.03)) tx = 5; // pick-six
      return base(setup, { outcome: 'interception', endX: tx, turnoverX: tx, yards: 0, elapsed: rng.float(3, 6), clockStops: true, turnover: true, type: 'pass', passer: ids.qb, receiver: target, stats, highlights: ['INTERCEPTED'] });
    }
    if (!rng.chance(cmpP)) {
      return base(setup, { outcome: 'incomplete', endX: losX, yards: 0, elapsed: rng.float(2.5, 4.5), clockStops: true, type: 'pass', passer: ids.qb, receiver: target, stats, highlights: ['Incomplete'] });
    }
    let yac = -Math.log(1 - rng.next()) * Math.max(0.5, pm.yacMean + pm.yacK * e);
    if (rng.chance(breakaway)) yac += rng.chance(0.5) ? 100 : rng.float(15, 40);
    let yards = Math.round(depth + yac);
    const td = yards >= toGoal;
    if (td) yards = toGoal;
    add(stats, ids.qb, 'passCmp', 1);
    add(stats, ids.qb, 'passYds', yards);
    add(stats, target, 'rec', 1);
    add(stats, target, 'recYds', yards);
    if (td) {
      add(stats, ids.qb, 'passTd', 1);
      add(stats, target, 'recTd', 1);
      return base(setup, { outcome: 'td', endX: GOAL_X, endY: rng.float(15, 38), yards, elapsed: clamp(2 + yards / 7, 2.5, 12), clockStops: true, type: 'pass', passer: ids.qb, receiver: target, stats, highlights: [`TOUCHDOWN! ${yards}-yd pass`] });
    }
    if (rng.chance(pm.fumble * (wet ? 1.6 : 1))) {
      const lost = rng.chance(0.65);
      return base(setup, { outcome: 'fumble', endX: losX + yards, turnoverX: losX + yards, yards, elapsed: clamp(2.5 + depth / 10 + yac * 0.12, 3, 10), clockStops: lost, turnover: lost, type: 'pass', passer: ids.qb, receiver: target, stats, highlights: ['FUMBLE'] });
    }
    const oob = rng.chance(oobP);
    return base(setup, { outcome: oob ? 'oob' : 'tackle', endX: losX + yards, endY: endYFor(oob), yards, elapsed: clamp(2.5 + depth / 10 + yac * 0.12, 3, 10), clockStops: oob, type: 'pass', passer: ids.qb, receiver: target, stats, highlights: [`+${yards}`] });
  }

  // ---- run ----
  const runner = rng.chance(0.12) ? ids.qb : ids.rb;
  let yards = Math.round(rng.normal(pm.runMean + pm.runMeanK * e - (setup.weather === 'snow' ? 0.6 : 0), pm.runSd));
  if (rng.chance(breakaway)) yards += rng.chance(0.4) ? 100 : rng.int(12, 40);
  yards = Math.max(-6, yards);
  add(stats, runner, 'rushAtt', 1);
  if (yards >= toGoal) {
    yards = toGoal;
    add(stats, runner, 'rushYds', yards);
    add(stats, runner, 'rushTd', 1);
    return base(setup, { outcome: 'td', endX: GOAL_X, yards, elapsed: clamp(2 + yards / 7, 2.5, 12), clockStops: true, type: 'run', rusher: runner, stats, highlights: [`TOUCHDOWN! ${yards}-yd run`] });
  }
  add(stats, runner, 'rushYds', yards);
  const endX = losX + yards;
  if (endX <= 10) {
    return base(setup, { outcome: 'safety', endX: Math.max(8, endX), yards, elapsed: rng.float(3, 5), clockStops: true, type: 'run', rusher: runner, stats, highlights: ['SAFETY'] });
  }
  if (rng.chance(pm.fumble * (wet ? 1.6 : 1) * (runner === ids.qb ? 1.5 : 1))) {
    const lost = rng.chance(0.65);
    return base(setup, { outcome: 'fumble', endX, turnoverX: endX, yards, elapsed: rng.float(3, 6), clockStops: lost, turnover: lost, type: 'run', rusher: runner, stats, highlights: ['FUMBLE'] });
  }
  const oob = yards > 2 && rng.chance(oobP * 0.7);
  return base(setup, { outcome: oob ? 'oob' : 'tackle', endX, endY: endYFor(oob), yards, elapsed: clamp(3 + Math.abs(yards) * 0.12 + rng.float(0, 1.5), 2.5, 12), clockStops: oob, type: 'run', rusher: runner, stats, highlights: [yards >= 0 ? `+${yards}` : `${yards}`] });
}

function twoPointPlay(setup, rng, e) {
  const pm = CFG.playModel;
  const ids = roster(setup);
  const ok = rng.chance(clamp(pm.twoPoint + pm.twoPointK * e, 0.2, 0.85));
  const pass = rng.chance(0.6);
  const yards = GOAL_X - setup.losX;
  return base(setup, {
    outcome: ok ? 'td' : pass ? 'incomplete' : 'tackle',
    endX: ok ? GOAL_X : pass ? setup.losX : setup.losX + rng.int(0, 1),
    yards: ok ? yards : 0,
    elapsed: rng.float(2.5, 4.5),
    clockStops: true,
    type: pass ? 'pass' : 'run',
    passer: pass ? ids.qb : null,
    rusher: pass ? null : ids.rb,
    highlights: [ok ? '2-PT GOOD' : '2-PT FAILS'],
  });
}

function kickPlay(setup, rng, e) {
  const ids = roster(setup);
  const K = setup.offense?.offense?.K;
  const power = clamp(K?.kickPower ?? 0.35, 0, 1);
  const acc = clamp(K?.kickAccuracy ?? 0.35, 0, 1);
  const dist = GOAL_X - setup.losX + CFG.kicking.fgSnapOffset;
  const max = kickerMaxFg(1 + 9 * power) + 0.25 * (setup.wind?.x ?? 0) - 0.08 * Math.abs(setup.wind?.y ?? 0);
  const pat = setup.kind === 'pat';
  const stats = {};
  add(stats, ids.k, pat ? 'patAtt' : 'fgAtt', 1);
  let outcome;
  if (rng.chance(0.012)) outcome = 'kick_blocked';
  else {
    const p = dist > max ? 0.03 : 0.98 * sigmoid((max - dist + 3) / 4.5) * (0.9 + 0.1 * acc) * clamp(0.95 + 0.1 * e, 0.85, 1);
    outcome = rng.chance(p) ? (pat ? 'pat_good' : 'fg_good') : pat ? 'pat_miss' : 'fg_miss';
  }
  if (outcome === 'fg_good' || outcome === 'pat_good') add(stats, ids.k, pat ? 'patMade' : 'fgMade', 1);
  if (outcome === 'fg_good' && ids.k) stats[ids.k].fgLong = dist;
  return base(setup, {
    outcome,
    endX: setup.losX,
    yards: 0,
    elapsed: rng.float(2.2, 3.4),
    clockStops: true,
    type: 'kick',
    kicker: ids.k,
    stats,
    highlights: [`${dist}-yd ${pat ? 'PAT' : 'FG'}: ${outcome.replace('_', ' ')}`],
  });
}

function kickReturnPlay(setup, rng, e) {
  const pm = CFG.playModel;
  const ids = roster(setup);
  const returner = rng.pick([ids.wr1, ids.rb, ids.wr2]);
  const stats = {};
  if (rng.chance(pm.kickReturnTouchback)) {
    return base(setup, { outcome: 'touchback', endX: 10 + CFG.field.kickReturnTouchback, endY: 26.67, yards: 0, elapsed: 0.5, clockStops: true, type: 'return', rusher: returner, stats, highlights: ['Touchback'] });
  }
  if (rng.chance(pm.kickReturnTd * (1 + 2 * e))) {
    add(stats, returner, 'retYds', 100);
    add(stats, returner, 'retTd', 1);
    return base(setup, { outcome: 'return_td', endX: GOAL_X, yards: 100, elapsed: rng.float(10, 13), clockStops: true, type: 'return', rusher: returner, stats, highlights: ['KICK RETURN TD!'] });
  }
  const endX = 10 + clamp(Math.round(rng.normal(pm.kickReturnMean + 8 * e, pm.kickReturnSd)), 6, 60);
  add(stats, returner, 'retYds', endX - 10);
  if (rng.chance(pm.kickReturnFumble)) {
    return base(setup, { outcome: 'fumble', endX, turnoverX: endX, yards: endX - 10, elapsed: rng.float(5, 8), clockStops: true, turnover: true, type: 'return', rusher: returner, stats, highlights: ['FUMBLE on the return'] });
  }
  const oob = rng.chance(0.15);
  return base(setup, { outcome: oob ? 'oob' : 'tackle', endX, endY: oob ? 0.5 : rng.float(10, 43), yards: endX - 10, elapsed: rng.float(5, 9), clockStops: true, type: 'return', rusher: returner, stats, highlights: [`Return to the ${endX - 10}`] });
}
