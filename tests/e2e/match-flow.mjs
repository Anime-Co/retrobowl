// Match screen end-to-end checks (src/match/MatchScreen.js) in a real browser.
//
//   node tests/e2e/match-flow.mjs            # phone portrait + landscape, desktop, 320px phone
//   node tests/e2e/match-flow.mjs --stub     # force the dev PlayView stub (src/match/devPlayStub.js)
//   node tests/e2e/match-flow.mjs --only=portrait
//
// Per viewport:
//   A. a full autoplay game at 1-minute quarters (bot plays every down) until postGame, with
//      screenshots + HUD layout checks at the coin toss, a kick return, pre-snap, an opponent
//      drive text box, a decision modal and the final overlay; the final Continue is clicked.
//   B. manual HUD interactions on a bot-played game: timeout by tapping the clock, Change Play
//      (button + C key), pause menu (clock frozen, sound toggle, resume, Esc), a 4th-down decision
//      clicked in the modal, the end-of-half FG button (window forced open on a held snap), then
//      Quit to hub (the game must stay unplayed, also in storage).
//   C. (portrait, desktop) a hand-driven game: the coin banner skips on tap, window blur / hidden tab
//      auto-pause, rotation mid-play (portrait), and — with the real PlayView — a held slingshot
//      drag (aim arc screenshot).
//   D. (portrait) the clock running out before the snap withdraws the play ("TIME!").
//   F. (portrait) 3- and 1-minute quarters: timeouts per half (3 / 2) show as scorebug pips.
// Fails (exit 1) on console errors, layout problems or broken flow. Screenshots: test-results/.

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withBrowser } from './harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const STUB = args.includes('--stub');
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').slice(7);
const SPEED = 6;
const REAL_VIEW = existsSync(join(ROOT, 'src/play/view/PlayView.js'));

const VIEWPORTS = [
  { name: 'portrait', opts: { mobile: true }, runs: 'ABCDF' },
  { name: 'landscape', opts: { mobile: true, landscape: true }, runs: 'AB' },
  { name: 'desktop', opts: { viewport: { width: 1280, height: 720 } }, runs: 'ABC' },
  { name: 'narrow', opts: { mobile: true, viewport: { width: 320, height: 568 } }, runs: 'A' },
].filter((v) => !ONLY || v.name === ONLY);

const problems = [];
const fail = (msg) => { problems.push(msg); console.log(`  FAIL ${msg}`); };
const ok = (msg) => console.log(`  ok   ${msg}`);
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

/** Fresh career + register the match screen (and a postGame stand-in if the UI one is missing). */
async function setupCareer(page, seed, settings = {}) {
  return page.evaluate(async ({ seed, settings }) => {
    const app = window.__app;
    const F = await import('/src/franchise/index.js');
    app.updateSettings({ quarterMinutes: 1, sound: false, driveDirection: 'right', showTips: false, ...settings });
    app.save = F.newFranchise({ coachName: 'QA', teamId: 'BOS', seed, difficulty: 'medium' });
    app.persist();
    const mod = await import('/src/match/MatchScreen.js');
    app.register('match', mod.MatchScreen);
    if (!app.screens.has('postGame')) {
      app.register('postGame', class { constructor(a, p) { this.p = p; } mount(root) { root.textContent = 'POSTGAME'; } unmount() {} });
    }
    window.__F = F;
    return F.nextUserGame(app.save).id;
  }, { seed, settings });
}

/** HUD / modal layout problems for the current frame. */
async function layoutProblems(page) {
  return page.evaluate(() => {
    const W = innerWidth;
    const H = innerHeight;
    const out = [];
    const vis = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return null;
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return null;
      return r;
    };
    if (document.documentElement.scrollWidth > W + 1) out.push(`page scrolls horizontally (${document.documentElement.scrollWidth} > ${W})`);
    const name = (el) => `.${[...el.classList].join('.')}`;
    const parts = ['.mh-bug', '.mh-pause', '.mh-cp', '.mh-fg', '.mh-box', '.mh-banner', '.mh-final', '.mh-flash', '.mh-overlay .modal'];
    const rects = {};
    for (const sel of parts) {
      const el = document.querySelector(sel);
      const r = vis(el);
      if (!r) continue;
      rects[sel] = r;
      if (r.left < -0.5 || r.top < -0.5 || r.right > W + 0.5 || r.bottom > H + 0.5) out.push(`${sel} off-screen (${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} in ${W}x${H})`);
    }
    // Touch targets: measure what a finger can actually hit (elementFromPoint), so visually slim
    // controls with an invisible ::after hit area (landscape scorebug) count at their real size.
    const hitSize = (el, r) => {
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const on = (x, y) => { const e = document.elementFromPoint(x, y); return !!e && (e === el || el.contains(e)); };
      if (!on(cx, cy)) return null; // covered by a modal: not tappable right now
      let t = cy; let b = cy; let l = cx; let rr = cx;
      while (t > 0 && on(cx, t - 1)) t--;
      while (b < H - 1 && on(cx, b + 1)) b++;
      while (l > 0 && on(l - 1, cy)) l--;
      while (rr < W - 1 && on(rr + 1, cy)) rr++;
      return { w: rr - l + 1, h: b - t + 1 };
    };
    for (const el of document.querySelectorAll('#hud button, .mh-overlay button')) {
      const r = vis(el);
      if (!r) continue;
      const hs = hitSize(el, r);
      if (hs && (hs.w < 43.5 || hs.h < 43.5)) out.push(`button ${name(el)} touch target smaller than 44px (${Math.round(hs.w)}x${Math.round(hs.h)}, drawn ${Math.round(r.width)}x${Math.round(r.height)})`);
    }
    const overlap = (a, b) => a && b && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
    const pairs = [['.mh-bug', '.mh-pause'], ['.mh-cp', '.mh-fg'], ['.mh-bug', '.mh-box'], ['.mh-bug', '.mh-banner'], ['.mh-bug', '.mh-final'], ['.mh-box', '.mh-cp'], ['.mh-final', '.mh-cp']];
    for (const [a, b] of pairs) if (overlap(rects[a], rects[b])) out.push(`${a} overlaps ${b}`);
    // keep the critical play area clear: top bar and bottom buttons hug the edges
    const bug = rects['.mh-bug'];
    const landscape = W >= H;
    // landscape phones get the slim one-row bug (~32px): keep it under ~11% of the screen height
    const slim = landscape && H <= 500;
    if (bug && bug.bottom > (slim ? Math.max(40, H * 0.11) : Math.max(landscape ? 66 : 84, H * (landscape ? 0.15 : 0.09)))) out.push(`scorebug too tall: bottom at ${Math.round(bug.bottom)} of ${H}`);
    for (const sel of ['.mh-cp', '.mh-fg']) {
      const r = rects[sel];
      if (r && r.top < H * (landscape ? (slim ? 0.86 : 0.8) : 0.9)) out.push(`${sel} intrudes into the field: top ${Math.round(r.top)} of ${H}`);
    }
    // legibility: no HUD text under 8px
    for (const el of document.querySelectorAll('#hud .mhud *, .mh-overlay *')) {
      if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
      if (!vis(el)) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < 7.5) out.push(`text "${el.textContent.trim().slice(0, 20)}" is ${fs}px`);
    }
    return out;
  });
}

const screenState = (page) => page.evaluate(() => {
  const s = window.__match;
  const app = window.__app;
  if (!s || !s.m) return { screen: app.currentName };
  const st = s.m.state;
  return {
    screen: app.currentName,
    mode: s.mode,
    step: s.step && s.step.type,
    kind: s.step && s.step.kind,
    q: st.quarter,
    clock: st.clock,
    score: `${st.score.user}-${st.score.opp}`,
    paused: s.paused,
    frozen: s.freeze,
    pending: window.__qaPending || null,
    real: !!(s.views && s.views.real),
  };
});

async function snap(page, shot, vp, key) {
  await page.waitForTimeout(160);
  await shot(`match-${vp}-${key}`);
  const p = await layoutProblems(page);
  for (const x of p) fail(`[${vp}] ${key}: ${x}`);
  if (!p.length) ok(`[${vp}] ${key}: layout`);
}

// ------------------------------------------------------------------------------- A. autoplay

async function runAutoplay(vp, ctx) {
  const { page, shot } = ctx;
  // landscape exercises the 'alternate' drive direction (right in the 1st half, left in the 2nd)
  const dir = vp === 'landscape' ? 'alternate' : vp === 'desktop' ? 'left' : 'right';
  const gameId = await setupCareer(page, 1001, { driveDirection: dir });
  await page.evaluate(({ gameId, speed, stub }) => {
    const app = window.__app;
    window.__qaTaken = {};
    window.__qaPending = null;
    window.__qaDrive = [];
    app.go('match', { gameId, autoplay: true, speed, stub });
    const s = window.__match;
    s.qaOnStep = (step) => {
      if (s.view) {
        const v = s.view;
        window.__qaDrive.push({ half: s.m.state.half, left: !!(v.driveLeft ?? (v.opts && v.opts.driveLeft)), mirror: !!(v.camera && v.camera.mirror) });
      }
      let key = step.type;
      if (step.type === 'play') key = step.twoPoint ? 'two-point' : step.canFieldGoal ? 'presnap-fg' : 'presnap';
      if (step.type === 'decision') key = `decision-${step.kind}`;
      if (step.type === 'auto') key = `auto-${step.kind}`;
      if (step.type === 'kick') key = `kick-${step.kind}`;
      const want = ['coin', 'kick_return', 'presnap', 'presnap-fg', 'opp_drive', 'decision-fourth', 'decision-conversion', 'decision-onside', 'halftime', 'kick-pat', 'kick-fg', 'auto-punt', 'final'];
      if (!want.includes(key) || window.__qaTaken[key]) return;
      if (key === 'presnap' && !(s.m.state.down > 1)) return; // wait for a mid-drive snap (running clock, D&D)
      window.__qaTaken[key] = true;
      window.__qaPending = key;
      s.freeze = true;
    };
  }, { gameId, speed: SPEED, stub: STUB });
  const t0 = Date.now();
  let last = '';
  let real = null;
  while (Date.now() - t0 < 6 * 60 * 1000) {
    await page.waitForTimeout(120);
    const st = await screenState(page);
    if (st.screen === 'postGame') break;
    if (real === null && st.mode && st.mode !== 'loading') real = st.real;
    const k = `${st.q}|${st.score}|${st.mode}`;
    if (k !== last) last = k;
    if (st.pending) {
      if (st.pending === 'opp_drive') await page.waitForTimeout(120);
      await snap(page, shot, vp, st.pending);
      if (st.pending === 'final') {
        const fin = await page.evaluate(() => ({ text: document.querySelector('.mh-final')?.textContent || '', btn: !!document.querySelector('.mh-continue') }));
        check(/FINAL/.test(fin.text) && fin.btn, `[${vp}] final overlay shows the score and a Continue button`);
        await page.evaluate(() => { window.__match.autoDecisions = false; });
      }
      await page.evaluate(() => { window.__qaPending = null; window.__match.freeze = false; });
      if (st.pending === 'final') {
        await page.locator('.mh-continue').click();
      }
    }
  }
  const end = await page.evaluate(() => {
    const app = window.__app;
    const F = window.__F;
    const p = app.current && app.current.params;
    const g = app.save.season.schedule.find((x) => x.id === (p && p.gameId));
    const stored = JSON.parse(localStorage.getItem('pocketgridiron.save0') || 'null');
    const sg = stored && stored.season.schedule.find((x) => x.id === (p && p.gameId));
    return {
      screen: app.currentName,
      params: p ? { gameId: p.gameId, hasResult: !!p.result, hasSummary: !!p.summary, user: p.result?.userScore, opp: p.result?.oppScore, stats: Object.keys(p.result?.stats || {}).length, hits: Array.isArray(p.result?.hits) } : null,
      played: !!(g && g.played),
      storedPlayed: !!(sg && sg.played),
      record: F.userTeam(app.save).record,
    };
  });
  check(end.screen === 'postGame', `[${vp}] full autoplay game reaches postGame (${Math.round((Date.now() - t0) / 1000)} s, PlayView ${real ? 'real' : 'stub'})`);
  if (end.params) {
    check(end.params.hasResult && end.params.hasSummary && end.params.gameId === gameId, `[${vp}] postGame params {gameId, result, summary} (final ${end.params.user}-${end.params.opp}, ${end.params.stats} player stat lines, hits array ${end.params.hits})`);
  }
  check(end.played && end.storedPlayed, `[${vp}] result applied to the save and persisted`);
  const taken = await page.evaluate(() => Object.keys(window.__qaTaken));
  ok(`[${vp}] screenshots: ${taken.join(', ')}`);
  const drive = await page.evaluate(() => window.__qaDrive);
  const want = (half) => (dir === 'left' ? true : dir === 'right' ? false : half === 2);
  const bad = drive.filter((d) => d.left !== want(d.half));
  check(drive.length > 0 && bad.length === 0, `[${vp}] driveDirection '${dir}' reaches every PlayView (${drive.length} views, ${bad.length} wrong)`);
  if (vp !== 'portrait' && vp !== 'narrow' && real) {
    const mirrored = drive.filter((d) => d.mirror !== want(d.half));
    check(mirrored.length === 0, `[${vp}] landscape camera mirrors exactly when driving left`);
  }
}

// ------------------------------------------------------------------------------- B. manual HUD

async function runManualHud(vp, ctx) {
  const { page, shot } = ctx;
  const gameId = await setupCareer(page, 2002);
  await page.evaluate(({ gameId, stub }) => {
    window.__app.go('match', { gameId, autoplay: true, autoDecisions: false, speed: 3, stub });
    const s = window.__match;
    // hold the bot's snap whenever a timeout could be called (clock running before the snap)
    s.holdSnap = (m, step) => step.type === 'play' && !step.twoPoint && m.canCallTimeout();
  }, { gameId, stub: STUB });

  const clickDecision = async (prefer) => {
    const sel = await page.evaluate((prefer) => {
      for (const id of prefer) if (document.querySelector(`.mh-opt[data-opt="${id}"]`)) return `.mh-opt[data-opt="${id}"]`;
      return '.mh-opt';
    }, prefer);
    await page.locator(sel).first().click();
  };

  // 1) reach a pre-snap play with the clock running, handling decisions by clicking
  const t0 = Date.now();
  let reached = false;
  while (Date.now() - t0 < 120000) {
    await page.waitForTimeout(100);
    const st = await page.evaluate(() => {
      const s = window.__match;
      if (!s || !s.m) return {};
      return { mode: s.mode, presnapTO: s.presnap() && s.m.canCallTimeout(), screen: window.__app.currentName };
    });
    if (st.presnapTO) { reached = true; break; }
    if (st.mode === 'decision') {
      await clickDecision(['go', 'pat', 'kickoff']);
    }
    if (st.mode === 'final') break;
  }
  check(reached, `[${vp}] reached a pre-snap play with the clock running (timeout available)`);
  if (!reached) return;
  await page.evaluate(() => { window.__match.holdSnap = true; });
  await snap(page, shot, vp, 'manual-presnap');

  // 2) timeout via the clock (or the T key on desktop)
  const before = await page.evaluate(() => ({ to: window.__match.m.state.timeouts.user, running: window.__match.m.state.clockRunning, can: document.querySelector('.mh-clock').classList.contains('can-to') }));
  check(before.can && before.running, `[${vp}] clock is highlighted as tappable while it runs pre-snap`);
  if (vp === 'desktop') await page.keyboard.press('t');
  else await page.locator('.mh-clock').click();
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => ({ to: window.__match.m.state.timeouts.user, running: window.__match.m.state.clockRunning, flash: document.querySelector('.mh-flash')?.textContent || '', hidden: document.querySelector('.mh-flash')?.hidden }));
  check(after.to === before.to - 1 && !after.running, `[${vp}] timeout via ${vp === 'desktop' ? 'T key' : 'clock tap'}: ${before.to} -> ${after.to}, clock stopped`);
  check(!after.hidden && /TIMEOUT/.test(after.flash), `[${vp}] timeout toast shown`);
  await snap(page, shot, vp, 'manual-timeout');

  // 3) change play
  const cp0 = await page.evaluate(() => ({ left: window.__match.m.state.audiblesLeft, p0: window.__match.view.sim.players[0] }));
  const cpVisible = await page.locator('.mh-cp').isVisible();
  check(cpVisible, `[${vp}] Change Play button visible pre-snap`);
  if (cp0.left > 0) {
    await page.evaluate(() => { window.__cpMark = window.__match.view.sim.players[0]; });
    await page.locator('.mh-cp').click();
    await page.waitForTimeout(80);
    const cp1 = await page.evaluate(() => ({ left: window.__match.m.state.audiblesLeft, rebuilt: window.__match.view.sim.players[0] !== window.__cpMark, badge: document.querySelector('.mh-cp .mh-badge').textContent }));
    check(cp1.left === cp0.left - 1 && cp1.rebuilt && cp1.badge === String(cp1.left), `[${vp}] Change Play: audibles ${cp0.left} -> ${cp1.left}, play re-rolled, badge ${cp1.badge}`);
    if (cp1.left > 0) {
      await page.keyboard.press('c');
      await page.waitForTimeout(60);
      const cp2 = await page.evaluate(() => window.__match.m.state.audiblesLeft);
      check(cp2 === cp1.left - 1, `[${vp}] C key changes the play (${cp1.left} -> ${cp2})`);
    }
  } else ok(`[${vp}] no audibles left to test`);

  // 4) pause menu: clock frozen, sound toggle, resume, Esc
  await page.evaluate(() => { window.__match.m.state.clockRunning = true; }); // make a frozen clock observable
  await page.locator('.mh-pause').click();
  await page.waitForTimeout(100);
  const c1 = await page.evaluate(() => window.__match.m.state.clock);
  await page.waitForTimeout(600);
  const p1 = await page.evaluate(() => ({ paused: window.__match.paused, menu: !!document.querySelector('.mh-pausebox'), clock: window.__match.m.state.clock, viewPaused: window.__match.view && window.__match.view.paused }));
  check(p1.paused && p1.menu && p1.viewPaused, `[${vp}] pause button opens the pause menu (PlayView paused)`);
  check(Math.abs(p1.clock - c1) < 1e-9, `[${vp}] clock does not tick while paused`);
  await snap(page, shot, vp, 'manual-pause');
  const s0 = await page.evaluate(() => window.__app.settings.sound);
  await page.locator('.mh-toggle[data-key="sound"]').click();
  const s1 = await page.evaluate(() => window.__app.settings.sound);
  await page.locator('.mh-toggle[data-key="sound"]').click();
  const s2 = await page.evaluate(() => window.__app.settings.sound);
  check(s1 === !s0 && s2 === s0, `[${vp}] sound toggle in the pause menu`);
  await page.locator('.mh-resume').click();
  await page.waitForTimeout(150);
  const r1 = await page.evaluate(() => ({ paused: window.__match.paused, menu: !!document.querySelector('.mh-pausebox'), clock: window.__match.m.state.clock }));
  check(!r1.paused && !r1.menu && r1.clock < c1, `[${vp}] resume closes the menu and the clock runs again`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(60);
  const e1 = await page.evaluate(() => window.__match.paused);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(60);
  const e2 = await page.evaluate(() => window.__match.paused);
  check(e1 && !e2, `[${vp}] Esc toggles the pause menu`);

  // 5) force a 4th down on this snap and decide by clicking the modal
  await page.evaluate(() => {
    const s = window.__match;
    s.m.state.down = 3;
    s.m.state.toGo = 99; // whatever happens short of a TD, the next down is 4th
    s.holdSnap = false;
    window.__qaPending = null;
    s.qaOnStep = (step) => {
      if (step.type === 'decision' || step.type === 'opp_drive') { s.freeze = true; window.__qaPending = step.type === 'decision' ? `decision-${step.kind}` : 'opp_drive'; }
    };
  });
  let decided = false;
  let sawDrive = false;
  const t1 = Date.now();
  while (Date.now() - t1 < 90000 && !(decided && sawDrive)) {
    await page.waitForTimeout(100);
    const st = await screenState(page);
    if (st.mode === 'final' || st.screen !== 'match') break;
    if (!st.pending) continue;
    if (st.pending.startsWith('decision')) {
      await snap(page, shot, vp, `manual-${st.pending}`);
      await page.evaluate(() => { window.__qaPending = null; window.__match.freeze = false; });
      const id0 = await page.evaluate(() => window.__match.step.id);
      await clickDecision(['punt', 'fg', 'go', 'pat', 'kickoff']);
      await page.waitForTimeout(120);
      const moved = await page.evaluate((id0) => window.__match.step.id !== id0 && !document.querySelector('.mh-decide'), id0);
      check(moved, `[${vp}] ${st.pending} resolved by clicking an option`);
      decided = true;
    } else if (st.pending === 'opp_drive') {
      await page.waitForTimeout(150);
      const box = await page.evaluate(() => ({ text: document.querySelector('.mh-box')?.textContent || '', dim: !document.querySelector('.mh-dim').hidden }));
      check(box.text.length > 5 && box.dim, `[${vp}] opponent drive shows a text box over a dimmed field`);
      await snap(page, shot, vp, 'manual-oppdrive');
      sawDrive = true;
      await page.evaluate(() => { window.__qaPending = null; window.__match.freeze = false; });
    }
  }
  check(decided, `[${vp}] a decision modal appeared and was clicked`);

  // 6) end-of-half FG button: hold the next scrimmage snap, open the FG window, kick
  await page.evaluate(() => {
    const s = window.__match;
    s.qaOnStep = null;
    s.freeze = false;
    window.__qaPending = null;
    s.holdSnap = (m, step) => step.type === 'play' && !step.twoPoint;
  });
  const t2 = Date.now();
  let held = false;
  while (Date.now() - t2 < 60000) {
    await page.waitForTimeout(100);
    const st = await page.evaluate(() => ({ mode: window.__match?.mode, pre: !!window.__match?.presnap() && window.__match.step.type === 'play' && !window.__match.step.twoPoint }));
    if (st.pre) { held = true; break; }
    if (st.mode === 'decision') await clickDecision(['go', 'pat', 'kickoff']);
    if (st.mode === 'final' || !st.mode) break;
  }
  if (held) {
    const fg0 = await page.evaluate(() => {
      const m = window.__match.m;
      const visibleBefore = !document.querySelector('.mh-fg').hidden;
      m.state.quarter = 2; // test-only: open the end-of-half window (Q2, <= 20 s) within range
      m.state.clock = 15;
      m.state.clockRunning = false;
      m.state.ballOn = 78;
      return { visibleBefore, avail: m.fieldGoalAvailable(), dist: m.fieldGoalDistance() };
    });
    await page.waitForTimeout(120);
    const lbl = await page.evaluate(() => { const b = document.querySelector('.mh-fg'); return b && !b.hidden ? b.textContent : null; });
    check(fg0.avail && lbl === `FG ${fg0.dist} YD`, `[${vp}] FG button appears live when the window opens (${lbl})`);
    await snap(page, shot, vp, 'manual-fg-button');
    if (lbl) {
      await page.locator('.mh-fg').click();
      await page.waitForTimeout(150);
      const k = await page.evaluate(() => ({ type: window.__match.step.type, kind: window.__match.step.kind, sit: document.querySelector('.mh-sit').textContent }));
      check(k.type === 'kick' && k.kind === 'fg' && /FIELD GOAL/.test(k.sit), `[${vp}] FG button starts the kick (${k.sit})`);
    }
  } else ok(`[${vp}] (skipped FG button check: no scrimmage snap reached)`);

  // 7) quit to hub: confirm, the game stays unplayed (memory and storage)
  await page.evaluate(() => { const s = window.__match; if (s) { s.qaOnStep = null; s.freeze = false; } });
  if ((await page.evaluate(() => window.__app.currentName)) === 'match') {
    await page.locator('.mh-pause').click();
    await page.locator('.mh-quit').click();
    await page.waitForTimeout(80);
    await snap(page, shot, vp, 'manual-quit-confirm');
    await page.locator('.mh-quit-yes').click();
    await page.waitForFunction(() => window.__app.currentName === 'hub', null, { timeout: 5000 }).catch(() => {});
    const q = await page.evaluate((gameId) => {
      const app = window.__app;
      const g = app.save.season.schedule.find((x) => x.id === gameId);
      const stored = JSON.parse(localStorage.getItem('pocketgridiron.save0') || 'null');
      const sg = stored && stored.season.schedule.find((x) => x.id === gameId);
      return { screen: app.currentName, played: g.played, storedPlayed: sg ? sg.played : null, hud: document.querySelectorAll('#hud .mhud').length, stage: !document.getElementById('stage').hidden, match: !!window.__match };
    }, gameId);
    check(q.screen === 'hub' && !q.played && q.storedPlayed === false, `[${vp}] quit to hub leaves the game unplayed (memory + storage)`);
    check(q.hud === 0 && !q.stage && !q.match, `[${vp}] HUD, stage and hooks cleaned up after quitting`);
  }
}

// ------------------------------------------------------------------------------- C. hand-driven

async function runHandDriven(vp, ctx) {
  const { page, shot } = ctx;
  const gameId = await setupCareer(page, 3003);
  await page.evaluate(({ gameId, stub }) => window.__app.go('match', { gameId, stub }), { gameId, stub: STUB });
  await page.waitForFunction(() => window.__match && window.__match.mode === 'banner', null, { timeout: 8000 });
  const box = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  await page.waitForTimeout(400);
  const id0 = await page.evaluate(() => window.__match.step.id);
  await page.mouse.click(box.w / 2, box.h / 2);
  await page.waitForTimeout(150);
  const id1 = await page.evaluate(() => window.__match.step.id);
  check(id1 !== id0, `[${vp}] a tap skips the coin-toss banner`);

  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForTimeout(60);
  const b1 = await page.evaluate(() => ({ paused: window.__match.paused, menu: !!document.querySelector('.mh-pausebox') }));
  check(b1.paused && b1.menu, `[${vp}] window blur auto-pauses`);
  await page.locator('.mh-resume').click();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.hidden;
  });
  await page.waitForTimeout(60);
  const v1 = await page.evaluate(() => window.__match.paused);
  check(v1, `[${vp}] hidden tab auto-pauses`);
  await page.keyboard.press('Escape');

  // walk to the first scrimmage snap: taps advance banners / drive boxes; kick returns run out
  const t0 = Date.now();
  let atSnap = false;
  while (Date.now() - t0 < 60000) {
    const st = await page.evaluate(() => {
      const s = window.__match;
      return { mode: s.mode, step: s.step && s.step.type, pre: s.presnap(), real: s.views && s.views.real, sel: s.view && s.view.sim && s.view.sim.phase };
    });
    if (st.mode === 'play' && st.step === 'play' && st.pre) { atSnap = true; break; }
    if (st.mode === 'decision') await page.locator('.mh-opt').first().click();
    else if (st.mode === 'banner' || st.mode === 'opp_drive') await page.mouse.click(box.w / 2, box.h / 2);
    await page.waitForTimeout(250);
  }
  check(atSnap, `[${vp}] reached a pre-snap scrimmage play by hand`);
  if (!atSnap) return;
  if (vp === 'portrait') await rotateCheck(vp, ctx);
  const real = await page.evaluate(() => !!window.__match.views.real);
  if (real) {
    // slingshot: press near the QB and drag back (portrait: down, landscape: away from the goal)
    const portrait = box.h > box.w;
    const sx = box.w / 2;
    const sy = box.h / 2;
    const ex = portrait ? sx + 30 : sx - 120;
    const ey = portrait ? sy + 140 : sy + 20;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    for (let i = 1; i <= 14; i++) {
      await page.mouse.move(sx + ((ex - sx) * i) / 14, sy + ((ey - sy) * i) / 14);
      await page.waitForTimeout(25);
    }
    await page.waitForTimeout(250);
    const aim = await page.evaluate(() => ({ phase: window.__match.view.sim.phase, aim: !!window.__match.view.sim.aim, snapped: window.__match.snapped, live: window.__match.m.state.clockRunning }));
    await snap(page, shot, vp, 'aiming');
    check(aim.phase === 'dropback' && aim.snapped, `[${vp}] backward drag snaps a drop-back (aim ${aim.aim}, clock running ${aim.live})`);
    await page.mouse.up();
  } else {
    await page.mouse.click(box.w / 2, box.h / 2); // stub: tap to snap
    await page.waitForTimeout(400);
    const sn = await page.evaluate(() => window.__match.snapped);
    check(sn, `[${vp}] stub play snaps on tap and reports onSnap`);
  }
  await page.waitForFunction(() => !window.__match || window.__match.submitted || window.__match.mode !== 'play', null, { timeout: 20000 }).catch(() => {});
  const res = await page.evaluate(() => ({ submitted: window.__match.submitted, mode: window.__match.mode }));
  check(res.submitted || res.mode !== 'play', `[${vp}] the hand-driven play was submitted at the whistle`);
}

// ------------------------------------------------------------------------------- D. clock out

async function runClockOut(vp, ctx) {
  const { page } = ctx;
  const gameId = await setupCareer(page, 4004);
  await page.evaluate(({ gameId, stub }) => {
    window.__app.go('match', { gameId, autoplay: true, speed: 8, stub });
    const s = window.__match;
    window.__withdrawn = 0;
    window.__after = null;
    // never snap while the clock runs: it must expire pre-snap and withdraw the play
    s.holdSnap = (m, step) => step.type === 'play' && m.state.clockRunning;
    const m = s.m;
    const orig = m.tickClock.bind(m);
    m.tickClock = (dt) => {
      const r = orig(dt);
      if (r) window.__withdrawn += 1;
      return r;
    };
    s.qaOnStep = (step) => {
      if (window.__withdrawn && !window.__after) {
        window.__after = { type: step.type, flash: document.querySelector('.mh-flash').textContent, view: !!s.view };
        s.freeze = true;
      }
    };
  }, { gameId, stub: STUB });
  await page.waitForFunction(() => !!window.__after, null, { timeout: 120000 }).catch(() => {});
  const a = await page.evaluate(() => window.__after);
  check(!!a && ['quarter_end', 'halftime', 'final', 'ot_start'].includes(a.type) && a.flash === 'TIME!' && !a.view,
    `[${vp}] clock expiring before the snap withdraws the play (TIME!) and moves on to ${a ? a.type : 'nothing'}`);
}

// ------------------------------------------------------------------------------- F. quarter length

async function runQuarterLength(vp, ctx) {
  const { page } = ctx;
  for (const minutes of [3, 1]) {
    const gameId = await setupCareer(page, 5005 + minutes, { quarterMinutes: minutes });
    await page.evaluate(({ gameId, stub }) => {
      window.__app.go('match', { gameId, autoplay: true, speed: 4, stub });
      window.__match.holdSnap = (m, step) => step.type === 'play';
    }, { gameId, stub: STUB });
    await page.waitForFunction(() => window.__match && window.__match.presnap() && window.__match.step.type === 'play', null, { timeout: 60000 }).catch(() => {});
    const r = await page.evaluate(() => ({
      pips: document.querySelectorAll('.mh-pips i').length,
      on: document.querySelectorAll('.mh-pips i.on').length,
      timeouts: window.__match.m.state.timeouts.user,
      qm: window.__match.m.state.quarterMinutes,
      start: window.__match.m.state.clock,
    }));
    const want = minutes === 3 ? 3 : 2;
    check(r.qm === minutes && r.pips === want && r.on === want && r.timeouts === want && r.start <= minutes * 60,
      `[${vp}] ${minutes}-minute quarters: ${r.pips} timeout pips (${r.on} lit), clock from ${minutes}:00`);
    await page.evaluate(() => window.__app.go('hub'));
  }
}

// ------------------------------------------------------------------------------- E. rotation

async function rotateCheck(vp, ctx) {
  const { page, shot } = ctx;
  const before = await page.evaluate(() => ({ ...window.__match.insets }));
  const vs = page.viewportSize();
  await page.setViewportSize({ width: vs.height, height: vs.width });
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({ ins: { ...window.__match.insets }, vin: window.__match.view && window.__match.view.opts && window.__match.view.opts.insets }));
  await snap(page, shot, vp, 'rotated');
  check(after.ins.top !== before.top || after.ins.bottom !== before.bottom, `[${vp}] rotating mid-play re-measures the HUD insets (top ${before.top} -> ${after.ins.top})`);
  if (after.vin) check(after.vin.top === after.ins.top, `[${vp}] the live PlayView sees the new insets`);
  await page.setViewportSize(vs);
  await page.waitForTimeout(300);
}

// ------------------------------------------------------------------------------- main

console.log(`match-flow: PlayView ${STUB ? 'stub (forced)' : REAL_VIEW ? 'real (src/play/view/PlayView.js)' : 'stub (real PlayView missing)'}`);
for (const v of VIEWPORTS) {
  for (const [label, fn] of [['A autoplay', runAutoplay], ['B manual HUD', runManualHud], ['C hand-driven', runHandDriven], ['D clock out', runClockOut], ['F quarter length', runQuarterLength]]) {
    if (!v.runs.includes(label[0])) continue;
    console.log(`[${v.name}] ${label}`);
    await withBrowser(v.opts, async (ctx) => {
      const { page, errors } = ctx;
      const extra = [];
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const loc = m.location() || {};
        // the real PlayView is optional until it lands: its 404 is expected then
        if (!REAL_VIEW && /PlayView\.js/.test(loc.url || '')) extra.push(m.text());
      });
      try {
        await fn(v.name, ctx);
      } catch (e) {
        fail(`[${v.name}] ${label} threw: ${e.message.split('\n')[0]}`);
        await ctx.shot(`match-${v.name}-error`).catch(() => {});
      }
      const errs = errors.filter((e) => !(extra.length && /Failed to load resource/.test(e)));
      check(errs.length === 0, `[${v.name}] ${label}: no console errors${errs.length ? ` ${JSON.stringify(errs.slice(0, 5))}` : ''}`);
    });
  }
}
console.log(problems.length ? `\nFAIL: ${problems.length} problem(s)` : '\nPASS');
process.exit(problems.length ? 1 : 0);
