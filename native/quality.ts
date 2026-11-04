// The look per graphics level. The engine-owned effects (shadows and their
// map size, bloom, the grade, anti-aliasing) are the level's own
// (levelSettings(): the same table every StarHermit game reads). The game's
// art (materials, sky and surface detail, reflections, scenery) is the
// browser build's four presets (js/gfx.js TABLE / BUDGETS / SCENERY /
// PARTICLES) keyed by the level's quality tier, with the island, cloud,
// particle and mote counts scaled within the tier by the level's particle
// budget against the tier's anchor level (quantum, molecular, terrestrial,
// galactic), at most 4×. The runtime owns what the old Graphics panel did
// besides: Auto and the level choice, render scale and the pixel-ratio cap,
// adaptive resolution and the frame-rate limit and readout. The
// per-category overrides of the old panel are not offered (the runtime's
// Options choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
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
  /** The level's key-light shadow map size, 0 when the level draws no shadows. */
  shadows: number;
  /** The level's bloom resolution as a fraction of the frame (null: off). */
  bloom: number | null;
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

type Art = Pick<Look, "reflections" | "skyDetailed" | "detailed" | "particles"> & { scenery: "sparse" | "normal" | "rich" };
const TABLE: Record<Preset, Art> = {
  low: { reflections: false, skyDetailed: false, scenery: "sparse", detailed: false, particles: "low" },
  balanced: { reflections: true, skyDetailed: true, scenery: "normal", detailed: true, particles: "low" },
  high: { reflections: true, skyDetailed: true, scenery: "rich", detailed: true, particles: "high" },
  ultra: { reflections: true, skyDetailed: true, scenery: "rich", detailed: true, particles: "high" },
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
/** Each tier's reference level: its budgets are tuned there. */
const ANCHOR: Record<Preset, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };

/** The look for a graphics level (the frame's by default). */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const t = TABLE[preset];
  const b = BUDGETS[preset];
  // Counts grow with the level's particle budget above the tier's anchor,
  // at most 4× the tier's budget.
  const k = Math.min(4, s.particles / levelSettings(ANCHOR[preset]).particles);
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
  return {
    preset, ...rest, budget,
    shadows: s.shadows ? s.shadowMapSize : 0,
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
  };
}
