// Plays the web package in headless Chrome (the loader index.html that
// `npm run package` writes), past ~/games/tools/engine-web-smoke.mjs's start:
// at a desktop viewport with the keyboard (Enter on the focused Play opens
// lesson 1's setup, Enter on Start, Space flaps, the fall ends the flight on
// the results, Escape back to the title), at a phone viewport (keys into a
// round, then taps on the sky flap, Escape pauses) and at a phone held
// sideways, failing on console errors or warnings or the runtime's error
// screen.
//   node tools/browser-play.mjs [GAME_DIR] [--shots OUT_DIR]
// Serves GAME_DIR on loopback (never tests/, tools/ or dot-names), the engine
// itself from wiki.starhermit.com as the loader pins it. playwright-core is
// resolved from GAME_DIR's node_modules or any sibling game's.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const args = process.argv.slice(2);
const dir = resolve(args[0] ?? '.');
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const shots = opt('--shots', null);
const waitMs = Number(opt('--wait', '8000'));

function findPlaywright() {
  const roots = [dir, resolve(dir, '..'), ...readdirSync(resolve(dir, '..')).map((d) => resolve(dir, '..', d))];
  for (const r of roots) {
    const p = join(r, 'node_modules', 'playwright-core');
    if (existsSync(p)) return createRequire(join(r, 'package.json'))('playwright-core');
  }
  throw new Error('playwright-core not found');
}
const { chromium } = findPlaywright();

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/plain',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.glb': 'model/gltf-binary', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
  // The platform's public clock (serverTime()), as the platform answers it: the loopback server stands in.
  if (path === 'api/v1/time') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ serverTime: Date.now(), serverTimeIso: new Date().toISOString() })); return; }
  const parts = path.split('/');
  if (parts.some((p) => p.startsWith('.') || p === '..') || ['tests', 'tools', 'node_modules'].includes(parts[0])) { res.writeHead(404).end(); return; }
  const file = join(dir, path);
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--enable-features=Vulkan'] });
let failed = false;
const play = [['click', 4, 4], ['shot', 'title'], ['key', 'Enter'], ['shot', 'setup'], ['key', 'Enter'], ['wait', 6000], ['shot', 'countdown']];
const views = [
  // the software GPU runs the sim slower than wall time: generous waits before flying
  // two flaps, then the bird falls into the sea: the results follow (Escape: the title)
  { name: 'desktop', viewport: { width: 1366, height: 768 }, steps: [...play, ['wait', 16000], ['flaps', 2], ['shot', 'flying'], ['wait', 2000], ['shot', 'results'], ['key', 'Escape'], ['shot', 'title-again']] },
  // phone: into a round by keys, then taps on the sky flap
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, steps: [...play, ['wait', 8000], ['tap', 0.5, 0.45], ['tap', 0.5, 0.45], ['shot', 'tapped'], ['key', 'Escape'], ['shot', 'pause']] },
  { name: 'landscape', viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, steps: [...play, ['wait', 8000], ['tap', 0.45, 0.5], ['tap', 0.45, 0.5], ['shot', 'tapped'], ['key', 'Escape'], ['shot', 'pause']] },
];
for (const v of views) {
  const ctx = await browser.newContext({ viewport: v.viewport, isMobile: v.isMobile, hasTouch: v.hasTouch, deviceScaleFactor: v.deviceScaleFactor });
  const page = await ctx.newPage();
  const problems = [];
  const environment = /^No available adapters\.$|GL Driver Message/;
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !environment.test(m.text())) problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`); });
  await page.goto(url, { waitUntil: 'load' });
  const started = await page.waitForFunction(() => {
    const s = document.getElementById('starhermit-status');
    return document.documentElement.dataset.starhermit === 'error' || (s && s.hidden);
  }, null, { timeout: 60000 }).then(() => true, () => false);
  await page.waitForTimeout(6000);
  for (const [op, a, b] of v.steps) {
    if (op === 'key') { await page.keyboard.down(a); await page.waitForTimeout(120); await page.keyboard.up(a); }
    if (op === 'flaps') for (let i = 0; i < a; i++) { await page.keyboard.down('Space'); await page.waitForTimeout(80); await page.keyboard.up('Space'); await page.waitForTimeout(320); }
    if (op === 'tap') await page.touchscreen.tap(v.viewport.width * a, v.viewport.height * b);
    if (op === 'click') await page.mouse.click(a, b);
    if (op === 'wait') { await page.waitForTimeout(a); continue; }
    if (op === 'shot' && shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, `${v.name}-${a}.png`) }); }
    await page.waitForTimeout(2500);
  }
  const state = await page.evaluate(() => document.documentElement.dataset.starhermit ?? '');
  const ok = started && state !== 'error' && problems.length === 0;
  failed ||= !ok;
  console.log(`${ok ? 'ok' : 'not ok'} - ${v.name} played: started=${started} state=${state || '-'}`);
  for (const p of problems) console.log(`  ${p}`);
  await ctx.close();
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
