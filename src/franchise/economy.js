// Economy (MECHANICS §6.6, §7.2-7.4): coaching credits, salary cap, contracts, releases,
// facilities, coordinators, morale boosts and rush treatment.

import {
  SALARY, FACILITIES, COORDINATORS, MORALE, INJURY, CC, CONDITION, LEAGUE,
} from './config.js';
import { askingSalary, maxContractYears, demandYears, shortName } from './players.js';
import { pickName } from '../data/names.js';
import { clamp } from '../core/util.js';
import { roster, findPlayer, userTeam, newId, fail } from './state.js';
import { refreshUserRatings } from './squad.js';
import { addHeadline } from './feed.js';

/** @typedef {import('../types.js').Save} Save */

// ------------------------------------------------------------------------------------ cap

/** Sum of user roster salaries ($K). */
export function payroll(save) {
  return roster(save).reduce((s, p) => s + p.contract.salary, 0);
}

/** @returns {{payroll:number, deadMoney:number, used:number, cap:number, room:number}} $K */
export function capUsage(save) {
  const pay = payroll(save);
  const dead = save.deadMoney || 0;
  return { payroll: pay, deadMoney: dead, used: pay + dead, cap: save.salaryCap, room: save.salaryCap - pay - dead };
}

export const capRoom = (save) => capUsage(save).room;
export const rosterSpace = (save, cap) => cap - roster(save).length;

export function spendCc(save, n) {
  if (save.cc < n) return false;
  save.cc -= n;
  return true;
}

/** CC earned for a user game (MECHANICS §7.2). */
export function gameCc(save, { won, margin, playoff, round, home }) {
  const items = [{ label: 'Game played', cc: CC.perGame }];
  if (won) {
    items.push({ label: 'Win', cc: CC.win });
    if (margin >= CC.bigWinMargin) items.push({ label: `Won by ${CC.bigWinMargin}+`, cc: CC.bigWin });
    if (playoff) items.push({ label: 'Playoff win', cc: CC.playoffWin });
    if (playoff && round === 'final') items.push({ label: 'Champions', cc: CC.finalWin });
    if (home && save.facilities.stadium >= CC.stadiumHomeWinLevel) items.push({ label: 'Stadium bonus', cc: CC.stadiumHomeWin });
  }
  return { total: items.reduce((s, i) => s + i.cc, 0), items };
}

// ------------------------------------------------------------------------------ contracts

/**
 * What a player asks for to extend / re-sign. Below 25 morale he refuses.
 * @returns {{salary:number, years:number, maxYears:number, willing:boolean, reason:string|null}}
 */
export function contractDemand(save, playerOrId) {
  const p = typeof playerOrId === 'string' ? findPlayer(save, playerOrId) : playerOrId;
  const salary = askingSalary(p);
  const maxYears = maxContractYears(p.age);
  const willing = p.morale >= SALARY.refuseBelowMorale;
  return { salary, years: Math.min(demandYears(p.age), maxYears), maxYears, willing, reason: willing ? null : 'unhappy' };
}

/** Players may extend while in the final two seasons of their deal. */
export const canExtend = (p) => p.contract.years <= 2;

/**
 * Extend a rostered player's contract by `years` seasons at his asking salary (never a pay cut).
 * @returns {{ok:true, contract:{salary:number, years:number}} | {ok:false, reason:string, message:string}}
 */
export function extendContract(save, id, years = null) {
  const p = findPlayer(save, id);
  if (!p) return fail('notFound', 'Player not found.');
  if (!canExtend(p)) return fail('notYet', `${shortName(p)} still has ${p.contract.years} years left.`);
  const d = contractDemand(save, p);
  if (!d.willing) return fail('refuses', `${shortName(p)} refuses to talk while he is this unhappy.`);
  const add = clamp(Math.round(years ?? d.years), 1, 5);
  const total = Math.min(p.contract.years + add, d.maxYears);
  if (total <= p.contract.years) return fail('maxYears', `${shortName(p)} won't sign for that long at his age.`);
  const salary = Math.max(d.salary, p.contract.salary);
  if (salary - p.contract.salary > capRoom(save)) return fail('cap', 'Not enough cap room for that raise.');
  p.contract = { salary, years: total };
  p.morale = clamp(p.morale + 5, 0, 100);
  addHeadline(save, `${shortName(p)} (${p.pos}) signs an extension through ${save.season.year + total - 1}.`, 'signing');
  return { ok: true, contract: { ...p.contract } };
}

/** Fraction of this season's salary still owed (for dead money). */
function remainingSeasonFraction(save) {
  const ph = save.season.phase;
  if (ph === 'offseason') return 1;
  if (ph === 'playoffs') return 0;
  return clamp((LEAGUE.regularWeeks - save.season.week + 1) / LEAGUE.regularWeeks, 0, 1);
}

/**
 * Release a player: frees the roster spot; 50% of the remaining salary this season stays on the
 * cap as dead money; team morale dips slightly.
 * @returns {{ok:true, deadMoney:number, player:Object} | {ok:false, reason:string, message:string}}
 */
export function releasePlayer(save, id) {
  const team = userTeam(save);
  const idx = team.roster.findIndex((p) => p.id === id);
  if (idx < 0) return fail('notFound', 'Player not found.');
  const p = team.roster[idx];
  const dead = Math.round((p.contract.salary * SALARY.deadMoneyFraction * remainingSeasonFraction(save)) / 100) * 100;
  save.deadMoney = (save.deadMoney || 0) + dead;
  team.roster.splice(idx, 1);
  for (const o of team.roster) o.morale = clamp(o.morale + MORALE.releaseTeamPenalty, 0, 100);
  refreshUserRatings(save);
  addHeadline(save, `${team.city} release ${p.pos} ${shortName(p)}.`, 'signing');
  return { ok: true, deadMoney: dead, player: p };
}

// ----------------------------------------------------------------------------- facilities

export function facilityUpgradeCost(save, kind) {
  const lvl = save.facilities[kind];
  if (lvl == null || lvl >= FACILITIES.maxLevel) return null;
  return FACILITIES.upgradeCost[lvl + 1];
}

/** Spend CC to raise a facility one level (MECHANICS §7.3). */
export function upgradeFacility(save, kind) {
  if (!FACILITIES.kinds.includes(kind)) return fail('badKind', `Unknown facility ${kind}.`);
  const cost = facilityUpgradeCost(save, kind);
  if (cost == null) return fail('maxed', `${FACILITIES.labels[kind]} is already at the top level.`);
  if (!spendCc(save, cost)) return fail('cc', `Need ${cost} CC.`);
  save.facilities[kind] += 1;
  addHeadline(save, `${userTeam(save).city} upgrade their ${FACILITIES.labels[kind].toLowerCase()} to level ${save.facilities[kind]}.`, 'team');
  return { ok: true, kind, level: save.facilities[kind], cost };
}

export const trainingXpMult = (save) => 1 + FACILITIES.trainingXpPerLevel * (save.facilities.training - 1);
export const rehabInjuryMult = (save) => Math.max(0.2, 1 - FACILITIES.rehabInjuryPerLevel * (save.facilities.rehab - 1));
export const weeklyRecovery = (save) => CONDITION.weeklyRecovery + FACILITIES.rehabRecoveryPerLevel * (save.facilities.rehab - 1);
export const stadiumFansMult = (save) => 1 + FACILITIES.stadiumFansPerLevel * (save.facilities.stadium - 1);
export const stadiumHomeEdge = (save) => FACILITIES.stadiumHomeEdgePerLevel * (save.facilities.stadium - 1);

/** Facility levels, costs and effects for the Staff & Facilities screen. */
export function facilitySummary(save) {
  return FACILITIES.kinds.map((kind) => {
    const level = save.facilities[kind];
    const effect = kind === 'stadium'
      ? `Fan gain x${stadiumFansMult(save).toFixed(2)}${level >= CC.stadiumHomeWinLevel ? ', +1 CC per home win' : ''}`
      : kind === 'training'
        ? `XP x${trainingXpMult(save).toFixed(2)}`
        : `Injuries x${rehabInjuryMult(save).toFixed(2)}, +${weeklyRecovery(save)}% condition/week`;
    return { kind, label: FACILITIES.labels[kind], desc: FACILITIES.desc[kind], level, max: FACILITIES.maxLevel, upgradeCost: facilityUpgradeCost(save, kind), effect };
  });
}

// --------------------------------------------------------------------------- coordinators

/** @returns {{id:string, name:string, role:'oc'|'dc', stars:number, years:number, cost:number, hiredOffseason:number|null}} */
export function makeCoordinator(save, rng, role, starsValue) {
  const { first, last } = pickName(rng);
  return {
    id: newId(save, 'c'),
    name: `${first} ${last}`,
    role,
    stars: starsValue,
    years: COORDINATORS.years,
    cost: starsValue * COORDINATORS.costPerStar,
    hiredOffseason: null,
  };
}

/** Offseason market: three candidates per role across star bands. */
export function generateCoordinatorMarket(save, rng) {
  const make = (role) => COORDINATORS.bands.map(([lo, hi]) => makeCoordinator(save, rng, role, rng.int(lo, hi)));
  save.staffMarket = { oc: make('oc'), dc: make('dc') };
  return save.staffMarket;
}

export function coordinatorCandidates(save, role) {
  return save.staffMarket ? save.staffMarket[role] || [] : [];
}

/**
 * Hire an OC/DC from the offseason market for stars x 3 CC (3-season contract).
 * @param {'oc'|'dc'} role
 * @param {Object|string} candidate  candidate object or id
 */
export function hireCoordinator(save, role, candidate) {
  if (role !== 'oc' && role !== 'dc') return fail('badRole', `Unknown role ${role}.`);
  if (!save.staffMarket) return fail('closed', 'Coordinators can only be hired in the offseason.');
  const id = typeof candidate === 'string' ? candidate : candidate && candidate.id;
  const list = save.staffMarket[role];
  const c = list.find((x) => x.id === id);
  if (!c) return fail('notFound', 'Candidate not available.');
  if (!spendCc(save, c.cost)) return fail('cc', `Need ${c.cost} CC.`);
  save.staff[role] = { ...c, years: COORDINATORS.years, hiredOffseason: save.offseason ? save.offseason.year : null };
  save.staffMarket[role] = list.filter((x) => x.id !== id);
  refreshUserRatings(save);
  addHeadline(save, `${userTeam(save).city} hire ${c.name} as ${role === 'oc' ? 'offensive' : 'defensive'} coordinator (${c.stars}★).`, 'staff');
  return { ok: true, coordinator: save.staff[role] };
}

// ------------------------------------------------------------------------ morale & injuries

/** Spend CC to lift one player's morale. */
export function boostMorale(save, playerId) {
  const p = findPlayer(save, playerId);
  if (!p) return fail('notFound', 'Player not found.');
  if (p.morale >= 100) return fail('full', 'Morale is already maxed.');
  if (!spendCc(save, MORALE.boostCost)) return fail('cc', `Need ${MORALE.boostCost} CC.`);
  p.morale = clamp(p.morale + MORALE.boostAmount, 0, 100);
  return { ok: true, morale: p.morale, cost: MORALE.boostCost };
}

/** Spend CC to lift everyone's morale. */
export function boostTeamMorale(save) {
  if (!roster(save).length) return fail('empty', 'No players.');
  if (!spendCc(save, MORALE.teamBoostCost)) return fail('cc', `Need ${MORALE.teamBoostCost} CC.`);
  for (const p of roster(save)) p.morale = clamp(p.morale + MORALE.teamBoostAmount, 0, 100);
  return { ok: true, cost: MORALE.teamBoostCost };
}

const weekKey = (save) => `${save.season.year}-${save.season.phase}-${save.season.week}`;

/** Spend CC to take a week off an injury (once per player per week). */
export function rushTreatment(save, playerId) {
  const p = findPlayer(save, playerId);
  if (!p) return fail('notFound', 'Player not found.');
  if (!p.injury) return fail('healthy', `${shortName(p)} is not injured.`);
  if (p.rushWeek === weekKey(save)) return fail('used', 'Already treated this week.');
  if (!spendCc(save, INJURY.rushCost)) return fail('cc', `Need ${INJURY.rushCost} CC.`);
  p.rushWeek = weekKey(save);
  p.injury.weeks -= 1;
  if (p.injury.weeks <= 0) p.injury = null;
  refreshUserRatings(save);
  return { ok: true, weeks: p.injury ? p.injury.weeks : 0, cost: INJURY.rushCost };
}
