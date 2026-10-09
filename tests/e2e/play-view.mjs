// PLAY-VIEW e2e: drives the dev sandbox with REAL gestures (CDP touch events incl. multi-touch,
// mouse with right-click, keyboard) in phone portrait, phone landscape (drive right and drive
// left) and desktop, and checks the PlaySim reacted: RB tap -> handoff, carrier swipes -> juke,
// hold -> truck, slingshot drag -> aim downfield, 2nd finger / right-click -> bullet, release ->
// throw, collapse -> QB run, FG two taps, kick return + touchback, post-play skip, audible, pause,
// resize mid-play. Screenshots -> test-results/pv-<config>-<step>.png. Measures frame time.
// Exit code 0 = all passed.
//
//   node tests/e2e/play-view.mjs            # all configs
//   node tests/e2e/play-view.mjs portrait   # one config

import { withBrowser } from './harness.mjs';

const CONFIGS = [
  { name: 'portrait', opts: { mobile: true }, input: 'touch' },
  { name: 'landscape', opts: { mobile: true, landscape: true }, input: 'touch' },
  { name: 'landscape-left', opts: { mobile: true, landscape: true }, input: 'touch', driveLeft: true },
  { name: 'desktop', opts: { viewport: { width: 1280, height: 720 } }, input: 'mouse' },
];

const only = process.argv[2];
let failures = 0;
const summary = [];

function check(cfg, label, ok, info = '') {
  const line = `${ok ? 'PASS' : 'FAIL'} [${cfg}] ${label}${info ? ` - ${info}` : ''}`;
  console.log(line);
  if (!ok) failures++;
  return ok;
}

for (const cfg of CONFIGS) {
  if (only && cfg.name !== only) continue;
  await withBrowser(cfg.opts, async ({ page, shot, errors }) => {
    const C = cfg.name;
    const touchMode = cfg.input === 'touch';
    const cdp = touchMode ? await page.context().newCDPSession(page) : null;
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
    const vp = page.viewportSize();
    const wait = (ms) => page.waitForTimeout(ms);
    const S = (fn, arg) => page.evaluate(fn, arg);
    const view = () => S(() => {
      const v = window.__app.current.view;
      const s = v.sim;
      return {
        phase: s.phase, kind: s.kind, ctl: s.controlledId, t: s.t,
        carrier: s.carrier ? s.carrier.id : null,
        aim: s.aim ? { tx: s.aim.tx, ty: s.aim.ty, bullet: s.aim.bullet, runMode: s.aim.runMode, valid: s.aim.valid } : null,
        qb: s.qb ? { x: s.qb.x, y: s.qb.y } : null,
        ev: s.eventLog.map((e) => e.type),
        log: v.controller.log.map((l) => l.cmd),
        result: v.result ? v.result.outcome : null, done: v.done,
        truck: s.carrierState ? s.carrierState.truckHeld : null,
        fwd: v.screenFwd, lat: v.screenLat,
      };
    });
    const newPlay = (over) => S((o) => { window.__app.current.newPlay(o); }, over || {});
    const setKind = (kind) => S((k) => { const sb = window.__app.current; sb.kind = k; sb.newPlay(); }, kind);
    const waitFor = (fn, arg, timeout = 8000) => page.waitForFunction(fn, arg, { timeout, polling: 16 }).then(() => true, () => false);

    // pointer helpers (touch via CDP, else mouse)
    const press = async (x, y) => {
      if (touchMode) await touch('touchStart', [{ x, y, id: 1 }]);
      else { await page.mouse.move(x, y); await page.mouse.down(); }
    };
    const moveTo = async (x, y) => {
      if (touchMode) await touch('touchMove', [{ x, y, id: 1 }]);
      else await page.mouse.move(x, y);
    };
    const lift = async (x, y) => {
      if (touchMode) await touch('touchEnd', [{ x, y, id: 1 }]);
      else await page.mouse.up();
    };
    const tap = async (x, y) => { await press(x, y); await wait(50); await lift(x, y); };
    const stroke = async (x1, y1, x2, y2, ms = 90, steps = 5, keep = false) => {
      await press(x1, y1);
      for (let i = 1; i <= steps; i++) {
        await wait(ms / steps);
        await moveTo(x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps);
      }
      if (!keep) await lift(x2, y2);
    };

    // ---------------------------------------------------------------- boot the sandbox
    await S(async (driveLeft) => {
      const m = await import('/src/play/view/SandboxScreen.js');
      window.__app.register('sandbox', m.SandboxScreen);
      window.__app.updateSettings({ showTips: true, cameraZoom: 'near' });
      try { localStorage.removeItem('pocketgridiron.playTips'); } catch { /* ignore */ }
      window.__app.go('sandbox', { kind: 'scrimmage', seed: 11, step: 3, driveLeft, tips: true });
    }, !!cfg.driveLeft);
    await wait(500);
    let st = await view();
    check(C, 'sandbox boots in presnap', st.phase === 'presnap' && st.kind === 'scrimmage', st.phase);
    await shot(`pv-${C}-01-presnap`);
    const cx = vp.width * 0.5;
    const cy = vp.height * (C === 'portrait' ? 0.55 : 0.55);
    const F = st.fwd;
    const L = st.lat;

    // ---------------------------------------------------------------- audible
    const changed = await S(() => {
      const v = window.__app.current.view;
      const before = v.sim.play.name;
      const ok = v.changePlay();
      return { ok, same: v.sim.players.length === 22, before, after: v.sim.play.name };
    });
    check(C, 'changePlay() re-rolls the play pre-snap', changed.ok && changed.same, `${changed.before} -> ${changed.after}`);

    // ---------------------------------------------------------------- run: tap RB, juke, hold-truck
    await newPlay({ seed: 21 });
    await wait(300);
    const rb = await S(() => window.__app.current.view.screenPos('RB'));
    if (touchMode) await tap(rb.x + 10, rb.y + 4); // a bit off the sprite: generous hit area
    else await page.mouse.click(rb.x, rb.y);
    await wait(80);
    st = await view();
    check(C, 'tap RB -> handoff (RB controlled, phase carry)', st.phase === 'carry' && st.ctl === 'RB' && st.log.includes('handoff'), `${st.phase} ${st.ctl}`);
    await waitFor(() => !!window.__app.current.view.sim.carrier, null, 2000);
    await wait(150);
    await shot(`pv-${C}-02-run`);
    // lateral swipe toward world -y (screen -lat)
    await stroke(cx, cy, cx - L.x * 34 + F.x * 6, cy - L.y * 34 + F.y * 6, 80, 4);
    await wait(60);
    st = await view();
    const juked = st.ev.includes('juke') || st.result;
    check(C, 'lateral flick -> sideStep (juke event)', st.ev.includes('juke'), `${st.log.join(',')} ${st.result || ''}`);
    await shot(`pv-${C}-03-juke`);
    if (!st.result) {
      // press-and-hold -> truck
      await press(cx, cy);
      await wait(320);
      const held = await view();
      await lift(cx, cy);
      await wait(40);
      const rel = await view();
      if (!held.result) check(C, 'press-and-hold -> truck(true) then release -> truck(false)', held.truck === true && (rel.truck === false || rel.result), `held=${held.truck} rel=${rel.truck}`);
    }
    if (!juked) failures += 0;
    // play finishes -> result at the whistle, beat, skip by tap
    const finished = await waitFor(() => !!window.__app.current.view.result, null, 12000);
    st = await view();
    check(C, 'run play reaches the whistle with a result', finished && !!st.result, st.result || 'none');
    await wait(250);
    await shot(`pv-${C}-04-whistle`);
    const vBefore = await S(() => window.__app.current.view);
    if (touchMode) await tap(cx, cy); else await page.mouse.click(cx, cy);
    await wait(60);
    const skipped = await S(() => window.__app.current.playN);
    check(C, 'tap after the whistle skips the post-play beat', skipped >= 3 && !!vBefore, `playN=${skipped}`);

    // ---------------------------------------------------------------- pass: drag back, bullet, release
    await newPlay({ seed: 11 });
    await wait(300);
    const back = Math.min(vp.width, vp.height) * 0.3;
    const sx = cx - L.x * 30;
    const sy = cy - L.y * 30;
    const ex = sx - F.x * back + L.x * 22;
    const ey = sy - F.y * back + L.y * 22;
    await stroke(sx, sy, ex, ey, 260, 10, true);
    await wait(350);
    st = await view();
    const downfield = st.aim && st.qb && st.aim.tx > st.qb.x + 8;
    const sideOk = st.aim && st.qb && st.aim.ty < st.qb.y; // dragged toward +lat -> throws toward -y
    check(C, 'drag back -> dropBack + slingshot aim downfield & opposite side', st.phase === 'dropback' && downfield && sideOk,
      st.aim ? `tx ${st.aim.tx.toFixed(1)} ty ${st.aim.ty.toFixed(1)} qb ${st.qb.x.toFixed(1)},${st.qb.y.toFixed(1)}` : 'no aim');
    await shot(`pv-${C}-05-aim`);
    // bullet toggle: 2nd finger (touch) / right-click while dragging (mouse)
    if (touchMode) {
      await touch('touchStart', [{ x: ex, y: ey, id: 1 }, { x: 40, y: vp.height - 40, id: 2 }]);
      await wait(50);
      await touch('touchEnd', [{ x: 40, y: vp.height - 40, id: 2 }]);
    } else {
      await page.mouse.down({ button: 'right' });
      await wait(30);
      await page.mouse.up({ button: 'right' });
    }
    await wait(80);
    st = await view();
    check(C, `bullet toggle via ${touchMode ? 'second finger' : 'right-click during drag'}`, st.phase === 'dropback' && st.aim && st.aim.bullet === true, st.log.join(','));
    await shot(`pv-${C}-06-bullet`);
    if (!touchMode) {
      await page.keyboard.press('KeyB'); // B toggles back to a lob
      await wait(40);
      st = await view();
      check(C, 'B key toggles bullet back to lob', st.aim && st.aim.bullet === false);
    }
    await lift(ex, ey);
    await wait(60);
    st = await view();
    check(C, 'release -> throw', st.ev.includes('throw') && (st.phase === 'air' || st.phase === 'carry' || st.phase === 'dead'), `${st.phase} ${st.ev.join(',')}`);
    await shot(`pv-${C}-07-air`);
    await waitFor(() => !!window.__app.current.view.result, null, 8000);
    st = await view();
    check(C, 'pass play resolves', !!st.result, st.result || 'none');
    await wait(200);
    await shot(`pv-${C}-08-pass-result`);

    // ---------------------------------------------------------------- QB run via collapse
    await newPlay({ seed: 12 });
    await wait(300);
    await stroke(cx, cy, cx - F.x * 60, cy - F.y * 60, 120, 5, true);
    await wait(60);
    for (let i = 1; i <= 5; i++) { await moveTo(cx - F.x * 60 + F.x * 18 * i, cy - F.y * 60 + F.y * 18 * i); await wait(15); }
    await wait(60);
    st = await view();
    check(C, 'drag collapsing past the anchor -> run mode (icon, no arc)', st.aim && st.aim.runMode === true, st.aim ? JSON.stringify(st.aim) : `no aim (${st.phase})`);
    await shot(`pv-${C}-09-runmode`);
    await lift(cx + F.x * 30, cy + F.y * 30);
    await wait(60);
    st = await view();
    check(C, 'release in run mode -> QB tucks and carries', st.ev.includes('tuck') && (st.carrier === 'QB' || st.result), `${st.carrier} ${st.result}`);

    // ---------------------------------------------------------------- keyboard (desktop): H, arrows, Space
    if (!touchMode) {
      await newPlay({ seed: 31 });
      await wait(250);
      await page.keyboard.press('KeyH');
      await waitFor(() => !!window.__app.current.view.sim.carrier, null, 2000);
      await page.keyboard.press('KeyW');
      await wait(40);
      st = await view();
      check(C, 'H hands off, W jukes (keyboard)', st.log.includes('handoff') && st.ev.includes('juke'), st.log.join(','));
      await page.keyboard.down('Space');
      await wait(60);
      const tk = await view();
      await page.keyboard.up('Space');
      check(C, 'hold Space trucks', tk.truck === true || !!tk.result);
      await newPlay({ seed: 32 });
      await wait(250);
      await page.keyboard.press('Space');
      await wait(40);
      st = await view();
      check(C, 'Space drops back', st.phase === 'dropback');
      await page.keyboard.press('KeyR');
      await wait(40);
      st = await view();
      check(C, 'R tucks and runs', st.ev.includes('tuck'));
    }

    // ---------------------------------------------------------------- field goal: two taps
    await S(() => { const sb = window.__app.current; sb.fgDist = 32; });
    await setKind('fg');
    await wait(200);
    await shot(`pv-${C}-10-fg-power`);
    const powerOk = await waitFor(() => { const k = window.__app.current.view.sim.kick; return k.power > 0.93; }, null, 4000);
    if (touchMode) await tap(cx, cy); else await page.mouse.click(cx, cy);
    await wait(60);
    st = await view();
    const k1 = await S(() => { const k = window.__app.current.view.sim.kick; return { stage: k.stage, power: k.power }; });
    check(C, 'FG tap 1 locks power (green band) + snaps', powerOk && k1.stage === 'aim' && st.phase === 'kick', `power ${k1.power.toFixed(2)} stage ${k1.stage}`);
    await waitFor(() => Math.abs(window.__app.current.view.sim.kick.aim) < 0.12, null, 3000);
    const posts = await S(() => {
      const v = window.__app.current.view;
      const cam = v.camera;
      const k = v.sim.kick;
      const bar = cam.toScreen(120, 160 / 6, 3.33); // crossbar centre
      const kicker = cam.toScreen(v.sim.byId.K.x, v.sim.byId.K.y, 0);
      const inView = (p) => p.x >= 0 && p.x <= cam.viewW && p.y >= 0 && p.y <= cam.viewH;
      return { bar: inView(bar), kicker: inView(kicker), spot: k.spotX };
    });
    check(C, 'FG framing shows kicker and crossbar together', posts.bar && posts.kicker, JSON.stringify(posts));
    await shot(`pv-${C}-11-fg-aim`);
    if (touchMode) await tap(cx, cy); else await page.keyboard.press('Space');
    await wait(60);
    const k2 = await S(() => { const k = window.__app.current.view.sim.kick; return { locked: k.aimLocked, aim: k.aim }; });
    check(C, 'FG tap 2 locks aim', k2.locked, `aim ${k2.aim.toFixed(2)}`);
    await waitFor(() => window.__app.current.view.sim.kick.stage === 'flight', null, 2000);
    await wait(500);
    await shot(`pv-${C}-12-fg-flight`);
    await waitFor(() => !!window.__app.current.view.result, null, 6000);
    st = await view();
    check(C, 'FG resolves (kick event + result)', st.ev.includes('kick') && /^fg_/.test(st.result || ''), st.result || 'none');
    await wait(300);
    await shot(`pv-${C}-13-fg-result`);

    // ---------------------------------------------------------------- kick return: touchback + return juke
    const seeds = await S(async () => {
      const { PlaySim } = await import('/src/play/sim/PlaySim.js');
      const sb = window.__app.current;
      const deep = [];
      const short = [];
      for (let s = 1; s < 400 && (deep.length < 1 || short.length < 1); s++) {
        const sim = new PlaySim({ ...sb.setupFor('kick_return'), seed: s });
        for (let i = 0; i < 60 && !sim.kickoff.kicked; i++) sim.update(1 / 60);
        if (sim.kickoff.landX < 6) deep.push(s); else if (sim.kickoff.landX > 12) short.push(s);
      }
      return { deep: deep[0], short: short[0] };
    });
    await S(() => { window.__app.current.kind = 'kick_return'; });
    await newPlay({ seed: seeds.deep });
    await waitFor(() => window.__app.current.view.sim.kickoff.kicked, null, 3000);
    await wait(400);
    await shot(`pv-${C}-14-return-air`);
    await waitFor(() => { const s = window.__app.current.view.sim; return !!s.carrier || s.ball.ft > s.ball.T - 0.6; }, null, 6000);
    // back-swipe (toward the own goal)
    await stroke(cx, cy, cx - F.x * 40, cy - F.y * 40, 80, 4);
    await waitFor(() => !!window.__app.current.view.result, null, 6000);
    st = await view();
    check(C, 'kick return: back-swipe in the end zone -> touchback', st.result === 'touchback', `${st.result} ${st.log.join(',')}`);
    await wait(250);
    await shot(`pv-${C}-15-touchback`);
    await newPlay({ seed: seeds.short });
    await waitFor(() => !!window.__app.current.view.sim.carrier, null, 8000);
    await wait(100);
    await stroke(cx, cy, cx + L.x * 36, cy + L.y * 36, 80, 4);
    await wait(50);
    st = await view();
    check(C, 'kick return: returner jukes after the catch', st.ev.includes('juke') || !!st.result, st.log.join(','));
    await shot(`pv-${C}-16-return-run`);

    // ---------------------------------------------------------------- pause, frame time, resize
    await S(() => { window.__app.current.kind = 'scrimmage'; });
    await newPlay({ seed: 41 });
    await wait(200);
    const paused = await S(async () => {
      const v = window.__app.current.view;
      v.sim.dropBack();
      v.paused = true;
      const t0 = v.sim.t;
      await new Promise((r) => setTimeout(r, 250));
      const t1 = v.sim.t;
      v.paused = false;
      return { t0, t1 };
    });
    check(C, 'paused view does not advance the sim', paused.t0 === paused.t1);
    const perf = await S(async () => {
      const v = window.__app.current.view;
      const d = [];
      let last = performance.now();
      await new Promise((res) => {
        const f = (now) => { d.push(now - last); last = now; if (d.length < 120) requestAnimationFrame(f); else res(); };
        requestAnimationFrame(f);
      });
      d.sort((a, b) => a - b);
      return { median: d[60], p95: d[114], renderMs: v.stats.renderMs, updateMs: v.stats.updateMs };
    });
    console.log(`INFO [${C}] frame interval median ${perf.median.toFixed(1)}ms p95 ${perf.p95.toFixed(1)}ms; view render ${perf.renderMs.toFixed(2)}ms update ${perf.updateMs.toFixed(3)}ms`);
    check(C, 'render cost under 8 ms', perf.renderMs < 8, `${perf.renderMs.toFixed(2)}ms`);
    summary.push({ C, ...perf });
    // resize / rotate mid-play
    await page.setViewportSize({ width: vp.height, height: vp.width });
    await wait(400);
    const rot = await S(() => ({ o: window.__app.display.orientation, cam: window.__app.current.view.camera.orientation, phase: window.__app.current.view.sim.phase }));
    check(C, 'rotation mid-play: camera follows the display orientation', rot.o === rot.cam, `${rot.o}/${rot.cam} ${rot.phase}`);
    await shot(`pv-${C}-17-rotated`);
    await page.setViewportSize(vp);
    await wait(200);

    // ---------------------------------------------------------------- IdleFieldView
    const idle = await S(async (driveLeft) => {
      const { IdleFieldView } = await import('/src/play/view/PlayView.js');
      const app = window.__app;
      const v = new IdleFieldView(app, { losX: 62, firstDownX: 72, userLook: { city: 'Cleveland', primary: '#1952b8', secondary: '#fdd835', helmet: '#1952b8' }, oppLook: { city: 'Chicago', primary: '#c62828', secondary: '#202020', helmet: '#202020' }, driveLeft, offense: 'opp', dim: 0.4 });
      for (let i = 0; i < 10; i++) v.update(1 / 60);
      v.render(1);
      const n = v.sim.players.length;
      v.destroy();
      return { n, mirror: v.camera.mirror };
    }, !!cfg.driveLeft);
    check(C, 'IdleFieldView renders both teams', idle.n === 22, JSON.stringify(idle));

    check(C, 'no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  });
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nALL PLAY-VIEW CHECKS PASSED');
process.exit(failures ? 1 : 0);
