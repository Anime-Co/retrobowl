// Player card (sheet): portrait, stars, attributes with skill points, XP, morale (+boost),
// condition, injury (+rush treatment), contract (extend / release) and season & career stats.

import { h, toast } from '../dom.js';
import * as F from '../../franchise/index.js';
import { drawPlayer } from '../../render/sprites.js';
import { userTeam } from '../../franchise/state.js';
import { openSheet, starRow, segBar, btn, money, plural, confirmDialog, segmented, progress, icon } from './common.js';
import { STAT_ROWS, xpBlock, playerFace } from './widgets.js';

/** Dead money a release would leave on this season's cap. */
export function releaseDeadMoney(save, p) {
  return F.releaseCost(save, p.id);
}

function hashId(id) {
  let x = 0;
  for (const c of String(id)) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return x;
}

/** Small animated sprite portrait in team colours. Returns {el, stop}. */
function portrait(save, p) {
  const t = userTeam(save);
  const look = { abbr: t.abbr, city: t.city, primary: t.colors.primary, secondary: t.colors.secondary, helmet: t.colors.helmet };
  const c = document.createElement('canvas');
  c.width = 26;
  c.height = 32;
  c.className = 'pc-portrait-canvas';
  c.setAttribute('aria-hidden', 'true');
  const g = c.getContext('2d');
  const skin = hashId(p.id) % 5;
  let frame = 0;
  const draw = () => {
    g.clearRect(0, 0, c.width, c.height);
    drawPlayer(g, 13, 29, look, { facing: 'down', anim: 'idle', frame, skin });
  };
  draw();
  const timer = setInterval(() => { frame = (frame + 1) % 2; draw(); }, 600);
  return { el: c, stop: () => clearInterval(timer) };
}

function statsTable(p) {
  const rows = STAT_ROWS[p.pos] || STAT_ROWS.OL;
  return h('table.tbl.pc-stats', h('thead', h('tr', h('th', 'Stat'), h('th.num', 'Season'), h('th.num', 'Career'))),
    h('tbody', rows.map(([label, k]) => h('tr', h('td', label), h('td.num', String(p.season[k] || 0)), h('td.num', String(p.career[k] || 0))))));
}

/**
 * Open the player card for a rostered player.
 * @param {{onChange?:Function}} [o]
 */
export function openPlayerCard(app, save, playerId, o = {}) {
  let pic = null;
  let mode = 'main'; // 'main' | 'extend'
  let extendYears = 1;
  const changed = () => { app.persist(); if (o.onChange) o.onChange(); };

  const sheet = openSheet(app, {
    title: '',
    className: 'player-card',
    onClose: () => { if (pic) pic.stop(); },
    build: (body, api) => {
      if (pic) { pic.stop(); pic = null; }
      const p = F.findPlayer(save, playerId);
      if (!p) { api.close(); return; }
      api.setTitle(F.fullName(p));
      pic = portrait(save, p);
      const s = F.stars(p);
      const mood = F.moraleLabel(p.morale);
      const cond = Math.round(p.condition);
      const atPotential = F.attrSum(p) >= p.potential;

      // Header
      body.appendChild(h('div.pc-head',
        h('div.pc-portrait', pic.el, h('span.pc-num', `#${p.number}`)),
        h('div.pc-id',
          h('p.pc-pos', h('span.chip.pos', p.pos), ` ${F.POS_LABELS[p.pos]}`),
          starRow(s, { scale: 2.5 }),
          h('p.pc-meta', `Age ${p.age} · Level ${p.level} · Potential ${F.potentialLabel(p)}`),
          F.traitLabels(p).length ? h('p.traits', p.traits.map((t) => h('span.chip', { title: F.TRAITS[t] ? F.TRAITS[t].desc : '' }, F.TRAITS[t] ? F.TRAITS[t].label : t))) : null,
          p.rookie ? h('span.chip.ok', 'Rookie') : null,
        ),
      ));

      // Attributes + skill points
      const sp = p.skillPoints || 0;
      body.appendChild(h('section.pc-sec',
        h('h3.pc-sec-t', 'Attributes', sp > 0 ? h('span.sp-badge', `${plural(sp, 'point')} to spend`) : null),
        h('div.attrs', F.ATTRS[p.pos].map((k) => {
          const v = p.attrs[k];
          const can = sp > 0 && v < F.ATTR.max && !atPotential;
          return h('div.attr',
            h('span.attr-name', F.ATTR_LABELS[k]),
            segBar(v),
            h('span.attr-val', String(v)),
            sp > 0 ? h('button.btn.small.good.attr-plus', {
              type: 'button',
              disabled: !can,
              'aria-label': `Add a point to ${F.ATTR_LABELS[k]}`,
              'data-attr': k,
              'data-fk': `attr:${k}`,
              onclick: () => {
                const r = F.applySkillPoint(save, p.id, k);
                if (!r.ok) { app.sfx('bad'); toast(r.message); return; }
                app.sfx('good');
                changed();
                if (r.stars > s) toast(`${F.shortName(p)} is now ${r.stars}★!`);
                api.rebuild();
              },
            }, icon('plus', 1.5)) : null,
          );
        })),
        sp > 0 && atPotential ? h('p.dim.small', 'He has reached his potential: extra points can no longer be spent.') : null,
        xpBlock(p),
      ));

      // Status: morale, condition, injury
      const rushCheck = p.injury ? F.canRushTreatment(save, p.id) : null;
      const rushUsed = !!rushCheck && rushCheck.reason === 'used';
      body.appendChild(h('section.pc-sec.pc-status',
        h('div.pc-line',
          playerFace(p, 2.5),
          h('div.pc-line-main', h('span.label', 'Morale'), h('b', mood.label), progress(p.morale / 100, `var(--m${mood.level})`)),
          btn(app, `Boost · ${F.MORALE.boostCost} CC`, () => {
            const r = F.boostMorale(save, p.id);
            if (!r.ok) { app.sfx('bad'); toast(r.message); return; }
            app.sfx('coin');
            changed();
            api.rebuild();
          }, { small: true, sfx: false, disabled: p.morale >= 100 || save.cc < F.MORALE.boostCost, title: `+${F.MORALE.boostAmount} morale`, attrs: { 'data-fk': 'pc-boost' } }),
        ),
        h('div.pc-line',
          icon('fans', 2),
          h('div.pc-line-main', h('span.label', 'Condition'), h('b', `${cond}% · ${F.conditionLabel(cond)}`), progress(cond / 100, cond < 60 ? 'var(--bad)' : 'var(--good)')),
        ),
        p.injury ? h('div.pc-line.pc-injury',
          icon('medic', 2),
          h('div.pc-line-main', h('span.label', 'Injury'), h('b.bad', F.injuryText(p))),
          btn(app, `Rush · ${F.INJURY.rushCost} CC`, () => {
            const r = F.rushTreatment(save, p.id);
            if (!r.ok) { app.sfx('bad'); toast(r.message); return; }
            app.sfx('coin');
            toast(r.weeks ? `Back in ${plural(r.weeks, 'week')}` : `${F.shortName(p)} is cleared to play!`);
            changed();
            api.rebuild();
          }, { small: true, sfx: false, disabled: !rushCheck || !rushCheck.ok, title: rushCheck && !rushCheck.ok ? rushCheck.message : '-1 week', attrs: { 'data-fk': 'pc-rush' } }),
        ) : null,
        // Touch screens have no hover titles: say why rush treatment is unavailable.
        p.injury && rushCheck && !rushCheck.ok ? h('p.dim.small.pc-note', rushCheck.message) : null,
      ));

      // Contract
      body.appendChild(mode === 'extend' ? extendSection(app, save, p, api) : contractSection(app, save, p, api));

      // Stats
      body.appendChild(h('section.pc-sec', h('h3.pc-sec-t', 'Stats'), statsTable(p),
        p.awards && p.awards.length ? h('p.small.accent', p.awards.map((a) => `${a.year} ${a.award}`).join(' · ')) : null));
    },
  });

  function contractSection(appRef, saveRef, p, api) {
    const ext = F.canExtend(p);
    return h('section.pc-sec.pc-contract',
      h('h3.pc-sec-t', 'Contract'),
      h('p', h('b', `${money(p.contract.salary)} / yr`), h('span.dim', ` · ${plural(p.contract.years, 'year')} left`)),
      h('div.btn-row',
        btn(appRef, 'Extend', () => {
          const d = F.contractDemand(saveRef, p);
          extendYears = Math.max(1, Math.min(d.years, d.maxYears - p.contract.years));
          mode = 'extend';
          api.rebuild();
        }, { small: true, disabled: !ext, title: ext ? null : 'Players talk extensions in the last two years of a deal', attrs: { 'data-fk': 'pc-extend' } }),
        btn(appRef, 'Release', async () => {
          const dead = releaseDeadMoney(saveRef, p);
          const ok = await confirmDialog(appRef, {
            title: `Release ${F.shortName(p)}?`,
            body: h('div', h('p', `He leaves the club for good and frees a roster spot.`), h('p', dead ? `Dead money: ${money(dead)} stays on this season's cap.` : 'No dead money this season.'), h('p.dim', 'The rest of the squad will be a little unsettled.')),
            ok: 'Release',
            danger: true,
          });
          if (!ok) return;
          const r = F.releasePlayer(saveRef, p.id);
          if (!r.ok) { appRef.sfx('bad'); toast(r.message); return; }
          appRef.sfx('bad');
          toast(`${F.shortName(p)} released`);
          changed();
          api.close();
        }, { small: true, kind: 'danger', sfx: 'click' }),
      ),
      !ext ? h('p.dim.small', `Extensions open with two years or less left on the deal.`) : null,
    );
  }

  function extendSection(appRef, saveRef, p, api) {
    const d = F.contractDemand(saveRef, p);
    const room = d.maxYears - p.contract.years;
    const raise = Math.max(0, Math.max(d.salary, p.contract.salary) - p.contract.salary);
    const capRoom = F.capUsage(saveRef).room;
    let problem = null;
    if (!d.willing) problem = 'He is too unhappy to talk. Lift his morale first.';
    else if (room <= 0) problem = 'He will not sign for any longer at his age.';
    else if (raise > capRoom) problem = `The raise (${money(raise)}) does not fit under the cap.`;
    const opts = [];
    for (let y = 1; y <= Math.max(1, room); y++) opts.push({ value: y, label: `+${y}` });
    return h('section.pc-sec.pc-contract',
      h('h3.pc-sec-t', 'Extension talks'),
      h('p', 'He asks for ', h('b', `${money(Math.max(d.salary, p.contract.salary))} / yr`), h('span.dim', ` (now ${money(p.contract.salary)})`)),
      room > 0 && d.willing ? h('div', h('p.label', 'Extra years'), segmented({ app: appRef, label: 'Extra years', value: Math.min(extendYears, room), options: opts, onChange: (v) => { extendYears = v; api.rebuild(); } })) : null,
      problem ? h('p.bad', problem) : h('p.dim.small', `New deal runs ${plural(p.contract.years + Math.min(extendYears, room), 'year')} in total.`),
      h('div.btn-row',
        btn(appRef, 'Back', () => { mode = 'main'; api.rebuild(); }, { small: true, kind: 'ghost', sfx: 'back' }),
        btn(appRef, 'Sign extension', () => {
          const r = F.extendContract(saveRef, p.id, Math.min(extendYears, room));
          if (!r.ok) { appRef.sfx('bad'); toast(r.message); return; }
          appRef.sfx('good');
          toast(`${F.shortName(p)} signs on: ${plural(r.contract.years, 'year')} left`);
          mode = 'main';
          changed();
          api.rebuild();
        }, { small: true, kind: 'primary', sfx: false, disabled: !!problem, id: 'btn-extend-confirm' }),
      ),
    );
  }

  return sheet;
}
