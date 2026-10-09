// On-field overlay drawing for the play view: dotted route lines, the aim arc / bullet line and
// their ground shadow, landing markers, kick meter (power bar, sweeping aim arrow, rush gauge),
// wind icon, banners and control tips. Pure drawing helpers over a Camera; everything is pixel
// art (fillRect / bitmap font, no anti-aliasing) and allocation-free on the per-frame path.

import { drawText, measureText } from '../../render/font.js';
import { drawRing } from '../../render/sprites.js';

export const INK = '#10121a';

const A = { x: 0, y: 0 };
const B = { x: 0, y: 0 };
const V = { x: 0, y: 0 };

/** Bresenham line of t x t squares in the current fillStyle. */
export function pixLine(ctx, x0, y0, x1, y1, t = 1) {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  const half = Math.floor(t / 2);
  let err = dx - dy;
  let n = dx + dy + 2;
  while (n-- > 0) {
    ctx.fillRect(x0 - half, y0 - half, t, t);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
}

/**
 * Walk a world-space polyline in SCREEN space and stamp a dot every `gap` px.
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('../../render/camera.js').Camera} cam
 * @param {{x:number,y:number,z?:number}[]} pts
 * @param {object} o
 *   n: number of points to use (default all); upto: fraction (0..1) of the last segment budget;
 *   color, gap (px), size (px), dash (px "on" length: draws dashes instead of dots),
 *   phase (px offset, for marching dots), ground (force z = 0), shadow (dark 1px drop shadow),
 *   fadeTail (px over which the last dots fade), alpha, maxPx (stop after this many px: grow-in),
 *   lean ({x, y}: extra screen px per yard of height above the straight chord between the first
 *   and last point - shows a lob's height when the throw runs along the screen's vertical axis)
 * @returns {number} screen length walked (px)
 */
export function dotPath(ctx, cam, pts, o) {
  const n = Math.min(o.n ?? pts.length, pts.length);
  if (n < 2) return 0;
  const gap = o.gap || 5;
  const size = o.size || 2;
  const dash = o.dash || 0;
  const ground = !!o.ground;
  const lean = !ground && o.lean && (o.lean.x || o.lean.y) ? o.lean : null;
  const last = pts.length - 1;
  const z0 = pts[0].z || 0;
  const z1 = pts[last].z || 0;
  const proj = (i, out) => {
    const p = pts[i];
    cam.project(p.x, p.y, ground ? 0 : p.z || 0, out);
    if (lean) {
      const hgt = (p.z || 0) - (z0 + ((z1 - z0) * i) / last);
      if (hgt > 0) { out.x += lean.x * hgt; out.y += lean.y * hgt; }
    }
    return out;
  };
  const prevAlpha = ctx.globalAlpha;
  const baseAlpha = prevAlpha * (o.alpha ?? 1);
  // total length (for the fading tail)
  let total = 0;
  if (o.fadeTail) {
    proj(0, A);
    for (let i = 1; i < n; i++) {
      proj(i, B);
      total += Math.hypot(B.x - A.x, B.y - A.y);
      A.x = B.x; A.y = B.y;
    }
  }
  let walked = 0;
  let next = ((o.phase || 0) % gap + gap) % gap;
  proj(0, A);
  const h = Math.floor(size / 2);
  for (let i = 1; i < n; i++) {
    proj(i, B);
    const sx = B.x - A.x;
    const sy = B.y - A.y;
    const len = Math.hypot(sx, sy);
    while (next <= walked + len) {
      if (o.maxPx != null && next > o.maxPx) break;
      const f = len > 0 ? (next - walked) / len : 0;
      const x = Math.round(A.x + sx * f);
      const y = Math.round(A.y + sy * f);
      let a = baseAlpha;
      if (o.fadeTail && total - next < o.fadeTail) a *= Math.max(0.15, (total - next) / o.fadeTail);
      ctx.globalAlpha = a;
      if (dash) {
        const ux = len > 0 ? sx / len : 1;
        const uy = len > 0 ? sy / len : 0;
        const ex = Math.round(x + ux * dash);
        const ey = Math.round(y + uy * dash);
        if (o.shadow) { ctx.fillStyle = INK; pixLine(ctx, x + 1, y + 1, ex + 1, ey + 1, size); }
        ctx.fillStyle = o.color;
        pixLine(ctx, x, y, ex, ey, size);
      } else {
        if (o.shadow) { ctx.fillStyle = INK; ctx.fillRect(x - h + 1, y - h + 1, size, size); }
        ctx.fillStyle = o.color;
        ctx.fillRect(x - h, y - h, size, size);
      }
      next += gap;
    }
    walked += len;
    A.x = B.x; A.y = B.y;
  }
  ctx.globalAlpha = prevAlpha;
  return walked;
}

/** Small arrowhead at screen (x, y) pointing along (dx, dy). Uses `color` with an ink outline. */
export function arrowHead(ctx, x, y, dx, dy, color, size = 4) {
  const l = Math.hypot(dx, dy) || 1;
  const ux = dx / l;
  const uy = dy / l;
  const c = Math.cos(2.5);
  const s = Math.sin(2.5);
  const lx = x + (ux * c - uy * s) * size;
  const ly = y + (ux * s + uy * c) * size;
  const rx = x + (ux * c + uy * s) * size;
  const ry = y + (-ux * s + uy * c) * size;
  ctx.fillStyle = INK;
  pixLine(ctx, x + 1, y + 1, lx + 1, ly + 1, 2);
  pixLine(ctx, x + 1, y + 1, rx + 1, ry + 1, 2);
  ctx.fillStyle = color;
  pixLine(ctx, x, y, lx, ly, 2);
  pixLine(ctx, x, y, rx, ry, 2);
}

/** Arrowhead at the end of a world polyline (screen direction of its last segment). */
export function pathArrow(ctx, cam, pts, color, size = 4) {
  const n = pts.length;
  if (n < 2) return;
  cam.project(pts[n - 2].x, pts[n - 2].y, 0, A);
  cam.project(pts[n - 1].x, pts[n - 1].y, 0, B);
  arrowHead(ctx, B.x, B.y, B.x - A.x, B.y - A.y, color, size);
}

/** "T" block marker in front of a blocker: a short stem toward +x then a crossbar. */
export function blockMarker(ctx, cam, x, y, color) {
  cam.project(x + 0.35, y, 0, A);
  cam.project(x + 1.25, y, 0, B);
  ctx.fillStyle = INK;
  pixLine(ctx, A.x + 1, A.y + 1, B.x + 1, B.y + 1, 1);
  ctx.fillStyle = color;
  pixLine(ctx, A.x, A.y, B.x, B.y, 1);
  cam.project(x + 1.25, y - 0.7, 0, A);
  cam.project(x + 1.25, y + 0.7, 0, V);
  ctx.fillStyle = INK;
  pixLine(ctx, A.x + 1, A.y + 1, V.x + 1, V.y + 1, 2);
  ctx.fillStyle = color;
  pixLine(ctx, A.x, A.y, V.x, V.y, 2);
}

/** Ground target marker (pulsing ring + centre pip). */
export function landingMarker(ctx, cam, x, y, color, time, w = 12) {
  cam.project(x, y, 0, A);
  const pulse = Math.floor(time * 5) % 2;
  drawRing(ctx, A.x, A.y, w + pulse * 2, color, 0.95);
  ctx.fillStyle = INK;
  ctx.fillRect(Math.round(A.x), Math.round(A.y), 2, 2);
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(A.x) - 1, Math.round(A.y) - 1, 2, 2);
}

/** Dark rounded-ish pixel panel. */
export function panel(ctx, x, y, w, h, alpha = 0.72, color = INK) {
  const a = ctx.globalAlpha;
  ctx.globalAlpha = a * alpha;
  ctx.fillStyle = color;
  x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
  ctx.fillRect(x + 1, y, w - 2, h);
  ctx.fillRect(x, y + 1, w, h - 2);
  ctx.globalAlpha = a;
}

/**
 * Vertical meter: frame, fill 0..1, optional highlighted top band (e.g. the green power band).
 * @param {{band?:number, bandColor?:string, fill?:string, marker?:boolean, dim?:boolean}} o
 */
export function vMeter(ctx, x, y, w, h, value, o = {}) {
  x = Math.round(x); y = Math.round(y);
  ctx.fillStyle = INK;
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
  ctx.fillStyle = '#2a3042';
  ctx.fillRect(x, y, w, h);
  if (o.band != null) {
    const bh = Math.max(2, Math.round(h * (1 - o.band)));
    ctx.fillStyle = o.bandColor || '#2f8f3f';
    ctx.fillRect(x, y, w, bh);
  }
  const v = Math.max(0, Math.min(1, value));
  const fh = Math.round(h * v);
  const a = ctx.globalAlpha;
  if (o.dim) ctx.globalAlpha = a * 0.55;
  ctx.fillStyle = o.fill || '#ffd23a';
  ctx.fillRect(x + 1, y + h - fh, w - 2, fh);
  if (o.band != null && v >= o.band) {
    ctx.fillStyle = '#7dff8a';
    ctx.fillRect(x + 1, y + h - fh, w - 2, Math.min(fh, Math.max(2, Math.round(h * (1 - o.band)))));
  }
  ctx.globalAlpha = a;
  if (o.marker !== false) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x - 2, y + h - fh - 1, w + 4, 2);
  }
}

/** Horizontal gauge (rush pressure etc.). */
export function hMeter(ctx, x, y, w, h, value, color) {
  x = Math.round(x); y = Math.round(y);
  ctx.fillStyle = INK;
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
  ctx.fillStyle = '#2a3042';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, Math.round(w * Math.max(0, Math.min(1, value))), h);
}

/**
 * Wind icon: panel with an arrow pointing the way the wind blows ON SCREEN plus "WIND / 12 MPH".
 * (x, y) = top-left; (dirX, dirY) = screen-space wind vector (any length). Returns the width.
 */
export function windIcon(ctx, x, y, dirX, dirY, mph) {
  const calm = mph < 0.5;
  const label = calm ? 'CALM' : `${Math.round(mph)} MPH`;
  const tw = Math.max(measureText(label, { size: 'small' }), measureText('WIND', { size: 'small' }));
  const w = 18 + tw + 4;
  const h = 18;
  x = Math.round(x); y = Math.round(y);
  panel(ctx, x, y, w, h, 0.78);
  const cx = x + 9;
  const cy = y + 9;
  if (!calm) {
    const l = Math.hypot(dirX, dirY) || 1;
    const ux = dirX / l;
    const uy = dirY / l;
    ctx.fillStyle = '#ffffff';
    pixLine(ctx, cx - ux * 6, cy - uy * 6, cx + ux * 4, cy + uy * 4, 1);
    arrowHead(ctx, cx + ux * 6, cy + uy * 6, ux, uy, '#ffffff', 4);
  } else {
    ctx.fillStyle = '#8f97a8';
    ctx.fillRect(cx - 1, cy - 1, 2, 2);
  }
  drawText(ctx, 'WIND', x + 18, y + 2, { size: 'small', color: '#8f97a8' });
  drawText(ctx, label, x + 18, y + 10, { size: 'small', color: mph >= 12 ? '#ffb347' : '#ffffff' });
  return w;
}

/**
 * Full-width banner band with big text (and an optional subtitle) at screen y.
 * `k` = 0..1 animation progress (slide in at the start, fade at the end).
 */
export function banner(ctx, vw, y, text, o) {
  const scale = o.scale;
  const tw = measureText(text, { size: 'big', scale });
  const th = 7 * scale;
  const padY = Math.max(3, scale * 2);
  const k = o.k;
  const slide = k < 0.12 ? 1 - k / 0.12 : 0;
  const fade = k > 0.85 ? Math.max(0, 1 - (k - 0.85) / 0.15) : 1;
  const a = ctx.globalAlpha;
  ctx.globalAlpha = a * fade;
  const subBig = o.sub && measureText(o.sub, { size: 'big' }) <= vw - 8;
  const bandH = th + padY * 2 + (o.sub ? (subBig ? 12 : 9) : 0);
  const by = Math.round(y - padY);
  // band: team colour stripe with ink edges
  ctx.globalAlpha = a * fade * 0.86;
  ctx.fillStyle = o.band || INK;
  ctx.fillRect(0, by, vw, bandH);
  ctx.globalAlpha = a * fade;
  ctx.fillStyle = o.edge || '#ffffff';
  ctx.fillRect(0, by - 1, vw, 1);
  ctx.fillRect(0, by + bandH, vw, 1);
  const dx = Math.round(slide * (vw * 0.6) * (o.fromLeft ? -1 : 1));
  drawText(ctx, text, Math.round(vw / 2 - tw / 2) + dx, Math.round(y), { size: 'big', scale, color: o.color || '#ffffff', shadow: o.shadow || INK });
  if (o.sub) {
    drawText(ctx, o.sub, Math.round(vw / 2) + dx, Math.round(y + th + 3), { size: subBig ? 'big' : 'small', color: o.subColor || '#e9e4d4', align: 'center', shadow: INK });
  }
  ctx.globalAlpha = a;
  return bandH;
}

/** Size of a tip box ({w, h} px incl. padding, font size) for `text` within `maxW`. */
export function tipSize(text, maxW) {
  const lines = text.split('\n');
  let w = 0;
  for (const ln of lines) w = Math.max(w, measureText(ln, { size: 'big' }));
  const useSmall = w + 12 > maxW;
  const size = useSmall ? 'small' : 'big';
  const lh = useSmall ? 7 : 10;
  w = 0;
  for (const ln of lines) w = Math.max(w, measureText(ln, { size }));
  return { w: w + 12, h: lines.length * lh + 6, size, lh, tw: w, lines };
}

/** Multi-line tip box centred at (cx, bottom y). Returns its height. */
export function tipBox(ctx, cx, bottom, text, alpha, maxW) {
  const { h, size, lh, tw: w, lines } = tipSize(text, maxW);
  const x = Math.round(cx - w / 2 - 6);
  const y = Math.round(bottom - h);
  const a = ctx.globalAlpha;
  ctx.globalAlpha = a * alpha;
  panel(ctx, x, y, w + 12, h, 0.78);
  ctx.fillStyle = '#ffcc33';
  ctx.fillRect(x + 1, y, w + 10, 1);
  for (let i = 0; i < lines.length; i++) {
    drawText(ctx, lines[i], Math.round(cx), y + 4 + i * lh, { size, color: '#ffffff', align: 'center' });
  }
  ctx.globalAlpha = a;
  return h;
}

/** Tiny "RUN" / "BULLET" style label with a pointer, above a player (screen coords of feet). */
export function tagAbove(ctx, sx, sy, text, color, lift = 30) {
  const w = measureText(text, { size: 'small' }) + 6;
  const x = Math.round(sx - w / 2);
  const y = Math.round(sy - lift);
  panel(ctx, x, y, w, 9, 0.8);
  drawText(ctx, text, Math.round(sx), y + 2, { size: 'small', color, align: 'center' });
}
