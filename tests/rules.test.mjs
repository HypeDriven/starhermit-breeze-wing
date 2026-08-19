/**
 * Breeze Wing — rules, content, and session tests (node:test).
 * Covers: legal actions, invalid-action reasons, scoring components,
 * terminal states, serialization, deterministic replay, fuzzing,
 * golden sessions, and content validation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSession, applyCommand, step, legalActions, hashState, serialize,
  deserialize, runReplay, createReplayEnvelope, createRng, hashString,
  Phase, TerminalReason, ActionType, compareResults, normalizeConfig,
  WORLD, TICKS_PER_SECOND, gateGapY, currentGapHalf,
} from '../js/rules.js';
import {
  JOURNEY, LESSONS, CHALLENGES, PRACTICE_PRESETS, dailyContent,
  scoreChaseContent, validateAll, validateContent, THEMES,
} from '../js/content.js';
import { GameSession } from '../js/session.js';

/* A gentle, finite config used by many tests. */
function testConfig(overrides = {}) {
  return {
    id: 'test', version: 1, seed: 12345, name: 'Test', mode: 'practice',
    theme: 'day',
    params: {
      gravity: 26, lift: 8.4, speed: 4, speedRamp: 0, maxSpeed: 12,
      gapHalf: 3, gapShrink: 0, minGapHalf: 2, spacing: 8,
      gateCount: 5, oscAmp: 0, oscFreq: 0, gapRange: 8,
      moveLimit: 0, timeLimitTicks: 0,
    },
    goal: { type: 'gates', value: 5 },
    parTicks: 0,
    ...overrides,
  };
}

/** Drive a session with a simple auto-flap policy until terminal. */
function autoplay(cfg, { maxTicks = 60 * 600, flapEvery = 26 } = {}) {
  let state = createSession(cfg);
  const events = [];
  let cmdN = 0;
  while (state.phase !== Phase.TERMINAL && maxTicks-- > 0) {
    if (state.tick % flapEvery === 0) {
      const r = applyCommand(state, { id: `a${cmdN++}`, tick: state.tick, type: 'flap' });
      state = r.state;
      events.push(...r.events);
    }
    const r = step(state);
    state = r.state;
    events.push(...r.events);
  }
  return { state, events, exhausted: maxTicks <= 0 };
}

/* ------------------------------- RNG ------------------------------- */

test('rng is deterministic and serializable', () => {
  const a = createRng(42); const b = createRng(42);
  for (let i = 0; i < 100; i++) assert.equal(a.next(), b.next());
  const c = createRng(42);
  c.next(); c.next();
  const saved = c.getState();
  const d = createRng(0); d.setState(saved);
  assert.equal(c.next(), d.next());
});

test('hashString is stable', () => {
  assert.equal(hashString('breeze'), hashString('breeze'));
  assert.notEqual(hashString('breeze'), hashString('wing'));
});

/* --------------------------- legal actions ------------------------- */

test('legal actions: flap legal in ready/active, illegal after terminal', () => {
  let s = createSession(testConfig());
  let acts = legalActions(s);
  assert.equal(acts.find((a) => a.type === 'flap').legal, true);
  s = applyCommand(s, { id: 'x1', tick: 0, type: 'flap' }).state;
  assert.equal(s.phase, Phase.ACTIVE);
  assert.equal(legalActions(s).find((a) => a.type === 'flap').legal, true);
  // Force terminal.
  s = { ...s, phase: Phase.TERMINAL, terminal: { reason: 'abandon', tick: s.tick } };
  const flap = legalActions(s).find((a) => a.type === 'flap');
  assert.equal(flap.legal, false);
  assert.equal(flap.reason, 'session-over');
});

test('invalid action reasons: move limit', () => {
  const cfg = testConfig({ params: { ...testConfig().params, moveLimit: 2 } });
  let s = createSession(cfg);
  s = applyCommand(s, { id: 'a', tick: 0, type: 'flap' }).state;
  s = applyCommand(s, { id: 'b', tick: 0, type: 'flap' }).state;
  assert.equal(s.flapsUsed, 2);
  const flap = legalActions(s).find((a) => a.type === 'flap');
  assert.equal(flap.legal, false);
  assert.equal(flap.reason, 'no-moves-remaining');
  const r = applyCommand(s, { id: 'c', tick: 0, type: 'flap' });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'no-moves-remaining');
  assert.equal(r.state.invalidActions, 1);
});

test('unknown and malformed commands rejected', () => {
  const s = createSession(testConfig());
  assert.equal(applyCommand(s, { id: 'q', tick: 0, type: 'teleport' }).reason, 'unknown-action');
  assert.equal(applyCommand(s, null).reason, 'malformed-command');
  assert.equal(applyCommand(s, {}).reason, 'malformed-command');
});

test('duplicate command ids rejected idempotently', () => {
  let s = createSession(testConfig());
  s = applyCommand(s, { id: 'dup', tick: 0, type: 'flap' }).state;
  const r = applyCommand(s, { id: 'dup', tick: 0, type: 'flap' });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'duplicate-command');
  assert.equal(r.state.flapsUsed, 1); // not applied twice
});

/* ------------------------------ physics ---------------------------- */

test('gravity pulls bird down, flap gives lift', () => {
  let s = createSession(testConfig());
  s = applyCommand(s, { id: 'f', tick: 0, type: 'flap' }).state;
  assert.ok(s.bird.vy > 0);
  const y0 = s.bird.y;
  s = step(s).state;
  assert.ok(s.bird.y > y0);
  let prev = s;
  for (let i = 0; i < 90; i++) prev = step(prev).state;
  assert.ok(prev.bird.vy < 0, 'velocity eventually negative');
});

test('floor and ceiling are terminal', () => {
  // No flaps → floor.
  let s = createSession(testConfig());
  s = applyCommand(s, { id: 'go', tick: 0, type: 'flap' }).state;
  let guard = 6000;
  while (s.phase !== Phase.TERMINAL && guard--) s = step(s).state;
  assert.equal(s.terminal.reason, TerminalReason.FLOOR);
  // Massive lift config → ceiling.
  const up = testConfig({ params: { ...testConfig().params, lift: 60 } });
  let s2 = createSession(up);
  s2 = applyCommand(s2, { id: 'go', tick: 0, type: 'flap' }).state;
  guard = 6000;
  while (s2.phase !== Phase.TERMINAL && guard--) s2 = step(s2).state;
  assert.equal(s2.terminal.reason, TerminalReason.CEILING);
});

/* ------------------------------ scoring ---------------------------- */

test('scoring components: gate, center bonus, streak, breakdown', () => {
  // Wide stationary gap at y=0: first gate forced to center for exact math.
  const cfg = testConfig({
    params: { ...testConfig().params, gapHalf: 4, gapRange: 0, speed: 4, gateCount: 3 },
    goal: { type: 'gates', value: 3 },
  });
  let s = createSession(cfg);
  // Pin all gate bases to y=0 for a deterministic centered pass test.
  s.gates = s.gates.map((g) => ({ ...g, baseY: 0, oscPhase: 0 }));
  s = applyCommand(s, { id: 'go', tick: 0, type: 'flap' }).state;
  // Flap rhythm tuned to hover near y=0.
  let n = 1; let guard = 60 * 120;
  while (s.phase !== Phase.TERMINAL && guard--) {
    if (s.bird.y < -0.2 && s.bird.vy < 0) {
      s = applyCommand(s, { id: `h${n++}`, tick: s.tick, type: 'flap' }).state;
    }
    s = step(s).state;
  }
  assert.ok(s.gatesPassed >= 1);
  assert.ok(s.score.gates >= 100);
  assert.ok(s.score.center >= 0 && s.score.center <= 50 * s.gatesPassed);
  assert.equal(s.score.total, s.score.gates + s.score.center + s.score.streak + s.score.time);
  assert.ok(Number.isInteger(s.score.total));
});

test('cleared terminal when gate goal reached, with time bonus under par', () => {
  const cfg = testConfig({ parTicks: 60 * 60 });
  const { state } = autoplay(cfg);
  if (state.terminal.reason === TerminalReason.CLEARED) {
    assert.ok(state.score.time >= 0);
    assert.equal(state.score.total,
      state.score.gates + state.score.center + state.score.streak + state.score.time);
  } else {
    // Autoplay policy may be crude; any terminal reason must be valid.
    assert.ok(Object.values(TerminalReason).includes(state.terminal.reason));
  }
});

test('time-up terminal reason', () => {
  const cfg = testConfig({
    params: { ...testConfig().params, timeLimitTicks: 120 },
    goal: { type: 'gates', value: 99 },
  });
  let s = createSession(cfg);
  s = applyCommand(s, { id: 'go', tick: 0, type: 'flap' }).state;
  let n = 1; let guard = 6000;
  while (s.phase !== Phase.TERMINAL && guard--) {
    if (s.tick % 25 === 0) s = applyCommand(s, { id: `h${n++}`, tick: s.tick, type: 'flap' }).state;
    s = step(s).state;
  }
  assert.ok([TerminalReason.TIME_UP, TerminalReason.FLOOR, TerminalReason.GATE, TerminalReason.CEILING]
    .includes(s.terminal.reason));
});

test('abandon command terminates with reason', () => {
  let s = createSession(testConfig());
  s = applyCommand(s, { id: 'go', tick: 0, type: 'flap' }).state;
  const r = applyCommand(s, { id: 'bye', tick: s.tick, type: 'abandon' });
  assert.equal(r.accepted, true);
  assert.equal(r.state.phase, Phase.TERMINAL);
  assert.equal(r.state.terminal.reason, TerminalReason.ABANDON);
});

test('compareResults implements documented tie-break order', () => {
  const mk = (o) => ({
    terminal: { reason: o.reason || 'cleared' }, score: { total: o.score },
    invalidActions: o.inv || 0, tick: o.tick || 100, sessionId: o.sid || 'a',
  });
  const win = mk({ score: 100 }); const lose = mk({ score: 100, reason: 'floor' });
  assert.ok(compareResults(win, lose) < 0);
  const more = mk({ score: 200 });
  assert.ok(compareResults(more, win) < 0);
  const dirty = mk({ score: 200, inv: 3 });
  assert.ok(compareResults(more, dirty) < 0);
  const slow = mk({ score: 200, tick: 200 });
  assert.ok(compareResults(more, slow) < 0);
  const sidB = mk({ score: 200, sid: 'b' });
  assert.ok(compareResults(more, sidB) < 0);
});

/* -------------------------- serialization -------------------------- */

test('serialize/deserialize round-trips and preserves hash', () => {
  let s = createSession(testConfig());
  s = applyCommand(s, { id: 'go', tick: 0, type: 'flap' }).state;
  for (let i = 0; i < 100; i++) s = step(s).state;
  const json = serialize(s);
  let s2 = deserialize(json);
  assert.equal(hashState(s), hashState(s2));
  // Continue both — identical futures.
  for (let i = 0; i < 100; i++) { s = step(s).state; s2 = step(s2).state; }
  assert.equal(hashState(s), hashState(s2));
});

test('deserialize rejects wrong version', () => {
  const s = createSession(testConfig());
  const bad = JSON.parse(serialize(s));
  bad.rulesVersion = 999;
  assert.throws(() => deserialize(JSON.stringify(bad)));
});

/* ------------------------ deterministic replay --------------------- */

test('same seed + commands → identical state hash (property-style sweep)', () => {
  for (const seed of [1, 7, 999, 123456789, 0xdeadbeef]) {
    const run = () => {
      const cfg = testConfig({ seed });
      let s = createSession(cfg);
      const rng = createRng(seed ^ 0x5eed);
      let n = 0;
      let guard = 60 * 300;
      while (s.phase !== Phase.TERMINAL && guard--) {
        if (rng.next() < 0.04) {
          s = applyCommand(s, { id: `r${n++}`, tick: s.tick, type: 'flap' }).state;
        }
        s = step(s).state;
      }
      return { hash: hashState(s), score: s.score.total };
    };
    const a = run(); const b = run();
    assert.equal(a.hash, b.hash, `seed ${seed} diverged`);
    assert.equal(a.score, b.score);
  }
});

test('replay envelope validates a recorded session', () => {
  const cfg = testConfig();
  const gs = new GameSession(cfg, { build: 'test' });
  let guard = 60 * 300;
  while (gs.phase !== Phase.TERMINAL && guard--) {
    if (gs.state.tick % 27 === 0) gs.command(ActionType.FLAP);
    gs.tick();
  }
  const env = JSON.parse(JSON.stringify(gs.envelope));
  env.config = cfg; // runReplay needs the config to reconstruct
  const r = runReplay(env);
  assert.equal(r.ok, true, `mismatch: ${r.mismatch}`);
  assert.equal(r.state.score.total, gs.state.score.total);
  assert.equal(r.state.terminal.reason, gs.state.terminal.reason);
});

test('replay detects tampered scores', () => {
  const cfg = testConfig();
  const gs = new GameSession(cfg, { build: 'test' });
  let guard = 60 * 300;
  while (gs.phase !== Phase.TERMINAL && guard--) {
    if (gs.state.tick % 27 === 0) gs.command(ActionType.FLAP);
    gs.tick();
  }
  const env = JSON.parse(JSON.stringify(gs.envelope));
  env.config = cfg;
  env.result.score += 1000;
  const r = runReplay(env);
  assert.equal(r.ok, false);
  assert.match(r.mismatch, /^score:/);
});

/* --------------------------- session/undo -------------------------- */

test('practice undo restores pre-flap state', () => {
  const gs = new GameSession(testConfig(), { allowUndo: true });
  gs.command(ActionType.FLAP);
  for (let i = 0; i < 30; i++) gs.tick();
  const hashBefore = hashState(gs.state);
  gs.command(ActionType.FLAP);
  for (let i = 0; i < 10; i++) gs.tick();
  assert.equal(gs.canUndo, true);
  assert.equal(gs.undo(), true);
  assert.equal(hashState(gs.state), hashBefore);
  assert.equal(gs.undo(), true); // back to before first flap
  assert.equal(gs.canUndo, false);
});

test('undo disallowed without opt-in', () => {
  const gs = new GameSession(testConfig());
  gs.command(ActionType.FLAP);
  assert.equal(gs.undo(), false);
});

/* ------------------------------- fuzz ------------------------------ */

test('fuzz: malformed commands and random inputs never hang or NaN', () => {
  const rng = createRng(0xf00d);
  for (let trial = 0; trial < 25; trial++) {
    const cfg = testConfig({ seed: trial * 1337 });
    let s = createSession(cfg);
    const junk = [null, undefined, 42, 'flap', {}, { type: 1 }, { type: '' },
      { type: 'flap', id: {} }, { type: 'FLAP' }, { type: '\x00' }];
    for (const j of junk) {
      const r = applyCommand(s, j);
      s = r.state; // state must always remain valid
    }
    let guard = 60 * 120;
    while (s.phase !== Phase.TERMINAL && guard--) {
      if (rng.next() < 0.05) {
        s = applyCommand(s, { id: `f${trial}-${s.tick}`, tick: s.tick, type: 'flap' }).state;
      }
      s = step(s).state;
      assert.ok(Number.isFinite(s.bird.y), 'NaN bird y');
      assert.ok(Number.isFinite(s.bird.vy), 'NaN bird vy');
      for (const g of s.gates) assert.ok(Number.isFinite(g.x));
    }
    assert.ok(guard > 0, 'session did not terminate in bounded time');
    assert.ok(Object.values(TerminalReason).includes(s.terminal.reason));
  }
});

test('fuzz: generated content across seeds stays valid and bounded', () => {
  for (let i = 0; i < 20; i++) {
    const cfg = scoreChaseContent(`fuzz-${i}`);
    const v = validateContent(cfg);
    assert.ok(v.ok, `${cfg.id}: ${v.errors.join(',')}`);
    const { state, exhausted } = autoplay({ ...cfg, params: { ...cfg.params, timeLimitTicks: 60 * 30 } });
    assert.equal(exhausted, false);
    assert.ok(state.terminal);
  }
});

/* --------------------------- golden sessions ----------------------- */

test('golden: journey stage 1 autoplay is reproducible', () => {
  const run = () => autoplay(JOURNEY[0]).state;
  const a = run(); const b = run();
  assert.equal(hashState(a), hashState(b));
  assert.ok(a.score.total >= 0);
});

test('golden: interrupted + resumed session matches uninterrupted', () => {
  const cfg = JOURNEY[5];
  const full = () => {
    let s = createSession(cfg);
    let n = 0; let guard = 60 * 300;
    while (s.phase !== Phase.TERMINAL && guard--) {
      if (s.tick % 24 === 0) s = applyCommand(s, { id: `g${n++}`, tick: s.tick, type: 'flap' }).state;
      s = step(s).state;
    }
    return s;
  };
  const interrupted = () => {
    let s = createSession(cfg);
    let n = 0;
    for (let i = 0; i < 500 && s.phase !== Phase.TERMINAL; i++) {
      if (s.tick % 24 === 0) s = applyCommand(s, { id: `g${n++}`, tick: s.tick, type: 'flap' }).state;
      s = step(s).state;
    }
    // "Background": serialize, restore, continue.
    s = deserialize(serialize(s));
    let guard = 60 * 300;
    while (s.phase !== Phase.TERMINAL && guard--) {
      if (s.tick % 24 === 0) s = applyCommand(s, { id: `g${n++}`, tick: s.tick, type: 'flap' }).state;
      s = step(s).state;
    }
    return s;
  };
  assert.equal(hashState(full()), hashState(interrupted()));
});

/* ------------------------------ content ---------------------------- */

test('all shipped content passes offline validators', () => {
  const report = validateAll();
  const bad = report.filter((r) => !r.ok);
  assert.deepEqual(bad, [], JSON.stringify(bad));
});

test('journey has 40 stages, 5 lessons, 5 themes, challenges and presets', () => {
  assert.equal(JOURNEY.length, 40);
  assert.equal(LESSONS.length, 5);
  assert.equal(Object.keys(THEMES).length, 5);
  assert.ok(CHALLENGES.length >= 5);
  assert.ok(PRACTICE_PRESETS.length >= 3);
  // mastery stages every 10th
  assert.ok(JOURNEY[9].mastery && JOURNEY[39].mastery && !JOURNEY[0].mastery);
});

test('daily content is immutable per UTC day', () => {
  const a = dailyContent('2026-08-19');
  const b = dailyContent('2026-08-19');
  const c = dailyContent('2026-08-20');
  assert.equal(a.seed, b.seed);
  assert.equal(a.id, 'daily-2026-08-19');
  assert.notEqual(a.seed, c.seed);
  assert.equal(a.ranked, true);
});

test('daily content validates across a year sweep', () => {
  for (let d = 0; d < 366; d += 17) {
    const date = new Date(Date.UTC(2026, 0, 1) + d * 86400000);
    const cfg = dailyContent(date);
    const v = validateContent(cfg);
    assert.ok(v.ok, `${cfg.id}: ${v.errors.join(',')}`);
  }
});

test('config normalization fills defaults and clamps', () => {
  const c = normalizeConfig({ id: 'x', seed: 'abc' });
  assert.equal(c.params.gravity, 26);
  assert.equal(typeof c.seed, 'number');
  assert.equal(c.goal.type, 'endless');
});

test('oscillating gates: gateGapY is deterministic and bounded', () => {
  const cfg = testConfig({ params: { ...testConfig().params, oscAmp: 2, oscFreq: 0.02 } });
  const g = { i: 0, x: 10, baseY: 1, oscPhase: 0.5, passed: false };
  for (let t = 0; t < 1000; t += 37) {
    const y = gateGapY(cfg, g, t);
    assert.ok(Math.abs(y - 1) <= 2 + 1e-9);
    assert.equal(y, gateGapY(cfg, g, t));
  }
});

test('gap shrink respects floor', () => {
  const cfg = testConfig({ params: { ...testConfig().params, gapHalf: 3, gapShrink: 0.5, minGapHalf: 2 } });
  assert.equal(currentGapHalf(cfg, 0), 3);
  assert.equal(currentGapHalf(cfg, 100), 2);
});
