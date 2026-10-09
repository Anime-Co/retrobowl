// Dev stand-in for src/play/view/PlayView.js that implements the PLAY-VIEW contract
// (docs/ARCHITECTURE.md) with the real PlaySim and a minimal FieldRenderer drawing. MatchScreen
// uses it when the real PlayView is missing or fails to load, and on request (`stub:true` param,
// fast QA autoplay). It has no gesture controller: when `selfDrive` is on, a tap / Space / Enter
// snaps and the SimBot plays the down; otherwise MatchScreen's autoplay bot drives `view.sim`.
//
//   const v = new StubPlayView(app, {setup, userLook, oppLook, driveLeft, onSnap});
//   v.update(dt); v.render(alpha); v.paused; v.changePlay(); v.sim; v.result; v.done; v.destroy();
//   const idle = new StubIdleFieldView(app, {losX, userLook, oppLook, driveLeft}); idle.update(dt); idle.render(a);
//
// `driveLeft` mirrors the landscape camera (portrait always drives up).

import { PlaySim } from '../play/sim/PlaySim.js';
import { SimBot } from '../play/sim/bot.js';
import { Camera, FIELD_W } from '../render/camera.js';
import { FieldRenderer } from '../render/field.js';
import { drawPlayer, drawBall } from '../render/sprites.js';
import { drawText } from '../render/font.js';

const POST_PLAY_BEAT = 1.4;

let shared = null;
let sharedKey = '';

/** One FieldRenderer shared by every stub view (its pre-render is cached per teams/camera). */
function fieldFor(userLook, oppLook) {
  const key = `${userLook?.abbr}|${userLook?.primary}|${oppLook?.abbr}|${oppLook?.primary}`;
  if (!shared) shared = new FieldRenderer();
  if (key !== sharedKey) {
    shared.setTeams(userLook, oppLook);
    sharedKey = key;
  }
  return shared;
}

function syncCamera(cam, d, driveLeft) {
  cam.mirror = !!driveLeft && d.orientation === 'landscape';
  if (cam.viewW !== d.w || cam.viewH !== d.h || cam.orientation !== d.orientation) {
    const tx = cam.tx;
    const ty = cam.ty;
    cam.setViewport(d.w, d.h, d.orientation);
    cam.snapTo(tx, ty);
  }
}

function bannerFor(r, sim) {
  if (!r) return '';
  switch (r.outcome) {
    case 'td':
    case 'return_td':
      return sim.twoPoint ? 'TWO POINTS!' : 'TOUCHDOWN!';
    case 'interception': return 'INTERCEPTED';
    case 'fumble': return r.turnover ? 'FUMBLE!' : 'FUMBLE';
    case 'sack': return 'SACK';
    case 'safety': return 'SAFETY';
    case 'incomplete': return 'INCOMPLETE';
    case 'fg_good': return 'IT\'S GOOD!';
    case 'pat_good': return 'GOOD!';
    case 'fg_miss':
    case 'pat_miss': return 'NO GOOD';
    case 'kick_blocked': return 'BLOCKED';
    case 'touchback': return 'TOUCHBACK';
    default: {
      if (sim.twoPoint) return 'NO GOOD';
      if (r.firstDown) return 'FIRST DOWN';
      const y = Math.round(r.yards || 0);
      return y > 0 ? `+${y}` : y < 0 ? `${y}` : 'NO GAIN';
    }
  }
}

export class StubPlayView {
  /**
   * @param {any} app
   * @param {{setup:Object, userLook:Object, oppLook:Object, driveLeft?:boolean, onSnap?:()=>void,
   *   selfDrive?:boolean}} opts
   */
  constructor(app, opts) {
    this.app = app;
    this.opts = opts;
    this.isStub = true;
    this.sim = new PlaySim(opts.setup);
    this.paused = false;
    this.result = null;
    this.done = false;
    this.selfDrive = !!opts.selfDrive;
    this.bot = new SimBot({ seed: ((opts.setup?.seed >>> 0) ^ 0x2545f491) >>> 0 });
    this.armed = false;
    this.snapped = false;
    this.after = 0;
    this.skip = false;
    this.time = 0;
    this.banner = '';
    this.field = fieldFor(opts.userLook, opts.oppLook);
    this.camera = new Camera();
    const d = app.display;
    this.camera.mirror = !!opts.driveLeft && d.orientation === 'landscape';
    this.camera.setViewport(d.w, d.h, d.orientation);
    this.camera.snapTo(this.sim.losX, this.sim.by ?? FIELD_W / 2);
  }

  changePlay() {
    return this.sim.changePlay();
  }

  update(dt) {
    const events = this.app.input.poll();
    if (this.paused) return;
    this.time += dt;
    for (const ev of events) {
      const press = ev.type === 'tap' || (ev.type === 'key' && ev.down && !ev.repeat && (ev.code === 'Space' || ev.code === 'Enter'));
      if (!press) continue;
      if (this.result) this.skip = true;
      else if (!this.armed) {
        this.armed = true;
        this.bot.snapDelay = 0; // snap on the tap
      }
    }
    const sim = this.sim;
    if (!this.result) {
      if (this.selfDrive && (this.armed || sim.phase !== 'presnap')) this.bot.step(sim, dt);
      sim.update(dt);
      if (!this.snapped && sim.phase !== 'presnap') {
        this.snapped = true;
        if (this.opts.onSnap) this.opts.onSnap();
      }
      if (sim.result) {
        this.result = sim.result;
        this.banner = bannerFor(sim.result, sim);
      }
    } else {
      sim.update(dt); // cosmetic: players settle, a kicked ball finishes its flight
      this.after += dt;
      if (this.after >= POST_PLAY_BEAT || (this.skip && this.after > 0.3)) this.done = true;
    }
    sim.drainEvents();
    const b = sim.ball;
    const c = sim.carrier;
    const fx = c ? c.x : b.x;
    const fy = c ? c.y : b.y;
    syncCamera(this.camera, this.app.display, this.opts.driveLeft);
    this.camera.follow(Number.isFinite(fx) ? fx : sim.losX, Number.isFinite(fy) ? fy : FIELD_W / 2, dt, 5);
  }

  render() {
    const d = this.app.display;
    const ctx = d.begin('#1b2030');
    const cam = this.camera;
    syncCamera(cam, d, this.opts.driveLeft);
    const sim = this.sim;
    const fd = sim.kind === 'scrimmage' && !sim.twoPoint ? sim.firstDownX : null;
    this.field.draw(ctx, cam, { losX: sim.kind === 'kick_return' ? null : sim.losX, firstDownX: fd, time: this.time, posts: false });
    this.field.drawPosts(ctx, cam, 'behind');
    const ps = sim.players.map((e) => ({ e, s: cam.toScreen(e.x, e.y) })).sort((a, b) => a.s.y - b.s.y);
    const { userLook, oppLook } = this.opts;
    for (const { e, s } of ps) {
      drawPlayer(ctx, s.x, s.y - (e.z || 0) * cam.ppy, e.side === 'off' ? userLook : oppLook, {
        facing: cam.facingFor(e.face?.x || 1, e.face?.y || 0),
        anim: e.anim,
        t: e.animT,
        highlight: e.controlled ? 'user' : null,
        time: this.time,
      });
    }
    const b = sim.ball;
    if (b.state !== 'held' || !b.holder) {
      const bs = cam.toScreen(b.x, b.y);
      drawBall(ctx, bs.x, bs.y, b.z, { ppy: cam.ppy, spin: this.time, angle: Math.atan2(b.vy || 0, b.vx || 1) });
    }
    this.field.drawPosts(ctx, cam, 'front');
    const mid = d.w / 2;
    if (this.banner) {
      drawText(ctx, this.banner, mid, Math.round(d.h * 0.32), { size: 'big', scale: 2, align: 'center', color: '#ffd23a', shadow: '#000000' });
    } else if (this.selfDrive && !this.armed && sim.phase === 'presnap') {
      drawText(ctx, 'DEV VIEW - TAP TO SNAP', mid, Math.round(d.h * 0.7), { align: 'center', color: '#ffffff', shadow: '#000000' });
    }
    d.present();
  }

  destroy() {
    this.done = true;
  }
}

export class StubIdleFieldView {
  /** @param {any} app @param {{losX:number, userLook:Object, oppLook:Object, driveLeft?:boolean}} opts */
  constructor(app, opts) {
    this.app = app;
    this.opts = opts;
    this.time = 0;
    this.losX = Number.isFinite(opts.losX) ? opts.losX : 35;
    this.field = fieldFor(opts.userLook, opts.oppLook);
    this.camera = new Camera();
    const d = app.display;
    this.camera.mirror = !!opts.driveLeft && d.orientation === 'landscape';
    this.camera.setViewport(d.w, d.h, d.orientation);
    this.camera.snapTo(this.losX, FIELD_W / 2);
    const mid = FIELD_W / 2;
    // a static huddle-ish picture: two lines of seven plus a few backs per side
    this.players = [];
    for (let i = 0; i < 7; i++) {
      const y = mid + (i - 3) * 1.6;
      this.players.push({ x: this.losX - 1, y, side: 'off', skin: i });
      this.players.push({ x: this.losX + 1, y: y + 0.3, side: 'def', skin: i + 2 });
    }
    for (const [dx, dy] of [[-5, 0], [-7.5, 0], [-2, -9], [-2, 9]]) this.players.push({ x: this.losX + dx, y: mid + dy, side: 'off', skin: 1 });
    for (const [dx, dy] of [[5, -4], [5, 4], [10, -10], [10, 10]]) this.players.push({ x: this.losX + dx, y: mid + dy, side: 'def', skin: 3 });
  }

  update(dt) {
    this.time += dt;
  }

  render() {
    const d = this.app.display;
    const ctx = d.begin('#1b2030');
    const cam = this.camera;
    cam.mirror = !!this.opts.driveLeft && d.orientation === 'landscape';
    if (cam.viewW !== d.w || cam.viewH !== d.h || cam.orientation !== d.orientation) {
      cam.setViewport(d.w, d.h, d.orientation);
      cam.snapTo(this.losX, FIELD_W / 2);
    }
    this.field.draw(ctx, cam, { losX: this.losX, time: this.time, posts: false });
    this.field.drawPosts(ctx, cam, 'behind');
    const ps = this.players.map((p) => ({ p, s: cam.toScreen(p.x, p.y) })).sort((a, b) => a.s.y - b.s.y);
    for (const { p, s } of ps) {
      const look = p.side === 'off' ? this.opts.userLook : this.opts.oppLook;
      drawPlayer(ctx, s.x, s.y, look, { facing: cam.facingFor(p.side === 'off' ? 1 : -1, 0), anim: 'idle', t: this.time + p.skin * 0.37, skin: p.skin });
    }
    this.field.drawPosts(ctx, cam, 'front');
    d.present();
  }

  destroy() {}
}
