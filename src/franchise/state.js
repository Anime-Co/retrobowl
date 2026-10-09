// Small helpers over the Save object shared by every franchise module: rng persistence, ids,
// lookups. The Save is plain JSON; the rng state lives in save.rngState.

import { Rng } from '../core/rng.js';

/**
 * Restore the franchise Rng from the save. Pair with commitRng() after use.
 * @param {import('../types.js').Save} save
 */
export function rngOf(save) {
  return new Rng(save.rngState >>> 0);
}

/** Persist an Rng's state back into the save. */
export function commitRng(save, rng) {
  save.rngState = rng.getState();
}

/** Run fn(rng) with the save's rng and commit the state afterwards. */
export function withRng(save, fn) {
  const rng = rngOf(save);
  try {
    return fn(rng);
  } finally {
    commitRng(save, rng);
  }
}

/** Persistent id from save.nextId (e.g. "p17"). */
export function newId(save, prefix = 'p') {
  const id = `${prefix}${save.nextId}`;
  save.nextId += 1;
  return id;
}

/** FNV-1a 32-bit string hash (deterministic seeds for derived generators). */
export function hashStr(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Independent generator derived from the save seed and a key; does not touch save.rngState. */
export function derivedRng(save, key) {
  return new Rng(hashStr(`${save.seed}|${key}`));
}

export const round1 = (v) => Math.round(v * 10) / 10;
export const round2 = (v) => Math.round(v * 100) / 100;

/** @returns {import('../types.js').Team} */
export function teamById(save, id) {
  return save.teams.find((t) => t.id === id) || null;
}

/** @returns {import('../types.js').Team} */
export function userTeam(save) {
  return teamById(save, save.userTeamId);
}

/** @returns {import('../types.js').Player[]} */
export function roster(save) {
  const t = userTeam(save);
  return (t && t.roster) || [];
}

/** Find a player on the user roster. */
export function findPlayer(save, id) {
  return roster(save).find((p) => p.id === id) || null;
}

/** Current season phase helpers. */
export const isRegular = (save) => save.season.phase === 'regular';
export const isPlayoffs = (save) => save.season.phase === 'playoffs';
export const isOffseason = (save) => save.season.phase === 'offseason';

/** Standard failure result for user actions. */
export function fail(reason, message, extra = {}) {
  return { ok: false, reason, message, ...extra };
}
