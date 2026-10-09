// Franchise-aware UI components shared by the hub, post-game and offseason screens.

import { h, toast } from '../dom.js';
import * as F from '../../franchise/index.js';
import { icon, starRow, moraleFace, teamTag, money, segBar, progress, signed } from './common.js';

/** Display order of positions on the roster. */
export const POS_ORDER = ['QB', 'RB', 'WR', 'TE', 'OL', 'K', 'DL', 'LB', 'DB'];
export const POS_GROUPS = [
  { label: 'Offense', positions: ['QB', 'RB', 'WR', 'TE', 'OL', 'K'] },
  { label: 'Defense', positions: ['DL', 'LB', 'DB'] },
];

export const ATTR_SHORT = { arm: 'ARM', accuracy: 'ACC', speed: 'SPD', stamina: 'STA', strength: 'STR', catching: 'CAT', blocking: 'BLK', tackling: 'TKL', range: 'RNG' };

const TAG_CLASS = { result: 'r', league: 'l', streak: 's', injury: 'i', signing: 'g', record: 'c', team: 't', draft: 'd', award: 'a', staff: 'f' };
const TAG_LABEL = { result: 'Result', league: 'League', streak: 'Streak', injury: 'Injury', signing: 'Signing', record: 'Record', team: 'Club', draft: 'Draft', award: 'Award', staff: 'Staff' };

/** "Week 5" / "Wild Card" / "Offseason" for the current point in the season. */
export function phaseText(save) {
  const s = save.season;
  if (s.phase === 'offseason') return 'Offseason';
  if (s.phase === 'playoffs') {
    const r = s.playoffs && s.playoffs.round;
    return r ? F.ROUND_LABELS[r] : 'Playoffs';
  }
  return `Week ${s.week}`;
}

export function gameLabel(g) {
  return g.playoff ? F.ROUND_LABELS[g.round] || 'Playoffs' : `Week ${g.week}`;
}

/** Two highest-weighted attributes, e.g. "ARM 7 · ACC 6". */
export function keyAttrs(p) {
  const w = F.STAR_WEIGHTS[p.pos];
  return [...F.ATTRS[p.pos]].sort((a, b) => w[b] - w[a]).slice(0, 2).map((k) => `${ATTR_SHORT[k]} ${p.attrs[k]}`).join(' · ');
}

const n = (v) => (Number.isFinite(v) ? v : 0);

/** One-line stat summary by position for a stats object (season, career or a game). */
export function statLine(pos, s) {
  if (!s) return '';
  switch (pos) {
    case 'QB': return `${n(s.passCmp)}/${n(s.passAtt)} · ${n(s.passYds)} yds · ${n(s.passTd)} TD · ${n(s.int)} INT`;
    case 'RB': return `${n(s.rushAtt)} car · ${n(s.rushYds)} yds · ${n(s.rushTd)} TD · ${n(s.rec)} rec`;
    case 'WR': case 'TE': return `${n(s.rec)} rec · ${n(s.recYds)} yds · ${n(s.recTd)} TD`;
    case 'K': return `${n(s.fgMade)}/${n(s.fgAtt)} FG · long ${n(s.fgLong)} · ${n(s.patMade)}/${n(s.patAtt)} XP`;
    case 'OL': return `${n(s.gp)} games`;
    default: return `${n(s.tackles)} tkl · ${n(s.sacks)} sacks · ${n(s.defInt)} INT`;
  }
}

/** Stat rows [label, key] shown on the player card per position. */
export const STAT_ROWS = {
  QB: [['Games', 'gp'], ['Completions', 'passCmp'], ['Attempts', 'passAtt'], ['Pass yards', 'passYds'], ['Pass TD', 'passTd'], ['Interceptions', 'int'], ['Rush yards', 'rushYds'], ['Rush TD', 'rushTd']],
  RB: [['Games', 'gp'], ['Carries', 'rushAtt'], ['Rush yards', 'rushYds'], ['Rush TD', 'rushTd'], ['Receptions', 'rec'], ['Rec yards', 'recYds'], ['Rec TD', 'recTd'], ['Fumbles', 'fumbles']],
  WR: [['Games', 'gp'], ['Receptions', 'rec'], ['Rec yards', 'recYds'], ['Rec TD', 'recTd'], ['Return yards', 'retYds'], ['Return TD', 'retTd']],
  TE: [['Games', 'gp'], ['Receptions', 'rec'], ['Rec yards', 'recYds'], ['Rec TD', 'recTd']],
  OL: [['Games', 'gp']],
  K: [['Games', 'gp'], ['FG made', 'fgMade'], ['FG tried', 'fgAtt'], ['Longest FG', 'fgLong'], ['XP made', 'patMade'], ['XP tried', 'patAtt']],
  DL: [['Games', 'gp'], ['Tackles', 'tackles'], ['Sacks', 'sacks'], ['Interceptions', 'defInt'], ['Forced fumbles', 'ff']],
};
STAT_ROWS.LB = STAT_ROWS.DL;
STAT_ROWS.DB = STAT_ROWS.DL;

/** Performance score of one stat line (player of the game, top performers). */
export function impact(s) {
  if (!s) return 0;
  return n(s.passYds) / 20 + n(s.passTd) * 5 - n(s.int) * 3 + n(s.rushYds) / 8 + n(s.rushTd) * 6
    + n(s.rec) * 0.6 + n(s.recYds) / 8 + n(s.recTd) * 6 + n(s.fgMade) * 3 + n(s.tackles) * 0.9
    + n(s.sacks) * 4 + n(s.defInt) * 5 + n(s.retYds) / 15 + n(s.retTd) * 6;
}

/** Positions with no healthy star starter (a generic filler plays there). */
export function rosterNeeds(save) {
  const chart = F.depthChart(F.roster(save));
  return POS_ORDER.filter((pos) => !chart.slots[pos][0]);
}

/** Starter / bench / injured role of each roster player. */
export function rosterRoles(save) {
  const chart = F.depthChart(F.roster(save));
  const role = {};
  for (const id of chart.starterIds) role[id] = 'starter';
  for (const p of chart.bench) role[p.id] = 'bench';
  for (const p of chart.injured) role[p.id] = 'injured';
  return role;
}

/** Contract chip text "$1.2M · 2y". */
export const contractShort = (c) => `${money(c.salary)} · ${c.years}y`;

/** Mood face for a player. */
export function playerFace(p, scale = 2) {
  const m = F.moraleLabel(p.morale);
  return moraleFace(m.level, `Morale: ${m.label}`, scale);
}

/**
 * Roster row: number/pos, name, stars, age, key attributes, morale, condition, injury, contract.
 * @param {{onOpen:(p)=>void, role?:string}} o
 */
export function playerRow(app, save, p, o) {
  const role = o.role;
  const cond = Math.round(p.condition);
  return h('button.prow', {
    type: 'button',
    class: p.injury ? 'hurt' : null,
    'aria-label': `${F.fullName(p)}, ${p.pos}, ${F.stars(p)} stars`,
    onclick: () => { app.sfx('click'); o.onOpen(p); },
  },
  h('span.prow-num', h('b', `#${p.number}`), h('span.chip.pos', p.pos)),
  h('span.prow-main',
    h('span.prow-name', F.shortName(p), p.skillPoints > 0 ? h('span.sp-badge', { title: 'Skill points to spend' }, `+${p.skillPoints}`) : null),
    h('span.prow-sub',
      h('span', `Age ${p.age}`),
      h('span.dim', keyAttrs(p)),
      h('span.dim.prow-contract', contractShort(p.contract)),
    ),
  ),
  h('span.prow-side',
    starRow(F.stars(p), { scale: 1.5 }),
    h('span.prow-status',
      p.injury ? h('span.chip.warn', { title: F.injuryText(p) }, p.injury.weeks >= 20 ? 'OUT' : `INJ ${p.injury.weeks}W`) : role === 'bench' ? h('span.chip', 'Bench') : null,
      h('span.cond', { title: `Condition ${cond}% (${F.conditionLabel(cond)})`, class: cond < 60 ? 'low' : null }, `${cond}%`),
      playerFace(p, 1.5),
    ),
  ));
}

const resolvedLines = new Map();

/**
 * Press question / player message with choice buttons and their effects.
 * @param {{onChange?:Function, compact?:boolean}} [o]
 */
export function newsCard(app, save, ev, o = {}) {
  const card = h(`article.panel.news-card${ev.kind === 'message' ? '.msg' : ''}`);
  const draw = () => {
    while (card.firstChild) card.removeChild(card.firstChild);
    const p = ev.playerId ? F.findPlayer(save, ev.playerId) : null;
    card.appendChild(h('div.news-head',
      h(`span.chip${ev.kind === 'message' ? '.ok' : '.pos'}`, ev.kind === 'message' ? 'Message' : 'Press'),
      h('h3.news-title', ev.title),
      p ? playerFace(p, 1.5) : null,
    ));
    card.appendChild(h('p.news-body', ev.body));
    if (ev.resolved) {
      const c = ev.choices[ev.choice];
      card.appendChild(h('div.news-reply',
        c ? h('p.news-said', c.label) : null,
        h('p.dim', ev.reply || ''),
        resolvedLines.has(ev.id) ? h('p.news-fx', resolvedLines.get(ev.id).join(' · ')) : null,
      ));
      return;
    }
    const list = h('div.news-choices');
    ev.choices.forEach((c, i) => {
      const ok = F.choiceAvailable(save, c);
      const fx = F.effectsText(save, c.effects);
      list.appendChild(h('button.btn.news-choice', {
        type: 'button',
        disabled: !ok,
        onclick: () => {
          const r = F.resolveNews(save, ev.id, i);
          if (!r.ok) { app.sfx('bad'); toast(r.message); return; }
          app.persist();
          app.sfx(c.effects.cc ? 'coin' : 'select');
          resolvedLines.set(ev.id, r.effects);
          draw();
          if (o.onChange) o.onChange();
        },
      },
      h('span.nc-label', c.label),
      fx.length ? h('span.nc-fx', fx.map((t) => h(`span${/[+]/.test(t) ? '.good' : /-\d/.test(t) ? '.bad' : ''}`, t))) : null,
      !ok ? h('span.nc-fx.bad', 'Not enough CC') : null));
    });
    card.appendChild(list);
  };
  draw();
  return card;
}

/** Recent headlines list. */
export function headlineList(save, limit = 8) {
  const items = F.headlines(save, limit);
  if (!items.length) return h('p.dim', 'No news yet.');
  return h('ul.headlines', items.map((it) => h('li',
    h(`span.htag.t-${TAG_CLASS[it.tag] || 'l'}`, TAG_LABEL[it.tag] || 'News'),
    h('span.htxt', it.text),
  )));
}

/** Compact team ratings "OFF ★★★ DEF ★★". */
export function ratingPair(off, def, scale = 1.5) {
  return h('span.rpair',
    h('span.rp', h('span.label', 'OFF'), starRow(off, { scale })),
    h('span.rp', h('span.label', 'DEF'), starRow(def, { scale })),
  );
}

/** Team line: tag + city + record. */
export function teamLine(save, team, extra) {
  return h('span.tline', teamTag(team), h('span.tl-city', team.city), extra || null);
}

/** XP bar with level. */
export function xpBlock(p) {
  const need = F.xpForLevel(p.level);
  return h('div.xp',
    h('span.xp-lvl', `LV ${p.level}`),
    progress(F.xpProgress(p), 'var(--info)'),
    h('span.xp-txt.dim', `${p.xp}/${need} XP`),
  );
}

/** Attribute bars (read only), e.g. for prospects / free agents. */
export function attrBars(pos, attrs) {
  return h('div.attrs', F.ATTRS[pos].map((k) => h('div.attr',
    h('span.attr-name', F.ATTR_LABELS[k]),
    segBar(attrs[k]),
    h('span.attr-val', String(attrs[k])),
  )));
}

/** Effects list for post-game deltas. */
export function deltaChip(label, v, suffix = '') {
  const cls = v > 0 ? 'good' : v < 0 ? 'bad' : 'dim';
  return h('span.delta', h('span.label', label), h(`b.${cls}`, `${signed(v)}${suffix}`));
}

export { icon };
