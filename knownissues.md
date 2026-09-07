# Known Issues — Breeze Wing

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on local5090 (HauhauCS Q3_K_P, 32k ctx),
alongside the game's own unit tests and a headless-Chrome boot/play smoke.

**Fix pass 2026-09-04** (this update): all five confirmed defects triaged against the current source
and fixed. Unit tests and the browser e2e re-run green. See `## Resolved defects`.

**Fix pass 2026-09-07**: second review found and fixed a ranked-submission/progression regression,
a double-finish of left rounds, and several smaller defects (see `## Resolved defects (2026-09-07)`).
Unit tests (50/50) and the browser e2e re-run green, including new regression coverage.

## Resolved defects (2026-09-07)

### 1. Ranked daily submissions rejected; journey "Next stage" never offered — RESOLVED

- **File:** `js/main.js` (`_beginRound`, `_progressRound`, `_fillResults`, `_retry`), `js/session.js`.
- **Root cause:** progression, results, and score submission read content metadata from
  `session.state.config`, which is the NORMALIZED config — `normalizeConfig` drops `dateKey`,
  `index`, `lesson`, `mastery`, etc. Daily submissions therefore posted to board `daily-undefined`
  (server: 400 board-mismatch, so ranked dailies never landed), and `cfg.index + 1 < JOURNEY.length`
  was `NaN < 40`, so the results screen never showed the next-stage action. Retrying a lesson also
  lost its prompt for the same reason.
- **Fix:** the raw content config is kept for the round (`_roundConfig`, also passed into
  `GameSession.rawConfig` and persisted in the safe snapshot for crash recovery) and used for all
  content metadata; the normalized config remains the rules truth. `_retry` reuses it.
- **Verified:** new e2e steps assert the Next-stage button after clearing journey stage 1 and that
  abandoning a daily round submits exactly once to `daily-<today>`.

### 2. Leaving a round finished it twice (double progression + double submission) — RESOLVED

- **File:** `js/main.js` (`_leaveRound` / `_finishRound` / terminal-event timeout).
- **Root cause:** `_leaveRound` called `_finishRound` immediately, but the ABANDON command's
  `terminal` event had already scheduled a second `_finishRound` ~1.1s later — `totalRuns`,
  `totalGates`, the local board, and the ranked submission were all recorded twice. The same
  timeout could also fire into a NEW session when the player retried within the delay.
- **Fix:** `_finishRound` runs once per session (`_finishedFor` guard), and the delayed finish
  captures the ending session and only fires if it is still current.
- **Verified:** e2e waits out the timer after leaving and asserts exactly one submission and a
  `totalRuns` delta of exactly 1.

### 3. `runReplay` accepted non-integer command ticks — RESOLVED

- **File:** `js/rules.js:510`. Guard is now `Number.isInteger(cmd.tick)`, closing the
  previously-suspected tick-5.5 replay skew. Regression test added.

### 4. Undo left the undone flap in the replay envelope — RESOLVED

- **File:** `js/session.js` (`undo`). After dropping later commands, the flap at the restored tick
  is now popped too; a new test replays a post-undo session to an exact hash/score match.

### 5. Score/save table writes could lose updates and were not atomic — RESOLVED

- **File:** `server.js` (storage). Tables are cached in-process (this script owns its data dir),
  writes are serialized through a promise queue (failure-isolated), and committed via tmp-file +
  `rename` instead of writing the destination directly.

### 6. Ghost-arc fade gradient never rendered — RESOLVED

- **File:** `js/render.js` (`_buildGhostArc`). All 12 dots shared one material, so the per-dot
  opacity loop collapsed to a single value; each dot now clones the material.

### 7. Escape on the results screen stranded the player on a blank dead screen — RESOLVED

- **File:** `js/main.js` (`_backFromScreen`, Escape handling). Results now backs out to the title;
  Escape on settings/help opened over pause returns to the pause screen.

### 8. Smaller fixes — RESOLVED

- `js/store.js` (`mergeSaves`): `tutorialDone` is now carried from either side of a merge.
- `index.html`: removed a leftover duplicate inline placeholder favicon (the game-specific
  `favicon.svg` remains the single icon).
- `LICENSE.md`: added (PolyForm Noncommercial 1.0.0), as required by the root instructions.

## Test results

| Check | Result |
| --- | --- |
| `npm test` (node --test) | 47/47 pass, 0 fail (2026-09-04); 50/50 pass, 0 fail (2026-09-07) |
| `node --check` on all modules | clean (`js/*.js`, `server.js`, `tests/*.mjs`) |
| `tests/e2e.mjs` (`npm run test:e2e`, headless Chrome) | present. PASS on desktop + mobile, no page/console errors, exit 0. |
| Directory-request smoke (`GET /js`, `/css`, `/vendor`) | all 404; server stays up (`GET /api/v1/time` still 200, process alive) |

## Resolved defects

### 1. `GET /js` (or any directory path) crashes the server process — RESOLVED

- **File:** `server.js:243-245` (static-file branch), `server.js:19` (import), `server.js:249-252` (stream error guard).
- **Fix:** after `existsSync`, an explicit `statSync(file).isDirectory()` check now returns 404 before
  any stream is opened, so a bare directory name (e.g. `/js`, `/css`, `/vendor`) — which previously
  slipped past the `data/`/`tests/` *trailing-slash* block — can no longer reach `createReadStream`.
  A stream-level `'error'` listener was also added so any underlying read error is answered with a 500
  instead of an unhandled async re-throw. A malformed request can never terminate the service.
- **Verified:** `GET /js` → 404, `GET /css` → 404, `GET /vendor` → 404, `GET /js/` → 404; subsequent
  `GET /api/v1/time` → 200 and the Node process remains alive (previously the process exited and the
  next request returned `000`).

### 2. `step()` and `applyCommand()` mutate the state object they were given — RESOLVED

- **File:** `js/rules.js:323-332` (`step` next-state build), `js/rules.js:265` (`applyCommand` next-state build).
- **Fix:** the shallow spread leaves `next.score` aliased to `state.score`, so `next.score.gates/center/
  streak/total +=` (and `finalizeScore`) wrote through into the caller's snapshot. Both `step`'s
  `next` and the `applyCommand` command branch now build `score: { ...state.score }`, so the input
  state stays immutable (only `state` returned via the unchanged READY/illegal paths kept as-is).
- **Verified:** after a 200-tick simulated flight, `step(s).state.score !== s.score` (previously
  identical reference) and the pre-step snapshot keeps its original `{gates:0,center:0,streak:0,time:0,
  total:0}`. Determinism / `hashState` stability unchanged and re-verified by the existing unit tests.

### 3. Replay envelopes produced by the game cannot be replayed — RESOLVED

- **File:** `js/rules.js:471-497` (`createReplayEnvelope`), reused by `js/rules.js:501` (`runReplay`).
- **Fix:** `createReplayEnvelope` now emits the normalized `config` (documented in the envelope
  schema comment). `runReplay` already reconstructed with `createSession({ ...envelope.config, seed })`;
  with `config` present the envelope is self-describing (spec §5) and no longer needs the external
  `env.config = ...` patch. The authoritative server (`server.js:184`) still overrides `config`/`seed`
  with its own rebuilt content, which is the intended trust model.
- **Verified:** `runReplay(JSON.parse(JSON.stringify(gs.envelope)))` on a recorded session — with **no**
  external config injection — now returns `{ok:true, mismatch:null}`, and both `state.score.total` and
  `hashState(state)` match the recorded `result`. (A pristine envelope with zero flap commands still
  correctly yields `no-termination`, because a never-started session legitimately stays `READY`.)

### 4. Cloud-save conflict destroys the other device's snapshot — RESOLVED

- **File:** `js/main.js:121-147` (`_syncCloud` → `_resolveCloudConflict`), `js/main.js:326-332` (save-conflict path).
- **Root cause:** on a conflicted `saveProgress`, the server returns the previous snapshot as
  `doc`/`remote`, but `js/main.js` called `_syncCloud()` again, which re-fetched from the server — now
  holding the just-written doc — and compared the local doc against a copy of itself (early return at
  `_syncCloud`). The other device's snapshot was silently dropped and no conflict screen appeared.
- **Fix:** the save-conflict path now uses the server-returned prior snapshot: shared logic
  `_resolveCloudConflict(remote)` compares the local save against that remote doc, auto-adopting if one
  is a strict descendant and otherwise preserving **both** in `this._cloudDoc` and asking the player via
  the conflict screen (spec §6). Boot-time `_syncCloud()` routes through the same helper.
- **Why the server handler wasn't changed:** `server.js` already returns the prior snapshot (`doc:
  existing`) on conflict, so both snapshots are available at the resolution point; the data loss was
  purely the client discarding it. The server is a mirror (each device also keeps a local copy via
  `writeSave`), so preserving the returned remote at the client is sufficient. No shadow/clobber
  storage was added to avoid changing the save schema contract.

### 5. `mergeSaves` and `isDescendant` throw on save documents the server accepts — RESOLVED

- **File:** `js/store.js:50-77` (`migrate`), `js/store.js:103-120` (`isDescendant`), `js/store.js:123-127` (`mergeSaves`).
- **Fix:** `migrate` now always reconstructs from `defaultSave()` and layers the persisted fields on
  top (settings, settings.volumes, and every progress sub-object), so a version-valid document that is
  nonetheless missing a sub-object degrades to a full default — mirroring what `loadSave` already does
  for localStorage. `isDescendant` and `mergeSaves` additionally tolerate `null`/partial `progress`
  (`graded access: (candidate && candidate.progress) || {}`, missing `journey`/`lessons` guarded).
- **Verified:** previously-throwing calls now all succeed:
  `mergeSaves({version:1}, local)` ✓, `mergeSaves(local, {version:1,progress:{}})` ✓,
  `mergeSaves(defaultSave(), {version:1})` ✓, `isDescendant({version:1,progress:{}}, saveWithJourney)` ✓
  (returns false, no throw).

## Suspected — not confirmed

### 1. Unvalidated "casual" scores are ranked against replay-validated ones

- **File:** `server.js:187-198`
- **Concern:** a submission without a usable replay envelope only has to pass `plausible()`
  (`server.js:106-114`), which permits roughly 1.4 million points inside the 4-hour duration cap. It is
  then pushed onto the *same* board array and `board.sort((a, b) => b.score - a.score || ...)` orders it
  purely by score, so an unverified entry outranks verified ones. spec.md §6 (line 205) says
  "If validation is unavailable, label the board casual" — the code labels per entry
  (`validated: false`) and sets a board-level `casual` flag on read, but does not separate the boards.
- **Evidence (mechanism confirmed, policy not):** against a copy of the server, with no replay envelope
  at all:

  ```
  casual score  500000 -> 200 {"ok":true,"validated":false,"rank":1,"casual":true}
  casual score 1440000 -> 200 {"ok":true,"validated":false,"rank":1,"casual":true}
  casual score 1500000 -> 422 {"error":"implausible"}

  GET /api/v1/scores?board=daily-2026-08-20
    [{"name":"Casual1440000","score":1440000,"validated":false},
     {"name":"Casual500000","score":500000,"validated":false}]
  ```

  So the practical ceiling is ~1.44 million points with no replay, on the same board as validated runs.
- **Why unconfirmed:** whether "label the board casual" means *segregate* or merely *annotate* is a
  product decision, not something the source settles. Every such entry is honestly marked
  `validated: false`, and the board response sets `casual: true`.

### 2. `runReplay` accepts non-integer command ticks — RESOLVED 2026-09-07

- Now guarded with `Number.isInteger` (`js/rules.js`); see `## Resolved defects (2026-09-07)` #3.

### 3. Score/save tables are read-modify-written per request without locking — RESOLVED 2026-09-07

- Tables are now cached in-process, writes serialized and committed atomically via rename
  (`server.js`); see `## Resolved defects (2026-09-07)` #5.

## Checked, no defects found

- `js/rules.js:201-282` — `ActionType` frozen; `applyCommand` rejects malformed commands, duplicate
  command ids, unknown actions, and illegal actions (incrementing `invalidActions` rather than applying).
- `js/rules.js:497-532` — replay hash checkpointing, the bounded run-out guard, and the final score
  comparison are all present and correct given a `config`.
- `server.js:91-103` (`contentFor`) — the daily key is regex-checked and the content is rebuilt
  server-side; `server.js:174` compares the rebuilt seed against the claim, and `server.js:183` replaces
  the client's `config`/`seed` with the server's before replaying. The forged-content class of attack
  does not apply here.
- `server.js:234-239` — static path handling: decode, `normalize`, reject any residual `..`, block
  `.map`, `spec.md`, `data/` and `tests/`.
- `js/store.js:62-87` — `loadSave` handles absent, unparseable, and checksum-mismatched documents, and
  archives the corrupt raw value before resetting; `writeSave` swallows quota errors and returns `false`.

## Not tested

- Hosted/StarHermit paths in `js/platform.js`: `saveProgress`, `loadProgress`, presence and activity all
  early-return unless `this.hosted` is true, and there is no local host shell to set that.
- Friends-only leaderboard filtering (`server.js:208-214`): needs an `x-friends` header injected by a
  host shell.
- Audio output (`js/audio.js`) — no audio device in headless Chrome.
- Long-session and away/backgrounding behaviour; the smoke run covers only a few seconds of play.
