# Known Issues — Breeze Wing

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on local5090 (HauhauCS Q3_K_P, 32k ctx),
alongside the game's own unit tests and a headless-Chrome boot/play smoke.

## Test results

| Check | Result |
| --- | --- |
| `npm test` | 47/47 pass, 0 fail |
| `node --check` on all modules | clean (`js/*.js`, `server.js`, `tests/*.mjs`) |
| `tests/e2e.mjs` (headless Chrome) | not present. Substituted a headless-Chrome smoke against `PORT=39302 node server.js`: boot to title, `#btn-play` → setup → `#btn-setup-start` → game. No page errors, no console errors, no failed requests. |

## Confirmed defects

### 1. `GET /js` (or any directory path) crashes the server process

- **File:** `server.js:237-247` (static file branch of the request handler)
- **Trigger:** a single unauthenticated `GET /js`, `GET /css`, `GET /vendor` — any existing directory name without a trailing slash.
- **Behaviour:** line 237 blocks only `data/` and `tests/` *with* a trailing slash, so a bare directory name passes. `existsSync(file)` (line 241) is true for directories. `createReadStream(file).pipe(res)` (line 247) then emits `'error'` (EISDIR) with no `'error'` listener attached. The surrounding `try/catch` (lines 230-250) cannot catch it because the error is asynchronous, so Node re-throws and the process exits.
- **Expected:** a directory request should be a 404; a malformed request must never terminate the service.
- **Evidence:**

  ```
  $ curl -o /dev/null -w '%{http_code}' http://localhost:39312/api/v1/time   -> 200
  $ curl -o /dev/null -w '%{http_code}' http://localhost:39312/js            -> 000
  $ curl -o /dev/null -w '%{http_code}' http://localhost:39312/api/v1/time   -> 000   (process gone)

  server log:
  Error: EISDIR: illegal operation on a directory, read
      Emitted 'error' event on ReadStream instance at:
      at emitErrorNT (node:internal/streams/destroy:170:8)
  ```

### 2. `step()` and `applyCommand()` mutate the state object they were given

- **File:** `js/rules.js:323-331` (`step`, the `const next = { ...state, ... }` shallow copy), with the
  mutations at lines 356, 363-364, 369, 400 and inside `finalizeScore` (lines 412-419, also called from
  `applyCommand` at line 278).
- **Trigger:** any `step()` call on the tick a gate is passed; any `ABANDON` command.
- **Behaviour:** the spread copy is shallow, so `next.score === state.score` and
  `next.gates[i] === state.gates[i]`. `next.score.gates += 100`, `next.score.center += centerBonus`,
  `next.score.streak += streakBonus`, `next.score.total = ...` and `g.passed = true` therefore write
  through into the state the caller passed in. A snapshot taken before the step retroactively acquires
  the new score, and its `hashState` changes.
- **Expected:** spec.md §5 (line 168) — "No module may mutate rules state except through a validated
  command. Rendering consumes immutable snapshots plus interpolation data."
- **Evidence:**

  ```
  identity check: step(s).state.score === s.score   -> true
  identity check: step(s).state.gates[0] === s.gates[0] -> true

  === INPUT-STATE MUTATION at tick 154
     prev.score before step: {"gates":0,"center":0,"streak":0,"time":0,"total":0}
     prev.score after  step: {"gates":100,"center":43,"streak":10,"time":0,"total":153}
     hashState(prev) before: 6875aa3c | after: 49196772
  ```

### 3. Replay envelopes produced by the game cannot be replayed

- **File:** `js/rules.js:478-491` (`createReplayEnvelope`) vs `js/rules.js:501` (`runReplay`)
- **Trigger:** `runReplay(createReplayEnvelope(config, build))`.
- **Behaviour:** `runReplay` reconstructs the session with
  `createSession({ ...envelope.config, seed: envelope.seed })`, but `createReplayEnvelope` never emits a
  `config` field, and the documented envelope schema in the comment at lines 471-475 does not list one
  either. The spread contributes nothing, the session is built from `{ seed }` alone, and the replay
  never terminates.
- **Expected:** spec.md §5 "Determinism, replay, and security" — a replay envelope should be
  self-describing so a validator can re-execute it.
- **Evidence:** `runReplay(createReplayEnvelope(dailyContent('2026-08-20'), 'dev'))` returns
  `{"ok":false,"mismatch":"no-termination"}` after burning the 36000-step guard.
  Both shipped call sites patch around it: `server.js:183` injects
  `const env = { ...claim.envelope, config, seed: config.seed }`, and `tests/rules.test.mjs:286` does
  `env.config = cfg; // runReplay needs the config to reconstruct`.

### 4. Cloud-save conflict destroys the other device's snapshot

- **File:** `server.js:157-161` (`PUT /api/v1/save`), with `js/main.js:326-330`
- **Trigger:** device A and device B both have progress; B saves while the server still holds A's document.
- **Behaviour:** the handler computes `conflict` (line 158) and then **unconditionally overwrites**
  `saves[id] = doc` (line 159), keeping only the incoming document. The previous document is returned
  once in the response (`doc: existing`) and `js/platform.js:132` surfaces it as `remote`, but
  `js/main.js:328` ignores that field and simply calls `this._syncCloud()`, which re-fetches from the
  server — where the pre-conflict document no longer exists. `_syncCloud` therefore compares the local
  document against a copy of itself, takes the early return at `js/main.js:125`, and the conflict screen
  never appears. A's progress is gone.
- **Expected:** spec.md §6 (line 195) — "Resolve conflicts by preserving both snapshots and asking the
  player when neither is a strict descendant."
- **Evidence:** `server.js:158-161` — `const conflict = ...; saves[id] = doc; await saveTable(...);
  return send(res, 200, { ok: true, conflict, doc: existing || null });` — nothing preserves `existing`
  server-side. `js/main.js:328` — `if (r && r.conflict) this._syncCloud();` — `r.remote` is unused.

### 5. `mergeSaves` and `isDescendant` throw on save documents the server accepts

- **File:** `js/store.js:96-101` (`isDescendant`) and `js/store.js:105-121` (`mergeSaves`), with
  `server.js:151` and `js/store.js:51-60` (`migrate`)
- **Trigger:** a cloud document that lacks `progress` or lacks one of its sub-objects. `PUT /api/v1/save`
  accepts anything with a numeric `version` (`server.js:151`: `typeof doc.version !== 'number'` is the
  only shape check), and `migrate()` only normalises `version` — it never fills in missing `progress`
  sub-objects.
- **Behaviour:** the conflict screen's Merge button (`js/main.js:738`,
  `mergeSaves(this.save, this._cloudDoc)`) throws, and `_syncCloud`'s descendancy test
  (`js/main.js:125`) throws during `init()` — which is awaited at `js/main.js:93`, before
  `_toTitle('boot-complete')`, so the game never leaves the boot screen.
- **Expected:** absent or corrupt stored data should degrade to a default document, the way
  `loadSave` already does for localStorage (`js/store.js:62-77`).
- **Evidence:**

  ```
  mergeSaves(local, {version:1})            THREW: TypeError: Cannot read properties of undefined (reading 'lessons')
  mergeSaves({version:1}, local)            THREW: TypeError: Cannot read properties of undefined (reading 'achievements')
  mergeSaves({version:1,progress:{}}, local) THREW: TypeError: Cannot convert undefined or null to object
  isDescendant({version:1,progress:{}}, saveWithJourney) THREW: TypeError: Cannot read properties of undefined (reading 'j1')
  ```

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
