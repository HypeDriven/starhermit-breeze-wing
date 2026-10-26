// The game's data and the StarHermit platform, on the runtime's modules:
// - progress (lessons, Journey stages, best scores, achievements, played
//   days, the device board of ranked runs, lifetime totals) is the game's
//   save (starhermit:storage `saves`): { v: 1, progress }, the browser
//   build's save-document progress unchanged, on the device and in the
//   player's cloud slot, two devices' copies merged on a conflict
//   (js/migrate.js mergeProgress → js/store.js mergeSaves). The slot the
//   browser build wrote (the JS SDK's zipped save.json, its whole save
//   document) shows as foreign and is merged in and replaced once;
// - the paused round's safe snapshot (js/session.js) is the device's
//   starhermit:storage, through a small localStorage-shaped shim;
// - the game's own settings (colour palette, left-handed HUD, predicted arc,
//   haptics) are `settings` (game.<key>, synced with the account); the
//   browser build's settings keys are migrated and removed;
// - the player chip (name and avatar), the invite link, the Leaderboards
//   screen's rows (global and friends) and posting a ranked round's total
//   to the high-score board through score-script.js (a practice session
//   whose socket carries { type: 'result', scores }, as the JS SDK's
//   submitScores did).
import type { JsonValue } from "starhermit:engine";
import { OffscreenCanvas } from "starhermit:canvas";
import { avatar, connectGame, serverNow, serverTime, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, profile, sessions, type Leaderboard } from "starhermit:platform";
import { saves, settings as store, storage } from "starhermit:storage";
import * as M from "../js/migrate.js";

export type Progress = ReturnType<typeof M.normalizeProgress>;

// --- progress -------------------------------------------------------------------------
let progress: Progress = M.normalizeProgress({});
let lastSavedAt = 0;
const listeners = new Set<() => void>();
/** fn() after progress from the account (another device, the browser build) was merged in. */
export function onProgressMerged(fn: () => void): void { listeners.add(fn); }
function merged(): void { for (const fn of listeners) fn(); }

/** The progress object the game reads and changes (then calls saveProgress). */
export function getProgress(): Progress { return progress; }
export function saveProgress(): void {
  try { saves.save(M.saveDoc(progress) as unknown as JsonValue, { schema: 1 }); }
  catch (e) { console.warn(`save: ${String(e)}`); }
}

/** Takes progress in (merged with what this device has); whether it changed. */
function adopt(other: Progress | null): boolean {
  if (!other) return false;
  const before = JSON.stringify(progress);
  const next = M.mergeProgress(other, progress);
  if (JSON.stringify(next) === before) return false;
  // Keep the object the game holds: replace its fields.
  for (const k of Object.keys(progress)) delete (progress as Record<string, unknown>)[k];
  Object.assign(progress, next);
  return true;
}

saves.onConflict((local, remote) => ({
  merged: M.saveDoc(M.mergeProgress(M.progressFromSave(remote.data), M.progressFromSave(local?.data))) as unknown as JsonValue,
}));
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  // The account's save replaced the device's (another device saved last): merge it in.
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    if (adopt(M.progressFromSave(cur.data))) { saveProgress(); merged(); }
  }
});

/** The browser build's cloud save: merged with this device's progress, saved over it once. */
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  const changed = adopt(M.progressFromBrowserSave(old.text));
  try { saves.save(M.saveDoc(progress) as unknown as JsonValue, { schema: 1, replaceForeign: true }); }
  catch (e) { console.warn(`save migration: ${String(e)}`); }
  if (changed) merged();
}

/** For the title's profile chip: offline (a guest) | saving | synced | error. */
export function syncState(): "offline" | "saving" | "synced" | "error" {
  if (!player()) return "offline";
  const st = saves.state();
  if (st === "error" || st === "read-blocked") return "error";
  if (st === "loading" || st === "uploading" || st === "foreign" || saves.status() === "pending") return "saving";
  return "synced";
}
export function flush(): void { void saves.flush().catch(() => undefined); }

/** js/session.js's safe snapshot store (the browser build's localStorage) on the device. */
export const deviceStorage = {
  getItem(key: string): string | null {
    try { return storage.getText(key); } catch { return null; }
  },
  setItem(key: string, value: string): void {
    try { storage.set(key, String(value)); } catch (e) { console.warn(`storage ${key}: ${String(e)}`); }
  },
  removeItem(key: string): void {
    try { storage.remove(key); } catch { /* gone */ }
  },
};

// --- the game's settings -----------------------------------------------------------------
export interface Settings { colorPalette: string; leftHanded: boolean; assistArc: boolean; haptics: boolean; [key: string]: unknown }
export const settings: Settings = { ...M.DEFAULT_SETTINGS };
const settingsListeners = new Set<() => void>();
export function onSettingsChange(fn: () => void): void { settingsListeners.add(fn); }
function settingsChanged(): void { for (const fn of settingsListeners) fn(); }
function readSetting(key: string): void {
  let v: JsonValue | undefined;
  try { v = store.get(key); } catch { return; }
  const ok = M.migrateSetting(key, v);
  if (ok !== undefined) settings[key] = ok;
}
function initSettings(): void {
  for (const k of M.GAME_SETTING_KEYS) readSetting(k);
  store.onChange((key) => {
    if (!M.GAME_SETTING_KEYS.includes(key)) return;
    readSetting(key);
    settingsChanged();
  });
  store.onLegacy(importLegacy);
  importLegacy();
  settingsChanged();
}
/** Changes one of the game's settings (device and account). */
export function setSetting(key: string, value: boolean | string): void {
  settings[key] = value;
  try { store.set(key, value); } catch (e) { console.warn(`setting ${key}: ${String(e)}`); }
  settingsChanged();
}
// The browser build's per-player settings: kept where the game still has the
// setting (unless this game set it since), then removed from the account.
function importLegacy(): void {
  const keys = store.legacyKeys();
  if (!keys) return;
  let changed = false;
  for (const key of keys) {
    if (!M.BROWSER_SETTING_KEYS.includes(key)) continue;
    const v = M.migrateSetting(key, store.legacy(key));
    if (v !== undefined && store.get(key) === undefined) {
      try { store.set(key, v as JsonValue); settings[key] = v; changed = true; } catch { /* keep the device's */ }
    }
    store.removeLegacy(key);
  }
  if (changed) settingsChanged();
}

/** Reads the device's save and the game's settings (from onStart). */
export function initPlatform(): void {
  const cur = saves.load();
  lastSavedAt = cur?.savedAt ?? 0;
  const p = M.progressFromSave(cur?.data);
  if (p) progress = p;
  else if (!cur) saveProgress();
  if (saves.state() === "foreign") migrateForeign();
  initSettings();
  refreshPlayer();
}

// --- the platform's clock ------------------------------------------------------------------
/** The platform's time (the shared day of Daily Breeze), else the device's clock offline. */
export function now(): Date {
  let t: number | null = null;
  try { t = serverNow(); } catch { t = null; }
  return new Date(t ?? Date.now());
}
/** Whether now() follows the platform's clock. */
export function timeTrusted(): boolean { try { return serverNow() !== null; } catch { return false; } }
/** Starts the first reading (from onStart). */
export function syncTime(): void { void serverTime().catch(() => undefined); }

// --- the player -----------------------------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
export function userId(): string | null { return player()?.userId ?? null; }
export function displayName(): string | null { return player()?.displayName ?? null; }
let avatarImage: OffscreenCanvas | null = null;
/** The player's avatar cut to a circle (48 px), or null. */
export function avatarCanvas(): OffscreenCanvas | null { return avatarImage; }
let invite: string | null = null;
/** The invite link, fetched ahead so a button press can copy it at once. */
export function inviteLink(): string | null { return player() ? invite : null; }
function refreshPlayer(): void {
  invite = null;
  avatarImage = null;
  board = null;
  const me = player();
  if (!me) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
  avatar(me.userId).then((bmp) => {
    if (!bmp || player()?.userId !== me.userId) return;
    const c = new OffscreenCanvas(48, 48);
    const g = c.getContext("2d");
    g.beginPath();
    g.arc(24, 24, 24, 0, Math.PI * 2);
    g.clip();
    g.drawImage(bmp, 0, 0, 48, 48);
    bmp.close();
    avatarImage = c;
  }, () => { /* no avatar */ });
}
onPlayerChange(() => refreshPlayer());

// --- the StarHermit leaderboards -------------------------------------------------------------
let board: Leaderboard | null = null;
async function highScoreBoard(): Promise<Leaderboard | null> {
  if (board) return board;
  const list = await leaderboards.list();
  board = list.find((b) => b.key === "high-score") ?? list[0] ?? null;
  return board;
}
export interface BoardRow { name: string; score: number; you: boolean }
/** The Leaderboards screen's rows (the first 50, names from the players' profiles when signed in; the player's own "You (name)"), or null when unavailable. */
export async function fetchLeaderboard(friendsOnly: boolean, youLabel: (name: string) => string): Promise<BoardRow[] | null> {
  const me = player();
  // Guests read the global board too (a public read); friends need a player.
  if (!me && friendsOnly) return null;
  try {
    const b = await highScoreBoard();
    if (!b) return null;
    const page = await leaderboards.entries(b.id, { pageSize: 50, ...(friendsOnly ? { friendsOnly: true, scope: "friends" } : {}) });
    return await Promise.all(page.items.map(async (e) => {
      let name = e.username || "Player " + e.userId.slice(0, 8);
      if (me && e.userId === me.userId) name = me.displayName;
      else if (me) { try { name = (await profile(e.userId)).displayName; } catch { /* the username */ } }
      const you = !!me && e.userId === me.userId;
      return { name: you ? youLabel(name) : name, score: Math.floor(Number(e.score) || 0), you };
    }));
  } catch { return null; }
}

/** Signed in only: post a finished ranked round's total through score-script.js; { posted, rank }. Never rejects. */
export async function postLeaderboard(total: number): Promise<{ posted: boolean; rank: number | null }> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  const score = Math.max(0, Math.round(total));
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { "high-score": score } }); });
      socket.on("game", (data) => {
        const d = data as { type?: string; accepted?: string[] } | null;
        if (d && d.type === "result-ack") finish(Array.isArray(d.accepted) ? d.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes("high-score")) return { posted: false, rank: null };
  try {
    const b = await highScoreBoard();
    if (!b) return { posted: true, rank: null };
    const r = await leaderboards.entries(b.id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}
