// Public franchise API (docs/ARCHITECTURE.md "FRANCHISE contract"). Pure, DOM-free functions over
// the plain-JSON Save object (mutated in place). Import from here:
//   import * as F from './src/franchise/index.js';

export * as CONFIG from './config.js';
export {
  START_YEAR, ROSTER, ATTR, STAR_WEIGHTS, CAP, SALARY, CC, FACILITIES, COORDINATORS, XP, MORALE, FANS,
  OWNER, DIFFICULTY, LEAGUE, ROUNDS, ROUND_LABELS, DRAFT, FREE_AGENCY, OFFSEASON_STEPS, OFFSEASON_LABELS,
  TRAITS, INJURY, RECORDS, WEATHER,
} from './config.js';

export { rngOf, commitRng, withRng, teamById, userTeam, roster, findPlayer, derivedRng } from './state.js';

export {
  POSITIONS, OFFENSE_POSITIONS, DEFENSE_POSITIONS, ATTRS, ATTR_LABELS, POS_LABELS, STAT_KEYS,
  stars, starsExact, weightedMean, attrSum, potentialStars, potentialLabel, canImprove, createPlayer,
  askingSalary, rookieSalary, demandYears, maxContractYears, fullName, shortName, moraleLabel,
  conditionLabel, starsText, injuryText, contractText, traitLabels, isInjured, emptyStats, attrToSkill,
} from './players.js';

export {
  createTeams, generateSchedule, standings, divisionStandings, playoffSeeds, playoffPicture, rankTeams,
  recordGame, recomputeRecords, winPct, recordText, streakText, gameWinner, gameLoser, isAlive, seedOf,
  roundLabel, conferenceName, divisionName, divisionRanks, CONFERENCES, DIVISIONS,
} from './league.js';

export { simulateGame, winProbability, difficultyRating } from './gameSim.js';

export {
  buildSquad, teamRatings, refreshUserRatings, depthChart, skillsFromAttrs, toSquadPlayer,
  performanceFactor, starsToUnit, OFFENSE_SLOTS, DEFENSE_SLOTS, SLOT_COUNTS,
} from './squad.js';

export {
  payroll, capUsage, capRoom, gameCc, contractDemand, canExtend, extendContract, releasePlayer,
  facilityUpgradeCost, upgradeFacility, facilitySummary, coordinatorCandidates, hireCoordinator,
  boostMorale, boostTeamMorale, rushTreatment, trainingXpMult, rehabInjuryMult, weeklyRecovery,
  releaseCost, canRushTreatment,
} from './economy.js';

export {
  xpForLevel, xpProgress, xpMultiplier, addXp, applySkillPoint, trainPlayer, retirementChance, hofScore, hofWorthy,
} from './progression.js';

export {
  TEMPLATES as NEWS_TEMPLATES, resolveNews, pendingNews, effectsText, choiceAvailable,
} from './news.js';

export { addHeadline, headlines } from './feed.js';

export {
  normalizeDifficulty, difficultyStep, difficultyInfo, setDifficulty,
} from './difficulty.js';

export {
  draftOrder, draftProspects, draftStatus, scoutProspect, draftPlayer, passPick, userOnClock,
} from './draft.js';

export { freeAgents, signFreeAgent, signingFee } from './freeAgency.js';

export {
  newFranchise, currentWeekGames, userGameThisWeek, nextUserGame, userWeekStatus, opponentOf,
  simulateOtherGames, applyUserGameResult, simulateUserGame, matchSetup, advanceWeek, expectedWins,
  offseasonSteps, currentOffseasonStep, offseasonData, runOffseasonStep, jobOffers, takeJob,
  hubSummary, careerHistory, resultLabel, previewLeague,
} from './season.js';
