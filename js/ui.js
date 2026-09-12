/**
 * Breeze Wing — ui module.
 * Semantic DOM shell: screen management, focus handling, live-region
 * announcements, HUD updates, and dynamic lists. The canvas is never the
 * only UI; every playfield control has a DOM equivalent.
 */

import { JOURNEY, ACHIEVEMENTS } from './content.js';
import { TICKS_PER_SECOND } from './rules.js';

const $ = (id) => document.getElementById(id);

const SCREENS = [
  'screen-title', 'screen-setup', 'screen-journey', 'screen-countdown',
  'screen-pause', 'screen-results', 'screen-help', 'screen-settings',
  'screen-achievements', 'screen-boards', 'screen-conflict', 'screen-compat',
  'screen-away',
];

export class UI {
  constructor() {
    this.el = Object.fromEntries([
      'hud', 'hud-objective', 'hud-progress', 'hud-score', 'hud-streak',
      'hud-moves', 'hud-time', 'btn-undo', 'btn-pause', 'tap-hint', 'toast',
      'sr-announcer', 'sr-alerts', 'audio-captions',
      'countdown-text', 'countdown-prompt',
      'setup-heading', 'setup-blurb', 'setup-rules', 'setup-duration',
      'setup-ranked', 'setup-options', 'setup-assist-arc', 'btn-setup-start',
      'journey-grid', 'journey-sub', 'daily-sub', 'profile-chip',
      'results-heading', 'results-sub', 'bd-gates', 'bd-gates-pts',
      'bd-center', 'bd-center-pts', 'bd-streak', 'bd-streak-pts',
      'bd-time-pts', 'bd-total', 'results-extra', 'results-achievements',
      'results-board', 'btn-next',
      'ach-list', 'board-list', 'board-note',
      'away-summary',
    ].map((id) => [id.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), $(id)]));
    this._current = null;
    this._lastFocus = null;
    this._captionTimer = null;
  }

  /* --------------------------- screens ------------------------------ */

  show(name) {
    for (const id of SCREENS) {
      const el = $(id);
      if (el) el.hidden = id !== `screen-${name}`;
    }
    this._current = name;
    if (name && name !== 'countdown') {
      const panel = $(`screen-${name}`);
      const focusable = panel && panel.querySelector('button, input, select, [tabindex]');
      this._lastFocus = document.activeElement;
      if (focusable) setTimeout(() => focusable.focus(), 30);
    }
  }

  /** Close the top screen and restore focus to whatever opened it. */
  hide() {
    for (const id of SCREENS) { const el = $(id); if (el) el.hidden = true; }
    this._current = null;
    if (this._lastFocus && document.contains(this._lastFocus)) this._lastFocus.focus();
  }

  setHudVisible(v) { this.el.hud.hidden = !v; }

  /* ------------------------ announcements --------------------------- */

  announce(text) { this.el.srAnnouncer.textContent = ''; requestAnimationFrame(() => { this.el.srAnnouncer.textContent = text; }); }
  alert(text) { this.el.srAlerts.textContent = ''; requestAnimationFrame(() => { this.el.srAlerts.textContent = text; }); }

  caption(text) {
    const c = this.el.audioCaptions;
    c.textContent = text;
    c.classList.add('show');
    clearTimeout(this._captionTimer);
    this._captionTimer = setTimeout(() => c.classList.remove('show'), 1200);
  }

  toast(text, ms = 2400) {
    const t = this.el.toast;
    t.textContent = text;
    t.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { t.hidden = true; }, ms);
    this.announce(text);
  }

  /* ------------------------------ HUD ------------------------------- */

  hud({ objective, progress, score, streak, moves, timeLeft, canUndo }) {
    if (objective !== undefined) this.el.hudObjective.textContent = objective;
    if (progress !== undefined) this.el.hudProgress.textContent = progress;
    if (score !== undefined) this.el.hudScore.textContent = String(score);
    if (streak !== undefined) {
      this.el.hudStreak.hidden = !streak || streak < 2;
      this.el.hudStreak.textContent = streak >= 2 ? `✦ streak ×${streak}` : '';
    }
    if (moves !== undefined) {
      this.el.hudMoves.hidden = moves === null;
      this.el.hudMoves.textContent = moves === null ? '' : `Flaps left: ${moves}`;
    }
    if (timeLeft !== undefined) {
      this.el.hudTime.hidden = timeLeft === null;
      this.el.hudTime.textContent = timeLeft === null ? '' : `⏱ ${timeLeft}`;
    }
    if (canUndo !== undefined) this.el.btnUndo.hidden = !canUndo;
  }

  countdown(text, prompt) {
    this.el.countdownText.textContent = text;
    if (prompt !== undefined) this.el.countdownPrompt.textContent = prompt;
  }

  /* --------------------------- setup fill --------------------------- */

  fillSetup(cfg, blurb) {
    this.el.setupHeading.textContent = cfg.name;
    this.el.setupBlurb.textContent = blurb || '';
    const p = cfg.params;
    const bits = [];
    if (cfg.goal.type === 'gates') bits.push(`pass ${cfg.goal.value} gates`);
    if (cfg.goal.type === 'survive') bits.push(`survive ${Math.round(cfg.goal.value / TICKS_PER_SECOND)}s`);
    if (cfg.goal.type === 'flaps') bits.push(`flap ${cfg.goal.value} times`);
    if (cfg.goal.type === 'endless') bits.push('endless flight — best score wins');
    if (p.moveLimit > 0) bits.push(`only ${p.moveLimit} flaps allowed`);
    if (p.oscAmp > 0) bits.push('moving gates');
    this.el.setupRules.textContent = bits.join(' · ') || 'free flight';
    const expected = cfg.parTicks > 0 ? cfg.parTicks / TICKS_PER_SECOND
      : cfg.goal.type === 'survive' ? cfg.goal.value / TICKS_PER_SECOND
      : cfg.goal.type === 'gates' ? (p.spacing * (cfg.goal.value + 2)) / Math.max(1, p.speed) : 0;
    this.el.setupDuration.textContent = expected > 0 ? `about ${Math.max(1, Math.round(expected / 10) * 10)}s` : 'as long as you last';
    this.el.setupRanked.textContent = cfg.ranked ? 'Yes — shared seed, replay-verified' : 'No — local only';
  }

  /** Options list for setup (e.g. practice difficulty, chase seed). */
  fillSetupOptions(items, selectedId, onPick) {
    const box = this.el.setupOptions;
    box.innerHTML = '';
    for (const item of items) {
      const b = document.createElement('button');
      b.className = 'btn setup-option';
      b.setAttribute('aria-pressed', String(item.id === selectedId));
      if (item.id === selectedId) b.style.borderColor = 'var(--accent-2)';
      b.innerHTML = `<strong></strong><small></small>`;
      b.querySelector('strong').textContent = item.name;
      b.querySelector('small').textContent = item.desc || '';
      b.addEventListener('click', () => onPick(item.id));
      box.appendChild(b);
    }
  }

  /* -------------------------- journey grid -------------------------- */

  buildJourneyGrid(progress, onPick) {
    const grid = this.el.journeyGrid;
    grid.innerHTML = '';
    let clearedCount = 0;
    let firstUncleared = -1;
    JOURNEY.forEach((st, i) => {
      const rec = progress.journey[st.id];
      const cleared = !!(rec && rec.cleared);
      if (cleared) clearedCount++;
      else if (firstUncleared < 0) firstUncleared = i;
      const b = document.createElement('button');
      b.className = 'jstage' + (cleared ? ' done' : '') + (st.mastery ? ' mastery' : '');
      b.setAttribute('role', 'listitem');
      const label = st.mastery ? `★` : String(i + 1);
      b.innerHTML = `<span></span><small></small>`;
      b.querySelector('span').textContent = label;
      b.querySelector('small').textContent = cleared ? `${rec.bestScore}` : st.name.replace('Mastery: ', '').split(' ')[0];
      b.setAttribute('aria-label', `Stage ${i + 1}: ${st.name}${cleared ? `, cleared, best ${rec.bestScore}` : ''}${st.mastery ? ', mastery trial' : ''}`);
      b.addEventListener('click', () => onPick(i));
      grid.appendChild(b);
    });
    if (firstUncleared >= 0) grid.children[firstUncleared].classList.add('current');
    this.el.journeySub.textContent = `${clearedCount} / ${JOURNEY.length} stages`;
    return clearedCount;
  }

  /* ---------------------------- results ----------------------------- */

  fillResults(state, { won, blurb, extra, boardNote, nextLabel }) {
    this.el.resultsHeading.textContent = won ? 'Clear skies!' : 'Flight ended';
    this.el.resultsSub.textContent = blurb || '';
    this.el.bdGates.textContent = String(state.gatesPassed);
    this.el.bdGatesPts.textContent = String(state.score.gates);
    this.el.bdCenter.textContent = String(state.centeredPasses);
    this.el.bdCenterPts.textContent = String(state.score.center);
    this.el.bdStreak.textContent = `best ×${state.bestStreak}`;
    this.el.bdStreakPts.textContent = String(state.score.streak);
    this.el.bdTimePts.textContent = String(state.score.time);
    this.el.bdTotal.textContent = String(state.score.total);
    this.el.resultsExtra.textContent = extra || '';
    this.el.resultsBoard.textContent = boardNote || '';
    if (nextLabel) { this.el.btnNext.hidden = false; this.el.btnNext.textContent = nextLabel; }
    else this.el.btnNext.hidden = true;
  }

  fillEarned(list) {
    const box = this.el.resultsAchievements;
    if (!list.length) { box.hidden = true; return; }
    box.hidden = false;
    box.textContent = `🏅 Unlocked: ${list.map((a) => a.name).join(' · ')}`;
  }

  /* ------------------------- achievements --------------------------- */

  buildAchievements(progress) {
    const ul = this.el.achList;
    ul.innerHTML = '';
    for (const a of ACHIEVEMENTS) {
      const li = document.createElement('li');
      const at = progress.achievements[a.key];
      li.className = at ? 'unlocked' : '';
      const name = document.createElement('div');
      name.className = 'ach-name';
      name.textContent = `${at ? '🏅' : '○'} ${a.name}`;
      const desc = document.createElement('div');
      desc.className = 'ach-desc';
      desc.textContent = a.desc;
      li.append(name, desc);
      if (at) {
        const d = document.createElement('div');
        d.className = 'ach-date';
        d.textContent = `Unlocked ${String(at).slice(0, 10)}`;
        li.append(d);
      }
      ul.appendChild(li);
    }
  }

  /* ------------------------- leaderboards --------------------------- */

  buildBoard(entries, note) {
    this.el.boardNote.textContent = note || '';
    const ol = this.el.boardList;
    ol.innerHTML = '';
    if (!entries || !entries.length) {
      const li = document.createElement('li');
      li.textContent = 'No scores yet — be the first breeze.';
      ol.appendChild(li);
      return;
    }
    entries.slice(0, 20).forEach((e, i) => {
      const li = document.createElement('li');
      if (e.you) li.className = 'you';
      const who = document.createElement('span');
      who.textContent = `${i + 1}. ${e.name || 'Pilot'}`;
      const score = document.createElement('strong');
      score.textContent = String(e.score);
      li.append(who, score);
      ol.appendChild(li);
    });
  }

  /* ---------------------------- settings ---------------------------- */

  applySettings(s) {
    document.body.classList.toggle('reduced-motion', !!s.reducedMotion);
    document.body.classList.toggle('high-contrast', !!s.highContrast);
    document.body.classList.toggle('large-text', !!s.largeText);
    document.body.classList.toggle('left-handed', !!s.leftHanded);
    document.body.classList.remove('palette-deuteranopia', 'palette-protanopia', 'palette-tritanopia');
    if (s.colorPalette && s.colorPalette !== 'default') {
      document.body.classList.add(`palette-${s.colorPalette}`);
    }
    $('vol-music').value = Math.round((s.volumes.music ?? 0.6) * 100);
    $('vol-effects').value = Math.round((s.volumes.effects ?? 0.8) * 100);
    $('vol-ambience').value = Math.round((s.volumes.ambience ?? 0.5) * 100);
    $('vol-voice').value = Math.round((s.volumes.voice ?? 0.7) * 100);
    $('set-muted').checked = !!s.muted;
    $('set-tier').value = s.graphicsTier || 'medium';
    $('set-motion').checked = !!s.reducedMotion;
    $('set-contrast').checked = !!s.highContrast;
    $('set-palette').value = s.colorPalette || 'default';
    $('set-text').checked = !!s.largeText;
    $('set-lefty').checked = !!s.leftHanded;
    $('set-arc').checked = s.assistArc !== false;
    $('set-haptics').checked = s.haptics !== false;
  }

  setProfileChip(profile, hosted, sync) {
    if (profile.guest) {
      this.el.profileChip.textContent = 'Guest — progress saves locally';
      return;
    }
    const syncTxt = sync === 'synced' ? 'cloud save synced'
      : sync === 'saving' ? 'saving…'
      : 'cloud save offline';
    this.el.profileChip.textContent = `${profile.name} — ${syncTxt}${hosted ? '' : ' (offline)'}`;
  }
}
