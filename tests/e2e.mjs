/**
 * Breeze Wing — end-to-end QA playthrough (dev only, not shipped).
 *
 * Drives the real visible UI in headless Chrome via playwright-core:
 *   desktop (1280x800): title → journey grid → stage 1 setup → countdown →
 *     flap autopilot (real Space key presses, timed off the exposed
 *     window.__bw state) → cleared → results → next stage → pause/resume →
 *     crash → results → menu → settings → help.
 *   mobile (390x844, touch): title → Play (learn lesson 1) → tap-to-flap
 *     until lesson cleared → results → journey stage → tap pause/resume →
 *     leave round → results.
 *
 * Self-contained: starts its own static server on an ephemeral port.
 * (The repo's server.js is the StarHermit authoritative game script and is
 * intentionally NOT used here; the game runs fully offline as a guest.)
 *
 * Exits non-zero on any failure or any non-benign page/console error.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHOT = (stage, vp) => `/tmp/breeze-wing-e2e-${stage}-${vp}.png`;

// Same benign-noise filter as tools/production_game_audit.mjs.
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2', '.ts': 'video/mp2t', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
      if (!path || path === '.') path = 'index.html';
      const file = join(ROOT, path);
      if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* ------------------------------ helpers ------------------------------ */

const appState = (page) => page.evaluate(() => window.__bw?.appState);

async function waitAppState(page, state, timeout = 10000) {
  await page.waitForFunction((s) => window.__bw?.appState === s, state, { timeout });
}

/** Remove focus from any button so Space presses flap instead of clicking. */
const blurFocus = (page) => page.evaluate(() => document.activeElement?.blur());

/**
 * Flap autopilot: reads the exposed rules state to decide WHEN to flap,
 * but every flap is a real UI input (Space key, or a touchscreen tap).
 * Bang-bang control: flap when the bird falls below the next gate's gap
 * center and is not already rising fast. Resolves with the terminal state.
 */
async function flyUntilTerminal(page, { tap = false, maxMs = 90000 } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < maxMs) {
    const st = await page.evaluate(() => {
      const s = window.__bw?.session?.state;
      if (!s) return null;
      const p = s.config.params;
      const next = s.gates.find((g) => !g.passed && g.x > -0.6);
      const target = next
        ? next.baseY + (p.oscAmp && p.oscFreq ? p.oscAmp * Math.sin(p.oscFreq * s.tick + next.oscPhase) : 0)
        : 0;
      return {
        phase: s.phase, y: s.bird.y, vy: s.bird.vy, target,
        gatesPassed: s.gatesPassed, terminal: s.terminal,
      };
    });
    if (!st) throw new Error('session vanished mid-flight');
    last = st;
    if (st.phase === 'terminal') return st;
    // READY phase: sim waits for a take-off flap before gravity applies.
    if (st.phase === 'ready' || (st.y < st.target - 0.15 && st.vy < 3)) {
      if (tap) await page.touchscreen.tap(195, 600);
      else await page.keyboard.press('Space');
    }
    await page.waitForTimeout(45);
  }
  throw new Error(`flight did not reach a terminal state within ${maxMs}ms (last: ${JSON.stringify(last)})`);
}

/* ------------------------------- passes ------------------------------ */

async function desktopPass(browser, base, errors) {
  const vp = 'desktop';
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`[desktop] pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !browserNoise.test(m.text())) errors.push(`[desktop] console: ${m.text()}`);
  });
  let stage1End = null;

  const step = async (name, fn) => { await fn(); console.log(`ok - [desktop] ${name}`); };

  await step('load + title visible', async () => {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForSelector('#screen-title:not([hidden])', { timeout: 15000 });
    await waitAppState(page, 'title');
    await page.screenshot({ path: SHOT('title', vp) });
  });

  await step('journey grid shows 40 stages', async () => {
    await page.click('#btn-journey');
    await page.waitForSelector('#screen-journey:not([hidden])');
    const cells = await page.locator('.jstage').count();
    if (cells !== 40) throw new Error(`expected 40 journey stages, got ${cells}`);
    await page.screenshot({ path: SHOT('journey', vp) });
  });

  await step('stage 1 setup', async () => {
    await page.locator('.jstage').first().click();
    await page.waitForSelector('#screen-setup:not([hidden])');
    await page.screenshot({ path: SHOT('setup', vp) });
  });

  await step('start → countdown → active', async () => {
    await page.click('#btn-setup-start');
    await waitAppState(page, 'countdown');
    await page.screenshot({ path: SHOT('countdown', vp) });
    await waitAppState(page, 'active', 8000);
    if (await page.locator('#hud').isHidden()) throw new Error('HUD not visible in play');
    await blurFocus(page);
  });

  await step('fly stage 1 to a result (real Space flaps)', async () => {
    const fly = flyUntilTerminal(page);
    await page.waitForTimeout(2500); // mid-flight screenshot
    await page.screenshot({ path: SHOT('play', vp) });
    const end = await fly;
    stage1End = end;
    console.log(`  stage 1 ended: ${end.terminal?.reason}, gates ${end.gatesPassed}`);
    await page.waitForSelector('#screen-results:not([hidden])', { timeout: 8000 });
    const total = await page.textContent('#bd-total');
    if (!Number(total) && end.terminal?.reason === 'cleared') throw new Error('cleared round scored 0');
    await page.screenshot({ path: SHOT('results', vp) });
    if (end.terminal?.reason !== 'cleared') {
      console.log('  note: autopilot crashed before clearing stage 1 — continuing with retry path');
    }
  });

  await step('next/retry → pause → resume → crash out', async () => {
    if (stage1End?.terminal?.reason === 'cleared') {
      // Regression: a cleared journey stage must offer the Next-stage action
      // (results read content metadata from the raw round config).
      if (!(await page.locator('#btn-next').isVisible())) {
        throw new Error('cleared journey stage but the Next-stage button is hidden');
      }
      await page.click('#btn-next');
    } else {
      await page.click('#btn-retry');
    }
    await waitAppState(page, 'active', 8000);
    await blurFocus(page);
    await page.click('#btn-pause');
    await page.waitForSelector('#screen-pause:not([hidden])');
    if (await page.evaluate(() => window.__bw.appState) !== 'paused') throw new Error('not paused');
    await page.screenshot({ path: SHOT('pause', vp) });
    await page.click('#btn-resume');
    await waitAppState(page, 'active');
    // One take-off flap, then deliberately stop: the bird falls into the sea.
    await blurFocus(page);
    await page.keyboard.press('Space');
    await page.waitForSelector('#screen-results:not([hidden])', { timeout: 15000 });
    const sub = await page.textContent('#results-sub');
    if (!/sea|sky|wing/.test(sub)) console.log(`  note: unexpected end reason text: "${sub}"`);
    await page.screenshot({ path: SHOT('crash', vp) });
    await page.click('#btn-results-menu');
    await page.waitForSelector('#screen-title:not([hidden])');
  });

  await step('progression persisted', async () => {
    const p = await page.evaluate(() => ({
      totalRuns: window.__bw.progress.totalRuns,
      totalGates: window.__bw.progress.totalGates,
      journey: Object.keys(window.__bw.progress.journey).length,
    }));
    if (p.totalRuns < 2 || !p.journey) throw new Error(`progress not persisted: ${JSON.stringify(p)}`);
    console.log(`  runs ${p.totalRuns}, gates ${p.totalGates}, journey records ${p.journey}`);
  });

  await step('settings open/apply/close', async () => {
    await page.click('#btn-settings');
    await page.waitForSelector('#screen-settings:not([hidden])');
    await page.check('#set-motion');
    await page.selectOption('#set-palette', 'deuteranopia');
    const applied = await page.evaluate(() => ({
      motion: document.body.classList.contains('reduced-motion'),
      palette: document.body.classList.contains('palette-deuteranopia'),
    }));
    if (!applied.motion || !applied.palette) throw new Error('settings not applied: ' + JSON.stringify(applied));
    await page.screenshot({ path: SHOT('settings', vp) });
    await page.click('#btn-settings-back');
    await page.waitForSelector('#screen-title:not([hidden])');
  });

  await step('help open/close', async () => {
    await page.click('#btn-help');
    await page.waitForSelector('#screen-help:not([hidden])');
    await page.screenshot({ path: SHOT('help', vp) });
    await page.click('#btn-help-back');
    await page.waitForSelector('#screen-title:not([hidden])');
  });

  await step('daily abandon targets the dated board exactly once', async () => {
    // Regression: ranked submission must use the raw config's dateKey (the
    // normalized rules config does not carry it) and must fire exactly once
    // per round (leave-round previously finished the session twice).
    await page.evaluate(() => {
      window.__capturedBoards = [];
      window.__runsBefore = window.__bw.progress.totalRuns;
      window.__bw.platform.submitScore = (p) => {
        window.__capturedBoards.push(p.board);
        return Promise.resolve({ ok: false, reason: 'spy' });
      };
    });
    await page.click('#btn-daily');
    await page.waitForSelector('#screen-setup:not([hidden])');
    await page.click('#btn-setup-start');
    await waitAppState(page, 'active', 8000);
    await blurFocus(page);
    await page.keyboard.press('Space'); // take off
    await page.click('#btn-pause');
    await page.waitForSelector('#screen-pause:not([hidden])');
    await page.click('#btn-leave');
    await page.waitForSelector('#screen-results:not([hidden])', { timeout: 8000 });
    await page.waitForTimeout(1400); // let any stale terminal timer fire
    const check = await page.evaluate(() => ({
      boards: window.__capturedBoards,
      runsDelta: window.__bw.progress.totalRuns - window.__runsBefore,
      dayKey: new Date().toISOString().slice(0, 10),
    }));
    if (check.boards.length !== 1 || check.boards[0] !== `daily-${check.dayKey}`) {
      throw new Error(`ranked daily submission wrong: ${JSON.stringify(check.boards)} (expected exactly one entry for daily-${check.dayKey})`);
    }
    if (check.runsDelta !== 1) throw new Error(`round progressed ${check.runsDelta} times (expected 1)`);
    await page.click('#btn-results-menu');
    await page.waitForSelector('#screen-title:not([hidden])');
  });

  await context.close();
}

async function mobilePass(browser, base, errors) {
  const vp = 'mobile';
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`[mobile] pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !browserNoise.test(m.text())) errors.push(`[mobile] console: ${m.text()}`);
  });

  const step = async (name, fn) => { await fn(); console.log(`ok - [mobile] ${name}`); };

  await step('load + title visible', async () => {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForSelector('#screen-title:not([hidden])', { timeout: 15000 });
    await waitAppState(page, 'title');
    await page.screenshot({ path: SHOT('title', vp) });
  });

  await step('Play → lesson 1 setup → start', async () => {
    await page.click('#btn-play'); // fresh profile: tutorial not done → lesson 1
    await page.waitForSelector('#screen-setup:not([hidden])');
    await page.click('#btn-setup-start');
    await waitAppState(page, 'active', 8000);
  });

  await step('tap to flap until lesson cleared', async () => {
    const end = await flyUntilTerminal(page, { tap: true });
    console.log(`  lesson ended: ${end.terminal?.reason}`);
    if (end.terminal?.reason !== 'cleared') throw new Error('lesson 1 not cleared by tapping');
    await page.waitForSelector('#screen-results:not([hidden])', { timeout: 8000 });
    const heading = await page.textContent('#results-heading');
    if (!/Clear/i.test(heading)) throw new Error(`unexpected results heading: ${heading}`);
    await page.screenshot({ path: SHOT('lesson-results', vp) });
  });

  await step('journey stage → pause/resume via touch → leave round', async () => {
    await page.click('#btn-results-menu');
    await page.waitForSelector('#screen-title:not([hidden])');
    await page.click('#btn-journey');
    await page.locator('.jstage').first().click();
    await page.click('#btn-setup-start');
    await waitAppState(page, 'active', 8000);
    await page.tap('#btn-pause');
    await page.waitForSelector('#screen-pause:not([hidden])');
    await page.screenshot({ path: SHOT('pause', vp) });
    await page.tap('#btn-resume');
    await waitAppState(page, 'active');
    // Flap a few times via touch, then leave the round from pause.
    for (let i = 0; i < 3; i++) { await page.touchscreen.tap(195, 600); await page.waitForTimeout(300); }
    await page.tap('#btn-pause');
    await page.waitForSelector('#screen-pause:not([hidden])');
    await page.tap('#btn-leave');
    await page.waitForSelector('#screen-results:not([hidden])', { timeout: 8000 });
    await page.screenshot({ path: SHOT('leave-results', vp) });
    await page.tap('#btn-results-menu');
    await page.waitForSelector('#screen-title:not([hidden])');
  });

  await context.close();
}

/* -------------------------------- main ------------------------------- */

const server = await startServer();
const base = `http://127.0.0.1:${server.address().port}`;
let browser = null;
const errors = [];

try {
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });

  await desktopPass(browser, base, errors);
  if (errors.length) throw new Error('page errors during desktop pass:\n' + errors.join('\n'));

  await mobilePass(browser, base, errors);
  if (errors.length) throw new Error('page errors during mobile pass:\n' + errors.join('\n'));

  console.log('\nE2E PASS — Breeze Wing playable end-to-end on desktop + mobile, no page errors');
} catch (err) {
  console.error(`\nE2E FAIL: ${err.message}`);
  if (errors.length) console.error('PAGE ERRORS:\n' + errors.join('\n'));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await new Promise((r) => server.close(r));
}
