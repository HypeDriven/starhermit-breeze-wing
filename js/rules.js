/**
 * Breeze Wing — rules engine.
 * Pure, deterministic, DOM-free. Runs identically in browser and Node.
 *
 * Contract:
 *  - Fixed simulation step (SIM_DT). One tick == one step.
 *  - Legal actions are queryable via legalActions(); play, tutorials and hints
 *    all go through the same applyCommand() path.
 *  - State is JSON-serializable; hashState() gives a stable replay hash.
 *  - state.tick increases monotonically; terminal states carry a reason.
 *  - Scores are integers; floats are used only for physics positions.
 */

export const RULES_VERSION = 1;
export const SIM_DT = 1 / 60;
export const TICKS_PER_SECOND = 60;

/** Canonical physics constants (world units: bird radius is 0.5). */
export const WORLD = Object.freeze({
  birdX: 0,
  birdRadius: 0.5,
  floorY: -9,
  ceilY: 9,
  gateHalfWidth: 0.6,
  spawnX: 14,
  despawnX: -16,
});

/* ------------------------------------------------------------------ */
/* Seeded random streams                                               */
/* ------------------------------------------------------------------ */

/** mulberry32 — small, fast, fully serializable (state is one uint32). */
export function createRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => Math.floor(lo + (hi - lo + 1) * next()),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    getState: () => a >>> 0,
    setState: (s) => { a = s >>> 0; },
  };
}

/** FNV-1a string hash → uint32 seed. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/* ------------------------------------------------------------------ */
/* Content config normalization                                        */
/* ------------------------------------------------------------------ */

/**
 * A content config is versioned data:
 * { id, version, seed, name, mode, theme, tutorial,
 *   params: { gravity, lift, speed, speedRamp, gapHalf, gapShrink, spacing,
 *             gateCount (0 = endless), oscAmp, oscFreq, gapRange,
 *             moveLimit (0 = none), timeLimitTicks (0 = none) },
 *   goal: { type: 'gates'|'score'|'survive'|'endless', value },
 *   parTicks }
 */
export function normalizeConfig(cfg) {
  const p = cfg.params || {};
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const params = {
    gravity: num(p.gravity, 26),
    lift: num(p.lift, 8.4),
    speed: num(p.speed, 5),
    speedRamp: num(p.speedRamp, 0),       // added speed per passed gate
    maxSpeed: num(p.maxSpeed, 12),
    gapHalf: num(p.gapHalf, 2.6),          // half-height of the gate gap
    gapShrink: num(p.gapShrink, 0),        // gap shrink per passed gate
    minGapHalf: num(p.minGapHalf, 1.6),
    spacing: num(p.spacing, 7),            // horizontal distance between gates
    gateCount: Math.max(0, Math.floor(num(p.gateCount, 0))), // 0 = endless
    oscAmp: num(p.oscAmp, 0),              // vertical oscillation amplitude
    oscFreq: num(p.oscFreq, 0),            // oscillation rad/tick
    gapRange: num(p.gapRange, 10),         // vertical range for gap centers
    moveLimit: Math.max(0, Math.floor(num(p.moveLimit, 0))),
    timeLimitTicks: Math.max(0, Math.floor(num(p.timeLimitTicks, 0))),
  };
  const goal = cfg.goal && typeof cfg.goal === 'object'
    ? { type: String(cfg.goal.type || 'endless'), value: Math.max(0, Math.floor(num(cfg.goal.value, 0))) }
    : { type: 'endless', value: 0 };
  return {
    id: String(cfg.id || 'unnamed'),
    version: Math.max(1, Math.floor(num(cfg.version, 1))),
    seed: (typeof cfg.seed === 'number' ? cfg.seed : hashString(String(cfg.seed ?? 'breeze'))) >>> 0,
    name: String(cfg.name || 'Untitled'),
    mode: String(cfg.mode || 'practice'),
    theme: String(cfg.theme || 'dawn'),
    tutorial: cfg.tutorial === true,
    ranked: cfg.ranked === true,
    params,
    goal,
    parTicks: Math.max(0, Math.floor(num(cfg.parTicks, 0))),
  };
}

/* ------------------------------------------------------------------ */
/* Gate generation (deterministic, streamable)                         */
/* ------------------------------------------------------------------ */

function makeGate(cfg, rng, index) {
  const halfRange = cfg.params.gapRange / 2;
  return {
    i: index,
    x: WORLD.spawnX + index * cfg.params.spacing,
    baseY: Math.round(rng.range(-halfRange, halfRange) * 1000) / 1000,
    oscPhase: Math.round(rng.range(0, Math.PI * 2) * 1000) / 1000,
    passed: false,
  };
}

/** Current vertical center of a gate's gap at a given tick. */
export function gateGapY(cfg, gate, tick) {
  if (!cfg.params.oscAmp || !cfg.params.oscFreq) return gate.baseY;
  return gate.baseY + cfg.params.oscAmp * Math.sin(cfg.params.oscFreq * tick + gate.oscPhase);
}

/** Gap half-height for the n-th passed gate (shrinks as you progress). */
export function currentGapHalf(cfg, passedCount) {
  const g = cfg.params.gapHalf - cfg.params.gapShrink * passedCount;
  return Math.max(cfg.params.minGapHalf, g);
}

/** Current scroll speed. */
export function currentSpeed(cfg, passedCount) {
  return Math.min(cfg.params.maxSpeed, cfg.params.speed + cfg.params.speedRamp * passedCount);
}

/* ------------------------------------------------------------------ */
/* Session lifecycle                                                   */
/* ------------------------------------------------------------------ */

export const Phase = Object.freeze({
  READY: 'ready',       // created, waiting for first flap
  ACTIVE: 'active',
  TERMINAL: 'terminal',
});

export const TerminalReason = Object.freeze({
  FLOOR: 'floor',
  CEILING: 'ceiling',
  GATE: 'gate',
  CLEARED: 'cleared',        // all gates passed / goal reached
  MOVE_LIMIT: 'move-limit',  // ran out of flaps and fell
  TIME_UP: 'time-up',
  ABANDON: 'abandon',
});

/**
 * Create a fresh session state from a normalized config.
 * Deterministic: same config → same initial state and gate stream.
 */
export function createSession(rawCfg) {
  const cfg = normalizeConfig(rawCfg);
  const rng = createRng(cfg.seed);
  const gates = [];
  const initial = cfg.params.gateCount > 0 ? Math.min(cfg.params.gateCount, 4) : 4;
  for (let i = 0; i < initial; i++) gates.push(makeGate(cfg, rng, i));
  return {
    rulesVersion: RULES_VERSION,
    config: cfg,
    tick: 0,
    phase: Phase.READY,
    terminal: null, // { reason, tick } once terminal
    bird: { y: 0, vy: 0 },
    gates,
    nextGateIndex: initial,
    rngState: rng.getState(),
    flapsUsed: 0,
    gatesPassed: 0,
    centeredPasses: 0,
    bestStreak: 0,
    streak: 0,
    invalidActions: 0,
    score: { gates: 0, center: 0, streak: 0, time: 0, total: 0 },
    commands: [], // ordered applied command ids (audit/replay)
    lastEventTick: 0,
  };
}

/* ------------------------------------------------------------------ */
/* Legality                                                            */
/* ------------------------------------------------------------------ */

export const ActionType = Object.freeze({
  FLAP: 'flap',
  ABANDON: 'abandon',
});

/**
 * Legal-action query. Returns an array of { type, legal, reason }.
 * reason is a stable machine string when legal === false.
 * Tutorials and hints must use this, never a duplicated rule.
 */
export function legalActions(state) {
  const acts = [];
  if (state.phase === Phase.TERMINAL) {
    acts.push({ type: ActionType.FLAP, legal: false, reason: 'session-over' });
    acts.push({ type: ActionType.ABANDON, legal: false, reason: 'session-over' });
    return acts;
  }
  const p = state.config.params;
  if (p.moveLimit > 0 && state.flapsUsed >= p.moveLimit) {
    acts.push({ type: ActionType.FLAP, legal: false, reason: 'no-moves-remaining' });
  } else {
    acts.push({ type: ActionType.FLAP, legal: true, reason: null });
  }
  acts.push({ type: ActionType.ABANDON, legal: true, reason: null });
  return acts;
}

export function isLegal(state, type) {
  const a = legalActions(state).find((x) => x.type === type);
  return !!a && a.legal;
}

export function illegalReason(state, type) {
  const a = legalActions(state).find((x) => x.type === type);
  if (!a) return 'unknown-action';
  return a.legal ? null : a.reason;
}

/* ------------------------------------------------------------------ */
/* Command application                                                 */
/* ------------------------------------------------------------------ */

let cmdSeq = 0;

/** Apply a player command. Returns { state, events, accepted, reason }. */
export function applyCommand(state, cmd) {
  if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') {
    return { state, events: [], accepted: false, reason: 'malformed-command' };
  }
  const id = typeof cmd.id === 'string' ? cmd.id : `c${++cmdSeq}`;
  if (state.commands.includes(id)) {
    // Idempotent duplicate rejection.
    return { state, events: [], accepted: false, reason: 'duplicate-command' };
  }
  const type = cmd.type;
  const known = Object.values(ActionType).includes(type);
  if (!known) {
    return { state, events: [], accepted: false, reason: 'unknown-action' };
  }
  if (!isLegal(state, type)) {
    const reason = illegalReason(state, type);
    const next = { ...state, invalidActions: state.invalidActions + 1 };
    return { state: next, events: [{ type: 'invalid', reason }], accepted: false, reason };
  }
  const next = { ...state, commands: [...state.commands, id], score: { ...state.score } };
  const events = [];
  if (type === ActionType.FLAP) {
    if (next.phase === Phase.READY) {
      next.phase = Phase.ACTIVE;
      events.push({ type: 'start' });
    }
    next.bird = { y: next.bird.y, vy: next.config.params.lift };
    next.flapsUsed += 1;
    events.push({ type: 'flap' });
  } else if (type === ActionType.ABANDON) {
    next.phase = Phase.TERMINAL;
    next.terminal = { reason: TerminalReason.ABANDON, tick: next.tick };
    finalizeScore(next);
    events.push({ type: 'terminal', reason: TerminalReason.ABANDON });
  }
  return { state: next, events, accepted: true, reason: null };
}

/* ------------------------------------------------------------------ */
/* Simulation step                                                     */
/* ------------------------------------------------------------------ */

/**
 * Advance exactly one fixed tick. Returns { state, events }.
 * Events: flap/start/invalid (from commands), pass, centered, streak,
 * terminal. Cosmetic layers consume events; rules stay pure.
 */
export function step(state) {
  if (state.phase !== Phase.ACTIVE) return { state, events: [] };
  const cfg = state.config;
  const p = cfg.params;
  const events = [];
  const tick = state.tick + 1;

  // Restore RNG for deterministic gate generation.
  const rng = createRng(cfg.seed);
  rng.setState(state.rngState);

  // Bird physics.
  let vy = state.bird.vy - p.gravity * SIM_DT;
  let y = state.bird.y + vy * SIM_DT;

  // Gate scrolling.
  const speed = currentSpeed(cfg, state.gatesPassed);
  let gates = state.gates.map((g) => ({ ...g, x: g.x - speed * SIM_DT }));

  // Spawn ahead.
  let nextGateIndex = state.nextGateIndex;
  const endless = p.gateCount === 0;
  const furthest = gates.length ? gates[gates.length - 1].x : -Infinity;
  if ((endless || nextGateIndex < p.gateCount) && furthest < WORLD.spawnX) {
    gates.push(makeGate(cfg, rng, nextGateIndex));
    nextGateIndex += 1;
  }
  // Despawn behind.
  gates = gates.filter((g) => g.x > WORLD.despawnX);

  const next = {
    ...state,
    tick,
    bird: { y, vy },
    gates,
    nextGateIndex,
    rngState: rng.getState(),
    lastEventTick: state.lastEventTick,
    score: { ...state.score },          // immutable snapshot: never write into caller's state
  };

  let terminal = null;

  // Bounds.
  if (y - WORLD.birdRadius <= WORLD.floorY) {
    terminal = p.moveLimit > 0 && next.flapsUsed >= p.moveLimit
      ? TerminalReason.MOVE_LIMIT
      : TerminalReason.FLOOR;
  } else if (y + WORLD.birdRadius >= WORLD.ceilY) {
    terminal = TerminalReason.CEILING;
  }

  // Gate collision + passing.
  const gapHalf = currentGapHalf(cfg, state.gatesPassed);
  for (const g of gates) {
    const overlapX = Math.abs(g.x - WORLD.birdX) < WORLD.gateHalfWidth + WORLD.birdRadius;
    if (overlapX && !g.passed) {
      const gapY = gateGapY(cfg, g, tick);
      const dy = y - gapY;
      if (Math.abs(dy) > gapHalf - WORLD.birdRadius) {
        terminal = terminal || TerminalReason.GATE;
      }
    }
    if (!g.passed && g.x + WORLD.gateHalfWidth < WORLD.birdX - WORLD.birdRadius) {
      g.passed = true;
      next.gatesPassed += 1;
      const gapY = gateGapY(cfg, g, tick);
      const dy = Math.abs(y - gapY);
      const centerFrac = Math.max(0, 1 - dy / gapHalf);
      const centerBonus = Math.round(50 * centerFrac);
      const centered = dy <= gapHalf * 0.25;
      next.score.gates += 100;
      next.score.center += centerBonus;
      if (centered) {
        next.streak += 1;
        next.centeredPasses += 1;
        const streakBonus = Math.min(100, next.streak * 10);
        next.score.streak += streakBonus;
        events.push({ type: 'centered', streak: next.streak, bonus: streakBonus });
      } else {
        next.streak = 0;
      }
      if (next.streak > next.bestStreak) next.bestStreak = next.streak;
      events.push({ type: 'pass', gate: g.i, centerBonus, centered });
      next.lastEventTick = tick;
    }
  }

  // Goal / limit checks.
  if (!terminal) {
    const goal = cfg.goal;
    if (goal.type === 'gates' && next.gatesPassed >= goal.value) terminal = TerminalReason.CLEARED;
    else if (goal.type === 'flaps' && next.flapsUsed >= goal.value) terminal = TerminalReason.CLEARED;
    else if (goal.type === 'score' && scoreTotal(next.score) >= goal.value) terminal = TerminalReason.CLEARED;
    else if (goal.type === 'survive' && tick >= goal.value) terminal = TerminalReason.CLEARED;
    else if (!endless && p.gateCount > 0 && next.gatesPassed >= p.gateCount) terminal = TerminalReason.CLEARED;
    else if (p.timeLimitTicks > 0 && tick >= p.timeLimitTicks) {
      terminal = goal.type === 'endless' ? TerminalReason.CLEARED : TerminalReason.TIME_UP;
    }
  }

  if (terminal) {
    next.phase = Phase.TERMINAL;
    next.terminal = { reason: terminal, tick };
    finalizeScore(next);
    events.push({ type: 'terminal', reason: terminal });
  }

  next.score.total = scoreTotal(next.score);
  return { state: next, events };
}

function scoreTotal(s) {
  return s.gates + s.center + s.streak + s.time;
}

export function totalScore(state) {
  return scoreTotal(state.score);
}

function finalizeScore(state) {
  // Time bonus for finite goals with a par: reward finishing under par.
  if (state.config.parTicks > 0 &&
      (state.terminal.reason === TerminalReason.CLEARED)) {
    const under = Math.max(0, state.config.parTicks - state.tick);
    state.score.time = Math.round((under / TICKS_PER_SECOND) * 5);
  }
  state.score.total = scoreTotal(state.score);
}

/** Tie-break comparison: returns negative if a ranks above b. */
export function compareResults(a, b) {
  // 1. primary objective completion
  const ca = a.terminal && a.terminal.reason === TerminalReason.CLEARED ? 1 : 0;
  const cb = b.terminal && b.terminal.reason === TerminalReason.CLEARED ? 1 : 0;
  if (ca !== cb) return cb - ca;
  // 2. score
  if (a.score.total !== b.score.total) return b.score.total - a.score.total;
  // 3. fewer invalid actions
  if (a.invalidActions !== b.invalidActions) return a.invalidActions - b.invalidActions;
  // 4. lower elapsed time
  if (a.tick !== b.tick) return a.tick - b.tick;
  // 5. stable session identifier
  return String(a.sessionId || '').localeCompare(String(b.sessionId || ''));
}

/* ------------------------------------------------------------------ */
/* Serialization + hashing                                             */
/* ------------------------------------------------------------------ */

export function serialize(state) {
  return JSON.stringify(state);
}

export function deserialize(json) {
  const s = JSON.parse(json);
  if (!s || s.rulesVersion !== RULES_VERSION) {
    throw new Error(`unsupported rules version: ${s && s.rulesVersion}`);
  }
  s.config = normalizeConfig(s.config);
  return s;
}

/** Stable FNV-1a hash of the canonical serialized state. */
export function hashState(state) {
  return hashString(stableStringify(state)).toString(16).padStart(8, '0');
}

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

/* ------------------------------------------------------------------ */
/* Replay                                                              */
/* ------------------------------------------------------------------ */

/**
 * Replay envelope: { schemaVersion, rulesVersion, build, contentId,
 * contentVersion, seed, config, createdAtOffset, commands: [{id, tick,
 * type}], hashes: [{tick, hash}], result }.
 * `config` makes the envelope self-describing: a validator can re-execute it
 * from the envelope alone (spec §5), with no external session state needed.
 */
export const REPLAY_SCHEMA_VERSION = 1;

export function createReplayEnvelope(config, build) {
  return {
    schemaVersion: REPLAY_SCHEMA_VERSION,
    rulesVersion: RULES_VERSION,
    build: String(build || 'dev'),
    contentId: config.id,
    contentVersion: config.version,
    seed: config.seed,
    config,
    createdAtOffset: 0,
    commands: [],
    hashes: [],
    result: null,
  };
}

/**
 * Deterministically re-run an envelope. Returns { state, ok, mismatch }.
 * Commands carry the tick at which they were applied; gaps are stepped.
 */
export function runReplay(envelope) {
  if (!envelope || envelope.schemaVersion !== REPLAY_SCHEMA_VERSION) {
    return { state: null, ok: false, mismatch: 'bad-schema' };
  }
  let state = createSession({ ...envelope.config, seed: envelope.seed });
  const cmds = [...envelope.commands].sort((a, b) => a.tick - b.tick);
  let mismatch = null;
  const hashMap = new Map((envelope.hashes || []).map((h) => [h.tick, h.hash]));
  for (const cmd of cmds) {
    if (!Number.isInteger(cmd.tick) || cmd.tick < state.tick || cmd.tick > state.tick + 60 * 60 * 60) {
      return { state, ok: false, mismatch: 'bad-command-tick' };
    }
    while (state.tick < cmd.tick && state.phase !== Phase.TERMINAL) {
      state = step(state).state;
      if (hashMap.has(state.tick) && hashMap.get(state.tick) !== hashState(state)) {
        mismatch = `hash@${state.tick}`;
        return { state, ok: false, mismatch };
      }
    }
    if (state.phase === Phase.TERMINAL) break;
    const r = applyCommand(state, cmd);
    if (!r.accepted && r.reason !== 'duplicate-command') {
      return { state: r.state, ok: false, mismatch: `rejected:${r.reason}` };
    }
    state = r.state;
  }
  // Run out to terminal (bounded).
  let guard = 60 * 60 * 10;
  while (state.phase !== Phase.TERMINAL && guard-- > 0) {
    state = step(state).state;
  }
  if (guard <= 0) return { state, ok: false, mismatch: 'no-termination' };
  if (envelope.result && envelope.result.score !== state.score.total) {
    return { state, ok: false, mismatch: `score:${envelope.result.score}!=${state.score.total}` };
  }
  return { state, ok: !mismatch, mismatch };
}
