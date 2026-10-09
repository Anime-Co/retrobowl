// Hub › Standings: division tables, conference table, playoff picture.

import { h } from '../dom.js';
import * as F from '../../franchise/index.js';
import { segmented, teamTag } from './common.js';

function table(save, rows, { seeds = null, showRank = false } = {}) {
  return h('table.tbl.stand', h('thead', h('tr',
    showRank ? h('th.num', '#') : null,
    h('th', 'Team'),
    h('th.num', 'W-L'),
    h('th.num.hide-xs', 'PCT'),
    h('th.num', 'DIFF'),
    h('th.num', 'STRK'),
  )), h('tbody', rows.map((r, i) => {
    const t = F.teamById(save, r.teamId);
    const seed = seeds ? seeds.indexOf(r.teamId) + 1 : 0;
    return h(`tr${r.isUser ? '.me' : ''}`, { 'aria-current': r.isUser ? 'true' : null },
      showRank ? h('td.num.dim', String(i + 1)) : null,
      h('td.st-team', teamTag(t), h('span.st-city', t.city), seed ? h('span.chip.seed', { title: `Playoff seed ${seed}` }, `#${seed}`) : null),
      h('td.num', r.record),
      h('td.num.hide-xs', r.pct.toFixed(3).replace(/^0/, '')),
      h(`td.num${r.diff > 0 ? '.good' : r.diff < 0 ? '.bad' : ''}`, r.diff > 0 ? `+${r.diff}` : String(r.diff)),
      h('td.num', r.streakText),
    );
  })));
}

function divisionView(save) {
  const user = F.userTeam(save);
  const divs = F.divisionStandings(save);
  divs.sort((a, b) => (a.conf === user.conf && a.div === user.div ? -1 : b.conf === user.conf && b.div === user.div ? 1 : 0));
  return h('div.stand-grid', divs.map((d) => h('section.panel.stand-panel', h('h3.panel-title', d.name), table(save, d.rows))));
}

function conferenceView(save, state) {
  const conf = state.standConf ?? F.userTeam(save).conf;
  const rows = F.standings(save, { conf });
  const pic = F.playoffPicture(save).conferences[conf];
  const seeds = pic.seeds.map((s) => s.teamId);
  return h('div.stand-conf',
    h('section.panel.stand-panel', h('h3.panel-title', `${F.conferenceName(conf)} Conference`), table(save, rows, { seeds, showRank: true }),
      h('p.dim.small', '#N = playoff seed (top 7 make it; division winners take 1-4).')),
  );
}

function playoffView(save) {
  const pic = F.playoffPicture(save);
  const projected = pic.phase === 'regular';
  return h('div.stand-grid', pic.conferences.map((c) => h('section.panel.stand-panel',
    h('h3.panel-title', `${c.name}${projected ? ' · if the season ended today' : ''}`),
    h('ol.seeds', c.seeds.map((s) => {
      const t = F.teamById(save, s.teamId);
      return h(`li.seed-row${s.isUser ? '.me' : ''}${!s.alive ? '.out' : ''}`,
        h('span.seed-n', String(s.seed)),
        teamTag(t),
        h('span.seed-city', t.city),
        s.divWinner ? h('span.chip.ok', { title: 'Division leader' }, 'DIV') : h('span.chip', { title: 'Wild card' }, 'WC'),
        h('span.seed-rec', s.record),
        !projected && !s.alive ? h('span.chip.warn', 'OUT') : null,
      );
    })),
    projected && c.hunt.length ? h('div.hunt', h('p.label', 'In the hunt'), h('ul', c.hunt.map((x) => {
      const t = F.teamById(save, x.teamId);
      return h(`li${x.teamId === save.userTeamId ? '.me' : ''}`, teamTag(t), h('span.seed-city', t.city), h('span.seed-rec', x.record), h('span.dim', `${x.gamesBack} GB`));
    }))) : null,
  )));
}

export function renderStandings(ctx) {
  const { app, save, state } = ctx;
  const view = state.standView || 'division';
  const controls = h('div.stand-controls',
    segmented({ app, label: 'Standings view', value: view, options: [{ value: 'division', label: 'Division' }, { value: 'conference', label: 'Conference' }, { value: 'playoffs', label: 'Playoffs' }], onChange: (v) => { state.standView = v; ctx.refresh(); } }),
    view === 'conference' ? segmented({ app, label: 'Conference', value: state.standConf ?? F.userTeam(save).conf, options: [0, 1].map((c) => ({ value: c, label: F.conferenceName(c) })), onChange: (v) => { state.standConf = v; ctx.refresh(); } }) : null,
  );
  let body;
  if (view === 'conference') body = conferenceView(save, state);
  else if (view === 'playoffs') body = playoffView(save);
  else body = divisionView(save);
  return h('div.standings', controls, body);
}
