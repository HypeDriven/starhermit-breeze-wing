# Breeze Wing — Game Design Document (running spec)

Present tense: this document describes what the shipped game does today. Anything the design wants
that the code does not yet do is listed once, at the end, under "Design intent not yet implemented".

## 1. Overview

**Pitch.** One button, one bird, one storybook sky: tap to lift, thread the glowing gap between two
terracotta pillars, and land as close to the centre of the gap as you dare — every gate is 100
points, but the middle of the gate is where streaks and scores are made.

| | |
|---|---|
| Genre | One-button arcade flight (gravity + impulse lift, scrolling gates), solo |
| Players | 1; asynchronous comparison through daily and score-chase leaderboards |
| Session length | 20–90 s per round; a sitting is typically 3–10 rounds (5–15 min) |
| Platforms | StarHermit engine script game (engine 1.28.0, host API 1.30): natively in the StarHermit client and in browsers through the engine's web runtime; landscape and portrait |
| Rendering | `starhermit:scene` (three.js-shaped) procedural 3D sky under a `starhermit:ui` shell; no image textures in the scene; post effects chosen by the runtime's graphics level (§13 Graphics) |
| Simulation | The runtime's fixed 60 Hz steps, deterministic, seeded; rules run identically in the engine and Node |

### File map

| Path | Role |
|---|---|
| `starhermit.txt` | Manifest: `launch=index.html`, `engine.entry=native/main.ts`, `engine.version=1.28.0`, `engine.minor=30`, capabilities `platform,storage,clipboard`, the five `control.*` actions with their gamepad defaults |
| `index.html`, `starhermit-files.json` | The engine's web loader and file index, written by `npm run package` (never edited by hand) |
| `native/main.ts` | Entry module: app state machine, fixed-step round, countdown, flap / undo / pause, progression and achievements, safe snapshot, input routing, lifecycle |
| `native/screens.ts` | Every screen and the HUD in `starhermit:ui` (immediate mode), layouts by window size, drawn glyphs, the title emblem and results horizon art |
| `native/render.ts` | The sky in `starhermit:scene`: bird, gates, islands, clouds, sky dome and sea (WGSL), sun and halo, particles, motes, ghost arc, camera, image-based light, post effects |
| `native/quality.ts` | The browser build's graphics presets and budgets keyed by the runtime's quality tier and level |
| `native/audio.ts` | Clips per event, theme ambience loops, rendered adaptive music, captions, on the runtime's buses |
| `native/platform.ts` | Engine save (progress) with foreign-save migration and merge, device storage for the snapshot, the game's settings with legacy import, player chip, invite, server time, leaderboards read and score posting |
| `native/i18n.ts`, `native/style.ts` | Interface language from the runtime; style registration and palette tokens |
| `js/rules.js`, `js/content.js`, `js/session.js`, `js/store.js` | Pure rules, content, session (command log, undo, replay envelope, safe snapshot) and save model — unchanged from the browser build, shared with Node tests and `server.js` |
| `js/strings.js`, `js/i18n.js` | Translation tables (English source strings as keys) and `T()` / `cfgName()` |
| `js/migrate.js` | Engine save document, the browser build's cloud save and settings keys → engine data |
| `assets/ui-style.json` | Styles converted from `tools/ui-style.css` with `starhermit css` (`npm run css`) |
| `assets/title-emblem.webp`, `assets/results-horizon.webp` | Storybook illustrations used by the title and results panels |
| `score-script.js` | StarHermit platform script (`server=score-script.js`): range-checks a ranked round's total and posts it to the `high-score` leaderboard |
| `server.js` | Local dev server: static serving + replay-validated scores, saves, time (not deployed) |
| `sfx/*.opus`, `sfx/manifest.*` | 17 authored clips and their manifest |
| `cover.jpg`, `coverart.png`, `icon.png` | Platform cover and icon |
| `tests/*.test.mjs`, `tests/native.mjs`, `tests/native/*.play` | Unit tests (node:test) and engine checks with play scripts |
| `tools/` | `package-web.mjs`, `css.mjs` + `ui-style.css`, `plan.mjs` (play-script planner), `browser-play.mjs` (headless Chrome play of the package) |
| `knownissues.md`, `LICENSE.md` | QA history; PolyForm Noncommercial 1.0.0 |

## 2. Vision and design pillars

1. **The middle of the gate is the game.** Surviving a gate is worth 100; the last 25 % of the gap
   is where centre bonuses, streaks and the sparkle live. Rules in: a continuous centre bonus, a
   streak that resets on any off-centre pass, a "True Center" lesson. Rules out: power-ups, coins,
   anything that rewards the player for something other than where the bird crossed the gap.
2. **One input, fully trusted.** Space/↑/W, click, tap or gamepad A all do exactly one thing: set
   the bird's vertical velocity to +8.4. Rules in: identical lift every time, a predicted-arc assist
   that is declared with the score. Rules out: hold-to-glide, charged flaps, dash, any second verb.
3. **A soft sky that never lies.** Storybook islands and clouds are decoration; the hazard set is
   always exactly two pillars, a floor and a ceiling, drawn from the same snapshot the rules use.
   Rules in: emissive trim that brightens on the next gate, procedural geometry only, the same read
   with effects off. Rules out: weather that changes hitboxes, hidden hazards, camera moves that
   shift the bird off `x = 0`.
4. **Every flight is a fact.** Same seed + same flaps = same result, on every device and on the
   server. Rules in: seeded gate stream, tick-stamped command log, periodic state hashes,
   server-side replay before a score is ranked. Rules out: client-trusted scores, physics that
   depends on frame rate.
5. **Learn in sixty seconds, master over forty stages.** Five lessons introduce one rule each;
   Journey turns the dials (gate count, speed, gap, oscillation) from tier 0 to tier 1 with a
   mastery trial every tenth stage. Rules out: stage locks (every stage is selectable), lives,
   energy, anything that makes a retry cost more than a tap.

## 3. Player experience

**Target player.** Someone with 30 seconds to two minutes, on a phone or at a desk, who enjoys
precision under a simple rule set — the "one more go" arcade player — and, secondarily, the daily
score-comparer who wants a fair shared seed.

**First 60 seconds.** A fresh profile presses **Play** and is taken straight to lesson 1 ("First
Lift") setup, blurb "Sixty seconds to learn the sky."; Start → 3·2·1·Go countdown with the lesson's
prompt on screen ("Press Space, click, or tap to flap. Flap once to take off!") → the prompt is
also toasted for 5 s and announced to screen readers → three flaps clear the lesson → results with
the score breakdown and **Next lesson →**. Lessons 2–5 each add one rule (hover between the
bounds, pass a gate, aim for the centre, read a moving gate). Touch devices additionally show the
pulsing "Tap anywhere to flap" pill, which is itself a flap target and disappears on the first flap or when the round pauses.
Help (title, pause, or `H`) shows six rule cards including the full scoring table.

**Session shape.** Title → (Journey stage or Daily) → 20–90 s flight → results (breakdown, unlocks,
Next/Retry) → repeat. Journey's Play button always resumes at the first uncleared stage; Daily is
one 90 s survival run per UTC day; Practice is endless with undo for warm-up.

**Emotional beat.** The held breath between the flap and the pillar — the bird is committed, the
arc is visible, and the answer is a bright chime (centred), a plain chime (through), or a soft thud
and a tumble into the sea. The results screen turns that into a legible number immediately.

## 4. Core loop and rules contract

All rules live in `js/rules.js`; `js/session.js` is the only module that mutates rules state and
only through `applyCommand` / `step`.

### World and entities (`WORLD`, `createSession`)

- Units: bird radius 0.5; bird fixed at `x = 0`; floor `y = −9`; ceiling `y = +9`; gate half-width
  0.6; gates spawn at `x = 14` and despawn below `x = −16`. `SIM_DT = 1/60`; one tick = one step.
- State: `tick`, `phase` (`ready` → `active` → `terminal`), `bird {y, vy}`, `gates[]`
  (`{i, x, baseY, oscPhase, passed}`), `nextGateIndex`, `rngState`, `flapsUsed`, `gatesPassed`,
  `centeredPasses`, `streak`, `bestStreak`, `invalidActions`, `score {gates, center, streak, time,
  total}`, `commands[]` (applied ids), `terminal {reason, tick}`.
- A session starts with 4 gates (or `gateCount` if fewer) at `x = 14 + i·spacing`; a new gate is
  generated whenever the furthest gate is below `x = 14` and either the mode is endless or
  `nextGateIndex < gateCount`.

### Content config (`normalizeConfig`)

`params` defaults: gravity 26, lift 8.4, speed 5, speedRamp 0, maxSpeed 12, gapHalf 2.6,
gapShrink 0, minGapHalf 1.6, spacing 7, gateCount 0 (endless), oscAmp 0, oscFreq 0 (rad/tick),
gapRange 10, moveLimit 0, timeLimitTicks 0. `goal` is `{type: gates|flaps|score|survive|endless,
value}`; `parTicks` ≥ 0; `ranked`, `tutorial` booleans; `seed` is a uint32 or a string hashed with
FNV-1a (`hashString`). Content metadata (`dateKey`, `index`, `lesson`, `mastery`) is stripped by
normalisation and kept separately by `main.js` as `_roundConfig`.

### Legal actions (`legalActions`, `applyCommand`)

Two actions: `flap` and `abandon`. `flap` is illegal after terminal (`session-over`) and when
`moveLimit > 0 && flapsUsed >= moveLimit` (`no-moves-remaining`). Rejections in order: malformed
command → `duplicate-command` (id already applied, idempotent, not counted) → `unknown-action` →
illegal (counted in `invalidActions`, emits `invalid` event). An accepted `flap` in `ready` phase
starts the round (`start` event) and every flap sets `vy = lift` (not additive) and increments
`flapsUsed`. `abandon` terminates immediately with reason `abandon`.

### Resolution order per tick (`step`)

1. `vy −= gravity·dt`; `y += vy·dt`.
2. Every gate scrolls left by `currentSpeed = min(maxSpeed, speed + speedRamp·gatesPassed)·dt`.
3. Spawn ahead (rule above), then despawn behind.
4. Bounds: `y − 0.5 ≤ −9` → `floor` (or `move-limit` when the flap budget is exhausted);
   `y + 0.5 ≥ 9` → `ceiling`.
5. For each unpassed gate overlapping `|x| < 1.1`: gap centre `gapY = baseY + oscAmp·sin(oscFreq·tick
   + oscPhase)`, half-height `gapHalf' = max(minGapHalf, gapHalf − gapShrink·gatesPassed)`; if
   `|y − gapY| > gapHalf' − 0.5` → `gate`. A gate whose right edge is behind the bird's left edge
   becomes `passed` and scores (below).
6. Goal checks if not terminal: `gates`, `flaps`, `score`, `survive` (tick ≥ value), finite
   `gateCount` reached → `cleared`; `timeLimitTicks` reached → `cleared` for endless goals, else
   `time-up`.
7. Terminal → `finalizeScore`; `score.total` recomputed every tick.

### Scoring formula

Per passed gate: `gates += 100`; `center += round(50 · max(0, 1 − |y − gapY| / gapHalf'))`;
if `|y − gapY| ≤ 0.25·gapHalf'` the pass is **centred**: `streak += 1`, `score.streak +=
min(100, 10·streak)`, `centered` event; otherwise `streak = 0`. `bestStreak` tracks the maximum.
Time bonus only on `cleared` with `parTicks > 0`: `time = round(max(0, parTicks − tick)/60 · 5)`
(5 points per second under par). `total = gates + center + streak + time`. All integers.

*Worked example* (Journey stage 1, 10 gates, par 1306 ticks): 10 gates → 1000; centre bonuses
summing to 312; centred passes on gates 2, 3, 4 (streak 1, 2, 3 → 10 + 20 + 30), an off-centre gate
5, then gates 7, 8 (10 + 20) → streak 90; cleared at tick 1180 → 126 ticks = 2.1 s under par →
round(10.5) = 11. **Total 1413.** The results table shows exactly these four rows plus the total.

### Terminal states and tie-break

Reasons: `floor`, `ceiling`, `gate`, `cleared`, `move-limit`, `time-up`, `abandon`. "Won" in the UI
means `cleared`. `compareResults(a, b)`: cleared first, then higher total, then fewer
`invalidActions`, then lower `tick`, then `sessionId` string order. (The server board sorts by
score then lower `durationTicks`.)

### RNG and determinism

`createRng` is mulberry32 with a serialisable uint32 state; the gate stream draws `baseY ∈
[−gapRange/2, gapRange/2]` and `oscPhase ∈ [0, 2π)` rounded to 3 decimals. `rngState` is stored in
the state, so `step` is a pure function of state. Cosmetic streams are separate: renderer
decoration seed `seed ^ 0xdec0`, particle LCG seed `seed ^ 0xf1e1d`, audio variants `seed ^
0xa0d10`. `hashState` is FNV-1a over a key-sorted serialisation.

### Replay (`createReplayEnvelope`, `runReplay`)

Envelope: `schemaVersion 1`, `rulesVersion 1`, `build`, `contentId`, `contentVersion`, `seed`,
normalised `config`, `commands [{id, tick, type}]`, `hashes` every 600 ticks, `result {score,
reason, tick, gates, centered, bestStreak, invalidActions, finalHash}`. `runReplay` re-creates
the session from `config + seed`, steps to each command's integer tick (rejecting past ticks or
jumps beyond one hour), checks periodic hashes, runs out to terminal (bounded at 10 min of ticks),
and compares the final score.

### Undo and hints

Undo exists only in Practice (`allowUndo`): up to 64 pre-flap snapshots; `undo()` restores the
snapshot, drops later commands and the undone flap from the envelope, and emits `undo`. There are
no hints beyond the optional predicted-arc assist (12 ghost dots simulating the next 48 ticks if
the player flapped now; `render.js _updateGhostArc`), which is recorded in `assists.arc` on ranked
submissions and hidden under reduced motion.

## 5. Modes and progression

The difficulty recipe (`content.js recipe(tier)`) maps tier 0→1 to: speed 4.4→8.0, speedRamp
0.02→0.12, maxSpeed 8→13, gapHalf 2.9→1.9, gapShrink 0.006→0.018, minGapHalf 1.7→1.5, spacing
7.6→6.2, gapRange 8→11, and oscillating gates (amp 0.8→3.0, freq 0.010→0.022 rad/tick) once
tier ≥ 0.35.

| Mode | Content | Goal / end | Ranked | Notes |
|---|---|---|---|---|
| Learn | 5 lessons: First Lift (3 flaps, no gates, no scroll), Hold the Line (survive 6 s), Thread the Gate (3 gates), True Center (4 gates), Restless Gates (4 moving gates) | `flaps` / `survive` / `gates` | No | Prompt shown in countdown + toast; clearing all five sets `tutorialDone` |
| Journey | 40 stages, tier = index/39; gate count 10→19, mastery stages 10/20/30/40 have 22 gates at tier+0.08; themes by block of 8: Ember Dawn, High Noon, Violet Dusk, Starlit Drift, Aurora Vale; moving gates from stage 15 | `gates`, par = 1.05 × expected travel time | No | No locks; grid marks cleared (best score) and the current stage; results offer **Next** |
| Daily Breeze | `daily-YYYY-MM-DD` from platform time (server-synced when hosted): tier 0.35–0.75 fixed per day, theme = day-number mod 5, endless gates, 90 s | `survive` 5400 ticks (time-up = cleared) | Yes → `high-score` | Title card shows "done today ✓" once a best exists; one shared seed for everyone |
| Practice | Calm Skies (tier 0.1), Breezy (0.5), Tempest (0.9); endless | Until crash / leave | No | Undo allowed (HUD button, `U`); never affects boards |
| Challenges | Frugal Wings (8 gates, 18 flaps), Tailwind Sprint (12 gates, speed 7.2, par 747 ticks), Needle Threader (10 tight moving gates), Sky Marathon (survive 60 s of restless gates), Perfect Line (8 gates) | per row | No | Personal bests stored per id |
| Score Chase | `chase-<hex seed>` from `sky-YYYY-MM-DD`, tier 0.55, endless | Until crash | Yes → `high-score` | Setup blurb names the seed to share |

Progression is a local save (`store.js`): `lessons`, `journey[stageId] {cleared, bestScore,
bestTicks}`, `best[contentId]`, `achievements[key] = ISO time`, `daysPlayed[]`, `localBoard[]`
(top 50 daily/chase runs), `totalGates`, `totalRuns`. Achievements (`content.js ACHIEVEMENTS`,
idempotent, evaluated after every round): `first_clear`, `mechanic_mastery` (all lessons),
`streak_5`, `journey_half` (20 stages), `journey_master` (40), `long_term` (7 distinct days),
`daily_first`, `centurion` (100 gates in one run).

## 6. Controls and interaction

Actions are declared in `starhermit.txt`; players rebind keys and pads in the runtime's Options
(the Help cards show the effective keys).

| Action | Keyboard | Mouse / touch | Gamepad | Effect |
|---|---|---|---|---|
| `flap` | `Space`, `↑`, `W` | Left click or tap anywhere on the sky (not on a HUD button); the "Tap anywhere to flap" pill is part of the sky | South (A / Cross) | `FLAP` command; whoosh, wing kick, 8 ms haptic, 5-particle puff |
| `pause` | `Esc`, `P` | HUD Pause button | Start, East (B) | Pauses a round or its countdown; on the pause screen resumes; from Help / Settings returns to pause; on other screens goes back to the title |
| `undo` | `U` | HUD Undo (Practice) | West (X) | Restores the pre-flap state; rewind cue |
| `restart` | `R` | Retry button | North (Y) | Retries from the results |
| `help` | `H` | Help button | Select | Opens Help from the title |
| Menus | `Tab` / arrows / `Enter`, `Esc` back | touch | D-pad / left stick, South activates, East back (the runtime's UI) | Visible focus ring `#ffb43c` |

Rules: game actions wait while a text field has the keyboard; `flap` acts only in flight with no
screen open (a focused button never eats a flap: focus is cleared); a pointer press right after a
touch is ignored so one tap is one flap. During the countdown, pause, results and menus a flap
does nothing. Every accepted input has audio (or caption) and visual feedback; every rejected
input shows a toast with its reason and an assertive announcement. In browsers audio starts with
the first press (the runtime's rule).

## 7. Screens and UI flow

`app.appState` (owner: `native/main.ts`): `boot → title → mode-setup | mode-select → countdown →
active ⇄ paused → results → (title | countdown)`. Screens: `title`, `setup`, `journey`,
`countdown`, `pause`, `results`, `help`, `settings`, `achievements`, `boards`, `away`. One screen
shows at a time; the HUD shows during countdown, flight and pause.

- **Title:** emblem medallion, logo, tagline, **Play** (primary), Daily Breeze + Journey cards,
  eight secondary buttons, Invite a friend (signed in) or Sign in with StarHermit (guest), profile
  chip (avatar, name, cloud-sync state). Behind it the sky shows today's daily scene idle.
- **Setup:** name, blurb, facts (rules sentence built from the config, expected duration, players,
  ranked), optional option list (lessons / presets / challenges), assist-arc checkbox, Start / Back.
- **Countdown:** 3 · 2 · 1 · Go! every 700 ms, flight starts 600 ms after Go (counted in fixed steps).
- **Play HUD:** objective + progress (`n / N gates`, `n / N flaps`, or `n gates`), centre score +
  streak (a drawn sparkle and `streak ×n` from 2), flaps left / time left / Undo / Pause; mirrored
  with the left-handed layout.
- **Pause:** Resume, Settings, Help, Restart, Leave round.
- **Results:** horizon illustration, "Clear skies!" / "Flight ended", reason sentence, four-row
  breakdown + total, "New personal best!" / "Best here", unlocked achievements, ranked note,
  leaderboard line (signed in, ranked), Retry / Next / Menu. Shown 1.1 s after terminal (0.4 s
  with reduced motion).
- **Help** (six rule cards with the bound keys), **Settings**, **Achievements**, **Leaderboards**
  (Global / Friends / This device tabs), **Welcome back** (a paused round's safe snapshot found at
  start: Continue flight / Start over).

Layout by the window's logical size (the runtime's interface size applied): panels are centred
cards (30 em; wide panels 44 em; ≥ 1024 px 32 / 52 em) over a 25 % navy scrim; at ≤ 700 px they
become bottom sheets (78 % of the height, the title stays a card); when the window is under
640 px tall the title uses the small emblem and logo; in landscape ≤ 500 px tall the HUD shrinks
and the results art is hidden. A panel body taller than the room scrolls while its buttons stay
pinned below it. Content stays inside the safe area. Must never be cut off: the score, Pause, the
countdown prompt, the results total row and the Retry / Menu row.

## 8. Art direction

**Palette (CSS tokens).** Ink `#1d2733`, soft ink `#44566b`, paper `rgba(255,252,246,.94)`, accent
`#d94f2b` (ember), accent-2 `#2f7fd0`, focus `#ffb43c`, page gradient `#7fb2e5 → #ffe3b3`.
Colour-vision palettes swap accents: deuteranopia `#0067c2/#e0a100`, protanopia `#0a6ed1/#c99300`,
tritanopia `#c8373e/#008f8f`; high contrast uses `#000` ink, `#b32400/#003da5` accents.

**Five scene themes (`content.js THEMES`)**, applied to sky dome, fog, key/hemisphere light, sun,
islands, gates, clouds, bird and wing:

| Theme | skyTop / horizon | gate / trim | bird / wing |
|---|---|---|---|
| Ember Dawn | `#7fb2e5` / `#ffe3b3` | `#e8623d` / `#fff1d6` | `#fff8ee` / `#ff9d5c` |
| High Noon | `#4f9fe0` / `#eaf7ff` | `#3f7fd6` / `#eaf4ff` | `#ffffff` / `#63b3ff` |
| Violet Dusk | `#51418c` / `#f7b6c2` | `#b04fd6` / `#f2e0ff` | `#fdf0f6` / `#d67fb8` |
| Starlit Drift | `#0d1330` / `#4a5b9e` | `#50c8c0` / `#d8fffa` | `#e8f0ff` / `#7fe0d8` |
| Aurora Vale | `#1e4a5e` / `#c8f4e0` | `#40d890` / `#eafff4` | `#f4fffa` / `#6fe8b0` |

**Shape language.** Rounded, plump, low-poly: sphere-built bird with tapered wing pods and a
cone beak; gates are tapered cylinders with a glowing ring trim (emissive 0.25; the next gate's
trim glows at 0.5, or 1.25 with a slow shimmer when bloom is active); islands are flat-shaded
inverted cones with grass caps and tufts; clouds are opaque, softly self-lit icosahedron clusters
(smooth and slightly flattened at Surface detail: Detailed). The **hero** is the bird at `x = 0` framed by the two nearest pillars; the camera
(FOV 38, z 17.5, x 3.2, look-ahead 1.4) follows the bird's `y` with a damped spring and widens FOV
in portrait so the ±9 band stays visible.

**Typography.** The runtime's system-ui face; logo 2.6 rem with the second word in accent;
`kbd` chips for keys; text size follows the runtime's Options. Symbols that depend on the
system's fonts (▶, ❚❚, ✦, ⏱, 🏅) are drawn glyphs.

**Motion principles.** Simulation-driven: bird tilt from `vy`, wing kick decaying over 0.3 s,
parallax islands/clouds scrolling at `12/depth` and `8/depth` of gate speed, sun pinned to the
camera; ambient motion (drifting cirrus, sea glints, twinkling stars, aurora ribbons, pollen or
firefly motes, next-gate shimmer) freezes under reduced motion or `prefers-reduced-motion`. Event tiers: flap puff (5) < gate burst (12; centred 26, gold `#ffe08a`) + 0.15 shake <
clear burst (60) / crash burst (40, `#ff6a4d`) + shake 1.0 (max 0.22 units). Reduced motion:
particles capped at 6 per burst (bursts are 1.5× larger at Particles: High), no shake, ghost arc hidden, environment drift at 25 %, UI
animations off (the runtime's reduced motion), results shown after 0.4 s.

**Visual assets the design calls for:** a 16:9 cover in the storybook style (`coverart.png`), a
circular bird medallion for the title panel (`assets/title-emblem.webp`), a wide horizon strip for
the results panel (`assets/results-horizon.webp`). Both in-game images fail soft (a plain fill
stands in) and are dropped under high contrast. No 3D model asset: the bird is deliberately
procedural so its wings animate from simulation state.

## 9. Audio direction

**Philosophy.** Short, bright, non-fatiguing transients tied to logical events; the theme's quiet
ambience loop; a sparse pentatonic music loop whose density rises with danger. Nothing is
audio-only: every cue has a caption (bracketed, ≥ 400 ms apart, translated) and an announcement.

**Buses** are the runtime's (Options › Audio owns volumes, mute and the voice limit): music →
`music`, effects and ambience → `effects`, cues (countdown, invalid) and the UI click →
`interface`; the old default levels (music 0.6, effects 0.8, ambience 0.5, cues 0.7) are folded
into each sound's gain. Pausing or hiding the window fades the ambience out and holds the music.
**Music:** a 300 ms grid — a root drone every 8 steps and A-minor-pentatonic triangle notes with
probability `0.35 + 0.4·intensity`; intensity = `0.25 + 0.6·min(1, gatesPassed/30)`, 0.2 on
results. The notes are rendered once into clips with the browser build's envelopes.
**Ambience:** the authored 12 s loop for the theme fades in over 2.5 s with the round.

**Clips** load once the mixer runs (natively at once, in browsers after the first press), one at
a time; until a clip is in, its event is silent but still captioned (the browser build's
procedural stand-ins and noise bed are not ported: live synthesis graphs break clip loading on the
web runtime). `sfx/manifest.txt` is the canonical table; summary:

| Event id | File | Sound | Usage |
|---|---|---|---|
| `flap` | `flap-whoosh.opus` | Soft feathered whoosh | Every accepted flap |
| `start` | `takeoff-rise.opus` | Rising wind sweep + chime | First flap of a round |
| `pass` | `gate-pass-chime.opus` | Two-note crystalline chime | Every gate passed |
| `centered` | `centered-sparkle.opus` | Ascending glockenspiel glitter | Pass within inner 25 % of the gap |
| `streak` | `streak-rise.opus` | Rising three-note bell run | Centred pass reaching streak ≥ 3 |
| `terminal:cleared` | `clear-fanfare.opus` | Four-note brass/bell fanfare | Goal met |
| `terminal:time-up` | `time-up-fanfare.opus` | Warm resolving jingle | Time limit without goal |
| `terminal:crash` | `crash-thud.opus` | Soft thud, muffled splash, wobble | floor / ceiling / gate / move-limit / abandon |
| `best` | `best-sting.opus` | Brass swell into bell ping | Existing personal best beaten (results) |
| `achievement` | `achievement-sparkle.opus` | Three-step bell arpeggio | Each unlock |
| `invalid` | `invalid-buzz.opus` | Muted wooden bonk | Rejected command (voice bus) |
| `undo` | `undo-rewind.opus` | Descending rewind whirr | Practice undo |
| `countdown` | `countdown-beep.opus` | Round mid-pitch beep | 3 · 2 · 1 |
| `countdown:final` | `countdown-go.opus` | Higher beep with sparkle | Go! |
| `ui` | `ui-tick.opus` | Tiny wooden click | Any menu button |
| `ambience:day` | `ambience-wind.opus` | High-altitude wind, faint chimes (12 s loop) | Dawn/day/dusk/aurora rounds |
| `ambience:night` | `ambience-night.opus` | Night hush, far crickets (12 s loop) | Starlit Drift rounds |

## 10. Localization

Nine locales ship: **en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT**.

- **Strings.** Code and content are authored in English and the English text is the lookup key.
  `js/strings.js` holds one row per key with es-419, de-DE, fr-FR, pt-BR and it-IT; en-GB, es-ES
  and fr-CA list only their differences. `T(key, vars)` (`js/i18n.js`) falls back regional →
  parent → English and fills `{name}` placeholders. Every on-screen string, caption,
  announcement and the StarHermit account and leaderboard lines go through `T()`; rich help text
  is shown as plain text. Content names are translated at display time (journey stages as "{sky}
  {n}" / "Mastery: {sky}", "Daily Breeze — {date}"). "Breeze Wing" and "StarHermit" are names.
- **Language** is the runtime's interface language (Options › Language, else the account's
  preferred language or the device's), mapped to the nearest shipped locale (`es-MX → es-419`,
  `en-AU → en-GB`, `fr → fr-FR`, `pt-PT → pt-BR`). A change re-renders every screen on the next
  frame without touching the round in play.
- `tests/i18n.test.mjs` collects every key from `native/*.ts`, `js/i18n.js` and the content, and
  fails when a locale lacks one, a translation drops a placeholder or markup tag, or a table keeps
  a key nothing uses.

## 11. Accessibility

- **Keyboard and gamepad path:** every screen is reachable and closable by keyboard or pad (the
  runtime's UI navigation; Esc / East back); each screen focuses its first control as it opens.
- **Screen readers:** the UI's accessibility tree names every control (journey cells carry full
  labels: stage, name, cleared and best, mastery); `ui.announce` speaks the round name, countdown
  digits, each gate ("Gate 4. Score 512."), centred streaks, pause/resume, undo and the results
  summary, and assertively the invalid-action reasons.
- **Captions:** every audio event prints a bracketed caption above the bottom edge (docked to the
  very bottom while a screen is open).
- **Contrast and colour:** ink `#1d2733` on paper ≥ 12:1; state is never colour-only (cleared
  stages get a green fill *and* a score, mastery stages a heavier border *and* ★, the current stage
  a ring). Three colour-vision palettes (Settings) and the runtime's high contrast (which also
  removes the illustrations).
- **Motion:** the runtime's reduced motion (see §8).
- **Text and controls:** the runtime's text and interface size; left-handed HUD mirror,
  predicted-arc timing assist, haptics toggle, Replay tutorial (Settings). Targets ≥ 44 × 44 px.

## 12. StarHermit integration

The runtime owns sign-in, the launch token and its renewal, Options (sound, graphics, language,
controls, accessibility) and the bug-report and crash paths; the game sees only `player()`.

| Feature | Used | How |
|---|---|---|
| Sign-in | Yes | A guest's title shows **Sign in with StarHermit** (`requestSignIn()`); a session that ends shows "Signed out of StarHermit — progress stays on this device." |
| Invite | Yes | Signed in, the title shows **Invite a friend**, copying `inviteLink()` (fetched ahead) with a toast (the link is shown if the clipboard refuses) |
| Profile | Yes | `player().displayName` and `avatar()` (cut to a circle) in the profile chip with the save's sync state |
| Cloud save | Yes | The engine save (`saves`, schema 1) is `{ v: 1, progress }`, on the device and in the account slot; another device's save arriving is merged in (`mergeProgress`: every lesson, achievement and played day from both sides, a stage cleared on either side stays cleared with the higher best and faster time, the higher best per mode, the larger totals, both device boards without duplicates); `onConflict` answers with the same merge. The browser build's slot (`game:<slug>`, the SDK's zipped `save.json`) shows as foreign: its progress is merged with this device's and saved over it with `replaceForeign` |
| Settings | Yes | The game's own settings (`colorPalette`, `leftHanded`, `assistArc`, `haptics`) are `settings` (`game.<key>`, synced with the account); the browser build's per-player keys are imported where the game still has them and removed; volumes, mute, graphics, reduced motion, high contrast, larger text, telemetry consent and `ui.language` belong to the runtime now |
| Server time | Yes | `serverTime()` at start, then `serverNow()` gives the Daily Breeze day, the Score Chase seed day and the played-days record; offline the device's UTC date is used and the Daily setup says so |
| Leaderboards | Yes | One board, `high-score`. Signed in, every finished Daily Breeze or Score Chase round posts its total through `score-script.js` (a practice session carrying `{ type: 'result', scores }`), and the results show "Leaderboard rank: #N" (or posted / not posted). The Leaderboards screen reads the board's entries (guests read the global board too; Friends needs a player), with players' display names (own row "You (name)"); when unreachable it shows this device's board |
| Achievements | Local | Unlocked and stored in the progress (cloud-saved); no platform unlock |
| Game script | Yes | `score-script.js` (unchanged). `server.js` stays the local dev server (replay-validated scores) |
| Rooms, matchmaking, chat, voice, replays | No | Solo game |

## 13. Technical architecture

- **Loop:** the runtime's fixed steps at 60 Hz (`setFixedRate(60)`): one rules tick per step while
  the round is in flight; the countdown and the settle before results are counted in the same
  steps, so a pause, a hidden window or a slow frame never moves the gates and play scripts replay
  exactly. `onRender` interpolates the bird and gates between the previous and current snapshot;
  paused / countdown / results render the frozen state with 20 % ambient motion; the title renders
  an idle daily scene.
- **Session ownership:** `GameSession` wraps rules state; listeners (renderer effects, audio,
  announcements) consume the event list; nothing else touches state. The safe snapshot
  (`breezewing.safeSnapshot.v1`, device storage) is written on pause, suspend and quit, and offered
  on the Welcome back screen at the next start.
- **Graphics** (`native/render.ts`, `native/quality.ts`). ACES filmic tone mapping (exposure 1.05).
  A key directional light (three.js intensities ÷ π) plus a hemisphere fill whose ground colour is
  lifted toward the haze; optional soft shadows from the key light (the engine's view-based
  directional shadow, 34 units) following the play band in half-unit steps. Image-based light: the
  theme's sky gradient and HDR sun written into a small latitude-longitude image, prefiltered with
  `PMREMGenerator.fromEquirectangular` on each theme change, per-material `envMapIntensity`
  0.3–0.6. Detailed surfaces: glazed-terracotta pillars (`MeshPhysicalMaterial`, clearcoat 0.55,
  world-height tile courses with grout and per-tile tint in a WGSL surface hook), a clearcoated beak
  and eye catch-lights, strata and tip-darkening vertex colours on flat-shaded islands, smooth
  clouds (faceted otherwise). The sky dome and the sea are WGSL `ShaderMaterial`s with the browser
  build's noise, cirrus, stars, aurora and glints. Burst particles and motes are `Points` with a
  soft dot texture (per-particle alpha; gold bursts and fireflies are HDR so they bloom). Post
  effects: `renderer.bloom` (bloom model r160 at the page's strength 0.4, radius 0.45, threshold 0.9, half resolution),
  `renderer.grade` (display space: S-curve, +14 % saturation, cool shadows / warm highlights,
  vignette 0.2), `renderer.antialias`.

  The runtime's graphics level (Options › Graphics: Auto or a level) picks the tier
  (`frame().quality`) and the counts scale with the level within it (about 1.64× a level, at most
  4×): Low — Lambert materials, no shadows, bloom or grade, plain sky and surfaces, 6 islands /
  6 clouds, 120 particles; Balanced — PBR, 1024 shadows, bloom, grade, FXAA, reflections, detailed
  sky and surfaces, 10 / 10, 120 particles and 20 motes; High — 2048 shadows, SMAA, 17 / 20,
  extra tufts, 900 particles and 45 motes; Ultra — 4096 shadows, MSAA, 22 / 26, 1350 particles
  and 80 motes. The runtime owns render scale, pixel-ratio cap, adaptive resolution, the frame-rate
  limit and readout. Graphics never change rules, hitboxes or hazard visibility.
- **Server:** dependency-free `node:http` dev server (unchanged), `BW_DATA_DIR` or `./data`.

## 14. Testing and acceptance criteria

`npm test` runs `npm run test:unit` and `npm run test:native`.

- **Unit** (`node --test`): rules (`tests/rules.test.mjs`: RNG determinism, legal and invalid
  actions, physics, terminals, every scoring component, tie-breaks, serialisation, replay accept /
  reject, practice undo, fuzzing, golden sessions, content validators, daily immutability), store
  (`tests/store.test.mjs`: checksums, migration, descendant and merge semantics), dev server
  (`tests/server.test.mjs`), localization (`tests/i18n.test.mjs`) and the engine data migration
  (`tests/migrate.test.mjs`: the browser build's cloud save, round trips, two-device merges without
  duplicate board rows, which old settings carry over).
- **Native** (`tests/native.mjs`): the committed web index matches the files, `tsc` (strict, the
  engine's `.d.ts`), `starhermit check .` with no warnings, and each `tests/native/*.play` as a
  signed-out `--render-check` run driving the real UI: `learn-lessons` (Play → lessons 1–3 flown by
  `tools/plan.mjs` plans to their exact planned score), `practice-undo` (option list, flaps, Undo,
  pause / resume, crash results, R retry, Leave round), `journey-stage` (grid → stage 1, planned
  crash after two gates with its breakdown, Retry), `screens` (achievements, leaderboards, settings,
  help, Daily setup, pause → Settings / Help, ranked results).
- **Browser** (`npm run test:browser`, `tools/browser-play.mjs`; `~/games/tools/engine-web-smoke.mjs`):
  the packaged loader in headless Chrome at desktop 1366×768 (keys through lesson 1 to results),
  phone 390×844 and phone landscape 844×390 (keys into a round, taps flap, Escape pauses), failing on
  console errors or warnings or the runtime's error screen.

QA bar: no text or control clipped at desktop, 390×844 portrait or 844×390 landscape; a fresh
profile is guided by lesson prompts; ranked rounds post once.

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `coverart.png` (1200×675, 256-colour PNG, 380 KB) | Platform cover: bird between glowing pillars at dawn | FLUX.2 klein, seed 4301, 30 steps | generated in this pass (replaced placeholder) |
| `assets/title-emblem.webp` (320×320, 6 KB) | Title medallion above the logo | FLUX.2 klein, seed 4302 | generated in this pass, wired |
| `assets/results-horizon.webp` (1024×320, 11 KB) | Results panel header strip | FLUX.2 klein, seed 4303 | generated in this pass, wired |
| `icon.png` | Launcher icon | authored | shipped |
| `sfx/flap-whoosh`, `takeoff-rise`, `gate-pass-chime`, `centered-sparkle`, `clear-fanfare`, `time-up-fanfare`, `crash-thud`, `invalid-buzz`, `ui-tick`, `countdown-beep`, `countdown-go`, `achievement-sparkle`, `undo-rewind` (.opus) | Event one-shots (§9) | MOSS-SoundEffect v2 | shipped |
| `sfx/streak-rise.opus`, `sfx/best-sting.opus` | Streak ≥ 3 and personal-best cues | MOSS-SoundEffect v2, 100 steps | generated in this pass, wired |
| `sfx/ambience-wind.opus`, `sfx/ambience-night.opus` (12 s loops) | Authored ambience beds | MOSS-SoundEffect v2, 100 steps | generated in this pass, wired |
| 3D models / character animation | — | — | not called for: bird, gates and islands are procedural (`native/render.ts`) |

## 16. Known limitations

- Rules: gates spawned during a round are placed at `14 + index·spacing` rather than one spacing
  past the furthest gate, so from the fifth gate on the gaps between gates grow (Journey stage 1's
  tenth gate arrives about 74 s in, against a 22 s par) and endless modes thin out. Shipped
  behaviour kept unchanged by the port (the replay validator and server share it).
- The Leaderboards screen shows one `high-score` board for Daily Breeze and Score Chase together.
- Score Chase always uses the day's default seed (`sky-YYYY-MM-DD`); there is no seed field.
- Challenge "Perfect Line" declares `goalExtra {centeredPasses: 5}` but the rules ignore it.
- The browser build's Conflict screen (choose device / cloud / merge) is gone: the engine's save
  conflicts and the old cloud save are merged automatically.
- Guests' progress from the browser build's localStorage does not migrate (cloud saves do).
- Clip-less moments: an event whose clip has not loaded yet plays nothing (its caption still shows).
- Signed-in paths (foreign save, legacy settings, score posting, friends board) are covered by unit
  tests of their logic, not live runs.

### Design intent not yet implemented

1. Separate Daily and Score Chase boards, or a "verified only" filter.
2. A seed field on the Score Chase setup so shared seeds can be entered.
3. Enforce `goalExtra.centeredPasses` for Perfect Line in the rules.
