// Free agency (MECHANICS §7.7): a pool of 10-14 stars, refreshed every 4 weeks in season and in
// the offseason. Signing needs cap room, a roster spot and a CC fee (= stars rounded up).

import { FREE_AGENCY, ROSTER } from './config.js';
import { createPlayer, stars, askingSalary, demandYears, maxContractYears, fullName, shortName, potentialLabel, emptyStats, assignFreeNumber } from './players.js';
import { clamp } from '../core/util.js';
import { roster, userTeam, fail } from './state.js';
import { capRoom, spendCc } from './economy.js';
import { refreshUserRatings } from './squad.js';
import { addHeadline } from './feed.js';

/** CC fee to sign: stars rounded up. */
export const signingFee = (p) => Math.ceil(stars(p));

/** Set the player's asking contract (`ask`) from his current stars/age/morale. */
export function setAsk(p) {
  p.ask = { salary: askingSalary(p), years: Math.min(demandYears(p.age), maxContractYears(p.age)) };
  return p.ask;
}

/** Generate one free agent. */
export function generateFreeAgent(save, rng, takenNames = null) {
  const posKeys = Object.keys(FREE_AGENCY.posWeights);
  const p = createPlayer(save, rng, {
    pos: rng.weighted(posKeys, posKeys.map((k) => FREE_AGENCY.posWeights[k])),
    stars: rng.weighted(FREE_AGENCY.stars.map((x) => x[0]), FREE_AGENCY.stars.map((x) => x[1])),
    age: rng.int(FREE_AGENCY.ageMin, FREE_AGENCY.ageMax),
    morale: 60,
    takenNames,
  });
  setAsk(p);
  p.contract = { ...p.ask };
  return p;
}

/**
 * Refresh the pool: keep ~30% of the current agents, add `departed` players, then fill to 10-14.
 * @param {Object[]} [departed]  players leaving the user team (they enter the pool)
 */
export function refreshFreeAgents(save, rng, departed = []) {
  const keep = (save.freeAgents || []).filter(() => rng.chance(FREE_AGENCY.keepFraction));
  const target = rng.int(FREE_AGENCY.min, FREE_AGENCY.max);
  for (const p of departed) { p.morale = clamp(p.morale, 30, 100); p.rookie = false; setAsk(p); }
  for (const p of keep) setAsk(p);
  const pool = [...departed, ...keep].slice(0, FREE_AGENCY.max);
  const taken = new Set([...roster(save), ...pool].map((p) => `${p.first} ${p.last}`));
  while (pool.length < target) {
    const p = generateFreeAgent(save, rng, taken);
    taken.add(`${p.first} ${p.last}`);
    pool.push(p);
  }
  save.freeAgents = pool;
  return pool;
}

/** Why the user can't sign this agent right now (null when he can). */
export function signBlocker(save, p) {
  const off = save.offseason;
  if (off && off.index <= off.steps.indexOf('contracts')) return { reason: 'wait', message: 'Free agency opens after contracts are settled.' };
  if (roster(save).length >= ROSTER.cap) return { reason: 'rosterFull', message: `Roster is full (${ROSTER.cap}).` };
  if (p.ask.salary > capRoom(save)) return { reason: 'cap', message: 'Not enough cap room.' };
  if (save.cc < signingFee(p)) return { reason: 'cc', message: `Need ${signingFee(p)} CC.` };
  return null;
}

/** Free-agent views for the UI. */
export function freeAgents(save) {
  return (save.freeAgents || []).map((p) => {
    const b = signBlocker(save, p);
    return {
      id: p.id,
      name: fullName(p),
      shortName: shortName(p),
      pos: p.pos,
      age: p.age,
      stars: stars(p),
      attrs: { ...p.attrs },
      traits: [...p.traits],
      potential: potentialLabel(p),
      salary: p.ask.salary,
      years: p.ask.years,
      maxYears: maxContractYears(p.age),
      fee: signingFee(p),
      canSign: !b,
      blocker: b ? b.message : null,
      player: p,
    };
  });
}

/**
 * Sign a free agent at his asking salary (optionally choosing 1..maxYears years).
 * @returns {{ok:true, player:Object, fee:number} | {ok:false, reason:string, message:string}}
 */
export function signFreeAgent(save, id, years = null) {
  const idx = (save.freeAgents || []).findIndex((p) => p.id === id);
  if (idx < 0) return fail('notFound', 'Free agent not available.');
  const p = save.freeAgents[idx];
  const b = signBlocker(save, p);
  if (b) return fail(b.reason, b.message);
  const fee = signingFee(p);
  spendCc(save, fee);
  p.contract = { salary: p.ask.salary, years: years ? clamp(Math.round(years), 1, maxContractYears(p.age)) : p.ask.years };
  delete p.ask;
  p.joined = save.season.year;
  p.seasons = 0;
  p.rookie = false;
  p.season = emptyStats();
  p.seasonXp = 0;
  save.freeAgents.splice(idx, 1);
  assignFreeNumber(save, p, userTeam(save).roster);
  userTeam(save).roster.push(p);
  refreshUserRatings(save);
  addHeadline(save, `${userTeam(save).city} sign ${p.pos} ${shortName(p)} (${stars(p)}★).`, 'signing');
  return { ok: true, player: p, fee };
}
