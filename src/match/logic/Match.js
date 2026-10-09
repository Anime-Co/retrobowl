// Match state machine (MECHANICS §4.2–§4.4, §5): quarters, real-time clock, downs, possession,
// score, timeouts, audibles, decisions, kicks, simulated opponent drives, overtime and the final
// MatchResult. DOM-free and deterministic for a given seed + sequence of UI inputs.
//
// The UI loop:
//   const step = m.next();          // idempotent: returns the same pending Step until resolved
//   ...handle it, then resolve with exactly one of m.ack() / m.choose(id) / m.submitPlay(result)
// While a 'play' / 'kick' / 'kick_return' step is up, the UI calls m.onSnap() when the ball is
// snapped and m.tickClock(dt) every frame while m.state.clockRunning. A true return from
// tickClock() means the clock expired BEFORE the snap: the pending step was withdrawn (tear the
// play view down and call m.next()).
//
// Frames: state.ballOn is ALWAYS the user frame (yards from the user's own goal, 0..100);
// world losX = ballOn + 10. The opponent frame is 100 − ballOn.

import { Rng } from '../../core/rng.js';
import { clamp, fmtClock, ordinal } from '../../core/util.js';
import {
  CFG,
  HASH_Y,
  FIELD_MID_Y,
  timeoutsPerHalf,
  stepToDifficulty,
  ratingToStars,
  kickerMaxFg,
  onsideChance,
} from './config.js';
import { simDrive, cpuConversion, spotLabelOpp, spotLabelUser, CONVERSION_TEXT } from './simDrive.js';

const round1 = (v) => Math.round(v * 10) / 10;
const ACK_TYPES = new Set(['coin', 'opp_drive', 'auto', 'quarter_end', 'halftime', 'ot_start']);
const PLAY_TYPES = new Set(['play', 'kick', 'kick_return']);
const OUTCOME_LABEL = {
  td: 'Touchdown',
  fg: 'Field goal',
  fg_miss: 'Missed FG',
  punt: 'Punt',
  int: 'Interception',
  fumble: 'Fumble',
  downs: 'Turnover on downs',
  end_half: 'End of half',
};

/**
 * @typedef {Object} MatchOptions
 * @property {{id:string, abbr:string, city:string, colors?:Object}} userTeam
 * @property {{id:string, abbr:string, city:string, colors?:Object}} oppTeam
 * @property {import('../../types.js').Squad|null} userSquad
 * @property {import('../../types.js').Squad|null} oppSquad
 * @property {boolean} [userIsHome=true]
 * @property {boolean} [playoff=false]
 * @property {{quarterMinutes?:1|2|3, difficultyStep?:number, wind?:'off'|'low'|'normal'|'high', easyOtFirst?:boolean}} [settings]
 * @property {number} [seed]
 * @property {string} [gameId]
 * @property {{id:string, name:string, pos:'DL'|'LB'|'DB', number?:number}[]} [userDefenders]  star defenders
 * @property {{id:string|null, range:number, accuracy:number}|{id:string|null, kickPower:number, kickAccuracy:number}|null} [userKicker]
 *   range/accuracy on the 1–10 attribute scale, or a SquadPlayer-like {kickPower, kickAccuracy} 0..1;
 *   default: userSquad.offense.K, else a generic weak kicker
 * @property {number} [oppKickerRating]  0..1
 * @property {number} [oppOffStars]      override (default from oppSquad.offRating)
 * @property {number} [userDefStars]     override (default from userSquad.defRating)
 * @property {number} [audibles=2]       audibles per game (1 + floor(qbLevel/3), max 5); reset in OT
 * @property {'clear'|'rain'|'snow'} [weather]  forced weather (else rolled)
 * @property {boolean} [snowEligible]    northern city late in the season → snow can be rolled
 */

/**
 * Steps returned by Match#next(). Every step has a unique increasing `id`.
 *
 * Resolve with ack():
 *   {type:'coin', userReceives}
 *   {type:'opp_drive', beats:[{text, kind:'start'|'play'|'result'|'conversion', unskippable,
 *        clockAfter, quarterAfter, scoreAfter:{user,opp}}], summary, outcome, points, conversion,
 *        timeUsed, startYard (opp frame), userBallOn (user frame | null)}
 *        — state is updated on ack (show beats' clockAfter/scoreAfter on the scorebug meanwhile)
 *   {type:'auto', kind:'punt'|'onside'|'safety'|'defensive_td', text, success?} — already applied
 *   {type:'quarter_end', quarter, score} / {type:'halftime', score} / {type:'ot_start', period, userReceives, score}
 * Resolve with choose(id):
 *   {type:'decision', kind:'fourth', options:[{id:'punt'|'fg'|'go', label, detail}], down, toGo, ballOn, fgDistance, fgRange}
 *   {type:'decision', kind:'conversion', options:[{id:'pat'},{id:'two'}]}
 *   {type:'decision', kind:'onside', chance, options:[{id:'onside'},{id:'kickoff'}]}
 * Resolve with submitPlay(PlayResult) (after onSnap() + tickClock() while clockRunning):
 *   {type:'play', setup, canFieldGoal, twoPoint, down, toGo, ballOn, fgDistance?}  — also choose('fg')
 *       when fieldGoalAvailable(); twoPoint plays are untimed conversions
 *   {type:'kick', kind:'fg'|'pat', setup, distance}
 *   {type:'kick_return', setup, how}
 * Terminal:
 *   {type:'final', result: MatchResult}
 * @typedef {Object} Step
 */

export class Match {
  /** @param {MatchOptions} opts */
  constructor(opts = {}) {
    const s = opts.settings || {};
    this.settings = {
      quarterMinutes: [1, 2, 3].includes(s.quarterMinutes) ? s.quarterMinutes : 2,
      difficultyStep: clamp(Math.round(s.difficultyStep ?? 6), 1, 16),
      wind: s.wind && CFG.wind[s.wind] ? s.wind : 'normal',
      easyOtFirst: !!s.easyOtFirst,
    };
    this.gameId = opts.gameId ?? null;
    this.playoff = !!opts.playoff;
    this.userTeam = opts.userTeam || { id: 'USER', abbr: 'YOU', city: 'Home' };
    this.oppTeam = opts.oppTeam || { id: 'OPP', abbr: 'OPP', city: 'Away' };
    this.userIsHome = opts.userIsHome ?? true;
    this.userSquad = opts.userSquad ?? null;
    this.oppSquad = opts.oppSquad ?? null;
    this.userDefenders = (opts.userDefenders || []).filter(Boolean);
    this.userKicker = resolveKicker(opts.userKicker, this.userSquad);
    this.oppKickerRating = clamp(opts.oppKickerRating ?? squadKickerRating(this.oppSquad) ?? 0.5, 0, 1);
    this.oppOffStars = opts.oppOffStars ?? ratingToStars(this.oppSquad?.offRating);
    this.userDefStars = opts.userDefStars ?? ratingToStars(this.userSquad?.defRating);
    this.audiblesPerGame = clamp(Math.round(opts.audibles ?? 2), 0, 5);
    this.qlen = this.settings.quarterMinutes * 60;
    this.rng = new Rng((opts.seed ?? 1) >>> 0 || 1);

    const qm = this.settings.quarterMinutes;
    this._openingUserReceives = this.rng.chance(0.5);
    const weather = opts.weather || this._rollWeather(!!opts.snowEligible);
    this._windStadium = this._rollWind();

    /** Public, read-only for the UI. */
    this.state = {
      quarter: 1, // 1–4; ≥5 = overtime period (quarter − 4)
      clock: this.qlen,
      half: 1, // 1, 2; 3 = overtime
      otPeriod: 0,
      score: { user: 0, opp: 0 },
      possession: this._openingUserReceives ? 'user' : 'opp',
      ballOn: 25,
      down: 1,
      toGo: 10,
      hashY: FIELD_MID_Y,
      timeouts: { user: timeoutsPerHalf(qm) },
      audiblesLeft: this.audiblesPerGame,
      clockRunning: false,
      weather,
      wind: { x: 0, y: 0 },
      quarterMinutes: qm,
      log: [],
      stats: {},
    };
    this._applyWind();

    /** Drive records (both teams, chronological). */
    this.drives = [];
    this._drive = null;
    this._phase = { k: 'coin' };
    this._step = null;
    this._h = null;
    this._stepId = 0;
    this._live = false;
    this._runoffPending = false;
    this._carry = 0;
    this._fourthChoice = null;
    this._ot = null;
    this._hits = [];
    this._result = null;
    this._timeoutsUsed = [0, 0, 0];
    this._box = {
      user: { plays: 0, passAtt: 0, passCmp: 0, passYds: 0, rushAtt: 0, rushYds: 0, sacked: 0, sackYds: 0, turnovers: 0, firstDowns: 0, top: 0 },
      opp: { plays: 0, passYds: 0, rushYds: 0, turnovers: 0, top: 0 },
      byQuarter: { user: [0, 0, 0, 0, 0], opp: [0, 0, 0, 0, 0] },
      scoringPlays: [],
    };
  }

  // ===========================================================================================
  // Public API
  // ===========================================================================================

  /** The Step the UI must handle now. Idempotent until the step is resolved. */
  next() {
    let guard = 0;
    while (!this._step) {
      if (++guard > 500) throw new Error(`Match: no step produced (phase ${this._phase.k})`);
      this._advance();
    }
    return this._step;
  }

  /** True once the final step has been produced. */
  get isOver() {
    return this._phase.k === 'final' && !!this._result;
  }

  /** Resolve coin / opp_drive / auto / quarter_end / halftime / ot_start. */
  ack() {
    const s = this._step;
    if (!s || !ACK_TYPES.has(s.type)) return false;
    const h = this._h;
    this._resolve();
    if (h && h.onAck) h.onAck();
    return true;
  }

  /** Resolve a decision step with one of its option ids, or 'fg' on a play step (canFieldGoal). */
  choose(id) {
    const s = this._step;
    if (!s) return false;
    if (s.type === 'decision') {
      if (!s.options.some((o) => o.id === id)) return false;
      const h = this._h;
      this._resolve();
      h.onChoose(id);
      return true;
    }
    if (s.type === 'play' && id === 'fg' && this.fieldGoalAvailable()) {
      this._resolve();
      this._runoffPending = false; // the FG unit comes on with the clock stopped
      this._phase = { k: 'user_fg' };
      return true;
    }
    return false;
  }

  /**
   * Resolve a play / kick / kick_return step with the engine's PlayResult.
   * @param {import('../../types.js').PlayResult} result
   */
  submitPlay(result) {
    const s = this._step;
    if (!s || !PLAY_TYPES.has(s.type) || !result) return false;
    const r = normalizeResult(result, s.setup);
    const h = this._h;
    this._resolve();
    h.onResult(r);
    return true;
  }

  /** The UI reports the snap of the pending play/kick/kick_return. Starts the clock if stopped. */
  onSnap() {
    const s = this._step;
    if (!s || !PLAY_TYPES.has(s.type) || this._live) return false;
    this._live = true;
    const untimed = (s.type === 'kick' && s.kind === 'pat') || (s.type === 'play' && s.twoPoint);
    this.state.clockRunning = !untimed && this.state.clock > 0;
    return true;
  }

  /**
   * Run the game clock while state.clockRunning (live play, or pre-snap after an in-bounds play).
   * Never goes below 0. Returns true if the clock expired before the snap and the pending step
   * was withdrawn (the UI must abandon the pre-snap view and call next()).
   */
  tickClock(dt) {
    const st = this.state;
    if (!st.clockRunning || !(dt > 0)) return false;
    const used = Math.min(dt, st.clock);
    st.clock -= used;
    this._box[st.possession === 'opp' ? 'opp' : 'user'].top += used;
    if (st.clock <= 1e-9) {
      st.clock = 0;
      st.clockRunning = false;
      if (!this._live && this._step && PLAY_TYPES.has(this._step.type)) {
        this._log('user', 'The clock runs out before the snap.', { kind: 'clock' });
        this._resolve();
        this._runoffPending = false;
        return true;
      }
    }
    return false;
  }

  /** Whether a user timeout is allowed right now (user ball, between plays, clock would run). */
  canCallTimeout() {
    const s = this._step;
    const st = this.state;
    if (!s || this._live || st.possession !== 'user') return false;
    const between = (s.type === 'play' && !s.twoPoint) || (s.type === 'decision' && s.kind === 'fourth');
    return between && st.timeouts.user > 0 && st.clock > 0 && this._runoffPending;
  }

  /** Call a user timeout: decrements, stops the clock until the next snap. */
  callTimeout() {
    if (!this.canCallTimeout()) return false;
    const st = this.state;
    st.timeouts.user -= 1;
    this._timeoutsUsed[Math.min(st.half, 3) - 1] += 1;
    this._runoffPending = false;
    st.clockRunning = false;
    this._log('user', `Timeout ${this.userTeam.abbr} (${st.timeouts.user} left).`, { kind: 'timeout' });
    return true;
  }

  /** Use an audible on the pending play (pre-snap). The engine re-rolls the play. */
  useAudible() {
    const s = this._step;
    if (!s || s.type !== 'play' || this._live || this.state.audiblesLeft <= 0) return false;
    this.state.audiblesLeft -= 1;
    return true;
  }

  /** Live check for the FG button on a play step (the window can open while the clock runs). */
  fieldGoalAvailable() {
    const s = this._step;
    if (!s || s.type !== 'play' || s.twoPoint || this._live) return false;
    return this._fgEligible(false);
  }

  /** FG distance from the current spot (yards to goal + 17). */
  fieldGoalDistance() {
    return Math.round(100 - this.state.ballOn + CFG.kicking.fgSnapOffset);
  }

  /** Max FG distance for the user's kicker. */
  fieldGoalRange() {
    return kickerMaxFg(this.userKicker.range);
  }

  /** "3rd & 4", "1st & Goal", "4th & inches". */
  downText() {
    return downLabel(this.state);
  }

  /** The MatchResult once final (also on the final step). */
  get result() {
    return this._result;
  }

  // ===========================================================================================
  // Phase machine
  // ===========================================================================================

  _advance() {
    const ph = this._phase;
    const st = this.state;
    switch (ph.k) {
      case 'coin':
        return this._present(
          { type: 'coin', userReceives: this._openingUserReceives },
          {
            onAck: () => {
              this._log(this._openingUserReceives ? 'user' : 'opp', `${this._openingUserReceives ? this.userTeam.abbr : this.oppTeam.abbr} receive the opening kickoff.`, { kind: 'coin' });
              this._phase = this._openingUserReceives ? { k: 'kick_to_user', how: 'opening' } : { k: 'user_kickoff', how: 'opening' };
            },
          },
        );
      case 'kick_to_user':
        if (this._periodOver()) return this._endPeriod();
        if (this._otDecided()) return this._goFinal();
        return this._presentKickReturn(ph);
      case 'user_kickoff':
        if (this._periodOver()) return this._endPeriod();
        if (this._otDecided()) return this._goFinal();
        return this._doUserKickoff(ph);
      case 'opp_drive':
        if (this._periodOver()) return this._endPeriod();
        if (this._otDecided()) return this._goFinal();
        return this._presentOppDrive(ph);
      case 'user_down':
        if (this._periodOver()) return this._endPeriod();
        if (st.down === 4 && !this._fourthChoice) return this._presentFourth();
        return this._presentPlay(false);
      case 'user_fg':
        return this._presentKick('fg');
      case 'conversion':
        return this._presentConversion();
      case 'pat':
        return this._presentKick('pat');
      case 'two_point':
        return this._presentPlay(true);
      case 'after_user_score':
        return this._afterUserScore();
      case 'after_opp_score':
        if (this._otDecided()) return this._goFinal();
        this._phase = { k: 'kick_to_user', how: 'kickoff' };
        return undefined;
      case 'notice':
        return this._present(
          { type: 'auto', kind: ph.kind, text: ph.text, ...(ph.extra || {}) },
          { onAck: () => { this._phase = ph.then; } },
        );
      case 'period_end':
        if (this._periodOver()) return this._endPeriod();
        this._phase = { k: 'kick_to_user', how: 'kickoff' };
        return undefined;
      case 'final':
        return this._presentFinal();
      default:
        throw new Error(`Match: unknown phase ${ph.k}`);
    }
  }

  _present(step, handlers = {}) {
    step.id = ++this._stepId;
    this._step = step;
    this._h = handlers;
    this._live = false;
    this.state.clockRunning = step.type === 'play' && !step.twoPoint && this._runoffPending && this.state.clock > 0;
    return step;
  }

  _resolve() {
    this._step = null;
    this._h = null;
    this._live = false;
    this.state.clockRunning = false;
  }

  _periodOver() {
    return this.state.clock <= 0;
  }

  _endPeriod() {
    const st = this.state;
    const q = st.quarter;
    this._runoffPending = false;
    if (q === 1 || q === 3) {
      return this._present(
        { type: 'quarter_end', quarter: q, score: { ...st.score } },
        {
          onAck: () => {
            st.quarter += 1;
            st.clock = Math.max(0, this.qlen - this._carry);
            this._carry = 0;
            this._applyWind();
          },
        },
      );
    }
    if (q === 2) {
      return this._present(
        { type: 'halftime', score: { ...st.score } },
        {
          onAck: () => {
            this._closeDrive('end_half');
            st.quarter = 3;
            st.half = 2;
            st.clock = this.qlen;
            this._carry = 0;
            st.timeouts.user = timeoutsPerHalf(this.settings.quarterMinutes);
            this._fourthChoice = null;
            this._applyWind();
            this._log('user', 'Halftime.', { kind: 'period' });
            const userReceives = !this._openingUserReceives;
            this._phase = userReceives ? { k: 'kick_to_user', how: 'half' } : { k: 'user_kickoff', how: 'half' };
          },
        },
      );
    }
    if (st.score.user !== st.score.opp) return this._goFinal();
    // regulation tied → OT; OT period over and still tied → playoffs go again, otherwise a tie
    if (q >= 5 && !this.playoff) return this._goFinal();
    const userReceives = this.settings.easyOtFirst ? true : this.rng.chance(0.5);
    return this._presentOtStart(userReceives);
  }

  _presentOtStart(userReceives) {
    const st = this.state;
    const period = st.otPeriod + 1;
    return this._present(
      { type: 'ot_start', period, userReceives, score: { ...st.score } },
      {
        onAck: () => {
          this._closeDrive('end_half');
          if (!this._ot) this._ot = { done: { user: 0, opp: 0 }, firstReceiver: userReceives ? 'user' : 'opp' };
          st.otPeriod = period;
          st.quarter = 4 + period;
          st.half = 3;
          st.clock = this.qlen;
          this._carry = 0;
          st.timeouts.user = timeoutsPerHalf(this.settings.quarterMinutes);
          st.audiblesLeft = this.audiblesPerGame;
          this._fourthChoice = null;
          this._applyWind();
          this._log(userReceives ? 'user' : 'opp', `Overtime${period > 1 ? ` ${period}` : ''}: ${userReceives ? this.userTeam.abbr : this.oppTeam.abbr} receive.`, { kind: 'period' });
          this._phase = userReceives ? { k: 'kick_to_user', how: 'ot' } : { k: 'user_kickoff', how: 'ot' };
        },
      },
    );
  }

  /**
   * OT: both teams have COMPLETED a possession and the score differs → game over. Checked only at
   * possession boundaries (and after scoring sequences), so the second team always plays its
   * drive out; after that every score is sudden death.
   */
  _otDecided() {
    const st = this.state;
    return !!this._ot && st.quarter >= 5 && this._ot.done.user > 0 && this._ot.done.opp > 0 && st.score.user !== st.score.opp;
  }

  _goFinal() {
    this._closeDrive('end_game');
    this._runoffPending = false;
    this._phase = { k: 'final' };
    return undefined;
  }

  _presentFinal() {
    if (!this._result) {
      const st = this.state;
      this._log(st.score.user > st.score.opp ? 'user' : 'opp', `Final: ${this.userTeam.abbr} ${st.score.user}, ${this.oppTeam.abbr} ${st.score.opp}${this._ot ? ' (OT)' : ''}.`, { kind: 'final' });
      this._result = this._buildResult();
    }
    return this._present({ type: 'final', result: this._result }, {});
  }

  // ---- kickoffs ------------------------------------------------------------------------------

  _presentKickReturn(ph) {
    const st = this.state;
    st.possession = 'user';
    st.ballOn = CFG.field.oppKickoffLosX - 10;
    st.down = 1;
    st.toGo = 10;
    st.hashY = FIELD_MID_Y;
    const setup = this._setup('kick_return', { losX: CFG.field.oppKickoffLosX, firstDownX: 110, down: 1, hashY: FIELD_MID_Y });
    return this._present({ type: 'kick_return', setup, how: ph.how }, { onResult: (r) => this._applyKickReturn(r, ph) });
  }

  _applyKickReturn(r, ph) {
    const st = this.state;
    const abbr = this.oppTeam.abbr;
    this._mergeStats(r);
    this._runoffPending = false;
    const endBallOn = r.endX - 10;
    if (r.turnover) {
      st.ballOn = clamp(round1(endBallOn), 0, 100);
      this._openDrive('user', ph.how || 'kickoff', st.ballOn);
      this._box.user.turnovers += 1;
      this._closeDrive('fumble');
      const spot = (r.turnoverX ?? r.endX) - 10;
      this._log('opp', `Fumble on the return — ${abbr} recover.`, { kind: 'turnover' });
      if (spot <= 0) return this._oppDefensiveTd('Fumble on the return in the end zone!');
      const startYard = clamp(Math.round(100 - spot), 1, 99);
      this._handOver(startYard);
      this._phase = { k: 'opp_drive', startYard, how: 'turnover', startText: `FUMBLE on the return! ${abbr} recover at ${spotLabelOpp(startYard, abbr)}.` };
      return;
    }
    if (r.outcome === 'return_td' || r.outcome === 'td' || endBallOn >= 100) {
      st.ballOn = 100;
      this._openDrive('user', ph.how || 'kickoff', CFG.field.oppKickoffLosX - 10);
      this._userTd(`Kick return TD ${this.userTeam.abbr}!`);
      return;
    }
    if (r.outcome === 'safety') {
      // returner left the end zone and was downed back in it (the engine reports touchbacks separately)
      st.ballOn = 0;
      this._openDrive('user', ph.how || 'kickoff', 0);
      this._userSafety();
      return;
    }
    if (r.outcome === 'touchback' || endBallOn <= 0) {
      st.ballOn = CFG.field.kickReturnTouchback;
      st.hashY = FIELD_MID_Y;
    } else {
      st.ballOn = clamp(round1(endBallOn), 1, 99);
      st.hashY = hashFrom(r.endY);
    }
    this._openDrive('user', ph.how || 'kickoff', st.ballOn);
    this._newSeries();
    this._phase = { k: 'user_down' };
  }

  _doUserKickoff(ph) {
    const rng = this.rng;
    const abbr = this.oppTeam.abbr;
    const kc = CFG.kickoff;
    const pTB = clamp(kc.touchbackBase + kc.touchbackPerRange * this.userKicker.range, 0, 0.95);
    let startYard;
    let text;
    if (rng.chance(pTB)) {
      startYard = CFG.field.kickoffTouchback;
      text = `Kickoff into the end zone — touchback. ${abbr} start at their ${startYard}.`;
    } else {
      let ret = clamp(rng.normal(kc.returnMean, kc.returnSd), 8, 45);
      if (rng.chance(kc.longReturnChance)) ret = rng.float(45, 75);
      startYard = Math.round(ret);
      text = `Kickoff returned to ${spotLabelOpp(startYard, abbr)}.`;
    }
    this._phase = { k: 'opp_drive', startYard, how: ph.how || 'kickoff', startText: text };
    return undefined;
  }

  // ---- user offense --------------------------------------------------------------------------

  _presentFourth() {
    const st = this.state;
    const fgOk = this._fgEligible(true);
    const dist = this.fieldGoalDistance();
    const puntOk = st.ballOn <= CFG.fourth.puntMaxBallOn || (!fgOk && st.ballOn <= CFG.fourth.puntMaxBallOnNoFg);
    const options = [];
    if (puntOk) {
      const avg = Math.round(CFG.punt.base + CFG.punt.perRange * this.userKicker.range);
      options.push({ id: 'punt', label: 'PUNT', detail: `Kick it away (~${avg} yd)` });
    }
    if (fgOk) options.push({ id: 'fg', label: 'FIELD GOAL', detail: `${dist}-yard attempt` });
    options.push({ id: 'go', label: 'GO FOR IT', detail: `${downLabel(st)} at ${spotLabelUser(st.ballOn, this.oppTeam.abbr)}` });
    return this._present(
      { type: 'decision', kind: 'fourth', options, down: st.down, toGo: st.toGo, ballOn: st.ballOn, fgDistance: dist, fgRange: Math.round(this.fieldGoalRange()) },
      {
        onChoose: (id) => {
          if (id === 'go') {
            this._fourthChoice = 'go';
            this._phase = { k: 'user_down' };
          } else if (id === 'fg') {
            this._fourthChoice = 'fg';
            this._runoffPending = false;
            this._phase = { k: 'user_fg' };
          } else this._userPunt();
        },
      },
    );
  }

  _presentPlay(twoPoint) {
    const st = this.state;
    if (twoPoint) {
      const setup = this._setup('scrimmage', { twoPoint: true, losX: CFG.field.twoPointBallOn + 10, firstDownX: 110, down: 1, hashY: FIELD_MID_Y });
      return this._present(
        { type: 'play', setup, canFieldGoal: false, twoPoint: true, down: 1, toGo: 100 - CFG.field.twoPointBallOn, ballOn: CFG.field.twoPointBallOn },
        { onResult: (r) => this._applyTwoPoint(r) },
      );
    }
    const setup = this._setup('scrimmage', {});
    return this._present(
      { type: 'play', setup, canFieldGoal: this._fgEligible(false), twoPoint: false, down: st.down, toGo: st.toGo, ballOn: st.ballOn, fgDistance: this.fieldGoalDistance() },
      { onResult: (r) => this._applyScrimmage(r) },
    );
  }

  _presentKick(kind) {
    const st = this.state;
    if (kind === 'pat') {
      const setup = this._setup('pat', { losX: CFG.field.patBallOn + 10, firstDownX: 110, down: 1, hashY: FIELD_MID_Y });
      const distance = 100 - CFG.field.patBallOn + CFG.kicking.fgSnapOffset;
      return this._present({ type: 'kick', kind: 'pat', setup, distance }, { onResult: (r) => this._applyPat(r) });
    }
    const setup = this._setup('fg', { firstDownX: 110 });
    return this._present(
      { type: 'kick', kind: 'fg', setup, distance: this.fieldGoalDistance(), ballOn: st.ballOn },
      { onResult: (r) => this._applyFg(r) },
    );
  }

  _presentConversion() {
    const patDist = 100 - CFG.field.patBallOn + CFG.kicking.fgSnapOffset;
    return this._present(
      {
        type: 'decision',
        kind: 'conversion',
        options: [
          { id: 'pat', label: 'KICK PAT', detail: `1 point · ${patDist}-yard kick` },
          { id: 'two', label: 'GO FOR 2', detail: `2 points · one play from the ${100 - CFG.field.twoPointBallOn}` },
        ],
      },
      { onChoose: (id) => { this._phase = { k: id === 'two' ? 'two_point' : 'pat' }; } },
    );
  }

  _applyScrimmage(r) {
    const st = this.state;
    const los = st.ballOn;
    const ltg = los + st.toGo;
    this._mergeStats(r);
    this._tallyUser(r);
    if (this._drive) this._drive.plays += 1;
    this._fourthChoice = null;
    const endBallOn = r.endX - 10;
    if (r.turnover) return this._userTurnover(r);
    const dead = r.outcome !== 'incomplete';
    if (r.outcome === 'td' || (dead && endBallOn >= 100)) {
      if (this._drive) this._drive.yards += 100 - los;
      return this._userTd(tdText(this.userTeam.abbr, r));
    }
    if (r.outcome === 'safety' || (dead && endBallOn <= 0)) return this._userSafety();
    const spot = dead ? clamp(round1(endBallOn), 0.5, 99.5) : los;
    if (dead) st.hashY = hashFrom(r.endY);
    if (this._drive) this._drive.yards += spot - los;
    st.ballOn = spot;
    const stops = r.outcome === 'incomplete' || r.outcome === 'oob' || r.clockStops === true;
    this._runoffPending = !stops;
    if (spot >= ltg - 1e-6) {
      this._box.user.firstDowns += 1;
      this._newSeries();
    } else if (st.down >= 4) {
      this._runoffPending = false;
      this._closeDrive('downs');
      const startYard = clamp(Math.round(100 - spot), 1, 99);
      const abbr = this.oppTeam.abbr;
      this._log('opp', `Turnover on downs at ${spotLabelUser(spot, abbr)}.`, { kind: 'turnover' });
      this._handOver(startYard);
      this._phase = { k: 'opp_drive', startYard, how: 'downs', startText: `Turnover on downs. ${abbr} take over at ${spotLabelOpp(startYard, abbr)}.` };
      return undefined;
    } else {
      st.down += 1;
      st.toGo = round1(ltg - spot);
    }
    this._phase = { k: 'user_down' };
    return undefined;
  }

  _userTurnover(r) {
    const st = this.state;
    const abbr = this.oppTeam.abbr;
    const isInt = r.outcome === 'interception';
    this._box.user.turnovers += 1;
    this._runoffPending = false;
    this._closeDrive(isInt ? 'int' : 'fumble');
    const spot = (r.turnoverX ?? r.endX) - 10; // user frame
    this._log('opp', isInt ? `Intercepted by ${abbr}.` : `Fumble lost to ${abbr}.`, { kind: 'turnover' });
    if (spot <= 0) return this._oppDefensiveTd(isInt ? 'Pick-six!' : 'Scoop and score!');
    let startYard;
    let startText;
    if (spot >= 100) {
      startYard = isInt ? CFG.field.intTouchback : CFG.field.puntTouchback;
      startText = `${isInt ? 'Picked off' : 'Fumble recovered'} in the end zone — touchback. ${abbr} start at their ${startYard}.`;
    } else {
      startYard = clamp(Math.round(100 - spot), 1, 99);
      startText = `${isInt ? 'INTERCEPTED' : 'FUMBLE'}! ${abbr} take over at ${spotLabelOpp(startYard, abbr)}.`;
    }
    this._handOver(startYard);
    this._phase = { k: 'opp_drive', startYard, how: 'turnover', startText };
    return undefined;
  }

  /** Defense returns a user turnover for a TD (spot at/behind the user's goal line). */
  _oppDefensiveTd(lead) {
    const st = this.state;
    const abbr = this.oppTeam.abbr;
    st.ballOn = 0;
    this._openDrive('opp', 'return', 100);
    this._score('opp', 6, 'td', `${abbr} defensive TD`);
    const conv = cpuConversion({
      scoreDiff: st.score.opp - 6 - st.score.user,
      half: st.quarter >= 5 ? 3 : st.half,
      offStars: this.oppOffStars,
      defStars: this.userDefStars,
      kickerRating: this.oppKickerRating,
      rng: this.rng,
      skipIfAhead: !!this._ot && st.quarter >= 5 && this._ot.done.user > 0,
    });
    if (conv.points) this._score('opp', conv.points, conv.conversion === 'two_good' ? 'two' : 'pat', `${abbr} ${conv.conversion === 'two_good' ? '2-pt try' : 'PAT'} good`);
    this._closeDrive('td');
    const tail = conv.conversion ? ` ${CONVERSION_TEXT[conv.conversion]}` : '';
    this._phase = { k: 'notice', kind: 'defensive_td', text: `${lead} ${abbr} take it back for a touchdown.${tail}`, then: { k: 'after_opp_score' } };
    return undefined;
  }

  _userTd(text) {
    const st = this.state;
    this._runoffPending = false;
    this._fourthChoice = null;
    this._score('user', 6, 'td', text);
    this._closeDrive('td');
    // OT: a TD that wins it outright needs no try
    if (this._otDecided() && st.score.user > st.score.opp) this._phase = { k: 'after_user_score' };
    else this._phase = { k: 'conversion' };
    return undefined;
  }

  _userSafety() {
    const st = this.state;
    const abbr = this.oppTeam.abbr;
    this._runoffPending = false;
    st.ballOn = 0;
    this._score('opp', 2, 'safety', `Safety — ${abbr} +2`);
    this._closeDrive('safety');
    const startYard = CFG.field.safetyOppStart;
    this._handOver(startYard);
    this._phase = {
      k: 'notice',
      kind: 'safety',
      text: `SAFETY! ${abbr} +2. You free-kick from your 20 — ${abbr} start at their ${startYard}.`,
      then: { k: 'opp_drive', startYard, how: 'safety_kick', startText: `${abbr} take over at their ${startYard} after the free kick.` },
    };
    return undefined;
  }

  _userPunt() {
    const st = this.state;
    const rng = this.rng;
    const pc = CFG.punt;
    const abbr = this.oppTeam.abbr;
    const k = this.userKicker;
    const gross = Math.round(pc.base + pc.perRange * k.range + rng.float(-pc.spread, pc.spread));
    const landing = st.ballOn + gross; // user frame
    let startYard;
    let text;
    if (landing >= 100) {
      startYard = CFG.field.puntTouchback;
      text = `Punt sails into the end zone — touchback. ${abbr} start at their ${startYard}.`;
    } else if (landing >= 100 - pc.coffinZone && rng.chance(0.5)) {
      startYard = clamp(Math.round(100 - landing), 1, 99);
      text = `${gross}-yard punt downed at the ${abbr} ${startYard}!`;
    } else {
      const fair = rng.chance(pc.fairCatch);
      let ret = fair ? 0 : Math.max(0, rng.normal(pc.returnMean, pc.returnSd));
      if (!fair && rng.chance(pc.longReturnChance)) ret += rng.float(15, 35);
      startYard = clamp(Math.round(100 - landing + ret), 1, 99);
      text = fair
        ? `${gross}-yard punt, fair catch at ${spotLabelOpp(startYard, abbr)}.`
        : `${gross}-yard punt, returned ${Math.round(ret)} to ${spotLabelOpp(startYard, abbr)}.`;
    }
    if (k.id) this._addStats(k.id, { punts: 1, puntYds: gross });
    this._runoffPending = false;
    this._fourthChoice = null;
    this._closeDrive('punt');
    this._log('user', text, { kind: 'punt' });
    this._handOver(startYard);
    this._phase = { k: 'notice', kind: 'punt', text, then: { k: 'opp_drive', startYard, how: 'punt', startText: `${abbr} take over at ${spotLabelOpp(startYard, abbr)}.` } };
  }

  _applyFg(r) {
    const st = this.state;
    const abbr = this.oppTeam.abbr;
    this._mergeStats(r);
    this._runoffPending = false;
    this._fourthChoice = null;
    const dist = this.fieldGoalDistance();
    if (r.outcome === 'fg_good') {
      this._score('user', 3, 'fg', `FG ${this.userTeam.abbr} — ${dist} yards`);
      this._closeDrive('fg');
      this._phase = { k: 'after_user_score' };
      return;
    }
    this._closeDrive('fg_miss');
    // spot of the kick or the opponent 20, whichever is better for them (engine turnoverX if given)
    const own = Math.max(CFG.field.missedFgMin, Math.round(100 - (st.ballOn - CFG.field.missedFgHolderOffset)));
    const startYard = clamp(Number.isFinite(r.turnoverX) ? Math.round(110 - r.turnoverX) : own, 1, 99);
    const blocked = r.outcome === 'kick_blocked';
    this._log('user', `${dist}-yard FG ${blocked ? 'blocked' : 'no good'}.`, { kind: 'fg_miss' });
    this._handOver(startYard);
    this._phase = { k: 'opp_drive', startYard, how: 'fg_miss', startText: `${blocked ? 'Kick blocked!' : `${dist}-yard try is no good.`} ${abbr} take over at ${spotLabelOpp(startYard, abbr)}.` };
  }

  _applyPat(r) {
    this._mergeStats(r);
    if (r.outcome === 'pat_good') this._score('user', 1, 'pat', `PAT good`);
    else this._log('user', r.outcome === 'kick_blocked' ? 'PAT blocked.' : 'PAT no good.', { kind: 'pat_miss' });
    this._phase = { k: 'after_user_score' };
  }

  _applyTwoPoint(r) {
    this._mergeStats(r);
    const ok = !r.turnover && (r.outcome === 'td' || (r.outcome !== 'incomplete' && r.endX >= 110));
    if (ok) this._score('user', 2, 'two', `2-pt try good`);
    else this._log('user', '2-pt try fails.', { kind: 'two_fail' });
    this._phase = { k: 'after_user_score' };
  }

  _afterUserScore() {
    const st = this.state;
    if (this._otDecided()) return this._goFinal();
    if (st.quarter === 4 && st.clock > 0 && st.score.user < st.score.opp) {
      const chance = onsideChance(this.userKicker);
      const pct = Math.round(chance * 100);
      return this._present(
        {
          type: 'decision',
          kind: 'onside',
          chance,
          options: [
            { id: 'onside', label: 'ONSIDE KICK', detail: `${pct}% chance to recover` },
            { id: 'kickoff', label: 'KICK DEEP', detail: 'Normal kickoff' },
          ],
        },
        { onChoose: (id) => (id === 'onside' ? this._onsideKick(chance) : (this._phase = { k: 'user_kickoff', how: 'kickoff' })) },
      );
    }
    this._phase = { k: 'user_kickoff', how: 'kickoff' };
    return undefined;
  }

  _onsideKick(chance) {
    const st = this.state;
    const abbr = this.oppTeam.abbr;
    const spot = CFG.field.onsideSpotBallOn;
    if (this.rng.chance(chance)) {
      st.ballOn = spot;
      st.hashY = FIELD_MID_Y;
      this._openDrive('user', 'onside', spot);
      this._newSeries();
      this._runoffPending = false;
      const text = `ONSIDE KICK RECOVERED! Your ball at ${spotLabelUser(spot, abbr)}.`;
      this._log('user', text, { kind: 'onside' });
      this._phase = { k: 'notice', kind: 'onside', text, extra: { success: true }, then: { k: 'user_down' } };
    } else {
      const startYard = 100 - spot;
      const text = `Onside kick fails — ${abbr} recover at ${spotLabelOpp(startYard, abbr)}.`;
      this._log('opp', text, { kind: 'onside' });
      this._handOver(startYard);
      this._phase = { k: 'notice', kind: 'onside', text, extra: { success: false }, then: { k: 'opp_drive', startYard, how: 'onside_fail', startText: `${abbr} take over at ${spotLabelOpp(startYard, abbr)}.` } };
    }
  }

  // ---- opponent possessions ------------------------------------------------------------------

  _presentOppDrive(ph) {
    const st = this.state;
    st.possession = 'opp';
    st.ballOn = 100 - ph.startYard;
    st.hashY = FIELD_MID_Y;
    this._openDrive('opp', ph.how || 'kickoff', ph.startYard);
    const q = st.quarter;
    const clockLeft = q === 1 || q === 3 ? st.clock + this.qlen : st.clock;
    const res = simDrive({
      offStars: this.oppOffStars,
      defStars: this.userDefStars,
      startYard: ph.startYard,
      clockLeft,
      quarterMinutes: this.settings.quarterMinutes,
      difficultyStep: this.settings.difficultyStep,
      half: q >= 5 ? 3 : st.half,
      scoreDiff: st.score.opp - st.score.user,
      rng: this.rng.fork(this._stepId),
      userDefenders: this.userDefenders,
      oppAbbr: this.oppTeam.abbr,
      kickerRating: this.oppKickerRating,
      startText: ph.startText,
      skipConversionIfAhead: !!this._ot && q >= 5 && this._ot.done.user > 0,
    });
    const running = { ...st.score };
    const beats = res.beats.map((b) => {
      running.opp += b.pts;
      const at = this._clockAfter(b.t);
      return { text: b.text, kind: b.kind, unskippable: b.unskippable, clockAfter: at.clock, quarterAfter: at.quarter, scoreAfter: { ...running } };
    });
    const summary = `${this.oppTeam.abbr}: ${res.plays} plays, ${res.yards} yds, ${fmtClock(res.timeUsed)} — ${OUTCOME_LABEL[res.outcome]}${res.conversion ? ` (${CONVERSION_TEXT[res.conversion]})` : ''}`;
    return this._present(
      { type: 'opp_drive', beats, summary, outcome: res.outcome, points: res.points, conversion: res.conversion, timeUsed: res.timeUsed, startYard: ph.startYard, userBallOn: res.userBallOn },
      { onAck: () => this._applyOppDrive(res) },
    );
  }

  _clockAfter(t) {
    const st = this.state;
    const c = st.clock - t;
    if (c >= 0) return { quarter: st.quarter, clock: c };
    return { quarter: st.quarter + 1, clock: Math.max(0, this.qlen + c) };
  }

  _applyOppDrive(res) {
    const st = this.state;
    const abbr = this.oppTeam.abbr;
    const at = this._clockAfter(res.timeUsed);
    if (res.timeUsed > st.clock) {
      this._carry = res.timeUsed - st.clock;
      st.clock = 0;
    } else st.clock = Math.max(0, st.clock - res.timeUsed);
    this._box.opp.top += res.timeUsed;
    this._box.opp.plays += res.plays;
    this._box.opp.passYds += res.passYds;
    this._box.opp.rushYds += res.rushYds;
    if (this._drive) {
      this._drive.plays = res.plays;
      this._drive.yards = res.yards;
    }
    for (const [id, s] of Object.entries(res.defStats)) this._addStats(id, s);
    if (res.outcome === 'td' || res.outcome === 'fg') {
      const line = res.beats.find((b) => b.kind === 'result')?.text;
      if (res.outcome === 'td') {
        this._score('opp', 6, 'td', line || `TD ${abbr}`, at);
        if (res.conversion === 'pat_good') this._score('opp', 1, 'pat', `${abbr} PAT good`, at);
        else if (res.conversion === 'two_good') this._score('opp', 2, 'two', `${abbr} 2-pt try good`, at);
      } else this._score('opp', 3, 'fg', line || `FG ${abbr}`, at);
      this._closeDrive(res.outcome);
      this._phase = { k: 'after_opp_score' };
      return;
    }
    this._log('opp', `${abbr} drive ends: ${OUTCOME_LABEL[res.outcome]}.`, { kind: res.outcome, at });
    if (res.outcome === 'int' || res.outcome === 'fumble') this._box.opp.turnovers += 1;
    this._closeDrive(res.outcome);
    if (this._otDecided()) {
      this._goFinal();
      return;
    }
    const halfOver = st.clock <= 0 && (st.quarter === 2 || st.quarter >= 4);
    if (res.outcome === 'end_half' || res.userBallOn == null || halfOver) {
      this._phase = { k: 'period_end' };
      return;
    }
    st.possession = 'user';
    st.ballOn = res.userBallOn;
    st.hashY = FIELD_MID_Y;
    this._openDrive('user', res.outcome, st.ballOn);
    this._newSeries();
    this._runoffPending = false;
    this._phase = { k: 'user_down' };
  }

  // ---- helpers -------------------------------------------------------------------------------

  /** Change of possession to the opponent at their own-frame `startYard`. */
  _handOver(startYard) {
    const st = this.state;
    st.possession = 'opp';
    st.ballOn = 100 - startYard;
    st.hashY = FIELD_MID_Y;
    this._runoffPending = false;
  }

  _newSeries() {
    const st = this.state;
    st.down = 1;
    st.toGo = round1(Math.min(10, 100 - st.ballOn));
    this._fourthChoice = null;
  }

  _fgEligible(fourthDecision) {
    const st = this.state;
    if (100 - st.ballOn + CFG.kicking.fgSnapOffset > this.fieldGoalRange() + 1e-9) return false;
    if (fourthDecision) return true;
    if (this._fourthChoice === 'go') return false;
    const windowQ = CFG.clock.fgWindowQuarters.includes(st.quarter) || st.quarter >= 5;
    return windowQ && st.clock <= CFG.clock.fgWindowSec && st.clock > 0;
  }

  _setup(kind, x) {
    const st = this.state;
    const losX = x.losX ?? st.ballOn + 10;
    let firstDownX = x.firstDownX;
    if (firstDownX == null) {
      const ltg = st.ballOn + st.toGo;
      firstDownX = ltg >= 100 - 1e-6 ? 110 : ltg + 10;
    }
    const step = this.settings.difficultyStep;
    return {
      kind,
      twoPoint: !!x.twoPoint,
      losX,
      firstDownX,
      hashY: x.hashY ?? st.hashY,
      down: x.down ?? st.down,
      offense: this.userSquad,
      defense: this.oppSquad,
      difficulty: stepToDifficulty(step),
      difficultyStep: step,
      wind: { x: st.wind.x, y: st.wind.y },
      seed: this.rng.int(1, 0x7ffffffe),
      clockLeft: st.clock,
      weather: st.weather,
      quarter: Math.min(st.quarter, 5),
      gameProgress: this._gameProgress(),
    };
  }

  _gameProgress() {
    const st = this.state;
    if (st.quarter >= 5) return 1;
    return clamp(((st.quarter - 1) * this.qlen + (this.qlen - st.clock)) / (4 * this.qlen), 0, 1);
  }

  _openDrive(team, how, start) {
    const st = this.state;
    if (this._drive && !this._drive.result) this._closeDrive('change');
    st.possession = team;
    this._drive = { team, how, quarter: st.quarter, clock: st.clock, start, plays: 0, yards: 0, points: 0, result: null, endQuarter: null, endClock: null };
    this.drives.push(this._drive);
  }

  _closeDrive(result) {
    const d = this._drive;
    if (!d || d.result) return;
    d.result = result;
    d.endQuarter = this.state.quarter;
    d.endClock = this.state.clock;
    this._drive = null;
    if (this._ot && this.state.quarter >= 5) this._ot.done[d.team] += 1;
  }

  _score(team, pts, kind, text, at) {
    const st = this.state;
    st.score[team] += pts;
    const quarter = at ? at.quarter : st.quarter;
    const clock = Math.max(0, Math.round(at ? at.clock : st.clock));
    this._box.byQuarter[team][Math.min(quarter, 5) - 1] += pts;
    const entry = { quarter, clock, team, text, kind, points: pts };
    st.log.push(entry);
    this._box.scoringPlays.push({ ...entry, userScore: st.score.user, oppScore: st.score.opp });
    for (let i = this.drives.length - 1; i >= 0; i--) {
      if (this.drives[i].team === team) {
        this.drives[i].points += pts;
        break;
      }
    }
  }

  _log(team, text, extra = {}) {
    const st = this.state;
    const { at, ...rest } = extra;
    st.log.push({ quarter: at ? at.quarter : st.quarter, clock: Math.max(0, Math.round(at ? at.clock : st.clock)), team, text, ...rest });
  }

  /** Sum numeric stat lines; keys ending in "Long" (e.g. fgLong) keep the maximum instead. */
  _addStats(id, s) {
    if (!id || id === 'null') return;
    const t = (this.state.stats[id] ||= {});
    for (const [k, v] of Object.entries(s)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      t[k] = /long$/i.test(k) ? Math.max(t[k] ?? v, v) : (t[k] || 0) + v;
    }
  }

  _mergeStats(r) {
    if (r.stats && typeof r.stats === 'object') {
      for (const [id, s] of Object.entries(r.stats)) if (s && typeof s === 'object') this._addStats(id, s);
    }
    if (Array.isArray(r.hits)) this._hits.push(...r.hits);
  }

  _tallyUser(r) {
    const b = this._box.user;
    b.plays += 1;
    const y = Number.isFinite(r.yards) ? r.yards : 0;
    if (r.type === 'pass') {
      if (r.outcome === 'sack') {
        b.sacked += 1;
        b.sackYds += -y;
        b.passYds += y;
      } else {
        b.passAtt += 1;
        if (r.outcome !== 'incomplete' && r.outcome !== 'interception') {
          b.passCmp += 1;
          b.passYds += y;
        }
      }
    } else if (r.type === 'run') {
      b.rushAtt += 1;
      b.rushYds += y;
    }
  }

  _rollWeather(snowEligible) {
    if (snowEligible && this.rng.chance(CFG.weather.snow)) return 'snow';
    return this.rng.chance(CFG.weather.rain) ? 'rain' : 'clear';
  }

  _rollWind() {
    const w = CFG.wind[this.settings.wind];
    if (!w || !this.rng.chance(w.p)) return { x: 0, y: 0 };
    const speed = this.rng.float(w.min, w.max);
    const a = this.rng.float(0, Math.PI * 2);
    return { x: speed * Math.cos(a), y: speed * Math.sin(a) };
  }

  /** Teams change ends every quarter: wind in the user's offense frame flips. */
  _applyWind() {
    const dir = this.state.quarter % 2 === 1 ? 1 : -1;
    this.state.wind = { x: round1(this._windStadium.x * dir) || 0, y: round1(this._windStadium.y * dir) || 0 };
  }

  _buildResult() {
    const st = this.state;
    const ot = !!this._ot;
    const b = this._box;
    const poss = (team) => this.drives.filter((d) => d.team === team).length;
    const byQ = (arr) => (ot ? arr.slice() : arr.slice(0, 4));
    return {
      gameId: this.gameId,
      userScore: st.score.user,
      oppScore: st.score.opp,
      ot,
      tie: st.score.user === st.score.opp,
      userWon: st.score.user > st.score.opp,
      playoff: this.playoff,
      stats: JSON.parse(JSON.stringify(st.stats)),
      hits: this._hits.slice(),
      log: st.log.map((e) => ({ ...e })),
      summary: {
        user: { ...b.user, points: st.score.user, totalYds: b.user.passYds + b.user.rushYds, possessions: poss('user'), top: Math.round(b.user.top) },
        opp: { ...b.opp, points: st.score.opp, totalYds: b.opp.passYds + b.opp.rushYds, possessions: poss('opp'), top: Math.round(b.opp.top) },
        byQuarter: { user: byQ(b.byQuarter.user), opp: byQ(b.byQuarter.opp) },
        scoringPlays: b.scoringPlays.map((e) => ({ ...e })),
        otPeriods: st.otPeriod,
        weather: st.weather,
        windMph: Math.round(Math.hypot(this._windStadium.x, this._windStadium.y)),
      },
    };
  }
}

// =============================================================================================
// Module helpers
// =============================================================================================

/** "3rd & 4", "1st & Goal", "4th & inches" for a state-like {down, toGo, ballOn}. */
export function downLabel(s) {
  const goal = s.ballOn + s.toGo >= 100 - 1e-6;
  let dist;
  if (goal) dist = 'Goal';
  else if (s.toGo < 0.5) dist = 'inches';
  else dist = String(Math.max(1, Math.round(s.toGo)));
  return `${ordinal(s.down)} & ${dist}`;
}

/** Snap the next spot between the hashes (ball outside them moves to the nearest hash). */
export function hashFrom(endY) {
  if (!Number.isFinite(endY)) return FIELD_MID_Y;
  return clamp(endY, HASH_Y[0], HASH_Y[1]);
}

/** User frame ballOn ↔ opponent frame (yards from the opponent's own goal). */
export const toOppFrame = (ballOn) => 100 - ballOn;
export const fromOppFrame = (oppYard) => 100 - oppYard;
/** User frame ballOn ↔ world x in the user's offense frame. */
export const ballOnToX = (ballOn) => ballOn + 10;
export const xToBallOn = (x) => x - 10;

function resolveKicker(k, squad) {
  const g = CFG.kicking.genericKicker;
  const r10 = (v) => clamp(v, 1, 10);
  const from01 = (v) => 1 + 9 * clamp(v, 0, 1);
  if (k && Number.isFinite(k.range)) {
    return { id: k.id ?? null, range: r10(k.range), accuracy: r10(Number.isFinite(k.accuracy) ? k.accuracy : k.range) };
  }
  const K = k && Number.isFinite(k.kickPower) ? k : squad?.offense?.K;
  if (K && Number.isFinite(K.kickPower)) {
    return { id: K.id ?? null, range: from01(K.kickPower), accuracy: from01(Number.isFinite(K.kickAccuracy) ? K.kickAccuracy : K.kickPower) };
  }
  return { ...g };
}

function squadKickerRating(squad) {
  const K = squad?.offense?.K;
  if (!K || !Number.isFinite(K.kickPower)) return null;
  return clamp(((K.kickPower ?? 0.5) + (K.kickAccuracy ?? 0.5)) / 2, 0, 1);
}

function tdText(abbr, r) {
  const n = Math.max(1, Math.round(Math.abs(r.yards || 0)));
  const kind = r.type === 'pass' ? 'pass' : r.type === 'return' ? 'return' : 'run';
  return `TD ${abbr} — ${n}-yard ${kind}`;
}

/** Fill missing PlayResult fields defensively so the state machine never sees NaN. */
function normalizeResult(res, setup) {
  const r = { ...res };
  const losX = setup?.losX ?? 35;
  if (!Number.isFinite(r.endX)) r.endX = Number.isFinite(r.yards) ? losX + r.yards : losX;
  if (!Number.isFinite(r.endY)) r.endY = setup?.hashY ?? FIELD_MID_Y;
  if (!Number.isFinite(r.yards)) r.yards = r.endX - losX;
  if (!Number.isFinite(r.elapsed)) r.elapsed = 0;
  if (typeof r.turnover !== 'boolean') r.turnover = r.outcome === 'interception';
  if (r.outcome === 'interception') r.turnover = true;
  if (typeof r.clockStops !== 'boolean') {
    r.clockStops = ['incomplete', 'oob', 'td', 'interception', 'safety', 'fg_good', 'fg_miss', 'pat_good', 'pat_miss', 'kick_blocked', 'touchback', 'return_td'].includes(r.outcome) || r.turnover;
  }
  return r;
}
