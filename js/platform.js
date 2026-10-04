/**
 * Breeze Wing — platform module (StarHermit host adapter) over
 * window.StarHermit (starhermit-sdk.js, loaded first as a classic script).
 *
 * The SDK reads the launch fragment (#game_token=<jwt>[&session_id=] or a
 * sign-in return #access_token=…), renews the token and talks to the
 * platform. This class keeps the game's adapter API: identity (profile
 * nickname + avatar, never /api/v1/me), server time, the ONE cloud-save slot
 * (/api/v1/me/cloud-saves/game:{slug}, remote wins on boot, debounced saves
 * flushed on pagehide/hidden), per-player settings KV, control bindings,
 * sign-in, invite link and the read-only platform leaderboard. Presence,
 * activity and telemetry endpoints do not exist for launch tokens and are
 * deliberately not called. No token → localStorage only, zero /api calls.
 */

const SH_GLOBAL = (typeof window !== 'undefined' && window.StarHermit) || null;
// Read the launch fragment as early as possible (module evaluation, before main.js runs).
if (SH_GLOBAL && !SH_GLOBAL.__bwInit) { SH_GLOBAL.init(); SH_GLOBAL.__bwInit = true; }

export class Platform {
  constructor(sh = SH_GLOBAL) {
    this.sh = sh;
    this.profile = { name: 'Guest', guest: true };
    this.sync = 'offline';     // offline | saving | synced (cloud save mirror)
    this._syncListeners = [];
    this._timeOffset = 0;
    this._timeSynced = false;
    this._saveWaiters = [];
    this._pushedSettings = null;
    if (sh) {
      sh.on('saved', (ok) => {
        this._setSync(ok ? 'synced' : 'offline');
        const waiters = this._saveWaiters;
        this._saveWaiters = [];
        for (const w of waiters) w(ok ? { ok: true } : { ok: false, reason: 'network' });
      });
    }
  }

  /** A launch token is held (hosted mode). */
  get hosted() { return !!(this.sh && this.sh.signedIn); }
  get tokenHosted() { return this.hosted; }
  get userId() { return this.hosted ? this.sh.userId : null; }
  get scope() { return this.sh ? this.sh.slug : null; }

  _setSync(state) {
    if (this.sync === state) return;
    this.sync = state;
    for (const fn of this._syncListeners) {
      try { fn(state); } catch { /* listener errors never break the adapter */ }
    }
  }

  onSync(fn) {
    if (typeof fn === 'function') this._syncListeners.push(fn);
  }

  /** fn({ signedIn, reason }) when the StarHermit session changes (e.g. renewal refused). */
  onAuth(fn) {
    if (!this.sh) return () => {};
    return this.sh.on('auth', (a) => {
      if (!a.signedIn) {
        this.profile = { name: 'Guest', guest: true };
        this._pushedSettings = null;
        this._setSync('offline');
      }
      fn(a);
    });
  }

  /* --------------------------- bootstrap ---------------------------- */

  async init() {
    if (!this.hosted) return { mode: 'offline' }; // localStorage only, zero /api calls
    try { window.addEventListener('pagehide', () => this._flushSave()); } catch { /* no window events */ }
    try { document.addEventListener('visibilitychange', () => { if (document.hidden) this._flushSave(); }); } catch { /* no document */ }
    const ok = await this.syncTime();
    const profile = await this.fetchProfile();
    if (!ok) return { mode: 'degraded', reason: 'no-host' };
    if (profile) return { mode: 'hosted' };
    return { mode: 'degraded', reason: 'no-profile' };
  }

  /* --------------------------- identity ----------------------------- */

  profileFor(userId) {
    if (!userId || typeof userId !== 'string') return Promise.resolve('player');
    const fallback = 'Player ' + userId.slice(0, 8);
    if (!this.hosted) return Promise.resolve(fallback);
    return this.sh.profile(userId).then((p) => (p && p.nickname) || fallback, () => fallback);
  }

  async fetchProfile() {
    if (!this.hosted) return null;
    const p = await this.sh.profile();
    if (!p) return null;
    this.profile = { name: String(p.displayName).slice(0, 40), guest: false };
    return this.profile;
  }

  /** Object URL of the signed-in player's avatar, or null. */
  avatarUrl() { return this.hosted ? this.sh.avatarUrl() : Promise.resolve(null); }

  /* ----------------------- sign-in / invite ------------------------- */

  canSignIn() { return !!(this.sh && this.sh.canSignIn()); }
  signIn() { return !!(this.sh && this.sh.signIn()); }
  inviteLink() { return this.hosted ? this.sh.inviteLink() : null; }

  /* ----------------------------- time ------------------------------- */

  /** Synchronize with GET /api/v1/time using round-trip-adjusted offset. */
  async syncTime() {
    if (!this.hosted) { this._timeSynced = false; return false; }
    try {
      const t0 = Date.now();
      const body = await this.sh.api('/api/v1/time');
      const t1 = Date.now();
      const serverMs = typeof body.now === 'number' ? body.now : Date.parse(body.now);
      if (!Number.isFinite(serverMs)) throw new Error('no-time');
      this._timeOffset = serverMs - (t0 + (t1 - t0) / 2);
      this._timeSynced = true;
      return true;
    } catch {
      this._timeSynced = false;
      return false;
    }
  }

  /** Authoritative-ish now(): server-adjusted when available. */
  now() {
    return new Date(Date.now() + (this._timeSynced ? this._timeOffset : 0));
  }

  get timeTrusted() { return this._timeSynced; }

  /* --------------------------- cloud save --------------------------- */

  /** The remote save doc, or null (none / offline). */
  async loadProgress() {
    if (!this.hosted) return null;
    const doc = await this.sh.loadJSON();
    this._setSync('synced'); // the slot is readable; local and cloud now agree after conflict resolution
    return doc;
  }

  /** Queue a cloud mirror of the save doc (debounced; resolves on flush). */
  saveProgress(doc) {
    if (!this.hosted) return Promise.resolve({ ok: false, reason: 'offline' });
    this._setSync('saving');
    this.sh.saveJSON(doc);
    return new Promise((resolve) => this._saveWaiters.push(resolve));
  }

  _flushSave() {
    if (!this.hosted) return Promise.resolve(false);
    return this.sh.flushSave(true);
  }

  /* ------------------------- settings KV ---------------------------- */

  /** Platform settings ({} when none / offline); also the mirror baseline. */
  async loadSettings() {
    if (!this.hosted) return {};
    const s = await this.sh.getSettings();
    this._pushedSettings = JSON.parse(JSON.stringify(s || {}));
    return s || {};
  }

  /** PATCH the settings keys that changed since the last mirror. */
  mirrorSettings(settings) {
    if (!this.hosted || !this._pushedSettings || !settings) return null;
    const patch = {};
    for (const k of Object.keys(settings)) {
      if (JSON.stringify(settings[k]) !== JSON.stringify(this._pushedSettings[k])) patch[k] = settings[k];
    }
    this._pushedSettings = JSON.parse(JSON.stringify(settings));
    return Object.keys(patch).length ? this.sh.patchSettings(patch) : null;
  }

  /* --------------------------- controls ----------------------------- */

  /** defaults: { action: [codes] } → effective bindings (platform overrides when signed in). */
  loadBindings(defaults) {
    const copy = JSON.parse(JSON.stringify(defaults));
    if (!this.hosted) return Promise.resolve(copy);
    return this.sh.loadBindings(defaults).catch(() => copy);
  }

  /* -------------------------- leaderboards -------------------------- */
  // READ-ONLY on the platform (wiki: clients can never submit to a game
  // leaderboard); user ids become profile nicknames.

  async submitScore() {
    return { ok: false, reason: this.hosted ? 'leaderboard-readonly' : 'offline', local: true };
  }

  /** Read the game's first platform leaderboard. Entries ([] when none) or null on failure. */
  async leaderboard(board, { friendsOnly = false } = {}) {
    if (!this.hosted) return null;
    try {
      const r = await this.sh.leaderboard(null, { page: 1, pageSize: 50, scope: friendsOnly ? 'friends' : undefined });
      if (!r.board) return null;
      const raw = r.items || r.entries || [];
      return Promise.all(raw.map(async (e) => {
        const uid = e.userId ?? e.playerId ?? '';
        const name = await this.profileFor(uid);
        return {
          name: uid && uid === this.userId ? `You (${name})` : name,
          score: e.score ?? e.value,
          you: uid === this.userId,
        };
      }));
    } catch {
      return null;
    }
  }

  /* -------------- presence / activity / telemetry ------------------- */
  // Not reachable with a launch token (wiki); kept as harmless no-ops.

  startPresence() { /* not available on-platform — intentionally silent */ }
  stopPresence() { /* not available on-platform — intentionally silent */ }
  activityStart() { /* not available on-platform — intentionally silent */ }
  activityEnd() { /* not available on-platform — intentionally silent */ }
  track() { /* no client telemetry endpoint — intentionally silent */ }
}
