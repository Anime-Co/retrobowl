// App shell: owns global services and the active screen. Screens are classes with:
//   constructor(app, params)   build state (no DOM yet)
//   mount(root)                build DOM inside `root` (the #ui layer)
//   unmount()                  cleanup (listeners, timers)
//   update?(dt)                fixed-step update (1/60 s) while active
//   render?(alpha, frameDt)    per-frame render while active
// Navigation: app.go('hub', {tab:'roster'}). Register screens in main.js.

import { Display } from './render/display.js';
import { Input } from './core/input.js';
import { Audio } from './core/audio.js';
import { Loop } from './core/loop.js';
import { loadSave, writeSave, loadSettings, saveSettings } from './core/storage.js';
import { clear } from './ui/dom.js';

export class App {
  constructor() {
    this.uiRoot = document.getElementById('ui');
    this.stage = document.getElementById('stage');
    this.canvas = document.getElementById('game');
    this.hudEl = document.getElementById('hud');
    this.display = new Display(this.canvas);
    this.input = new Input(this.stage);
    this.audio = new Audio();
    this.settings = loadSettings();
    this.audio.setEnabled(this.settings.sound);
    /** @type {import('./types.js').Save|null} */
    this.save = loadSave();
    this.screens = new Map();
    this.current = null;
    this.currentName = '';
    this.loop = new Loop({
      update: (dt) => {
        this.input.pollGamepads();
        if (this.current && this.current.update) this.current.update(dt);
      },
      render: (alpha, frameDt) => {
        if (this.current && this.current.render) this.current.render(alpha, frameDt);
      },
    });
    // Debug/testing hook (used by automated browser tests).
    window.__app = this;
  }

  /** @param {string} name @param {new (app: App, params: any) => any} ScreenClass */
  register(name, ScreenClass) {
    this.screens.set(name, ScreenClass);
  }

  go(name, params = {}) {
    const ScreenClass = this.screens.get(name);
    if (!ScreenClass) throw new Error(`Unknown screen: ${name}`);
    if (this.current) {
      try { this.current.unmount?.(); } catch (e) { console.error(e); }
    }
    clear(this.uiRoot);
    clear(this.hudEl);
    this.showStage(false);
    this.input.reset();
    this.current = new ScreenClass(this, params);
    this.currentName = name;
    this.current.mount?.(this.uiRoot);
    this.uiRoot.scrollTop = 0;
  }

  /** Show/hide the game canvas layer (only the match screen uses it). */
  showStage(on) {
    this.stage.hidden = !on;
    this.input.captureKeys = on;
    if (on) this.display.resize();
  }

  sfx(name, opts) {
    this.audio.play(name, opts);
  }

  vibrate(ms = 15) {
    if (this.settings.vibration && navigator.vibrate) {
      try { navigator.vibrate(ms); } catch { /* ignore */ }
    }
  }

  persist() {
    if (this.save) writeSave(this.save);
  }

  updateSettings(patch) {
    Object.assign(this.settings, patch);
    saveSettings(this.settings);
    this.audio.setEnabled(this.settings.sound);
  }

  start(initial = 'title') {
    this.go(initial);
    this.loop.start();
  }
}
