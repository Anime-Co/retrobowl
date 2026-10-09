// Abstract whole-game simulation from OFF/DEF star ratings (AI vs AI, auto-played user games).
// Drive-based: each team gets ~11 possessions; each possession ends in a TD, FG, safety,
// defensive score or nothing with probabilities driven by OFF vs DEF stars. Produces realistic
// football scores (3/7 increments, 20-ish points per team on average). Playoffs never tie.

import { GAME_SIM, LEAGUE, DIFFICULTY } from './config.js';
import { clamp } from '../core/util.js';

/**
 * Opponent rating after the difficulty offset (MECHANICS §5.5). Step 16 = 5-star team.
 * @param {number} starsValue
 * @param {number} step 1..16
 */
export function difficultyRating(starsValue, step) {
  if (step >= DIFFICULTY.fiveStarStep) return 5;
  const d = step - DIFFICULTY.pivot;
  return clamp(starsValue + d * (d >= 0 ? DIFFICULTY.offsetPerStep : DIFFICULTY.offsetPerStepBelow), 0.5, 5);
}

function newTally() {
  return { pts: 0, td: 0, fg: 0, patAtt: 0, patMade: 0, twoAtt: 0, twoMade: 0, safety: 0, defTd: 0, turnovers: 0, punts: 0, drives: 0 };
}

function scoreTd(rng, tally) {
  tally.td += 1;
  tally.pts += 6;
  if (rng.chance(GAME_SIM.twoPtRate)) {
    tally.twoAtt += 1;
    if (rng.chance(GAME_SIM.twoPtGood)) { tally.twoMade += 1; tally.pts += 2; }
  } else {
    tally.patAtt += 1;
    if (rng.chance(GAME_SIM.patGood)) { tally.patMade += 1; tally.pts += 1; }
  }
}

/** One possession. d = attacking OFF - defending DEF (stars). Mutates both tallies. */
function drive(rng, d, att, def) {
  att.drives += 1;
  const pTd = clamp(GAME_SIM.tdBase + GAME_SIM.tdPerStar * d, GAME_SIM.tdMin, GAME_SIM.tdMax);
  const pFg = clamp(GAME_SIM.fgBase + GAME_SIM.fgPerStar * d, GAME_SIM.fgMin, GAME_SIM.fgMax);
  const r = rng.next();
  if (r < pTd) {
    scoreTd(rng, att);
    return 'td';
  }
  if (r < pTd + pFg) {
    att.fg += 1;
    att.pts += 3;
    return 'fg';
  }
  if (r < pTd + pFg + GAME_SIM.safety) {
    def.safety += 1;
    def.pts += 2;
    return 'safety';
  }
  if (r < pTd + pFg + GAME_SIM.safety + GAME_SIM.defTd) {
    att.turnovers += 1;
    def.defTd += 1;
    scoreTd(rng, def);
    return 'defTd';
  }
  if (rng.chance(GAME_SIM.turnover)) {
    att.turnovers += 1;
    return 'turnover';
  }
  att.punts += 1;
  return 'punt';
}

/**
 * Simulate a full game between two rated teams.
 * @param {{off:number, def:number}} home   Team (or any {off, def} in stars)
 * @param {{off:number, def:number}} away
 * @param {import('../core/rng.js').Rng} rng
 * @param {{difficultyStep?:number, userSide?:'home'|'away'|null, playoff?:boolean,
 *   neutral?:boolean, homeEdge?:number}} [opts]
 *   userSide: the side controlled by the user; the OTHER side gets the difficulty offset.
 * @returns {{homeScore:number, awayScore:number, ot:boolean, detail:{home:Object, away:Object}}}
 */
export function simulateGame(home, away, rng, opts = {}) {
  const step = opts.difficultyStep ?? DIFFICULTY.pivot;
  let hOff = home.off;
  let hDef = home.def;
  let aOff = away.off;
  let aDef = away.def;
  if (opts.userSide === 'home') {
    aOff = difficultyRating(aOff, step);
    aDef = difficultyRating(aDef, step);
  } else if (opts.userSide === 'away') {
    hOff = difficultyRating(hOff, step);
    hDef = difficultyRating(hDef, step);
  }
  const edge = opts.neutral ? 0 : (opts.homeEdge ?? LEAGUE.homeEdge);
  const dHome = hOff + edge / 2 - aDef;
  const dAway = aOff - (hDef + edge / 2);
  const H = newTally();
  const A = newTally();
  const n = clamp(Math.round(rng.normal(GAME_SIM.drives, GAME_SIM.drivesSd)), GAME_SIM.drivesMin, GAME_SIM.drivesMax);
  const homeFirst = rng.chance(0.5);
  for (let i = 0; i < n; i++) {
    if (homeFirst) { drive(rng, dHome, H, A); drive(rng, dAway, A, H); } else { drive(rng, dAway, A, H); drive(rng, dHome, H, A); }
  }
  // Half-time parity: the team that kicked first may get one extra possession.
  if (rng.chance(0.35)) {
    if (homeFirst) drive(rng, dAway, A, H); else drive(rng, dHome, H, A);
  }

  let ot = false;
  if (H.pts === A.pts) {
    ot = true;
    // Both teams get a possession, then sudden death (MECHANICS §5.4).
    const first = rng.chance(0.5) ? 'home' : 'away';
    const go = (side) => (side === 'home' ? drive(rng, dHome, H, A) : drive(rng, dAway, A, H));
    const other = first === 'home' ? 'away' : 'home';
    go(first);
    go(other);
    let side = first;
    let extra = 0;
    const limit = opts.playoff ? 200 : GAME_SIM.otExtraDrives;
    while (H.pts === A.pts && extra < limit) {
      go(side);
      side = side === 'home' ? 'away' : 'home';
      extra += 1;
    }
    if (H.pts === A.pts && opts.playoff) {
      // Pathological guard: a walk-off field goal decides it.
      const t = rng.chance(0.5) ? H : A;
      t.fg += 1;
      t.pts += 3;
    }
  }
  return { homeScore: H.pts, awayScore: A.pts, ot, detail: { home: H, away: A } };
}

/**
 * Win probability for team A vs team B (logistic on the rating edge; calibrated against
 * simulateGame). edgeForA > 0 when A is at home.
 * @param {{off:number, def:number}} a
 * @param {{off:number, def:number}} b
 */
export function winProbability(a, b, { homeEdge = 0 } = {}) {
  const delta = (a.off - b.def) - (b.off - a.def) + homeEdge;
  return 1 / (1 + Math.exp(-GAME_SIM.winProbSlope * delta));
}
