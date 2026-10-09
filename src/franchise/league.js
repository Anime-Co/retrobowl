// League structure (MECHANICS §7.1): 32 teams with abstract OFF/DEF star ratings, the 16-game
// schedule, records, standings with tiebreakers, playoff seeding and the bracket.

import { TEAM_TEMPLATES, CONFERENCES, DIVISIONS } from '../data/teams.js';
import { LEAGUE, ROUNDS, ROUND_LABELS } from './config.js';
import { clamp } from '../core/util.js';
import { hashStr, round1, teamById } from './state.js';

/** @typedef {import('../types.js').Save} Save */
/** @typedef {import('../types.js').Team} Team */
/** @typedef {import('../types.js').Game} Game */

export function emptyRecord() {
  return { w: 0, l: 0, t: 0, pf: 0, pa: 0, divW: 0, divL: 0, divT: 0, confW: 0, confL: 0, confT: 0, streak: 0 };
}

export const clampRating = (v) => round1(clamp(v, LEAGUE.clampMin, LEAGUE.clampMax));

/**
 * Build the 32 league teams with spread-out AI ratings (roughly 1.5..4.5 stars).
 * @param {import('../core/rng.js').Rng} rng
 * @returns {Team[]}
 */
export function createTeams(rng) {
  const n = TEAM_TEMPLATES.length;
  const spread = (i) => LEAGUE.aiRatingMin + ((LEAGUE.aiRatingMax - LEAGUE.aiRatingMin) * (i + 0.5)) / n;
  const offs = rng.shuffle(Array.from({ length: n }, (_, i) => spread(i)));
  const defs = rng.shuffle(Array.from({ length: n }, (_, i) => spread(i)));
  const lim = (v) => round1(clamp(v, LEAGUE.aiRatingMin, LEAGUE.aiRatingMax));
  return TEAM_TEMPLATES.map((t, i) => ({
    id: t.id,
    city: t.city,
    abbr: t.abbr,
    conf: t.conf,
    div: t.div,
    colors: { primary: t.primary, secondary: t.secondary, helmet: t.helmet },
    off: lim(offs[i] + rng.normal(0, LEAGUE.aiRatingNoise)),
    def: lim(defs[i] + rng.normal(0, LEAGUE.aiRatingNoise)),
    record: emptyRecord(),
  }));
}

export const conferenceName = (c) => CONFERENCES[c];
export const divisionName = (c, d) => `${CONFERENCES[c]} ${DIVISIONS[d]}`;
export const roundLabel = (round) => ROUND_LABELS[round] || round;

/** Team ids of one division in template order. */
export function divisionIds(teams, conf, div) {
  return teams.filter((t) => t.conf === conf && t.div === div).map((t) => t.id);
}

export function makeGame(year, week, home, away, extra = {}) {
  return {
    id: `${year}-W${week}-${away}@${home}`,
    week,
    home,
    away,
    played: false,
    homeScore: 0,
    awayScore: 0,
    ot: false,
    playoff: !!extra.playoff,
    round: extra.round || null,
    neutral: !!extra.neutral,
  };
}

// --------------------------------------------------------------------------------- schedule

const K4_ROUNDS = [[[0, 1], [2, 3]], [[0, 2], [1, 3]], [[0, 3], [1, 2]]];
const INTRA_PAIRINGS = [[[0, 1], [2, 3]], [[0, 2], [1, 3]], [[0, 3], [1, 2]]];

/**
 * 16-game schedule (MECHANICS §7.1): 6 division games (home and away), 4 vs a same-conference
 * division, 4 vs an other-conference division, 2 vs same-place finishers. Every team plays
 * exactly once per week, 8 home / 8 away. Built as 16 perfect matchings, then the weeks are
 * shuffled (a division round always closes the season).
 * @param {Team[]} teams
 * @param {number} year
 * @param {import('../core/rng.js').Rng} rng
 * @param {Object<string, number>|null} divRanks  last season's division finish (0 = first)
 * @returns {Game[]}
 */
export function generateSchedule(teams, year, rng, divRanks = null) {
  const div = (c, d) => divisionIds(teams, c, d);
  const ranked = (c, d) => {
    const ids = div(c, d);
    if (!divRanks) return ids;
    return [...ids].sort((a, b) => (divRanks[a] ?? 9) - (divRanks[b] ?? 9) || ids.indexOf(a) - ids.indexOf(b));
  };
  const flip = year % 2 === 1;
  const orient = (h, a) => (flip ? [a, h] : [h, a]);
  const rounds = [];

  // Division double round robin: 6 rounds.
  for (let half = 0; half < 2; half++) {
    for (const r of K4_ROUNDS) {
      const games = [];
      for (let c = 0; c < 2; c++) {
        for (let d = 0; d < 4; d++) {
          const ids = div(c, d);
          for (const [i, j] of r) games.push(half === 0 ? orient(ids[i], ids[j]) : orient(ids[j], ids[i]));
        }
      }
      rounds.push({ kind: 'division', games });
    }
  }

  // Complete bipartite 4x4 between two divisions: 4 rounds, 2 home / 2 away each.
  const bipartite = (X, Y, k) => {
    const out = [];
    for (let i = 0; i < 4; i++) {
      const j = (i + k) % 4;
      out.push((i + j + year) % 2 === 0 ? [X[i], Y[j]] : [Y[j], X[i]]);
    }
    return out;
  };

  const pairing = INTRA_PAIRINGS[year % 3];
  for (let k = 0; k < 4; k++) {
    const games = [];
    for (let c = 0; c < 2; c++) {
      for (const [dx, dy] of pairing) games.push(...bipartite(div(c, dx), div(c, dy), k));
    }
    rounds.push({ kind: 'conference', games });
  }

  for (let k = 0; k < 4; k++) {
    const games = [];
    for (let d = 0; d < 4; d++) games.push(...bipartite(div(0, d), div(1, (d + year) % 4), k));
    rounds.push({ kind: 'interconference', games });
  }

  // Same-place: rank r of the paired divisions (A,B) plays rank r of the other pair (C,D).
  for (let m = 0; m < 2; m++) {
    const games = [];
    for (let c = 0; c < 2; c++) {
      const [[a, b], [cc, dd]] = pairing;
      const A = ranked(c, a);
      const B = ranked(c, b);
      const C = ranked(c, cc);
      const D = ranked(c, dd);
      for (let r = 0; r < 4; r++) {
        if (m === 0) games.push(orient(A[r], C[r]), orient(B[r], D[r]));
        else games.push(orient(D[r], A[r]), orient(C[r], B[r]));
      }
    }
    rounds.push({ kind: 'sameplace', games });
  }

  // Shuffle week order; keep a division round for the finale.
  const divIdx = rounds.map((r, i) => (r.kind === 'division' ? i : -1)).filter((i) => i >= 0);
  const finaleIdx = rng.pick(divIdx);
  const finale = rounds[finaleIdx];
  const rest = rng.shuffle(rounds.filter((_, i) => i !== finaleIdx));
  const ordered = [...rest, finale];
  const schedule = [];
  ordered.forEach((r, w) => {
    for (const [home, away] of r.games) schedule.push(makeGame(year, w + 1, home, away));
  });
  return schedule;
}

// ---------------------------------------------------------------------------------- records

/** Winner team id of a played game, or null for a tie. */
export function gameWinner(game) {
  if (!game.played || game.homeScore === game.awayScore) return null;
  return game.homeScore > game.awayScore ? game.home : game.away;
}

export function gameLoser(game) {
  const w = gameWinner(game);
  if (!w) return null;
  return w === game.home ? game.away : game.home;
}

function updateRecord(t, pf, pa, opp) {
  const r = t.record;
  const sameConf = t.conf === opp.conf;
  const sameDiv = sameConf && t.div === opp.div;
  r.pf += pf;
  r.pa += pa;
  if (pf > pa) {
    r.w += 1;
    if (sameDiv) r.divW += 1;
    if (sameConf) r.confW += 1;
    r.streak = r.streak > 0 ? r.streak + 1 : 1;
  } else if (pf < pa) {
    r.l += 1;
    if (sameDiv) r.divL += 1;
    if (sameConf) r.confL += 1;
    r.streak = r.streak < 0 ? r.streak - 1 : -1;
  } else {
    r.t += 1;
    if (sameDiv) r.divT += 1;
    if (sameConf) r.confT += 1;
    r.streak = 0;
  }
}

/** Apply a played regular-season game to both teams' records (playoff games are ignored). */
export function recordGame(save, game) {
  if (game.playoff) return;
  const h = teamById(save, game.home);
  const a = teamById(save, game.away);
  updateRecord(h, game.homeScore, game.awayScore, a);
  updateRecord(a, game.awayScore, game.homeScore, h);
}

/** Rebuild every team record from the schedule (for checks/repair). */
export function recomputeRecords(save) {
  for (const t of save.teams) t.record = emptyRecord();
  const played = save.season.schedule.filter((g) => g.played && !g.playoff).sort((a, b) => a.week - b.week);
  for (const g of played) recordGame(save, g);
}

const pct = (w, l, t) => (w + l + t > 0 ? (w + 0.5 * t) / (w + l + t) : 0);
export const winPct = (r) => pct(r.w, r.l, r.t);
export const recordText = (r) => (r.t ? `${r.w}-${r.l}-${r.t}` : `${r.w}-${r.l}`);
export const streakText = (s) => (s > 0 ? `W${s}` : s < 0 ? `L${-s}` : '-');

// ------------------------------------------------------------------------------ tiebreakers

function h2hPct(save, id, group) {
  let w = 0;
  let g = 0;
  for (const game of save.season.schedule) {
    if (!game.played || game.playoff) continue;
    let opp = null;
    if (game.home === id) opp = game.away;
    else if (game.away === id) opp = game.home;
    if (!opp || !group.includes(opp)) continue;
    g += 1;
    const win = gameWinner(game);
    if (win === id) w += 1;
    else if (win === null) w += 0.5;
  }
  return g ? w / g : 0.5;
}

/** Deterministic per-season coin flip in [0,1). */
export function coinFlip(save, id) {
  return hashStr(`${save.seed}|${save.season.year}|coin|${id}`) / 4294967296;
}

const CRITERIA = [
  (save, id) => winPct(teamById(save, id).record),
  (save, id, group) => h2hPct(save, id, group),
  (save, id) => { const r = teamById(save, id).record; return pct(r.divW, r.divL, r.divT); },
  (save, id) => { const r = teamById(save, id).record; return pct(r.confW, r.confL, r.confT); },
  (save, id) => { const r = teamById(save, id).record; return r.pf - r.pa; },
  (save, id) => coinFlip(save, id),
];

function rankGroup(save, ids, start) {
  if (ids.length <= 1) return ids;
  for (let c = start; c < CRITERIA.length; c++) {
    const val = new Map(ids.map((id) => [id, CRITERIA[c](save, id, ids)]));
    const sorted = [...ids].sort((a, b) => val.get(b) - val.get(a) || (a < b ? -1 : a > b ? 1 : 0));
    const groups = [];
    for (const id of sorted) {
      const last = groups[groups.length - 1];
      if (last && Math.abs(val.get(last[0]) - val.get(id)) < 1e-9) last.push(id);
      else groups.push([id]);
    }
    if (groups.length > 1) return groups.flatMap((g) => rankGroup(save, g, 1));
  }
  return [...ids].sort();
}

/**
 * Order team ids best-first: win%, head-to-head, division win%, conference win%, point
 * differential, coin flip (MECHANICS §7.1). Multi-team ties restart at head-to-head within each
 * split subgroup. Independent of input order.
 */
export function rankTeams(save, ids) {
  return rankGroup(save, [...ids].sort(), 0);
}

function standingRow(save, id, rank) {
  const t = teamById(save, id);
  const r = t.record;
  return {
    rank,
    teamId: id,
    city: t.city,
    abbr: t.abbr,
    conf: t.conf,
    div: t.div,
    w: r.w,
    l: r.l,
    t: r.t,
    pct: Math.round(winPct(r) * 1000) / 1000,
    pf: r.pf,
    pa: r.pa,
    diff: r.pf - r.pa,
    divRecord: recordText({ w: r.divW, l: r.divL, t: r.divT }),
    confRecord: recordText({ w: r.confW, l: r.confL, t: r.confT }),
    record: recordText(r),
    streak: r.streak,
    streakText: streakText(r.streak),
    isUser: id === save.userTeamId,
  };
}

/**
 * Sorted standings rows. Filter with {conf} and/or {div}.
 * @param {Save} save
 * @param {{conf?:number, div?:number}} [filter]
 */
export function standings(save, filter = {}) {
  let teams = save.teams;
  if (filter.conf != null) teams = teams.filter((t) => t.conf === filter.conf);
  if (filter.div != null) teams = teams.filter((t) => t.div === filter.div);
  return rankTeams(save, teams.map((t) => t.id)).map((id, i) => standingRow(save, id, i + 1));
}

/** All eight divisions with sorted rows: [{conf, div, name, rows}] */
export function divisionStandings(save) {
  const out = [];
  for (let c = 0; c < CONFERENCES.length; c++) {
    for (let d = 0; d < DIVISIONS.length; d++) {
      out.push({ conf: c, div: d, name: divisionName(c, d), rows: standings(save, { conf: c, div: d }) });
    }
  }
  return out;
}

/** Division finish map {teamId: 0..3} for same-place scheduling. */
export function divisionRanks(save) {
  const ranks = {};
  for (const d of divisionStandings(save)) d.rows.forEach((row, i) => { ranks[row.teamId] = i; });
  return ranks;
}

// --------------------------------------------------------------------------------- playoffs

/** 7 seeds for a conference: 4 division winners (1-4), then 3 wildcards. */
export function playoffSeeds(save, conf) {
  const winners = [];
  for (let d = 0; d < DIVISIONS.length; d++) winners.push(rankTeams(save, divisionIds(save.teams, conf, d))[0]);
  const confIds = save.teams.filter((t) => t.conf === conf).map((t) => t.id);
  const rest = rankTeams(save, confIds.filter((id) => !winners.includes(id)));
  return [...rankTeams(save, winners), ...rest.slice(0, LEAGUE.playoffTeamsPerConf - winners.length)];
}

export const weekOfRound = (round) => LEAGUE.regularWeeks + ROUNDS.indexOf(round) + 1;

/** Seed the bracket from final standings and schedule the wild-card round. */
export function startPlayoffs(save) {
  const seeds = [playoffSeeds(save, 0), playoffSeeds(save, 1)];
  save.season.playoffs = {
    seeds,
    alive: [seeds[0].slice(), seeds[1].slice()],
    round: null,
    champion: null,
    runnerUp: null,
    eliminated: {},
  };
  save.season.phase = 'playoffs';
  createPlayoffRound(save, 'wildcard');
}

/** Create the games of a playoff round (higher seed hosts; the Final is neutral). */
export function createPlayoffRound(save, round) {
  const pl = save.season.playoffs;
  const week = weekOfRound(round);
  const year = save.season.year;
  const games = [];
  const add = (home, away, neutral = false) => games.push(makeGame(year, week, home, away, { playoff: true, round, neutral }));
  if (round === 'final') {
    const [home, away] = rankTeams(save, [pl.alive[0][0], pl.alive[1][0]]);
    add(home, away, true);
  } else {
    for (let c = 0; c < 2; c++) {
      const seeds = pl.seeds[c];
      const alive = pl.alive[c];
      if (round === 'wildcard') {
        add(seeds[1], seeds[6]);
        add(seeds[2], seeds[5]);
        add(seeds[3], seeds[4]);
      } else if (round === 'divisional') {
        add(alive[0], alive[3]);
        add(alive[1], alive[2]);
      } else {
        add(alive[0], alive[1]);
      }
    }
  }
  pl.round = round;
  save.season.week = week;
  save.season.schedule.push(...games);
  return games;
}

/**
 * Resolve the current round once all its games are played: losers leave the bracket.
 * @returns {{round:string, done:boolean, losers:string[]}}
 */
export function completePlayoffRound(save) {
  const pl = save.season.playoffs;
  const round = pl.round;
  const games = save.season.schedule.filter((g) => g.playoff && g.round === round);
  const losers = [];
  for (const g of games) {
    const loser = gameLoser(g);
    if (!loser) throw new Error(`playoff game ${g.id} has no winner`);
    losers.push(loser);
    pl.eliminated[loser] = round;
    for (let c = 0; c < 2; c++) pl.alive[c] = pl.alive[c].filter((id) => id !== loser);
    if (round === 'final') {
      pl.champion = gameWinner(g);
      pl.runnerUp = loser;
    }
  }
  return { round, done: round === 'final', losers };
}

export const nextRound = (round) => ROUNDS[ROUNDS.indexOf(round) + 1] || null;

/** True while the team is still in the bracket. */
export function isAlive(save, teamId) {
  const pl = save.season.playoffs;
  if (!pl || save.season.phase !== 'playoffs') return false;
  return pl.alive.some((a) => a.includes(teamId));
}

/** Seed (1..7) of a team in the current bracket, or 0. */
export function seedOf(save, teamId) {
  const pl = save.season.playoffs;
  if (!pl) return 0;
  for (const s of pl.seeds) {
    const i = s.indexOf(teamId);
    if (i >= 0) return i + 1;
  }
  return 0;
}

/**
 * Playoff picture for the UI. Regular season: projected seeds and the next teams in the hunt.
 * Playoffs/offseason: actual seeds and who is still alive.
 */
export function playoffPicture(save) {
  const pl = save.season.playoffs;
  const conferences = [];
  for (let c = 0; c < CONFERENCES.length; c++) {
    const seeds = pl ? pl.seeds[c] : playoffSeeds(save, c);
    const winners = new Set();
    for (let d = 0; d < DIVISIONS.length; d++) winners.add(rankTeams(save, divisionIds(save.teams, c, d))[0]);
    const lead = teamById(save, seeds[seeds.length - 1]).record;
    const confIds = save.teams.filter((t) => t.conf === c).map((t) => t.id);
    const hunt = rankTeams(save, confIds.filter((id) => !seeds.includes(id))).slice(0, 3).map((id) => {
      const r = teamById(save, id).record;
      return { teamId: id, abbr: teamById(save, id).abbr, record: recordText(r), gamesBack: ((lead.w - r.w) + (r.l - lead.l)) / 2 };
    });
    conferences.push({
      conf: c,
      name: CONFERENCES[c],
      seeds: seeds.map((id, i) => {
        const t = teamById(save, id);
        return {
          seed: i + 1,
          teamId: id,
          abbr: t.abbr,
          city: t.city,
          record: recordText(t.record),
          divWinner: winners.has(id),
          alive: pl ? pl.alive[c].includes(id) : true,
          eliminatedIn: pl ? pl.eliminated[id] || null : null,
          isUser: id === save.userTeamId,
        };
      }),
      hunt,
    });
  }
  return {
    phase: save.season.phase,
    round: pl ? pl.round : null,
    champion: pl ? pl.champion : null,
    runnerUp: pl ? pl.runnerUp : null,
    conferences,
  };
}

/** AI rating drift between seasons with mean reversion and a draft boost after bad years. */
export function driftAiRatings(save, rng) {
  for (const t of save.teams) {
    if (t.id === save.userTeamId) continue;
    const p = winPct(t.record);
    const bump = p < LEAGUE.badSeasonPct ? LEAGUE.badSeasonBoost : p > LEAGUE.goodSeasonPct ? -LEAGUE.goodSeasonPenalty : 0;
    for (const k of ['off', 'def']) {
      const v = t[k] + (LEAGUE.driftMean - t[k]) * LEAGUE.driftReversion + rng.normal(0, LEAGUE.driftSd) + bump / 2;
      t[k] = clampRating(v);
    }
  }
}

export { ROUNDS, ROUND_LABELS, CONFERENCES, DIVISIONS };
