// Pixel-perfect display. Everything in-game is drawn to a low-resolution "virtual" buffer whose
// short side is ~BASE_SHORT px, then blitted to the visible canvas at an INTEGER scale with
// nearest-neighbour sampling, so pixel art stays crisp on every phone and monitor.
// The virtual buffer always fills the screen (no letterboxing): its long side varies with aspect.

export const BASE_SHORT = 270;

export class Display {
  /** @param {HTMLCanvasElement} canvas visible canvas (CSS-sized to fill its container) */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.buf = document.createElement('canvas');
    this.bctx = this.buf.getContext('2d');
    this.w = 480; // virtual px
    this.h = 270;
    this.scale = 1; // physical px per virtual px
    this.dpr = 1;
    this.cssW = 1;
    this.cssH = 1;
    this.orientation = 'landscape';
    this.listeners = new Set();
    this.resize = this.resize.bind(this);
    window.addEventListener('resize', this.resize);
    window.addEventListener('orientationchange', () => setTimeout(this.resize, 150));
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(this.resize).observe(canvas);
    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(r.width || window.innerWidth));
    const cssH = Math.max(1, Math.round(r.height || window.innerHeight));
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const physW = Math.round(cssW * dpr);
    const physH = Math.round(cssH * dpr);
    const short = Math.min(physW, physH);
    const scale = Math.max(1, Math.round(short / BASE_SHORT));
    const w = Math.ceil(physW / scale);
    const h = Math.ceil(physH / scale);
    const changed = w !== this.w || h !== this.h || scale !== this.scale || physW !== this.canvas.width || physH !== this.canvas.height;
    Object.assign(this, { cssW, cssH, dpr, scale, w, h, orientation: cssW >= cssH ? 'landscape' : 'portrait' });
    if (!changed) return;
    this.canvas.width = physW;
    this.canvas.height = physH;
    this.buf.width = w;
    this.buf.height = h;
    this.bctx.imageSmoothingEnabled = false;
    this.ctx.imageSmoothingEnabled = false;
    for (const fn of this.listeners) fn(this);
  }

  onResize(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Start a frame: returns the virtual-resolution context. */
  begin(clearColor = '#000') {
    const c = this.bctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.fillStyle = clearColor;
    c.fillRect(0, 0, this.w, this.h);
    return c;
  }

  /** Blit the virtual buffer to the visible canvas. */
  present() {
    const c = this.ctx;
    c.imageSmoothingEnabled = false;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(this.buf, 0, 0, this.w * this.scale, this.h * this.scale);
  }

  /** CSS px (relative to canvas) -> virtual px */
  cssToVirtual(x, y) {
    const k = (this.dpr / this.scale);
    return { x: x * k, y: y * k };
  }

  virtualToCss(x, y) {
    const k = this.scale / this.dpr;
    return { x: x * k, y: y * k };
  }
}
