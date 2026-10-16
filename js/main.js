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
import { GraphicsPanel, initialGraphics, accountStrings } from './gfx-ui.js';

// Keyboard actions by KeyboardEvent.code (control.* in starhermit.txt);
// a signed-in player's StarHermit overrides replace these at boot.
const KEY_DEFAULTS = {
  flap: ['Space', 'ArrowUp', 'KeyW'], pause: ['Escape', 'KeyP'], undo: ['KeyU'], restart: ['KeyR'], help: ['KeyH'],
};
const KEY_NAMES = { Space: 'Space', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc' };
// Account strings follow the one game language (js/i18n.js); refreshed on change.
const I18N = window.BWI18N;
let ACCOUNT = accountStrings(I18N ? I18N.lang : 'en-US');
import { AudioEngine } from './audio.js';
import { UI, T, cfgName } from './ui.js';
import { Platform } from './platform.js';
import { loadSave, writeSave, mergeSaves, isDescendant, migrate } from './store.js';

const $ = (id) => document.getElementById(id);

/** Marks an English key that is translated with T() when shown. */
const N = (s) => s;

const INVALID_TEXT = {
  'no-moves-remaining': N('No flaps left — glide it in!'),
  'session-over': N('This round is over.'),
  'unknown-action': N('That action is not available.'),
  'duplicate-command': N('Already registered.'),
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

  persist() {
    writeSave(localStorage, this.save);
    this.platform.mirrorSettings(this.settings); // StarHermit settings KV (changed keys only)
  }

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
      this.ui.toast(() => T('Save data was corrupted; a fresh profile was created.'));
    }

    // Hosted handshake (graceful offline fallback).
    const boot = await this.platform.init();
    this.ui.setProfileChip(this.platform.profile, this.platform.hosted, this.platform.sync);
    this.platform.onSync(() => {
      this.ui.setProfileChip(this.platform.profile, this.platform.hosted, this.platform.sync);
    });
    if (boot.mode === 'degraded') this.ui.toast(() => T('Playing offline — progress stays on this device.'));
    this._initAccount();

    // Renderer.
    // Graphics settings are per device (they depend on this GPU), so they live
    // in their own localStorage key rather than the cloud-saved document.
    const gfxSaved = initialGraphics(localStorage, this.settings.graphicsTier);
    this.renderer = new Renderer($('game-canvas'), {
      graphics: gfxSaved,
      reducedMotion: this.settings.reducedMotion,
    });
    this.gfxPanel = new GraphicsPanel($('gfx-fieldset'), this.renderer, localStorage, gfxSaved, I18N ? I18N.lang : navigator.language);
    this.renderer.setAssistArc(this.settings.assistArc);
    this.audio.setCaptionSink((t) => this.ui.caption(t));

    this._applySettings();
    this._bindUI();
    this._bindInput();
    this._bindLifecycle();
    document.addEventListener('bw-language', () => this._onLanguage());

    // Cloud save conflict resolution (hosted accounts only).
    await this._syncCloud();

    // Mid-round crash recovery.
    const snap = GameSession.loadSafeSnapshot(localStorage);
    if (this._cloudDoc) {
      // An unresolved cloud conflict keeps its screen up; its buttons go to the title.
    } else if (snap && snap.phase !== Phase.TERMINAL && !this._awayShown) {
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
    const [remote, ps] = await Promise.all([this.platform.loadProgress(), this.platform.loadSettings()]);
    this._resolveCloudConflict(remote);
    // Platform settings win over the save document's preferences.
    let changed = false;
    for (const k of Object.keys(this.settings)) {
      if (k in ps) { this.settings[k] = k === 'volumes' ? { ...this.settings.volumes, ...ps[k] } : ps[k]; changed = true; }
    }
    if (changed) this._applySettings();
    this.persist(); // local cache + seeds KV keys the platform lacks
  }

  /* ===================== StarHermit account ====================== */

  _initAccount() {
    const P = this.platform;
    this.keyBindings = JSON.parse(JSON.stringify(KEY_DEFAULTS));
    this._renderKeys();
    $('btn-sign-in').addEventListener('click', () => P.signIn());
    $('btn-invite').addEventListener('click', () => this._copyInvite());
    P.avatarUrl().then((url) => this.ui.setProfileAvatar(url));
    P.loadBindings(KEY_DEFAULTS).then((b) => { this.keyBindings = b; this._renderKeys(); });
    P.onAuth((a) => {
      if (!a.signedIn) {
        this.ui.setProfileAvatar(null);
        this.ui.setProfileChip(P.profile, P.hosted, P.sync);
        this.ui.toast(() => ACCOUNT.signedOut);
      }
      this._refreshAccountButtons();
    });
    // Another device saved first: merge both sides and save again.
    P.onConflict((remote) => this._mergeCloud(remote));
    this._refreshAccountButtons();
  }

  _refreshAccountButtons() {
    const si = $('btn-sign-in'), inv = $('btn-invite');
    si.textContent = ACCOUNT.signIn;
    si.hidden = !this.platform.canSignIn();
    inv.textContent = ACCOUNT.invite;
    inv.hidden = !this.platform.hosted;
  }

  async _copyInvite() {
    const link = this.platform.inviteLink();
    if (!link) return;
    try { await navigator.clipboard.writeText(link); this.ui.toast(() => ACCOUNT.inviteCopied); }
    catch { this.ui.toast(`${ACCOUNT.inviteFailed} ${link}`, 6000); }
  }

  _actionFor(code) {
    for (const [a, codes] of Object.entries(this.keyBindings || KEY_DEFAULTS)) if (codes.includes(code)) return a;
    return null;
  }

  /** Help cards show the effective bindings. */
  _renderKeys() {
    for (const action of Object.keys(KEY_DEFAULTS)) {
      const host = $(`keys-${action}`);
      if (!host) continue;
      host.replaceChildren();
      (this.keyBindings[action] || []).forEach((c, i) => {
        if (i) host.append(action === 'flap' ? ' / ' : '/');
        const k = document.createElement('kbd');
        k.textContent = KEY_NAMES[c] || c.replace(/^Key/, '').replace(/^Digit/, '');
        host.appendChild(k);
      });
    }
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

  /**
   * Runtime conflict (the SDK refused a write because another device saved
   * since our last load): keep the better of both sides — mergeSaves is a
   * union that keeps every lesson, cleared stage, best score and achievement —
   * adopt it and save again. The round in play lives in the session, not the
   * save document, so it is untouched.
   */
  _mergeCloud(remote) {
    if (this._cloudDoc) return; // the boot-time choice screen is still open
    if (remote) {
      this._save.doc = mergeSaves(this.save, remote);
      writeSave(localStorage, this.save);
      this._applySettings();
      if (this.appState === 'title') this._toTitle('cloud-merge');
    }
    this.platform.saveProgress(this.save);
  }

  /**
   * Language change (Settings → Language, or the account preference arriving):
   * static markup is re-applied by js/i18n.js; everything written from code is
   * re-rendered here without touching the round in play.
   */
  _onLanguage() {
    ACCOUNT = accountStrings(I18N.lang);
    if (this.gfxPanel) this.gfxPanel.setLocale(I18N.lang);
    this._refreshAccountButtons();
    this._renderKeys();
    this.ui.setProfileChip(this.platform.profile, this.platform.hosted, this.platform.sync);
    this.ui.buildJourneyGrid(this.progress, (i) => this._openSetup(JOURNEY[i]));
    this.ui.el.dailySub.textContent = this._dailyDone() ? T('done today ✓') : T("today's shared sky");
    if (this._setupView) this._renderSetup();
    if (this._resultsView) this._renderResults();
    if (this._boardView) this.ui.buildBoard(this._boardView.entries, this._boardView.note());
    if (this._awaySnap) this._renderAway(this._awaySnap);
    if (this._countdownPrompt && this._countdownKey) this.ui.countdown(T(this._countdownKey), this._countdownPrompt());
    this.ui.buildAchievements(this.progress);
    this._hudUpdate();
    this.ui.relocalizeToast();
  }

  /* ======================= state transitions ======================== */

  _toTitle(reason) {
    this.appState = 'title';
    this.session = null;
    this._clearCountdown();
    this.ui.setHudVisible(false);
    this.ui.show('title');
    this.ui.buildJourneyGrid(this.progress, (i) => this._openSetup(JOURNEY[i]));
    this.ui.el.dailySub.textContent = this._dailyDone() ? T('done today ✓') : T("today's shared sky");
    this._setupView = null; this._resultsView = null; this._boardView = null; this._countdownPrompt = null;
    this.audio.setMusicIntensity(0.2);
  }

  _dailyDone() {
    return !!this.progress.best[dailyContent(this.platform.now()).id];
  }

  /** blurb: a function returning localized text (re-run on language change). */
  _openSetup(cfg, blurb, options) {
    this.pendingConfig = cfg;
    this.appState = 'mode-setup';
    this._setupView = { blurb: typeof blurb === 'function' ? blurb : () => (blurb ? T(blurb) : ''), options: options || null, selected: options && options.length ? options[0].id : null };
    this._renderSetup();
    this.ui.el.setupAssistArc.checked = this.settings.assistArc;
    this.ui.show('setup');
  }

  _renderSetup() {
    const v = this._setupView;
    this.ui.fillSetup(this.pendingConfig, v.blurb());
    if (v.options && v.options.length) {
      const items = v.options.map((o) => ({ id: o.id, name: T(o.name), desc: o.desc ? o.desc() : '' }));
      this.ui.fillSetupOptions(items, v.selected, (id) => {
        this.audio.event('ui');
        const picked = v.options.find((o) => o.id === id);
        if (picked && picked.config) this.pendingConfig = picked.config;
        v.selected = id;
        this._renderSetup();
      });
    } else {
      this.ui.el.setupOptions.innerHTML = '';
    }
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
    this.ui.announce(T('{name}. Get ready.', { name: cfgName(cfg) }));
    this._setupView = null; this._resultsView = null;

    // Countdown (interruptible): 3·2·1·go — timers owned here.
    const prompt = () => T(cfg.lesson ? cfg.lesson.prompt : N('Flap to take off!'));
    this._countdownPrompt = prompt;
    const seq = ['3', '2', '1', N('Go!')];
    seq.forEach((txt, i) => {
      this.countdownTimers.push(setTimeout(() => {
        this._countdownKey = txt;
        this.ui.countdown(T(txt), prompt());
        this.audio.event('countdown', { final: i === seq.length - 1 });
        this.ui.announce(T(txt));
        if (i === seq.length - 1) {
          this.countdownTimers.push(setTimeout(() => {
            this.ui.hide();
            this.appState = 'active';
            this.ui.el.tapHint.hidden = !('ontouchstart' in window) || !!cfg.lesson;
            this._countdownPrompt = null;
            if (cfg.lesson) {
              this.ui.el.tapHint.hidden = true;
              this.ui.announce(T(cfg.lesson.prompt));
              this.ui.toast(() => T(cfg.lesson.prompt), 5000);
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
    this.ui.el.tapHint.hidden = true; // never covers the pause or settings screens
    this.ui.show('pause');
    this.ui.setHudVisible(true);
    this.audio.event('ui');
    this.ui.announce(T('Paused.'));
    if (this.session) this.session.saveSafeSnapshot(localStorage);
  }

  _resume() {
    if (!this.session || this.session.phase === Phase.TERMINAL) return;
    this.ui.hide();
    this.appState = 'active';
    this.ui.announce(T('Resumed.'));
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
    this.ui.announce(T(won ? 'Stage clear. Score {n}.' : 'Flight ended. Score {n}.', { n: s.score.total }));
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
        const hadBest = (p.best[cfg.id] || 0) > 0;
        p.best[cfg.id] = s.score.total;
        if (cfg.mode === 'daily' || cfg.mode === 'chase') extras.push(N('New personal best!'));
        // Sting only when an existing best is beaten; a first score is not a record.
        if (hadBest && s.score.total > 0) this.audio.event('best');
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

    // Cloud save (versioned, checksummed doc). Held while a conflict is unresolved,
    // or the stale local doc would overwrite the other device's cloud save. A write
    // that loses to another device is merged and re-saved by _mergeCloud.
    if (this.platform.hosted && !this.platform.profile.guest && !this._cloudDoc) {
      this.platform.saveProgress(this.save);
    }

    // Ranked rounds (Daily Breeze, Score Chase) post their total to the
    // platform `high-score` board when signed in; the results screen shows the rank.
    this._lbRound = (cfg.ranked && s.terminal) ? {
      board: cfg.mode === 'daily' ? `daily-${cfg.dateKey}` : 'chase', score: s.score.total,
    } : null;
    return extras;
  }

  _fillResults(s, won, extras) {
    this._resultsView = { s, won, extras, cfg: this._roundConfig || s.config };
    this._lbText = null;
    this._renderResults();
    this.ui.fillEarned(this._lastEarned || []);
    this._postToLeaderboard(this._lbRound);
  }

  _renderResults() {
    const { s, won, extras, cfg } = this._resultsView;
    const reasonText = {
      floor: N('You met the sea.'),
      ceiling: N('You clipped the sky.'),
      gate: N('A gate edge caught your wing.'),
      'move-limit': N('Out of flaps — so close!'),
      'time-up': N('Time ran out.'),
      cleared: cfg.mode === 'learn' ? N('Lesson complete!') : N('Every gate threaded.'),
      abandon: N('You headed home early.'),
    }[s.terminal ? s.terminal.reason : 'abandon'];
    const parts = [T(reasonText)];
    if (extras && extras.length) parts.push(...extras.map((e) => T(e)));
    if (this.progress.best[cfg.id]) parts.push(T('Best here: {n}', { n: this.progress.best[cfg.id] }));

    // Next recommended action.
    let nextLabel = null;
    if (cfg.mode === 'journey' && won && cfg.index + 1 < JOURNEY.length) {
      nextLabel = T('Next: {name}', { name: cfgName(JOURNEY[cfg.index + 1]) }) + ' →';
      this._nextConfig = JOURNEY[cfg.index + 1];
    } else if (cfg.mode === 'learn' && won) {
      const idx = LESSONS.findIndex((l) => l.id === cfg.id);
      if (idx >= 0 && idx + 1 < LESSONS.length) {
        nextLabel = T('Next lesson') + ' →';
        this._nextConfig = LESSONS[idx + 1];
      }
    } else {
      this._nextConfig = null;
    }

    this.ui.fillResults(s, {
      won, blurb: parts.join(' '), extra: '',
      boardNote: T(cfg.ranked ? 'Ranked round — replay recorded for verification.' : 'Unranked — practice never affects rating.'),
      nextLabel,
    });
    this.ui.fillEarned(this._lastEarned || []);
    const line = $('results-lb');
    if (line && !line.hidden) line.textContent = this._lbText ? this._lbText() : ACCOUNT.lbPosting;
  }

  /** Hosted only: post the round and show the leaderboard line on the results screen. */
  _postToLeaderboard(round) {
    const line = $('results-lb');
    if (!line) return;
    if (!round || !this.platform.hosted) { line.hidden = true; line.textContent = ''; return; }
    line.hidden = false;
    line.textContent = ACCOUNT.lbPosting;
    const session = this.session;
    this.platform.submitScore(round).then((r) => {
      if (this.session !== session) return;
      this._lbText = () => (!r.posted ? ACCOUNT.lbNotPosted
        : r.rank ? ACCOUNT.lbRank.replace('{rank}', r.rank) : ACCOUNT.lbPosted);
      line.textContent = this._lbText();
    });
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
          this.ui.announce(T('Gate {n}. Score {score}.', { n: state.gatesPassed, score: state.score.total }));
          break;
        case 'centered':
          this.audio.event('centered');
          if (e.streak >= 3) this.audio.event('streak', { streak: e.streak });
          this._haptic(20);
          if (e.streak >= 2) this.ui.announce(T('Centered! Streak {n}.', { n: e.streak }));
          break;
        case 'invalid': {
          this.audio.event('invalid');
          const key = INVALID_TEXT[e.reason] || N('Not available right now.');
          const msg = T(key);
          this.ui.toast(() => T(key));
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
          this.ui.announce(T('Undid the last flap.'));
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
    if (goal.type === 'gates' || (cfg.params.gateCount > 0)) progress = T('{n} / {total} gates', { n: s.gatesPassed, total: cfg.params.gateCount || goal.value });
    else if (goal.type === 'flaps') progress = T('{n} / {total} flaps', { n: s.flapsUsed, total: goal.value });
    else progress = T('{n} gates', { n: s.gatesPassed });
    const moves = cfg.params.moveLimit > 0 ? Math.max(0, cfg.params.moveLimit - s.flapsUsed) : null;
    let timeLeft = null;
    if (goal.type === 'survive' && goal.value > 0) {
      timeLeft = `${Math.max(0, Math.ceil((goal.value - s.tick) / TICKS_PER_SECOND))}s`;
    }
    this.ui.hud({
      objective: cfgName(this._roundConfig || cfg),
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
      switch (this._actionFor(e.code)) {
        case 'flap':
          if (!typing) { e.preventDefault(); this._flap(); }
          break;
        case 'pause':
          if (this.appState === 'active' || this.appState === 'countdown') this._pause('key');
          else if (this.appState === 'paused' && (!this.ui._current || this.ui._current === 'pause')) this._resume();
          else if (this.appState === 'paused') {
            // Sub-screen (settings/help) open over pause: back to pause,
            // never strand the frozen round behind no UI.
            this.ui.hide();
            this.ui.show('pause');
          } else if (this.ui._current && !['title', 'conflict'].includes(this.ui._current)) { // conflict needs a choice
            this.ui.hide();
            this._backFromScreen();
          }
          break;
        case 'undo':
          if (this.session && this.session.canUndo) this.session.undo();
          break;
        case 'restart':
          if (this.appState === 'results' && this.session) this._retry();
          break;
        case 'help':
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
      if (!this.progress.tutorialDone) this._openSetup(LESSONS[0], N('Sixty seconds to learn the sky.'));
      else {
        const next = JOURNEY.find((st) => !(this.progress.journey[st.id] && this.progress.journey[st.id].cleared)) || JOURNEY[0];
        this._openSetup(next, N('Pick up where you left off.'));
      }
    });
    on('btn-daily', () => {
      const cfg = dailyContent(this.platform.now());
      const note = this.platform.timeTrusted ? N('Synchronized to server time.') : N('Using local clock (offline).');
      this._openSetup(cfg, () => T('One shared sky for everyone today.') + ' ' + T(note));
    });
    on('btn-journey', () => {
      this.appState = 'mode-select';
      this.ui.buildJourneyGrid(this.progress, (i) => this._openSetup(JOURNEY[i]));
      this.ui.show('journey');
    });
    on('btn-learn', () => {
      const options = LESSONS.map((l) => ({
        id: l.id, name: l.name, desc: () => T(l.lesson.goalText), config: l,
      }));
      this._openSetup(LESSONS[0], N('Five tiny lessons, one rule at a time.'), options);
    });
    on('btn-practice', () => {
      const options = PRACTICE_PRESETS.map((p) => ({
        id: p.id, name: p.name, desc: () => T('{difficulty} — endless, undo allowed, unranked', { difficulty: T(p.difficulty) }), config: p,
      }));
      this._openSetup(PRACTICE_PRESETS[0], N('Free flight. Undo is allowed; nothing is ranked.'), options);
    });
    on('btn-challenge', () => {
      const options = CHALLENGES.map((c) => ({ id: c.id, name: c.name, desc: () => T(c.blurb), config: c }));
      this._openSetup(CHALLENGES[0], N('Constrained goals for seasoned wings.'), options);
    });
    on('btn-chase', () => {
      const seed = this.chaseSeed || `sky-${new Date().toISOString().slice(0, 10)}`;
      const cfg = scoreChaseContent(seed);
      this._openSetup(cfg, () => T('Endless score chase. Share the seed "{seed}" to fly the same sky as friends.', { seed }));
    });
    on('btn-boards', () => this._openBoards());
    on('btn-achievements', () => {
      this.ui.buildAchievements(this.progress);
      this.ui.show('achievements');
    });
    on('btn-help', () => this._openHelp());
    on('btn-settings', () => this._openSettings());

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
    on('btn-pause-settings', () => this._openSettings());
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
    on('btn-keep-local', () => { this._cloudDoc = null; this.ui.hide(); this._toTitle('conflict-local'); });
    on('btn-keep-cloud', () => { this._save.doc = migrateRemote(this._cloudDoc); this._cloudDoc = null; this.persist(); this._applySettings(); this.ui.hide(); this._toTitle('conflict-cloud'); });
    on('btn-merge', () => { this._save.doc = mergeSaves(this.save, this._cloudDoc); this._cloudDoc = null; this.persist(); this._applySettings(); this.ui.hide(); this._toTitle('conflict-merge'); });

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
    this._awaySnap = snap;
    this._renderAway(snap);
    this.ui.setHudVisible(true);
    this._hudUpdate();
    this.ui.show('away');
  }

  _renderAway(snap) {
    if ($('screen-away').hidden) { this._awaySnap = null; return; }
    $('away-summary').textContent = T('While you were away: your {name} flight was kept safe — {gates} gates, score {score}, {secs}s in. The sky waited for you.', {
      name: cfgName(snap.rawConfig || snap.config), gates: snap.state.gatesPassed, score: snap.state.score.total,
      secs: Math.round(snap.state.tick / TICKS_PER_SECOND),
    });
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
    const show = (entries, note) => {
      this._boardView = { entries, note: () => T(note) };
      this.ui.buildBoard(entries, T(note));
    };
    if (which === 'local') {
      show(this.progress.localBoard, N('Scores from this device. Casual — verified boards require sign-in.'));
      return;
    }
    const entries = await this.platform.leaderboard('high-score', { friendsOnly: which === 'friends' });
    if (entries === null) {
      show(this.progress.localBoard,
        this.platform.hosted ? N('Board unavailable right now — showing local scores.') : N('Offline — showing this device\'s scores. Sign in for global boards.'));
    } else {
      show(entries, which === 'friends' ? N('Friends only — high scores from Daily Breeze and Score Chase.') : N('High scores from Daily Breeze and Score Chase.'));
    }
  }

  /* ============================ settings ============================ */

  _openSettings() {
    this.ui.show('settings');
    this.gfxPanel.sync();
    // Keep the GPU / cost / frame-rate summary live while the screen is open.
    clearInterval(this._gfxInfoTimer);
    this._gfxInfoTimer = setInterval(() => {
      if ($('screen-settings').hidden) { clearInterval(this._gfxInfoTimer); return; }
      this.gfxPanel.refreshInfo();
    }, 1000);
  }

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
    });
    bindCheck('set-muted', 'muted', (v) => this.audio.setMuted(v));
    bindCheck('set-motion', 'reducedMotion', (v) => this.renderer.setReducedMotion(v));
    bindCheck('set-contrast', 'highContrast');
    bindCheck('set-text', 'largeText');
    bindCheck('set-lefty', 'leftHanded');
    bindCheck('set-arc', 'assistArc', (v) => this.renderer.setAssistArc(v));
    bindCheck('set-haptics', 'haptics');
    $('set-palette').addEventListener('change', (e) => {
      s().colorPalette = e.target.value;
      this.persist();
      this._applySettings();
    });
    $('btn-replay-tutorial').addEventListener('click', () => {
      this.progress.tutorialDone = false;
      this.persist();
      this.ui.hide();
      this._openSetup(LESSONS[0], N('Sixty seconds to learn the sky.'));
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
  if (t) { t.textContent = T('Something went wrong starting Breeze Wing. Please reload.'); t.hidden = false; }
});
