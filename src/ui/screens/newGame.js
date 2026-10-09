// New career wizard: 1 coach name, 2 team, 3 difficulty, then newFranchise() and on to the hub.

import { h } from '../dom.js';
import * as F from '../../franchise/index.js';
import { Rng, freshSeed } from '../../core/rng.js';
import { CONFERENCES, DIVISIONS } from '../../data/teams.js';
import { btn, helmet, starRow, screenHeader, screenKeys, setVars, teamVars, teamTag } from './common.js';

export const DIFFICULTY_TEXT = {
  easy: 'Soft coverage and forgiving throws. A good place to learn the controls.',
  medium: 'A fair fight. Opponents play to their ratings.',
  hard: 'Quicker defenders, tighter windows and less of the throw arc to read.',
  extreme: 'Every opponent plays like a five-star team. Good luck.',
  dynamic: 'Adapts to you: each win makes the league a little tougher, each loss eases off.',
};

const STEPS = ['Coach', 'Team', 'Level'];

export class NewGameScreen {
  constructor(app) {
    this.app = app;
    this.step = 0;
    this.seed = freshSeed();
    this.coachName = '';
    this.teamId = null;
    this.difficulty = 'dynamic';
    // Same seed => the league that newFranchise() builds has exactly these AI ratings.
    this.teams = F.createTeams(new Rng(this.seed));
    const preview = F.newFranchise({ coachName: 'Preview', teamId: this.teams[0].id, seed: this.seed });
    this.squad = F.teamRatings(preview);
    this.squadSize = F.roster(preview).length;
  }

  mount(root) {
    this.root = h('div.screen.ng');
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
    if (this.step > 0) { this.step -= 1; this.draw(); } else this.app.go('title');
  }

  next() {
    if (this.step === 0) {
      this.coachName = (this.nameInput.value || '').trim().slice(0, 24);
      if (!this.coachName) {
        this.nameInput.classList.add('err');
        this.nameInput.focus();
        this.app.sfx('bad');
        return;
      }
    }
    if (this.step === 1 && !this.teamId) { this.app.sfx('bad'); return; }
    if (this.step < STEPS.length - 1) {
      this.step += 1;
      this.draw();
    } else this.start();
  }

  start() {
    const app = this.app;
    const save = F.newFranchise({ coachName: this.coachName || 'Coach', teamId: this.teamId, seed: this.seed, difficulty: this.difficulty });
    app.save = save;
    app.persist();
    app.sfx('good');
    app.go('hub', { tab: 'home', welcome: true });
  }

  draw() {
    const app = this.app;
    const root = this.root;
    while (root.firstChild) root.removeChild(root.firstChild);
    const stepper = h('ol.stepper', { 'aria-label': 'Steps' }, STEPS.map((s, i) => h(`li${i === this.step ? '.on' : i < this.step ? '.done' : ''}`, { 'aria-current': i === this.step ? 'step' : null }, h('b', String(i + 1)), h('span', s))));
    const body = h('div.ng-body.scroll-y');
    const team = this.teamId ? this.teams.find((t) => t.id === this.teamId) : null;
    if (team) setVars(root, teamVars(team.colors));
    let nextLabel = 'Next';
    if (this.step === 0) body.appendChild(this.coachStep());
    else if (this.step === 1) body.appendChild(this.teamStep());
    else { body.appendChild(this.levelStep()); nextLabel = 'Start career'; }

    const nextBtn = btn(app, nextLabel, () => this.next(), { kind: 'primary', id: 'ng-next', sfx: this.step === 2 ? false : 'select', disabled: this.step === 1 && !this.teamId });
    this.nextBtn = nextBtn;
    root.append(
      h('div.wrap.ng-wrap',
        screenHeader(app, { title: 'New Career', onBack: () => this.back(), right: stepper }),
        body,
        h('footer.ng-foot',
          this.step === 1 ? h('div.ng-pick', { 'aria-live': 'polite' }, team ? [teamTag(team, { size: 'md' }), h('span.ng-pick-city', team.city)] : h('span.dim', 'Pick a club')) : h('span'),
          nextBtn,
        ),
      ),
    );
    if (this.step === 0) setTimeout(() => this.nameInput && this.nameInput.focus({ preventScroll: true }), 30);
    if (this.step === 1 && this.teamId) {
      const sel = root.querySelector('.team-card.on');
      if (sel) sel.scrollIntoView({ block: 'nearest' });
    }
  }

  /** Select a club in place (keeps the list's scroll position). */
  selectTeam(id) {
    this.teamId = id;
    const team = this.teams.find((t) => t.id === id);
    for (const c of this.root.querySelectorAll('.team-card')) {
      const on = c.dataset.team === id;
      c.classList.toggle('on', on);
      c.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    setVars(this.root, teamVars(team.colors));
    const pick = this.root.querySelector('.ng-pick');
    if (pick) {
      while (pick.firstChild) pick.removeChild(pick.firstChild);
      pick.append(teamTag(team, { size: 'md' }), h('span.ng-pick-city', team.city));
    }
    if (this.nextBtn) this.nextBtn.disabled = false;
  }

  coachStep() {
    this.nameInput = h('input#coach-name', {
      type: 'text',
      maxlength: '24',
      autocomplete: 'off',
      autocapitalize: 'words',
      spellcheck: 'false',
      placeholder: 'Coach name',
      'aria-label': 'Coach name',
      value: this.coachName,
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); this.app.sfx('select'); this.next(); } },
      oninput: (e) => e.target.classList.remove('err'),
    });
    return h('section.panel.ng-coach',
      h('h2.panel-title', 'Who is calling the plays?'),
      h('p', 'Pick a name for your coach. It shows up in the papers, the press room and the record books.'),
      h('label.ng-label', { for: 'coach-name' }, 'Coach name'),
      this.nameInput,
      h('p.dim.small', 'You can change difficulty and match options any time in Settings.'),
    );
  }

  teamStep() {
    const app = this.app;
    const wrap = h('section.ng-teams');
    wrap.appendChild(h('div.panel.ng-note',
      h('p', h('b.accent', 'Every club is a rebuild. '), `Whoever you pick, you inherit ${this.squadSize} young role players (your squad: OFF `, starRow(this.squad.off, { scale: 1.5 }), ' DEF ', starRow(this.squad.def, { scale: 1.5 }), '). Stars on the cards show each club\'s current league strength, so look for a division you can climb.'),
    ));
    for (let c = 0; c < CONFERENCES.length; c++) {
      for (let d = 0; d < DIVISIONS.length; d++) {
        const div = this.teams.filter((t) => t.conf === c && t.div === d);
        const avg = div.reduce((s, t) => s + t.off + t.def, 0) / (div.length * 2);
        const tough = avg >= 3.2 ? 'Tough division' : avg <= 2.8 ? 'Open division' : 'Balanced division';
        wrap.appendChild(h('h3.ng-div', h('span', `${CONFERENCES[c]} ${DIVISIONS[d]}`), h('span.dim', tough)));
        wrap.appendChild(h('div.team-grid', { role: 'radiogroup', 'aria-label': `${CONFERENCES[c]} ${DIVISIONS[d]}` }, div.map((t) => {
          const on = t.id === this.teamId;
          const card = h(`button.team-card${on ? '.on' : ''}`, {
            type: 'button',
            role: 'radio',
            'aria-checked': on ? 'true' : 'false',
            'data-team': t.id,
            onclick: () => {
              app.sfx('select');
              this.selectTeam(t.id);
            },
            ondblclick: () => this.next(),
          },
          h('span.tc-helmet', helmet(t.colors, { scale: 2 })),
          h('span.tc-main',
            h('span.tc-city', t.city),
            h('span.tc-rate', h('span.label', 'OFF'), starRow(t.off, { scale: 1 })),
            h('span.tc-rate', h('span.label', 'DEF'), starRow(t.def, { scale: 1 })),
          ));
          setVars(card, teamVars(t.colors));
          return card;
        })));
      }
    }
    return wrap;
  }

  levelStep() {
    const app = this.app;
    const team = this.teams.find((t) => t.id === this.teamId);
    const list = h('div.diff-list', { role: 'radiogroup', 'aria-label': 'Difficulty' }, F.DIFFICULTY.modes.slice().sort((a, b) => (a === 'dynamic' ? -1 : b === 'dynamic' ? 1 : 0)).map((m) => {
      const on = m === this.difficulty;
      return h(`button.diff-opt${on ? '.on' : ''}`, {
        type: 'button',
        role: 'radio',
        'aria-checked': on ? 'true' : 'false',
        'data-diff': m,
        onclick: () => {
          app.sfx('select');
          this.difficulty = m;
          for (const b of list.querySelectorAll('.diff-opt')) {
            const sel = b.dataset.diff === m;
            b.classList.toggle('on', sel);
            b.setAttribute('aria-checked', sel ? 'true' : 'false');
          }
        },
      },
      h('span.diff-name', F.DIFFICULTY.labels[m], m === 'dynamic' ? h('span.chip.ok', 'Default') : null),
      h('span.diff-desc', DIFFICULTY_TEXT[m]));
    }));
    return h('div.ng-level',
      h('section.panel',
        h('h2.panel-title', 'Difficulty'),
        list,
      ),
      team ? h('section.panel.ng-summary',
        h('h2.panel-title', 'Ready?'),
        h('div.ng-sum-row', helmet(team.colors, { scale: 3 }), h('div',
          h('p.ng-sum-team', `Coach ${this.coachName || 'Coach'}`),
          h('p', `Head coach of ${team.city}. Season ${F.START_YEAR}. 16 games, then the playoffs and a shot at the ${F.LEAGUE.cupName}.`),
        )),
      ) : null,
    );
  }
}
