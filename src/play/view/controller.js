// On-field controls: raw pointer / keyboard / gamepad events (src/core/input.js) -> PlaySim
// commands (MECHANICS 2.3-2.4, 3.1, 4.1, 4.3). All gesture geometry is done in CSS px on SCREEN
// axes and classified RELATIVE TO THE DRIVE DIRECTION for the current orientation / mirror, so
// the same code serves portrait (drive up), landscape drive-right and landscape drive-left.
//
//   pre-snap   tap on / near the RB ............... handoff()
//              drag (not clearly forward) ......... dropBack(), then slingshot aiming
//   aiming     target = QB - drag(world) * scale .. aimAt() every tick (QB-relative slingshot)
//              drag forward past the anchor ....... aimRunMode(true)  (QB run icon)
//              2nd finger / right-click / B ....... toggleBullet()
//              lift ............................... release()  (tuck & run in run mode)
//              pointer cancel ..................... aimCancel()
//   carrier    flick sideways ..................... sideStep(world dir)
//              flick forward / backward ........... dive() / stutter()  (stutter in own EZ on a
//                                                   kick return = touchback)
//              press & hold still ................. truck(true) until lift (the hold counts from
//                                                   when the runner has the ball)
//              a 2nd thumb landing ................ takes over the gesture (two-thumb play: the
//                                                   resting thumb no longer swallows the swipe)
//   kicks      tap / click / Space / Enter ........ kickTap()  (fires on press for timing; a tap
//                                                   with the other thumb counts too)
//   after the whistle: tap / click / Space / Enter skips the post-play beat.
// Keyboard: H/Enter handoff, Space drop back | kick tap | hold = truck, R tuck, B bullet,
// arrows/WASD by SCREEN direction (lateral = juke, holding drifts; forward = dive; back = stutter).
// Gamepad (via Input's mapped codes): A handoff/dive/kick, X drop back/truck, B bullet/stutter, Y tuck,
// stick / d-pad like the arrow keys.

/** Feel tuning (CSS px / ms / s). */
export const CONTROL = {
  dragStartPx: 9, // press -> drag (pre-snap drop back) after moving this far
  rbDragStartPx: 20, // ... when the press landed on the RB (a sloppy tap must not become a drop back)
  dropBackFwd: 0.35, // a pre-snap drag snaps unless its forward share exceeds this (clearly forward)
  rbHitPx: 30, // generous radius around the RB sprite box that counts as "tap the RB"
  tapMaxMs: 600,
  tapMaxPx: 20, // finger travel still accepted as a tap on the RB
  aimComfortFrac: 0.42, // longest comfortable drag = frac * short side (CSS px) -> max arm distance
  aimComfortMin: 130,
  aimComfortMax: 300,
  aimCurve: 1.0, // 1 = linear drag -> distance; > 1 = finer control on short throws
  runModePx: 10, // forward drag beyond the anchor that collapses the aim into a QB run
  runModeExitPx: 3,
  swipePx: 20, // flick distance that triggers a carrier move ...
  swipeWindowMs: 300, // ... measured over this sliding window
  releaseSwipePx: 12, // shorter flick accepted when the finger lifts, if fast enough
  releaseSwipeSpeed: 220, // CSS px / s
  lateralBias: 0.7, // |lateral| >= bias * |forward| -> side-step (dive / stutter need a clear line)
  sameDirMs: 450, // a second move in the same direction within one touch needs this much time
  zigzagMs: 90, // a direction reversal within one touch may fire again after this
  holdMs: 260, // press-and-hold without moving -> truck (shorter reads a resting thumb as a truck)
  holdMovePx: 10,
  meshBufferS: 0.8, // carrier moves made during the handoff mesh (<= 0.75 s) land when the RB gets the ball
  keyDriftMs: 200, // holding a lateral key longer than this drifts
  skipDelay: 0.25, // s after the whistle before a tap / key skips the post-play beat
};

const KEY_VEC = {
  ArrowUp: [0, -1], KeyW: [0, -1],
  ArrowDown: [0, 1], KeyS: [0, 1],
  ArrowLeft: [-1, 0], KeyA: [-1, 0],
  ArrowRight: [1, 0], KeyD: [1, 0],
};

const HIST = 48; // swipe history samples (covers the swipe window even at 120-160 Hz touch rates)

export class Controller {
  /** @param {import('./PlayView.js').PlayView} view */
  constructor(view) {
    this.view = view;
    this.g = null; // active pointer gesture
    this.buffered = null; // {kind, dir, t}
    this.latKeys = new Map(); // code -> {dir, t0, drift}
    this.drifting = 0;
    this.keyTruck = false;
    this.lastPhase = '';
    // swipe history ring (CSS px, ms)
    this.hx = new Float64Array(HIST);
    this.hy = new Float64Array(HIST);
    this.ht = new Float64Array(HIST);
    this.hn = 0;
    this.hi = 0;
    this._cls = { kind: '', dir: 0 };
    this.log = []; // last commands (debug / tests): [{cmd, t}]
  }

  get sim() {
    return this.view.sim;
  }

  /** Forget the current gesture / held keys (pause, play change). */
  reset() {
    const sim = this.sim;
    const g = this.g;
    if (g && g.mode === 'aim' && sim.phase === 'dropback') sim.aimCancel();
    if ((g && g.truck) || this.keyTruck) sim.truck(false);
    if (this.drifting) sim.drift(0);
    this.g = null;
    this.buffered = null;
    this.latKeys.clear();
    this.drifting = 0;
    this.keyTruck = false;
  }

  _note(cmd) {
    this.log.push({ cmd, t: this.sim.t });
    if (this.log.length > 40) this.log.shift();
  }

  // ------------------------------------------------------------------ geometry

  /**
   * Classify a SCREEN vector (CSS px) relative to the drive direction.
   * Writes {kind:'lat'|'fwd'|'back', dir} into this._cls (dir = WORLD y sign for 'lat').
   */
  classify(dx, dy) {
    const F = this.view.screenFwd;
    const L = this.view.screenLat;
    const f = dx * F.x + dy * F.y;
    const l = dx * L.x + dy * L.y;
    const c = this._cls;
    if (Math.abs(l) >= CONTROL.lateralBias * Math.abs(f)) {
      c.kind = 'lat';
      c.dir = l >= 0 ? 1 : -1;
    } else {
      c.kind = f > 0 ? 'fwd' : 'back';
      c.dir = 0;
    }
    return c;
  }

  /** Forward component (CSS px) of a screen vector. */
  fwdOf(dx, dy) {
    const F = this.view.screenFwd;
    return dx * F.x + dy * F.y;
  }

  /**
   * The screen rotated (or the drive flipped) under a held finger: its drag no longer means what
   * it did - drop it instead of throwing / juking somewhere unintended on lift.
   */
  _checkOrient() {
    const g = this.g;
    if (!g || g.orient === this._orientKey()) return;
    const sim = this.sim;
    if (g.mode === 'aim' && sim.phase === 'dropback') {
      sim.aimCancel();
      this._note('aimCancel');
    }
    if (g.truck) sim.truck(false);
    this.g = null;
  }

  /** Screen orientation + mirror the current gesture was made in. */
  _orientKey() {
    const cam = this.view.camera;
    return cam.orientation === 'landscape' ? (cam.mirror ? 'L-' : 'L+') : 'P';
  }

  _carryPhase() {
    const sim = this.sim;
    return sim.phase === 'carry' || sim.phase === 'return';
  }

  _userCarrying() {
    const sim = this.sim;
    if (sim.phase === 'return') return true;
    if (sim.phase !== 'carry') return false;
    if (sim.carrier) return sim.carrier.side === 'off' && sim.carrier.controlled;
    return sim.controlledId === 'RB'; // handoff mesh
  }

  // ------------------------------------------------------------------ event entry

  /** @param {any[]} events from Input.poll() */
  handle(events) {
    this._checkOrient();
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      switch (ev.type) {
        case 'down': this._down(ev); break;
        case 'move': if (!this.g || !this.g.sec) this._move(ev); break;
        case 'up': if (!this.g || !this.g.sec) this._up(ev); break;
        case 'cancel': if (!this.g || !this.g.sec) this._cancel(); break;
        case 'pointer2': this._pointer2(ev); break;
        case 'move2': if (this.g && this.g.sec && this.g.id === ev.id) this._move(ev); break;
        case 'up2': if (this.g && this.g.sec && this.g.id === ev.id) (ev.cancel ? this._cancel() : this._up(ev)); break;
        case 'key': this._key(ev); break;
        default: break;
      }
    }
  }

  /** Per-tick work after the events: re-aim, hold-to-truck, key drift, buffered moves. */
  tick(now) {
    const sim = this.sim;
    if (sim.phase !== this.lastPhase) {
      // phase change: carry over an ongoing touch into the new phase
      const g = this.g;
      if (g && this._carryPhase() && this._userCarrying()) {
        // a finger held through the catch becomes a carrier gesture; an aim gesture ends
        if (g.mode === 'wait') this._toCarry(g, now);
        else if (g.mode === 'aim' || g.mode === 'pending') g.mode = 'none';
      }
      if (g && sim.phase === 'dropback' && g.mode === 'pending') g.mode = 'aim';
      if (this.lastPhase === 'dropback' || sim.phase === 'dead') {
        this.latKeys.clear();
        this.drifting = 0;
      }
      this.lastPhase = sim.phase;
    }
    this._checkOrient();
    if (sim.carrier !== this._carrier) {
      // the runner just got the ball (handoff, catch, kick return): a finger already resting on the
      // glass starts its press-and-hold count now, so it doesn't truck the instant he has it
      this._carrier = sim.carrier;
      const g0 = this.g;
      if (g0 && g0.mode === 'carry' && !g0.truck) {
        g0.t0 = now;
        g0.x0 = g0.x;
        g0.y0 = g0.y;
        g0.maxMove = 0;
      }
    }
    const g = this.g;
    if (g && g.mode === 'aim' && g.aimed && !g.run && sim.phase === 'dropback') this._applyAim(g);
    if (g && g.mode === 'carry' && !g.truck && !g.fired && g.maxMove < CONTROL.holdMovePx
      && now - g.t0 >= CONTROL.holdMs && sim.carrier && this._userCarrying()) {
      sim.truck(true);
      g.truck = true;
      this._note('truck');
    }
    // keyboard drift
    if (this.latKeys.size && this._userCarrying()) {
      let d = 0;
      for (const k of this.latKeys.values()) {
        if (!k.drift && now - k.t0 >= CONTROL.keyDriftMs) k.drift = true;
        if (k.drift) d += k.dir;
      }
      d = Math.sign(d);
      if (d !== this.drifting) {
        this.drifting = d;
        sim.drift(d);
      }
    }
    // a move made during the handoff mesh lands once the RB has the ball
    const b = this.buffered;
    if (b) {
      if (sim.carrier && sim.phase === 'carry') {
        this.buffered = null;
        if (sim.t - b.t <= CONTROL.meshBufferS) this._fire(b.kind, b.dir);
      } else if (sim.phase !== 'carry') this.buffered = null;
    }
  }

  // ------------------------------------------------------------------ pointer

  _down(ev) {
    this._begin(ev, false);
  }

  /** Start a gesture for a pointer (`sec` = a secondary touch taking over from a resting thumb). */
  _begin(ev, sec) {
    const sim = this.sim;
    const v = this.view;
    if (sim.phase === 'dead') {
      v.trySkip();
      return;
    }
    const g = {
      x0: ev.x, y0: ev.y, x: ev.x, y: ev.y, t0: ev.t, mode: 'none', onRB: false, maxMove: 0, id: ev.id, sec,
      orient: this._orientKey(),
      aimed: false, run: false, truck: false, fired: false, lastKind: '', lastDir: 0, firedT: 0, anchorT: ev.t,
    };
    this.hn = 0;
    this._hist(ev.x, ev.y, ev.t);
    if (sim.kind === 'fg' || sim.kind === 'pat') {
      this._kickTap();
    } else if (sim.phase === 'presnap') {
      g.mode = 'pending';
      g.onRB = v.hitRB(ev.x, ev.y);
    } else if (sim.phase === 'dropback') {
      g.mode = 'aim';
    } else if (this._carryPhase() && this._userCarrying()) {
      g.mode = 'carry';
    } else {
      g.mode = 'wait'; // e.g. ball in the air: becomes a carrier gesture on the catch
    }
    this.g = g;
  }

  _hist(x, y, t) {
    this.hi = (this.hi + 1) % HIST;
    this.hx[this.hi] = x;
    this.hy[this.hi] = y;
    this.ht[this.hi] = t;
    if (this.hn < HIST) this.hn++;
  }

  _move(ev) {
    const g = this.g;
    if (!g) return;
    g.x = ev.x;
    g.y = ev.y;
    const d = Math.hypot(ev.x - g.x0, ev.y - g.y0);
    if (d > g.maxMove) g.maxMove = d;
    this._hist(ev.x, ev.y, ev.t);
    const sim = this.sim;
    switch (g.mode) {
      case 'pending':
        if (d >= (g.onRB ? CONTROL.rbDragStartPx : CONTROL.dragStartPx)) {
          const fwd = this.fwdOf(ev.x - g.x0, ev.y - g.y0);
          if (fwd <= CONTROL.dropBackFwd * d && sim.dropBack()) {
            this._note('dropBack');
            this.view.noteTip('snap');
            g.mode = 'aim';
            this._aim(g);
          }
        }
        break;
      case 'aim':
        this._aim(g);
        break;
      case 'carry':
        this._swipe(g, ev.t, false);
        break;
      default:
        break;
    }
  }

  _up(ev) {
    const g = this.g;
    this.g = null;
    if (!g) return;
    const sim = this.sim;
    if (ev) {
      g.x = ev.x;
      g.y = ev.y;
      this._hist(ev.x, ev.y, ev.t);
    }
    switch (g.mode) {
      case 'pending':
        if (g.onRB && g.maxMove <= CONTROL.tapMaxPx && (ev ? ev.t - g.t0 : 0) <= CONTROL.tapMaxMs && sim.handoff()) {
          this._note('handoff');
          this.view.noteTip('snap');
        }
        break;
      case 'aim':
        if (sim.phase !== 'dropback') break;
        if (g.run) {
          sim.aimRunMode(true);
          if (sim.release()) this._note('tuck');
        } else if (g.aimed && sim.aim) {
          this._applyAim(g);
          const valid = sim.aim && sim.aim.valid;
          if (sim.release()) {
            this._note('throw');
            if (valid) this.view.noteTip('pass');
          }
        }
        break;
      case 'carry':
        if (g.truck) {
          sim.truck(false);
          this._note('truckOff');
        } else if (!g.fired && ev) this._swipe(g, ev.t, true);
        break;
      default:
        break;
    }
  }

  _cancel() {
    const g = this.g;
    this.g = null;
    if (!g) return;
    const sim = this.sim;
    if (g.mode === 'aim' && sim.phase === 'dropback') {
      sim.aimCancel();
      this._note('aimCancel');
    }
    if (g.truck) sim.truck(false);
  }

  /** A second touch (or the right mouse button) while the primary pointer is held. */
  _pointer2(ev) {
    const sim = this.sim;
    if (sim.phase === 'dropback') {
      sim.toggleBullet();
      this._note('bullet');
      this.view.noteBullet();
      return;
    }
    if (sim.kind === 'fg' || sim.kind === 'pat') {
      // tapping power with one thumb and aim with the other (first thumb still down)
      if (sim.phase !== 'dead') this._kickTap();
      else this.view.trySkip();
      return;
    }
    if (sim.phase === 'dead') {
      this.view.trySkip();
      return;
    }
    // ball carrier / returner / ball in the air: the new thumb takes over the gesture
    if (sim.phase === 'presnap' || !ev || ev.id == null || ev.button > 0) return;
    const g = this.g;
    if (g && g.truck) {
      sim.truck(false);
      this._note('truckOff');
    }
    this.g = null;
    this._begin(ev, true);
  }

  _toCarry(g, now) {
    g.mode = 'carry';
    g.x0 = g.x;
    g.y0 = g.y;
    g.t0 = now;
    g.anchorT = now;
    g.maxMove = 0;
    g.fired = false;
    g.lastKind = '';
    this.hn = 0;
    this._hist(g.x, g.y, now);
  }

  // ------------------------------------------------------------------ aiming

  _aim(g) {
    const sim = this.sim;
    if (sim.phase !== 'dropback') return;
    const dx = g.x - g.x0;
    const dy = g.y - g.y0;
    const fwd = this.fwdOf(dx, dy);
    if (!g.run && fwd > CONTROL.runModePx) {
      g.run = true;
      sim.aimRunMode(true);
      this._note('runMode');
      return;
    }
    if (g.run) {
      if (fwd >= CONTROL.runModeExitPx) return;
      g.run = false;
      sim.aimRunMode(false);
    }
    if (Math.hypot(dx, dy) < 2) return;
    g.aimed = true;
    this._applyAim(g);
  }

  /** Slingshot: target = QB - drag * scale, re-anchored to the QB every tick. */
  _applyAim(g) {
    const sim = this.sim;
    const qb = sim.qb;
    if (!qb) return;
    const v = this.view;
    const d = v.app.display;
    const k = d.dpr / d.scale; // CSS -> virtual px
    const dx = g.x - g.x0;
    const dy = g.y - g.y0;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return;
    const comfort = Math.max(CONTROL.aimComfortMin, Math.min(CONTROL.aimComfortMax, Math.min(d.cssW, d.cssH) * CONTROL.aimComfortFrac));
    // shape the length (optional curve), keep the direction
    const u = len / comfort;
    const shaped = (CONTROL.aimCurve === 1 ? u : Math.sign(u) * Math.pow(Math.abs(u), CONTROL.aimCurve)) * comfort;
    const f = shaped / len;
    const w = v.camera.deltaToWorld(dx * f * k, dy * f * k);
    const comfortYds = (comfort * k) / v.camera.ppy;
    const scale = sim.maxThrowDist() / comfortYds;
    sim.aimAt(qb.x - w.x * scale, qb.y - w.y * scale);
  }

  // ------------------------------------------------------------------ carrier swipes

  _swipe(g, t, atRelease) {
    // displacement over the recent window (but only since the last fired move). The origin is
    // where the finger was AT the window start: the last sample at or before it (a finger resting
    // at the turn of a zigzag sends no moves, so the turn point may be older than the window)
    const since = Math.max(g.anchorT, t - CONTROL.swipeWindowMs);
    let ox = g.x;
    let oy = g.y;
    let ot = t;
    for (let i = 0; i < this.hn; i++) {
      const j = (this.hi - i + HIST) % HIST;
      ox = this.hx[j];
      oy = this.hy[j];
      ot = this.ht[j];
      if (this.ht[j] <= since) break;
    }
    const dx = g.x - ox;
    const dy = g.y - oy;
    const dist = Math.hypot(dx, dy);
    let ok = dist >= CONTROL.swipePx;
    if (!ok && atRelease) {
      const dt = Math.max(16, t - ot) / 1000;
      ok = dist >= CONTROL.releaseSwipePx && dist / dt >= CONTROL.releaseSwipeSpeed;
    }
    if (!ok) return;
    const c = this.classify(dx, dy);
    if (g.fired) {
      const same = c.kind === g.lastKind && c.dir === g.lastDir;
      if (same && t - g.firedT < CONTROL.sameDirMs) return;
      if (!same && t - g.firedT < CONTROL.zigzagMs) return;
    }
    if (g.truck) {
      this.sim.truck(false);
      g.truck = false;
    }
    g.fired = true;
    g.lastKind = c.kind;
    g.lastDir = c.dir;
    g.firedT = t;
    g.anchorT = t;
    this._fire(c.kind, c.dir);
  }

  /** Issue a carrier move ('lat' | 'fwd' | 'back'). */
  _fire(kind, dir) {
    const sim = this.sim;
    if (sim.phase === 'carry' && !sim.carrier) {
      // handoff mesh: the RB doesn't have the ball yet
      this.buffered = { kind, dir, t: sim.t };
      return;
    }
    let ok = false;
    if (kind === 'lat') ok = sim.sideStep(dir);
    else if (kind === 'fwd') ok = sim.dive();
    else ok = sim.stutter();
    if (ok) {
      this._note(kind === 'lat' ? `juke${dir > 0 ? '+' : '-'}` : kind === 'fwd' ? 'dive' : 'stutter');
      this.view.noteTip('carry');
    }
  }

  /** FG / PAT tap: 1st locks power (and snaps), 2nd locks the aim (click feedback). */
  _kickTap() {
    const sim = this.sim;
    if (!sim.kickTap()) return;
    this._note('kickTap');
    this.view.noteTip('kick');
    if (sim.kick && sim.kick.aimLocked) this.view.app.sfx('click');
  }

  // ------------------------------------------------------------------ keyboard / gamepad

  _key(ev) {
    const sim = this.sim;
    const v = this.view;
    const code = ev.code;
    const down = ev.down;
    const fresh = down && !ev.repeat;
    if (sim.phase === 'dead') {
      if (fresh && (code === 'Space' || code === 'Enter' || code === 'NumpadEnter' || code === 'PadA')) v.trySkip();
      if (!down && (code === 'Space' || code === 'PadX')) this.keyTruck = false;
      return;
    }
    if (sim.kind === 'fg' || sim.kind === 'pat') {
      if (fresh && (code === 'Space' || code === 'Enter' || code === 'NumpadEnter' || code === 'PadA')) this._kickTap();
      return;
    }
    if (sim.phase === 'presnap') {
      if (!fresh) return;
      if ((code === 'KeyH' || code === 'Enter' || code === 'NumpadEnter' || code === 'PadA') && sim.handoff()) {
        this._note('handoff');
        v.noteTip('snap');
      } else if ((code === 'Space' || code === 'PadX') && sim.dropBack()) {
        this._note('dropBack');
        v.noteTip('snap');
        if (this.g && this.g.mode === 'pending') this.g.mode = 'aim';
      }
      return;
    }
    if (sim.phase === 'dropback') {
      if (!fresh) return;
      if (code === 'KeyR' || code === 'PadY') {
        const g = this.g;
        if (g && g.mode === 'aim') {
          sim.aimRunMode(true);
          sim.release();
          g.mode = 'none';
        } else sim.tuck();
        this._note('tuck');
      } else if (code === 'KeyB' || code === 'PadB') {
        sim.toggleBullet();
        this._note('bullet');
        v.noteBullet();
      }
      return;
    }
    if (!this._carryPhase()) return;
    // carrier (or returner waiting for the kick)
    const vec = KEY_VEC[code];
    if (vec) {
      if (fresh) {
        const c = this.classify(vec[0], vec[1]);
        if (c.kind === 'lat') this.latKeys.set(code, { dir: c.dir, t0: performance.now(), drift: false });
        this._fire(c.kind, c.dir);
      } else if (!down && this.latKeys.has(code)) {
        this.latKeys.delete(code);
        if (!this.latKeys.size && this.drifting) {
          this.drifting = 0;
          sim.drift(0);
        }
      }
      return;
    }
    if (code === 'Space' || code === 'PadX') {
      if (fresh && !this.keyTruck) {
        this.keyTruck = true;
        sim.truck(true);
        this._note('truck');
      } else if (!down && this.keyTruck) {
        this.keyTruck = false;
        sim.truck(false);
        this._note('truckOff');
      }
      return;
    }
    if (fresh && code === 'PadA') this._fire('fwd', 0);
    else if (fresh && code === 'PadB') this._fire('back', 0);
  }
}
