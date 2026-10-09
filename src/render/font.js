// Original tiny bitmap pixel font for canvas text. Two sizes:
//   'small' — 3x5 glyphs (a few wide letters like M/W/N use 4-5 columns for legibility)
//   'big'   — 5x7 glyphs
// Glyphs are bit patterns ('#' = ink) rendered with fillRect into a per-(size, colour) atlas canvas
// the first time a colour is used, then blitted with drawImage (nearest-neighbour, integer scale).
// Lowercase input is drawn as uppercase. Unknown characters render as '?'.
// measureText() is DOM-free, so layout can be computed in Node tests.

/** @typedef {'small'|'big'} FontSize */

const SMALL_SRC = {
  'A': ['.#.', '#.#', '###', '#.#', '#.#'],
  'B': ['##.', '#.#', '##.', '#.#', '##.'],
  'C': ['.##', '#..', '#..', '#..', '.##'],
  'D': ['##.', '#.#', '#.#', '#.#', '##.'],
  'E': ['###', '#..', '##.', '#..', '###'],
  'F': ['###', '#..', '##.', '#..', '#..'],
  'G': ['.##', '#..', '#.#', '#.#', '.##'],
  'H': ['#.#', '#.#', '###', '#.#', '#.#'],
  'I': ['###', '.#.', '.#.', '.#.', '###'],
  'J': ['..#', '..#', '..#', '#.#', '.#.'],
  'K': ['#.#', '#.#', '##.', '#.#', '#.#'],
  'L': ['#..', '#..', '#..', '#..', '###'],
  'M': ['#...#', '##.##', '#.#.#', '#...#', '#...#'],
  'N': ['#..#', '##.#', '#.##', '#..#', '#..#'],
  'O': ['.#.', '#.#', '#.#', '#.#', '.#.'],
  'P': ['##.', '#.#', '##.', '#..', '#..'],
  'Q': ['.#.', '#.#', '#.#', '##.', '.##'],
  'R': ['##.', '#.#', '##.', '#.#', '#.#'],
  'S': ['.##', '#..', '.#.', '..#', '##.'],
  'T': ['###', '.#.', '.#.', '.#.', '.#.'],
  'U': ['#.#', '#.#', '#.#', '#.#', '###'],
  'V': ['#.#', '#.#', '#.#', '#.#', '.#.'],
  'W': ['#...#', '#...#', '#.#.#', '##.##', '#...#'],
  'X': ['#.#', '#.#', '.#.', '#.#', '#.#'],
  'Y': ['#.#', '#.#', '.#.', '.#.', '.#.'],
  'Z': ['###', '..#', '.#.', '#..', '###'],
  '0': ['###', '#.#', '#.#', '#.#', '###'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['##.', '..#', '.#.', '#..', '###'],
  '3': ['##.', '..#', '.#.', '..#', '##.'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '##.', '..#', '##.'],
  '6': ['.##', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '.#.', '.#.', '.#.'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '##.'],
  '.': ['.', '.', '.', '.', '#'],
  ',': ['..', '..', '..', '.#', '#.'],
  ':': ['.', '#', '.', '#', '.'],
  '!': ['#', '#', '#', '.', '#'],
  '?': ['##.', '..#', '.#.', '...', '.#.'],
  '+': ['...', '.#.', '###', '.#.', '...'],
  '-': ['...', '...', '###', '...', '...'],
  '/': ['..#', '..#', '.#.', '#..', '#..'],
  '\'': ['#', '#', '.', '.', '.'],
  '&': ['.#..', '#.#.', '.#..', '#.##', '.##.'],
  '(': ['.#', '#.', '#.', '#.', '.#'],
  ')': ['#.', '.#', '.#', '.#', '#.'],
  '#': ['.#.#.', '#####', '.#.#.', '#####', '.#.#.'],
  '%': ['#.#', '..#', '.#.', '#..', '#.#'],
  ' ': ['..', '..', '..', '..', '..'],
};

const BIG_SRC = {
  'A': ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  'B': ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  'C': ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  'D': ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  'E': ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  'F': ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  'G': ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
  'H': ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  'I': ['###', '.#.', '.#.', '.#.', '.#.', '.#.', '###'],
  'J': ['....#', '....#', '....#', '....#', '#...#', '#...#', '.###.'],
  'K': ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  'L': ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  'M': ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  'N': ['#...#', '#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
  'O': ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  'P': ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  'Q': ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  'R': ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  'S': ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  'T': ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  'U': ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  'V': ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  'W': ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  'X': ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  'Y': ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  'Z': ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  '0': ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  '.': ['..', '..', '..', '..', '..', '##', '##'],
  ',': ['..', '..', '..', '..', '##', '.#', '#.'],
  ':': ['..', '##', '##', '..', '##', '##', '..'],
  '!': ['##', '##', '##', '##', '##', '..', '##'],
  '?': ['.###.', '#...#', '....#', '..##.', '..#..', '.....', '..#..'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  '-': ['....', '....', '....', '####', '....', '....', '....'],
  '/': ['....#', '....#', '...#.', '..#..', '.#...', '#....', '#....'],
  '\'': ['##', '##', '.#', '#.', '..', '..', '..'],
  '&': ['.##..', '#..#.', '#.#..', '.#...', '#.#.#', '#..#.', '.##.#'],
  '(': ['..#', '.#.', '#..', '#..', '#..', '.#.', '..#'],
  ')': ['#..', '.#.', '..#', '..#', '..#', '.#.', '#..'],
  '#': ['.#.#.', '.#.#.', '#####', '.#.#.', '#####', '.#.#.', '.#.#.'],
  '%': ['##..#', '##..#', '...#.', '..#..', '.#...', '#..##', '#..##'],
  ' ': ['...', '...', '...', '...', '...', '...', '...'],
};

/**
 * Compile a glyph table into atlas layout: each glyph gets an x offset in a single-row atlas.
 * @param {Object<string,string[]>} src
 * @param {number} h glyph height
 */
function compile(src, h) {
  const glyphs = new Map();
  let x = 0;
  for (const [ch, rows] of Object.entries(src)) {
    if (rows.length !== h) throw new Error(`font: glyph ${JSON.stringify(ch)} has ${rows.length} rows, want ${h}`);
    const w = rows[0].length;
    for (const r of rows) if (r.length !== w) throw new Error(`font: glyph ${JSON.stringify(ch)} has ragged rows`);
    glyphs.set(ch, { x, w, rows });
    x += w + 1; // 1px gutter so scaled blits never bleed
  }
  return { glyphs, h, atlasW: x, spacing: 1, lineGap: h <= 5 ? 2 : 3 };
}

/** Compiled font tables (exported for tests and tooling). */
export const FONTS = {
  small: compile(SMALL_SRC, 5),
  big: compile(BIG_SRC, 7),
};

/** Every character the font can render (both sizes share the same set). */
export const CHARSET = Object.keys(SMALL_SRC).join('');

function fontFor(size) {
  return FONTS[size] || FONTS.small;
}

function glyphFor(font, ch) {
  return font.glyphs.get(ch) || font.glyphs.get(ch.toUpperCase()) || font.glyphs.get('?');
}

/**
 * Pixel width of `text` (widest line when it contains '\n').
 * @param {string} text
 * @param {{size?:FontSize, scale?:number}} [opts]
 * @returns {number}
 */
export function measureText(text, opts = {}) {
  const font = fontFor(opts.size);
  const scale = Math.max(1, Math.round(opts.scale || 1));
  let best = 0;
  for (const line of String(text).split('\n')) {
    let w = 0;
    for (const ch of line) w += glyphFor(font, ch).w + font.spacing;
    if (w > 0) w -= font.spacing;
    if (w > best) best = w;
  }
  return best * scale;
}

/**
 * Pixel height of `text` at the given size/scale (accounts for '\n' line breaks).
 * @param {string} text
 * @param {{size?:FontSize, scale?:number}} [opts]
 */
export function textHeight(text, opts = {}) {
  const font = fontFor(opts.size);
  const scale = Math.max(1, Math.round(opts.scale || 1));
  const lines = String(text).split('\n').length;
  return (lines * font.h + (lines - 1) * font.lineGap) * scale;
}

const atlasCache = new Map();

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function atlasFor(size, color) {
  const key = `${size}|${color}`;
  let atlas = atlasCache.get(key);
  if (atlas) return atlas;
  const font = fontFor(size);
  atlas = makeCanvas(font.atlasW, font.h);
  const g = atlas.getContext('2d');
  g.fillStyle = color;
  for (const glyph of font.glyphs.values()) {
    for (let y = 0; y < font.h; y++) {
      const row = glyph.rows[y];
      for (let x = 0; x < glyph.w; x++) if (row[x] === '#') g.fillRect(glyph.x + x, y, 1, 1);
    }
  }
  if (atlasCache.size > 96) atlasCache.delete(atlasCache.keys().next().value);
  atlasCache.set(key, atlas);
  return atlas;
}

function drawRun(ctx, atlas, font, line, x, y, scale) {
  let cx = x;
  for (const ch of line) {
    const g = glyphFor(font, ch);
    if (ch !== ' ') ctx.drawImage(atlas, g.x, 0, g.w, font.h, cx, y, g.w * scale, font.h * scale);
    cx += (g.w + font.spacing) * scale;
  }
}

/**
 * Draw pixel text. (x, y) is the top of the first line; `align` positions it horizontally
 * around x. Coordinates are rounded to whole pixels for crispness.
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} x
 * @param {number} y
 * @param {{size?:FontSize, color?:string, align?:'left'|'center'|'right', shadow?:string, scale?:number}} [opts]
 * @returns {number} width in pixels of the widest line
 */
export function drawText(ctx, text, x, y, opts = {}) {
  const size = opts.size === 'big' ? 'big' : 'small';
  const font = FONTS[size];
  const scale = Math.max(1, Math.round(opts.scale || 1));
  const color = opts.color || '#ffffff';
  const align = opts.align || 'left';
  const lines = String(text).split('\n');
  const atlas = atlasFor(size, color);
  const shadow = opts.shadow ? atlasFor(size, opts.shadow) : null;
  const smooth = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  let widest = 0;
  let ly = Math.round(y);
  for (const line of lines) {
    const w = measureText(line, { size, scale });
    if (w > widest) widest = w;
    let lx = x;
    if (align === 'center') lx = x - w / 2;
    else if (align === 'right') lx = x - w;
    lx = Math.round(lx);
    if (shadow) drawRun(ctx, shadow, font, line, lx + scale, ly + scale, scale);
    drawRun(ctx, atlas, font, line, lx, ly, scale);
    ly += (font.h + font.lineGap) * scale;
  }
  ctx.imageSmoothingEnabled = smooth;
  return widest;
}

/** Drop cached glyph atlases (e.g. after a context loss). */
export function clearFontCache() {
  atlasCache.clear();
}
