// Procedural pixel-art players and ball (original designs).
//
// Pipeline: a pose (joint positions per view/anim/frame) is rasterised into a small palette-INDEX
// buffer (DOM-free, cached per facing/anim/frame), auto-outlined, cropped, then colourised into an
// offscreen canvas per (team look, skin tone) on first use. 'left' is a mirror of 'right'.
// Views: 'side' (right/left), 'front' (down: facing the camera), 'back' (up: facing away).
//
// Sprite anchor (ox, oy) = feet centre on the turf: draw the canvas at (sx - ox, sy - oy).

/** @typedef {import('../types.js').TeamLook} TeamLook */
/** @typedef {'right'|'left'|'up'|'down'} Facing */
/** @typedef {'idle'|'run'|'throw'|'catch'|'block'|'tackle'|'down'|'dive'|'celebrate'|'kick'|'stance'} AnimName */

/**
 * Animation table: frame count, playback fps and whether it loops (non-looping anims hold the
 * last frame). drawPlayer() derives the frame from `t` (seconds since the anim started).
 */
export const ANIMS = {
  idle: { frames: 2, fps: 2, loop: true },
  run: { frames: 4, fps: 10, loop: true },
  throw: { frames: 3, fps: 9, loop: false },
  catch: { frames: 2, fps: 6, loop: false },
  block: { frames: 2, fps: 5, loop: true },
  tackle: { frames: 2, fps: 6, loop: false },
  down: { frames: 1, fps: 1, loop: false },
  dive: { frames: 2, fps: 7, loop: false },
  celebrate: { frames: 4, fps: 6, loop: true },
  kick: { frames: 3, fps: 8, loop: false },
  stance: { frames: 1, fps: 1, loop: false },
};

export const FACINGS = ['right', 'left', 'up', 'down'];

/** Skin tones (index 0..4), light to dark. */
export const SKIN_TONES = ['#f2cba6', '#dda274', '#b97a4c', '#8a5532', '#5c3820'];

// ---------------------------------------------------------------------------------------------
// Colour helpers

function hexToRgb(hex) {
  let h = String(hex || '#888').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (r, g, b) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

/** Multiply a colour toward black (f < 1) — slight hue shift toward cool for nicer shading. */
export function darken(hex, f = 0.7) {
  const [r, g, b] = hexToRgb(hex);
  return toHex(r * f, g * f, b * (f + (1 - f) * 0.25));
}

/** Mix a colour toward white by t (0..1), slightly warm. */
export function lighten(hex, t = 0.3) {
  const [r, g, b] = hexToRgb(hex);
  return toHex(r + (255 - r) * t, g + (250 - g) * t, b + (235 - b) * t);
}

/** Perceived luminance 0..1. */
export function luma(hex) {
  const [r, g, b] = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function colorDist(a, b) {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

// ---------------------------------------------------------------------------------------------
// Palette indices

const C = {
  T: 0, O: 1, H: 2, HS: 3, HL: 4, ST: 5, MK: 6, SK: 7, SS: 8, J: 9, JS: 10, TR: 11,
  P: 12, PS: 13, SO: 14, SOS: 15, SH: 16, EY: 17, JL: 18, WH: 19, MKS: 20,
};
const N_COLORS = 21;

const KEY = {
  '.': C.T, o: C.O, H: C.H, h: C.HS, L: C.HL, T: C.ST, m: C.MK, n: C.MKS, S: C.SK, s: C.SS,
  J: C.J, j: C.JS, l: C.JL, N: C.TR, P: C.P, p: C.PS, K: C.SO, k: C.SOS, B: C.SH, e: C.EY, w: C.WH,
};

// Part bitmaps. Side view faces RIGHT (back of the helmet on the left).
const HELMET = {
  front: [
    '.HLTLH.',
    'HLHTHHh',
    'HSeSeSh',
    'hmmmmmh',
    'hnSSSnh',
    '.hmmmh.',
  ],
  back: [
    '.HLTLH.',
    'HLHTHHh',
    'HHHTHHh',
    'HHHTHhh',
    'hHhThhh',
    '.hhhhh.',
  ],
  side: [
    '.TTTTT..',
    'HLLHHHH.',
    'HLHHHHSm',
    'HHhHHSem',
    'hHHHhmmm',
    '.hhhh.n.',
  ],
};

const TORSO = {
  front: [
    '.lJJJJJj.',
    'lJJJJJJJj',
    'JJJNJNJJj',
    '.JJNJNJj.',
    '.PPPPPPp.',
  ],
  back: [
    '.lJJJJJj.',
    'lJNNJNNJj',
    'JJJNJJNJj',
    '.JJNJJNj.',
    '.PPPPPPp.',
  ],
  side: [
    '.JJJJ.',
    'jJJJJl',
    'jJJJJJ',
    'jjJJJ.',
    '.pPPP.',
  ],
};

// Sprawled (diving / wrapping) figures lying along the screen's vertical axis, seen from above.
// 'up' = diving away from the camera (head at the top), 'down' = toward it (head at the bottom).
const SPRAWL = {
  up: [
    'SS.......SS',
    'SS.......SS',
    'sS.......Ss',
    'sS.......Ss',
    'NN.HLTLH.NN',
    'JJHLHTHHhJJ',
    'JJHHHTHHhJJ',
    'JJHHHThhhJJ',
    'lJhHhThhhJj',
    'lJJhhhhhJJj',
    '.JJJNJNJJj.',
    '.JJJNJNJJj.',
    '.jJJJJJJjj.',
    '..PPPPPPp..',
    '..PPp.PPp..',
    '.PPp...PPp.',
    '.KK.....kK.',
    'BB.......BB',
  ],
  down: [
    'BB.......BB',
    '.Kk.....KK.',
    '.PPp...PPp.',
    '..PPp.PPp..',
    '..PPPPPPp..',
    '.lJJJJJJJj.',
    '.JJJNJNJJj.',
    'lJJJNJNJJJj',
    'lJHLHTHHhJj',
    'JJHLHTHHhJJ',
    'JJHHHTHHhJJ',
    'JJhmmmmmhJJ',
    'NNnmSSSmnNN',
    'sS.nmmmn.Ss',
    'sS.......Ss',
    'SS.......SS',
    'SS.......SS',
  ],
};

// Layout of the parts relative to the anchor (feet centre at column 0, ground row 0; the lowest
// shoe row is -1).
const LAYOUT = {
  front: { head: [-3, -16], torso: [-4, -11], sh: [[-5, -10], [4, -10]], hip: [[-2, -6], [1, -6]], shoeW: 2 },
  back: { head: [-3, -16], torso: [-4, -11], sh: [[-5, -10], [4, -10]], hip: [[-2, -6], [1, -6]], shoeW: 2 },
  side: { head: [-4, -16], torso: [-3, -11], sh: [[-2, -10], [0, -10]], hip: [[-2, -6], [0, -6]], shoeW: 3 },
};

// ---------------------------------------------------------------------------------------------
// Index buffer

const BW = 40;
const BH = 40;
const AX = 20; // anchor column in the work buffer
const AY = 32; // anchor row (ground) in the work buffer

class PixBuf {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.d = new Uint8Array(w * h);
  }

  set(x, y, c) {
    x = Math.round(x) + AX;
    y = Math.round(y) + AY;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.d[y * this.w + x] = c;
  }

  get(x, y) {
    x = Math.round(x) + AX;
    y = Math.round(y) + AY;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    return this.d[y * this.w + x];
  }

  /** Blit an ASCII bitmap at (x, y) (top-left, anchor-relative). `shear` shifts rows: top row by `shear` px, bottom row by 0. */
  bitmap(rows, x, y, shear = 0) {
    const n = rows.length;
    for (let r = 0; r < n; r++) {
      const off = n > 1 ? Math.round((shear * (n - 1 - r)) / (n - 1)) : 0;
      const row = rows[r];
      for (let c = 0; c < row.length; c++) {
        const v = KEY[row[c]];
        if (v) this.set(x + c + off, y + r, v);
      }
    }
  }

  /** 2px-thick Bresenham line; thickness is added toward +x (steep) or +y (shallow). */
  line(x0, y0, x1, y1, c, from = 0, to = 1) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const steep = dy >= dx;
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    const n = Math.max(dx, dy);
    let err = dx - dy;
    let x = x0;
    let y = y0;
    for (let i = 0; i <= n; i++) {
      const f = n ? i / n : 1;
      if (f >= from && f <= to) {
        const col = typeof c === 'function' ? c(f) : c;
        this.set(x, y, col);
        if (steep) this.set(x + 1, y, col); else this.set(x, y + 1, col);
      }
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  }

  /**
   * Composite `src` (another PixBuf) on top. Pixels of the existing body that touch the new layer
   * are re-coloured through `edge` (e.g. jersey -> jersey shade) so overlapping limbs keep a
   * readable inner contour.
   */
  overlay(src, edge) {
    const { w, h, d } = this;
    const s = src.d;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (s[i]) continue;
        const touch = (x > 0 && s[i - 1]) || (x < w - 1 && s[i + 1]) || (y > 0 && s[i - w]) || (y < h - 1 && s[i + w]);
        if (touch && edge[d[i]] != null) d[i] = edge[d[i]];
      }
    }
    for (let i = 0; i < s.length; i++) if (s[i]) d[i] = s[i];
  }

  /** Add a 1px outline around every opaque pixel (4-neighbourhood). */
  outline() {
    const { w, h, d } = this;
    const out = new Uint8Array(d);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d[y * w + x]) continue;
        const n = (x > 0 && d[y * w + x - 1]) || (x < w - 1 && d[y * w + x + 1]) ||
          (y > 0 && d[(y - 1) * w + x]) || (y < h - 1 && d[(y + 1) * w + x]);
        if (n) out[y * w + x] = C.O;
      }
    }
    this.d = out;
  }
}

/** Crop to the opaque bounding box. Returns {w,h,data,ox,oy} with the anchor offset. */
function crop(buf) {
  const { w, h, d } = buf;
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!d[y * w + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return { w: 1, h: 1, data: new Uint8Array(1), ox: 0, oy: 0 };
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  const data = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) data.set(d.subarray((y + y0) * w + x0, (y + y0) * w + x0 + cw), y * cw);
  return { w: cw, h: ch, data, ox: AX - x0, oy: AY - y0 };
}

function mirrorX(f) {
  const data = new Uint8Array(f.data.length);
  for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) data[y * f.w + x] = f.data[y * f.w + (f.w - 1 - x)];
  return { ...f, data, ox: f.w - 1 - f.ox };
}

/** Rotate 90deg clockwise (top -> right). */
function rotCW(f) {
  const w = f.h;
  const h = f.w;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) data[x * w + (w - 1 - y)] = f.data[y * f.w + x];
  return { ...f, w, h, data };
}

// ---------------------------------------------------------------------------------------------
// Poses
//
// A pose (all integers, px):
//   by     whole-body vertical offset (jumps; negative = up, feet leave the ground)
//   cy     upper-body drop (crouch): head/torso/shoulders/hips move down, feet stay planted
//   lean   torso lean toward facing (side view) — torso is sheared, head/shoulders shift
//   hx,hy  extra head offset
//   a0,a1  arms [elbowDx, elbowDy, handDx, handDy] relative to the shoulder
//          side view: a0 = far arm, a1 = near arm. front/back: a0 = screen-left, a1 = screen-right
//   l0,l1  legs [kneeDx, kneeDy, footDx, footDy]: knee relative to the (crouched) hip; foot relative
//          to the standing hip position (so crouching keeps feet planted). Standing foot = [0, 5].
//   lay    'h' -> rotate the finished figure to lie horizontally; 'v' -> lie along screen-y
//   lift   px the lying figure floats above the turf (airborne dive)

const ARM_DOWN = [0, 2, 1, 4];
const LEG_STAND = [0, 2, 0, 5];

function pose(o) {
  return { by: 0, cy: 0, lean: 0, hx: 0, hy: 0, a0: ARM_DOWN, a1: ARM_DOWN, l0: LEG_STAND, l1: LEG_STAND, lay: null, lift: 0, ...o };
}

/** Mirror a limb for the screen-right side of front/back views. */
const mx = (l) => [-l[0], l[1], -l[2], l[3]];

const SIDE_POSES = {
  idle: [
    pose({ a0: [0, 2, 1, 4], a1: [0, 2, 1, 4], l0: [0, 2, -1, 5], l1: [0, 2, 1, 5] }),
    pose({ cy: 1, a0: [0, 2, 1, 3], a1: [0, 2, 1, 3], l0: [0, 2, -1, 5], l1: [0, 2, 1, 5] }),
  ],
  run: [
    pose({ lean: 1, a0: [1, 2, 3, 1], a1: [-1, 2, -2, 4], l0: [-1, 3, -4, 4], l1: [2, 2, 3, 5] }),
    pose({ by: -1, lean: 1, a0: [0, 2, 1, 3], a1: [0, 2, 0, 4], l0: [0, 2, 0, 6], l1: [2, 1, 1, 4] }),
    pose({ lean: 1, a0: [-1, 2, -2, 4], a1: [1, 2, 3, 1], l0: [2, 2, 3, 5], l1: [-1, 3, -4, 4] }),
    pose({ by: -1, lean: 1, a0: [0, 2, 0, 4], a1: [0, 2, 1, 3], l0: [2, 1, 1, 4], l1: [0, 2, 0, 6] }),
  ],
  throw: [
    pose({ lean: -1, a0: [2, 0, 4, 0], a1: [-2, -1, -3, -3], l0: [1, 2, 2, 5], l1: [-1, 2, -2, 5] }),
    pose({ a0: [2, 1, 3, 2], a1: [-1, -2, 0, -5], l0: [1, 2, 2, 5], l1: [-1, 2, -2, 5] }),
    pose({ lean: 2, a0: [-1, 2, -2, 3], a1: [2, 0, 4, 1], l0: [1, 2, 2, 5], l1: [-1, 2, -3, 3] }),
  ],
  catch: [
    pose({ a0: [1, -2, 3, -5], a1: [1, -2, 2, -5], l0: [0, 2, -1, 5], l1: [1, 2, 2, 5] }),
    pose({ a0: [1, 1, 3, 0], a1: [1, 1, 2, 0], l0: [0, 2, -1, 5], l1: [1, 2, 2, 5] }),
  ],
  block: [
    pose({ lean: 2, cy: 1, a0: [2, 0, 4, -1], a1: [2, 0, 4, 0], l0: [1, 2, 2, 5], l1: [-1, 2, -3, 5] }),
    pose({ lean: 3, cy: 1, a0: [2, 0, 5, -1], a1: [2, 1, 5, 0], l0: [1, 2, 1, 5], l1: [-1, 2, -4, 5] }),
  ],
  tackle: [
    pose({ lean: 3, cy: 2, a0: [2, -1, 5, -2], a1: [2, 0, 5, -1], l0: [2, 1, 2, 5], l1: [-2, 2, -5, 4] }),
    pose({ lay: 'h', lift: 1, a0: [0, -3, 1, -6], a1: [1, -3, 2, -5], l0: [0, 3, -1, 6], l1: [0, 3, 1, 6] }),
  ],
  down: [
    pose({ lay: 'h', a0: [0, 2, 1, 4], a1: [1, -3, 1, -6], l0: [0, 3, -1, 6], l1: [0, 3, 1, 6] }),
  ],
  dive: [
    pose({ lean: 3, cy: 1, a0: [2, -1, 5, -3], a1: [2, -1, 5, -2], l0: [1, 2, 1, 5], l1: [-1, 2, -4, 4] }),
    pose({ lay: 'h', lift: 2, a0: [0, -3, 0, -6], a1: [1, -3, 1, -6], l0: [0, 3, 0, 6], l1: [0, 3, 1, 6] }),
  ],
  celebrate: [
    pose({ a0: [0, -3, 0, -6], a1: [1, -3, 1, -6], l0: [0, 2, -1, 5], l1: [0, 2, 1, 5] }),
    pose({ by: -2, a0: [-1, -3, -1, -6], a1: [1, -3, 2, -6], l0: [1, 2, 0, 4], l1: [1, 2, 2, 4] }),
    pose({ by: -3, a0: [-1, -3, -2, -6], a1: [1, -3, 3, -6], l0: [1, 2, 0, 4], l1: [1, 2, 2, 4] }),
    pose({ a0: [0, 2, 1, 4], a1: [1, -2, 2, -5], l0: [0, 2, -1, 5], l1: [0, 2, 1, 5] }),
  ],
  kick: [
    pose({ a0: [2, 1, 3, 2], a1: [-1, 2, -2, 3], l0: [0, 2, 0, 5], l1: [-1, 2, -3, 2] }),
    pose({ lean: -1, a0: [1, 0, 3, -1], a1: [-1, 1, -3, 1], l0: [0, 2, -1, 5], l1: [1, 2, 2, 4] }),
    pose({ lean: -1, a0: [-1, -1, -3, -2], a1: [1, -2, 2, -4], l0: [0, 2, -1, 5], l1: [2, 0, 5, -1] }),
  ],
  stance: [
    pose({ lean: 3, cy: 3, hy: 1, a0: [1, 2, 2, 2], a1: [1, 3, 1, 7], l0: [-1, 1, -3, 5], l1: [2, 0, 1, 5] }),
  ],
};

const FRONT_POSES = {
  idle: [
    pose({ a0: [0, 2, 0, 4], a1: mx([0, 2, 0, 4]), l0: [0, 2, 0, 5], l1: [0, 2, 0, 5] }),
    pose({ cy: 1, a0: [0, 2, 0, 3], a1: mx([0, 2, 0, 3]), l0: [0, 2, 0, 5], l1: [0, 2, 0, 5] }),
  ],
  run: [
    pose({ a0: [0, 1, 1, 2], a1: mx([0, 2, 0, 4]), l0: [0, 1, 0, 3], l1: [0, 2, 0, 5] }),
    pose({ by: -1, a0: [0, 2, 0, 3], a1: mx([0, 2, 0, 3]), l0: [0, 2, 0, 5], l1: [0, 2, 0, 6] }),
    pose({ a0: [0, 2, 0, 4], a1: mx([0, 1, 1, 2]), l0: [0, 2, 0, 5], l1: [0, 1, 0, 3] }),
    pose({ by: -1, a0: [0, 2, 0, 3], a1: mx([0, 2, 0, 3]), l0: [0, 2, 0, 6], l1: [0, 2, 0, 5] }),
  ],
  throw: [
    pose({ a0: [-1, 1, -2, 2], a1: mx([-2, -1, -2, -4]), l0: [0, 2, -1, 5], l1: [0, 2, 1, 5] }),
    pose({ a0: [0, 2, 1, 3], a1: mx([-1, -3, -1, -6]), l0: [0, 2, -1, 5], l1: [0, 2, 1, 5] }),
    pose({ a0: [0, 2, 0, 4], a1: mx([1, 1, 3, 2]), l0: [0, 2, -1, 5], l1: [0, 1, 1, 3] }),
  ],
  catch: [
    pose({ a0: [0, -3, 1, -6], a1: mx([0, -3, 1, -6]), l0: [0, 2, 0, 5], l1: [0, 2, 0, 5] }),
    pose({ a0: [1, 1, 3, 1], a1: mx([1, 1, 3, 1]), l0: [0, 2, 0, 5], l1: [0, 2, 0, 5] }),
  ],
  block: [
    pose({ cy: 1, a0: [1, 1, 2, 2], a1: mx([1, 1, 2, 2]), l0: [-1, 2, -1, 5], l1: [1, 2, 1, 5] }),
    pose({ cy: 2, a0: [1, 0, 2, 1], a1: mx([1, 1, 2, 2]), l0: [-1, 2, -2, 5], l1: [1, 2, 1, 5] }),
  ],
  tackle: [
    pose({ cy: 2, hy: 1, a0: [-1, 1, -1, 3], a1: mx([-1, 1, -1, 3]), l0: [-1, 1, -2, 5], l1: [1, 1, 2, 5] }),
    pose({ lay: 'v', lift: 1, a0: [0, -3, 1, -6], a1: mx([0, -3, 1, -6]), l0: [0, 2, 0, 4], l1: [0, 2, 0, 4] }),
  ],
  down: null, // uses the side view (lying horizontally)
  dive: [
    pose({ cy: 2, hy: 1, a0: [-1, 0, -1, 2], a1: mx([-1, 0, -1, 2]), l0: [0, 2, 0, 5], l1: [0, 1, 0, 3] }),
    pose({ lay: 'v', lift: 2, a0: [0, -3, 0, -6], a1: mx([0, -3, 0, -6]), l0: [0, 2, 0, 4], l1: [0, 2, 0, 4] }),
  ],
  celebrate: [
    pose({ a0: [-1, -3, -1, -6], a1: mx([-1, -3, -1, -6]), l0: [0, 2, 0, 5], l1: [0, 2, 0, 5] }),
    pose({ by: -2, a0: [-1, -3, -2, -6], a1: mx([-1, -3, -2, -6]), l0: [-1, 2, -1, 4], l1: [1, 2, 1, 4] }),
    pose({ by: -3, a0: [-1, -2, -3, -5], a1: mx([-1, -2, -3, -5]), l0: [-1, 2, -1, 4], l1: [1, 2, 1, 4] }),
    pose({ a0: [0, 2, 0, 4], a1: mx([-1, -3, -1, -6]), l0: [0, 2, 0, 5], l1: [0, 2, 0, 5] }),
  ],
  kick: [
    pose({ a0: [-1, 1, -2, 2], a1: mx([-1, 1, -2, 2]), l0: [0, 2, 0, 5], l1: [0, 1, 0, 3] }),
    pose({ a0: [-1, 0, -3, 0], a1: mx([-1, 1, -2, 2]), l0: [0, 2, 0, 5], l1: [0, 2, 0, 6] }),
    pose({ a0: [-1, -1, -3, -2], a1: mx([-1, -1, -3, -2]), l0: [0, 2, 0, 5], l1: [0, 0, 0, 1] }),
  ],
  stance: [
    pose({ cy: 3, hy: 1, a0: [1, 2, 2, 3], a1: mx([0, 3, 0, 6]), l0: [-1, 1, -2, 5], l1: [1, 1, 2, 5] }),
  ],
};

// ---------------------------------------------------------------------------------------------
// Rasteriser

// Inner-contour recolouring where a near limb overlaps the body.
const EDGE = { [C.J]: C.JS, [C.JL]: C.J, [C.TR]: C.JS, [C.H]: C.HS, [C.HL]: C.H, [C.ST]: C.HS, [C.P]: C.PS, [C.SK]: C.SS, [C.MK]: C.MKS };

/** Arm colour along its length: sleeve (jersey) to the elbow, trim band, then skin. */
function armColors(far) {
  const J = far ? C.JS : C.J;
  const S = far ? C.SS : C.SK;
  return { J, S };
}

function drawArm(buf, sx, sy, a, far) {
  const { J, S } = armColors(far);
  const ex = sx + a[0];
  const ey = sy + a[1];
  const hx = sx + a[2];
  const hy = sy + a[3];
  buf.line(sx, sy, ex, ey, J);
  buf.line(ex, ey, hx, hy, S);
  buf.line(ex, ey, ex, ey, far ? C.JS : C.TR, 0, 0);
}

function drawLeg(buf, hx, hy, footX, footY, l, far, shoeW, facingRight) {
  const kx = hx + l[0];
  const ky = hy + l[1];
  const P = far ? C.PS : C.P;
  const K = far ? C.SOS : C.SO;
  buf.line(hx, hy, kx, ky, P);
  buf.line(kx, ky, footX, footY - 1, K);
  // shoe
  if (shoeW === 3) {
    const dir = facingRight ? 1 : -1;
    for (let i = 0; i < 3; i++) buf.set(footX + i * dir + (dir < 0 ? 1 : 0), footY, C.SH);
  } else {
    buf.set(footX, footY, C.SH);
    buf.set(footX + 1, footY, C.SH);
  }
}

/**
 * Rasterise a pose for a view into an index buffer (anchor-relative) and return the cropped frame.
 * @param {'side'|'front'|'back'} view
 * @param {object} p pose
 */
function rasterise(view, p) {
  const L = LAYOUT[view];
  const buf = new PixBuf(BW, BH);
  const by = p.by;
  const up = by + p.cy; // upper-body vertical offset
  const lean = view === 'side' ? p.lean : 0;
  const hipY = (i) => L.hip[i][1] + up;
  const hipX = (i) => L.hip[i][0];
  const footX = (i, l) => L.hip[i][0] + l[2];
  const footY = (i, l) => L.hip[i][1] + by + l[3];
  const shX = (i) => L.sh[i][0] + lean;
  const shY = (i) => L.sh[i][1] + up;
  const leg = (i, far) => {
    const l = i ? p.l1 : p.l0;
    drawLeg(buf, hipX(i), hipY(i), footX(i, l), footY(i, l), l, far, L.shoeW, true);
  };
  const arm = (i, far) => {
    if (far) { drawArm(buf, shX(i), shY(i), i ? p.a1 : p.a0, far); return; }
    const layer = new PixBuf(BW, BH);
    drawArm(layer, shX(i), shY(i), i ? p.a1 : p.a0, far);
    buf.overlay(layer, EDGE);
  };
  const torso = () => buf.bitmap(TORSO[view], L.torso[0], L.torso[1] + up, lean);
  const head = () => buf.bitmap(HELMET[view], L.head[0] + lean + p.hx, L.head[1] + up + p.hy);

  if (view === 'side') {
    arm(0, true);
    leg(0, true);
    torso();
    leg(1, false);
    head();
    arm(1, false);
  } else if (view === 'front') {
    leg(0, false);
    leg(1, false);
    torso();
    head();
    arm(0, false);
    arm(1, false);
  } else {
    leg(0, false);
    leg(1, false);
    torso();
    arm(0, false);
    arm(1, false);
    head();
  }
  buf.outline();
  return crop(buf);
}

// ---------------------------------------------------------------------------------------------
// Index-frame cache (team-independent)

const frameCache = new Map();

/**
 * Get the palette-index frame for a facing/anim/frame. DOM-free (used by tests and tooling).
 * @param {Facing} facing
 * @param {AnimName} anim
 * @param {number} frame
 * @returns {{w:number,h:number,data:Uint8Array,ox:number,oy:number,sw:number}}
 */
export function getIndexFrame(facing, anim, frame) {
  const def = ANIMS[anim] ? anim : 'idle';
  const nf = ANIMS[def].frames;
  const fi = Math.max(0, Math.min(nf - 1, frame | 0));
  const key = `${facing}|${def}|${fi}`;
  let f = frameCache.get(key);
  if (f) return f;
  if (facing === 'left') {
    f = mirrorX(getIndexFrame('right', def, fi));
  } else {
    const view = facing === 'up' ? 'back' : facing === 'down' ? 'front' : 'side';
    let poses = view === 'side' ? SIDE_POSES[def] : FRONT_POSES[def];
    let v = view;
    if (!poses) { poses = SIDE_POSES[def]; v = 'side'; }
    const p = poses[fi];
    if (p.lay === 'h') {
      // Rasterise upright (side view), then rotate so the head points along the facing.
      const upright = rasterise('side', { ...p, lay: null });
      f = rotCW(upright);
      f = { ...f, ox: Math.floor(f.w / 2), oy: f.h + p.lift, sw: Math.max(12, f.w - 2) };
      if (facing === 'down') f = mirrorX(f);
    } else if (p.lay === 'v') {
      // Sprawled along the screen's vertical axis (hand-drawn, seen from above).
      const buf = new PixBuf(BW, BH);
      const rows = SPRAWL[facing === 'down' ? 'down' : 'up'];
      buf.bitmap(rows, -Math.floor(rows[0].length / 2), -rows.length);
      buf.outline();
      f = crop(buf);
      f = { ...f, oy: Math.round(f.h * 0.56) + p.lift, sw: 10, sh: Math.round(f.h * 0.6) };
    } else {
      f = rasterise(v, p);
      f.sw = 10;
    }
  }
  frameCache.set(key, f);
  return f;
}

// ---------------------------------------------------------------------------------------------
// Colourised canvases

const OUTLINE = '#10121a';

function lookKey(look) {
  return `${look.primary}|${look.secondary}|${look.helmet}`;
}

/** Derive the full sprite palette (RGBA per index) for a team look + skin tone. */
function buildPalette(look, skin) {
  const primary = look.primary || '#3355aa';
  const secondary = look.secondary || '#ffffff';
  const helmet = look.helmet || primary;
  const skinHex = SKIN_TONES[((skin | 0) % SKIN_TONES.length + SKIN_TONES.length) % SKIN_TONES.length];
  let stripe = colorDist(helmet, primary) < 70 ? secondary : primary;
  if (colorDist(stripe, helmet) < 50) stripe = luma(helmet) > 0.5 ? darken(helmet, 0.55) : lighten(helmet, 0.5);
  let trim = secondary;
  if (colorDist(trim, primary) < 60) trim = luma(primary) > 0.5 ? '#1a1a22' : '#f4f1e8';
  const pants = luma(secondary) > 0.55 ? lighten(secondary, 0.12) : '#e6e1d2';
  const helmetDark = luma(helmet) < 0.14;
  const jerseyDark = luma(primary) < 0.14;
  const hex = new Array(N_COLORS).fill('#000000');
  hex[C.O] = OUTLINE;
  hex[C.H] = helmetDark ? lighten(helmet, 0.08) : helmet;
  hex[C.HS] = helmetDark ? helmet : darken(helmet, 0.74);
  hex[C.HL] = lighten(helmet, helmetDark ? 0.42 : 0.4);
  hex[C.ST] = stripe;
  hex[C.MK] = '#b4b9c2';
  hex[C.MKS] = '#767c88';
  hex[C.SK] = skinHex;
  hex[C.SS] = darken(skinHex, 0.8);
  hex[C.J] = jerseyDark ? lighten(primary, 0.08) : primary;
  hex[C.JS] = jerseyDark ? primary : darken(primary, 0.74);
  hex[C.JL] = lighten(primary, 0.28);
  hex[C.TR] = trim;
  hex[C.P] = pants;
  hex[C.PS] = darken(pants, 0.78);
  hex[C.SO] = jerseyDark ? lighten(primary, 0.15) : primary;
  hex[C.SOS] = darken(primary, 0.7);
  hex[C.SH] = '#22222a';
  hex[C.EY] = '#1c120c';
  hex[C.WH] = '#f4f1e8';
  return hex.map((hx, i) => (i === C.T ? [0, 0, 0, 0] : [...hexToRgb(hx), 255]));
}

const paletteCache = new Map();
const canvasCache = new Map();
const MAX_CANVASES = 2400; // ~4 team looks x 5 skins x 4 facings x 26 frames

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function colorize(frame, pal) {
  const c = makeCanvas(frame.w, frame.h);
  const g = c.getContext('2d');
  const img = g.createImageData(frame.w, frame.h);
  const px = img.data;
  for (let i = 0; i < frame.data.length; i++) {
    const p = pal[frame.data[i]];
    const o = i * 4;
    px[o] = p[0]; px[o + 1] = p[1]; px[o + 2] = p[2]; px[o + 3] = p[3];
  }
  g.putImageData(img, 0, 0);
  return c;
}

/**
 * Cached sprite canvas for a team look / facing / anim / frame / skin.
 * @param {TeamLook} look
 * @param {{facing?:Facing, anim?:AnimName, frame?:number, skin?:number}} opts
 * @returns {{canvas:HTMLCanvasElement, ox:number, oy:number, w:number, h:number, sw:number, sh:number}}
 *   ox/oy: anchor (feet centre) offset; sw/sh: suggested ground-shadow width/height (sh 0 = auto)
 */
export function getPlayerSprite(look, opts = {}) {
  look = look || {};
  const facing = FACINGS.includes(opts.facing) ? opts.facing : 'down';
  const anim = ANIMS[opts.anim] ? opts.anim : 'idle';
  const frame = Math.max(0, Math.min(ANIMS[anim].frames - 1, opts.frame | 0));
  const skin = ((opts.skin | 0) % SKIN_TONES.length + SKIN_TONES.length) % SKIN_TONES.length;
  const lk = lookKey(look);
  const key = `${lk}|${skin}|${facing}|${anim}|${frame}`;
  let s = canvasCache.get(key);
  if (s) return s;
  const pk = `${lk}|${skin}`;
  let pal = paletteCache.get(pk);
  if (!pal) { pal = buildPalette(look, skin); paletteCache.set(pk, pal); }
  const f = getIndexFrame(facing, anim, frame);
  s = { canvas: colorize(f, pal), ox: f.ox, oy: f.oy, w: f.w, h: f.h, sw: f.sw || 10, sh: f.sh || 0 };
  // Bound memory over a long franchise session (many opponents): drop the oldest entries.
  if (canvasCache.size >= MAX_CANVASES) {
    let n = MAX_CANVASES >> 2;
    for (const k of canvasCache.keys()) { canvasCache.delete(k); if (--n <= 0) break; }
  }
  canvasCache.set(key, s);
  return s;
}

/**
 * Frame index for an animation at time t (seconds since it started).
 * @param {AnimName} anim
 * @param {number} t
 */
export function frameAt(anim, t) {
  const a = ANIMS[anim] || ANIMS.idle;
  const i = Math.floor(Math.max(0, t || 0) * a.fps);
  return a.loop ? i % a.frames : Math.min(i, a.frames - 1);
}

// ---------------------------------------------------------------------------------------------
// Shadows, markers

const shadowCache = new Map();

function shadowCanvas(w, hh) {
  w = Math.max(2, Math.round(w));
  const h = hh ? Math.max(1, Math.round(hh)) : Math.max(1, Math.round(w * 0.32));
  const key = w * 1000 + h;
  let c = shadowCache.get(key);
  if (c) return c;
  c = makeCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  const rx = w / 2;
  const ry = h / 2;
  for (let y = 0; y < h; y++) {
    const dy = (y + 0.5 - ry) / ry;
    const half = Math.round(rx * Math.sqrt(Math.max(0, 1 - dy * dy)));
    if (half > 0) g.fillRect(Math.round(rx - half), y, half * 2, 1);
  }
  shadowCache.set(key, c);
  return c;
}

/**
 * Pixel ground shadow (ellipse) centred at (sx, sy).
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} sx
 * @param {number} sy
 * @param {number} w width in px
 * @param {number} [alpha=0.32]
 * @param {number} [h] height in px (default ~ w / 3)
 */
export function drawShadow(ctx, sx, sy, w, alpha = 0.32, h) {
  const c = shadowCanvas(w, h);
  const a = ctx.globalAlpha;
  ctx.globalAlpha = a * alpha;
  ctx.drawImage(c, Math.round(sx - c.width / 2), Math.round(sy - c.height / 2));
  ctx.globalAlpha = a;
}

const ringCache = new Map();

function ringCanvas(color, w) {
  const key = `${color}|${w}`;
  let c = ringCache.get(key);
  if (c) return c;
  const h = Math.max(4, Math.round(w * 0.42));
  c = makeCanvas(w, h);
  const g = c.getContext('2d');
  const rx = w / 2;
  const ry = h / 2;
  // pixel ellipse outline: compute filled mask then keep edge pixels
  const mask = [];
  for (let y = 0; y < h; y++) {
    const row = [];
    for (let x = 0; x < w; x++) {
      const dx = (x + 0.5 - rx) / rx;
      const dy = (y + 0.5 - ry) / ry;
      row.push(dx * dx + dy * dy <= 1);
    }
    mask.push(row);
  }
  const inside = (x, y) => y >= 0 && y < h && x >= 0 && x < w && mask[y][x];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y][x]) continue;
      const edge = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
      if (!edge) continue;
      g.fillStyle = OUTLINE;
      g.fillRect(x, y + 1, 1, 1);
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y][x]) continue;
      const edge = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
      if (!edge) continue;
      g.fillStyle = color;
      g.fillRect(x, y, 1, 1);
    }
  }
  ringCache.set(key, c);
  return c;
}

const ARROW = ['ooooooo', 'oYYYYYo', '.oYYYo.', '..oYo..', '...o...'];

const arrowCache = new Map();

function arrowCanvas(color) {
  let c = arrowCache.get(color);
  if (c) return c;
  c = makeCanvas(ARROW[0].length, ARROW.length);
  const g = c.getContext('2d');
  ARROW.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === '.') continue;
      g.fillStyle = row[x] === 'o' ? OUTLINE : color;
      g.fillRect(x, y, 1, 1);
    }
  });
  arrowCache.set(color, c);
  return c;
}

export const HIGHLIGHT_COLORS = { user: '#ffcc33', target: '#ffffff' };

/**
 * Draw a player with ground shadow and optional highlight marker.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} sx screen x of the feet
 * @param {number} sy screen y of the feet
 * @param {TeamLook} look
 * @param {{facing?:Facing, anim?:AnimName, t?:number, frame?:number, skin?:number,
 *   highlight?:'user'|'target'|null, alpha?:number, time?:number, shadow?:boolean}} [opts]
 *   t = seconds since the anim started (picks the frame); `frame` overrides it. `time` = global
 *   clock for marker bobbing (defaults to t).
 */
export function drawPlayer(ctx, sx, sy, look, opts = {}) {
  const anim = ANIMS[opts.anim] ? opts.anim : 'idle';
  const frame = opts.frame != null ? opts.frame : frameAt(anim, opts.t || 0);
  const spr = getPlayerSprite(look, { facing: opts.facing, anim, frame, skin: opts.skin });
  const x = Math.round(sx);
  const y = Math.round(sy);
  const prevAlpha = ctx.globalAlpha;
  if (opts.alpha != null) ctx.globalAlpha = prevAlpha * opts.alpha;
  const hl = opts.highlight;
  const clock = opts.time != null ? opts.time : (opts.t || 0);
  if (hl) {
    const color = HIGHLIGHT_COLORS[hl] || hl;
    const pulse = hl === 'target' && Math.floor(clock * 4) % 2 ? 2 : 0;
    const rw = Math.max(14, spr.sw + 4) + pulse;
    const ring = ringCanvas(color, rw);
    ctx.drawImage(ring, x - Math.floor(ring.width / 2), y - Math.floor(ring.height / 2));
  }
  if (opts.shadow !== false) drawShadow(ctx, x, y, spr.sw, 0.32, spr.sh || undefined);
  ctx.drawImage(spr.canvas, x - spr.ox, y - spr.oy);
  if (hl === 'user') {
    const a = arrowCanvas(HIGHLIGHT_COLORS.user);
    const bob = Math.floor(clock * 3) % 2;
    ctx.drawImage(a, x - Math.floor(a.width / 2), y - spr.oy - a.height - 2 - bob);
  }
  ctx.globalAlpha = prevAlpha;
}

// ---------------------------------------------------------------------------------------------
// Ball

const BALL_KEY = { '.': null, o: '#2a160b', b: '#8c4a20', L: '#c27a40', d: '#5c2d12', w: '#f3efe4' };

// [orientation][size] -> spin frames. orientation 0 = horizontal, 1 = '\', 2 = vertical, 3 = '/'
const BALL_H = {
  normal: [
    ['.oooo.', 'oLwwbo', 'obbbdo', '.oooo.'],
    ['.oooo.', 'oLbbbo', 'obwwdo', '.oooo.'],
    ['.oooo.', 'oLLbbo', 'obbbdo', '.oooo.'],
  ],
  big: [
    ['..oooo..', '.oLwwbo.', 'oLbbbbdo', '.obbbdo.', '..oooo..'],
    ['..oooo..', '.oLbbbo.', 'oLbbbbdo', '.obwwdo.', '..oooo..'],
    ['..oooo..', '.oLLbbo.', 'oLbbbbdo', '.obbddo.', '..oooo..'],
  ],
};

const BALL_D = {
  normal: [
    ['.oo..', 'oLwo.', 'obbwo', '.obdo', '..oo.'],
    ['.oo..', 'oLbo.', 'owbbo', '.owdo', '..oo.'],
    ['.oo..', 'oLbo.', 'obbbo', '.obdo', '..oo.'],
  ],
  big: [
    ['.oo...', 'oLbo..', 'oLwbo.', '.obwbo', '..obdo', '...oo.'],
    ['.oo...', 'oLbo..', 'obbwo.', '.owbbo', '..obdo', '...oo.'],
    ['.oo...', 'oLbo..', 'oLbbo.', '.obbbo', '..obdo', '...oo.'],
  ],
};

function transpose(rows) {
  const h = rows.length;
  const w = rows[0].length;
  const out = [];
  for (let x = 0; x < w; x++) {
    let s = '';
    for (let y = 0; y < h; y++) s += rows[y][x];
    out.push(s);
  }
  return out;
}

const mirrorRows = (rows) => rows.map((r) => r.split('').reverse().join(''));

const ballCache = new Map();

function ballCanvas(orient, size, spin) {
  const key = `${orient}|${size}|${spin}`;
  let c = ballCache.get(key);
  if (c) return c;
  let rows;
  if (orient === 0) rows = BALL_H[size][spin];
  else if (orient === 2) rows = transpose(BALL_H[size][spin]);
  else if (orient === 1) rows = BALL_D[size][spin];
  else rows = mirrorRows(BALL_D[size][spin]);
  const w = Math.max(...rows.map((r) => r.length));
  c = makeCanvas(w, rows.length);
  const g = c.getContext('2d');
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const col = BALL_KEY[row[x]];
      if (!col) continue;
      g.fillStyle = col;
      g.fillRect(x, y, 1, 1);
    }
  });
  ballCache.set(key, c);
  return c;
}

/**
 * Draw the ball. (sx, sy) = ground position on screen; the ball is lifted by z * ppy with a ground
 * shadow that shrinks/fades with height. Slightly larger sprite when high (z > 3.5 yd).
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} sx
 * @param {number} sy
 * @param {number} z height in yards
 * @param {{spin?:number, ppy?:number, angle?:number, shadow?:boolean, spinning?:boolean}} [opts]
 *   spin: clock (s) driving the spiral flicker; angle: screen-space travel direction (radians)
 *   used to orient the ball (default horizontal); spinning:false freezes the laces.
 */
export function drawBall(ctx, sx, sy, z = 0, opts = {}) {
  const ppy = opts.ppy || 10;
  const zz = Math.max(0, z || 0);
  if (opts.shadow !== false) {
    const sw = Math.max(3, Math.round(6 - zz * 0.25));
    drawShadow(ctx, sx, sy, sw, Math.max(0.14, 0.4 - zz * 0.02));
  }
  let orient = 0;
  if (opts.angle != null && Number.isFinite(opts.angle)) {
    let a = opts.angle % Math.PI;
    if (a < 0) a += Math.PI;
    orient = Math.round(a / (Math.PI / 4)) % 4;
  }
  const size = zz > 3.5 ? 'big' : 'normal';
  const spin = opts.spinning === false ? 0 : Math.floor((opts.spin || 0) * 14) % 3;
  const c = ballCanvas(orient, size, spin);
  ctx.drawImage(c, Math.round(sx - c.width / 2), Math.round(sy - zz * ppy - c.height / 2 - 1));
}

/** Drop every cached sprite canvas (e.g. after team colours change or a context loss). */
export function clearSpriteCache() {
  canvasCache.clear();
  paletteCache.clear();
  shadowCache.clear();
  ringCache.clear();
  arrowCache.clear();
  ballCache.clear();
}
