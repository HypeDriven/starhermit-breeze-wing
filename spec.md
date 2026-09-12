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
| Platforms | Desktop and mobile browsers with WebGL; landscape and portrait |
| Rendering | Three.js (`vendor/three.module.js`) procedural 3D scene behind a semantic HTML/CSS shell; no textures, no post-processing |
| Simulation | Fixed 60 Hz step, deterministic, seeded; rules run identically in browser and Node |

### File map

| Path | Role |
|---|---|
| `index.html` | Entry point named by `starhermit.txt` (`launch=index.html`): canvas + every screen as semantic DOM |
| `css/style.css` | UI shell, palettes, breakpoints, reduced-motion/high-contrast/large-text rules |
| `js/rules.js` | Pure rules engine: config normalisation, RNG, gate stream, `step`, `applyCommand`, scoring, hashing, replay |
| `js/content.js` | Versioned content: 5 themes, difficulty recipe, 40 Journey stages, 5 lessons, 5 challenges, daily/chase generators, 3 practice presets, 8 achievements, offline validators |
| `js/session.js` | `GameSession`: owns live rules state, command log, undo snapshots, replay envelope, safe snapshot |
| `js/render.js` | Three.js scene: bird, gates, islands, clouds, sky dome, particles, ghost arc, camera, quality tiers |
| `js/audio.js` | WebAudio engine: four buses, authored Opus one-shots + loops with procedural fallbacks, captions, adaptive music |
| `js/ui.js` | Screen switching, focus restore, live regions, HUD, setup/results/journey/achievements/board fills |
| `js/platform.js` | StarHermit adapter: fragment launch token + Bearer + 45-min refresh, profile nickname, cloud-save slot (zip+base64, debounced, sync status), read-only platform leaderboard |
| `js/store.js` | Versioned, checksummed local save document; migration; conflict helpers |
| `js/main.js` | `App`: state machine, fixed-step loop, input, lifecycle, progression, achievements, UI wiring |
| `server.js` | StarHermit game script (`server=server.js`): static serving + authoritative replay-validated scores, saves, time |
| `sfx/*.opus`, `sfx/manifest.txt` | 17 authored clips; canonical `file \| event \| description \| usage` manifest (`manifest.json` feeds the generator and the runtime map) |
| `assets/title-emblem.webp`, `assets/results-horizon.webp` | Storybook illustrations used by the title and results panels |
| `coverart.png`, `icon.png`, `favicon.svg` | Platform cover (16:9) and icons |
| `tests/rules.test.mjs`, `tests/store.test.mjs`, `tests/server.test.mjs` | `npm test` (node:test, no dependencies) |
| `tests/e2e.mjs` | Real-UI playthrough in headless Chrome via `playwright-core` (`npm run test:e2e`) |
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
pulsing "Tap anywhere to flap" pill, which is itself a flap target and disappears on the first flap.
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
| Daily Breeze | `daily-YYYY-MM-DD` from platform time (server-synced when hosted): tier 0.35–0.75 fixed per day, theme = day-number mod 5, endless gates, 90 s | `survive` 5400 ticks (time-up = cleared) | Yes → board `daily-<date>` | Title card shows "done today ✓" once a best exists; one shared seed for everyone |
| Practice | Calm Skies (tier 0.1), Breezy (0.5), Tempest (0.9); endless | Until crash / leave | No | Undo allowed (HUD button, `U`); never affects boards |
| Challenges | Frugal Wings (8 gates, 18 flaps), Tailwind Sprint (12 gates, speed 7.2, par 747 ticks), Needle Threader (10 tight moving gates), Sky Marathon (survive 60 s of restless gates), Perfect Line (8 gates) | per row | No | Personal bests stored per id |
| Score Chase | `chase-<hex seed>` from `sky-YYYY-MM-DD`, tier 0.55, endless | Until crash | Yes → board `chase` | Setup blurb names the seed to share |

Progression is a local save (`store.js`): `lessons`, `journey[stageId] {cleared, bestScore,
bestTicks}`, `best[contentId]`, `achievements[key] = ISO time`, `daysPlayed[]`, `localBoard[]`
(top 50 daily/chase runs), `totalGates`, `totalRuns`. Achievements (`content.js ACHIEVEMENTS`,
idempotent, evaluated after every round): `first_clear`, `mechanic_mastery` (all lessons),
`streak_5`, `journey_half` (20 stages), `journey_master` (40), `long_term` (7 distinct days),
`daily_first`, `centurion` (100 gates in one run).

## 6. Controls and interaction

| Input | Desktop | Mobile / touch | Gamepad | Effect |
|---|---|---|---|---|
| Flap | `Space`, `↑`, `W`, left click on canvas | Tap anywhere on the canvas or the "Tap anywhere to flap" pill | Button 0 (A/Cross) | `FLAP` command; whoosh, wing kick, 8 ms haptic, 5-particle puff |
| Pause / resume | `Esc`, `P`, HUD ❚❚ Pause | HUD button | Start (9) pauses, Start/B (1) resumes | Countdown timers are cancelled; sim freezes |
| Undo (Practice) | `U`, HUD Undo | HUD Undo | — | Restores pre-flap state; rewind cue |
| Retry | `R` on results, Retry button | button | A on focused button | Same raw config, new session id |
| Help | `H` on title, Help buttons | buttons | — | Rule cards |
| Menu navigation | `Tab`/`Enter`, arrow keys in selects | touch | D-pad up/down (12/13) moves focus among visible controls; A clicks | Visible focus ring `#ffb43c` |

Rules: keys are ignored while an `input`/`select`/`textarea` has focus; `keydown` repeats are
dropped; pointer capture is taken on the canvas so a drag off-screen cannot double-fire; panels
sit above the canvas so taps on menus never flap. During `countdown`, `paused`, `results` and all
menu states `_flap()` is a no-op. Every accepted input has audio (or caption) + visual feedback;
every rejected input shows a toast with the reason text (`INVALID_TEXT`) and an assertive
live-region alert. First pointer/key gesture unlocks the AudioContext.

## 7. Screens and UI flow

`App.appState` (owner: `js/main.js`): `boot → title → mode-setup | mode-select → countdown → active
⇄ paused → results → (title | countdown)`. Screens (`js/ui.js SCREENS`): `title`, `setup`,
`journey`, `countdown`, `pause`, `results`, `help`, `settings`, `achievements`, `boards`,
`conflict`, `compat`, `away`. Exactly one screen is visible at a time; the HUD is a separate layer
shown during countdown/active/paused/away.

- **Title:** emblem medallion, logo, tagline, **Play** (primary), Daily Breeze + Journey cards,
  eight secondary buttons, profile chip. Behind it the canvas renders today's daily scene idle.
- **Setup:** name, blurb, rules sentence built from the config (`fillSetup`), expected duration,
  players, ranked yes/no, optional option list (lessons / presets / challenges), assist-arc
  checkbox, Start / Back.
- **Countdown:** 3 · 2 · 1 · Go! at 700 ms, play starts 600 ms after Go; pointer-events none.
- **Play HUD:** left objective + progress (`n / N gates`, `n / N flaps`, or `n gates`), centre
  score + streak (`✦ streak ×n` from 2), right flaps-left / time-left / Undo / Pause.
- **Pause:** Resume, Settings, Help, Restart, Leave round. Esc from Settings/Help returns to pause.
- **Results:** horizon illustration, "Clear skies!" / "Flight ended", reason sentence, four-row
  breakdown + total, "New personal best!" / "Best here", unlocked achievements, ranked note,
  Retry / Next / Menu. Shown 1.1 s after terminal (0.4 s under reduced motion).
- **Help, Settings, Achievements, Leaderboards (Global / Friends / This device tabs)**.
- **Conflict** (two cloud saves), **Compat** (no WebGL), **Away** (safe snapshot found: Continue
  flight / Start over).

Layout: panels are centred cards (max 30 em; wide panels 44 em; ≥1024 px: 32/52 em) over a
25 % navy scrim; at ≤700 px they become bottom sheets (max-height 78 vh, title stays a card); in
landscape ≤500 px tall the HUD shrinks, the logo drops to 1.8 rem, the emblem to 64 px and the
results illustration is hidden. Safe areas are applied via `env(safe-area-inset-*)` to the HUD,
panel padding, captions and the tap pill. Must never be cut off: the score, Pause, the countdown
prompt, the results total row and the Retry/Menu row.

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

**Shape language.** Rounded, plump, flat-shaded: sphere-built bird with tapered wing pods and a
cone beak; gates are tapered cylinders with a glowing ring trim (emissive 0.25, 0.5 on the next
gate); islands are inverted cones with grass caps and tufts; clouds are icosahedron clusters at
85 % opacity. The **hero** is the bird at `x = 0` framed by the two nearest pillars; the camera
(FOV 38, z 17.5, x 3.2, look-ahead 1.4) follows the bird's `y` with a damped spring and widens FOV
in portrait so the ±9 band stays visible.

**Typography.** Avenir Next / Segoe UI / system-ui; logo 2.6 rem with the second word in accent;
tabular numerals for score and breakdown; `kbd` chips for keys; 125 % scale with Larger text.

**Motion principles.** Simulation-driven: bird tilt from `vy`, wing kick decaying over 0.3 s,
parallax islands/clouds scrolling at `12/depth` and `8/depth` of gate speed, sun pinned to the
camera. Event tiers: flap puff (5) < gate burst (12; centred 26, gold `#ffe08a`) + 0.15 shake <
clear burst (60) / crash burst (40, `#ff6a4d`) + shake 1.0 (max 0.22 units). Reduced motion:
particles capped at 6 per burst, no shake, ghost arc hidden, environment drift at 25 %, CSS
animations/transitions off, results shown after 0.4 s.

**Visual assets the design calls for:** a 16:9 cover in the storybook style (`coverart.png`), a
circular bird medallion for the title panel (`assets/title-emblem.webp`), a wide horizon strip for
the results panel (`assets/results-horizon.webp`). Both in-game images fail closed (`onerror`
hides them) and are dropped under high contrast. No 3D model asset: the bird is deliberately
procedural so its wings animate from simulation state.

## 9. Audio direction

**Philosophy.** Short, bright, non-fatiguing transients tied to logical events; a low, quiet wind
bed; a sparse procedural pentatonic music loop whose density rises with danger. Nothing is
audio-only: every cue has a caption (`#audio-captions`, ≥400 ms apart) and a live-region text.

**Buses** (`AudioEngine`): `music` 0.6, `effects` 0.8, `ambience` 0.5, `voice` (cues) 0.7 — each
a `GainNode` under a master; Mute zeroes all four; backgrounding ducks the master to 0.
**Music:** `startMusic` schedules a 300 ms grid — a root drone every 8 steps and A-minor-pentatonic
triangle notes with probability `0.35 + 0.4·intensity`; intensity = `0.25 + 0.6·min(1,
gatesPassed/30)`, 0.2 on menus/results. **Ambience:** a filtered-noise wind bed (low-pass 400 Hz,
220 Hz on Starlit Drift) starts with the round; the authored 12 s loop for the theme cross-fades in
over 2.5 s once decoded and the bed ducks to 12 %.

**Clips** are lazy-loaded after the first gesture from `sfx/manifest.json` (`name`, `event`);
`AUTHORED_SFX_BY_EVENT` in `js/audio.js` is the fallback map. If a clip is missing or still
decoding, the procedural synth for that event plays instead, so the game is never silent.
`sfx/manifest.txt` is the canonical table; summary:

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

The shipped build is **English only**: every string is an English literal in `index.html` (screen
copy, rule cards, settings labels), `js/main.js` (`INVALID_TEXT`, result reasons, toasts, blurbs),
`js/ui.js` (HUD/setup/board sentences) and `js/content.js` (stage, lesson, challenge and
achievement names). `<html lang="en">` is fixed; there is no language selector and no locale
detection. The product target list — en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR,
it-IT — is recorded under "Design intent not yet implemented". Layout allowances already in place
for a future string table: panels wrap at 70 ch, buttons are min-width 44 px with wrapping rows,
and the setup facts grid and results table are two-column so 30 % longer labels fit without
truncation.

## 11. Accessibility

- **Keyboard-only path:** every screen is reachable and closable by keyboard (Tab/Enter, Esc);
  `ui.show` focuses the first control of each panel and `ui.hide` restores the opener's focus; no
  focus traps; visible 3 px `#ffb43c` focus ring on buttons, inputs and selects.
- **Live regions:** `#sr-announcer` (polite) receives round name, countdown digits, each gate
  ("Gate 4. Score 512."), centred streaks, pause/resume, undo, and the results summary;
  `#sr-alerts` (assertive) receives invalid-action reasons. Journey cells carry full `aria-label`s;
  the canvas is `aria-hidden`; the board filter is a `tablist`.
- **Captions:** every audio event prints a bracketed caption above the safe-area bottom.
- **Contrast and colour:** ink `#1d2733` on paper ≥ 12:1; state is never colour-only (cleared
  stages get a check-like fill *and* a score, mastery stages a dashed border *and* ★, the current
  stage a ring). Three colour-vision palettes and a High contrast mode (also removes illustrations).
- **Motion:** Reduced motion setting (see §8) plus `body.reduced-motion` CSS kill-switch.
- **Text and controls:** Larger text (125 %), Left-handed HUD mirror, predicted-arc timing assist,
  haptics toggle, Replay tutorial. All targets ≥ 44 × 44 CSS px with 8 px gaps.

## 12. StarHermit integration

Manifest `starhermit.txt`: `name=Breeze Wing`, `launch=index.html`, `owner=…`, `server=server.js`,
`version=1.0.0`, `cover=coverart.png`. The client is hosted when a launch token was read — it
arrives in the URL fragment `#game_token=<jwt>` (optional `&session_id=`), is stripped after the
read, and is sent as `Authorization: Bearer` on every hosted call, never persisted. It is re-minted
every 45 min via `POST /api/v1/games/{slug}/launch-token` (60 s retry); the slug comes from the
JWT's `game_scope` and is never hard-coded. Without a token the game makes zero `/api` calls and
runs as an offline guest with local saves.

| Feature | Used | How |
|---|---|---|
| Identity / profile | Yes | `GET /api/v1/users/{sub}/profile` → nickname (never `/api/v1/me`, never usernames; `Player <id8>` fallback); shown in the profile chip with cloud-sync status (offline/saving/synced) |
| Server time | Yes | `GET /api/v1/time`, round-trip-adjusted offset; drives the daily key and "done today" |
| Presence / activity / telemetry | No | No per-game endpoints exist for launch tokens (wiki); the client deliberately never calls them |
| Cloud save | Yes | One zip+base64 slot at `GET/PUT /api/v1/me/cloud-saves/{slug}`; remote wins on boot (strict-descendant auto-resolve or Conflict screen), saves debounce 2 s and flush on `pagehide`/hidden; localStorage stays the offline cache |
| Leaderboards | Read-only | Clients never submit (wiki). Read via `GET /api/v1/games/{slug}` → `leaderboardId` → `GET /api/v1/leaderboards/{id}/entries[?friendsOnly=]` with user ids resolved to nicknames (own row "You"). The dev server's replay-validated `POST/GET /api/v1/scores` remains for direct local testing only |
| Achievements | Local | Unlocked and stored in the save document (part of the cloud-saved doc); no platform unlock endpoint is called |
| Game script | Yes | `server.js` rebuilds the immutable content for `daily-*` / `chase-*`, rejects stale `contentVersion`, seed or board mismatches, replays the envelope through `js/rules.js`, labels entries `validated` or casual (plausibility-checked), keeps 200 per board, rate-limits 120 req/min per identity, 256 KB bodies, atomic table writes |
| Realtime rooms, matchmaking, chat, voice, invitations | No | Solo game |

Conventions follow https://wiki.starhermit.com/ (same-origin `/api/v1`, `Authorization: Bearer`
with the launch token, structured `{"error": …}` responses, `Retry-After` on 429).

## 13. Technical architecture

- **Loop (`main.js _frame`):** accumulator fixed-step at 1/60 s, at most 5 steps per frame (then
  the accumulator resets), render with interpolation alpha between the previous and current
  snapshot; paused/countdown/results render the frozen state with 20 % ambient motion; the title
  renders an idle daily scene.
- **Session ownership:** `GameSession` wraps rules state; listeners (`renderer.onEvents`, audio,
  HUD) consume the event list; nothing else touches state. Safe snapshot (`breezewing.safeSnapshot.v1`)
  is written on pause, tab hide and `pagehide`, and offered on the Away screen at next boot.
- **Persistence:** `breezewing.save.v1` (version 1, FNV checksum; corrupt docs are archived and
  reset); `migrate` layers any doc over defaults; `isDescendant`/`mergeSaves` power conflicts.
- **Rendering budgets (`QUALITY_TIERS`):** low — DPR 1 × 0.85, no shadows, 6 clouds, 6 islands,
  120 particles; medium — DPR ≤ 1.75, shadows, 10/10, 400; high — DPR ≤ 2, 16/14, 900. ACES tone
  mapping, sRGB output, one 1024² shadow map, sky dome shader, fog 40–140. `renderer.stats()`
  exposes draw calls/triangles. WebGL context loss is handled by flagging and re-uploading on
  restore; no WebGL → Compat screen.
- **Server:** dependency-free `node:http`; static files confined to the root with `..`, `.map`,
  `spec.md`, `knownissues.md`, `data/`, `tests/`, `tools/`, `node_modules/` and dotfiles refused;
  MIME for `.opus`, `.webp`, `.glb`; immutable caching for js/css/png/svg/webp/opus; data dir
  `BW_DATA_DIR` or `./data` (git-ignored).
- **E2E:** `tests/e2e.mjs` starts its own static server on an ephemeral port, launches
  `/usr/bin/google-chrome` headless, and plays through the real DOM: desktop 1280×800 (title →
  journey grid → stage 1 → Space-key autopilot reading `window.__bw` state only to time real key
  presses → results → Next/Retry → pause/resume → crash → menu → settings → help → daily
  leave-round with a submission spy) and mobile 390×844 touch (Play → lesson 1 by tapping →
  journey stage → tap pause/resume → leave). Any page error or non-benign console error fails it.

## 14. Testing and acceptance criteria

`npm test` (51 tests, `node --test tests/*.test.mjs`): RNG determinism and `hashString`; legal
actions and every invalid reason; malformed/unknown/duplicate commands; gravity and lift;
floor/ceiling/gate/time-up/abandon terminals; each scoring component and the time bonus; tie-break
order; serialise/deserialise and version rejection; property sweep of seed+commands → identical
hash; envelope replay accepts a recorded session and rejects tampered scores and non-integer ticks;
practice undo (state and envelope); fuzzed commands never hang or NaN; generated content across
seeds stays valid; golden stage-1 and interrupted/resumed sessions; all shipped content passes the
validators; 40 stages / 5 lessons / 5 themes; daily immutability and a year sweep; config
normalisation; oscillation bounds; gap-shrink floor. Store: fresh/round-trip/corrupt/unreadable
saves, migration, descendant and merge semantics. Server: concurrent first submissions, time
endpoint, static allow/deny list, validated ranking, tampered replay → 422, stale version and seed
mismatch → 400, casual plausibility, save round-trip and credential rejection, friends filter.

`npm run test:e2e` verifies the flow in §13 at both viewports with zero page errors.

QA bar (checkable): a fresh profile is guided by lesson prompts before any unexplained mechanic;
every button on every screen performs its action in the browser; no console errors or warnings
during the e2e; no text or control is clipped at 1280×800, 390×844 portrait or 844×390 landscape;
a bot reaches results using only visible controls; ranked runs submit exactly once to the dated
board; `node --check` passes on every JS/MJS file.

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `coverart.png` (1200×675, 256-colour PNG, 380 KB) | Platform cover: bird between glowing pillars at dawn | FLUX.2 klein, seed 4301, 30 steps | generated in this pass (replaced placeholder) |
| `assets/title-emblem.webp` (320×320, 6 KB) | Title medallion above the logo | FLUX.2 klein, seed 4302 | generated in this pass, wired |
| `assets/results-horizon.webp` (1024×320, 11 KB) | Results panel header strip | FLUX.2 klein, seed 4303 | generated in this pass, wired |
| `icon.png`, `favicon.svg` | Launcher icon, tab icon | authored | shipped |
| `sfx/flap-whoosh`, `takeoff-rise`, `gate-pass-chime`, `centered-sparkle`, `clear-fanfare`, `time-up-fanfare`, `crash-thud`, `invalid-buzz`, `ui-tick`, `countdown-beep`, `countdown-go`, `achievement-sparkle`, `undo-rewind` (.opus) | Event one-shots (§9) | MOSS-SoundEffect v2 | shipped |
| `sfx/streak-rise.opus`, `sfx/best-sting.opus` | Streak ≥ 3 and personal-best cues | MOSS-SoundEffect v2, 100 steps | generated in this pass, wired |
| `sfx/ambience-wind.opus`, `sfx/ambience-night.opus` (12 s loops) | Authored ambience beds | MOSS-SoundEffect v2, 100 steps | generated in this pass, wired |
| 3D models / character animation | — | — | not called for: bird, gates and islands are procedural (`render.js`) |

## 16. Known limitations

- Casual (envelope-less) submissions rank on the same board as validated ones, marked
  `validated:false` and `casual:true` in responses; the client shows "Score submitted (casual
  board)" but the board list does not distinguish them (knownissues.md, suspected #1).
- The Leaderboards screen only ever fetches today's `daily-<date>` board; the `chase` board is
  written to but never displayed.
- Score Chase always uses the day's default seed (`sky-YYYY-MM-DD`); there is no UI to enter a
  custom seed even though the setup blurb invites sharing one.
- Challenge "Perfect Line" declares `goalExtra {centeredPasses: 5}` but the rules ignore it: the
  challenge clears after 8 gates regardless of centred passes.
- Journey stages are never locked; the `.jstage.locked` style is unused.
- Hosted paths (cloud save, save conflict, platform leaderboard, friends filter) are exercised only by ad-hoc
  harnesses; no host shell is available locally, and the e2e plays as an offline guest (zero `/api` calls).
- The audio caption pill (bottom-anchored) can overlap the results buttons for about a second on
  portrait phones when an achievement cue fires as the results sheet opens.
- English only (see §10). Audio output is untested in headless Chrome.

### Design intent not yet implemented

1. String table and locale selection for en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR,
   it-IT (host locale first, then `navigator.language`, then English).
2. A separate casual board, or a "verified only" filter, on the Leaderboards screen, plus a
   Score Chase board tab.
3. A seed field on the Score Chase setup so shared seeds can actually be entered.
4. Enforce `goalExtra.centeredPasses` for Perfect Line in the rules (terminal `cleared` only when
   both conditions hold).
