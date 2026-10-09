// Settings: sound, vibration, match options (quarter length, drive direction, camera, wind, tips),
// in-career difficulty, delete save. Params: {from?: screen name, fromParams?: object}

import { h, toast } from '../dom.js';
import * as F from '../../franchise/index.js';
import { deleteSave } from '../../core/storage.js';
import { btn, segmented, toggle, screenHeader, screenKeys, confirmDialog } from './common.js';
import { DIFFICULTY_TEXT } from './newGame.js';

export class SettingsScreen {
  constructor(app, params = {}) {
    this.app = app;
    this.from = params.from || (app.save ? 'hub' : 'title');
    this.fromParams = params.fromParams || {};
  }

  mount(root) {
    this.root = h('div.screen.settings');
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
    const app = this.app;
    let to = this.from;
    if (!app.save && to !== 'title') to = 'title';
    if (to === 'offseason' && (!app.save || app.save.season.phase !== 'offseason')) to = 'hub';
    app.go(to, this.fromParams);
  }

  set(patch) {
    this.app.updateSettings(patch);
    this.draw(true);
  }

  draw(keepScroll = false) {
    const app = this.app;
    const s = app.settings;
    const root = this.root;
    const prev = root.querySelector('.set-body');
    const st = keepScroll && prev ? prev.scrollTop : 0;
    const focusKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.fk : null;
    while (root.firstChild) root.removeChild(root.firstChild);

    const row = (label, control, hint, id) => h(`div.set-row${control.classList.contains('switch') ? '.sw' : ''}`, h('div.set-lbl', h('label', { for: id || null }, label), hint ? h('p.set-hint', hint) : null), h('div.set-ctl', control));
    const seg = (key, options, label) => {
      const el = segmented({ app, label, value: s[key], options, onChange: (v) => this.set({ [key]: v }) });
      return el;
    };
    const sw = (key, label) => {
      const el = toggle({ app, checked: !!s[key], label, id: `set-${key}`, onChange: (v) => { this.set({ [key]: v }); if (key === 'vibration' && v) app.vibrate(30); } });
      el.dataset.fk = key;
      return el;
    };

    const sections = [
      h('section.panel.set-sec',
        h('h2.panel-title', 'Sound & feel'),
        row('Sound effects', sw('sound', 'Sound effects'), null, 'set-sound'),
        row('Vibration', sw('vibration', 'Vibration'), 'Short buzzes on big hits and scores (phones only).', 'set-vibration'),
      ),
      h('section.panel.set-sec',
        h('h2.panel-title', 'Match'),
        row('Quarter length', seg('quarterMinutes', [1, 2, 3].map((m) => ({ value: m, label: `${m} min` })), 'Quarter length'), 'Game clock per quarter. Longer quarters add timeouts too.'),
        row('Drive direction', seg('driveDirection', [{ value: 'right', label: 'Right' }, { value: 'left', label: 'Left' }, { value: 'alternate', label: 'Alternate' }], 'Drive direction'),
          'Landscape only (portrait always drives up). Right-handers often pick Left so the thumb never covers the field ahead; lefties pick Right. Alternate switches at halftime.'),
        row('Camera', seg('cameraZoom', [{ value: 'near', label: 'Near' }, { value: 'far', label: 'Far' }], 'Camera zoom'), 'Far shows more of the field.'),
        row('Wind', seg('wind', [{ value: 'off', label: 'Off' }, { value: 'low', label: 'Low' }, { value: 'normal', label: 'Normal' }, { value: 'high', label: 'High' }], 'Wind'), 'How often and how hard the wind blows on kicks.'),
        row('Control tips', sw('showTips', 'Control tips'), 'Short on-field hints for the first plays.', 'set-showTips'),
      ),
    ];

    const save = app.save;
    if (save) {
      const info = F.difficultyInfo(save);
      const dseg = segmented({
        app,
        label: 'Difficulty',
        wide: true,
        value: info.mode,
        options: F.DIFFICULTY.modes.map((m) => ({ value: m, label: F.DIFFICULTY.labels[m], hint: DIFFICULTY_TEXT[m] })),
        onChange: (v) => {
          F.setDifficulty(save, v);
          app.persist();
          toast(`Difficulty: ${F.difficultyInfo(save).label}`);
          this.draw(true);
        },
      });
      sections.push(h('section.panel.set-sec',
        h('h2.panel-title', `Career · Coach ${save.coach.name}`),
        row('Difficulty', dseg, `${DIFFICULTY_TEXT[info.mode]}${info.mode === 'dynamic' ? ` Current level ${info.step} of 16${info.cap < 16 ? ` (capped at ${info.cap} until your first title)` : ''}.` : ''}`),
        h('div.set-actions',
          btn(app, 'Main menu', () => app.go('title'), { kind: 'ghost', icon: 'back' }),
          btn(app, 'Delete career', () => this.deleteCareer(), { kind: 'danger', id: 'btn-delete' }),
        ),
      ));
    }

    sections.push(h('section.panel.set-sec',
      h('h2.panel-title', 'About'),
      h('p', 'Pocket Gridiron: an original game inspired by classic arcade football. All names, art, sound and text are original.'),
      h('div.set-actions', btn(app, 'How to Play', () => app.go('help', { from: 'settings', fromParams: { from: this.from, fromParams: this.fromParams } }), { icon: 'info' })),
    ));

    root.appendChild(h('div.wrap.set-wrap',
      screenHeader(app, { title: 'Settings', onBack: () => this.back() }),
      h('div.set-body.scroll-y', h('div.set-grid', sections)),
    ));
    const body = root.querySelector('.set-body');
    body.scrollTop = st;
    if (focusKey) {
      const el = root.querySelector(`[data-fk="${CSS.escape(focusKey)}"]`);
      if (el) el.focus({ preventScroll: true });
    }
  }

  async deleteCareer() {
    const app = this.app;
    const ok = await confirmDialog(app, {
      title: 'Delete career?',
      body: h('p', 'Your franchise, history and Hall of Fame will be gone for good. Settings are kept.'),
      ok: 'Delete',
      danger: true,
    });
    if (!ok) return;
    deleteSave();
    app.save = null;
    app.sfx('bad');
    toast('Career deleted');
    app.go('title');
  }
}
