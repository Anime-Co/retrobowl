// Post-game: final score banner, box score (MatchResult.summary), player of the game and the
// franchise PostGameSummary (CC, XP & level-ups, injuries, morale, fans, owner, records, news).
// Params: {gameId, result: MatchResult (summary optional), summary: PostGameSummary, restored?}
// (restored: reopened from save.pendingPostGame after a reload or from the hub's Game recap)
// Continue advances the week (AI games, upkeep) and returns to the hub / offseason.

import { h, toast } from '../dom.js';
import * as F from '../../franchise/index.js';
import { fmtClock } from '../../core/util.js';
import { btn, helmet, setVars, teamVars, screenKeys, signed, plural, ccChip, icon } from './common.js';
import { newsCard, statLine, impact, deltaChip, gameLabel } from './widgets.js';

const QLABEL = (i) => (i < 4 ? `Q${i + 1}` : 'OT');

export class PostGameScreen {
  constructor(app, params = {}) {
    this.app = app;
    this.params = params;
    this.done = false;
  }

  mount(root) {
    const app = this.app;
    const save = app.save;
    const sum = this.params.summary;
    if (!save || !sum) { setTimeout(() => app.go(save ? 'hub' : 'title'), 0); return; }
    const result = this.params.result || {};
    const game = save.season.schedule.find((g) => g.id === sum.gameId) || null;
    const team = F.userTeam(save);
    const opp = F.teamById(save, sum.opponentId);
    const verdict = sum.champion ? 'Champions!' : sum.won ? 'Victory' : sum.lost ? 'Defeat' : 'Tie game';
    const cls = sum.won ? 'win' : sum.lost ? 'loss' : 'tie';

    const banner = h(`header.pg-banner.${cls}`,
      h('p.pg-label', game ? gameLabel(game) : 'Final', ' · FINAL', sum.ot ? ' / OT' : ''),
      h('div.pg-score',
        h('div.pg-side', helmet(team.colors, { scale: 3 }), h('span.pg-abbr', team.abbr), h('b.pg-pts', String(sum.userScore))),
        h('span.pg-dash', '–'),
        h('div.pg-side.opp', h('b.pg-pts', String(sum.oppScore)), h('span.pg-abbr', opp.abbr), helmet(opp.colors, { scale: 3, flip: true })),
      ),
      h('p.pg-verdict', { role: 'status' }, verdict),
      sum.champion ? h('p.pg-cup', `${team.city} win the ${F.LEAGUE.cupName}!`) : sum.eliminated ? h('p.pg-cup.dim', 'Your playoff run ends here.') : null,
    );
    setVars(banner, teamVars(team.colors));

    const left = h('div.pg-col',
      this.potg(save, result, sum),
      this.boxScore(save, result, team, opp),
    );
    const right = h('div.pg-col',
      this.rewards(save, sum),
      this.progressPanel(save, sum),
      this.newsPanel(save, sum),
    );
    this.continueBtn = btn(app, sum.champion || sum.eliminated ? 'To the offseason' : 'Continue', () => this.next(), { kind: 'primary', icon: 'play', id: 'btn-continue', sfx: 'select' });
    this.root = h('div.screen.pg',
      h('div.wrap.pg-wrap',
        banner,
        h('div.pg-body.scroll-y', h('div.pg-grid', left, right)),
        h('footer.pg-foot', h('span.dim.small', `Season ${save.season.year} · ${F.recordText(team.record)}`), this.continueBtn),
      ),
    );
    setVars(this.root, teamVars(team.colors));
    root.appendChild(this.root);
    this.offKeys = screenKeys((e) => {
      if (e.key === 'Enter' && document.activeElement === document.body) { e.preventDefault(); this.continueBtn.click(); }
    });
    if (!this.params.restored) {
      app.sfx(sum.champion ? 'touchdown' : sum.won ? 'good' : sum.lost ? 'bad' : 'whistle');
      app.vibrate(sum.won ? 40 : 20);
    }
  }

  unmount() {
    if (this.offKeys) this.offKeys();
  }

  next() {
    if (this.done) return;
    this.done = true;
    const app = this.app;
    const save = app.save;
    delete save.pendingPostGame;
    const r = F.advanceWeek(save);
    if (!r.ok && r.reason !== 'offseason') toast(r.message);
    app.persist();
    if (save.fired) app.go('fired');
    else if (save.season.phase === 'offseason') app.go('offseason');
    else app.go('hub', { tab: 'home' });
  }

  potg(save, result, sum) {
    const stats = result.stats || {};
    let best = null;
    for (const [id, s] of Object.entries(stats)) {
      const p = F.findPlayer(save, id);
      if (!p) continue;
      const v = impact(s);
      if (!best || v > best.v) best = { p, s, v };
    }
    if (!best && sum.xpGains && sum.xpGains.length) {
      const top = sum.xpGains.slice().sort((a, b) => b.xp - a.xp)[0];
      const p = F.findPlayer(save, top.playerId);
      if (p) best = { p, s: null, v: top.xp };
    }
    if (!best) return null;
    const { p, s } = best;
    return h('section.panel.potg',
      h('h2.panel-title', icon('trophy', 2), ' Player of the game'),
      h('div.potg-row', h('span.chip.pos', p.pos), h('b', `#${p.number} ${F.fullName(p)}`)),
      s ? h('p.potg-line', statLine(p.pos, s)) : h('p.dim', 'Led the team in experience earned.'),
    );
  }

  boxScore(save, result, team, opp) {
    const bs = result.summary;
    if (!bs) {
      return h('section.panel.box', h('h2.panel-title', 'Box score'), h('p.dim', 'This game was simulated: only the final score is known.'));
    }
    const qs = bs.byQuarter.user.length;
    const head = h('tr', h('th', ''), ...Array.from({ length: qs }, (_, i) => h('th.num', QLABEL(i))), h('th.num', 'T'));
    const line = (t, arr, pts) => h('tr', h('td', h('b', t.abbr)), ...arr.map((v) => h('td.num', String(v))), h('td.num', h('b', String(pts))));
    const u = bs.user;
    const o = bs.opp;
    const row = (label, a, b) => h('tr', h('td.num', String(a)), h('td.c.dim', label), h('td.num', String(b)));
    const totals = h('table.tbl.box-tot',
      h('thead', h('tr', h('th.num', team.abbr), h('th.c', ''), h('th.num', opp.abbr))),
      h('tbody',
        row('Total yards', u.totalYds, o.totalYds),
        row('Passing', u.passYds, o.passYds),
        row('Rushing', u.rushYds, o.rushYds),
        row('Turnovers', u.turnovers, o.turnovers),
        row('Possessions', u.possessions, o.possessions),
        row('Time of poss.', fmtClock(u.top), fmtClock(o.top)),
        row('Comp / att', `${u.passCmp}/${u.passAtt}`, '—'),
        row('First downs', u.firstDowns, '—'),
        row('Sacked', u.sacked, '—'),
      ),
    );
    const plays = bs.scoringPlays || [];
    return h('section.panel.box',
      h('h2.panel-title', 'Box score'),
      h('table.tbl.box-q', h('thead', head), h('tbody', line(team, bs.byQuarter.user, u.points), line(opp, bs.byQuarter.opp, o.points))),
      totals,
      h('h3.label.box-sp', 'Scoring plays'),
      plays.length ? h('ol.scoring', plays.map((sp) => h(`li.${sp.team === 'user' ? 'us' : 'them'}`,
        h('span.sp-when.dim', `${QLABEL(sp.quarter - 1)} ${fmtClock(sp.clock)}`),
        h('span.sp-txt', sp.text),
        h('b.sp-score', `${sp.userScore}-${sp.oppScore}`),
      ))) : h('p.dim', 'No points scored.'),
      bs.weather && bs.weather !== 'clear' ? h('p.dim.small', `Weather: ${bs.weather}${bs.windMph ? `, wind ${bs.windMph} mph` : ''}`) : bs.windMph ? h('p.dim.small', `Wind ${bs.windMph} mph`) : null,
    );
  }

  rewards(save, sum) {
    return h('section.panel.rewards',
      h('h2.panel-title', 'Rewards'),
      h('ul.cc-items', sum.ccItems.map((it) => h('li', h('span', it.label), h('b.accent', `+${it.cc} CC`)))),
      h('div.cc-total', h('span', 'Earned'), h('b', `+${sum.ccEarned} CC`), ccChip(save.cc)),
      h('div.deltas',
        deltaChip('Fans', sum.fansDelta),
        deltaChip('Owner', Math.round(sum.jobSecurityDelta * 10) / 10),
        deltaChip('Team morale', sum.teamMoraleDelta),
        sum.difficulty && sum.difficulty.from !== sum.difficulty.to ? h('span.delta', h('span.label', 'Difficulty'), h('b', `${sum.difficulty.from} → ${sum.difficulty.to}`)) : null,
      ),
    );
  }

  progressPanel(save, sum) {
    const gains = (sum.xpGains || []).slice().sort((a, b) => b.levelUps - a.levelUps || b.xp - a.xp);
    const name = (id) => { const p = F.findPlayer(save, id); return p ? F.shortName(p) : 'Former player'; };
    const posOf = (id) => { const p = F.findPlayer(save, id); return p ? p.pos : ''; };
    const morale = (sum.moraleChanges || []).filter((m) => Math.abs(m.delta - sum.teamMoraleDelta) >= 2).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 4);
    const lvl = gains.filter((g) => g.levelUps > 0);
    return h('section.panel.prog',
      h('h2.panel-title', 'Player progress'),
      lvl.length ? h('p.accent', `${plural(lvl.length, 'level-up')}! Spend skill points on the Roster tab.`) : null,
      h('ul.xp-list', gains.map((g) => h('li',
        h('span.chip.pos', posOf(g.playerId)),
        h('span.xl-name', name(g.playerId)),
        h('b.xl-xp', `+${g.xp} XP`),
        g.levelUps ? h('span.chip.ok', g.points ? `LV UP +${g.points}` : 'LV UP') : null,
      ))),
      sum.injuries.length ? h('div.pg-inj', h('h3.label', 'Injuries'), h('ul', sum.injuries.map((i) => h('li.bad', icon('medic', 1.5), ` ${name(i.playerId)}: ${i.type}, ${i.weeks >= 20 ? 'out for the season' : plural(i.weeks, 'week')}`)))) : null,
      morale.length ? h('div.pg-mor', h('h3.label', 'Mood swings'), h('ul', morale.map((m) => h('li', `${name(m.playerId)} `, h(`b.${m.delta > 0 ? 'good' : 'bad'}`, signed(m.delta)))))) : null,
      sum.records.length ? h('div.pg-rec', h('h3.label', 'Records broken'), h('ul', sum.records.map((r) => h('li.accent', icon('trophy', 1.5), ` ${r.name}: ${r.value} ${r.label.toLowerCase()} (${r.scope})`)))) : null,
    );
  }

  newsPanel(save, sum) {
    const evs = (sum.news || []).map((n) => (save.news || []).find((x) => x.id === n.id) || n);
    const heads = sum.headlines || [];
    if (!evs.length && !heads.length) return null;
    return h('section.pg-news',
      evs.length ? h('h2.sec-title', 'Press room') : null,
      evs.map((ev) => newsCard(this.app, save, ev)),
      heads.length ? h('section.panel', h('h2.panel-title', 'Headlines'), h('ul.headlines', heads.map((x) => h('li', h('span.htxt', x.text))))) : null,
    );
  }
}
