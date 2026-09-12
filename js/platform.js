/**
 * Breeze Wing — platform module (StarHermit host adapter).
 *
 * Hosted contract (wiki): the platform opens the game as
 * index.html#game_token=<jwt> (optional &session_id=), stripped after the
 * read. The JWT carries sub = user id and game_scope = this game's slug —
 * never hard-coded. Same-origin /api calls send Authorization: Bearer; the
 * token is re-minted every 45 min via POST /api/v1/games/{slug}/launch-token.
 * The display name is the profile nickname from GET /api/v1/users/{sub}/profile
 * — never /api/v1/me, never usernames. Cloud save is ONE zip+base64 slot at
 * GET/PUT /api/v1/me/cloud-saves/{slug}: remote wins on boot, saves debounce
 * ~2 s and flush on pagehide/hidden. Game leaderboards are READ-ONLY for
 * clients (wiki): entries come from GET /api/v1/games/{slug} → leaderboardId
 * → GET /api/v1/leaderboards/{id}/entries; the game's own dev server keeps
 * its /api/v1/scores POST for local development only (no launch token).
 * Presence, activity and telemetry endpoints do not exist for launch tokens
 * and are deliberately not called. Everything degrades to local/offline
 * play: no token → localStorage only.
 *
 * Security: launch tokens are read from the URL and NEVER persisted.
 */

const REFRESH_MS = 45 * 60 * 1000; // token lives 60 min; re-mint at 45
const RETRY_MS = 60 * 1000;
const SAVE_DEBOUNCE_MS = 2000;

// Minimal ZIP writer/reader (stored entries only, no compression).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(name, dataBytes) {
  const enc = new TextEncoder();
  const nameB = enc.encode(name);
  const crc = crc32(dataBytes);
  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
  u32(crc); u32(dataBytes.length); u32(dataBytes.length);
  u16(nameB.length); u16(0);
  const head = new Uint8Array(out);
  const cd = [];
  const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
  const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
  c32(crc); c32(dataBytes.length); c32(dataBytes.length);
  c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0);
  const cdHead = new Uint8Array(cd);
  const cdOff = head.length + nameB.length + dataBytes.length;
  const parts = [head, nameB, dataBytes, cdHead, nameB];
  const eocd = [];
  const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
  e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
  e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
  parts.push(new Uint8Array(eocd));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}
function unzipFirstEntry(zipBytes) {
  const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let off = 0;
  while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
    const method = dv.getUint16(off + 8, true);
    const size = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const dataOff = off + 30 + nameLen + extraLen;
    if (method !== 0) throw new Error('unsupported zip entry');
    return zipBytes.slice(dataOff, dataOff + size);
  }
  throw new Error('bad zip');
}
function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class Platform {
  constructor() {
    this.launchToken = null;   // memory only
    this.scope = null;         // game slug from the JWT's game_scope
    this.userId = null;        // JWT sub
    this.hosted = false;       // a launch token was read (hosted mode)
    this.profile = { name: 'Guest', guest: true };
    this.sync = 'offline';     // offline | saving | synced (cloud save mirror)
    this._syncListeners = [];
    this._timeOffset = 0;
    this._timeSynced = false;
    this._refreshTimer = null;
    this._retryTimer = null;
    this._saveTimer = null;
    this._pendingSave = null;
    this._saveWaiters = [];
    this._profileNames = {};   // userId -> Promise<string>
  }

  get tokenHosted() { return this.hosted; }

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

  /* --------------------------- bootstrap ---------------------------- */

  // Fragment first (platform contract); query forms are local-dev only.
  _readLaunchToken() {
    try {
      const h = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
      const t = h.get('game_token');
      if (t) {
        h.delete('game_token');
        h.delete('session_id');
        const rest = h.toString();
        history.replaceState(null, '', location.pathname + location.search + (rest ? '#' + rest : ''));
        return t;
      }
      const q = new URLSearchParams(location.search);
      return q.get('game_token') || q.get('launch') || q.get('token') || null;
    } catch {
      return null;
    }
  }

  _decodeJwt(t) {
    try {
      const seg = String(t).split('.')[1];
      if (!seg) return null;
      let b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
      b64 += '='.repeat((4 - (b64.length % 4)) % 4);
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return null;
    }
  }

  async init() {
    this.launchToken = this._readLaunchToken();
    if (this.launchToken) {
      const claims = this._decodeJwt(this.launchToken);
      if (!claims) this.launchToken = null;
      else {
        if (typeof claims.sub === 'string' && claims.sub) this.userId = claims.sub;
        if (typeof claims.game_scope === 'string' && claims.game_scope) this.scope = claims.game_scope;
        if (!this.userId || !this.scope) this.launchToken = null;
      }
    }
    this.hosted = !!this.launchToken;
    if (!this.hosted) return { mode: 'offline' }; // localStorage only, zero /api calls

    this._scheduleRefresh();
    try { window.addEventListener('pagehide', () => this._flushSave()); } catch { /* no window events */ }
    document.addEventListener('visibilitychange', () => { if (document.hidden) this._flushSave(); });
    const ok = await this.syncTime();
    if (!ok) return { mode: 'degraded', reason: 'no-host' };
    const profile = await this.fetchProfile();
    if (profile) return { mode: 'hosted' };
    return { mode: 'degraded', reason: 'no-profile' };
  }

  /* --------------------------- identity ----------------------------- */
  // Nickname via GET /api/v1/users/{id}/profile — the only profile read a
  // game-scoped token may make. Never /api/v1/me, never usernames.
  profileFor(userId) {
    if (!userId || typeof userId !== 'string') return Promise.resolve('player');
    if (this._profileNames[userId]) return this._profileNames[userId];
    const p = this._fetch(`/api/v1/users/${encodeURIComponent(userId)}/profile`)
      .then((r) => (r && typeof r.nickname === 'string' && r.nickname ? r.nickname : null))
      .then((n) => n || ('Player ' + userId.slice(0, 8)))
      .catch(() => 'Player ' + userId.slice(0, 8));
    this._profileNames[userId] = p;
    return p;
  }

  async fetchProfile() {
    if (!this.userId) return null;
    const name = (await this.profileFor(this.userId)).slice(0, 40);
    this.profile = { name, guest: false };
    return this.profile;
  }

  /* --------------------------- token refresh ------------------------ */

  _scheduleRefresh() {
    if (this._refreshTimer) clearInterval(this._refreshTimer);
    this._refreshTimer = setInterval(() => this._refreshToken(), REFRESH_MS);
  }

  _refreshToken() {
    if (!this.launchToken || !this.scope) return Promise.resolve(false);
    return this._fetch(`/api/v1/games/${encodeURIComponent(this.scope)}/launch-token`, { method: 'POST', body: '{}' })
      .then((body) => {
        if (body && typeof body.token === 'string' && body.token) {
          this.launchToken = body.token;
          const claims = this._decodeJwt(this.launchToken);
          if (claims && claims.sub) this.userId = claims.sub;
          if (claims && claims.game_scope) this.scope = claims.game_scope;
          return true;
        }
        this._retryRefresh();
        return false;
      })
      .catch(() => { this._retryRefresh(); return false; });
  }

  _retryRefresh() {
    if (this._retryTimer || !this.launchToken) return;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._refreshToken();
    }, RETRY_MS);
  }

  /* ----------------------------- time ------------------------------- */

  /** Synchronize with GET /api/v1/time using round-trip-adjusted offset. */
  async syncTime() {
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

  /* --------------------------- cloud save --------------------------- */
  // ONE zip+base64 slot at /api/v1/me/cloud-saves/{slug}. The local save doc
  // remains the offline cache; this mirrors it. Remote wins on boot (the
  // caller merges), saves debounce ~2 s and flush on pagehide/hidden.

  async loadProgress() {
    if (!this.hosted) return null;
    try {
      const res = await fetch(`/api/v1/me/cloud-saves/${encodeURIComponent(this.scope)}`, {
        headers: this.launchToken ? { Authorization: `Bearer ${this.launchToken}` } : {},
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`http-${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (!buf.byteLength) return null;
      return JSON.parse(new TextDecoder().decode(unzipFirstEntry(buf)));
    } catch {
      return null;
    }
  }

  /** Queue a cloud mirror of the save doc (debounced; resolves on flush). */
  saveProgress(doc) {
    if (!this.hosted) return Promise.resolve({ ok: false, reason: 'offline' });
    this._pendingSave = doc;
    this._setSync('saving');
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._flushSave(), SAVE_DEBOUNCE_MS);
    return new Promise((resolve) => this._saveWaiters.push(resolve));
  }

  _flushSave() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    const waiters = this._saveWaiters;
    this._saveWaiters = [];
    const done = (result) => { for (const w of waiters) w(result); return result; };
    if (!this.hosted || !this.scope || this._pendingSave == null) {
      return Promise.resolve(done({ ok: false, reason: 'nothing-pending' }));
    }
    const doc = this._pendingSave;
    this._pendingSave = null;
    let body;
    try {
      body = { dataBase64: bytesToBase64(zipStore('save.json', new TextEncoder().encode(JSON.stringify(doc)))) };
    } catch {
      return Promise.resolve(done({ ok: false, reason: 'encode-failed' }));
    }
    return fetch(`/api/v1/me/cloud-saves/${encodeURIComponent(this.scope)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.launchToken}` },
      body: JSON.stringify(body),
      keepalive: true,
    }).then((res) => {
      if (res.ok) { this._setSync('synced'); return done({ ok: true }); }
      this._pendingSave = this._pendingSave == null ? doc : this._pendingSave;
      this._setSync('offline');
      return done({ ok: false, reason: `http-${res.status}` });
    }).catch(() => {
      this._pendingSave = this._pendingSave == null ? doc : this._pendingSave;
      this._setSync('offline');
      return done({ ok: false, reason: 'network' });
    });
  }

  /* -------------------------- leaderboards -------------------------- */
  // READ-ONLY on the platform (wiki: clients can never submit to a game
  // leaderboard). The daily/chase boards resolve through the game record's
  // leaderboardId; user ids become profile nicknames.

  /**
   * Hosted leaderboards are READ-ONLY for clients (wiki): with a launch
   * token this never submits. (The game's own dev server keeps its
   * replay-validated POST /api/v1/scores route for direct local testing;
   * the client no longer calls it, so offline/e2e builds make zero /api
   * calls without a token.)
   */
  async submitScore({ board, score, config, assists, durationTicks, envelope }) {
    return { ok: false, reason: this.hosted ? 'leaderboard-readonly' : 'offline', local: true };
  }

  /** Read a leaderboard. Returns entries ([] when none) or null on failure. */
  async leaderboard(board, { friendsOnly = false } = {}) {
    if (!this.hosted) return null;
    try {
      const game = await this._fetch(`/api/v1/games/${encodeURIComponent(this.scope)}`);
      const leaderboardId = game && game.leaderboardId;
      if (!leaderboardId) return null;
      const qs = new URLSearchParams({ page: '1', pageSize: '50' });
      if (friendsOnly) qs.set('friendsOnly', 'true');
      const r = await this._fetch(`/api/v1/leaderboards/${encodeURIComponent(leaderboardId)}/entries?${qs.toString()}`);
      const raw = (r && (r.entries || r.items)) || [];
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
  // No per-game presence/activity/telemetry endpoints are reachable with a
  // launch token (wiki), so hosted mode deliberately never calls them. These
  // stubs keep older call sites harmless; they are no-ops by design.

  startPresence() { /* not available on-platform — intentionally silent */ }
  stopPresence() { /* not available on-platform — intentionally silent */ }
  activityStart() { /* not available on-platform — intentionally silent */ }
  activityEnd() { /* not available on-platform — intentionally silent */ }
  track() { /* no client telemetry endpoint — intentionally silent */ }
}
