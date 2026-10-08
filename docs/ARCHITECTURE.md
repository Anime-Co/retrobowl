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

```js
import { PlaySim } from './src/play/sim/PlaySim.js';
const sim = new PlaySim(setup /* PlaySetup, see types.js */);
sim.update(dt);              // fixed 1/60 s; deterministic for a given setup.seed + command stream
// commands (called by the controller, any time; ignored when not applicable)
sim.snap();                  // presnap -> live (no-op otherwise)
sim.aimStart();              // begin aiming a pass (QB has ball, behind LOS)
sim.aimAt(x, y);             // world landing target for the pass; engine clamps by arm strength
sim.aimRelease();            // throw at current target
sim.aimCancel();
sim.move(dx, dy);            // desired movement direction for the user-controlled player (QB scramble /
                             // ball carrier), components -1..1 in WORLD axes; (0,0) = default behaviour
sim.juke(dir);               // dir -1 (toward y-) | +1 (toward y+)
sim.dive();
sim.kickAim(aim, power);     // kicks: aim -1..1 lateral, power 0..1 (live preview)
sim.kick();                  // execute kick with current kickAim
// read-only state (renderer/controller)
sim.phase   // 'presnap'|'live'|'air'|'carry'|'kick'|'dead'
sim.t       // seconds since snap
sim.players // Entity[]: {id, side:'off'|'def', pos, slot, x, y, vx, vy, dir:{x,y}, anim, animT,
            //            number, squad: SquadPlayer, hasBall, controlled, down:boolean, route?}
sim.ball    // {x, y, z, vx, vy, vz, state:'held'|'air'|'loose'|'kicked'|'dead', holder:id|null, target?:{x,y}}
sim.aim     // null | {x, y, maxDist, path:[{x,y,z}], valid}
sim.kickState // null | {aim, power, wind, preview path}
sim.losX, sim.firstDownX, sim.setup
sim.events  // SimEvent[] appended during update; consumer drains with sim.drainEvents()
            // {type:'snap'|'throw'|'catch'|'drop'|'deflect'|'int'|'tackle'|'broken_tackle'|'juke'|
            //   'dive'|'sack'|'td'|'oob'|'safety'|'kick'|'kick_good'|'kick_miss'|'first_down_line'|
            //   'whistle', x, y, ...}
sim.result  // PlayResult | null (set once phase === 'dead')
```

The sim owns all rules of a single play: formations, routes (randomised per play per MECHANICS),
blocking, pass rush, coverage, pursuit, catching/interceptions, tackling, juke/dive, out of bounds,
touchdown/safety detection, FG/PAT physics with wind, and stat attribution.

## PLAY-VIEW contract (`src/play/view/`, `src/render/sprites.js|field.js|fx.js`)

```js
import { PlayView } from './src/play/view/PlayView.js';
const view = new PlayView(app, { setup, homeLook, awayLook, hud: {...} });
view.update(dt);   // polls app.input, maps gestures → sim commands, steps sim, camera, fx, audio
view.render(alpha);// draws field + entities + aim/kick UI + fx into app.display
view.done          // true after result shown and the post-play beat has elapsed
view.result        // PlayResult
view.destroy();
```

The controller implements the control scheme in MECHANICS.md for touch and for mouse/keyboard/
gamepad, and shows minimal on-canvas hints the first few plays. Sprites are procedurally drawn
pixel art (original designs) in team colours, cached per team/facing/frame.

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

## MATCH contract (`src/match/`)

`src/match/logic/` (DOM-free): `Match` state machine (quarters, clock, downs, possession, score,
timeouts, decisions), `simDrive()` for opponent possessions, `simulateGame()` for AI-vs-AI.
`src/match/MatchScreen.js`: the `match` screen — shows the stage, runs `PlayView` for user snaps,
shows opponent drive summaries, 4th-down / conversion decisions, scorebug HUD, end-of-quarter and
final screens, then calls `applyUserGameResult` and goes to `postGame`.

## Testing

- `npm test` — unit tests (`node --test tests/unit/*.test.js`). Each module ships tests,
  including headless soak tests (e.g. 2,000 bot-driven plays never hang/NaN; 10 simulated
  seasons keep the save consistent).
- `npm run e2e` — Playwright smoke across desktop / mobile portrait / mobile landscape. Use
  `tests/e2e/harness.mjs` (`withBrowser`, `drag`) for scripted checks; screenshots go to
  `test-results/` (git-ignored).
