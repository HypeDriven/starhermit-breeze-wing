/**
 * Breeze Wing — audio module.
 * Original procedural WebAudio: short transients tied to logical events,
 * layered impacts, quiet ambience, adaptive music stems. Independent buses:
 * music / effects / ambience / voice(ui cues). Seeded variant selection so
 * recorded sessions sound consistent. Authored one-shots (sfx/*.opus, see
 * sfx/manifest.json) are preferred per event once lazy-loaded after unlock;
 * the procedural synthesis below remains the fallback while clips load or
 * when a clip is unavailable.
 */

import { createRng } from './rules.js';

const AUTHORED_SFX_BY_EVENT = Object.freeze({
  flap: 'flap-whoosh',
  start: 'takeoff-rise',
  pass: 'gate-pass-chime',
  centered: 'centered-sparkle',
  'terminal:cleared': 'clear-fanfare',
  'terminal:time-up': 'time-up-fanfare',
  'terminal:crash': 'crash-thud',
  invalid: 'invalid-buzz',
  ui: 'ui-tick',
  countdown: 'countdown-beep',
  'countdown:final': 'countdown-go',
  achievement: 'achievement-sparkle',
  undo: 'undo-rewind',
  streak: 'streak-rise',
  best: 'best-sting',
  'ambience:day': 'ambience-wind',
  'ambience:night': 'ambience-night',
});

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buses = {};
    this.volumes = { music: 0.6, effects: 0.8, ambience: 0.5, voice: 0.7 };
    this.muted = false;
    this.enabled = true;
    this._rng = createRng(0xbeef);
    this._musicTimer = null;
    this._ambNodes = null;
    this._captionSink = null; // (text) => void — accessibility text cues
    this._lastCaption = 0;
    this._sfxManifest = null; // Promise — fetch of sfx/manifest.json, started at unlock
    this._sfxMap = new Map(Object.entries(AUTHORED_SFX_BY_EVENT)); // eventKey -> clipName
    this._sfxBuffers = new Map(); // clipName -> AudioBuffer
    this._sfxPending = new Map(); // clipName -> in-flight fetch/decode Promise
    this._sfxFailed = new Set();  // clipName that failed to load (keep synth fallback)
  }

  /** Must be called from a user gesture. Safe to call repeatedly. */
  unlock() {
    if (!this.enabled) return;
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { this.enabled = false; return; }
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.connect(this.ctx.destination);
        for (const name of ['music', 'effects', 'ambience', 'voice']) {
          const g = this.ctx.createGain();
          g.gain.value = this.muted ? 0 : this.volumes[name];
          g.connect(this.master);
          this.buses[name] = g;
        }
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      this._ensureSfxManifest();
    } catch {
      this.enabled = false;
    }
  }

  /* ------------------- authored one-shot samples ---------------------- */

  /** Start loading the sample manifest. Only runs after the gesture unlock. */
  _ensureSfxManifest() {
    if (this._sfxManifest || !this.ctx || typeof fetch !== 'function') return;
    this._sfxManifest = fetch('sfx/manifest.json')
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => {
        const map = new Map(Object.entries(AUTHORED_SFX_BY_EVENT));
        if (Array.isArray(list)) {
          for (const e of list) {
            if (e && typeof e.name === 'string' && typeof e.event === 'string') {
              map.set(e.event, e.name);
            }
          }
        }
        this._sfxMap = map;
        return map;
      })
      .catch(() => { this._sfxMap = new Map(Object.entries(AUTHORED_SFX_BY_EVENT)); });
  }

  /** Runtime event map key: existing event names, with terminal/countdown split by detail. */
  _sfxKeyFor(type, detail) {
    if (type === 'terminal') {
      if (detail.reason === 'cleared') return 'terminal:cleared';
      if (detail.reason === 'time-up') return 'terminal:time-up';
      return 'terminal:crash';
    }
    if (type === 'countdown') return detail.final ? 'countdown:final' : 'countdown';
    return type;
  }

  /**
   * Prefer the mapped authored sample for an event. Returns true when a
   * decoded clip actually played; otherwise kicks off the lazy load and
   * returns false so the caller falls back to procedural synthesis.
   */
  _trySample(type, detail) {
    if (!this._sfxMap || !this.ctx) return false;
    const name = this._sfxMap.get(this._sfxKeyFor(type, detail));
    if (!name) return false;
    const buf = this._sfxBuffers.get(name);
    if (!buf) { this._loadSample(name); return false; }
    try {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.buses.effects);
      src.start();
      return true;
    } catch { return false; }
  }

  /** Lazy fetch+decode. Resolves to the AudioBuffer, or null when unavailable. */
  _loadSample(name) {
    if (!this.ctx || this._sfxFailed.has(name)) return Promise.resolve(null);
    if (this._sfxBuffers.has(name)) return Promise.resolve(this._sfxBuffers.get(name));
    if (this._sfxPending.has(name)) return this._sfxPending.get(name);
    const p = fetch(`sfx/${name}.opus`)
      .then((r) => { if (!r.ok) throw new Error(`http-${r.status}`); return r.arrayBuffer(); })
      .then((ab) => this.ctx.decodeAudioData(ab))
      .then((buf) => { this._sfxBuffers.set(name, buf); return buf; })
      .catch(() => { this._sfxFailed.add(name); return null; })
      .finally(() => { this._sfxPending.delete(name); });
    this._sfxPending.set(name, p);
    return p;
  }

  setCaptionSink(fn) { this._captionSink = fn; }

  _caption(text) {
    const now = performance.now();
    if (this._captionSink && now - this._lastCaption > 400) {
      this._lastCaption = now;
      this._captionSink(text);
    }
  }

  setVolume(bus, v) {
    this.volumes[bus] = Math.max(0, Math.min(1, v));
    if (this.buses[bus] && !this.muted) {
      this.buses[bus].gain.setTargetAtTime(this.volumes[bus], this.ctx.currentTime, 0.05);
    }
  }

  setMuted(m) {
    this.muted = !!m;
    if (!this.ctx) return;
    for (const [name, g] of Object.entries(this.buses)) {
      g.gain.setTargetAtTime(this.muted ? 0 : this.volumes[name], this.ctx.currentTime, 0.03);
    }
  }

  /** Seed the cosmetic variant stream (never affects rules). */
  reseedVariants(seed) { this._rng = createRng((seed ^ 0xa0d10) >>> 0); }

  /* ------------------------- synth primitives ------------------------- */

  _env(gain, t0, a, peak, d) {
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), t0 + a);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
  }

  _tone(bus, { freq = 440, freqEnd = null, type = 'sine', attack = 0.005, decay = 0.15, gain = 0.3, delay = 0 }) {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (freqEnd) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t0 + attack + decay);
    this._env(g, t0, attack, gain, decay);
    osc.connect(g); g.connect(this.buses[bus]);
    osc.start(t0); osc.stop(t0 + attack + decay + 0.05);
  }

  _noise(bus, { dur = 0.12, gain = 0.2, freq = 1200, q = 1, delay = 0, type = 'bandpass' }) {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime + delay;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    const r = this._rng;
    for (let i = 0; i < len; i++) d[i] = (r.next() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = this.ctx.createGain();
    this._env(g, t0, 0.004, gain, dur);
    src.connect(f); f.connect(g); g.connect(this.buses[bus]);
    src.start(t0);
  }

  /* --------------------------- event mapping -------------------------- */

  /** Map logical rules/UI events to sound. Event hierarchy respected. */
  event(type, detail = {}) {
    if (!this.ctx || this.muted || !this.enabled) { this._captionFor(type, detail); return; }
    // Prefer the authored clip; procedural synthesis covers loading/failure.
    if (this._trySample(type, detail)) { this._captionFor(type, detail); return; }
    const v = 0.94 + this._rng.next() * 0.12; // seeded pitch variant
    switch (type) {
      case 'flap':
        this._noise('effects', { dur: 0.09, gain: 0.16, freq: 900 * v, q: 1.4 });
        this._tone('effects', { freq: 520 * v, freqEnd: 760 * v, type: 'triangle', attack: 0.004, decay: 0.08, gain: 0.10 });
        break;
      case 'start':
        this._tone('effects', { freq: 392, freqEnd: 784, type: 'sine', attack: 0.01, decay: 0.25, gain: 0.22 });
        break;
      case 'pass':
        this._tone('effects', { freq: 660 * v, type: 'sine', attack: 0.006, decay: 0.14, gain: 0.2 });
        this._tone('effects', { freq: 990 * v, type: 'sine', attack: 0.006, decay: 0.18, gain: 0.16, delay: 0.05 });
        break;
      case 'centered':
        this._tone('effects', { freq: 880 * v, type: 'sine', attack: 0.005, decay: 0.12, gain: 0.18 });
        this._tone('effects', { freq: 1320 * v, type: 'sine', attack: 0.005, decay: 0.2, gain: 0.14, delay: 0.06 });
        break;
      case 'terminal': {
        const reason = detail.reason;
        if (reason === 'cleared' || reason === 'time-up') {
          // round completion fanfare (highest tier)
          const seq = [523, 659, 784, 1047];
          seq.forEach((f, i) => this._tone('effects', { freq: f, type: 'triangle', attack: 0.01, decay: 0.3, gain: 0.2, delay: i * 0.09 }));
        } else {
          this._noise('effects', { dur: 0.3, gain: 0.3, freq: 300, q: 0.8, type: 'lowpass' });
          this._tone('effects', { freq: 220, freqEnd: 60, type: 'sawtooth', attack: 0.005, decay: 0.35, gain: 0.16 });
        }
        break;
      }
      case 'invalid':
        this._tone('voice', { freq: 180, type: 'square', attack: 0.004, decay: 0.08, gain: 0.08 });
        break;
      case 'ui':
        this._tone('effects', { freq: 700 * v, type: 'sine', attack: 0.003, decay: 0.05, gain: 0.08 });
        break;
      case 'countdown':
        this._tone('voice', { freq: detail.final ? 880 : 440, type: 'sine', attack: 0.005, decay: 0.12, gain: 0.2 });
        break;
      case 'achievement':
        [784, 988, 1175].forEach((f, i) => this._tone('effects', { freq: f, type: 'sine', attack: 0.008, decay: 0.25, gain: 0.16, delay: i * 0.07 }));
        break;
      case 'undo':
        this._tone('effects', { freq: 500, freqEnd: 300, type: 'sine', attack: 0.004, decay: 0.1, gain: 0.1 });
        break;
      case 'streak': {
        // Escalating three-note run; pitch climbs with the streak length (capped).
        const lift = Math.min(6, (detail.streak || 3) - 3) * 40;
        [880, 1109, 1319].forEach((f, i) => this._tone('effects', { freq: (f + lift) * v, type: 'sine', attack: 0.004, decay: 0.14, gain: 0.14, delay: i * 0.055 }));
        break;
      }
      case 'best':
        this._tone('effects', { freq: 392, freqEnd: 784, type: 'triangle', attack: 0.02, decay: 0.35, gain: 0.16 });
        this._tone('effects', { freq: 1568, type: 'sine', attack: 0.006, decay: 0.4, gain: 0.12, delay: 0.3 });
        break;
      default: break;
    }
    this._captionFor(type, detail);
  }

  _captionFor(type, detail) {
    const map = {
      flap: 'whoosh', pass: 'chime: gate passed', centered: 'bright chime: centered pass',
      terminal: detail.reason === 'crash' ? 'thud: flight ended'
        : detail.reason === 'time-up' ? 'jingle: time up' : 'fanfare: stage clear',
      invalid: 'low buzz: action unavailable', countdown: detail.final ? 'beep: go' : 'beep',
      achievement: 'sparkle: achievement unlocked', start: 'rising tone: takeoff', undo: 'soft rewind',
      streak: `rising bells: streak ${detail.streak || ''}`.trim(), best: 'warm sting: new personal best',
    };
    if (map[type]) this._caption(`[${map[type]}]`);
  }

  /* ------------------- ambience + adaptive music ---------------------- */

  startAmbience(theme = 'day') {
    if (!this.ctx || this._ambNodes) return;
    try {
      // Quiet filtered-noise wind bed.
      const len = this.ctx.sampleRate * 2;
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      let last = 0;
      const r = this._rng;
      for (let i = 0; i < len; i++) { last = last * 0.98 + (r.next() * 2 - 1) * 0.02; d[i] = last * 3; }
      const src = this.ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = theme === 'night' ? 220 : 400;
      const g = this.ctx.createGain(); g.gain.value = 0.5;
      src.connect(f); f.connect(g); g.connect(this.buses.ambience);
      src.start();
      this._ambNodes = { src, g, loop: null, loopGain: null };
      this._startAuthoredAmbience(theme, this._ambNodes);
    } catch { /* ambience is optional */ }
  }

  /**
   * Cross-fade the authored ambience loop (sfx/ambience-*.opus) in over the
   * synth wind bed once it has decoded. The bed stays as the fallback: if the
   * clip is missing or the session ended meanwhile, nothing changes.
   */
  _startAuthoredAmbience(theme, nodes) {
    const key = theme === 'night' ? 'ambience:night' : 'ambience:day';
    const name = this._sfxMap && this._sfxMap.get(key);
    if (!name) return;
    Promise.resolve(this._loadSample(name)).then((buf) => {
      if (!buf || this._ambNodes !== nodes || !this.ctx) return;
      try {
        const t0 = this.ctx.currentTime;
        const loop = this.ctx.createBufferSource();
        loop.buffer = buf; loop.loop = true;
        const lg = this.ctx.createGain();
        lg.gain.setValueAtTime(0.0001, t0);
        lg.gain.exponentialRampToValueAtTime(0.9, t0 + 2.5);
        loop.connect(lg); lg.connect(this.buses.ambience);
        loop.start(t0);
        nodes.g.gain.setTargetAtTime(0.12, t0, 1.2); // duck the synth bed under the loop
        nodes.loop = loop; nodes.loopGain = lg;
      } catch { /* keep the synth bed */ }
    });
  }

  stopAmbience() {
    if (this._ambNodes) {
      try { this._ambNodes.src.stop(); } catch { /* already stopped */ }
      try { this._ambNodes.loop && this._ambNodes.loop.stop(); } catch { /* already stopped */ }
      this._ambNodes = null;
    }
  }

  /** Adaptive music: intensity 0 (calm) .. 1 (danger). Gentle pentatonic loop. */
  startMusic() {
    if (!this.ctx || this._musicTimer) return;
    const scale = [0, 3, 5, 7, 10]; // minor pentatonic degrees
    const root = 220;
    let stepN = 0;
    this._musicIntensity = 0.3;
    const tickFn = () => {
      if (!this.ctx || this.muted) return;
      const r = this._rng;
      const deg = scale[Math.floor(r.next() * scale.length)] + (r.next() < 0.25 ? 12 : 0);
      const freq = root * Math.pow(2, deg / 12);
      const bar = stepN % 8;
      if (bar === 0) {
        this._tone('music', { freq: root / 2, type: 'sine', attack: 0.02, decay: 0.9, gain: 0.10 });
      }
      if (r.next() < 0.35 + this._musicIntensity * 0.4) {
        this._tone('music', { freq, type: 'triangle', attack: 0.01, decay: 0.5, gain: 0.05 + this._musicIntensity * 0.04 });
      }
      stepN++;
    };
    this._musicTimer = setInterval(tickFn, 300);
  }

  setMusicIntensity(v) { this._musicIntensity = Math.max(0, Math.min(1, v)); }

  stopMusic() {
    if (this._musicTimer) { clearInterval(this._musicTimer); this._musicTimer = null; }
  }

  /** Background tab: keep clocks but silence output. */
  setBackgrounded(bg) {
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(bg ? 0 : 1, this.ctx.currentTime, 0.1);
  }

  suspend() {
    this.stopMusic(); this.stopAmbience();
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
  }
}
