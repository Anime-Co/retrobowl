// MatchScreen ('match'): drives one user game through the Match state machine (src/match/logic),
// shows each live play in a PlayView (src/play/view, PLAY-VIEW contract) and owns the HUD in
// app.hudEl (src/match/hud.js). See docs/ARCHITECTURE.md "MATCH-SCREEN contract".
//
// Params: {gameId, autoplay?:boolean, autoDecisions?:boolean, stub?:boolean, speed?:number}
//   gameId         the user's game this week (must match franchise matchSetup(save).gameId)
//   autoplay       QA: a SimBot plays every down, overlays advance quickly, decisions are picked
//   autoDecisions  autoplay only: false leaves decisions / the final Continue to the user (tests)
//   stub           force the dev PlayView stand-in (src/match/devPlayStub.js) instead of the real one
//   speed          autoplay only: simulation steps per frame (1–16), for fast end-to-end runs
//
// Step loop: m.next() → present(step) → resolve with ack()/choose()/submitPlay(). For play steps
// the view's result is submitted at the whistle and the next step is fetched right away, so a
// running clock keeps running through the post-play beat until the next snap (MECHANICS §5.1).
// Mid-game state is never persisted: quitting leaves the game unplayed.
//
// Testing hooks: window.__match is the active screen (mode, step, m, view, paused). Set `freeze`
// to stop ticking (screenshots), `holdSnap` (boolean or (m, step) => boolean) to keep the autoplay
// bot from snapping, and `qaOnStep(step)` to be called whenever a step is presented.

import * as F from '../franchise/index.js';
import { Match, downLabel, timeoutsPerHalf } from './logic/index.js';
import { fmtClock, yardLabel, clamp } from '../core/util.js';
import { SimBot } from '../play/sim/bot.js';
import { MatchHud, decisionModal, pauseMenu, lookOf } from './hud.js';
import { StubPlayView, StubIdleFieldView } from './devPlayStub.js';
import { Autopilot } from './autopilot.js';

const STUB = { PlayView: StubPlayView, IdleFieldView: StubIdleFieldView, real: false };
let realViews = null;

/**
 * Resolve the PlayView implementation: the real one from src/play/view/PlayView.js when it
 * exists and loads, else the dev stub. Cached per page load.
 */
export function loadPlayViews(forceStub = false) {
  if (forceStub) return Promise.resolve(STUB);
  if (!realViews) {
    realViews = import('../play/view/PlayView.js')
      .then((mod) => (mod && typeof mod.PlayView === 'function'
        ? { PlayView: mod.PlayView, IdleFieldView: typeof mod.IdleFieldView === 'function' ? mod.IdleFieldView : StubIdleFieldView, real: true }
        : STUB))
      .catch(() => STUB);
  }
  return realViews;
}

const BEAT_SEC = 1.25; // opponent-drive text box (MECHANICS §5.3: ~1.2 s, tap to speed up)
const BANNER_SEC = { coin: 2.2, quarter_end: 2.0, halftime: 2.6, ot_start: 2.6, auto: 2.8 };
const AUTO_TITLES = {
  punt: 'PUNT',
  safety: 'SAFETY',
  defensive_td: 'DEFENSIVE TD',
};

const qLabel = (q) => (q <= 4 ? `Q${q}` : q === 5 ? 'OT' : `OT${q - 4}`);

export class MatchScreen {
  constructor(app, params = {}) {
    this.app = app;
    this.params = params;
    this.gameId = params.gameId;
    this.autoplay = !!params.autoplay;
    this.autoDecisions = this.autoplay && params.autoDecisions !== false;
    this.qaOnStep = null;
    this.speed = this.autoplay ? clamp(Math.round(params.speed || 1), 1, 16) : 1;
    this.mode = 'loading';
    this.ready = false;
    this.dead = false;
    this.paused = false;
    this.freeze = false;
    this.holdSnap = false;
    this.step = null;
    this.view = null;
    this.idle = null;
    this.idleKey = null;
    this.modal = null;
    this.menu = null;
    this.stepT = 0;
  }

  // ===========================================================================================
  // Lifecycle
  // ===========================================================================================

  mount() {
    const app = this.app;
    const save = app.save;
    const setup = save ? F.matchSetup(save) : null;
    if (!setup || (this.gameId && setup.gameId !== this.gameId)) {
      setTimeout(() => app.go(save ? 'hub' : 'title'), 0);
      this.dead = true;
      return;
    }
    this.gameId = setup.gameId;
    this.setup = setup;
    const s = app.settings;
    const mode = F.difficultyInfo(save).mode;
    this.m = new Match({
      ...setup,
      settings: { quarterMinutes: s.quarterMinutes, difficultyStep: setup.difficultyStep, wind: s.wind, easyOtFirst: mode === 'easy' },
    });
    this.userLook = lookOf(setup.userTeam, setup.userSquad);
    this.oppLook = lookOf(setup.oppTeam, setup.oppSquad);
    this.pilot = new Autopilot((setup.seed ^ 0x9e3779b9) >>> 0);

    app.showStage(true);
    this.hud = new MatchHud(app.hudEl, {
      userLook: this.userLook,
      oppLook: this.oppLook,
      onTimeout: () => this.tryTimeout(),
      onChangePlay: () => this.changePlay(),
      onFieldGoal: () => this.kickFieldGoal(),
      onPause: () => this.pause(),
    });
    this.hud.setLoading(true);
    this.syncHud();
    // HUD-covered stage edges for the PlayView (one live object: refreshed on resize / rotation)
    this.insets = this.hud.insets();
    this.offResize = app.display.onResize(() => {
      if (this.hud && !this.dead) Object.assign(this.insets, this.hud.insets());
    });

    this.onKey = (e) => this.handleKey(e);
    this.onVis = () => { if (document.hidden) this.pause(true); };
    this.onBlur = () => this.pause(true);
    window.addEventListener('keydown', this.onKey);
    document.addEventListener('visibilitychange', this.onVis);
    window.addEventListener('blur', this.onBlur);
    window.__match = this;

    app.audio.startCrowd();
    loadPlayViews(!!this.params.stub).then((views) => {
      if (this.dead) return;
      this.views = views;
      this.ready = true;
      this.hud.setLoading(false);
      this.advance();
    });
  }

  unmount() {
    this.dead = true;
    this.endView();
    this.dropIdle();
    this.closeModal();
    this.closeMenu();
    if (this.offResize) this.offResize();
    if (this.hud) this.hud.destroy();
    if (this.onKey) window.removeEventListener('keydown', this.onKey);
    if (this.onVis) document.removeEventListener('visibilitychange', this.onVis);
    if (this.onBlur) window.removeEventListener('blur', this.onBlur);
    this.app.audio.stopCrowd();
    if (window.__match === this) window.__match = null;
  }

  update(dt) {
    if (!this.ready || this.dead) return;
    const start = this.app.input.isDown('PadStart'); // gamepad Start toggles the pause menu
    if (start && !this._padStart) {
      if (this.paused) this.resume();
      else this.pause();
    }
    this._padStart = start;
    if (this.paused || this.freeze) {
      if (this.view) {
        this.view.paused = true;
        this.view.update(dt);
      }
      return;
    }
    for (let i = 0; i < this.speed && !this.dead && !this.paused; i++) this.tick(dt);
    if (!this.dead) this.syncHud();
  }

  render(alpha) {
    if (this.dead) return;
    if (this.view) this.view.render(alpha);
    else if (this.idle) this.idle.render(alpha);
    else {
      const d = this.app.display;
      d.begin('#0e2a17');
      d.present();
    }
  }

  // ===========================================================================================
  // Step presentation
  // ===========================================================================================

  advance() {
    if (this.dead) return;
    this.present(this.m.next());
  }

  present(step) {
    if (this.dead) return;
    this.step = step;
    this.stepT = 0;
    if (step.type !== 'quarter_end') this.carryBug = null;
    this.hud.hideAll();
    this.hud.setDim(false);
    this.app.input.reset();
    switch (step.type) {
      case 'play':
      case 'kick':
      case 'kick_return':
        this.presentPlay(step);
        break;
      case 'decision':
        this.presentDecision(step);
        break;
      case 'opp_drive':
        this.presentOppDrive(step);
        break;
      case 'final':
        this.presentFinal(step);
        break;
      default:
        this.presentBanner(step);
    }
    this.hud.setMode(this.mode);
    this.syncHud();
    if (this.qaOnStep) {
      try { this.qaOnStep(step); } catch (e) { console.error(e); }
    }
  }

  /** Spot (world x, user frame) the idle field shows for the current state. */
  stateLosX() {
    return clamp(this.m.state.ballOn, 1, 99) + 10;
  }

  driveLeft() {
    const dir = this.app.settings.driveDirection;
    if (dir === 'left') return true;
    if (dir === 'alternate') return this.m.state.half === 2; // flips at halftime (OT back to the 1st-half end)
    return false;
  }

  /** Idle field behind non-play steps; `offense` 'opp' lines the opponent up on offense. */
  ensureIdle(losX, offense = 'user') {
    const x = Math.round(losX * 2) / 2;
    const left = this.driveLeft();
    const key = `${x}|${offense}|${left}`;
    if (this.idle && this.idleKey === key) return;
    this.dropIdle();
    const Idle = this.views.IdleFieldView;
    const opts = { losX: x, offense, userLook: this.userLook, oppLook: this.oppLook, driveLeft: left, keepCrowd: true };
    try {
      this.idle = new Idle(this.app, opts);
    } catch (e) {
      console.warn('IdleFieldView failed, using the stub', e);
      this.idle = new StubIdleFieldView(this.app, opts);
    }
    this.idleKey = key;
  }

  dropIdle() {
    if (this.idle && this.idle.destroy) this.idle.destroy();
    this.idle = null;
    this.idleKey = null;
  }

  // ---- live plays ---------------------------------------------------------------------------

  presentPlay(step) {
    this.mode = 'play';
    this.endView();
    this.dropIdle();
    this.snapped = false;
    this.submitted = false;
    this.nextStep = null;
    this.autoPre = false;
    this.viewStep = step;
    const opts = {
      setup: step.setup,
      userLook: this.userLook,
      oppLook: this.oppLook,
      driveLeft: this.driveLeft(),
      onSnap: () => this.handleSnap(step),
      // PlayView extras (ignored by other implementations): keep canvas UI clear of the HUD,
      // the screen owns the crowd bed, autoplay shortens the post-play beat
      insets: Object.assign(this.insets, this.hud.insets()),
      keepCrowd: true,
      ...(this.autoplay ? { beat: 0.6 } : {}),
    };
    try {
      this.view = new this.views.PlayView(this.app, opts);
    } catch (e) {
      console.warn('PlayView failed, using the dev stub', e);
      this.view = new StubPlayView(this.app, opts);
    }
    if (this.view.isStub && !this.autoplay) this.view.selfDrive = true;
    this.bot = this.autoplay ? new SimBot({ seed: ((step.setup.seed >>> 0) ^ 0x5bd1e995) >>> 0, skill: 0.62 }) : null;
    if (step.type === 'kick_return') this.app.sfx('whistle');
  }

  handleSnap(step) {
    if (this.snapped || this.dead || step !== this.viewStep || this.submitted) return;
    this.snapped = true;
    this.m.onSnap();
  }

  endView() {
    if (this.view) {
      try { this.view.destroy(); } catch (e) { console.error(e); }
    }
    this.view = null;
    this.bot = null;
  }

  /** The play view is up for its own (still pending) step and the ball is not snapped yet. */
  presnap() {
    const v = this.view;
    return this.mode === 'play' && !!v && !this.submitted && !this.snapped && !!v.sim && v.sim.phase === 'presnap';
  }

  tickPlay(dt) {
    const m = this.m;
    const v = this.view;
    if (!v) return;
    v.paused = false;
    if (this.autoplay && this.presnap() && this.step.type === 'play') {
      if (!this.autoPre) {
        this.autoPre = true;
        const act = this.pilot.presnap(m, this.step);
        if (act.timeout && m.canCallTimeout()) this.tryTimeout();
        if (act.audible) this.changePlay();
      }
      if (this.autoDecisions && m.fieldGoalAvailable() && this.pilot.wantsFieldGoal(m)) {
        this.kickFieldGoal();
        return;
      }
    }
    if (this.bot && !v.result && !(v.sim.phase === 'presnap' && this.holding())) this.bot.step(v.sim, dt);
    v.update(dt);
    if (this.dead || this.view !== v) return;
    if (!this.snapped && !this.submitted && v.sim && v.sim.phase !== 'presnap') this.handleSnap(this.viewStep);

    if (this.m.state.clockRunning && m.tickClock(dt)) {
      if (!this.submitted) {
        // the clock ran out before the snap: the pending play was withdrawn
        this.endView();
        this.app.sfx('buzzer');
        this.hud.flash('TIME!');
        this.advance();
        return;
      }
      this.nextStep = null; // the early-fetched step was withdrawn during the post-play beat
    }

    if (!this.submitted && v.result) {
      this.submitted = true;
      const before = { ...m.state.score };
      m.submitPlay(v.result);
      this.afterPlay(v.result, before);
      this.nextStep = m.next();
    }
    if (v.done) {
      if (!this.submitted) return; // a view must never finish without a result
      this.endView();
      this.present(this.nextStep || m.next());
    }
  }

  /** QA: hold the autoplay snap (holdSnap may be a predicate on the match). */
  holding() {
    const h = this.holdSnap;
    if (typeof h === 'function') {
      try { return !!h(this.m, this.step); } catch { return false; }
    }
    return !!h;
  }

  afterPlay(r, before) {
    const st = this.m.state;
    if (st.score.user > before.user) this.app.audio.cheer(1, 2.5);
    if (r.turnover) this.app.vibrate(40);
  }

  kickFieldGoal() {
    if (!this.presnap() || this.step.type !== 'play' || this.paused) return false;
    if (!this.m.choose('fg')) return false;
    this.app.sfx('select');
    this.endView();
    this.advance();
    return true;
  }

  changePlay() {
    if (this.paused || !this.presnap() || this.step.type !== 'play') return false;
    if (!this.m.useAudible()) return false;
    this.view.changePlay();
    this.app.sfx('select');
    return true;
  }

  tryTimeout() {
    if (this.paused || this.dead) return false;
    if (!this.m.canCallTimeout() || !this.m.callTimeout()) {
      if (this.m.state.possession === 'user' && this.mode === 'play' && this.m.state.timeouts.user <= 0) this.hud.flash('NO TIMEOUTS LEFT', 1000);
      return false;
    }
    this.app.sfx('whistle');
    this.app.vibrate(25);
    this.hud.flash(`TIMEOUT · ${this.m.state.timeouts.user} LEFT`);
    this.syncHud();
    return true;
  }

  // ---- decisions ----------------------------------------------------------------------------

  presentDecision(step) {
    this.mode = 'decision';
    this.endView();
    this.ensureIdle(this.stateLosX());
    this.openDecision(step);
  }

  openDecision(step) {
    this.closeModal();
    const m = this.m;
    const st = m.state;
    let title = 'DECISION';
    let sub = '';
    let options = step.options;
    if (step.kind === 'fourth') {
      title = `${downLabel(st).toUpperCase()} · ${yardLabel(st.ballOn)}`;
      sub = 'Fourth down. What is the call?';
      options = step.options.map((o) => (o.id === 'fg' ? { ...o, detail: `${step.fgDistance} yd attempt · kicker range ${step.fgRange} yd` } : o));
    } else if (step.kind === 'conversion') {
      title = 'TOUCHDOWN! THE TRY';
      sub = `${this.userLook.abbr} ${st.score.user} – ${st.score.opp} ${this.oppLook.abbr}`;
    } else if (step.kind === 'onside') {
      const pct = Math.round((step.chance || 0) * 100);
      title = 'ONSIDE KICK?';
      sub = `Down ${st.score.opp - st.score.user} with ${fmtClock(st.clock)} left in the 4th.`;
      options = step.options.map((o) => (o.id === 'onside' ? { ...o, label: `ONSIDE (${pct}%)` } : o));
    }
    const timeout = step.kind === 'fourth' && m.canCallTimeout()
      ? { left: st.timeouts.user, onCall: () => this.tryTimeout() }
      : null;
    this.modal = decisionModal(this.app.uiRoot, { title, sub, options, timeout, onChoose: (id) => this.choose(id) });
  }

  choose(id) {
    if (this.dead || this.paused || this.mode !== 'decision') return false;
    if (!this.m.choose(id)) return false;
    this.app.sfx('select');
    this.closeModal();
    this.advance();
    return true;
  }

  closeModal() {
    if (this.modal) this.modal.close();
    this.modal = null;
  }

  // ---- opponent drives ----------------------------------------------------------------------

  presentOppDrive(step) {
    this.mode = 'opp_drive';
    this.endView();
    this.ensureIdle(110 - step.startYard, 'opp');
    this.hud.setDim(true);
    this.beatIdx = -1;
    this.beatT = 0;
    this.beat = null;
    this.nextBeat();
  }

  beatDuration(b) {
    if (this.autoplay) return 0.12;
    const len = (b.text || '').length;
    return BEAT_SEC + Math.max(0, len - 42) * 0.02 + (b.kind === 'result' ? 0.35 : 0);
  }

  nextBeat() {
    const step = this.step;
    this.beatIdx += 1;
    this.beatT = 0;
    if (this.beatIdx >= step.beats.length) {
      this.hud.hideBox();
      // a drive that ran into the next quarter: keep its clock on the bug through "END OF Qn"
      const last = this.beat;
      this.carryBug = last && last.quarterAfter > this.m.state.quarter ? { quarter: last.quarterAfter, clock: last.clockAfter } : null;
      this.m.ack();
      this.advance();
      return;
    }
    const b = step.beats[this.beatIdx];
    this.beat = b;
    let tone = '';
    if (b.kind === 'result') {
      const bad = step.outcome === 'td' || step.outcome === 'fg';
      tone = bad ? 'bad' : 'good';
      this.app.sfx(bad ? 'bad' : 'good');
      if (!bad && (step.outcome === 'int' || step.outcome === 'fumble')) this.app.vibrate(30);
    }
    this.hud.showBox({ head: `${this.oppLook.abbr} DRIVE`, text: b.text, index: this.beatIdx, count: step.beats.length, kind: b.kind, unskippable: !!b.unskippable, tone });
  }

  tickOppDrive(dt, pressed) {
    this.beatT += dt;
    const b = this.beat;
    if (!b) return;
    const dur = this.beatDuration(b);
    if (this.beatT >= dur || (pressed && !b.unskippable && this.beatT > 0.18)) this.nextBeat();
  }

  // ---- banners ------------------------------------------------------------------------------

  presentBanner(step) {
    this.mode = 'banner';
    this.endView();
    const st = this.m.state;
    const u = this.userLook.abbr;
    const o = this.oppLook.abbr;
    const score = (sc) => `${u} ${sc.user} – ${sc.opp} ${o}`;
    let banner;
    switch (step.type) {
      case 'coin': {
        const lines = [];
        if (st.weather !== 'clear') lines.push(st.weather === 'snow' ? 'SNOW ON THE FIELD' : 'RAIN TODAY');
        const wind = Math.round(Math.hypot(st.wind.x, st.wind.y));
        if (wind >= 1) lines.push(`WIND ${wind} MPH`);
        this.openingUserReceives = !!step.userReceives;
        banner = { title: 'COIN TOSS', sub: step.userReceives ? 'YOU RECEIVE' : `${o} RECEIVE`, lines, tone: 'neutral' };
        this.app.sfx('coin');
        break;
      }
      case 'quarter_end':
        banner = { title: `END OF Q${step.quarter}`, sub: score(step.score) };
        this.app.sfx('whistle');
        break;
      case 'halftime':
        banner = { title: 'HALFTIME', sub: score(step.score), lines: [this.openingUserReceives ? `${o} RECEIVE` : 'YOU RECEIVE'] };
        this.app.sfx('buzzer');
        break;
      case 'ot_start':
        banner = { title: step.period > 1 ? `OVERTIME ${step.period}` : 'OVERTIME', sub: score(step.score), lines: [step.userReceives ? 'YOU RECEIVE' : `${o} RECEIVE`] };
        this.app.sfx('whistle');
        break;
      case 'auto': {
        let title = AUTO_TITLES[step.kind] || 'NOTICE';
        let tone = 'neutral';
        if (step.kind === 'onside') {
          title = step.success ? 'RECOVERED!' : 'ONSIDE FAILS';
          tone = step.success ? 'good' : 'bad';
        } else if (step.kind === 'safety' || step.kind === 'defensive_td') tone = 'bad';
        banner = { title, sub: step.text, tone };
        this.app.sfx(tone === 'good' ? 'good' : tone === 'bad' ? 'bad' : 'kick');
        break;
      }
      default:
        banner = { title: String(step.type).toUpperCase() };
    }
    banner.hint = 'TAP ▸';
    this.hud.showBanner(banner);
    const neutral = step.type === 'coin' || step.type === 'halftime' || step.type === 'ot_start';
    this.ensureIdle(neutral ? 60 : this.stateLosX(), !neutral && st.possession === 'opp' ? 'opp' : 'user');
    this.hud.setDim(true);
    this.mode = 'banner';
  }

  tickBanner(dt, pressed) {
    const dur = this.autoplay ? 0.2 : BANNER_SEC[this.step.type] || 2.2;
    if (this.stepT >= dur || (pressed && this.stepT > 0.3)) {
      this.hud.hideBanner();
      this.m.ack();
      this.advance();
    }
  }

  // ---- final --------------------------------------------------------------------------------

  presentFinal(step) {
    this.mode = 'final';
    this.endView();
    this.closeModal();
    this.closeMenu();
    this.paused = false;
    this.ensureIdle(60);
    this.hud.setDim(true);
    const r = step.result;
    this.result = r;
    let summary = null;
    try {
      summary = F.applyUserGameResult(this.app.save, r);
      this.app.persist();
    } catch (e) {
      console.warn('applyUserGameResult failed', e);
    }
    this.summary = summary;
    const verdict = r.userWon ? (summary?.champion ? 'CHAMPIONS!' : 'VICTORY') : r.tie ? 'TIE GAME' : 'DEFEAT';
    const tone = r.userWon ? 'good' : r.tie ? 'neutral' : 'bad';
    this.app.sfx('buzzer');
    if (r.userWon) this.app.audio.cheer(1, 3);
    this.hud.showFinal({ userScore: r.userScore, oppScore: r.oppScore, ot: r.ot, verdict, tone }, () => this.finish());
  }

  finish() {
    if (this.finished || this.dead) return;
    this.finished = true;
    const app = this.app;
    if (!this.summary) {
      app.go(app.save ? 'hub' : 'title');
      return;
    }
    app.go('postGame', { gameId: this.gameId, result: this.result, summary: this.summary });
  }

  // ===========================================================================================
  // Per-step tick
  // ===========================================================================================

  tick(dt) {
    this.stepT += dt;
    if (this.mode === 'play') {
      this.tickPlay(dt);
      return;
    }
    // Outside live plays the screen owns the stage input: taps / Space / Enter advance.
    const evs = this.app.input.poll();
    const pressed = evs.some((e) => e.type === 'tap' || (e.type === 'key' && e.down && !e.repeat && (e.code === 'Space' || e.code === 'Enter')));
    if (this.idle) this.idle.update(dt);
    switch (this.mode) {
      case 'decision':
        if (this.autoDecisions && this.stepT >= 0.3) this.choose(this.pilot.decide(this.m, this.step));
        break;
      case 'opp_drive':
        this.tickOppDrive(dt, pressed);
        break;
      case 'banner':
        this.tickBanner(dt, pressed);
        break;
      case 'final':
        if (this.autoDecisions && this.stepT >= 0.6) this.finish();
        break;
      default:
        break;
    }
  }

  // ===========================================================================================
  // HUD
  // ===========================================================================================

  situationText() {
    const m = this.m;
    const st = m.state;
    const o = this.oppLook.abbr;
    const s = this.mode === 'play' && this.submitted && this.nextStep ? this.nextStep : this.step;
    if (!s) return '';
    switch (s.type) {
      case 'kick_return': return 'KICKOFF · RETURN';
      case 'kick': return s.kind === 'pat' ? 'EXTRA POINT' : `FIELD GOAL · ${s.distance} YD`;
      case 'play':
        if (s.twoPoint) return '2-PT TRY';
        return `${downLabel(st).toUpperCase()} · ${yardLabel(st.ballOn)}`;
      case 'decision':
        if (s.kind === 'fourth') return `${downLabel(st).toUpperCase()} · ${yardLabel(st.ballOn)}`;
        if (s.kind === 'conversion') return 'TOUCHDOWN';
        return 'KICKOFF';
      case 'opp_drive': return `${o} BALL`;
      case 'coin': return 'COIN TOSS';
      case 'quarter_end': return `END OF Q${s.quarter}`;
      case 'halftime': return 'HALFTIME';
      case 'ot_start': return 'OVERTIME';
      case 'final': return 'FINAL';
      case 'auto': return s.kind === 'punt' ? 'PUNT' : s.kind === 'onside' ? 'ONSIDE KICK' : AUTO_TITLES[s.kind] || '';
      default: return '';
    }
  }

  syncHud() {
    const hud = this.hud;
    const m = this.m;
    if (!hud || !m) return;
    const st = m.state;
    let score = st.score;
    let clock = st.clock;
    let quarter = st.quarter;
    if (this.mode === 'opp_drive' && this.beat) {
      score = this.beat.scoreAfter;
      clock = this.beat.clockAfter;
      quarter = this.beat.quarterAfter;
    } else if (this.carryBug && this.step && this.step.type === 'quarter_end') {
      clock = this.carryBug.clock;
      quarter = this.carryBug.quarter;
    }
    const live = this.mode === 'play' || this.mode === 'decision';
    const canTimeout = live && !this.paused && m.canCallTimeout();
    hud.setBug({
      userScore: score.user,
      oppScore: score.opp,
      quarter: qLabel(quarter),
      clock: fmtClock(clock),
      timeouts: st.timeouts.user,
      timeoutsMax: timeoutsPerHalf(st.quarterMinutes),
      canTimeout,
      possession: this.mode === 'final' ? null : st.possession,
      running: !!st.clockRunning,
      sit: this.ready ? this.situationText() : '',
    });
    const pre = this.presnap() && this.step.type === 'play';
    hud.setChangePlay({ visible: pre, left: st.audiblesLeft });
    hud.setFieldGoal({ visible: pre && m.fieldGoalAvailable(), distance: m.fieldGoalDistance() });
    hud.setPauseVisible(this.mode !== 'final');
    hud.setMode(this.mode);
  }

  // ===========================================================================================
  // Pause / keyboard
  // ===========================================================================================

  pause(auto = false) {
    if (this.paused || this.dead || this.mode === 'final' || !this.m) return;
    if (auto && this.autoplay) return; // QA runs keep going in background tabs
    this.paused = true;
    if (this.view) this.view.paused = true;
    const st = this.m.state;
    const s = this.app.settings;
    this.menu = pauseMenu(this.app.uiRoot, {
      scoreLine: `${this.userLook.abbr} ${st.score.user} – ${st.score.opp} ${this.oppLook.abbr} · ${qLabel(st.quarter)} ${fmtClock(st.clock)}`,
      settings: { sound: !!s.sound, vibration: !!s.vibration },
      onResume: () => this.resume(),
      onToggle: (key, value) => {
        this.app.updateSettings({ [key]: value });
        if (key === 'sound' && value) this.app.audio.startCrowd();
      },
      onQuit: () => this.quit(),
    });
    this.syncHud();
  }

  resume() {
    if (!this.paused) return;
    this.closeMenu();
    this.paused = false;
    if (this.view) this.view.paused = false;
    this.app.input.reset();
    this.syncHud();
  }

  closeMenu() {
    if (this.menu) this.menu.close();
    this.menu = null;
  }

  quit() {
    if (this.dead) return;
    this.app.sfx('back');
    this.app.go('hub');
  }

  handleKey(e) {
    if (this.dead || !this.ready || e.ctrlKey || e.metaKey || e.altKey) return;
    const code = e.code;
    if (code === 'Escape' || code === 'KeyP') {
      if (e.repeat) return;
      e.preventDefault();
      if (this.paused) {
        if (this.menu && this.menu.confirming()) this.menu.back();
        else this.resume();
      } else this.pause();
      return;
    }
    if (this.paused || e.repeat) return;
    if (code === 'KeyT') {
      e.preventDefault();
      if (this.tryTimeout() && this.mode === 'decision' && this.step) this.openDecision(this.step); // refresh the timeout row
    } else if (code === 'KeyC') {
      e.preventDefault();
      this.changePlay();
    } else if (this.mode === 'decision' && /^Digit[1-9]$/.test(code)) {
      const opt = this.step.options[Number(code.slice(5)) - 1];
      if (opt) {
        e.preventDefault();
        this.choose(opt.id);
      }
    }
  }
}
