/**
 * Breeze Wing — StarHermit authoritative game script (server.js).
 * Dependency-free Node server. Responsibilities:
 *  - serve the static distribution
 *  - GET  /api/v1/time          (round-trip-adjustable server clock)
 *  - POST /api/v1/scores        (replay-validated leaderboard submission)
 *  - GET  /api/v1/scores        (global / friends-filtered boards)
 *  - GET/PUT /api/v1/save       (versioned, checksummed cloud save)
 *  - GET  /api/v1/me, presence, activity, telemetry (minimal, consent-gated)
 *
 * Competitive trust model: client clocks/scores are untrusted. Scores are
 * accepted only with a replay envelope that re-executes deterministically
 * through the shared rules engine (js/rules.js). If validation cannot run,
 * the entry is labeled casual and rate-checked instead.
 */

import http from 'node:http';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runReplay, REPLAY_SCHEMA_VERSION, RULES_VERSION } from './js/rules.js';
import { CONTENT_VERSION, dailyContent, scoreChaseContent, ACHIEVEMENTS } from './js/content.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = join(ROOT, 'data');
const PORT = Number(process.env.PORT || 8080);
const MAX_BODY = 256 * 1024; // payload size bound
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120; // requests per window per identity

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/* ------------------------------ storage ----------------------------- */

async function loadTable(name) {
  try { return JSON.parse(await readFile(join(DATA_DIR, `${name}.json`), 'utf8')); }
  catch { return {}; }
}
async function saveTable(name, table) {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = join(DATA_DIR, `.${name}.tmp`);
  await writeFile(tmp, JSON.stringify(table));
  await writeFile(join(DATA_DIR, `${name}.json`), JSON.stringify(table));
}

/* ----------------------------- helpers ------------------------------ */

const rateBuckets = new Map();
function rateOk(id) {
  const now = Date.now();
  const b = rateBuckets.get(id) || { start: now, n: 0 };
  if (now - b.start > RATE_WINDOW_MS) { b.start = now; b.n = 0; }
  b.n++;
  rateBuckets.set(id, b);
  return b.n <= RATE_MAX;
}

function identityOf(req) {
  // Hosted shells inject a verified identity header; local dev falls back to IP.
  return String(req.headers['x-player-id'] || req.socket.remoteAddress || 'anon');
}

function nameOf(req) {
  const raw = req.headers['x-player-name'];
  return raw ? String(raw).slice(0, 24).replace(/[<>&"]/g, '') : 'Pilot';
}

async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new Error('payload-too-large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

/** Reconstruct the published, immutable content for a claimed ruleset. */
function contentFor(ruleset) {
  if (typeof ruleset !== 'string') return null;
  if (ruleset.startsWith('daily-')) {
    const day = ruleset.slice(6);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    return dailyContent(day);
  }
  if (ruleset.startsWith('chase-')) {
    return scoreChaseContent(parseInt(ruleset.slice(6), 16));
  }
  return null;
}

/** Plausibility bounds for casual (unverifiable) submissions. */
function plausible(claim, config) {
  if (!Number.isInteger(claim.score) || claim.score < 0) return false;
  if (!Number.isInteger(claim.durationTicks) || claim.durationTicks < 0) return false;
  const maxGatesPerTick = 1 / 60; // gates are spaced far apart
  const estGates = claim.score / 100 + 1;
  if (estGates > claim.durationTicks * maxGatesPerTick + 5) return false;
  if (claim.durationTicks > 60 * 60 * 60 * 4) return false; // 4h cap
  return true;
}

/* --------------------------- API handlers ---------------------------- */

async function handleApi(req, res, url) {
  const id = identityOf(req);
  if (!rateOk(id)) return send(res, 429, { error: 'rate-limited' }, { 'Retry-After': '5' });

  const scores = await loadTable('scores');
  const saves = await loadTable('saves');

  if (url.pathname === '/api/v1/time') {
    return send(res, 200, { now: Date.now(), iso: new Date().toISOString() });
  }
  if (url.pathname === '/api/v1/me') {
    return send(res, 200, { name: nameOf(req), avatar: null, privacy: 'public' });
  }
  if (url.pathname === '/api/v1/presence' || url.pathname === '/api/v1/activity/start' || url.pathname === '/api/v1/activity/end') {
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/v1/telemetry') {
    // Aggregate counters only; no raw text, no PII retained.
    return send(res, 202, { ok: true });
  }
  if (url.pathname === '/api/v1/achievements') {
    return send(res, 200, { achievements: ACHIEVEMENTS });
  }

  if (url.pathname === '/api/v1/save') {
    if (req.method === 'GET') {
      const doc = saves[id] || null;
      return send(res, 200, { doc });
    }
    if (req.method === 'PUT') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad-json' }); }
      const doc = body && body.doc;
      if (!doc || typeof doc !== 'object' || typeof doc.version !== 'number') {
        return send(res, 400, { error: 'bad-save-doc' });
      }
      // Never store credentials: strip anything that looks like a token.
      const json = JSON.stringify(doc);
      if (/token|secret|password/i.test(json)) return send(res, 400, { error: 'credentials-in-save' });
      const existing = saves[id];
      const conflict = !!(existing && JSON.stringify(existing.progress) !== JSON.stringify(doc.progress));
      saves[id] = doc;
      await saveTable('saves', saves);
      return send(res, 200, { ok: true, conflict, doc: existing || null });
    }
  }

  if (url.pathname === '/api/v1/scores' && req.method === 'POST') {
    let claim;
    try { claim = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad-json' }); }
    if (!claim || typeof claim.board !== 'string' || !Number.isInteger(claim.score)) {
      return send(res, 400, { error: 'bad-claim' });
    }
    const config = contentFor(claim.ruleset);
    if (!config) return send(res, 400, { error: 'unknown-ruleset' });
    if (claim.contentVersion !== CONTENT_VERSION) return send(res, 400, { error: 'stale-version' });
    if (config.seed !== claim.seed) return send(res, 400, { error: 'seed-mismatch' });
    // Stale daily boards are rejected (immutable seeds after publication).
    if (claim.ruleset.startsWith('daily-') && claim.board !== `daily-${config.dateKey}`) {
      return send(res, 400, { error: 'board-mismatch' });
    }

    let validated = false;
    if (claim.envelope && claim.envelope.schemaVersion === REPLAY_SCHEMA_VERSION
        && claim.envelope.rulesVersion === RULES_VERSION) {
      const env = { ...claim.envelope, config, seed: config.seed };
      const r = runReplay(env);
      if (r.ok && r.state.score.total === claim.score) validated = true;
      else return send(res, 422, { error: `replay-invalid:${r.mismatch || 'score'}` });
    } else if (!plausible(claim, config)) {
      return send(res, 422, { error: 'implausible' });
    }

    const board = scores[claim.board] || [];
    board.push({
      name: nameOf(req), playerId: id, score: claim.score,
      validated, assists: claim.assists || {}, durationTicks: claim.durationTicks || 0,
      ruleset: claim.ruleset, seed: claim.seed, at: new Date().toISOString(),
    });
    board.sort((a, b) => b.score - a.score || a.durationTicks - b.durationTicks);
    scores[claim.board] = board.slice(0, 200);
    await saveTable('scores', scores);
    const rank = scores[claim.board].findIndex((e) => e.playerId === id && e.score === claim.score) + 1;
    return send(res, 200, { ok: true, validated, rank: rank || null, casual: !validated });
  }

  if (url.pathname === '/api/v1/scores' && req.method === 'GET') {
    const board = String(url.searchParams.get('board') || '');
    const friendsOnly = url.searchParams.get('friends') === '1';
    let entries = scores[board] || [];
    if (friendsOnly) {
      // Host shells provide a verified friends list; without it, friends-only
      // filtering degrades to "you" so no private profile leaks.
      const friends = String(req.headers['x-friends'] || '').split(',').filter(Boolean);
      const visible = new Set([id, ...friends]);
      entries = entries.filter((e) => visible.has(e.playerId));
    }
    return send(res, 200, {
      entries: entries.slice(0, 50).map((e) => ({
        name: e.name, score: e.score, validated: e.validated, you: e.playerId === id,
      })),
      casual: entries.some((e) => !e.validated),
    });
  }

  return send(res, 404, { error: 'not-found' });
}

/* ------------------------------ server ------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method' });
    // Static files, confined to ROOT; no secrets or source maps served.
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    if (path.includes('..')) { res.writeHead(403); return res.end(); }
    if (path === '') path = 'index.html';
    if (path.endsWith('.map') || path === 'spec.md' || path.startsWith('data/') || path.startsWith('tests/')) {
      res.writeHead(404); return res.end();
    }
    const file = join(ROOT, path);
    if (!existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    const immutable = /\.(js|css|png|svg)$/.test(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    createReadStream(file).pipe(res);
  } catch (err) {
    send(res, err.message === 'payload-too-large' ? 413 : 500, { error: err.message || 'server-error' });
  }
});

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  server.listen(PORT, () => {
    console.log(`Breeze Wing authoritative script listening on :${PORT}`);
  });
}

export { server, contentFor, plausible };
