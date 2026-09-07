/**
 * Breeze Wing — session module.
 * Owns the live rules state, the ordered command log, undo snapshots,
 * replay-envelope recording, and safe-snapshot persistence.
 * No rendering, no DOM. Only this module may mutate rules state,
 * and only through validated commands / steps.
 */

import {
  createSession, applyCommand, step, serialize, deserialize, hashState,
  createReplayEnvelope, Phase, TerminalReason, ActionType,
} from './rules.js';

const HASH_EVERY_TICKS = 600; // periodic state hashes in the replay envelope
const SAFE_SNAPSHOT_KEY = 'breezewing.safeSnapshot.v1';

export class GameSession {
  /**
   * @param config normalized-or-raw content config
   * @param opts { build, allowUndo, sessionId }
   */
  constructor(config, opts = {}) {
    this.state = createSession(config);
    this.build = opts.build || 'dev';
    this.allowUndo = opts.allowUndo === true;
    this.sessionId = opts.sessionId || `s-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    // Raw content config (pre-normalization) for progression/results metadata;
    // never part of rules state, so it cannot affect determinism or hashing.
    this.rawConfig = opts.rawConfig || null;
    this.envelope = createReplayEnvelope(this.state.config, this.build);
    this._cmdCounter = 0;
    this._undoStack = []; // serialized states, practice only
    this._listeners = new Set();
  }

  onEvent(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _emit(events) {
    if (!events || !events.length) return;
    for (const fn of this._listeners) {
      try { fn(events, this.state); } catch { /* listener errors never break sim */ }
    }
  }

  get phase() { return this.state.phase; }
  get config() { return this.state.config; }

  /** Issue a validated player command. Returns the applyCommand result. */
  command(type) {
    const id = `${this.sessionId}-${++this._cmdCounter}`;
    const cmd = { id, tick: this.state.tick, type };
    const before = this.state;
    const r = applyCommand(this.state, cmd);
    if (r.accepted) {
      if (this.allowUndo && type === ActionType.FLAP && this._undoStack.length < 64) {
        this._undoStack.push(serialize(before));
      }
      this.state = r.state;
      this.envelope.commands.push({ id, tick: cmd.tick, type });
      if (this.state.phase === Phase.TERMINAL) this._finalizeEnvelope();
      this._emit(r.events);
    } else {
      // Invalid actions still count toward tie-breaks via state.
      this.state = r.state;
      this._emit(r.events);
    }
    return r;
  }

  /** Advance one fixed tick. */
  tick() {
    const r = step(this.state);
    this.state = r.state;
    if (this.state.tick % HASH_EVERY_TICKS === 0) {
      this.envelope.hashes.push({ tick: this.state.tick, hash: hashState(this.state) });
    }
    if (this.state.phase === Phase.TERMINAL && !this.envelope.result) this._finalizeEnvelope();
    this._emit(r.events);
    return r;
  }

  _finalizeEnvelope() {
    this.envelope.result = {
      score: this.state.score.total,
      reason: this.state.terminal.reason,
      tick: this.state.tick,
      gates: this.state.gatesPassed,
      centered: this.state.centeredPasses,
      bestStreak: this.state.bestStreak,
      invalidActions: this.state.invalidActions,
      finalHash: hashState(this.state),
    };
  }

  /** Undo the last flap (practice mode only, where rules permit). */
  undo() {
    if (!this.allowUndo || this._undoStack.length === 0) return false;
    if (this.state.phase === Phase.TERMINAL) return false;
    const json = this._undoStack.pop();
    this.state = deserialize(json);
    // Drop the replay commands issued after the restored point, then the
    // undone flap itself: it was applied at the restored tick, so it is the
    // last remaining command and must leave the log too.
    while (this.envelope.commands.length &&
           this.envelope.commands[this.envelope.commands.length - 1].tick > this.state.tick) {
      this.envelope.commands.pop();
    }
    if (this.envelope.commands.length &&
        this.envelope.commands[this.envelope.commands.length - 1].tick === this.state.tick) {
      this.envelope.commands.pop();
    }
    this._emit([{ type: 'undo' }]);
    return true;
  }

  get canUndo() {
    return this.allowUndo && this._undoStack.length > 0 && this.state.phase !== Phase.TERMINAL;
  }

  /* ---------------- persistence ---------------- */

  /** Save the last safe snapshot (mid-round crash recovery). */
  saveSafeSnapshot(storage) {
    if (!storage || this.state.phase === Phase.TERMINAL) return;
    try {
      storage.setItem(SAFE_SNAPSHOT_KEY, JSON.stringify({
        sessionId: this.sessionId,
        build: this.build,
        state: JSON.parse(serialize(this.state)),
        envelope: this.envelope,
        rawConfig: this.rawConfig,
        savedAt: Date.now(),
      }));
    } catch { /* quota / privacy mode: snapshot is best-effort */ }
  }

  static loadSafeSnapshot(storage) {
    if (!storage) return null;
    try {
      const raw = storage.getItem(SAFE_SNAPSHOT_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      const s = new GameSession(data.state.config, { build: data.build, sessionId: data.sessionId, rawConfig: data.rawConfig || null });
      s.state = deserialize(JSON.stringify(data.state));
      s.envelope = data.envelope;
      return s;
    } catch {
      return null;
    }
  }

  static clearSafeSnapshot(storage) {
    try { storage && storage.removeItem(SAFE_SNAPSHOT_KEY); } catch { /* ignore */ }
  }
}

export { Phase, TerminalReason, ActionType };
