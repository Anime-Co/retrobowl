// Standalone art preview: live field scene + sprite / ball / font galleries.
// URL params: ?o=portrait|landscape (force orientation), ?x=<yard> (camera x), ?y=<yard> (camera
//             y, clamped like the game camera), ?ui=0 (hide bar),
//             ?t=<seconds> (freeze the live scene at a time), ?teams=BOS,CHI
// Exposes window.__preview = { ready, fieldMs, ... } once everything has been drawn.

import { Display } from '../src/render/display.js';
import { Camera, FIELD_W } from '../src/render/camera.js';
import { TEAM_TEMPLATES, teamTemplate } from '../src/data/teams.js';
import { drawPlayer, drawBall, getPlayerSprite, ANIMS, FACINGS, SKIN_TONES } from '../src/render/sprites.js';
import { FieldRenderer, FIELD_COLORS } from '../src/render/field.js';
import { drawText, measureText, CHARSET } from '../src/render/font.js';
import { Fx } from '../src/render/fx.js';

const params = new URLSearchParams(location.search);
const forceO = params.get('o');
const freezeT = params.has('t') ? Number(params.get('t')) : null;
const startX = params.has('x') ? Number(params.get('x')) : 38;
const startY = params.has('y') ? Number(params.get('y')) : null;
const errors = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));

const lookOf = (t) => ({ abbr: t.abbr, city: t.city, primary: t.primary, secondary: t.secondary, helmet: t.helmet });
const teamIds = (params.get('teams') || 'BOS,CHI').split(',');
const HOME = lookOf(teamTemplate(teamIds[0]) || TEAM_TEMPLATES[0]);
const AWAY = lookOf(teamTemplate(teamIds[1]) || TEAM_TEMPLATES[12]);
const GALLERY_LOOKS = [HOME, AWAY, lookOf(teamTemplate('SDG'))];

const dpr = () => Math.min(window.devicePixelRatio || 1, 3);

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Size a gallery canvas at an integer device-pixel zoom so it stays crisp. */
function present(canvas, host, maxZoom = 4) {
  canvas.className = 'sheet';
  host.appendChild(canvas);
  const avail = Math.max(100, (host.clientWidth || window.innerWidth - 32) * dpr());
  const zoom = Math.max(1, Math.min(maxZoom * dpr(), Math.floor(avail / canvas.width)));
  canvas.style.width = `${(canvas.width * zoom) / dpr()}px`;
  canvas.style.height = `${(canvas.height * zoom) / dpr()}px`;
}

// ---------------------------------------------------------------------------------------------
// Live scene

const live = document.getElementById('live');
if (forceO === 'portrait') live.classList.add('force-portrait');
if (forceO === 'landscape') live.classList.add('force-landscape');
if (params.get('ui') === '0') document.getElementById('bar').hidden = true;
for (const b of document.querySelectorAll('[data-o]')) {
  b.setAttribute('aria-pressed', String((forceO || 'auto') === b.dataset.o));
  b.addEventListener('click', () => {
    const p = new URLSearchParams(location.search);
    if (b.dataset.o === 'auto') p.delete('o'); else p.set('o', b.dataset.o);
    location.search = p.toString();
  });
}

const display = new Display(document.getElementById('view'));
const camera = new Camera();
const field = new FieldRenderer();
field.setTeams(HOME, AWAY);
const fx = new Fx();
let camX = startX;
const yard = document.getElementById('yard');
yard.value = String(camX);
yard.addEventListener('input', () => { camX = Number(yard.value); });
let paused = false;
document.getElementById('pause').addEventListener('click', (e) => {
  paused = !paused;
  e.currentTarget.setAttribute('aria-pressed', String(paused));
});

function syncCamera() {
  camera.setViewport(display.w, display.h, display.orientation);
}
display.onResize(syncCamera);
syncCamera();

const mid = FIELD_W / 2;
const smooth = (a, b, k) => a + (b - a) * Math.max(0, Math.min(1, k));
const ease = (k) => k * k * (3 - 2 * k);

/** Scripted sample play (period 7s) relative to the line of scrimmage. Returns entities. */
function scene(t, los) {
  const P = 7;
  const tt = ((t % P) + P) % P;
  const snapT = 1.0;
  const throwT = 2.1;
  const catchT = 3.2;
  const tackleT = 4.5;
  const ents = [];
  const add = (look, x, y, vx, vy, anim, animT, extra = {}) => ents.push({ look, x, y, vx, vy, anim, animT, ...extra });
  const live = tt >= snapT;
  // Offensive line + defensive line
  for (let i = -2; i <= 2; i++) {
    const y = mid + i * 1.4;
    const push = live ? Math.min(1, (tt - snapT) * 2) : 0;
    add(HOME, los - 0.9 + push * 0.4, y, 1, 0, live ? 'block' : 'stance', tt - snapT, { skin: (i + 7) % 5 });
    if (Math.abs(i) <= 1) {
      add(AWAY, los + 1.0 + push * 0.4, y + 0.6, -1, 0, live ? 'block' : 'stance', tt - snapT, { skin: (i + 9) % 5 });
    }
  }
  // QB drops back then throws
  const drop = live ? ease(Math.min(1, (tt - snapT) / 0.9)) : 0;
  const qbX = los - 4 - drop * 3;
  let qbAnim = live ? (tt < snapT + 0.9 ? 'run' : 'idle') : 'idle';
  if (tt >= throwT - 0.3 && tt < throwT + 0.6) qbAnim = 'throw';
  add(HOME, qbX, mid, live && tt < snapT + 0.9 ? -1 : 1, 0, qbAnim, qbAnim === 'throw' ? tt - (throwT - 0.3) : tt, { skin: 1, user: tt < throwT });
  // RB
  add(HOME, los - 6.5, mid + 1.2, 1, 0, live ? 'block' : 'idle', tt, { skin: 3 });
  // WR route: up the field then an in-cut
  const wr0 = { x: los - 0.6, y: mid - 13 };
  const k = live ? Math.min(1, (tt - snapT) / (tackleT - snapT)) : 0;
  const wrX = wr0.x + k * 18;
  const wrY = wr0.y + Math.max(0, k - 0.45) * 12;
  let wrAnim = live ? 'run' : 'stance';
  if (tt >= catchT - 0.15 && tt < catchT + 0.25) wrAnim = 'catch';
  if (tt >= tackleT) wrAnim = 'down';
  const wrVx = 18 / (tackleT - snapT);
  const wrVy = k > 0.45 ? 12 / (tackleT - snapT) : 0;
  add(HOME, wrX, wrY, wrVx, wrVy, wrAnim, wrAnim === 'catch' ? tt - catchT + 0.15 : tt, {
    skin: 4, target: tt >= throwT - 0.5 && tt < catchT, user: tt >= catchT && tt < tackleT,
  });
  // Second WR (other side) + covering DB
  const wr2X = los - 0.6 + k * 11;
  add(HOME, wr2X, mid + 14 - k * 2, 1, -0.2, live ? 'run' : 'stance', tt * 1.1, { skin: 2 });
  add(AWAY, los + 7 + k * 7, mid + 13.5 - k * 2, live ? 1 : -1, 0, live ? 'run' : 'idle', tt, { skin: 0 });
  // Safety that tackles the WR
  const sx = smooth(los + 14, wrX + 1.2, ease(Math.min(1, Math.max(0, (tt - snapT) / (tackleT - snapT)))));
  const sy = smooth(mid - 4, wrY + 0.3, ease(Math.min(1, Math.max(0, (tt - snapT) / (tackleT - snapT)))));
  let sAnim = live ? 'run' : 'idle';
  if (tt >= tackleT - 0.3) sAnim = 'tackle';
  add(AWAY, sx, sy, wrX - sx || -1, wrY - sy, sAnim, sAnim === 'tackle' ? tt - (tackleT - 0.3) : tt, { skin: 2 });
  // Linebacker drops
  add(AWAY, los + 5 - k * 1, mid + 3, -1, 0.3, live ? 'run' : 'idle', tt * 0.9, { skin: 3 });
  // Celebrating teammates (kicker-style demo) near the far hash
  add(HOME, los - 9, mid - 8, 0, 1, 'celebrate', tt, { skin: 0 });
  add(HOME, los - 10, mid - 6, 1, 0, 'kick', (tt % 1.4), { skin: 2 });
  // Ball
  let ball;
  const qbHand = { x: qbX + 0.3, y: mid };
  if (tt < snapT) ball = { x: los - 0.2, y: mid, z: 0.15 };
  else if (tt < throwT) ball = { x: qbHand.x, y: qbHand.y + 0.2, z: 1.1 };
  else if (tt < catchT) {
    const f = (tt - throwT) / (catchT - throwT);
    const cx = wr0.x + ((catchT - snapT) / (tackleT - snapT)) * 18;
    const cy = wr0.y + Math.max(0, (catchT - snapT) / (tackleT - snapT) - 0.45) * 12;
    ball = { x: smooth(qbHand.x, cx, f), y: smooth(qbHand.y, cy, f), z: 1.6 + Math.sin(f * Math.PI) * 6, air: true, f };
    ball.vx = cx - qbHand.x;
    ball.vy = cy - qbHand.y;
  } else if (tt < tackleT) ball = { x: wrX + 0.2, y: wrY + 0.3, z: 0.9 };
  else ball = { x: wrX + 0.9, y: wrY + 0.4, z: 0.15 };
  return { ents, ball, tt, events: { snapT, throwT, catchT, tackleT } };
}

let lastTT = 0;
let simT = freezeT != null ? freezeT : 0;
let lastNow = performance.now();
let frames = 0;
let fpsAcc = 0;
let fps = 0;

function triggerFx(prev, tt, s, los) {
  const crossed = (at) => prev < at && tt >= at;
  const { snapT, catchT, tackleT } = s.events;
  if (crossed(snapT)) { fx.burst(los, mid, { kind: 'turf', n: 10 }); }
  if (crossed(catchT)) {
    const wr = s.ents.find((e) => e.anim === 'catch' || e.user);
    if (wr) { fx.burst(wr.x, wr.y, { kind: 'spark' }); fx.pop(wr.x, wr.y, 'CATCH!', { color: '#ffffff', size: 'small' }); }
  }
  if (crossed(tackleT)) {
    const wr = s.ents.find((e) => e.anim === 'down');
    if (wr) {
      fx.burst(wr.x, wr.y, { kind: 'hit' });
      fx.burst(wr.x, wr.y, { kind: 'turf', n: 12 });
      fx.pop(wr.x, wr.y, '+18 YDS', { color: '#ffcc33' });
      camera.shake(2, 0.25);
    }
  }
  if (crossed(5.6)) {
    fx.burst(los - 9, mid - 8, { kind: 'confetti', n: 60 });
    fx.pop(los - 9, mid - 8, 'TOUCHDOWN!', { color: '#ffffff', dur: 1.4 });
    fx.flash('#ffffff', 0.2);
  }
}

function drawLive(dt) {
  const ctx = display.begin('#000');
  const los = Math.round(camX) - (camera.orientation === 'landscape' ? 6 : 14);
  const s = scene(simT, los);
  triggerFx(lastTT, s.tt, s, los);
  lastTT = s.tt;
  // same clamping as the game camera (shows at most ~3 yd beyond the field edges)
  camera.snapTo(camX, startY != null ? startY : camera.orientation === 'landscape' ? mid - 3 : mid);
  // camera shake offsets (camera.follow normally handles this)
  if (camera.shakeT > 0) {
    camera.shakeT -= dt;
    const m = camera.shakeMag * Math.max(0, camera.shakeT) * 4;
    camera.ox = (Math.random() - 0.5) * m;
    camera.oy = (Math.random() - 0.5) * m;
  } else { camera.ox = 0; camera.oy = 0; }
  const t0 = performance.now();
  field.draw(ctx, camera, { losX: los, firstDownX: los + 10, time: simT, posts: false });
  const fieldMs = performance.now() - t0;
  field.drawPosts(ctx, camera, 'behind');
  const ents = s.ents.slice().sort((a, b) => camera.toScreen(a.x, a.y).y - camera.toScreen(b.x, b.y).y);
  for (const e of ents) {
    const p = camera.toScreen(e.x, e.y);
    const facing = camera.facingFor(e.vx, e.vy);
    drawPlayer(ctx, p.x, p.y, e.look, {
      facing, anim: e.anim, t: e.animT, skin: e.skin, time: simT,
      highlight: e.user ? 'user' : e.target ? 'target' : null,
    });
  }
  const b = s.ball;
  const bp = camera.toScreen(b.x, b.y);
  let angle;
  if (b.air) {
    const a = camera.toScreen(b.x, b.y, b.z);
    const n = camera.toScreen(b.x + b.vx * 0.02, b.y + b.vy * 0.02, b.z + Math.cos(b.f * Math.PI) * 0.12);
    angle = Math.atan2(n.y - a.y, n.x - a.x);
  }
  drawBall(ctx, bp.x, bp.y, b.z, { spin: simT, ppy: camera.ppy, angle, spinning: !!b.air });
  field.drawPosts(ctx, camera, 'front');
  fx.update(dt);
  fx.render(ctx, camera);
  // HUD sample (font on the canvas)
  drawText(ctx, `${HOME.abbr} 14`, 6, display.h - 12, { size: 'big', color: '#ffffff', shadow: '#10121a' });
  drawText(ctx, `${AWAY.abbr} 10`, display.w - 6, display.h - 12, { size: 'big', color: '#ffffff', shadow: '#10121a', align: 'right' });
  drawText(ctx, '2ND & 10  Q3 4:12', display.w / 2, display.h - 10, { size: 'small', color: '#ffcc33', shadow: '#10121a', align: 'center' });
  display.present();
  return fieldMs;
}

const statsEl = document.getElementById('stats');
let fieldAvg = 0;

function tick(now) {
  const dt = Math.min(0.1, (now - lastNow) / 1000);
  lastNow = now;
  if (!paused && freezeT == null) simT += dt;
  const fm = drawLive(paused || freezeT != null ? 0 : dt);
  fieldAvg = fieldAvg ? fieldAvg * 0.95 + fm * 0.05 : fm;
  frames++;
  fpsAcc += dt;
  if (fpsAcc >= 0.5) { fps = frames / fpsAcc; frames = 0; fpsAcc = 0; }
  statsEl.textContent = `${display.w}x${display.h} @${display.scale}x  ppy ${camera.ppy}  ${camera.orientation}  field ${fieldAvg.toFixed(2)}ms  ${fps.toFixed(0)}fps`;
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------------------------
// Galleries

const ANIM_NAMES = Object.keys(ANIMS);

function turfRow(g, y, h, w, i) {
  g.fillStyle = i % 2 ? FIELD_COLORS.turfB : FIELD_COLORS.turfA;
  g.fillRect(0, y, w, h);
}

function playerSheet(look) {
  const cell = 22;
  const labelW = 46;
  const blockGap = 6;
  const blockW = 4 * cell + blockGap;
  const rowH = 34;
  const headH = 24;
  const w = labelW + blockW * 4;
  const h = headH + rowH * ANIM_NAMES.length + 4;
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = '#10121a';
  g.fillRect(0, 0, w, h);
  drawText(g, `${look.city.toUpperCase()} (${look.abbr})`, 3, 4, { size: 'small', color: '#ffcc33' });
  FACINGS.forEach((f, i) => drawText(g, f.toUpperCase(), labelW + i * blockW + 2, 14, { size: 'small', color: '#8f97a8' }));
  ANIM_NAMES.forEach((anim, r) => {
    const y = headH + r * rowH;
    turfRow(g, y, rowH, w, r);
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(0, y, labelW - 4, rowH);
    drawText(g, anim.toUpperCase(), 3, y + 12, { size: 'small', color: '#ffffff' });
    FACINGS.forEach((facing, fi) => {
      for (let f = 0; f < ANIMS[anim].frames; f++) {
        const x = labelW + fi * blockW + f * cell + cell / 2;
        const spr = getPlayerSprite(look, { facing, anim, frame: f });
        const lift = spr.h - spr.oy > 2 ? spr.h - spr.oy : 0; // sprawled frames extend below the anchor
        drawPlayer(g, x, y + rowH - 6 - lift, look, { facing, anim, frame: f, skin: (r + fi) % 5 });
      }
    });
  });
  return c;
}

function skinSheet(look) {
  const cell = 24;
  const w = 8 + SKIN_TONES.length * 4 * cell + 3 * 6 + 120;
  const h = 96;
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  turfRow(g, 0, h / 2, w, 0);
  turfRow(g, h / 2, h / 2, w, 1);
  let x = 8 + cell / 2;
  for (let s = 0; s < SKIN_TONES.length; s++) {
    FACINGS.forEach((facing) => {
      drawPlayer(g, x, 30, look, { facing, anim: 'idle', frame: 0, skin: s });
      drawPlayer(g, x, 76, look, { facing, anim: 'run', frame: 1, skin: s });
      x += cell;
    });
    x += 6;
  }
  // highlight markers
  drawPlayer(g, x + 14, 36, look, { facing: 'right', anim: 'run', frame: 0, skin: 1, highlight: 'user', time: 0 });
  drawPlayer(g, x + 50, 36, look, { facing: 'down', anim: 'catch', frame: 0, skin: 3, highlight: 'target', time: 0 });
  drawPlayer(g, x + 86, 36, look, { facing: 'up', anim: 'run', frame: 2, skin: 2, highlight: 'user', time: 0.4, alpha: 0.5 });
  drawText(g, 'USER', x + 14, 78, { size: 'small', color: '#ffcc33', align: 'center', shadow: '#10121a' });
  drawText(g, 'TARGET', x + 50, 78, { size: 'small', color: '#ffffff', align: 'center', shadow: '#10121a' });
  drawText(g, 'ALPHA', x + 86, 78, { size: 'small', color: '#ffffff', align: 'center', shadow: '#10121a' });
  return c;
}

function ballSheet() {
  const heights = [0, 0.5, 1, 2, 4, 6, 9];
  const ppy = 6;
  const colW = 34;
  const w = 10 + heights.length * colW + 4 * 22 + 30;
  const h = 96;
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  turfRow(g, 0, h, w, 0);
  heights.forEach((z, i) => {
    const x = 10 + i * colW + colW / 2;
    drawBall(g, x, 82, z, { ppy, spin: i * 0.07 });
    drawText(g, `${z}`, x, 88, { size: 'small', color: '#ffffff', align: 'center' });
  });
  // orientations x spin frames
  const ox = 10 + heights.length * colW + 16;
  for (let o = 0; o < 4; o++) {
    for (let s = 0; s < 3; s++) {
      drawBall(g, ox + o * 22, 20 + s * 14, 0.2, { ppy: 10, angle: (o * Math.PI) / 4, spin: s / 14 + 0.001, shadow: false });
      drawBall(g, ox + o * 22, 62 + s * 10, 5, { ppy: 0.01, angle: (o * Math.PI) / 4, spin: s / 14 + 0.001, shadow: false });
    }
  }
  drawText(g, 'HEIGHT (YD)', 10, 4, { size: 'small', color: '#ffffff', shadow: '#10121a' });
  drawText(g, 'ANGLE X SPIN', ox - 6, 4, { size: 'small', color: '#ffffff', shadow: '#10121a' });
  return c;
}

function fontSheet() {
  const w = 420;
  const h = 214;
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = '#10121a';
  g.fillRect(0, 0, w, h);
  turfRow(g, 128, 86, w, 0);
  let y = 6;
  const line = (text, opts, dy) => { drawText(g, text, opts.x || 6, y, opts); y += dy; };
  const set = CHARSET.replace(/\s/g, '');
  line(set, { size: 'small', color: '#ffffff' }, 9);
  line('THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG 0123456789', { size: 'small', color: '#ffcc33' }, 9);
  line(set.slice(0, 36), { size: 'big', color: '#ffffff' }, 11);
  line(set.slice(36), { size: 'big', color: '#ffffff' }, 11);
  line('1ST & 10', { size: 'big', scale: 2, color: '#ffcc33', shadow: '#5a4100' }, 20);
  line('TOUCHDOWN!', { size: 'big', scale: 3, color: '#ffffff', shadow: '#3a4160' }, 28);
  const ly = y;
  drawText(g, 'LEFT', 6, ly, { size: 'small', color: '#8f97a8' });
  drawText(g, 'CENTER', w / 2, ly, { size: 'small', color: '#8f97a8', align: 'center' });
  drawText(g, 'RIGHT', w - 6, ly, { size: 'small', color: '#8f97a8', align: 'right' });
  y = 134;
  line('+12 YDS  SACK!  INTERCEPTED!', { size: 'big', color: '#ffffff', shadow: '#10121a' }, 12);
  line("CC 4,500  50%  (2-1)  #12  O'NEIL & CO.  A/B", { size: 'small', color: '#ffffff', shadow: '#10121a' }, 9);
  line('MULTI-LINE\nTEXT BLOCK', { size: 'small', scale: 2, color: '#ffcc33', shadow: '#10121a' }, 26);
  const mw = measureText('MEASURE ME', { size: 'big', scale: 2 });
  g.fillStyle = '#ff5a4f';
  g.fillRect(6, y - 2, mw, 1);
  line('MEASURE ME', { size: 'big', scale: 2, color: '#ffffff' }, 16);
  return c;
}

function fieldOverview(orientation, ppy) {
  const cam = new Camera();
  const L = orientation === 'landscape';
  const w = L ? Math.round(124 * ppy) : Math.round((FIELD_W + 4) * ppy * 0.82);
  const h = L ? Math.round((FIELD_W + 4) * ppy * 0.82) : Math.round(124 * ppy);
  cam.setViewport(w, h, orientation);
  cam.ppy = ppy;
  cam.cx = 60;
  cam.cy = FIELD_W / 2;
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  const fr = new FieldRenderer();
  fr.setTeams(HOME, AWAY);
  fr.draw(g, cam, { losX: 35, firstDownX: 45, time: 0 });
  // a few players for scale
  for (let i = 0; i < 5; i++) {
    const p = cam.toScreen(34, FIELD_W / 2 + (i - 2) * 1.4);
    drawPlayer(g, p.x, p.y, HOME, { facing: cam.facingFor(1, 0), anim: 'stance', skin: i });
  }
  return c;
}

function buildGalleries() {
  const players = document.getElementById('players');
  for (const look of GALLERY_LOOKS) present(playerSheet(look), players, 3);
  present(skinSheet(HOME), document.getElementById('skins'), 3);
  present(ballSheet(), document.getElementById('balls'), 4);
  present(fontSheet(), document.getElementById('fonts'), 3);
  const fields = document.getElementById('fields');
  present(fieldOverview('landscape', 5), fields, 2);
  present(fieldOverview('portrait', 5), fields, 2);
}

function benchmark() {
  // field draw time at the reference 480x270 landscape and 270x480 portrait
  const out = {};
  for (const [o, w, h] of [['landscape', 480, 270], ['portrait', 270, 585]]) {
    const cam = new Camera();
    cam.setViewport(w, h, o);
    cam.snapTo(40, FIELD_W / 2);
    const c = makeCanvas(w, h);
    // CPU-backed canvas: readbacks are cheap and the timing is a pessimistic (no-GPU) bound
    const g = c.getContext('2d', { willReadFrequently: true });
    const fr = new FieldRenderer();
    fr.setTeams(HOME, AWAY);
    fr.draw(g, cam, {});
    const ms = fr.benchmark(g, cam, 300);
    out[o] = { ms: Number(ms.toFixed(3)), buildMs: Number(fr.buildMs.toFixed(1)), ppy: cam.ppy };
  }
  // sprite generation cost for one full team sheet
  const t0 = performance.now();
  const look = { ...HOME, primary: '#123456' };
  for (const a of ANIM_NAMES) for (const f of FACINGS) for (let i = 0; i < ANIMS[a].frames; i++) getPlayerSprite(look, { facing: f, anim: a, frame: i, skin: 2 });
  out.spriteSheetMs = Number((performance.now() - t0).toFixed(1));
  return out;
}

buildGalleries();
const bench = benchmark();
drawLive(0);
requestAnimationFrame((now) => {
  lastNow = now;
  tick(now);
  window.__preview = { ready: true, bench, errors, orientation: camera.orientation, ppy: camera.ppy, view: [display.w, display.h, display.scale] };
});
