// Hub › Team: ratings, facilities (upgrade), coordinators, coach career, history, record book and
// Hall of Fame.

import { h, toast } from '../dom.js';
import * as F from '../../franchise/index.js';
import { btn, starRow, segmented, icon, plural } from './common.js';

function ratingsPanel(save) {
  const r = F.teamRatings(save);
  const row = (label, total, base, boost, coachLabel) => h('div.rating-row',
    h('span.label', label),
    starRow(total, { scale: 2 }),
    h('span.dim.small', `${base.toFixed(1)} squad${boost ? ` + ${boost.toFixed(1)} ${coachLabel}` : ''}`),
  );
  return h('section.panel.team-ratings',
    h('h2.panel-title', 'Team ratings'),
    row('Offense', r.off, r.offBase, r.ocBoost, 'OC'),
    row('Defense', r.def, r.defBase, r.dcBoost, 'DC'),
    h('p.dim.small', `The owner expects about ${save.season.expectedWins} wins this season.`),
  );
}

function facilitiesPanel(ctx) {
  const { app, save } = ctx;
  return h('section.panel.facilities',
    h('h2.panel-title', 'Facilities'),
    h('div.fac-list', F.facilitySummary(save).map((f) => {
      const pips = [];
      for (let i = 1; i <= f.max; i++) pips.push(h(`i${i <= f.level ? '.on' : ''}`));
      const can = f.upgradeCost != null && save.cc >= f.upgradeCost;
      return h('div.fac',
        h('div.fac-top', h('b.fac-name', f.label), h('span.pips', { role: 'img', 'aria-label': `Level ${f.level} of ${f.max}` }, pips), h('span.fac-lvl', `LV ${f.level}`)),
        h('p.fac-desc.dim', f.desc),
        h('div.fac-bottom',
          h('p.fac-eff', f.effect),
          f.upgradeCost == null
            ? h('span.chip.ok', 'Max level')
            : btn(app, `Upgrade · ${f.upgradeCost} CC`, () => {
              const r = F.upgradeFacility(save, f.kind);
              if (!r.ok) { app.sfx('bad'); toast(r.message); return; }
              app.persist();
              app.sfx('coin');
              toast(`${f.label} upgraded to level ${r.level}`);
              ctx.refresh();
            }, { small: true, kind: can ? 'good' : '', disabled: !can, sfx: false, title: can ? null : `Need ${f.upgradeCost} CC`, attrs: { 'data-fk': `fac:${f.kind}` } }),
        ),
      );
    })),
    h('p.dim.small', `Facilities above level 1 may slip a level each offseason unless you pay ${F.FACILITIES.maintainCost} CC to maintain them.`),
  );
}

function staffPanel(save) {
  const row = (role, label) => {
    const c = save.staff[role];
    return h('div.staff-row',
      h('span.label', label),
      c ? h('span.staff-name', c.name) : h('span.dim', 'Vacant'),
      c ? starRow(c.stars, { scale: 1.5 }) : null,
      c ? h('span.dim.small', `${plural(c.years, 'season')} left · +${(c.stars * F.COORDINATORS.boostPerStar).toFixed(1)} ${role === 'oc' ? 'OFF' : 'DEF'}`) : null,
    );
  };
  return h('section.panel.staff',
    h('h2.panel-title', 'Coordinators'),
    row('oc', 'Offense (OC)'),
    row('dc', 'Defense (DC)'),
    h('p.dim.small', 'Coordinators lift team ratings and speed up XP on their side of the ball. New candidates come up every offseason.'),
  );
}

function coachPanel(ctx) {
  const { app, save } = ctx;
  const c = save.coach;
  const d = F.difficultyInfo(save);
  const stat = (label, v) => h('div.cstat', h('b', String(v)), h('span.label', label));
  return h('section.panel.coach',
    h('h2.panel-title', `Coach ${c.name}`),
    h('div.cstats',
      stat('Record', `${c.wins}-${c.losses}${c.ties ? `-${c.ties}` : ''}`),
      stat('Titles', c.titles),
      stat('Playoffs', c.playoffApps),
      stat('Seasons', c.seasons),
    ),
    h('div.coach-diff', h('span', `Difficulty: ${d.label}`), btn(app, 'Change', () => app.go('settings', { from: 'hub', fromParams: { tab: 'team' } }), { small: true, kind: 'ghost', icon: 'gear' })),
  );
}

function historyPanel(save) {
  const rows = F.careerHistory(save);
  return h('section.panel.history',
    h('h2.panel-title', 'History'),
    rows.length
      ? h('table.tbl', h('thead', h('tr', h('th', 'Year'), h('th', 'Team'), h('th.num', 'W-L'), h('th', 'Finish'))),
        h('tbody', rows.map((r) => h(`tr${r.result === 'champion' ? '.me' : ''}`,
          h('td', String(r.year)),
          h('td', r.abbr),
          h('td.num', `${r.w}-${r.l}${r.t ? `-${r.t}` : ''}`),
          h('td.wrap', r.resultLabel),
        ))))
      : h('p.dim', 'Your first season is under way.'),
  );
}

function recordsPanel(ctx) {
  const { app, save, state } = ctx;
  const scope = state.recScope || 'season';
  const rec = save.records;
  if (!rec) return null;
  const rows = Object.entries(F.RECORDS.stats).map(([k, label]) => {
    const r = rec[scope][k];
    return h(`tr${r.playerId ? '.me' : ''}`, h('td.wrap', label), h('td.num', String(r.value)), h('td.wrap', r.name), h('td.num.dim.hide-xs', String(r.year)));
  });
  if (scope === 'game' && rec.longestFg) rows.push(h(`tr${rec.longestFg.playerId ? '.me' : ''}`, h('td.wrap', 'Longest FG'), h('td.num', `${rec.longestFg.value}`), h('td.wrap', rec.longestFg.name), h('td.num.dim.hide-xs', String(rec.longestFg.year))));
  return h('section.panel.records',
    h('h2.panel-title', 'Record book'),
    segmented({ app, label: 'Record scope', value: scope, options: [{ value: 'game', label: 'Game' }, { value: 'season', label: 'Season' }, { value: 'career', label: 'Career' }], onChange: (v) => { state.recScope = v; ctx.refresh(); } }),
    h('table.tbl.rec-tbl', h('tbody', rows)),
    h('p.dim.small', 'Highlighted rows were set by your players.'),
  );
}

function hofPanel(save) {
  const hof = save.hallOfFame || [];
  return h('section.panel.hof',
    h('h2.panel-title', icon('trophy', 2), ' Hall of Fame'),
    hof.length
      ? h('ul.hof-list', hof.slice().reverse().map((p) => h('li', h('span.chip.pos', p.pos), h('b', p.name), h('span.dim', ` ${p.inducted} · ${plural(p.seasons, 'season')} · peak `), starRow(p.peakStars, { scale: 1 }), p.titles ? h('span.accent', ` · ${plural(p.titles, 'title')}`) : null)))
      : h('p.dim', 'No inductees yet. Long careers, awards and titles earn a spot when a star retires.'),
  );
}

export function renderTeam(ctx) {
  const { save } = ctx;
  return h('div.team-tab',
    h('div.team-col', ratingsPanel(save), facilitiesPanel(ctx), staffPanel(save)),
    h('div.team-col', coachPanel(ctx), historyPanel(save), recordsPanel(ctx), hofPanel(save)),
  );
}
