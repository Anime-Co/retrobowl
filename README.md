# Pocket Gridiron

A retro arcade football game with a full franchise mode, for phones (portrait and landscape) and
desktop browsers. You run the offense snap by snap while the opponent's possessions are simulated.
Between games you manage a small roster of star players, coaching credits, facilities, the draft
and free agency. The mechanics follow the design popularised by *Retro Bowl* (New Star Games); the
name, art, text and sound are all original.

## Play

No build step and no dependencies: serve the folder statically.

```sh
npm start            # http://localhost:8080
```

Any static host works, including GitHub Pages. Add `?sandbox` to the URL for a dev screen that runs
endless single plays.

## Controls

| | Touch | Mouse / keyboard |
|---|---|---|
| Run play | Tap the running back (blue ring) | Click the RB, or H / Enter |
| Pass | Drag back from the QB to aim, release to throw | Same with the mouse; Space drops back |
| Bullet pass | Second finger while aiming | Right-click or B while aiming |
| QB run | Pull the drag forward past the QB, release | R |
| Juke / dive / stutter | Swipe sideways / forward / back | W/S or ↑/↓ · forward key · back key |
| Truck | Hold a finger down | Hold Space |
| Field goal / PAT | Tap to lock power, tap to lock aim | Space / Enter / click |
| Timeout · Change play · Pause | Tap the clock · button · pause | T · C · Esc |

In landscape you can set the drive direction (right, left, or alternate halves) in Settings.
Left-handed players usually prefer driving right.

## Development

```sh
npm test             # unit tests: play engine, match logic, franchise, balance (node --test)
npm run e2e          # boot smoke test in desktop / phone portrait / phone landscape (Playwright)
npm run e2e:ui       # full career flow through the UI on several viewports
npm run balance      # balance report: full matches and careers on the real engine
node tests/e2e/play-view.mjs     # gesture and controls checks
node tests/e2e/match-flow.mjs    # match screen, HUD and decisions
```

- `docs/MECHANICS.md`: the mechanics spec, with research sources, confidence tags and tuned values.
- `docs/ARCHITECTURE.md`: module boundaries and contracts.
- Tuning lives in `src/play/sim/tuning.js` (on-field), `src/match/logic/config.js` (clock,
  simulated drives) and `src/franchise/config.js` (economy, ratings, difficulty).
