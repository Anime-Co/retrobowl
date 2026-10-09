// Draft (MECHANICS §7.7): ~60 prospects aged 21-23 with estimated star ranges, scouting for
// 1 CC reveals exact stars and potential, order is reverse standings (champion last), 3 rounds.
// AI teams are abstract and sometimes pass. A user pick needs a free roster spot and cap room;
// rookies sign 3-year deals at 0.5-1.5 $M.

import { DRAFT, ROSTER, ROOKIE_CONTRACT } from './config.js';
import { createPlayer, stars, potentialStars, rookieSalary, fullName, shortName, assignFreeNumber } from './players.js';
import { clamp } from '../core/util.js';
import { roster, userTeam, teamById, fail, rngOf, commitRng } from './state.js';
import { rankTeams } from './league.js';
import { capRoom, spendCc } from './economy.js';
import { refreshUserRatings } from './squad.js';
import { addHeadline } from './feed.js';

/** @typedef {import('../types.js').Save} Save */

const ELIM_ORDER = ['wildcard', 'divisional', 'conference'];

/**
 * Draft order (worst first): non-playoff teams by record, then playoff teams by the round they
 * were eliminated in, runner-up, and the champion last.
 * @returns {string[]}
 */
export function draftOrder(save) {
  const pl = save.season.playoffs;
  const all = save.teams.map((t) => t.id);
  const worstFirst = (ids) => rankTeams(save, ids).reverse();
  if (!pl) return worstFirst(all);
  const inPlayoffs = new Set([...pl.seeds[0], ...pl.seeds[1]]);
  const order = worstFirst(all.filter((id) => !inPlayoffs.has(id)));
  for (const round of ELIM_ORDER) order.push(...worstFirst(all.filter((id) => pl.eliminated[id] === round)));
  if (pl.runnerUp) order.push(pl.runnerUp);
  if (pl.champion) order.push(pl.champion);
  // Safety: anyone not placed (bracket incomplete) goes before the playoff teams.
  const placed = new Set(order);
  const missing = all.filter((id) => !placed.has(id));
  return [...worstFirst(missing), ...order];
}

const halfRound = (v) => Math.round(v * 2) / 2;

/** Generate the prospect class (Player objects + `draft` estimate info). */
export function generateProspects(save, rng, n = DRAFT.prospects) {
  const posKeys = Object.keys(DRAFT.posWeights);
  const posW = posKeys.map((k) => DRAFT.posWeights[k]);
  const starVals = DRAFT.stars.map((x) => x[0]);
  const starW = DRAFT.stars.map((x) => x[1]);
  const takenNames = new Set(roster(save).map((p) => `${p.first} ${p.last}`));
  const out = [];
  for (let i = 0; i < n; i++) {
    const pos = rng.weighted(posKeys, posW);
    const age = rng.int(DRAFT.ageMin, DRAFT.ageMax);
    const p = createPlayer(save, rng, {
      pos,
      stars: rng.weighted(starVals, starW),
      age,
      rookie: true,
      potentialBonus: rng.int(DRAFT.potentialBonus[0], DRAFT.potentialBonus[1]),
      takenNames,
      year: save.season.year + 1,
    });
    takenNames.add(`${p.first} ${p.last}`);
    const s = stars(p);
    p.contract = { salary: rookieSalary(s), years: ROOKIE_CONTRACT.years };
    const width = rng.pick([1, 1.5, 2]);
    const lo = clamp(halfRound(s - rng.int(0, width * 2) / 2), 0.5, 5);
    const hi = clamp(lo + width, 0.5, 5);
    p.draft = { lo: Math.min(lo, s), hi: Math.max(hi, s), scouted: false };
    out.push(p);
  }
  return out;
}

/** Create the draft (prospects, 3 rounds of picks) and run AI picks up to the user's turn. */
export function startDraft(save, rng) {
  const order = draftOrder(save);
  const picks = [];
  for (let r = 0; r < DRAFT.rounds; r++) {
    order.forEach((teamId, i) => picks.push({ overall: r * order.length + i + 1, round: r + 1, pick: i + 1, teamId, prospectId: null, name: null, pos: null, stars: null, passed: false }));
  }
  save.draft = { year: save.season.year, prospects: generateProspects(save, rng), picks, index: 0, done: false };
  runAiPicks(save, rng);
  return save.draft;
}

function prospectValue(p) {
  return stars(p) + 0.45 * potentialStars(p);
}

/** AI teams pick (or pass) until it is the user's turn or the draft ends. */
export function runAiPicks(save, rng) {
  const d = save.draft;
  if (!d) return;
  while (d.index < d.picks.length && d.picks[d.index].teamId !== save.userTeamId) {
    const pick = d.picks[d.index];
    if (d.prospects.length && rng.chance(DRAFT.aiPickChance[pick.round - 1] ?? 0.3)) {
      let best = null;
      let bestV = -Infinity;
      for (const p of d.prospects) {
        const v = prospectValue(p) + rng.normal(0, DRAFT.aiNoise);
        if (v > bestV) { bestV = v; best = p; }
      }
      d.prospects = d.prospects.filter((p) => p !== best);
      Object.assign(pick, { prospectId: best.id, name: shortName(best), pos: best.pos, stars: stars(best) });
    } else {
      pick.passed = true;
    }
    d.index += 1;
  }
  if (d.index >= d.picks.length) d.done = true;
}

/** True when the user is on the clock. */
export function userOnClock(save) {
  const d = save.draft;
  return !!(d && !d.done && d.index < d.picks.length && d.picks[d.index].teamId === save.userTeamId);
}

/** Current pick info for the UI. */
export function draftStatus(save) {
  const d = save.draft;
  if (!d) return null;
  const cur = d.done ? null : d.picks[d.index];
  return {
    year: d.year,
    done: d.done,
    onClock: userOnClock(save),
    current: cur ? { ...cur, team: teamById(save, cur.teamId).abbr } : null,
    userPicks: d.picks.filter((p) => p.teamId === save.userTeamId),
    made: d.picks.slice(0, d.index).filter((p) => p.prospectId).map((p) => ({ ...p, team: teamById(save, p.teamId).abbr })),
    rosterSpace: ROSTER.cap - roster(save).length,
  };
}

/** Prospect views (best estimate first). Hidden values are null until scouted. */
export function draftProspects(save) {
  const d = save.draft;
  if (!d) return [];
  return d.prospects
    .map((p) => ({
      id: p.id,
      name: fullName(p),
      shortName: shortName(p),
      pos: p.pos,
      age: p.age,
      number: p.number,
      scouted: p.draft.scouted,
      estimate: { lo: p.draft.lo, hi: p.draft.hi },
      stars: p.draft.scouted ? stars(p) : null,
      potential: p.draft.scouted ? potentialStars(p) : null,
      attrs: p.draft.scouted ? { ...p.attrs } : null,
      salary: p.contract.salary,
      years: p.contract.years,
      traits: p.draft.scouted ? [...p.traits] : [],
    }))
    .sort((a, b) => (b.estimate.lo + b.estimate.hi) - (a.estimate.lo + a.estimate.hi) || (a.id < b.id ? -1 : 1));
}

/** Spend 1 CC to reveal a prospect's exact stars and potential. */
export function scoutProspect(save, id) {
  const d = save.draft;
  if (!d || d.done) return fail('noDraft', 'The draft is not open.');
  const p = d.prospects.find((x) => x.id === id);
  if (!p) return fail('notFound', 'Prospect not available.');
  if (p.draft.scouted) return fail('scouted', 'Already scouted.');
  if (!spendCc(save, DRAFT.scoutCost)) return fail('cc', `Need ${DRAFT.scoutCost} CC.`);
  p.draft.scouted = true;
  return { ok: true, stars: stars(p), potential: potentialStars(p), attrs: { ...p.attrs } };
}

/**
 * Draft a prospect with the user's current pick (needs a roster spot and cap room).
 * AI picks then continue to the user's next pick.
 */
export function draftPlayer(save, id) {
  if (!userOnClock(save)) return fail('notOnClock', 'You are not on the clock.');
  const d = save.draft;
  const p = d.prospects.find((x) => x.id === id);
  if (!p) return fail('notFound', 'Prospect not available.');
  if (roster(save).length >= ROSTER.cap) return fail('rosterFull', `Roster is full (${ROSTER.cap}). Release a player or pass.`);
  if (p.contract.salary > capRoom(save)) return fail('cap', 'Not enough cap room for the rookie deal.');
  const pick = d.picks[d.index];
  d.prospects = d.prospects.filter((x) => x !== p);
  delete p.draft;
  p.drafted = { year: d.year, round: pick.round, overall: pick.overall };
  p.rookie = true;
  assignFreeNumber(save, p, userTeam(save).roster);
  userTeam(save).roster.push(p);
  Object.assign(pick, { prospectId: p.id, name: shortName(p), pos: p.pos, stars: stars(p) });
  d.index += 1;
  refreshUserRatings(save);
  addHeadline(save, `${userTeam(save).city} draft ${p.pos} ${shortName(p)} in round ${pick.round} (#${pick.overall}).`, 'draft');
  const rng = rngOf(save);
  runAiPicks(save, rng);
  commitRng(save, rng);
  return { ok: true, player: p, pick: { ...pick } };
}

/** Pass on the user's current pick. */
export function passPick(save) {
  if (!userOnClock(save)) return fail('notOnClock', 'You are not on the clock.');
  const d = save.draft;
  d.picks[d.index].passed = true;
  d.index += 1;
  const rng = rngOf(save);
  runAiPicks(save, rng);
  commitRng(save, rng);
  return { ok: true };
}

/** Complete the draft: the user passes any remaining picks. */
export function finishDraft(save, rng) {
  const d = save.draft;
  if (!d) return null;
  let guard = 0;
  while (!d.done && guard++ < 1000) {
    if (userOnClock(save)) {
      d.picks[d.index].passed = true;
      d.index += 1;
    }
    runAiPicks(save, rng);
  }
  d.prospects = [];
  return d.picks.filter((p) => p.teamId === save.userTeamId);
}
