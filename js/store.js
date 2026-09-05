/**
 * Breeze Wing — local persistence: versioned, checksummed save document.
 * Settings (accessibility/audio/graphics/controls) and progression live in
 * one document; migrations are explicit and tested. No credentials or
 * private data are ever stored here.
 */

import { hashString } from './rules.js';

export const SAVE_VERSION = 1;
const KEY = 'breezewing.save.v1';

export function defaultSave() {
  return {
    version: SAVE_VERSION,
    checksum: '',
    settings: {
      volumes: { music: 0.6, effects: 0.8, ambience: 0.5, voice: 0.7 },
      muted: false,
      graphicsTier: 'medium',          // low | medium | high
      reducedMotion: false,
      highContrast: false,
      colorPalette: 'default',         // default | deuteranopia | protanopia | tritanopia
      largeText: false,
      leftHanded: false,
      assistArc: true,                 // timing assistance: predicted-arc preview
      haptics: true,
      telemetryConsent: false,
    },
    progress: {
      tutorialDone: false,
      lessons: {},                     // lessonId -> true
      journey: {},                     // stageId -> { cleared, bestScore, bestTicks }
      achievements: {},                // key -> isoTimestamp
      daysPlayed: [],                  // UTC date keys (for long-term goal)
      best: {},                        // modeOrId -> score int
      localBoard: [],                  // [{name, score, date, contentId, seed}] capped
      totalGates: 0,
      totalRuns: 0,
    },
  };
}

function checksumOf(doc) {
  const copy = JSON.parse(JSON.stringify(doc));
  delete copy.checksum;
  return hashString(JSON.stringify(copy)).toString(16).padStart(8, '0');
}

/** Migrate older documents forward, one version at a time. */
export function migrate(doc) {
  if (!doc || typeof doc !== 'object') return defaultSave();
  const base = defaultSave();
  // Always start from defaults and layer the persisted fields on top, so a
  // version-valid document that is nonetheless missing a progress/settings
  // sub-object degrades to a full default document instead of throwing later
  // (as `loadSave` already does for localStorage).
  const d = { ...base, ...doc };
  d.settings = { ...base.settings, ...(doc.settings || {}) };
  d.settings.volumes = { ...base.settings.volumes, ...((doc.settings && doc.settings.volumes) || {}) };
  d.progress = { ...base.progress, ...(doc.progress || {}) };
  for (const k of ['lessons', 'journey', 'achievements', 'daysPlayed', 'best', 'localBoard']) {
    if (!d.progress[k]) d.progress[k] = base.progress[k];
  }
  d.version = SAVE_VERSION;
  return d;
}

export function loadSave(storage) {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return { doc: defaultSave(), status: 'fresh' };
    const parsed = JSON.parse(raw);
    const doc = migrate(parsed);
    if (doc.checksum && doc.checksum !== checksumOf(doc)) {
      // Corrupted: preserve the evidence, start clean.
      try { storage.setItem(`${KEY}.corrupt.${Date.now()}`, raw); } catch { /* ignore */ }
      return { doc: defaultSave(), status: 'corrupt-reset' };
    }
    return { doc, status: 'loaded' };
  } catch {
    return { doc: defaultSave(), status: 'unreadable' };
  }
}

export function writeSave(storage, doc) {
  doc.checksum = checksumOf(doc);
  try {
    storage.setItem(KEY, JSON.stringify(doc));
    return true;
  } catch {
    return false; // quota/private mode: session still playable
  }
}

/** Compare two save docs for cloud-conflict resolution. */
export function isDescendant(candidate, base) {
  // A doc is a strict descendant if it has >= progress on every tracked field.
  const p = (candidate && candidate.progress) || {};
  const q = (base && base.progress) || {};
  if (!p || !q) return false;
  const keys = (o) => Object.keys(o || {});
  const superset = (a, b) => keys(b).every((k) => k in (a || {}));
  const journeyOk = keys(q.journey).every((k) => {
    const a = (p.journey || {})[k], b = (q.journey || {})[k];
    return a && (a.bestScore || 0) >= (b.bestScore || 0);
  });
  return superset(p.lessons, q.lessons) && superset(p.achievements, q.achievements) && journeyOk &&
    (p.totalRuns || 0) >= (q.totalRuns || 0);
}

/** Merge two docs (union), used after player picks or to auto-resolve. */
export function mergeSaves(a, b) {
  const out = migrate(JSON.parse(JSON.stringify(a || {})));
  const src = migrate(JSON.parse(JSON.stringify(b || {})));
  for (const k of Object.keys(src.progress.lessons || {})) out.progress.lessons[k] = true;
  for (const [k, v] of Object.entries(src.progress.journey || {})) {
    const cur = out.progress.journey[k];
    if (!cur || (v.bestScore || 0) > (cur.bestScore || 0)) out.progress.journey[k] = v;
  }
  Object.assign(out.progress.achievements, src.progress.achievements || {});
  out.progress.daysPlayed = [...new Set([...(out.progress.daysPlayed || []), ...(src.progress.daysPlayed || [])])];
  for (const [k, v] of Object.entries(src.progress.best || {})) {
    if ((out.progress.best[k] || 0) < v) out.progress.best[k] = v;
  }
  out.progress.totalGates = Math.max(out.progress.totalGates || 0, src.progress.totalGates || 0);
  out.progress.totalRuns = Math.max(out.progress.totalRuns || 0, src.progress.totalRuns || 0);
  out.progress.localBoard = [...(out.progress.localBoard || []), ...(src.progress.localBoard || [])]
    .sort((x, y) => y.score - x.score).slice(0, 50);
  return out;
}
