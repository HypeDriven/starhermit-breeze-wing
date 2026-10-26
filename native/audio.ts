// Sound, as the browser build's js/audio.js: the authored one-shots
// (sfx/<name>.opus, the event table of sfx/manifest.json) per logical event,
// the theme's authored 12 s ambience loop (wind by day, the night hush on
// Starlit Drift) faded in under a round, and the sparse adaptive music — a
// 300 ms grid with a low root drone every eight steps and A-minor-pentatonic
// triangle notes at a probability that rises with danger. Every audible event
// also prints a bracketed caption (at most one each 400 ms).
//
// The browser build's four buses become the runtime's (Options › Audio owns
// the volumes, the mute and the voice limit): music → "music", effects and
// ambience → "effects", the cues (countdown beeps, the invalid bonk) and the
// UI click → "interface". The old default bus levels (music 60 %, effects
// 80 %, ambience 50 %, cues 70 %) are folded into each sound's gain. The
// music's notes are rendered once into clips (createClip) with the same
// envelopes; the procedural stand-ins the browser build played while a clip
// decoded, and its filtered-noise wind bed, are not ported: the engine's
// browser runtime drops clip loads and plays while a synthesis graph changes
// (the arrow-exodus port's finding). Clips load once the mixer runs
// (natively at once, in a browser after the first press), one at a time.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Bus, type Sound } from "starhermit:audio";
import { createRng } from "../js/rules.js";

/** Marks an English caption key (translated by the caption listener). */
const N = (s: string): string => s;
const LEVEL = { music: 0.6, effects: 0.8, ambience: 0.5, voice: 0.7 };
/** Logical event key → authored sample basename (sfx/manifest.json's event → name). */
const SAMPLES: Record<string, string> = {
  flap: "flap-whoosh", start: "takeoff-rise", pass: "gate-pass-chime", centered: "centered-sparkle",
  "terminal:cleared": "clear-fanfare", "terminal:time-up": "time-up-fanfare", "terminal:crash": "crash-thud",
  invalid: "invalid-buzz", ui: "ui-tick", countdown: "countdown-beep", "countdown:final": "countdown-go",
  achievement: "achievement-sparkle", undo: "undo-rewind", streak: "streak-rise", best: "best-sting",
};
const AMBIENCE: Record<string, string> = { day: "ambience-wind", night: "ambience-night" };
const VOICE = new Set(["invalid", "countdown", "countdown:final", "ui"]);

export interface Detail { reason?: string; final?: boolean; streak?: number }
const clips = new Map<string, AudioClip>();
const queue: string[] = [];
let loading = false;
let wantClips = false;
let onCaption: ((key: string, vars: Record<string, string | number>) => void) | null = null;
let lastCaption = -1e9;

function load(name: string): void { if (!queue.includes(name) && !clips.has(name)) queue.push(name); }
function pump(): void {
  if (loading || !queue.length) return;
  const name = queue.shift()!;
  loading = true;
  loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => { console.warn(`sfx ${name}: ${String(e)}`); loading = false; });
}
/** Asks for the clips; they load once the mixer runs (see update). */
export function loadSfx(): void { wantClips = true; }
/** cb(captionKey, vars) for each captioned event (an English caption key, translated by the caller). */
export function setOnCaption(cb: (key: string, vars: Record<string, string | number>) => void): void { onCaption = cb; }

function keyFor(type: string, d: Detail): string {
  if (type === "terminal") return d.reason === "cleared" ? "terminal:cleared" : d.reason === "time-up" ? "terminal:time-up" : "terminal:crash";
  if (type === "countdown") return d.final ? "countdown:final" : "countdown";
  return type;
}
function caption(type: string, d: Detail): void {
  const map: Record<string, string> = {
    flap: N("[whoosh]"), pass: N("[chime: gate passed]"), centered: N("[bright chime: centered pass]"),
    terminal: d.reason === "cleared" ? N("[fanfare: stage clear]") : d.reason === "time-up" ? N("[jingle: time up]") : N("[thud: flight ended]"),
    invalid: N("[low buzz: action unavailable]"), countdown: d.final ? N("[beep: go]") : N("[beep]"),
    achievement: N("[sparkle: achievement unlocked]"), start: N("[rising tone: takeoff]"), undo: N("[soft rewind]"),
    streak: N("[rising bells: streak {n}]"), best: N("[warm sting: new personal best]"),
  };
  const key = map[type];
  if (!key || !onCaption) return;
  const now = context.currentTime > 0 ? context.currentTime : Date.now() / 1000;
  if (now - lastCaption < 0.4) return;
  lastCaption = now;
  onCaption(key, { n: d.streak ?? "" });
}

/** Plays a logical event's sample (when loaded) and emits its caption. */
export function event(type: string, detail: Detail = {}): void {
  caption(type, detail);
  const key = keyFor(type, detail);
  const file = SAMPLES[key];
  const clip = file ? clips.get(file) : undefined;
  if (!clip) return;
  const voice = VOICE.has(key);
  const bus: Bus = voice ? "interface" : "effects";
  try { playClip(clip, { bus, gain: voice ? LEVEL.voice : LEVEL.effects }); }
  catch { clips.delete(file!); load(file!); } // a clip the mixer lost: load it again
}

// -- adaptive music ----------------------------------------------------------------------
const RATE = 11025;
const ROOT = 220;
const DEGREES = [0, 3, 5, 7, 10]; // minor pentatonic
const notes = new Map<string, AudioClip>();
/** js/audio.js _tone(): an exponential attack to `peak`, an exponential decay to 0.0001 (peak 1 here, gain at play). */
function toneClip(freq: number, type: "sine" | "triangle", attack: number, decay: number): AudioClip {
  const n = Math.round((attack + decay + 0.05) * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const env = t < attack ? 0.0001 * Math.pow(1 / 0.0001, t / attack) : t < attack + decay ? Math.pow(0.0001, (t - attack) / decay) : 0;
    const ph = (freq * t) % 1;
    const w = type === "sine" ? Math.sin(2 * Math.PI * freq * t) : 4 * Math.abs(ph - 0.5) - 1;
    out[i] = w * env;
  }
  return createClip([out], RATE);
}
const NOTE_LIST: [string, number, "sine" | "triangle", number, number][] = [
  ["drone", ROOT / 2, "sine", 0.02, 0.9],
  ...DEGREES.flatMap((d) => [0, 12].map((o) => [`n${d + o}`, ROOT * Math.pow(2, (d + o) / 12), "triangle", 0.01, 0.5] as [string, number, "triangle", number, number])),
];
let rng = createRng(0xbeef);
let musicOn = false;
let intensity = 0.3;
let stepN = 0;
let nextStep = 0;
let nextRender = 0;
let paused = false;

/** Seeds the cosmetic variant stream (never affects rules). */
export function reseed(seed: number): void { rng = createRng((seed ^ 0xa0d10) >>> 0); }
export function startMusic(): void { if (!musicOn) { musicOn = true; stepN = 0; nextStep = 0; } }
export function stopMusic(): void { musicOn = false; }
export function setMusicIntensity(v: number): void { intensity = Math.max(0, Math.min(1, v)); }

// -- ambience -------------------------------------------------------------------------------
let ambienceKind: string | null = null;
let ambience: Sound | null = null;
export function startAmbience(theme: string): void {
  const kind = theme === "night" ? "night" : "day";
  if (ambienceKind === kind && ambience) return;
  stopAmbience();
  ambienceKind = kind;
}
export function stopAmbience(): void {
  ambienceKind = null;
  if (ambience) { try { ambience.stop(); } catch { /* gone */ } }
  ambience = null;
}
/** Pause and a hidden window: music holds and the ambience fades out (the browser build ducked its master). */
export function setPaused(on: boolean): void {
  paused = on;
  if (!ambience) return;
  try { ambience.fade(on ? 0 : 0.9 * LEVEL.ambience, 0.3); } catch { ambience = null; }
}

/** Each frame: the clips once the mixer runs (one at a time), the music's notes
 * one a half second after them, the ambience once its clip is in, then the
 * music's next steps by mixer time. */
export function update(): void {
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    for (const name of new Set([...Object.values(SAMPLES), ...Object.values(AMBIENCE)])) load(name);
    return;
  }
  pump();
  if (loading || queue.length) return;
  try {
    if (context.currentTime >= nextRender) {
      for (const [k, f, type, a, d] of NOTE_LIST) {
        if (!notes.has(k)) { notes.set(k, toneClip(f, type, a, d)); nextRender = context.currentTime + 0.5; return; }
      }
    }
    if (ambienceKind && !ambience) {
      const clip = clips.get(AMBIENCE[ambienceKind] ?? "");
      if (clip) {
        ambience = playClip(clip, { bus: "effects", gain: 0.0001, loop: true });
        ambience.fade(paused ? 0 : 0.9 * LEVEL.ambience, 2.5);
      }
    }
  } catch (e) { console.warn(`audio: ${String(e)}`); return; }
  if (!musicOn || paused) return;
  const now = context.currentTime;
  if (now < nextStep) return;
  nextStep = Math.max(now, nextStep) + 0.3;
  const deg = DEGREES[Math.floor(rng.next() * DEGREES.length)]! + (rng.next() < 0.25 ? 12 : 0);
  if (stepN % 8 === 0) {
    const drone = notes.get("drone");
    if (drone) { try { playClip(drone, { bus: "music", gain: 0.1 * LEVEL.music }); } catch { /* the mixer is full */ } }
  }
  if (rng.next() < 0.35 + intensity * 0.4) {
    const clip = notes.get(`n${deg}`);
    if (clip) { try { playClip(clip, { bus: "music", gain: (0.05 + intensity * 0.04) * LEVEL.music }); } catch { /* full */ } }
  }
  stepN++;
}
