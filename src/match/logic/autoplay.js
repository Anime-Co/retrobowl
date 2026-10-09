// Headless driver: plays a Match exactly the way the MatchScreen would (pre-snap clock runoff,
// timeouts, onSnap → tickClock through the play → submitPlay), using playModel for the user's
// snaps and a simple coaching AI for decisions. Used by soak tests and as a "sim to end" helper.
// Bot randomness uses its own Rng so the match rng only sees the same calls the UI would make.

import { Rng } from '../../core/rng.js';
import { playModel } from './playModel.js';
import { simScale } from './config.js';

/**
 * @typedef {Object} AutoOptions
 * @property {Rng} [rng]              bot rng (default: seeded from opts.seed or 1)
 * @property {number} [seed]
 * @property {number} [skill]         playModel skill (0.7 ≈ typical human)
 * @property {[number,number]} [presnap]  normal pre-snap seconds range when the clock runs
 * @property {number} [tickDt=0.25]   clock tick granularity
 * @property {(m:import('./Match.js').Match, dt:number)=>void} [onTick]  called after every tick
 */

/** Advance the match by handling exactly one step. Returns the step that was handled. */
export function autoStep(m, opts = {}) {
  const rng = opts.rng || (opts.rng = new Rng(opts.seed ?? 1));
  const step = m.next();
  switch (step.type) {
    case 'final':
      return step;
    case 'coin':
    case 'opp_drive':
    case 'auto':
    case 'quarter_end':
    case 'halftime':
    case 'ot_start':
      m.ack();
      return step;
    case 'decision':
      m.choose(decide(m, step, rng));
      return step;
    case 'play':
      runPlay(m, step, rng, opts);
      return step;
    case 'kick':
    case 'kick_return':
      snapAndPlay(m, step, rng, opts, false);
      return step;
    default:
      throw new Error(`autoStep: unknown step ${step.type}`);
  }
}

/** Play a whole match headless. Returns the MatchResult. */
export function autoPlayMatch(m, opts = {}) {
  const max = opts.maxSteps ?? 20000;
  for (let i = 0; i < max; i++) {
    const s = autoStep(m, opts);
    if (s.type === 'final') return s.result;
  }
  throw new Error('autoPlayMatch: match did not finish');
}

/** Tick the clock in small chunks while it runs. Returns true if the pending step was withdrawn. */
export function runClock(m, seconds, opts = {}) {
  const dtMax = opts.tickDt ?? 0.25;
  let left = seconds;
  while (left > 1e-9 && m.state.clockRunning) {
    const dt = Math.min(dtMax, left);
    left -= dt;
    const withdrawn = m.tickClock(dt);
    if (opts.onTick) opts.onTick(m, dt);
    if (withdrawn) return true;
  }
  return false;
}

function situation(m) {
  const st = m.state;
  const scale = simScale(st.quarterMinutes);
  const diff = st.score.user - st.score.opp;
  const lateGame = st.quarter >= 4 && st.clock < 120 * scale;
  const trailingLate = lateGame && diff <= 0;
  const endOfHalf = st.quarter === 2 && st.clock < 40 * scale;
  const leadingLate = st.quarter === 4 && diff > 0 && st.clock < 150 * scale;
  return { st, scale, diff, hurry: trailingLate || endOfHalf, leadingLate, trailingLate };
}

function runPlay(m, step, rng, opts) {
  const { st, scale, diff, hurry, leadingLate } = situation(m);
  if (!step.twoPoint && step.canFieldGoal && st.clock <= 8 && (diff >= -3 || st.quarter === 2) && m.choose('fg')) return;
  if (hurry && st.clockRunning && st.clock < 45 * scale && m.canCallTimeout()) m.callTimeout();
  if (st.clockRunning) {
    const [lo, hi] = opts.presnap || [2.5, 7];
    const pre = hurry ? rng.float(0.8, 2.5) : leadingLate ? rng.float(6, 16) : rng.float(lo, hi);
    if (runClock(m, pre, opts)) return; // clock expired before the snap
  }
  if (rng.chance(0.04)) m.useAudible();
  snapAndPlay(m, step, rng, opts, hurry);
}

function snapAndPlay(m, step, rng, opts, hurry) {
  m.onSnap();
  const res = playModel(step.setup, { rng, skill: opts.skill, hurry });
  runClock(m, res.elapsed, opts);
  m.submitPlay(res);
}

function decide(m, step, rng) {
  const { st, scale, diff } = situation(m);
  const ids = step.options.map((o) => o.id);
  if (step.kind === 'fourth') {
    const lateTrail = st.quarter >= 4 && diff < 0 && st.clock < 150 * scale;
    if (ids.includes('fg') && !(lateTrail && diff < -3)) return 'fg';
    if (lateTrail) return 'go';
    if (st.toGo <= 1.5 && st.ballOn >= 40 && rng.chance(0.6)) return 'go';
    if (ids.includes('punt')) return 'punt';
    return 'go';
  }
  if (step.kind === 'conversion') {
    if (st.quarter >= 4 && [-2, -5, -10, 1, 5].includes(diff)) return 'two';
    return rng.chance(0.08) ? 'two' : 'pat';
  }
  if (step.kind === 'onside') return st.clock < 75 * scale || rng.chance(0.3) ? 'onside' : 'kickoff';
  return step.options[0].id;
}
