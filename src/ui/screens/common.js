// Shared UI building blocks for the menu screens: pixel icons (inline SVG, no font glyphs needed),
// star rows, morale faces, team badges/helmets, segmented controls, switches, buttons with SFX,
// sheets (modals with Escape/focus handling) and confirm dialogs. Generic: no franchise imports.

import { h } from '../dom.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// --------------------------------------------------------------------------------- pixel art

/**
 * Inline SVG from a bitmap. rows: strings of equal length; each char maps to a colour in
 * `palette` ('.' and ' ' are transparent). Horizontal runs are merged into one path per colour.
 * @param {string[]} rows
 * @param {Object<string,string>} palette
 * @param {{scale?:number, className?:string, title?:string, flip?:boolean}} [opts]
 */
export function pixelArt(rows, palette, opts = {}) {
  const w = Math.max(...rows.map((r) => r.length));
  const hgt = rows.length;
  const scale = opts.scale || 2;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
  svg.setAttribute('width', String(w * scale));
  svg.setAttribute('height', String(hgt * scale));
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('class', `pix ${opts.className || ''}`.trim());
  if (opts.title) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', opts.title);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  const paths = {};
  rows.forEach((row0, y) => {
    const row = opts.flip ? [...row0.padEnd(w, '.')].reverse().join('') : row0;
    let x = 0;
    while (x < row.length) {
      const c = row[x];
      if (c === '.' || c === ' ' || !palette[c]) { x++; continue; }
      let e = x + 1;
      while (e < row.length && row[e] === c) e++;
      paths[c] = (paths[c] || '') + `M${x} ${y}h${e - x}v1h${x - e}z`;
      x = e;
    }
  });
  for (const [c, d] of Object.entries(paths)) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', palette[c]);
    svg.appendChild(p);
  }
  return svg;
}

/** Single-colour icons ('#' = currentColor). Original 9x9 pixel designs. */
const ICONS = {
  coin: ['..#####..', '.#######.', '###...###', '##..#####', '##..#####', '##..#####', '###...###', '.#######.', '..#####..'],
  home: ['....#....', '...###...', '..#####..', '.#######.', '#########', '.##...##.', '.##.#.##.', '.##.#.##.', '.#######.'],
  roster: ['##.....##', '###...###', '#########', '.#######.', '.##...##.', '.###.###.', '.##...##.', '.#######.', '.#######.'],
  schedule: ['.#.....#.', '#########', '#########', '#.......#', '#.#.#.#.#', '#.......#', '#.#.#.#.#', '#.......#', '#########'],
  standings: ['......##.', '......##.', '...##.##.', '...##.##.', '##.##.##.', '##.##.##.', '##.##.##.', '##.##.##.', '#########'],
  team: ['#........', '####.....', '######...', '########.', '######...', '####.....', '#........', '#........', '#........'],
  market: ['.######..', '.#....##.', '.#.##..#.', '.#.....#.', '.#.###.#.', '.#.....#.', '.#.###.#.', '.#.....#.', '.#######.'],
  gear: ['...###...', '.#.###.#.', '.#######.', '####.####', '###...###', '####.####', '.#######.', '.#.###.#.', '...###...'],
  back: ['.........', '...#.....', '..##.....', '.#######.', '########.', '.#######.', '..##.....', '...#.....', '.........'],
  fans: ['.##...##.', '####.####', '#########', '#########', '.#######.', '..#####..', '...###...', '....#....', '.........'],
  owner: ['...###...', '...#.#...', '#########', '#########', '####.####', '#########', '#########', '#########', '.........'],
  play: ['#........', '###......', '#####....', '#######..', '#########', '#######..', '#####....', '###......', '#........'],
  check: ['.........', '........#', '.......##', '#.....##.', '##...##..', '.##.##...', '..###....', '...#.....', '.........'],
  cross: ['.........', '##.....##', '.##...##.', '..##.##..', '...###...', '..##.##..', '.##...##.', '##.....##', '.........'],
  plus: ['.........', '...###...', '...###...', '#########', '#########', '#########', '...###...', '...###...', '.........'],
  up: ['....#....', '...###...', '..#####..', '.#######.', '#########', '...###...', '...###...', '...###...', '...###...'],
  down: ['...###...', '...###...', '...###...', '...###...', '#########', '.#######.', '..#####..', '...###...', '....#....'],
  cross2: ['...###...', '...###...', '...###...', '#########', '#########', '#########', '...###...', '...###...', '...###...'],
  medic: ['.........', '...###...', '...###...', '.#######.', '.#######.', '.#######.', '...###...', '...###...', '.........'],
  info: ['..#####..', '.##...##.', '##..#..##', '#.......#', '#...#...#', '#...#...#', '##..#..##', '.##...##.', '..#####..'],
  trophy: ['#########', '#.#####.#', '#.#####.#', '.#######.', '...###...', '....#....', '...###...', '..#####..', '..#####..'],
  ball: ['.........', '..#####..', '.#######.', '##.#.#.##', '#########', '.#######.', '..#####..', '.........', '.........'],
};

/** @param {keyof typeof ICONS} name */
export function icon(name, scale = 2, title) {
  const rows = ICONS[name] || ICONS.info;
  return pixelArt(rows, { '#': 'currentColor' }, { scale, title, className: `icon icon-${name}` });
}

const STAR = ['...#...', '..###..', '#######', '.#####.', '..###..', '.##.##.', '##...##'];

function starArt(kind, scale) {
  const rows = STAR.map((r) => [...r].map((c, x) => {
    if (c !== '#') return '.';
    if (kind === 'full') return 'a';
    if (kind === 'empty') return 'f';
    return x <= 3 ? 'a' : 'f';
  }).join(''));
  return pixelArt(rows, { a: 'var(--accent)', f: 'var(--star-off, #3a4160)' }, { scale });
}

/** Pixel star row (0.5..5 in halves). Font-independent replacement for text stars. */
export function starRow(value, { scale = 2, max = 5, className = '' } = {}) {
  const v = Math.max(0, Math.min(max, Math.round((value || 0) * 2) / 2));
  const parts = [];
  for (let i = 0; i < max; i++) {
    const kind = v >= i + 1 ? 'full' : v >= i + 0.5 ? 'half' : 'empty';
    parts.push(starArt(kind, scale));
  }
  return h(`span.pstars${className ? `.${className}` : ''}`, { role: 'img', 'aria-label': `${v} of ${max} stars`, title: `${v} stars` }, parts);
}

const FACE_ROWS = {
  base: ['..#####..', '.#ooooo#.', '#ooooooo#', null, '#ooooooo#', null, null, '.#ooooo#.', '..#####..'],
  0: ['#o##o##o#', '#oo###oo#', '#o#ooo#o#'],
  1: ['#oo#o#oo#', '#oo###oo#', '#o#ooo#o#'],
  2: ['#oo#o#oo#', '#ooooooo#', '#oo###oo#'],
  3: ['#oo#o#oo#', '#o#ooo#o#', '#oo###oo#'],
  4: ['#oo#o#oo#', '#o#####o#', '#oo###oo#'],
};
export const MORALE_COLORS = ['#ff5a4f', '#ff9a3d', '#ffcc33', '#a7dc5a', '#5fd068'];

/** Pixel morale face for level 0..4 (miserable..fired up). */
export function moraleFace(level, label, scale = 2) {
  const l = Math.max(0, Math.min(4, level | 0));
  const [eyes, m1, m2] = FACE_ROWS[l];
  const rows = FACE_ROWS.base.slice();
  rows[3] = eyes;
  rows[5] = m1;
  rows[6] = m2;
  return pixelArt(rows, { '#': '#1a1405', o: MORALE_COLORS[l] }, { scale, title: label || `Morale ${l + 1} of 5`, className: 'face' });
}

const HELMET = [
  '....kkkkkk....',
  '..kkssssssk...',
  '.khwwhhhhhhk..',
  'khwhhhhhhhhhk.',
  'khhhhhhhkkkkkk',
  'khhkkhhhkmmmmk',
  'khhkkhhhkmkkmk',
  'khhhhhhhkmmmmk',
  '.khhhhhhkkkkk.',
  '..kkkkkkk.....',
];

/** Original pixel helmet in team colours (faces right; flip to face left). */
export function helmet(colors, { scale = 3, flip = false, title } = {}) {
  const c = colors || {};
  const shell = c.helmet || c.primary || '#888';
  let stripe = c.secondary || '#fff';
  if (stripe.toLowerCase() === shell.toLowerCase()) stripe = c.primary || '#fff';
  // Dark shells get a lighter outline so they still read on dark panels.
  const outline = lum(shell) < 0.04 ? '#6d7390' : '#05060a';
  return pixelArt(HELMET, { k: outline, h: shell, s: stripe, m: '#cfd3dc', w: mix(shell, '#ffffff', 0.45) }, { scale, flip, title, className: 'helmet' });
}

// ------------------------------------------------------------------------------------ colour

function rgb(hex) {
  let s = String(hex || '#888').replace('#', '');
  if (s.length === 3) s = s.split('').map((x) => x + x).join('');
  const n = parseInt(s, 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function mix(a, b, t) {
  const A = rgb(a);
  const B = rgb(b);
  return `#${A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

/** Relative luminance 0..1. */
export function lum(hex) {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const la = lum(a);
  const lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Best ink on a background: the team's secondary if readable, else light/dark. */
export function inkOn(bg, preferred) {
  if (preferred && contrast(bg, preferred) >= 3) return preferred;
  return contrast(bg, '#f4ead2') >= contrast(bg, '#10121a') ? '#f4ead2' : '#10121a';
}

/** Inline style with team CSS variables (--t1 primary, --t2 secondary, --tink readable ink). */
export function teamVars(colors) {
  const c = colors || {};
  const p = c.primary || '#3a4160';
  return { '--t1': p, '--t2': c.secondary || '#f4ead2', '--tink': inkOn(p, c.secondary), '--t1d': mix(p, '#05060a', 0.45) };
}

/** Apply CSS custom properties (Object.assign on style does not set custom properties). */
export function setVars(el, vars) {
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
  return el;
}

/** Small square team tag: abbr on the team's colours. */
export function teamTag(team, { size = 'sm' } = {}) {
  const el = h(`span.ttag.${size}`, { title: team.city }, team.abbr);
  setVars(el, teamVars(team.colors));
  return el;
}

// ------------------------------------------------------------------------------------ format

/** $K -> "$3.2M" (negative: "-$1.5M", never "$-1.5M") */
export const money = (k) => {
  const v = Math.round((Number(k) || 0) / 100) / 10;
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(1)}M`;
};
export const signed = (v) => (v > 0 ? `+${v}` : `${v}`);
export const plural = (n, word, pl = `${word}s`) => `${n} ${n === 1 ? word : pl}`;

// ----------------------------------------------------------------------------------- widgets

/**
 * Button with SFX. `sfx: false` to stay silent.
 * @param {any} label
 * @param {(e:Event)=>void} onClick
 * @param {{kind?:string, sfx?:string|false, small?:boolean, block?:boolean, disabled?:boolean,
 *   title?:string, icon?:string, id?:string, attrs?:Object}} [o]
 */
export function btn(app, label, onClick, o = {}) {
  const cls = ['btn', o.kind, o.small && 'small', o.block && 'block'].filter(Boolean).join('.');
  return h(`button.${cls}`, {
    type: 'button',
    disabled: !!o.disabled,
    title: o.title,
    id: o.id,
    ...(o.attrs || {}),
    onclick: (e) => {
      if (o.sfx !== false) app.sfx(o.sfx || 'click');
      onClick(e);
    },
  }, o.icon ? icon(o.icon, 2) : null, label);
}

/**
 * Segmented single-choice control (role=radiogroup, arrow keys move).
 * @param {{label?:string, options:{value:any,label:any,hint?:string}[], value:any, onChange:(v:any)=>void, app?:any, wide?:boolean}} o
 */
export function segmented(o) {
  const group = h(`div.seg${o.wide ? '.wide' : ''}`, { role: 'radiogroup', 'aria-label': o.label || null });
  const buttons = o.options.map((opt, i) => {
    const on = opt.value === o.value;
    return h('button.seg-btn', {
      type: 'button',
      role: 'radio',
      'aria-checked': on ? 'true' : 'false',
      tabindex: on || (i === 0 && !o.options.some((x) => x.value === o.value)) ? '0' : '-1',
      class: on ? 'on' : null,
      title: opt.hint || null,
      'data-fk': `${o.label || 'seg'}:${opt.value}`,
      onclick: () => {
        if (o.app) o.app.sfx('select');
        o.onChange(opt.value);
      },
      onkeydown: (e) => {
        const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        const next = buttons[(i + d + buttons.length) % buttons.length];
        next.focus();
        next.click();
      },
    }, opt.label);
  });
  buttons.forEach((b) => group.appendChild(b));
  return group;
}

/**
 * Roving-tabindex keyboard model for radio-like buttons: the set is one Tab stop (the selected
 * button), arrow keys / Home / End move and select, Enter on the selected button confirms.
 * @param {HTMLElement[]} items
 * @param {{isOn:(b:HTMLElement)=>boolean, select:(b:HTMLElement)=>void, confirm?:(b:HTMLElement)=>void}} o
 * @returns {{sync:()=>void}} call sync() after the selection changes by other means (clicks)
 */
export function rovingRadios(items, o) {
  const list = [...items];
  const sync = () => {
    const cur = list.findIndex((b) => o.isOn(b));
    list.forEach((b, i) => b.setAttribute('tabindex', i === (cur >= 0 ? cur : 0) ? '0' : '-1'));
  };
  list.forEach((b, i) => b.addEventListener('keydown', (e) => {
    let j = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % list.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + list.length) % list.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = list.length - 1;
    else if (e.key === 'Enter' && o.confirm && o.isOn(b)) {
      e.preventDefault();
      o.confirm(b);
      return;
    }
    if (j < 0 || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    o.select(list[j]);
    sync();
    list[j].focus();
  }));
  sync();
  return { sync };
}

/** On/off switch (role=switch). */
export function toggle({ app, checked, onChange, label, id }) {
  return h(`button.switch${checked ? '.on' : ''}`, {
    type: 'button',
    role: 'switch',
    id,
    'aria-checked': checked ? 'true' : 'false',
    'aria-label': label,
    onclick: () => {
      if (app) app.sfx(checked ? 'back' : 'select');
      onChange(!checked);
    },
  }, h('span.knob'), h('span.switch-txt', checked ? 'ON' : 'OFF'));
}

/** 10-segment attribute bar (MECHANICS §6.2). */
export function segBar(value, max = 10, { color, potential } = {}) {
  const v = Math.max(0, Math.min(max, Math.round(value)));
  const segs = [];
  for (let i = 0; i < max; i++) {
    segs.push(h(`i${i < v ? '.on' : potential && i < potential ? '.pot' : ''}`, color && i < v ? { style: { background: color } } : null));
  }
  return h('span.segbar', { role: 'img', 'aria-label': `${v} of ${max}` }, segs);
}

/** Labelled 0..100 meter. */
export function meter(label, value, { iconName, warnBelow = 25, title } = {}) {
  const v = Math.round(Math.max(0, Math.min(100, value)));
  const color = v < warnBelow ? 'var(--bad)' : v < 50 ? 'var(--accent)' : 'var(--good)';
  return h('div.meter', { title: title || `${label}: ${v}/100` },
    h('span.meter-lbl', iconName ? icon(iconName, 1.5) : null, label),
    h('span.meter-bar', h('i', { style: { width: `${v}%`, background: color } })),
    h('span.meter-val', String(v)),
  );
}

/** Plain progress bar 0..1. */
export function progress(frac, color) {
  const pct = Math.max(0, Math.min(1, frac || 0)) * 100;
  return h('span.pbar', h('i', { style: { width: `${pct}%`, background: color || undefined } }));
}

export function ccChip(n) {
  return h('span.cc-chip', { title: 'Coaching credits' }, icon('coin', 1.5), h('b', String(n)), ' CC');
}

// ------------------------------------------------------------------------------------ sheets

const sheetStack = [];
/** True while a sheet or modal is open (screens skip their own Escape handling then). */
export const sheetOpen = () => sheetStack.length > 0 || !!document.querySelector('#ui .screen-overlay');

function focusables(root) {
  return [...root.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((el) => el.offsetParent !== null || el === document.activeElement);
}

// One capture-phase listener serves the top-most sheet, so Escape/Tab work even when focus was
// lost (e.g. the focused button was rebuilt) and never leak to the screen underneath.
let sheetKeysInstalled = false;
function installSheetKeys() {
  if (sheetKeysInstalled) return;
  sheetKeysInstalled = true;
  window.addEventListener('keydown', (e) => {
    const top = sheetStack[sheetStack.length - 1];
    if (!top) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (top.dismissable) { top.app.sfx('back'); top.close(); }
    } else if (e.key === 'Tab') {
      const f = focusables(top.box);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      const inside = top.box.contains(document.activeElement);
      if (!inside) { e.preventDefault(); (e.shiftKey ? last : first).focus(); } else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }, true);
}

/**
 * Open a sheet: a modal panel (bottom sheet on phones, centred dialog on wide screens).
 * Escape / backdrop / close button dismiss it; Tab focus stays inside; focus is restored on close.
 * @param {any} app
 * @param {{title:any, className?:string, build:(body:HTMLElement, api:{close:Function, rebuild:Function, setTitle:Function})=>void,
 *   onClose?:Function, dismissable?:boolean}} o
 * @returns {{close:Function, rebuild:Function, setTitle:Function, el:HTMLElement}}
 */
export function openSheet(app, o) {
  installSheetKeys();
  const prevFocus = document.activeElement;
  const dismissable = o.dismissable !== false;
  const titleEl = h('h2.sheet-title', { id: `sheet-t-${Date.now()}` }, o.title);
  const body = h('div.sheet-body');
  const closeBtn = h('button.btn.ghost.small.sheet-x', { type: 'button', 'aria-label': 'Close', 'data-fk': 'sheet-close', onclick: () => { app.sfx('back'); close(); } }, icon('cross', 2));
  const box = h(`div.sheet${o.className ? `.${o.className}` : ''}`, { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleEl.id, tabindex: '-1' },
    h('div.sheet-head', titleEl, dismissable ? closeBtn : null),
    body,
  );
  const overlay = h('div.screen-overlay.sheet-overlay', box);
  let closed = false;
  if (dismissable) {
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) { app.sfx('back'); close(); } });
  }
  function rebuild() {
    const st = body.scrollTop;
    const ae = document.activeElement;
    const fk = ae && box.contains(ae) && ae.dataset ? ae.dataset.fk : null;
    while (body.firstChild) body.removeChild(body.firstChild);
    o.build(body, api);
    body.scrollTop = st;
    if (!box.contains(document.activeElement)) {
      const el = (fk && box.querySelector(`[data-fk="${CSS.escape(fk)}"]`)) || box;
      el.focus({ preventScroll: true });
    }
  }
  function close() {
    if (closed) return;
    closed = true;
    const i = sheetStack.indexOf(entry);
    if (i >= 0) sheetStack.splice(i, 1);
    overlay.remove();
    if (o.onClose) o.onClose();
    if (prevFocus && prevFocus.isConnected && prevFocus.focus) prevFocus.focus({ preventScroll: true });
  }
  const api = { close, rebuild, setTitle: (t) => { titleEl.textContent = t; }, el: box };
  const entry = { app, box, close, dismissable };
  sheetStack.push(entry);
  o.build(body, api);
  (app.uiRoot || document.getElementById('ui')).appendChild(overlay);
  setTimeout(() => {
    if (closed) return;
    const target = box.querySelector('[autofocus]') || focusables(body)[0] || closeBtn;
    if (target && target.focus) target.focus({ preventScroll: true });
  }, 20);
  return api;
}

/**
 * Yes/no dialog. Resolves true on confirm.
 * @param {{title:string, body?:any, ok?:string, cancel?:string, danger?:boolean}} o
 */
export function confirmDialog(app, o) {
  return new Promise((resolve) => {
    let result = false;
    openSheet(app, {
      title: o.title,
      className: 'confirm',
      onClose: () => resolve(result),
      build: (body, api) => {
        if (o.body) body.appendChild(h('div.confirm-body', o.body));
        body.appendChild(h('div.btn-row.confirm-actions',
          h('button.btn.ghost', { type: 'button', onclick: () => { app.sfx('back'); api.close(); } }, o.cancel || 'Cancel'),
          h(`button.btn.${o.danger ? 'danger' : 'primary'}`, { type: 'button', autofocus: true, onclick: () => { app.sfx('select'); result = true; api.close(); } }, o.ok || 'OK'),
        ));
      },
    });
  });
}

/** Simple screen header: back button, title, optional right-side content. */
export function screenHeader(app, { title, onBack, right, backLabel = 'Back' }) {
  return h('header.sc-head',
    onBack ? h('button.btn.ghost.small.sc-back', { type: 'button', 'aria-label': backLabel, onclick: () => { app.sfx('back'); onBack(); } }, icon('back', 2), h('span.sc-back-txt', backLabel)) : null,
    h('h1.sc-title', title),
    h('div.sc-right', right || null),
  );
}

const focusSig = (el) => (el.id ? `#${el.id}` : el.dataset && el.dataset.fk ? `fk:${el.dataset.fk}`
  : el.getAttribute('aria-label') ? `al:${el.getAttribute('aria-label')}` : `tx:${(el.textContent || '').trim().slice(0, 48)}`);

/**
 * Remember which control inside `root` has focus, so a full redraw can put it back
 * (keyboard players keep their place; Enter never falls through to a screen's default action).
 * @returns {null | (() => void)} call after the redraw to restore focus
 */
export function keepFocus(root) {
  const ae = document.activeElement;
  if (!root || !ae || ae === document.body || !root.contains(ae)) return null;
  const sig = focusSig(ae);
  const tag = ae.tagName;
  const index = [...root.querySelectorAll(tag)].filter((x) => focusSig(x) === sig).indexOf(ae);
  return (fallback) => {
    const same = [...root.querySelectorAll(tag)].filter((x) => focusSig(x) === sig);
    const el = same[index] || same[same.length - 1] || fallback;
    if (el && el.focus) el.focus({ preventScroll: true });
  };
}

/** Install a keydown handler that ignores events while a sheet is open; returns remover. */
export function screenKeys(handler) {
  const fn = (e) => {
    // An event another handler already acted on (e.g. Enter that just started a career) must not
    // also trigger the next screen's shortcut when that screen mounts mid-dispatch.
    if (sheetOpen() || e.defaultPrevented) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) && e.key !== 'Escape') return;
    handler(e);
  };
  window.addEventListener('keydown', fn);
  return () => window.removeEventListener('keydown', fn);
}

/** Respect reduced motion for canvas animations. */
export const reducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};
