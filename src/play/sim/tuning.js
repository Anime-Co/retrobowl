// Every tunable number of the on-field engine lives here (MECHANICS.md: "one config file per
// module"). Units: distances in yards, speeds in yd/s, accelerations in yd/s^2, times in seconds,
// probabilities 0..1. Attribute inputs are the normalized 0..1 SquadPlayer skills (0.5 = average
// starter, generic fillers ~0.15-0.25). Values tagged [D] are MECHANICS design decisions.

import { FIELD_W } from '../../render/camera.js';

export const FIELD = {
  LEN: 120,
  W: FIELD_W, // 53.33
  OWN_GOAL: 10,
  OPP_GOAL: 110,
  END_LINE: 120,
  HASH_L: 23.58,
  HASH_R: 29.75,
  INSET: 1.2, // routes / alignments stay this far inside the sidelines
};

export const TUNING = {
  step: 1 / 60, // fixed simulation step
  maxPlayTime: 25, // hard cap: whistle the play dead after this much sim time
  histFrames: 36, // per-entity position history kept (frames) for delayed AI perception

  // ---------------------------------------------------------------- movement
  // top speed = base + span * speed attr  (yd/s). Skill players ~6.2-9.5 [D]
  speed: {
    QB: [5.8, 2.8],
    RB: [6.2, 3.3],
    WR: [6.2, 3.3],
    TE: [5.8, 2.7],
    OL: [4.6, 1.8],
    DL: [5.1, 2.2],
    LB: [5.8, 2.8],
    DB: [6.35, 3.3],
    K: [5.0, 1.8],
  },
  // speed attr -> curve: keeps the 0 and 1 extremes but flattens the middle so small rating gaps
  // don't decide every chase: f(s) = 0.5 + 0.5 * sign(2s-1) * |2s-1|^speedCurve
  speedCurve: 2,
  // head-to-head contest skills = 0.5 + contestSpread * (raw - 0.5)   (see squads.js skill())
  contestSpread: 0.5,
  accelBase: 8.5, // yd/s^2 at speed 0
  accelSpan: 4.0, // + span * speed attr
  decelMult: 1.8, // braking / turning uses accel * this
  staminaSpeed: 0.1, // top speed *= 1 - staminaSpeed * (1 - stamina)
  snowSpeed: 0.92, // weather multiplier (MECHANICS 5.6)
  backpedalFrac: 0.72, // DBs backpedalling before they turn and run

  // ---------------------------------------------------------------- difficulty (step 1..16)
  // Values are anchored at step 6 (Medium) and move per step. The franchise layer ALSO shifts the
  // opponent's ratings by step (DIFFICULTY.offsetPerStep: 0.2 stars/step below Medium, 0.05 above),
  // so the AI scaling here is deliberately mild, and milder still above Medium (slopeScale).
  difficulty: {
    // 'difficulty' (0 easy,1 normal,2 hard) -> step when difficultyStep is missing
    legacyStep: [2, 6, 10],
    pivot: 6,
    defSpeed: [0.98, 0.004], // defender speed multiplier [at pivot, per step]
    react: [0.21, -0.008], // defender reaction delay (s)
    lungeRange: [1.55, 0.015], // yd
    tackle: [0, 0.008], // tackle probability bonus
    rush: [1.02, -0.012], // pass-rush beat-timer multiplier (lower = faster pressure)
    int: [0, 0.006], // interception chance bonus
    catch: [0, -0.003], // offensive catch chance bonus
    // visible-arc trim: 0 up to step 6, -0.1 at step 10 (Hard), -0.2 at step 16 (Extreme) [D]
    arcTrim: [[6, 0], [10, 0.1], [16, 0.2]],
    // every per-step slope above is scaled by `above` for steps over the pivot and by `below`
    // under it (balance lever: how much each difficulty step changes the defenders)
    slopeScale: { below: 1.25, above: 0.2 },
  },

  // ---------------------------------------------------------------- formations
  formation: {
    shotgunChance: 0.5, // [D] each play picks shotgun or under centre
    qbDepthCenter: 1.1,
    qbDepthShotgun: 5.0,
    rbDepthCenter: 6.6,
    rbDepthShotgun: 5.0,
    rbOffsetShotgun: 2.3,
    olSpacing: 1.5,
    olDepth: 0.8,
    teInline: 4.6,
    wrSplitMin: 11,
    wrSplitMax: 15,
    slotChance: 0.25, // WR2 aligns in the slot
    dlDepth: 1.0,
    lbDepth: 4.6,
    cbCushionMin: 4.5,
    cbCushionMax: 7.0,
    pressChance: 0.18, // CB aligns in press (1.5 yd)
    ssDepth: 9.5,
    fsDepth: 14,
    te2BlockChance: 0.4, // [D] TE2 blocks instead of running a route
  },

  // ---------------------------------------------------------------- routes (MECHANICS 2.2)
  routes: {
    // catalog weights for WRs
    wrWeights: { go: 9, fade: 7, post: 9, corner: 8, curl: 10, quick_in: 8, quick_out: 8, deep_in: 7, deep_out: 7, slant: 10, flat: 4 },
    teWeights: { flat: 1, out: 1, seam: 1, drag: 1 },
    rbWeights: { checkdown: 3, wheel: 1 },
    cutSlow: 0.55, // speed kept through a 90 degree cut (scaled by angle and elusiveness)
    cutSlowElusive: 0.3, // + elusiveness * this
    rbFakeTime: 0.35, // RB run-fake before releasing into his route
  },

  // ---------------------------------------------------------------- run game
  run: {
    meshDepthCenter: 4.2, // handoff point behind the LOS (under centre)
    meshDepthShotgun: 4.4,
    meshTimeMax: 0.75, // the exchange always happens by this time
    meshDist: 0.9,
    rbMeshBoost: 1.4, // accel multiplier while running to the mesh
    laneReach: 1.1, // waypoint reached radius
    autoLateralGain: 2.5, // auto-run lateral steering toward the lane target (1/s)
    autoLateralMax: 0.55, // max lateral component (fraction of speed) for auto steering
  },

  // ---------------------------------------------------------------- blocking
  block: {
    engageDist: 1.15, // blocker latches on within this distance
    climbEngageDist: 1.45, // second-level (climb / stalk) blocks latch from a bit further
    pairGap: 0.9, // distance kept between engaged players
    passBeatBase: 3.0, // [D] mean beat timer (s) for an even pass-rush matchup
    passBeatSkill: 0.9, // timer *= 1 + skill * (blocker - rusher)
    passBeatVar: 0.25, // +-25% randomisation [D]
    quickBeatChance: 0.04, // per rusher: blown block, beaten almost instantly
    quickBeatTime: [0.7, 1.5],
    doubleTeam: 1.45, // beat timer multiplier when doubled
    chip: 1.2, // TE chip multiplier
    tePassBeat: 0.75, // TE / RB pickup beat timer multiplier vs a blitzer
    runShedBase: 1.8, // mean shed time for run blocks
    runShedSkill: 1.0,
    runShedVar: 0.3,
    stalkShed: 1.1, // WR stalk-block shed mean
    secondLevelShed: 0.65,
    pocketDrift: 0.35, // pass-rush pair drift toward the QB (yd/s) at even strength
    runDrift: -0.45, // run-block drift (negative = defender driven back)
    driftSkill: 1.1, // drift += skill * (rusher - blocker)
    avoidBase: 0.08, // chance a defender slips a block attempt
    avoidSpeed: 0.35, // + (def speed - blocker speed) * this
    reengageCooldown: 1.0, // shed defender can't be re-blocked for this long
    beatenStumble: 0.7, // beaten pass blocker stumbles (s)
    blockSeekRange: 6, // free blockers look for defenders this close
  },

  // ---------------------------------------------------------------- pass rush / defense calls
  rush: {
    blitzChance: 0.35, // [D] 1-3 LBs blitz on ~35% of plays
    blitzCountWeights: [5, 3, 1], // 1, 2, 3 blitzers
    sackReach: 0.95, // free rusher within this of the QB = sack
    stripChance: 0.05, // sack fumble chance
  },

  // ---------------------------------------------------------------- coverage
  coverage: {
    readDelay: 0.42, // LB run/pass read (s) at step 6 (+ react scaling)
    dbRunRead: 0.65, // DBs keep backpedalling before they read run
    cushionDecay: 2.6, // off-coverage cushion closes at this rate (yd/s)
    trailCushion: 0.9, // man defender stays this far deeper than his receiver
    insideShade: 0.5,
    lookAhead: 0.22, // defenders aim this far ahead of the (delayed) receiver
    reactCoverSkill: 0.8, // reaction *= 1.4 - skill * coverage
    fsDepthOverDeepest: 6.5,
    hookDepth: 6.5,
    hookRange: 6,
    ballReactExtra: 0.06, // extra delay before breaking on a thrown ball
    breakRange: 20, // defenders within this of the landing point break on the ball
  },

  // ---------------------------------------------------------------- QB / throwing (MECHANICS 2.4)
  pass: {
    dropDepthCenter: 7.0, // yards behind LOS after the drop
    dropDepthShotgun: 7.0,
    dropSpeed: 5.0,
    releaseZ: 2.0, // ball height at release (yd)
    arriveZ: 1.7, // head-high at the landing target
    gravity: 10.7, // yd/s^2
    bulletGravity: 6.5, // flatter bullet arcs
    // horizontal ball speed: (base + perYd * dist) * (armBase + armSpan * arm)
    lobBase: 10.5,
    lobPerYd: 0.26,
    bulletBase: 19,
    bulletPerYd: 0.36,
    armSpeedBase: 0.86,
    armSpeedSpan: 0.28,
    minFlight: 0.22,
    // [D] max air distance = 22 + 4 * arm(1..10) = 26 + 36 * arm(0..1)
    maxDistBase: 26,
    maxDistSpan: 36,
    armFade: 0.12, // max arm loss late in game for a 0-stamina QB
    minThrow: 2.0,
    // [D] visible fraction = 0.35 + 0.65 * accuracy, minus difficulty trim
    visBase: 0.35,
    visSpan: 0.65,
    // [D] scatter +-1.5 yd at accuracy 0 down to +-0.2 yd at accuracy 1 (scaled by distance)
    scatterMax: 1.5,
    scatterMin: 0.2,
    scatterDistRef: 22, // scatter *= 0.55 + dist / (2 * ref)
    scatterPressure: 1.5, // scatter multiplier with a rusher within 2.5 yd
    bulletScatter: 0.85,
    pathSamples: 28,
    batChanceLob: 0.07, // DL/LB in the throwing lane at the line
    batChanceBullet: 0.025,
    batRange: 2.6,
    throwAnim: 0.3,
  },

  // ---------------------------------------------------------------- catching (MECHANICS 2.6)
  catch: {
    // [D] offense reach = 0.9 + 0.12 * catching(1..10) = 1.02 + 1.08 * hands
    offReachBase: 1.02,
    offReachSpan: 1.08,
    // [D] defense reach = 0.8 + 0.06 * skill(1..10) = 0.86 + 0.54 * coverage
    defReachBase: 0.86,
    defReachSpan: 0.54,
    reachZ: 2.75, // max catchable height (jumping)
    groundZ: 0.12,
    lookAheadT: 0.22, // closest-approach look-ahead when a player first gets in reach
    pCatchBase: 0.97,
    pCatchDist: 0.3, // - dist^2 term
    bulletPenalty: 0.03,
    bulletHands: 0.1, // * (1 - hands)
    underthrowPenalty: 0.3, // * (1 - hands) * |behind|
    fillerHands: 0.3, // below this, receivers only catch balls right in their path
    contestedPenalty: 0.2,
    contestedHands: 0.12, // + hands * this
    contestedRange: 1.3,
    rainPenalty: 0.04,
    snowPenalty: 0.03,
    dropDeflect: 0.25, // failed catch -> tipped (live) instead of dropped
    // defenders
    pIntBase: 0.15,
    pIntCover: 0.24,
    pIntDist: 0.55,
    pIntBullet: 0.05,
    pIntTipped: -0.12, // tipped balls are awkward to secure
    pDeflect: 0.5,
    deflectVz: [1.5, 3.0],
    deflectKeep: 0.25,
    adjustBase: 0.25, // intended receiver adjusts to the ball: base + hands * span
    adjustSpan: 0.6,
    offWeight: 1.35, // contest ordering weight for the intended receiver side
    catchFumble: 0.02, // fumble on catch when a defender is right there: * (1.6 - 1.2 hands)
    catchAnim: 0.3,
  },

  // ---------------------------------------------------------------- ball carrier (MECHANICS 3.1)
  carrier: {
    jukeDist: 1.2, // lateral distance of a full juke
    jukeTime: 0.22,
    jukeForward: 0.75, // forward speed kept during a juke
    jukeChain: [1.0, 0.7, 0.5, 0.35, 0.25], // diminishing returns
    jukeRecover: 0.8, // straight running to reset the chain
    jukeStamina: 0.015, // in-play top-speed loss per juke
    driftSpeed: 2.3,
    diveTime: 0.38,
    diveDistBase: 1.5, // + speed * diveDistSpan  (1.5-2.0 yd)
    diveDistSpan: 0.5,
    stutterTime: 0.4,
    stutterSpeed: 0.2,
    tauntClear: 4.0, // no defender within this -> taunt
    truckSpeed: 0.82,
    truckCharge: 0.45, // s to charge, * (1 + uses * truckChargeGrow) * nonStar
    truckChargeGrow: 0.6,
    truckNonStar: 1.35,
    truckBase: 0.5, // success = base + str * span - tackler tackling * tkl
    truckStr: 0.4,
    truckTkl: 0.3,
    truckBehind: 0.12, // extra tackle chance from behind while trucking
    proxRange: 1.25, // proximity slow-down
    proxSlow: 0.12,
    proxMin: 0.72,
    catchSpeedKeep: 0.6, // receivers gather themselves at the catch
    ballSpeed: 0.93, // carrying the ball costs a little top speed (lets pursuit close from behind)
    fatigueAfter: 2.4, // s of carrying before a long run starts to tire the carrier
    fatigueRate: 0.03, // top speed lost per second after that
    fatigueMin: 0.88,
    // automatic stiff-arm (Strength) / hurdle (Speed) with per-run budgets
    stiffBudgetHi: 0.75, // strength >= this -> 2 per run
    stiffBudgetLo: 0.48, // strength >= this -> 1
    hurdleBudgetHi: 0.8,
    hurdleBudgetLo: 0.5,
    stiffBase: 0.04,
    stiffStr: 0.42,
    stiffTkl: 0.3,
    hurdleBase: 0.05,
    hurdleSpd: 0.4,
    shakeSlow: 0.65, // speed multiplier right after breaking a tackle
    shakeTime: 0.35,
  },

  // ---------------------------------------------------------------- tackling (MECHANICS 3.2)
  tackle: {
    reach: 0.72, // contact distance
    lungeTime: 0.3,
    lungeBurst: 1.25, // lunge speed multiple of top speed
    lungeFrontDot: -1.01, // any angle; the intercept solver decides if the dive can get there
    lungeWindup: 0.1, // telegraph before the burst (defender commits his direction here)
    lungeWindupPerYd: 0.045, // longer dives telegraph longer: windup = max(base, perYd * dist)
    lungeWindupMax: 0.24,
    windupSpeed: 0.35, // frontal divers gather to this fraction of top speed during the windup
    lungeHoming: 1.2, // rad/s the committed dive can still bend toward the carrier
    jukeWindow: 0.28, // (min) a juke this soon after the dive starts - or any time before it lands - fools the diver
    jukedReach: 0.5, // contact reach vs a fooled diver = reach * (1 - jukedReach * jukeEff)
    lungeDelay: 0.06, // must be in range this long before lunging
    lungeClosing: 0.17, // lunge range grows by closing speed * this (head-on dives start earlier)
    lungeRangeMax: 4.0,
    whiffDown: 0.9, // recovery time on the turf after a whiff
    whiffDownVar: 0.3,
    brokenDown: 0.8,
    pBase: 0.9, // tackle prob = base + tkl * tackling - str * carrier strength
    pTkl: 0.08,
    pStr: 0.1,
    pBehind: 0.04,
    pGang: 0.06,
    pMin: 0.55,
    pMax: 0.985,
    fallForwardMax: 1.0, // carrier falls forward up to this many yards when hit going forward
    closeRange: 3.5, // pursuers this close to the carrier find an extra gear
    closeBurst: 1.08,
    pursuitMaxLead: 1.6,
    pursuitNoise: 0.25,
  },

  // ---------------------------------------------------------------- fumbles (MECHANICS 3.1)
  fumble: {
    // [D] base 1.2% per tackle * (1.6 - 0.12 * catching(1..10)) = * (1.48 - 1.08 * hands)
    base: 0.012,
    handsA: 1.48,
    handsB: 1.08,
    rain: 1.4,
    snow: 1.5,
    qbRun: 1.5,
    defRecover: 0.65, // [D]
  },

  // ---------------------------------------------------------------- kicking (MECHANICS 4.1)
  kick: {
    holdDepth: 7, // kick spot behind the LOS
    snapTime: 0.3,
    powerPeriod: 1.5, // power meter 0 -> 1 -> 0
    greenBand: 0.9, // power >= this = full range
    lowPowerFloor: 0.45, // power factor = floor + (1-floor) * (p/band)^powerExp below the band
    powerExp: 1.2,
    sweepDeg: 22, // [D] arrow sweep +-22 degrees
    sweepPeriodMin: 1.15, // accuracy 0 (fast arrow): ~100 ms good window at 44 yd, PAT ~80% for a filler K
    sweepPeriodMax: 2.15, // accuracy 1 (slow arrow)
    // [D] max distance = 38 + 2.8 * range(1..10) = 40.8 + 25.2 * kickPower
    rangeBase: 40.8,
    rangeSpan: 25.2,
    staminaFade: 0.12, // max range lost by the end of the game at 0 stamina
    staminaFadeFresh: 0.04, // ... at full stamina
    pressureLimit: 3.2, // [D] kick must be away this long after the snap
    releaseDelayMax: 0.4, // [D] Speed 1 -> 0.4 s, Speed 10 -> 0 s
    launchDeg: 34,
    gravity: 10.7,
    crossbarZ: 3.33, // 10 ft
    uprightHalf: 3.08, // 18.5 ft / 2
    uprightTop: 13.3,
    postX: 120,
    doinkBand: 0.22, // upright/crossbar collision band
    windLat: 0.055, // lateral accel (yd/s^2) per mph crosswind
    windLong: 0.005, // speed scale per mph head/tail wind
    flightPad: 0.7, // seconds the play stays live after the kick is decided
    patLosX: 95,
    missTurnoverMax: 90, // opponent takes over at spot of kick or their 20, whichever is better for them
  },

  // ---------------------------------------------------------------- kick returns (MECHANICS 4.3)
  kickoff: {
    kickX: 75, // opponent's 35 in the offense frame
    depthMin: 60, // [D] 60-72 yd from their 35
    depthMax: 72,
    hangMin: 3.7,
    hangMax: 4.3,
    approach: 0.6, // kicker run-up before the kick
    returnerX: 6,
    coverSpeed: 0.96, // coverage speed multiplier
    coverLaneHold: 0.55, // coverage keeps lanes until the ball is caught (fraction of lateral)
    blockerShed: 2.4,
    slipChance: 0.05, // coverage man slips a return block attempt
    wallDepth: [22, 13, 6], // return blockers set up this far in front of the catch (front/2nd/deep)
    engageBeforeCatch: 0.6, // blockers attack their man once the ball is this close to landing
    blockerShedVar: 0.35,
    touchbackX: 35, // own 25
    lateral: 9, // landing spread across the field (+- from centre)
  },

  // ---------------------------------------------------------------- results
  result: {
    intTouchbackX: 90, // end-zone INT -> opponent ball at their 20 (offense frame)
    intReturnMax: 12, // instant INT return yards (random 0..max, toward -x)
    hitPowerBase: 0.25, // injury-roll hit power = base + closing speed / 30 + 0.2 * tackler strength
  },
};

/** Defender difficulty helpers derived from the internal step 1..16. */
export function diffParams(step) {
  const D = TUNING.difficulty;
  const s = Math.max(1, Math.min(16, Number.isFinite(step) ? step : D.pivot));
  const k = s >= D.pivot ? D.slopeScale.above : D.slopeScale.below;
  const v = ([mid, per]) => mid + per * k * (s - D.pivot);
  let trim = 0;
  const pts = D.arcTrim;
  for (let i = 1; i < pts.length; i++) {
    const [s0, v0] = pts[i - 1];
    const [s1, v1] = pts[i];
    if (s >= s0 && s <= s1) trim = v0 + ((v1 - v0) * (s - s0)) / (s1 - s0);
    else if (s > s1) trim = v1;
  }
  return {
    step: s,
    defSpeed: v(D.defSpeed),
    react: Math.max(0.08, v(D.react)),
    lungeRange: v(D.lungeRange),
    tackleBonus: v(D.tackle),
    rushMult: v(D.rush),
    intBonus: v(D.int),
    catchBonus: v(D.catch),
    arcTrim: trim,
  };
}
