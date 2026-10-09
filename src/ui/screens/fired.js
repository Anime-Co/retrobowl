// Fired: the owner let you go. Take one of the job offers (jobOffers/takeJob) or start over.

import { h, toast } from '../dom.js';
import * as F from '../../franchise/index.js';
import { deleteSave } from '../../core/storage.js';
import { btn, helmet, starRow, confirmDialog, setVars, teamVars } from './common.js';

export class FiredScreen {
  constructor(app) {
    this.app = app;
  }

  mount(root) {
    const app = this.app;
    const save = app.save;
    if (!save) { setTimeout(() => app.go('title'), 0); return; }
    if (!save.fired) { setTimeout(() => app.go('hub'), 0); return; }
    const old = F.teamById(save, save.fired.fromTeam) || F.userTeam(save);
    const c = save.coach;
    const offers = F.jobOffers(save);
    const cards = offers.map((o) => {
      const t = F.teamById(save, o.teamId);
      const card = h('article.offer',
        h('div.offer-top', helmet(t.colors, { scale: 3 }), h('div', h('b.offer-city', o.city), h('span.dim.small', `Last season ${o.record}`))),
        h('div.offer-rate', h('span.label', 'OFF'), starRow(o.off, { scale: 1.5 }), h('span.label', 'DEF'), starRow(o.def, { scale: 1.5 })),
        btn(app, `Take the ${o.abbr} job`, () => this.take(o), { kind: 'primary', block: true, sfx: false, attrs: { 'data-team': o.teamId } }),
      );
      setVars(card, teamVars(t.colors));
      return card;
    });
    this.root = h('div.screen.fired',
      h('div.wrap.fired-wrap.scroll-y',
        h('header.fired-head',
          h('p.label', 'Breaking news'),
          h('h1.title-lg', 'You have been fired'),
          h('p', `${old.city} part ways with Coach ${c.name} after the ${save.fired.year} season.`),
          h('p.dim', `Career: ${c.wins}-${c.losses}${c.ties ? `-${c.ties}` : ''} · ${c.titles} title${c.titles === 1 ? '' : 's'} · ${c.playoffApps} playoff trip${c.playoffApps === 1 ? '' : 's'}`),
        ),
        h('h2.sec-title', 'Job offers'),
        h('p.dim', 'Each club comes with its own roster, facilities and staff, and an owner willing to give you time. Your record and Hall of Fame come with you.'),
        cards.length ? h('div.offers', cards) : h('p', 'Nobody is calling. Time for a fresh start.'),
        h('div.fired-foot', btn(app, 'Start over', () => this.startOver(), { kind: 'danger', sfx: 'click' })),
      ),
    );
    setVars(this.root, teamVars(old.colors));
    root.appendChild(this.root);
  }

  unmount() {}

  take(o) {
    const app = this.app;
    const r = F.takeJob(app.save, o.teamId);
    if (!r.ok) { app.sfx('bad'); toast(r.message); return; }
    app.persist();
    app.sfx('good');
    toast(`Welcome to ${o.city}!`, 2400);
    if (app.save.season.phase === 'offseason') app.go('offseason');
    else app.go('hub', { tab: 'home' });
  }

  async startOver() {
    const app = this.app;
    const ok = await confirmDialog(app, { title: 'Start over?', body: h('p', 'Your career, history and Hall of Fame will be deleted.'), ok: 'Delete & restart', danger: true });
    if (!ok) return;
    deleteSave();
    app.save = null;
    app.go('newGame');
  }
}
