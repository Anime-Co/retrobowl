# Pocket Gridiron — Architecture & Module Contracts

Pocket Gridiron is a mechanically faithful, originally-branded remake of the arcade-football +
franchise-management loop popularised by Retro Bowl. **Mechanics** come from `docs/MECHANICS.md`.
**Names, art, text, music are original** — never copy New Star Games assets, logos, wording or
the "Retro Bowl" name; teams are city-only with original colours (`src/data/teams.js`).

## Tech rules

- Vanilla JavaScript ES modules, **no build step, no runtime dependencies**. Must run from any
  static host (GitHub Pages, `npm start`, claude.ai artifact). Relative imports with `.js`.
- Style: 2-space indent, semicolons, single quotes, small functions, JSDoc for public APIs.
  Types shared across modules live in `src/types.js` (JSDoc typedefs only).
- **Determinism:** all logic randomness goes through `Rng` (`src/core/rng.js`). `Math.random` is
  only allowed for cosmetic effects (particles, camera shake).
- **Pure logic is DOM-free** (`src/play/sim/**`, `src/franchise/**`, `src/match/logic/**`) so it can
  be unit-tested with `node --test` and soak-tested headless.
- Rendering of the field is canvas 2D at a low virtual resolution (`Display`, short side ≈ 270px,
  integer-scaled, nearest-neighbour). Menus/HUD are DOM (`#ui`, `#hud`) styled by `styles.css`.
- Works with **touch, mouse, keyboard and gamepad**, in **portrait and landscape**. Touch targets
  ≥ 44 CSS px. Respect safe-area insets. No hover-only interactions.
- Storage via `src/core/storage.js` only (all access try/catch; game must work without storage).

## Directory ownership

| Path | Owner module | Notes |
|---|---|---|
| `index.html`, `styles.css` (base), `manifest.webmanifest` | foundation | screen modules append CSS in clearly marked sections |
| `src/core/*` (rng, util, loop, input, storage, audio) | foundation | audio SFX may be extended by ART |
| `src/render/display.js`, `src/render/camera.js` | foundation | |
| `src/app.js`, `src/main.js`, `src/ui/dom.js`, `src/types.js`, `src/data/teams.js` | foundation | |
| `src/play/sim/**` | PLAY-SIM | headless on-field simulation, AI, formations, routes, kicking physics |
| `src/render/sprites.js`, `src/render/field.js`, `src/render/fx.js`, `src/play/view/**` | PLAY-VIEW | drawing, controller (input→commands), `PlayView` component, sandbox |
| `src/franchise/**`, `src/data/names.js` | FRANCHISE | league, players, season, economy, draft, news, squad builder |
| `src/match/**` | MATCH | match state machine, sim drives, AI-vs-AI game sim, `MatchScreen`, HUD |
| `src/ui/screens/**` (except match) | UI | title, new game, hub tabs, offseason flows, settings, help |
| `tests/unit/*.test.js` | each module | name files after the module (`play-sim.test.js`, ...) |
| `tests/e2e/*` | foundation/QA | Playwright harness: `tests/e2e/harness.mjs` |

Agents must not edit files owned by another module except trivial import-path fixes; request
changes in their final report instead.

## Coordinate system (on-field)

World units are **yards**. `x ∈ [0,120]` along the field: `0–10` is the offense's own end zone,
`10` its goal line, `110` the opponent goal line, `110–120` the end zone being attacked. The user's
offense **always attacks +x** (the engine works in the offense frame; the match layer converts
"yards from own goal" = `x − 10`). `y ∈ [0, 53.33]` sideline to sideline (`FIELD_W` in camera.js),
hashes at `y ≈ 23.58` and `29.75`. `z` = height (ball). `Camera` maps world → screen for both
orientations (landscape: +x→right; portrait: +x→up). Sprites choose a facing via
`camera.facingFor(dx, dy)` → `'right'|'left'|'up'|'down'`.

## Global services (`App`)

`app.display` (Display), `app.input` (Input), `app.audio` (Audio, `app.sfx(name)`),
`app.settings` (+ `app.updateSettings(patch)`), `app.save` (Save | null, `app.persist()`),
`app.go(screenName, params)`, `app.showStage(bool)` (show the canvas layer), `app.hudEl` (DOM
layer over the canvas, `pointer-events:none` except `.interactive`), `app.uiRoot` (`#ui`, modal
host), `app.vibrate(ms)`. The fixed-step loop calls `screen.update(dt)` (dt = 1/60) and
`screen.render(alpha, frameDt)` on the active screen. `window.__app` is exposed for tests.

Screens: `class X { constructor(app, params); mount(root); unmount(); update?(dt); render?(a, fdt) }`.
Registered in `src/ui/screens/index.js`. Stable names:
`title`, `newGame`, `hub` (params `{tab}`), `match` (params `{gameId}`), `postGame`
(params `{gameId, summary}`), `offseason` (params `{step}`), `settings`, `help`, `fired`,
`sandbox` (dev: single plays without franchise).

## PLAY-SIM contract (`src/play/sim/`)

Implements MECHANICS.md §2–§4 for ONE play. Deterministic for a given `setup.seed` + command stream.

```js
import { PlaySim } from './src/play/sim/PlaySim.js';
const sim = new PlaySim(setup /* PlaySetup, see types.js */);
sim.update(dt);              // fixed 1/60 s
// ---- commands (called by the controller; ignored when not applicable) ----
// pre-snap
sim.changePlay();            // audible: re-roll the assigned play (match layer enforces the count)
sim.handoff();               // snap + hand off to RB (tap on RB). Run play.
sim.dropBack();              // snap + QB drops back (first backward drag / Space). Pass play.
// passing (QB has ball, before tuck / before crossing LOS)
sim.aimAt(x, y);             // world landing target (controller maps slingshot drag -> target);
                             // engine clamps to arm range; sets sim.aim
sim.aimRunMode(on);          // drag collapsed past the QB -> "run" icon; release will tuck & run
sim.toggleBullet();          // lob <-> bullet while aiming
sim.release();               // throw at current aim (or tuck & run if aim run mode)
sim.aimCancel();
sim.tuck();                  // QB tucks and becomes the ball carrier (keyboard R)
// ball carrier (also kick returner)
sim.sideStep(dir);           // dir -1 = toward y-, +1 = toward y+ (WORLD axes)
sim.drift(dir);              // continuous lateral drift while key held (-1|0|1)
sim.dive();
sim.stutter();               // also: in own end zone on a kick return -> touchback
sim.truck(on);               // hold to truck
// FG / PAT
sim.kickTap();               // 1st tap locks power, 2nd tap locks aim and kicks
// ---- read-only state for the view ----
sim.phase      // 'presnap'|'dropback'|'air'|'carry'|'kick'|'return'|'dead'
sim.t          // seconds since snap (0 in presnap)
sim.play       // assigned play: {name, qbDepth, routes:[{playerId, points:[{x,y}], type}], runLane, teBlocks}
sim.players    // Entity[]: {id, side:'off'|'def', pos, slot, x, y, vx, vy, face:{x,y}, anim, animT,
               //            number, squad: SquadPlayer, hasBall, controlled, down, lunging, blocking}
sim.ball       // {x, y, z, vx, vy, vz, state:'held'|'air'|'loose'|'kicked'|'dead', holder:id|null, bullet}
sim.aim        // null | {tx, ty, valid, runMode, bullet, path:[{x,y,z}], visibleFrac, maxDist}
sim.kick       // null | {stage:'power'|'aim'|'flight'|'done', power, aim, wind:{x,y}, pressure, path}
sim.losX, sim.firstDownX, sim.setup, sim.weather
sim.drainEvents() // SimEvent[] since last drain:
               // {type:'snap'|'handoff'|'throw'|'catch'|'drop'|'deflect'|'int'|'tackle'|'burn'|
               //   'stiffarm'|'hurdle'|'juke'|'dive'|'stutter'|'truck_hit'|'sack'|'fumble'|'td'|'oob'|
               //   'safety'|'kick'|'doink'|'kick_good'|'kick_miss'|'touchback'|'whistle', x, y, ...}
sim.result     // PlayResult | null (set once phase === 'dead')
```

Kinds (`setup.kind`): `'scrimmage'` (normal down; also used for the 2-pt try from the 2),
`'fg'`, `'pat'`, `'kick_return'` (opponent kicks off; the user controls the returner; the result's
`endX` is the new line of scrimmage in the user's offense frame, or a touchback at the 25).

## PLAY-VIEW contract (`src/play/view/`, uses `src/render/*`)

`PlayView` owns everything drawn on the canvas for ONE play and all on-field input:
field, players, ball, pre-snap route lines + RB blue ring, aim arc (first `aim.visibleFrac`,
shadow, landing marker when `showMarker`), bullet/run-mode indicators, kick power meter / aim arrow /
wind icon / pressure, on-field banners ("+12", "FIRST DOWN", "TOUCHDOWN!", "INTERCEPTED",
"SACK", "NO GOOD"...), fx, camera (follow, zoom per settings, drive direction per settings and
orientation), on-field SFX, first-plays control tips (settings.showTips).

```js
import { PlayView } from './src/play/view/PlayView.js';
const view = new PlayView(app, {
  setup,                 // PlaySetup from Match
  userLook, oppLook,     // TeamLook (abbr, city, primary, secondary, helmet)
  driveLeft,             // boolean: landscape screen direction for this play (portrait always up)
  onSnap,                // () => void, called once when sim.phase leaves 'presnap'
});
view.update(dt);          // input → sim commands, sim.update, camera, fx (skips sim when view.paused)
view.render(alpha);       // draws into app.display (begin/present inside)
view.paused = true|false; // MatchScreen pauses during modals; input ignored while paused
view.changePlay();        // audible (MatchScreen enforces count via Match.useAudible())
view.sim                  // the PlaySim (read-only for others)
view.result               // PlayResult once the whistle blows (available immediately at whistle)
view.done                 // true after the post-play beat (~1.2–1.8 s after the whistle; tap skips)
view.destroy();
```

Extra options (as implemented): `insets` ({top,right,bottom,left} CSS px covered by the HUD; may be
a live object), `tips` / `zoom` (override settings), `keepCrowd` (destroy() leaves the crowd bed
running), `beat` (post-play pause seconds). `update(dt, events)` accepts pre-polled input.
Controls and feel knobs: `CONTROL` in `src/play/view/controller.js`, `VIEW` in `PlayView.js`.

`IdleFieldView` (same module) draws the field with players standing at a given spot, used by
MatchScreen behind opponent-drive text boxes and between steps: `new IdleFieldView(app,
{losX, userLook, oppLook, driveLeft, firstDownX?, hashY?, offense:'user'|'opp', dim?, showPlayers?,
keepCrowd?}); .update(dt); .render(alpha)`.

A dev `sandbox` screen (`src/play/view/SandboxScreen.js`, registered as `sandbox`) runs endless
single plays with test squads for tuning the feel; reachable via `?sandbox` URL param.

## MATCH-SCREEN contract (`src/match/MatchScreen.js`, `src/match/hud.js`)

The `match` screen (params `{gameId}`) drives `Match` (src/match/logic) step by step using
franchise `matchSetup(save)` + user settings, shows the stage, creates a `PlayView` for each
`play` / `kick` / `kick_return` step (submitting `view.result` to `m.submitPlay` at the whistle),
calls `m.onSnap()` via `onSnap`, ticks `m.tickClock(dt)` while `m.state.clockRunning`, and owns the
DOM HUD in `app.hudEl`: scorebug (abbrs in team colours, scores, quarter, clock — tap for timeout
with pips, down & distance, ball spot), Change Play button with count, pause menu (resume /
settings toggles / quit to hub), decision modals (4th down, conversion, onside, end-of-half FG
button on `canFieldGoal`), opponent-drive text boxes over an `IdleFieldView`, quarter / halftime /
OT / final overlays, then `applyUserGameResult` → `setPendingPostGame` → `app.persist()` →
`app.go('postGame', {gameId, result, summary})`. The recap stays in `save.pendingPostGame` until the
week advances, so title Continue / the hub's "Game recap" button can reopen it after a reload. Mid-game state is not persisted (quitting forfeits nothing: the game stays
unplayed).

## FRANCHISE contract (`src/franchise/`)

Pure functions over the `Save` object (mutate in place, return useful summaries). Key exports
(module `src/franchise/index.js` re-exports everything):

```js
newFranchise({ coachName, teamId, seed, difficulty }) -> Save
userTeam(save) -> Team; teamById(save, id) -> Team
currentWeekGames(save) -> Game[]; nextUserGame(save) -> Game | null
buildSquad(save, teamId) -> Squad          // user team from roster; AI team from ratings
applyUserGameResult(save, matchResult) -> PostGameSummary   // stats, XP, CC, morale, injuries, fans, news
simulateOtherGames(save)                   // AI vs AI for current week (uses match/logic/gameSim)
advanceWeek(save) -> { phaseChanged, ... }
standings(save) -> rows; playoffPicture(save)
// roster & economy
trainPlayer(save, playerId, attr) ; releasePlayer(save, id) ; extendContract(save, id, years)
upgradeFacility(save, kind) ; hireCoordinator(save, role, candidate)
// offseason pipeline
offseasonSteps(save) -> step list; runOffseasonStep(save, step, choice)
draftProspects(save); scoutProspect(save, id); draftPlayer(save, id)
freeAgents(save); signFreeAgent(save, id)
resolveNews(save, newsId, choiceIndex)
```

## MATCH-LOGIC contract (`src/match/logic/`)

DOM-free `Match` state machine — see the header of `src/match/logic/Match.js` for the exact Step
types (`coin`, `kick_return`, `play`, `decision`, `kick`, `opp_drive`, `auto`, `quarter_end`,
`halftime`, `ot_start`, `final`) and methods (`next`, `ack`, `choose`, `submitPlay`, `onSnap`,
`tickClock`, `callTimeout`, `useAudible`, `fieldGoalAvailable`).

## Testing

- `npm test` — unit tests (`node --test tests/unit/*.test.js`). Each module ships tests,
  including headless soak tests (e.g. 2,000 bot-driven plays never hang/NaN; 10 simulated
  seasons keep the save consistent).
- `npm run e2e` — Playwright smoke across desktop / mobile portrait / mobile landscape. Use
  `tests/e2e/harness.mjs` (`withBrowser`, `drag`) for scripted checks; screenshots go to
  `test-results/` (git-ignored).
