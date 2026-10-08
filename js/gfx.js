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

export const STORAGE_KEY = 'breezewing.graphics.v1';

/**
 * Best preset for this GPU from the unmasked renderer string.
 * Software renderers → low; discrete GPUs / Apple M → high; else balanced.
 * `mobile` (touch-first device) caps the result at balanced.
 */
export function detectPreset(gpu, mobile = false) {
  const g = String(gpu || '').toLowerCase();
  let p = 'balanced';
  if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(g)) p = 'low';
  else if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|amd radeon(?!.*graphics)|apple m\d/.test(g)) p = 'high';
  if (mobile && PRESETS.indexOf(p) > PRESETS.indexOf('balanced')) p = 'balanced';
  return p;
}

/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
 */
export function resolve(saved, detected) {
  const s = saved || {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const renderScale = clamp(Number(s.render_scale) || 1, 0.5, 2);
  const out = { preset, auto, renderScale, scale: row.scale * renderScale, dprCap: row.dprCap };
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
  }
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
