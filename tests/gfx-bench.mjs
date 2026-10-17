// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in the real Settings
// screen, starts today's Daily flight and keeps flying it with real Space presses (retrying through the
// results screen if the bird falls) so gates, scenery, particles and the post chain all run.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForFunction(() => window.__bw?.appState === 'title', null, { timeout: 20000 });
  await page.click('#btn-settings');
  await page.locator('#gfx-preset').scrollIntoViewIfNeeded();
  await page.selectOption('#gfx-preset', preset);
  await page.waitForFunction((p) => document.getElementById('game-canvas').dataset.gfxPreset === p, preset);
  await page.click('#btn-settings-back');
}

export async function start(page, { mobile } = {}) {
  await page.click('#btn-daily');
  await page.waitForSelector('#screen-setup:not([hidden])');
  await page.click('#btn-setup-start');
  await page.waitForFunction(() => window.__bw?.appState === 'active', null, { timeout: 10000 });
  await page.evaluate(() => document.activeElement?.blur());
  let open = true;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try {
        const st = await page.evaluate(() => {
          const s = window.__bw?.session?.state;
          if (!document.getElementById('screen-results').hidden) return 'results';
          if (!s) return null;
          const p = s.config.params;
          const next = s.gates.find((g) => !g.passed && g.x > -0.6);
          const target = next ? next.baseY + (p.oscAmp && p.oscFreq ? p.oscAmp * Math.sin(p.oscFreq * s.tick + next.oscPhase) : 0) : 0;
          return s.phase === 'ready' || (s.bird.y < target - 0.15 && s.bird.vy < 3) ? 'flap' : null;
        });
        if (st === 'results') {
          await page.click('#btn-retry', { timeout: 1000 }).catch(() => page.click('#btn-next', { timeout: 1000 }));
          await page.evaluate(() => document.activeElement?.blur());
        } else if (st === 'flap') {
          if (mobile) await page.touchscreen.tap(195, 600); else await page.keyboard.press('Space');
        }
        await page.waitForTimeout(45);
      } catch { if (!open) return; }
    }
  })();
  await page.waitForTimeout(500);
}
