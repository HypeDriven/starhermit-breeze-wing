/**
 * Breeze Wing — bootstrap + application controller.
 * Owns the game-state machine:
 *   boot → title → mode-select → preparing → countdown → active ↔ paused
 *        → results → progression
 * Every transition has one owner (this module) and an explicit reason.
 * The rules state is only mutated through GameSession commands/steps.
 */

import {
  SIM_DT, TICKS_PER_SECOND, Phase, TerminalReason, ActionType,
} from './rules.js';
import {
  JOURNEY, LESSONS, CHALLENGES, PRACTICE_PRESETS,
  dailyContent, scoreChaseContent, ACHIEVEMENTS, BUILD,
} from './content.js';
import { GameSession } from './session.js';
import { Renderer } from './render.js';
import { AudioEngine } from './audio.js';
import { UI } from './ui.js';
import { Platform } from './platform.js';
import { loadSave, writeSave, mergeSaves, isDescendant, migrate } from './store.js';

const $ = (id) => document.getElementById(id);

const INVALID_TEXT = {
  'no-moves-remaining': 'No flaps left — glide it in!',
  'session-over': 'This round is over.',
  'unknown-action': 'That action is not available.',
  'duplicate-command': 'Already registered.',
};

class App {
  constructor() {
    this.platform = new Platform();
    this.ui = new UI();
    this.audio = new AudioEngine();
    this.renderer = null;
    this.session = null;
    this.prevState = null;
    this.appState = 'boot'; // state machine owner
    this.pendingConfig = null; // chosen in setup
    this.practiceChoice = PRACTICE_PRESETS[0].id;
    this.chaseSeed = '';
    this.accumulator = 0;
    this.lastFrame = 0;
    this.countdownTimers = [];
    this._save = null;
    this._awayShown = false;
  }

  get save() { return this._save.doc; }
  get settings() { return this.save.settings; }
  get progress() { return this.save.progress; }

  persist() { writeSave(localStorage, this.save); }

  /* ============================ boot ================================ */

  async start() {
    // Capability detection first: WebGL required for the 3D playfield.
    if (!this._webglOk()) {
      this.ui.show('compat');
      $('btn-compat-retry').addEventListener('click', () => location.reload());
      return;
    }

    this._save = loadSave(localStorage);
    if (this._save.status === 'corrupt-reset') {
      this.ui.toast('Save data was corrupted; a fresh profile was created.');
    }

    // Hosted handshake (graceful offline fallback).
    const boot = await this.platform.init();
    this.platform.telemetryConsent = !!this.settings.telemetryConsent;
    this.ui.setProfileChip(this.platform.profile, this.platform.hosted);
    if (boot.mode === 'degraded') this.ui.toast('Playing offline — progress stays on this device.');

    // Renderer.
    this.renderer = new Renderer($('game-canvas'), {
      tier: this.settings.graphicsTier,
      reducedMotion: this.settings.reducedMotion,
    });
    this.renderer.setAssistArc(this.settings.assistArc);
    this.audio.setCaptionSink((t) => this.ui.caption(t));

    this._applySettings();
    this._bindUI();
    this._bindInput();
    this._bindLifecycle();

    // Cloud save conflict resolution (hosted accounts only).
    await this._syncCloud();

    // Activity + presence lifecycle.
    this.platform.activityStart();
    this.platform.startPresence();

    // Mid-round crash recovery.
    const snap = GameSession.loadSafeSnapshot(localStorage);
    if (snap && snap.phase !== Phase.TERMINAL && !this._awayShown) {
      this._awayShown = true;
      this.session = snap;
      this._roundConfig = snap.rawConfig || snap.config;
      this.renderer.prepareSession(snap.config);
      this._showAway(snap);
    } else {
      this._toTitle('boot-complete');
    }

    this.lastFrame = performance.now();
    requestAnimationFrame((t) => this._frame(t));
  }

  _webglOk() {
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch { return false; }
  }

  async _syncCloud() {
    const remote = await this.platform.loadProgress();
    this._resolveCloudConflict(remote);
  }

  /**
   * Resolve a cloud-save conflict: when neither side is a strict descendant we
   * must preserve BOTH snapshots and ask the player (spec §6). `remote` is the
   * other device's snapshot; the local save is this._save.doc. Called from
   * boot sync and again when a save reports a conflict, so the server-returned
   * prior snapshot is never silently discarded.
   */
  _resolveCloudConflict(remote) {
    if (!remote) return;
    const local = this.save;
    if (isDescendant(local, remote) || JSON.stringify(local.progress) === JSON.stringify(remote.progress)) return;
    if (isDescendant(remote, local)) {
      this._save.doc = migrateRemote(remote);
      this.persist();
      this._applySettings();
      return;
    }
    // Neither is a strict descendant: preserve both, ask the player.
    this._cloudDoc = remote;
    this.ui.show('conflict');
  }

  /* ======================= state transitions ======================== */

  _toTitle(reason) {
    this.appState = 'title';
    this.session = null;
    this._clearCountdown();
    this.ui.setHudVisible(false);
    this.ui.show('title');
    this.ui.buildJourneyGrid(this.progress, (i) => this._openSetup(JOURNEY[i]));
    this.ui.el.dailySub.textContent = this._dailyDone() ? 'done today ✓' : "today's shared sky";
    this.audio.setMusicIntensity(0.2);
    this.platform.track('start', { mode: 'title', reason });
  }

  _dailyDone() {
    return !!this.progress.best[dailyContent(this.platform.now()).id];
  }

  _openSetup(cfg, blurb, options) {
    this.pendingConfig = cfg;
    this.appState = 'mode-setup';
    this.ui.fillSetup(cfg, blurb);
    if (options && options.length) {
      this.ui.fillSetupOptions(options, options[0].id, (id) => {
        this.audio.event('ui');
        const picked = options.find((o) => o.id === id);
        if (picked && picked.config) this.pendingConfig = picked.config;
        this.ui.fillSetup(this.pendingConfig, blurb);
      });
    } else {
      this.ui.el.setupOptions.innerHTML = '';
    }
    this.ui.el.setupAssistArc.checked = this.settings.assistArc;
    this.ui.show('setup');
  }

  _beginRound(reason) {
    const cfg = this.pendingConfig;
    // Keep the RAW content config for this round: the rules state only holds
    // the normalized config (normalizeConfig drops content metadata such as
    // dateKey, index, lesson), but progression, results, and ranked
    // submission need those fields. Always read content metadata from here,
    // rules truth from session.state.
    this._roundConfig = cfg;
    this._clearCountdown();
    GameSession.clearSafeSnapshot(localStorage);
    this.session = new GameSession(cfg, {
      build: BUILD,
      allowUndo: cfg.mode === 'practice',
      rawConfig: cfg,
      sessionId: `bw-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e8).toString(36)}`,
    });
    this.session.onEvent((events, state) => this._onSessionEvents(events, state));
    this.prevState = this.session.state;
    this.renderer.prepareSession(cfg);
    this.audio.unlock();
    this.audio.reseedVariants(cfg.seed);
    this.audio.startAmbience(cfg.theme);
    this.audio.startMusic();
    this.appState = 'countdown';
    this.ui.setHudVisible(true);
    this._hudUpdate();
    this.ui.show('countdown');
    this.ui.announce(`${cfg.name}. Get ready.`);
    this.platform.track('start', { mode: cfg.mode });

    // Countdown (interruptible): 3·2·1·go — timers owned here.
    const prompt = cfg.lesson ? cfg.lesson.prompt : 'Flap to take off!';
    const seq = ['3', '2', '1', 'Go!'];
    seq.forEach((txt, i) => {
      this.countdownTimers.push(setTimeout(() => {
        this.ui.countdown(txt, prompt);
        this.audio.event('countdown', { final: i === seq.length - 1 });
        this.ui.announce(txt);
        if (i === seq.length - 1) {
          this.countdownTimers.push(setTimeout(() => {
            this.ui.hide();
            this.appState = 'active';
            this.ui.el.tapHint.hidden = !('ontouchstart' in window) || !!cfg.lesson;
            if (cfg.lesson) {
              this.ui.el.tapHint.hidden = true;
              this.ui.announce(cfg.lesson.prompt);
              this.ui.toast(cfg.lesson.prompt, 5000);
            }
          }, 600));
        }
      }, i * 700));
    });
  }

  _pause(reason) {
    if (this.appState !== 'active' && this.appState !== 'countdown') return;
    this.appState = 'paused';
    this._clearCountdown();
    this.ui.show('pause');
    this.ui.setHudVisible(true);
    this.audio.event('ui');
    this.ui.announce('Paused.');
    if (this.session) this.session.saveSafeSnapshot(localStorage);
  }

  _resume() {
    if (!this.session || this.session.phase === Phase.TERMINAL) return;
    this.ui.hide();
    this.appState = 'active';
    this.ui.announce('Resumed.');
  }

  _leaveRound() {
    if (this.session && this.session.phase !== Phase.TERMINAL) {
      this.session.command(ActionType.ABANDON);
    }
    this._finishRound('left');
  }

  _finishRound(reason) {
    if (!this.session) { this._toTitle('no-session'); return; }
    // Finish each session exactly once: _leaveRound() finishes immediately,
    // but the 'terminal' event also schedules a delayed finish for the
    // crash/clear animation — without this guard the round would be
    // progressed and submitted twice.
    if (this._finishedFor === this.session) return;
    this._finishedFor = this.session;
    const s = this.session.state;
    GameSession.clearSafeSnapshot(localStorage);
    this.appState = 'results';
    this.ui.setHudVisible(false);
    this.ui.el.tapHint.hidden = true;

    const won = s.terminal && s.terminal.reason === TerminalReason.CLEARED;
    const breakdownExtra = this._progressRound(s, won);
    this._fillResults(s, won, breakdownExtra);
    this.ui.show('results');
    this.audio.setMusicIntensity(0.2);
    this.ui.announce(`${won ? 'Stage clear' : 'Flight ended'}. Score ${s.score.total}.`);
    this.platform.track('round_end', { mode: s.config.mode, reason: s.terminal ? s.terminal.reason : reason });
    this.persist();
  }

  /* ======================= progression ============================== */

  _progressRound(s, won) {
    const p = this.progress;
    const cfg = this._roundConfig || s.config;
    const extras = [];
    p.totalRuns += 1;
    p.totalGates += s.gatesPassed;

    // Day tracking (accessibility-neutral long-term goal).
    const dayKey = this.platform.now().toISOString().slice(0, 10);
    if (!p.daysPlayed.includes(dayKey)) p.daysPlayed.push(dayKey);

    // Mode bookkeeping.
    if (cfg.mode === 'learn' && won) {
      p.lessons[cfg.id] = true;
      if (Object.keys(p.lessons).length >= LESSONS.length) p.tutorialDone = true;
    }
    if (cfg.mode === 'journey') {
      const rec = p.journey[cfg.id] || { cleared: false, bestScore: 0, bestTicks: 0 };
      if (won) rec.cleared = true;
      if (s.score.total > (rec.bestScore || 0)) rec.bestScore = s.score.total;
      if (won && (!rec.bestTicks || s.tick < rec.bestTicks)) rec.bestTicks = s.tick;
      p.journey[cfg.id] = rec;
    }
    if (['daily', 'chase', 'practice', 'challenge'].includes(cfg.mode)) {
      if ((p.best[cfg.id] || 0) < s.score.total) {
        p.best[cfg.id] = s.score.total;
        if (cfg.mode === 'daily' || cfg.mode === 'chase') extras.push('New personal best!');
      }
    }

    // Local board entry for competitive modes.
    if ((cfg.mode === 'daily' || cfg.mode === 'chase') && s.terminal) {
      p.localBoard.push({
        name: this.platform.profile.name, score: s.score.total,
        date: dayKey, contentId: cfg.id, seed: cfg.seed, you: true,
      });
      p.localBoard.sort((a, b) => b.score - a.score);
      p.localBoard = p.localBoard.slice(0, 50);
    }

    // Achievements (idempotent unlocks).
    const earned = [];
    const unlock = (key) => {
      if (!p.achievements[key]) {
        p.achievements[key] = new Date().toISOString();
        const meta = ACHIEVEMENTS.find((a) => a.key === key);
        if (meta) { earned.push(meta); this.audio.event('achievement'); }
      }
    };
    if (won) unlock('first_clear');
    if (Object.keys(p.lessons).length >= LESSONS.length) unlock('mechanic_mastery');
    if (s.bestStreak >= 5) unlock('streak_5');
    const journeyCleared = Object.values(p.journey).filter((r) => r.cleared).length;
    if (journeyCleared >= 20) unlock('journey_half');
    if (journeyCleared >= 40) unlock('journey_master');
    if (p.daysPlayed.length >= 7) unlock('long_term');
    if (cfg.mode === 'daily' && s.terminal) unlock('daily_first');
    if (s.gatesPassed >= 100) unlock('centurion');
    this._lastEarned = earned;

    // Cloud save (versioned, checksummed doc).
    if (this.platform.hosted && !this.platform.profile.guest) {
      this.platform.saveProgress(this.save).then((r) => {
        // A conflict returns the OTHER device's prior snapshot in `remote`.
        // Resolve against it directly rather than re-fetching (which would
        // compare the local doc against a copy of itself and drop the other
        // device's progress).
        if (r && r.conflict && r.remote) this._resolveCloudConflict(r.remote);
      });
    }

    // Ranked submission: full provenance + replay envelope.
    if (cfg.ranked && s.terminal) {
      const assists = { arc: !!this.settings.assistArc, reducedMotion: !!this.settings.reducedMotion };
      this.platform.submitScore({
        board: cfg.mode === 'daily' ? `daily-${cfg.dateKey}` : 'chase',
        score: s.score.total, config: cfg, assists,
        durationTicks: s.tick, envelope: this.session.envelope,
      }).then((r) => {
        if (r.ok) this.ui.toast(r.validated ? `Score verified — rank #${r.rank ?? '?'}` : 'Score submitted (casual board).');
        else this.ui.toast('Score kept locally — will submit when online.');
      });
    }
    return extras;
  }

  _fillResults(s, won, extras) {
    const cfg = this._roundConfig || s.config;
    const reasonText = {
      floor: 'You met the sea.',
      ceiling: 'You clipped the sky.',
      gate: 'A gate edge caught your wing.',
      'move-limit': 'Out of flaps — so close!',
      'time-up': 'Time ran out.',
      cleared: cfg.mode === 'learn' ? 'Lesson complete!' : 'Every gate threaded.',
      abandon: 'You headed home early.',
    }[s.terminal ? s.terminal.reason : 'abandon'];
    const parts = [reasonText];
    if (extras && extras.length) parts.push(...extras);
    if (this.progress.best[cfg.id]) parts.push(`Best here: ${this.progress.best[cfg.id]}`);

    // Next recommended action.
    let nextLabel = null;
    if (cfg.mode === 'journey' && won && cfg.index + 1 < JOURNEY.length) {
      nextLabel = `Next: ${JOURNEY[cfg.index + 1].name} →`;
      this._nextConfig = JOURNEY[cfg.index + 1];
    } else if (cfg.mode === 'learn' && won) {
      const idx = LESSONS.findIndex((l) => l.id === cfg.id);
      if (idx >= 0 && idx + 1 < LESSONS.length) {
        nextLabel = `Next lesson →`;
        this._nextConfig = LESSONS[idx + 1];
      }
    } else {
      this._nextConfig = null;
    }

    this.ui.fillResults(s, {
      won, blurb: parts.join(' '), extra: '',
      boardNote: cfg.ranked ? 'Ranked round — replay recorded for verification.' : 'Unranked — practice never affects rating.',
      nextLabel,
    });
    this.ui.fillEarned(this._lastEarned || []);
  }

  /* ========================= session events ========================= */

  _onSessionEvents(events, state) {
    this.renderer.onEvents(events, state);
    for (const e of events) {
      switch (e.type) {
        case 'flap':
          this.audio.event('flap');
          this._haptic(8);
          this.ui.el.tapHint.hidden = true;
          break;
        case 'start': this.audio.event('start'); break;
        case 'pass':
          this.audio.event('pass');
          this.ui.announce(`Gate ${state.gatesPassed}. Score ${state.score.total}.`);
          break;
        case 'centered':
          this.audio.event('centered');
          this._haptic(20);
          if (e.streak >= 2) this.ui.announce(`Centered! Streak ${e.streak}.`);
          break;
        case 'invalid': {
          this.audio.event('invalid');
          const msg = INVALID_TEXT[e.reason] || 'Not available right now.';
          this.ui.toast(msg);
          this.ui.alert(msg);
          break;
        }
        case 'terminal':
          this.audio.event('terminal', { reason: e.reason });
          this._haptic(e.reason === 'cleared' ? [30, 40, 30] : 60);
          this.audio.setMusicIntensity(0.2);
          // Let the crash/clear animation breathe, then show results. Capture
          // the session: if the player already retried, this timer must not
          // finish the NEW round.
          const endedSession = this.session;
          setTimeout(() => { if (this.session === endedSession) this._finishRound('terminal'); }, this.settings.reducedMotion ? 400 : 1100);
          break;
        case 'undo':
          this.audio.event('undo');
          this.ui.announce('Undid the last flap.');
          break;
        default: break;
      }
    }
    this._hudUpdate();
  }

  _hudUpdate() {
    if (!this.session) return;
    const s = this.session.state;
    const cfg = s.config;
    const goal = cfg.goal;
    let progress = '';
    if (goal.type === 'gates' || (cfg.params.gateCount > 0)) progress = `${s.gatesPassed} / ${cfg.params.gateCount || goal.value} gates`;
    else if (goal.type === 'flaps') progress = `${s.flapsUsed} / ${goal.value} flaps`;
    else progress = `${s.gatesPassed} gates`;
    const moves = cfg.params.moveLimit > 0 ? Math.max(0, cfg.params.moveLimit - s.flapsUsed) : null;
    let timeLeft = null;
    if (goal.type === 'survive' && goal.value > 0) {
      timeLeft = `${Math.max(0, Math.ceil((goal.value - s.tick) / TICKS_PER_SECOND))}s`;
    }
    this.ui.hud({
      objective: cfg.name,
      progress,
      score: s.score.total,
      streak: s.streak,
      moves,
      timeLeft,
      canUndo: this.session.canUndo,
    });
    // Adaptive music intensity rises with speed and danger.
    const danger = Math.min(1, s.gatesPassed / 30);
    this.audio.setMusicIntensity(0.25 + danger * 0.6);
  }

  /* ============================= loop =============================== */

  _frame(now) {
    const dtReal = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    if (this.session && this.appState === 'active') {
      // Fixed simulation step; cosmetic render uses interpolation alpha.
      this.accumulator += dtReal;
      const maxSteps = 5; // spiral-of-death guard: drop render scale, not sim
      let steps = 0;
      while (this.accumulator >= SIM_DT && steps < maxSteps) {
        this.prevState = this.session.state;
        this.session.tick();
        this.accumulator -= SIM_DT;
        steps++;
      }
      if (steps === maxSteps) this.accumulator = 0;
      const alpha = this.accumulator / SIM_DT;
      this.renderer.render(this.prevState || this.session.state, this.session.state, alpha, dtReal);
    } else if (this.session && (this.appState === 'paused' || this.appState === 'countdown' || this.appState === 'results')) {
      // Frozen sim, gentle cosmetic motion continues.
      this.renderer.render(this.session.state, this.session.state, 1, dtReal * 0.2);
    } else {
      // Title screen: ambient demo scene.
      this._idleRender(dtReal);
    }

    this._pollGamepad();
    requestAnimationFrame((t) => this._frame(t));
  }

  _idleRender(dt) {
    if (!this._idleSession) {
      this._idleSession = new GameSession(dailyContent(this.platform.now()));
      this.renderer.prepareSession(this._idleSession.config);
    }
    // Slow ambient drift, no input.
    this._idleSession.state = { ...this._idleSession.state, tick: this._idleSession.state.tick + 1 };
    this.renderer.render(this._idleSession.state, this._idleSession.state, 1, dt);
  }

  /* ============================= input ============================== */

  _flap() {
    if (this.appState !== 'active' || !this.session) return;
    this.audio.unlock();
    this.session.command(ActionType.FLAP);
  }

  _bindInput() {
    // Pointer/touch: whole playfield is the flap surface; UI panels stop
    // propagation so canvas taps never fire while menus are open.
    const canvas = $('game-canvas');
    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { canvas.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
      this._flap();
    });
    canvas.addEventListener('pointercancel', () => { /* capture lost: no-op, safe */ });
    // Tap hint doubles as a big DOM touch target.
    this.ui.el.tapHint.addEventListener('pointerdown', (e) => { e.preventDefault(); this._flap(); });

    // Keyboard: full operation, visible focus, no traps.
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const tag = (e.target && e.target.tagName) || '';
      const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
      switch (e.code) {
        case 'Space': case 'ArrowUp': case 'KeyW':
          if (!typing) { e.preventDefault(); this._flap(); }
          break;
        case 'Escape': case 'KeyP':
          if (this.appState === 'active' || this.appState === 'countdown') this._pause('key');
          else if (this.appState === 'paused' && (!this.ui._current || this.ui._current === 'pause')) this._resume();
          else if (this.appState === 'paused') {
            // Sub-screen (settings/help) open over pause: back to pause,
            // never strand the frozen round behind no UI.
            this.ui.hide();
            this.ui.show('pause');
          } else if (this.ui._current && !['title'].includes(this.ui._current)) {
            this.ui.hide();
            this._backFromScreen();
          }
          break;
        case 'KeyU':
          if (this.session && this.session.canUndo) this.session.undo();
          break;
        case 'KeyR':
          if (this.appState === 'results' && this.session) this._retry();
          break;
        case 'KeyH':
          if (this.appState === 'title') this._openHelp();
          break;
        default: break;
      }
    });

    // First gesture unlocks audio (browser policy).
    const unlock = () => this.audio.unlock();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
  }

  _pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of pads) {
      if (!gp) continue;
      const pressed = (i) => gp.buttons[i] && gp.buttons[i].pressed;
      const edge = (key, down) => {
        this._gpPrev = this._gpPrev || {};
        const was = this._gpPrev[key];
        this._gpPrev[key] = down;
        return down && !was;
      };
      if (edge('a', pressed(0))) { // A / Cross: flap or confirm focused control
        if (this.appState === 'active') this._flap();
        else if (document.activeElement && document.activeElement.click) document.activeElement.click();
      }
      if (edge('start', pressed(9))) {
        if (this.appState === 'active') this._pause('gamepad');
        else if (this.appState === 'paused') this._resume();
      }
      if (edge('b', pressed(1)) && this.appState === 'paused') this._resume();
      // D-pad navigation among DOM controls.
      if (edge('up', pressed(12))) this._moveFocus(-1);
      if (edge('down', pressed(13))) this._moveFocus(1);
      break; // primary pad only
    }
  }

  _moveFocus(dir) {
    const focusables = [...document.querySelectorAll('.screen:not([hidden]) button, .screen:not([hidden]) input, .screen:not([hidden]) select, #hud:not([hidden]) button')]
      .filter((el) => !el.disabled && el.offsetParent !== null);
    if (!focusables.length) return;
    const idx = focusables.indexOf(document.activeElement);
    const next = focusables[(idx + dir + focusables.length) % focusables.length];
    next.focus();
  }

  _haptic(pattern) {
    if (this.settings.haptics && navigator.vibrate) {
      try { navigator.vibrate(pattern); } catch { /* unsupported */ }
    }
  }

  /* =========================== lifecycle ============================ */

  _bindLifecycle() {
    // Backgrounding pauses solo simulation; clocks survive via snapshots.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.audio.setBackgrounded(true);
        if (this.appState === 'active' || this.appState === 'countdown') this._pause('hidden');
        if (this.session) this.session.saveSafeSnapshot(localStorage);
      } else {
        this.audio.setBackgrounded(false);
        if (this.platform.hosted) this.platform.syncTime();
      }
    });
    window.addEventListener('pagehide', () => {
      if (this.session) this.session.saveSafeSnapshot(localStorage);
      this.platform.activityEnd();
    });

    // Resize/orientation/DPR without losing input or restarting.
    const onResize = () => {
      this.renderer.resize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    if (window.matchMedia) {
      window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`).addEventListener?.('change', onResize);
    }
    onResize();
  }

  /* ============================ UI wiring =========================== */

  _backFromScreen() {
    if (['pause'].includes(this.ui._current)) return;
    // 'results' included: leaving the results screen via Esc goes to the
    // title (the round is already recorded), never to a blank dead screen.
    if (this.appState === 'title' || this.appState === 'results' || !this.session) this._toTitle('back');
  }

  _retry() {
    this.platform.track('retry', { mode: this.session ? this.session.config.mode : '' });
    // Retry the round's raw content config (not the normalized rules config,
    // which has lost lesson prompts, journey index, and the daily dateKey).
    this.pendingConfig = this._roundConfig || this.session.config;
    this._beginRound('retry');
  }

  _openHelp() {
    this._helpReturn = this.ui._current;
    this.ui.show('help');
  }

  _bindUI() {
    const on = (id, fn) => $(id).addEventListener('click', () => { this.audio.unlock(); this.audio.event('ui'); fn(); });

    // Title.
    on('btn-play', () => {
      // Short path to play: continue journey, or learn first.
      if (!this.progress.tutorialDone) this._openSetup(LESSONS[0], 'Sixty seconds to learn the sky.');
      else {
        const next = JOURNEY.find((st) => !(this.progress.journey[st.id] && this.progress.journey[st.id].cleared)) || JOURNEY[0];
        this._openSetup(next, 'Pick up where you left off.');
      }
    });
    on('btn-daily', () => {
      const cfg = dailyContent(this.platform.now());
      const note = this.platform.timeTrusted ? 'Synchronized to server time.' : 'Using local clock (offline).';
      this._openSetup(cfg, `One shared sky for everyone today. ${note}`);
    });
    on('btn-journey', () => {
      this.appState = 'mode-select';
      this.ui.buildJourneyGrid(this.progress, (i) => this._openSetup(JOURNEY[i]));
      this.ui.show('journey');
    });
    on('btn-learn', () => {
      const options = LESSONS.map((l) => ({
        id: l.id, name: l.name, desc: l.lesson.goalText, config: l,
      }));
      this._openSetup(LESSONS[0], 'Five tiny lessons, one rule at a time.', options);
    });
    on('btn-practice', () => {
      const options = PRACTICE_PRESETS.map((p) => ({
        id: p.id, name: p.name, desc: `${p.difficulty} — endless, undo allowed, unranked`, config: p,
      }));
      this._openSetup(PRACTICE_PRESETS[0], 'Free flight. Undo is allowed; nothing is ranked.', options);
    });
    on('btn-challenge', () => {
      const options = CHALLENGES.map((c) => ({ id: c.id, name: c.name, desc: c.blurb, config: c }));
      this._openSetup(CHALLENGES[0], 'Constrained goals for seasoned wings.', options);
    });
    on('btn-chase', () => {
      const seed = this.chaseSeed || `sky-${new Date().toISOString().slice(0, 10)}`;
      const cfg = scoreChaseContent(seed);
      this._openSetup(cfg, `Endless score chase. Share the seed "${seed}" to fly the same sky as friends.`);
    });
    on('btn-boards', () => this._openBoards());
    on('btn-achievements', () => {
      this.ui.buildAchievements(this.progress);
      this.ui.show('achievements');
    });
    on('btn-help', () => this._openHelp());
    on('btn-settings', () => this.ui.show('settings'));

    // Setup.
    on('btn-setup-start', () => {
      this.settings.assistArc = this.ui.el.setupAssistArc.checked;
      this.persist();
      this.renderer.setAssistArc(this.settings.assistArc);
      this._beginRound('setup-start');
    });
    on('btn-setup-back', () => this._toTitle('setup-back'));
    on('btn-journey-back', () => this._toTitle('journey-back'));

    // HUD.
    on('btn-pause', () => this._pause('button'));
    on('btn-undo', () => { if (this.session && this.session.canUndo) this.session.undo(); });

    // Pause.
    on('btn-resume', () => this._resume());
    on('btn-pause-settings', () => this.ui.show('settings'));
    on('btn-pause-help', () => this._openHelp());
    on('btn-pause-restart', () => this._retry());
    on('btn-leave', () => this._leaveRound());

    // Results.
    on('btn-retry', () => this._retry());
    on('btn-next', () => {
      if (this._nextConfig) { this.pendingConfig = this._nextConfig; this._beginRound('next'); }
    });
    on('btn-results-menu', () => this._toTitle('results-menu'));

    // Help/settings/achievements backs.
    on('btn-help-back', () => { this.ui.hide(); if (this.appState === 'title') this._toTitle('help-back'); else if (this.appState === 'paused') this.ui.show('pause'); });
    on('btn-settings-back', () => { this.ui.hide(); this._applySettings(); if (this.appState === 'title') this._toTitle('settings-back'); else if (this.appState === 'paused') this.ui.show('pause'); });
    on('btn-ach-back', () => this._toTitle('ach-back'));
    on('btn-boards-back', () => this._toTitle('boards-back'));

    // Boards tabs.
    on('board-global', () => this._loadBoard('global'));
    on('board-friends', () => this._loadBoard('friends'));
    on('board-local', () => this._loadBoard('local'));

    // Cloud conflict.
    on('btn-keep-local', () => { this.ui.hide(); this._toTitle('conflict-local'); });
    on('btn-keep-cloud', () => { this._save.doc = migrateRemote(this._cloudDoc); this.persist(); this._applySettings(); this.ui.hide(); this._toTitle('conflict-cloud'); });
    on('btn-merge', () => { this._save.doc = mergeSaves(this.save, this._cloudDoc); this.persist(); this._applySettings(); this.ui.hide(); this._toTitle('conflict-merge'); });

    // Away screen.
    on('btn-away-continue', () => {
      this.ui.hide();
      this.prevState = this.session.state;
      this._resume();
    });
    on('btn-away-restart', () => {
      GameSession.clearSafeSnapshot(localStorage);
      this._toTitle('away-restart');
    });

    this._bindSettings();
  }

  _showAway(snap) {
    this.appState = 'paused';
    const cfg = snap.config;
    $('away-summary').textContent =
      `While you were away: your ${cfg.name} flight was kept safe — ` +
      `${snap.state.gatesPassed} gates, score ${snap.state.score.total}, ` +
      `${Math.round(snap.state.tick / TICKS_PER_SECOND)}s in. The sky waited for you.`;
    this.ui.setHudVisible(true);
    this._hudUpdate();
    this.ui.show('away');
  }

  async _openBoards() {
    this.appState = 'mode-select';
    this.ui.show('boards');
    this._loadBoard('global');
  }

  async _loadBoard(which) {
    for (const id of ['board-global', 'board-friends', 'board-local']) {
      $(id).setAttribute('aria-selected', String(id === `board-${which}`));
    }
    if (which === 'local') {
      this.ui.buildBoard(this.progress.localBoard, 'Scores from this device. Casual — verified boards require sign-in.');
      return;
    }
    const dayKey = dailyContent(this.platform.now()).dateKey;
    const entries = await this.platform.leaderboard(`daily-${dayKey}`, { friendsOnly: which === 'friends' });
    if (entries === null) {
      this.ui.buildBoard(this.progress.localBoard,
        this.platform.hosted ? 'Board unavailable right now — showing local scores.' : 'Offline — showing this device\'s scores. Sign in for global boards.');
    } else {
      this.ui.buildBoard(entries, which === 'friends' ? 'Friends only.' : `Daily board for ${dayKey}.`);
    }
  }

  /* ============================ settings ============================ */

  _bindSettings() {
    const s = () => this.settings;
    const bindRange = (id, bus) => $(id).addEventListener('input', (e) => {
      s().volumes[bus] = e.target.value / 100;
      this.audio.setVolume(bus, s().volumes[bus]);
      this.persist();
    });
    bindRange('vol-music', 'music');
    bindRange('vol-effects', 'effects');
    bindRange('vol-ambience', 'ambience');
    bindRange('vol-voice', 'voice');
    const bindCheck = (id, key, apply) => $(id).addEventListener('change', (e) => {
      s()[key] = e.target.checked;
      this.persist();
      this._applySettings();
      if (apply) apply(e.target.checked);
      this.platform.track('settings_change', { step: key });
    });
    bindCheck('set-muted', 'muted', (v) => this.audio.setMuted(v));
    bindCheck('set-motion', 'reducedMotion', (v) => this.renderer.setReducedMotion(v));
    bindCheck('set-contrast', 'highContrast');
    bindCheck('set-text', 'largeText');
    bindCheck('set-lefty', 'leftHanded');
    bindCheck('set-arc', 'assistArc', (v) => this.renderer.setAssistArc(v));
    bindCheck('set-haptics', 'haptics');
    bindCheck('set-telemetry', 'telemetryConsent', (v) => { this.platform.telemetryConsent = v; });
    $('set-tier').addEventListener('change', (e) => {
      s().graphicsTier = e.target.value;
      this.persist();
      this.renderer.setQuality(s().graphicsTier);
      this.platform.track('settings_change', { tier: s().graphicsTier });
    });
    $('set-palette').addEventListener('change', (e) => {
      s().colorPalette = e.target.value;
      this.persist();
      this._applySettings();
    });
    $('btn-replay-tutorial').addEventListener('click', () => {
      this.progress.tutorialDone = false;
      this.persist();
      this.ui.hide();
      this._openSetup(LESSONS[0], 'Sixty seconds to learn the sky.');
    });
  }

  _applySettings() {
    this.ui.applySettings(this.settings);
    this.audio.volumes = { ...this.settings.volumes };
    if (this.audio.ctx) {
      for (const bus of Object.keys(this.audio.volumes)) this.audio.setVolume(bus, this.audio.volumes[bus]);
      this.audio.setMuted(this.settings.muted);
    }
    if (this.renderer) {
      this.renderer.setReducedMotion(this.settings.reducedMotion);
      this.renderer.setAssistArc(this.settings.assistArc);
    }
  }

  _clearCountdown() {
    this.countdownTimers.forEach(clearTimeout);
    this.countdownTimers = [];
  }
}

/** Cloud docs may be older; run them through the same migration path. */
function migrateRemote(remote) {
  return migrate(remote);
}

/* ------------------------------- boot -------------------------------- */

const app = new App();
// Inspectable handle: supports debugging, validation captures, and replay tooling.
window.__bw = app;
app.start().catch((err) => {
  console.error('boot failed', err);
  const t = document.getElementById('toast');
  if (t) { t.textContent = 'Something went wrong starting Breeze Wing. Please reload.'; t.hidden = false; }
});
