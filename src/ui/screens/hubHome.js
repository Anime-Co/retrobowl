// Hub › Home: next game (PLAY), week advance / offseason entry, press & player messages, alerts and
// recent headlines.

import { h, toast } from '../dom.js';
import * as F from '../../franchise/index.js';
import { btn, helmet, icon, setVars, teamVars, plural, starRow, teamTag } from './common.js';
import { newsCard, headlineList, gameLabel, rosterNeeds } from './widgets.js';

/** Advance the week from the hub (bye / played / eliminated). Routes to the offseason when done. */
export function advanceFromHub(ctx) {
  const { app, save } = ctx;
  let r = F.advanceWeek(save);
  let guard = 0;
  while (r.ok && save.season.phase === 'playoffs' && F.userWeekStatus(save) === 'eliminated' && guard++ < 6) r = F.advanceWeek(save);
  if (!r.ok) {
    app.sfx('bad');
    toast(r.message);
    return;
  }
  app.persist();
  if (save.season.phase === 'offseason') {
    app.sfx('whistle');
    app.go('offseason');
    return;
  }
  app.sfx('select');
  toast(`${save.season.phase === 'playoffs' ? F.ROUND_LABELS[save.season.playoffs.round] : `Week ${save.season.week}`} is up next`);
  ctx.refresh();
}

function sideBlock(save, team, ratings, { flip = false, label }) {
  const el = h(`div.mu-side${flip ? '.opp' : ''}`,
    h('span.mu-helmet', helmet(team.colors, { scale: 3, flip })),
    h('span.mu-abbr', team.abbr),
    h('span.mu-city', team.city),
    h('span.mu-rec', label),
    h('span.mu-rate', h('span.label', 'OFF'), starRow(ratings.off, { scale: 1.5 })),
    h('span.mu-rate', h('span.label', 'DEF'), starRow(ratings.def, { scale: 1.5 })),
  );
  setVars(el, teamVars(team.colors));
  return el;
}

function nextGameCard(ctx) {
  const { app, save } = ctx;
  const game = F.userGameThisWeek(save);
  const team = F.userTeam(save);
  const opp = F.opponentOf(save, game);
  const home = game.home === team.id;
  const mine = F.teamRatings(save);
  const step = F.difficultyStep(save);
  const theirs = { off: Math.round(F.difficultyRating(opp.off, step) * 2) / 2, def: Math.round(F.difficultyRating(opp.def, step) * 2) / 2 };
  const venue = game.neutral ? 'Neutral site' : home ? 'Home' : 'Away';
  const recOf = (t) => (game.playoff ? `Seed #${F.seedOf(save, t.id)} · ${F.recordText(t.record)}` : F.recordText(t.record));
  const play = btn(app, 'Play', () => app.go('match', { gameId: game.id }), { kind: 'primary', icon: 'play', sfx: 'whistle', id: 'btn-play', attrs: { 'aria-label': `Play ${gameLabel(game)} ${home ? 'against' : 'at'} ${opp.city}` } });
  play.classList.add('play-btn');
  const card = h('article.panel.next-game',
    h('div.ngc-top', h('span.ngc-label', gameLabel(game)), h('span.chip', venue)),
    h('div.matchup',
      sideBlock(save, team, mine, { label: recOf(team) }),
      h('div.mu-vs', home || game.neutral ? 'VS' : 'AT'),
      sideBlock(save, opp, theirs, { flip: true, label: recOf(opp) }),
    ),
    play,
    h('p.ngc-foot.dim', `${F.difficultyInfo(save).label} difficulty · ${app.settings.quarterMinutes}-minute quarters`),
  );
  setVars(card, teamVars(team.colors));
  return card;
}

function lastResultText(save) {
  const g = F.userGameThisWeek(save);
  if (!g || !g.played) return '';
  const uHome = g.home === save.userTeamId;
  const us = uHome ? g.homeScore : g.awayScore;
  const them = uHome ? g.awayScore : g.homeScore;
  const opp = F.opponentOf(save, g);
  const r = us > them ? 'W' : us < them ? 'L' : 'T';
  return `${r} ${us}-${them} ${uHome ? 'vs' : 'at'} ${opp.city}${g.ot ? ' (OT)' : ''}`;
}

function statusCard(ctx) {
  const { app, save } = ctx;
  const status = F.userWeekStatus(save);
  if (status === 'game') return nextGameCard(ctx);
  if (status === 'offseason') {
    const step = F.currentOffseasonStep(save);
    return h('article.panel.status-card',
      h('h2.panel-title', `Offseason ${save.season.year}`),
      h('p', step ? `Next up: ${F.OFFSEASON_LABELS[step]}.` : 'Get ready for the new season.'),
      btn(app, 'Continue offseason', () => app.go('offseason'), { kind: 'primary', block: true, icon: 'play', sfx: 'select', id: 'btn-offseason' }),
    );
  }
  if (status === 'eliminated') {
    return h('article.panel.status-card',
      h('h2.panel-title', 'Season over'),
      h('p', 'You are out of the playoffs. Watch the rest of the bracket play out, then head into the offseason.'),
      btn(app, 'Finish the playoffs', () => advanceFromHub(ctx), { kind: 'primary', block: true, sfx: false, id: 'btn-advance' }),
    );
  }
  const title = status === 'bye' ? (save.season.phase === 'playoffs' ? 'First-round bye' : 'Bye week') : `${gameLabel(F.userGameThisWeek(save))} complete`;
  const text = status === 'bye'
    ? (save.season.phase === 'playoffs' ? 'Top seed perks: you rest while the wild-card round is played.' : 'No game for you this week.')
    : lastResultText(save);
  return h('article.panel.status-card',
    h('h2.panel-title', title),
    h('p', text),
    h('p.dim', 'Advance to play out the rest of the week around the league.'),
    btn(app, 'Advance week', () => advanceFromHub(ctx), { kind: 'primary', block: true, icon: 'play', sfx: false, id: 'btn-advance' }),
  );
}

function alerts(ctx) {
  const { save } = ctx;
  const out = [];
  const sp = F.roster(save).reduce((s, p) => s + (p.skillPoints || 0), 0);
  if (sp > 0) out.push(h('button.alert', { type: 'button', onclick: () => { ctx.app.sfx('click'); ctx.go('roster'); } }, icon('up', 2), h('span', `${plural(sp, 'skill point')} to spend`), h('span.alert-go', 'Roster')));
  const hurt = F.roster(save).filter((p) => p.injury);
  if (hurt.length) out.push(h('button.alert.warn', { type: 'button', onclick: () => { ctx.app.sfx('click'); ctx.go('roster'); } }, icon('medic', 2), h('span', `${plural(hurt.length, 'player')} injured`), h('span.alert-go', 'Roster')));
  const needs = rosterNeeds(save);
  if (needs.length && save.season.phase !== 'offseason') out.push(h('button.alert.info', { type: 'button', onclick: () => { ctx.app.sfx('click'); ctx.go('market'); } }, icon('info', 2), h('span', `No star at ${needs.join(', ')}`), h('span.alert-go', 'Agents')));
  return out.length ? h('div.alerts', out) : null;
}

function divisionPanel(ctx) {
  const { app, save } = ctx;
  if (save.season.phase === 'offseason') return null;
  const t = F.userTeam(save);
  const rows = F.standings(save, { conf: t.conf, div: t.div });
  return h('section.panel.home-div',
    h('h2.panel-title', F.divisionName(t.conf, t.div)),
    h('ol.mini-stand', rows.map((r, i) => {
      const team = F.teamById(save, r.teamId);
      return h(`li${r.isUser ? '.me' : ''}`, h('span.ms-rank', String(i + 1)), teamTag(team), h('span.ms-city', team.city), h('b.ms-rec', r.record), h(`span.ms-diff${r.diff > 0 ? '.good' : r.diff < 0 ? '.bad' : '.dim'}`, r.diff > 0 ? `+${r.diff}` : String(r.diff)));
    })),
    btn(app, 'Full standings', () => ctx.go('standings'), { small: true, kind: 'ghost', icon: 'standings' }),
  );
}

function upcomingPanel(ctx) {
  const { save } = ctx;
  if (save.season.phase !== 'regular') return null;
  const uid = save.userTeamId;
  const next = F.userGameThisWeek(save);
  const games = save.season.schedule
    .filter((g) => !g.played && !g.playoff && (g.home === uid || g.away === uid) && (!next || g.id !== next.id))
    .sort((a, b) => a.week - b.week)
    .slice(0, 3);
  if (!games.length) return null;
  return h('section.panel.home-next',
    h('h2.panel-title', 'Coming up'),
    h('ul.mini-sched', games.map((g) => {
      const opp = F.teamById(save, g.home === uid ? g.away : g.home);
      return h('li', h('span.ms-wk', `W${g.week}`), h('span.ms-at', g.home === uid ? 'vs' : '@'), teamTag(opp), h('span.ms-city', opp.city), h('span.ms-rec.dim', F.recordText(opp.record)));
    })),
  );
}

export function renderHome(ctx) {
  const { app, save } = ctx;
  const pending = F.pendingNews(save);
  const news = pending.length
    ? h('section.home-news', { 'aria-label': 'Press room' },
      h('h2.sec-title', 'Press room', h('span.chip.warn', String(pending.length))),
      pending.map((ev) => newsCard(app, save, ev, { onChange: () => { ctx.hub.drawNav(save); ctx.hub.drawHead(save, F.userTeam(save)); } })))
    : null;
  return h('div.home-grid',
    h('div.home-main', statusCard(ctx), alerts(ctx), divisionPanel(ctx), upcomingPanel(ctx)),
    h('div.home-side',
      news,
      h('section.panel.home-feed',
        h('h2.panel-title', 'Headlines'),
        headlineList(save, 10),
      ),
    ),
  );
}
