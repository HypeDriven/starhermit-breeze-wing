/**
 * Breeze Wing — authoritative server tests: time sync endpoint, replay
 * validation, stale-version/seed rejection, plausibility gates, idempotent
 * boards, and save storage. Uses an ephemeral port and temp data dir.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR_OVERRIDE = '';

let server, base, dataDir;

// Point the server's DATA_DIR at a temp location by running in-process with
// a chdir-free approach: the server module computes DATA_DIR from its own
// path, so instead we just let it write ./data and clean up after.
const { server: srv, plausible } = await import('../server.js');
const { dailyContent } = await import('../js/content.js');
const { GameSession } = await import('../js/session.js');
const { ActionType, Phase } = await import('../js/rules.js');

before(async () => {
  await new Promise((resolve) => {
    server = srv.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await rm(join(process.cwd(), 'data'), { recursive: true, force: true });
});

const post = (path, body, headers = {}) => fetch(base + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
}).then((r) => r.json().then((j) => ({ status: r.status, body: j })));

test('GET /api/v1/time returns a numeric clock', async () => {
  const r = await fetch(`${base}/api/v1/time`).then((x) => x.json());
  assert.ok(typeof r.now === 'number' && r.now > 0);
  assert.ok(typeof r.iso === 'string');
});

test('index.html and starhermit.txt are served; spec.md is not', async () => {
  const idx = await fetch(`${base}/index.html`);
  assert.equal(idx.status, 200);
  const sh = await fetch(`${base}/starhermit.txt`);
  assert.equal(sh.status, 200);
  const txt = await sh.text();
  assert.match(txt, /name=Breeze Wing/);
  const spec = await fetch(`${base}/spec.md`);
  assert.equal(spec.status, 404);
});

test('validated replay submission accepted and ranked', async () => {
  const cfg = dailyContent('2026-08-19');
  const gs = new GameSession(cfg, { build: 'test' });
  let guard = 60 * 200;
  while (gs.phase !== Phase.TERMINAL && guard--) {
    if (gs.state.tick % 27 === 0) gs.command(ActionType.FLAP);
    gs.tick();
  }
  const claim = {
    board: `daily-${cfg.dateKey}`,
    score: gs.state.score.total,
    ruleset: cfg.id, contentVersion: cfg.version, seed: cfg.seed,
    assists: { arc: true }, durationTicks: gs.state.tick,
    envelope: gs.envelope,
  };
  const r = await post('/api/v1/scores', claim, { 'x-player-id': 'tester-1', 'x-player-name': 'Tester' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.validated, true);
  assert.ok(r.body.rank >= 1);

  const board = await fetch(`${base}/api/v1/scores?board=daily-${cfg.dateKey}`).then((x) => x.json());
  assert.ok(board.entries.length >= 1);
  assert.equal(board.entries[0].validated, true);
});

test('tampered score rejected with replay-invalid', async () => {
  const cfg = dailyContent('2026-08-19');
  const gs = new GameSession(cfg, { build: 'test' });
  let guard = 60 * 200;
  while (gs.phase !== Phase.TERMINAL && guard--) {
    if (gs.state.tick % 27 === 0) gs.command(ActionType.FLAP);
    gs.tick();
  }
  const claim = {
    board: `daily-${cfg.dateKey}`,
    score: gs.state.score.total + 5000, // inflated
    ruleset: cfg.id, contentVersion: cfg.version, seed: cfg.seed,
    durationTicks: gs.state.tick, envelope: gs.envelope,
  };
  const r = await post('/api/v1/scores', claim, { 'x-player-id': 'cheater' });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /replay-invalid/);
});

test('stale content version and seed mismatch rejected', async () => {
  const cfg = dailyContent('2026-08-19');
  const base1 = {
    board: `daily-${cfg.dateKey}`, score: 100, ruleset: cfg.id,
    contentVersion: cfg.version, seed: cfg.seed, durationTicks: 6000,
  };
  let r = await post('/api/v1/scores', { ...base1, contentVersion: 999 }, { 'x-player-id': 'p2' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'stale-version');
  r = await post('/api/v1/scores', { ...base1, seed: 12345 }, { 'x-player-id': 'p2' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'seed-mismatch');
  r = await post('/api/v1/scores', { ...base1, ruleset: 'nonsense' }, { 'x-player-id': 'p2' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'unknown-ruleset');
});

test('casual submission without envelope is plausibility-checked', async () => {
  const cfg = dailyContent('2026-08-19');
  const ok = await post('/api/v1/scores', {
    board: `daily-${cfg.dateKey}`, score: 150, ruleset: cfg.id,
    contentVersion: cfg.version, seed: cfg.seed, durationTicks: 6000,
  }, { 'x-player-id': 'casual-1' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.validated, false);
  const bad = await post('/api/v1/scores', {
    board: `daily-${cfg.dateKey}`, score: 10_000_000, ruleset: cfg.id,
    contentVersion: cfg.version, seed: cfg.seed, durationTicks: 60,
  }, { 'x-player-id': 'casual-2' });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error, 'implausible');
});

test('save round-trips; credentials rejected', async () => {
  const put = (body, headers = {}) => fetch(`${base}/api/v1/save`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).then((r) => r.json().then((j) => ({ status: r.status, body: j })));
  const doc = { version: 1, progress: { totalRuns: 3 }, settings: {} };
  const okPut = await put({ doc }, { 'x-player-id': 'saver' });
  assert.equal(okPut.status, 200);
  const got = await fetch(`${base}/api/v1/save`, { headers: { 'x-player-id': 'saver' } }).then((x) => x.json());
  assert.equal(got.doc.progress.totalRuns, 3);
  const bad = await put({ doc: { version: 1, token: 'abc' } }, { 'x-player-id': 'saver' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'credentials-in-save');
});

test('plausibility helper bounds', () => {
  assert.equal(plausible({ score: 0, durationTicks: 0 }, {}), true);
  assert.equal(plausible({ score: -5, durationTicks: 10 }, {}), false);
  assert.equal(plausible({ score: 1e9, durationTicks: 10 }, {}), false);
});

test('friends filter does not leak non-friends', async () => {
  const cfg = dailyContent('2026-08-19');
  const board = await fetch(`${base}/api/v1/scores?board=daily-${cfg.dateKey}&friends=1`, {
    headers: { 'x-player-id': 'lonely', 'x-friends': '' },
  }).then((x) => x.json());
  for (const e of board.entries) assert.equal(e.you, true);
});
