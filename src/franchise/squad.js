// Squad builder: turns the franchise roster (user) or abstract ratings (AI) into the normalized
// Squad the play engine consumes (types.js). Skills are 0..1 with 0.5 = attribute 5.5.

import { TEAM_WEIGHTS, TEAM_RATING, FILLER, VIRTUAL, COORDINATORS, MORALE, CONDITION } from './config.js';
import { ATTRS, starsExact, attrToSkill, shortName } from './players.js';
import { pickName, pickJersey } from '../data/names.js';
import { clamp } from '../core/util.js';
import { teamById, derivedRng, round1 } from './state.js';
import { difficultyRating } from './gameSim.js';
import { difficultyStep } from './difficulty.js';

/** @typedef {import('../types.js').Squad} Squad */
/** @typedef {import('../types.js').SquadPlayer} SquadPlayer */
/** @typedef {import('../types.js').Player} Player */

export const OFFENSE_SLOTS = Object.freeze({ QB: 1, RB: 1, WR: 2, TE: 2, OL: 5, K: 1 });
export const DEFENSE_SLOTS = Object.freeze({ DL: 4, LB: 3, DB: 4 });
export const SLOT_COUNTS = Object.freeze({ ...OFFENSE_SLOTS, ...DEFENSE_SLOTS });

const byQuality = (a, b) => starsExact(b) - starsExact(a) || b.condition - a.condition || (a.id < b.id ? -1 : 1);

/**
 * Starters by role from healthy stars (MECHANICS §6.1). Empty slots are null (filler).
 * @param {Player[]} rosterArr
 * @returns {{slots:Object<string,(Player|null)[]>, bench:Player[], injured:Player[], starterIds:string[]}}
 */
export function depthChart(rosterArr) {
  const slots = {};
  const used = new Set();
  for (const pos of Object.keys(SLOT_COUNTS)) {
    const healthy = rosterArr.filter((p) => p.pos === pos && !p.injury).sort(byQuality);
    slots[pos] = Array.from({ length: SLOT_COUNTS[pos] }, (_, i) => healthy[i] || null);
    for (const p of healthy.slice(0, SLOT_COUNTS[pos])) used.add(p.id);
  }
  return {
    slots,
    bench: rosterArr.filter((p) => !p.injury && !used.has(p.id)),
    injured: rosterArr.filter((p) => p.injury),
    starterIds: [...used],
  };
}

/** Stars -> 0..1 unit rating on the same scale as skills. */
export const starsToUnit = (s) => clamp((2 * s - 1) / 9, 0, 1);

/**
 * One side's rating (stars) from its starters (MECHANICS §6.2: "a star in a position makes that
 * slot noticeably better, both on the field and in the team rating"). Empty slots are generic
 * fillers worth FILLER.stars. The starters are ranked best first and the best players carry the
 * unit: the slot at cumulative weight x counts with Q'(x), Q(x) = 1 - (1 - x)^topHeavy (an
 * ordered weighted mean). A side of equal players rates exactly their stars, a few stars among
 * fillers count much more than their slot weight, and replacing any player with a better one
 * never lowers the rating.
 * @param {Object<string, number[]>} weights  slot weights by position
 * @param {Object<string, (Object|null)[]>} slots  depth-chart slots (null = filler)
 */
export function sideRating(weights, slots) {
  const items = [];
  let total = 0;
  for (const pos of Object.keys(weights)) {
    weights[pos].forEach((w, i) => {
      const p = slots[pos] && slots[pos][i];
      items.push({ w, v: p ? starsExact(p) : FILLER.stars });
      total += w;
    });
  }
  if (!(total > 0)) return FILLER.stars;
  items.sort((a, b) => b.v - a.v);
  const Q = (x) => 1 - Math.pow(Math.max(0, 1 - x / total), TEAM_RATING.topHeavy);
  let cum = 0;
  let r = 0;
  for (const it of items) {
    const q0 = Q(cum);
    cum += it.w;
    r += (Q(cum) - q0) * it.v;
  }
  return r;
}

/**
 * Team OFF/DEF in stars (0.5..5, one decimal) incl. coordinator boost (MECHANICS §6.2).
 * AI teams return their stored ratings.
 * @returns {{off:number, def:number, offBase:number, defBase:number, ocBoost:number, dcBoost:number}}
 */
export function teamRatings(save, teamId = save.userTeamId) {
  const team = teamById(save, teamId);
  if (!team) throw new Error(`unknown team ${teamId}`);
  if (team.id !== save.userTeamId || !Array.isArray(team.roster)) {
    return { off: team.off, def: team.def, offBase: team.off, defBase: team.def, ocBoost: 0, dcBoost: 0 };
  }
  const { slots } = depthChart(team.roster);
  const offBase = sideRating(TEAM_WEIGHTS.off, slots);
  const defBase = sideRating(TEAM_WEIGHTS.def, slots);
  const ocBoost = save.staff && save.staff.oc ? save.staff.oc.stars * COORDINATORS.boostPerStar : 0;
  const dcBoost = save.staff && save.staff.dc ? save.staff.dc.stars * COORDINATORS.boostPerStar : 0;
  return {
    off: round1(clamp(offBase + ocBoost, 0.5, 5)),
    def: round1(clamp(defBase + dcBoost, 0.5, 5)),
    offBase: round1(offBase),
    defBase: round1(defBase),
    ocBoost: round1(ocBoost),
    dcBoost: round1(dcBoost),
  };
}

/** Copy the user's computed ratings onto the user Team (used by sims, standings UI). */
export function refreshUserRatings(save) {
  const t = teamById(save, save.userTeamId);
  if (!t || !Array.isArray(t.roster)) return;
  const r = teamRatings(save, t.id);
  t.off = r.off;
  t.def = r.def;
}

/** Engine skills from attributes (1..10 values, may be fractional for virtual players). */
export function skillsFromAttrs(pos, attrs) {
  const a = (k) => attrToSkill(attrs[k] ?? 1);
  const s = {
    speed: 0.3, strength: 0.3, hands: 0.2, arm: 0.1, accuracy: 0.1, blocking: 0.15, passRush: 0.1,
    coverage: 0.1, tackling: 0.15, elusiveness: 0.2, kickPower: 0.1, kickAccuracy: 0.1,
  };
  switch (pos) {
    case 'QB':
      s.arm = a('arm'); s.accuracy = a('accuracy'); s.speed = a('speed');
      s.strength = 0.25 + 0.25 * a('stamina'); s.hands = 0.35; s.elusiveness = 0.15 + 0.55 * a('speed');
      break;
    case 'RB':
      s.speed = a('speed'); s.strength = a('strength'); s.hands = a('catching');
      s.elusiveness = 0.6 * a('speed') + 0.4 * a('strength'); s.blocking = 0.1 + 0.4 * a('strength');
      break;
    case 'WR':
      s.speed = a('speed'); s.strength = a('strength'); s.hands = a('catching');
      s.elusiveness = 0.7 * a('speed') + 0.3 * a('catching'); s.blocking = 0.05 + 0.3 * a('strength');
      break;
    case 'TE':
      s.speed = a('speed'); s.strength = a('strength'); s.hands = a('catching');
      s.elusiveness = 0.5 * a('speed') + 0.5 * a('strength'); s.blocking = 0.15 + 0.7 * a('strength');
      break;
    case 'OL':
      s.blocking = a('blocking'); s.strength = a('strength'); s.speed = a('speed');
      s.elusiveness = 0.05; s.hands = 0.1;
      break;
    case 'DL':
      s.tackling = a('tackling'); s.strength = a('strength'); s.speed = a('speed');
      s.passRush = 0.5 * a('strength') + 0.3 * a('speed') + 0.2 * a('tackling');
      s.coverage = 0.1 + 0.25 * a('speed'); s.hands = 0.1 + 0.2 * a('tackling');
      break;
    case 'LB':
      s.tackling = a('tackling'); s.strength = a('strength'); s.speed = a('speed');
      s.passRush = 0.4 * a('strength') + 0.4 * a('speed') + 0.2 * a('tackling');
      s.coverage = 0.5 * a('speed') + 0.3 * a('tackling') + 0.2 * a('strength'); s.hands = 0.15 + 0.3 * a('tackling');
      break;
    case 'DB':
      s.tackling = a('tackling'); s.strength = a('strength'); s.speed = a('speed');
      s.coverage = 0.55 * a('speed') + 0.3 * a('tackling') + 0.15 * a('strength');
      s.passRush = 0.1 + 0.2 * a('speed'); s.hands = 0.2 + 0.3 * a('tackling') + 0.2 * a('speed');
      s.elusiveness = 0.5 * a('speed');
      break;
    case 'K':
      s.kickPower = a('range'); s.kickAccuracy = a('accuracy'); s.speed = a('speed'); s.strength = 0.2;
      break;
    default:
      break;
  }
  for (const k of Object.keys(s)) s[k] = clamp(s[k], 0, 1);
  return s;
}

/** On-field multiplier from morale (+-8%) and condition (drops under ~60%). */
export function performanceFactor(morale, condition) {
  const m = 1 + MORALE.perfEffect * clamp((morale - 50) / 50, -1, 1);
  const c = condition >= CONDITION.perfThreshold
    ? 1 - (100 - condition) * CONDITION.perfHi
    : 1 - (100 - CONDITION.perfThreshold) * CONDITION.perfHi - (CONDITION.perfThreshold - condition) * CONDITION.perfLo;
  return clamp(m * c, 0.3, 1.1);
}

const SKILL_FIELDS = ['speed', 'strength', 'hands', 'arm', 'accuracy', 'blocking', 'passRush', 'coverage', 'tackling', 'elusiveness', 'kickPower', 'kickAccuracy'];

/** Franchise Player -> SquadPlayer (morale and condition applied). @returns {SquadPlayer} */
export function toSquadPlayer(p) {
  const s = skillsFromAttrs(p.pos, p.attrs);
  const f = performanceFactor(p.morale, p.condition);
  for (const k of SKILL_FIELDS) s[k] = clamp(s[k] * f, 0, 1);
  return {
    id: p.id,
    name: shortName(p),
    number: p.number,
    pos: p.pos,
    ...s,
    stamina: clamp(p.condition / 100, 0.3, 1),
    endurance: attrToSkill(p.attrs.stamina ?? 1),
    stars: starsExact(p),
    level: p.level,
    age: p.age,
    morale: p.morale,
  };
}

function virtualAttrs(rng, pos, starsValue, sd) {
  const attrs = {};
  const mean = Math.min(2 * starsValue, VIRTUAL.attrCap);
  for (const k of ATTRS[pos]) attrs[k] = clamp(mean + rng.normal(0, sd), 1, 10);
  return attrs;
}

function genericName(rng, takenNames) {
  return shortName(pickName(rng, takenNames));
}

/** Generic filler (MECHANICS §6.1): skills ~0.15..0.25. */
function makeFiller(rng, pos, numbers, names) {
  const base = rng.float(FILLER.skillMin, FILLER.skillMax);
  const attrs = {};
  for (const k of ATTRS[pos]) attrs[k] = 1 + 9 * clamp(base + rng.normal(0, 0.02), 0, 1);
  const number = pickJersey(rng, pos, numbers);
  numbers.add(number);
  return {
    id: null,
    name: genericName(rng, names),
    number,
    pos,
    ...skillsFromAttrs(pos, attrs),
    stamina: 1,
    endurance: 0.3,
    stars: FILLER.stars,
    level: FILLER.level,
    age: 25,
    morale: 60,
  };
}

function makeVirtual(rng, pos, starsValue, numbers, names) {
  const s = clamp(starsValue, 0.5, 5);
  const number = pickJersey(rng, pos, numbers);
  numbers.add(number);
  return {
    id: null,
    name: genericName(rng, names),
    number,
    pos,
    ...skillsFromAttrs(pos, virtualAttrs(rng, pos, s, 0.7)),
    stamina: 1,
    endurance: attrToSkill(2 * s),
    stars: s,
    level: 1 + Math.round(s * 2),
    age: 26,
    morale: 60,
  };
}

function teamLook(team) {
  return { abbr: team.abbr, city: team.city, primary: team.colors.primary, secondary: team.colors.secondary, helmet: team.colors.helmet };
}

function pickReturner(candidates) {
  const pool = candidates.filter(Boolean);
  const stars = pool.filter((p) => p.id);
  const from = stars.length ? stars : pool;
  return from.reduce((best, p) => (!best || p.speed > best.speed ? p : best), null);
}

function assemble(look, get, teamId, offStars, defStars, bench = []) {
  const offense = { QB: get('QB', 0), RB: get('RB', 0), WR: [get('WR', 0), get('WR', 1)], TE: [get('TE', 0), get('TE', 1)], OL: [0, 1, 2, 3, 4].map((i) => get('OL', i)), K: get('K', 0) };
  const defense = { DL: [0, 1, 2, 3].map((i) => get('DL', i)), LB: [0, 1, 2].map((i) => get('LB', i)), DB: [0, 1, 2, 3].map((i) => get('DB', i)) };
  const returner = pickReturner([...offense.WR, offense.RB, ...defense.DB, ...bench.filter((p) => ['WR', 'RB', 'DB'].includes(p.pos))]);
  return {
    teamId,
    look,
    offense,
    defense,
    bench,
    returner,
    offRating: Math.round(starsToUnit(offStars) * 1000) / 1000,
    defRating: Math.round(starsToUnit(defStars) * 1000) / 1000,
    offStars,
    defStars,
  };
}

/**
 * Build the on-field Squad for a team.
 * User team: healthy stars fill their slots (best first), extra stars sit on the bench, empty
 * slots get generic fillers. AI team: synthesized from OFF/DEF stars; as the user's opponent the
 * difficulty offset applies (step 16 = 5-star team).
 *
 * Squad.offense.TE is [TE1, TE2] (MECHANICS §2.1 fields two TEs; PLAY-SIM normalizeSquad accepts
 * an array). Extra fields: bench, returner, offStars/defStars, teamId; SquadPlayer extras:
 * endurance (0..1 stamina attribute), stars, level, age, morale.
 * @param {import('../types.js').Save} save
 * @param {string} teamId
 * @param {{opponent?:boolean, difficultyStep?:number}} [opts]
 *   opponent (AI only, default true): apply the difficulty offset.
 * @returns {Squad}
 */
export function buildSquad(save, teamId, opts = {}) {
  const team = teamById(save, teamId);
  if (!team) throw new Error(`unknown team ${teamId}`);
  const look = teamLook(team);
  const rng = derivedRng(save, `squad|${teamId}|${save.season.year}|${save.season.week}`);
  const numbers = new Set();
  const names = new Set();

  if (team.id === save.userTeamId && Array.isArray(team.roster)) {
    const chart = depthChart(team.roster);
    for (const p of team.roster) { numbers.add(p.number); names.add(`${p.first} ${p.last}`); }
    const built = {};
    for (const pos of Object.keys(SLOT_COUNTS)) {
      built[pos] = chart.slots[pos].map((p) => (p ? toSquadPlayer(p) : makeFiller(rng, pos, numbers, names)));
    }
    const r = teamRatings(save, teamId);
    return assemble(look, (pos, i) => built[pos][i], teamId, r.off, r.def, chart.bench.map(toSquadPlayer));
  }

  const apply = opts.opponent ?? true;
  const step = opts.difficultyStep ?? difficultyStep(save);
  const offS = apply ? difficultyRating(team.off, step) : team.off;
  const defS = apply ? difficultyRating(team.def, step) : team.def;
  const built = {};
  for (const pos of Object.keys(SLOT_COUNTS)) {
    const sideStars = DEFENSE_SLOTS[pos] ? defS : pos === 'K' ? (offS + defS) / 2 : offS;
    built[pos] = Array.from({ length: SLOT_COUNTS[pos] }, (_, i) => {
      const bonus = pos === 'QB' ? 0.2 : i === 0 ? 0.1 : -0.05 * i;
      return makeVirtual(rng, pos, sideStars + bonus + rng.normal(0, 0.3), numbers, names);
    });
  }
  return assemble(look, (pos, i) => built[pos][i], teamId, round1(offS), round1(defS));
}
