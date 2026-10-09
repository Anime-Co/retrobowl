// DOM-free checks for the render art modules: bitmap font tables/metrics, procedural sprite
// index frames, animation frame selection and the cosmetic Fx particle lifecycle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FONTS, CHARSET, measureText, textHeight } from '../../src/render/font.js';
import { ANIMS, FACINGS, SKIN_TONES, getIndexFrame, frameAt, darken, lighten, luma } from '../../src/render/sprites.js';
import { Fx } from '../../src/render/fx.js';

const REQUIRED = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ.,:!?+-/\'&()#% ';

test('font: both sizes cover the required character set with consistent glyph sizes', () => {
  for (const ch of REQUIRED) assert.ok(CHARSET.includes(ch), `charset missing ${JSON.stringify(ch)}`);
  for (const [name, font] of Object.entries(FONTS)) {
    const h = name === 'small' ? 5 : 7;
    assert.equal(font.h, h);
    for (const ch of REQUIRED) {
      const g = font.glyphs.get(ch);
      assert.ok(g, `${name} missing ${JSON.stringify(ch)}`);
      assert.equal(g.rows.length, h);
      for (const r of g.rows) {
        assert.equal(r.length, g.w, `${name} ${JSON.stringify(ch)} ragged`);
        assert.match(r, /^[#.]+$/);
      }
      if (ch !== ' ') assert.ok(g.rows.some((r) => r.includes('#')), `${name} ${JSON.stringify(ch)} is blank`);
    }
    // nominal widths: small glyphs are 3 wide except a few wide letters; big glyphs <= 5
    for (const ch of '0123456789ABCDEFGHJKLOPQRSTUVXYZ') {
      assert.equal(font.glyphs.get(ch).w, name === 'small' ? 3 : 5, `${name} ${ch} width`);
    }
  }
});

test('font: glyph bitmaps are unique within a size (no accidental duplicates)', () => {
  for (const [name, font] of Object.entries(FONTS)) {
    const seen = new Map();
    for (const [ch, g] of font.glyphs) {
      const key = g.rows.join('|');
      // the round O and the zero share a shape in the big font by design
      if (seen.has(key) && !(name === 'big' && 'O0'.includes(ch) && 'O0'.includes(seen.get(key)))) {
        assert.fail(`${name}: ${JSON.stringify(ch)} duplicates ${JSON.stringify(seen.get(key))}`);
      }
      seen.set(key, ch);
    }
  }
});

test('font: measureText / textHeight', () => {
  assert.equal(measureText('', { size: 'small' }), 0);
  assert.equal(measureText('A', { size: 'small' }), 3);
  assert.equal(measureText('AB', { size: 'small' }), 7); // 3 + 1 + 3
  assert.equal(measureText('AB', { size: 'small', scale: 2 }), 14);
  assert.equal(measureText('10', { size: 'big' }), 11);
  assert.equal(measureText('ab', { size: 'small' }), measureText('AB', { size: 'small' }), 'lowercase maps to uppercase');
  assert.equal(measureText('A\nABC', { size: 'small' }), measureText('ABC', { size: 'small' }), 'widest line');
  assert.equal(measureText('~', { size: 'small' }), measureText('?', { size: 'small' }), 'unknown -> ?');
  assert.equal(measureText('M', { size: 'small' }), 5);
  assert.equal(textHeight('A', { size: 'small' }), 5);
  assert.equal(textHeight('A\nB', { size: 'big', scale: 2 }), (7 * 2 + 3) * 2);
});

test('sprites: every facing x anim x frame rasterises to a sane, outlined frame', () => {
  for (const facing of FACINGS) {
    for (const [anim, def] of Object.entries(ANIMS)) {
      for (let i = 0; i < def.frames; i++) {
        const f = getIndexFrame(facing, anim, i);
        const label = `${facing}/${anim}/${i}`;
        assert.ok(f.w >= 8 && f.w <= 30, `${label} width ${f.w}`);
        assert.ok(f.h >= 8 && f.h <= 30, `${label} height ${f.h}`);
        assert.equal(f.data.length, f.w * f.h);
        assert.ok(f.ox >= 0 && f.ox < f.w, `${label} ox ${f.ox}`);
        assert.ok(f.oy >= 1 && f.oy <= f.h + 3, `${label} oy ${f.oy}`);
        let opaque = 0;
        let outline = 0;
        for (const v of f.data) { if (v) opaque++; if (v === 1) outline++; }
        assert.ok(opaque > 60, `${label} too few pixels (${opaque})`);
        assert.ok(outline > 20, `${label} missing outline`);
        // the border of the cropped frame must be outline or transparent (never raw colour)
        for (let x = 0; x < f.w; x++) {
          assert.ok(f.data[x] <= 1 && f.data[(f.h - 1) * f.w + x] <= 1, `${label} unoutlined edge`);
        }
      }
    }
  }
});

test('sprites: upright frames stand on the anchor; left mirrors right', () => {
  const idle = getIndexFrame('down', 'idle', 0);
  assert.equal(idle.oy, idle.h - 1, 'the shoes\' bottom outline row sits on the ground line');
  assert.ok(idle.h >= 15 && idle.h <= 19, `player height ${idle.h}`);
  assert.ok(idle.w >= 11 && idle.w <= 14, `player width ${idle.w}`);
  for (const anim of Object.keys(ANIMS)) {
    for (let i = 0; i < ANIMS[anim].frames; i++) {
      const r = getIndexFrame('right', anim, i);
      const l = getIndexFrame('left', anim, i);
      assert.equal(l.w, r.w);
      assert.equal(l.ox, r.w - 1 - r.ox);
      for (let y = 0; y < r.h; y++) {
        for (let x = 0; x < r.w; x++) assert.equal(l.data[y * l.w + x], r.data[y * r.w + (r.w - 1 - x)]);
      }
    }
  }
  // celebrate jumps leave the ground (sprite bottom above the anchor)
  const jump = getIndexFrame('down', 'celebrate', 2);
  assert.ok(jump.oy > jump.h - 1, 'jump frame floats');
});

test('sprites: frameAt loops or holds per the anim table', () => {
  assert.equal(frameAt('run', 0), 0);
  assert.equal(frameAt('run', 1 / ANIMS.run.fps + 1e-6), 1);
  assert.equal(frameAt('run', 4 / ANIMS.run.fps + 1e-6), 0, 'run loops');
  assert.equal(frameAt('throw', 99), ANIMS.throw.frames - 1, 'throw holds last frame');
  assert.equal(frameAt('down', 5), 0);
  assert.equal(frameAt('nope', 0.6), frameAt('idle', 0.6));
  assert.equal(frameAt('idle', -3), 0);
});

test('sprites: colour helpers', () => {
  assert.equal(SKIN_TONES.length, 5);
  assert.ok(luma(darken('#80c0ff', 0.6)) < luma('#80c0ff'));
  assert.ok(luma(lighten('#204060', 0.5)) > luma('#204060'));
  assert.match(darken('#fff'), /^#[0-9a-f]{6}$/);
});

test('fx: particles and pops expire; clear empties everything', () => {
  const fx = new Fx();
  fx.burst(30, 20, { kind: 'turf' });
  fx.burst(30, 20, { kind: 'confetti', n: 40 });
  fx.burst(30, 20, { kind: 'hit', n: 5 });
  fx.burst(30, 20, { kind: 'spark' });
  fx.pop(30, 20, '+12 YDS', { dur: 0.5 });
  fx.flash('#fff', 0.2);
  assert.ok(fx.count > 50);
  for (let i = 0; i < 60; i++) fx.update(1 / 60);
  assert.equal(fx.pops.length, 0, 'pop expired after its duration');
  assert.equal(fx.flashT, 0);
  assert.ok(fx.parts.every((p) => p.z >= 0 && Number.isFinite(p.x) && Number.isFinite(p.y)));
  for (let i = 0; i < 300; i++) fx.update(1 / 60);
  assert.equal(fx.count, 0, 'everything expires');
  fx.burst(0, 0, { kind: 'confetti' });
  fx.clear();
  assert.equal(fx.count, 0);
  fx.maxParts = 50;
  fx.burst(0, 0, { kind: 'confetti', n: 500 });
  assert.equal(fx.parts.length, 50, 'particle cap');
});
