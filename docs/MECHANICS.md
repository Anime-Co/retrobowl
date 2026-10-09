# Pocket Gridiron — Mechanics Spec

This is the implementation spec for the on-field and franchise mechanics. It follows the design of
New Star Games' *Retro Bowl* (2020) as closely as public sources allow. All names, art, wording
and audio are **original**. We copy no text, sprites, logos or music, and we don't use the name.

**Confidence tags**
- **[C] confirmed:** two or more credible sources agree, or the developer or wiki says so.
- **[L] likely:** one credible source.
- **[U] uncertain:** sources conflict or are weak.
- **[D] design decision:** our own call, made where the original is unknown or deliberately changed.

Every tunable number lives in one config file per module (`src/play/sim/tuning.js`,
`src/franchise/config.js`, `src/match/logic/config.js`), so values can be corrected without
touching logic.

> Research caveat: the research environment's egress policy blocked direct page fetches (fandom
> wiki, Reddit, Pocket Gamer, …). On-field findings come from search-result extracts of the cited
> pages. The player/franchise findings come from researcher recollection, with no reachable
> sources, and are mostly [U]. The source list is at the end.

---

## 1. Core loop

You coach one pro team. On match day you control **only the offense**, snap by snap. Opponent
possessions are **simulated** and shown as short text beats [C]. Between games you manage a small
roster of star players, coaching credits (CC), facilities, coordinators, morale, contracts, the
draft and free agency, across a 16-game season, playoffs and a championship final [L/U].

Matches are short: quarters of 1, 2 or 3 minutes of real game clock [C]. A whole game takes about
5–12 real minutes.

---

## 2. Pre-snap and passing

### 2.1 Personnel and formation
- Offense always fields 11: **QB, RB, 2 WR, 2 TE, 5 OL**. Defense fields 11: **4 DL, 3 LB, 4 DB**,
  with no CB/S split [L].
- On every pass play at least one TE blocks. Eligible targets are WR1, WR2, sometimes TE2, and the
  RB [L].
- [D] For variety, each play randomly chooses shotgun or under-centre QB depth, and whether TE2
  blocks or runs a route.

### 2.2 No play calling: the game assigns a play every down [C]
- Before each snap the game shows **one assigned play**, with route lines drawn on the field for
  the WRs, the TE that runs a route, and the RB's run path. You cannot pick from a playbook.
- Each play is a **run/pass package** [L]. The RB's designed run lane doubles as his pass route if
  you pass instead.
- **Change Play (audible)** [C]: swaps in another random play. You get a limited number per game,
  scaling with QB experience: rookies get 1, a max of 5 [D: `1 + floor(qbLevel/3)`, capped at 5].
  Audibles reset in overtime [L].
- **Route catalog** [L] (yards are depth before the cut):
  Go/streak; Fade (slight outside release, then vertical); Post (10–12 yd, then about 30° inside);
  Corner (10–12 yd, then about 30° outside); Curl (10–12 yd, then 3–4 yd back toward the QB);
  Quick In / Quick Out (90° cut at 5–7 yd); Deep In / Deep Out (90° cut at 12–15 yd);
  Slant (2–3 yd, then 45° inside); Flat (shallow toward the sideline, then upfield). TE routes are
  short or middle (Flat, Out, Seam, Drag). RB lanes: Dive, Off-tackle, Sweep left/right, with a
  checkdown flat or wheel after the run fake when passing.

### 2.3 Starting the play (no hike button) [C]
- **Tap the RB** (highlighted by a blue ring) to snap and hand off. This is a run play, and you then
  control the RB.
- **Touch and drag backward** (away from the goal) to snap and drop back. This is a pass play.
- Snap timing is otherwise automatic.
- Desktop: mouse drag works the same way. Click the RB, or press **H** or **Enter**, to hand off.
  [D] **Space** starts a drop-back for keyboard users, who then aim with the mouse.

### 2.4 Slingshot aiming [C]
- The drag vector is the **opposite** of the throw direction. Drag length sets throw distance,
  capped by Arm. Moving the finger steers the aim live, and lifting it throws. There is **no
  auto-target**: you throw to a spot and must lead moving receivers.
- The indicator is a **dotted arc** with a **ground shadow**. The ball arrives about head-high at
  the end of the shadow line, so the end of the shadow is the landing target [L].
- **Accuracy controls how much of the arc you can see** [C]. A low-accuracy QB shows only the
  first part of the arc; a max-accuracy QB shows almost all of it.
  [D] Visible fraction = 0.35 + 0.65 × accuracy, then lowered by difficulty (Hard −0.1,
  Extreme −0.2). The landing marker only shows when the arc is fully visible.
  [D] Throws also get a small random scatter that shrinks with accuracy (±1.5 yd at accuracy 1,
  ±0.2 yd at accuracy 10).
- **Arm** sets the maximum distance [C]. A weak arm can't reach 15 yd downfield; a strong arm
  regularly throws past 25 yd. [D] Max air distance from the QB = 22 + 4 × arm yards (26–62 yd).
  Ball speed scales with arm, and arm drops over the game at a rate set by Stamina [C].
- **Bullet pass** [C]: while aiming, a **second touch** (another finger) toggles a lob into a
  bullet: a flat, straight line and a much faster ball. It is harder to catch (needs Catching) and
  easier to intercept if misread, but harder to bat at the line. It can be toggled any number of
  times and resets to lob every play.
  Desktop: **right-click** or **B** while aiming toggles it.
- **QB run** [C]: during the drag, pull the finger forward past the QB so the aim collapses. The
  arc disappears and a run icon shows. Release and the QB tucks the ball and becomes a ball carrier.
  You can't pass after that [U→D]. Desktop: **R** also tucks and runs.
- Aim is cancelled if the QB is sacked.

### 2.5 Pass rush, sacks, blitzes
- DL rush on every pass and OL block them one-on-one. LBs may blitz in any combination [L].
  Pocket time is about **3–4 s**, slightly longer with a good OL [U]. Releasing quickly is the main
  sack-avoidance skill.
- Sacks can lose more than 5 yards [C]. A QB sacked in his own end zone is a **safety** [L].
- [D] Pocket model: each DL has a beat timer that depends on OL Blocking/Strength vs the
  defense's strength rating and difficulty, randomised ±25%. A beaten rusher runs at the QB.
  1–3 LBs blitz on about 35% of plays.

### 2.6 Catching, drops, tips, interceptions
- Receivers catch automatically when the ball arrives near them [C]. **Catching** sets how far off
  the ball's path they can reach, contested-catch success with a defender close, and fumble-on-catch
  odds [C]. Generic (non-star) receivers only catch balls placed right in their path and are bad on
  underthrows [C].
- **Interceptions**: a defender whose reach overlaps the ball's path can pick it off [C]. This is
  most likely on underthrown or early balls into a lane, throws that lead a receiver too far into a
  DB, and bullets [C]. An end-zone interception is a touchback [C].
- Tipped balls can be deflected and caught [C].
- [D] Catch resolution at the arrival point: the closest eligible player within reach wins the
  check (offense: `catchRadius = 0.9 + 0.12 × catching` yd; defense: `0.8 + 0.06 × skill` yd).
  When both are in range it is a contested roll weighted by skill, proximity, lob/bullet and
  difficulty. Possible outcomes: catch, incomplete (dropped or batted), or interception.
- Throwaways are fine: there are **no penalties** [C]. A ball out of bounds or into empty grass is
  incomplete and stops the clock [C].
- After a catch, control passes to the receiver as ball carrier [C].

---

## 3. Ball carrier and running

### 3.1 Auto-run with discrete moves [C]
- The ball carrier **runs toward the opponent's goal on his own**, at top speed set by Speed,
  weather and condition. On touch there's **no free steering**, only gestures:
  - **Swipe up/down → side-step (juke)**: a quick lateral burst of about 1.2 yd over about 0.22 s,
    while forward motion continues at a reduced rate [C/D].
  - **Swipe forward (toward the goal) → dive**: ends the run with about 1.5–2 extra yards and
    protects against fumbles. It is the go-to move for first downs and the goal line [C]. A QB past
    the line of scrimmage slides feet-first instead, which works the same way [C].
  - **Swipe backward → stutter**: a brief stall of about 0.4 s. With no defender within about 4 yd
    it plays a taunt animation instead [C]. Backward in your own end zone on a kick return →
    touchback [C].
  - **Press and hold → truck**: a charging meter; the runner is slower but plows through
    frontal contact and is vulnerable from behind. Charge time grows with each use on a down,
    weaker for QBs and non-stars [C, added 2025].
- **Juke diminishing returns** [C]: each consecutive side-step is less effective (×1.0, 0.7, 0.5,
  0.35…). Effectiveness recovers after about 0.8 s of straight running. Jukes also spend in-play
  stamina [L].
- **Burn** [C]: defenders lunge or dive when close. Side-stepping during the lunge makes the
  defender whiff and fall to the turf. This is the core thrill to get right.
- **Stiff-arms and hurdles are automatic** [C]. On contact, roll a stiff-arm (Strength) or a
  hurdle (Speed). The number of successes per run is budgeted. Veterans succeed more and rookies
  less [C].
- **Proximity slow-down** [C]: carriers are slightly held up by very close defenders.
- **Blocking** [C]: blocks are one-on-one, and an engaged defender can't make a tackle. A strong
  OL opens running lanes.
- **Fumbles** exist [C], on contact or on a catch. They are more likely with low Catching, low
  morale, rain or snow, rookies, and QB runs. Diving or sliding avoids them. [D] Base 1.2% per
  tackle, ×(1.6 − 0.12 × catching). The defense recovers about 65% of fumbles.
- **Out of bounds** ends the play at that spot and stops the clock [L].
- **Touchdown** = the ball crosses the goal line plane while carried [C].
- **Safety** = the ball carrier is downed in his own end zone [L]. [D] After a safety, the opponent
  gets a simulated possession starting from their 35.
- Desktop [L/D]: **W/S or ↑/↓** side-step (holding drifts laterally at a reduced speed);
  **forward key** (→/D when driving right, ←/A when driving left) dives; the opposite key stutters;
  **hold Space** to truck. Gamepad: stick up/down side-step, A dive, B stutter, hold X truck.

### 3.2 Defense AI while you have the ball [D, based on C]
- Defenders are CPU AI [C]. DL rush, LBs read run/pass (and blitz), DBs cover man-to-man on WRs,
  TE and RB with a deep safety help bias. All of them react to the throw and break on the ball
  when it is in the air.
- Pursuit takes angles and leads the carrier. A defender lunges when within about 1.6 yd and in
  front of or beside the carrier, with a short recovery if he whiffs.
- Difficulty scales defender speed, reaction time, lunge range and tackle strength. On Extreme
  every opponent plays as a 5-star team [C].

---

## 4. Kicking and special teams

### 4.1 Field goals and extra points: two-tap timing [C]
- **Stage 1, power:** a meter cycles from 0 to full to 0. Tap or click to lock it; the green top
  band gives full range.
- **Stage 2, aim:** an arrow sweeps left and right. Tap to lock, normally at the centre.
  **Accuracy** sets the sweep speed (higher accuracy = slower arrow) [C].
- **Range** sets the max distance; **Stamina** sets how much range fades over the game; **Speed**
  sets the delay before the ball leaves the foot [C]. If the player takes too long to lock the
  aim, the rush tackles the kicker and the kick fails [L].
  [D] The pressure limit is 3.2 s after the snap, plus 0.4 s at kicker Speed 1, down to 0 s at
  Speed 10.
- **Wind** pushes the ball sideways in flight; aim into it [C]. A wind icon shows direction and
  strength [U]. [D] Wind is 0–20 mph and drift grows with distance. A wind-probability option
  exists [C].
- Uprights have collision and can "doink" in or out [L].
- **FG availability** [C]: the kick option appears only when in range **and** it's 4th down, or
  time is running out at the end of the 2nd or 4th quarter. The longest possible kick is
  **66 yd** [C]. [D] FG distance = yards to goal + 17.
- **Extra point** [U]: placed for a kick from the opponent's 15. Our call: a 33-yd kick
  (the original may use the 20). Wind applies [C].
- [D] Range model: max distance = 38 + 2.8 × range yards (40.8–66 yd), × power factor, × stamina
  fade. Arrow sweep is ±22°. A well-timed centre lock is good from mid range.
- Desktop/keyboard: click, Space or Enter for each tap.

### 4.2 Automatic kicks [C]
- **Punts** are automatic. There is no punter; the K punts. [D] Distance = 38 + 1.4 × range ± 6
  yd, with a touchback at the 20 if it reaches the end zone.
- **Your kickoffs** are automatic. The opponent possession that follows is simulated.
- **CPU kicks** (FG, PAT, punts) are simulated text results, and the CPU can miss PATs [C].
- **No kicker on the roster**: a generic kicker with poor ratings is used [D].

### 4.3 Kick returns (interactive) [C]
- When the opponent scores, they kick off and **you control the returner**. You catch
  automatically and use the normal carrier moves. The return ends when the returner is tackled,
  steps out of bounds, or scores.
- **Touchback**: a back-swipe (or the back key) while in your own end zone starts the drive at
  your **25** [C].
- [D] The returner is the fastest star among WR, RB and DB (or a filler). Kick depth is 60–72 yd
  from their 35.

### 4.4 Decisions and conversions [C]
- **4th down**: a pop-up offers **PUNT** on your side of midfield, or **FIELD GOAL** when in range.
  Choosing "go for it" runs a normal play [L]. [D] Both options appear when both make sense
  (e.g. the opponent's 45 with a big leg).
- **After a TD**: choose a **1-pt kick** or a **2-pt try**, a single play from the opponent's
  **2-yd line** [C].
- **Onside kick** [L]: offered after you score while trailing in the 4th quarter. It shows a
  success chance of about 5% with a weak kicker, up to 15% with a strong one, resolved
  automatically. If it fails, the opponent starts with a short field.
- Scoring [C]: TD 6, FG 3, PAT 1, 2-pt 2, safety 2.

---

## 5. Match flow, clock and simulated defense

### 5.1 Clock [C/L]
- Four quarters of **1, 2 or 3 minutes** (option; default 2) [C].
- The clock **runs in real time while a play is live** [C].
- After an in-bounds tackle the clock **keeps running** through the next pre-snap, until the snap
  [L]. This is what makes timeouts and the sideline matter.
- The clock **stops** after incompletions, out of bounds, scores, turnovers and timeouts, until
  the next snap [L].
- [D] The pre-snap clock pauses while a decision pop-up (4th down, conversion) is open.
- **Timeouts**: 2 per half with 1–2 minute quarters, 3 per half with 3 minute quarters [C]. Offense
  only, between plays, by tapping the clock (desktop: **T**) [L]. They reset at halftime.
- There is **no two-minute warning** [U→D: none]. There are **no penalties** [C].
- End of half: if a play is live when the clock hits 0:00, the play finishes [D: standard].

### 5.2 Possessions
- [D] A coin toss decides the opening kickoff. The other team receives the 2nd-half kickoff.
- When **you receive**, you get an interactive kick return (§4.3).
- Any change of possession on your drive (INT, fumble, turnover on downs, punt, FG made or
  missed) leads to a **simulated opponent possession**. After the opponent scores, they kick off
  to you. After a defensive stop or takeaway you get the ball at the spot the sim says, or at
  your 25 on a touchback [C/D].

### 5.3 Simulated opponent possessions [C]
- Shown as **3–6 short text boxes** with no players on the field: the start, 1–3 key beats
  ("completion for 18", "sacked by #91 …", "3rd-down stop"), the result, and the PAT/2-pt
  outcome. Each auto-advances in about 1.2 s, tap to speed up. Turnover lines are short but
  unskippable [C].
- **Outcome model** [D, based on L]: the inputs are the opponent's OFF vs your DEF (stars plus the
  DC), difficulty, field position and clock. p(score) comes from a logistic of the rating
  difference, plus a field-position bonus, with high variance [L]. Results: TD, FG, punt, INT,
  fumble lost, turnover on downs, end of half [L]. Star defenders get credit by name for
  sacks/INTs and stats are tracked [L].
- **Clock runoff** grows with distance [L]: about 15 s on a short field up to about 40–50 s on a
  long TD drive at the 2-minute baseline. [Tuned] 9 s + 0.5 s per yard covered: a 3-and-out still
  costs real time, a long TD drive about 46 s, a short-field TD about 19 s. Scale with quarter length: 1 min ×0.5, 3 min ×1.5. If
  time runs out first, the drive ends with the half, with a small chance of a quick strike when
  the field is short [U→D].
- **Easy** is said to target about 80 combined points per game [C]. [Tuned, deliberate deviation]
  We land at about 45–50. The clock caps possessions at about 8.5 per team at 2-minute quarters,
  so 80 points would require opponents to score *more* on Easy, which defeats its purpose. Easy is
  instead clearly easier: a casual player wins about 85% of evenly rated games.

### 5.4 Overtime and ties
- [C, 2025 rules] Both teams get a possession in OT; after that it's sudden death. Easy always
  gives you the first OT possession [C].
- [D] The OT period lasts one quarter length. A regular-season game that's still tied at the end
  of OT is a **tie**. Playoff OT repeats until there's a winner.

### 5.5 Difficulty [C]
- **Easy, Medium, Hard, Extreme, Dynamic** (default). Dynamic uses 16 internal steps: +1 per win,
  −1 per loss, capped at step 9 until your first title. Extreme treats every opponent as a 5-star
  team.
- [D] Mapping: Easy → step 2, Medium → 6, Hard → 10, Extreme → 16. The step drives the opponent
  rating offset, defender AI speed/reaction, visible arc trim, and the sim-drive bias.
- [Tuned] Difficulty is **asymmetric** around Medium. Below it, each step lowers opponents by
  0.2★ (so Dynamic can rescue a weak team). Above it, each step adds only 0.05★ and a small
  sim-drive bias, because the symmetric slope made Hard unwinnable. Measured with the real engine
  at equal 3★ ratings, an average player wins about 45% on Medium and 32% on Hard.
- [Tuned] AI teams' on-field players are synthesized from their star ratings, with the attribute
  mean capped at 8.8. A 5★ or Extreme opponent is elite, not flawless.
- **Extreme** keeps the original's rule that every opponent plays as a 5★ team. It is meant for
  elite rosters: an evenly matched 3★ team is shut out (0 wins in 100 measured games), and a good
  player with a 4★ team wins about 10–15%. Dynamic (the default) is the mode for building up a
  weak team.

### 5.6 Weather [C/L]
- **Snow** slows players and raises fumbles. **Rain** raises fumbles and drops a little, and
  shows droplets. **Wind** only affects kicks [C].
- [D] Chances: snow 8% for northern cities in late season, otherwise 0%; rain 12%; wind
  (option: Off/Low/Normal/High) 35% at Normal.

### 5.7 HUD [U→D]
- A score bug across the top shows both team abbreviations and scores, the quarter, the clock
  (tap it for a timeout, with timeout pips), down & distance, and the ball spot. There is also an
  audible counter and button.
- On the field: a **blue line of scrimmage** and a **yellow first-down line** [C]. Route lines
  pre-snap, and the RB's blue ring.
- **Drive direction option**: Left / Right / Alternate (flips at halftime) [L]. Right-handed
  players are advised to drive left so the hand doesn't cover the field [L].
  [D] Portrait mode always drives **up**.
- **Camera zoom toggle**: Near / Far [L].

---

## 6. Players

### 6.1 Roster [L/U]
- You manage only **named star players**. Every other on-field slot is a **generic filler** with
  low ratings (about 1–1.5 stars) that never appears on the roster [L].
- **Roster cap: 12 stars** [U; the original has 10 free and 12 with its paid upgrade]. Injured
  players count toward the cap.
- Star slots fill on-field roles in order: QB → QB; RB → RB; WR → WR1, WR2; TE → TE1, TE2;
  OL → best 5 OL; K → K; DL → 4 DL; LB → 3 LB; DB → 4 DB. Extra stars at a position sit on the
  bench and auto-fill when a starter is injured.

### 6.2 Attributes [U→D]
Four attributes per player, **1–10 scale** [L], shown as 10-segment bars:

| Pos | Attributes |
|---|---|
| QB | Arm, Accuracy, Speed, Stamina |
| RB, WR, TE | Speed, Strength, Catching, Stamina |
| OL | Blocking, Strength, Speed, Stamina |
| DL, LB, DB | Tackling, Strength, Speed, Stamina |
| K | Range, Accuracy, Speed, Stamina |

- **Generic fillers** play at replacement level on the field (skills about 0.08–0.14), but count as
  1.25★ in team ratings, so ratings stay readable. Any star beats a filler at their key attributes.
- **Overall stars**: 0.5–5.0 in half-star steps [C], from a position-weighted mean of the
  attributes [D]. Weights: QB Acc .35 Arm .35 Sta .2 Spd .1; skill players Spd .35 Cat .3 Str .2
  Sta .15; OL Blk .45 Str .35 Sta .1 Spd .1; defense Tck .35 Spd .3 Str .25 Sta .1; K Rng .45
  Acc .45 Spd .05 Sta .05.
- **Team ratings** OFF and DEF are shown as stars, 0.5–5 [U→D]. They combine starters (stars or
  fillers) by position weight, plus a coordinator boost of +0.1 to +0.5 stars.
  [Tuned] The formula is an *ordered* weighted mean that counts the best players in a unit most
  (top-heavy factor 2.2). With 12 stars spread over 23 slots, a plain mean drowned every star in
  fillers. The ordered form never drops when a better player joins, and a unit of equal players
  rates exactly their stars. Signing a 3★ defender adds about +0.25★ DEF; a 4★ DB adds about
  +0.5★.

### 6.3 XP and level-ups [U→D]
- Players earn XP from production: yards, catches, TDs, completions, made kicks; for defenders,
  sim tackles, sacks and INTs. Training facility and coordinator multipliers apply [L].
- A full XP bar earns a **skill point**. The user taps an attribute to raise it by +1 (max 10) [D].
- [D] XP per level = 100 × level^0.8. Rookies under 25 get ×1.3 XP; players over 30 get ×0.6.
- Attributes respect a hidden per-player **potential** cap (sum of attributes), revealed loosely
  as "Potential ★" in scouting.

### 6.4 Age, progression, retirement [U→D]
- Age goes up every offseason. Rookies are 21–23, the peak is 26–30. Players over 30 lose Stamina
  plus Strength or Speed every offseason [L]. Retirement odds rise from 32 to 36. Kickers last
  about 4 years longer.

### 6.5 Morale, condition, injuries [U→D]
- **Morale** is 0–100, shown as 5 faces. It rises with wins, production and good press answers,
  and falls with losses, few touches, and refused requests. On the field it's worth about ±8%
  performance; defenders with low morale miss more tackles [C]. Low morale raises contract demands
  and can lead to refusing to re-sign. CC can be spent to lift it.
- **Condition** is 0–100%, energy that drops with in-game usage and recovers between games
  (faster with Rehab). Under about 60% performance noticeably drops [L].
- **Injuries**: about 0.6% per hit on a star, scaled up by low condition. Typically 1–6 weeks,
  rarely season-ending. Rehab shortens them. CC can buy "rush treatment" (−1 week). An injured star
  is replaced by a bench star or filler.

### 6.6 Contracts and cap [L/U→D]
- Each star has a salary in $M (one decimal) and 1–5 years remaining [L]. A **salary cap** blocks
  signings over it [L]. Fillers are free.
- [D, tuned] Cap $60.0M, rising $0.5M per season. Asking salary is about 0.3 + 1.0 × stars^1.6 $M,
  × age and morale factors. By season 3+ the cap usually blocks one re-sign or wanted free agent per
  offseason. Rookie deals: 3 years at 0.5–1.5M.
- Expiring contracts: the player asks for a salary and length. Accept, or let him go. If morale is
  under 25 he may refuse.
- **Release** a player any time: frees the roster spot and 50% of the remaining salary this season
  ([D] dead money), and slightly lowers team morale.

---

## 7. Franchise

### 7.1 League and season [L/U→D]
- **32 city-only teams**, 2 conferences × 4 divisions × 4 teams (`src/data/teams.js`), with
  original colours [L/D].
- **16-game regular season** [U]. [D] Schedule: 6 division games (home and away), 4 vs another
  division in the same conference, 4 vs a division in the other conference, and 2 vs same-place
  teams. One game per week.
- **Playoffs** [U→D]: 7 per conference (4 division winners seeded 1–4, then 3 wildcards). The #1
  seed gets a bye. Rounds: Wild Card → Divisional → Conference → **the Final** (neutral site,
  named "Gridiron Cup" [D]). Single elimination, higher seed hosts.
- Tiebreakers [D]: win%, head-to-head, division win%, conference win%, point differential, coin
  flip.
- AI teams are abstract: OFF/DEF star ratings that drift each season, with mean reversion and a
  boost after a bad season (draft effect).

### 7.2 Coaching credits (CC) [L/U→D]
- CC is the single scarce meta currency, spent on facilities, coordinators, free-agent signing
  fees, morale boosts and rush treatment [L].
- [D, tuned] Earning: +1 per game, +1 more for a win, +1 for a win by 21+, +3 per playoff win,
  +6 for winning the Final. That works out to one meaningful purchase about every 3 games in season
  1. Press answers can give ±1. Start the career with 6 CC.

### 7.3 Facilities [L/U→D]
- **Stadium**, **Training**, **Rehab**, each at levels 1–5 [L].
  - Stadium: fan growth, home-field edge, CC bonus +1 per home win at level 4+.
  - Training: XP ×(1 + 0.15 × (lvl − 1)).
  - Rehab: injury duration ×(1 − 0.12 × (lvl − 1)), condition recovery up.
- Upgrade cost [D, tuned]: 5 / 9 / 14 / 20 CC to reach levels 2–5. Each offseason, every facility above
  level 1 has a 35% chance to drop one level unless "maintained" (pay 2 CC per facility) [U→D].

### 7.4 Coordinators [L/U→D]
- An **OC** and a **DC**, each rated 1–5 stars. They add to team OFF/DEF and speed XP on their
  side of the ball. Hiring costs CC (stars × 3) and they keep a 3-season contract. In the
  offseason, three candidates appear for each role.

### 7.5 Fans and job security [U→D]
- **Fan support** is 0–100 and moves with wins, streaks, big wins, playoff runs, Stadium level and
  press answers.
- **Owner confidence** is 0–100, driven by results vs expectation. Below 15 at season end, you're
  **fired**. You then take an offer from a weaker team or start over [U: the original pro game may
  not have firing; kept mild].

### 7.6 News, press and player messages [L/U→D]
- Between games there are 0–2 short events: press questions or player messages with 2–3 choices.
  Each choice visibly shifts fans, team morale, a named player's morale, or CC. All text is
  original. A news feed lists league results, streaks, injuries, signings and records.

### 7.7 Draft and free agency [L/U→D]
- **Draft** after the Final [L]. Order is reverse standings, with the champion last. **3 rounds**
  [U→D] and about 60 prospects. Each prospect shows position, age and an estimated star range;
  "Scout" (1 CC) reveals exact stars and potential. A pick needs a free roster spot (you can
  release or pass).
- **Free agency**: a pool of 10–14 stars during the season, refreshed every 4 weeks and in the
  offseason. Signing needs cap room, a roster spot and a CC fee of ceil(1.5 × stars), so a signing competes
  with facilities and coordinators.
- There are **no trades** [U].

### 7.8 Offseason order [U→D]
Season summary and awards → retirements → expiring contracts (re-sign or release) → aging and
progression → facility decay or maintenance → coordinator market → draft → free agency → new
schedule (week 1). Each step is a quick screen; all of it should take under 2 minutes.

### 7.9 Records and history [U→D]
Career history (season records, titles), single-season and career leaders for your team, a Hall
of Fame for retired stars with big careers, and longest-FG records.

---

## 8. Presentation [L/U→D]

- **Side-on, slightly elevated camera**. The field scrolls horizontally in landscape and the
  camera follows the ball [L]. Pixel art, team-coloured players, end zones with city names [D].
- **Portrait support** [D, our addition]: the field rotates to vertical with the offense driving
  up. Every control is the same, with the axes rotated.
- Pre-snap overlay: route lines, the RB's blue ring, and a short hint for first-time users.
- Post-play banners: "+12", "FIRST DOWN", "TOUCHDOWN!", "INTERCEPTED", "SACK".
- Opponent drives: text boxes over a dimmed field.
- Menus are a team hub with tabs (Home/News, Roster, Schedule, Standings, Staff & Facilities,
  Draft/FA in season), pixel fonts, and chunky buttons.
- Audio: original chiptune SFX and a crowd bed. No copied music.
- Options: sound, quarter length, difficulty, drive direction, camera zoom, wind frequency,
  vibration, "show tips".

---

## 9. Deliberate deviations

| Original | Pocket Gridiron |
|---|---|
| "Retro Bowl" name, logo, title art | "Pocket Gridiron", original logo text |
| Final named "Retro Bowl" | "Gridiron Cup" |
| Real-market city teams with loosely real colours | Mix of real cities, all with original colours |
| Sprite art, UI art, fonts, music | Procedural original pixel art, Google Fonts (OFL), synthesized SFX |
| Paid "Unlimited" upgrade (12-man roster, kick returns, editor) | Everything free: 12-man roster and kick returns on by default |
| Landscape only | Landscape and portrait |
| Ad-supported | No ads |

---

## 10. Open questions (verify when the sources can be read)

1. Exact CC amounts per result and facility/coordinator prices.
2. Roster cap, attribute names and scale, and the star formula.
3. Whether the clock really keeps running through the pre-snap after in-bounds plays (we assume
   yes), and the exact runoff on simulated drives.
4. PAT distance (15 vs 20).
5. Season length (16 vs 17), playoff size, OT details.
6. Whether pro-mode firing exists.

---

## Sources (read via search extracts)

- Retro Bowl Wiki: retro-bowl.fandom.com/wiki/ Gameplay, Positions, Tips, Kickoff, Change_Play,
  Field_Goals, Star_System, Weather, Scoring, Quarters, Options
- Developer posts: x.com/retro_bowl (2020 control and design posts)
- Store listings: apps.apple.com/us/app/retro-bowl/id1478902583; poki.com/en/g/retro-bowl;
  kongregate.com/en/games/siread/retro-bowl; apkmirror.com (v1.4.93 changelog)
- Reviews and guides: pocketgamer.com (review and running tips), pockettactics.com/retro-bowl/review,
  nintendolife.com/reviews/switch-eshop/retro-bowl, operationsports.com (update and patch-note
  articles, review), purenintendo.com, geektogeekmedia.com, theretronetwork.com,
  toucharcade.com community thread, tryhardguides.com/how-to-juke-in-retro-bowl,
  robwritesaboutwhatever.com (2021 roster and game guides), levelwinner.com guide,
  speedrun.com/retro_bowl forums, goombastomp.com web guide, YouTube (66-yd FG clips)
