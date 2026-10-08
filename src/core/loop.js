// Fixed-timestep game loop: simulation advances in exact STEP increments (deterministic),
// rendering happens once per animation frame with an interpolation alpha.

export const STEP = 1 / 60;

export class Loop {
  /**
   * @param {{update:(dt:number)=>void, render:(alpha:number, frameDt:number)=>void}} hooks
   */
  constructor(hooks) {
    this.hooks = hooks;
    this.acc = 0;
    this.last = 0;
    this.running = false;
    this.timeScale = 1;
    this._raf = 0;
    this._frame = this._frame.bind(this);
    document.addEventListener('visibilitychange', () => {
      // Avoid a giant catch-up step after the tab was hidden.
      this.last = performance.now();
      this.acc = 0;
    });
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this._raf = requestAnimationFrame(this._frame);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
  }

  _frame(now) {
    if (!this.running) return;
    let frameDt = (now - this.last) / 1000;
    this.last = now;
    if (frameDt > 0.25) frameDt = 0.25;
    this.acc += frameDt * this.timeScale;
    let steps = 0;
    while (this.acc >= STEP && steps < 10) {
      this.hooks.update(STEP);
      this.acc -= STEP;
      steps++;
    }
    if (steps === 10) this.acc = 0;
    this.hooks.render(this.acc / STEP, frameDt);
    this._raf = requestAnimationFrame(this._frame);
  }
}
