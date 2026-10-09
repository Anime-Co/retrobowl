// Simulated opponent possession (MECHANICS §5.3). Pure function of its inputs + rng: decides the
// drive outcome with a logistic model on the rating difference, field position and difficulty
// bias, then dresses it up as 3–6 short ORIGINAL text beats and credits the user's star
// defenders with tackles / sacks / INTs / forced fumbles. DOM-free.
//
// Frames: `startYard` and `endYard` are in the DRIVING team's frame (yards from its own goal).
// `userBallOn` is in the user's frame (yards from the user's own goal) = 100 − opp yard.

import { Rng } from '../../core/rng.js';
import { clamp } from '../../core/util.js';
import { CFG, simScale, simDifficultyBias } from './config.js';

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/**
 * @typedef {Object} SimBeat
 * @property {string} text
 * @property {number} t            seconds into the drive when the beat happens (0..timeUsed)
 * @property {number} pts          points the driving team adds on this beat
 * @property {'start'|'play'|'result'|'conversion'} kind
 * @property {boolean} unskippable  turnover lines
 */

/**
 * @typedef {Object} SimDriveResult
 * @property {'td'|'fg'|'fg_miss'|'punt'|'int'|'fumble'|'downs'|'end_half'} outcome
 * @property {number} points        total incl. conversion
 * @property {'pat_good'|'pat_miss'|'two_good'|'two_fail'|null} conversion
 * @property {number} timeUsed      game-clock seconds consumed (≤ clockLeft)
 * @property {number|null} userBallOn  where the user takes over (user frame) or null (score → kickoff / end of half)
 * @property {SimBeat[]} beats
 * @property {Object<string,{tackles:number,sacks:number,defInt:number,ff:number}>} defStats
 * @property {number} yards         net yards gained by the drive
 * @property {number} passYds
 * @property {number} rushYds
 * @property {number} plays
 * @property {number} startYard
 * @property {number} endYard       driving-team frame yard where the drive ended (100 = TD)
 * @property {number} fgDistance    FG attempt distance (0 if none)
 */

/**
 * Simulate one opponent possession.
 * @param {Object} o
 * @param {number} o.offStars        driving team OFF stars (0.5–5)
 * @param {number} o.defStars        defending team DEF stars (0.5–5)
 * @param {number} o.startYard       driving-team frame (yards from its own goal)
 * @param {number} o.clockLeft       seconds available to this drive (time left in the HALF / OT period)
 * @param {number} [o.quarterMinutes=2]
 * @param {number} [o.difficultyStep=6]
 * @param {number} [o.half=1]        1, 2 (3 = OT)
 * @param {number} [o.scoreDiff=0]   driving team score − defending team score
 * @param {Rng} [o.rng]
 * @param {number} [o.seed]          used when no rng is given
 * @param {{id:string,name:string,pos:string,number?:number}[]} [o.userDefenders]  defending star players
 * @param {string} [o.oppAbbr='OPP'] driving team abbreviation for text
 * @param {number} [o.kickerRating=0.5]  driving team K quality 0..1
 * @param {string} [o.startText]     replaces the generated opening beat (e.g. kickoff / punt result)
 * @param {boolean} [o.skipConversionIfAhead]  OT: no PAT/2-pt when the TD alone decides the game
 * @param {boolean} [o.neutral]      AI-vs-AI: no difficulty bias
 * @returns {SimDriveResult}
 */
export function simDrive(o) {
  const c = CFG.sim;
  const cpu = CFG.cpu;
  const rng = o.rng || new Rng(o.seed ?? 1);
  const off = o.offStars ?? 2.75;
  const def = o.defStars ?? 2.75;
  const d = off - def;
  const start = clamp(Math.round(o.startYard ?? 25), 1, 99);
  const clockLeft = Math.max(0, o.clockLeft ?? Infinity);
  const scale = simScale(o.quarterMinutes ?? 2);
  const half = o.half ?? 1;
  const diff = o.scoreDiff ?? 0;
  const abbr = o.oppAbbr || 'OPP';
  const kr = clamp(o.kickerRating ?? 0.5, 0, 1);
  const late = half >= 2 && clockLeft <= c.lateWindow * scale;
  const twoMinuteDrill = half === 1 && clockLeft <= c.lateWindow * scale * 0.6;
  const hurry = (late && diff < 0) || twoMinuteDrill;
  const milk = late && diff > 0 && half === 2;
  const fgMax = cpu.fgRangeBase + cpu.fgRangePerRating * kr;
  const fgLine = clamp(100 - (fgMax - CFG.kicking.fgSnapOffset), 50, 95); // own-frame yard where FG range starts
  const field = (start - 25) / 10;

  // ---- 1. intended outcome ------------------------------------------------------------------
  const bias = o.neutral ? 0 : simDifficultyBias(o.difficultyStep ?? 6);
  const pScore = sigmoid(c.scoreBase + c.scoreRatingK * d + c.scoreFieldK * field + bias + rng.normal(0, c.noiseSd));
  let outcome;
  let endYard;
  let forceMiss = false;
  if (rng.chance(pScore)) {
    const pTD = sigmoid(c.tdBase + c.tdRatingK * d + c.tdFieldK * field);
    if (start >= 96 || rng.chance(pTD)) outcome = 'td';
    else outcome = 'fg';
    // Trailing by more than a FG late: a FG doesn't help, go for the TD.
    if (outcome === 'fg' && late && diff <= -4) outcome = rng.chance(0.4) ? 'td' : 'downs';
  } else {
    const pTO = sigmoid(c.turnoverBase - c.turnoverRatingK * d);
    if (rng.chance(pTO)) outcome = rng.chance(c.intShare) ? 'int' : 'fumble';
    else if (rng.chance(c.downsShare)) outcome = 'downs';
    else outcome = 'punt';
    if (outcome === 'punt' && hurry && half >= 2 && rng.chance(0.75)) outcome = 'downs';
  }

  // ---- 2. where the drive ends (own frame) ---------------------------------------------------
  const room = 100 - start;
  switch (outcome) {
    case 'td':
      endYard = 100;
      break;
    case 'fg': {
      const lo = Math.max(start, fgLine + 2);
      endYard = lo >= 95 ? Math.min(97, lo) : rng.float(lo, 95);
      break;
    }
    case 'punt': {
      const cap = Math.max(start, fgLine - 3);
      endYard = clamp(start + clamp(rng.normal(9, 10), -6, 45), 2, cap);
      if (start >= fgLine - 3) {
        // already in range on a short field: a stalled drive is a missed kick or a 4th-down stop
        outcome = rng.chance(0.5) ? 'fg' : 'downs';
        forceMiss = outcome === 'fg';
        endYard = clamp(start + clamp(rng.normal(5, 5), -3, 15), start - 3, 97);
      }
      break;
    }
    case 'downs':
      endYard = clamp(start + clamp(rng.normal(22, 14), 0, room - 1), 1, 99);
      break;
    case 'int':
    case 'fumble':
      endYard = clamp(start + clamp(rng.normal(12, 12), -3, room - 3), 1, 97);
      break;
    default:
      endYard = start;
  }
  endYard = Math.round(endYard);

  // ---- 3. clock ------------------------------------------------------------------------------
  const timeFor = (yards, mode) =>
    (c.runoffBase + c.runoffPerYard * Math.max(0, yards)) * scale * mode;
  const mode = hurry ? c.hurryFactor : milk ? c.milkFactor : 1;
  let timeUsed = timeFor(endYard - start, mode) * rng.float(1 - c.runoffJitter, 1 + c.runoffJitter);
  if (outcome === 'punt' || outcome === 'downs') timeUsed += 2 * scale * mode;
  let kneel = false;
  if (timeUsed > clockLeft) {
    const scoring = outcome === 'td' || outcome === 'fg';
    const pace = c.runoffPerYard * scale * c.hurryFactor;
    const reach = start + Math.max(0, (clockLeft - c.runoffBase * scale * c.hurryFactor) / pace);
    if (milk) {
      outcome = 'end_half';
      kneel = true;
      endYard = start;
      timeUsed = clockLeft;
    } else if (scoring && reach >= 100) {
      timeUsed = Math.min(clockLeft, timeFor(100 - start, c.hurryFactor));
    } else if (scoring && reach >= fgLine && !(late && diff <= -4)) {
      outcome = 'fg';
      endYard = Math.round(clamp(reach, start, 95));
      timeUsed = clockLeft;
    } else if (clockLeft >= 2 && rng.chance(c.quickStrikeBase + c.quickStrikePerYard * Math.max(0, start - 50))) {
      outcome = 'td';
      endYard = 100;
      timeUsed = clockLeft * rng.float(0.6, 1);
    } else {
      outcome = 'end_half';
      endYard = Math.round(clamp(Math.min(reach, start + rng.int(0, 25)), start, 99));
      timeUsed = clockLeft;
    }
  }
  timeUsed = Math.max(0, Math.min(clockLeft, timeUsed));

  // ---- 4. resolve kicks, conversions and the user's take-over spot ---------------------------
  let points = 0;
  let conversion = null;
  let userBallOn = null;
  let fgDistance = 0;
  let resultSpot = null;
  let puntTouchback = false;
  if (outcome === 'fg') {
    fgDistance = Math.round(100 - endYard + CFG.kicking.fgSnapOffset);
    const pMake = clamp(cpu.fgMakeAtShort - cpu.fgMakeSlope * Math.max(0, fgDistance - 30) * (1.25 - 0.5 * kr), 0.05, 0.99);
    if (!forceMiss && rng.chance(pMake)) points = 3;
    else {
      outcome = 'fg_miss';
      userBallOn = Math.max(CFG.field.missedFgMin, 100 - (endYard - CFG.field.missedFgHolderOffset));
    }
  } else if (outcome === 'td') {
    const conv = cpuConversion({ scoreDiff: diff, half, offStars: off, defStars: def, kickerRating: kr, rng, skipIfAhead: o.skipConversionIfAhead });
    conversion = conv.conversion;
    points = 6 + conv.points;
  } else if (outcome === 'punt') {
    const gross = rng.normal(45, 5);
    const landing = endYard + gross;
    if (landing >= 100) {
      if (rng.chance(0.65)) {
        userBallOn = CFG.field.puntTouchback;
        puntTouchback = true;
      } else userBallOn = rng.int(3, 10);
    } else {
      const ret = rng.chance(0.4) ? 0 : Math.max(0, rng.normal(8, 6));
      userBallOn = 100 - landing + ret;
    }
  } else if (outcome === 'int') {
    const spot = endYard + rng.float(6, 24);
    if (spot >= 100) userBallOn = CFG.field.intTouchback;
    else userBallOn = 100 - spot + Math.max(0, rng.normal(8, 9));
  } else if (outcome === 'fumble') {
    userBallOn = 100 - endYard - rng.float(0, 5) + Math.max(0, rng.normal(2, 4));
  } else if (outcome === 'downs') {
    userBallOn = 100 - endYard;
  }
  if (userBallOn != null) userBallOn = clamp(Math.round(userBallOn), 1, 99);
  resultSpot = userBallOn;

  // ---- 5. beats and defensive credit ---------------------------------------------------------
  const slots = buildSlots(o.userDefenders || [], rng);
  const defStats = {};
  const credit = (slot, key) => {
    if (!slot.star || !slot.star.id) return;
    const s = (defStats[slot.star.id] ||= { tackles: 0, sacks: 0, defInt: 0, ff: 0 });
    s[key] += 1;
  };
  const pickSlot = (w) => slots[rng.weightedIndex(slots.map((s) => w[s.pos] * (s.star ? c.starWeight : 1)))];
  const who = (slot) => (slot.star ? (slot.star.number != null ? `#${slot.star.number} ${slot.star.name}` : slot.star.name) : `#${slot.num}`);
  const userSpot = (b) => spotLabelUser(b, abbr);

  const netYards = outcome === 'td' ? 100 - start : endYard - start;
  const beats = [];
  beats.push({ text: o.startText || `${abbr} take over at ${spotLabelOpp(start, abbr)}.`, t: 0, pts: 0, kind: 'start', unskippable: false });

  // key plays (1–3)
  const keys = [];
  let finalPlay = 0; // yards of the scoring play (TD)
  let finalType = 'pass';
  if (outcome === 'td') {
    finalType = rng.chance(0.55) ? 'pass' : 'run';
    finalPlay = Math.max(1, Math.min(netYards, rng.chance(0.3) ? rng.int(15, 45) : rng.int(1, 12)));
  }
  let gainPool = Math.max(0, netYards - finalPlay);
  let sackHappened = false;
  const nGains = gainPool >= 30 ? rng.int(1, 2) : gainPool >= 6 ? 1 : 0;
  for (let i = 0; i < nGains; i++) {
    const share = i === nGains - 1 ? rng.float(0.35, 0.7) : rng.float(0.25, 0.5);
    const n = Math.max(3, Math.round(gainPool * share));
    gainPool -= n;
    keys.push(gainText(rng, n, abbr));
    if (keys.length < 3 && rng.chance(0.3)) keys.push(pickText(rng, ['Converts on 3rd & {k}.', 'Moves the chains on 3rd & {k}.', 'Keeps it alive on 3rd & {k}.']).replace('{k}', String(rng.int(2, 9))));
  }
  const sackP = clamp(0.28 - 0.06 * d, 0.08, 0.6);
  const stalls = outcome === 'punt' || outcome === 'fg' || outcome === 'fg_miss' || outcome === 'downs';
  if (keys.length < 3 && (stalls ? rng.chance(0.75) : rng.chance(sackP * 0.5))) {
    if (rng.chance(sackP)) {
      const s = pickSlot(c.sackW);
      credit(s, 'sacks');
      sackHappened = true;
      keys.push(pickText(rng, ['{who} gets home — sack, loss of {n}.', 'Sacked by {who}! Back {n} yards.', '{who} drops the QB for -{n}.']).replace('{who}', who(s)).replace('{n}', String(rng.int(4, 10))));
    } else if (stalls) {
      const s = pickSlot(c.tackleW);
      keys.push(pickText(rng, ['3rd-down stop! {who} breaks it up.', '{who} stuffs the run on 3rd & {k}.', '3rd & {k} — incomplete, {who} in coverage.']).replace('{who}', who(s)).replace('{k}', String(rng.int(2, 12))));
    }
  }
  if (keys.length === 0) keys.push(gainText(rng, Math.max(2, rng.int(2, 9)), abbr));
  keys.slice(0, 3).forEach((text, i, arr) => {
    beats.push({ text, t: timeUsed * ((i + 1) / (arr.length + 1)), pts: 0, kind: 'play', unskippable: false });
  });

  // result
  let resultText;
  let unskippable = false;
  let resultPts = 0;
  switch (outcome) {
    case 'td':
      resultPts = 6;
      resultText = finalType === 'pass' ? `TOUCHDOWN ${abbr}! ${finalPlay}-yard pass.` : `TOUCHDOWN ${abbr}! ${finalPlay}-yard run.`;
      break;
    case 'fg':
      resultPts = 3;
      resultText = `FIELD GOAL ${abbr} — good from ${fgDistance} yards.`;
      break;
    case 'fg_miss':
      resultText = `${abbr} miss from ${fgDistance} yards! Your ball at ${userSpot(resultSpot)}.`;
      break;
    case 'punt':
      resultText = puntTouchback
        ? `${abbr} punt into the end zone. Touchback — your ball at your 20.`
        : `${abbr} punt. Your ball at ${userSpot(resultSpot)}.`;
      break;
    case 'int': {
      const s = pickSlot(c.intW);
      credit(s, 'defInt');
      unskippable = true;
      resultText = `INTERCEPTED by ${who(s)}! Your ball at ${userSpot(resultSpot)}.`;
      break;
    }
    case 'fumble': {
      const s = pickSlot(c.ffW);
      credit(s, 'ff');
      unskippable = true;
      resultText = `FUMBLE! ${who(s)} punches it out — your ball at ${userSpot(resultSpot)}.`;
      break;
    }
    case 'downs':
      unskippable = true;
      resultText = `Stopped on 4th & ${rng.int(1, 6)}! Your ball at ${userSpot(resultSpot)}.`;
      break;
    default:
      resultText = kneel ? `${abbr} kneel and run out the clock.` : `Time runs out on the ${abbr} drive.`;
  }
  beats.push({ text: resultText, t: timeUsed, pts: resultPts, kind: 'result', unskippable });
  if (conversion) {
    beats.push({ text: CONVERSION_TEXT[conversion], t: timeUsed, pts: points - 6, kind: 'conversion', unskippable: false });
  }

  // tackles: roughly one per non-scoring, non-incomplete snap
  const plays = clamp(Math.round(Math.abs(netYards) / 6) + 3, 3, 14);
  const tackles = Math.max(0, Math.round(plays * 0.72) - (outcome === 'td' ? 1 : 0) - (sackHappened ? 1 : 0));
  for (let i = 0; i < tackles; i++) credit(pickSlot(c.tackleW), 'tackles');

  const gained = Math.max(0, netYards);
  const passYds = Math.round(gained * clamp(rng.normal(c.passShare, 0.15), 0.1, 0.95));
  return {
    outcome,
    points,
    conversion,
    timeUsed,
    userBallOn,
    beats,
    defStats,
    yards: netYards,
    passYds,
    rushYds: netYards - passYds,
    plays,
    startYard: start,
    endYard,
    fgDistance,
  };
}

export const CONVERSION_TEXT = {
  pat_good: 'Extra point is good.',
  pat_miss: 'Extra point is NO GOOD!',
  two_good: '2-point try is good!',
  two_fail: '2-point try fails.',
};

/**
 * CPU try after a touchdown: PAT, or a 2-pt try per a simple 2nd-half chart.
 * @param {{scoreDiff:number, half:number, offStars:number, defStars:number, kickerRating:number,
 *          rng:Rng, skipIfAhead?:boolean}} o  scoreDiff = kicking team − other team BEFORE the TD
 * @returns {{conversion:'pat_good'|'pat_miss'|'two_good'|'two_fail'|null, points:number}}
 */
export function cpuConversion(o) {
  const cpu = CFG.cpu;
  const { rng } = o;
  const margin = (o.scoreDiff ?? 0) + 6;
  if (o.skipIfAhead && margin > 0) return { conversion: null, points: 0 };
  const goTwo = ((o.half ?? 1) >= 2 && cpu.twoPointChart.includes(margin)) || rng.chance(cpu.twoPointRandom);
  if (goTwo) {
    const d = (o.offStars ?? 2.75) - (o.defStars ?? 2.75);
    const ok = rng.chance(clamp(cpu.twoPointBase + cpu.twoPointPerStar * d, 0.2, 0.8));
    return { conversion: ok ? 'two_good' : 'two_fail', points: ok ? 2 : 0 };
  }
  const ok = rng.chance(clamp(cpu.patBase + cpu.patPerRating * clamp(o.kickerRating ?? 0.5, 0, 1), 0.5, 0.995));
  return { conversion: ok ? 'pat_good' : 'pat_miss', points: ok ? 1 : 0 };
}

/** 11 defensive slots (4 DL, 3 LB, 4 DB); stars fill their position first, fillers get numbers. */
function buildSlots(userDefenders, rng) {
  const counts = { DL: 4, LB: 3, DB: 4 };
  const ranges = { DL: [90, 99], LB: [50, 59], DB: [20, 39] };
  const slots = [];
  for (const pos of ['DL', 'LB', 'DB']) {
    const stars = userDefenders.filter((p) => p && p.pos === pos).slice(0, counts[pos]);
    for (let i = 0; i < counts[pos]; i++) {
      slots.push({ pos, star: stars[i] || null, num: rng.int(ranges[pos][0], ranges[pos][1]) });
    }
  }
  return slots;
}

function pickText(rng, arr) {
  return arr[Math.floor(rng.next() * arr.length)];
}

function gainText(rng, n, abbr) {
  const big = n >= 20;
  if (rng.chance(0.6)) {
    const t = big
      ? ['Deep ball hauled in for {n}!', 'Shot down the sideline — {n} yards!', 'Receiver splits the safeties, {n} yards!']
      : ['Quick slant for {n}.', '{abbr} hit the tight end for {n}.', 'Back-shoulder throw, {n} yards.', 'Screen pass goes for {n}.'];
    return pickText(rng, t).replace('{n}', String(n)).replace('{abbr}', abbr);
  }
  const t = big
    ? ['Breakaway run of {n}!', 'Cutback lane — {n}-yard run!']
    : ['Inside run for {n}.', 'Sweep to the edge, {n} yards.', 'Draw play picks up {n}.', 'QB scramble for {n}.'];
  return pickText(rng, t).replace('{n}', String(n));
}

/** Driving-team frame yard → text from the user's point of view. */
export function spotLabelOpp(y, abbr) {
  const v = clamp(Math.round(y), 1, 99);
  if (v === 50) return 'midfield';
  return v < 50 ? `the ${abbr} ${v}` : `your ${100 - v}`;
}

/** User frame yard → text from the user's point of view. */
export function spotLabelUser(b, abbr) {
  const v = clamp(Math.round(b), 1, 99);
  if (v === 50) return 'midfield';
  return v < 50 ? `your ${v}` : `the ${abbr} ${100 - v}`;
}
