// Difficulty modes and the 16-step internal scale (MECHANICS §5.5).
// Easy -> 2, Medium -> 6, Hard -> 10, Extreme -> 16; Dynamic moves +1 per win, -1 per loss and
// is capped at step 9 until the coach's first title.

import { DIFFICULTY } from './config.js';
import { clamp } from '../core/util.js';

const LEGACY = ['easy', 'medium', 'hard', 'extreme', 'dynamic'];

/** Accept 'easy'|'medium'|'normal'|'hard'|'extreme'|'dynamic' or 0..4; default 'dynamic'. */
export function normalizeDifficulty(d) {
  if (typeof d === 'number' && LEGACY[d]) return LEGACY[d];
  if (typeof d === 'string') {
    const s = d.toLowerCase();
    if (s === 'normal') return 'medium';
    if (DIFFICULTY.modes.includes(s)) return s;
  }
  return 'dynamic';
}

/** Highest dynamic step currently allowed. */
export function dynamicCap(save) {
  return save.coach.titles > 0 ? DIFFICULTY.max : DIFFICULTY.capBeforeTitle;
}

/** Current internal difficulty step 1..16. */
export function difficultyStep(save) {
  const d = save.difficulty || { mode: 'dynamic', step: DIFFICULTY.dynamicStart };
  if (d.mode === 'dynamic') return clamp(d.step, DIFFICULTY.min, DIFFICULTY.max);
  return DIFFICULTY.steps[d.mode] ?? DIFFICULTY.pivot;
}

/**
 * Info for UI / match setup. `legacy` maps to PlaySetup.difficulty (0 easy, 1 normal, 2 hard).
 * @returns {{mode:string, label:string, step:number, cap:number, legacy:number}}
 */
export function difficultyInfo(save) {
  const step = difficultyStep(save);
  const mode = save.difficulty.mode;
  return {
    mode,
    label: mode === 'dynamic' ? `${DIFFICULTY.labels.dynamic} (${step})` : DIFFICULTY.labels[mode],
    step,
    cap: mode === 'dynamic' ? dynamicCap(save) : step,
    legacy: step <= 4 ? 0 : step <= 8 ? 1 : 2,
  };
}

/** Change the difficulty mode mid-career (keeps the dynamic step). */
export function setDifficulty(save, mode) {
  const m = normalizeDifficulty(mode);
  save.difficulty.mode = m;
  if (m === 'dynamic') save.difficulty.step = clamp(save.difficulty.step || DIFFICULTY.dynamicStart, DIFFICULTY.min, dynamicCap(save));
  return difficultyInfo(save);
}

/** Dynamic step after a user result: 'W' +1, 'L' -1, 'T' 0. */
export function updateDynamicDifficulty(save, result) {
  const d = save.difficulty;
  const from = difficultyStep(save);
  if (d.mode !== 'dynamic') return { from, to: from };
  const delta = result === 'W' ? 1 : result === 'L' ? -1 : 0;
  d.step = clamp(d.step + delta, DIFFICULTY.min, dynamicCap(save));
  return { from, to: d.step };
}
