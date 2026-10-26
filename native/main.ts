// Breeze Wing on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules, content, session and save model are
// the browser build's unchanged js/rules.js, js/content.js, js/session.js and
// js/store.js; this module is what js/main.js did around them — the app
// state machine (boot → title → setup | journey → countdown → active ⇄
// paused → results → progression, with help, settings, achievements and the
// leaderboards as screens), the flap, undo, the countdown, the cosmetic
// settle before results, progression and achievements, the paused round's
// safe snapshot and the Welcome back screen, input routing (actions, presses
// and taps on the sky) and the lifecycle — with the screens and HUD drawn by
// screens.ts (starhermit:ui) and the sky by render.ts (starhermit:scene).
//
// The simulation clock is the runtime's fixed steps (60 a second, the rules'
// SIM_DT): a tick every step, only while the round is active, so pausing, a
// hidden window and a slow frame never move the gates. The countdown and the
// settle before results are counted in the same steps, so play scripts
// replay exactly.
import { frame, onFixedUpdate, onPreferencesChange, onQuit, onRender, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { onAction, onPointerButton, onTouch, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onPlayerChange, onSessionEnded } from "starhermit:platform";
import { Phase, TerminalReason, ActionType, TICKS_PER_SECOND } from "../js/rules.js";
import { JOURNEY, LESSONS, CHALLENGES, PRACTICE_PRESETS, ACHIEVEMENTS, BUILD, dailyContent, scoreChaseContent } from "../js/content.js";
import { GameSession } from "../js/session.js";
import * as audio from "./audio.ts";
import { N, T, cfgName } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens, loadArt } from "./screens.ts";
import { applyPalette, initStyles } from "./style.ts";

// deno-lint-ignore no-explicit-any
export type Cfg = any;
export type State = render.State & {
  score: { gates: number; center: number; streak: number; time: number; total: number };
  streak: number; bestStreak: number; centeredPasses: number; flapsUsed: number; invalidActions: number;
  config: { params: Record<string, number>; goal: { type: string; value: number }; parTicks: number; [k: string]: unknown };
};
export type ScreenName = "title" | "setup" | "journey" | "countdown" | "pause" | "results" | "help" | "settings" | "achievements" | "boards" | "away";
export type AppState = "boot" | "title" | "mode-setup" | "mode-select" | "countdown" | "active" | "paused" | "results";
export interface SetupOption { id: string; name: string; desc: () => string; config: Cfg }
export interface ResultsView {
  s: State; won: boolean; extras: string[]; cfg: Cfg; earned: { key: string; name: string; desc: string }[];
  next: Cfg | null; nextLabel: string | null; lb: { pending?: boolean; posted?: boolean; rank?: number | null } | null;
}
export type BoardTab = "global" | "friends" | "local";

const INVALID_TEXT: Record<string, string> = {
  "no-moves-remaining": N("No flaps left — glide it in!"),
  "session-over": N("This round is over."),
  "unknown-action": N("That action is not available."),
  "duplicate-command": N("Already registered."),
};
const COUNTDOWN = ["3", "2", "1", N("Go!")];
const COUNT_STEP = Math.round(0.7 * TICKS_PER_SECOND); // 700 ms a numeral
const GO_HOLD = Math.round(0.6 * TICKS_PER_SECOND); // play starts 600 ms after Go

export const app = {
  appState: "boot" as AppState,
  /** The open screen; null while flying (the HUD shows). */
  screen: "title" as ScreenName | null,
  /** Frame the screen opened on (the action that opened it must not also close it). */
  openedFrame: 0,
  focusNext: false,
  /** The screen Help / Settings return to. */
  returnTo: "title" as ScreenName | null,
  pendingConfig: null as Cfg,
  setup: null as { blurb: () => string; options: SetupOption[] | null; selected: string | null } | null,
  results: null as ResultsView | null,
  board: { tab: "global" as BoardTab, entries: null as platform.BoardRow[] | null, note: "" },
  countdownText: null as string | null,
  countdownPrompt: null as (() => string) | null,
  tapHint: false,
  toast: null as { text: () => string; until: number } | null,
  caption: null as { text: string; until: number } | null,
  touchSeen: false,
  awaySnap: null as GameSession | null,
};
export let session: GameSession | null = null;
/** The raw content config of the round (the rules state holds only the normalized one). */
export let roundConfig: Cfg = null;
export const settings = platform.settings;
export const progress = (): platform.Progress => platform.getProgress();
const now = (): number => frame().time;
/** Whether a session's round reached a terminal state. */
const ended = (s: GameSession): boolean => (s.phase as string) === Phase.TERMINAL;

export function announce(msg: string, assertive = false): void {
  if (msg) ui.announce(msg, { politeness: assertive ? "assertive" : "polite" });
}
/** A toast; `text` re-runs each frame so a visible toast follows a language change. */
export function toast(text: () => string, seconds = 2.4): void {
  app.toast = { text, until: now() + seconds };
  announce(text());
}
function haptic(ms: number): void { if (settings.haptics) vibrate(ms); }
audio.setOnCaption((key, vars) => { app.caption = { text: T(key, vars), until: now() + 1.2 }; });

// ------------------------------------------------------------------ screens
export function showScreen(name: ScreenName | null): void {
  app.screen = name;
  app.openedFrame = frame().frame;
  app.focusNext = !!name && name !== "countdown";
  // Gameplay guidance never lingers over a screen's text or actions.
  if (name && name !== "countdown") { app.toast = null; app.caption = null; }
  if (!name || name === "countdown") ui.setFocus(null);
}
export function dailyDone(): boolean { return !!progress().best[dailyContent(platform.now()).id]; }

export function toTitle(): void {
  app.appState = "title";
  session = null;
  roundConfig = null;
  app.setup = null; app.results = null; app.countdownPrompt = null; app.countdownText = null; app.tapHint = false;
  audio.setMusicIntensity(0.2);
  audio.stopAmbience();
  audio.setPaused(false);
  idle = null;
  showScreen("title");
}

/** blurb: a function returning localized text (re-run each frame, so it follows a language change). */
export function openSetup(cfg: Cfg, blurb?: string | (() => string), options?: SetupOption[]): void {
  app.pendingConfig = cfg;
  app.appState = "mode-setup";
  app.setup = {
    blurb: typeof blurb === "function" ? blurb : () => (blurb ? T(blurb) : ""),
    options: options ?? null, selected: options && options.length ? options[0]!.id : null,
  };
  showScreen("setup");
}
export function pickSetupOption(id: string): void {
  const v = app.setup;
  if (!v || !v.options) return;
  const picked = v.options.find((o) => o.id === id);
  if (picked && picked.config) app.pendingConfig = picked.config;
  v.selected = id;
}
export function openPlay(): void {
  // Short path to play: learn first, then continue the journey.
  const p = progress();
  if (!p.tutorialDone) openSetup(LESSONS[0], N("Sixty seconds to learn the sky."));
  else {
    const next = JOURNEY.find((st: Cfg) => !(p.journey[st.id] && p.journey[st.id].cleared)) || JOURNEY[0];
    openSetup(next, N("Pick up where you left off."));
  }
}
export function openDaily(): void {
  // The shared day follows the platform's clock; offline, the device's.
  const note = (): string => (platform.timeTrusted() ? N("Synchronized to server time.") : N("Using local clock (offline)."));
  openSetup(dailyContent(platform.now()), () => `${T("One shared sky for everyone today.")} ${T(note())}`);
}
export function openJourney(): void { app.appState = "mode-select"; showScreen("journey"); }
export function openLearn(): void {
  openSetup(LESSONS[0], N("Five tiny lessons, one rule at a time."), LESSONS.map((l: Cfg) => ({ id: l.id, name: l.name, desc: () => T(l.lesson.goalText), config: l })));
}
export function openPractice(): void {
  openSetup(PRACTICE_PRESETS[0], N("Free flight. Undo is allowed; nothing is ranked."), PRACTICE_PRESETS.map((p: Cfg) => ({
    id: p.id, name: p.name, desc: () => T("{difficulty} — endless, undo allowed, unranked", { difficulty: T(p.difficulty) }), config: p,
  })));
}
export function openChallenges(): void {
  openSetup(CHALLENGES[0], N("Constrained goals for seasoned wings."), CHALLENGES.map((c: Cfg) => ({ id: c.id, name: c.name, desc: () => T(c.blurb), config: c })));
}
export function openChase(): void {
  const seed = `sky-${platform.now().toISOString().slice(0, 10)}`;
  openSetup(scoreChaseContent(seed), () => T('Endless score chase. Share the seed "{seed}" to fly the same sky as friends.', { seed }));
}
/** Help / Settings from the title or the pause screen; Back returns there. */
export function openOverlay(name: "help" | "settings"): void {
  if (app.screen !== "help" && app.screen !== "settings") app.returnTo = app.screen;
  showScreen(name);
}
export function closeOverlay(): void {
  if (app.appState === "paused") showScreen("pause");
  else if (app.returnTo && app.returnTo !== "help" && app.returnTo !== "settings") showScreen(app.returnTo);
  else toTitle();
}
export function openAchievements(): void { app.appState = "mode-select"; showScreen("achievements"); }
export function openBoards(): void { app.appState = "mode-select"; showScreen("boards"); loadBoard("global"); }
export function loadBoard(tab: BoardTab): void {
  const b = app.board;
  b.tab = tab;
  const local = (note: string): void => { b.entries = progress().localBoard.map((e: Cfg) => ({ name: e.name, score: e.score, you: !!e.you })); b.note = note; };
  if (tab === "local") { local(N("Scores from this device. Casual — verified boards require sign-in.")); return; }
  if (tab === "friends" && !platform.signedIn()) { local(N("Offline — showing this device's scores. Sign in for global boards.")); return; }
  b.entries = null;
  b.note = "";
  void platform.fetchLeaderboard(tab === "friends", (name) => T("You ({name})", { name })).then((rows) => {
    if (b.tab !== tab) return;
    if (rows === null) local(N("Board unavailable right now — showing local scores."));
    else { b.entries = rows; b.note = tab === "friends" ? N("Friends only — high scores from Daily Breeze and Score Chase.") : N("High scores from Daily Breeze and Score Chase."); }
  });
}
export function replayTutorial(): void {
  progress().tutorialDone = false;
  platform.saveProgress();
  openSetup(LESSONS[0], N("Sixty seconds to learn the sky."));
}

// ------------------------------------------------------------------ the round
let countdownLeft = 0;
let countdownIndex = -1;
let goLeft = 0;
let finishLeft = -1;
let prevState: State | null = null;

export function beginRound(): void {
  const cfg = app.pendingConfig;
  // Keep the RAW content config for this round: the rules state only holds
  // the normalized config (normalizeConfig drops content metadata such as
  // dateKey, index, lesson), but progression, results and ranked posting
  // need those fields.
  roundConfig = cfg;
  GameSession.clearSafeSnapshot(platform.deviceStorage);
  const s = new GameSession(cfg, {
    build: BUILD,
    allowUndo: cfg.mode === "practice",
    rawConfig: cfg,
    sessionId: `bw-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e8).toString(36)}`,
  });
  s.onEvent((events: render.RulesEvent[], state: State) => onSessionEvents(events, state));
  session = s;
  prevState = s.state as State;
  finished = null;
  finishLeft = -1;
  idle = null;
  render.prepareSession(cfg);
  render.setAssistArc(settings.assistArc);
  audio.reseed(cfg.seed);
  audio.startAmbience(cfg.theme);
  audio.startMusic();
  audio.setPaused(false);
  app.appState = "countdown";
  app.setup = null;
  app.results = null;
  app.tapHint = false;
  showScreen("countdown");
  announce(T("{name}. Get ready.", { name: cfgName(cfg) }));
  app.countdownPrompt = () => T(cfg.lesson ? cfg.lesson.prompt : N("Flap to take off!"));
  countdownLeft = COUNT_STEP * COUNTDOWN.length;
  countdownIndex = -1;
  goLeft = 0;
  countdownTick();
}
/** One step of the 3 · 2 · 1 · Go countdown (fixed steps), then 600 ms to flight. */
function countdownTick(): void {
  if (goLeft > 0) {
    if (--goLeft === 0) startFlight();
    return;
  }
  const i = COUNTDOWN.length - Math.ceil(countdownLeft / COUNT_STEP);
  if (i !== countdownIndex && i < COUNTDOWN.length) {
    countdownIndex = i;
    const txt = COUNTDOWN[i]!;
    app.countdownText = txt;
    const last = i === COUNTDOWN.length - 1;
    audio.event("countdown", { final: last });
    announce(T(txt));
    if (last) goLeft = GO_HOLD;
  }
  countdownLeft--;
}
function startFlight(): void {
  const cfg = roundConfig;
  app.appState = "active";
  app.countdownText = null;
  app.countdownPrompt = null;
  showScreen(null);
  app.tapHint = app.touchSeen && !cfg.lesson;
  if (cfg.lesson) {
    announce(T(cfg.lesson.prompt));
    toast(() => T(cfg.lesson.prompt), 5);
  }
}
export function flap(): void {
  if (app.appState !== "active" || !session || app.screen) return;
  session.command(ActionType.FLAP);
}
export function undo(): void { if (session && session.canUndo && (app.appState === "active" || app.appState === "paused")) session.undo(); }

function onSessionEvents(events: render.RulesEvent[], state: State): void {
  render.onEvents(events, state);
  for (const e of events) {
    switch (e.type) {
      case "flap": audio.event("flap"); haptic(8); app.tapHint = false; break;
      case "start": audio.event("start"); break;
      case "pass":
        audio.event("pass");
        announce(T("Gate {n}. Score {score}.", { n: state.gatesPassed, score: state.score.total }));
        break;
      case "centered":
        audio.event("centered");
        if ((e.streak ?? 0) >= 3) audio.event("streak", { streak: e.streak! });
        haptic(20);
        if ((e.streak ?? 0) >= 2) announce(T("Centered! Streak {n}.", { n: e.streak! }));
        break;
      case "invalid": {
        audio.event("invalid");
        const key = INVALID_TEXT[(e as { reason?: string }).reason ?? ""] || N("Not available right now.");
        toast(() => T(key));
        announce(T(key), true);
        break;
      }
      case "terminal":
        audio.event("terminal", { reason: e.reason! });
        haptic(e.reason === "cleared" ? 100 : 60);
        audio.setMusicIntensity(0.2);
        // Let the crash / clear animation breathe, then show results.
        finishLeft = Math.round((preferences().reducedMotion ? 0.4 : 1.1) * TICKS_PER_SECOND);
        break;
      case "undo":
        audio.event("undo");
        announce(T("Undid the last flap."));
        break;
      default: break;
    }
  }
  // Adaptive music intensity rises with speed and danger.
  if (state.phase !== Phase.TERMINAL) audio.setMusicIntensity(0.25 + Math.min(1, state.gatesPassed / 30) * 0.6);
}

export function pause(): void {
  if (app.appState !== "active" && app.appState !== "countdown") return;
  if (session && ended(session)) return; // the settle before results runs on
  app.appState = "paused";
  app.tapHint = false; // never covers the pause or settings screens
  showScreen("pause");
  audio.event("ui");
  audio.setPaused(true);
  announce(T("Paused."));
  if (session) session.saveSafeSnapshot(platform.deviceStorage);
}
export function resume(): void {
  if (!session || ended(session)) return;
  app.awaySnap = null;
  showScreen(null);
  app.appState = "active";
  audio.setPaused(false);
  audio.startMusic();
  announce(T("Resumed."));
}
export function leaveRound(): void {
  if (session && !ended(session)) session.command(ActionType.ABANDON);
  finishRound();
}
export function retry(): void {
  // Retry the round's raw content config (not the normalized rules config).
  app.pendingConfig = roundConfig || session?.config;
  beginRound();
}
export function next(): void {
  const n = app.results?.next;
  if (n) { app.pendingConfig = n; beginRound(); }
}

let finished: GameSession | null = null;
function finishRound(): void {
  if (!session) { toTitle(); return; }
  // Finish each session exactly once (Leave finishes at once; the terminal settle may follow).
  if (finished === session) return;
  finished = session;
  finishLeft = -1;
  const s = session.state as State;
  GameSession.clearSafeSnapshot(platform.deviceStorage);
  app.appState = "results";
  app.tapHint = false;
  const won = !!(s.terminal && s.terminal.reason === TerminalReason.CLEARED);
  const cfg = roundConfig || s.config;
  const { extras, earned, lbRound } = progressRound(s, won, cfg);
  let nextCfg: Cfg = null, nextLabel: string | null = null;
  if (cfg.mode === "journey" && won && cfg.index + 1 < JOURNEY.length) {
    nextCfg = JOURNEY[cfg.index + 1];
    nextLabel = "journey";
  } else if (cfg.mode === "learn" && won) {
    const idx = LESSONS.findIndex((l: Cfg) => l.id === cfg.id);
    if (idx >= 0 && idx + 1 < LESSONS.length) { nextCfg = LESSONS[idx + 1]; nextLabel = "lesson"; }
  }
  app.results = { s, won, extras, cfg, earned, next: nextCfg, nextLabel, lb: null };
  if (lbRound && platform.signedIn()) {
    const res = app.results;
    res.lb = { pending: true };
    void platform.postLeaderboard(lbRound.score).then((r) => { res.lb = r; });
  }
  showScreen("results");
  audio.setMusicIntensity(0.2);
  audio.stopMusic();
  announce(T(won ? "Stage clear. Score {n}." : "Flight ended. Score {n}.", { n: s.score.total }));
  platform.saveProgress();
}

function progressRound(s: State, won: boolean, cfg: Cfg): { extras: string[]; earned: { key: string; name: string; desc: string }[]; lbRound: { score: number } | null } {
  const p = progress();
  const extras: string[] = [];
  p.totalRuns += 1;
  p.totalGates += s.gatesPassed;
  const dayKey = platform.now().toISOString().slice(0, 10);
  if (!p.daysPlayed.includes(dayKey)) p.daysPlayed.push(dayKey);
  if (cfg.mode === "learn" && won) {
    p.lessons[cfg.id] = true;
    if (Object.keys(p.lessons).length >= LESSONS.length) p.tutorialDone = true;
  }
  if (cfg.mode === "journey") {
    const rec = p.journey[cfg.id] || { cleared: false, bestScore: 0, bestTicks: 0 };
    if (won) rec.cleared = true;
    if (s.score.total > (rec.bestScore || 0)) rec.bestScore = s.score.total;
    if (won && (!rec.bestTicks || s.tick < rec.bestTicks)) rec.bestTicks = s.tick;
    p.journey[cfg.id] = rec;
  }
  if (["daily", "chase", "practice", "challenge"].includes(cfg.mode)) {
    if ((p.best[cfg.id] || 0) < s.score.total) {
      const hadBest = (p.best[cfg.id] || 0) > 0;
      p.best[cfg.id] = s.score.total;
      if (cfg.mode === "daily" || cfg.mode === "chase") extras.push(N("New personal best!"));
      // Sting only when an existing best is beaten; a first score is not a record.
      if (hadBest && s.score.total > 0) audio.event("best");
    }
  }
  // Device board entry for the ranked modes.
  if ((cfg.mode === "daily" || cfg.mode === "chase") && s.terminal) {
    p.localBoard.push({ name: platform.displayName() ?? T("Guest"), score: s.score.total, date: dayKey, contentId: cfg.id, seed: cfg.seed, you: true });
    p.localBoard.sort((a: Cfg, b: Cfg) => b.score - a.score);
    p.localBoard = p.localBoard.slice(0, 50);
  }
  // Achievements (idempotent unlocks).
  const earned: { key: string; name: string; desc: string }[] = [];
  const unlock = (key: string): void => {
    if (p.achievements[key]) return;
    p.achievements[key] = new Date().toISOString();
    const meta = ACHIEVEMENTS.find((a: Cfg) => a.key === key);
    if (meta) { earned.push(meta); audio.event("achievement"); }
  };
  if (won) unlock("first_clear");
  if (Object.keys(p.lessons).length >= LESSONS.length) unlock("mechanic_mastery");
  if (s.bestStreak >= 5) unlock("streak_5");
  const journeyCleared = Object.values(p.journey).filter((r: Cfg) => r.cleared).length;
  if (journeyCleared >= 20) unlock("journey_half");
  if (journeyCleared >= 40) unlock("journey_master");
  if (p.daysPlayed.length >= 7) unlock("long_term");
  if (cfg.mode === "daily" && s.terminal) unlock("daily_first");
  if (s.gatesPassed >= 100) unlock("centurion");
  // Ranked rounds (Daily Breeze, Score Chase) post their total to the high-score board when signed in.
  return { extras, earned, lbRound: cfg.ranked && s.terminal ? { score: s.score.total } : null };
}

// ------------------------------------------------------------------ the Welcome back screen
export function continueAway(): void {
  const snap = app.awaySnap;
  if (!snap) { toTitle(); return; }
  prevState = snap.state as State;
  resume();
}
export function restartAway(): void {
  GameSession.clearSafeSnapshot(platform.deviceStorage);
  app.awaySnap = null;
  toTitle();
}
function showAway(snap: GameSession): void {
  session = snap;
  snap.onEvent((events: render.RulesEvent[], state: State) => onSessionEvents(events, state));
  roundConfig = snap.rawConfig || snap.config;
  prevState = snap.state as State;
  render.prepareSession(snap.config);
  audio.startAmbience(roundConfig.theme);
  audio.setPaused(true);
  app.appState = "paused";
  app.awaySnap = snap;
  showScreen("away");
}

// ------------------------------------------------------------------ input
onAction((e) => {
  if (!e.pressed || ui.capturingKeys()) return;
  const fresh = frame().frame !== app.openedFrame;
  switch (e.action) {
    case "flap":
      // Only while flying with no screen open, so it never fires from a focused menu button.
      if (app.appState === "active" && !app.screen) { if (ui.focused()) ui.setFocus(null); flap(); }
      break;
    case "pause":
      if (!fresh) break;
      if (app.appState === "active" || app.appState === "countdown") pause();
      else if (app.appState === "paused" && app.screen === "pause") resume();
      else if (app.appState === "paused" && (app.screen === "help" || app.screen === "settings")) showScreen("pause");
      else if (app.screen === "help" || app.screen === "settings") closeOverlay();
      else if (app.screen && app.screen !== "title" && app.screen !== "away" && app.screen !== "countdown") toTitle();
      break;
    case "undo":
      if (app.appState === "active" && session?.canUndo) session.undo();
      break;
    case "restart":
      if (app.appState === "results" && session) retry();
      break;
    case "help":
      if (app.appState === "title" && app.screen === "title") openOverlay("help");
      break;
  }
});

// A press anywhere on the sky (not on the HUD's buttons) flaps. Touch and
// the mouse can both report one press: a pointer press right after a touch
// is skipped.
let lastTouch = -1e9;
function skyPress(): void {
  if (app.appState !== "active" || app.screen || ui.pointerOver()) return;
  flap();
}
onPointerButton((e) => {
  if (e.button !== 0 || !e.pressed || now() - lastTouch < 0.6) return;
  skyPress();
});
onTouch((e) => {
  app.touchSeen = true;
  if (!e.primary) return;
  lastTouch = now();
  if (e.phase === "start") skyPress();
});

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const key = `${f.quality}:${f.levelIndex}`;
  if (key === lookKey) return;
  lookKey = key;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}
function applySettings(): void {
  applyPalette(String(settings.colorPalette), preferences().highContrast);
  render.setReducedMotion(preferences().reducedMotion);
  render.setAssistArc(!!settings.assistArc);
}

let idle: { state: State } | null = null;
onStart(() => {
  setFixedRate(TICKS_PER_SECOND);
  initStyles();
  platform.initPlatform();
  platform.syncTime();
  applySettings();
  audio.loadSfx();
  applyLook();
  loadArt();
  // Mid-round recovery: a paused round's safe snapshot offers Welcome back.
  const snap = GameSession.loadSafeSnapshot(platform.deviceStorage);
  if (snap && !ended(snap)) showAway(snap);
  else toTitle();
});
onPreferencesChange(() => applySettings());
platform.onSettingsChange(() => applySettings());
onSessionEnded(() => { toast(() => T("Signed out of StarHermit — progress stays on this device."), 4); });
onPlayerChange(() => undefined);
onSuspend(() => {
  // Backgrounding pauses the round (with its snapshot) and surfaces the pause screen.
  pause();
  if (session && !ended(session)) session.saveSafeSnapshot(platform.deviceStorage);
  platform.flush();
});
onQuit(() => { if (session && !ended(session) && app.appState !== "results") session.saveSafeSnapshot(platform.deviceStorage); });

onFixedUpdate(() => {
  if (app.appState === "countdown" && session) countdownTick();
  else if (app.appState === "active" && session) {
    if (!ended(session)) {
      prevState = session.state as State;
      session.tick();
    } else prevState = session.state as State;
    if (finishLeft > 0 && --finishLeft === 0) finishRound();
  }
});
let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  audio.update();
  const t0 = now();
  if (app.toast && t0 > app.toast.until) app.toast = null;
  if (app.caption && t0 > app.caption.until) app.caption = null;
});
onRender((alpha) => {
  const f = frame();
  drawScreens();
  const s = session;
  if (s && app.appState === "active") {
    render.render(prevState, s.state as State, alpha, frameDt, f.width, f.height);
  } else if (s) {
    // Frozen sim, gentle cosmetic motion continues.
    render.render(s.state as State, s.state as State, 1, frameDt * 0.2, f.width, f.height);
  } else {
    // The title's idle sky: today's daily scene, no input.
    if (!idle) {
      const g = new GameSession(dailyContent(platform.now()));
      render.prepareSession(g.config);
      idle = { state: g.state as State };
    }
    idle.state = { ...idle.state, tick: idle.state.tick + 1 };
    render.render(idle.state, idle.state, 1, frameDt, f.width, f.height);
  }
});
