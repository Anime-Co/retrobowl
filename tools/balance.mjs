#!/usr/bin/env node
// Balance harness: plays FULL matches and whole careers headless with the REAL engine and prints a
// balance report. Nothing here is a stand-in model: every user snap is a PlaySim play driven by the
// SimBot (src/play/sim/bot.js), the Match state machine (src/match/logic) runs the clock, the
// decisions and the simulated opponent possessions, squads come from the franchise (buildSquad /
// matchSetup), and careers go through applyUserGameResult / advanceWeek / the offseason pipeline.
//
// Usage:
//   node tools/balance.mjs [suite ...] [--n=N] [--skill=0.6] [--seasons=4] [--careers=N]
//                          [--workers=K] [--seed=S] [--qm=2] [--quick]
//   npm run balance -- drives match        (suggested script: "balance": "node tools/balance.mjs")
//
// Suites (default: all):
//   drives    simulated opponent possessions straight from simDrive (outcome table by rating gap,
//             difficulty and start spot)
//   ai        AI-vs-AI league games (franchise gameSim): score distribution, standings spread
//   ratings   team OFF/DEF of new careers and how they respond to signing stars
//   match     full matches with the real engine: equal 3★ v 3★ by difficulty, by bot skill
//   quarters  possessions per team for 1/2/3-minute quarters
//   career    new careers on Dynamic for casual/average/good bots: records, playoffs, firing,
//             CC purchases, cap pressure
//
// Options: --n matches per cell (default 60), --careers careers per skill (default 6),
//   --seasons seasons per career (default 4), --workers parallel worker threads (default: CPUs),
//   --quick small samples (smoke run), --set path=json what-if override applied in every worker
//   (roots: match = src/match/logic/config.js CFG, play = src/play/sim/tuning.js TUNING,
//   franchise = src/franchise/config.js exports), e.g. --set match.sim.scoreBase=-0.2
//   --set franchise.DIFFICULTY.offsetPerStep=0.15. Bot skill: 0.45 casual, 0.6 average, 0.75 good.
//
// The exported functions are reused by tests/unit/balance.test.js (small, fast samples).

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';

import { Rng } from '../src/core/rng.js';
import { Match } from '../src/match/logic/Match.js';
import { CFG, simScale } from '../src/match/logic/config.js';
import { simDrive } from '../src/match/logic/simDrive.js';
import { PlaySim } from '../src/play/sim/PlaySim.js';
import { SimBot } from '../src/play/sim/bot.js';
import { TUNING } from '../src/play/sim/tuning.js';
import * as F from '../src/franchise/index.js';
import * as FCONFIG from '../src/franchise/config.js';
import { createPlayer } from '../src/franchise/players.js';

export const SKILL = { casual: 0.45, average: 0.6, good: 0.75 };
export const STEP = { easy: 2, medium: 6, hard: 10, extreme: 16 };

// =============================================================================================
// The human: coaching decisions and between-play timing
// =============================================================================================

/**
 * A sensible human coach (decisions mirror src/match/autopilot.js, plus situational 4th downs
 * and realistic between-play time). Own Rng: never touches the match stream.
 */
export class Coach {
  constructor(seed = 1, skill = SKILL.average) {
    this.rng = new Rng((seed >>> 0) || 1);
    this.skill = skill;
  }

  situation(m) {
    const st = m.state;
    const scale = simScale(st.quarterMinutes);
    const diff = st.score.user - st.score.opp;
    const trailingLate = st.quarter === 4 && st.clock < 120 * scale && diff <= 0;
    const endOfHalf = st.quarter === 2 && st.clock < 40 * scale;
    const leadingLate = st.quarter === 4 && diff > 0 && st.clock < 150 * scale;
    return { st, scale, diff, hurry: trailingLate || endOfHalf || (st.quarter >= 5 && diff < 0), leadingLate };
  }

  decide(m, step) {
    const { st, scale, diff } = this.situation(m);
    const ids = step.options.map((o) => o.id);
    const rng = this.rng;
    if (step.kind === 'fourth') {
      const lateTrail = st.quarter >= 4 && diff < 0 && st.clock < 150 * scale;
      const lateLead = st.quarter >= 4 && diff > 0 && st.clock < 150 * scale;
      // arcade coaches go for it on short yardage in enemy territory (fewer chip-shot FGs)
      if (!lateLead && st.toGo <= 2 && st.ballOn >= 60 && rng.chance(0.6)) return 'go';
      if (ids.includes('fg') && !(lateTrail && diff < -3)) return 'fg';
      if (lateTrail) return 'go';
      if (st.toGo <= 1.5 && st.ballOn >= 40 && rng.chance(0.6)) return 'go';
      if (st.toGo <= 3 && st.ballOn >= 55 && !ids.includes('fg') && rng.chance(0.5)) return 'go';
      if (ids.includes('punt')) return 'punt';
      return 'go';
    }
    if (step.kind === 'conversion') {
      if (st.quarter >= 4 && [-2, -5, -10, 1, 5].includes(diff)) return 'two';
      return rng.chance(0.06) ? 'two' : 'pat';
    }
    if (step.kind === 'onside') return st.clock < 75 * scale || (diff <= -9 && rng.chance(0.5)) ? 'onside' : 'kickoff';
    return step.options[0].id;
  }

  /** Game-clock seconds between the whistle and the next snap while the clock runs. */
  presnapSeconds(m) {
    const { hurry, leadingLate } = this.situation(m);
    const r = this.rng;
    if (hurry) return r.float(0.7, 1.8);
    if (leadingLate) return r.float(8, 16);
    // post-play beat (1.4 s, often tapped through) + reading the assigned play
    return r.float(0.6, 1.4) + r.float(1.0, 3.2) * (1.25 - 0.5 * this.skill);
  }

  wantsTimeout(m) {
    const { st, scale, hurry } = this.situation(m);
    return hurry && st.clockRunning && st.clock < 45 * scale;
  }

  wantsFieldGoal(m) {
    const { st, diff } = this.situation(m);
    if (st.quarter >= 5) return true;
    return st.clock <= 10 && (diff >= -3 || st.quarter === 2);
  }
}

// =============================================================================================
// One full match with the real engine
// =============================================================================================

function runClock(m, seconds) {
  let left = seconds;
  while (left > 1e-9 && m.state.clockRunning) {
    const dt = Math.min(0.25, left);
    left -= dt;
    if (m.tickClock(dt)) return true;
  }
  return false;
}

/** Drive one PlaySim play for a play / kick / kick_return step. Returns false if withdrawn. */
function playStep(m, step, coach, botOpts, tally) {
  const sim = new PlaySim(step.setup);
  if (step.type === 'play' && !step.twoPoint && m.state.audiblesLeft > 0 && coach.rng.chance(0.05) && m.useAudible()) {
    sim.changePlay();
  }
  const noise = 1 + (SKILL.average - botOpts.skill) * 1.2;
  const bot = new SimBot({
    seed: ((step.setup.seed >>> 0) ^ 0x5bd1e995) >>> 0,
    skill: botOpts.skill,
    powerNoise: 0.065 * noise,
    aimNoise: 0.055 * noise,
  });
  const dt = TUNING.step;
  let snapped = false;
  for (let i = 0; i < 60 * 60 && !sim.result; i++) {
    bot.step(sim, dt);
    sim.update(dt);
    if (!snapped && sim.phase !== 'presnap') {
      snapped = true;
      m.onSnap();
    }
    if (m.state.clockRunning && m.tickClock(dt) && !snapped) return false;
  }
  if (!sim.result) throw new Error('play did not finish');
  if (tally) {
    const r = sim.result;
    const t = tally.plays;
    if (step.type === 'play' && !step.twoPoint) {
      tally.userPlays += 1;
      tally.playSecs += r.elapsed || 0;
      if (sim._thrown || sim._sacked || r.type === 'pass') {
        t.dropbacks += 1;
        if (sim._sacked) t.sacks += 1;
        if (sim._thrown) t.att += 1;
        if (sim._completed) t.cmp += 1;
        if (r.outcome === 'interception') t.ints += 1;
        t.passYds += r.outcome === 'interception' ? 0 : r.yards || 0;
      } else {
        t.runs += 1;
        t.runYds += r.yards || 0;
      }
      if (r.firstDown) t.firstDowns += 1;
      if (r.outcome === 'fumble' || (r.turnover && r.outcome !== 'interception')) t.fumbles += 1;
    } else if (step.type === 'kick' && step.kind === 'fg') {
      t.fgAtt += 1;
      t.fgDist += step.distance;
      if (r.outcome === 'fg_good') t.fgMade += 1;
    } else if (step.type === 'kick' && step.kind === 'pat') {
      t.patAtt += 1;
      if (r.outcome === 'pat_good') t.patMade += 1;
    } else if (step.type === 'kick_return') {
      t.returns += 1;
      t.returnStart += r.outcome === 'touchback' ? 25 : Math.max(0, Math.min(100, (r.endX ?? 35) - 10));
    }
  }
  m.submitPlay(sim.result);
  return true;
}

/**
 * Play one complete match. `o` is a Match options object (as built from F.matchSetup) plus
 * {skill, quarterMinutes, difficultyStep, wind, easyOtFirst}.
 * @returns {{result:Object, info:Object}}
 */
export function playMatch(o) {
  const skill = o.skill ?? SKILL.average;
  const m = new Match({
    ...o,
    settings: {
      quarterMinutes: o.quarterMinutes ?? 2,
      difficultyStep: o.difficultyStep ?? 6,
      wind: o.wind ?? 'normal',
      easyOtFirst: !!o.easyOtFirst,
    },
  });
  const coach = new Coach(((o.seed ?? 1) ^ 0x9e3779b9) >>> 0, skill);
  const tally = {
    userPlays: 0,
    playSecs: 0,
    oppDrives: [],
    maxBall: new Map(),
    plays: { dropbacks: 0, att: 0, cmp: 0, sacks: 0, ints: 0, passYds: 0, runs: 0, runYds: 0, firstDowns: 0, fumbles: 0, fgAtt: 0, fgMade: 0, fgDist: 0, patAtt: 0, patMade: 0, returns: 0, returnStart: 0 },
  };
  for (let guard = 0; guard < 20000; guard++) {
    const step = m.next();
    switch (step.type) {
      case 'final':
        return { result: step.result, info: matchInfo(m, step.result, tally) };
      case 'opp_drive':
        tally.oppDrives.push({ outcome: step.outcome, start: step.startYard, points: step.points });
        m.ack();
        break;
      case 'coin':
      case 'auto':
      case 'quarter_end':
      case 'halftime':
      case 'ot_start':
        m.ack();
        break;
      case 'decision':
        if (step.kind === 'fourth' && coach.wantsTimeout(m)) m.callTimeout();
        m.choose(coach.decide(m, step));
        break;
      case 'play': {
        if (!step.twoPoint) {
          if (m.fieldGoalAvailable() && coach.wantsFieldGoal(m) && m.choose('fg')) break;
          if (coach.wantsTimeout(m)) m.callTimeout();
          if (m.state.clockRunning) {
            let pre = coach.presnapSeconds(m);
            // a human kicks the end-of-half field goal before the clock dies
            if (m.fieldGoalAvailable() && m.state.clock - pre < 4) pre = Math.max(0, m.state.clock - 4);
            if (runClock(m, pre)) break;
            if (m.fieldGoalAvailable() && coach.wantsFieldGoal(m) && m.choose('fg')) break;
          }
        }
        const drive = m.drives[m.drives.length - 1];
        if (drive && drive.team === 'user' && !step.twoPoint) tally.maxBall.set(drive, Math.max(tally.maxBall.get(drive) ?? 0, m.state.ballOn));
        playStep(m, step, coach, { skill }, tally);
        break;
      }
      case 'kick':
      case 'kick_return':
        playStep(m, step, coach, { skill }, tally);
        break;
      default:
        throw new Error(`unknown step ${step.type}`);
    }
  }
  throw new Error('match did not finish');
}

function matchInfo(m, result, tally) {
  const drives = m.drives;
  const user = drives.filter((d) => d.team === 'user' && d.how !== 'return');
  const opp = drives.filter((d) => d.team === 'opp' && d.how !== 'return');
  const userScoring = user.filter((d) => d.result === 'td' || d.result === 'fg').length;
  return {
    userPoss: user.length,
    oppPoss: opp.length,
    userTd: user.filter((d) => d.result === 'td').length,
    userFg: user.filter((d) => d.result === 'fg').length,
    userScoring,
    userTurnovers: result.summary.user.turnovers,
    userPlays: tally.userPlays,
    plays: tally.plays,
    userResults: user.map((d) => d.result),
    redZone: user.filter((d) => (tally.maxBall.get(d) ?? 0) >= 80 || d.result === 'td').map((d) => d.result),
    oppDrives: tally.oppDrives,
    oppStars: m.oppOffStars,
    userDefStars: m.userDefStars,
  };
}

// =============================================================================================
// Squads for rated matchups (franchise buildSquad, AI-style virtual squads)
// =============================================================================================

const saveCache = new Map();
function baseSave(seed) {
  if (!saveCache.has(seed)) saveCache.set(seed, F.newFranchise({ coachName: 'Balance', seed, teamId: 'DEN' }));
  return saveCache.get(seed);
}

/**
 * Match options for a user team rated userOff/userDef against an AI team rated oppOff/oppDef
 * (both synthesized by buildSquad; the opponent gets the difficulty offset like a real game).
 * With `career: true` the user side is the real starting roster of a brand-new career (stars +
 * generic fillers, its own OFF/DEF from teamRatings) instead of a synthesized team.
 */
export function ratedMatch({ i = 0, seed = 1, userOff = 3, userDef = 3, oppOff = 3, oppDef = 3, step = 6, career = false }) {
  const save = career ? F.newFranchise({ coachName: 'Balance', seed: seed * 1000 + i + 1, teamId: 'DEN' }) : baseSave(seed);
  const ai = save.teams.filter((t) => t.id !== save.userTeamId);
  const A = career ? F.userTeam(save) : ai[(i * 7) % ai.length];
  const B = ai[(i * 7 + 3 + (i % 5)) % ai.length];
  if (!career) {
    save.season.week = 1 + (i % 16);
    save.season.year = F.START_YEAR + Math.floor(i / 16);
    Object.assign(A, { off: userOff, def: userDef });
  }
  Object.assign(B, { off: oppOff, def: oppDef });
  const look = (t) => ({ id: t.id, abbr: t.abbr, city: t.city, colors: { ...t.colors } });
  const chart = career ? F.depthChart(F.roster(save)) : null;
  return {
    gameId: `bal-${seed}-${i}`,
    userTeam: look(A),
    oppTeam: look(B),
    userSquad: F.buildSquad(save, A.id, { opponent: false }),
    oppSquad: F.buildSquad(save, B.id, { difficultyStep: step }),
    userIsHome: i % 2 === 0,
    userDefenders: chart ? ['DL', 'LB', 'DB'].flatMap((pos) => chart.slots[pos].filter(Boolean)).map((p) => ({ id: p.id, name: p.last, pos: p.pos, number: p.number })) : [],
    seed: (seed * 7919 + i * 104729) >>> 0,
    difficultyStep: step,
  };
}

// =============================================================================================
// Aggregation helpers
// =============================================================================================

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const pct = (v) => (Number.isFinite(v) ? `${(100 * v).toFixed(0)}%` : '-');
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '-');
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '-');

/** Summarize a list of {result, info} match outputs. */
export function summarizeMatches(runs) {
  const r = runs.map((x) => x.result);
  const info = runs.map((x) => x.info);
  // every opponent possession counts (a drive that runs out the half is a non-scoring drive)
  const real = info.flatMap((x) => x.oppDrives);
  const cnt = (k) => real.filter((d) => d.outcome === k).length / Math.max(1, real.length);
  return {
    n: runs.length,
    user: mean(r.map((x) => x.userScore)),
    opp: mean(r.map((x) => x.oppScore)),
    combined: mean(r.map((x) => x.userScore + x.oppScore)),
    winPct: mean(r.map((x) => (x.userWon ? 1 : x.tie ? 0.5 : 0))),
    ties: r.filter((x) => x.tie).length,
    ot: mean(r.map((x) => (x.ot ? 1 : 0))),
    userPoss: mean(info.map((x) => x.userPoss)),
    oppPoss: mean(info.map((x) => x.oppPoss)),
    userScorePct: mean(info.map((x) => x.userScoring / Math.max(1, x.userPoss))),
    userTdPct: mean(info.map((x) => x.userTd / Math.max(1, x.userPoss))),
    userTo: mean(info.map((x) => x.userTurnovers)),
    userPlays: mean(info.map((x) => x.userPlays)),
    oppScore: cnt('td') + cnt('fg'),
    oppTd: cnt('td'),
    oppFg: cnt('fg'),
    oppTo: cnt('int') + cnt('fumble'),
    oppStart: mean(real.map((d) => d.start)),
    plays: sumPlays(info.map((x) => x.plays)),
    userResults: countKeys(info.flatMap((x) => x.userResults)),
    redZone: countKeys(info.flatMap((x) => x.redZone)),
    redZoneTrips: mean(info.map((x) => x.redZone.length)),
  };
}

function sumPlays(list) {
  const t = {};
  for (const p of list) for (const [k, v] of Object.entries(p)) t[k] = (t[k] || 0) + v;
  return {
    ...t,
    cmpPct: t.cmp / Math.max(1, t.att),
    sackPct: t.sacks / Math.max(1, t.dropbacks),
    intPct: t.ints / Math.max(1, t.att),
    ypc: t.runYds / Math.max(1, t.runs),
    passPlay: t.passYds / Math.max(1, t.dropbacks),
    passShare: t.dropbacks / Math.max(1, t.dropbacks + t.runs),
    fgPct: t.fgMade / Math.max(1, t.fgAtt),
    fgDistAvg: t.fgDist / Math.max(1, t.fgAtt),
    returnAvg: t.returnStart / Math.max(1, t.returns),
  };
}

function countKeys(arr) {
  const c = {};
  for (const k of arr) c[k] = (c[k] || 0) + 1;
  const n = arr.length || 1;
  return Object.fromEntries(Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v / n]));
}

/** One-line play stats + user drive endings for a summarized cell. */
export function playLine(r) {
  const p = r.plays;
  return `   plays: cmp ${pct(p.cmpPct)} sack ${pct(p.sackPct)} INT ${pct(p.intPct)} ypc ${f1(p.ypc)} pass-play ${f1(p.passPlay)} pass ${pct(p.passShare)} | FG ${pct(p.fgPct)} (${f1(p.fgDistAvg)} yd, ${f1(p.fgAtt / r.n)}/g) | KR start ${f1(p.returnAvg)}\n`
    + `   user drives: ${Object.entries(r.userResults).map(([k, v]) => `${k} ${pct(v)}`).join(' ')}\n`
    + `   red zone (${f1(r.redZoneTrips)} trips/g): ${Object.entries(r.redZone).map(([k, v]) => `${k} ${pct(v)}`).join(' ')}`;
}

// =============================================================================================
// Suites (each returns {rows, text}); heavy loops go through `runTasks` for parallelism
// =============================================================================================

/** simDrive outcome table straight from the model (fast). */
export function driveTable({ n = 4000, seed = 1, cells } = {}) {
  const rng = new Rng(seed);
  const list = cells || [
    { d: -2, step: 6, start: 25 }, { d: -1, step: 6, start: 25 }, { d: 0, step: 6, start: 25 }, { d: 1, step: 6, start: 25 }, { d: 2, step: 6, start: 25 },
    { d: 0, step: 2, start: 25 }, { d: 0, step: 10, start: 25 }, { d: 0, step: 16, start: 25 },
    { d: 0, step: 6, start: 40 }, { d: 0, step: 6, start: 60 },
  ];
  const rows = [];
  for (const c of list) {
    const k = {};
    let pts = 0;
    for (let i = 0; i < n; i++) {
      const res = simDrive({ offStars: 3 + c.d / 2, defStars: 3 - c.d / 2, startYard: c.start, clockLeft: 400, difficultyStep: c.step, half: 1, rng: rng.fork(i), neutral: c.neutral });
      k[res.outcome] = (k[res.outcome] || 0) + 1;
      pts += res.points;
    }
    const p = (o) => (k[o] || 0) / n;
    rows.push({ ...c, score: p('td') + p('fg'), td: p('td'), fg: p('fg'), to: p('int') + p('fumble'), ptsPerDrive: pts / n });
  }
  const text = ['SIM DRIVES (simDrive, 400 s on the clock, half 1)', 'OFF-DEF  step start | score   TD   FG   TO | pts/drive']
    .concat(rows.map((r) => `${String(r.d).padStart(5)}  ${String(r.step).padStart(5)} ${String(r.start).padStart(5)} | ${pct(r.score).padStart(5)} ${pct(r.td).padStart(4)} ${pct(r.fg).padStart(4)} ${pct(r.to).padStart(4)} | ${f2(r.ptsPerDrive)}`))
    .join('\n');
  return { rows, text };
}

/** AI-vs-AI league games via the franchise sim (what the league actually uses). */
export function aiTable({ seasons = 6, seed = 11 } = {}) {
  const scores = [];
  const margins = [];
  const winPcts = [];
  let ot = 0;
  let ties = 0;
  let games = 0;
  let homeWins = 0;
  const key = new Map();
  for (let s = 0; s < seasons; s++) {
    const save = F.newFranchise({ coachName: 'AI', seed: seed + s, teamId: 'DEN' });
    while (save.season.phase === 'regular') {
      const mr = F.simulateUserGame(save);
      if (mr) F.applyUserGameResult(save, mr);
      F.advanceWeek(save);
    }
    for (const g of save.season.schedule) {
      if (!g.played || g.playoff) continue;
      if (g.home === save.userTeamId || g.away === save.userTeamId) continue;
      games += 1;
      scores.push(g.homeScore + g.awayScore);
      margins.push(Math.abs(g.homeScore - g.awayScore));
      if (g.ot) ot += 1;
      if (g.homeScore === g.awayScore) ties += 1;
      if (g.homeScore > g.awayScore) homeWins += 1;
      for (const sc of [g.homeScore, g.awayScore]) key.set(sc, (key.get(sc) || 0) + 1);
    }
    for (const t of save.teams) if (t.id !== save.userTeamId) winPcts.push((t.record.w + t.record.t / 2) / Math.max(1, t.record.w + t.record.l + t.record.t));
  }
  scores.sort((a, b) => a - b);
  const sd = (a) => Math.sqrt(mean(a.map((v) => (v - mean(a)) ** 2)));
  const commonScores = [...key.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}:${pct(v / (2 * games))}`).join(' ');
  const winsSd = sd(winPcts.map((p) => p * 16));
  const row = {
    games,
    combined: mean(scores),
    p10: scores[Math.floor(scores.length * 0.1)],
    p90: scores[Math.floor(scores.length * 0.9)],
    margin: mean(margins),
    oneScore: margins.filter((m) => m <= 8).length / games,
    ot: ot / games,
    ties: ties / games,
    homeWin: homeWins / games,
    winsSd,
    commonScores,
  };
  const text = [
    'AI-vs-AI (franchise gameSim, regular season)',
    `games ${games}: combined ${f1(row.combined)} (p10 ${row.p10}, p90 ${row.p90}), avg margin ${f1(row.margin)}, one-score ${pct(row.oneScore)}, OT ${pct(row.ot)}, ties ${pct(row.ties)}, home win ${pct(row.homeWin)}`,
    `standings spread: SD of wins ${f2(winsSd)} (real NFL ~3.1)`,
    `most common team scores: ${commonScores}`,
  ].join('\n');
  return { row, text };
}

/** Team rating of a fresh career and its response to adding stars. */
export function ratingTable({ seeds = 30 } = {}) {
  const base = [];
  const add = { DL3: [], LB3: [], DB3: [], DB4: [], QB4: [], WR4: [], twoDef35: [] };
  const built = {};
  let aiOff = 0;
  let aiDef = 0;
  let aiN = 0;
  for (let s = 1; s <= seeds; s++) {
    const save = F.newFranchise({ coachName: 'R', seed: 1000 + s, teamId: 'DEN' });
    for (const t of save.teams) if (t.id !== save.userTeamId) { aiOff += t.off; aiDef += t.def; aiN += 1; }
    const r0 = F.teamRatings(save);
    base.push(r0);
    const rng = new Rng(77 + s);
    const tryAdd = (key, list) => {
      const team = F.userTeam(save);
      const before = team.roster.slice();
      for (const [pos, st] of list) {
        const p = createStar(save, rng, pos, st);
        team.roster.push(p);
      }
      const r = F.teamRatings(save);
      add[key].push({ off: r.off - r0.off, def: r.def - r0.def });
      team.roster = before;
    };
    tryAdd('DL3', [['DL', 3]]);
    tryAdd('LB3', [['LB', 3]]);
    tryAdd('DB3', [['DB', 3]]);
    tryAdd('DB4', [['DB', 4]]);
    tryAdd('QB4', [['QB', 4]]);
    tryAdd('WR4', [['WR', 4]]);
    tryAdd('twoDef35', [['LB', 3.5], ['DB', 3.5]]);
    // built rosters (12-star cap): replace the whole roster
    const team = F.userTeam(save);
    const keep = team.roster;
    const build = (key, list) => {
      team.roster = list.map(([pos, st]) => createStar(save, rng, pos, st));
      const r = F.teamRatings(save);
      (built[key] ||= []).push({ off: r.off, def: r.def });
    };
    const six = (st) => [['QB', st], ['RB', st], ['WR', st], ['WR', st], ['TE', st], ['OL', st], ['DL', st], ['DL', st], ['LB', st], ['LB', st], ['DB', st], ['DB', st]];
    build('12 stars @3', six(3));
    build('12 stars @4', six(4));
    build('12 stars @4.5', six(4.5));
    team.roster = keep;
  }
  const row = {
    off: mean(base.map((r) => r.off)),
    def: mean(base.map((r) => r.def)),
    aiOff: aiOff / aiN,
    aiDef: aiDef / aiN,
    deltas: Object.fromEntries(Object.entries(add).map(([k, v]) => [k, { off: mean(v.map((x) => x.off)), def: mean(v.map((x) => x.def)) }])),
    built: Object.fromEntries(Object.entries(built).map(([k, v]) => [k, { off: mean(v.map((x) => x.off)), def: mean(v.map((x) => x.def)) }])),
  };
  const text = [
    'TEAM RATINGS (new careers)',
    `new user team OFF ${f2(row.off)}★ DEF ${f2(row.def)}★  vs AI average OFF ${f2(row.aiOff)}★ DEF ${f2(row.aiDef)}★`,
    'adding a star: ' + Object.entries(row.deltas).map(([k, d]) => `${k} ${d.off >= 0.05 ? `OFF +${f2(d.off)} ` : ''}DEF +${f2(d.def)}`).join(' | '),
    'built rosters (6 OFF + 6 DEF stars, 1★ coordinators): ' + Object.entries(row.built).map(([k, d]) => `${k} → ${f2(d.off)}/${f2(d.def)}`).join(' | '),
  ].join('\n');
  return { row, text };
}

function createStar(save, rng, pos, starsValue) {
  return createPlayer(save, rng, { pos, stars: starsValue, age: 26, contractYears: 2 });
}

// ---------------------------------------------------------------------------- match suites

/** Task: one rated match. */
export function ratedMatchTask(a) {
  const o = ratedMatch(a);
  const run = playMatch({ ...o, skill: a.skill, quarterMinutes: a.qm ?? 2, easyOtFirst: a.step <= 2 });
  return { result: slimResult(run.result), info: run.info };
}

function slimResult(r) {
  return { userScore: r.userScore, oppScore: r.oppScore, userWon: r.userWon, tie: r.tie, ot: r.ot, summary: { user: { turnovers: r.summary.user.turnovers } } };
}

export async function matchSuite({ n = 60, seed = 1, cells, pool, detail = true } = {}) {
  const list = cells || [
    { label: 'Easy   casual 3v3', step: 2, skill: SKILL.casual },
    { label: 'Easy   avg    3v3', step: 2, skill: SKILL.average },
    { label: 'Medium casual 3v3', step: 6, skill: SKILL.casual },
    { label: 'Medium avg    3v3', step: 6, skill: SKILL.average },
    { label: 'Medium good   3v3', step: 6, skill: SKILL.good },
    { label: 'Hard   avg    3v3', step: 10, skill: SKILL.average },
    { label: 'Hard   good   3v3', step: 10, skill: SKILL.good },
    { label: 'Extreme avg   3v3', step: 16, skill: SKILL.average },
    { label: 'Extreme good  3v3', step: 16, skill: SKILL.good },
    { label: 'NEW team Easy cas', step: 2, skill: SKILL.casual, career: true },
    { label: 'NEW team Dyn4 avg', step: 4, skill: SKILL.average, career: true },
    { label: 'NEW team Med avg', step: 6, skill: SKILL.average, career: true },
  ];
  const tasks = [];
  list.forEach((c, ci) => {
    for (let i = 0; i < n; i++) tasks.push({ fn: 'ratedMatchTask', args: { i: ci * 1000 + i, seed: seed + ci, step: c.step, skill: c.skill, qm: c.qm ?? 2, userOff: c.userOff ?? 3, userDef: c.userDef ?? 3, oppOff: c.oppOff ?? 3, oppDef: c.oppDef ?? 3, career: !!c.career } });
  });
  const out = await runTasks(tasks, pool);
  const rows = list.map((c, ci) => ({ ...c, ...summarizeMatches(out.slice(ci * n, ci * n + n)) }));
  const text = ['FULL MATCHES (real engine, 2-min quarters unless noted)', 'cell               |  user   opp  comb | win%  OT | poss u/o  | user sc% TD%  TO | opp sc% TD%  FG%  TO% start']
    .concat(rows.map((r) => `${r.label.padEnd(18)} | ${f1(r.user).padStart(5)} ${f1(r.opp).padStart(5)} ${f1(r.combined).padStart(5)} | ${pct(r.winPct).padStart(4)} ${pct(r.ot).padStart(3)} | ${f1(r.userPoss)}/${f1(r.oppPoss)}  | ${pct(r.userScorePct).padStart(6)} ${pct(r.userTdPct).padStart(4)} ${f1(r.userTo).padStart(3)} | ${pct(r.oppScore).padStart(6)} ${pct(r.oppTd).padStart(4)} ${pct(r.oppFg).padStart(4)} ${pct(r.oppTo).padStart(4)} ${f1(r.oppStart).padStart(5)}${detail ? `\n${playLine(r)}` : ''}`))
    .join('\n');
  return { rows, text };
}

export async function quarterSuite({ n = 30, seed = 5, pool } = {}) {
  const cells = [1, 2, 3].map((qm) => ({ label: `${qm}-min Medium avg`, step: 6, skill: SKILL.average, qm }));
  const res = await matchSuite({ n, seed, cells, pool });
  const text = ['QUARTER LENGTH (Medium, 3v3, average bot)']
    .concat(res.rows.map((r) => `${r.qm}-min: user possessions ${f1(r.userPoss)}, opp ${f1(r.oppPoss)}, user plays ${f1(r.userPlays)}, combined ${f1(r.combined)}, win ${pct(r.winPct)}`))
    .join('\n');
  return { rows: res.rows, text };
}

// =============================================================================================
// Careers: franchise seasons with the real engine and sensible management
// =============================================================================================

/** Rating gain (OFF+DEF stars) of adding `p` to the roster (and optionally removing `drop`). */
function ratingGain(save, p, drop = null) {
  const team = F.userTeam(save);
  const before = F.teamRatings(save);
  const saved = team.roster;
  team.roster = saved.filter((x) => x !== drop).concat([p]);
  const after = F.teamRatings(save);
  team.roster = saved;
  return after.off - before.off + (after.def - before.def);
}

/** Least valuable roster player (rating loss if removed), skipping `keep`. */
function weakestPlayer(save, keep = new Set()) {
  const team = F.userTeam(save);
  const base = F.teamRatings(save);
  let worst = null;
  let worstLoss = Infinity;
  for (const p of team.roster) {
    if (keep.has(p.id)) continue;
    const saved = team.roster;
    team.roster = saved.filter((x) => x !== p);
    const r = F.teamRatings(save);
    team.roster = saved;
    const loss = base.off - r.off + (base.def - r.def) + (p.age <= 24 ? 0.05 : 0);
    if (loss < worstLoss) {
      worstLoss = loss;
      worst = p;
    }
  }
  return worst ? { player: worst, loss: worstLoss } : null;
}

function newsChoice(save, n) {
  let best = -1;
  let bestV = -Infinity;
  n.choices.forEach((c, i) => {
    if (!F.choiceAvailable(save, c)) return;
    const e = c.effects || {};
    const v = (e.cc || 0) * 3 + (e.jobSecurity || 0) * 1.2 + (e.teamMorale || 0) * 0.6 + (e.fans || 0) * 0.3
      + (e.players || []).reduce((s, x) => s + x.delta * 0.15, 0) - (e.injury ? e.injury.weeks * 2 : 0) + (e.xp ? e.xp.amount / 25 : 0);
    if (v > bestV) {
      bestV = v;
      best = i;
    }
  });
  return best;
}

function spendSkillPoints(save) {
  for (const p of F.roster(save)) {
    let guard = 0;
    while (p.skillPoints > 0 && guard++ < 30) {
      const w = F.STAR_WEIGHTS[p.pos];
      const attrs = F.ATTRS[p.pos].filter((a) => p.attrs[a] < 10).sort((a, b) => w[b] - w[a] || p.attrs[a] - p.attrs[b]);
      if (!attrs.length || !F.applySkillPoint(save, p.id, attrs[0]).ok) break;
    }
  }
}

function logPurchase(ctx, kind, cc, detail) {
  ctx.purchases.push({ season: ctx.seasonIdx, game: ctx.gameIdx, kind, cc, detail });
}

/** Sign the best-value free agents (rating gain per CC); releases a weak player when full. */
function shopFreeAgents(save, ctx, { minGain, reserve, allowRelease, maxSigns = 2 }) {
  let signed = 0;
  for (let k = 0; k < maxSigns; k++) {
    const fas = F.freeAgents(save);
    let best = null;
    for (const fa of fas) {
      if (fa.fee > save.cc - reserve) continue;
      const full = F.roster(save).length >= F.ROSTER.cap;
      const drop = full && allowRelease ? weakestPlayer(save)?.player : null;
      if (full && !drop) continue;
      const room = F.capRoom(save) + (drop ? drop.contract.salary * 0.5 : 0);
      const gain = ratingGain(save, fa.player, drop);
      const value = gain - (fa.age >= 31 ? 0.1 : 0);
      if (fa.salary > room) {
        if (value >= minGain) ctx.capBlockedFa.add(fa.id);
        continue;
      }
      if (value >= minGain && (!best || value / Math.max(1, fa.fee) > best.value / Math.max(1, best.fa.fee))) best = { fa, drop, value, gain };
    }
    if (!best) break;
    if (best.drop) {
      const rel = F.releasePlayer(save, best.drop.id);
      if (!rel.ok) break;
      ctx.releases += 1;
    }
    const r = F.signFreeAgent(save, best.fa.id);
    if (!r.ok) break;
    signed += 1;
    logPurchase(ctx, 'fa', r.fee, `${best.fa.pos} ${best.fa.stars}★ +${best.gain.toFixed(2)}`);
  }
  return signed;
}

/** In-season management between games. */
function manageWeek(save, ctx) {
  for (const n of F.pendingNews(save)) {
    const i = newsChoice(save, n);
    if (i >= 0) F.resolveNews(save, n.id, i);
  }
  spendSkillPoints(save);
  // free agents first (they move the team rating), then facilities with spare CC
  shopFreeAgents(save, ctx, { minGain: 0.25, reserve: 2, allowRelease: false, maxSigns: 1 });
  const order = ['training', 'rehab', 'stadium'];
  for (const kind of order) {
    const cost = F.facilityUpgradeCost(save, kind);
    if (cost != null && save.facilities[kind] < 3 && save.cc - cost >= 6) {
      if (F.upgradeFacility(save, kind).ok) logPurchase(ctx, `facility:${kind}`, cost, `L${save.facilities[kind]}`);
      break;
    }
  }
  const chart = F.depthChart(F.roster(save));
  for (const p of F.roster(save)) {
    if (p.injury && !p.injury.seasonEnding && p.injury.weeks >= 2 && chart.starterIds.length && save.cc >= 8 && F.stars(p) >= 2.5) {
      if (F.rushTreatment(save, p.id).ok) logPurchase(ctx, 'rush', 1, p.pos);
    }
    if (!p.injury && p.morale < 30 && save.cc >= 6 && F.boostMorale(save, p.id).ok) logPurchase(ctx, 'morale', 1, p.pos);
  }
}

function runOffseason(save, ctx) {
  let guard = 0;
  while (save.offseason && guard++ < 60) {
    if (save.fired) {
      const offers = F.jobOffers(save).sort((a, b) => b.off + b.def - (a.off + a.def));
      F.takeJob(save, offers[0].teamId);
      ctx.firings += 1;
      continue;
    }
    const step = F.currentOffseasonStep(save);
    const data = F.offseasonData(save);
    let choice = null;
    if (step === 'contracts') {
      const list = (data || []).filter((c) => c.demand.willing && c.stars >= 2 && c.age <= 31).sort((a, b) => b.stars - a.stars);
      const resign = {};
      let used = F.capUsage(save).used - (data || []).reduce((s, c) => s + c.current, 0);
      for (const c of list) {
        if (used + c.demand.salary > save.salaryCap - 1500) {
          ctx.capCuts += 1;
          continue;
        }
        used += c.demand.salary;
        resign[c.playerId] = c.demand.years;
      }
      ctx.expiring += (data || []).length;
      choice = { resign };
    } else if (step === 'facilities') {
      choice = { maintain: (data || []).filter((f) => f.kind === 'training' && save.cc >= 8).map((f) => f.kind) };
    } else if (step === 'staff') {
      const hire = {};
      let budget = save.cc - 3;
      for (const role of ['dc', 'oc']) {
        const cur = save.staff[role];
        const curStars = cur && cur.years > 1 ? cur.stars : 0;
        const cands = F.coordinatorCandidates(save, role).filter((c) => c.cost <= budget && c.stars > curStars);
        const best = cands.sort((a, b) => b.stars - a.stars)[0];
        if (best) {
          hire[role] = best.id;
          budget -= best.cost;
          logPurchase(ctx, `coord:${role}`, best.cost, `${best.stars}★`);
        }
      }
      choice = { hire };
    } else if (step === 'draft') {
      let g = 0;
      while (F.userOnClock(save) && g++ < 10) {
        const prospects = F.draftProspects(save);
        let pick = null;
        let bestGain = 0.04;
        for (const pr of prospects.slice(0, 15)) {
          const p = save.draft.prospects.find((x) => x.id === pr.id);
          const gain = ratingGain(save, p) + 0.08 * (pr.estimate.hi - pr.estimate.lo);
          if (gain > bestGain) {
            bestGain = gain;
            pick = pr;
          }
        }
        const full = F.roster(save).length >= F.ROSTER.cap;
        if (pick && !full && F.draftPlayer(save, pick.id).ok) ctx.drafted += 1;
        else F.passPick(save);
      }
    } else if (step === 'freeAgency') {
      shopFreeAgents(save, ctx, { minGain: 0.2, reserve: 1, allowRelease: true, maxSigns: 3 });
    }
    const res = F.runOffseasonStep(save, step, choice);
    if (!res.ok) throw new Error(`offseason ${step}: ${res.message}`);
  }
}

/** Build the Match options for the user's game this week exactly like MatchScreen does. */
export function franchiseMatchOptions(save, { quarterMinutes = 2 } = {}) {
  const setup = F.matchSetup(save);
  if (!setup) return null;
  const mode = F.difficultyInfo(save).mode;
  return { ...setup, quarterMinutes, wind: 'normal', easyOtFirst: mode === 'easy' };
}

/**
 * A whole career: `seasons` seasons with the real engine for every user game.
 * @returns {{seasons:Object[], purchases:Object[], firings:number}}
 */
export function runCareer({ seed = 1, teamId = null, skill = SKILL.average, difficulty = 'dynamic', seasons = 4, qm = 2 } = {}) {
  const teams = F.previewLeague(seed);
  const tid = teamId || teams[seed % teams.length].id;
  const save = F.newFranchise({ coachName: 'Balance', teamId: tid, seed, difficulty });
  const ctx = { purchases: [], seasonIdx: 0, gameIdx: 0, firings: 0, releases: 0, drafted: 0, capCuts: 0, expiring: 0, capBlockedFa: new Set() };
  const out = [];
  for (let s = 0; s < seasons; s++) {
    ctx.seasonIdx = s + 1;
    ctx.gameIdx = 0;
    const r0 = F.teamRatings(save);
    const cc0 = save.cc;
    const steps = [];
    let ccEarned = 0;
    let pf = 0;
    let pa = 0;
    let minJs = save.jobSecurity;
    const firings0 = ctx.firings;
    const capCuts0 = ctx.capCuts;
    ctx.capBlockedFa = new Set();
    let guard = 0;
    while (save.season.phase !== 'offseason' && guard++ < 40) {
      manageWeek(save, ctx);
      const o = franchiseMatchOptions(save, { quarterMinutes: qm });
      if (o) {
        ctx.gameIdx += 1;
        steps.push(o.difficultyStep);
        const { result } = playMatch({ ...o, skill });
        const sum = F.applyUserGameResult(save, result);
        ccEarned += sum.ccEarned;
        if (!sum.playoff) {
          pf += sum.userScore;
          pa += sum.oppScore;
        }
        minJs = Math.min(minJs, save.jobSecurity);
      }
      let r = F.advanceWeek(save);
      let g2 = 0;
      while (r.ok && save.season.phase === 'playoffs' && F.userWeekStatus(save) === 'eliminated' && g2++ < 6) r = F.advanceWeek(save);
    }
    const h = save.history[save.history.length - 1];
    const cap = F.capUsage(save);
    const row = {
      season: s + 1,
      team: h.abbr,
      w: h.w,
      l: h.l,
      t: h.t,
      pf: pf / Math.max(1, h.w + h.l + h.t),
      pa: pa / Math.max(1, h.w + h.l + h.t),
      seed: h.seed,
      result: h.result,
      playoffs: !!h.seed,
      stepAvg: mean(steps),
      stepEnd: F.difficultyStep(save),
      off0: r0.off,
      def0: r0.def,
      off1: F.teamRatings(save).off,
      def1: F.teamRatings(save).def,
      ccStart: cc0,
      ccEarned,
      js: save.jobSecurity,
      minJs,
      roster: F.roster(save).length,
      payroll: cap.used,
      cap: cap.cap,
    };
    runOffseason(save, ctx);
    row.fired = ctx.firings > firings0;
    row.capCuts = ctx.capCuts - capCuts0;
    row.capBlockedFa = ctx.capBlockedFa.size;
    row.starAvg = mean(F.roster(save).map((p) => F.stars(p)));
    row.payrollAfter = F.capUsage(save).used;
    row.capAfter = F.capUsage(save).cap;
    out.push(row);
  }
  return { seasons: out, purchases: ctx.purchases, firings: ctx.firings, drafted: ctx.drafted, releases: ctx.releases };
}

export async function careerSuite({ careers = 6, seasons = 4, seed = 300, skills = SKILL, pool } = {}) {
  const tasks = [];
  const names = Object.keys(skills);
  for (const name of names) {
    for (let c = 0; c < careers; c++) tasks.push({ fn: 'runCareer', args: { seed: seed + c * 13 + 1, skill: skills[name], seasons } });
  }
  const out = await runTasks(tasks, pool);
  const lines = [`CAREERS (new career on Dynamic, ${careers} careers x ${seasons} seasons per skill)`];
  const bySkill = {};
  names.forEach((name, ni) => {
    const runs = out.slice(ni * careers, ni * careers + careers);
    bySkill[name] = runs;
    lines.push(`-- ${name} bot (skill ${skills[name]})`);
    lines.push('season | W-L (range)      | playoffs | PF/PA per game | diff step avg/end | OFF/DEF start→end      | min owner | fired');
    for (let s = 0; s < seasons; s++) {
      const rows = runs.map((r) => r.seasons[s]).filter(Boolean);
      const w = rows.map((r) => r.w);
      lines.push(`  ${s + 1}    | ${f1(mean(w))}-${f1(mean(rows.map((r) => r.l)))} (${Math.min(...w)}-${Math.max(...w)})`.padEnd(30)
        + `| ${pct(mean(rows.map((r) => (r.playoffs ? 1 : 0)))).padStart(6)}   | ${f1(mean(rows.map((r) => r.pf)))}/${f1(mean(rows.map((r) => r.pa)))}`.padEnd(29)
        + `| ${f1(mean(rows.map((r) => r.stepAvg)))}/${f1(mean(rows.map((r) => r.stepEnd)))}`.padEnd(20)
        + `| ${f1(mean(rows.map((r) => r.off0)))}/${f1(mean(rows.map((r) => r.def0)))} → ${f1(mean(rows.map((r) => r.off1)))}/${f1(mean(rows.map((r) => r.def1)))}`.padEnd(24)
        + `| ${f1(mean(rows.map((r) => r.minJs))).padStart(5)}     | ${rows.filter((r) => r.fired).length}`);
    }
    const firstPlayoff = runs.map((r) => r.seasons.findIndex((x) => x.playoffs) + 1).map((v) => (v === 0 ? '-' : v));
    lines.push(`  first playoff season per career: ${firstPlayoff.join(' ')}`);
    // economy
    const s1 = runs.map((r) => r.purchases.filter((p) => p.season === 1 && p.kind !== 'morale' && p.kind !== 'rush'));
    const s1Games = runs.map((r) => r.seasons[0].w + r.seasons[0].l + r.seasons[0].t);
    const cadence = mean(s1.map((p, i) => s1Games[i] / Math.max(1, p.length)));
    const kinds = {};
    for (const p of s1.flat()) kinds[p.kind.split(':')[0]] = (kinds[p.kind.split(':')[0]] || 0) + 1;
    lines.push(`  season-1 CC: earned ${f1(mean(runs.map((r) => r.seasons[0].ccEarned)))}, purchases ${f1(mean(s1.map((p) => p.length)))} (one every ${f1(cadence)} games; ${Object.entries(kinds).map(([k, v]) => `${k} ${f1(v / careers)}`).join(', ')})`);
    for (let s = 0; s < seasons; s++) {
      const rows = runs.map((r) => r.seasons[s]).filter(Boolean);
      lines.push(`  season ${s + 1} cap: payroll ${f1(mean(rows.map((r) => r.payroll / 1000)))}/${f1(mean(rows.map((r) => r.cap / 1000)))}M, after offseason ${f1(mean(rows.map((r) => r.payrollAfter / 1000)))}M, roster ${f1(mean(rows.map((r) => r.roster)))} (avg ${f1(mean(rows.map((r) => r.starAvg)))}★), cap blocked: re-signs ${f1(mean(rows.map((r) => r.capCuts)))}, wanted FAs ${f1(mean(rows.map((r) => r.capBlockedFa)))}`);
    }
  });
  return { bySkill, text: lines.join('\n') };
}

// =============================================================================================
// Parallel task runner (worker_threads); falls back to inline when pool is 0
// =============================================================================================

const TASKS = { ratedMatchTask, runCareer };

// ---- what-if overrides: --set match.sim.scoreBase=-0.2 --set franchise.DIFFICULTY.offsetPerStep=0.1
const TUNE_ROOTS = { match: CFG, play: TUNING, franchise: FCONFIG };
const tuneOriginals = new Map();

function tuneRef(path) {
  const parts = path.split('.');
  let obj = TUNE_ROOTS[parts.shift()];
  while (obj && parts.length > 1) obj = obj[parts.shift()];
  if (!obj || !(parts[0] in obj)) throw new Error(`unknown tunable ${path}`);
  return { obj, key: parts[0] };
}

/** Apply {path: value} overrides (restoring any earlier ones first). Values are JSON. */
export function applyTune(tune = {}) {
  for (const [path, v] of tuneOriginals) {
    const { obj, key } = tuneRef(path);
    obj[key] = v;
  }
  tuneOriginals.clear();
  for (const [path, v] of Object.entries(tune)) {
    const { obj, key } = tuneRef(path);
    tuneOriginals.set(path, obj[key]);
    obj[key] = v;
  }
}

let currentTune = {};
/** Set the overrides used by this process and every task sent to workers. */
export function setTune(tune) {
  currentTune = { ...tune };
  applyTune(currentTune);
}

export function createPool(size = Math.max(1, os.cpus().length)) {
  if (size <= 1) return null;
  const workers = Array.from({ length: size }, () => new Worker(fileURLToPath(import.meta.url), { workerData: { worker: true } }));
  return { workers, close: () => Promise.all(workers.map((w) => w.terminate())) };
}

export async function runTasks(tasks, pool) {
  if (!pool) return tasks.map((t) => TASKS[t.fn](t.args));
  tasks = tasks.map((t) => ({ ...t, tune: currentTune }));
  const results = new Array(tasks.length);
  let next = 0;
  await Promise.all(pool.workers.map((w) => new Promise((resolve, reject) => {
    const feed = () => {
      if (next >= tasks.length) {
        w.off('message', onMsg);
        w.off('error', reject);
        resolve();
        return;
      }
      const idx = next++;
      w.postMessage({ idx, task: tasks[idx] });
    };
    const onMsg = (msg) => {
      if (msg.error) {
        reject(new Error(msg.error));
        return;
      }
      results[msg.idx] = msg.result;
      feed();
    };
    w.on('message', onMsg);
    w.on('error', reject);
    feed();
  })));
  return results;
}

if (!isMainThread && workerData && workerData.worker) {
  let lastTune = '{}';
  parentPort.on('message', ({ idx, task }) => {
    try {
      const key = JSON.stringify(task.tune || {});
      if (key !== lastTune) {
        applyTune(task.tune || {});
        lastTune = key;
      }
      parentPort.postMessage({ idx, result: TASKS[task.fn](task.args) });
    } catch (e) {
      parentPort.postMessage({ idx, error: `${e.stack || e}` });
    }
  });
}

// =============================================================================================
// CLI
// =============================================================================================

async function main(argv) {
  const opts = {};
  const suites = [];
  const tune = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--set') {
      const [k, v] = argv[++i].split('=');
      tune[k] = JSON.parse(v);
      continue;
    }
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) opts[m[1]] = m[2] ?? true;
    else suites.push(a);
  }
  setTune(tune);
  if (Object.keys(tune).length) console.log(`overrides: ${JSON.stringify(tune)}`);
  const quick = !!opts.quick;
  const want = suites.length ? suites : ['drives', 'ai', 'ratings', 'match', 'quarters', 'career'];
  const n = Number(opts.n ?? (quick ? 12 : 60));
  const pool = createPool(Number(opts.workers ?? os.cpus().length));
  const t0 = Date.now();
  try {
    for (const s of want) {
      const t = Date.now();
      let res;
      if (s === 'drives') res = driveTable({ n: quick ? 1500 : 6000 });
      else if (s === 'ai') res = aiTable({ seasons: quick ? 2 : 6 });
      else if (s === 'ratings') res = ratingTable({ seeds: quick ? 10 : 40 });
      else if (s === 'match') res = await matchSuite({ n, seed: Number(opts.seed ?? 1), pool });
      else if (s === 'quarters') res = await quarterSuite({ n: Math.max(8, Math.round(n / 2)), pool });
      else if (s === 'career') {
        const skills = opts.skill ? { custom: Number(opts.skill) } : SKILL;
        res = await careerSuite({ careers: Number(opts.careers ?? (quick ? 2 : 6)), seasons: Number(opts.seasons ?? (quick ? 2 : 4)), skills, pool, seed: Number(opts.seed ?? 300) });
      } else {
        console.log(`unknown suite ${s}`);
        continue;
      }
      console.log(`\n${res.text}\n  (${((Date.now() - t) / 1000).toFixed(1)} s)`);
    }
  } finally {
    if (pool) await pool.close();
  }
  console.log(`\ntotal ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

if (isMainThread && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

