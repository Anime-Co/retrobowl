// Offseason flow (MECHANICS §7.8): one screen per step of offseasonSteps()/runOffseasonStep():
// season review & awards → retirements → expiring contracts → development → facilities →
// coordinators → draft → free agency → new season. Steps that produce results (contracts,
// development, facilities, staff, draft) show them before moving on.
// Params: {step?} (informational; the current step always comes from the save)

import { h, toast } from '../dom.js';
import * as F from '../../franchise/index.js';
import { btn, icon, starRow, money, plural, segmented, toggle, confirmDialog, setVars, teamVars, ccChip, signed, helmet, screenKeys, keepFocus } from './common.js';
import { freeAgentList } from './hubMarket.js';
import { capPanel } from './hubRoster.js';
import { attrBars, POS_ORDER, rosterNeeds, playerFace, ATTR_SHORT } from './widgets.js';

export class OffseasonScreen {
  constructor(app, params = {}) {
    this.app = app;
    this.params = params;
    this.result = null; // {step, result} after running a step that has something to show
    this.choice = {}; // per-step UI choices
    this.state = {};
  }

  mount(root) {
    const app = this.app;
    const save = app.save;
    if (!save) { setTimeout(() => app.go('title'), 0); return; }
    if (save.fired) { setTimeout(() => app.go('fired'), 0); return; }
    if (save.season.phase !== 'offseason' || !save.offseason) { setTimeout(() => app.go('hub'), 0); return; }
    this.root = h('div.screen.off');
    setVars(this.root, teamVars(F.userTeam(save).colors));
    root.appendChild(this.root);
    this.draw();
    // Enter with nothing focused presses the step's primary button.
    this.offKeys = screenKeys((e) => {
      const ae = document.activeElement;
      if (e.key !== 'Enter' || (ae && ae !== document.body)) return;
      const b = this.root && this.root.querySelector('#off-primary');
      if (b && !b.disabled) { e.preventDefault(); b.click(); }
    });
  }

  unmount() {
    if (this.offKeys) this.offKeys();
  }

  get save() { return this.app.save; }

  run(step, choice) {
    const app = this.app;
    const save = this.save;
    const r = F.runOffseasonStep(save, step, choice);
    if (!r.ok) {
      app.sfx('bad');
      toast(r.message);
      if (r.reason === 'fired') app.go('fired');
      return null;
    }
    app.persist();
    return r;
  }

  draw(keepScroll = false) {
    const save = this.save;
    const root = this.root;
    const prevBody = root.querySelector('.off-body');
    const st = keepScroll && prevBody ? prevBody.scrollTop : 0;
    const refocus = keepScroll ? keepFocus(root) : null;
    while (root.firstChild) root.removeChild(root.firstChild);
    const steps = F.offseasonSteps(save);
    const cur = F.currentOffseasonStep(save);
    const showing = this.result ? this.result.step : cur;
    const view = this.result ? this.resultView() : this.stepView(cur);
    const team = F.userTeam(save);
    root.appendChild(h('div.wrap.off-wrap',
      h('header.off-head',
        h('div.off-title',
          helmet(team.colors, { scale: 2 }),
          h('div', h('h1.off-h1', `Offseason ${save.offseason.year}`), h('p.off-step', F.OFFSEASON_LABELS[showing] || '')),
          h('div.off-tools',
            ccChip(save.cc),
            h('button.btn.ghost.small', { type: 'button', title: 'Roster', 'aria-label': 'Open roster', onclick: () => { this.app.sfx('click'); this.app.go('hub', { tab: 'roster' }); } }, icon('roster', 2)),
            h('button.btn.ghost.small', { type: 'button', title: 'Settings', 'aria-label': 'Settings', onclick: () => { this.app.sfx('click'); this.app.go('settings', { from: 'offseason' }); } }, icon('gear', 2)),
          ),
        ),
        h('ol.off-steps', { 'aria-label': 'Offseason steps' }, steps.map((s, i) => h(`li${s.id === showing ? '.on' : s.done ? '.done' : ''}`, { title: s.label, 'aria-current': s.id === showing ? 'step' : null }, h('b', String(i + 1)), h('span', s.label)))),
      ),
      h('div.off-body.scroll-y', { tabindex: '-1' }, view.body),
      h('footer.off-foot', view.secondary || h('span'), view.primary),
    ));
    const body = root.querySelector('.off-body');
    if (body) body.scrollTop = st;
    if (refocus) refocus(body);
  }

  next() {
    this.result = null;
    this.draw();
  }

  primary(label, onClick, o = {}) {
    return btn(this.app, label, onClick, { kind: 'primary', icon: 'play', id: 'off-primary', sfx: o.sfx ?? 'select', disabled: o.disabled });
  }

  // ------------------------------------------------------------------------------- steps

  stepView(step) {
    switch (step) {
      case 'summary': return this.summaryStep();
      case 'retirements': return this.retirementsStep();
      case 'contracts': return this.contractsStep();
      case 'progression': return this.progressionStep();
      case 'facilities': return this.facilitiesStep();
      case 'staff': return this.staffStep();
      case 'draft': return this.draftStep();
      case 'freeAgency': return this.freeAgencyStep();
      case 'newSeason': return this.newSeasonStep();
      default: return { body: h('p', 'Unknown step.'), primary: this.primary('Back to hub', () => this.app.go('hub')) };
    }
  }

  summaryStep() {
    const save = this.save;
    const d = F.offseasonData(save, 'summary') || {};
    const champ = d.champion ? F.teamById(save, d.champion) : null;
    const body = h('div.off-grid',
      h('section.panel.review',
        h('h2.panel-title', `${d.year} season review`),
        h('p.review-result', d.resultLabel || ''),
        h('div.review-stats',
          h('div', h('b', `${d.w}-${d.l}${d.t ? `-${d.t}` : ''}`), h('span.label', 'Record')),
          h('div', h('b', d.seed ? `#${d.seed}` : '—'), h('span.label', 'Seed')),
          h('div', h('b', String(d.pf)), h('span.label', 'Points for')),
          h('div', h('b', String(d.pa)), h('span.label', 'Points against')),
        ),
        champ ? h('p', icon('trophy', 2), ` ${champ.city} won the ${F.LEAGUE.cupName}.`) : null,
        h('p.dim.small', `Expected wins: ${d.expectedWins}`),
      ),
      h('section.panel.awards',
        h('h2.panel-title', 'Awards'),
        d.awards && d.awards.length
          ? h('ul.award-list', d.awards.map((a) => h('li', h('span.award-name', a.award), h('b', a.name), a.pos ? h('span.chip.pos', a.pos) : null, a.detail ? h('span.dim', ` ${a.detail}`) : null)))
          : h('p.dim', 'No awards this year.'),
      ),
      h(`section.panel.owner${d.atRisk ? '.risk' : ''}`,
        h('h2.panel-title', 'The owner'),
        h('p', `Confidence ${Math.round(d.jobSecurity)}/100 `, h(`b.${d.jobSecurityDelta >= 0 ? 'good' : 'bad'}`, `(${signed(Math.round(d.jobSecurityDelta))})`)),
        h('p.dim', d.atRisk ? 'The owner has seen enough. Your job is on the line.' : d.jobSecurity < 35 ? 'The owner expects a better showing next year.' : 'The front office is happy with the direction.'),
      ),
    );
    return {
      body,
      primary: this.primary('Continue', () => {
        const r = this.run('summary');
        if (!r) return;
        if (r.result.fired) { this.app.sfx('bad'); this.app.go('fired'); return; }
        this.next();
      }),
    };
  }

  retirementsStep() {
    const list = F.offseasonData(this.save, 'retirements') || [];
    const body = h('section.panel',
      h('h2.panel-title', 'Retirements'),
      list.length
        ? h('ul.ret-list', list.map((r) => h('li', h('span.chip.pos', r.pos), h('b', r.name), h('span.dim', ` age ${r.age} · ${plural(r.seasons, 'season')} with you `), starRow(r.stars, { scale: 1.5 }), r.hallOfFame ? h('span.chip.ok', 'Hall of Fame') : null)))
        : h('p', 'Nobody is hanging up the cleats this year.'),
      list.length ? h('p.dim.small', 'Retiring players leave the roster. Big careers go into your Hall of Fame.') : null,
    );
    return {
      body,
      primary: this.primary(list.length ? 'Say goodbye' : 'Continue', () => {
        const r = this.run('retirements');
        if (!r) return;
        const hof = r.result.retired.filter((x) => x.hallOfFame);
        if (hof.length) toast(`${hof.map((x) => x.name).join(', ')} enter${hof.length === 1 ? 's' : ''} the Hall of Fame!`, 2600);
        this.next();
      }),
    };
  }

  contractsStep() {
    const app = this.app;
    const save = this.save;
    const roster = F.roster(save);
    const expiring = roster.filter((p) => p.contract.years <= 1);
    const ch = this.choice.contracts || (this.choice.contracts = {});
    for (const p of expiring) {
      if (!ch[p.id]) {
        const d = F.contractDemand(save, p);
        ch[p.id] = { on: d.willing && F.stars(p) >= 1.5, years: d.years };
      }
    }
    const keepIds = new Set(expiring.map((p) => p.id));
    const base = roster.filter((p) => !keepIds.has(p.id)).reduce((s, p) => s + p.contract.salary, 0) + (save.deadMoney || 0);
    let used = base;
    const rows = expiring.map((p) => {
      const d = F.contractDemand(save, p);
      const c = ch[p.id];
      if (!d.willing) c.on = false;
      c.years = Math.max(1, Math.min(c.years, d.maxYears));
      if (c.on) used += d.salary;
      const over = c.on && used > save.salaryCap;
      const opts = [];
      for (let y = 1; y <= d.maxYears; y++) opts.push({ value: y, label: `${y}y` });
      return h(`article.ctr${c.on ? '.on' : ''}`,
        h('div.ctr-top',
          h('span.chip.pos', p.pos),
          h('div.ctr-id', h('b', F.shortName(p)), h('span.dim.small', `Age ${p.age} · now ${money(p.contract.salary)}`)),
          starRow(F.stars(p), { scale: 1.5 }),
          playerFace(p, 1.5),
        ),
        d.willing
          ? h('div.ctr-deal',
            h('span', 'Asks ', h('b', `${money(d.salary)}/yr`)),
            c.on ? segmented({ app, label: `Years for ${F.shortName(p)}`, value: c.years, options: opts, onChange: (v) => { c.years = v; this.draw(true); } }) : null,
            toggle({ app, checked: c.on, label: `Re-sign ${F.shortName(p)}`, onChange: (v) => { c.on = v; this.draw(true); } }),
          )
          : h('div.ctr-deal',
            h('span.bad', 'Refuses to negotiate (morale too low)'),
            btn(app, `Boost morale · ${F.MORALE.boostCost} CC`, () => {
              const r = F.boostMorale(save, p.id);
              if (!r.ok) { app.sfx('bad'); toast(r.message); return; }
              app.persist();
              app.sfx('coin');
              this.draw(true);
            }, { small: true, sfx: false, disabled: save.cc < F.MORALE.boostCost }),
          ),
        over ? h('p.bad.small', 'Over the cap: this deal will fail.') : null,
      );
    });
    const body = h('div.off-contracts',
      h('section.panel', h('h2.panel-title', 'Expiring contracts'),
        h('p.dim', expiring.length ? 'These deals end now. Re-sign the ones you want to keep; the rest enter free agency.' : 'No contracts expire this year.'),
        h('div.cap-proj', h('span.label', 'Cap after re-signing'), h(`b${used > save.salaryCap ? '.bad' : ''}`, `${money(used)} / ${money(save.salaryCap)}`)),
      ),
      h('div.ctr-list', rows),
    );
    return {
      body,
      primary: this.primary(expiring.length ? 'Confirm contracts' : 'Continue', () => {
        const resign = {};
        for (const p of expiring) if (ch[p.id] && ch[p.id].on) resign[p.id] = ch[p.id].years;
        this.names = Object.fromEntries(expiring.map((p) => [p.id, F.shortName(p)]));
        const r = this.run('contracts', { resign });
        if (!r) return;
        if (!expiring.length) { this.next(); return; }
        this.result = { step: 'contracts', result: r.result };
        this.draw();
      }),
    };
  }

  progressionStep() {
    const body = h('section.panel',
      h('h2.panel-title', 'Training camp'),
      h('p', 'Everyone gets a year older. Young players tend to grow on their own, veterans past 30 start to slow down, and kickers last a few years longer.'),
      h('p.dim', 'Injuries heal and condition resets for the new season.'),
    );
    return {
      body,
      primary: this.primary('Run training camp', () => {
        const r = this.run('progression');
        if (!r) return;
        this.result = { step: 'progression', result: r.result };
        this.draw();
      }),
    };
  }

  facilitiesStep() {
    const app = this.app;
    const save = this.save;
    // Live list (not the prepared snapshot): facilities upgraded from the hub since then count too.
    const list = F.FACILITIES.kinds.filter((k) => save.facilities[k] > 1).map((k) => ({ kind: k, label: F.FACILITIES.labels[k], level: save.facilities[k] }));
    const ch = this.choice.facilities || (this.choice.facilities = {});
    for (const f of list) if (!(f.kind in ch)) ch[f.kind] = true;
    const cost = list.filter((f) => ch[f.kind]).length * F.FACILITIES.maintainCost;
    const body = h('section.panel',
      h('h2.panel-title', 'Facility upkeep'),
      list.length
        ? h('div',
          h('p.dim', `Each facility above level 1 has a ${Math.round(F.FACILITIES.decayChance * 100)}% chance to drop a level unless you maintain it (${F.FACILITIES.maintainCost} CC each).`),
          h('div.maint-list', list.map((f) => h('div.maint',
            h('b', f.label), h('span.dim', ` level ${f.level}`),
            toggle({ app, checked: !!ch[f.kind], label: `Maintain ${f.label}`, onChange: (v) => { ch[f.kind] = v; this.draw(true); } }),
          ))),
          h('p', 'Upkeep: ', h(`b${cost > save.cc ? '.bad' : ''}`, `${cost} CC`), h('span.dim', ` of ${save.cc}`)),
        )
        : h('p', 'All facilities are at level 1, so nothing can slip. Upgrade them from the Team tab once you have credits.'),
    );
    return {
      body,
      primary: this.primary(list.length ? 'Confirm upkeep' : 'Continue', () => {
        const maintain = list.filter((f) => ch[f.kind]).map((f) => f.kind);
        const r = this.run('facilities', { maintain });
        if (!r) return;
        if (!list.length) { this.next(); return; }
        if (r.result.maintained.length) app.sfx('coin');
        this.result = { step: 'facilities', result: r.result };
        this.draw();
      }, { disabled: cost > save.cc }),
    };
  }

  staffStep() {
    const app = this.app;
    const save = this.save;
    const d = F.offseasonData(save, 'staff') || { expiring: [], current: {} };
    const ch = this.choice.staff || (this.choice.staff = {});
    const total = ['oc', 'dc'].reduce((s, role) => {
      const c = ch[role] && F.coordinatorCandidates(save, role).find((x) => x.id === ch[role]);
      return s + (c ? c.cost : 0);
    }, 0);
    const roleBlock = (role, label) => {
      const cur = save.staff[role];
      const exp = d.expiring.includes(role);
      return h('section.panel.staff-pick',
        h('h2.panel-title', label),
        h('div.staff-cur', h('span.label', 'Current'), cur ? [h('b', cur.name), starRow(cur.stars, { scale: 1.5 }), h(`span.${exp ? 'bad' : 'dim'}`, exp ? ' contract ends now' : ` ${plural(cur.years, 'season')} left`)] : h('span.dim', 'Vacant')),
        h('div.cand-list', { role: 'radiogroup', 'aria-label': `${label} candidates` }, F.coordinatorCandidates(save, role).map((c) => {
          const on = ch[role] === c.id;
          return h(`button.cand${on ? '.on' : ''}`, {
            type: 'button',
            role: 'radio',
            'aria-checked': on ? 'true' : 'false',
            onclick: () => { app.sfx('select'); ch[role] = on ? null : c.id; this.draw(true); },
          }, h('b.cand-name', c.name), starRow(c.stars, { scale: 1.5 }), h('span.cand-cost', `${c.cost} CC`), h('span.dim.small', `+${(c.stars * F.COORDINATORS.boostPerStar).toFixed(1)} ${role === 'oc' ? 'OFF' : 'DEF'} · ${F.COORDINATORS.years} seasons`));
        })),
      );
    };
    const body = h('div.off-staff',
      h('p.dim', 'Hire a coordinator to lift your ratings and speed up XP. Tap a candidate to select; tap again to keep your current coach.'),
      h('div.off-grid', roleBlock('oc', 'Offensive coordinator'), roleBlock('dc', 'Defensive coordinator')),
      h('p', 'Total: ', h(`b${total > save.cc ? '.bad' : ''}`, `${total} CC`), h('span.dim', ` of ${save.cc}`)),
    );
    return {
      body,
      primary: this.primary(total ? 'Hire & continue' : 'Continue', () => {
        const hire = {};
        for (const role of ['oc', 'dc']) if (ch[role]) hire[role] = ch[role];
        const r = this.run('staff', { hire });
        if (!r) return;
        if (r.result.hired.length) app.sfx('coin');
        if (!r.result.hired.length && !r.result.left.length) { this.next(); return; }
        this.result = { step: 'staff', result: r.result };
        this.draw();
      }, { disabled: total > save.cc }),
    };
  }

  draftStep() {
    const app = this.app;
    const save = this.save;
    const st = F.draftStatus(save);
    const onClock = F.userOnClock(save);
    const filter = this.state.draftPos || 'ALL';
    const needs = rosterNeeds(save);
    let prospects = F.draftProspects(save);
    if (filter === 'NEEDS') prospects = prospects.filter((p) => needs.includes(p.pos));
    else if (filter !== 'ALL') prospects = prospects.filter((p) => p.pos === filter);
    const space = st ? st.rosterSpace : 0;
    const capRoom = F.capUsage(save).room;
    const cur = st && st.current;
    const banner = h(`section.panel.draft-banner${onClock ? '.clock' : ''}`,
      onClock && cur ? h('p.db-main', h('b', 'You are on the clock'), h('span', ` · Round ${cur.round}, pick ${cur.pick} (#${cur.overall})`))
        : h('p.db-main', h('b', st && st.done ? 'The draft is complete' : 'Waiting for your pick')),
      h('p.dim.small', `Roster spots ${space} · cap room ${money(capRoom)} · rookie deals run ${F.CONFIG.ROOKIE_CONTRACT.years} years. Scouting costs ${F.DRAFT.scoutCost} CC and reveals true stars and potential.`),
      h('div.db-picks', (st ? st.userPicks : []).map((pk) => h(`span.chip${pk.prospectId ? '.ok' : pk.passed ? '' : '.pos'}`, pk.prospectId ? `R${pk.round}: ${pk.pos} ${pk.name}` : pk.passed ? `R${pk.round}: passed` : `R${pk.round} #${pk.overall}`))),
    );
    const chips = h('div.chips', { role: 'radiogroup', 'aria-label': 'Filter prospects' }, ['ALL', 'NEEDS', ...POS_ORDER].map((p) => h(`button.chip-btn${p === filter ? '.on' : ''}`, {
      type: 'button',
      role: 'radio',
      'aria-checked': p === filter ? 'true' : 'false',
      onclick: () => { app.sfx('click'); this.state.draftPos = p; this.draw(true); },
    }, p === 'ALL' ? 'All' : p === 'NEEDS' ? 'Needs' : p)));
    const cheapest = F.draftProspects(save).reduce((m, p) => Math.min(m, p.salary), Infinity);
    const blocker = !onClock ? null : space <= 0 ? 'Roster full: release a player (Roster button above) or pass.'
      : Number.isFinite(cheapest) && cheapest > capRoom ? `No cap room for a rookie deal (${money(capRoom)} left): release a player or pass.` : null;
    const cards = prospects.slice(0, 40).map((p) => {
      const cantPay = p.salary > capRoom;
      return h(`article.prospect${p.scouted ? '.scouted' : ''}`,
        h('div.pr-top',
          h('span.chip.pos', p.pos),
          h('div.pr-id', h('b', p.shortName), h('span.dim.small', `Age ${p.age} · ${money(p.salary)} × ${p.years}y`)),
          p.scouted
            ? h('div.pr-stars', starRow(p.stars, { scale: 1.5 }), h('span.label', 'Potential'), starRow(p.potential, { scale: 1 }))
            : h('div.pr-stars.est', h('span.label', 'Scouts say'), h('span.pr-range', starRow(p.estimate.lo, { scale: 1 }), h('span', '–'), starRow(p.estimate.hi, { scale: 1 }))),
        ),
        p.scouted && p.attrs ? attrBars(p.pos, p.attrs) : null,
        h('div.btn-row.pr-actions',
          p.scouted ? null : btn(app, `Scout · ${F.DRAFT.scoutCost} CC`, () => {
            const r = F.scoutProspect(save, p.id);
            if (!r.ok) { app.sfx('bad'); toast(r.message); return; }
            app.persist();
            app.sfx('coin');
            this.draw(true);
          }, { small: true, sfx: false, disabled: save.cc < F.DRAFT.scoutCost || (st && st.done) }),
          onClock ? btn(app, 'Draft', () => {
            const r = F.draftPlayer(save, p.id);
            if (!r.ok) { app.sfx('bad'); toast(r.message); return; }
            app.persist();
            app.sfx('good');
            toast(`You draft ${p.pos} ${p.shortName}!`);
            this.draw(true);
          }, { small: true, kind: 'primary', sfx: false, disabled: !!blocker || cantPay, title: blocker || (cantPay ? 'Not enough cap room' : null), attrs: { 'data-draft': p.id } }) : null,
        ),
        onClock && !blocker && cantPay ? h('p.bad.small.pr-note', 'Not enough cap room for this rookie deal.') : null,
      );
    });
    const made = st ? st.made.slice(-8).reverse() : [];
    const body = h('div.off-draft',
      banner,
      h('div.draft-grid',
        h('aside.panel.draft-ticker',
          h('h3.panel-title', 'Latest picks'),
          made.length ? h('ol.ticker', made.map((m) => h(`li${m.teamId === save.userTeamId ? '.me' : ''}`, h('span.dim', `#${m.overall}`), h('b', ` ${m.team}`), ` ${m.pos} ${m.name} `, starRow(m.stars, { scale: 1 })))) : h('p.dim', 'No picks yet.'),
        ),
        h('div.draft-main', chips, blocker ? h('p.bad', blocker) : null, cards.length ? h('div.pr-list', cards) : h('p.dim', 'No prospects match.')),
      ),
    );
    const secondary = onClock ? btn(app, 'Pass pick', () => {
      const r = F.passPick(save);
      if (!r.ok) { app.sfx('bad'); toast(r.message); return; }
      app.persist();
      this.draw(true);
    }, { kind: 'ghost', sfx: 'back', id: 'btn-pass' }) : null;
    return {
      body,
      secondary,
      primary: this.primary('Finish draft', async () => {
        if (F.userOnClock(save)) {
          const ok = await confirmDialog(app, { title: 'Finish the draft?', body: h('p', 'You still have picks left. Any remaining picks will be passed.'), ok: 'Finish draft' });
          if (!ok) return;
        }
        const r = this.run('draft');
        if (!r) return;
        this.result = { step: 'draft', result: r.result };
        this.draw();
      }),
    };
  }

  freeAgencyStep() {
    const save = this.save;
    const cap = F.capUsage(save);
    const ctx = { app: this.app, save, state: this.state, refresh: () => this.draw(true) };
    const body = h('div.off-fa',
      h('section.panel.market-top',
        h('div.mt-stats',
          h('div', h('span.label', 'Roster spots'), h('b', `${F.ROSTER.cap - F.roster(save).length} open`)),
          h('div', h('span.label', 'Cap room'), h('b', money(cap.room))),
          h('div', h('span.label', 'Credits'), ccChip(save.cc)),
        ),
        h('p.dim.small', 'Players you let go are in this pool too. Sign as many as you can afford, then start the new season.'),
      ),
      freeAgentList(ctx),
    );
    return {
      body,
      primary: this.primary('Done signing', () => {
        const r = this.run('freeAgency', null);
        if (!r) return;
        this.next();
      }),
    };
  }

  newSeasonStep() {
    const save = this.save;
    const r = F.teamRatings(save);
    const needs = rosterNeeds(save);
    const body = h('div.off-grid',
      h('section.panel',
        h('h2.panel-title', `Season ${save.season.year + 1}`),
        h('p', 'The schedule is out and the cap rises by ', h('b', money(F.CAP.perSeason)), '.'),
        h('div.rating-row', h('span.label', 'Offense'), starRow(r.off, { scale: 2 })),
        h('div.rating-row', h('span.label', 'Defense'), starRow(r.def, { scale: 2 })),
        h('p', `${F.roster(save).length}/${F.ROSTER.cap} stars on the roster.`),
        needs.length ? h('p.dim', `No star yet at ${needs.join(', ')}. Free agents arrive during the season too.`) : null,
      ),
      h('section.panel', h('h2.panel-title', 'Cap'), capPanel(save)),
    );
    return {
      body,
      primary: this.primary(`Kick off ${save.season.year + 1}`, () => {
        const res = this.run('newSeason');
        if (!res) return;
        this.app.sfx('whistle');
        this.app.go('hub', { tab: 'home' });
      }, { sfx: false }),
    };
  }

  // ------------------------------------------------------------------------------ results

  resultView() {
    const save = this.save;
    const { step, result } = this.result;
    const name = (id) => { const p = F.findPlayer(save, id); return p ? F.shortName(p) : (this.names && this.names[id]) || 'Player'; };
    let body;
    if (step === 'contracts') {
      body = h('section.panel',
        h('h2.panel-title', 'Contract results'),
        result.resigned.length ? h('div', h('h3.label', 'Re-signed'), h('ul.res-list', result.resigned.map((r) => h('li.good', icon('check', 1.5), ` ${name(r.playerId)}: ${money(r.salary)} × ${r.years}y`)))) : null,
        result.failed.length ? h('div', h('h3.label', 'Talks failed'), h('ul.res-list', result.failed.map((r) => h('li.bad', icon('cross', 1.5), ` ${name(r.playerId)}: ${r.reason === 'cap' ? 'no cap room' : 'refused to sign'}`)))) : null,
        result.departed.length ? h('div', h('h3.label', 'Leaving'), h('ul.res-list', result.departed.map((r) => h('li.dim', ` ${r.name}`)))) : h('p.dim', 'Nobody left.'),
      );
    } else if (step === 'progression') {
      const changes = result.changes.slice().sort((a, b) => (b.starsAfter - b.starsBefore) - (a.starsAfter - a.starsBefore));
      body = h('section.panel',
        h('h2.panel-title', 'Development report'),
        h('ul.dev-list', changes.map((c) => {
          const p = F.findPlayer(save, c.playerId);
          const ds = c.starsAfter - c.starsBefore;
          const attrs = Object.entries(c.changes).map(([k, v]) => h(`span.chip${v > 0 ? '.ok' : '.warn'}`, `${signed(v)} ${ATTR_SHORT[k] || k}`));
          return h(`li${ds > 0 ? '.up' : ds < 0 ? '.down' : ''}`,
            p ? h('span.chip.pos', p.pos) : null,
            h('b.dev-name', c.name),
            h('span.dim', ` ${c.age}`),
            h('span.dev-stars', starRow(c.starsAfter, { scale: 1.5 }), ds ? h(`b.${ds > 0 ? 'good' : 'bad'}`, ` ${signed(ds)}`) : null),
            attrs.length ? h('span.dev-attrs', attrs) : h('span.dim.small', 'No change'),
          );
        })),
      );
    } else if (step === 'facilities') {
      body = h('section.panel',
        h('h2.panel-title', 'Upkeep report'),
        result.maintained.length ? h('p.good', `Maintained: ${result.maintained.map((k) => F.FACILITIES.labels[k]).join(', ')}`) : null,
        result.decayed.length ? h('ul.res-list', result.decayed.map((d) => h('li.bad', `${F.FACILITIES.labels[d.kind]} slipped to level ${d.to}`))) : h('p', 'No facility lost a level.'),
      );
    } else if (step === 'staff') {
      body = h('section.panel',
        h('h2.panel-title', 'Staff changes'),
        result.hired.length ? h('ul.res-list', result.hired.map((role) => h('li.good', icon('check', 1.5), ` New ${role === 'oc' ? 'offensive' : 'defensive'} coordinator: ${save.staff[role] ? save.staff[role].name : ''}`))) : null,
        result.left.length ? h('ul.res-list', result.left.map((l) => h('li.bad', `${l.name} leaves (${l.role.toUpperCase()})`))) : null,
      );
    } else if (step === 'draft') {
      const picks = (result.picks || []).filter((p) => p.prospectId);
      body = h('section.panel',
        h('h2.panel-title', 'Your draft class'),
        picks.length ? h('ul.res-list', picks.map((p) => {
          const pl = F.findPlayer(save, p.prospectId);
          return h('li', h('span.chip.pos', p.pos), h('b', ` ${pl ? F.fullName(pl) : p.name}`), h('span.dim', ` round ${p.round} (#${p.overall}) `), starRow(p.stars, { scale: 1.5 }));
        })) : h('p.dim', 'You passed on every pick.'),
      );
    } else {
      body = h('p', 'Done.');
    }
    const nextStep = F.currentOffseasonStep(save);
    return { body, primary: this.primary(nextStep ? `Next: ${F.OFFSEASON_LABELS[nextStep]}` : 'Continue', () => this.next()) };
  }
}
