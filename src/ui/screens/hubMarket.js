// Hub › Free Agents: the pool with stars, age, asking contract, CC fee and a Sign flow that
// explains blockers (roster full, cap room, CC, offseason timing). Reused by the offseason screen.

import { h, toast, render } from '../dom.js';
import * as F from '../../franchise/index.js';
import { btn, starRow, money, segmented, openSheet, plural, ccChip } from './common.js';
import { attrBars, keyAttrs, POS_ORDER } from './widgets.js';

/** Sign sheet: contract length choice, cost summary, confirm. */
export function openSignSheet(app, save, fa, onDone) {
  let years = fa.years;
  openSheet(app, {
    title: `Sign ${fa.name}`,
    className: 'sign-sheet',
    build: (body, api) => {
      const cap = F.capUsage(save);
      const opts = [];
      for (let y = 1; y <= fa.maxYears; y++) opts.push({ value: y, label: `${y} yr${y > 1 ? 's' : ''}` });
      render(body,
        h('div.fa-head', h('span.chip.pos', fa.pos), starRow(fa.stars, { scale: 2 }), h('span.dim', `Age ${fa.age} · potential ${fa.potential}`)),
        fa.traits.length ? h('p.traits', fa.traits.map((t) => h('span.chip', { title: F.TRAITS[t] ? F.TRAITS[t].desc : '' }, F.TRAITS[t] ? F.TRAITS[t].label : t))) : null,
        attrBars(fa.pos, fa.attrs),
        h('p.label', 'Contract length'),
        segmented({ app, label: 'Contract length', value: years, options: opts, onChange: (v) => { years = v; api.rebuild(); } }),
        h('div.sign-sum',
          h('div', h('span.label', 'Salary'), h('b', `${money(fa.salary)} / yr`)),
          h('div', h('span.label', 'Signing fee'), h('b', `${fa.fee} CC`), h('span.dim', ` (you have ${save.cc})`)),
          h('div', h('span.label', 'Cap room after'), h('b', money(cap.room - fa.salary))),
        ),
        // sticky footer: the reason you can't sign stays next to the (disabled) Sign button
        h('div.sheet-foot',
          fa.blocker ? h('p.bad.sheet-block', fa.blocker) : null,
          h('div.btn-row.sheet-actions',
          btn(app, 'Cancel', () => api.close(), { kind: 'ghost', sfx: 'back' }),
          btn(app, `Sign · ${fa.fee} CC`, () => {
            const r = F.signFreeAgent(save, fa.id, years);
            if (!r.ok) { app.sfx('bad'); toast(r.message); return; }
            app.persist();
            app.sfx('coin');
            toast(`${fa.shortName} signs for ${plural(r.player.contract.years, 'year')}!`);
            api.close();
            if (onDone) onDone(r);
          }, { kind: 'primary', disabled: !fa.canSign, sfx: false, id: 'btn-sign-confirm' }),
          ),
        ),
      );
    },
  });
}

/**
 * Free-agent list with position filter.
 * @param {{app:any, save:any, state:Object, refresh:Function}} ctx
 */
export function freeAgentList(ctx) {
  const { app, save, state } = ctx;
  const filter = state.faPos || 'ALL';
  let list = F.freeAgents(save).sort((a, b) => b.stars - a.stars || a.age - b.age);
  const positions = POS_ORDER.filter((p) => list.some((f) => f.pos === p));
  if (filter !== 'ALL') list = list.filter((f) => f.pos === filter);
  const chips = h('div.chips', { role: 'radiogroup', 'aria-label': 'Filter by position' }, ['ALL', ...positions].map((p) => h(`button.chip-btn${p === filter ? '.on' : ''}`, {
    type: 'button',
    role: 'radio',
    'aria-checked': p === filter ? 'true' : 'false',
    'data-fk': `fa:${p}`,
    onclick: () => { app.sfx('click'); state.faPos = p; ctx.refresh(); },
  }, p === 'ALL' ? 'All' : p)));
  const cards = list.map((fa) => h('article.fa-card',
    h('div.fa-main',
      h('span.chip.pos', fa.pos),
      h('div.fa-id',
        h('b.fa-name', fa.shortName),
        h('span.dim.small', `Age ${fa.age} · ${keyAttrs(fa.player)} · pot. ${fa.potential}`),
      ),
      starRow(fa.stars, { scale: 1.5 }),
    ),
    h('div.fa-deal',
      h('span', h('b', money(fa.salary)), h('span.dim', ` × ${fa.years}y`)),
      h('span', h('b', `${fa.fee}`), h('span.dim', ' CC fee')),
      btn(app, 'Sign', () => openSignSheet(app, save, fa, () => ctx.refresh()), { small: true, kind: fa.canSign ? 'good' : '', attrs: { 'data-fk': `sign:${fa.id}`, 'aria-label': `Sign ${fa.name}` } }),
    ),
    fa.blocker ? h('p.fa-block.bad', fa.blocker) : null,
  ));
  return h('div.fa-list-wrap', chips, cards.length ? h('div.fa-list', cards) : h('p.dim', 'Nobody at this position right now.'));
}

function nextRefreshWeek(save) {
  if (save.season.phase !== 'regular') return null;
  const w = save.season.week;
  const n = w + (F.FREE_AGENCY.refreshWeeks - ((w - 1) % F.FREE_AGENCY.refreshWeeks));
  return n <= F.LEAGUE.regularWeeks ? n : null;
}

export function renderMarket(ctx) {
  const { save } = ctx;
  const cap = F.capUsage(save);
  const open = F.ROSTER.cap - F.roster(save).length;
  const nr = nextRefreshWeek(save);
  return h('div.market',
    h('section.panel.market-top',
      h('div.mt-stats',
        h('div', h('span.label', 'Roster spots'), h(`b${open <= 0 ? '.bad' : ''}`, `${open} open`)),
        h('div', h('span.label', 'Cap room'), h(`b${cap.room <= 0 ? '.bad' : ''}`, money(cap.room))),
        h('div', h('span.label', 'Credits'), ccChip(save.cc)),
      ),
      h('p.dim.small', `Signing costs the asking salary plus a CC fee (stars rounded up).${nr ? ` New faces arrive in week ${nr}.` : ''}`),
    ),
    freeAgentList(ctx),
  );
}
