// Match-logic tunables (docs/MECHANICS.md §4.2–§4.4, §5). Every number the match state machine,
// the simulated opponent drives, the AI-vs-AI game sim and the stand-in play model use lives here,
// so balance can be corrected without touching logic. DOM-free.

/** World y of the two hash rows (matches src/render/field.js HASH_Y). */
export const HASH_Y = [23.58, 29.75];
/** World y of the middle of the field. */
export const FIELD_MID_Y = 160 / 6;

/** Difficulty presets (MECHANICS §5.5) as internal steps 1..16. */
export const DIFFICULTY_STEPS = { easy: 2, medium: 6, hard: 10, extreme: 16 };

export const CFG = {
  clock: {
    /** Timeouts per half, keyed by quarter length in minutes (§5.1). OT periods use the same. */
    timeoutsPerHalf: { 1: 2, 2: 2, 3: 3 },
    /** Sim-drive / runoff scale by quarter length (§5.3). */
    simScale: { 1: 0.5, 2: 1, 3: 1.5 },
    /** End-of-half FG window: FG offered on any down when ≤ this many seconds remain (§4.1). */
    fgWindowSec: 20,
    /** Quarters with an end-of-half FG window (OT periods, quarter ≥ 5, always have one). */
    fgWindowQuarters: [2, 4],
  },

  field: {
    /** Kickoffs are taken from the kicking team's 35. User frame world x of the opp kickoff spot. */
    oppKickoffLosX: 75,
    /** User kick-return touchback (§4.3). */
    kickReturnTouchback: 25,
    /** Opponent start after a touchback on a user kickoff. */
    kickoffTouchback: 25,
    /** Touchback on a punt or an end-zone interception. */
    puntTouchback: 20,
    intTouchback: 20,
    /** After a safety the user free-kicks; opponent starts at their 35 (§3.1). */
    safetyOppStart: 35,
    /** PAT from the opponent 15 (losX 95), 2-pt from the 2 (losX 108). */
    patBallOn: 85,
    twoPointBallOn: 98,
    /** Onside kick: the ball is recovered about 11 yd past the user 35. */
    onsideSpotBallOn: 46,
    /** Missed FG: ball goes to the spot of the kick (LOS − 7) or the 20, whichever is better. */
    missedFgHolderOffset: 7,
    missedFgMin: 20,
  },

  kicking: {
    /** FG distance = yards to goal + 17; the longest possible kick is 66 yd (§4.1). */
    fgSnapOffset: 17,
    fgMax: 66,
    /** Max distance = 38 + 2.8 × range (range on the 1–10 attribute scale). */
    rangeBase: 38,
    rangePerPoint: 2.8,
    /** Used when the roster has no K (§4.2). */
    genericKicker: { id: null, range: 3, accuracy: 3 },
  },

  /** User punts (automatic, §4.2): distance = 38 + 1.4 × range ± 6. */
  punt: {
    base: 38,
    perRange: 1.4,
    spread: 6,
    fairCatch: 0.45,
    returnMean: 8,
    returnSd: 6,
    longReturnChance: 0.03,
    /** Ball landing this close to the goal without reaching it is downed inside the 10. */
    coffinZone: 6,
  },

  /** User kickoffs (automatic, §4.2). Touchback odds rise with kicker range. */
  kickoff: {
    touchbackBase: 0.3,
    touchbackPerRange: 0.05,
    returnMean: 26,
    returnSd: 6,
    longReturnChance: 0.03,
  },

  /** Onside kick success chance by kicker (§4.4): 5% weak → 15% strong. */
  onside: { min: 0.05, max: 0.15 },

  /** 4th-down options (§4.4). PUNT on own side (≤ midfield + a bit), or deeper when no FG. */
  fourth: {
    puntMaxBallOn: 60,
    puntMaxBallOnNoFg: 72,
  },

  /** CPU (opponent) kicking and conversion behaviour in simulated drives. */
  cpu: {
    patBase: 0.89,
    patPerRating: 0.09,
    twoPointBase: 0.47,
    twoPointPerStar: 0.025,
    /** Margins (opp − user, after the TD's 6) where the CPU goes for 2 in the 2nd half. */
    twoPointChart: [-2, -5, -10, -12, 1, 5, 12],
    twoPointRandom: 0.03,
    /** CPU max FG range = base + perRating × kickerRating(0..1). */
    fgRangeBase: 47,
    fgRangePerRating: 12,
    fgMakeAtShort: 0.97,
    fgMakeSlope: 0.013,
  },

  /** Simulated opponent possessions (§5.3). Logistic model on ratings + field + difficulty. */
  sim: {
    /** Logit of p(score) at equal ratings, start at own 25, difficulty step 6. */
    scoreBase: -0.15,
    /** Logit per star of (OFF − DEF). */
    scoreRatingK: 0.55,
    /** Logit per 10 yards of start position past the 25. */
    scoreFieldK: 0.3,
    /** Per-drive logit noise (high variance). */
    noiseSd: 0.45,
    /** Logit per difficulty step relative to step 6 (Medium): above / below the pivot. */
    diffPerStep: 0.04,
    diffPerStepBelow: 0,
    /** Share of scoring drives that are TDs (logit): base + ratingK × d + fieldK × field. */
    tdBase: 1.0,
    tdRatingK: 0.3,
    tdFieldK: 0.12,
    /** Of non-scoring drives: turnover share (logit) and INT vs fumble split. */
    turnoverBase: -1.2,
    turnoverRatingK: 0.3,
    intShare: 0.62,
    /** Of non-scoring, non-turnover drives: turnover-on-downs share. */
    downsShare: 0.1,
    /** Runoff in seconds at the 2-min baseline: base + perYard × yards gained, ×0.8..1.2. */
    runoffBase: 9,
    runoffPerYard: 0.5,
    runoffJitter: 0.2,
    /** Runoff multiplier when trailing late (hurry-up) and leading late (milking). */
    hurryFactor: 0.6,
    milkFactor: 1.45,
    /** "Late" = this many baseline seconds left in the 2nd half (scaled by quarter length). */
    lateWindow: 75,
    /** Quick-strike chance when the clock is short: base + perYard past midfield. */
    quickStrikeBase: 0.04,
    quickStrikePerYard: 0.006,
    /** Defensive credit: per-play weights by position, star multiplier. */
    starWeight: 1.8,
    tackleW: { DL: 0.75, LB: 1.35, DB: 0.95 },
    sackW: { DL: 1.0, LB: 0.45, DB: 0.1 },
    intW: { DL: 0.03, LB: 0.35, DB: 1.0 },
    ffW: { DL: 0.9, LB: 1.1, DB: 0.8 },
    /** Share of a drive's yards gained through the air (box score only). */
    passShare: 0.6,
  },

  /** AI-vs-AI full-game simulation (gameSim.js). */
  gameSim: {
    quarterMinutes: 2,
    /** Neutral difficulty step for AI-vs-AI (no user bias). */
    difficultyStep: 6,
    homeEdgeStars: 0.15,
  },

  weather: { rain: 0.12, snow: 0.08 },

  /** Wind option (§5.6): probability of a windy game and the mph range. */
  wind: {
    off: { p: 0, min: 0, max: 0 },
    low: { p: 0.15, min: 3, max: 9 },
    normal: { p: 0.35, min: 4, max: 16 },
    high: { p: 0.6, min: 8, max: 20 },
  },

  /** Stand-in play model (playModel.js) — a "typical human" offense. */
  playModel: {
    defaultSkill: 0.7,
    /** Quality offset per difficulty step relative to 6 (efficiency e = skill − 0.5 + …). */
    diffPerStep: 0.035,
    ratingK: 0.35,
    passShare: 0.58,
    completion: 0.66,
    completionK: 0.6,
    /** Pass depth buckets: short 3–9, medium 10–19, deep 20–45. */
    shortShare: 0.5,
    mediumShare: 0.32,
    sack: 0.06,
    sackK: -0.1,
    interception: 0.025,
    interceptionK: -0.05,
    runMean: 4.2,
    runMeanK: 5,
    runSd: 4,
    breakaway: 0.05,
    breakawayK: 0.15,
    yacMean: 4,
    yacK: 8,
    fumble: 0.009,
    oob: 0.18,
    oobHurry: 0.55,
    twoPoint: 0.5,
    twoPointK: 0.5,
    kickReturnTouchback: 0.35,
    kickReturnMean: 27,
    kickReturnSd: 7,
    kickReturnTd: 0.015,
    kickReturnFumble: 0.008,
  },
};

/** Sim-drive / runoff scale for a quarter length. */
export function simScale(quarterMinutes) {
  return CFG.clock.simScale[quarterMinutes] ?? quarterMinutes / 2;
}

/** Timeouts per half for a quarter length (§5.1). */
export function timeoutsPerHalf(quarterMinutes) {
  return CFG.clock.timeoutsPerHalf[quarterMinutes] ?? (quarterMinutes >= 3 ? 3 : 2);
}

/** Internal step 1..16 → PlaySetup.difficulty (0 easy, 1 normal, 2 hard). */
export function stepToDifficulty(step) {
  if (step <= 4) return 0;
  if (step <= 8) return 1;
  return 2;
}

/** Sim-drive logit bias for a difficulty step (0 at Medium = step 6). */
export function simDifficultyBias(step) {
  const d = (step ?? 6) - 6;
  return (d >= 0 ? CFG.sim.diffPerStep : CFG.sim.diffPerStepBelow) * d;
}

/** Squad rating 0..1 → stars 0.5..5. */
export function ratingToStars(r) {
  if (typeof r !== 'number' || !Number.isFinite(r)) return 2.75;
  return Math.min(5, Math.max(0.5, 0.5 + 4.5 * r));
}

/** Max FG distance for a kicker with `range` on the 1–10 scale, capped at 66 yd. */
export function kickerMaxFg(range) {
  const k = CFG.kicking;
  return Math.min(k.fgMax, k.rangeBase + k.rangePerPoint * range);
}

/** Onside recovery chance for a kicker (range/accuracy on 1–10). */
export function onsideChance(kicker) {
  const q = Math.min(1, Math.max(0, ((kicker.range + kicker.accuracy) / 2 - 1) / 9));
  return CFG.onside.min + (CFG.onside.max - CFG.onside.min) * q;
}
