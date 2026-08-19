/**
 * Breeze Wing — platform module (StarHermit host adapter).
 * Token-aware same-origin /api adapter with retries, rate-limit handling,
 * server-time sync, presence heartbeats, cloud save, and leaderboard
 * submission. Everything degrades gracefully to local/offline play:
 * no token → guest mode, no host → localStorage only.
 *
 * Security: launch/account tokens are read from the URL/host shell and are
 * NEVER persisted to local storage.
 */

export class Platform {
  constructor() {
    const params = new URLSearchParams(location.search);
    this.launchToken = params.get('launch') || params.get('token') || null;
    this.scope = params.get('scope') || null; // game scope from launch token route
    this.hosted = !!this.launchToken;
    this.profile = { name: 'Guest', avatar: null, guest: true };
    this._timeOffset = 0; // serverTime - localTime (ms)
    this._timeSynced = false;
    this._presenceTimer = null;
    this._listeners = { presence: [] };
    this.telemetryConsent = false;
  }

  /* ------------------------------ HTTP ------------------------------ */

  async _fetch(path, opts = {}, attempt = 0) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (this.launchToken) headers['Authorization'] = `Bearer ${this.launchToken}`;
    let res;
    try {
      res = await fetch(path, { ...opts, headers });
    } catch (err) {
      if (attempt < 2) return this._fetch(path, opts, attempt + 1);
      throw new Error('network-unreachable');
    }
    if (res.status === 429) {
      // Rate limited: respect Retry-After, bounded retries.
      const wait = Math.min(8000, parseInt(res.headers.get('Retry-After') || '2', 10) * 1000);
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, wait));
        return this._fetch(path, opts, attempt + 1);
      }
      throw new Error('rate-limited');
    }
    if (res.status === 401) throw new Error('token-expired');
    let body = null;
    try { body = await res.json(); } catch { /* empty body is fine */ }
    if (!res.ok) throw new Error((body && body.error) || `http-${res.status}`);
    return body;
  }

  /* --------------------------- bootstrap ---------------------------- */

  async init() {
    if (!this.hosted) return { mode: 'offline' };
    try {
      const me = await this._fetch('/api/v1/me');
      if (me && me.name && me.privacy !== 'hidden') {
        this.profile = { name: String(me.name).slice(0, 40), avatar: me.avatar || null, guest: false };
      }
      await this.syncTime();
      return { mode: 'hosted' };
    } catch (err) {
      // Structured {"error": ...} and network failures become recoverable states.
      return { mode: 'degraded', reason: String(err.message || err) };
    }
  }

  /** Synchronize with GET /api/v1/time using round-trip-adjusted offset. */
  async syncTime() {
    if (!this.hosted) { this._timeSynced = false; return false; }
    try {
      const t0 = Date.now();
      const body = await this._fetch('/api/v1/time');
      const t1 = Date.now();
      const serverMs = typeof body.now === 'number' ? body.now : Date.parse(body.now);
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

  /* --------------------------- presence ----------------------------- */

  startPresence() {
    if (!this.hosted || this._presenceTimer) return;
    const beat = () => this._fetch('/api/v1/presence', {
      method: 'POST', body: JSON.stringify({ scope: this.scope, state: 'playing' }),
    }).catch(() => { /* presence is best-effort */ });
    beat();
    this._presenceTimer = setInterval(beat, 30000); // throttled
  }

  stopPresence() {
    if (this._presenceTimer) { clearInterval(this._presenceTimer); this._presenceTimer = null; }
    if (this.hosted) {
      this._fetch('/api/v1/presence', { method: 'POST', body: JSON.stringify({ scope: this.scope, state: 'idle' }) })
        .catch(() => {});
    }
  }

  /* ---------------------- activity (playtime) ----------------------- */

  activityStart() {
    if (!this.hosted) return;
    this._fetch('/api/v1/activity/start', { method: 'POST', body: JSON.stringify({ scope: this.scope }) }).catch(() => {});
  }

  activityEnd() {
    if (!this.hosted) return;
    this._fetch('/api/v1/activity/end', { method: 'POST', body: JSON.stringify({ scope: this.scope }) }).catch(() => {});
  }

  /* --------------------------- cloud save --------------------------- */

  async saveProgress(doc) {
    if (!this.hosted || this.profile.guest) return { ok: false, reason: 'guest' };
    try {
      const r = await this._fetch('/api/v1/save', { method: 'PUT', body: JSON.stringify({ scope: this.scope, doc }) });
      return { ok: true, conflict: r && r.conflict === true, remote: r && r.doc };
    } catch (err) {
      return { ok: false, reason: String(err.message || err) };
    }
  }

  async loadProgress() {
    if (!this.hosted || this.profile.guest) return null;
    try {
      const r = await this._fetch(`/api/v1/save?scope=${encodeURIComponent(this.scope || '')}`);
      return r && r.doc ? r.doc : null;
    } catch {
      return null;
    }
  }

  /* -------------------------- leaderboards -------------------------- */

  /**
   * Submit a score with full provenance: ruleset, content version, seed,
   * assists, duration, and the replay envelope for validation.
   */
  async submitScore({ board, score, config, assists, durationTicks, envelope }) {
    const payload = {
      board, score,
      ruleset: config.id, contentVersion: config.version, seed: config.seed,
      assists, durationTicks, envelope,
    };
    if (!this.hosted) return { ok: false, reason: 'offline', local: true };
    try {
      const r = await this._fetch('/api/v1/scores', { method: 'POST', body: JSON.stringify(payload) });
      return { ok: true, rank: r && r.rank, validated: r && r.validated === true };
    } catch (err) {
      return { ok: false, reason: String(err.message || err) };
    }
  }

  async leaderboard(board, { friendsOnly = false } = {}) {
    if (!this.hosted) return null;
    try {
      const r = await this._fetch(`/api/v1/scores?board=${encodeURIComponent(board)}${friendsOnly ? '&friends=1' : ''}`);
      return r && Array.isArray(r.entries) ? r.entries : [];
    } catch {
      return null;
    }
  }

  /* --------------------------- telemetry ---------------------------- */

  /** Anonymous funnel events only; consent-gated; no raw text or PII. */
  track(event, detail = {}) {
    if (!this.telemetryConsent || !this.hosted) return;
    const allowed = ['start', 'tutorial_step', 'round_end', 'retry', 'settings_change', 'error'];
    if (!allowed.includes(event)) return;
    const clean = {};
    for (const k of ['mode', 'tier', 'step', 'reason', 'category']) {
      if (typeof detail[k] === 'string') clean[k] = detail[k].slice(0, 40);
      else if (typeof detail[k] === 'number') clean[k] = detail[k];
    }
    this._fetch('/api/v1/telemetry', {
      method: 'POST',
      body: JSON.stringify({ scope: this.scope, event, detail: clean, t: Date.now() }),
    }).catch(() => {});
  }
}
