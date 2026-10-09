// World <-> screen transform for the field. World units are YARDS:
//   x: 0..120 along the field (0-10 = offense's own end zone, 10-110 field of play,
//      110-120 = end zone being attacked). The user's offense ALWAYS attacks +x.
//   y: 0..53.33 across the field (sideline to sideline); FIELD_W/2 is the middle.
//   z: height above the turf (yards), used for the ball and jumps.
// Orientation:
//   landscape: +x -> screen right, +y -> screen down
//   portrait:  +x -> screen up,    +y -> screen right   (rotated 90deg CCW; offense's right stays right)
// `mirror` reverses the along-field axis only (landscape: +x -> screen LEFT, i.e. "drive left"; the
// camera stays on the same sideline, so +y is still screen-down). Height z always lifts toward
// screen-up. `yScale` compresses the cross-field axis slightly to fake a raised camera angle.
//
// Optional framing knobs (all backward compatible; defaults reproduce the original behaviour):
//   zoom      multiplier on pixels-per-yard (Near = 1, Far < 1)
//   fitCross  if set (yards), the base ppy is chosen so this many cross-field yards fit the
//             screen's short side, instead of the width-based default
//   ppyMax    if set, caps pixels-per-yard (e.g. to fit a whole field goal on screen)
//   marginX / marginY  how far (yards) the view may show beyond the end lines / sidelines
//   marginY0 / marginY1  optional per-side overrides of marginY for the y = 0 / y = FIELD_W
//             sideline (e.g. extra room on the side a HUD bar covers)
//   marginX0 / marginX1  likewise for the x = 0 / x = FIELD_LEN end line

import { damp } from '../core/util.js';

export const FIELD_LEN = 120;
export const FIELD_W = 160 / 3; // 53.333 yd

export class Camera {
  constructor() {
    this.orientation = 'landscape';
    this.viewW = 480;
    this.viewH = 270;
    this.ppy = 9; // virtual px per yard
    this.yScale = 0.82;
    this.cx = 30; // world point at screen centre
    this.cy = FIELD_W / 2;
    this.tx = 30;
    this.ty = FIELD_W / 2;
    this.shakeT = 0;
    this.shakeMag = 0;
    this.ox = 0;
    this.oy = 0;
    // Where (as a fraction of the view along the downfield axis) the follow target should sit.
    // 0.5 = centred; lower = target sits further "back" so you can see more field ahead.
    this.leadFrac = 0.42;
    this.mirror = false;
    this.zoom = 1;
    this.fitCross = 0;
    this.ppyMax = 0;
    this.marginX = 3;
    this.marginY = 3;
    this.marginY0 = null;
    this.marginY1 = null;
    this.marginX0 = null;
    this.marginX1 = null;
  }

  /** Update viewport size; picks pixels-per-yard so the view covers sensible field area. */
  setViewport(w, h, orientation) {
    this.viewW = w;
    this.viewH = h;
    this.orientation = orientation;
    const z = this.zoom > 0 ? this.zoom : 1;
    let base;
    if (this.fitCross > 0) {
      // fit N cross-field yards across the short side (landscape: height, portrait: width)
      base = Math.min(w, h) / (this.fitCross * this.yScale);
    } else if (orientation === 'landscape') {
      // ~44 yards visible downfield, cross-field fits most of the width
      base = w / 44;
    } else {
      // full-ish field width visible across the short side
      base = w / 40;
    }
    let ppy = Math.round(base * z);
    if (this.ppyMax > 0) ppy = Math.min(ppy, this.ppyMax);
    this.ppy = Math.max(orientation === 'landscape' ? 5 : 4, ppy);
  }

  /** Visible extents in yards along downfield (alongX) and cross-field (alongY) axes. */
  get spanX() {
    return (this.orientation === 'landscape' ? this.viewW : this.viewH) / this.ppy;
  }

  get spanY() {
    return (this.orientation === 'landscape' ? this.viewH : this.viewW) / (this.ppy * this.yScale);
  }

  /** Set follow target immediately. */
  snapTo(x, y) {
    this.tx = x; this.ty = y;
    this._clampTarget();
    this.cx = this.tx; this.cy = this.ty;
  }

  /** Smoothly follow a world point; target x is offset so more field is visible ahead. */
  follow(x, y, dt, rate = 6) {
    const ahead = (0.5 - this.leadFrac) * this.spanX;
    this.tx = x + ahead;
    this.ty = y;
    this._clampTarget();
    const k = damp(rate, dt);
    this.cx += (this.tx - this.cx) * k;
    this.cy += (this.ty - this.cy) * k;
    this.updateShake(dt);
  }

  /** Advance the cosmetic camera shake (called by follow()). */
  updateShake(dt) {
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      const m = this.shakeMag * Math.max(0, this.shakeT) * 4;
      this.ox = (Math.random() - 0.5) * m; // cosmetic only
      this.oy = (Math.random() - 0.5) * m;
    } else {
      this.ox = 0; this.oy = 0;
    }
  }

  _clampTarget() {
    const hx = this.spanX / 2;
    const hy = this.spanY / 2;
    const mx0 = this.marginX0 ?? this.marginX;
    const mx1 = this.marginX1 ?? this.marginX;
    const my0 = this.marginY0 ?? this.marginY;
    const my1 = this.marginY1 ?? this.marginY;
    if (this.spanX >= FIELD_LEN + mx0 + mx1) this.tx = (FIELD_LEN + mx1 - mx0) / 2;
    else this.tx = Math.min(Math.max(this.tx, -mx0 + hx), FIELD_LEN + mx1 - hx);
    if (this.spanY >= FIELD_W + my0 + my1) this.ty = (FIELD_W + my1 - my0) / 2;
    else this.ty = Math.min(Math.max(this.ty, -my0 + hy), FIELD_W + my1 - hy);
  }

  shake(mag = 2, time = 0.25) {
    this.shakeMag = mag;
    this.shakeT = time;
  }

  /**
   * World (yards) -> screen (virtual px), written into `out` (no allocation).
   * @param {number} x @param {number} y @param {number} z @param {{x:number,y:number}} out
   */
  project(x, y, z, out) {
    const p = this.ppy;
    const dx = (x - this.cx) * p * (this.mirror ? -1 : 1);
    const dy = (y - this.cy) * p * this.yScale;
    const lift = (z || 0) * p;
    if (this.orientation === 'landscape') {
      out.x = this.viewW / 2 + dx + this.ox;
      out.y = this.viewH / 2 + dy - lift + this.oy;
    } else {
      out.x = this.viewW / 2 + dy + this.ox;
      out.y = this.viewH / 2 - dx - lift + this.oy;
    }
    return out;
  }

  /** World (yards) -> screen (virtual px). */
  toScreen(x, y, z = 0) {
    return this.project(x, y, z, { x: 0, y: 0 });
  }

  /** Screen (virtual px) -> world (yards) on the ground plane (z = 0). */
  toWorld(sx, sy) {
    const p = this.ppy;
    const m = this.mirror ? -1 : 1;
    if (this.orientation === 'landscape') {
      return { x: this.cx + (m * (sx - this.viewW / 2 - this.ox)) / p, y: this.cy + (sy - this.viewH / 2 - this.oy) / (p * this.yScale) };
    }
    return { x: this.cx - (m * (sy - this.viewH / 2 - this.oy)) / p, y: this.cy + (sx - this.viewW / 2 - this.ox) / (p * this.yScale) };
  }

  /** Screen delta (virtual px) -> world delta (yards). */
  deltaToWorld(dsx, dsy) {
    const p = this.ppy;
    const m = this.mirror ? -1 : 1;
    if (this.orientation === 'landscape') return { x: (m * dsx) / p, y: dsy / (p * this.yScale) };
    return { x: (-m * dsy) / p, y: dsx / (p * this.yScale) };
  }

  /**
   * World ground direction/delta -> screen delta (virtual px), into `out` (allocates if omitted).
   * Useful for "which way is downfield on screen" (worldDirToScreen(1, 0)).
   */
  worldDirToScreen(wx, wy, out = { x: 0, y: 0 }) {
    const p = this.ppy;
    const ax = wx * p * (this.mirror ? -1 : 1);
    const ay = wy * p * this.yScale;
    if (this.orientation === 'landscape') { out.x = ax; out.y = ay; } else { out.x = ay; out.y = -ax; }
    return out;
  }

  /** World direction -> sprite facing for 4-direction sprites. Returns 'right'|'left'|'up'|'down'. */
  facingFor(wx, wy) {
    // convert direction to screen space
    const m = this.mirror ? -1 : 1;
    let sx, sy;
    if (this.orientation === 'landscape') { sx = m * wx; sy = wy * this.yScale; } else { sx = wy * this.yScale; sy = -m * wx; }
    if (Math.abs(sx) >= Math.abs(sy)) return sx >= 0 ? 'right' : 'left';
    return sy >= 0 ? 'down' : 'up';
  }

  /** Is a world point roughly on screen (with margin in px)? */
  visible(x, y, margin = 24) {
    const s = this.toScreen(x, y);
    return s.x > -margin && s.y > -margin && s.x < this.viewW + margin && s.y < this.viewH + margin;
  }
}
