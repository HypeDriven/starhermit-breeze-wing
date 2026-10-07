// StarHermit adapter tests: the SDK runs in a sandbox with a stubbed fetch
// and launch fragment; js/platform.js (Platform) drives it. Run: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Platform } from '../js/platform.js';
import { ACCOUNT_STRINGS, GFX_STRINGS } from '../js/gfx-ui.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SLUG = 'breeze-wing';
const USER = 'a1b2c3d4-0000-4000-8000-000000000001';
const b64url = (s) => Buffer.from(s).toString('base64url');
const jwt = (claims) => `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify(claims))}.sig`;
const plain = (v) => JSON.parse(JSON.stringify(v));

function boot({ hash = '' } = {}) {
  const calls = [];
  const cloud = { bytes: null };
  const kv = { music: 0.2 };
  const ctx = {
    URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa, Blob, Response, console,
    setTimeout: (fn, ms) => (ms > 5000 ? 0 : setTimeout(fn, ms)),
    clearTimeout: (id) => { if (id) clearTimeout(id); },
    location: { hash, search: '', pathname: '/', hostname: 'localhost', origin: 'http://localhost', href: `http://localhost/${hash}` },
    history: { state: null, replaceState(_s, _t, url) { ctx.location.hash = url.includes('#') ? url.slice(url.indexOf('#')) : ''; } },
  };
  ctx.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers?.Authorization });
    const u = decodeURIComponent(url);
    if (u.endsWith(`/api/v1/users/${USER}/profile`)) return Response.json({ nickname: 'Thrower' });
    if (u.endsWith(`/cloud-saves/game:${SLUG}`)) {
      if (method === 'PUT') { cloud.bytes = Buffer.from(JSON.parse(init.body).dataBase64, 'base64'); return new Response(null, { status: 204 }); }
      return cloud.bytes ? new Response(cloud.bytes) : new Response('', { status: 404 });
    }
    if (u.endsWith(`/games/${SLUG}/settings`)) {
      if (method === 'PATCH') Object.assign(kv, JSON.parse(init.body).settings);
      return Response.json({ settings: kv });
    }
    if (u.endsWith(`/games/${SLUG}/controls`)) return Response.json({ actions: [{ action: 'hint', codes: ['KeyJ'] }] });
    if (u.endsWith(`/games/${SLUG}/leaderboards`)) return Response.json([{ id: 'lb1', key: 'high-score' }]);
    if (u.includes('/leaderboards/lb1/entries')) return Response.json({ items: [{ rank: 1, score: 900, userId: USER }], total: 1 });
    return new Response('', { status: 404 });
  };
  ctx.self = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'starhermit-sdk.js'), 'utf8'), ctx, { filename: 'starhermit-sdk.js' });
  ctx.StarHermit.init();
  return { ctx, calls, cloud, kv, SH: ctx.StarHermit, P: new Platform(ctx.StarHermit) };
}

const KEYS = { flap: ['Space'], hint: ['KeyH'] };

test('standalone: no token, no StarHermit requests', async () => {
  const { P, calls } = boot();
  assert.equal(P.hosted, false);
  assert.deepEqual(plain(await P.init()), { mode: 'offline' });
  assert.equal(await P.fetchProfile(), null);
  assert.equal(await P.profileFor('abcdef123456'), 'Player abcdef12');
  assert.equal(await P.avatarUrl(), null);
  assert.equal(await P.loadProgress(), null);
  assert.deepEqual(plain(await P.saveProgress({ v: 1 })), { ok: false, reason: 'offline' });
  assert.deepEqual(plain(await P.loadSettings()), {});
  assert.equal(P.mirrorSettings({ muted: true }), null);
  assert.deepEqual(plain(await P.loadBindings(KEYS)), KEYS);
  assert.equal(await P.leaderboard('daily'), null);
  assert.equal(P.inviteLink(), null);
  assert.equal(P.canSignIn(), false);
  assert.equal(calls.length, 0);
});

test('launch token: identity, cloud save game:<slug>, settings, bindings, board', async () => {
  const token = jwt({ sub: USER, game_scope: SLUG, exp: Math.floor(Date.now() / 1000) + 3600 });
  const { P, ctx, calls, cloud, kv } = boot({ hash: `#game_token=${token}&session_id=s1` });
  assert.equal(P.hosted, true);
  assert.equal(P.scope, SLUG);
  assert.equal(P.userId, USER);
  assert.equal(ctx.location.hash, '', 'launch fragment stripped');
  assert.equal((await P.fetchProfile()).name, 'Thrower');
  assert.equal(P.profile.guest, false);

  assert.deepEqual(plain(await P.loadSettings()), { music: 0.2 });
  await P.mirrorSettings({ music: 0.2, muted: true });
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.ok(patch.url.endsWith(`/api/v1/games/${SLUG}/settings`));
  assert.deepEqual(patch.body, { settings: { muted: true } });
  assert.equal(kv.muted, true);
  assert.deepEqual(plain(await P.loadBindings(KEYS)), { flap: ['Space'], hint: ['KeyJ'] });

  assert.equal(await P.loadProgress(), null);
  const doc = { version: 1, settings: {}, progress: { totalRuns: 3 } };
  const saved = P.saveProgress(doc);
  await P._flushSave();
  assert.deepEqual(plain(await saved), { ok: true });
  assert.equal(P.sync, 'synced');
  const put = calls.find((c) => c.method === 'PUT');
  assert.equal(decodeURIComponent(put.url), `/api/v1/me/cloud-saves/game:${SLUG}`);
  const again = boot({ hash: `#game_token=${token}` });
  again.cloud.bytes = cloud.bytes;
  assert.deepEqual(plain(await again.P.loadProgress()), doc);

  const board = await P.leaderboard('daily');
  assert.deepEqual(plain(board), [{ name: 'You (Thrower)', score: 900, you: true }]);
  assert.ok(calls.every((c) => c.auth === `Bearer ${token}`));
  assert.ok(!calls.some((c) => /\/api\/v1\/me(\/|$)/.test(c.url) && !c.url.includes('cloud-saves')), 'never /api/v1/me');
  assert.match(P.inviteLink(), new RegExp(`/game-invite/${USER}/${SLUG}$`));
});

test('sign-out on refused renewal returns to guest', async () => {
  const token = jwt({ sub: USER, game_scope: SLUG, exp: Math.floor(Date.now() / 1000) + 3600 });
  const { P, SH } = boot({ hash: `#game_token=${token}` });
  await P.fetchProfile();
  const seen = [];
  P.onAuth((a) => seen.push(a.signedIn));
  SH.signOut('expired');
  assert.deepEqual(seen, [false]);
  assert.equal(P.hosted, false);
  assert.equal(P.profile.guest, true);
  assert.equal(P.inviteLink(), null);
});

test('account strings exist in every required locale', () => {
  for (const loc of Object.keys(GFX_STRINGS))
    for (const k of Object.keys(ACCOUNT_STRINGS['en-US'])) assert.ok(ACCOUNT_STRINGS[loc]?.[k], `${loc}.${k}`);
  assert.equal(Object.keys(ACCOUNT_STRINGS).length, 9);
});
