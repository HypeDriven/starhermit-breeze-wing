# Known Issues — Breeze Wing

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on local5090 (HauhauCS Q3_K_P, 32k ctx),
alongside the game's own unit tests and a headless-Chrome boot/play smoke.

**Fix pass 2026-09-04** (this update): all five confirmed defects triaged against the current source
and fixed. Unit tests and the browser e2e re-run green. See `## Resolved defects`.

## Test results

| Check | Result |
| --- | --- |
| `npm test` (node --test) | 47/47 pass, 0 fail |
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

### 2. `runReplay` accepts non-integer command ticks

- **File:** `js/rules.js:506`
- **Concern:** the guard is `typeof cmd.tick !== 'number'`, not `Number.isInteger`. A `tick: 5.5`
  passes, and the `while (state.tick < cmd.tick)` loop at line 509 steps to 6, applying the command one
  tick late relative to the original session.
- **Why unconfirmed:** `js/session.js` only ever records integer ticks, so producing such an envelope
  requires a hand-crafted submission, and it would then fail the hash comparison at line 511 in most
  cases. I did not construct one that both survives the hash check and changes the score.

### 3. Score/save tables are read-modify-written per request without locking

- **File:** `server.js:42-51, 122-123`
- **Concern:** every API request calls `loadTable('scores')` and `loadTable('saves')` and handlers write
  the whole table back. Two overlapping submissions can each read the same snapshot and the later write
  discards the earlier one. `saveTable` also writes a `.tmp` file and then writes the destination
  directly (lines 48-50) rather than renaming, so the temporary file buys no atomicity.
- **Why unconfirmed:** demonstrating the lost update needs deterministic interleaving of two in-flight
  requests, which I could not arrange reliably against the single-process server.

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
