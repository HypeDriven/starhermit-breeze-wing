/**
 * Breeze Wing — the engine client's save document and what the browser build
 * (starhermit-sdk.js) left in the player's account (pure: no storage).
 *  - The engine save (starhermit:storage `saves`) is { v: 1, progress }: the
 *    browser build's save-document progress unchanged (js/store.js), merged
 *    across devices by mergeSaves (every lesson, achievement and played day
 *    from both sides, a Journey stage cleared on either device stays cleared
 *    with the higher best score and the faster best time, the higher best per
 *    mode, the larger totals, both local boards).
 *  - The browser build's cloud save (slot game:<slug>) holds the SDK's zipped
 *    save.json: the whole browser document { version, checksum, settings,
 *    progress }. The engine shows it as a foreign save; docFromBrowserSave
 *    reads its progress, which is merged with this device's and replaces the
 *    slot once.
 *  - The per-player settings keys (the SDK's PATCH of the document's
 *    settings): the game's own options (colour palette, left-handed HUD,
 *    predicted arc, haptics) carry over as game settings; volumes, mute,
 *    graphics, reduced motion, high contrast, larger text, telemetry consent
 *    and the language are the runtime's Options now and are dropped.
 */

import { defaultSave, migrate, mergeSaves } from './store.js';

const bool = (v) => typeof v === 'boolean';
export const PALETTES = ['default', 'deuteranopia', 'protanopia', 'tritanopia'];

/** Settings the game still owns (game.<key> in the runtime's settings), with their checks. */
const GAME_SETTINGS = {
  colorPalette: (v) => PALETTES.includes(v),
  leftHanded: bool,
  assistArc: bool,
  haptics: bool,
};
export const GAME_SETTING_KEYS = Object.keys(GAME_SETTINGS);
export const DEFAULT_SETTINGS = { colorPalette: 'default', leftHanded: false, assistArc: true, haptics: true };
/** Every key the browser build kept in the account's per-player settings. */
export const BROWSER_SETTING_KEYS = [...Object.keys(defaultSave().settings), 'ui.language'];

const isObj = (v) => !!(v && typeof v === 'object' && !Array.isArray(v));

/** A complete progress object (defaults under what is there). */
export function normalizeProgress(progress) {
  return migrate({ progress: isObj(progress) ? JSON.parse(JSON.stringify(progress)) : {} }).progress;
}

/** The progress in an engine save ({ v: 1, progress }), or null. */
export function progressFromSave(data) {
  if (!isObj(data) || data.v !== 1 || !isObj(data.progress)) return null;
  return normalizeProgress(data.progress);
}

/** The progress in the browser build's cloud save text (its whole save document), or null. */
export function progressFromBrowserSave(text) {
  if (typeof text !== 'string') return null;
  try {
    const doc = JSON.parse(text);
    return isObj(doc) && isObj(doc.progress) ? normalizeProgress(doc.progress) : null;
  } catch { return null; }
}

/** The engine save document for a progress object. */
export function saveDoc(progress) { return { v: 1, progress }; }

/** Two progress objects merged (either may be null), keeping the better value of every field. */
export function mergeProgress(remote, local) {
  if (!remote && !local) return normalizeProgress({});
  if (!remote) return normalizeProgress(local);
  if (!local) return normalizeProgress(remote);
  const out = mergeSaves({ progress: local }, { progress: remote }).progress;
  // mergeSaves concatenates both local boards; the same run kept on both sides counts once.
  const seen = new Set();
  out.localBoard = out.localBoard.filter((e) => {
    const k = JSON.stringify([e.name, e.score, e.date, e.contentId, e.seed]);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return out;
}

/** A browser-build setting's value as the engine client keeps it, or undefined (dropped). */
export function migrateSetting(key, value) {
  const check = GAME_SETTINGS[key];
  return check && check(value) ? value : undefined;
}
