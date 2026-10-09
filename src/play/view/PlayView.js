// PlayView: everything drawn on the canvas for ONE play plus all on-field input (contract in
// docs/ARCHITECTURE.md "PLAY-VIEW contract"). Wraps a PlaySim; the Controller turns gestures /
// keys into sim commands; this module renders field, players, ball, overlays (routes, RB ring,
// aim arc, kick meter, wind), fx, banners and first-play tips, drives the camera and plays the
// on-field SFX / haptics from sim events.
//
//   const view = new PlayView(app, { setup, userLook, oppLook, driveLeft, onSnap });
//   view.update(dt); view.render(alpha); view.result; view.done; view.destroy();
//
// IdleFieldView (same module) draws the field with both teams lined up at a spot (opponent-drive
// text boxes, between steps).

import { PlaySim } from '../sim/PlaySim.js';
import { Camera, FIELD_W } from '../../render/camera.js';
import { FieldRenderer, FIELD_COLORS } from '../../render/field.js';
import { drawPlayer, drawBall, drawRing, fieldKit, prewarmSprites } from '../../render/sprites.js';
import { measureText } from '../../render/font.js';
import { Fx } from '../../render/fx.js';
import { readJSON, writeJSON } from '../../core/storage.js';
import { Controller } from './controller.js';
import {
  INK, dotPath, pathArrow, blockMarker, landingMarker, vMeter, hMeter, windIcon, banner, tipBox, tipSize, tagAbove, pixLine,
  arrowHead,
} from './overlay.js';

const W = FIELD_W;
const FIELD_LEN_X = 120;

/** Presentation tuning (camera framing, beats, colours). */
export const VIEW = {
  nearCross: { landscape: 34, portrait: 44 }, // cross-field yards that fit the short side at Near
  farMult: 0.78, // ppy multiplier for the Far camera
  presnapBack: { landscape: 13, portrait: 21 }, // yards visible behind the LOS before the snap
  carryLead: 0.36, // the ball carrier sits this far (fraction of the view) from the back edge
  dropbackLead: { landscape: 0.24, portrait: 0.15 }, // portrait's long view needs less room behind the QB
  kickLead: 0.2,
  kickSpotMin: 54, // farthest FG spot (66 yd): the one wider field-goal framing fits it (pre-rendered)
  crossMargin: 2.5, // yd kept between framed players / the aim target and the screen (HUD) edge
  arcLean: 0.6, // screen px per px of lob height leaned sideways when a throw runs up/down the screen
  leanFlip: 0.15, // |screen dx| of the throw direction that flips the lean side (hysteresis)
  buzzGapMs: 110, // min gap between small haptic pulses (big hits / scores always buzz)
  beat: 1.4, // post-play beat (s) before view.done
  beatBig: 1.9, // ... after a TD / turnover / made kick
  routeFade: 1.0, // s after the snap over which the pre-snap route lines fade
  routeGrow: 0.35, // s for route lines to draw in (play start / audible)
  tipsMax: 3, // successes before a control tip stops showing
  bigHit: 8.5, // closing speed (yd/s) of a "big hit" (shake + strong haptic)
  routeColors: { WR1: '#ffa94d', WR2: '#ff8fd8', TE2: '#b9a2ff', RB: '#9fd3ff' },
  laneColor: '#4aa3ff',
  ringColor: '#4aa3ff',
  arcColor: '#ffffff',
  bulletColor: '#ff7a3d',
};

const DEFAULT_USER = { abbr: 'YOU', city: 'Home', primary: '#1952b8', secondary: '#fdd835', helmet: '#1952b8' };
const DEFAULT_OPP = { abbr: 'OPP', city: 'Away', primary: '#c62828', secondary: '#f0f0f0', helmet: '#c62828' };
const TIPS_KEY = 'playTips';
const TURF = [FIELD_COLORS.turfA, FIELD_COLORS.turfB];

// HUD insets of the most recent play view (MatchScreen passes one live object), so idle views
// (drives, decisions) pre-warm the same field-goal framing the next kick will use
let lastPlayInsets = null;

// one MediaQueryList for "is this a touch device?" (matchMedia() per frame forces style work)
let coarseMq;
function coarsePointer() {
  try {
    if (coarseMq === undefined) coarseMq = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : null;
    return !!(coarseMq && coarseMq.matches);
  } catch {
    return false;
  }
}

// on-field kits, memoised so consecutive plays share one look object (and its sprite cache)
const kitCache = new Map();
function kitFor(look, other) {
  const key = `${look.primary}|${look.secondary}|${look.helmet}|${other ? other.primary : ''}`;
  let k = kitCache.get(key);
  if (!k) {
    k = fieldKit(look, TURF, other);
    if (kitCache.size > 64) kitCache.clear();
    kitCache.set(key, k);
  }
  return k;
}

// one pre-rendered field per app (so consecutive plays don't rebuild it)
const fieldCache = new WeakMap();
function sharedField(app) {
  let f = fieldCache.get(app);
  if (!f) {
    f = new FieldRenderer();
    fieldCache.set(app, f);
  }
  return f;
}

const P = { x: 0, y: 0 };
const Q = { x: 0, y: 0 };

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const skinOf = (e) => ((e.number | 0) * 7 + (e.side === 'def' ? 3 : 0) + (e.id ? e.id.length : 0)) % 5;

// ---------------------------------------------------------------------------------------------
// Shared base: camera viewport (orientation, mirror, zoom), field, fx

class FieldScene {
  constructor(app, o = {}) {
    this.app = app;
    this.opts = o;
    this.userLook = { ...DEFAULT_USER, ...(o.userLook || {}) };
    this.oppLook = { ...DEFAULT_OPP, ...(o.oppLook || {}) };
    // player sprites wear on-field kits: no jersey that melts into the turf, no two look-alike sides
    this.userKit = kitFor(this.userLook, null);
    this.oppKit = kitFor(this.oppLook, this.userKit);
    this.driveLeft = !!o.driveLeft;
    this.camera = new Camera();
    this.field = sharedField(app);
    this.fx = new Fx();
    this.time = 0;
    this.screenFwd = { x: 1, y: 0 };
    this.screenLat = { x: 0, y: 1 };
    this.dim = o.dim || 0;
    this._crowd = false;
  }

  /** Camera viewport from app.display (every frame: survives resizes / rotation mid-play). */
  _viewport() {
    const d = this.app.display;
    const cam = this.camera;
    const land = d.orientation === 'landscape';
    cam.mirror = land && this.driveLeft;
    const zoom = this.opts.zoom || (this.app.settings && this.app.settings.cameraZoom) || 'near';
    cam.fitCross = VIEW.nearCross[d.orientation] || 36;
    cam.zoom = zoom === 'far' ? VIEW.farMult : 1;
    const cap = this._ppyCap(d);
    if (cam.viewW !== d.w || cam.viewH !== d.h || cam.orientation !== d.orientation || cam._z !== cam.zoom || cam._cap !== cap) {
      const rebuilt = cam.viewW !== d.w || cam.viewH !== d.h || cam.orientation !== d.orientation;
      cam.ppyMax = 0;
      cam.setViewport(d.w, d.h, d.orientation);
      this._normalPpy = cam.ppy;
      if (cap > 0 && cap < cam.ppy) {
        // one wider framing for every kick that doesn't fit (so it can be pre-rendered)
        cam.ppyMax = this._kickPpy(d, cam.ppy);
        cam.setViewport(d.w, d.h, d.orientation);
      }
      cam._z = cam.zoom;
      cam._cap = cap;
      if (rebuilt && this._warmed) this._prewarm(false); // rotation / resize: build it all now, once
    }
    cam.worldDirToScreen(1, 0, this.screenFwd);
    let l = Math.hypot(this.screenFwd.x, this.screenFwd.y) || 1;
    this.screenFwd.x /= l; this.screenFwd.y /= l;
    cam.worldDirToScreen(0, 1, this.screenLat);
    l = Math.hypot(this.screenLat.x, this.screenLat.y) || 1;
    this.screenLat.x /= l; this.screenLat.y /= l;
  }

  /** Optional pixels-per-yard cap for this frame (0 = none). */
  _ppyCap() {
    return 0;
  }

  /** Pixels per yard at which a kick from `spotX` fits kicker + uprights (orientation-aware). */
  _kickFit(d, spotX) {
    if (d.orientation === 'landscape') return Math.max(1, Math.floor(d.w / (131 - spotX)));
    const ins = this._insets();
    return Math.max(1, Math.floor((d.h - ins.top - ins.bottom - 32) / (131.5 - spotX)));
  }

  /** The single wider field-goal framing (fits the longest kick; never below 70% of `normal`). */
  _kickPpy(d, normal) {
    return Math.min(normal, Math.max(Math.ceil(normal * 0.7), this._kickFit(d, VIEW.kickSpotMin)));
  }

  /**
   * Pre-render the field for this framing (all crowd bob frames too) and the wider field-goal
   * framing, while the scene is still static, so no frame stalls mid-play.
   */
  _prewarm(kick = true) {
    this._warmed = true;
    const cam = this.camera;
    try {
      prewarmSprites(this.userKit);
      prewarmSprites(this.oppKit);
      this.field.prepare(cam);
      const normal = this._normalPpy || cam.ppy;
      const kp = this._kickPpy(this.app.display, normal);
      if (kick && kp < normal) this.field.prewarm({ orientation: cam.orientation, mirror: cam.mirror, ppy: kp, yScale: cam.yScale });
    } catch (e) {
      console.warn('field prewarm failed', e);
    }
  }

  _ensureCrowd() {
    const au = this.app.audio;
    if (!this._crowd && au && au.ctx && au.enabled) {
      au.startCrowd();
      this._crowd = true;
    }
  }

  _stopCrowd() {
    if (!this.opts.keepCrowd && this.app.audio) this.app.audio.stopCrowd();
    this._crowd = false;
  }

  _dimOverlay(ctx) {
    if (this.dim > 0) {
      const a = ctx.globalAlpha;
      ctx.globalAlpha = a * Math.min(0.9, this.dim);
      ctx.fillStyle = '#05070c';
      ctx.fillRect(0, 0, this.camera.viewW, this.camera.viewH);
      ctx.globalAlpha = a;
    }
  }

  /** Haptic pulse; small ones are rate-limited so rapid jukes / hits don't buzz continuously. */
  _buzz(ms) {
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    if (ms < 30 && now - (this._buzzT || -1e9) < VIEW.buzzGapMs) return;
    this._buzzT = now;
    this.app.vibrate(ms);
  }

  /** CSS-px insets reserved by the HUD -> virtual px (reused object; `view.insets` may change live). */
  _insets() {
    const d = this.app.display;
    const i = this.insets || this.opts.insets || {};
    const k = d.dpr / d.scale;
    const o = this._ins || (this._ins = { top: 0, bottom: 0, left: 0, right: 0 });
    o.top = Math.round((i.top ?? 46) * k);
    o.bottom = Math.round((i.bottom ?? 10) * k);
    o.left = Math.round((i.left ?? 8) * k);
    o.right = Math.round((i.right ?? 8) * k);
    return o;
  }
}

// ---------------------------------------------------------------------------------------------

export class PlayView extends FieldScene {
  /**
   * @param {import('../../app.js').App} app
   * @param {{setup:import('../../types.js').PlaySetup, userLook?:object, oppLook?:object, driveLeft?:boolean,
   *   onSnap?:()=>void, tips?:boolean, zoom?:'near'|'far', insets?:{top?:number,bottom?:number,left?:number,right?:number},
   *   keepCrowd?:boolean, beat?:number}} o
   *   Extras: `tips` overrides settings.showTips; `zoom` overrides settings.cameraZoom; `insets` = CSS
   *   px kept clear of canvas UI (HUD; default top 46); `keepCrowd` leaves the crowd bed running on
   *   destroy(); `beat` overrides the post-play beat (s).
   */
  constructor(app, o = {}) {
    const setup = o.setup || {};
    super(app, {
      ...o,
      userLook: o.userLook || (setup.offense && setup.offense.look),
      oppLook: o.oppLook || (setup.defense && setup.defense.look),
    });
    this.setup = setup;
    if (o.insets) lastPlayInsets = o.insets;
    this.onSnap = typeof o.onSnap === 'function' ? o.onSnap : null;
    this.sim = new PlaySim(setup);
    this.field.setTeams(this.userLook, this.oppLook); // own end zone behind, theirs ahead
    this.controller = new Controller(this);
    this.paused = false;
    this.done = false;
    this.whistleT = -1;
    this._beat = o.beat ?? VIEW.beat;
    this.snapped = false;
    this.bannerState = null; // {text, sub, color, band, t, dur}
    this.throwTarget = null;
    this.phaseT = 0;
    this._phase = this.sim.phase;
    this._wasPaused = false;
    this._builtT = 0;
    this.tipsOn = o.tips != null ? !!o.tips : !(app.settings && app.settings.showTips === false);
    this.tipCounts = { snap: 0, pass: 0, carry: 0, kick: 0, ret: 0, ...(readJSON(TIPS_KEY, {}) || {}) };
    this.stats = { renderMs: 0, updateMs: 0, frames: 0 };
    // interpolation buffers
    this._pl = null;
    this._prev = new Float32Array(0);
    this._rx = new Float32Array(0);
    this._ry = new Float32Array(0);
    this._rz = new Float32Array(0);
    this._sy = new Float32Array(0);
    this._order = [];
    this._pb = { x: 0, y: 0, z: 0 };
    this._rb = { x: 0, y: 0, z: 0 };
    this._pcx = 0;
    this._pcy = 0;
    this._leanSide = -1;
    this._aimLean = { x: 0, y: 0 };
    this._ballLean = { x: 0, y: 0 };
    this._onPlayBuilt();
    this._viewport();
    this._cameraGoal(true);
    this._savePrev();
    this._ensureCrowd();
    this._prewarm();
  }

  /** PlayResult once the whistle blows. */
  get result() {
    return this.sim.result;
  }

  // ------------------------------------------------------------------ public API

  /** Audible: re-roll the assigned play (pre-snap scrimmage only). */
  changePlay() {
    if (this.sim.phase !== 'presnap' || this.sim.kind !== 'scrimmage') return false;
    const ok = this.sim.changePlay();
    if (ok) {
      this.controller.reset();
      this._onPlayBuilt();
      this._pl = null;
      this._savePrev();
      this.app.sfx('select');
    }
    return ok;
  }

  destroy() {
    this.controller.reset();
    this._stopCrowd();
    this.done = true;
  }

  /** Post-play beat skip (tap / click / Space after the whistle). */
  trySkip() {
    if (this.whistleT >= 0 && this.time - this.whistleT >= 0.25) this.done = true;
  }

  /** CSS point near the RB sprite? (pre-snap tap target) */
  hitRB(cssX, cssY) {
    const rb = this.sim.rb;
    if (!rb) return false;
    const d = this.app.display;
    const k = d.scale / d.dpr; // virtual -> CSS
    this.camera.project(rb.x, rb.y, 0, P);
    const cx = P.x * k;
    const cy = (P.y - 9) * k;
    const dx = Math.max(0, Math.abs(cssX - cx) - 7 * k);
    const dy = Math.max(0, Math.abs(cssY - cy) - 10 * k);
    return Math.hypot(dx, dy) <= 30;
  }

  /** CSS position (relative to the stage) of an entity's sprite centre (tests / tooling). */
  screenPos(id) {
    const e = this.sim.byId[id];
    if (!e) return null;
    const d = this.app.display;
    const k = d.scale / d.dpr;
    this.camera.project(e.x, e.y, e.z || 0, P);
    return { x: P.x * k, y: (P.y - 9) * k };
  }

  /** Count a successful use of a control (tips disappear after a few). */
  noteTip(kind) {
    const c = this.tipCounts;
    if (!(kind in c)) c[kind] = 0;
    if (c[kind] >= VIEW.tipsMax * 2) return;
    c[kind] += 1;
    writeJSON(TIPS_KEY, c);
  }

  noteBullet() {
    this.app.sfx('click');
  }

  /** Field goals / PATs: zoom out (to the one wider framing) when the kicker and the uprights don't fit. */
  _ppyCap(d) {
    const sim = this.sim;
    if (!sim || !sim.kick || (sim.kind !== 'fg' && sim.kind !== 'pat')) return 0;
    return this._kickFit(d, sim.kick.spotX);
  }

  // ------------------------------------------------------------------ update

  /**
   * @param {number} dt
   * @param {any[]} [events] input events already drained by the caller (MatchScreen can poll
   *   app.input itself, look at keys like T / Escape, then hand the batch over); default: poll here
   */
  update(dt, events) {
    const t0 = performance.now();
    if (!events) events = this.app.input.poll();
    this.lastEvents = events;
    if (this.paused) {
      if (!this._wasPaused) {
        this.controller.reset();
        this._wasPaused = true;
      }
      return;
    }
    this._wasPaused = false;
    this._viewport();
    this._ensureCrowd();
    this.time += dt;
    const sim = this.sim;
    this.controller.handle(events);
    this._savePrev();
    sim.update(dt);
    if (sim.phase !== this._phase) {
      this._phase = sim.phase;
      this.phaseT = this.time;
    }
    if (!this.snapped && (sim.phase !== 'presnap' || sim.kind === 'kick_return')) {
      this.snapped = true;
      if (this.onSnap) {
        try { this.onSnap(); } catch (e) { console.error(e); }
      }
    }
    this._events(sim.drainEvents());
    this.controller.tick(performance.now());
    if (sim.result && this.whistleT < 0) {
      this.whistleT = this.time;
      this._onWhistle(sim.result);
    }
    this._cameraGoal(false, dt);
    this._updateLean(dt);
    this.fx.update(dt);
    if (this.bannerState) {
      this.bannerState.t += dt;
      if (this.bannerState.t >= this.bannerState.dur) this.bannerState = null;
    }
    if (this.whistleT >= 0 && !this.done && this.time - this.whistleT >= this._beat) this.done = true;
    const ms = performance.now() - t0;
    this.stats.updateMs = this.stats.updateMs ? this.stats.updateMs * 0.95 + ms * 0.05 : ms;
  }

  // ------------------------------------------------------------------ lob lean

  /**
   * Screen px (per yard of height above the chord) a lob from (fx, fy) to (tx, ty) leans sideways.
   * Height normally lifts the ball up the screen, which is invisible when the throw itself runs
   * up the screen (portrait, or a landscape throw across the field): the lean bows the arc to the
   * side so the lob reads. The side flips (with hysteresis) so the lean always adds to the visible
   * bow (the throw's upward normal) instead of cancelling the lift.
   */
  _leanTarget(fx, fy, tx, ty, out) {
    const cam = this.camera;
    cam.worldDirToScreen(tx - fx, ty - fy, out);
    const l = Math.hypot(out.x, out.y);
    if (l < 1e-6) {
      out.x = 0;
      out.y = 0;
      return out;
    }
    const ux = out.x / l;
    const uy = out.y / l;
    // lean toward the side where it adds to the up-the-screen lift (the throw's "upper" normal)
    if (Math.abs(ux) > VIEW.leanFlip && Math.abs(uy) > 0.05) this._leanSide = ux * uy > 0 ? 1 : -1;
    out.x = this._leanSide * VIEW.arcLean * Math.abs(uy) * cam.ppy;
    out.y = 0;
    return out;
  }

  _updateLean(dt) {
    const sim = this.sim;
    const aim = sim.phase === 'dropback' ? sim.aim : null;
    const L = this._aimLean;
    if (aim && !aim.runMode && sim.qb) {
      this._leanTarget(sim.qb.x, sim.qb.y, aim.tx, aim.ty, Q);
      const k = 1 - Math.exp(-14 * dt);
      L.x += (Q.x - L.x) * k;
      L.y += (Q.y - L.y) * k;
    } else if (sim.phase !== 'air') {
      L.x = 0;
      L.y = 0;
    }
  }

  /** Sideways screen offset of the flying ball (same lean as the arc it was thrown on). */
  _ballDx(b, z) {
    const sim = this.sim;
    const lean = this._ballLean;
    // passes only (a kickoff's 20-yd hang would swing the ball off the screen)
    if (!lean.x || b.tipped || !(b.T > 0) || b.state !== 'air' || sim.kind !== 'scrimmage') return 0;
    const f = clamp01((b.ft || 0) / b.T);
    const zT = b.z0 + b.fvz * b.T - 0.5 * b.g * b.T * b.T;
    const h = z - (b.z0 + (zT - b.z0) * f);
    return h > 0 ? lean.x * h : 0;
  }

  _onPlayBuilt() {
    const sim = this.sim;
    this._builtT = this.time;
    this._lanePts = null;
    if (sim.play && sim.play.runLane && sim.rb) {
      this._lanePts = [{ x: sim.rb.x, y: sim.rb.y }, ...sim.play.runLane.points];
    }
  }

  // ------------------------------------------------------------------ interpolation

  _savePrev() {
    const pl = this.sim.players;
    const n = pl.length;
    if (this._prev.length < n * 3) {
      this._prev = new Float32Array(n * 3 + 9);
      this._rx = new Float32Array(n + 3);
      this._ry = new Float32Array(n + 3);
      this._rz = new Float32Array(n + 3);
      this._sy = new Float32Array(n + 3);
    }
    for (let i = 0; i < n; i++) {
      const e = pl[i];
      this._prev[i * 3] = e.x;
      this._prev[i * 3 + 1] = e.y;
      this._prev[i * 3 + 2] = e.z || 0;
    }
    this._pl = pl;
    const b = this.sim.ball;
    this._pb.x = b.x; this._pb.y = b.y; this._pb.z = b.z;
    this._pcx = this.camera.cx;
    this._pcy = this.camera.cy;
  }

  _interp(a) {
    const pl = this.sim.players;
    const same = pl === this._pl;
    for (let i = 0; i < pl.length; i++) {
      const e = pl[i];
      if (same) {
        const px = this._prev[i * 3];
        const py = this._prev[i * 3 + 1];
        const pz = this._prev[i * 3 + 2];
        this._rx[i] = px + (e.x - px) * a;
        this._ry[i] = py + (e.y - py) * a;
        this._rz[i] = pz + ((e.z || 0) - pz) * a;
      } else {
        this._rx[i] = e.x;
        this._ry[i] = e.y;
        this._rz[i] = e.z || 0;
      }
    }
    const b = this.sim.ball;
    const pb = this._pb;
    // don't smear teleports (snap, catch handover)
    const jump = Math.abs(b.x - pb.x) + Math.abs(b.y - pb.y) > 4;
    this._rb.x = jump ? b.x : pb.x + (b.x - pb.x) * a;
    this._rb.y = jump ? b.y : pb.y + (b.y - pb.y) * a;
    this._rb.z = jump ? b.z : pb.z + (b.z - pb.z) * a;
  }

  // ------------------------------------------------------------------ camera

  _cameraGoal(snap, dt = 1 / 60) {
    const sim = this.sim;
    const cam = this.camera;
    const spanX = cam.spanX;
    const portrait = cam.orientation === 'portrait';
    let x = sim.losX;
    let y = sim.by;
    let lead = 0.5;
    let rate = 5;
    let rateY = 0;
    cam.marginX = 3;
    const b = sim.ball;
    if (sim.kind === 'fg' || sim.kind === 'pat') {
      const k = sim.kick;
      const flying = k.stage === 'flight' || (sim.phase === 'dead' && b.state === 'kicked');
      const lo = k.spotX - 8; // a little behind the kicker
      lead = 0.5;
      rate = flying ? 3 : 4;
      if (portrait) {
        // uprights rise up the screen: put the crossbar just under the HUD, keep the kicker in view
        const ins = this._insets();
        const postsC = 123.33 - (cam.viewH / 2 - ins.top - 26) / cam.ppy;
        const kickerC = k.spotX - 5.5 + spanX / 2;
        x = Math.min(postsC, kickerC);
        if (flying && x < postsC) x = Math.min(postsC, Math.max(x, b.x - spanX * 0.1));
        cam.marginX = Math.max(3, x + spanX / 2 - FIELD_LEN_X + 0.5);
        y = W / 2;
      } else {
        const hi = 123;
        if (hi - lo <= spanX) x = (lo + hi) / 2;
        else x = flying ? Math.max(lo + spanX / 2, b.x + spanX * 0.16) : lo + spanX / 2;
        y = (k.spotY + W / 2) / 2;
      }
    } else if (sim.phase === 'presnap') {
      x = sim.losX;
      lead = Math.max(0.16, Math.min(0.42, VIEW.presnapBack[cam.orientation] / spanX));
      rate = 6;
      // the whole formation across: QB / RB must show, receivers as far as possible
      const qb = sim.qb;
      const rb = sim.rb;
      const lo = Math.min(sim.by, qb ? qb.y : sim.by, rb ? rb.y : sim.by) - 1;
      const hi = Math.max(sim.by, qb ? qb.y : sim.by, rb ? rb.y : sim.by) + 1;
      const r = this._receiverSpan(sim.by, sim.by);
      y = this._fitCross(lo, hi, r.lo, r.hi, sim.by);
    } else if (sim.phase === 'return' || (sim.kind === 'kick_return' && !sim.carrier && sim.phase !== 'dead')) {
      const ko = sim.kickoff;
      const kr = sim.byId.KR;
      if (ko && ko.kicked) {
        x = Math.min(ko.landX, kr.x);
        y = (ko.landY + kr.y) / 2;
      } else {
        x = kr.x;
        y = kr.y;
      }
      lead = 0.3;
      rate = 2.5;
    } else if (sim.phase === 'dropback') {
      const qb = sim.qb;
      x = qb.x;
      lead = VIEW.dropbackLead[cam.orientation] ?? 0.24;
      rate = 3;
      rateY = 2.5;
      const aim = sim.aim;
      if (aim && !aim.runMode) {
        // keep the QB and the landing spot on screen (clear of the HUD), downfield and across
        let c = qb.x + (0.5 - lead) * spanX;
        c = Math.max(c, aim.tx - this._aheadSpan() + 4);
        c = Math.min(c, qb.x + this._behindSpan() - 4);
        x = c;
        lead = 0.5;
        rate = 2.5;
        const r = this._receiverSpan(Math.min(qb.y, aim.ty), Math.max(qb.y, aim.ty));
        y = this._fitCross(Math.min(qb.y, aim.ty), Math.max(qb.y, aim.ty), r.lo, r.hi, aim.ty);
      } else {
        // before the aim: QB on screen, receivers (running their routes) as far as possible
        const r = this._receiverSpan(qb.y, qb.y);
        y = this._fitCross(qb.y - 1, qb.y + 1, r.lo, r.hi, qb.y);
      }
    } else if (sim.phase === 'air') {
      const lx = b.landX ?? b.x;
      const ly = b.landY ?? b.y;
      x = b.x * 0.55 + lx * 0.45;
      y = b.y * 0.55 + ly * 0.45;
      lead = 0.45;
      rate = 4;
    } else if (sim.phase === 'carry') {
      const C = sim.carrier || sim.byId[sim.controlledId] || sim.qb;
      x = C.x;
      y = C.y;
      lead = VIEW.carryLead;
      rate = 6;
    } else {
      // dead ball: settle on the end spot
      const r = sim.result;
      if (sim.carrier) {
        x = sim.carrier.x;
        y = sim.carrier.y;
      } else if (r) {
        x = r.outcome === 'incomplete' ? b.x : r.endX;
        y = r.outcome === 'incomplete' ? b.y : r.endY;
      }
      lead = 0.42;
      rate = 2;
    }
    const cx = x + (0.5 - lead) * spanX;
    // `y` is what should sit in the middle of the part of the screen the HUD doesn't cover
    y -= this._crossOffset();
    // the camera may look past a sideline / end line by as much as the HUD covers on that side
    // (portrait: the scorebug sits over the far end zone, the button row over the near one)
    const insv = this._insets();
    if (cam.orientation === 'landscape') {
      const k = cam.ppy * cam.yScale;
      cam.marginY0 = cam.marginY + insv.top / k;
      cam.marginY1 = cam.marginY + this._bottomInset() / k;
      cam.marginX0 = null;
      cam.marginX1 = null;
    } else {
      cam.marginY0 = null;
      cam.marginY1 = null;
      const isKick = sim.kind === 'fg' || sim.kind === 'pat';
      cam.marginX0 = cam.marginX + this._bottomInset() / cam.ppy;
      cam.marginX1 = isKick ? null : cam.marginX + insv.top / cam.ppy;
    }
    cam.leadFrac = 0.5;
    if (snap) cam.snapTo(cx, y);
    else if (rateY > 0) {
      // separate (softer) cross-field rate: the framing re-balances as the aim sweeps, without lurching
      const ty = cam.cy;
      cam.follow(cx, y, dt, rate);
      const k = 1 - Math.exp(-rateY * dt);
      cam.cy = ty + (cam.ty - ty) * k;
    } else cam.follow(cx, y, dt, rate);
  }

  /** HUD-free part of the screen along the cross-field axis, in yards, and its offset from centre. */
  _crossBand() {
    const cam = this.camera;
    const ins = this._insets();
    const k = cam.ppy * cam.yScale;
    let a;
    let b;
    if (cam.orientation === 'landscape') {
      a = ins.top;
      b = this._bottomInset();
    } else {
      a = ins.left;
      b = ins.right;
    }
    const full = cam.orientation === 'landscape' ? cam.viewH : cam.viewW;
    const o = this._band || (this._band = { span: 0, off: 0 });
    o.span = Math.max(4, (full - a - b) / k);
    o.off = (a - b) / 2 / k;
    return o;
  }

  /** World-y shift between the screen centre and the centre of the HUD-free band. */
  _crossOffset() {
    return this._crossBand().off;
  }

  /** Bottom HUD inset (virtual px): the button row only shows before the snap. */
  _bottomInset() {
    const ins = this._insets();
    const sim = this.sim;
    if (sim && sim.phase === 'presnap' && sim.kind === 'scrimmage') return ins.bottom;
    return Math.min(ins.bottom, 6);
  }

  /** Yards visible from the screen centre to the downfield edge (clear of the HUD). */
  _aheadSpan() {
    const cam = this.camera;
    const ins = this._insets();
    if (cam.orientation === 'portrait') return (cam.viewH / 2 - ins.top) / cam.ppy;
    return (cam.viewW / 2 - (cam.mirror ? ins.left : ins.right)) / cam.ppy;
  }

  /** Yards visible from the screen centre to the edge behind the play. */
  _behindSpan() {
    const cam = this.camera;
    const ins = this._insets();
    if (cam.orientation === 'portrait') return (cam.viewH / 2 - this._bottomInset()) / cam.ppy;
    return (cam.viewW / 2 - (cam.mirror ? ins.right : ins.left)) / cam.ppy;
  }

  /** Cross-field extent of the pass-eligible players (merged with [lo, hi]). */
  _receiverSpan(lo, hi) {
    const sim = this.sim;
    const o = this._rspan || (this._rspan = { lo: 0, hi: 0 });
    o.lo = lo;
    o.hi = hi;
    for (const id of ['WR1', 'WR2', 'TE2', 'RB']) {
      const e = sim.byId[id];
      if (!e) continue;
      if (e.y < o.lo) o.lo = e.y;
      if (e.y > o.hi) o.hi = e.y;
    }
    return o;
  }

  /**
   * Cross-field framing: the world y for the middle of the HUD-free band that keeps [lo, hi] on
   * screen (with a margin) and shows as much of [nlo, nhi] as it can. When [lo, hi] can't fit,
   * `pri` (e.g. the aim target) stays on screen and the rest gets as close as possible.
   */
  _fitCross(lo, hi, nlo, nhi, pri) {
    const band = this._crossBand();
    const half = band.span / 2;
    const m = Math.min(VIEW.crossMargin, band.span * 0.1);
    const minY = hi + m - half;
    const maxY = lo - m + half;
    const want = (Math.min(nlo, lo) + Math.max(nhi, hi)) / 2;
    if (minY <= maxY) return Math.min(maxY, Math.max(minY, want));
    // too wide for the margins: give up the margins before giving up either end
    if (hi - lo <= band.span) return (lo + hi) / 2;
    const m2 = Math.min(m, 1);
    return Math.min(pri + half - m2, Math.max(pri - half + m2, (lo + hi) / 2));
  }

  // ------------------------------------------------------------------ events -> sfx / fx

  _events(evs) {
    const app = this.app;
    const sim = this.sim;
    const fx = this.fx;
    for (let i = 0; i < evs.length; i++) {
      const ev = evs[i];
      switch (ev.type) {
        case 'snap':
          app.sfx('hike');
          break;
        case 'throw':
          app.sfx('throw');
          this._buzz(8);
          this.throwTarget = ev.target || null;
          this._ballLean.x = this._aimLean.x;
          this._ballLean.y = this._aimLean.y;
          break;
        case 'catch':
          app.sfx('catch');
          fx.burst(ev.x, ev.y, { kind: ev.contested ? 'hit' : 'spark', z: 1.2 });
          break;
        case 'drop':
          fx.pop(ev.x, ev.y, 'DROPPED', { color: '#ffffff', size: 'small' });
          break;
        case 'deflect':
          app.sfx('hit', { power: 0.35 });
          fx.burst(ev.x, ev.y, { kind: 'spark', z: 2 });
          fx.pop(ev.x, ev.y, ev.batted ? 'BATTED!' : 'TIPPED!', { color: '#ffffff', size: 'small', z: 2.4 });
          break;
        case 'int':
          app.sfx('bad');
          fx.burst(ev.x, ev.y, { kind: 'spark', z: 1.4 });
          break;
        case 'juke':
          app.sfx('juke');
          this._buzz(6);
          fx.burst(ev.x, ev.y, { kind: 'turf', n: 7 });
          break;
        case 'burn':
          fx.pop(ev.x, ev.y, 'BURNED!', { color: '#ffd23a', size: 'small' });
          fx.burst(ev.x, ev.y, { kind: 'turf', n: 10 });
          if (app.audio) app.audio.cheer(0.45, 1.0);
          break;
        case 'dive':
          app.sfx('dive');
          break;
        case 'stutter':
          if (ev.taunt) fx.pop(ev.x, ev.y, 'TAUNT!', { color: '#ffffff', size: 'small' });
          break;
        case 'truck_hit':
          app.sfx('hit', { power: 1 });
          this._buzz(35);
          this.camera.shake(3, 0.3);
          fx.burst(ev.x, ev.y, { kind: 'hit', z: 1 });
          fx.pop(ev.x, ev.y, 'TRUCKED!', { color: '#ffd23a', size: 'small' });
          break;
        case 'hurdle':
          app.sfx('juke');
          fx.pop(ev.x, ev.y, 'HURDLE!', { color: '#ffd23a', size: 'small' });
          break;
        case 'stiffarm':
          app.sfx('hit', { power: 0.6 });
          this._buzz(15);
          fx.burst(ev.x, ev.y, { kind: 'hit', z: 1, n: 6 });
          fx.pop(ev.x, ev.y, 'STIFF ARM!', { color: '#ffd23a', size: 'small' });
          break;
        case 'broken_tackle':
          app.sfx('hit', { power: 0.5 });
          fx.burst(ev.x, ev.y, { kind: 'hit', z: 1, n: 6 });
          break;
        case 'tackle':
        case 'sack': {
          const C = sim.byId[ev.id];
          const d = sim.byId[ev.by];
          const closing = C && d ? Math.hypot(C.vx - d.vx, C.vy - d.vy) : 6;
          const big = ev.type === 'sack' || closing >= VIEW.bigHit;
          app.sfx('hit', { power: big ? 1 : 0.7 });
          this._buzz(big ? 40 : 18);
          fx.burst(ev.x, ev.y, { kind: 'hit', z: 0.9 });
          fx.burst(ev.x, ev.y, { kind: 'turf', n: 12 });
          if (big) this.camera.shake(2.5, 0.28);
          break;
        }
        case 'fumble':
          app.sfx('bad');
          fx.pop(ev.x, ev.y, 'FUMBLE!', { color: '#ff6b6b', size: 'small' });
          break;
        case 'recover':
          fx.pop(ev.x, ev.y, 'RECOVERED', { color: '#ffffff', size: 'small' });
          break;
        case 'oob':
          fx.burst(ev.x, ev.y, { kind: 'turf', n: 8 });
          break;
        case 'td':
          app.sfx('touchdown');
          this._buzz(60);
          if (app.audio) app.audio.cheer(1, 3);
          fx.burst(ev.x, ev.y, { kind: 'confetti' });
          fx.flash('#ffffff', 0.22);
          break;
        case 'kick':
          app.sfx('kick');
          this._buzz(12);
          fx.burst(ev.x, ev.y, { kind: 'turf', n: 8 });
          break;
        case 'doink':
          app.sfx('hit', { power: 0.4 });
          fx.pop(ev.x, ev.y, 'DOINK!', { color: '#ffffff', size: 'small', z: 4 });
          break;
        case 'kick_good':
          app.sfx('good');
          if (app.audio) app.audio.cheer(0.8, 2);
          break;
        case 'kick_miss':
          app.sfx('bad');
          break;
        case 'incomplete':
          app.sfx('incomplete');
          break;
        case 'whistle':
          app.sfx('whistle');
          break;
        default:
          break;
      }
    }
  }

  _onWhistle(r) {
    const sim = this.sim;
    const fx = this.fx;
    const app = this.app;
    let sub = (r.highlights && r.highlights[0]) || '';
    let text = '';
    let band = INK;
    let color = '#ffffff';
    let big = false;
    const yds = Math.round(r.yards);
    const ydTxt = `${yds > 0 ? '+' : ''}${yds}`;
    const popYards = (c) => fx.pop(r.endX, r.endY, ydTxt, { color: c, dur: 1.4, z: 2.2 });
    switch (r.outcome) {
      case 'td':
      case 'return_td':
        text = r.twoPoint ? '2-PT GOOD!' : 'TOUCHDOWN!';
        band = this.userLook.primary;
        big = true;
        break;
      case 'interception':
        text = r.defensiveTd ? 'PICK SIX!' : 'INTERCEPTED';
        band = '#7a1622';
        big = true;
        break;
      case 'fumble':
        text = 'FUMBLE';
        band = '#7a1622';
        big = true;
        break;
      case 'sack':
        text = r.twoPoint ? 'NO GOOD' : 'SACKED';
        band = '#3a2f4a';
        popYards('#ff6b6b');
        break;
      case 'safety':
        text = 'SAFETY';
        band = '#7a1622';
        big = true;
        break;
      case 'incomplete':
        text = r.twoPoint ? 'NO GOOD' : 'INCOMPLETE';
        band = '#2a3042';
        break;
      case 'fg_good':
      case 'pat_good':
        text = "IT'S GOOD!";
        band = '#1f6b34';
        big = true;
        fx.burst(sim.ball.x, sim.ball.y, { kind: 'confetti', n: 40 });
        break;
      case 'fg_miss':
      case 'pat_miss':
        text = 'NO GOOD';
        band = '#7a1622';
        break;
      case 'kick_blocked':
        text = 'BLOCKED!';
        band = '#7a1622';
        break;
      case 'touchback':
        text = 'TOUCHBACK';
        band = '#2a3042';
        break;
      default:
        // tackle / oob
        if (r.twoPoint) {
          text = 'NO GOOD';
          band = '#7a1622';
        } else if (r.firstDown) {
          text = 'FIRST DOWN!';
          band = '#8a6a00';
          color = '#ffffff';
          app.sfx('firstdown');
          if (app.audio) app.audio.cheer(0.5, 1.4);
        }
        if (!r.twoPoint) popYards(yds < 0 ? '#ff6b6b' : r.firstDown ? '#ffffff' : '#ffd23a');
        if (r.dive) fx.burst(r.endX, r.endY, { kind: 'turf', n: 14 });
        if (r.outcome === 'oob') fx.pop(r.endX, r.endY, 'OUT OF BOUNDS', { color: '#ffffff', size: 'small', z: 0.6, dur: 1.4 });
        if (r.yards >= 20 && app.audio) app.audio.cheer(0.8, 2);
        break;
    }
    this._beat = this.opts.beat ?? (big ? VIEW.beatBig : VIEW.beat);
    if (r.twoPoint && sub) sub = sub.replace(/^TOUCHDOWN!\s*/, ''); // the banner already says 2-PT
    // drop a subtitle that only repeats the banner ("PASS INCOMPLETE", "TOUCHBACK")
    const core = text.replace(/[^A-Z0-9 ]/g, '').trim();
    if (sub && text && sub.startsWith(text)) sub = sub.slice(text.length).trim();
    if (sub && core && sub.includes(core) && sub.length - core.length < 8) sub = '';
    // the banner fades out within the post-play beat (the view, and the banner, end with it)
    if (text) this.bannerState = { text, sub, color, band, t: 0, dur: Math.max(0.5, this._beat) };
  }

  // ------------------------------------------------------------------ render

  render(alpha = 1) {
    const t0 = performance.now();
    const d = this.app.display;
    this._viewport();
    const ctx = d.begin('#000');
    const cam = this.camera;
    const sim = this.sim;
    const a = this.paused ? 1 : clamp01(alpha);
    const ccx = cam.cx;
    const ccy = cam.cy;
    cam.cx = this._pcx + (ccx - this._pcx) * a;
    cam.cy = this._pcy + (ccy - this._pcy) * a;
    this._interp(a);
    const scrim = sim.kind === 'scrimmage';
    const isKick = sim.kind === 'fg' || sim.kind === 'pat';
    this.field.draw(ctx, cam, {
      losX: sim.kind === 'kick_return' ? null : sim.losX,
      firstDownX: scrim ? sim.firstDownX : null,
      time: this.time,
      posts: false,
    });
    this.field.drawPosts(ctx, cam, 'behind');
    this._drawGround(ctx, scrim, isKick);
    this._drawEntities(ctx);
    this.field.drawPosts(ctx, cam, 'front');
    this._drawAir(ctx, isKick);
    this.fx.render(ctx, cam);
    this._drawUI(ctx, isKick);
    this._dimOverlay(ctx);
    d.present();
    cam.cx = ccx;
    cam.cy = ccy;
    const ms = performance.now() - t0;
    this.stats.renderMs = this.stats.renderMs ? this.stats.renderMs * 0.95 + ms * 0.05 : ms;
    this.stats.frames += 1;
  }

  _drawGround(ctx, scrim, isKick) {
    const sim = this.sim;
    const cam = this.camera;
    const t = this.time;
    // ---- pre-snap play art (fades out after the snap)
    if (scrim && sim.play) {
      let alpha = 1;
      if (sim.phase !== 'presnap') alpha = sim.phase === 'dropback' ? clamp01(1 - sim.t / VIEW.routeFade) * 0.8 : 0;
      if (alpha > 0.01) {
        const grow = clamp01((t - this._builtT) / VIEW.routeGrow);
        const maxPx = grow >= 1 ? null : grow * 260;
        const routes = sim.play.routes;
        for (let i = 0; i < routes.length; i++) {
          const r = routes[i];
          const isRB = r.playerId === 'RB';
          if (isRB && sim.phase === 'presnap') {
            // the RB's pass route: faint, so the run lane reads first
            dotPath(ctx, cam, r.points, { ground: true, color: VIEW.routeColors.RB, gap: 5, size: 1, alpha: alpha * 0.6, maxPx });
            continue;
          }
          if (isRB) continue;
          const col = VIEW.routeColors[r.playerId] || '#ffffff';
          dotPath(ctx, cam, r.points, { ground: true, color: col, gap: 4, size: 2, shadow: true, alpha, maxPx });
          if (grow >= 1) {
            const ga = ctx.globalAlpha;
            ctx.globalAlpha = ga * alpha;
            pathArrow(ctx, cam, r.points, col, 4);
            ctx.globalAlpha = ga;
          }
        }
        if (sim.phase === 'presnap') {
          // TE block markers: TE1 always blocks; TE2 when the play keeps him in
          const te1 = sim.byId.TE1;
          if (te1) blockMarker(ctx, cam, te1.x, te1.y, '#e9e4d4');
          const te2 = sim.byId.TE2;
          if (te2 && sim.play.teBlocks) blockMarker(ctx, cam, te2.x, te2.y, '#e9e4d4');
          // RB run lane + pulsing ring
          const rb = sim.rb;
          if (rb && this._lanePts) {
            this._lanePts[0].x = rb.x;
            this._lanePts[0].y = rb.y;
            dotPath(ctx, cam, this._lanePts, { ground: true, color: VIEW.laneColor, gap: 7, dash: 3, size: 2, shadow: true, phase: -t * 14, maxPx });
            if (grow >= 1) pathArrow(ctx, cam, this._lanePts, VIEW.laneColor, 5);
          }
          if (rb) {
            cam.project(rb.x, rb.y, 0, P);
            const pulse = (Math.sin(t * 6) + 1) / 2;
            drawRing(ctx, P.x, P.y, 18, VIEW.ringColor, 1);
            drawRing(ctx, P.x, P.y, 22 + Math.round(pulse * 6), VIEW.ringColor, 0.25 + 0.5 * (1 - pulse));
          }
        }
      }
    }
    // ---- aim: ground shadow + landing marker
    const aim = sim.phase === 'dropback' ? sim.aim : null;
    if (aim && !aim.runMode && aim.path && aim.path.length > 1) {
      const n = this._aimCount(aim);
      dotPath(ctx, cam, aim.path, { n, ground: true, color: '#000000', gap: aim.bullet ? 6 : 5, size: 2, alpha: 0.4, dash: aim.bullet ? 3 : 0 });
      if (aim.showMarker && aim.valid) landingMarker(ctx, cam, aim.tx, aim.ty, aim.bullet ? VIEW.bulletColor : '#ffffff', t, 12);
    }
    // ---- kick return: landing spot
    if (sim.kind === 'kick_return' && !sim.carrier && sim.kickoff && sim.kickoff.kicked && sim.phase !== 'dead') {
      landingMarker(ctx, cam, sim.kickoff.landX, sim.kickoff.landY, '#ffd23a', t, 14);
    }
    // ---- FG / PAT aim arrow on the turf
    if (isKick) this._drawKickArrow(ctx);
  }

  _aimCount(aim) {
    const len = aim.path.length;
    return Math.max(2, Math.min(len, Math.round(clamp01(aim.visibleFrac) * (len - 1)) + 1));
  }

  _drawKickArrow(ctx) {
    const sim = this.sim;
    const k = sim.kick;
    if (!k || sim.phase === 'dead' || k.stage === 'flight' || k.stage === 'done') return;
    const cam = this.camera;
    if (k.stage !== 'aim') return;
    const sx = k.spotX;
    const sy = k.spotY;
    const DEG = Math.PI / 180;
    // sweep guides (limits + centre line toward the posts)
    const ga = ctx.globalAlpha;
    for (const s of [-1, 1]) {
      const ang = k.baseAngle + s * k.sweepDeg * DEG;
      cam.project(sx + Math.cos(ang) * 3, sy + Math.sin(ang) * 3, 0, P);
      cam.project(sx + Math.cos(ang) * 9, sy + Math.sin(ang) * 9, 0, Q);
      ctx.globalAlpha = ga * 0.45;
      ctx.fillStyle = '#ffffff';
      pixLine(ctx, P.x, P.y, Q.x, Q.y, 1);
    }
    ctx.globalAlpha = ga * 0.35;
    const cl = 14;
    for (let i = 3; i < cl; i += 1.2) {
      cam.project(sx + Math.cos(k.baseAngle) * i, sy + Math.sin(k.baseAngle) * i, 0, P);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(Math.round(P.x), Math.round(P.y), 1, 1);
    }
    ctx.globalAlpha = ga;
    // the arrow
    const len = 11;
    cam.project(sx + Math.cos(k.aimAngle) * 1.5, sy + Math.sin(k.aimAngle) * 1.5, 0, P);
    cam.project(sx + Math.cos(k.aimAngle) * len, sy + Math.sin(k.aimAngle) * len, 0, Q);
    const col = k.aimLocked ? '#ffffff' : '#ffd23a';
    ctx.fillStyle = INK;
    pixLine(ctx, P.x + 1, P.y + 1, Q.x + 1, Q.y + 1, 2);
    ctx.fillStyle = col;
    pixLine(ctx, P.x, P.y, Q.x, Q.y, 2);
    arrowHead(ctx, Q.x, Q.y, Q.x - P.x, Q.y - P.y, col, 6);
  }

  _drawEntities(ctx) {
    const sim = this.sim;
    const cam = this.camera;
    const pl = sim.players;
    const n = pl.length;
    const rx = this._rx;
    const ry = this._ry;
    const rz = this._rz;
    const sy = this._sy;
    const order = this._order;
    order.length = n;
    for (let i = 0; i < n; i++) {
      cam.project(rx[i], ry[i], 0, P);
      sy[i] = P.y;
      order[i] = i;
    }
    // insertion sort by screen y (nearly sorted frame to frame)
    for (let i = 1; i < n; i++) {
      const v = order[i];
      const key = sy[v];
      let j = i - 1;
      while (j >= 0 && sy[order[j]] > key) {
        order[j + 1] = order[j];
        j--;
      }
      order[j + 1] = v;
    }
    const b = sim.ball;
    const holder = b.state === 'held' && b.holder ? sim.byId[b.holder] : null;
    const live = sim.phase !== 'dead';
    const presnapScrim = sim.phase === 'presnap' && sim.kind === 'scrimmage';
    const air = sim.phase === 'air';
    for (let oi = 0; oi < n; oi++) {
      const i = order[oi];
      const e = pl[i];
      cam.project(rx[i], ry[i], 0, P);
      const lift = rz[i] * cam.ppy;
      let hl = null;
      if (live && e.controlled && !presnapScrim) hl = 'user';
      else if (air && this.throwTarget === e.id) hl = 'target';
      const po = this._po || (this._po = { facing: 'right', anim: 'idle', t: 0, skin: 0, highlight: null, time: 0 });
      po.facing = cam.facingFor(e.face.x, e.face.y);
      po.anim = e.anim;
      po.t = e.animT;
      po.skin = skinOf(e);
      po.highlight = hl;
      po.time = this.time;
      drawPlayer(ctx, P.x, P.y - lift, e.side === 'off' ? this.userKit : this.oppKit, po);
      if (holder === e) this._drawHeldBall(ctx, e, P.x, P.y - lift);
    }
  }

  _drawHeldBall(ctx, e, sx, sy) {
    const sim = this.sim;
    const cam = this.camera;
    const b = sim.ball;
    if (b.z <= 0.5) {
      // on the turf (centre's snap, holder's spot)
      cam.project(this._rb.x, this._rb.y, 0, Q);
      drawBall(ctx, Q.x, Q.y, b.z, { ppy: cam.ppy, spinning: false });
      return;
    }
    // tucked: a few px toward the facing, at chest height (sprite space, independent of ppy)
    cam.worldDirToScreen(e.face.x, e.face.y, Q);
    const l = Math.hypot(Q.x, Q.y) || 1;
    const bx = sx + (Q.x / l) * 3;
    const by = sy + (Q.y / l) * 2 - 8;
    drawBall(ctx, bx, by, 0, { ppy: cam.ppy, spinning: false, shadow: false });
  }

  _drawAir(ctx, isKick) {
    const sim = this.sim;
    const cam = this.camera;
    const t = this.time;
    const b = sim.ball;
    // aim arc / bullet line
    const aim = sim.phase === 'dropback' ? sim.aim : null;
    const qb = sim.qb;
    if (aim && qb) {
      cam.project(qb.x, qb.y, 0, P);
      if (aim.runMode) {
        tagAbove(ctx, P.x, P.y, 'RUN', '#7dff8a', 34);
        // arrow just beyond the tag, pointing the way the QB will run
        const fx = this.screenFwd;
        const off = Math.abs(fx.x) * 14 + Math.abs(fx.y) * 9;
        arrowHead(ctx, P.x + fx.x * off, P.y - 30 + fx.y * off, fx.x, fx.y, '#7dff8a', 4);
      } else if (aim.path && aim.path.length > 1) {
        const n = this._aimCount(aim);
        const alpha = aim.valid ? 1 : 0.45;
        const lean = this._aimLean;
        if (aim.bullet) {
          dotPath(ctx, cam, aim.path, { n, color: VIEW.bulletColor, gap: 7, dash: 4, size: 2, shadow: true, alpha, fadeTail: 10, phase: -t * 40, lean });
        } else {
          dotPath(ctx, cam, aim.path, { n, color: VIEW.arcColor, gap: 5, size: 2, shadow: true, alpha, fadeTail: 12, phase: -t * 16, lean });
        }
        if (aim.bullet) tagAbove(ctx, P.x, P.y, 'BULLET', VIEW.bulletColor, 34);
      }
    }
    // truck charge meter over the carrier while the press is held
    const cs = sim.carrierState;
    if (cs && cs.truckHeld && sim.carrier && sim.phase === 'carry') {
      const i = sim.players.indexOf(sim.carrier);
      cam.project(i >= 0 ? this._rx[i] : sim.carrier.x, i >= 0 ? this._ry[i] : sim.carrier.y, 0, P);
      const full = cs.truckCharge >= 1;
      const col = full ? (Math.floor(t * 10) % 2 ? '#ffffff' : '#ffd23a') : '#ff9f1c';
      hMeter(ctx, Math.round(P.x - 9), Math.round(P.y - 31), 18, 3, cs.truckCharge, col);
    }
    // the ball when not in someone's hands
    if (b.state !== 'held' || !b.holder) {
      const r = this._rb;
      cam.project(r.x, r.y, 0, P);
      let angle;
      let spinning = false;
      if (b.state === 'air' || b.state === 'kicked' || b.state === 'loose') {
        cam.project(this._pb.x, this._pb.y, this._pb.z, Q);
        const cx = P.x;
        const cy = P.y - r.z * cam.ppy;
        const dx = cx - Q.x;
        const dy = cy - Q.y;
        if (dx * dx + dy * dy > 0.01) angle = Math.atan2(dy, dx);
        spinning = true;
      }
      // kicked ball: faint trail of the flight so far
      if (isKick && sim.kick && sim.kick.path && sim.kick.path.length > 1 && b.state === 'kicked') {
        const k = sim.kick;
        const u = clamp01((k.flightT || 0) / Math.max(0.05, k.tEnd || 1));
        const m = Math.max(2, Math.round(u * (k.path.length - 1)) + 1);
        dotPath(ctx, cam, k.path, { n: m, color: '#ffffff', gap: 6, size: 1, alpha: 0.5 });
      }
      drawBall(ctx, P.x, P.y, r.z, { ppy: cam.ppy, spin: t, angle, spinning, dx: this._ballDx(b, r.z) });
    }
  }

  _drawUI(ctx, isKick) {
    const sim = this.sim;
    const cam = this.camera;
    const vw = cam.viewW;
    const vh = cam.viewH;
    const ins = this._insets();
    const t = this.time;
    if (isKick && sim.kick && sim.phase !== 'dead') {
      const k = sim.kick;
      const K = sim.byId.K;
      if (K && k.stage !== 'flight' && k.stage !== 'done') {
        cam.project(K.x, K.y, 0, P);
        const land = cam.orientation === 'landscape';
        const bx = land ? Math.round(P.x - this.screenFwd.x * 22) - 3 : Math.round(P.x - 26);
        const by = Math.round(P.y - 46);
        vMeter(ctx, bx, by, 7, 40, k.power, { band: k.greenBand, dim: k.powerLocked });
        if (k.stage === 'aim' && !k.aimLocked) {
          const pr = clamp01(k.pressure);
          const blink = pr > 0.75 && Math.floor(t * 8) % 2;
          const col = pr < 0.5 ? '#ffd23a' : pr < 0.75 ? '#ff9f1c' : '#ff4d4d';
          hMeter(ctx, Math.round(P.x - 15), Math.round(P.y + 5), 30, 3, pr, blink ? '#ffffff' : col);
        }
      }
      // wind
      const wnd = k.wind || { x: 0, y: 0 };
      const mph = Math.hypot(wnd.x, wnd.y);
      cam.worldDirToScreen(wnd.x, wnd.y, Q);
      const ww = 18 + Math.max(measureText(mph < 0.5 ? 'CALM' : `${Math.round(mph)} MPH`, { size: 'small' }), 15) + 4;
      // away from the uprights: landscape = top corner behind the kicker; portrait = bottom-left
      let wx = ins.left + 2;
      let wy = ins.top + 2;
      if (cam.orientation === 'landscape') {
        if (this.screenFwd.x < 0) wx = vw - ins.right - ww - 2;
      } else wy = vh - this._bottomInset() - 22;
      windIcon(ctx, wx, wy, Q.x, Q.y, mph);
    }
    // banner
    const bs = this.bannerState;
    if (bs) {
      let scale = 3;
      const w1 = measureText(bs.text, { size: 'big' });
      while (scale > 1 && w1 * scale > vw * 0.9) scale--;
      const y = Math.round(Math.max(ins.top + 10, vh * (cam.orientation === 'portrait' ? 0.3 : 0.26)));
      banner(ctx, vw, y, bs.text, {
        scale, k: bs.t / bs.dur, band: bs.band, color: bs.color, sub: bs.sub && measureText(bs.sub, { size: 'small' }) < vw - 8 ? bs.sub : '',
        fromLeft: !this.camera.mirror,
      });
    }
    // tips: along the bottom edge, behind the play (landscape: the side the offense comes from),
    // so they never sit over the routes, the landing spot or the runner's path; faded while the
    // finger is already doing what they describe
    const tip = this._tipText();
    if (tip) {
      let ta = clamp01((t - this.phaseT - 0.35) / 0.25);
      const g = this.controller.g;
      if (g && (g.mode === 'aim' || g.mode === 'carry')) ta *= 0.5;
      if (ta > 0) {
        const maxW = Math.min(vw - 8, cam.orientation === 'landscape' ? Math.round(vw * 0.46) : vw - 8);
        const sz = tipSize(tip, maxW);
        const at = this._tipSpot(tip, sz, isKick);
        tipBox(ctx, Math.round(at.cx), Math.round(at.bottom), tip, ta, maxW);
      }
    }
  }

  /**
   * Where the tip box goes: one of a few edge slots (bottom / under the HUD; in landscape also
   * behind or ahead of the play), whichever covers the least of what matters right now - the
   * player you control, the aim target, the receivers, then everyone else. Re-evaluated a few
   * times a second with hysteresis so the box doesn't hop around.
   */
  _tipSpot(text, sz, isKick) {
    const cam = this.camera;
    const vw = cam.viewW;
    const vh = cam.viewH;
    const ins = this._insets();
    const bot = vh - this._bottomInset() - 3;
    const top = ins.top + 3 + sz.h;
    const st = this._tipState || (this._tipState = { text: '', slot: -1, t: -1, slots: [] });
    const slots = st.slots;
    slots.length = 0;
    const half = sz.w / 2;
    if (cam.orientation === 'landscape' && !isKick) {
      const back = this.screenFwd.x >= 0 ? ins.left + 4 + half : vw - ins.right - 4 - half;
      const front = this.screenFwd.x >= 0 ? vw - ins.right - 4 - half : ins.left + 4 + half;
      slots.push({ cx: back, bottom: bot }, { cx: vw / 2, bottom: bot }, { cx: front, bottom: bot }, { cx: back, bottom: top }, { cx: front, bottom: top });
    } else {
      slots.push({ cx: vw / 2, bottom: bot });
      if (!isKick) slots.push({ cx: vw / 2, bottom: top });
    }
    if (st.text !== text || st.slot < 0 || st.slot >= slots.length || this.time - st.t >= 0.25) {
      const scores = slots.map((sl) => this._tipCover(sl.cx - half - 4, sl.bottom - sz.h - 4, sz.w + 8, sz.h + 8));
      let best = 0;
      for (let i = 1; i < scores.length; i++) if (scores[i] < scores[best] - 1e-6) best = i;
      const keep = st.text === text && st.slot >= 0 && st.slot < scores.length && scores[st.slot] <= scores[best] + 1.5;
      st.slot = keep ? st.slot : best;
      st.text = text;
      st.t = this.time;
    }
    return slots[st.slot];
  }

  /** How much important stuff a screen rect (virtual px) would hide. */
  _tipCover(x, y, w, h) {
    const sim = this.sim;
    const cam = this.camera;
    let score = 0;
    const add = (wx, wy, wt, lift = 10) => {
      cam.project(wx, wy, 0, P);
      if (P.x >= x - 6 && P.x <= x + w + 6 && P.y - lift >= y - 4 && P.y - lift - 12 <= y + h) score += wt;
    };
    const ctl = sim.carrier || sim.byId[sim.controlledId] || (sim.phase === 'presnap' ? sim.qb : null);
    for (const e of sim.players) {
      let wt = 0.4;
      if (e === ctl) wt = 8;
      else if (sim.phase === 'presnap' && e.id === 'RB') wt = 5;
      else if (e.side === 'off' && (e.pos === 'WR' || e.pos === 'TE' || e.pos === 'RB')) wt = sim.phase === 'carry' ? 0.6 : 2;
      else if (e.side === 'def' && sim.phase === 'carry') wt = 1;
      add(e.x, e.y, wt);
    }
    const aim = sim.phase === 'dropback' ? sim.aim : null;
    if (aim && !aim.runMode) {
      add(aim.tx, aim.ty, 5, 0);
      add((aim.tx + sim.qb.x) / 2, (aim.ty + sim.qb.y) / 2, 2, 0);
    }
    if (sim.phase === 'return' && sim.kickoff && sim.kickoff.kicked) add(sim.kickoff.landX, sim.kickoff.landY, 5, 0);
    return score;
  }

  _touchUI() {
    const lp = this.app.input && this.app.input.lastPointerType;
    if (lp) return lp === 'touch' || lp === 'pen';
    return coarsePointer();
  }

  _tipText() {
    if (!this.tipsOn) return null;
    const sim = this.sim;
    const c = this.tipCounts;
    const N = VIEW.tipsMax;
    const touch = this._touchUI();
    const portrait = this.camera.orientation === 'portrait';
    const left = this.camera.mirror;
    if (sim.phase === 'dead') return null;
    if (sim.kind === 'fg' || sim.kind === 'pat') {
      if (c.kick >= N * 2) return null;
      const k = sim.kick;
      if (sim.phase === 'presnap') return touch ? 'TAP WHEN THE POWER\nIS IN THE GREEN' : 'CLICK OR SPACE WHEN THE\nPOWER IS IN THE GREEN';
      if (k && k.stage === 'aim' && !k.aimLocked) return touch ? 'TAP AGAIN TO AIM\nAT THE POSTS' : 'CLICK OR SPACE AGAIN\nTO AIM AT THE POSTS';
      return null;
    }
    const fwdKey = portrait ? 'W' : left ? 'A' : 'D';
    const backKey = portrait ? 'S' : left ? 'D' : 'A';
    const fwdSwipe = portrait ? 'UP' : left ? 'LEFT' : 'RIGHT';
    const backSwipe = portrait ? 'DOWN' : left ? 'RIGHT' : 'LEFT';
    if (sim.phase === 'presnap') {
      if (c.snap >= N) return null;
      return touch ? `TAP THE RB TO RUN\nDRAG ${backSwipe} TO PASS` : 'CLICK THE RB (OR H) TO RUN\nDRAG BACK (OR SPACE) TO PASS';
    }
    if (sim.phase === 'dropback') {
      if (c.pass >= N) return null;
      return touch ? 'PULL BACK TO AIM - LIFT TO THROW\n2ND FINGER: BULLET - SLIDE FORWARD: RUN'
        : 'DRAG AWAY FROM THE TARGET, RELEASE TO THROW\nRIGHT CLICK / B: BULLET - R: RUN';
    }
    if (sim.phase === 'return') {
      const ko = sim.kickoff;
      if (c.ret >= N || !ko || !ko.kicked || ko.landX >= 10) return null;
      return touch ? `SWIPE ${backSwipe} FOR A TOUCHBACK` : `${backKey} FOR A TOUCHBACK`;
    }
    if (sim.phase === 'carry' && this.controller._userCarrying()) {
      if (sim.kind === 'kick_return' && sim.carrier && sim.carrier.x < 10 && sim.cs && !sim.cs.leftEndZone && c.ret < N) {
        return touch ? `SWIPE ${backSwipe} FOR A TOUCHBACK` : `${backKey} FOR A TOUCHBACK`;
      }
      if (c.carry >= N) return null;
      if (touch) return portrait ? 'SWIPE SIDEWAYS: JUKE - UP: DIVE\nHOLD: TRUCK' : `SWIPE UP/DOWN: JUKE\n${fwdSwipe}: DIVE - HOLD: TRUCK`;
      if (portrait) return 'A/D: JUKE - W: DIVE - S: STUTTER\nHOLD SPACE: TRUCK';
      return `W/S: JUKE - ${fwdKey}: DIVE - ${backKey}: STUTTER\nHOLD SPACE: TRUCK`;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------------------------

/**
 * Field with both teams lined up at a spot (MatchScreen: behind opponent-drive text boxes and
 * between steps). Options: {losX, userLook, oppLook, driveLeft, firstDownX?, hashY?,
 * offense?:'user'|'opp' (who lines up on offense; 'opp' attacks toward the user's end zone),
 * dim?:0..1, showPlayers?:boolean, zoom?, keepCrowd?, seed?}. `view.dim` can be changed live.
 */
export class IdleFieldView extends FieldScene {
  constructor(app, o = {}) {
    super(app, o);
    this.losX = Number.isFinite(o.losX) ? o.losX : 35;
    this.firstDownX = Number.isFinite(o.firstDownX) ? o.firstDownX : null;
    this.flip = o.offense === 'opp';
    this.showPlayers = o.showPlayers !== false;
    const offLook = this.flip ? this.oppKit : this.userKit;
    const defLook = this.flip ? this.userKit : this.oppKit;
    this.offLook = offLook;
    this.defLook = defLook;
    this.field.setTeams(this.userLook, this.oppLook);
    const hy = Number.isFinite(o.hashY) ? o.hashY : W / 2;
    this.sim = new PlaySim({
      kind: 'scrimmage',
      losX: this.flip ? 120 - this.losX : this.losX,
      firstDownX: (this.flip ? 120 - this.losX : this.losX) + 10,
      hashY: this.flip ? W - hy : hy,
      seed: o.seed ?? 7,
      offense: { look: offLook },
      defense: { look: defLook },
      difficultyStep: 6,
    });
    this._viewport();
    this.camera.leadFrac = 0.5;
    this.camera.snapTo(this.losX, hy);
    this.hashY = hy;
    this._ensureCrowd();
    // idle screens (drives, decisions) are the cheapest time to build the FG framing - once the
    // HUD insets a kick will use are known
    this.insets = o.insets || lastPlayInsets || null;
    this._prewarm(!!this.insets);
  }

  update(dt) {
    // not interactive: the owning screen keeps polling app.input itself
    this._viewport();
    this._ensureCrowd();
    this.time += dt;
    this.sim.update(dt);
    this.camera.leadFrac = 0.5;
    this.camera.follow(this.losX, this.hashY, dt, 3);
    this.fx.update(dt);
  }

  render() {
    const d = this.app.display;
    this._viewport();
    const ctx = d.begin('#000');
    const cam = this.camera;
    this.field.draw(ctx, cam, { losX: this.losX, firstDownX: this.firstDownX, time: this.time, posts: false });
    this.field.drawPosts(ctx, cam, 'behind');
    if (this.showPlayers) {
      const pl = this.sim.players;
      const list = this._list || (this._list = []);
      list.length = 0;
      for (const e of pl) list.push(e);
      const f = this.flip;
      const wx = (e) => (f ? 120 - e.x : e.x);
      const wy = (e) => (f ? W - e.y : e.y);
      list.sort((a, b) => cam.project(wx(a), wy(a), 0, P).y - cam.project(wx(b), wy(b), 0, Q).y);
      for (const e of list) {
        cam.project(wx(e), wy(e), 0, P);
        drawPlayer(ctx, P.x, P.y, e.side === 'off' ? this.offLook : this.defLook, {
          facing: cam.facingFor(f ? -e.face.x : e.face.x, f ? -e.face.y : e.face.y),
          anim: e.anim,
          t: e.animT,
          skin: skinOf(e),
        });
      }
      const b = this.sim.ball;
      cam.project(f ? 120 - b.x : b.x, f ? W - b.y : b.y, 0, P);
      drawBall(ctx, P.x, P.y, b.z, { ppy: cam.ppy, spinning: false });
    }
    this.field.drawPosts(ctx, cam, 'front');
    this.fx.render(ctx, cam);
    this._dimOverlay(ctx);
    d.present();
  }

  destroy() {
    this._stopCrowd();
  }
}
