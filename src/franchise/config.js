// Franchise tuning. Every number the franchise layer uses lives here so values can be corrected
// without touching logic (docs/MECHANICS.md §5.5, §6, §7; [D] = our design decision).
// Money is stored in $K integers everywhere (60000 = $60.0M).

export const START_YEAR = 2026;

/** Roster and squad (MECHANICS §6.1). */
export const ROSTER = {
  cap: 12,               // max named stars incl. injured
  startMin: 8,           // new franchise roster size range
  startMax: 9,
};

/** Attribute scale (MECHANICS §6.2). */
export const ATTR = { min: 1, max: 10, potentialMax: 40 };

/** Position-weighted star formula (MECHANICS §6.2). Weights per attribute. */
export const STAR_WEIGHTS = {
  QB: { accuracy: 0.35, arm: 0.35, stamina: 0.2, speed: 0.1 },
  RB: { speed: 0.35, catching: 0.3, strength: 0.2, stamina: 0.15 },
  WR: { speed: 0.35, catching: 0.3, strength: 0.2, stamina: 0.15 },
  TE: { speed: 0.35, catching: 0.3, strength: 0.2, stamina: 0.15 },
  OL: { blocking: 0.45, strength: 0.35, stamina: 0.1, speed: 0.1 },
  DL: { tackling: 0.35, speed: 0.3, strength: 0.25, stamina: 0.1 },
  LB: { tackling: 0.35, speed: 0.3, strength: 0.25, stamina: 0.1 },
  DB: { tackling: 0.35, speed: 0.3, strength: 0.25, stamina: 0.1 },
  K: { range: 0.45, accuracy: 0.45, speed: 0.05, stamina: 0.05 },
};

/** Generation noise and hidden potential (MECHANICS §6.3/§6.4). growth = extra attribute points. */
export const GENERATION = {
  attrSd: 1.2,
  // Key attributes (star weight >= keyWeight) never roll below the star target and get less noise,
  // so e.g. a 2★ RB can't have 2 speed.
  keyWeight: 0.3,
  keySd: 0.6,
  // [minGrowth, maxGrowth] attribute points above the current sum, by age
  growthByAge: [
    [21, 4, 14], [22, 3, 13], [23, 3, 11], [24, 2, 9], [25, 1, 7],
    [26, 0, 4], [27, 0, 4], [28, 0, 2], [29, 0, 2],
  ],
  traitChance: 0.18,
  moraleMin: 55,
  moraleMax: 75,
};

/** Traits (rare, small effects). */
export const TRAITS = {
  leader: { label: 'Leader', desc: 'Lifts team morale after wins.', weight: 3 },
  ironman: { label: 'Iron Man', desc: 'Half the injury risk.', weight: 3 },
  fragile: { label: 'Fragile', desc: 'Gets hurt more often.', weight: 2 },
  hothead: { label: 'Hothead', desc: 'Morale swings harder.', weight: 2 },
  learner: { label: 'Quick Learner', desc: '+20% XP.', weight: 3 },
};
export const TRAIT_EFFECTS = {
  leaderTeamMoraleOnWin: 1,
  ironmanInjury: 0.5,
  fragileInjury: 1.6,
  hotheadMorale: 1.5,
  learnerXp: 1.2,
};

/** Salary cap and asking salary (MECHANICS §6.6). $K. */
export const CAP = { base: 60000, perSeason: 500 };
export const SALARY = {
  base: 300,              // 0.3 $M
  mult: 1000,             // 1.0 $M x stars^exp
  exp: 1.6,
  roundTo: 100,           // one decimal $M
  min: 500,
  max: 13000,
  // age factor applied to the asking salary
  ageFactors: [[23, 0.9], [30, 1.0], [32, 0.85], [99, 0.7]],
  moraleLowBelow: 40,
  moraleLowFactor: 1.15,
  moraleHighAbove: 75,
  moraleHighFactor: 0.95,
  // asked contract length by age [maxAge, years]
  askYears: [[27, 4], [30, 3], [32, 2], [99, 1]],
  // max total years a player accepts by age
  maxYears: [[30, 5], [32, 3], [99, 2]],
  refuseBelowMorale: 25,  // won't negotiate below this morale
  deadMoneyFraction: 0.5, // of remaining salary this season on release
};
export const ROOKIE_CONTRACT = { years: 3, min: 500, max: 1500 };

/** Coaching credits (MECHANICS §7.2). */
export const CC = {
  start: 6,
  perGame: 1,
  win: 1,
  bigWinMargin: 21,
  bigWin: 1,
  playoffWin: 3,
  finalWin: 6,
  stadiumHomeWinLevel: 4,
  stadiumHomeWin: 1,
};

/** Facilities (MECHANICS §7.3). */
export const FACILITIES = {
  kinds: ['stadium', 'training', 'rehab'],
  labels: { stadium: 'Stadium', training: 'Training', rehab: 'Rehab' },
  desc: {
    stadium: 'Fan growth, home-field edge, +1 CC per home win at level 4+.',
    training: 'More XP for every player.',
    rehab: 'Shorter injuries, faster recovery between games.',
  },
  maxLevel: 5,
  upgradeCost: { 2: 5, 3: 9, 4: 14, 5: 20 },  // CC to reach level
  decayChance: 0.35,
  maintainCost: 2,
  trainingXpPerLevel: 0.15,
  rehabInjuryPerLevel: 0.12,
  rehabRecoveryPerLevel: 4,  // extra condition recovered per week per level above 1
  stadiumFansPerLevel: 0.15, // fan gain multiplier per level above 1 on home wins
  stadiumHomeEdgePerLevel: 0.04, // stars added to home edge per level above 1 (user home games)
};

/** Coordinators (MECHANICS §7.4). */
export const COORDINATORS = {
  costPerStar: 3,
  years: 3,
  boostPerStar: 0.1,      // team OFF/DEF stars
  xpPerStar: 0.05,        // XP multiplier per star on their side of the ball
  candidates: 3,
  startStars: 1,
  // star bands for the three candidates
  bands: [[1, 2], [2, 3], [3, 5]],
};

/** XP and level-ups (MECHANICS §6.3). */
export const XP = {
  base: 100,
  exp: 0.8,
  youngUnder: 25,
  youngMult: 1.3,
  oldOver: 30,
  oldMult: 0.6,
  starterAppearance: 10,
  benchAppearance: 4,
  win: 6,
  rates: {
    passYds: 0.08, passTd: 8, passCmp: 0.4, int: -3,
    rushYds: 0.25, rushTd: 8,
    rec: 2, recYds: 0.2, recTd: 8,
    fgMade: 6, patMade: 1,
    tackles: 2.5, sacks: 8, defInt: 10, ff: 6,
    retYds: 0.08, retTd: 8, fumbles: -3,
  },
  olPerTeamRushYd: 0.05,  // OL earn from team rushing
  olPerTeamPassTd: 2,
};

/** Natural development and aging (MECHANICS §6.4). Points per offseason by age. */
export const AGING = {
  growth: [[23, 2], [25, 1]],     // age <= 23: +2 points, <= 25: +1
  midGrowthMaxAge: 29,            // 26..29: chance of +1
  midGrowthChance: 0.3,
  declineOver: 30,                // age > 30 loses stamina + strength|speed
  steepDeclineFrom: 34,           // extra -1 random attr
  kickerExtraYears: 4,
};

/** Retirement odds by age (MECHANICS §6.4). Kickers use age - kickerExtraYears. */
export const RETIREMENT = {
  byAge: { 31: 0.04, 32: 0.12, 33: 0.25, 34: 0.45, 35: 0.65, 36: 0.85 },
  forceAge: 38,
  lowStarsAt: 1.5,      // stars <= this and age >= 30 add lowStarBonus
  lowStarBonus: 0.12,
};

/** Hall of Fame on retirement (MECHANICS §7.9). Position-neutral legacy points: every season
 * with the team adds stars^2; awards and titles add a bonus. */
export const HOF = {
  minScore: 100,
  perAward: 8,
  perTitle: 10,
  peakStars: 4.5,     // or: peak >= 4.5 stars over at least 5 seasons with the team
  peakSeasons: 5,
};

/** Condition (MECHANICS §6.5). */
export const CONDITION = {
  gameBase: 8,
  perTouch: 0.8,
  qbPassAttFactor: 0.25,
  olImplicitTouches: 6,
  staminaRelief: 0.06,    // drain x (1.3 - 0.06 x stamina)
  weeklyRecovery: 18,
  perfThreshold: 60,
  // performance multiplier: >= threshold: 1 - (100-c)*hi; below: (1 - 40*hi) - (60-c)*lo
  perfHi: 0.001,
  perfLo: 0.007,
};

/** Injuries (MECHANICS §6.5). */
export const INJURY = {
  perHit: 0.006,
  lowConditionFrom: 70,   // below: risk x (1 + (70-c)/40)
  lowConditionDiv: 40,
  // implicit contact per game for starters (added to touches when no hit list is given)
  implicitHits: { QB: 2, RB: 1, WR: 1, TE: 2, OL: 4, DL: 4, LB: 3, DB: 3, K: 0.3 },
  weeks: [1, 2, 3, 4, 5, 6],
  weekWeights: [30, 25, 18, 12, 8, 7],
  seasonEndingChance: 0.03,
  seasonEndingWeeks: 30,
  rushCost: 1,
  types: ['Hamstring', 'Ankle sprain', 'Knee sprain', 'Shoulder', 'Concussion', 'Ribs', 'Wrist', 'Groin', 'Back spasms', 'Turf toe'],
  seasonEndingTypes: ['Torn knee ligament', 'Broken leg', 'Achilles tear'],
};

/** Morale (MECHANICS §6.5). */
export const MORALE = {
  win: 3,
  loss: -3,
  tie: 0,
  bigGame: 3,             // top performer bonus
  fewTouches: -3,         // skill starters with < fewTouchesBelow touches
  fewTouchesBelow: 2,
  injured: -2,
  driftTarget: 60,
  driftRate: 0.08,        // weekly
  offseasonDrift: 0.3,
  perfEffect: 0.08,       // +-8% on-field
  boostCost: 1,
  boostAmount: 15,
  teamBoostCost: 3,
  teamBoostAmount: 8,
  releaseTeamPenalty: -2,
  awardBonus: 10,
  labels: ['Miserable', 'Unhappy', 'Okay', 'Happy', 'Fired up'],
  keys: ['miserable', 'unhappy', 'okay', 'happy', 'fired'],
  thresholds: [20, 40, 60, 80],  // level = number of thresholds <= morale
};

/** Fans (MECHANICS §7.5). */
export const FANS = {
  start: 50,
  win: 2,
  loss: -1,
  bigWin: 1,
  streakAt: 3,
  streak: 1,
  playoffWin: 4,
  title: 10,
  playoffBerth: 3,
  missedPlayoffs: -3,
  weeklyDrift: 0.03,      // toward 50
};

/** Owner confidence / job security (MECHANICS §7.5). */
export const OWNER = {
  start: 60,
  perGame: 4,             // x (result - expected win prob)
  expectationCompress: 0.6, // expected p pulled toward 0.5 (the user plays the offense)
  playoffBerth: 6,
  playoffWin: 4,
  title: 15,
  missedPlayoffs: -3,
  fansWeight: 0.1,        // x (fans - 50) at season end
  seasonReversion: 0.1,   // toward 50 at new season
  fireBelow: 15,
  graceSeasons: 1,        // no firing after the first N seasons
  offers: 3,
  offerPool: 12,          // offers come from the weakest N teams
  newJob: 55,
};

/** Difficulty (MECHANICS §5.5). */
export const DIFFICULTY = {
  modes: ['easy', 'medium', 'hard', 'extreme', 'dynamic'],
  labels: { easy: 'Easy', medium: 'Medium', hard: 'Hard', extreme: 'Extreme', dynamic: 'Dynamic' },
  steps: { easy: 2, medium: 6, hard: 10, extreme: 16 },
  dynamicStart: 4,
  min: 1,
  max: 16,
  capBeforeTitle: 9,
  pivot: 6,               // step with no rating offset
  offsetPerStep: 0.05,    // opponent stars per step above pivot (Hard/step 10: +0.2, step 15: +0.45)
  offsetPerStepBelow: 0.2, // ... per step below pivot (step 1: -1.0)
  fiveStarStep: 16,       // at this step every opponent is a 5-star team
};

/** League (MECHANICS §7.1). */
export const LEAGUE = {
  regularWeeks: 16,
  playoffTeamsPerConf: 7,
  aiRatingMin: 1.5,
  aiRatingMax: 4.5,
  aiRatingNoise: 0.2,
  clampMin: 1.0,
  clampMax: 5.0,
  driftMean: 3.0,
  driftReversion: 0.25,
  driftSd: 0.35,
  badSeasonPct: 0.35,
  badSeasonBoost: 0.3,
  goodSeasonPct: 0.7,
  goodSeasonPenalty: 0.15,
  homeEdge: 0.3,          // stars (~55% home win rate between equal teams)
  cupName: 'Gridiron Cup',
};

export const ROUNDS = ['wildcard', 'divisional', 'conference', 'final'];
export const ROUND_LABELS = {
  wildcard: 'Wild Card',
  divisional: 'Divisional',
  conference: 'Conference Final',
  final: 'Gridiron Cup',
};

/** Score model for abstract games (MECHANICS §5.3, AI-vs-AI). Stars difference d = OFF - DEF. */
export const GAME_SIM = {
  drives: 11,
  drivesSd: 1.1,
  drivesMin: 8,
  drivesMax: 14,
  tdBase: 0.21,
  tdPerStar: 0.065,
  tdMin: 0.05,
  tdMax: 0.5,
  fgBase: 0.14,
  fgPerStar: 0.015,
  fgMin: 0.06,
  fgMax: 0.22,
  safety: 0.005,
  defTd: 0.012,
  turnover: 0.13,         // share of empty drives that end in a turnover
  patGood: 0.94,
  twoPtRate: 0.05,
  twoPtGood: 0.48,
  otExtraDrives: 4,       // sudden-death drives before a regular-season tie
  winProbSlope: 0.66,     // logistic slope on (rating edge), calibrated vs simulateGame
};

/** Weather eligibility handed to the match (MECHANICS §5.6): snow only for northern home teams late. */
export const WEATHER = {
  northern: ['BOS', 'NYC', 'BUF', 'PIT', 'PHI', 'BAL', 'WAS', 'CHI', 'DET', 'CLE', 'IND', 'SEA', 'POR', 'MIN', 'DEN', 'KCY', 'STL'],
  snowFromWeek: 12,
};

/** Generic fillers (MECHANICS §6.1). */
// Replacement-level players in empty slots. Must stay clearly below any star (a 1.5★ star's key
// attributes start at 3 → skill ≈ 0.22), so signing a star always upgrades the position.
// AI teams are abstract star ratings; their on-field players are synthesized from them. Cap the
// synthesized attribute mean so a 5★ (or Extreme) opponent is elite but not flawless: uncapped,
// every attribute sat at 10 and equal-rated user teams could not move the ball at all.
export const VIRTUAL = { attrCap: 8.8 };

export const FILLER = { skillMin: 0.08, skillMax: 0.14, stars: 1.25, level: 1 };

/** Team OFF/DEF from starters (MECHANICS §6.2). Weights per slot (sum 1 per side). */
export const TEAM_WEIGHTS = {
  off: { QB: [0.28], RB: [0.12], WR: [0.12, 0.10], TE: [0.06, 0.04], OL: [0.04, 0.04, 0.04, 0.04, 0.04], K: [0.08] },
  def: { DL: [0.08, 0.08, 0.08, 0.08], LB: [0.09, 0.09, 0.09], DB: [0.1025, 0.1025, 0.1025, 0.1025] },
};

/**
 * Team rating formula (squad.js sideRating): starters ranked best first, the slot at cumulative
 * weight x counts with the slope of Q(x) = 1 - (1 - x)^topHeavy (1 = plain weighted mean). The
 * user can carry 12 stars for 23 slots, so fillers always fill half the lineup; with a plain mean
 * a roster of elite stars could never rate like a top AI team and one new star would barely move
 * the needle. Monotonic: a better player never lowers the rating.
 */
export const TEAM_RATING = { topHeavy: 2.2 };

/** Draft (MECHANICS §7.7). */
export const DRAFT = {
  rounds: 3,
  prospects: 60,
  ageMin: 21,
  ageMax: 23,
  scoutCost: 1,
  aiPickChance: [0.8, 0.5, 0.3],  // AI teams are abstract and sometimes pass
  aiNoise: 0.6,
  // true-star weights [stars, weight]
  stars: [[0.5, 2], [1, 5], [1.5, 6], [2, 5], [2.5, 3], [3, 1.5], [3.5, 0.5]],
  potentialBonus: [0, 6],          // extra growth on top of age growth
  estimateSpread: [0.5, 1.0],      // half-width of the shown star range
  posWeights: { QB: 5, RB: 7, WR: 10, TE: 6, OL: 12, DL: 10, LB: 8, DB: 10, K: 3 },
};

/** Free agency (MECHANICS §7.7). */
export const FREE_AGENCY = {
  feePerStar: 1.5, // signing fee = ceil(feePerStar * stars) CC: a signing should be a real choice
  min: 10,
  max: 14,
  refreshWeeks: 4,
  keepFraction: 0.3,
  ageMin: 24,
  ageMax: 33,
  stars: [[1, 2], [1.5, 3], [2, 4], [2.5, 4], [3, 3], [3.5, 2], [4, 1], [4.5, 0.3]],
  posWeights: { QB: 4, RB: 7, WR: 10, TE: 6, OL: 11, DL: 10, LB: 8, DB: 10, K: 3 },
};

/** Starting roster (MECHANICS §7: "~8-9 stars mostly 1-2.5"). */
export const START_ROSTER = {
  core: ['QB', 'RB', 'WR', 'WR', 'OL', 'DL', 'LB', 'DB'],
  extra: ['TE', 'K', 'OL', 'DL', 'DB'],
  qbStars: [[2, 3], [2.5, 3], [3, 1]],
  stars: [[1.5, 3], [2, 4], [2.5, 3], [3, 0.6]],
  ageMin: 22,
  ageMax: 31,
};

/** News, press and feed (MECHANICS §7.6). */
export const NEWS = {
  eventCountWeights: [25, 50, 25], // 0, 1, 2 events after a game
  keepResolved: 30,
  feedMax: 80,
  ignoredMessageMorale: -2,
};

/** Records: tracked stats and the seeded franchise record book (fictional legends). */
export const RECORDS = {
  stats: {
    passYds: 'Passing yards', passTd: 'Passing TDs', rushYds: 'Rushing yards', rushTd: 'Rushing TDs',
    rec: 'Receptions', recYds: 'Receiving yards', recTd: 'Receiving TDs', tackles: 'Tackles',
    sacks: 'Sacks', defInt: 'Interceptions', fgMade: 'Field goals',
  },
  // Calibrated to the match engine's stat volume (2-minute quarters, arcade scoring).
  baseline: {
    game: { passYds: [400, 460], passTd: [5, 6], rushYds: [180, 220], rushTd: [3, 4], rec: [11, 13], recYds: [190, 230], recTd: [3, 4], tackles: [15, 17], sacks: [3, 4], defInt: [2, 3], fgMade: [4, 5] },
    season: { passYds: [4800, 5500], passTd: [48, 56], rushYds: [1400, 1700], rushTd: [16, 20], rec: [105, 125], recYds: [1800, 2100], recTd: [20, 25], tackles: [150, 175], sacks: [14, 18], defInt: [9, 12], fgMade: [28, 33] },
    career: { passYds: [28000, 36000], passTd: [260, 320], rushYds: [8000, 10000], rushTd: [80, 100], rec: [600, 750], recYds: [9000, 11000], recTd: [100, 130], tackles: [900, 1100], sacks: [80, 110], defInt: [45, 60], fgMade: [180, 220] },
    longestFg: [54, 58],
  },
};

/** Offseason pipeline (MECHANICS §7.8). */
export const OFFSEASON_STEPS = ['summary', 'retirements', 'contracts', 'progression', 'facilities', 'staff', 'draft', 'freeAgency', 'newSeason'];
export const OFFSEASON_LABELS = {
  summary: 'Season Review',
  retirements: 'Retirements',
  contracts: 'Expiring Contracts',
  progression: 'Player Development',
  facilities: 'Facilities',
  staff: 'Coordinators',
  draft: 'Draft',
  freeAgency: 'Free Agency',
  newSeason: 'New Season',
};
