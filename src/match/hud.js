// Match HUD (MATCH-SCREEN contract): the DOM layer drawn over the field canvas in `app.hudEl`,
// plus the match modals hosted in `app.uiRoot` (decisions, pause menu, quit confirm).
//
//   const hud = new MatchHud(app.hudEl, { userLook, oppLook, onTimeout, onChangePlay, onFieldGoal, onPause });
//   hud.setBug({...}) / setChangePlay({...}) / setFieldGoal({...})   cheap: DOM is touched only on change
//   hud.showBox(...) / showBanner(...) / showFinal(...) / setDim(on) / flash(text)
//   const dlg = decisionModal(app.uiRoot, {...}); dlg.close();
//   const menu = pauseMenu(app.uiRoot, {...}); menu.close();
//
// Layout: scorebug + pause button along the top safe edge, Change Play (bottom-left) and the
// end-of-half FG button (bottom-right) along the bottom safe edge, banners / opponent-drive text
// boxes in the middle. Only the buttons take pointer events; everything else lets taps fall
// through to the stage (tap-to-advance is read from app.input by the screen). Interactive HUD
// elements stop pointerdown propagation so a button press never reaches the field's gesture input.

import { h, clear, render } from '../ui/dom.js';

// ------------------------------------------------------------------------------------ colour

function rgb(hex) {
  const s = String(hex || '#888888').replace('#', '');
  const f = s.length === 3 ? s.split('').map((c) => c + c).join('') : s.padEnd(6, '0');
  const n = parseInt(f.slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lum(hex) {
  const c = rgb(hex).map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function contrast(a, b) {
  const la = lum(a);
  const lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Readable ink for text on `bg`: the team's secondary when it contrasts enough, else white/black. */
export function inkOn(bg, preferred) {
  if (preferred && contrast(bg, preferred) >= 3.2) return preferred;
  return contrast(bg, '#ffffff') >= contrast(bg, '#10121a') ? '#ffffff' : '#10121a';
}

/** TeamLook from a match team ({abbr, city, colors}) or a squad look. */
export function lookOf(team, squad) {
  if (squad && squad.look && squad.look.primary) return { ...squad.look };
  const c = (team && team.colors) || {};
  return { abbr: team?.abbr || '???', city: team?.city || '', primary: c.primary || '#3a4160', secondary: c.secondary || '#f4ead2', helmet: c.helmet || c.primary || '#3a4160' };
}

// ------------------------------------------------------------------------------------ helpers

/** Stop a HUD control's pointer events reaching the stage's gesture input. */
function guard(el) {
  for (const t of ['pointerdown', 'pointerup', 'touchstart', 'mousedown']) el.addEventListener(t, (e) => e.stopPropagation());
  // don't keep keyboard focus on HUD buttons (Space / Enter belong to the field controls)
  el.addEventListener('click', () => setTimeout(() => el.blur(), 0));
  el.classList.add('interactive');
  return el;
}

function setText(el, v) {
  const s = String(v);
  if (el.textContent !== s) el.textContent = s;
}

function setHidden(el, hidden) {
  if (el.hidden !== hidden) el.hidden = hidden;
}

function chip(look, text, cls = '') {
  const el = h(`span.mh-chip${cls ? `.${cls}` : ''}`, text ?? look.abbr);
  el.style.background = look.primary;
  el.style.color = inkOn(look.primary, look.secondary);
  return el;
}

/** Inline pixel icon (rows of '#'/'.') as an SVG string using currentColor. */
function pixIcon(rows, px = 2) {
  let d = '';
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === '#') d += `M${x} ${y}h1v1h-1z`;
  });
  const w = rows[0].length;
  return `<svg viewBox="0 0 ${w} ${rows.length}" width="${w * px}" height="${rows.length * px}" shape-rendering="crispEdges" aria-hidden="true"><path d="${d}" fill="currentColor"/></svg>`;
}

const PAUSE_ICON = pixIcon(['##.##', '##.##', '##.##', '##.##', '##.##', '##.##', '##.##'], 2);
const CYCLE_ICON = pixIcon([
  '..#......',
  '.##......',
  '#########',
  '.##......',
  '..#...#..',
  '......##.',
  '#########',
  '......##.',
  '......#..',
], 2);

// ------------------------------------------------------------------------------------ HUD

export class MatchHud {
  /**
   * @param {HTMLElement} host app.hudEl
   * @param {{userLook:Object, oppLook:Object, onTimeout:()=>void, onChangePlay:()=>void,
   *   onFieldGoal:()=>void, onPause:()=>void}} o
   */
  constructor(host, o) {
    this.host = host;
    this.o = o;
    const u = o.userLook;
    const p = o.oppLook;

    this.userPts = h('b.mh-pts', '0');
    this.oppPts = h('b.mh-pts', '0');
    this.userTeam = h('div.mh-team.user', chip(u, u.abbr, 'abbr'), this.userPts);
    this.oppTeam = h('div.mh-team.opp', chip(p, p.abbr, 'abbr'), this.oppPts);
    this.qEl = h('span.mh-q', 'Q1');
    this.timeEl = h('span.mh-time', '0:00');
    this.pipsEl = h('span.mh-pips', { 'aria-hidden': 'true' });
    this.clockBtn = guard(h('button.mh-clock', {
      type: 'button',
      'aria-label': 'Game clock',
      title: 'Tap for a timeout (T)',
      onclick: () => o.onTimeout(),
    }, h('span.mh-qt', this.qEl, this.timeEl), this.pipsEl));
    this.sitEl = h('div.mh-sit', { role: 'status', 'aria-live': 'off' }, '');
    this.bug = h('div.mh-bug', h('div.mh-teams', this.userTeam, this.oppTeam), this.clockBtn, this.sitEl);
    this.pauseBtn = guard(h('button.mh-pause', { type: 'button', 'aria-label': 'Pause (Esc)', title: 'Pause (Esc / P)', html: PAUSE_ICON, onclick: () => o.onPause() }));
    this.flashEl = h('div.mh-flash', { hidden: true, role: 'status' });

    this.cpCount = h('span.mh-badge', '0');
    this.cpBtn = guard(h('button.mh-btn.mh-cp', { type: 'button', hidden: true, title: 'Change play (C)', onclick: () => o.onChangePlay() },
      h('span.mh-ico', { html: CYCLE_ICON }), h('span.mh-lbl', 'CHANGE PLAY'), this.cpCount));
    this.fgLbl = h('span.mh-lbl', 'FG');
    this.fgBtn = guard(h('button.mh-btn.mh-fg', { type: 'button', hidden: true, title: 'Kick a field goal', onclick: () => o.onFieldGoal() }, this.fgLbl));

    this.banner = h('div.mh-banner', { hidden: true, role: 'status' });
    this.box = h('div.mh-box', { hidden: true, role: 'status', 'aria-live': 'polite' });
    this.finalEl = h('div.mh-final', { hidden: true });
    this.loading = h('div.mh-loading', { hidden: true }, 'LOADING…');
    this.dim = h('div.mh-dim', { hidden: true });

    this.root = h('div.mhud', { 'data-mode': 'loading' },
      this.dim,
      h('div.mh-top', this.bug, this.pauseBtn, this.flashEl),
      h('div.mh-mid', this.banner, this.box, this.finalEl, this.loading),
      h('div.mh-bottom', this.cpBtn, this.fgBtn),
    );
    host.appendChild(this.root);
    this._bug = {};
    this._flashTimer = 0;
  }

  /**
   * CSS px of the stage edges covered by the HUD (top bar, bottom button row), for
   * PlayView `insets` so canvas UI (wind icon, tips, meters) stays clear of it.
   */
  insets() {
    const host = this.host.getBoundingClientRect();
    const bug = this.bug.getBoundingClientRect();
    const pause = this.pauseBtn.getBoundingClientRect();
    const bottom = this.root.querySelector('.mh-bottom').getBoundingClientRect();
    const topEdge = Math.max(bug.bottom, pause.bottom) - host.top;
    return {
      top: Math.max(36, Math.round(topEdge + 6)),
      bottom: Math.max(10, Math.round(host.bottom - bottom.top + 4)),
      left: 8,
      right: 8,
    };
  }

  setMode(mode) {
    if (this.root.dataset.mode !== mode) this.root.dataset.mode = mode;
  }

  setLoading(on) {
    setHidden(this.loading, !on);
  }

  /**
   * @param {{userScore:number, oppScore:number, quarter:string, clock:string, timeouts:number,
   *   timeoutsMax:number, canTimeout:boolean, possession:'user'|'opp'|null, running:boolean, sit:string}} b
   */
  setBug(b) {
    const o = this._bug;
    if (o.userScore !== b.userScore) setText(this.userPts, b.userScore);
    if (o.oppScore !== b.oppScore) setText(this.oppPts, b.oppScore);
    if (o.quarter !== b.quarter) setText(this.qEl, b.quarter);
    if (o.clock !== b.clock) setText(this.timeEl, b.clock);
    if (o.sit !== b.sit) {
      setText(this.sitEl, b.sit);
      this.sitEl.hidden = !b.sit;
    }
    if (o.possession !== b.possession) {
      this.userTeam.classList.toggle('ball', b.possession === 'user');
      this.oppTeam.classList.toggle('ball', b.possession === 'opp');
    }
    if (o.canTimeout !== b.canTimeout) {
      this.clockBtn.classList.toggle('can-to', b.canTimeout);
      this.clockBtn.setAttribute('aria-disabled', b.canTimeout ? 'false' : 'true');
    }
    if (o.running !== b.running) this.clockBtn.classList.toggle('running', b.running);
    if (o.timeouts !== b.timeouts || o.timeoutsMax !== b.timeoutsMax) {
      clear(this.pipsEl);
      for (let i = 0; i < b.timeoutsMax; i++) this.pipsEl.appendChild(h(i < b.timeouts ? 'i.on' : 'i'));
    }
    if (o.timeouts !== b.timeouts || o.canTimeout !== b.canTimeout || o.quarter !== b.quarter) {
      this.clockBtn.setAttribute('aria-label', `Game clock, ${b.quarter}. ${b.timeouts} timeout${b.timeouts === 1 ? '' : 's'} left${b.canTimeout ? ' — tap to call one' : ''}`);
    }
    this._bug = { ...b };
  }

  /** @param {{visible:boolean, left:number}} s */
  setChangePlay(s) {
    setHidden(this.cpBtn, !s.visible);
    if (!s.visible) return;
    setText(this.cpCount, s.left);
    const dis = s.left <= 0;
    if (this.cpBtn.disabled !== dis) this.cpBtn.disabled = dis;
  }

  /** @param {{visible:boolean, distance:number}} s */
  setFieldGoal(s) {
    setHidden(this.fgBtn, !s.visible);
    if (s.visible) setText(this.fgLbl, `FG ${s.distance} YD`);
  }

  setPauseVisible(on) {
    setHidden(this.pauseBtn, !on);
  }

  setDim(on) {
    setHidden(this.dim, !on);
  }

  /** Short toast under the scorebug ("TIMEOUT", "TIME!"). */
  flash(text, ms = 1300) {
    setText(this.flashEl, text);
    this.flashEl.hidden = false;
    this.flashEl.classList.remove('go');
    void this.flashEl.offsetWidth; // restart the CSS animation
    this.flashEl.classList.add('go');
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => { this.flashEl.hidden = true; }, ms);
  }

  /**
   * Centre banner (coin toss, quarter end, halftime, OT, automatic results).
   * @param {{title:string, sub?:string, lines?:string[], tone?:'good'|'bad'|'neutral', hint?:string}} b
   */
  showBanner(b) {
    clear(this.banner);
    this.banner.className = `mh-banner t-${b.tone || 'neutral'}`;
    this.banner.appendChild(h('p.mh-btitle', b.title));
    if (b.sub) this.banner.appendChild(h('p.mh-bsub', b.sub));
    for (const l of b.lines || []) this.banner.appendChild(h('p.mh-bline', l));
    if (b.hint) this.banner.appendChild(h('p.mh-hint', b.hint));
    this.banner.hidden = false;
  }

  hideBanner() {
    this.banner.hidden = true;
  }

  /**
   * Opponent-drive text box (one beat at a time).
   * @param {{head:string, text:string, index:number, count:number, kind:string, unskippable:boolean, tone?:string}} b
   */
  showBox(b) {
    const dots = h('span.mh-dots', { 'aria-hidden': 'true' });
    for (let i = 0; i < b.count; i++) dots.appendChild(h(i <= b.index ? 'i.on' : 'i'));
    this.box.className = `mh-box k-${b.kind}${b.tone ? ` t-${b.tone}` : ''}`;
    render(this.box,
      h('div.mh-boxhead', chip(this.o.oppLook, b.head, 'head'), dots),
      h('p.mh-boxtext', b.text),
      h('p.mh-hint', b.unskippable ? '' : 'TAP ▸'),
    );
    this.box.hidden = false;
  }

  hideBox() {
    this.box.hidden = true;
  }

  /**
   * Final whistle overlay with a Continue button.
   * @param {{userScore:number, oppScore:number, ot:boolean, verdict:string, tone:string, note?:string}} f
   * @param {()=>void} onContinue
   */
  showFinal(f, onContinue) {
    clear(this.finalEl);
    const btn = guard(h('button.btn.primary.mh-continue', { type: 'button', onclick: () => onContinue() }, 'CONTINUE'));
    this.finalEl.className = `mh-final t-${f.tone}`;
    render(this.finalEl,
      h('p.mh-btitle', f.ot ? 'FINAL / OT' : 'FINAL'),
      h('div.mh-fscore',
        chip(this.o.userLook, this.o.userLook.abbr, 'big'), h('b', String(f.userScore)),
        h('span.mh-dash', '–'),
        h('b', String(f.oppScore)), chip(this.o.oppLook, this.o.oppLook.abbr, 'big')),
      h('p.mh-verdict', f.verdict),
      f.note ? h('p.mh-bline', f.note) : null,
      btn,
    );
    this.finalEl.hidden = false;
    setTimeout(() => { try { btn.focus({ preventScroll: true }); } catch { /* ignore */ } }, 30);
    return btn;
  }

  hideAll() {
    this.hideBanner();
    this.hideBox();
    this.finalEl.hidden = true;
  }

  destroy() {
    clearTimeout(this._flashTimer);
    this.root.remove();
  }
}

// ------------------------------------------------------------------------------------ modals

function overlay(root, cls) {
  const el = h(`div.screen-overlay.mh-overlay${cls ? `.${cls}` : ''}`, { role: 'dialog', 'aria-modal': 'true' });
  root.appendChild(el);
  return el;
}

function focusFirst(el) {
  setTimeout(() => {
    const b = el.querySelector('button:not([disabled])');
    if (b) try { b.focus({ preventScroll: true }); } catch { /* ignore */ }
  }, 30);
}

/**
 * Decision pop-up (4th down, conversion, onside). Options come straight from the Match step.
 * @param {HTMLElement} root app.uiRoot
 * @param {{title:string, sub?:string, options:{id:string,label:string,detail?:string}[],
 *   onChoose:(id:string)=>void, timeout?:{left:number, onCall:()=>boolean}|null}} o
 * @returns {{el:HTMLElement, close:()=>void, button:(id:string)=>HTMLElement|null}}
 */
export function decisionModal(root, o) {
  const ov = overlay(root, 'mh-decide');
  let closed = false;
  const buttons = new Map();
  const opts = o.options.map((opt, i) => {
    const b = h(`button.btn.block.mh-opt${i === 0 ? '.first' : ''}`, {
      type: 'button',
      'data-opt': opt.id,
      onclick: () => { if (!closed) o.onChoose(opt.id); },
    }, h('span.mh-optlabel', opt.label), opt.detail ? h('span.mh-optdetail', opt.detail) : null);
    buttons.set(opt.id, b);
    return b;
  });
  let toRow = null;
  if (o.timeout) {
    const tb = h('button.btn.ghost.mh-to', { type: 'button' }, `TIMEOUT (${o.timeout.left} LEFT)`);
    tb.addEventListener('click', () => {
      if (o.timeout.onCall()) {
        tb.disabled = true;
        tb.textContent = 'TIMEOUT CALLED';
      }
    });
    toRow = h('div.mh-torow', tb);
  }
  const box = h('div.modal.mh-modal',
    h('h2', o.title),
    o.sub ? h('p.mh-msub', o.sub) : null,
    h('div.btn-col', opts),
    toRow,
  );
  ov.appendChild(box);
  focusFirst(box);
  return {
    el: ov,
    close() { closed = true; ov.remove(); },
    button: (id) => buttons.get(id) || null,
  };
}

/**
 * Pause menu: Resume, Sound / Vibration toggles, Quit to hub (with confirm).
 * @param {HTMLElement} root
 * @param {{scoreLine:string, settings:{sound:boolean, vibration:boolean}, onResume:()=>void,
 *   onToggle:(key:'sound'|'vibration', value:boolean)=>void, onQuit:()=>void}} o
 * @returns {{el:HTMLElement, close:()=>void, confirming:()=>boolean, back:()=>void}}
 */
export function pauseMenu(root, o) {
  const ov = overlay(root, 'mh-pausewrap');
  const box = h('div.modal.mh-modal.mh-pausebox');
  ov.appendChild(box);
  let confirming = false;
  const state = { ...o.settings };
  const toggle = (key, label) => {
    const b = h('button.btn.block.mh-toggle', { type: 'button', 'data-key': key, 'aria-pressed': String(!!state[key]) });
    const paint = () => {
      b.textContent = `${label}: ${state[key] ? 'ON' : 'OFF'}`;
      b.setAttribute('aria-pressed', String(!!state[key]));
      b.classList.toggle('on', !!state[key]);
    };
    b.addEventListener('click', () => {
      state[key] = !state[key];
      paint();
      o.onToggle(key, state[key]);
    });
    paint();
    return b;
  };
  const main = () => {
    confirming = false;
    clear(box);
    box.append(
      h('h2', 'PAUSED'),
      h('p.mh-msub', o.scoreLine),
      h('div.btn-col',
        h('button.btn.block.primary.mh-resume', { type: 'button', onclick: () => o.onResume() }, 'RESUME'),
        toggle('sound', 'SOUND'),
        toggle('vibration', 'VIBRATION'),
        h('button.btn.block.danger.mh-quit', { type: 'button', onclick: () => confirm() }, 'QUIT TO HUB'),
      ),
    );
    focusFirst(box);
  };
  const confirm = () => {
    confirming = true;
    clear(box);
    box.append(
      h('h2', 'QUIT THIS GAME?'),
      h('p.mh-msub', 'Nothing is saved from this game. It stays unplayed and you can kick it off again from the hub.'),
      h('div.btn-col',
        h('button.btn.block.danger.mh-quit-yes', { type: 'button', onclick: () => o.onQuit() }, 'QUIT GAME'),
        h('button.btn.block.mh-quit-no', { type: 'button', onclick: () => main() }, 'KEEP PLAYING'),
      ),
    );
    focusFirst(box);
  };
  main();
  return { el: ov, close: () => ov.remove(), confirming: () => confirming, back: () => main() };
}
