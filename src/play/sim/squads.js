// Squad helpers for the play engine: attribute access with safe defaults, generic fillers,
// normalization of whatever Squad the match layer hands us (missing slots -> fillers), and a
// seeded test/sandbox squad builder (used by unit tests, the bot and the dev sandbox).

import { Rng } from '../../core/rng.js';
import { clamp } from '../../core/util.js';
import { TUNING } from './tuning.js';

/** @typedef {import('../../types.js').SquadPlayer} SquadPlayer */
/** @typedef {import('../../types.js').Squad} Squad */

export const ATTR_KEYS = ['speed', 'strength', 'hands', 'arm', 'accuracy', 'blocking', 'passRush', 'coverage',
  'tackling', 'elusiveness', 'kickPower', 'kickAccuracy'];

const NUMBER_RANGES = {
  QB: [1, 19], RB: [20, 49], WR: [80, 89], TE: [80, 89], OL: [60, 79], DL: [90, 99], LB: [50, 59], DB: [20, 39], K: [1, 9],
};

/** Read a 0..1 attribute with a filler-ish default; never returns NaN. */
export function attr(sp, key, def = 0.2) {
  const v = sp ? sp[key] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, 1) : def;
}

/**
 * Head-to-head contest skill: the raw 0..1 attribute pulled toward 0.5 by TUNING.contestSpread so
 * rating gaps tilt contests (blocks, coverage, tackles, catches in traffic) without deciding every
 * one of them - player skill should still matter more than the roster sheet.
 */
export function skill(sp, key, def = 0.2) {
  return 0.5 + TUNING.contestSpread * (attr(sp, key, def) - 0.5);
}

/** Current energy multiplier (1 = fresh). */
export function stamina(sp) {
  const v = sp ? sp.stamina : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, 1) : 1;
}

/** Stamina ATTRIBUTE (how fast arm / leg fade over a game): `endurance` when the squad builder
 * provides it, else the current-energy `stamina`. */
export function endurance(sp) {
  const v = sp ? sp.endurance : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, 1) : stamina(sp);
}

/** True for named franchise players (stars). */
export const isStar = (sp) => !!(sp && sp.id);

/** Generic filler (~1-1.5 stars): all skills around `level`. */
export function makeFiller(pos, number = 0, level = 0.2) {
  const sp = { id: null, name: `#${number}`, number, pos, stamina: 1 };
  for (const k of ATTR_KEYS) sp[k] = level;
  return sp;
}

function fillList(list, n, pos, startNo) {
  const src = Array.isArray(list) ? list : list ? [list] : [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = src[i];
    out.push(p && typeof p === 'object' ? p : makeFiller(pos, startNo + i));
  }
  return out;
}

/**
 * Normalize a Squad into fixed-size slot lists. Accepts TE as a single player or an array.
 * @param {Squad} squad
 */
export function normalizeSquad(squad) {
  const o = (squad && squad.offense) || {};
  const d = (squad && squad.defense) || {};
  return {
    look: (squad && squad.look) || { abbr: 'TM', city: 'Team', primary: '#888', secondary: '#fff', helmet: '#fff' },
    returner: squad && squad.returner && typeof squad.returner === 'object' ? squad.returner : null,
    QB: fillList(o.QB, 1, 'QB', 12)[0],
    RB: fillList(o.RB, 1, 'RB', 28)[0],
    WR: fillList(o.WR, 2, 'WR', 81),
    TE: fillList(o.TE, 2, 'TE', 86),
    OL: fillList(o.OL, 5, 'OL', 61),
    K: fillList(o.K, 1, 'K', 3)[0],
    DL: fillList(d.DL, 4, 'DL', 91),
    LB: fillList(d.LB, 3, 'LB', 51),
    DB: fillList(d.DB, 4, 'DB', 21),
  };
}

/** Position-specific attribute emphasis for generated test players. */
const KEY_ATTRS = {
  QB: ['arm', 'accuracy', 'speed'],
  RB: ['speed', 'strength', 'hands', 'elusiveness'],
  WR: ['speed', 'hands', 'elusiveness', 'strength'],
  TE: ['hands', 'strength', 'blocking', 'speed'],
  OL: ['blocking', 'strength', 'speed'],
  DL: ['passRush', 'strength', 'tackling', 'speed'],
  LB: ['tackling', 'speed', 'coverage', 'strength', 'passRush'],
  DB: ['coverage', 'speed', 'tackling', 'hands'],
  K: ['kickPower', 'kickAccuracy', 'speed'],
};

/**
 * Seeded synthetic squad for tests and the sandbox. Every slot is a "star" (has an id) unless
 * `starFrac` < 1, in which case some slots become generic fillers.
 * @param {{rating?:number, seed?:number, spread?:number, starFrac?:number, prefix?:string, look?:object}} [opts]
 * @returns {Squad}
 */
export function makeTestSquad(opts = {}) {
  const rating = opts.rating ?? 0.5;
  const spread = opts.spread ?? 0.08;
  const starFrac = opts.starFrac ?? 1;
  const prefix = opts.prefix ?? 't';
  const rng = new Rng((opts.seed ?? 1) >>> 0);
  let n = 0;
  const used = new Set();
  const mk = (pos) => {
    n += 1;
    const [lo, hi] = NUMBER_RANGES[pos];
    let number = rng.int(lo, hi);
    for (let k = 0; k < 20 && used.has(number); k++) number = rng.int(lo, hi);
    used.add(number);
    if (rng.next() > starFrac) return makeFiller(pos, number, 0.15 + rng.next() * 0.1);
    const sp = { id: `${prefix}${n}`, name: `${String.fromCharCode(65 + rng.int(0, 25))}. ${pos}${n}`, number, pos, stamina: 1 };
    for (const k of ATTR_KEYS) sp[k] = clamp(rating - 0.15 + rng.normal(0, spread), 0.05, 1);
    for (const k of KEY_ATTRS[pos]) sp[k] = clamp(rating + rng.normal(0, spread), 0.05, 1);
    return sp;
  };
  return {
    look: opts.look || { abbr: 'TST', city: 'Test', primary: '#3366cc', secondary: '#ffffff', helmet: '#ffffff' },
    offense: {
      QB: mk('QB'),
      RB: mk('RB'),
      WR: [mk('WR'), mk('WR')],
      TE: [mk('TE'), mk('TE')],
      OL: [mk('OL'), mk('OL'), mk('OL'), mk('OL'), mk('OL')],
      K: mk('K'),
    },
    defense: {
      DL: [mk('DL'), mk('DL'), mk('DL'), mk('DL')],
      LB: [mk('LB'), mk('LB'), mk('LB')],
      DB: [mk('DB'), mk('DB'), mk('DB'), mk('DB')],
    },
    offRating: rating,
    defRating: rating,
  };
}
