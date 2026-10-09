// PLAY-VIEW e2e: drives the dev sandbox with REAL gestures (CDP touch events incl. multi-touch,
// mouse with right-click, keyboard) in phone portrait, phone landscape (drive right and drive
// left) and desktop, and checks the PlaySim reacted: RB tap -> handoff, carrier swipes -> juke,
// hold -> truck, slingshot drag -> aim downfield, 2nd finger / right-click -> bullet, release ->
// throw, collapse -> QB run, FG two taps, kick return + touchback, post-play skip, audible, pause,
// resize mid-play. Screenshots -> test-results/pv-<config>-<step>.png. Measures frame time.
// QA regressions (gameplay-feel pass): sloppy RB tap still hands off, a second thumb takes over a
// carrier gesture, the FG arrow starts at an edge and a second-thumb tap locks it, the truck hold
// counts from the catch, lob arcs lean in portrait, HUD-aware aim framing at both sidelines, tips
// never cover the QB, banners fade within the beat, on-field kits, field pre-warm, rotation
// mid-aim cancels the throw, blur releases held keys, haptics are throttled.
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
        g: v.controller.g ? `${v.controller.g.mode}${v.controller.g.sec ? '/2nd' : ''}` : '-',
      };
    });
    // every seeded play starts from the same drive spot (earlier plays must not shift later ones)
    const newPlay = (over) => S((o) => {
      const sb = window.__app.current;
      sb.drive = { losX: sb.startLos, down: 1, firstDownX: sb.startLos + 10, hashY: 160 / 6 };
      sb.newPlay(o);
    }, over || {});
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
    // keep the defense on the turf for a few seconds so a quick tackle can't race the checks below
    // (a press after the whistle would skip into the next play)
    await S(() => { for (const e of window.__app.current.view.sim.players) if (e.side === 'def') { e.down = true; e.ai.downUntil = 4; } });
    await wait(150);
    await shot(`pv-${C}-02-run`);
    // lateral swipe toward world -y (screen -lat)
    await stroke(cx, cy, cx - L.x * 34 + F.x * 6, cy - L.y * 34 + F.y * 6, 80, 4);
    await wait(60);
    st = await view();
    const juked = st.ev.includes('juke') || st.result;
    check(C, 'lateral flick -> sideStep (juke event)', st.ev.includes('juke'), `${st.log.join(',')} ${st.result || ''} phase ${st.phase} gesture ${st.g} ev ${st.ev.slice(-4).join(',')}`);
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

    // ---------------------------------------------------------------- QA regressions (feel pass)
    await S(() => { window.__app.current.kind = 'scrimmage'; });
    const freezeDefense = (until = 6) => S((u) => { for (const e of window.__app.current.view.sim.players) if (e.side === 'def') { e.down = true; e.ai.downUntil = u; } }, until);
    if (touchMode) {
      // a sloppy tap on the RB (the finger travels ~15 px) still hands off
      await newPlay({ seed: 21 });
      await wait(250);
      const rb2 = await S(() => window.__app.current.view.screenPos('RB'));
      await touch('touchStart', [{ x: rb2.x, y: rb2.y, id: 1 }]);
      await wait(30);
      await touch('touchMove', [{ x: rb2.x + 9, y: rb2.y + 7, id: 1 }]);
      await wait(30);
      await touch('touchMove', [{ x: rb2.x + 12, y: rb2.y + 9, id: 1 }]);
      await wait(30);
      await touch('touchEnd', [{ x: rb2.x + 12, y: rb2.y + 9, id: 1 }]);
      await wait(80);
      st = await view();
      check(C, 'sloppy RB tap (15 px of finger travel) still hands off', st.log.includes('handoff') && !st.log.includes('dropBack'), st.log.join(','));
      // two thumbs: one rests (and trucks), the other swipes -> the swipe is not swallowed
      await waitFor(() => !!window.__app.current.view.sim.carrier, null, 2000);
      await freezeDefense();
      const A = { x: cx - L.x * 70, y: cy - L.y * 70 };
      const B = { x: cx + L.x * 70, y: cy + L.y * 70 };
      await touch('touchStart', [{ ...A, id: 1 }]);
      await wait(420);
      const rest = await view();
      await touch('touchStart', [{ ...A, id: 1 }, { ...B, id: 2 }]);
      for (let i = 1; i <= 4; i++) {
        await wait(20);
        await touch('touchMove', [{ ...A, id: 1 }, { x: B.x - L.x * 9 * i, y: B.y - L.y * 9 * i, id: 2 }]);
      }
      await wait(60);
      st = await view();
      await touch('touchEnd', [{ x: B.x - L.x * 36, y: B.y - L.y * 36, id: 2 }]);
      await touch('touchEnd', [{ ...A, id: 1 }]);
      check(C, 'resting thumb trucks; a second thumb\'s swipe takes over (juke, truck released)', rest.truck === true && st.ev.includes('juke') && st.truck === false, `rest ${rest.truck} ${st.log.join(',')} truck ${st.truck}`);
    }
    // a zigzag in ONE touch (pausing at each turn) gives one juke per stroke, with diminishing
    // returns (MECHANICS 3.1: x1.0, 0.7, 0.5, 0.35)
    await newPlay({ seed: 21 });
    await wait(250);
    await S(() => window.__app.current.view.sim.handoff());
    await waitFor(() => !!window.__app.current.view.sim.carrier, null, 2000);
    await freezeDefense(30);
    await press(cx, cy);
    let zx = cx;
    let zy = cy;
    for (const d of [1, -1, 1, -1]) {
      for (let k = 0; k < 3; k++) { zx += d * L.x * 9; zy += d * L.y * 9; await moveTo(zx, zy); await wait(18); }
      await wait(260);
    }
    await lift(zx, zy);
    await wait(80);
    const effs = await S(() => window.__app.current.view.sim.eventLog.filter((e) => e.type === 'juke').map((e) => e.eff));
    check(C, 'zigzag in one touch (pauses at the turns): 4 jukes, diminishing 1/.7/.5/.35', effs.length === 4 && effs[0] === 1 && effs[1] < 1 && effs[3] < effs[2], JSON.stringify(effs));
    // FG: the arrow starts at an edge (no reflexive double-tap centre), a 2nd-thumb tap locks it
    await S(() => { const sb = window.__app.current; sb.kind = 'fg'; sb.fgDist = 30; sb.newPlay(); });
    await wait(200);
    await waitFor(() => window.__app.current.view.sim.kick.power > 0.9, null, 4000);
    if (touchMode) await touch('touchStart', [{ x: cx, y: cy, id: 1 }]);
    else await page.mouse.click(cx, cy);
    await wait(30);
    const edge = await S(() => window.__app.current.view.sim.kick.aim);
    check(C, 'FG aim arrow starts at an edge, swinging in', Math.abs(edge) > 0.6, `aim ${edge.toFixed(2)}`);
    if (touchMode) {
      await wait(120);
      await touch('touchStart', [{ x: cx, y: cy, id: 1 }, { x: cx + 60, y: cy + 60, id: 2 }]);
      await wait(40);
      const lk = await S(() => window.__app.current.view.sim.kick.aimLocked);
      await touch('touchEnd', [{ x: cx + 60, y: cy + 60, id: 2 }]);
      await touch('touchEnd', [{ x: cx, y: cy, id: 1 }]);
      check(C, 'FG: a tap with the other thumb (first still down) locks the aim', lk === true);
    } else {
      await page.keyboard.press('Space');
      await wait(40);
    }
    await waitFor(() => !!window.__app.current.view.result, null, 6000);
    const bn = await S(() => { const v = window.__app.current.view; return v.bannerState ? { dur: v.bannerState.dur, beat: v._beat } : null; });
    check(C, 'result banner fades out within the post-play beat (no abrupt cut)', !!bn && bn.dur <= bn.beat + 1e-6, JSON.stringify(bn));
    if (touchMode) {
      // a finger resting through the kick-return catch only trucks once held from the catch on
      await S(() => { window.__app.current.kind = 'kick_return'; });
      await newPlay({ seed: seeds.short });
      await waitFor(() => window.__app.current.view.sim.kickoff.kicked, null, 3000);
      await touch('touchStart', [{ x: cx, y: cy, id: 1 }]);
      await waitFor(() => !!window.__app.current.view.sim.carrier, null, 8000);
      const early = await S(() => window.__app.current.view.sim.carrierState.truckHeld);
      await wait(450);
      const late = await S(() => { const v = window.__app.current.view; return v.result ? 'over' : v.sim.carrierState.truckHeld; });
      await touch('touchEnd', [{ x: cx, y: cy, id: 1 }]);
      check(C, 'kick return: resting finger does not truck at the catch, only after a hold', early === false && (late === true || late === 'over'), `early ${early} late ${late}`);
      await S(() => { window.__app.current.kind = 'scrimmage'; });
    }
    // aiming at either sideline keeps the target and the QB on screen, clear of a HUD bar
    await S(() => { window.__app.current.kind = 'scrimmage'; });
    for (const side of ['far', 'near']) {
      await newPlay({ seed: 51 });
      await S(() => { window.__app.current.view.insets = { top: 52, bottom: 50, left: 8, right: 8 }; }); // ~ the match HUD
      await wait(200);
      await freezeDefense();
      const sx2 = cx;
      const sy2 = cy;
      await stroke(sx2, sy2, sx2 - F.x * 30, sy2 - F.y * 30, 80, 4, true);
      await wait(150);
      const want = await S((side) => {
        const v = window.__app.current.view;
        const s = v.sim;
        const d = v.app.display;
        const k = d.dpr / d.scale;
        const comfort = Math.max(130, Math.min(300, Math.min(d.cssW, d.cssH) * 0.42));
        const scale = s.maxThrowDist() / ((comfort * k) / v.camera.ppy);
        const tx = s.qb.x + 18;
        const ty = side === 'far' ? 2.5 : 160 / 3 - 2.5;
        const o = v.camera.worldDirToScreen((s.qb.x - tx) / scale, (s.qb.y - ty) / scale);
        return { dx: o.x / k, dy: o.y / k };
      }, side);
      for (let i = 1; i <= 6; i++) { await moveTo(sx2 + want.dx * i / 6, sy2 + want.dy * i / 6); await wait(30); }
      await wait(1500);
      const fr = await S(() => {
        const v = window.__app.current.view;
        const s = v.sim;
        if (!s.aim) return { phase: s.phase };
        const c = v.camera;
        const ins = v._insets();
        const t = c.toScreen(s.aim.tx, s.aim.ty, 0);
        const q = c.toScreen(s.qb.x, s.qb.y, 0);
        const land = c.orientation === 'landscape';
        const inBand = (p) => p.x >= 0 && p.x <= c.viewW && p.y >= (land ? ins.top : 0) && p.y <= c.viewH;
        return { target: inBand(t), qb: inBand({ x: q.x, y: q.y - 12 }) && inBand(q), t: [Math.round(t.x), Math.round(t.y)], q: [Math.round(q.x), Math.round(q.y)], top: ins.top, ty: +s.aim.ty.toFixed(1) };
      });
      await shot(`pv-${C}-18-aim-${side}-sideline`);
      check(C, `aim at the ${side} sideline: target clear of the HUD and the QB both on screen`, fr.target && fr.qb, JSON.stringify(fr));
      if (side === 'near') {
        // the tip box (pass tips still showing) never sits on the QB
        const tipq = await S(async () => {
          const v = window.__app.current.view;
          const { tipSize } = await import('/src/play/view/overlay.js');
          const text = v._tipText();
          if (!text) return { none: true };
          const sz = tipSize(text, v.camera.viewW - 8);
          const at = v._tipSpot(text, sz, false);
          const q = v.camera.toScreen(v.sim.qb.x, v.sim.qb.y, 0);
          const x0 = at.cx - sz.w / 2;
          const y0 = at.bottom - sz.h;
          const hit = q.x > x0 - 6 && q.x < x0 + sz.w + 6 && q.y > y0 && q.y - 22 < at.bottom;
          return { hit, slot: v._tipState.slot };
        });
        check(C, 'control tip is placed off the QB', tipq.none || !tipq.hit, JSON.stringify(tipq));
      }
      await lift(sx2 + want.dx, sy2 + want.dy);
      await wait(100);
    }
    // goal-line framing: on a 2-pt try the whole end zone (to the end line) stays clear of the HUD
    await S(() => { const sb = window.__app.current; sb.kind = 'two_point'; sb.newPlay({ seed: 5 }); sb.view.insets = { top: 60, bottom: 50, left: 8, right: 8 }; });
    await wait(900);
    const gl = await S(() => {
      const v = window.__app.current.view;
      const c = v.camera;
      const ins = v._insets();
      const back = c.toScreen(119.5, 160 / 6, 0);
      const land = c.orientation === 'landscape';
      return { ok: land ? back.x >= 0 && back.x <= c.viewW : back.y >= ins.top, y: Math.round(back.y), top: ins.top };
    });
    await shot(`pv-${C}-19-goal-line`);
    check(C, 'goal-line framing: the end line is on screen, clear of the HUD', gl.ok, JSON.stringify(gl));
    await S(() => { window.__app.current.kind = 'scrimmage'; });
    // portrait: a straight-downfield lob bows sideways off its ground shadow; landscape: no lean
    await newPlay({ seed: 52 });
    await wait(150);
    await freezeDefense();
    const lean = await S(async () => {
      const v = window.__app.current.view;
      const s = v.sim;
      s.dropBack();
      for (let i = 0; i < 30; i++) { s.update(1 / 60); s.aimAt(s.qb.x + 35, s.qb.y); v._updateLean(1 / 60); }
      const p = s.aim.path;
      const mid = p[Math.floor(p.length / 2)];
      const c = v.camera;
      const g = c.toScreen(mid.x, mid.y, 0);
      const z0 = p[0].z;
      const z1 = p[p.length - 1].z;
      const h = mid.z - (z0 + (z1 - z0) * 0.5);
      return { lean: v._aimLean.x, ppy: c.ppy, bowPx: Math.abs(v._aimLean.x * h), o: c.orientation, gx: g.x };
    });
    if (lean.o === 'portrait') check(C, 'portrait lob arc leans sideways off its shadow (height reads)', lean.bowPx > 6, JSON.stringify(lean));
    else check(C, 'landscape downfield lob has no sideways lean', Math.abs(lean.lean) < 0.2 * lean.ppy, JSON.stringify(lean));
    await S(() => window.__app.current.view.sim.aimCancel());
    // rotating mid-aim cancels the drag instead of throwing somewhere unintended on lift
    await newPlay({ seed: 53 });
    await wait(150);
    await freezeDefense();
    await stroke(cx, cy, cx - F.x * 70 + L.x * 20, cy - F.y * 70 + L.y * 20, 120, 5, true);
    await wait(120);
    const pre = await view();
    await page.setViewportSize({ width: vp.height, height: vp.width });
    await wait(350);
    await lift(cx, cy);
    await wait(120);
    st = await view();
    await page.setViewportSize(vp);
    await wait(300);
    check(C, 'rotation mid-aim cancels the aim (no throw on lift)', pre.phase === 'dropback' && !!pre.aim && st.phase === 'dropback' && !st.ev.includes('throw'), `${pre.phase} -> ${st.phase} ${st.ev.join(',')}`);
    if (!touchMode) {
      // window blur releases a held key (Space truck)
      await newPlay({ seed: 31 });
      await wait(200);
      await page.keyboard.press('KeyH');
      await waitFor(() => !!window.__app.current.view.sim.carrier, null, 2000);
      await freezeDefense();
      await page.keyboard.down('Space');
      await wait(60);
      const held = await view();
      await S(() => window.dispatchEvent(new Event('blur')));
      await wait(60);
      st = await view();
      await page.keyboard.up('Space');
      check(C, 'window blur releases a held Space (truck off)', held.truck === true && st.truck === false, `${held.truck} -> ${st.truck}`);
    }
    // kits, field pre-warm, haptic throttle, audio limiter
    const misc = await S(async () => {
      const app = window.__app;
      const v = app.current.view;
      const { fieldKit, kitDistance, KIT } = await import('/src/render/sprites.js');
      const { FIELD_COLORS } = await import('/src/render/field.js');
      const turf = [FIELD_COLORS.turfA, FIELD_COLORS.turfB];
      const atl = fieldKit({ primary: '#2e8b3a', secondary: '#c8c8c8', helmet: '#c8c8c8' }, turf);
      const por = fieldKit({ primary: '#2d6a4f', secondary: '#e9c46a', helmet: '#2d6a4f' }, turf);
      const home = fieldKit({ primary: '#c62828', secondary: '#202020', helmet: '#202020' }, turf);
      const away = fieldKit({ primary: '#b3122e', secondary: '#f0f0f0', helmet: '#b3122e' }, turf, home);
      const kits = {
        turf: Math.min(...turf.map((t) => kitDistance(atl.primary, t))) >= KIT.turf && Math.min(...turf.map((t) => kitDistance(por.helmet, t))) >= KIT.turf,
        clash: kitDistance(home.primary, away.primary) >= KIT.clash,
      };
      const f = v.field;
      const entries = [...f._cache.values()];
      const crowdBuilt = entries.length > 0 && entries.every((e) => e.crowd.every((s) => s.frames.every(Boolean)));
      const normal = v._normalPpy || v.camera.ppy;
      const kp = v._kickPpy(app.display, normal);
      const kickKey = [...f._cache.keys()].some((k) => k.split('|')[2] === String(kp));
      let n = 0;
      const orig = app.vibrate;
      app.vibrate = () => { n++; };
      for (let i = 0; i < 5; i++) v._buzz(6);
      const small = n;
      v._buzz(40);
      app.vibrate = orig;
      return { kits, crowdBuilt, kickKey, kp, normal, small, big: n - small, limiter: !app.audio.ctx || !!app.audio.limiter };
    });
    check(C, 'on-field kits: turf-coloured jerseys/helmets switch, look-alike sides split', misc.kits.turf && misc.kits.clash, JSON.stringify(misc.kits));
    check(C, 'field pre-warmed: all crowd frames + the field-goal framing cached before play', misc.crowdBuilt && misc.kickKey, `crowd ${misc.crowdBuilt} kick ppy ${misc.kp}/${misc.normal} cached ${misc.kickKey}`);
    check(C, 'haptics: rapid small pulses are throttled, big ones always buzz', misc.small === 1 && misc.big === 1, `${misc.small}/${misc.big}`);
    check(C, 'audio master bus has a limiter', misc.limiter);

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
