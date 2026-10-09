// Field renderer (original pixel-art look) for both orientations.
//
// The static field (turf stripes, lines, hashes, numbers, end zones, apron, wall, stands) is
// pre-rendered once per (orientation, mirror, ppy, yScale, teams) into an offscreen canvas laid
// out in SCREEN orientation, so text reads upright (also when the camera is mirrored for a drive
// to the left) and each frame is a single cropped blit. The crowd is
// a few precomputed opaque stand strips (one per bob frame) blitted over the stands area. The
// line of scrimmage, first-down line and goal posts are drawn live on top.

import { FIELD_LEN, FIELD_W } from './camera.js';
import { drawText, measureText } from './font.js';
import { darken, lighten, luma, SKIN_TONES } from './sprites.js';

/** @typedef {import('../types.js').TeamLook} TeamLook */

const PAD = 8; // yards of surroundings pre-rendered beyond each sideline
const PAD_X = 13; // ... and beyond each end line (portrait kicks look past the uprights)
const CACHE_SIZE = 3; // pre-renders kept (normal zoom + the wider field-goal framing + one spare)
const BORDER = 0.35; // white boundary band (yards)
const APRON = 0.65; // sideline/end-line apron between the border and the wall
const WALL = 0.45; // padded wall
const STANDS = BORDER + APRON + WALL; // where the crowd starts (yards beyond the edge)
const CROWD_FRAMES = 3;
const CROWD_FPS = 3.5;

export const HASH_Y = [23.58, 29.75];

/** Field palette (exported so other modules can match the look). */
export const FIELD_COLORS = {
  turfA: '#3c9a48',
  turfB: '#348a40',
  apron: '#2a7135',
  line: '#f4f4ee',
  wall: '#20283d',
  wallTop: '#3a4766',
  wallBot: '#141a29',
  stands: '#1b2030',
  standsStep: '#252c40',
  standsEdge: '#121622',
  los: '#3f86ff',
  firstDown: '#ffd23a',
  post: '#ffd23a',
  postShade: '#c3950f',
  postOutline: '#3a2c06',
};

const DEFAULT_HOME = { abbr: 'HOM', city: 'Home', primary: '#1952b8', secondary: '#fdd835', helmet: '#1952b8' };
const DEFAULT_AWAY = { abbr: 'AWY', city: 'Away', primary: '#c62828', secondary: '#f0f0f0', helmet: '#c62828' };

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

/** Small deterministic hash -> [0,1) (static art must not change between rebuilds). */
function hash2(a, b) {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function hexRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * World->canvas mapping for a pre-render (screen-oriented).
 * landscape: +x right, +y down. portrait: +x up, +y right. `mirror` reverses the x axis.
 */
class Mapper {
  constructor(orientation, ppy, yScale, mirror = false) {
    this.o = orientation;
    this.ppy = ppy;
    this.ys = yScale;
    this.mirror = !!mirror;
    this.X0 = -PAD_X;
    this.X1 = FIELD_LEN + PAD_X;
    this.Y0 = -PAD;
    this.Y1 = FIELD_W + PAD;
    const lenPx = Math.round((this.X1 - this.X0) * ppy);
    const widPx = Math.round((this.Y1 - this.Y0) * ppy * yScale);
    if (orientation === 'landscape') { this.w = lenPx; this.h = widPx; } else { this.w = widPx; this.h = lenPx; }
  }

  /** along-field coordinate in px (canvas axis depends on orientation) */
  ax(x) {
    // landscape: x grows rightward (leftward when mirrored); portrait: x grows upward (downward)
    const fwd = (this.o === 'landscape') !== this.mirror;
    return fwd ? Math.round((x - this.X0) * this.ppy) : Math.round((this.X1 - x) * this.ppy);
  }

  /** World x that sits at canvas coordinate 0 along the field axis. */
  originX() {
    return (this.o === 'landscape') !== this.mirror ? this.X0 : this.X1;
  }

  /** Screen direction ('left'|'right'|'up'|'down') of decreasing world x (toward the own goal). */
  ownDir() {
    if (this.o === 'landscape') return this.mirror ? 'right' : 'left';
    return this.mirror ? 'up' : 'down';
  }

  /** cross-field coordinate in px */
  ay(y) {
    return Math.round((y - this.Y0) * this.ppy * this.ys);
  }

  /** world point -> canvas {x, y} */
  pt(x, y) {
    return this.o === 'landscape' ? { x: this.ax(x), y: this.ay(y) } : { x: this.ay(y), y: this.ax(x) };
  }

  /** world rect -> canvas rect {x, y, w, h} */
  rect(x0, x1, y0, y1) {
    const a0 = this.ax(x0);
    const a1 = this.ax(x1);
    const b0 = this.ay(y0);
    const b1 = this.ay(y1);
    const ax = Math.min(a0, a1);
    const aw = Math.abs(a1 - a0);
    if (this.o === 'landscape') return { x: ax, y: b0, w: aw, h: b1 - b0 };
    return { x: b0, y: ax, w: b1 - b0, h: aw };
  }

  fill(g, color, x0, x1, y0, y1) {
    const r = this.rect(x0, x1, y0, y1);
    if (r.w <= 0 || r.h <= 0) return;
    g.fillStyle = color;
    g.fillRect(r.x, r.y, r.w, r.h);
  }

  /** A line ACROSS the field at world x (yard line) spanning y0..y1, `t` px thick, centred. */
  across(g, color, x, y0, y1, t = 1) {
    const a = this.ax(x) - Math.floor(t / 2);
    const b0 = this.ay(y0);
    const b1 = this.ay(y1);
    g.fillStyle = color;
    if (this.o === 'landscape') g.fillRect(a, b0, t, b1 - b0);
    else g.fillRect(b0, a, b1 - b0, t);
  }

  /** A line ALONG the field at world y spanning x0..x1, `t` px thick. */
  along(g, color, y, x0, x1, t = 1) {
    const b = this.ay(y) - Math.floor(t / 2);
    const a0 = Math.min(this.ax(x0), this.ax(x1));
    const a1 = Math.max(this.ax(x0), this.ax(x1));
    g.fillStyle = color;
    if (this.o === 'landscape') g.fillRect(a0, b, a1 - a0, t);
    else g.fillRect(b, a0, t, a1 - a0);
  }
}

function lookKey(l) {
  return `${l.city}|${l.primary}|${l.secondary}|${l.helmet}`;
}

/** Pick a readable text colour for an end zone filled with `fill`. */
function endZoneInk(look) {
  const fill = look.primary;
  const cand = [look.secondary, look.helmet, '#ffffff', '#141414'];
  let best = cand[0];
  let bestD = -1;
  for (const c of cand) {
    const d = Math.abs(luma(c) - luma(fill));
    if (d > bestD + 0.12) { best = c; bestD = d; }
  }
  return best;
}

export class FieldRenderer {
  constructor() {
    this.home = DEFAULT_HOME;
    this.away = DEFAULT_AWAY;
    this._key = '';
    this._static = null;
    this._crowd = null; // [{x, y, frames:[canvas]}]
    this._map = null;
    this._cache = new Map(); // key -> {static, crowd, map} (LRU, CACHE_SIZE entries)
    this.buildMs = 0;
  }

  /**
   * Set end-zone teams: x < 10 uses `homeLook` (the end zone the drive starts from), x > 110 uses
   * `awayLook`. The caller decides which team is which. Invalidates the pre-render on change.
   * @param {TeamLook} homeLook
   * @param {TeamLook} awayLook
   */
  setTeams(homeLook, awayLook) {
    const home = { ...DEFAULT_HOME, ...(homeLook || {}) };
    const away = { ...DEFAULT_AWAY, ...(awayLook || {}) };
    // keep the pre-render when nothing visible changed (a renderer can be shared across plays)
    if (lookKey(home) === lookKey(this.home) && lookKey(away) === lookKey(this.away) && this._static) return;
    this.home = home;
    this.away = away;
    this.invalidate();
  }

  /** Force a rebuild of the static layer on the next draw. */
  invalidate() {
    this._key = '';
    this._cache.clear();
  }

  _keyFor(camera) {
    return `${camera.orientation}|${!!camera.mirror}|${camera.ppy}|${camera.yScale}|${lookKey(this.home)}|${lookKey(this.away)}`;
  }

  /** Cache entry for a framing (built on a miss; LRU order refreshed). */
  _entry(camera, key = this._keyFor(camera)) {
    let e = this._cache.get(key);
    if (e) {
      this._cache.delete(key); // refresh LRU order
    } else {
      const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
      const m = new Mapper(camera.orientation, camera.ppy, camera.yScale, !!camera.mirror);
      e = { map: m, static: this._buildStatic(m), crowd: this._buildCrowd(m) };
      this.buildMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
      while (this._cache.size >= CACHE_SIZE) this._cache.delete(this._cache.keys().next().value);
    }
    this._cache.set(key, e);
    return e;
  }

  _ensure(camera) {
    const key = this._keyFor(camera);
    if (key === this._key && this._static) return;
    const e = this._entry(camera, key);
    this._map = e.map;
    this._static = e.static;
    this._crowd = e.crowd;
    this._key = key;
  }

  /**
   * Pre-render now for a camera (e.g. while a play is still pre-snap) so no frame stalls later.
   * `crowd` also builds every crowd bob frame (otherwise they are built the first time each is
   * shown, i.e. mid-play).
   */
  prepare(camera, { crowd = true } = {}) {
    this._ensure(camera);
    if (crowd) this._fillCrowd(this._crowd);
  }

  /**
   * Build (and cache) another framing without switching to it, e.g. the wider field-goal zoom
   * while the field is idle. `cam` = {orientation, mirror, ppy, yScale}. Returns true if it built.
   */
  prewarm(cam) {
    const key = this._keyFor(cam);
    if (key === this._key || this._cache.has(key)) return false;
    const cur = this._key && this._cache.get(this._key);
    const e = this._entry(cam, key);
    this._fillCrowd(e.crowd);
    if (cur) {
      // keep the framing in use the most recently used one
      this._cache.delete(this._key);
      this._cache.set(this._key, cur);
    }
    return true;
  }

  _fillCrowd(crowd) {
    for (const s of crowd || []) for (let f = 0; f < s.frames.length; f++) if (!s.frames[f]) s.frames[f] = s.make(f);
  }

  // -------------------------------------------------------------------------------------------
  // Static layer

  _buildStatic(m) {
    const c = makeCanvas(m.w, m.h);
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    const F = FIELD_COLORS;
    const L = FIELD_LEN;
    const W = FIELD_W;
    const ppy = m.ppy;
    const thin = 1;
    const thick = ppy >= 12 ? 3 : 2;

    // Stands base (the crowd strips cover it at draw time)
    g.fillStyle = F.stands;
    g.fillRect(0, 0, m.w, m.h);

    // Wall ring
    const s = STANDS;
    m.fill(g, F.wallTop, -s, L + s, -s, W + s);
    const wt = Math.max(1, Math.round(WALL * ppy * 0.35));
    const wi = s - wt / (ppy * m.ys);
    m.fill(g, F.wall, -wi, L + wi, -wi, W + wi);
    // Apron (darker turf) inside the wall
    const ap = BORDER + APRON;
    m.fill(g, F.wallBot, -ap - 0.12, L + ap + 0.12, -ap - 0.12, W + ap + 0.12);
    m.fill(g, F.apron, -ap, L + ap, -ap, W + ap);
    this._apronDetail(g, m);
    // White border band around the whole field
    m.fill(g, F.line, -BORDER, L + BORDER, -BORDER, W + BORDER);

    // Turf: 5-yard mowing bands with a subtle grass speckle
    this._turf(g, m);
    // End zones
    this._endZone(g, m, 0, 10, this.home);
    this._endZone(g, m, 110, 120, this.away);
    // Midfield emblem (original: simple pixel ring + star), under the lines
    this._midfield(g, m);

    // Yard lines every 5 yards; goal lines thicker
    for (let x = 15; x <= 105; x += 5) m.across(g, F.line, x, 0, W, thin);
    m.across(g, F.line, 10, 0, W, thick);
    m.across(g, F.line, 110, 0, W, thick);
    // Hash marks each yard (two middle rows + sideline ticks)
    const tick = 0.7;
    for (let x = 11; x < 110; x++) {
      if (x % 5 === 0) continue;
      for (const hy of HASH_Y) m.across(g, F.line, x, hy - tick / 2, hy + tick / 2, thin);
      m.across(g, F.line, x, 0.35, 0.35 + tick, thin);
      m.across(g, F.line, x, W - 0.35 - tick, W - 0.35, thin);
    }
    // 2-point conversion marks (short dash at the 2)
    for (const x of [12, 108]) m.across(g, F.line, x, W / 2 - 0.4, W / 2 + 0.4, thin);
    // Yard numbers
    this._numbers(g, m);
    return c;
  }

  _apronDetail(g, m) {
    // Team bench areas: slightly lighter apron patches behind each sideline between the 30s
    const F = FIELD_COLORS;
    const ap = BORDER + APRON;
    const shade = lighten(F.apron, 0.06);
    m.fill(g, shade, 40, 80, -ap, -BORDER);
    m.fill(g, shade, 40, 80, FIELD_W + BORDER, FIELD_W + ap);
  }

  _endZone(g, m, x0, x1, look) {
    const fill = look.primary;
    m.fill(g, fill, x0, x1, 0, FIELD_W);
    // subtle diagonal hatch for texture
    const r = m.rect(x0, x1, 0, FIELD_W);
    // (a 6x6 diagonal tile as a pattern: one fill instead of thousands of 1px rects)
    const tile = makeCanvas(6, 6);
    const tg = tile.getContext('2d');
    tg.fillStyle = darken(fill, 0.9);
    for (let k = 0; k < 6; k++) tg.fillRect(k, k, 1, 1);
    g.save();
    g.translate(r.x, r.y);
    g.fillStyle = g.createPattern(tile, 'repeat');
    g.fillRect(0, 0, r.w, r.h);
    g.restore();
    // inner border
    const inset = Math.max(2, Math.round(m.ppy * 0.45));
    const ink = endZoneInk(look);
    g.fillStyle = darken(fill, 0.78);
    g.fillRect(r.x + inset, r.y + inset, r.w - inset * 2, 1);
    g.fillRect(r.x + inset, r.y + r.h - inset - 1, r.w - inset * 2, 1);
    g.fillRect(r.x + inset, r.y + inset, 1, r.h - inset * 2);
    g.fillRect(r.x + r.w - inset - 1, r.y + inset, 1, r.h - inset * 2);
    const name = String(look.city || look.abbr || '').toUpperCase();
    const shadow = luma(ink) > 0.5 ? darken(fill, 0.45) : lighten(fill, 0.35);
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    if (m.o === 'portrait') {
      // horizontal name across the end zone (which spans the screen width)
      const maxW = r.w * 0.82;
      const maxH = r.h * 0.42;
      let scale = Math.max(1, Math.min(4, Math.floor(maxH / 7)));
      while (scale > 1 && measureText(name, { size: 'big', scale }) > maxW) scale--;
      const big = measureText(name, { size: 'big', scale }) <= maxW;
      const th = (big ? 7 : 5) * scale;
      drawText(g, name, Math.round(cx), Math.round(cy - th / 2), { size: big ? 'big' : 'small', scale, color: ink, align: 'center', shadow });
    } else {
      // landscape: the end zone is a tall strip; stack the letters vertically so they read upright
      const letters = name.replace(/\s+/g, ' ').split('');
      const n = letters.length;
      const maxH = r.h * 0.86;
      let scale = Math.max(1, Math.min(4, Math.floor((r.w * 0.42) / 5)));
      const pitch = (s) => 7 * s + Math.max(2, s + 1);
      while (scale > 1 && n * pitch(scale) > maxH) scale--;
      const p = pitch(scale);
      const total = n * p - (p - 7 * scale);
      let y = Math.round(cy - total / 2);
      for (const ch of letters) {
        if (ch !== ' ') drawText(g, ch, Math.round(cx), y, { size: 'big', scale, color: ink, align: 'center', shadow });
        y += ch === ' ' ? Math.round(p * 0.6) : p;
      }
    }
  }

  /** Field of play turf (stripes + speckle) written straight into pixels — no canvas readback. */
  _turf(g, m) {
    const r = m.rect(10, 110, 0, FIELD_W);
    const img = g.createImageData(r.w, r.h);
    const d = img.data;
    const A = hexRgb(FIELD_COLORS.turfA);
    const B = hexRgb(FIELD_COLORS.turfB);
    const land = m.o === 'landscape';
    // band index along the field axis, using the same rounding as the line positions
    const n = land ? r.w : r.h;
    const band = new Uint8Array(n);
    for (let k = 0; k < 20; k++) {
      const a0 = m.ax(10 + k * 5);
      const a1 = m.ax(15 + k * 5);
      const lo = Math.min(a0, a1) - (land ? r.x : r.y);
      const hi = Math.max(a0, a1) - (land ? r.x : r.y);
      for (let i = Math.max(0, lo); i < Math.min(n, hi); i++) band[i] = k % 2;
    }
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        const c = band[land ? x : y] ? B : A;
        const h = hash2(x + r.x, y + r.y);
        let k = 0;
        if (h < 0.035) k = -10;
        else if (h > 0.975) k = 7;
        else if (((x + r.x) * 3 + (y + r.y) * 5) % 23 === 0) k = -4; // faint mow grain
        const o = (y * r.w + x) * 4;
        d[o] = Math.max(0, c[0] + k);
        d[o + 1] = Math.max(0, c[1] + k * 1.4);
        d[o + 2] = Math.max(0, c[2] + k * 0.6);
        d[o + 3] = 255;
      }
    }
    g.putImageData(img, r.x, r.y);
  }

  _numbers(g, m) {
    const F = FIELD_COLORS;
    const ink = F.line;
    const scale = Math.max(1, Math.round((m.o === 'landscape' ? m.ppy * m.ys : m.ppy) * 2 / 7));
    const gap = Math.max(2, scale + 1); // px between a digit and the yard line
    const rows = [11.5, FIELD_W - 11.5];
    const own = m.ownDir();
    const opp = { left: 'right', right: 'left', up: 'down', down: 'up' }[own];
    for (let x = 20; x <= 100; x += 10) {
      const label = String(50 - Math.abs(60 - x));
      const dir = x < 60 ? own : opp; // arrow points at the nearer goal
      for (const y of rows) {
        const p = m.pt(x, y);
        const dh = 7 * scale;
        const dw = 5 * scale;
        if (m.o === 'landscape') {
          // digits straddle the yard line: "1 | 0" (always read left to right)
          const top = Math.round(p.y - dh / 2);
          if (label.length === 2) {
            drawText(g, label[0], p.x - gap - dw, top, { size: 'big', scale, color: ink });
            drawText(g, label[1], p.x + gap + 1, top, { size: 'big', scale, color: ink });
          }
          if (x !== 60) {
            const ax = dir === 'left' ? p.x - gap - dw - scale * 2 - 1 : p.x + gap + 1 + dw + scale + 1;
            this._arrow(g, ax, Math.round(p.y - scale), scale, dir, ink);
          }
        } else {
          // portrait: number centred on the line, with the line interrupted behind it
          const w = measureText(label, { size: 'big', scale }) + scale * 2;
          const left = Math.round(p.x - w / 2);
          const top = Math.round(p.y - dh / 2);
          // the line's pixel row belongs to the band just below it on screen: [x-5, x), or
          // [x, x+5) when the field is mirrored (x grows downward)
          const band = m.mirror ? Math.floor((x - 10) / 5) : Math.floor((x - 15) / 5);
          g.fillStyle = band % 2 ? F.turfB : F.turfA;
          g.fillRect(left - 1, p.y, w + 2, 1);
          drawText(g, label, Math.round(p.x), top, { size: 'big', scale, color: ink, align: 'center' });
          if (x !== 60) {
            const ay = dir === 'down' ? top + dh + gap : top - gap - scale * 2;
            this._arrow(g, Math.round(p.x - scale), ay, scale, dir, ink);
          }
        }
      }
    }
  }

  /** Small solid triangle (yard-number direction arrow). */
  _arrow(g, x, y, s, dir, color) {
    g.fillStyle = color;
    const n = 2; // triangle "radius" in scaled units
    for (let i = 0; i < n; i++) {
      const len = (n - i) * 2 - 1; // 3, 1
      for (let j = 0; j < len; j++) {
        const off = j - (len - 1) / 2;
        let px; let py;
        // i = 0 is the 3-px base, i = n-1 the tip
        if (dir === 'left') { px = x + (n - 1 - i) * s; py = y + (off + 0.5) * s; }
        if (dir === 'right') { px = x + i * s; py = y + (off + 0.5) * s; }
        if (dir === 'up') { px = x + (off + 0.5) * s; py = y + (n - 1 - i) * s; }
        if (dir === 'down') { px = x + (off + 0.5) * s; py = y + i * s; }
        g.fillRect(Math.round(px), Math.round(py), s, s);
      }
    }
  }

  _midfield(g, m) {
    const p = m.pt(60, FIELD_W / 2);
    const rx = Math.round((m.o === 'landscape' ? m.ppy : m.ppy * m.ys) * 2.6);
    const ry = Math.round((m.o === 'landscape' ? m.ppy * m.ys : m.ppy) * 2.6);
    const col = lighten(FIELD_COLORS.turfA, 0.12);
    g.fillStyle = col;
    // ellipse ring, 1px, plotted per pixel row/col for a clean pixel outline
    for (let a = 0; a < 360; a += 1.5) {
      const t = (a * Math.PI) / 180;
      g.fillRect(Math.round(p.x + Math.cos(t) * rx), Math.round(p.y + Math.sin(t) * ry), 1, 1);
    }
    // 4-point star
    const s = Math.max(1, Math.round(rx / 6));
    const arm = Math.round(Math.min(rx, ry) * 0.55);
    for (let i = -arm; i <= arm; i++) {
      const w = Math.max(1, Math.round((1 - Math.abs(i) / arm) * s * 2));
      g.fillRect(p.x + i, p.y - Math.floor(w / 2), 1, w);
      g.fillRect(p.x - Math.floor(w / 2), p.y + i, w, 1);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Crowd

  _buildCrowd(m) {
    const L = FIELD_LEN;
    const W = FIELD_W;
    const s = STANDS;
    // stands regions in world space (the corners belong to the sideline stands)
    const regions = [
      { x0: m.X0, x1: m.X1, y0: m.Y0, y1: -s, side: 'near0' },
      { x0: m.X0, x1: m.X1, y0: W + s, y1: m.Y1, side: 'near1' },
      { x0: m.X0, x1: -s, y0: -s, y1: W + s, side: 'end0' },
      { x0: L + s, x1: m.X1, y0: -s, y1: W + s, side: 'end1' },
    ];
    const palette = this._crowdPalette();
    const out = [];
    const fr = m.rect(0, L, 0, W);
    const fcx = fr.x + fr.w / 2;
    const fcy = fr.y + fr.h / 2;
    for (const reg of regions) {
      const r = m.rect(reg.x0, reg.x1, reg.y0, reg.y1);
      if (r.w <= 0 || r.h <= 0) continue;
      // in canvas space: horizontal rows if the region's long side is horizontal
      const horizontal = r.w >= r.h;
      // which side of the strip faces the field (in canvas space), and are fans seen from behind?
      // (stands below the field on screen are nearest the camera: we see the backs of heads)
      const fieldAfter = horizontal ? r.y + r.h / 2 < fcy : r.x + r.w / 2 < fcx;
      const backs = horizontal && !fieldAfter;
      // bob frame 0 now; the others are built the first time they're shown (spreads the cost)
      const frames = [this._crowdFrame(r, horizontal, 0, palette, fieldAfter, backs, m)];
      for (let f = 1; f < CROWD_FRAMES; f++) frames.push(null);
      const make = (f) => this._crowdFrame(r, horizontal, f, palette, fieldAfter, backs, m);
      out.push({ x: r.x, y: r.y, w: r.w, h: r.h, frames, make });
    }
    return out;
  }

  _crowdPalette() {
    const shirts = [];
    const dim = (rgb) => rgb.map((v) => Math.round(v * 0.86));
    const add = (hex, n) => { for (let i = 0; i < n; i++) shirts.push(dim(hexRgb(hex))); };
    add(this.home.primary, 6);
    add(this.home.secondary, 3);
    add(this.away.primary, 2);
    add(this.away.secondary, 1);
    for (const h of ['#d8d8d0', '#4a5068', '#2f5d8a', '#8a3a3a']) add(h, 1);
    const heads = SKIN_TONES.map(hexRgb).map(dim);
    const hair = ['#2a1d14', '#4a3020', '#6a4a2a', '#b89048', '#1a1a1a'].map(hexRgb);
    return {
      shirts, heads, hair,
      bg: hexRgb(FIELD_COLORS.stands),
      seat: hexRgb(FIELD_COLORS.standsStep),
      aisle: hexRgb('#30364a'),
      aisleStep: hexRgb('#262b3c'),
    };
  }

  /**
   * Render one bob frame of a stands region (opaque): seat rows parallel to the field edge,
   * stairway aisles, and upright 2px-head fans. Only the fans differ between frames.
   * @param {{x:number,y:number,w:number,h:number}} r canvas rect of the region
   * @param {boolean} horizontal seat rows run horizontally in canvas space
   * @param {number} frame bob frame
   * @param {object} pal crowd palette
   * @param {boolean} fieldAfter the field lies at larger canvas coordinates (below / right)
   * @param {boolean} backs fans are seen from behind (hair instead of faces)
   */
  _crowdFrame(r, horizontal, frame, pal, fieldAfter, backs, m) {
    const c = makeCanvas(r.w, r.h);
    const g = c.getContext('2d');
    const img = g.createImageData(r.w, r.h);
    const d = img.data;
    const put = (x, y, rgb) => {
      if (x < 0 || y < 0 || x >= r.w || y >= r.h) return;
      const o = (y * r.w + x) * 4;
      d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255;
    };
    for (let i = 0; i < d.length; i += 4) { d[i] = pal.bg[0]; d[i + 1] = pal.bg[1]; d[i + 2] = pal.bg[2]; d[i + 3] = 255; }
    const scaleAxis = horizontal ? (m.o === 'landscape' ? m.ppy * m.ys : m.ppy) : (m.o === 'landscape' ? m.ppy : m.ppy * m.ys);
    const pitch = Math.max(6, Math.min(8, Math.round(0.62 * scaleAxis))); // row depth (px)
    const step = horizontal ? 5 : 6; // fan spacing along a row (px)
    const aisleEvery = 14; // seats between stairways
    const V = horizontal ? r.h : r.w; // depth of the stands
    const U = horizontal ? r.w : r.h; // length along the field edge
    const rows = Math.ceil(V / pitch);
    const seats = Math.ceil(U / step);
    // global offsets so neighbouring regions don't repeat the same pattern
    const gu = horizontal ? r.x : r.y;
    const gv = horizontal ? r.y : r.x;
    for (let j = 0; j < rows; j++) {
      // canvas-space start of row j (row 0 hugs the field)
      const rs = fieldAfter ? V - (j + 1) * pitch : j * pitch;
      const seatLine = fieldAfter ? rs : rs + pitch - 1; // seat backs on the far side
      for (let u = 0; u < U; u++) {
        if (horizontal) put(u, seatLine, pal.seat); else put(seatLine, u, pal.seat);
      }
      const fanV = rs + pitch - 5; // fan's top-left across the row
      for (let i = 0; i < seats; i++) {
        const u0 = i * step + (j % 2 ? 2 : 0);
        if ((i + (j % 3 === 0 ? 0 : 0)) % aisleEvery === 0) {
          for (let du = 0; du < 3; du++) {
            for (let dv = 0; dv < pitch; dv++) {
              const col = (dv + rs) % 2 ? pal.aisleStep : pal.aisle;
              if (horizontal) put(i * step + du, rs + dv, col); else put(rs + dv, i * step + du, col);
            }
          }
          continue;
        }
        const h0 = hash2(gu + i * 7 + 3, gv + j * 13 + 1);
        if (h0 < 0.07) continue; // empty seat
        const h1 = hash2(gu + i + 11, gv + j + 5);
        const h2 = hash2(gu + i + 29, gv + j * 3 + 17);
        const phase = Math.floor(h1 * CROWD_FRAMES * 7) % CROWD_FRAMES;
        const bob = (phase + frame) % CROWD_FRAMES === 0 ? 1 : 0;
        const cheer = h2 > 0.86 && (frame + phase) % CROWD_FRAMES !== 1;
        const shirt = pal.shirts[Math.floor(h2 * 997) % pal.shirts.length];
        const head = backs && h1 > 0.25 ? pal.hair[Math.floor(h1 * 97) % pal.hair.length] : pal.heads[Math.floor(h1 * 53) % pal.heads.length];
        const sd = [shirt[0] * 0.72, shirt[1] * 0.72, shirt[2] * 0.72];
        // upright fan: 2x2 head over 4x2 shoulders
        const x = horizontal ? u0 : fanV;
        const y = (horizontal ? fanV : u0 + 1) - bob;
        put(x + 1, y, head); put(x + 2, y, head); put(x + 1, y + 1, head); put(x + 2, y + 1, head);
        for (let k = 0; k < 4; k++) { put(x + k, y + 2, shirt); put(x + k, y + 3, sd); }
        if (cheer) { put(x, y - 1, head); put(x + 3, y - 1, head); put(x, y + 1, shirt); put(x + 3, y + 1, shirt); }
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  // -------------------------------------------------------------------------------------------
  // Per-frame drawing

  /**
   * Draw the field for the current camera.
   * @param {CanvasRenderingContext2D} ctx virtual-resolution context
   * @param {import('./camera.js').Camera} camera
   * @param {{losX?:number, firstDownX?:number, time?:number, posts?:boolean}} [opts]
   *   posts:false skips the goal posts. For correct depth, pass posts:false, then call
   *   drawPosts(ctx, camera, 'behind') before the players and drawPosts(ctx, camera, 'front')
   *   after them.
   */
  draw(ctx, camera, opts = {}) {
    this._ensure(camera);
    const m = this._map;
    const vw = camera.viewW;
    const vh = camera.viewH;
    const tl = camera.project(m.originX(), m.Y0, 0, this._tl || (this._tl = { x: 0, y: 0 }));
    const ox = Math.round(tl.x);
    const oy = Math.round(tl.y);
    if (ox > 0 || oy > 0 || ox + m.w < vw || oy + m.h < vh) {
      ctx.fillStyle = FIELD_COLORS.stands;
      ctx.fillRect(0, 0, vw, vh);
    }
    blitClip(ctx, this._static, 0, 0, m.w, m.h, ox, oy, vw, vh);
    const fi = Math.floor((opts.time || 0) * CROWD_FPS) % CROWD_FRAMES;
    for (const s of this._crowd) {
      // skip regions entirely off screen (and don't build their frames yet)
      if (ox + s.x >= vw || oy + s.y >= vh || ox + s.x + s.w <= 0 || oy + s.y + s.h <= 0) continue;
      const fr = s.frames[fi] || (s.frames[fi] = s.make(fi));
      blitClip(ctx, fr, 0, 0, s.w, s.h, ox + s.x, oy + s.y, vw, vh);
    }

    const t = Math.max(1, Math.round(camera.ppy / 6));
    if (opts.losX != null && Number.isFinite(opts.losX)) this._fieldLine(ctx, camera, opts.losX, FIELD_COLORS.los, t);
    if (opts.firstDownX != null && Number.isFinite(opts.firstDownX) && opts.firstDownX < 110) {
      this._fieldLine(ctx, camera, opts.firstDownX, FIELD_COLORS.firstDown, t);
    }
    if (opts.posts !== false) this.drawPosts(ctx, camera);
  }

  _fieldLine(ctx, camera, x, color, t) {
    const a = camera.project(x, 0, 0, this._la || (this._la = { x: 0, y: 0 }));
    const b = camera.project(x, FIELD_W, 0, this._lb || (this._lb = { x: 0, y: 0 }));
    ctx.fillStyle = color;
    if (camera.orientation === 'landscape') {
      const sx = Math.round(a.x) - Math.floor(t / 2);
      ctx.fillRect(sx, Math.round(a.y), t, Math.round(b.y) - Math.round(a.y));
    } else {
      const sy = Math.round(a.y) - Math.floor(t / 2);
      ctx.fillRect(Math.round(a.x), sy, Math.round(b.x) - Math.round(a.x), t);
    }
  }

  /**
   * Draw the goal posts (yellow, with height).
   * layer 'behind' = posts farther from the camera than the players (draw before players),
   * 'front' = posts nearer the camera (draw after players; only the near post in portrait),
   * 'all' = both.
   * @param {CanvasRenderingContext2D} ctx
   * @param {import('./camera.js').Camera} camera
   * @param {'all'|'behind'|'front'} [layer='all']
   */
  drawPosts(ctx, camera, layer = 'all') {
    const portrait = camera.orientation !== 'landscape';
    // in portrait the post at the bottom of the screen (x=0, or x=120 when mirrored) is closest
    // to the camera
    const nearX = camera.mirror ? FIELD_LEN : 0;
    for (const [x, dir] of [[0, -1], [FIELD_LEN, 1]]) {
      const front = portrait && x === nearX;
      if (layer === 'all' || (layer === 'front') === front) this._post(ctx, camera, x, dir);
    }
  }

  _post(ctx, camera, xLine, dir) {
    const span = 3.08; // half the upright spacing (yards)
    const bar = 3.33; // crossbar height
    const top = bar + 6.5; // upright tops
    const back = 0.9; // base pad behind the end line
    const cy = FIELD_W / 2;
    const land = camera.orientation === 'landscape';
    // landscape: the crossbar runs along the screen's vertical axis, so draw it obliquely (the far
    // end nudged toward midfield, a 3/4 view) to separate the two vertical uprights on screen
    const oblique = land ? 0.42 * dir * (camera.mirror ? -1 : 1) * camera.ppy : 0;
    const P = (x, y, z) => {
      const s = camera.toScreen(x, y, z);
      return { x: Math.round(s.x + (y - cy) * oblique), y: Math.round(s.y) };
    };
    const xs = xLine + dir * back;
    // quick cull
    const c0 = P(xLine, cy, 0);
    const m = 160;
    if (c0.x < -m || c0.x > camera.viewW + m || c0.y < -m * 1.5 || c0.y > camera.viewH + m) return;
    const w = camera.ppy >= 9 ? 2 : 1;
    const F = FIELD_COLORS;
    // shadow on the ground
    const sh0 = P(xs, cy, 0);
    ctx.globalAlpha = 0.25;
    pixLine(ctx, sh0.x, sh0.y, P(xs + dir * 2.2, cy + 0.8, 0).x, P(xs + dir * 2.2, cy + 0.8, 0).y, '#000', w);
    ctx.globalAlpha = 1;
    // base post + gooseneck
    const base = P(xs, cy, 0);
    const neckTop = P(xs, cy, bar - 0.6);
    const mid = P(xLine, cy, bar);
    const segs = [];
    segs.push([base, neckTop]);
    segs.push([neckTop, mid]);
    // crossbar
    const l = P(xLine, cy - span, bar);
    const r = P(xLine, cy + span, bar);
    segs.push([l, r]);
    // uprights
    segs.push([l, P(xLine, cy - span, top)]);
    segs.push([r, P(xLine, cy + span, top)]);
    // outline pass, then shade, then body
    for (const [a, b] of segs) pixLine(ctx, a.x, a.y, b.x, b.y, F.postOutline, w + 2);
    for (const [a, b] of segs) pixLine(ctx, a.x, a.y, b.x, b.y, F.postShade, w);
    for (const [a, b] of segs) pixLine(ctx, a.x, a.y, b.x, b.y, F.post, Math.max(1, w - 1));
    // base pad
    ctx.fillStyle = '#20283d';
    ctx.fillRect(base.x - w - 1, base.y - 2, w * 2 + 3, 3);
  }

  /** Average ms of a full draw() at the camera's current settings (tooling / tests). */
  benchmark(ctx, camera, n = 200) {
    this._ensure(camera);
    ctx.getImageData(0, 0, 1, 1); // flush pending work so it is not billed to the loop
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      this.draw(ctx, camera, { losX: 35, firstDownX: 45, time: i / 60 });
      if (i % 20 === 19) ctx.getImageData(0, 0, 1, 1); // force rasterisation (GPU canvases defer)
    }
    ctx.getImageData(0, 0, 1, 1);
    return (performance.now() - t0) / n;
  }
}

/** drawImage with manual clipping to the destination viewport (avoids huge offscreen blits). */
function blitClip(ctx, img, sx, sy, sw, sh, dx, dy, vw, vh) {
  let x0 = dx; let y0 = dy; let x1 = dx + sw; let y1 = dy + sh;
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  if (x1 > vw) x1 = vw;
  if (y1 > vh) y1 = vh;
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return;
  ctx.drawImage(img, sx + (x0 - dx), sy + (y0 - dy), w, h, x0, y0, w, h);
}

/** Pixel line made of square dots (crisp, no anti-aliasing). `t` = thickness. */
function pixLine(ctx, x0, y0, x1, y1, color, t = 1) {
  ctx.fillStyle = color;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;
  const half = Math.floor(t / 2);
  for (let i = 0; i <= dx + dy + 1; i++) {
    ctx.fillRect(x - half, y - half, t, t);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}
