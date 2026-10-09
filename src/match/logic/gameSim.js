// AI-vs-AI full game simulation (used by franchise for the rest of the league each week).
// Alternates simDrive() possessions on a 4-quarter clock with halftime, kickoffs and the same OT
// rules as Match (both teams possess, then sudden death; regular-season ties after one OT period,
// playoff OT repeats). No difficulty bias. DOM-free, deterministic per seed/rng.

import { Rng } from '../../core/rng.js';
import { clamp } from '../../core/util.js';
import { CFG } from './config.js';
import { simDrive } from './simDrive.js';

/**
 * @typedef {Object} SimTeam
 * @property {number} off            offense stars 0.5–5
 * @property {number} def            defense stars 0.5–5
 * @property {string} [abbr]
 * @property {number} [kickerRating] 0..1
 */

/**
 * Simulate a whole AI-vs-AI game.
 * @param {Object} o
 * @param {SimTeam} o.home
 * @param {SimTeam} o.away
 * @param {Rng} [o.rng]
 * @param {number} [o.seed]
 * @param {boolean} [o.playoff=false]
 * @param {boolean} [o.neutralSite=false]   no home edge (the Final)
 * @param {number} [o.quarterMinutes=2]
 * @returns {{homeScore:number, awayScore:number, ot:boolean, tie:boolean,
 *            scoring:{quarter:number, team:'home'|'away', points:number, kind:string}[], drives:number}}
 */
export function simulateGame(o) {
  const rng = o.rng || new Rng(o.seed ?? 1);
  const qm = o.quarterMinutes ?? CFG.gameSim.quarterMinutes;
  const qlen = qm * 60;
  const edge = o.neutralSite ? 0 : CFG.gameSim.homeEdgeStars;
  const teams = {
    home: { off: (o.home.off ?? 2.75) + edge, def: (o.home.def ?? 2.75) + edge, abbr: o.home.abbr || 'HOME', kr: o.home.kickerRating ?? 0.5 },
    away: { off: o.away.off ?? 2.75, def: o.away.def ?? 2.75, abbr: o.away.abbr || 'AWAY', kr: o.away.kickerRating ?? 0.5 },
  };
  const other = (t) => (t === 'home' ? 'away' : 'home');
  const score = { home: 0, away: 0 };
  const scoring = [];
  let drives = 0;
  const kickoffStart = () => (rng.chance(0.55) ? CFG.field.kickoffTouchback : Math.round(clamp(rng.normal(CFG.kickoff.returnMean, CFG.kickoff.returnSd), 8, 45)));

  // Plays one period of `periodLen` seconds (a half = 2 quarters, or one OT period).
  // Returns when the clock runs out or `stop()` says the game is decided.
  const playPeriod = (firstOff, periodLen, half, quarterBase, stop) => {
    let clock = periodLen;
    let poss = firstOff;
    let start = kickoffStart();
    while (clock > 0) {
      const off = teams[poss];
      const def = teams[other(poss)];
      const res = simDrive({
        offStars: off.off,
        defStars: def.def,
        startYard: start,
        clockLeft: clock,
        quarterMinutes: qm,
        half,
        scoreDiff: score[poss] - score[other(poss)],
        rng,
        oppAbbr: off.abbr,
        kickerRating: off.kr,
        neutral: true,
        skipConversionIfAhead: half === 3 && stop && stop.started[other(poss)] > 0,
      });
      drives += 1;
      if (stop) stop.started[poss] += 1;
      const quarter = quarterBase + Math.min(Math.floor((periodLen - clock) / qlen), periodLen / qlen - 1);
      clock -= res.timeUsed;
      if (res.points > 0) {
        score[poss] += res.points;
        scoring.push({ quarter, team: poss, points: res.points, kind: res.outcome });
        poss = other(poss);
        start = kickoffStart();
      } else if (res.outcome === 'end_half' || res.userBallOn == null) {
        break;
      } else {
        poss = other(poss);
        start = res.userBallOn;
      }
      if (stop && stop.started.home > 0 && stop.started.away > 0 && score.home !== score.away) return true;
    }
    return false;
  };

  const openingReceiver = rng.chance(0.5) ? 'home' : 'away';
  playPeriod(openingReceiver, 2 * qlen, 1, 1, null);
  playPeriod(other(openingReceiver), 2 * qlen, 2, 3, null);
  let ot = false;
  let period = 0;
  const otState = { started: { home: 0, away: 0 } };
  while (score.home === score.away) {
    if (period >= 1 && !o.playoff) break;
    ot = true;
    period += 1;
    playPeriod(rng.chance(0.5) ? 'home' : 'away', qlen, 3, 4 + period, otState);
  }
  return { homeScore: score.home, awayScore: score.away, ot, tie: score.home === score.away, scoring, drives };
}
