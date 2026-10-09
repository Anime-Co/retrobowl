// Hub › Schedule: the user's 16 weeks with results, plus the playoff bracket once it exists.

import { h } from '../dom.js';
import * as F from '../../franchise/index.js';
import { teamTag } from './common.js';

function resultOf(save, g) {
  const uHome = g.home === save.userTeamId;
  const us = uHome ? g.homeScore : g.awayScore;
  const them = uHome ? g.awayScore : g.homeScore;
  const r = us > them ? 'W' : us < them ? 'L' : 'T';
  return { r, text: `${us}-${them}${g.ot ? ' OT' : ''}` };
}

function scheduleList(ctx) {
  const { save } = ctx;
  const uid = save.userTeamId;
  const games = save.season.schedule.filter((g) => g.home === uid || g.away === uid).sort((a, b) => a.week - b.week);
  const next = F.nextUserGame(save);
  const rows = games.map((g) => {
    const home = g.home === uid;
    const opp = F.teamById(save, home ? g.away : g.home);
    const cur = next && next.id === g.id;
    const res = g.played ? resultOf(save, g) : null;
    return h(`li.sched-row${cur ? '.cur' : ''}${g.playoff ? '.po' : ''}`, { 'aria-current': cur ? 'true' : null },
      h('span.sr-wk', g.playoff ? (F.ROUND_LABELS[g.round] || '').replace('Conference Final', 'Conf.').replace('Gridiron Cup', 'Cup').replace('Divisional', 'Div.').replace('Wild Card', 'WC') : `W${g.week}`),
      h('span.sr-at', g.neutral ? 'vs' : home ? 'vs' : '@'),
      teamTag(opp),
      h('span.sr-city', opp.city),
      h('span.sr-orec.dim', F.recordText(opp.record)),
      res ? h(`span.sr-res.r-${res.r}`, h('b', res.r), ` ${res.text}`) : h('span.sr-res.dim', cur ? 'Next' : '—'),
    );
  });
  return h('ol.sched', rows);
}

function matchupBox(save, g, label) {
  const side = (id, score, won) => {
    const t = F.teamById(save, id);
    const seed = F.seedOf(save, id);
    return h(`div.bk-team${won ? '.won' : ''}${id === save.userTeamId ? '.me' : ''}`,
      h('span.bk-seed', seed ? String(seed) : ''),
      teamTag(t),
      h('span.bk-city', t.city),
      h('span.bk-score', g && g.played ? String(score) : ''),
    );
  };
  if (!g) return h('div.bk-game.tbd', label ? h('span.bk-label', label) : null, h('div.bk-tbd.dim', 'To be decided'));
  const w = F.gameWinner(g);
  return h('div.bk-game', label ? h('span.bk-label', label) : null,
    side(g.away, g.awayScore, w === g.away),
    side(g.home, g.homeScore, w === g.home),
  );
}

function bracket(ctx) {
  const { save } = ctx;
  const pl = save.season.playoffs;
  if (!pl) return null;
  const po = save.season.schedule.filter((g) => g.playoff);
  const confOf = (g) => F.teamById(save, g.home).conf;
  const cols = [];
  const userConf = F.userTeam(save).conf;
  for (const c of [userConf, 1 - userConf]) {
    const rounds = ['wildcard', 'divisional', 'conference'].map((round) => {
      const games = po.filter((g) => g.round === round && confOf(g) === c);
      const expected = round === 'wildcard' ? 3 : round === 'divisional' ? 2 : 1;
      const boxes = games.map((g) => matchupBox(save, g));
      if (!games.length) boxes.push(matchupBox(save, null));
      else for (let i = games.length; i < expected; i++) boxes.push(matchupBox(save, null));
      if (round === 'wildcard') {
        const top = pl.seeds[c][0];
        const t = F.teamById(save, top);
        boxes.unshift(h('div.bk-game.bye', h('div.bk-team', h('span.bk-seed', '1'), teamTag(t), h('span.bk-city', t.city), h('span.bk-score.dim', 'BYE'))));
      }
      return h('div.bk-round', h('h4.bk-rlabel', F.ROUND_LABELS[round]), boxes);
    });
    cols.push(h('section.bk-conf', h('h3.sec-title', F.conferenceName(c)), h('div.bk-rounds', rounds)));
  }
  const final = po.find((g) => g.round === 'final');
  return h('section.bracket',
    h('h2.sec-title', 'Playoff bracket'),
    h('div.bk-confs', cols),
    h('section.bk-final', h('h3.sec-title', F.LEAGUE.cupName), matchupBox(save, final || null, final ? 'Neutral site' : null),
      pl.champion ? h('p.bk-champ', `Champions: ${F.teamById(save, pl.champion).city}`) : null),
  );
}

export function renderSchedule(ctx) {
  const { save } = ctx;
  const t = F.userTeam(save);
  return h('div.schedule',
    bracket(ctx),
    h('section.panel.sched-panel',
      h('h2.panel-title', `${save.season.year} season`, h('span.dim', ` · ${F.recordText(t.record)} · PF ${t.record.pf} PA ${t.record.pa}`)),
      scheduleList(ctx),
    ),
  );
}
