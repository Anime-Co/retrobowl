// Unified input: Pointer Events (touch + mouse + pen) with gesture recognition, keyboard and
// gamepad. Consumers call poll() once per update to drain queued events, and may read the live
// `pointer` / `keys` state. Coordinates are CSS pixels relative to the target element; convert
// with Display.cssToVirtual().
//
// Event shapes (all have `t` = performance.now() ms):
//   {type:'down', x, y}                       primary pointer pressed
//   {type:'move', x, y, dx, dy}               primary pointer moved (dx,dy from press point)
//   {type:'up', x, y, dx, dy, duration}       primary pointer released
//   {type:'dragstart', x, y, startX, startY}  moved beyond DRAG_START px while held
//   {type:'drag', x, y, dx, dy, startX, startY}
//   {type:'dragend', x, y, dx, dy, startX, startY, duration}
//   {type:'tap', x, y}                        short press with little movement
//   {type:'swipe', x, y, dx, dy, dir, speed}  fast flick (also produces drag events before it)
//   {type:'key', code, down:boolean, repeat:boolean}   keyboard / mapped gamepad buttons
//   {type:'cancel'}                           pointer cancelled (e.g. OS gesture)

export const TAP_MAX_MS = 260;
export const TAP_MAX_MOVE = 12;
export const DRAG_START = 10;
export const SWIPE_MIN_DIST = 26;
export const SWIPE_MAX_MS = 320;
export const SWIPE_MIN_SPEED = 260; // css px / s

const GAMEPAD_MAP = {
  0: 'PadA', 1: 'PadB', 2: 'PadX', 3: 'PadY', 9: 'PadStart',
  12: 'ArrowUp', 13: 'ArrowDown', 14: 'ArrowLeft', 15: 'ArrowRight',
};

const PREVENT_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

export class Input {
  /** @param {HTMLElement} el element receiving pointer input (the game stage) */
  constructor(el) {
    this.el = el;
    this.queue = [];
    this.pointer = { down: false, id: -1, x: 0, y: 0, startX: 0, startY: 0, startT: 0, dragging: false, history: [] };
    this.keys = new Set();
    this.enabled = true;
    this.captureKeys = false; // when true, arrow/space keys don't scroll the page
    this._pad = {};

    el.addEventListener('pointerdown', (e) => this._down(e));
    el.addEventListener('pointermove', (e) => this._move(e));
    el.addEventListener('pointerup', (e) => this._up(e));
    el.addEventListener('pointercancel', (e) => this._cancel(e));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this._key(e, true));
    window.addEventListener('keyup', (e) => this._key(e, false));
    window.addEventListener('blur', () => {
      this.keys.clear();
      if (this.pointer.down) this._cancel({ pointerId: this.pointer.id });
    });
  }

  _pos(e) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _push(ev) {
    if (!this.enabled) return;
    ev.t = performance.now();
    this.queue.push(ev);
    if (this.queue.length > 256) this.queue.shift();
  }

  _down(e) {
    if (this.pointer.down) return; // primary pointer only
    if (e.button !== undefined && e.button > 0) return;
    const { x, y } = this._pos(e);
    try { this.el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const p = this.pointer;
    Object.assign(p, { down: true, id: e.pointerId, x, y, startX: x, startY: y, startT: performance.now(), dragging: false });
    p.history = [{ x, y, t: p.startT }];
    this._push({ type: 'down', x, y });
    e.preventDefault?.();
  }

  _move(e) {
    const p = this.pointer;
    const { x, y } = this._pos(e);
    if (!p.down || e.pointerId !== p.id) {
      p.x = x; p.y = y; // hover position for mouse aiming
      return;
    }
    p.x = x; p.y = y;
    const now = performance.now();
    p.history.push({ x, y, t: now });
    while (p.history.length > 2 && now - p.history[0].t > 120) p.history.shift();
    const dx = x - p.startX;
    const dy = y - p.startY;
    this._push({ type: 'move', x, y, dx, dy });
    if (!p.dragging && Math.hypot(dx, dy) > DRAG_START) {
      p.dragging = true;
      this._push({ type: 'dragstart', x, y, startX: p.startX, startY: p.startY });
    }
    if (p.dragging) this._push({ type: 'drag', x, y, dx, dy, startX: p.startX, startY: p.startY });
  }

  _up(e) {
    const p = this.pointer;
    if (!p.down || e.pointerId !== p.id) return;
    const { x, y } = this._pos(e);
    const now = performance.now();
    const dx = x - p.startX;
    const dy = y - p.startY;
    const duration = now - p.startT;
    p.down = false;
    this._push({ type: 'up', x, y, dx, dy, duration });
    if (p.dragging) this._push({ type: 'dragend', x, y, dx, dy, startX: p.startX, startY: p.startY, duration });
    const moved = Math.hypot(dx, dy);
    if (duration <= TAP_MAX_MS && moved <= TAP_MAX_MOVE) {
      this._push({ type: 'tap', x, y });
    } else {
      // Swipe detection on recent motion so a slow drag ending in a flick still counts.
      const h = p.history;
      const first = h.find((s) => now - s.t <= SWIPE_MAX_MS) || h[0];
      const sdx = x - first.x;
      const sdy = y - first.y;
      const sdt = Math.max(16, now - first.t) / 1000;
      const sd = Math.hypot(sdx, sdy);
      const speed = sd / sdt;
      if (sd >= SWIPE_MIN_DIST && speed >= SWIPE_MIN_SPEED) {
        const dir = Math.abs(sdx) > Math.abs(sdy) ? (sdx > 0 ? 'right' : 'left') : sdy > 0 ? 'down' : 'up';
        this._push({ type: 'swipe', x, y, dx: sdx, dy: sdy, dir, speed });
      }
    }
    p.dragging = false;
  }

  _cancel(e) {
    const p = this.pointer;
    if (!p.down || (e.pointerId !== undefined && e.pointerId !== p.id)) return;
    p.down = false;
    p.dragging = false;
    this._push({ type: 'cancel' });
  }

  _key(e, down) {
    const target = e.target;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (typing) return;
    if (this.captureKeys && PREVENT_KEYS.has(e.code)) e.preventDefault();
    if (down) this.keys.add(e.code);
    else this.keys.delete(e.code);
    this._push({ type: 'key', code: e.code, down, repeat: !!e.repeat });
  }

  /** Poll gamepads (call once per frame); maps buttons to key events. */
  pollGamepads() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = pads && Array.from(pads).find(Boolean);
    if (!pad) return;
    for (const [idx, code] of Object.entries(GAMEPAD_MAP)) {
      const pressed = !!pad.buttons[idx]?.pressed;
      if (pressed !== !!this._pad[code]) {
        this._pad[code] = pressed;
        if (pressed) this.keys.add(code); else this.keys.delete(code);
        this._push({ type: 'key', code, down: pressed, repeat: false });
      }
    }
    // Left stick -> arrow keys (digital)
    const ax = pad.axes[0] || 0;
    const ay = pad.axes[1] || 0;
    const stick = { ArrowLeft: ax < -0.5, ArrowRight: ax > 0.5, ArrowUp: ay < -0.5, ArrowDown: ay > 0.5 };
    for (const [code, on] of Object.entries(stick)) {
      const k = `stick_${code}`;
      if (on !== !!this._pad[k]) {
        this._pad[k] = on;
        if (on) this.keys.add(code); else if (!this._pad[code]) this.keys.delete(code);
        this._push({ type: 'key', code, down: on, repeat: false });
      }
    }
  }

  /** Drain queued events. */
  poll() {
    const q = this.queue;
    this.queue = [];
    return q;
  }

  /** Discard pending events and pointer state (e.g. when switching screens). */
  reset() {
    this.queue = [];
    this.pointer.down = false;
    this.pointer.dragging = false;
  }

  isDown(code) {
    return this.keys.has(code);
  }
}
