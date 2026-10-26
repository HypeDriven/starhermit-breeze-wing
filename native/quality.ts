// The look per graphics level: the browser build's four presets and budgets
// (js/gfx.js TABLE / BUDGETS / SCENERY / PARTICLES, each tuned to hold 60 FPS
// on the weakest GPU its Auto gave it) keyed by the runtime's quality tier
// (frame().quality), with the island, cloud, particle and mote counts scaled
// within the tier by the level (frame().levelIndex), as the browser build
// scaled them by its hardware level (at most 4×, never below the tier's
// floor). The runtime owns the rest of what the old Graphics panel did: Auto
// and the level choice, render scale and the pixel-ratio cap, adaptive
// resolution, the frame-rate limit and readout, and the shadow-map size and
// MSAA samples it holds to the level. The per-category overrides of the old
// panel are not offered (the runtime's Options choose a level).
import type { QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export type Preset = QualityTier;
export interface Budget {
  /** "lambert" (Lambert islands, clouds, gates and bird) or "standard" (PBR; physical clearcoat where detailed). */
  material: "lambert" | "standard";
  /** Cloud puff smoothness when detailed (the browser build's icosahedron subdivision 1–3). */
  cloudDetail: number;
  islands: number;
  clouds: number;
  /** Extra grass tufts per island. */
  tufts: number;
  /** Burst particle pool. */
  pool: number;
  /** Ambient motes (pollen by day, fireflies by night). */
  motes: number;
}
export interface Look {
  preset: Preset;
  shadows: 0 | 1024 | 2048 | 4096;
  bloom: boolean;
  grade: boolean;
  antialias: AntialiasMode;
  reflections: boolean;
  /** Sky: halo, cirrus, stars, aurora, sea glints. */
  skyDetailed: boolean;
  /** Surface detail: glazed tiled pillars, clearcoat beak, eye glints, island strata, smooth clouds. */
  detailed: boolean;
  particles: "low" | "high";
  budget: Budget;
}

const TABLE: Record<Preset, Omit<Look, "preset" | "budget"> & { scenery: "sparse" | "normal" | "rich" }> = {
  low: { shadows: 0, bloom: false, grade: false, antialias: "off", reflections: false, skyDetailed: false, scenery: "sparse", detailed: false, particles: "low" },
  balanced: { shadows: 1024, bloom: true, grade: true, antialias: "fxaa", reflections: true, skyDetailed: true, scenery: "normal", detailed: true, particles: "low" },
  high: { shadows: 2048, bloom: true, grade: true, antialias: "smaa", reflections: true, skyDetailed: true, scenery: "rich", detailed: true, particles: "high" },
  ultra: { shadows: 4096, bloom: true, grade: true, antialias: "msaa", reflections: true, skyDetailed: true, scenery: "rich", detailed: true, particles: "high" },
};
const SCENERY = { sparse: { islands: 6, clouds: 6 }, normal: { islands: 10, clouds: 10 }, rich: { islands: 14, clouds: 16 } };
const PARTICLES = { low: { pool: 120, motes: 0 }, high: { pool: 900, motes: 45 } };
const BUDGETS: Record<Preset, { material: "lambert" | "standard"; cloudDetail: number; scenery: number; tufts: number; particles: number; motes: number }> = {
  low: { material: "lambert", cloudDetail: 1, scenery: 1, tufts: 0, particles: 1, motes: 0 },
  balanced: { material: "standard", cloudDetail: 2, scenery: 1, tufts: 0, particles: 1, motes: 20 },
  high: { material: "standard", cloudDetail: 3, scenery: 1.25, tufts: 1, particles: 1, motes: 45 },
  ultra: { material: "standard", cloudDetail: 3, scenery: 1.6, tufts: 2, particles: 1.5, motes: 80 },
};
export const POOL_MAX = 4000;
export const MOTE_MAX = 240;
/** The first level index of each tier (quantum … galactic). */
const TIER_FLOOR: Record<Preset, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };

/** The look for a quality tier at a level index (0 quantum … 9 infinite). */
export function lookFor(preset: Preset, levelIndex: number): Look {
  const t = TABLE[preset];
  const b = BUDGETS[preset];
  // Levels are about 1.64× apart in GPU throughput: counts grow with the
  // level above the tier's first, at most 4× the tier's budget.
  const k = Math.min(4, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  const sc = SCENERY[t.scenery];
  const pt = PARTICLES[t.particles];
  const budget: Budget = {
    material: b.material,
    cloudDetail: b.cloudDetail,
    tufts: b.tufts,
    islands: Math.min(40, Math.round(sc.islands * b.scenery * k)),
    clouds: Math.min(48, Math.round(sc.clouds * b.scenery * k)),
    pool: Math.min(POOL_MAX, Math.round(pt.pool * b.particles * k)),
    motes: pt.motes > 0 ? Math.min(MOTE_MAX, Math.round(b.motes * k)) : 0,
  };
  const { scenery: _s, ...rest } = t;
  void _s;
  return { preset, ...rest, budget };
}
