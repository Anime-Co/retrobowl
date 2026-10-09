// Season flow (MECHANICS §7): new franchise, week loop, applying the user's match result
// (stats, XP, CC, morale, condition, injuries, fans, owner confidence, dynamic difficulty,
// records, news), AI games, playoffs, the offseason pipeline (§7.8), firing and new jobs.

import {
  START_YEAR, ROSTER, START_ROSTER, CAP, CC, FANS, OWNER, MORALE, CONDITION, INJURY, TRAIT_EFFECTS,
  LEAGUE, OFFSEASON_STEPS, OFFSEASON_LABELS, DIFFICULTY, RECORDS, FACILITIES, FREE_AGENCY, ROUND_LABELS,
  WEATHER,
} from './config.js';
import { SAVE_VERSION } from '../core/storage.js';
import { Rng } from '../core/rng.js';
import { clamp } from '../core/util.js';
import { pickName } from '../data/names.js';
import {
  rngOf, commitRng, userTeam, teamById, roster, findPlayer, fail, round1, hashStr,
} from './state.js';
import { createPlayer, stars, shortName, fullName, emptyStats, isOffense } from './players.js';
import {
  createTeams, generateSchedule, recordGame, startPlayoffs, createPlayoffRound, completePlayoffRound,
  nextRound, isAlive, seedOf, divisionRanks, driftAiRatings, emptyRecord, clampRating, recordText,
  roundLabel,
} from './league.js';
import { simulateGame, winProbability, difficultyRating } from './gameSim.js';
import { depthChart, teamRatings, refreshUserRatings, buildSquad } from './squad.js';
import {
  gameCc, contractDemand, capUsage, makeCoordinator, generateCoordinatorMarket, hireCoordinator,
  spendCc, rehabInjuryMult, weeklyRecovery, stadiumFansMult, stadiumHomeEdge,
} from './economy.js';
import { rawGameXp, xpMultiplier, addXp, agePlayer, retirementChance, hofWorthy, hofScore } from './progression.js';
import { generateEvents, expireNews, leagueHeadlines } from './news.js';
import { addHeadline } from './feed.js';
import { normalizeDifficulty, difficultyStep, updateDynamicDifficulty } from './difficulty.js';
import { startDraft, finishDraft } from './draft.js';
import { refreshFreeAgents, signFreeAgent, setAsk } from './freeAgency.js';

/** @typedef {import('../types.js').Save} Save */
/** @typedef {import('../types.js').Game} Game */
/** @typedef {import('../types.js').MatchResult} MatchResult */

// ----------------------------------------------------------------------------- creation

function weightedStars(rng, table) {
  return rng.weighted(table.map((x) => x[0]), table.map((x) => x[1]));
}

/** Starting roster: 8-9 stars, mostly 1-2.5, always including a QB. */
function generateStartingRoster(save, rng) {
  const count = rng.int(ROSTER.startMin, ROSTER.startMax);
  const positions = [...START_ROSTER.core];
  while (positions.length < count) positions.push(rng.pick(START_ROSTER.extra));
  const takenNames = new Set();
  const takenNumbers = new Set();
  return positions.map((pos) => {
    const p = createPlayer(save, rng, {
      pos,
      stars: weightedStars(rng, pos === 'QB' ? START_ROSTER.qbStars : START_ROSTER.stars),
      age: rng.int(START_ROSTER.ageMin, START_ROSTER.ageMax),
      takenNames,
      takenNumbers,
      contractYears: rng.int(1, 4),
    });
    takenNames.add(`${p.first} ${p.last}`);
    takenNumbers.add(p.number);
    return p;
  });
}

/** Roster for a team the coach takes over: stars around the team's OFF/DEF, fitted under the cap. */
function generateTeamRoster(save, rng, team) {
  const count = rng.int(ROSTER.startMin, ROSTER.startMax + 1);
  const positions = ['QB', ...START_ROSTER.core.slice(1)];
  while (positions.length < count) positions.push(rng.pick(START_ROSTER.extra));
  const takenNames = new Set();
  const takenNumbers = new Set();
  const out = positions.map((pos) => {
    const base = isOffense(pos) ? team.off : team.def;
    const s = clamp(Math.round((base - 0.5 + rng.normal(0, 0.6)) * 2) / 2, 0.5, 4.5);
    const p = createPlayer(save, rng, { pos, stars: s, age: rng.int(23, 32), takenNames, takenNumbers, contractYears: rng.int(1, 4) });
    p.contract.salary = Math.max(500, Math.round((p.contract.salary * rng.float(0.7, 1.0)) / 100) * 100);
    takenNames.add(`${p.first} ${p.last}`);
    takenNumbers.add(p.number);
    return p;
  });
  const total = out.reduce((s, p) => s + p.contract.salary, 0);
  const limit = save.salaryCap * 0.85;
  if (total > limit) {
    const f = limit / total;
    for (const p of out) p.contract.salary = Math.max(500, Math.floor((p.contract.salary * f) / 100) * 100);
  }
  return out;
}

function legendName(rng) {
  const { first, last } = pickName(rng);
  return `${first} ${last}`;
}

/** Franchise record book seeded with fictional past legends. */
function seedRecords(save, rng) {
  const year = save.season.year;
  const rec = { game: {}, season: {}, career: {}, longestFg: null };
  for (const scope of ['game', 'season', 'career']) {
    for (const stat of Object.keys(RECORDS.stats)) {
      const [lo, hi] = RECORDS.baseline[scope][stat];
      rec[scope][stat] = { value: rng.int(lo, hi), name: legendName(rng), playerId: null, year: year - rng.int(1, 25) };
    }
  }
  const [lo, hi] = RECORDS.baseline.longestFg;
  rec.longestFg = { value: rng.int(lo, hi), name: legendName(rng), playerId: null, year: year - rng.int(1, 25) };
  return rec;
}

/** Expected wins for the owner (win probabilities compressed toward 0.5). */
export function expectedWins(save) {
  const u = save.userTeamId;
  const r = teamRatings(save, u);
  let e = 0;
  for (const g of save.season.schedule) {
    if (g.playoff || (g.home !== u && g.away !== u)) continue;
    e += expectedResult(save, g, r);
  }
  return round1(e);
}

/** Owner's expected result for a user game: difficulty-adjusted opponent, compressed toward 0.5. */
function expectedResult(save, g, r = teamRatings(save, save.userTeamId)) {
  const home = g.home === save.userTeamId;
  const t = teamById(save, home ? g.away : g.home);
  const step = difficultyStep(save);
  const opp = { off: difficultyRating(t.off, step), def: difficultyRating(t.def, step) };
  const edge = g.neutral ? 0 : home ? LEAGUE.homeEdge : -LEAGUE.homeEdge;
  const p = winProbability({ off: r.off, def: r.def }, opp, { homeEdge: edge });
  return 0.5 + (p - 0.5) * OWNER.expectationCompress;
}

/**
 * Start a new career.
 * @param {{coachName?:string, teamId?:string, seed?:number, difficulty?:string|number, year?:number}} opts
 * @returns {Save}
 */
export function newFranchise({ coachName = 'Coach', teamId, seed = 1, difficulty = 'dynamic', year = START_YEAR } = {}) {
  const s = (seed >>> 0) || 1;
  const rng = new Rng(s);
  const teams = createTeams(rng);
  const tid = teams.some((t) => t.id === teamId) ? teamId : teams[0].id;
  /** @type {Save} */
  const save = {
    version: SAVE_VERSION,
    seed: s,
    rngState: 0,
    nextId: 1,
    coach: { name: String(coachName || 'Coach').slice(0, 24), wins: 0, losses: 0, ties: 0, titles: 0, seasons: 0, playoffWins: 0, playoffApps: 0, firings: 0, teams: [tid] },
    userTeamId: tid,
    teams,
    season: { year, week: 1, phase: 'regular', schedule: [], playoffs: null, expectedWins: 0 },
    cc: CC.start,
    salaryCap: CAP.base,
    facilities: { stadium: 1, training: 1, rehab: 1 },
    fans: FANS.start,
    jobSecurity: OWNER.start,
    staff: { oc: null, dc: null },
    freeAgents: [],
    draft: null,
    news: [],
    history: [],
    difficulty: { mode: normalizeDifficulty(difficulty), step: DIFFICULTY.dynamicStart },
    deadMoney: 0,
    feed: [],
    records: null,
    hallOfFame: [],
    offseason: null,
    staffMarket: null,
    fired: null,
    divRanks: null,
  };
  const team = userTeam(save);
  team.roster = generateStartingRoster(save, rng);
  save.staff.oc = makeCoordinator(save, rng, 'oc', 1);
  save.staff.dc = makeCoordinator(save, rng, 'dc', 1);
  save.records = seedRecords(save, rng);
  refreshUserRatings(save);
  save.season.schedule = generateSchedule(save.teams, year, rng, null);
  save.season.expectedWins = expectedWins(save);
  refreshFreeAgents(save, rng);
  addHeadline(save, `${save.coach.name} takes charge in ${team.city}.`, 'team');
  generateEvents(save, rng, { preseason: true });
  commitRng(save, rng);
  return save;
}

// ----------------------------------------------------------------------------- week flow

const involvesUser = (save, g) => g.home === save.userTeamId || g.away === save.userTeamId;

/** All games of the current week. @returns {Game[]} */
export function currentWeekGames(save) {
  if (save.season.phase === 'offseason') return [];
  return save.season.schedule.filter((g) => g.week === save.season.week);
}

/** The user's game this week (played or not), or null (bye / eliminated / offseason). */
export function userGameThisWeek(save) {
  return currentWeekGames(save).find((g) => involvesUser(save, g)) || null;
}

/** Next unplayed user game (any week), or null. */
export function nextUserGame(save) {
  if (save.season.phase === 'offseason') return null;
  const games = save.season.schedule.filter((g) => !g.played && involvesUser(save, g));
  games.sort((a, b) => a.week - b.week);
  return games[0] || null;
}

/** 'game' (to play) | 'played' | 'bye' | 'eliminated' | 'offseason' */
export function userWeekStatus(save) {
  if (save.season.phase === 'offseason') return 'offseason';
  const g = userGameThisWeek(save);
  if (g) return g.played ? 'played' : 'game';
  if (save.season.phase === 'playoffs' && !isAlive(save, save.userTeamId)) return 'eliminated';
  return 'bye';
}

/** Opponent team of a game from the user's perspective. */
export function opponentOf(save, game) {
  return teamById(save, game.home === save.userTeamId ? game.away : game.home);
}

function simGame(save, rng, g) {
  const r = simulateGame(teamById(save, g.home), teamById(save, g.away), rng, { playoff: g.playoff, neutral: g.neutral });
  g.homeScore = r.homeScore;
  g.awayScore = r.awayScore;
  g.ot = r.ot;
  g.played = true;
  recordGame(save, g);
  return g;
}

function simWeek(save, rng) {
  const out = [];
  for (const g of currentWeekGames(save)) {
    if (g.played || involvesUser(save, g)) continue;
    out.push(simGame(save, rng, g));
  }
  return out;
}

/** Simulate every AI-vs-AI game of the current week. @returns {Game[]} newly played games */
export function simulateOtherGames(save) {
  const rng = rngOf(save);
  const out = simWeek(save, rng);
  commitRng(save, rng);
  return out;
}

// ------------------------------------------------------------------------- user results

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function addStats(target, stats) {
  for (const [k, v] of Object.entries(stats || {})) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    if (k === 'fgLong') target.fgLong = Math.max(target.fgLong || 0, v);
    else target[k] = (target[k] || 0) + v;
  }
}

/** Keep only finite numeric stats for players on the user roster. */
function sanitizeStats(save, stats) {
  const out = {};
  const ids = new Set(roster(save).map((p) => p.id));
  for (const [id, s] of Object.entries(stats || {})) {
    if (!ids.has(id) || !s || typeof s !== 'object') continue;
    const clean = {};
    for (const [k, v] of Object.entries(s)) if (typeof v === 'number' && Number.isFinite(v)) clean[k] = Math.round(v);
    out[id] = clean;
  }
  return out;
}

function touches(p, s) {
  s = s || {};
  switch (p.pos) {
    case 'QB': return num(s.passAtt) * CONDITION.qbPassAttFactor + num(s.rushAtt) + num(s.sacked);
    case 'RB': case 'WR': case 'TE': return num(s.rushAtt) + num(s.rec);
    case 'OL': return CONDITION.olImplicitTouches;
    case 'DL': case 'LB': case 'DB': return num(s.tackles) + num(s.sacks);
    default: return 0;
  }
}

function injuryRiskMult(p) {
  let m = 1;
  if (p.condition < INJURY.lowConditionFrom) m *= 1 + (INJURY.lowConditionFrom - p.condition) / INJURY.lowConditionDiv;
  if (p.traits.includes('ironman')) m *= TRAIT_EFFECTS.ironmanInjury;
  if (p.traits.includes('fragile')) m *= TRAIT_EFFECTS.fragileInjury;
  return m;
}

function injure(save, rng, p) {
  const seasonEnding = rng.chance(INJURY.seasonEndingChance);
  let weeks;
  let type;
  if (seasonEnding) {
    weeks = INJURY.seasonEndingWeeks;
    type = rng.pick(INJURY.seasonEndingTypes);
  } else {
    weeks = Math.max(1, Math.round(rng.weighted(INJURY.weeks, INJURY.weekWeights) * rehabInjuryMult(save)));
    type = rng.pick(INJURY.types);
  }
  p.injury = { weeks, type };
  return { playerId: p.id, weeks, type };
}

/**
 * Injury rolls (MECHANICS §6.5): ~0.6% per hit, scaled up by low condition. Uses
 * matchResult.hits [{playerId, power 0..1}] when given, otherwise touches + implicit contact.
 */
function rollInjuries(save, rng, mr, stats, starterIds) {
  const out = [];
  const hitsBy = new Map();
  if (Array.isArray(mr.hits) && mr.hits.length) {
    for (const h of mr.hits) {
      if (!h || typeof h.playerId !== 'string') continue;
      const arr = hitsBy.get(h.playerId) || [];
      arr.push(clamp(num(h.power ?? 0.5), 0, 1));
      hitsBy.set(h.playerId, arr);
    }
  }
  const useHits = hitsBy.size > 0 || (Array.isArray(mr.hits) && mr.hits.length > 0);
  for (const p of roster(save)) {
    if (p.injury) continue;
    const mult = injuryRiskMult(p);
    let pInj = 0;
    if (useHits) {
      let survive = 1;
      for (const power of hitsBy.get(p.id) || []) survive *= 1 - clamp(INJURY.perHit * mult * (0.5 + power), 0, 1);
      pInj = 1 - survive;
    } else {
      const starter = starterIds.has(p.id);
      if (!starter && !stats[p.id]) continue;
      const s = stats[p.id] || {};
      const n = num(s.rushAtt) + num(s.rec) + num(s.sacked) + num(s.tackles) + (starter ? INJURY.implicitHits[p.pos] || 0 : 0);
      pInj = 1 - Math.pow(1 - clamp(INJURY.perHit * mult, 0, 1), n);
    }
    if (pInj > 0 && rng.chance(pInj)) out.push(injure(save, rng, p));
  }
  return out;
}

function updateRecords(save, stats) {
  const broken = [];
  const check = (scope, stat, value, p) => {
    const rec = save.records[scope][stat];
    if (!(value > rec.value)) return;
    if (rec.playerId !== p.id || scope === 'game') {
      broken.push({ scope, stat, label: RECORDS.stats[stat], value, prev: rec.value, prevName: rec.name, playerId: p.id, name: fullName(p) });
    }
    save.records[scope][stat] = { value, name: fullName(p), playerId: p.id, year: save.season.year };
  };
  for (const p of roster(save)) {
    const s = stats[p.id] || {};
    for (const stat of Object.keys(RECORDS.stats)) {
      if (num(s[stat]) > 0) check('game', stat, num(s[stat]), p);
      if (num(p.season[stat]) > 0) check('season', stat, num(p.season[stat]), p);
      if (num(p.career[stat]) > 0) check('career', stat, num(p.career[stat]), p);
    }
    const lf = num(s.fgLong);
    if (lf > save.records.longestFg.value) {
      broken.push({ scope: 'game', stat: 'longestFg', label: 'Longest field goal', value: lf, prev: save.records.longestFg.value, prevName: save.records.longestFg.name, playerId: p.id, name: fullName(p) });
      save.records.longestFg = { value: lf, name: fullName(p), playerId: p.id, year: save.season.year };
    }
  }
  return broken;
}

const SCOPE_LABEL = { game: 'single-game', season: 'single-season', career: 'career' };

/**
 * Apply the user's finished match to the franchise.
 * @param {Save} save
 * @param {MatchResult & {hits?:{playerId:string, power?:number}[]}} mr
 * @returns {Object} PostGameSummary {gameId, won, lost, tie, userScore, oppScore, opponentId,
 *   playoff, round, ot, ccEarned, ccItems, xpGains, injuries, moraleChanges, teamMoraleDelta,
 *   fansDelta, jobSecurityDelta, difficulty:{from,to}, news, headlines, records, eliminated, champion}
 */
export function applyUserGameResult(save, mr) {
  const game = save.season.schedule.find((g) => g.id === mr.gameId);
  if (!game) throw new Error(`unknown game ${mr.gameId}`);
  if (!involvesUser(save, game)) throw new Error(`game ${game.id} is not the user's`);
  if (game.played) throw new Error(`game ${game.id} already played`);
  if (game.week !== save.season.week) throw new Error(`game ${game.id} is not this week's game`);
  const us = Math.max(0, Math.round(num(mr.userScore)));
  const them = Math.max(0, Math.round(num(mr.oppScore)));
  if (game.playoff && us === them) throw new Error('playoff games cannot end in a tie');

  const rng = rngOf(save);
  const team = userTeam(save);
  const userHome = game.home === team.id;
  const oppId = userHome ? game.away : game.home;
  const expected = game.playoff ? 0.5 : expectedResult(save, game);
  const chart = depthChart(team.roster);
  const starterIds = new Set(chart.starterIds);
  const benchIds = new Set(chart.bench.map((p) => p.id));

  game.homeScore = userHome ? us : them;
  game.awayScore = userHome ? them : us;
  game.ot = !!mr.ot;
  game.played = true;
  recordGame(save, game);

  const won = us > them;
  const lost = us < them;
  const tie = !won && !lost;
  const margin = us - them;
  if (won) save.coach.wins += 1;
  else if (lost) save.coach.losses += 1;
  else save.coach.ties += 1;
  if (game.playoff && won) save.coach.playoffWins += 1;

  // Stats
  const stats = sanitizeStats(save, mr.stats);
  let teamRushYds = 0;
  let teamPassTd = 0;
  for (const p of team.roster) {
    const s = stats[p.id];
    if (s) { teamRushYds += num(s.rushYds); teamPassTd += num(s.passTd); }
    if (starterIds.has(p.id) || s) {
      p.season.gp += 1;
      p.career.gp += 1;
      if (s) { addStats(p.season, s); addStats(p.career, s); }
    }
  }

  // XP
  const xpGains = [];
  let topId = null;
  let topXp = -1;
  for (const p of team.roster) {
    if (p.injury) continue;
    const starter = starterIds.has(p.id);
    if (!starter && !benchIds.has(p.id)) continue;
    const raw = rawGameXp(p, stats[p.id] || {}, { starter, won, teamRushYds, teamPassTd });
    const res = addXp(save, p, raw * xpMultiplier(save, p));
    xpGains.push({ playerId: p.id, xp: res.xp, levelUps: res.levelUps, points: res.points });
    if (raw > topXp && stats[p.id]) { topXp = raw; topId = p.id; }
  }

  // Condition drain for starters
  for (const p of team.roster) {
    if (!starterIds.has(p.id)) continue;
    const drain = (CONDITION.gameBase + touches(p, stats[p.id]) * CONDITION.perTouch) * (1.3 - CONDITION.staminaRelief * (p.attrs.stamina || 5)) + rng.float(-2, 2);
    p.condition = clamp(Math.round(p.condition - Math.max(0, drain)), 0, 100);
  }

  // Injuries
  const injuries = rollInjuries(save, rng, mr, stats, starterIds);
  const injuredIds = new Set(injuries.map((i) => i.playerId));

  // Morale
  const base = won ? MORALE.win : lost ? MORALE.loss : MORALE.tie;
  const leader = won && team.roster.some((p) => !p.injury && p.traits.includes('leader')) ? TRAIT_EFFECTS.leaderTeamMoraleOnWin : 0;
  const moraleChanges = [];
  for (const p of team.roster) {
    let d = base + leader;
    if (p.id === topId) d += MORALE.bigGame;
    if (starterIds.has(p.id) && ['RB', 'WR', 'TE'].includes(p.pos)) {
      const s = stats[p.id] || {};
      if (num(s.rushAtt) + num(s.rec) < MORALE.fewTouchesBelow) d += MORALE.fewTouches;
    }
    if (injuredIds.has(p.id)) d += MORALE.injured;
    if (p.traits.includes('hothead')) d *= TRAIT_EFFECTS.hotheadMorale;
    d = Math.round(d);
    const before = p.morale;
    p.morale = clamp(p.morale + d, 0, 100);
    if (p.morale !== before) moraleChanges.push({ playerId: p.id, delta: p.morale - before });
  }

  // CC
  const cc = gameCc(save, { won, margin, playoff: game.playoff, round: game.round, home: userHome && !game.neutral });
  save.cc += cc.total;

  // Fans
  let fd = won ? FANS.win : lost ? FANS.loss : 0;
  if (won && margin >= CC.bigWinMargin) fd += FANS.bigWin;
  if (won && userHome && !game.neutral) fd *= stadiumFansMult(save);
  if (!game.playoff && team.record.streak >= FANS.streakAt) fd += FANS.streak;
  if (!game.playoff && team.record.streak <= -FANS.streakAt) fd -= FANS.streak;
  if (game.playoff && won) fd += FANS.playoffWin;
  const champion = game.playoff && game.round === 'final' && won;
  if (champion) fd += FANS.title;
  const fansBefore = save.fans;
  save.fans = clamp(Math.round(save.fans + fd), 0, 100);

  // Owner confidence
  const jsBefore = save.jobSecurity;
  let jd = ((won ? 1 : tie ? 0.5 : 0) - expected) * OWNER.perGame;
  if (game.playoff && won) jd += OWNER.playoffWin;
  if (champion) jd += OWNER.title;
  save.jobSecurity = clamp(round1(save.jobSecurity + jd), 0, 100);

  // Dynamic difficulty
  const diff = updateDynamicDifficulty(save, won ? 'W' : lost ? 'L' : 'T');

  // Records
  const records = updateRecords(save, stats);

  // Feed
  const opp = teamById(save, oppId);
  const headlines = [];
  const label = game.playoff ? `${roundLabel(game.round)}: ` : '';
  headlines.push(addHeadline(save, won
    ? `${label}${team.city} beat ${opp.city} ${us}-${them}${game.ot ? ' in OT' : ''}.`
    : lost
      ? `${label}${team.city} fall to ${opp.city} ${them}-${us}${game.ot ? ' in OT' : ''}.`
      : `${team.city} and ${opp.city} tie ${us}-${them}.`, 'result'));
  for (const inj of injuries) {
    const p = findPlayer(save, inj.playerId);
    headlines.push(addHeadline(save, inj.weeks >= 20
      ? `${p.pos} ${shortName(p)} is out for the season (${inj.type.toLowerCase()}).`
      : `${p.pos} ${shortName(p)} out ${inj.weeks} week${inj.weeks === 1 ? '' : 's'} (${inj.type.toLowerCase()}).`, 'injury'));
  }
  for (const r of records) {
    headlines.push(addHeadline(save, `Team record! ${r.name}: ${r.value} ${r.label.toLowerCase()} (${SCOPE_LABEL[r.scope]}).`, 'record'));
  }
  if (!game.playoff && team.record.streak >= 4) headlines.push(addHeadline(save, `${team.city} have won ${team.record.streak} straight.`, 'streak'));
  if (game.playoff && lost) headlines.push(addHeadline(save, `${team.city}'s season ends in the ${roundLabel(game.round)}.`, 'team'));
  if (champion) headlines.push(addHeadline(save, `${team.city} win the ${LEAGUE.cupName}!`, 'team'));

  // News events (0-2)
  const news = generateEvents(save, rng, { post: true, won, lost, margin, us, them, oppId, stats, injuries, starters: chart.starterIds });

  refreshUserRatings(save);
  commitRng(save, rng);
  return {
    gameId: game.id,
    won,
    lost,
    tie,
    userScore: us,
    oppScore: them,
    opponentId: oppId,
    playoff: game.playoff,
    round: game.round,
    ot: game.ot,
    ccEarned: cc.total,
    ccItems: cc.items,
    xpGains,
    injuries,
    moraleChanges,
    teamMoraleDelta: base + leader,
    fansDelta: save.fans - fansBefore,
    jobSecurityDelta: round1(save.jobSecurity - jsBefore),
    difficulty: diff,
    news,
    headlines,
    records,
    eliminated: game.playoff && lost,
    champion,
  };
}

/**
 * Everything the match screen needs to start the user's game this week, shaped for MATCH's
 * `new Match({...})` options (add `settings: {quarterMinutes, difficultyStep, wind}` from the
 * player's settings). Returns null when there is no unplayed user game this week.
 */
export function matchSetup(save) {
  const g = userGameThisWeek(save);
  if (!g || g.played) return null;
  const t = userTeam(save);
  const opp = opponentOf(save, g);
  const chart = depthChart(roster(save));
  const qb = chart.slots.QB[0];
  const step = difficultyStep(save);
  const look = (x) => ({ id: x.id, abbr: x.abbr, city: x.city, colors: { ...x.colors } });
  const home = teamById(save, g.home);
  return {
    gameId: g.id,
    week: g.week,
    playoff: g.playoff,
    round: g.round,
    neutral: g.neutral,
    userTeam: look(t),
    oppTeam: look(opp),
    userSquad: buildSquad(save, t.id),
    oppSquad: buildSquad(save, opp.id),
    userIsHome: g.home === t.id,
    difficultyStep: step,
    difficulty: step <= 4 ? 0 : step <= 8 ? 1 : 2,
    userDefenders: ['DL', 'LB', 'DB'].flatMap((pos) => chart.slots[pos].filter(Boolean)).map((p) => ({ id: p.id, name: shortName(p), pos: p.pos, number: p.number })),
    audibles: clamp(1 + Math.floor((qb ? qb.level : 1) / 3), 1, 5),
    snowEligible: !g.neutral && WEATHER.northern.includes(home.id) && (g.playoff || g.week >= WEATHER.snowFromWeek),
    seed: hashStr(`${save.seed}|match|${g.id}`),
  };
}

// --------------------------------------------------------------------- auto-play (sim)

function poisson(rng, lambda) {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do { k += 1; p *= rng.next(); } while (p > L && k < 50);
  return k - 1;
}

/** Plausible per-player stats for an auto-simmed user game (stars only; fillers drop out). */
function synthUserStats(save, rng, my, their, chart, offStars) {
  const s = {};
  const add = (p, k, v) => {
    if (!p || !v) return;
    if (!s[p.id]) s[p.id] = {};
    s[p.id][k] = (s[p.id][k] || 0) + v;
  };
  const sl = chart.slots;
  const qb = sl.QB[0];
  const rb = sl.RB[0];
  const offTd = Math.max(0, my.td - my.defTd);
  let passTd = 0;
  let rushTd = 0;
  for (let i = 0; i < offTd; i++) { if (rng.chance(0.6)) passTd += 1; else rushTd += 1; }
  // Passing
  const passYds = Math.max(0, Math.round(rng.normal(150 + 28 * passTd + 15 * (offStars - 2.5), 40)));
  const cmp = Math.max(passTd, Math.round(passYds / rng.float(9, 13)));
  const att = Math.max(cmp, Math.round(cmp / rng.float(0.56, 0.72)));
  const ints = Math.min(my.turnovers, poisson(rng, 0.8));
  add(qb, 'passAtt', att);
  add(qb, 'passCmp', cmp);
  add(qb, 'passYds', passYds);
  add(qb, 'passTd', passTd);
  add(qb, 'int', ints);
  add(qb, 'sacked', poisson(rng, 1.8));
  // Receiving
  const targets = [sl.WR[0], sl.WR[1], sl.TE[0], sl.TE[1], rb];
  const tw = [0.32, 0.24, 0.16, 0.06, 0.14];
  const shares = [];
  let tot = 0;
  for (let i = 0; i < cmp; i++) { const w = rng.float(0.3, 1.7); shares.push(w); tot += w; }
  for (let i = 0; i < cmp; i++) {
    const r = rng.weighted(targets, tw);
    add(r, 'rec', 1);
    add(r, 'recYds', Math.round((passYds * shares[i]) / (tot || 1)));
  }
  for (let i = 0; i < passTd; i++) add(rng.weighted(targets, tw), 'recTd', 1);
  // Rushing
  const rushAtt = rng.int(16, 28);
  const rbAtt = Math.round(rushAtt * 0.75);
  const qbAtt = Math.round(rushAtt * 0.1);
  add(rb, 'rushAtt', rbAtt);
  add(rb, 'rushYds', Math.round(rbAtt * rng.normal(4.3, 1.1)));
  add(qb, 'rushAtt', qbAtt);
  add(qb, 'rushYds', Math.round(qbAtt * rng.normal(3.5, 2)));
  for (let i = 0; i < rushTd; i++) add(rng.chance(0.8) ? rb : qb, 'rushTd', 1);
  // Kicking
  const k = sl.K[0];
  if (k) {
    const misses = poisson(rng, 0.35);
    add(k, 'fgAtt', my.fg + misses);
    add(k, 'fgMade', my.fg);
    if (my.fg > 0) s[k.id].fgLong = rng.int(24, 50);
    add(k, 'patAtt', my.patAtt);
    add(k, 'patMade', my.patMade);
  }
  // Defense
  const defW = { DL: 0.06, LB: 0.13, DB: 0.08 };
  for (const pos of ['DL', 'LB', 'DB']) {
    for (const p of sl[pos]) if (p) add(p, 'tackles', Math.max(0, Math.round(rng.normal(55 * defW[pos], 1.6))));
  }
  const sacks = poisson(rng, 2.2);
  for (let i = 0; i < sacks; i++) add(rng.weighted([...sl.DL, ...sl.LB, ...sl.DB], [...sl.DL.map(() => 0.15), ...sl.LB.map(() => 0.1), ...sl.DB.map(() => 0.025)]), 'sacks', 1);
  const defInts = Math.round(their.turnovers * 0.6);
  for (let i = 0; i < defInts; i++) add(rng.weighted([...sl.LB, ...sl.DB], [...sl.LB.map(() => 0.1), ...sl.DB.map(() => 0.175)]), 'defInt', 1);
  return s;
}

/**
 * Auto-play the user's game this week with the abstract sim (difficulty applies to the
 * opponent). Returns a MatchResult for applyUserGameResult, or null when there is no game.
 * @returns {MatchResult|null}
 */
export function simulateUserGame(save) {
  const game = userGameThisWeek(save);
  if (!game || game.played) return null;
  const rng = rngOf(save);
  const userHome = game.home === save.userTeamId;
  const r = teamRatings(save);
  const me = { off: r.off, def: r.def };
  const opp = opponentOf(save, game);
  const res = simulateGame(userHome ? me : opp, userHome ? opp : me, rng, {
    difficultyStep: difficultyStep(save),
    userSide: userHome ? 'home' : 'away',
    playoff: game.playoff,
    neutral: game.neutral,
    homeEdge: LEAGUE.homeEdge + (userHome ? stadiumHomeEdge(save) : 0),
  });
  const my = userHome ? res.detail.home : res.detail.away;
  const their = userHome ? res.detail.away : res.detail.home;
  const stats = synthUserStats(save, rng, my, their, depthChart(roster(save)), r.off);
  commitRng(save, rng);
  return {
    gameId: game.id,
    userScore: userHome ? res.homeScore : res.awayScore,
    oppScore: userHome ? res.awayScore : res.homeScore,
    ot: res.ot,
    stats,
    log: [],
  };
}

// ------------------------------------------------------------------------- advancing

function weeklyUpkeep(save) {
  const rec = weeklyRecovery(save);
  for (const p of roster(save)) {
    p.condition = clamp(p.condition + rec, 0, 100);
    p.morale = clamp(Math.round(p.morale + (MORALE.driftTarget - p.morale) * MORALE.driftRate), 0, 100);
    if (p.injury) {
      p.injury.weeks -= 1;
      if (p.injury.weeks <= 0) {
        p.injury = null;
        addHeadline(save, `${p.pos} ${shortName(p)} is back from injury.`, 'injury');
      }
    }
  }
  save.fans = clamp(Math.round((save.fans + (FANS.start - save.fans) * FANS.weeklyDrift) * 10) / 10, 0, 100);
  refreshUserRatings(save);
}

function finishPlayoffsAndOffseason(save, rng, log) {
  let guard = 0;
  while (save.season.phase === 'playoffs' && guard++ < 10) {
    log.push(...simWeek(save, rng));
    const res = completePlayoffRound(save);
    if (res.done) break;
    createPlayoffRound(save, nextRound(res.round));
  }
  enterOffseason(save, rng);
}

/**
 * Finish the current week: sims remaining AI games, weekly upkeep (injuries, condition,
 * morale drift, FA refresh), then moves to the next week / playoffs / offseason. When the user
 * is out of the playoffs the rest of the bracket is simulated and the offseason starts.
 * @returns {{ok:true, phaseChanged:boolean, phase:string, week:number, results:Game[],
 *   champion?:string} | {ok:false, reason:string, message:string}}
 */
export function advanceWeek(save) {
  const phase0 = save.season.phase;
  if (phase0 === 'offseason') return fail('offseason', 'The season is over.');
  const ug = userGameThisWeek(save);
  if (ug && !ug.played) return fail('userGamePending', 'Play your game first.', { gameId: ug.id });
  const rng = rngOf(save);
  const results = simWeek(save, rng);
  leagueHeadlines(save, currentWeekGames(save));
  weeklyUpkeep(save);

  if (phase0 === 'regular') {
    if (save.season.week >= LEAGUE.regularWeeks) {
      startPlayoffs(save);
      const seed = seedOf(save, save.userTeamId);
      const t = userTeam(save);
      addHeadline(save, seed ? `${t.city} clinch the #${seed} seed.` : `${t.city} miss the playoffs at ${recordText(t.record)}.`, 'team');
      if (!isAlive(save, save.userTeamId)) finishPlayoffsAndOffseason(save, rng, results);
    } else {
      save.season.week += 1;
      if ((save.season.week - 1) % FREE_AGENCY.refreshWeeks === 0) refreshFreeAgents(save, rng);
    }
  } else {
    const res = completePlayoffRound(save);
    if (res.done) enterOffseason(save, rng);
    else {
      createPlayoffRound(save, nextRound(res.round));
      if (!isAlive(save, save.userTeamId)) finishPlayoffsAndOffseason(save, rng, results);
    }
  }
  expireNews(save);
  commitRng(save, rng);
  const pl = save.season.playoffs;
  return {
    ok: true,
    phaseChanged: save.season.phase !== phase0,
    phase: save.season.phase,
    week: save.season.week,
    results,
    champion: pl ? pl.champion : null,
  };
}

// ------------------------------------------------------------------------- offseason

function offScore(s) {
  return num(s.passYds) / 25 + num(s.passTd) * 4 - num(s.int) * 2 + num(s.rushYds) / 10 + num(s.rushTd) * 6
    + num(s.rec) * 0.5 + num(s.recYds) / 10 + num(s.recTd) * 6 + num(s.fgMade) * 3;
}
const defScore = (s) => num(s.tackles) + num(s.sacks) * 4 + num(s.defInt) * 5;

function seasonAwards(save, champion) {
  const r = roster(save).filter((p) => p.season.gp > 0);
  const awards = [];
  const best = (arr, f) => arr.reduce((b, p) => (!b || f(p) > f(b) ? p : b), null);
  const give = (p, award, detail) => {
    if (!p) return;
    awards.push({ award, playerId: p.id, name: fullName(p), pos: p.pos, detail });
    p.awards.push({ year: save.season.year, award });
    p.morale = clamp(p.morale + MORALE.awardBonus, 0, 100);
  };
  const mvp = best(r, (p) => p.seasonXp || 0);
  give(mvp, 'Team MVP', `${mvp ? mvp.seasonXp : 0} XP`);
  const offP = best(r.filter((p) => isOffense(p.pos) && offScore(p.season) > 0), (p) => offScore(p.season));
  if (offP) give(offP, 'Offensive Star', null);
  const defP = best(r.filter((p) => !isOffense(p.pos) && defScore(p.season) > 0), (p) => defScore(p.season));
  if (defP) give(defP, 'Defensive Star', `${defP.season.tackles} tkl, ${defP.season.sacks} sck, ${defP.season.defInt} int`);
  const roy = best(r.filter((p) => p.rookie), (p) => p.seasonXp || 0);
  if (roy) give(roy, 'Rookie of the Year', null);
  if (champion && mvp) give(mvp, 'Cup MVP', null);
  const t = userTeam(save);
  if (t.record.w >= 10 && t.record.w - save.season.expectedWins >= 3) {
    awards.push({ award: 'Coach of the Year', playerId: null, name: save.coach.name, pos: null, detail: `${recordText(t.record)}` });
  }
  return awards;
}

function enterOffseason(save, rng) {
  const pl = save.season.playoffs;
  const uid = save.userTeamId;
  const team = userTeam(save);
  const isChamp = pl.champion === uid;
  const seed = seedOf(save, uid);
  const result = isChamp ? 'champion' : pl.runnerUp === uid ? 'runnerUp' : pl.eliminated[uid] || 'missed';
  save.coach.seasons += 1;
  if (isChamp) save.coach.titles += 1;
  if (seed) save.coach.playoffApps += 1;

  const jsBefore = save.jobSecurity;
  let jd = seed ? OWNER.playoffBerth : OWNER.missedPlayoffs;
  jd += (save.fans - FANS.start) * OWNER.fansWeight;
  save.jobSecurity = clamp(round1(save.jobSecurity + jd), 0, 100);
  save.fans = clamp(Math.round(save.fans + (seed ? FANS.playoffBerth : FANS.missedPlayoffs)), 0, 100);

  for (const p of team.roster) {
    p.seasons += 1;
    if (isChamp) p.titles += 1;
    const s = stars(p);
    p.peakStars = Math.max(p.peakStars || 0, s);
    p.legacy = Math.round(((p.legacy || 0) + s * s) * 100) / 100;
  }
  const awards = seasonAwards(save, isChamp);
  const champT = teamById(save, pl.champion);
  const entry = {
    year: save.season.year,
    teamId: uid,
    abbr: team.abbr,
    city: team.city,
    w: team.record.w,
    l: team.record.l,
    t: team.record.t,
    pf: team.record.pf,
    pa: team.record.pa,
    seed,
    result,
    champion: pl.champion,
    championCity: champT.city,
    runnerUp: pl.runnerUp,
    expectedWins: save.season.expectedWins,
    awards,
    difficulty: difficultyStep(save),
  };
  save.history.push(entry);
  save.deadMoney = 0;
  save.season.phase = 'offseason';
  addHeadline(save, `${champT.city} win the ${LEAGUE.cupName}, beating ${teamById(save, pl.runnerUp).city}.`, 'league');
  save.offseason = {
    year: save.season.year,
    index: 0,
    steps: [...OFFSEASON_STEPS],
    data: {
      summary: {
        ...entry,
        resultLabel: resultLabel(result),
        jobSecurity: save.jobSecurity,
        jobSecurityDelta: round1(save.jobSecurity - jsBefore),
        atRisk: save.jobSecurity < OWNER.fireBelow && save.coach.seasons > OWNER.graceSeasons,
        coach: { ...save.coach },
      },
    },
  };
}

export function resultLabel(result) {
  switch (result) {
    case 'champion': return `${LEAGUE.cupName} champions`;
    case 'runnerUp': return `Lost the ${LEAGUE.cupName}`;
    case 'missed': return 'Missed the playoffs';
    default: return `Lost in the ${ROUND_LABELS[result] || result}`;
  }
}

/** Offseason pipeline with status for the UI. @returns {{id:string, label:string, done:boolean, current:boolean}[]} */
export function offseasonSteps(save) {
  const off = save.offseason;
  if (!off) return [];
  return off.steps.map((id, i) => ({ id, label: OFFSEASON_LABELS[id], done: i < off.index, current: i === off.index }));
}

/** Current offseason step id (or null). */
export function currentOffseasonStep(save) {
  return save.offseason ? save.offseason.steps[save.offseason.index] || null : null;
}

/** Data prepared for the current step (retirements list, expiring contracts with demands, ...). */
export function offseasonData(save, step = currentOffseasonStep(save)) {
  return save.offseason ? save.offseason.data[step] ?? null : null;
}

function prepareStep(save, rng, step) {
  const d = save.offseason.data;
  const r = roster(save);
  switch (step) {
    case 'retirements':
      d.retirements = r.filter((p) => rng.chance(retirementChance(p))).map((p) => ({
        playerId: p.id, name: fullName(p), pos: p.pos, age: p.age, stars: stars(p), seasons: p.seasons, hallOfFame: hofWorthy(p),
      }));
      break;
    case 'contracts':
      d.contracts = r.filter((p) => p.contract.years <= 1).map((p) => ({
        playerId: p.id, name: fullName(p), pos: p.pos, age: p.age, stars: stars(p), current: p.contract.salary, demand: contractDemand(save, p),
      }));
      break;
    case 'facilities':
      d.facilities = FACILITIES.kinds.filter((k) => save.facilities[k] > 1).map((k) => ({
        kind: k, label: FACILITIES.labels[k], level: save.facilities[k], cost: FACILITIES.maintainCost, decayChance: FACILITIES.decayChance,
      }));
      break;
    case 'staff':
      generateCoordinatorMarket(save, rng);
      d.staff = {
        expiring: ['oc', 'dc'].filter((role) => save.staff[role] && save.staff[role].years <= 1 && save.staff[role].hiredOffseason !== save.offseason.year),
        current: { oc: save.staff.oc, dc: save.staff.dc },
      };
      break;
    case 'draft':
      startDraft(save, rng);
      d.draft = { started: true };
      break;
    case 'freeAgency':
      refreshFreeAgents(save, rng, d.departed || []);
      d.departed = [];
      d.freeAgency = { poolSize: save.freeAgents.length };
      break;
    default:
      break;
  }
}

function fire(save, rng) {
  const uid = save.userTeamId;
  const pool = save.teams.filter((t) => t.id !== uid)
    .sort((a, b) => (a.off + a.def) - (b.off + b.def) || (a.id < b.id ? -1 : 1))
    .slice(0, OWNER.offerPool)
    .map((t) => t.id);
  const offers = rng.shuffle(pool).slice(0, OWNER.offers);
  save.fired = { year: save.season.year, fromTeam: uid, offers };
  save.coach.firings += 1;
  addHeadline(save, `${userTeam(save).city} part ways with coach ${save.coach.name}.`, 'team');
  return offers;
}

const RUNNERS = {
  summary(save, rng) {
    const fired = save.jobSecurity < OWNER.fireBelow && save.coach.seasons > OWNER.graceSeasons;
    if (fired) return { fired: true, offers: fire(save, rng) };
    return { fired: false };
  },
  retirements(save) {
    const team = userTeam(save);
    const out = [];
    for (const r of save.offseason.data.retirements || []) {
      const p = team.roster.find((x) => x.id === r.playerId);
      if (!p) continue;
      team.roster = team.roster.filter((x) => x !== p);
      const hof = hofWorthy(p);
      if (hof) {
        save.hallOfFame.push({
          playerId: p.id, name: fullName(p), pos: p.pos, inducted: save.season.year, seasons: p.seasons,
          peakStars: p.peakStars, titles: p.titles, score: hofScore(p), career: { ...p.career }, awards: p.awards.length,
        });
        addHeadline(save, `${fullName(p)} retires and heads to the Hall of Fame.`, 'award');
      } else {
        addHeadline(save, `${p.pos} ${shortName(p)} retires at ${p.age}.`, 'team');
      }
      out.push({ playerId: p.id, name: fullName(p), hallOfFame: hof });
    }
    refreshUserRatings(save);
    return { retired: out };
  },
  contracts(save, rng, choice) {
    const team = userTeam(save);
    // Recomputed now: players extended or released since the step was prepared are handled.
    const list = team.roster.filter((p) => p.contract.years <= 1).map((p) => ({ playerId: p.id }));
    let want = choice && choice.resign;
    if (Array.isArray(want)) want = Object.fromEntries(want.map((id) => [id, null]));
    want = want || {};
    const expiringIds = new Set(list.map((c) => c.playerId));
    let used = team.roster.filter((p) => !expiringIds.has(p.id)).reduce((s, p) => s + p.contract.salary, 0) + (save.deadMoney || 0);
    const resigned = [];
    const failed = [];
    const departed = [];
    for (const p of team.roster) if (!expiringIds.has(p.id)) p.contract.years = Math.max(1, p.contract.years - 1);
    for (const c of list) {
      const p = team.roster.find((x) => x.id === c.playerId);
      if (!p) continue;
      if (Object.prototype.hasOwnProperty.call(want, p.id)) {
        const d = contractDemand(save, p);
        if (!d.willing) failed.push({ playerId: p.id, reason: 'refuses' });
        else if (used + d.salary > save.salaryCap) failed.push({ playerId: p.id, reason: 'cap' });
        else {
          const years = clamp(Math.round(want[p.id] ?? d.years), 1, d.maxYears);
          p.contract = { salary: d.salary, years };
          used += d.salary;
          resigned.push({ playerId: p.id, salary: d.salary, years });
          addHeadline(save, `${p.pos} ${shortName(p)} re-signs (${years} yr${years === 1 ? '' : 's'}).`, 'signing');
          continue;
        }
      }
      departed.push(p);
    }
    team.roster = team.roster.filter((p) => !departed.includes(p));
    for (const p of departed) addHeadline(save, `${p.pos} ${shortName(p)} leaves in free agency.`, 'signing');
    save.offseason.data.departed = departed;
    refreshUserRatings(save);
    return { resigned, failed, departed: departed.map((p) => ({ playerId: p.id, name: fullName(p) })) };
  },
  progression(save, rng) {
    const changes = [];
    for (const p of roster(save)) {
      changes.push({ ...agePlayer(rng, p), name: fullName(p) });
      p.condition = 100;
      p.injury = null;
      p.morale = clamp(Math.round(p.morale + (MORALE.driftTarget - p.morale) * MORALE.offseasonDrift), 0, 100);
      if (p.seasons >= 1) p.rookie = false;
    }
    for (const p of save.freeAgents) { p.age += 1; setAsk(p); }
    for (const p of save.offseason.data.departed || []) p.age += 1;
    refreshUserRatings(save);
    return { changes };
  },
  facilities(save, rng, choice) {
    const maintain = new Set((choice && choice.maintain) || []);
    const maintained = [];
    const decayed = [];
    for (const k of FACILITIES.kinds) {
      const lvl = save.facilities[k];
      if (lvl <= 1) continue;
      if (maintain.has(k) && spendCc(save, FACILITIES.maintainCost)) { maintained.push(k); continue; }
      if (rng.chance(FACILITIES.decayChance)) {
        save.facilities[k] = lvl - 1;
        decayed.push({ kind: k, from: lvl, to: lvl - 1 });
        addHeadline(save, `${FACILITIES.labels[k]} drops to level ${lvl - 1} after a year without upkeep.`, 'team');
      }
    }
    return { maintained, decayed };
  },
  staff(save, rng, choice) {
    const hired = [];
    if (choice && choice.hire) {
      for (const role of ['oc', 'dc']) {
        if (!choice.hire[role]) continue;
        const r = hireCoordinator(save, role, choice.hire[role]);
        if (r.ok) hired.push(role);
      }
    }
    const left = [];
    for (const role of ['oc', 'dc']) {
      const c = save.staff[role];
      if (!c || c.hiredOffseason === save.offseason.year) continue;
      c.years -= 1;
      if (c.years <= 0) {
        left.push({ role, name: c.name });
        save.staff[role] = null;
        addHeadline(save, `${role === 'oc' ? 'Offensive' : 'Defensive'} coordinator ${c.name} leaves as his contract ends.`, 'staff');
      }
    }
    save.staffMarket = null;
    refreshUserRatings(save);
    return { hired, left };
  },
  draft(save, rng) {
    const picks = finishDraft(save, rng);
    return { picks };
  },
  freeAgency(save, rng, choice) {
    const signed = [];
    for (const id of (choice && choice.sign) || []) {
      const r = signFreeAgent(save, id);
      if (r.ok) signed.push(id);
    }
    return { signed };
  },
  newSeason(save, rng) {
    startNewSeason(save, rng);
    return { year: save.season.year };
  },
};

function startNewSeason(save, rng) {
  const ranks = divisionRanks(save);
  driftAiRatings(save, rng);
  save.season.year += 1;
  save.salaryCap += CAP.perSeason;
  for (const t of save.teams) t.record = emptyRecord();
  save.divRanks = ranks;
  save.season.schedule = generateSchedule(save.teams, save.season.year, rng, ranks);
  save.season.week = 1;
  save.season.phase = 'regular';
  save.season.playoffs = null;
  for (const p of roster(save)) {
    p.season = emptyStats();
    p.seasonXp = 0;
    p.rushWeek = null;
  }
  save.draft = null;
  save.staffMarket = null;
  save.offseason = null;
  save.jobSecurity = clamp(round1(save.jobSecurity + (50 - save.jobSecurity) * OWNER.seasonReversion), 0, 100);
  refreshUserRatings(save);
  save.season.expectedWins = expectedWins(save);
  addHeadline(save, `The ${save.season.year} season kicks off.`, 'league');
  generateEvents(save, rng, { preseason: true });
}

/**
 * Run the current offseason step and prepare the next one.
 * Choices: contracts {resign: id[] | {id: years}}, facilities {maintain: kind[]},
 * staff {hire: {oc?: candidateId, dc?: candidateId}}, freeAgency {sign: id[]}; others none.
 * While fired (save.fired) the pipeline waits for takeJob().
 * @returns {{ok:true, step:string, result:Object, next:string|null} | {ok:false, reason:string, message:string}}
 */
export function runOffseasonStep(save, step = null, choice = null) {
  const off = save.offseason;
  if (!off) return fail('notOffseason', 'Not in the offseason.');
  if (save.fired) return fail('fired', 'You were fired. Take a new job first.');
  const cur = off.steps[off.index];
  if (step && step !== cur) return fail('wrongStep', `Current step is ${cur}.`, { expected: cur });
  const rng = rngOf(save);
  const result = RUNNERS[cur](save, rng, choice);
  let next = null;
  if (cur !== 'newSeason') {
    off.index += 1;
    next = off.steps[off.index] || null;
    if (next && !save.fired) prepareStep(save, rng, next);
  }
  commitRng(save, rng);
  return { ok: true, step: cur, result, next };
}

// -------------------------------------------------------------------------- firing

/** Job offers after a firing ([] when not fired). */
export function jobOffers(save) {
  if (!save.fired) return [];
  return save.fired.offers.map((id) => {
    const t = teamById(save, id);
    return { teamId: id, city: t.city, abbr: t.abbr, off: t.off, def: t.def, record: recordText(t.record) };
  });
}

/**
 * Accept a job offer after being fired: the coach keeps his career record, history and Hall of
 * Fame; the new team brings its own generated roster, facilities and staff.
 */
export function takeJob(save, teamId) {
  if (!save.fired) return fail('notFired', 'You have a job.');
  if (!save.fired.offers.includes(teamId)) return fail('notOffered', 'No offer from that team.');
  const rng = rngOf(save);
  const old = userTeam(save);
  const r = teamRatings(save, old.id);
  old.off = clampRating(r.off);
  old.def = clampRating(r.def);
  delete old.roster;
  const nt = teamById(save, teamId);
  save.userTeamId = teamId;
  save.coach.teams.push(teamId);
  nt.roster = generateTeamRoster(save, rng, nt);
  save.facilities = { stadium: rng.int(1, 2), training: rng.int(1, 2), rehab: rng.int(1, 2) };
  save.staff = { oc: makeCoordinator(save, rng, 'oc', rng.int(1, 2)), dc: makeCoordinator(save, rng, 'dc', rng.int(1, 2)) };
  if (save.offseason) for (const role of ['oc', 'dc']) save.staff[role].hiredOffseason = save.offseason.year;
  save.fans = FANS.start;
  save.jobSecurity = OWNER.newJob;
  save.deadMoney = 0;
  save.records = seedRecords(save, rng);
  for (const n of save.news) if (!n.resolved) { n.resolved = true; n.choice = -1; n.reply = 'No response.'; }
  save.fired = null;
  refreshUserRatings(save);
  addHeadline(save, `${save.coach.name} is the new head coach in ${nt.city}.`, 'team');
  if (save.offseason) {
    const step = currentOffseasonStep(save);
    if (step) prepareStep(save, rng, step);
  }
  commitRng(save, rng);
  return { ok: true, team: nt };
}

// ---------------------------------------------------------------------------- overview

/** Compact hub summary for the UI. */
export function hubSummary(save) {
  const t = userTeam(save);
  const r = teamRatings(save);
  const next = nextUserGame(save);
  return {
    team: { id: t.id, city: t.city, abbr: t.abbr, colors: t.colors },
    year: save.season.year,
    week: save.season.week,
    phase: save.season.phase,
    record: recordText(t.record),
    ratings: r,
    cc: save.cc,
    fans: Math.round(save.fans),
    jobSecurity: Math.round(save.jobSecurity),
    cap: capUsage(save),
    rosterCount: roster(save).length,
    rosterCap: ROSTER.cap,
    nextGame: next ? { id: next.id, week: next.week, home: next.home === t.id, opponent: opponentOf(save, next).id, playoff: next.playoff, round: next.round } : null,
    status: userWeekStatus(save),
    pendingNews: (save.news || []).filter((n) => !n.resolved).length,
    skillPoints: roster(save).reduce((s, p) => s + (p.skillPoints || 0), 0),
  };
}

/** Career / franchise history rows (newest first). */
export function careerHistory(save) {
  return [...save.history].reverse().map((h) => ({ ...h, resultLabel: resultLabel(h.result) }));
}

