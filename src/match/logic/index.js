// Public entry point for the match logic (DOM-free). See docs/ARCHITECTURE.md "MATCH contract".
export { Match, downLabel, hashFrom, toOppFrame, fromOppFrame, ballOnToX, xToBallOn } from './Match.js';
export { simDrive, cpuConversion, spotLabelOpp, spotLabelUser } from './simDrive.js';
export { simulateGame } from './gameSim.js';
export { playModel } from './playModel.js';
export { autoStep, autoPlayMatch, runClock } from './autoplay.js';
export {
  CFG,
  DIFFICULTY_STEPS,
  HASH_Y,
  FIELD_MID_Y,
  simScale,
  timeoutsPerHalf,
  stepToDifficulty,
  simDifficultyBias,
  ratingToStars,
  kickerMaxFg,
  onsideChance,
} from './config.js';
