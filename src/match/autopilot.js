// Autoplay coaching brain for the match screen (QA: `app.go('match', {gameId, autoplay:true})`).
// Mirrors the headless driver in src/match/logic/autoplay.js: sensible 4th-down / conversion /
// onside calls, end-of-half field goals, hurry-up timeouts and the odd audible. Uses its own Rng
// so it never touches the match's random stream.

import { Rng } from '../core/rng.js';
import { simScale } from './logic/config.js';

function situation(m) {
  const st = m.state;
  const scale = simScale(st.quarterMinutes);
  const diff = st.score.user - st.score.opp;
  const lateGame = st.quarter >= 4 && st.clock < 120 * scale;
  const trailingLate = lateGame && diff <= 0;
  const endOfHalf = st.quarter === 2 && st.clock < 40 * scale;
  return { st, scale, diff, hurry: trailingLate || endOfHalf };
}

export class Autopilot {
  constructor(seed = 1) {
    this.rng = new Rng((seed >>> 0) || 1);
  }

  /** Option id for a decision step. */
  decide(m, step) {
    const { st, scale, diff } = situation(m);
    const ids = step.options.map((o) => o.id);
    const rng = this.rng;
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
      return rng.chance(0.1) ? 'two' : 'pat';
    }
    if (step.kind === 'onside') return st.clock < 75 * scale || rng.chance(0.3) ? 'onside' : 'kickoff';
    return step.options[0].id;
  }

  /** Called once per play step before the snap: {timeout?, audible?}. */
  presnap(m, step) {
    const { st, scale, hurry } = situation(m);
    return {
      timeout: !!(hurry && st.clockRunning && st.clock < 45 * scale),
      audible: !step.twoPoint && this.rng.chance(0.06),
    };
  }

  /** Polled every pre-snap frame while the FG button is available. */
  wantsFieldGoal(m) {
    const { st, diff } = situation(m);
    return st.clock <= 8 && (diff >= -3 || st.quarter === 2 || st.quarter >= 5);
  }
}
