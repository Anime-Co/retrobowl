// Player model: attributes per position (MECHANICS §6.2), generation with hidden potential,
// star rating, asking salary and display helpers.

import {
  START_YEAR, STAR_WEIGHTS, ATTR, GENERATION, TRAITS, SALARY, ROOKIE_CONTRACT, MORALE,
} from './config.js';
import { pickName, pickJersey } from '../data/names.js';
import { clamp } from '../core/util.js';
import { newId, derivedRng } from './state.js';

/** @typedef {import('../types.js').Player} Player */
/** @typedef {import('../types.js').Position} Position */

export const POSITIONS = Object.freeze(['QB', 'RB', 'WR', 'TE', 'OL', 'DL', 'LB', 'DB', 'K']);
export const OFFENSE_POSITIONS = Object.freeze(['QB', 'RB', 'WR', 'TE', 'OL', 'K']);
export const DEFENSE_POSITIONS = Object.freeze(['DL', 'LB', 'DB']);

const SKILL_ATTRS = Object.freeze(['speed', 'strength', 'catching', 'stamina']);
const DEF_ATTRS = Object.freeze(['tackling', 'strength', 'speed', 'stamina']);

/** Four attributes per position, in display order (MECHANICS §6.2). */
export const ATTRS = Object.freeze({
  QB: Object.freeze(['arm', 'accuracy', 'speed', 'stamina']),
  RB: SKILL_ATTRS,
  WR: SKILL_ATTRS,
  TE: SKILL_ATTRS,
  OL: Object.freeze(['blocking', 'strength', 'speed', 'stamina']),
  DL: DEF_ATTRS,
  LB: DEF_ATTRS,
  DB: DEF_ATTRS,
  K: Object.freeze(['range', 'accuracy', 'speed', 'stamina']),
});

export const ATTR_LABELS = Object.freeze({
  arm: 'Arm', accuracy: 'Accuracy', speed: 'Speed', stamina: 'Stamina', strength: 'Strength',
  catching: 'Catching', blocking: 'Blocking', tackling: 'Tackling', range: 'Range',
});

export const POS_LABELS = Object.freeze({
  QB: 'Quarterback', RB: 'Running Back', WR: 'Wide Receiver', TE: 'Tight End', OL: 'Offensive Line',
  DL: 'Defensive Line', LB: 'Linebacker', DB: 'Defensive Back', K: 'Kicker',
});

/** Season/career stat keys. `fgLong` is a max, everything else sums. */
export const STAT_KEYS = Object.freeze([
  'gp', 'passAtt', 'passCmp', 'passYds', 'passTd', 'int', 'rushAtt', 'rushYds', 'rushTd',
  'rec', 'recYds', 'recTd', 'fgAtt', 'fgMade', 'fgLong', 'patAtt', 'patMade', 'sacked',
  'tackles', 'sacks', 'defInt', 'ff', 'fumbles', 'retYds', 'retTd',
]);

export function emptyStats() {
  const o = {};
  for (const k of STAT_KEYS) o[k] = 0;
  return o;
}

export const isOffense = (pos) => OFFENSE_POSITIONS.includes(pos);
export const isDefense = (pos) => DEFENSE_POSITIONS.includes(pos);

/** Attribute (1..10) -> engine skill (0..1); attr 5.5 -> 0.5. */
export const attrToSkill = (a) => clamp((a - ATTR.min) / (ATTR.max - ATTR.min), 0, 1);

/** Position-weighted attribute mean (1..10). */
export function weightedMean(pos, attrs) {
  const w = STAR_WEIGHTS[pos];
  let s = 0;
  let tw = 0;
  for (const k of ATTRS[pos]) {
    s += w[k] * (attrs[k] ?? ATTR.min);
    tw += w[k];
  }
  return Math.round((s / tw) * 1e6) / 1e6;
}

/** Stars 0.5..5 in halves from a weighted mean. */
export const starsFromMean = (m) => clamp(Math.round(m) / 2, 0.5, 5);

/** Overall stars (0.5..5 in half steps). @param {Player} p */
export function stars(p) {
  return starsFromMean(weightedMean(p.pos, p.attrs));
}

/** Continuous star value (for team ratings). @param {Player} p */
export function starsExact(p) {
  return clamp(weightedMean(p.pos, p.attrs) / 2, 0.5, 5);
}

export function attrSum(attrsOrPlayer) {
  const a = attrsOrPlayer.attrs || attrsOrPlayer;
  let s = 0;
  for (const k of Object.keys(a)) s += a[k];
  return s;
}

/** True while the player can still raise an attribute (below potential and not all maxed). */
export function canImprove(p) {
  return attrSum(p) < p.potential && ATTRS[p.pos].some((k) => p.attrs[k] < ATTR.max);
}

/** Stars the player would reach at full potential (points spread by star weight). */
export function potentialStars(p) {
  const attrs = { ...p.attrs };
  let room = Math.max(0, (p.potential ?? attrSum(p)) - attrSum(p));
  const order = [...ATTRS[p.pos]].sort((a, b) => STAR_WEIGHTS[p.pos][b] - STAR_WEIGHTS[p.pos][a]);
  let guard = 0;
  while (room > 0 && guard++ < 100) {
    let moved = false;
    for (const k of order) {
      if (room <= 0) break;
      if (attrs[k] < ATTR.max) { attrs[k] += 1; room -= 1; moved = true; }
    }
    if (!moved) break;
  }
  return starsFromMean(weightedMean(p.pos, attrs));
}

/** Loose upside label for roster players (potential stays hidden). */
export function potentialLabel(p) {
  const room = Math.max(0, (p.potential ?? 0) - attrSum(p));
  if (room >= 10) return 'High';
  if (room >= 5) return 'Medium';
  if (room >= 1) return 'Low';
  return 'Peaked';
}

/**
 * Integer attributes whose weighted mean rounds to the target stars.
 * @param {import('../core/rng.js').Rng} rng
 */
export function makeAttrs(rng, pos, targetStars) {
  const keys = ATTRS[pos];
  const w = STAR_WEIGHTS[pos];
  const target = clamp(Math.round(targetStars * 2), 1, 10);
  const attrs = {};
  for (const k of keys) attrs[k] = clamp(Math.round(target + rng.normal(0, GENERATION.attrSd)), ATTR.min, ATTR.max);
  for (let i = 0; i < 400; i++) {
    const m = Math.round(weightedMean(pos, attrs));
    if (m === target) break;
    const dir = m < target ? 1 : -1;
    const cands = keys.filter((k) => (dir > 0 ? attrs[k] < ATTR.max : attrs[k] > ATTR.min));
    if (!cands.length) break;
    const k = rng.weighted(cands, cands.map((c) => w[c]));
    attrs[k] += dir;
  }
  return attrs;
}

/** Hidden growth room (attribute points) by age. */
export function growthRoom(rng, age) {
  for (const [maxAge, lo, hi] of GENERATION.growthByAge) {
    if (age <= maxAge) return rng.int(lo, hi);
  }
  return 0;
}

/** Starting level for a generated player (veterans have experience). */
export function startLevel(age) {
  return 1 + Math.floor(Math.max(0, age - 22) * 0.8);
}

function pickTrait(rng) {
  const keys = Object.keys(TRAITS);
  return rng.weighted(keys, keys.map((k) => TRAITS[k].weight));
}

/**
 * Generate a player. Advances `rng`; takes an id from save.nextId.
 * @param {import('../types.js').Save} save
 * @param {import('../core/rng.js').Rng} rng
 * @param {{pos:Position, stars?:number, age?:number, rookie?:boolean, potentialBonus?:number,
 *   takenNames?:Set<string>, takenNumbers?:Iterable<number>, contractYears?:number,
 *   salary?:number, morale?:number, year?:number}} opts
 * @returns {Player}
 */
export function createPlayer(save, rng, opts) {
  const pos = opts.pos;
  const age = opts.age ?? 25;
  const attrs = makeAttrs(rng, pos, opts.stars ?? 2);
  const sum = attrSum(attrs);
  const potential = clamp(sum + growthRoom(rng, age) + (opts.potentialBonus || 0), sum, ATTR.potentialMax);
  const { first, last } = pickName(rng, opts.takenNames || null);
  const year = opts.year ?? (save.season ? save.season.year : START_YEAR);
  /** @type {Player} */
  const p = {
    id: newId(save, 'p'),
    first,
    last,
    pos,
    age,
    number: pickJersey(rng, pos, opts.takenNumbers || []),
    attrs,
    potential,
    xp: 0,
    level: opts.rookie ? 1 : startLevel(age),
    skillPoints: 0,
    morale: opts.morale ?? rng.int(GENERATION.moraleMin, GENERATION.moraleMax),
    condition: 100,
    injury: null,
    contract: { salary: 0, years: 1 },
    traits: [],
    season: emptyStats(),
    career: emptyStats(),
    rookie: !!opts.rookie,
    seasons: 0,
    peakStars: 0,
    titles: 0,
    legacy: 0,
    awards: [],
    joined: year,
    seasonXp: 0,
    rushWeek: null,
  };
  if (rng.chance(GENERATION.traitChance)) p.traits.push(pickTrait(rng));
  p.peakStars = stars(p);
  p.contract = {
    salary: opts.salary ?? askingSalary(p),
    years: opts.contractYears ?? demandYears(age),
  };
  return p;
}

/** Give a joining player a jersey number not used on the user roster (deterministic). */
export function assignFreeNumber(save, p, rosterArr) {
  const taken = new Set(rosterArr.filter((x) => x.id !== p.id).map((x) => x.number));
  if (!taken.has(p.number)) return p.number;
  p.number = pickJersey(derivedRng(save, `jersey|${p.id}`), p.pos, taken);
  return p.number;
}

function lookup(table, v) {
  for (const [max, val] of table) if (v <= max) return val;
  return table[table.length - 1][1];
}

/** Asking salary in $K (MECHANICS §6.6): 0.3 + 0.9 x stars^1.6 $M x age x morale factors. */
export function askingSalary(p, { morale } = {}) {
  const s = stars(p);
  let k = SALARY.base + SALARY.mult * Math.pow(s, SALARY.exp);
  k *= lookup(SALARY.ageFactors, p.age);
  const m = morale ?? p.morale ?? 60;
  if (m < SALARY.moraleLowBelow) k *= SALARY.moraleLowFactor;
  else if (m > SALARY.moraleHighAbove) k *= SALARY.moraleHighFactor;
  return clamp(Math.round(k / SALARY.roundTo) * SALARY.roundTo, SALARY.min, SALARY.max);
}

/** Rookie deal salary in $K: 0.5..1.5 $M scaled by stars. */
export function rookieSalary(s) {
  const k = ROOKIE_CONTRACT.min + ((s - 0.5) / 2.5) * (ROOKIE_CONTRACT.max - ROOKIE_CONTRACT.min);
  return clamp(Math.round(k / SALARY.roundTo) * SALARY.roundTo, ROOKIE_CONTRACT.min, ROOKIE_CONTRACT.max);
}

/** Contract length a player asks for at this age. */
export const demandYears = (age) => lookup(SALARY.askYears, age);
/** Longest total contract a player accepts at this age. */
export const maxContractYears = (age) => lookup(SALARY.maxYears, age);

// ---------------------------------------------------------------- display helpers

/** "Jordan Smith" */
export const fullName = (p) => `${p.first} ${p.last}`;
/** "J. SMITH" */
export const shortName = (p) => `${p.first.charAt(0)}. ${p.last}`.toUpperCase();

/** Morale 0..100 -> 5 levels {level 0..4, label, key}. */
export function moraleLabel(m) {
  let level = 0;
  for (const t of MORALE.thresholds) if (m >= t) level += 1;
  return { level, label: MORALE.labels[level], key: MORALE.keys[level] };
}

/** Condition 0..100 -> label. */
export function conditionLabel(c) {
  if (c >= 85) return 'Fresh';
  if (c >= 60) return 'Fine';
  if (c >= 40) return 'Tired';
  return 'Exhausted';
}

/** 3.5 -> "★★★½" */
export function starsText(s) {
  const full = Math.floor(s);
  const half = s - full >= 0.5;
  return '★'.repeat(full) + (half ? '½' : '');
}

/** "Hamstring (3 wk)" or "" when healthy. */
export function injuryText(p) {
  if (!p.injury) return '';
  return p.injury.weeks >= 20 ? `${p.injury.type} (season)` : `${p.injury.type} (${p.injury.weeks} wk)`;
}

/** "$3.2M x 2 yrs" */
export function contractText(p) {
  const m = (p.contract.salary / 1000).toFixed(1);
  return `$${m}M x ${p.contract.years} yr${p.contract.years === 1 ? '' : 's'}`;
}

export const traitLabels = (p) => (p.traits || []).map((t) => (TRAITS[t] ? TRAITS[t].label : t));

export const isInjured = (p) => !!p.injury;
