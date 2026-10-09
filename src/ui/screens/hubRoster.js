// Hub › Roster: the 12-star roster grouped by position, cap usage, team morale boost.

import { h, toast } from '../dom.js';
import * as F from '../../franchise/index.js';
import { btn, money, progress, plural } from './common.js';
import { playerRow, POS_GROUPS, rosterRoles, rosterNeeds } from './widgets.js';

export function capPanel(save) {
  const cap = F.capUsage(save);
  const frac = cap.used / cap.cap;
  return h('div.cap',
    h('div.cap-top', h('span.label', 'Salary cap'), h('span', h('b', money(cap.used)), h('span.dim', ` / ${money(cap.cap)}`))),
    progress(frac, frac > 0.95 ? 'var(--bad)' : frac > 0.8 ? 'var(--accent)' : 'var(--good)'),
    h('div.cap-foot.dim', `Room ${money(cap.room)}${cap.deadMoney ? ` · dead money ${money(cap.deadMoney)}` : ''}`),
  );
}

export function renderRoster(ctx) {
  const { app, save } = ctx;
  const roster = F.roster(save);
  const roles = rosterRoles(save);
  const needs = rosterNeeds(save);
  const avgMorale = roster.length ? roster.reduce((s, p) => s + p.morale, 0) / roster.length : 0;
  const mood = F.moraleLabel(avgMorale);
  const sp = roster.reduce((s, p) => s + (p.skillPoints || 0), 0);

  const top = h('section.panel.roster-top',
    h('div.rt-count', h('span.label', 'Stars'), h('b.rt-num', `${roster.length}/${F.ROSTER.cap}`), h('span.dim', `${F.ROSTER.cap - roster.length} open`)),
    capPanel(save),
    h('div.rt-morale',
      h('span.label', 'Team mood'),
      h('b', mood.label),
      btn(app, `Team talk · ${F.MORALE.teamBoostCost} CC`, () => {
        const r = F.boostTeamMorale(save);
        if (!r.ok) { app.sfx('bad'); toast(r.message); return; }
        app.persist();
        app.sfx('coin');
        toast(`Everyone's morale +${F.MORALE.teamBoostAmount}`);
        ctx.refresh();
      }, { small: true, disabled: save.cc < F.MORALE.teamBoostCost, sfx: false, title: `Lift every player's morale by ${F.MORALE.teamBoostAmount}` }),
    ),
  );

  const groups = [];
  for (const g of POS_GROUPS) {
    const sec = h('section.roster-group', h('h2.sec-title', g.label));
    for (const pos of g.positions) {
      const players = roster.filter((p) => p.pos === pos)
        .sort((a, b) => (roles[a.id] === 'starter' ? 0 : 1) - (roles[b.id] === 'starter' ? 0 : 1) || F.stars(b) - F.stars(a));
      const slots = F.SLOT_COUNTS[pos];
      const starters = players.filter((p) => roles[p.id] === 'starter').length;
      sec.appendChild(h('h3.pos-head', h('span', F.POS_LABELS[pos]), h('span.dim', `${starters}/${slots} starters${starters < slots ? ` · ${plural(slots - starters, 'filler')}` : ''}`)));
      if (!players.length) {
        sec.appendChild(h('div.prow.empty', h('span.dim', 'No star here. A generic filler (about 1 star) plays.')));
        continue;
      }
      sec.appendChild(h('div.plist', players.map((p) => playerRow(app, save, p, { role: roles[p.id], onOpen: () => ctx.openPlayer(p.id) }))));
    }
    groups.push(sec);
  }

  return h('div.roster',
    top,
    sp > 0 ? h('p.roster-tip.accent', `Tap a player with a +N badge to spend ${plural(sp, 'skill point')}.`) : null,
    needs.length ? h('p.roster-tip.dim', `Fillers start at: ${needs.map((p) => F.POS_LABELS[p]).join(', ')}.`) : null,
    h('div.roster-groups', groups),
  );
}
