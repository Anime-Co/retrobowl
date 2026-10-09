// UI flow: drives a whole career loop through the menu screens with real clicks:
// title → help/settings → new career → hub tabs, player card, signing → PLAY (match stub) →
// post-game → … (middle weeks fast-forwarded through the franchise API) → playoffs → every
// offseason step → season 2, then a forced firing → job offer. Fails on console errors, horizontal
// overflow or primary buttons clipped off-screen.
//
//   node tests/e2e/ui-flow.mjs                 # one viewport (phone portrait), fast
//   node tests/e2e/ui-flow.mjs --all           # phone portrait, phone landscape, desktop, 320px
//   node tests/e2e/ui-flow.mjs --all --shots   # also writes test-results/ui-<viewport>-NN-<screen>.png

import { withBrowser } from './harness.mjs';
import { pathToFileURL } from 'node:url';

export const VIEWPORTS = {
  portrait: { mobile: true },
  landscape: { mobile: true, landscape: true },
  desktop: { viewport: { width: 1280, height: 800 } },
  narrow: { mobile: true, viewport: { width: 320, height: 568 } },
};

/** Checks run on every visited screen; returns a list of problems. */
async function layoutProblems(page, primarySel) {
  return page.evaluate((sel) => {
    const W = innerWidth;
    const H = innerHeight;
    const out = [];
    if (document.documentElement.scrollWidth > W + 1) out.push(`page scrolls horizontally (${document.documentElement.scrollWidth} > ${W})`);
    const clipOf = (el) => {
      for (let a = el.parentElement; a && a.id !== 'ui'; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.overflowX !== 'visible') return a;
      }
      return null;
    };
    const skip = (el) => el.closest('.title-bg, .tabs, .off-steps, .hub-nav') || getComputedStyle(el).position === 'fixed';
    let n = 0;
    for (const el of document.querySelectorAll('#ui *')) {
      if (n > 8) break;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || skip(el)) continue;
      const clip = clipOf(el);
      if (clip && getComputedStyle(clip).textOverflow === 'ellipsis') continue; // intentional truncation
      const right = clip ? Math.min(W, clip.getBoundingClientRect().right) : W;
      const left = clip ? Math.max(0, clip.getBoundingClientRect().left) : 0;
      if (r.right > right + 1.5 || r.left < left - 1.5) {
        // Only report the outermost offender.
        const p = el.parentElement;
        const pr = p && p.getBoundingClientRect();
        if (pr && (pr.right > right + 1.5 || pr.left < left - 1.5) && !p.closest('.title-bg')) continue;
        out.push(`overflow: <${el.tagName.toLowerCase()} class="${el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className}"> ${Math.round(r.left)}..${Math.round(r.right)} vs ${Math.round(left)}..${Math.round(right)}`);
        n++;
      }
    }
    let small = 0;
    for (const b of document.querySelectorAll('#ui button, #ui [role="button"]')) {
      const r = b.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || getComputedStyle(b).visibility === 'hidden') continue;
      if ((r.height < 43.5 || r.width < 43.5) && small++ < 3) out.push(`tap target <${b.tagName.toLowerCase()} class="${b.className}"> "${(b.textContent || b.getAttribute('aria-label') || '').trim().slice(0, 20)}" is ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    const text = document.getElementById('ui').innerText;
    const junk = text.match(/\b(null|undefined|NaN)\b|\[object \w+\]/);
    if (junk) out.push(`stray "${junk[0]}" in the UI text`);
    if (sel) {
      const b = document.querySelector(sel);
      if (!b) out.push(`primary ${sel} missing`);
      else {
        const r = b.getBoundingClientRect();
        if (r.top < 0 || r.bottom > H + 1 || r.left < 0 || r.right > W + 1) out.push(`primary ${sel} off-screen (${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} in ${W}x${H})`);
        if (r.height < 43.5 || r.width < 43.5) out.push(`primary ${sel} smaller than 44px (${Math.round(r.width)}x${Math.round(r.height)})`);
      }
    }
    return out;
  }, primarySel || null);
}

/**
 * Run the whole flow on an open page.
 * @param {any} page
 * @param {{name:string, shot?:(n:string)=>Promise<any>, log?:(s:string)=>void}} o
 * @returns {Promise<string[]>} problems
 */
export async function runFlow(page, o) {
  const problems = [];
  const log = o.log || (() => {});
  let shotN = 0;
  const screenName = () => page.evaluate(() => window.__app.currentName);
  const waitScreen = async (name, timeout = 8000) => {
    await page.waitForFunction((n) => window.__app.currentName === n, name, { timeout });
    await page.waitForTimeout(60);
  };
  const visit = async (label, primary) => {
    await page.waitForTimeout(80);
    const p = await layoutProblems(page, primary);
    for (const x of p) problems.push(`[${o.name}] ${label}: ${x}`);
    if (o.shot) await o.shot(`${String(++shotN).padStart(2, '0')}-${label}`);
  };
  const click = async (sel, opts = {}) => {
    const loc = page.locator(sel).first();
    await loc.waitFor({ state: 'visible', timeout: opts.timeout || 5000 });
    await loc.scrollIntoViewIfNeeded();
    await loc.click();
    await page.waitForTimeout(opts.wait ?? 40);
  };
  const exists = async (sel) => (await page.locator(sel).count()) > 0;
  const enabled = async (sel) => page.evaluate((s) => { const b = document.querySelector(s); return !!b && !b.disabled; }, sel);
  const save = () => page.evaluate(() => {
    const s = window.__app.save;
    return s ? { phase: s.season.phase, week: s.season.week, year: s.season.year, fired: !!s.fired, cc: s.cc, roster: s.teams.find((t) => t.id === s.userTeamId).roster.length } : null;
  });

  // Fresh start
  await page.evaluate(() => { try { localStorage.clear(); } catch { /* ignore */ } });
  await page.reload();
  await page.waitForFunction(() => window.__app && window.__app.currentName === 'title');
  await page.waitForTimeout(300);
  await visit('title', '#btn-new');

  // Help & settings from the title
  await click('#btn-help');
  await waitScreen('help');
  await visit('help');
  await click('.seg-btn[aria-checked="false"]');
  await visit('help-other');
  await page.keyboard.press('Escape');
  await waitScreen('title');
  await click('#btn-settings');
  await waitScreen('settings');
  await click('#set-sound');
  await click('#set-sound');
  await visit('settings');
  await click('.sc-back');
  await waitScreen('title');

  // New career
  await click('#btn-new');
  await waitScreen('newGame');
  await page.fill('#coach-name', 'Tester');
  await visit('newgame-coach', '#ng-next');
  await click('#ng-next');
  await click('[data-team="CHI"]');
  await visit('newgame-team', '#ng-next');
  await click('#ng-next');
  await click('[data-diff="easy"]');
  await visit('newgame-level', '#ng-next');
  await click('#ng-next');
  await waitScreen('hub');
  await visit('hub-home', '#btn-play');

  // Answer the first press question in the hub
  if (await exists('.news-choice:not([disabled])')) {
    await click('.news-choice:not([disabled])');
    if (!(await exists('.news-reply'))) problems.push(`[${o.name}] press answer did not resolve`);
  }

  // Keyboard: number keys switch tabs, Enter opens a player card, Escape closes it and focus returns.
  if (o.name === 'desktop') {
    await page.keyboard.press('2');
    await page.waitForSelector('.hub-body[data-tab="roster"]');
    await page.focus('.prow');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.player-card');
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => !!document.activeElement.closest('.player-card'));
    if (!inside) problems.push(`[${o.name}] focus left the player card on Tab`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.player-card', { state: 'detached' });
    const back = await page.evaluate(() => document.activeElement.classList.contains('prow'));
    if (!back) problems.push(`[${o.name}] focus did not return to the roster row after Escape`);
    await page.keyboard.press('1');
    await page.waitForSelector('.hub-body[data-tab="home"]');
  }

  // Tabs
  for (const tab of ['roster', 'schedule', 'standings', 'team', 'market']) {
    await click(`[data-tab="${tab}"]`);
    await visit(`hub-${tab}`);
    if (tab === 'roster') {
      await click('.prow');
      await page.waitForSelector('.player-card');
      await visit('player-card');
      if (await exists('.pc-contract .btn:not([disabled])[data-fk="pc-extend"]')) {
        await click('[data-fk="pc-extend"]');
        await visit('player-extend');
      }
      await page.keyboard.press('Escape');
      await page.waitForSelector('.player-card', { state: 'detached' });
    }
    if (tab === 'standings') {
      await click('.seg-btn[data-fk="Standings view:conference"]');
      await visit('hub-standings-conf');
      await click('.seg-btn[data-fk="Standings view:playoffs"]');
      await visit('hub-standings-po');
    }
    if (tab === 'team' && (await exists('[data-fk="fac:training"]:not([disabled])'))) {
      await click('[data-fk="fac:training"]');
    }
    if (tab === 'market') {
      await click('.fa-card .btn');
      await page.waitForSelector('.sign-sheet');
      await visit('sign-sheet');
      if (await enabled('#btn-sign-confirm')) await click('#btn-sign-confirm');
      else await page.keyboard.press('Escape');
      await page.waitForSelector('.sign-sheet', { state: 'detached' });
    }
  }
  await click('[data-tab="home"]');

  // Play a game through the stub with the match engine, then one quick sim
  const playOne = async (kind, shots) => {
    await click('#btn-play');
    await waitScreen('match');
    if (shots) await visit('match-stub');
    await click(kind === 'auto' ? '#stub-auto' : '#stub-sim');
    await waitScreen('postGame', 15000);
    if (shots) await visit('postgame', '#btn-continue');
    await click('#btn-continue');
    await page.waitForFunction(() => ['hub', 'offseason', 'fired'].includes(window.__app.currentName));
  };
  await playOne('auto', true);
  await playOne('sim', false);
  log(`after 2 games: ${JSON.stringify(await save())}`);

  // Fast-forward the middle of the season through the franchise API (forcing wins so the
  // playoff screens get exercised).
  await page.evaluate(async () => {
    const F = await import('/src/franchise/index.js');
    const app = window.__app;
    const s = app.save;
    let guard = 0;
    while (s.season.phase === 'regular' && s.season.week < 16 && guard++ < 40) {
      for (const n of F.pendingNews(s)) { const i = n.choices.findIndex((c) => F.choiceAvailable(s, c)); if (i >= 0) F.resolveNews(s, n.id, i); }
      const mr = F.simulateUserGame(s);
      if (mr) {
        if (mr.userScore <= mr.oppScore) mr.userScore = mr.oppScore + 3;
        F.applyUserGameResult(s, mr);
      }
      F.advanceWeek(s);
    }
    app.persist();
    app.go('hub');
  });
  await waitScreen('hub');
  await visit('hub-week16', '#btn-play');
  await playOne('auto', false);

  // Playoffs (if we made it) through the UI
  let guard = 0;
  let sawBracket = false;
  while (guard++ < 8) {
    const name = await screenName();
    if (name !== 'hub') break;
    if (!sawBracket) {
      sawBracket = true;
      await click('[data-tab="schedule"]');
      await visit('hub-playoff-bracket');
      await click('[data-tab="home"]');
    }
    if (await exists('#btn-play')) await playOne('auto', false);
    else if (await exists('#btn-advance')) { await click('#btn-advance'); await page.waitForTimeout(100); }
    else if (await exists('#btn-offseason')) { await click('#btn-offseason'); break; }
    else break;
  }
  await page.waitForFunction(() => ['offseason', 'fired'].includes(window.__app.currentName), null, { timeout: 8000 });
  log(`season 1 over: ${JSON.stringify(await save())}`);

  // Offseason, every step through its primary button
  const offseasonLoop = async (prefix) => {
    const seen = new Set();
    let g = 0;
    while (g++ < 40) {
      const name = await screenName();
      if (name === 'fired') {
        await visit(`${prefix}fired`);
        await click('.offer .btn');
        await page.waitForFunction(() => window.__app.currentName !== 'fired');
        continue;
      }
      if (name !== 'offseason') break;
      const st = await page.evaluate(() => {
        const off = window.__app.save.offseason;
        const shown = (document.querySelector('.off-step') || {}).textContent || '';
        return { step: off && off.steps[off.index], shown: shown.replace(/\W+/g, '-').toLowerCase(), result: (document.querySelector('#off-primary') || {}).textContent.startsWith('Next') };
      });
      const key = `${st.shown}${st.result ? '-result' : ''}`;
      if (!seen.has(key)) { seen.add(key); await visit(`${prefix}off-${key}`, '#off-primary'); }
      if (!st.result) {
        if (st.step === 'staff' && (await exists('.cand'))) {
          const ok = await page.evaluate(() => { const s = window.__app.save; return s.cc >= 3; });
          if (ok) await click('.cand');
        }
        if (st.step === 'draft') {
          if (await exists('.prospect .btn:not(.primary):not([disabled])')) await click('.prospect .btn:not(.primary):not([disabled])');
          if (await exists('[data-draft]:not([disabled])')) { await click('[data-draft]:not([disabled])'); await visit(`${prefix}off-draft-picked`, '#off-primary'); }
        }
        if (st.step === 'freeAgency' && (await exists('.fa-card .btn.good'))) {
          await click('.fa-card .btn.good');
          await page.waitForSelector('.sign-sheet');
          if (await enabled('#btn-sign-confirm')) await click('#btn-sign-confirm'); else await page.keyboard.press('Escape');
          await page.waitForSelector('.sign-sheet', { state: 'detached' });
        }
      }
      await click('#off-primary');
      if (await exists('.sheet.confirm')) await click('.sheet.confirm .btn.primary');
      await page.waitForTimeout(60);
    }
  };
  await offseasonLoop('');
  await waitScreen('hub');
  const s2 = await save();
  log(`season 2: ${JSON.stringify(s2)}`);
  if (!s2 || s2.phase !== 'regular' || s2.week !== 1) problems.push(`[${o.name}] expected season 2 week 1, got ${JSON.stringify(s2)}`);
  await visit('hub-season2', '#btn-play');

  // Forced firing: fast-forward season 2, tank the owner's confidence, run the review.
  await page.evaluate(async () => {
    const F = await import('/src/franchise/index.js');
    const app = window.__app;
    const s = app.save;
    let guard = 0;
    while (s.season.phase !== 'offseason' && guard++ < 40) {
      const mr = F.simulateUserGame(s);
      if (mr) F.applyUserGameResult(s, mr);
      F.advanceWeek(s);
    }
    s.jobSecurity = 0;
    s.coach.seasons = Math.max(s.coach.seasons, 3);
    app.persist();
    app.go('offseason');
  });
  await waitScreen('offseason');
  await click('#off-primary');
  await waitScreen('fired');
  await visit('fired');
  await click('.offer .btn');
  await waitScreen('offseason');
  await visit('offseason-new-team', '#off-primary');

  // Back to the title: Continue should be offered
  await page.evaluate(() => window.__app.go('title'));
  await waitScreen('title');
  await visit('title-continue', '#btn-continue');
  return problems;
}

async function main() {
  const args = process.argv.slice(2);
  const names = args.includes('--all') ? Object.keys(VIEWPORTS) : ['portrait'];
  const shots = args.includes('--shots');
  let failed = 0;
  for (const name of names) {
    const t0 = Date.now();
    await withBrowser(VIEWPORTS[name], async ({ page, shot, errors }) => {
      let problems = [];
      try {
        problems = await runFlow(page, { name, shot: shots ? (n) => shot(`ui-${name}-${n}`) : null, log: (s) => console.log(`  ${name}: ${s}`) });
      } catch (e) {
        problems.push(`[${name}] flow aborted: ${e.message.split('\n')[0]}`);
        try { await shot(`ui-${name}-FAILED`); } catch { /* ignore */ }
      }
      const all = [...problems, ...errors.map((e) => `[${name}] console: ${e}`)];
      const ok = all.length === 0;
      if (!ok) failed++;
      console.log(`${ok ? 'PASS' : 'FAIL'} ui-flow ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      for (const p of all) console.log(`  - ${p}`);
    });
  }
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
