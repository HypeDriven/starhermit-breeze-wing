/**
 * Breeze Wing — content: versioned stages, lessons, challenges, daily seeds,
 * visual themes, achievements, and offline validators.
 * Pure data + generation; no DOM, no rendering.
 */

import { hashString, TICKS_PER_SECOND } from './rules.js';

export const CONTENT_VERSION = 1;
export const BUILD = '1.0.0';

/* ------------------------------------------------------------------ */
/* Visual themes (five) — presentation data only, never rules.         */
/* ------------------------------------------------------------------ */

export const THEMES = {
  dawn: {
    id: 'dawn', name: 'Ember Dawn',
    sky: 0xffc98a, skyTop: 0x7fb2e5, horizon: 0xffe3b3, haze: 0xffd9a0,
    sun: 0xfff2cc, keyLight: 0xffe0b0, ambient: 0x9db8dd,
    islandTop: 0x7ec850, islandRock: 0x9a7b5a, gate: 0xe8623d, gateTrim: 0xfff1d6,
    cloud: 0xfff4e0, bird: 0xfff8ee, wing: 0xff9d5c, accent: 0xd94f2b,
  },
  day: {
    id: 'day', name: 'High Noon',
    sky: 0xbfe8ff, skyTop: 0x4f9fe0, horizon: 0xeaf7ff, haze: 0xd8f0ff,
    sun: 0xffffff, keyLight: 0xffffff, ambient: 0xbcd4ee,
    islandTop: 0x62bd4e, islandRock: 0x8a7a68, gate: 0x3f7fd6, gateTrim: 0xeaf4ff,
    cloud: 0xffffff, bird: 0xffffff, wing: 0x63b3ff, accent: 0x1f5fb0,
  },
  dusk: {
    id: 'dusk', name: 'Violet Dusk',
    sky: 0xd98bb0, skyTop: 0x51418c, horizon: 0xf7b6c2, haze: 0xe3a8c0,
    sun: 0xffd0e0, keyLight: 0xffc2d4, ambient: 0x8f83c4,
    islandTop: 0x6fae62, islandRock: 0x6e5a70, gate: 0xb04fd6, gateTrim: 0xf2e0ff,
    cloud: 0xf6d8e8, bird: 0xfdf0f6, wing: 0xd67fb8, accent: 0x8a2fa8,
  },
  night: {
    id: 'night', name: 'Starlit Drift',
    sky: 0x2b3a6e, skyTop: 0x0d1330, horizon: 0x4a5b9e, haze: 0x3a4a80,
    sun: 0xcfe0ff, keyLight: 0xaac4ff, ambient: 0x54649a,
    islandTop: 0x4d8a6a, islandRock: 0x4a4a66, gate: 0x50c8c0, gateTrim: 0xd8fffa,
    cloud: 0x8a9ac8, bird: 0xe8f0ff, wing: 0x7fe0d8, accent: 0x2fa8a0,
  },
  aurora: {
    id: 'aurora', name: 'Aurora Vale',
    sky: 0x9fe8d0, skyTop: 0x1e4a5e, horizon: 0xc8f4e0, haze: 0xa8e8d4,
    sun: 0xe8fff4, keyLight: 0xd0ffe8, ambient: 0x7ab0a4,
    islandTop: 0x58c78a, islandRock: 0x3e6a62, gate: 0x40d890, gateTrim: 0xeafff4,
    cloud: 0xd0f4e4, bird: 0xf4fffa, wing: 0x6fe8b0, accent: 0x18a868,
  },
};

export const THEME_IDS = Object.keys(THEMES);

/* ------------------------------------------------------------------ */
/* Difficulty recipe                                                   */
/* ------------------------------------------------------------------ */

/**
 * Difficulty is expressed through solution depth (gate count), time pressure
 * (speed/par), motor precision (gap size), hidden information (oscillation)
 * and recovery options (move limits) — not merely bigger numbers.
 */
function recipe(tier) {
  // tier: 0 (gentlest) .. 1 (hardest)
  return {
    gravity: 26,
    lift: 8.4,
    speed: 4.4 + tier * 3.6,                       // 4.4 .. 8.0
    speedRamp: 0.02 + tier * 0.10,
    maxSpeed: 8 + tier * 5,
    gapHalf: 2.9 - tier * 1.0,                     // 2.9 .. 1.9
    gapShrink: 0.006 + tier * 0.012,
    minGapHalf: 1.7 - tier * 0.2,
    spacing: 7.6 - tier * 1.4,                     // 7.6 .. 6.2
    oscAmp: tier < 0.35 ? 0 : 0.8 + tier * 2.2,    // moving gates appear mid-way
    oscFreq: tier < 0.35 ? 0 : 0.010 + tier * 0.012,
    gapRange: 8 + tier * 3,
  };
}

/* ------------------------------------------------------------------ */
/* Journey: 40 authored stages + mastery gates                         */
/* ------------------------------------------------------------------ */

const JOURNEY_THEMES = ['dawn', 'day', 'dusk', 'night', 'aurora'];

function journeyStage(index) {
  // index 0..39. Mastery stages at 9, 19, 29, 39 (every 10th).
  const mastery = index % 10 === 9;
  const tier = Math.min(1, index / 39);
  const base = recipe(mastery ? Math.min(1, tier + 0.08) : tier);
  const gateCount = mastery ? 22 : 10 + Math.floor(index / 4); // depth grows
  const theme = JOURNEY_THEMES[Math.floor(index / 8) % JOURNEY_THEMES.length];
  const seed = hashString(`journey-v${CONTENT_VERSION}-${index}`);
  const expected = (base.spacing * (gateCount + 2)) / base.speed;
  const params = {
    ...base,
    gateCount,
    moveLimit: 0,
    timeLimitTicks: 0,
  };
  return {
    id: `journey-${String(index + 1).padStart(2, '0')}`,
    version: CONTENT_VERSION,
    seed,
    name: mastery ? `Mastery: ${THEMES[theme].name}` : `${THEMES[theme].name} ${ (index % 8) + 1 }`,
    mode: 'journey',
    theme,
    mastery,
    index,
    params,
    goal: { type: 'gates', value: gateCount },
    parTicks: Math.round(expected * TICKS_PER_SECOND * 1.05),
  };
}

export const JOURNEY = Array.from({ length: 40 }, (_, i) => journeyStage(i));

/* ------------------------------------------------------------------ */
/* Learn: interactive lessons, one rule at a time                      */
/* ------------------------------------------------------------------ */

export const LESSONS = [
  {
    id: 'learn-1', version: CONTENT_VERSION, seed: hashString('learn-1'),
    name: 'First Lift', mode: 'learn', theme: 'dawn', tutorial: true,
    lesson: {
      step: 'flap',
      prompt: 'Press Space, click, or tap to flap. Flap once to take off!',
      goalText: 'Flap 3 times to get a feel for lift.',
      requiredFlaps: 3,
    },
    params: { ...recipe(0), speed: 0, speedRamp: 0, gateCount: 0, gapHalf: 99, minGapHalf: 99, spacing: 999, moveLimit: 0, timeLimitTicks: 0 },
    goal: { type: 'flaps', value: 3 },
    parTicks: 0,
  },
  {
    id: 'learn-2', version: CONTENT_VERSION, seed: hashString('learn-2'),
    name: 'Hold the Line', mode: 'learn', theme: 'dawn', tutorial: true,
    lesson: {
      step: 'hover',
      prompt: 'Flap gently to stay between the ribbons. Don\'t touch the sky or the sea!',
      goalText: 'Stay airborne for 6 seconds.',
      surviveTicks: 6 * TICKS_PER_SECOND,
    },
    params: { ...recipe(0), speed: 0, speedRamp: 0, gateCount: 0, gapHalf: 99, minGapHalf: 99, spacing: 999, moveLimit: 0, timeLimitTicks: 0 },
    goal: { type: 'survive', value: 6 * TICKS_PER_SECOND },
    parTicks: 0,
  },
  {
    id: 'learn-3', version: CONTENT_VERSION, seed: hashString('learn-3'),
    name: 'Thread the Gate', mode: 'learn', theme: 'day', tutorial: true,
    lesson: {
      step: 'gate',
      prompt: 'Gates drift toward you. Pass through the glowing gap — avoid the edges.',
      goalText: 'Pass 3 gates.',
    },
    params: { ...recipe(0), speed: 3.4, gapHalf: 3.2, minGapHalf: 3.2, gateCount: 3, spacing: 9, oscAmp: 0, oscFreq: 0, moveLimit: 0, timeLimitTicks: 0 },
    goal: { type: 'gates', value: 3 },
    parTicks: 0,
  },
  {
    id: 'learn-4', version: CONTENT_VERSION, seed: hashString('learn-4'),
    name: 'True Center', mode: 'learn', theme: 'day', tutorial: true,
    lesson: {
      step: 'center',
      prompt: 'Passing near the center of a gap earns bonus points and builds a streak.',
      goalText: 'Pass 4 gates — aim for the middle!',
    },
    params: { ...recipe(0), speed: 3.8, gapHalf: 2.9, minGapHalf: 2.9, gateCount: 4, spacing: 8.5, oscAmp: 0, oscFreq: 0, moveLimit: 0, timeLimitTicks: 0 },
    goal: { type: 'gates', value: 4 },
    parTicks: 0,
  },
  {
    id: 'learn-5', version: CONTENT_VERSION, seed: hashString('learn-5'),
    name: 'Restless Gates', mode: 'learn', theme: 'dusk', tutorial: true,
    lesson: {
      step: 'moving',
      prompt: 'Some gates breathe up and down. Watch the rhythm, then commit.',
      goalText: 'Pass 4 moving gates.',
    },
    params: { ...recipe(0), speed: 4.0, gapHalf: 3.0, minGapHalf: 3.0, gateCount: 4, spacing: 9, oscAmp: 1.6, oscFreq: 0.014, moveLimit: 0, timeLimitTicks: 0 },
    goal: { type: 'gates', value: 4 },
    parTicks: 0,
  },
];

/* ------------------------------------------------------------------ */
/* Challenges                                                          */
/* ------------------------------------------------------------------ */

export const CHALLENGES = [
  {
    id: 'challenge-frugal', version: CONTENT_VERSION, seed: hashString('challenge-frugal-1'),
    name: 'Frugal Wings', mode: 'challenge', theme: 'dusk',
    blurb: 'Only 18 flaps to clear 8 gates. Every press counts.',
    params: { ...recipe(0.35), gateCount: 8, spacing: 8, moveLimit: 18, timeLimitTicks: 0 },
    goal: { type: 'gates', value: 8 },
    parTicks: 0,
  },
  {
    id: 'challenge-tailwind', version: CONTENT_VERSION, seed: hashString('challenge-tailwind-1'),
    name: 'Tailwind Sprint', mode: 'challenge', theme: 'day',
    blurb: 'High wind, 12 gates, beat the clock for the time bonus.',
    params: { ...recipe(0.7), speed: 7.2, gateCount: 12, moveLimit: 0, timeLimitTicks: 0 },
    goal: { type: 'gates', value: 12 },
    parTicks: Math.round(((6.4 * 14) / 7.2) * TICKS_PER_SECOND),
  },
  {
    id: 'challenge-needle', version: CONTENT_VERSION, seed: hashString('challenge-needle-1'),
    name: 'Needle Threader', mode: 'challenge', theme: 'night',
    blurb: 'Tight gaps, 10 gates. Precision over speed.',
    params: { ...recipe(0.85), speed: 4.6, gapHalf: 2.0, minGapHalf: 1.8, gateCount: 10, spacing: 7.4, oscAmp: 1.0, oscFreq: 0.012, moveLimit: 0, timeLimitTicks: 0 },
    goal: { type: 'gates', value: 10 },
    parTicks: 0,
  },
  {
    id: 'challenge-marathon', version: CONTENT_VERSION, seed: hashString('challenge-marathon-1'),
    name: 'Sky Marathon', mode: 'challenge', theme: 'aurora',
    blurb: 'Survive 60 seconds of restless gates.',
    params: { ...recipe(0.6), gateCount: 0, moveLimit: 0, timeLimitTicks: 60 * TICKS_PER_SECOND, oscAmp: 1.8, oscFreq: 0.013 },
    goal: { type: 'survive', value: 60 * TICKS_PER_SECOND },
    parTicks: 60 * TICKS_PER_SECOND,
  },
  {
    id: 'challenge-streak', version: CONTENT_VERSION, seed: hashString('challenge-streak-1'),
    name: 'Perfect Line', mode: 'challenge', theme: 'dawn',
    blurb: 'Score 5 centered passes in a single run of 8 gates.',
    params: { ...recipe(0.4), gateCount: 8, spacing: 8, moveLimit: 0, timeLimitTicks: 0 },
    goal: { type: 'gates', value: 8 },
    goalExtra: { centeredPasses: 5 },
    parTicks: 0,
  },
];

/* ------------------------------------------------------------------ */
/* Daily — one shared seed and ruleset per UTC day                     */
/* ------------------------------------------------------------------ */

/** Deterministic daily content for a UTC date (Date or 'YYYY-MM-DD'). */
export function dailyContent(dateInput) {
  let key;
  if (dateInput instanceof Date) {
    key = dateInput.toISOString().slice(0, 10);
  } else {
    key = String(dateInput).slice(0, 10);
  }
  const seed = hashString(`daily-v${CONTENT_VERSION}-${key}`);
  // Day-of-year modulates difficulty within a fair band.
  const dayNum = Math.floor(Date.parse(`${key}T00:00:00Z`) / 86400000);
  const tier = 0.35 + ((dayNum * 7919) % 100) / 100 * 0.4; // 0.35..0.75, fixed per day
  const theme = THEME_IDS[dayNum % THEME_IDS.length];
  return {
    id: `daily-${key}`,
    version: CONTENT_VERSION,
    seed,
    name: `Daily Breeze — ${key}`,
    mode: 'daily',
    theme,
    ranked: true,
    dateKey: key,
    params: { ...recipe(tier), gateCount: 0, moveLimit: 0, timeLimitTicks: 90 * TICKS_PER_SECOND },
    goal: { type: 'survive', value: 90 * TICKS_PER_SECOND },
    parTicks: 90 * TICKS_PER_SECOND,
  };
}

/* ------------------------------------------------------------------ */
/* Practice presets                                                    */
/* ------------------------------------------------------------------ */

export const PRACTICE_PRESETS = [
  {
    id: 'practice-calm', version: CONTENT_VERSION, seed: hashString('practice-calm'),
    name: 'Calm Skies', mode: 'practice', theme: 'day', difficulty: 'gentle',
    params: { ...recipe(0.1), gateCount: 0, moveLimit: 0, timeLimitTicks: 0 },
    goal: { type: 'endless', value: 0 }, parTicks: 0,
  },
  {
    id: 'practice-breezy', version: CONTENT_VERSION, seed: hashString('practice-breezy'),
    name: 'Breezy', mode: 'practice', theme: 'dusk', difficulty: 'moderate',
    params: { ...recipe(0.5), gateCount: 0, moveLimit: 0, timeLimitTicks: 0 },
    goal: { type: 'endless', value: 0 }, parTicks: 0,
  },
  {
    id: 'practice-tempest', version: CONTENT_VERSION, seed: hashString('practice-tempest'),
    name: 'Tempest', mode: 'practice', theme: 'night', difficulty: 'hard',
    params: { ...recipe(0.9), gateCount: 0, moveLimit: 0, timeLimitTicks: 0 },
    goal: { type: 'endless', value: 0 }, parTicks: 0,
  },
];

/* ------------------------------------------------------------------ */
/* Score chase (endless, fixed competitive ruleset)                    */
/* ------------------------------------------------------------------ */

export function scoreChaseContent(seed) {
  const s = (typeof seed === 'number' ? seed : hashString(String(seed ?? 'chase'))) >>> 0;
  return {
    id: `chase-${s.toString(16)}`,
    version: CONTENT_VERSION,
    seed: s,
    name: 'Score Chase',
    mode: 'chase',
    theme: 'day',
    ranked: true,
    params: { ...recipe(0.55), gateCount: 0, moveLimit: 0, timeLimitTicks: 0 },
    goal: { type: 'endless', value: 0 },
    parTicks: 0,
  };
}

/* ------------------------------------------------------------------ */
/* Achievements — stable lowercase keys, idempotent unlocks            */
/* ------------------------------------------------------------------ */

export const ACHIEVEMENTS = [
  { key: 'first_clear', name: 'First Clearing', desc: 'Complete any stage for the first time.' },
  { key: 'mechanic_mastery', name: 'Gate Whisperer', desc: 'Finish all five lessons.' },
  { key: 'streak_5', name: 'On the Beam', desc: 'Hold a centered-pass streak of 5.' },
  { key: 'journey_half', name: 'Half the Horizon', desc: 'Clear 20 Journey stages.' },
  { key: 'journey_master', name: 'Beyond the Vale', desc: 'Clear all 40 Journey stages.' },
  { key: 'long_term', name: 'Seasoned Glider', desc: 'Play on 7 different days (any mode, no streak required).' },
  { key: 'daily_first', name: 'Daily Breadth', desc: 'Finish a Daily Breeze.' },
  { key: 'centurion', name: 'Centurion', desc: 'Pass 100 gates in one run.' },
];

/* ------------------------------------------------------------------ */
/* Offline validators                                                  */
/* ------------------------------------------------------------------ */

/**
 * Validate content: legality of schema, reachable goal, bounded duration,
 * absence of obvious soft locks. Returns { ok, errors: [] }.
 */
export function validateContent(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== 'object') return { ok: false, errors: ['not-an-object'] };
  if (!cfg.id) errors.push('missing-id');
  if (typeof cfg.seed !== 'number') errors.push('missing-seed');
  const p = cfg.params || {};
  const req = ['gravity', 'lift', 'speed', 'gapHalf', 'spacing'];
  for (const k of req) {
    if (typeof p[k] !== 'number' || !Number.isFinite(p[k])) errors.push(`bad-param:${k}`);
  }
  if (p.gapHalf != null && p.gapHalf < 1.2 && p.gapHalf < 90) errors.push('gap-too-tight');
  if (p.minGapHalf != null && p.minGapHalf < 1.2 && p.minGapHalf < 90) errors.push('min-gap-too-tight');
  if (p.gateCount < 0) errors.push('negative-gate-count');
  if (p.moveLimit > 0 && cfg.goal && cfg.goal.type === 'gates') {
    // Soft-lock check: total aloft time from the move budget must cover the
    // time needed to travel to the final gate.
    const aloftPerFlap = flapAloftEstimate(p);
    const travelTicks = ((p.spacing * (cfg.goal.value + 1)) / Math.max(0.1, p.speed));
    if (p.moveLimit * aloftPerFlap * 0.85 < travelTicks) errors.push('move-limit-softlock');
  }
  // Bounded duration: finite modes must terminate.
  const finite = (p.gateCount > 0) || (p.timeLimitTicks > 0) ||
    (cfg.goal && ['gates', 'score', 'survive', 'flaps'].includes(cfg.goal.type) && cfg.goal.value > 0);
  if (!finite && cfg.mode !== 'practice' && cfg.mode !== 'chase') errors.push('unbounded-duration');
  // Reachability heuristic: gap oscillation must not exceed vertical space.
  const halfRange = (p.gapRange || 0) / 2 + (p.oscAmp || 0);
  if (halfRange > 8.5) errors.push('gap-out-of-bounds');
  return { ok: errors.length === 0, errors };
}

/** Approximate useful aloft time per flap: rise to apex, then fall to the
 *  bottom edge of the gate gap before another flap is needed. */
function flapAloftEstimate(p) {
  const g = Math.max(1, p.gravity);
  const riseT = p.lift / g;
  const riseH = (p.lift * p.lift) / (2 * g);
  const fallH = riseH + Math.max(0.5, p.gapHalf || 2);
  return riseT + Math.sqrt((2 * fallH) / g);
}

/** Validate all shipped content. Used by tests and at boot in dev. */
export function validateAll() {
  const report = [];
  const all = [
    ...LESSONS, ...JOURNEY, ...CHALLENGES, ...PRACTICE_PRESETS,
    scoreChaseContent('validation'), dailyContent('2026-01-01'),
  ];
  for (const cfg of all) {
    const r = validateContent(cfg);
    report.push({ id: cfg.id, ok: r.ok, errors: r.errors });
  }
  return report;
}
