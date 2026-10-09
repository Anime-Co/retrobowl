// Player progression (MECHANICS §6.3-6.4): XP from production, level-ups that grant skill points,
// spending points on attributes (capped by hidden potential), offseason aging, decline,
// retirement and Hall of Fame scoring.

import { XP, AGING, RETIREMENT, ATTR, TRAIT_EFFECTS, COORDINATORS, HOF, STAR_WEIGHTS } from './config.js';
import { ATTRS, attrSum, stars, isOffense, shortName } from './players.js';
import { trainingXpMult } from './economy.js';
import { findPlayer, fail } from './state.js';
import { refreshUserRatings } from './squad.js';

/** XP needed to go from `level` to level + 1: 100 x level^0.8. */
export const xpForLevel = (level) => Math.round(XP.base * Math.pow(level, XP.exp));

/** Total multiplier: training facility x coordinator x age x trait. */
export function xpMultiplier(save, p) {
  let m = trainingXpMult(save);
  const coord = isOffense(p.pos) ? save.staff.oc : save.staff.dc;
  if (coord) m *= 1 + COORDINATORS.xpPerStar * coord.stars;
  if (p.age < XP.youngUnder) m *= XP.youngMult;
  else if (p.age > XP.oldOver) m *= XP.oldMult;
  if ((p.traits || []).includes('learner')) m *= TRAIT_EFFECTS.learnerXp;
  return m;
}

/**
 * Base XP for one game before multipliers.
 * @param {import('../types.js').Player} p
 * @param {Object<string, number>} stats  this player's game stats
 * @param {{starter:boolean, won:boolean, teamRushYds?:number, teamPassTd?:number}} ctx
 */
export function rawGameXp(p, stats, ctx) {
  let xp = ctx.starter ? XP.starterAppearance : XP.benchAppearance;
  if (ctx.won) xp += XP.win;
  for (const [k, rate] of Object.entries(XP.rates)) {
    const v = stats && Number.isFinite(stats[k]) ? stats[k] : 0;
    xp += rate * v;
  }
  if (p.pos === 'OL' && ctx.starter) xp += XP.olPerTeamRushYd * (ctx.teamRushYds || 0) + XP.olPerTeamPassTd * (ctx.teamPassTd || 0);
  return Math.max(0, xp);
}

/** Room left for skill points (potential and the 10-cap). */
function pointRoom(p) {
  const capRoom = ATTRS[p.pos].reduce((s, k) => s + (ATTR.max - p.attrs[k]), 0);
  return Math.min(p.potential - attrSum(p), capRoom) - (p.skillPoints || 0);
}

/**
 * Add XP and process level-ups. A level-up grants a skill point while the player is below his
 * potential (levels still count for experience-based mechanics such as audibles).
 * @returns {{xp:number, levelUps:number, points:number}}
 */
export function addXp(save, p, amount) {
  const xp = Math.max(0, Math.round(amount));
  p.xp += xp;
  p.seasonXp = (p.seasonXp || 0) + xp;
  let levelUps = 0;
  let points = 0;
  let guard = 0;
  while (p.xp >= xpForLevel(p.level) && guard++ < 50) {
    p.xp -= xpForLevel(p.level);
    p.level += 1;
    levelUps += 1;
    if (pointRoom(p) > 0) {
      p.skillPoints += 1;
      points += 1;
    }
  }
  return { xp, levelUps, points };
}

/** Progress toward the next level 0..1 (UI XP bar). */
export const xpProgress = (p) => Math.min(1, p.xp / xpForLevel(p.level));

/**
 * Spend one skill point: +1 to an attribute (max 10, total capped by hidden potential).
 * @returns {{ok:true, attr:string, value:number, stars:number} | {ok:false, reason:string, message:string}}
 */
export function applySkillPoint(save, playerId, attr) {
  const p = findPlayer(save, playerId);
  if (!p) return fail('notFound', 'Player not found.');
  if (!(p.skillPoints > 0)) return fail('noPoints', `${shortName(p)} has no skill points.`);
  if (!ATTRS[p.pos].includes(attr)) return fail('badAttr', `${attr} is not a ${p.pos} attribute.`);
  if (p.attrs[attr] >= ATTR.max) return fail('maxed', 'That attribute is maxed.');
  if (attrSum(p) >= p.potential) return fail('potential', `${shortName(p)} has reached his potential.`);
  p.attrs[attr] += 1;
  p.skillPoints -= 1;
  p.peakStars = Math.max(p.peakStars || 0, stars(p));
  refreshUserRatings(save);
  return { ok: true, attr, value: p.attrs[attr], stars: stars(p) };
}

/** Alias used by ARCHITECTURE.md. */
export const trainPlayer = applySkillPoint;

function bump(rng, p, dir) {
  const keys = ATTRS[p.pos].filter((k) => (dir > 0 ? p.attrs[k] < ATTR.max : p.attrs[k] > ATTR.min));
  if (!keys.length) return null;
  const k = rng.weighted(keys, keys.map((x) => STAR_WEIGHTS[p.pos][x] + 0.1));
  p.attrs[k] += dir;
  return k;
}

function lower(p, k) {
  if (p.attrs[k] > ATTR.min) { p.attrs[k] -= 1; return k; }
  return null;
}

/**
 * Offseason aging for one player: age +1, natural growth for young players, decline after 30
 * (kickers 4 years later): Stamina plus Strength or Speed (QB: Arm or Speed; K: Range or Speed).
 * @returns {{playerId:string, age:number, starsBefore:number, starsAfter:number, changes:Object<string,number>}}
 */
export function agePlayer(rng, p) {
  const before = { ...p.attrs };
  const starsBefore = stars(p);
  p.age += 1;
  let growth = 0;
  for (const [maxAge, pts] of AGING.growth) {
    if (p.age <= maxAge) { growth = pts; break; }
  }
  if (!growth && p.age <= AGING.midGrowthMaxAge && rng.chance(AGING.midGrowthChance)) growth = 1;
  for (let i = 0; i < growth; i++) {
    if (attrSum(p) + (p.skillPoints || 0) >= p.potential) break;
    bump(rng, p, 1);
  }
  const effAge = p.age - (p.pos === 'K' ? AGING.kickerExtraYears : 0);
  if (effAge > AGING.declineOver) {
    lower(p, 'stamina');
    const alt = p.pos === 'QB' ? ['arm', 'speed'] : p.pos === 'K' ? ['range', 'speed'] : ['strength', 'speed'];
    lower(p, rng.pick(alt));
    if (effAge >= AGING.steepDeclineFrom) bump(rng, p, -1);
  }
  const changes = {};
  for (const k of ATTRS[p.pos]) if (p.attrs[k] !== before[k]) changes[k] = p.attrs[k] - before[k];
  p.peakStars = Math.max(p.peakStars || 0, stars(p));
  return { playerId: p.id, age: p.age, starsBefore, starsAfter: stars(p), changes };
}

/** Chance a player retires this offseason (MECHANICS §6.4). */
export function retirementChance(p) {
  const effAge = p.age - (p.pos === 'K' ? AGING.kickerExtraYears : 0);
  if (effAge >= RETIREMENT.forceAge) return 1;
  let c = RETIREMENT.byAge[effAge] ?? (effAge > 36 ? RETIREMENT.byAge[36] : 0);
  if (p.age >= 30 && stars(p) <= RETIREMENT.lowStarsAt) c += RETIREMENT.lowStarBonus;
  return Math.min(1, c);
}

/** Hall of Fame score: legacy points (sum of stars^2 per season) + awards + titles. */
export function hofScore(p) {
  return Math.round((p.legacy || 0) + HOF.perAward * (p.awards ? p.awards.length : 0) + HOF.perTitle * (p.titles || 0));
}

export function hofWorthy(p) {
  return hofScore(p) >= HOF.minScore || ((p.peakStars || 0) >= HOF.peakStars && (p.seasons || 0) >= HOF.peakSeasons);
}
