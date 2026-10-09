// Title screen: bitmap-font logo (renders identically without web fonts), animated field backdrop,
// Continue / New Career / Settings / How to Play.

import { h } from '../dom.js';
import { drawText, measureText } from '../../render/font.js';
import * as F from '../../franchise/index.js';
import { FieldBackdrop } from './backdrop.js';
import { btn, confirmDialog, reducedMotion, setVars, teamVars, screenKeys } from './common.js';
import { phaseText } from './widgets.js';

/** Draw the "POCKET GRIDIRON" logo into a canvas at 1 virtual px per font pixel. */
export function drawLogo(canvas) {
  const big = 'GRIDIRON';
  const small = 'POCKET';
  const bs = 2; // big text scale
  const bw = measureText(big, { size: 'big', scale: bs });
  const sw = measureText(small, { size: 'small', scale: 1 });
  const pad = 3;
  const W = bw + pad * 2 + 2;
  const smallH = 5;
  const gap = 4;
  const H = pad + smallH + gap + 7 * bs + pad + 2;
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  g.imageSmoothingEnabled = false;
  const outline = (txt, x, y, opts, col) => {
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) drawText(g, txt, x + dx, y + dy, { ...opts, color: col });
  };
  // POCKET with rules either side and a tiny football
  const sy = pad;
  const cx = Math.round(W / 2);
  outline(small, cx, sy, { size: 'small', align: 'center' }, '#05060a');
  drawText(g, small, cx, sy, { size: 'small', align: 'center', color: '#f4ead2' });
  const ruleY = sy + 2;
  const ruleW = Math.max(4, Math.round((bw - sw) / 2) - 8);
  g.fillStyle = '#05060a';
  g.fillRect(cx - sw / 2 - 4 - ruleW, ruleY - 1, ruleW + 2, 3);
  g.fillRect(cx + sw / 2 + 2, ruleY - 1, ruleW + 2, 3);
  g.fillStyle = '#ffcc33';
  g.fillRect(cx - sw / 2 - 3 - ruleW, ruleY, ruleW, 1);
  g.fillRect(cx + sw / 2 + 3, ruleY, ruleW, 1);
  // GRIDIRON: dark outline, burnt drop shadow, gold face with a light top band
  const by = sy + smallH + gap;
  const bx = cx;
  const opts = { size: 'big', scale: bs, align: 'center' };
  drawText(g, big, bx + 1, by + 2, { ...opts, color: '#05060a' });
  drawText(g, big, bx, by + 1, { ...opts, color: '#b8541a' });
  outline(big, bx, by, opts, '#05060a');
  drawText(g, big, bx, by, { ...opts, color: '#ffcc33' });
  g.save();
  g.beginPath();
  g.rect(0, by, W, 4);
  g.clip();
  drawText(g, big, bx, by, { ...opts, color: '#fff1a8' });
  g.restore();
  return { w: W, h: H };
}

/** Size a pixel canvas to the largest integer device-pixel scale that fits maxCssW/maxCssH. */
export function fitPixelCanvas(canvas, maxCssW, maxCssH) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const k = Math.max(1, Math.floor(Math.min((maxCssW * dpr) / canvas.width, (maxCssH * dpr) / canvas.height)));
  canvas.style.width = `${(canvas.width * k) / dpr}px`;
  canvas.style.height = `${(canvas.height * k) / dpr}px`;
}

export class TitleScreen {
  constructor(app) {
    this.app = app;
    this.bg = null;
    this._onResize = () => this.layout();
  }

  mount(root) {
    const app = this.app;
    const save = app.save;
    this.bgCanvas = h('canvas.title-bg-canvas', { 'aria-hidden': 'true' });
    this.logo = h('canvas.title-logo', { role: 'img', 'aria-label': 'Pocket Gridiron' });
    drawLogo(this.logo);

    let cont = null;
    if (save) {
      const t = F.userTeam(save);
      cont = btn(app, h('span.tb-stack', h('span', 'Continue'), h('span.tb-sub', `${t.city} · ${F.recordText(t.record)} · ${save.season.year} ${phaseText(save)}`)),
        () => this.resume(), { kind: 'primary', block: true, icon: 'play', sfx: 'select', id: 'btn-continue' });
      setVars(cont, teamVars(t.colors));
      cont.classList.add('team-edge');
    }
    const newCareer = btn(app, 'New Career', () => this.newCareer(), { kind: save ? '' : 'primary', block: true, id: 'btn-new', sfx: 'select', icon: 'ball' });

    this.root = h('div.screen.title-screen',
      h('div.title-bg', this.bgCanvas),
      h('div.title-shade'),
      h('div.title-wrap',
        h('div.title-logo-box', this.logo, h('p.title-tag', 'Arcade football · Pocket-sized franchise')),
        h('nav.title-menu', { 'aria-label': 'Main menu' },
          cont,
          newCareer,
          h('div.title-row',
            btn(app, 'Settings', () => app.go('settings', { from: 'title' }), { block: true, icon: 'gear', id: 'btn-settings' }),
            btn(app, 'How to Play', () => app.go('help', { from: 'title' }), { block: true, icon: 'info', id: 'btn-help' }),
          ),
        ),
        h('p.title-credits', 'Original game inspired by classic arcade football'),
      ),
    );
    root.appendChild(this.root);
    this.bg = new FieldBackdrop(this.bgCanvas, { still: reducedMotion() });
    this.layout();
    window.addEventListener('resize', this._onResize);
    // Enter with nothing focused starts the main action (Continue, else New Career).
    this.offKeys = screenKeys((e) => {
      if (e.key !== 'Enter' || (document.activeElement && document.activeElement !== document.body)) return;
      e.preventDefault();
      (this.root.querySelector('#btn-continue') || this.root.querySelector('#btn-new')).click();
    });
  }

  layout() {
    if (!this.root) return;
    const r = this.root.getBoundingClientRect();
    const landscapeShort = r.width > r.height && r.height < 520;
    fitPixelCanvas(this.logo, Math.min(r.width * (landscapeShort ? 0.46 : 0.86), 620), landscapeShort ? r.height * 0.42 : r.height * 0.22);
    if (this.bg) this.bg.resize();
  }

  resume() {
    const app = this.app;
    if (!app.save) return;
    if (app.save.fired) app.go('fired');
    else if (app.save.season.phase === 'offseason') app.go('offseason');
    else app.go('hub');
  }

  async newCareer() {
    const app = this.app;
    if (app.save) {
      const t = F.userTeam(app.save);
      const ok = await confirmDialog(app, {
        title: 'Start a new career?',
        body: h('p', `Your career with ${t.city} (${app.save.coach.name}, season ${app.save.season.year}) will be replaced once the new one starts. This can't be undone.`),
        ok: 'New career',
        danger: true,
      });
      if (!ok) return;
    }
    app.go('newGame');
  }

  render(alpha, frameDt) {
    if (this.bg) this.bg.frame(frameDt || 1 / 60);
  }

  unmount() {
    window.removeEventListener('resize', this._onResize);
    if (this.offKeys) this.offKeys();
    this.root = null;
    this.bg = null;
  }
}
