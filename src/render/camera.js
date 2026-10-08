// World <-> screen transform for the field. World units are YARDS:
//   x: 0..120 along the field (0-10 = offense's own end zone, 10-110 field of play,
//      110-120 = end zone being attacked). The user's offense ALWAYS attacks +x.
//   y: 0..53.33 across the field (sideline to sideline); FIELD_W/2 is the middle.
//   z: height above the turf (yards), used for the ball and jumps.
// Orientation:
//   landscape: +x -> screen right, +y -> screen down
//   portrait:  +x -> screen up,    +y -> screen right   (rotated 90deg CCW; offense's right stays right)
// Height z always lifts toward screen-up. `yScale` compresses the cross-field axis slightly to fake a
// raised camera angle.

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
  }

  /** Update viewport size; picks pixels-per-yard so the view covers sensible field area. */
  setViewport(w, h, orientation) {
    this.viewW = w;
    this.viewH = h;
    this.orientation = orientation;
    if (orientation === 'landscape') {
      // ~44 yards visible downfield, cross-field fits most of the width
      this.ppy = Math.max(5, Math.round(w / 44));
    } else {
      // full-ish field width visible across the short side
      this.ppy = Math.max(4, Math.round(w / 40));
    }
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
    const margin = 3; // allow seeing a little beyond the end lines / sidelines
    this.tx = Math.min(Math.max(this.tx, -margin + hx), FIELD_LEN + margin - hx);
    if (this.spanY >= FIELD_W + 2 * margin) this.ty = FIELD_W / 2;
    else this.ty = Math.min(Math.max(this.ty, -margin + hy), FIELD_W + margin - hy);
  }

  shake(mag = 2, time = 0.25) {
    this.shakeMag = mag;
    this.shakeT = time;
  }

  /** World (yards) -> screen (virtual px). */
  toScreen(x, y, z = 0) {
    const p = this.ppy;
    const dx = (x - this.cx) * p;
    const dy = (y - this.cy) * p * this.yScale;
    const lift = z * p;
    if (this.orientation === 'landscape') {
      return { x: this.viewW / 2 + dx + this.ox, y: this.viewH / 2 + dy - lift + this.oy };
    }
    return { x: this.viewW / 2 + dy + this.ox, y: this.viewH / 2 - dx - lift + this.oy };
  }

  /** Screen (virtual px) -> world (yards) on the ground plane (z = 0). */
  toWorld(sx, sy) {
    const p = this.ppy;
    if (this.orientation === 'landscape') {
      return { x: this.cx + (sx - this.viewW / 2 - this.ox) / p, y: this.cy + (sy - this.viewH / 2 - this.oy) / (p * this.yScale) };
    }
    return { x: this.cx - (sy - this.viewH / 2 - this.oy) / p, y: this.cy + (sx - this.viewW / 2 - this.ox) / (p * this.yScale) };
  }

  /** Screen delta (virtual px) -> world delta (yards). */
  deltaToWorld(dsx, dsy) {
    const p = this.ppy;
    if (this.orientation === 'landscape') return { x: dsx / p, y: dsy / (p * this.yScale) };
    return { x: -dsy / p, y: dsx / (p * this.yScale) };
  }

  /** World direction -> sprite facing for 4-direction sprites. Returns 'right'|'left'|'up'|'down'. */
  facingFor(wx, wy) {
    // convert direction to screen space
    let sx, sy;
    if (this.orientation === 'landscape') { sx = wx; sy = wy * this.yScale; } else { sx = wy * this.yScale; sy = -wx; }
    if (Math.abs(sx) >= Math.abs(sy)) return sx >= 0 ? 'right' : 'left';
    return sy >= 0 ? 'down' : 'up';
  }

  /** Is a world point roughly on screen (with margin in px)? */
  visible(x, y, margin = 24) {
    const s = this.toScreen(x, y);
    return s.x > -margin && s.y > -margin && s.x < this.viewW + margin && s.y < this.viewH + margin;
  }
}
