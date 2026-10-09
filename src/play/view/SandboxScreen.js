// Dev sandbox (screen name 'sandbox'): endless single plays with synthetic test squads, for tuning
// the on-field feel without a franchise. A tiny DOM toolbar picks the play kind, difficulty step,
// drive direction and camera zoom; the info line shows orientation, ppy, fps, render cost, the
// down & distance and the last result.
//
// Params (app.go('sandbox', {...}) or URL ?sandbox=<kind>&dir=left&zoom=far&step=8&seed=3&fg=45):
//   kind: 'scrimmage'|'fg'|'pat'|'kick_return'|'two_point'   step: 1..16 difficulty step
//   driveLeft: boolean   zoom: 'near'|'far'   seed: number   fgDist: yards   losX: number
//   offRating / defRating: 0..1   team / opp: team ids from src/data/teams.js   tips: boolean

import { PlayView } from './PlayView.js';
import { makeTestSquad } from '../sim/squads.js';
import { teamTemplate } from '../../data/teams.js';
import { FIELD_W } from '../../render/camera.js';

const KINDS = [
  ['scrimmage', 'Scrimmage'],
  ['fg', 'Field goal'],
  ['pat', 'Extra point'],
  ['kick_return', 'Kick return'],
  ['two_point', '2-pt try'],
];

const lookOf = (t, fb) => (t ? { abbr: t.abbr, city: t.city, primary: t.primary, secondary: t.secondary, helmet: t.helmet } : fb);

function urlParams() {
  try {
    return new URLSearchParams(window.location.search);
  } catch {
    return new URLSearchParams('');
  }
}

export class SandboxScreen {
  constructor(app, params = {}) {
    this.app = app;
    const q = urlParams();
    const qKind = q.get('sandbox');
    const kind = params.kind || (qKind && KINDS.some((k) => k[0] === qKind) ? qKind : 'scrimmage');
    this.kind = kind;
    this.step = Number(params.step ?? q.get('step') ?? 6) || 6;
    const dir = params.driveLeft != null ? (params.driveLeft ? 'left' : 'right') : q.get('dir') || app.settings.driveDirection;
    this.driveLeft = dir === 'left';
    const zoom = params.zoom || q.get('zoom');
    if (zoom === 'near' || zoom === 'far') app.updateSettings({ cameraZoom: zoom });
    this.seed = Number(params.seed ?? q.get('seed') ?? Math.floor(Math.random() * 1e6)) >>> 0 || 1;
    this.fgDist = Number(params.fgDist ?? q.get('fg')) || 0;
    this.tips = params.tips ?? (q.has('tips') ? q.get('tips') !== '0' : undefined);
    this.offRating = Number(params.offRating ?? q.get('off') ?? 0.6);
    this.defRating = Number(params.defRating ?? q.get('def') ?? 0.5);
    this.userLook = lookOf(teamTemplate(params.team || q.get('team') || 'CLE'), { abbr: 'YOU', city: 'Home', primary: '#1952b8', secondary: '#fdd835', helmet: '#1952b8' });
    this.oppLook = lookOf(teamTemplate(params.opp || q.get('opp') || 'CHI'), { abbr: 'OPP', city: 'Away', primary: '#c62828', secondary: '#202020', helmet: '#202020' });
    this._squads();
    this.startLos = Number(params.losX ?? q.get('los')) || 35;
    this.drive = { losX: this.startLos, down: 1, firstDownX: this.startLos + 10, hashY: FIELD_W / 2 };
    this.view = null;
    this.playN = 0;
    this.last = '';
    this.results = [];
    this._fps = 0;
    this._lastT = 0;
    this._infoT = 0;
  }

  _squads() {
    this.offense = makeTestSquad({ rating: this.offRating, seed: 101, prefix: 'o', look: this.userLook });
    this.defense = makeTestSquad({ rating: this.defRating, seed: 202, prefix: 'd', look: this.oppLook });
  }

  mount() {
    const app = this.app;
    app.showStage(true);
    this._toolbar();
    this.newPlay();
  }

  unmount() {
    if (this.view) this.view.destroy();
    this.view = null;
    if (this.bar) this.bar.remove();
    this.app.audio.stopCrowd();
  }

  // ------------------------------------------------------------------ plays

  /** Build the PlaySetup for the next play. */
  setupFor(kind) {
    const s = {
      kind: kind === 'two_point' ? 'scrimmage' : kind,
      twoPoint: kind === 'two_point',
      losX: this.drive.losX,
      firstDownX: this.drive.firstDownX,
      hashY: this.drive.hashY,
      down: this.drive.down,
      offense: this.offense,
      defense: this.defense,
      difficulty: 1,
      difficultyStep: this.step,
      wind: { x: 0, y: 0 },
      seed: (this.seed + this.playN * 7919) >>> 0,
      weather: 'clear',
      quarter: 1,
      gameProgress: 0.3,
    };
    const rnd = (a, b) => a + ((s.seed * 9301 + 49297) % 233280) / 233280 * (b - a);
    if (kind === 'fg' || kind === 'pat') {
      const dist = kind === 'fg' ? (this.fgDist || Math.round(rnd(24, 52))) : 33;
      if (kind === 'fg') s.losX = 127 - dist;
      const mph = rnd(0, 14);
      const ang = rnd(0, Math.PI * 2);
      s.wind = { x: Math.cos(ang) * mph, y: Math.sin(ang) * mph };
      s.hashY = FIELD_W / 2 + (rnd(0, 1) < 0.5 ? -3 : 3) * (rnd(0, 1) < 0.5 ? 1 : 0);
    }
    return s;
  }

  newPlay(over = {}) {
    if (this.view) this.view.destroy();
    const app = this.app;
    this.playN += 1;
    // keep canvas UI (tips, wind, banners) clear of the toolbar
    const barBottom = this.bar ? Math.ceil(this.bar.getBoundingClientRect().bottom) + 4 : 40;
    const setup = { ...this.setupFor(this.kind), ...over };
    this.view = new PlayView(app, {
      setup,
      userLook: this.userLook,
      oppLook: this.oppLook,
      driveLeft: this.driveLeft,
      tips: this.tips,
      keepCrowd: true,
      insets: { top: barBottom, bottom: 8 },
      onSnap: () => { this.snaps = (this.snaps || 0) + 1; },
    });
    this._sync();
    return this.view;
  }

  /** Move the sandbox drive along after a play. */
  _advance(r) {
    if (!r) return;
    this.results.push(r.outcome);
    if (this.results.length > 50) this.results.shift();
    this.last = `${r.outcome}${r.type !== 'kick' ? ` ${r.yards >= 0 ? '+' : ''}${Math.round(r.yards)}` : ''}`;
    if (this.kind !== 'scrimmage') return; // kicks / returns / 2-pt: repeat the same situation
    const d = this.drive;
    const reset = () => {
      d.losX = this.startLos;
      d.down = 1;
      d.firstDownX = d.losX + 10;
      d.hashY = FIELD_W / 2;
    };
    if (r.turnover || r.outcome === 'td' || r.outcome === 'safety') {
      reset();
      return;
    }
    d.losX = Math.min(109, Math.max(11, r.endX));
    d.hashY = Math.min(29.75, Math.max(23.58, r.endY));
    if (r.firstDown) {
      d.down = 1;
      d.firstDownX = Math.min(d.losX + 10, 110);
    } else {
      d.down += 1;
      if (d.down > 4) reset();
    }
  }

  update(dt) {
    const v = this.view;
    if (!v) return;
    v.update(dt);
    if (v.done) {
      this._advance(v.result);
      this.newPlay();
    }
  }

  render(alpha) {
    if (!this.view) return;
    this.view.render(alpha);
    const now = performance.now();
    if (this._lastT) {
      const f = 1000 / Math.max(1, now - this._lastT);
      this._fps = this._fps ? this._fps * 0.92 + f * 0.08 : f;
    }
    this._lastT = now;
    if (now - this._infoT > 250) {
      this._infoT = now;
      this._info();
    }
  }

  // ------------------------------------------------------------------ toolbar

  _toolbar() {
    const app = this.app;
    const bar = document.createElement('div');
    bar.className = 'sbx-bar interactive';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Sandbox controls');
    Object.assign(bar.style, {
      position: 'absolute', left: 'calc(var(--safe-l, 0px) + 6px)', top: 'calc(var(--safe-t, 0px) + 6px)',
      right: 'calc(var(--safe-r, 0px) + 6px)', display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center',
      font: '10px/1.2 ui-monospace, Menlo, Consolas, monospace', color: '#e9e4d4', pointerEvents: 'none', zIndex: 5,
    });
    const style = (el) => {
      Object.assign(el.style, {
        pointerEvents: 'auto', background: 'rgba(16,18,26,0.82)', color: '#e9e4d4', border: '1px solid #2a3246',
        borderRadius: '4px', padding: '2px 6px', font: 'inherit', minHeight: '24px', cursor: 'pointer', width: 'auto',
        flex: '0 0 auto', margin: '0', lineHeight: '1.2',
      });
      return el;
    };
    const btn = (id, label, fn) => {
      const b = style(document.createElement('button'));
      b.type = 'button';
      b.id = id;
      b.textContent = label;
      b.addEventListener('click', (e) => {
        fn(e);
        b.blur();
        this._sync();
      });
      bar.appendChild(b);
      return b;
    };
    const sel = style(document.createElement('select'));
    sel.id = 'sbx-kind';
    sel.setAttribute('aria-label', 'Play kind');
    for (const [v, l] of KINDS) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = l;
      sel.appendChild(o);
    }
    sel.value = this.kind;
    sel.addEventListener('change', () => {
      this.kind = sel.value;
      sel.blur();
      this.newPlay();
    });
    bar.appendChild(sel);
    btn('sbx-step-dn', '-', () => { this.step = Math.max(1, this.step - 1); });
    this.stepEl = style(document.createElement('span'));
    this.stepEl.style.cursor = 'default';
    bar.appendChild(this.stepEl);
    btn('sbx-step-up', '+', () => { this.step = Math.min(16, this.step + 1); });
    this.dirBtn = btn('sbx-dir', '', () => {
      this.driveLeft = !this.driveLeft;
      if (this.view && this.view.sim.phase === 'presnap') this.newPlay();
    });
    this.zoomBtn = btn('sbx-zoom', '', () => {
      app.updateSettings({ cameraZoom: app.settings.cameraZoom === 'far' ? 'near' : 'far' });
    });
    btn('sbx-next', 'Next play', () => this.newPlay());
    btn('sbx-exit', 'Exit', () => app.go(app.screens.has('title') ? 'title' : 'sandbox'));
    this.infoEl = document.createElement('span');
    this.infoEl.id = 'sbx-info';
    Object.assign(this.infoEl.style, {
      pointerEvents: 'none', background: 'rgba(16,18,26,0.6)', padding: '3px 6px', borderRadius: '3px', whiteSpace: 'nowrap',
      overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%',
    });
    bar.appendChild(this.infoEl);
    app.hudEl.appendChild(bar);
    this.bar = bar;
    this._sync();
  }

  _sync() {
    if (!this.bar) return;
    this.stepEl.textContent = `Diff ${this.step}`;
    this.dirBtn.textContent = `Drive ${this.driveLeft ? 'L' : 'R'}`;
    this.zoomBtn.textContent = this.app.settings.cameraZoom === 'far' ? 'Far' : 'Near';
    this._info();
  }

  _info() {
    if (!this.infoEl || !this.view) return;
    const v = this.view;
    const d = this.drive;
    const yl = Math.round(d.losX - 10);
    const spot = yl === 50 ? '50' : yl < 50 ? `own ${yl}` : `opp ${100 - yl}`;
    const toGo = d.firstDownX >= 110 ? 'goal' : Math.round(d.firstDownX - d.losX);
    this.infoEl.textContent = `${this.app.display.orientation} ppy ${v.camera.ppy} ${Math.round(this._fps)}fps `
      + `r ${v.stats.renderMs.toFixed(2)}ms | ${this.kind === 'scrimmage' ? `${d.down}&${toGo} ${spot}` : this.kind} | ${v.sim.phase}`
      + `${this.last ? ` | last: ${this.last}` : ''}`;
  }
}
