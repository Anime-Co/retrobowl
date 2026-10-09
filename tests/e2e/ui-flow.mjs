// UI flow: drives a whole career loop through the menu screens with real clicks:
// title → help/settings → new career → hub tabs, player card, signing → PLAY (match, autoplayed) →
// post-game → … (middle weeks fast-forwarded through the franchise API) → playoffs → every
// offseason step → season 2, then a forced firing → job offer. Fails on console errors, horizontal
// overflow, primary buttons clipped off-screen or toasts covering the header / primary button.
// Persistence: reloads mid-match (game stays unplayed), on the post-game screen (Continue brings
// the recap back, nothing is applied twice), during the draft with picks pending and after being
// fired. On desktop the new-career wizard and the offseason are driven with the keyboard only.
//
//   node tests/e2e/ui-flow.mjs                  # one viewport (phone portrait), fast
//   node tests/e2e/ui-flow.mjs --all            # every viewport below + the no-storage run
//   node tests/e2e/ui-flow.mjs --only=hd        # one named viewport
//   node tests/e2e/ui-flow.mjs --all --shots    # also writes test-results/ui-<viewport>-NN-<screen>.png
//   node tests/e2e/ui-flow.mjs --webfonts       # load the real Google Fonts (through curl, so the
//                                               # agent proxy works); default is the offline fallback

import { withBrowser } from './harness.mjs';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';

export const VIEWPORTS = {
  portrait: { mobile: true },
  landscape: { mobile: true, landscape: true },
  desktop: { viewport: { width: 1280, height: 800 } },
  narrow: { mobile: true, viewport: { width: 320, height: 568 } },
  p360: { mobile: true, viewport: { width: 360, height: 740 } },
  hd: { viewport: { width: 1920, height: 1080 } },
};

const fontCache = new Map();
function curl(url) {
  if (!fontCache.has(url)) {
    fontCache.set(url, new Promise((resolve) => {
      execFile('curl', ['-sS', '-m', '15', '-A', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36', url], { encoding: 'buffer', maxBuffer: 8 << 20 },
        (err, out) => resolve(err ? null : out));
    }));
  }
  return fontCache.get(url);
}

/** Serve Google Fonts through curl (honours HTTPS_PROXY); falls back to nothing when offline. */
export async function useWebFonts(page) {
  await page.route(/fonts\.(googleapis|gstatic)\.com/, async (route) => {
    const url = route.request().url();
    const body = await curl(url);
    if (!body) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    const css = /googleapis/.test(url);
    return route.fulfill({ status: 200, contentType: css ? 'text/css' : 'font/woff2', body, headers: { 'access-control-allow-origin': '*' } });
  });
}

/** Checks run on every visited screen; returns a list of problems. */
export async function layoutProblems(page, primarySel) {
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
    // toasts must not cover the team header or the screen's primary button
    const toasts = [...document.querySelectorAll('.toast')].map((t) => t.getBoundingClientRect());
    const guarded = [...document.querySelectorAll('.hub-head, .off-head, .sc-head, .pg-banner')];
    if (sel && document.querySelector(sel)) guarded.push(document.querySelector(sel));
    for (const t of toasts) {
      for (const g of guarded) {
        const r = g.getBoundingClientRect();
        if (r.width && t.left < r.right && r.left < t.right && t.top < r.bottom && r.top < t.bottom) out.push(`toast covers ${g.id ? `#${g.id}` : `.${[...g.classList].join('.')}`}`);
      }
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

  const reloadToTitle = async () => {
    await page.reload();
    await page.waitForFunction(() => window.__app && window.__app.currentName === 'title');
    await page.waitForTimeout(150);
  };
  const keyboard = o.name === 'desktop' || o.name === 'hd';
  const focused = () => page.evaluate(() => {
    const a = document.activeElement;
    return a && a !== document.body ? `${a.tagName.toLowerCase()}${a.id ? `#${a.id}` : ''}.${[...a.classList].join('.')}` : 'body';
  });

  // Fresh start
  if (o.webfonts) await useWebFonts(page);
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

  // New career (desktop: keyboard only — Enter on the title, type, Enter, arrows + Enter)
  if (keyboard) {
    await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('Enter');
    await waitScreen('newGame');
    await page.keyboard.type('Tester');
    await visit('newgame-coach', '#ng-next');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(120);
    let f = await focused();
    if (!/team-card/.test(f)) problems.push(`[${o.name}] team step: focus starts on ${f}, not a club`);
    // walk to Chicago with the arrow keys (the clubs are one roving radio group)
    let guardK = 0;
    while (guardK++ < 40 && (await page.evaluate(() => window.__app.current.teamId)) !== 'CHI') {
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(20);
    }
    if ((await page.evaluate(() => window.__app.current.teamId)) !== 'CHI') problems.push(`[${o.name}] arrow keys never reached CHI`);
    await visit('newgame-team', '#ng-next');
    await page.keyboard.press('Tab');
    f = await focused();
    if (!/ng-next/.test(f)) problems.push(`[${o.name}] Tab from the clubs should reach Next (one Tab stop), got ${f}`);
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Enter'); // Enter on the picked club = Next
    await page.waitForTimeout(120);
    f = await focused();
    if (!/diff-opt/.test(f)) problems.push(`[${o.name}] level step: focus starts on ${f}, not a difficulty`);
    let guardD = 0;
    while (guardD++ < 8 && (await page.evaluate(() => window.__app.current.difficulty)) !== 'easy') await page.keyboard.press('ArrowDown');
    await visit('newgame-level', '#ng-next');
    await page.keyboard.press('Enter');
    await waitScreen('hub');
    const made = await page.evaluate(() => ({ team: window.__app.save.userTeamId, diff: window.__app.save.difficulty.mode, coach: window.__app.save.coach.name }));
    if (made.team !== 'CHI' || made.diff !== 'easy' || made.coach !== 'Tester') problems.push(`[${o.name}] keyboard career setup wrong: ${JSON.stringify(made)}`);
  } else {
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
  }
  await visit('hub-home', '#btn-play'); // the welcome toast is up here: it must not cover the header
  // reload on the hub: Continue restores it
  await reloadToTitle();
  await click('#btn-continue');
  await waitScreen('hub');

  // Answer the first press question in the hub
  if (await exists('.news-choice:not([disabled])')) {
    if (keyboard) {
      // answer with Enter, then a stray second Enter must not kick off the game
      await page.focus('.news-choice:not([disabled])');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(80);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(150);
      if ((await screenName()) !== 'hub') problems.push(`[${o.name}] a second Enter after answering the press started ${await screenName()}`);
    } else {
      await click('.news-choice:not([disabled])');
    }
    if (!(await exists('.news-reply'))) problems.push(`[${o.name}] press answer did not resolve`);
  }

  // Keyboard: number keys switch tabs, Enter opens a player card, Escape closes it and focus returns.
  if (keyboard) {
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

  // Play games through the real match screen: click PLAY, then hand the same game to the bot
  // (autoplay) so the flow stays fast. Match-screen controls are covered by match-flow.mjs.
  const playOne = async (kind, shots) => {
    await click('#btn-play');
    await waitScreen('match');
    if (shots) await visit('match');
    await page.evaluate(() => {
      const app = window.__app;
      app.go('match', { gameId: app.current.gameId, autoplay: true, speed: 16 });
    });
    await waitScreen('postGame', 120000);
    if (shots) await visit('postgame', '#btn-continue');
    await click('#btn-continue');
    await page.waitForFunction(() => ['hub', 'offseason', 'fired'].includes(window.__app.currentName));
  };
  const games = () => page.evaluate(() => {
    const s = window.__app.save;
    const t = s.teams.find((x) => x.id === s.userTeamId);
    return { week: s.season.week, played: s.season.schedule.filter((g) => g.played && (g.home === s.userTeamId || g.away === s.userTeamId)).length, decided: t.record.w + t.record.l + t.record.t, coach: s.coach.wins + s.coach.losses + s.coach.ties, cc: s.cc };
  });

  // Persistence 1: reload in the middle of a match -> the game stays unplayed.
  {
    const g0 = await games();
    await click('#btn-play');
    await waitScreen('match');
    await page.waitForTimeout(1200);
    await reloadToTitle();
    await click('#btn-continue');
    await waitScreen('hub');
    const g1 = await games();
    if (JSON.stringify(g0) !== JSON.stringify(g1) || !(await exists('#btn-play'))) problems.push(`[${o.name}] reload mid-match changed the save: ${JSON.stringify(g0)} -> ${JSON.stringify(g1)}`);
  }

  // Persistence 2: reload on the post-game screen -> Continue brings the recap back; the result
  // is applied exactly once and the week advances exactly once.
  {
    const g0 = await games();
    await click('#btn-play');
    await waitScreen('match');
    await page.evaluate(() => { const app = window.__app; app.go('match', { gameId: app.current.gameId, autoplay: true, speed: 16 }); });
    await waitScreen('postGame', 120000);
    const score = await page.evaluate(() => document.querySelector('.pg-score').textContent);
    await reloadToTitle();
    await click('#btn-continue');
    await waitScreen('postGame').catch(() => {});
    const back = await page.evaluate(() => ({ name: window.__app.currentName, score: (document.querySelector('.pg-score') || {}).textContent }));
    if (back.name !== 'postGame' || back.score !== score) problems.push(`[${o.name}] reload on the post-game screen lost the recap (${JSON.stringify(back)})`);
    const g1 = await games();
    if (g1.played !== g0.played + 1 || g1.coach !== g0.coach + 1 || g1.week !== g0.week) problems.push(`[${o.name}] post-game reload: game applied ${g1.played - g0.played}x / week ${g0.week}->${g1.week}`);
    await visit('postgame-restored', '#btn-continue');
    await click('#btn-continue');
    await waitScreen('hub');
    const g2 = await games();
    if (g2.week !== g0.week + 1 || g2.played !== g1.played) problems.push(`[${o.name}] Continue after the restored recap: ${JSON.stringify(g1)} -> ${JSON.stringify(g2)}`);
  }

  await playOne('auto', true);
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
          // Persistence: reload with picks still pending -> same draft board, same roster
          const snap = () => page.evaluate(() => {
            const s = window.__app.save;
            const d = s.draft;
            return JSON.stringify({ i: d && d.index, mine: d && d.picks.filter((p) => p.teamId === s.userTeamId).map((p) => p.prospectId || p.passed), board: d && d.prospects.length, roster: s.teams.find((t) => t.id === s.userTeamId).roster.map((p) => p.id), cc: s.cc });
          });
          const d0 = await snap();
          await reloadToTitle();
          await click('#btn-continue');
          await waitScreen('offseason');
          const d1 = await snap();
          if (d0 !== d1) problems.push(`[${o.name}] draft changed across a reload: ${d0} -> ${d1}`);
        }
        if (st.step === 'freeAgency' && (await exists('.fa-card .btn.good'))) {
          await click('.fa-card .btn.good');
          await page.waitForSelector('.sign-sheet');
          if (await enabled('#btn-sign-confirm')) await click('#btn-sign-confirm'); else await page.keyboard.press('Escape');
          await page.waitForSelector('.sign-sheet', { state: 'detached' });
        }
      }
      if (keyboard) {
        // keyboard only: with nothing focused, Enter presses the step's primary button
        await page.evaluate(() => document.activeElement && document.activeElement.blur());
        const before = await page.evaluate(() => { const off = window.__app.save.offseason; return `${off && off.index}|${(document.querySelector('#off-primary') || {}).textContent}`; });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(80);
        if (await exists('.sheet.confirm')) await page.keyboard.press('Enter'); // focus starts on the confirm button
        await page.waitForTimeout(60);
        const after = await page.evaluate(() => { const off = window.__app.save.offseason; return `${off && off.index}|${(document.querySelector('#off-primary') || {}).textContent}`; });
        if (before === after && (await screenName()) === 'offseason') problems.push(`[${o.name}] Enter did not press the offseason primary (${before})`);
      } else {
        await click('#off-primary');
        if (await exists('.sheet.confirm')) await click('.sheet.confirm .btn.primary');
      }
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
  // Persistence: reload after being fired -> Continue goes straight back to the offers
  await reloadToTitle();
  const sub = await page.evaluate(() => (document.querySelector('#btn-continue .tb-sub') || {}).textContent || '');
  if (!/job offers/i.test(sub)) problems.push(`[${o.name}] title Continue while fired says "${sub}"`);
  await click('#btn-continue');
  await waitScreen('fired');
  await click('.offer .btn');
  await waitScreen('offseason');
  await visit('offseason-new-team', '#off-primary');

  // Back to the title: Continue should be offered
  await page.evaluate(() => window.__app.go('title'));
  await waitScreen('title');
  await visit('title-continue', '#btn-continue');
  return problems;
}

/**
 * Browser storage blocked (private mode / blocked site data): the game must still run a career
 * and a match, warn that nothing is saved, and never throw.
 */
export async function runNoStorage(page, o) {
  const problems = [];
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('blocked', 'SecurityError'); } });
  });
  await page.reload();
  await page.waitForFunction(() => window.__app && window.__app.currentName === 'title');
  if (!(await page.locator('.title-warn').count())) problems.push(`[${o.name}] no "saving is blocked" note on the title`);
  await page.click('#btn-new');
  await page.fill('#coach-name', 'NoStore');
  await page.click('#ng-next');
  await page.click('.team-card >> nth=2');
  await page.click('#ng-next');
  await page.click('#ng-next');
  await page.waitForFunction(() => window.__app.currentName === 'hub');
  if (!(await page.locator('.alert.static').count())) problems.push(`[${o.name}] hub does not warn that progress is not saved`);
  await page.click('#btn-play');
  await page.waitForFunction(() => window.__app.currentName === 'match');
  await page.evaluate(() => { const app = window.__app; app.go('match', { gameId: app.current.gameId, autoplay: true, speed: 16 }); });
  await page.waitForFunction(() => window.__app.currentName === 'postGame', null, { timeout: 120000 });
  await page.click('#btn-continue');
  await page.waitForFunction(() => window.__app.currentName === 'hub');
  const wk = await page.evaluate(() => window.__app.save.season.week);
  if (wk !== 2) problems.push(`[${o.name}] without storage the week did not advance (${wk})`);
  return problems;
}

async function main() {
  const args = process.argv.slice(2);
  const only = (args.find((a) => a.startsWith('--only=')) || '').slice(7);
  const all = args.includes('--all');
  const names = only ? [only] : all ? Object.keys(VIEWPORTS) : ['portrait'];
  const shots = args.includes('--shots');
  const webfonts = args.includes('--webfonts');
  let failed = 0;
  if (all) {
    const t0 = Date.now();
    await withBrowser(VIEWPORTS.portrait, async ({ page, errors }) => {
      let problems = [];
      try { problems = await runNoStorage(page, { name: 'no-storage' }); } catch (e) { problems.push(`[no-storage] aborted: ${e.message.split('\n')[0]}`); }
      const all2 = [...problems, ...errors.map((e) => `[no-storage] console: ${e}`)];
      if (all2.length) failed++;
      console.log(`${all2.length ? 'FAIL' : 'PASS'} ui-flow no-storage (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      for (const p of all2) console.log(`  - ${p}`);
    });
  }
  for (const name of names) {
    const t0 = Date.now();
    await withBrowser(VIEWPORTS[name], async ({ page, shot, errors }) => {
      let problems = [];
      try {
        problems = await runFlow(page, { name, webfonts, shot: shots ? (n) => shot(`ui-${name}-${n}`) : null, log: (s) => console.log(`  ${name}: ${s}`) });
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
