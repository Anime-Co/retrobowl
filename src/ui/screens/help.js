// How to Play: controls for touch and for mouse/keyboard (MECHANICS §2.3–§2.4, §3.1, §4.1, §5.1)
// with small pixel illustrations drawn with the game's own sprites, plus franchise basics.
// Params: {from?: screen name, fromParams?: object}

import { h } from '../dom.js';
import { drawPlayer, drawBall } from '../../render/sprites.js';
import { FIELD_COLORS } from '../../render/field.js';
import { segmented, screenHeader, screenKeys } from './common.js';
import { fitPixelCanvas } from './title.js';

const OFF = { abbr: 'YOU', city: 'You', primary: '#1952b8', secondary: '#fdd835', helmet: '#1952b8' };
const DEF = { abbr: 'OPP', city: 'Opp', primary: '#c62828', secondary: '#f0f0f0', helmet: '#c62828' };
const W = 96;
const H = 44;

const HAND = [
  '..##....',
  '.#ww#...',
  '.#ww#...',
  '.#ww###.',
  '.#wwwww#',
  '##wwwww#',
  '#wwwwww#',
  '.#wwww#.',
  '..####..',
];

function px(g, x, y, c) { g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), 1, 1); }

function hand(g, x, y) {
  HAND.forEach((row, j) => [...row].forEach((c, i) => {
    if (c === '#') px(g, x + i, y + j, '#1a1405');
    else if (c === 'w') px(g, x + i, y + j, '#f2cba6');
  }));
}

function turf(g) {
  for (let x = 0; x < W; x += 12) {
    g.fillStyle = (x / 12) % 2 ? FIELD_COLORS.turfB : FIELD_COLORS.turfA;
    g.fillRect(x, 0, 12, H);
  }
  g.fillStyle = 'rgba(244,244,238,0.7)';
  for (let x = 0; x < W; x += 12) g.fillRect(x, 0, 1, H);
}

function dotted(g, pts, c = '#ffffff', every = 2) {
  pts.forEach((p, i) => { if (i % every === 0) px(g, p.x, p.y, c); });
}

function line(x0, y0, x1, y1, n = 30) {
  const out = [];
  for (let i = 0; i <= n; i++) out.push({ x: x0 + ((x1 - x0) * i) / n, y: y0 + ((y1 - y0) * i) / n });
  return out;
}

function arc(x0, y0, x1, y1, lift, n = 40) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const k = i / n;
    out.push({ x: x0 + (x1 - x0) * k, y: y0 + (y1 - y0) * k - Math.sin(Math.PI * k) * lift });
  }
  return out;
}

function arrow(g, x0, y0, x1, y1, c = '#ffcc33') {
  for (const p of line(x0, y0, x1, y1, Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)))) px(g, p.x, p.y, c);
  const dx = Math.sign(x1 - x0);
  const dy = Math.sign(y1 - y0);
  for (let i = 1; i <= 2; i++) {
    if (dx) { px(g, x1 - dx * i, y1 - i, c); px(g, x1 - dx * i, y1 + i, c); }
    if (dy) { px(g, x1 - i, y1 - dy * i, c); px(g, x1 + i, y1 - dy * i, c); }
  }
}

function ring(g, cx, cy, c) {
  for (let a = 0; a < 24; a++) {
    const t = (a / 24) * Math.PI * 2;
    px(g, cx + Math.cos(t) * 5, cy + Math.sin(t) * 2, c);
  }
}

const SCENES = {
  handoff(g) {
    turf(g);
    ring(g, 26, 31, '#3f86ff');
    drawPlayer(g, 26, 31, OFF, { facing: 'right', anim: 'idle', skin: 2 });
    drawPlayer(g, 36, 28, OFF, { facing: 'right', anim: 'idle', skin: 1 });
    drawPlayer(g, 50, 28, OFF, { facing: 'right', anim: 'stance', skin: 3 });
    drawPlayer(g, 56, 28, DEF, { facing: 'left', anim: 'stance', skin: 4 });
    hand(g, 23, 32);
    arrow(g, 34, 38, 46, 38, '#ffffff');
  },
  dropback(g) {
    turf(g);
    drawPlayer(g, 30, 28, OFF, { facing: 'right', anim: 'throw', frame: 0, skin: 1 });
    drawPlayer(g, 74, 18, OFF, { facing: 'right', anim: 'run', frame: 1, skin: 2 });
    dotted(g, arc(32, 22, 72, 16, 12), '#ffffff');
    arrow(g, 22, 36, 8, 40, '#ffcc33');
    hand(g, 4, 34);
  },
  bullet(g) {
    turf(g);
    drawPlayer(g, 30, 28, OFF, { facing: 'right', anim: 'throw', frame: 0, skin: 1 });
    drawPlayer(g, 70, 24, OFF, { facing: 'right', anim: 'run', frame: 2, skin: 2 });
    dotted(g, line(32, 22, 68, 19, 36), '#ffcc33', 1);
    hand(g, 6, 32);
    hand(g, 54, 32);
    px(g, 58, 30, '#ffffff'); px(g, 56, 29, '#ffffff'); px(g, 60, 29, '#ffffff');
  },
  qbrun(g) {
    turf(g);
    drawPlayer(g, 34, 28, OFF, { facing: 'right', anim: 'run', frame: 1, skin: 1 });
    arrow(g, 26, 38, 50, 38, '#ffcc33');
    hand(g, 47, 32);
    drawBall(g, 37, 27, 0.6, { ppy: 6, shadow: false, spinning: false });
  },
  moves(g) {
    turf(g);
    drawPlayer(g, 46, 28, OFF, { facing: 'right', anim: 'run', frame: 0, skin: 2 });
    drawBall(g, 49, 26, 0.7, { ppy: 6, shadow: false, spinning: false });
    arrow(g, 46, 12, 46, 4, '#ffcc33');
    arrow(g, 46, 34, 46, 42, '#ffcc33');
    arrow(g, 56, 22, 70, 22, '#5fd068');
    arrow(g, 36, 22, 22, 22, '#ff9a3d');
  },
  kick(g) {
    turf(g);
    drawPlayer(g, 30, 32, OFF, { facing: 'right', anim: 'kick', frame: 1, skin: 3 });
    g.fillStyle = '#10121a'; g.fillRect(8, 6, 6, 32);
    g.fillStyle = '#5fd068'; g.fillRect(9, 7, 4, 6);
    g.fillStyle = '#ffcc33'; g.fillRect(9, 13, 4, 24);
    g.fillStyle = '#ffffff'; g.fillRect(7, 16, 8, 1);
    dotted(g, arc(34, 26, 80, 12, 10), '#ffffff');
    g.fillStyle = '#ffd23a'; g.fillRect(84, 4, 1, 22); g.fillRect(78, 4, 1, 14); g.fillRect(78, 17, 7, 1);
    arrow(g, 62, 36, 72, 33, '#ffcc33');
  },
  clock(g) {
    g.fillStyle = '#10121a'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#262b3d'; g.fillRect(18, 8, 60, 18);
    g.fillStyle = '#f4ead2';
    // "1:24" in chunky pixels
    const digits = { 1: ['.#', '##', '.#', '.#', '.#'], ':': ['.', '#', '.', '#', '.'], 2: ['##', '.#', '##', '#.', '##'], 4: ['#.#', '#.#', '###', '..#', '..#'] };
    let x = 34;
    for (const ch of '1:24') {
      const rows = digits[ch];
      rows.forEach((r, j) => [...r].forEach((c, i) => { if (c === '#') g.fillRect(x + i * 2, 12 + j * 2, 2, 2); }));
      x += rows[0].length * 2 + 2;
    }
    hand(g, 52, 22);
    g.fillStyle = '#ffcc33'; g.fillRect(22, 30, 4, 2); g.fillRect(28, 30, 4, 2); g.fillRect(34, 30, 4, 2);
  },
};

function illo(kind, label) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  c.className = 'illo';
  c.setAttribute('role', 'img');
  c.setAttribute('aria-label', label);
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  try { SCENES[kind](g); } catch (e) { console.warn('illustration', kind, e); }
  return c;
}

const key = (k) => h('kbd', k);

const TOUCH = [
  { title: 'Start the play', illo: 'handoff', items: [
    ['Tap the running back', ' (blue ring) to snap and hand off. That makes it a run.'],
    ['Drag backward', ' from anywhere to snap and drop back to pass.'],
  ] },
  { title: 'Throw it', illo: 'dropback', items: [
    ['Slingshot aim:', ' the ball flies the opposite way to your drag. A longer drag throws farther, up to what your QB\'s arm allows.'],
    ['Lift your finger', ' to throw. There is no auto-aim, so lead your receiver.'],
    ['Accurate QBs', ' show more of the dotted arc. The shadow marks where the ball comes down.'],
  ] },
  { title: 'Bullet pass', illo: 'bullet', items: [
    ['Touch with a second finger', ' while aiming to switch to a bullet: flat and fast, harder to catch and harder to bat down. Touch again to switch back.'],
  ] },
  { title: 'QB scramble', illo: 'qbrun', items: [
    ['Pull your finger forward past the QB', ' until the arc disappears, then let go: he tucks the ball and runs.'],
  ] },
  { title: 'Run with the ball', illo: 'moves', items: [
    ['Your runner keeps going on his own.', ' You add the moves:'],
    ['Swipe up or down:', ' juke sideways. Time it as a defender lunges and he will whiff.'],
    ['Swipe forward:', ' dive for a couple of extra yards (and protect the ball).'],
    ['Swipe back:', ' stutter step. In your own end zone on a return, take a touchback.'],
    ['Press and hold:', ' truck. Slower, but you bulldoze anyone in front.'],
  ] },
  { title: 'Kicks', illo: 'kick', items: [
    ['Tap once', ' to lock the power (the green top band reaches farthest).'],
    ['Tap again', ' to stop the swinging aim arrow. Aim into the wind.'],
  ] },
  { title: 'Clock & play calls', illo: 'clock', items: [
    ['Tap the clock', ' between plays to call a timeout.'],
    ['Change Play', ' swaps the assigned play for a new one. You get a few per game; experienced QBs get more.'],
  ] },
];

const KEYS = () => [
  { title: 'Start the play', illo: 'handoff', items: [
    [[key('H'), ' or ', key('Enter'), ' (or click the RB)'], 'Snap and hand off'],
    [[key('Space'), ' or drag back'], 'Snap and drop back to pass'],
  ] },
  { title: 'Throw it', illo: 'dropback', items: [
    [['Drag the mouse'], 'Aim (slingshot: opposite way); release to throw'],
    [[key('B'), ' or right-click'], 'Bullet pass on/off while aiming'],
    [[key('R')], 'Tuck and run'],
  ] },
  { title: 'Run with the ball', illo: 'moves', items: [
    [[key('W'), ' ', key('S'), ' or ', key('↑'), ' ', key('↓')], 'Juke (hold to drift sideways)'],
    [[key('→'), ' or ', key('D')], 'Dive (', key('←'), ' / ', key('A'), ' when driving left)'],
    [['Opposite key'], 'Stutter step / touchback in your end zone'],
    [['Hold ', key('Space')], 'Truck'],
  ] },
  { title: 'Kicks & clock', illo: 'kick', items: [
    [[key('Space'), ' ', key('Enter'), ' or click'], 'Lock power, then lock aim'],
    [[key('C')], 'Change play'],
    [[key('T')], 'Timeout'],
  ] },
];

const FRANCHISE = [
  ['Coaching credits (CC)', 'You earn CC every game, with extra for wins, blowouts and playoff wins. Spend them on facilities, coordinators, free-agent fees, morale boosts and rushing injured players back.'],
  ['Stars & skill points', 'Players are rated from half a star to five, built from four attributes. Production earns XP; each level-up gives a skill point to add to an attribute, up to a hidden potential.'],
  ['Roster', 'Up to 12 named stars. Any empty spot on the field goes to a generic one-star filler, so fill the key positions first.'],
  ['Salary cap', 'Every star has a salary and the total must fit under the cap. Releasing a player leaves dead money on this season\'s books.'],
  ['Facilities', 'Stadium grows your fan base, Training speeds up XP, Rehab shortens injuries. Pay upkeep in the offseason or they may slip a level.'],
  ['Fans & the owner', 'Winning keeps both happy. If the owner\'s confidence is too low when the season ends, you will be looking for a new job.'],
  ['Offseason', 'Awards, retirements, contracts, player development, upkeep, coordinators, a three-round draft and free agency, all in a couple of minutes.'],
];

export class HelpScreen {
  constructor(app, params = {}) {
    this.app = app;
    this.from = params.from || 'title';
    this.fromParams = params.fromParams || {};
    let coarse = false;
    try { coarse = window.matchMedia('(pointer: coarse)').matches; } catch { /* ignore */ }
    this.mode = coarse ? 'touch' : 'keys';
  }

  mount(root) {
    this.root = h('div.screen.help');
    root.appendChild(this.root);
    this.offKeys = screenKeys((e) => {
      if (e.key === 'Escape') { e.preventDefault(); this.app.sfx('back'); this.back(); }
    });
    this.draw();
  }

  unmount() {
    if (this.offKeys) this.offKeys();
  }

  back() {
    const to = this.from === 'hub' && !this.app.save ? 'title' : this.from;
    this.app.go(to, this.fromParams);
  }

  draw() {
    const app = this.app;
    const root = this.root;
    const focusKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.fk : null;
    while (root.firstChild) root.removeChild(root.firstChild);
    const touch = this.mode === 'touch';
    const cards = (touch ? TOUCH : KEYS()).map((sec) => h('section.panel.help-card',
      h('div.help-illo', illo(sec.illo, sec.title)),
      h('div.help-txt',
        h('h3.panel-title', sec.title),
        touch
          ? h('ul.help-list', sec.items.map(([b, rest]) => h('li', h('b', b), rest)))
          : h('ul.keys', sec.items.map(([k, ...what]) => h('li', h('span.keys-k', k), h('span.keys-d', what)))),
      ),
    ));
    const modeSeg = segmented({ app, label: 'Control scheme', value: this.mode, options: [{ value: 'touch', label: 'Touch' }, { value: 'keys', label: 'Mouse & keys' }], onChange: (v) => { this.mode = v; this.draw(); } });
    root.appendChild(h('div.wrap.help-wrap',
      screenHeader(app, { title: 'How to Play', onBack: () => this.back() }),
      h('div.help-body.scroll-y',
        h('section.help-intro',
          h('p', 'You run the offense, one snap at a time. The game hands you a play with routes drawn on the field; the opposing offense is simulated in quick text updates. Score more than them, then manage your club between games.'),
          modeSeg,
          h('p.dim.small', touch ? 'Holding your phone upright? The field turns so you drive up the screen; every swipe turns with it.' : 'Mouse drags work exactly like touch drags. A gamepad works too.'),
        ),
        h('div.help-grid', cards),
        h('section.panel.help-fr',
          h('h2.panel-title', 'Running the franchise'),
          h('dl.fr-list', FRANCHISE.map(([t, d]) => [h('dt', t), h('dd', d)])),
        ),
      ),
    ));
    for (const c of root.querySelectorAll('canvas.illo')) fitPixelCanvas(c, Math.min(300, root.clientWidth * 0.8), 140);
    if (focusKey) {
      const el = root.querySelector(`[data-fk="${CSS.escape(focusKey)}"]`);
      if (el) el.focus({ preventScroll: true });
    }
  }
}
