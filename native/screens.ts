// The browser build's DOM shell (index.html + js/ui.js + css/style.css) as
// starhermit:ui, built every frame: the play HUD (objective and progress,
// score and streak, flaps left, time left, Undo and Pause, mirrored for the
// left-handed layout), the tap pill, the countdown numeral and prompt, the
// toast and the caption strip, and the screens (title with its emblem, the
// mode setup with its facts and options, the Journey grid, pause, results
// with the horizon art and the score breakdown, help with its rule cards,
// settings, achievements, the leaderboards with their Global / Friends /
// This device tabs, Welcome back). The browser's media queries are layouts
// picked by the window's logical size: wide (≥ 1024 px: larger panels),
// compact (≤ 700 px: panels become bottom sheets, the title stays a card)
// and short landscape (≤ 500 px tall: a smaller HUD, logo and emblem, no
// results art). Panels taller than the room scroll, with their buttons
// pinned below.
import { clipboard, frame, openMenu } from "starhermit:engine";
import { bindings } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { createImageBitmap, OffscreenCanvas } from "starhermit:canvas";
import { requestSignIn } from "starhermit:platform";
import { ACHIEVEMENTS, JOURNEY } from "../js/content.js";
import { PALETTES } from "../js/migrate.js";
import { TICKS_PER_SECOND } from "../js/rules.js";
import { T, cfgName } from "./i18n.ts";
import * as platform from "./platform.ts";
import {
  app, closeOverlay, continueAway, dailyDone, leaveRound, loadBoard, next, openAchievements, openBoards,
  openChallenges, openChase, openDaily, openJourney, openLearn, openOverlay, openPlay, openPractice, openSetup,
  pause, pickSetupOption, progress, replayTutorial, restartAway, resume, retry, roundConfig, session, settings,
  beginRound, toTitle, toast, undo, type Cfg, type ScreenName, type State,
} from "./main.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; wide: boolean; narrow: boolean; shortLand: boolean }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  return { lw, lh, sc, wide: lw >= 1024, narrow: lw <= 700, shortLand: lw > lh && lh <= 500 };
}
const lastHeight = new Map<string, number>();
const REM = 16;

function textWidth(text: string, style: string | readonly string[], kind?: "button"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: typeof style === "string" ? style : [...style] }).width / ui.preferences().scale;
}
const buttonWidth = (text: string, style: readonly string[]): number => textWidth(text, style, "button") + 4;

interface Btn { id: string; text: string; style?: string[]; disabled?: boolean; selected?: boolean; act: () => void; face?: () => void }
const PLAIN = ["btn"];
/** A button `width` wide (null: its text's); a label too long for it wraps inside. */
function button(b: Btn, width: number | null = null): void {
  const style = b.style ?? PLAIN;
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  if (b.selected !== undefined) opts.selected = b.selected;
  const s: ui.Style = width != null ? { width } : {};
  if (b.face) opts.content = b.face;
  else if (width != null && buttonWidth(b.text, style) > width) {
    const inner = width - 36;
    opts.content = () => { ui.paragraph(b.text, inner, { weight: "600", ...(style.includes("btn-big") ? { size: 20.8 } : {}) }); };
  }
  if (ui.style(...style, s).id(b.id).button(b.text, opts)) { b.act(); }
}
/** Buttons at their own widths in rows that wrap at `width` (CSS flex-wrap). */
function flow(label: string, list: Btn[], width: number, align: "start" | "center" | "end" = "start", gap = 8): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  for (const b of list) {
    const bw = Math.min(width, buttonWidth(b.text, b.style ?? PLAIN));
    if (rows[rows.length - 1]!.length && used + gap + bw > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + bw;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      for (const b of row) button(b, buttonWidth(b.text, b.style ?? PLAIN) > width ? width : null);
    }, { spacing: gap, align: "center" }));
  }, { spacing: gap, align, width });
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls?: string | readonly string[] | null, id?: string, center = false): void {
  if (!text) return;
  const styles: (string | ui.Style)[] = cls ? (typeof cls === "string" ? [cls] : [...cls]) : [];
  if (center) styles.push({ text: { align: "center" } });
  let u = ui.style(...styles);
  if (id) u = u.id(id);
  if (ui.measureText(text, { style: styles }).width / ui.preferences().scale <= width) u.label(text);
  else u.paragraph(text, width);
}
/** Without its leading symbol (▶ ❚❚ ✦): those depend on the system's fonts (tofu); drawn glyphs stand in. */
const bare = (s: string): string => s.replace(/^[▶❚✦\s]+/u, "").trim();
/** Rich text from the string tables (help cards) as plain text. */
const plain = (s: string): string => s.replace(/<[^>]+>/g, "");

// ------------------------------------------------------------------ glyphs
type Glyph = "play" | "pause" | "sparkle" | "medal" | "star" | "clock";
function starPts(cx: number, cy: number, r: number, n = 5, inner = 0.45): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    const rr = i % 2 ? r * inner : r;
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  return pts;
}
function glyph(kind: Glyph, size: number, color: string): void {
  ui.widget("", {
    role: "none", size: { width: size, height: size },
    draw: (r) => {
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2, s = Math.min(r.width, r.height) / 2;
      if (kind === "play") draw.polygon([[cx - s * 0.6, cy - s * 0.75], [cx + s * 0.8, cy], [cx - s * 0.6, cy + s * 0.75]], color);
      else if (kind === "pause") {
        draw.rect(cx - s * 0.6, cy - s * 0.7, s * 0.42, s * 1.4, color);
        draw.rect(cx + s * 0.18, cy - s * 0.7, s * 0.42, s * 1.4, color);
      } else if (kind === "sparkle") draw.polygon(starPts(cx, cy, s, 4, 0.32), color);
      else if (kind === "star") draw.polygon(starPts(cx, cy, s), color);
      else if (kind === "clock") {
        draw.roundRect(cx - s * 0.8, cy - s * 0.8, s * 1.6, s * 1.6, s * 0.8, color);
        draw.roundRect(cx - s * 0.58, cy - s * 0.58, s * 1.16, s * 1.16, s * 0.58, "#fffcf6");
        draw.line(cx, cy, cx, cy - s * 0.45, color, Math.max(1.5, s * 0.16));
        draw.line(cx, cy, cx + s * 0.32, cy + s * 0.1, color, Math.max(1.5, s * 0.16));
      } else {
        draw.polygon([[cx - s * 0.55, cy - s], [cx - s * 0.1, cy - s], [cx + s * 0.1, cy - s * 0.2], [cx - s * 0.3, cy - s * 0.2]], "#d94f2b");
        draw.polygon([[cx + s * 0.55, cy - s], [cx + s * 0.1, cy - s], [cx - s * 0.1, cy - s * 0.2], [cx + s * 0.3, cy - s * 0.2]], "#2f7fd0");
        draw.polygon(starPts(cx, cy + s * 0.3, s * 0.68), color);
      }
    },
  });
}
const GOLD = "#e0a100";

// ------------------------------------------------------------------ art
// The storybook illustrations (assets/*.webp), decoded into canvases: the
// emblem cut to a circle, the horizon strip with the panel's rounded top.
// Missing art never breaks a screen: a soft fill stands in (the browser
// build hid the image), and both are dropped under high contrast.
let emblem: OffscreenCanvas | null = null;
let horizon: OffscreenCanvas | null = null;
export function loadArt(): void {
  createImageBitmap("assets/title-emblem.webp").then((bmp) => {
    const c = new OffscreenCanvas(216, 216);
    const g = c.getContext("2d");
    g.beginPath();
    g.arc(108, 108, 108, 0, Math.PI * 2);
    g.clip();
    g.drawImage(bmp, 0, 0, 216, 216);
    bmp.close();
    emblem = c;
  }, () => undefined);
  createImageBitmap("assets/results-horizon.webp").then((bmp) => {
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext("2d").drawImage(bmp, 0, 0);
    bmp.close();
    horizon = c;
  }, () => undefined);
}
function emblemWidget(size: number): void {
  if (ui.preferences().highContrast) return;
  ui.widget("", {
    role: "none", size: { width: size, height: size },
    draw: (r) => {
      draw.roundRect(r.x, r.y + r.height * 0.03, r.width, r.height, r.width / 2, "#1e2d4626");
      if (emblem) draw.image(emblem, r.x, r.y, r.width, r.height);
      else draw.roundRect(r.x, r.y, r.width, r.height, r.width / 2, "#ffd9a0");
    },
  });
}
/** The results' horizon strip across the panel, object-fit cover `h` tall. */
function horizonWidget(width: number, h: number): void {
  if (ui.preferences().highContrast) return;
  ui.widget("", {
    role: "none", size: { width, height: h },
    draw: (r) => {
      if (!horizon) { draw.roundRect(r.x, r.y, r.width, r.height, 12, "#ffe3b3"); return; }
      const k = r.width / horizon.width;
      const sh = Math.min(horizon.height, r.height / k);
      draw.image(horizon, r.x, r.y, r.width, r.height, { source: { x: 0, y: (horizon.height - sh) / 2, width: horizon.width, height: sh } });
    },
  });
}

// ------------------------------------------------------------------ the frame
function firstLabel(name: ScreenName): string | null {
  switch (name) {
    case "title": return T("▶ Play");
    case "setup": return T("Start");
    case "journey": return stageLabel(0);
    case "pause": return T("Resume");
    case "results": return T("Retry");
    case "help": case "achievements": return T("Back");
    case "settings": return T("Color palette");
    case "boards": return T("Global");
    case "away": return T("Continue flight");
    default: return null;
  }
}

let toastH = 40;
export function drawScreens(): void {
  const L = layoutNow();
  // A screen that just opened focuses its first control once its layout has
  // settled; a tall screen moves into its scroll area a frame later, where a
  // focus asked for too early does not take: ask again until it does.
  const age = frame().frame - app.openedFrame;
  if (app.focusNext && app.screen && age >= 2) {
    const first = firstLabel(app.screen);
    if (first && age < 12 && ui.focused() !== first) ui.setFocus(first);
    else app.focusNext = false;
  }
  const hudOn = !!session && (app.appState === "countdown" || app.appState === "active" || app.appState === "paused");
  if (hudOn) hud(L);
  switch (app.screen) {
    case "title": titleScreen(L); break;
    case "setup": setupScreen(L); break;
    case "journey": journeyScreen(L); break;
    case "countdown": countdownScreen(L); break;
    case "pause": pauseScreen(L); break;
    case "results": resultsScreen(L); break;
    case "help": helpScreen(L); break;
    case "settings": settingsScreen(L); break;
    case "achievements": achievementsScreen(L); break;
    case "boards": boardsScreen(L); break;
    case "away": awayScreen(L); break;
    default: break;
  }
  if (app.tapHint && app.appState === "active" && !app.screen) {
    // A label, not a button: a tap on it reaches the sky (main.ts flaps on any press outside the HUD's buttons).
    ui.place("tap-hint", { anchor: "bottom", y: 20 }, () => {
      ui.style("tap-hint").id("tap-hint").label(T("Tap anywhere to flap"));
    });
  }
  if (app.caption) {
    // While a screen is open, captions dock to the very bottom edge.
    const docked = !!app.screen && app.screen !== "countdown";
    const w = Math.min(L.lw * 0.92, 30 * REM);
    ui.place("captions", { anchor: "bottom", y: docked ? 6 : 84 }, () => {
      para(app.caption!.text, w - 24, "captions-text", "caption-text", true);
    }, { style: "captions" });
  }
  if (app.toast) {
    const text = app.toast.text();
    const w = Math.min(L.lw - 32, 560);
    ui.place("toast", { anchor: "top-start", x: (L.lw - Math.min(w, textWidth(text, "toast") + 44)) / 2, y: 70 }, () => {
      const r = ui.column("toast-box", () => { para(text, w - 40, "toast-text", "toast-text", true); }, { style: "toast", align: "center" });
      toastH = r.height / L.sc;
    });
  }
  void toastH;
}

// ------------------------------------------------------------------ HUD
function hud(L: Layout): void {
  const s = session!;
  const st = s.state as State;
  const cfg = st.config;
  const goal = cfg.goal;
  const short = L.shortLand;
  const pad = short ? { x: 10, y: 6 } : L.wide ? { x: 28, y: 14 } : { x: 14, y: 10 };
  let progressText = "";
  if (goal.type === "gates" || cfg.params.gateCount! > 0) progressText = T("{n} / {total} gates", { n: st.gatesPassed, total: cfg.params.gateCount || goal.value });
  else if (goal.type === "flaps") progressText = T("{n} / {total} flaps", { n: st.flapsUsed, total: goal.value });
  else progressText = T("{n} gates", { n: st.gatesPassed });
  const moves = cfg.params.moveLimit! > 0 ? Math.max(0, cfg.params.moveLimit! - st.flapsUsed) : null;
  const timeLeft = goal.type === "survive" && goal.value > 0 ? `${Math.max(0, Math.ceil((goal.value - st.tick) / TICKS_PER_SECOND))}s` : null;
  const left = !!settings.leftHanded;
  const scoreCls = ["hud-score", ...(short ? ["hud-score-short"] : L.narrow ? ["hud-score-compact"] : [])];
  const scoreW = Math.max(textWidth(String(st.score.total), scoreCls), st.streak >= 2 ? textWidth(bare(T("✦ streak ×{n}", { n: st.streak })), "hud-streak") + 20 : 0);
  const sideW = Math.max(80, (L.lw - pad.x * 2 - scoreW - 16) / 2);

  // Objective and progress (the left column; the right with the left-handed layout).
  ui.place("hud-info", { anchor: left ? "top-end" : "top-start", x: pad.x, y: pad.y }, () => {
    para(cfgName(roundConfig || cfg), sideW, "hud-objective", "hud-objective", false);
    para(progressText, sideW, "hud-progress", "hud-progress");
  }, { spacing: 2, align: left ? "end" : "start" });
  // Score and streak.
  ui.place("hud-center", { anchor: "top", y: pad.y }, () => {
    ui.style(...scoreCls).id("hud-score").label(String(st.score.total));
    if (st.streak >= 2) {
      ui.row("hud-streak-row", () => {
        glyph("sparkle", 14, "#d94f2b");
        ui.style("hud-streak").id("hud-streak").label(bare(T("✦ streak ×{n}", { n: st.streak })));
      }, { spacing: 4, align: "center" });
    }
  }, { align: "center", spacing: 0 });
  // Flaps left, time left, Undo, Pause.
  ui.place("hud-actions", { anchor: left ? "top-start" : "top-end", x: pad.x, y: pad.y }, () => {
    if (moves !== null) para(T("Flaps left: {n}", { n: moves }), sideW, "hud-progress", "hud-moves");
    if (timeLeft !== null) {
      ui.row("hud-time", () => { glyph("clock", 14, "#44566b"); ui.style("hud-progress").id("hud-time").label(timeLeft); }, { spacing: 4, align: "center" });
    }
    if (s.canUndo && app.appState === "active") {
      if (ui.style("btn", "btn-ghost", "hud-btn").id("btn-undo").button(T("Undo"))) { undo(); ui.setFocus(null); }
    }
    if (app.appState !== "paused") {
      const label = bare(T("❚❚ Pause"));
      const clicked = ui.style("btn", "btn-ghost", "hud-btn").id("btn-pause").button(T("Pause game"), {
        content: () => { ui.row("btn-pause-face", () => { glyph("pause", 14, "#1d2733"); ui.label(label, { weight: "600" }); }, { spacing: 6, align: "center" }); },
      });
      if (clicked) { pause(); }
    }
  }, { spacing: 6, align: left ? "start" : "end" });
}

// ------------------------------------------------------------------ screens
interface ScreenOpts { title?: boolean; center?: boolean; art?: (w: number) => void }
/** A screen: the scrim over the sky with its panel centred (a bottom sheet at ≤ 700 px, the title
 * excepted); a body taller than the room scrolls while the footer's buttons stay below it. */
function screen(key: string, L: Layout, maxW: number, body: (w: number) => void, footer: ((w: number) => void) | null, opts: ScreenOpts = {}): void {
  const sheet = L.narrow && !opts.title;
  const compact = L.shortLand || L.lh < 640 || (L.narrow && L.lh < 720);
  const width = sheet ? L.lw : Math.max(220, Math.min(maxW, L.lw - 24));
  const padX = compact ? 18 : 26, padY = compact ? 14 : 22;
  const inner = width - padX * 2;
  const avail = sheet ? L.lh * 0.78 : L.lh - (L.shortLand ? 16 : 48);
  const fH = footer ? (lastHeight.get(`${key}:f`) ?? 56) + 12 : 0;
  const artH = opts.art ? (lastHeight.get(`${key}:a`) ?? 0) : 0;
  const bodyMax = Math.max(64, avail - padY * 2 - fH - artH);
  const bh = lastHeight.get(`${key}:b`) ?? 0;
  const scrolls = bh > bodyMax + 1;
  const styles = ["panel", ...(sheet ? ["panel-sheet"] : []), ...(compact ? ["panel-compact"] : [])];
  ui.place(`scr-${key}`, { anchor: "top-start", x: 0, y: 0 }, () => {
    ui.column(`scr-${key}-box`, () => {
      ui.column(`${key}-panel`, () => {
        if (opts.art) {
          const r = ui.column(`${key}-art`, () => opts.art!(inner), { width: inner });
          lastHeight.set(`${key}:a`, r.height / L.sc + 12);
        }
        const inside = (w: number): void => {
          const r = ui.column(`${key}-body`, () => body(w), { width: w, spacing: compact ? 8 : 12, align: opts.center ? "center" : "start" });
          lastHeight.set(`${key}:b`, r.height / L.sc);
        };
        if (scrolls) ui.scrollArea(`${key}-scroll`, { width: inner, height: bodyMax }, () => inside(inner - 12));
        else inside(inner);
        if (footer) {
          const r = ui.column(`${key}-foot`, () => footer(inner), { width: inner, align: opts.center ? "center" : "start" });
          lastHeight.set(`${key}:f`, r.height / L.sc);
        }
      }, { style: styles, width, spacing: 12, align: opts.center ? "center" : "start", padding: { top: padY, bottom: padY, start: padX, end: padX } });
    }, { width: L.lw, height: L.lh, align: "center", justify: sheet ? "end" : "center" });
  }, { style: "screen", width: L.lw, height: L.lh });
}
function h2(text: string, id: string): void { ui.style("h2").id(id).heading(text); }
/** The `.row` of a panel's buttons (flex-wrap). */
function actions(key: string, list: Btn[], w: number, align: "start" | "center" = "start"): void { flow(key, list, w, align); }

function titleScreen(L: Layout): void {
  const short = L.shortLand || L.lh < 640;
  screen("title", L, (L.wide ? 32 : 30) * REM, (w) => {
    emblemWidget(short ? 64 : 108);
    ui.row("title-logo", () => {
      const cls = short ? "game-logo-compact" : null;
      ui.style("game-logo", cls).id("logo-1").label("Breeze");
      ui.style("game-logo-accent", cls).id("logo-2").label("Wing");
    }, { spacing: short ? 9 : 13, align: "end" });
    para(T("Tap to fly. Thread the gates. Chase the horizon."), w, "tagline", "tagline", true);
    const playText = bare(T("▶ Play"));
    button({
      id: "btn-play", text: T("▶ Play"), style: ["btn", "btn-primary", "btn-big"], act: openPlay,
      face: () => { ui.row("btn-play-face", () => { glyph("play", 18, "#ffffff"); ui.label(playText, { weight: "600", size: 20.8 }); }, { spacing: 8, align: "center" }); },
    });
    const cardW = (w - 10) / 2;
    const card = (id: string, title: string, sub: string, act: () => void): void => {
      button({
        id, text: title, style: ["btn", "btn-card"], act,
        face: () => {
          ui.column(`${id}-face`, () => {
            para(title, cardW - 30, "btn-card-title", undefined, true);
            para(sub, cardW - 30, "btn-card-sub", undefined, true);
          }, { align: "center", spacing: 2 });
        },
      }, cardW);
    };
    ui.row("title-row", () => {
      card("btn-daily", T("Daily Breeze"), dailyDone() ? T("done today ✓") : T("today's shared sky"), openDaily);
      const cleared = JOURNEY.filter((st: Cfg) => progress().journey[st.id]?.cleared).length;
      card("btn-journey", T("Journey"), T("{n} / {total} stages", { n: cleared, total: JOURNEY.length }), openJourney);
    }, { spacing: 10, align: "stretch" });
    flow("title-nav", [
      { id: "btn-learn", text: T("Learn"), act: openLearn },
      { id: "btn-practice", text: T("Practice"), act: openPractice },
      { id: "btn-challenge", text: T("Challenges"), act: openChallenges },
      { id: "btn-chase", text: T("Score Chase"), act: openChase },
      { id: "btn-boards", text: T("Leaderboards"), act: openBoards },
      { id: "btn-achievements", text: T("Achievements"), act: openAchievements },
      { id: "btn-help", text: T("Help"), act: () => openOverlay("help") },
      { id: "btn-settings", text: T("Settings"), act: () => openOverlay("settings") },
    ], w, "center");
    const account: Btn[] = [];
    const link = platform.inviteLink();
    if (link) {
      account.push({
        id: "btn-invite", text: T("Invite a friend"),
        act: () => {
          try { clipboard.writeText(link); toast(() => T("Invite link copied to the clipboard.")); }
          catch { toast(() => `${T("Could not copy the invite link.")} ${link}`, 6); }
        },
      });
    }
    if (!platform.signedIn()) account.push({ id: "btn-sign-in", text: T("Sign in with StarHermit"), act: () => { void requestSignIn().catch(() => undefined); } });
    if (account.length) flow("title-account", account, w, "center");
    // The profile chip: avatar, name and cloud-sync state.
    const name = platform.displayName();
    const sync = platform.syncState();
    const chip = !name ? T("Guest — progress saves locally")
      : `${name} — ${sync === "synced" ? T("cloud save synced") : sync === "saving" ? T("saving…") : T("cloud save offline")}`;
    const pic = platform.avatarCanvas();
    ui.row("profile-chip", () => {
      if (pic) ui.widget("", { role: "none", size: { width: 24, height: 24 }, draw: (r) => { draw.image(pic, r.x, r.y, r.width, r.height); } });
      para(chip, w - (pic ? 30 : 0), "profile-chip", "profile-chip", true);
    }, { spacing: 6, align: "center" });
  }, null, { title: true, center: true });
}

function setupScreen(L: Layout): void {
  const v = app.setup;
  const cfg = app.pendingConfig;
  if (!v || !cfg) { toTitle(); return; }
  screen("setup", L, (L.wide ? 32 : 30) * REM, (w) => {
    h2(cfgName(cfg), "setup-heading");
    para(v.blurb(), w, "blurb", "setup-blurb");
    const p = cfg.params;
    const bits: string[] = [];
    if (cfg.goal.type === "gates") bits.push(T("pass {n} gates", { n: cfg.goal.value }));
    if (cfg.goal.type === "survive") bits.push(T("survive {n}s", { n: Math.round(cfg.goal.value / TICKS_PER_SECOND) }));
    if (cfg.goal.type === "flaps") bits.push(T("flap {n} times", { n: cfg.goal.value }));
    if (cfg.goal.type === "endless") bits.push(T("endless flight — best score wins"));
    if (p.moveLimit > 0) bits.push(T("only {n} flaps allowed", { n: p.moveLimit }));
    if (p.oscAmp > 0) bits.push(T("moving gates"));
    const expected = cfg.parTicks > 0 ? cfg.parTicks / TICKS_PER_SECOND
      : cfg.goal.type === "survive" ? cfg.goal.value / TICKS_PER_SECOND
      : cfg.goal.type === "gates" ? (p.spacing * (cfg.goal.value + 2)) / Math.max(1, p.speed) : 0;
    const facts: [string, string][] = [
      [T("Rules"), bits.join(" · ") || T("free flight")],
      [T("Expected duration"), expected > 0 ? T("about {n}s", { n: Math.max(1, Math.round(expected / 10) * 10) }) : T("as long as you last")],
      [T("Players"), T("1 (solo)")],
      [T("Ranked"), cfg.ranked ? T("Yes — shared seed, replay-verified") : T("No — local only")],
    ];
    const cols = w >= 320 ? 2 : 1;
    const cw = (w - 18 * (cols - 1)) / cols;
    ui.grid("setup-facts", () => {
      facts.forEach(([dt, dd], i) => {
        ui.column(`fact-${i}`, () => {
          para(dt.toUpperCase(), cw, "fact-dt");
          para(dd, cw, "fact-dd", `fact-dd-${i}`);
        }, { spacing: 2, width: cw });
      });
    }, { columns: cols, gap: { row: 8, column: 18 }, width: w });
    if (v.options && v.options.length) {
      ui.column("setup-options", () => {
        for (const o of v.options!) {
          const name = T(o.name), desc = o.desc();
          button({
            id: `opt-${o.id}`, text: name, style: ["btn", "setup-option"], selected: o.id === v.selected, act: () => pickSetupOption(o.id),
            face: () => {
              ui.column(`opt-${o.id}-face`, () => {
                para(name, w - 40, "setup-option-title");
                para(desc, w - 40, "setup-option-sub");
              }, { spacing: 2, align: "start" });
            },
          }, w);
        }
      }, { spacing: 8, width: w });
    }
    const arc = !!settings.assistArc;
    const nextArc = ui.id("setup-assist-arc").checkbox(T("Show predicted flight arc (assist)"), arc);
    if (nextArc !== arc) platform.setSetting("assistArc", nextArc);
  }, (w) => {
    actions("setup-actions", [
      { id: "btn-setup-start", text: T("Start"), style: ["btn", "btn-primary"], act: beginRound },
      { id: "btn-setup-back", text: T("Back"), style: ["btn", "btn-ghost"], act: toTitle },
    ], w);
  });
}

function stageLabel(i: number): string {
  const st = JOURNEY[i];
  const rec = progress().journey[st.id];
  const cleared = !!(rec && rec.cleared);
  return T("Stage {n}: {name}", { n: i + 1, name: cfgName(st) }) + (cleared ? T(", cleared, best {score}", { score: rec.bestScore }) : "") + (st.mastery ? T(", mastery trial") : "");
}
function journeyScreen(L: Layout): void {
  screen("journey", L, (L.wide ? 52 : 44) * REM, (w) => {
    h2(T("Journey"), "journey-heading");
    para(T("Forty authored stages across five skies. Every tenth stage is a mastery trial."), w, "blurb", "journey-blurb");
    const gap = 8;
    const cols = Math.max(1, Math.floor((w + gap) / (64 + gap)));
    const cell = (w - gap * (cols - 1)) / cols;
    const p = progress();
    const current = JOURNEY.findIndex((st: Cfg) => !(p.journey[st.id] && p.journey[st.id].cleared));
    ui.column("journey-grid", () => {
      for (let i = 0; i < JOURNEY.length; i += cols) {
        ui.row(`jrow-${i}`, () => {
          for (let k = i; k < Math.min(JOURNEY.length, i + cols); k++) {
            const st = JOURNEY[k];
            const rec = p.journey[st.id];
            const cleared = !!(rec && rec.cleared);
            const sub = cleared ? String(rec.bestScore) : T(st.name.replace("Mastery: ", "").replace(/ \d+$/, "")).split(" ")[0]!;
            const styles = ["jstage", ...(st.mastery ? ["jstage-mastery"] : []), ...(cleared ? ["jstage-done"] : []), ...(k === current ? ["jstage-current"] : [])];
            const clicked = ui.style(...styles, { width: cell, height: cell }).id(`jstage-${k + 1}`).button(stageLabel(k), {
              content: () => {
                ui.column(`jstage-${k + 1}-face`, () => {
                  if (st.mastery) glyph("star", 18, "#1d2733");
                  else ui.label(String(k + 1), { weight: "700" });
                  if (textWidth(sub, "jstage-sub") <= cell - 10) ui.style("jstage-sub").label(sub);
                }, { align: "center", spacing: 1 });
              },
            });
            if (clicked) openSetup(st);
          }
        }, { spacing: gap });
      }
    }, { spacing: gap, width: w });
  }, (w) => {
    actions("journey-actions", [{ id: "btn-journey-back", text: T("Back"), style: ["btn", "btn-ghost"], act: toTitle }], w);
  });
}

function countdownScreen(L: Layout): void {
  const prompt = app.countdownPrompt ? app.countdownPrompt() : "";
  ui.place("countdown", { anchor: "top-start", x: 0, y: 0 }, () => {
    if (app.countdownText) ui.style("countdown", L.shortLand ? "countdown-compact" : null).id("countdown-text").label(T(app.countdownText));
    para(prompt, Math.min(L.lw - 32, 70 * 9), "countdown-prompt", "countdown-prompt", true);
  }, { width: L.lw, height: L.lh, align: "center", justify: "center", spacing: 8 });
}

function pauseScreen(L: Layout): void {
  screen("pause", L, (L.wide ? 32 : 30) * REM, (w) => {
    h2(T("Paused"), "pause-heading");
    ui.column("pause-stack", () => {
      button({ id: "btn-resume", text: T("Resume"), style: ["btn", "btn-primary"], act: resume }, w);
      button({ id: "btn-pause-settings", text: T("Settings"), act: () => openOverlay("settings") }, w);
      button({ id: "btn-pause-help", text: T("Help"), act: () => openOverlay("help") }, w);
      button({ id: "btn-pause-restart", text: T("Restart"), act: retry }, w);
      button({ id: "btn-leave", text: T("Leave round"), style: ["btn", "btn-ghost"], act: leaveRound }, w);
    }, { spacing: 8, width: w });
  }, null);
}

function resultsScreen(L: Layout): void {
  const res = app.results;
  if (!res) { toTitle(); return; }
  const { s, won, cfg } = res;
  const showArt = !L.shortLand && L.lh >= 600;
  screen("results", L, (L.wide ? 32 : 30) * REM, (w) => {
    h2(won ? T("Clear skies!") : T("Flight ended"), "results-heading");
    const reasonKey: Record<string, string> = {
      floor: "You met the sea.", ceiling: "You clipped the sky.", gate: "A gate edge caught your wing.",
      "move-limit": "Out of flaps — so close!", "time-up": "Time ran out.",
      cleared: cfg.mode === "learn" ? "Lesson complete!" : "Every gate threaded.", abandon: "You headed home early.",
    };
    const parts = [T(reasonKey[s.terminal ? s.terminal.reason : "abandon"]!)];
    parts.push(...res.extras.map((e) => T(e)));
    const best = progress().best[cfg.id];
    if (best) parts.push(T("Best here: {n}", { n: best }));
    para(parts.join(" "), w, "blurb", "results-sub");
    const rows: [string, string, number][] = [
      [T("Gates passed"), String(s.gatesPassed), s.score.gates],
      [T("Centered bonuses"), String(s.centeredPasses), s.score.center],
      [T("Streak bonuses"), T("best ×{n}", { n: s.bestStreak }), s.score.streak],
      [T("Time bonus"), "", s.score.time],
    ];
    const ptsW = Math.max(56, textWidth(String(s.score.total), "bd-total") + 12);
    const midW = Math.max(48, ...rows.map((r) => textWidth(r[1], "bd-td") + 10));
    const thW = w - ptsW - midW - 8;
    ui.grid("breakdown", () => {
      for (const [th, td, pts] of rows) {
        para(th, thW, "bd-th");
        ui.style("bd-td").label(td);
        ui.style("bd-pts").label(String(pts));
      }
      ui.gridRow("bd-total-row").style("bd-total").label(T("Total"));
      ui.style("bd-td").label("");
      ui.style("bd-total", { text: { align: "end" } }).id("bd-total").label(String(s.score.total));
    }, { columns: [{ width: thW }, { width: midW }, { fr: 1, align: "end" }], gap: 0, width: w });
    if (res.earned.length) {
      ui.row("results-achievements", () => {
        glyph("medal", 18, GOLD);
        para(T("Unlocked: {list}", { list: res.earned.map((a) => T(a.name)).join(" · ") }), w - 52, null, "earned-text");
      }, { style: "earned", spacing: 6, align: "center", width: w });
    }
    para(T(cfg.ranked ? "Ranked round — replay recorded for verification." : "Unranked — practice never affects rating."), w, "blurb", "results-board");
    if (res.lb) {
      const lb = res.lb;
      para(lb.pending ? T("Posting score to the leaderboard…") : !lb.posted ? T("Score not posted to the leaderboard.")
        : lb.rank ? T("Leaderboard rank: #{rank}", { rank: lb.rank }) : T("Score posted to the leaderboard."), w, "blurb", "results-lb");
    }
  }, (w) => {
    const list: Btn[] = [{ id: "btn-retry", text: T("Retry"), style: ["btn", "btn-primary"], act: retry }];
    if (res.next) {
      const label = res.nextLabel === "journey" ? `${T("Next: {name}", { name: cfgName(res.next) })} →` : `${T("Next lesson")} →`;
      list.push({ id: "btn-next", text: label, act: next });
    }
    list.push({ id: "btn-results-menu", text: T("Menu"), style: ["btn", "btn-ghost"], act: toTitle });
    actions("results-actions", list, w);
  }, showArt ? { art: (pw) => horizonWidget(pw, L.narrow ? 96 : 120) } : {});
}

/** An action's keys as the Help cards show them (Space / ↑ / W), from the player's bindings. */
const KEY_NAMES: Record<string, string> = { Space: "Space", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Escape: "Esc" };
function keyChips(action: string): string[] {
  return bindings(action).filter((b) => b.device === "keyboard").map((b) => KEY_NAMES[b.code] ?? b.label);
}
function kbdRow(id: string, keys: string[], after: string, w: number): void {
  ui.row(id, () => {
    for (const k of keys) ui.style("kbd").label(k);
    if (after) ui.style("rule-p").label(after);
  }, { spacing: 4, align: "center" });
  void w;
}
function helpScreen(L: Layout): void {
  screen("help", L, (L.wide ? 52 : 44) * REM, (w) => {
    h2(T("How to play"), "help-heading");
    const gap = 10;
    const cols = Math.max(1, Math.floor((w + gap) / (200 + gap)));
    const cw = (w - gap * (cols - 1)) / cols;
    const ci = cw - 32;
    const cards: { id: string; title: string; build: () => void }[] = [
      { id: "one", title: T("One button"), build: () => {
        kbdRow("keys-flap", keyChips("flap"), "", ci);
        para(T("— or click, or tap — to flap. Each flap gives instant lift. That is the whole control scheme."), ci, "rule-p");
      } },
      { id: "gates", title: T("Gates"), build: () => para(T("Pillars drift toward you. Pass through the glowing gap. Touching an edge, the sky ceiling, or the sea ends the flight."), ci, "rule-p") },
      { id: "scoring", title: T("Scoring"), build: () => para(plain(T("Each gate: <strong>100</strong>. Near-center pass: up to <strong>+50</strong>. Consecutive centered passes build a streak worth up to <strong>+100</strong> per gate. Finish under par for a time bonus.")), ci, "rule-p") },
      { id: "keyboard", title: T("Keyboard"), build: () => {
        kbdRow("keys-pause", keyChips("pause"), T("pause"), ci);
        kbdRow("keys-undo", keyChips("undo"), T("undo (practice)"), ci);
        kbdRow("keys-restart", keyChips("restart"), T("restart"), ci);
        kbdRow("keys-help", keyChips("help"), T("help"), ci);
        para(plain(T("menus work with <kbd>Tab</kbd> and <kbd>Enter</kbd>.")), ci, "rule-p");
      } },
      { id: "gamepad", title: T("Gamepad"), build: () => para(plain(T("<kbd>A</kbd>/<kbd>Cross</kbd> flaps, <kbd>Start</kbd> pauses, shoulder buttons and D-pad navigate menus.")), ci, "rule-p") },
      { id: "fair", title: T("Fair play"), build: () => para(T("Every round is seeded and replayable. Daily skies are identical for everyone on the same UTC day. Assists are declared with your score."), ci, "rule-p") },
    ];
    ui.column("rule-cards", () => {
      for (let i = 0; i < cards.length; i += cols) {
        ui.row(`rule-row-${i}`, () => {
          for (const c of cards.slice(i, i + cols)) {
            ui.column(`rule-${c.id}`, () => { ui.style("rule-h3").heading(c.title); c.build(); }, { style: "rule-card", width: cw, spacing: 6 });
          }
        }, { spacing: gap, align: "stretch" });
      }
    }, { spacing: gap, width: w });
  }, (w) => {
    actions("help-actions", [{ id: "btn-help-back", text: T("Back"), style: ["btn", "btn-ghost"], act: closeOverlay }], w);
  });
}

function settingsScreen(L: Layout): void {
  screen("settings", L, (L.wide ? 52 : 44) * REM, (w) => {
    h2(T("Settings"), "settings-heading");
    const gap = 14;
    const cols = w >= 2 * 220 + gap ? 2 : 1;
    const fw = (w - gap * (cols - 1)) / cols;
    const fi = fw - 32;
    const check = (key: string, label: string): void => {
      const cur = !!settings[key];
      const nextV = ui.id(`set-${key}`).checkbox(label, cur);
      if (nextV !== cur) platform.setSetting(key, nextV);
    };
    const fieldset = (id: string, legend: string, build: () => void): void => {
      ui.column(id, () => { ui.style("legend").label(legend); build(); }, { style: "fieldset", width: fw, spacing: 6 });
    };
    ui.row("settings-grid", () => {
      fieldset("fs-display", T("Display"), () => {
        para(T("Color palette"), fi, "body-text");
        const names = [T("Default"), T("Deuteranopia-safe"), T("Protanopia-safe"), T("Tritanopia-safe")];
        const idx = Math.max(0, PALETTES.indexOf(String(settings.colorPalette)));
        const nextIdx = ui.id("set-palette").select(T("Color palette"), idx, names);
        if (nextIdx !== idx) platform.setSetting("colorPalette", PALETTES[nextIdx]!);
      });
      if (cols === 1) return;
      fieldset("fs-access", T("Accessibility & controls"), () => {
        check("leftHanded", T("Left-handed layout"));
        check("assistArc", T("Predicted flight arc (timing assist)"));
        check("haptics", T("Haptics on supported devices"));
        button({ id: "btn-replay-tutorial", text: T("Replay tutorial"), act: replayTutorial }, Math.min(fi, buttonWidth(T("Replay tutorial"), PLAIN)));
      });
    }, { spacing: gap, align: "stretch" });
    if (cols === 1) {
      fieldset("fs-access", T("Accessibility & controls"), () => {
        check("leftHanded", T("Left-handed layout"));
        check("assistArc", T("Predicted flight arc (timing assist)"));
        check("haptics", T("Haptics on supported devices"));
        button({ id: "btn-replay-tutorial", text: T("Replay tutorial"), act: replayTutorial }, Math.min(fi, buttonWidth(T("Replay tutorial"), PLAIN)));
      });
    }
    // Sound, graphics, language, key bindings, text size, contrast and reduced motion are the runtime's Options.
    para(T("Sound, graphics, language, controls, text size, high contrast and reduced motion are in the StarHermit Options."), w, "blurb", "options-note");
    button({ id: "btn-options", text: T("Open Options"), act: () => openMenu() }, Math.min(w, buttonWidth(T("Open Options"), PLAIN)));
  }, (w) => {
    actions("settings-actions", [{ id: "btn-settings-back", text: T("Back"), style: ["btn", "btn-ghost"], act: closeOverlay }], w);
  });
}

function achievementsScreen(L: Layout): void {
  screen("achievements", L, (L.wide ? 32 : 30) * REM, (w) => {
    h2(T("Achievements"), "ach-heading");
    const p = progress();
    ui.column("ach-list", () => {
      for (const a of ACHIEVEMENTS) {
        const at = p.achievements[a.key];
        ui.column(`ach-${a.key}`, () => {
          ui.row(`ach-${a.key}-name`, () => {
            if (at) glyph("medal", 16, GOLD);
            else ui.style("ach-name").label("○");
            para(T(a.name), w - 60, "ach-name");
          }, { spacing: 6, align: "center" });
          para(T(a.desc), w - 32, "ach-desc");
          if (at) para(T("Unlocked {date}", { date: String(at).slice(0, 10) }), w - 32, "ach-date");
        }, { style: at ? ["ach-item", "ach-item-unlocked"] : "ach-item", width: w, spacing: 2 });
      }
    }, { spacing: 8, width: w });
  }, (w) => {
    actions("ach-actions", [{ id: "btn-ach-back", text: T("Back"), style: ["btn", "btn-ghost"], act: toTitle }], w);
  });
}

function boardsScreen(L: Layout): void {
  const b = app.board;
  screen("boards", L, (L.wide ? 32 : 30) * REM, (w) => {
    h2(T("Leaderboards"), "boards-heading");
    const tab = (id: "global" | "friends" | "local", text: string): Btn => ({ id: `board-${id}`, text, style: ["btn", "btn-tab"], selected: b.tab === id, act: () => loadBoard(id) });
    flow("board-tabs", [tab("global", T("Global")), tab("friends", T("Friends")), tab("local", T("This device"))], w);
    if (b.note) para(T(b.note), w, "blurb", "board-note");
    ui.column("board-list", () => {
      if (b.entries === null) return;
      if (!b.entries.length) { para(T("No scores yet — be the first breeze."), w, "board-row", "board-empty"); return; }
      b.entries.slice(0, 20).forEach((e, i) => {
        const cls = e.you ? "board-you" : "board-row";
        const sw = textWidth(String(e.score), cls) + 8;
        ui.row(`board-${i}`, () => {
          para(`${i + 1}. ${e.name || T("Pilot")}`, w - sw - 12, cls);
          ui.spacer();
          ui.style(cls, { text: { weight: "700" } }).label(String(e.score));
        }, { width: w, align: "center" });
      });
    }, { spacing: 0, width: w });
  }, (w) => {
    actions("boards-actions", [{ id: "btn-boards-back", text: T("Back"), style: ["btn", "btn-ghost"], act: toTitle }], w);
  });
}

function awayScreen(L: Layout): void {
  const snap = app.awaySnap;
  if (!snap) { toTitle(); return; }
  const st = snap.state as State;
  screen("away", L, (L.wide ? 32 : 30) * REM, (w) => {
    h2(T("Welcome back"), "away-heading");
    para(T("While you were away: your {name} flight was kept safe — {gates} gates, score {score}, {secs}s in. The sky waited for you.", {
      name: cfgName(snap.rawConfig || snap.config), gates: st.gatesPassed, score: st.score.total, secs: Math.round(st.tick / TICKS_PER_SECOND),
    }), w, "blurb", "away-summary");
  }, (w) => {
    actions("away-actions", [
      { id: "btn-away-continue", text: T("Continue flight"), style: ["btn", "btn-primary"], act: continueAway },
      { id: "btn-away-restart", text: T("Start over"), style: ["btn", "btn-ghost"], act: restartAway },
    ], w);
  });
}
