// Tiny DOM helpers used by every screen. No framework: screens build DOM with h() and re-render
// sections by replacing children.

/**
 * h('div.panel#id', {onclick, style, ...attrs}, ...children)
 * Tag string supports `.class` and `#id` shorthands. Children may be strings, nodes, arrays, null.
 */
export function h(tag, attrs, ...children) {
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  const m = tag.match(/^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i);
  const el = document.createElement((m && m[1]) || 'div');
  if (m && m[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g)) {
      if (part[0] === '.') el.classList.add(part.slice(1));
      else el.id = part.slice(1);
    }
  }
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'class' || k === 'className') el.className += ` ${v}`;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'html') el.innerHTML = v; // only for trusted, static strings
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** Replace el's children. */
export function render(el, ...children) {
  clear(el);
  appendChildren(el, children);
  return el;
}

/**
 * Show a modal in `root`. Resolves with the chosen action's `value`.
 * @param {HTMLElement} root
 * @param {{title:string, body?:any, actions:{label:string, value:any, kind?:string}[], dismissable?:boolean}} opts
 */
export function modal(root, { title, body, actions, dismissable = false }) {
  return new Promise((resolve) => {
    const overlay = h('div.screen-overlay', { role: 'dialog', 'aria-modal': 'true' });
    const close = (v) => {
      overlay.remove();
      resolve(v);
    };
    const box = h('div.modal',
      h('h2', title),
      body !== undefined ? h('div.body', body) : null,
      h('div.btn-col', actions.map((a) => h(`button.btn.block${a.kind ? `.${a.kind}` : ''}`, { onclick: () => close(a.value), disabled: a.disabled }, a.label))),
    );
    overlay.appendChild(box);
    if (dismissable) overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(null); });
    root.appendChild(overlay);
    const first = box.querySelector('button:not([disabled])');
    if (first) setTimeout(() => first.focus({ preventScroll: true }), 30);
  });
}

let toastWrap = null;
export function toast(msg, ms = 1800) {
  if (!toastWrap || !toastWrap.isConnected) {
    toastWrap = h('div.toast-wrap');
    document.getElementById('app').appendChild(toastWrap);
  }
  const t = h('div.toast', msg);
  toastWrap.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

/** ★★★☆☆ style rating; value 0..max (halves allowed) */
export function stars(value, max = 5) {
  const full = Math.floor(value);
  const half = value - full >= 0.5;
  const parts = [];
  for (let i = 0; i < max; i++) {
    if (i < full) parts.push(h('span', '★'));
    else if (i === full && half) parts.push(h('span', '⯪'));
    else parts.push(h('span.off', '★'));
  }
  return h('span.stars', { 'aria-label': `${value} of ${max} stars` }, parts);
}

export function bar(frac, color) {
  const pct = Math.max(0, Math.min(1, frac)) * 100;
  return h('div.bar', h('i', { style: { width: `${pct}%`, background: color || undefined } }));
}
