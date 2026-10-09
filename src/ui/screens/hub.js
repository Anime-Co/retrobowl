// Franchise hub: team header (record, phase, CC, fans, owner) + tabs. Tabs live in hub*.js files
// and render into the scrollable body; `refresh()` redraws header and body after any mutation.
// Params: {tab?: 'home'|'roster'|'schedule'|'standings'|'team'|'market', welcome?: boolean}

import { h, toast } from '../dom.js';
import * as F from '../../franchise/index.js';
import { icon, helmet, ccChip, meter, setVars, teamVars, screenKeys, keepFocus } from './common.js';
import { phaseText } from './widgets.js';
import { renderHome } from './hubHome.js';
import { renderRoster } from './hubRoster.js';
import { renderSchedule } from './hubSchedule.js';
import { renderStandings } from './hubStandings.js';
import { renderTeam } from './hubTeam.js';
import { renderMarket } from './hubMarket.js';
import { openPlayerCard } from './playerCard.js';

export const HUB_TABS = [
  { id: 'home', label: 'Home', short: 'Home', icon: 'home', render: renderHome },
  { id: 'roster', label: 'Roster', short: 'Roster', icon: 'roster', render: renderRoster },
  { id: 'schedule', label: 'Schedule', short: 'Games', icon: 'schedule', render: renderSchedule },
  { id: 'standings', label: 'Standings', short: 'Table', icon: 'standings', render: renderStandings },
  { id: 'team', label: 'Team', short: 'Club', icon: 'team', render: renderTeam },
  { id: 'market', label: 'Free Agents', short: 'Agents', icon: 'market', render: renderMarket },
];

export class HubScreen {
  constructor(app, params = {}) {
    this.app = app;
    this.tab = HUB_TABS.some((t) => t.id === params.tab) ? params.tab : 'home';
    this.welcome = !!params.welcome;
    this.scroll = {};
    this.state = {}; // per-tab UI state (filters, toggles) kept across refreshes
  }

  get save() {
    return this.app.save;
  }

  mount(root) {
    const app = this.app;
    if (!app.save) { setTimeout(() => app.go('title'), 0); return; }
    if (app.save.fired) { setTimeout(() => app.go('fired'), 0); return; }
    this.head = h('header.hub-head');
    this.nav = h('nav.hub-nav', { role: 'tablist', 'aria-label': 'Franchise sections' });
    this.body = h('main.hub-body.scroll-y', { role: 'tabpanel', id: 'hub-panel', tabindex: '-1' });
    this.root = h('div.screen.hub', h('div.hub-frame', this.head, this.nav, this.body));
    root.appendChild(this.root);
    this.offKeys = screenKeys((e) => this.onKey(e));
    this.refresh();
    if (this.welcome) {
      const t = F.userTeam(app.save);
      toast(`Welcome to ${t.city}, Coach ${app.save.coach.name}!`, 2600);
    }
  }

  unmount() {
    if (this.offKeys) this.offKeys();
  }

  onKey(e) {
    if (e.key === 'Escape') return;
    // Enter with nothing focused runs the Home tab's main action (Play / Advance / Offseason).
    const ae = document.activeElement;
    if (e.key === 'Enter' && this.tab === 'home' && (!ae || ae === document.body)) {
      const b = this.root.querySelector('#btn-play, #btn-advance, #btn-offseason');
      if (b && !b.disabled) { e.preventDefault(); b.click(); }
      return;
    }
    // Number keys 1-6 jump between tabs on desktop.
    if (/^[1-6]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const t = HUB_TABS[Number(e.key) - 1];
      if (t) { this.app.sfx('click'); this.setTab(t.id, true); }
    }
  }

  setTab(id, focus = false) {
    if (this.body) this.scroll[this.tab] = this.body.scrollTop;
    this.tab = id;
    this.refresh(false);
    this.body.scrollTop = this.scroll[id] || 0;
    if (focus) {
      const b = this.nav.querySelector(`[data-tab="${id}"]`);
      if (b) b.focus();
    }
  }

  /** Redraw header, nav and the active tab. keepScroll preserves the body's scroll position. */
  refresh(keepScroll = true) {
    const save = this.save;
    if (!save || !this.root) return;
    const st = keepScroll ? this.body.scrollTop : 0;
    const refocus = keepFocus(this.root);
    const team = F.userTeam(save);
    setVars(this.root, teamVars(team.colors));
    this.drawHead(save, team);
    this.drawNav(save);
    while (this.body.firstChild) this.body.removeChild(this.body.firstChild);
    const tab = HUB_TABS.find((t) => t.id === this.tab) || HUB_TABS[0];
    this.body.setAttribute('aria-label', tab.label);
    this.body.dataset.tab = tab.id;
    this.body.appendChild(tab.render(this.ctx()));
    if (keepScroll) this.body.scrollTop = st;
    // Keyboard players keep their place across redraws; if the control is gone, focus parks on
    // the panel (never on <body>, where Enter would start the next game).
    if (refocus) refocus(this.body);
  }

  ctx() {
    return {
      app: this.app,
      save: this.save,
      hub: this,
      state: this.state,
      refresh: () => this.refresh(),
      go: (tab) => this.setTab(tab),
      openPlayer: (id) => openPlayerCard(this.app, this.save, id, { onChange: () => this.refresh() }),
    };
  }

  drawHead(save, team) {
    const app = this.app;
    const sum = F.hubSummary(save);
    const head = this.head;
    while (head.firstChild) head.removeChild(head.firstChild);
    head.append(
      h('div.hh-team',
        h('span.hh-helmet', helmet(team.colors, { scale: 2 })),
        h('div.hh-id',
          h('h1.hh-city', team.city),
          h('p.hh-sub', h('b', sum.record), h('span', ` · ${phaseText(save)}`), h('span.hide-xs', ` · ${save.season.year}`)),
        ),
      ),
      h('div.hh-stats',
        ccChip(save.cc),
        meter('Fans', sum.fans, { iconName: 'fans', title: `Fan support ${sum.fans}/100` }),
        meter('Owner', sum.jobSecurity, { iconName: 'owner', warnBelow: 25, title: `Owner confidence ${sum.jobSecurity}/100 (below ${F.OWNER.fireBelow} at season end and you may be fired)` }),
      ),
      h('button.btn.ghost.small.hh-gear', {
        type: 'button',
        'aria-label': 'Settings',
        title: 'Settings',
        onclick: () => { app.sfx('click'); app.go('settings', { from: 'hub', fromParams: { tab: this.tab } }); },
      }, icon('gear', 2)),
    );
  }

  drawNav(save) {
    const app = this.app;
    const nav = this.nav;
    while (nav.firstChild) nav.removeChild(nav.firstChild);
    const sum = F.hubSummary(save);
    const badges = {
      home: sum.pendingNews,
      roster: sum.skillPoints,
    };
    HUB_TABS.forEach((t, i) => {
      const on = t.id === this.tab;
      const b = h(`button.hub-tab${on ? '.on' : ''}`, {
        type: 'button',
        role: 'tab',
        id: `tab-${t.id}`,
        'data-tab': t.id,
        'aria-selected': on ? 'true' : 'false',
        'aria-controls': 'hub-panel',
        tabindex: on ? '0' : '-1',
        title: `${t.label} (${i + 1})`,
        onclick: () => { if (this.tab !== t.id) { app.sfx('click'); this.setTab(t.id); } },
        onkeydown: (e) => {
          const vertical = getComputedStyle(nav).flexDirection === 'column';
          const fwd = vertical ? 'ArrowDown' : 'ArrowRight';
          const bwd = vertical ? 'ArrowUp' : 'ArrowLeft';
          let j = -1;
          if (e.key === fwd) j = (i + 1) % HUB_TABS.length;
          else if (e.key === bwd) j = (i - 1 + HUB_TABS.length) % HUB_TABS.length;
          else if (e.key === 'Home') j = 0;
          else if (e.key === 'End') j = HUB_TABS.length - 1;
          if (j < 0) return;
          e.preventDefault();
          app.sfx('click');
          this.setTab(HUB_TABS[j].id, true);
        },
      },
      h('span.ht-icon', icon(t.icon, 2)),
      h('span.ht-label', h('span.ht-long', t.label), h('span.ht-short', t.short)),
      badges[t.id] ? h('span.ht-badge', { 'aria-label': `${badges[t.id]} new` }, String(badges[t.id])) : null);
      nav.appendChild(b);
    });
  }
}
