// Headless calibration helpers: run batches of bot-driven plays and aggregate the numbers the
// tuning targets talk about (completion %, INT / sack rates, yards per run / pass play, pocket
// time, FG % by distance, kick-return starting spot). Used by the unit tests and for QA tuning:
//   node -e "import('./src/play/sim/calibrate.js').then(m => console.log(m.calibrationReport()))"

import { FIELD } from './tuning.js';
import { makeTestSquad } from './squads.js';
import { runBotPlay } from './bot.js';

/** Base PlaySetup with synthetic squads. */
export function makeSetup(over = {}) {
  const offRating = over.offRating ?? 0.5;
  const defRating = over.defRating ?? 0.5;
  const s = {
    kind: 'scrimmage',
    losX: 35,
    firstDownX: 45,
    hashY: FIELD.W / 2,
    down: 1,
    offense: over.offense || makeTestSquad({ rating: offRating, seed: over.offSeed ?? 101, prefix: 'o' }),
    defense: over.defense || makeTestSquad({ rating: defRating, seed: over.defSeed ?? 202, prefix: 'd' }),
    difficulty: 1,
    difficultyStep: 6,
    wind: { x: 0, y: 0 },
    seed: 1,
    weather: 'clear',
    quarter: 1,
    gameProgress: 0.3,
    ...over,
  };
  delete s.offRating;
  delete s.defRating;
  delete s.offSeed;
  delete s.defSeed;
  return s;
}

/**
 * Bot-driven scrimmage batch.
 * @param {{n?:number, seed?:number, mode?:string, skill?:number, losX?:number, step?:number,
 *   offRating?:number, defRating?:number, weather?:string, spread?:boolean}} o
 */
export function scrimmageBatch(o = {}) {
  const n = o.n ?? 400;
  const m = {
    plays: 0, dropbacks: 0, att: 0, cmp: 0, int: 0, sacks: 0, passPlayYds: 0, runs: 0, runYds: 0, scrambles: 0,
    td: 0, fumblesLost: 0, incomplete: 0, safeties: 0, elapsed: 0, throwT: 0, pocketT: 0, pocketN: 0, firstDowns: 0,
    yards: 0, maxT: 0,
  };
  for (let i = 0; i < n; i++) {
    const seed = ((o.seed ?? 1) * 7919 + i * 104729) >>> 0;
    const losX = o.spread ? 15 + ((i * 37) % 80) : o.losX ?? 35;
    const setup = makeSetup({
      offRating: o.offRating, defRating: o.defRating, seed, losX, firstDownX: Math.min(losX + 10, 110),
      difficultyStep: o.step ?? 6, weather: o.weather ?? 'clear', hashY: o.spread ? [23.58, 26.67, 29.75][i % 3] : FIELD.W / 2,
      down: o.spread ? 1 + (i % 4) : 1, offSeed: o.offSeed, defSeed: o.defSeed,
    });
    const { result: r, bot, sim } = runBotPlay(setup, { mode: o.mode ?? 'auto', skill: o.skill ?? 0.6 });
    m.plays += 1;
    m.elapsed += r.elapsed;
    m.maxT = Math.max(m.maxT, r.elapsed);
    m.yards += r.yards;
    if (r.firstDown) m.firstDowns += 1;
    if (r.outcome === 'td') m.td += 1;
    if (r.outcome === 'safety') m.safeties += 1;
    if (r.outcome === 'fumble') m.fumblesLost += 1;
    if (bot.log.action === 'pass' || bot.log.action === 'hold') {
      m.dropbacks += 1;
      if (sim._sacked) {
        m.sacks += 1;
        m.pocketT += r.elapsed;
        m.pocketN += 1;
      }
      if (sim._thrown) {
        m.att += 1;
        m.throwT += bot.log.throwT || 0;
      }
      if (sim._completed) m.cmp += 1;
      if (r.outcome === 'interception') m.int += 1;
      if (r.outcome === 'incomplete') m.incomplete += 1;
      if (sim._scramble) m.scrambles += 1;
      m.passPlayYds += r.outcome === 'interception' ? 0 : r.yards;
    } else {
      m.runs += 1;
      m.runYds += r.yards;
    }
  }
  return {
    ...m,
    cmpPct: m.att ? m.cmp / m.att : 0,
    intPct: m.att ? m.int / m.att : 0,
    sackPct: m.dropbacks ? m.sacks / m.dropbacks : 0,
    ypc: m.runs ? m.runYds / m.runs : 0,
    passPlayAvg: m.dropbacks ? m.passPlayYds / m.dropbacks : 0,
    avgThrowT: m.att ? m.throwT / m.att : 0,
    avgPocketT: m.pocketN ? m.pocketT / m.pocketN : 0,
    avgYards: m.yards / Math.max(1, m.plays),
    avgElapsed: m.elapsed / Math.max(1, m.plays),
  };
}

/** Field-goal make % by distance bucket for a kicker of the given rating. */
export function kickBatch(o = {}) {
  const buckets = o.buckets || [[18, 34], [35, 44], [45, 52], [53, 59], [60, 66]];
  const per = o.n ?? 120;
  const out = [];
  for (const [lo, hi] of buckets) {
    let made = 0;
    let blocked = 0;
    for (let i = 0; i < per; i++) {
      const dist = lo + (i % (hi - lo + 1));
      const losX = 127 - dist;
      const seed = ((o.seed ?? 3) * 31337 + i * 7907 + lo) >>> 0;
      const windMph = o.wind ?? 6;
      const ang = (i * 2.399) % (2 * Math.PI);
      const setup = makeSetup({
        kind: 'fg', losX, seed, wind: { x: Math.cos(ang) * windMph, y: Math.sin(ang) * windMph },
        offRating: o.rating ?? 0.5, gameProgress: o.gameProgress ?? 0.5,
      });
      const { result } = runBotPlay(setup, { powerNoise: o.powerNoise, aimNoise: o.aimNoise, windComp: o.windComp });
      if (result.outcome === 'fg_good') made += 1;
      if (result.outcome === 'kick_blocked') blocked += 1;
    }
    out.push({ lo, hi, pct: made / per, blocked });
  }
  return out;
}

/** Kick-return outcomes: average starting spot (yards from own goal). */
export function returnBatch(o = {}) {
  const n = o.n ?? 300;
  let start = 0;
  let tb = 0;
  let td = 0;
  let fum = 0;
  for (let i = 0; i < n; i++) {
    const seed = ((o.seed ?? 5) * 6151 + i * 3571) >>> 0;
    const setup = makeSetup({ kind: 'kick_return', seed, offRating: o.offRating, defRating: o.defRating, difficultyStep: o.step ?? 6 });
    const { result: r } = runBotPlay(setup, { skill: o.skill ?? 0.6, touchbackRate: o.touchbackRate });
    if (r.outcome === 'touchback') tb += 1;
    if (r.outcome === 'return_td') td += 1;
    if (r.turnover) fum += 1;
    start += r.turnover ? 0 : r.outcome === 'return_td' ? 100 : r.endX - 10;
  }
  return { n, avgStart: start / n, touchbacks: tb / n, returnTds: td / n, turnovers: fum / n };
}

/** Pocket time: QB never throws; time until the sack. */
export function pocketBatch(o = {}) {
  const n = o.n ?? 200;
  const times = [];
  for (let i = 0; i < n; i++) {
    const seed = ((o.seed ?? 9) * 2741 + i * 811) >>> 0;
    const setup = makeSetup({ seed, offRating: o.offRating, defRating: o.defRating, difficultyStep: o.step ?? 6 });
    const { result } = runBotPlay(setup, { mode: 'hold' });
    times.push(result.elapsed);
  }
  times.sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(times.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return { mean, sd, p10: times[Math.floor(n * 0.1)], p50: times[Math.floor(n * 0.5)], p90: times[Math.floor(n * 0.9)] };
}

/** Human-readable calibration report (string). */
export function calibrationReport(n = 400) {
  const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : String(v));
  const pc = (v) => `${(v * 100).toFixed(1)}%`;
  const lines = [];
  const avg = scrimmageBatch({ n, seed: 1 });
  lines.push(`avg vs avg (step 6): cmp ${pc(avg.cmpPct)}  int ${pc(avg.intPct)}  sack ${pc(avg.sackPct)}  ypc ${f(avg.ypc)}  pass-play ${f(avg.passPlayAvg)}  throwT ${f(avg.avgThrowT, 2)}s  TD ${avg.td}`);
  const pk = pocketBatch({ n: Math.round(n / 2) });
  lines.push(`pocket time (no throw): mean ${f(pk.mean, 2)}s sd ${f(pk.sd, 2)} p10 ${f(pk.p10, 2)} p90 ${f(pk.p90, 2)}`);
  const kb = kickBatch({ n: Math.round(n / 4) });
  lines.push(`FG mid kicker: ${kb.map((b) => `${b.lo}-${b.hi}: ${pc(b.pct)}`).join('  ')}`);
  const rb = returnBatch({ n: Math.round(n / 2) });
  lines.push(`kick return: avg start own ${f(rb.avgStart)}  TB ${pc(rb.touchbacks)}  TD ${pc(rb.returnTds)}`);
  return lines.join('\n');
}
