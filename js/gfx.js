/**
 * Breeze Wing — graphics quality model.
 * Presets, per-category overrides, GPU detection and a cost summary.
 * Pure (no three.js import) so the settings panel, the renderer and the unit
 * tests agree on what a setting means. Graphics never change rules or hazard
 * visibility.
 */

export const PRESETS = ['low', 'balanced', 'high', 'ultra'];

/** Category → allowed tiers, cheapest first. */
export const CATEGORIES = {
  shadows: ['off', 'low', 'medium', 'high'],
  bloom: ['off', 'on'],
  grade: ['off', 'on'],
  antialias: ['off', 'fxaa', 'smaa', 'msaa'],
  reflections: ['off', 'on'],
  sky: ['plain', 'detailed'],
  scenery: ['sparse', 'normal', 'rich'],
  detail: ['plain', 'detailed'],
  particles: ['low', 'high'],
};

/** Each preset: a row of tiers, a render scale and a device-pixel-ratio cap. */
const TABLE = {
  low: { scale: 0.85, dprCap: 1, shadows: 'off', bloom: 'off', grade: 'off', antialias: 'off', reflections: 'off', sky: 'plain', scenery: 'sparse', detail: 'plain', particles: 'low' },
  balanced: { scale: 1, dprCap: 1.75, shadows: 'low', bloom: 'on', grade: 'on', antialias: 'fxaa', reflections: 'on', sky: 'detailed', scenery: 'normal', detail: 'detailed', particles: 'low' },
  high: { scale: 1, dprCap: 2, shadows: 'medium', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', sky: 'detailed', scenery: 'rich', detail: 'detailed', particles: 'high' },
  ultra: { scale: 1.25, dprCap: 2, shadows: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', sky: 'detailed', scenery: 'rich', detail: 'detailed', particles: 'high' },
};

export const SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };
/** Decoration counts per scenery tier (cosmetic only). */
export const SCENERY = {
  sparse: { islands: 6, clouds: 6 },
  normal: { islands: 10, clouds: 10 },
  rich: { islands: 14, clouds: 16 },
};
/** Particle pool budget per tier; `motes` = ambient drifting motes. */
export const PARTICLES = { low: { pool: 120, motes: 0 }, high: { pool: 900, motes: 45 } };

/**
 * Per-preset asset and effect budget. Each preset is tuned to hold 60 FPS on the weakest GPU Auto gives
 * it (Low → hardware level 0, Balanced → 4, High → 10, Ultra → 17; measured with tests/gfx-bench.mjs).
 *   material     'lambert' (per-vertex-cheap Lambert on islands, clouds, gates, bird) | 'standard' (PBR;
 *                Physical sheen/clearcoat where Surface detail is detailed);
 *   cloudDetail  icosahedron subdivision of cloud puffs when Surface detail is detailed (plain = 1);
 *   scenery      multiplier on the Scenery tier's island and cloud counts; tufts = extra grass tufts per island;
 *   particles    multiplier on the Particles tier's pool; motes = ambient motes (Particles: high only).
 * Counts are tuned at the preset's floor level and scale up within the preset on faster GPUs
 * (StarHermitGpu.scaleBudget, ≤ 4×, never below the floor budget).
 */
export const BUDGETS = {
  low: { material: 'lambert', cloudDetail: 1, scenery: 1, tufts: 0, particles: 1, motes: 0 },
  balanced: { material: 'standard', cloudDetail: 2, scenery: 1, tufts: 0, particles: 1, motes: 20 },
  high: { material: 'standard', cloudDetail: 3, scenery: 1.25, tufts: 1, particles: 1, motes: 45 },
  ultra: { material: 'standard', cloudDetail: 3, scenery: 1.6, tufts: 2, particles: 1.5, motes: 80 },
};

/** A preset's concrete budget for a hardware level (counts scaled with scaleCount). */
export function budgetFor(preset, level, scenery = 'normal', particles = 'low') {
  const b = { ...(BUDGETS[preset] || BUDGETS.balanced) };
  const sc = SCENERY[scenery] || SCENERY.normal;
  const pt = PARTICLES[particles] || PARTICLES.low;
  b.islands = Math.min(40, scaleCount(sc.islands * b.scenery, preset, level));
  b.clouds = Math.min(48, scaleCount(sc.clouds * b.scenery, preset, level));
  b.pool = Math.min(4000, scaleCount(pt.pool * b.particles, preset, level));
  b.motes = pt.motes > 0 ? Math.min(240, scaleCount(b.motes, preset, level)) : 0;
  return b;
}

export const STORAGE_KEY = 'breezewing.graphics.v1';

// Auto picks the preset from the StarHermit hardware level (0 = Galaxy S20 / Intel UHD, 20 = RTX 5090;
// gpu-level.js → window.StarHermitGpu): Low from 0, Balanced from 4, High from 10, Ultra from 17.
// Phones, tablets and ≤ 4 GB machines are capped at level 9 (Balanced); software renderers are level 0.
export const PRESET_LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };

function gpuApi() { return globalThis.StarHermitGpu; }

/** Hardware level (0–20) for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
export function detectLevel(gpu, system) {
  const G = gpuApi();
  if (!G) return PRESET_LEVELS.balanced;
  return G.detectLevel({ ...(system || {}), gpu: String(gpu || '') });
}

/** The preset Auto starts from for a hardware level. */
export function presetForLevel(level) {
  const G = gpuApi();
  if (G) return G.presetForLevel(level, PRESET_LEVELS);
  return level >= 17 ? 'ultra' : level >= 10 ? 'high' : level >= 4 ? 'balanced' : 'low';
}

/** Best preset for this GPU (the level already caps phones/tablets at Balanced). */
export function detectPreset(gpu, system) {
  return presetForLevel(detectLevel(gpu, system));
}

/** Scale a count tuned at the preset's floor level up for faster GPUs (≤ 4×, never below the floor budget). */
export function scaleCount(n, preset, level) {
  const G = gpuApi();
  const floor = PRESET_LEVELS[preset] || 0;
  return Math.round(G ? G.scaleBudget(n, Math.max(Number(level) || 0, floor), floor) : n);
}

/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
 */
export function resolve(saved, detected, level) {
  const s = saved || {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const renderScale = clamp(Number(s.render_scale) || 1, 0.5, 2);
  const out = { preset, auto, renderScale, scale: row.scale * renderScale, dprCap: row.dprCap };
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
  }
  out.budget = budgetFor(preset, level, out.scenery, out.particles);
  out.adaptive = s.adaptive !== false;
  out.showFps = !!s.show_fps;
  // Post-processing runs only when something needs it; otherwise the scene
  // renders straight to the canvas (Low costs no extra passes).
  out.post = out.bloom === 'on' || out.grade === 'on' || out.antialias === 'fxaa' || out.antialias === 'smaa';
  return out;
}

/** The preset's own tier for a category (for "From preset (…)" labels). */
export function presetTier(preset, cat) {
  return TABLE[preset]?.[cat];
}

/** Apply a preset choice: choosing a preset clears every per-category override. */
export function choosePreset(saved, preset) {
  const out = { ...(saved || {}) };
  for (const cat of Object.keys(CATEGORIES)) delete out[cat];
  out.preset = PRESETS.includes(preset) ? preset : 'auto';
  return out;
}

const EN = {
  noShadows: 'no shadows', shadows: '{n}² shadows', bloom: 'bloom', grade: 'colour grade',
  reflections: 'reflections', noAA: 'no anti-aliasing', px: '{w}×{h} px',
};

/** Human cost summary, e.g. "2048² shadows · bloom · SMAA · 1280×800 px". */
export function describe(r, pixels, labels = EN) {
  const L = { ...EN, ...labels };
  const parts = [
    r.shadows === 'off' ? L.noShadows : L.shadows.replace('{n}', SHADOW_MAP[r.shadows]),
    r.bloom === 'on' ? L.bloom : null,
    r.grade === 'on' ? L.grade : null,
    r.reflections === 'on' ? L.reflections : null,
    r.antialias === 'off' ? L.noAA : r.antialias.toUpperCase(),
    pixels ? L.px.replace('{w}', pixels[0]).replace('{h}', pixels[1]) : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

/** Read / write the per-device settings (graphics depend on this device's GPU). */
export function loadGraphics(storage) {
  try {
    const v = JSON.parse(storage.getItem(STORAGE_KEY) || 'null');
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}
export function saveGraphics(storage, saved) {
  try { storage.setItem(STORAGE_KEY, JSON.stringify(saved)); } catch { /* storage unavailable */ }
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}
