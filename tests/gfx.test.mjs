import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESETS, CATEGORIES, detectPreset, resolve, presetTier, choosePreset, describe,
  loadGraphics, saveGraphics, STORAGE_KEY,
} from '../js/gfx.js';
import { GFX_STRINGS, pickLocale, initialGraphics } from '../js/gfx-ui.js';

test('detectPreset: software renderers get low', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)'), 'low');
  assert.equal(detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  assert.equal(detectPreset('Microsoft Basic Render Driver'), 'low');
});

test('detectPreset: discrete GPUs and Apple M get high, integrated get balanced', () => {
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'high');
  assert.equal(detectPreset('AMD Radeon RX 6800 XT'), 'high');
  assert.equal(detectPreset('Apple M2'), 'high');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)'), 'balanced');
  assert.equal(detectPreset('AMD Radeon Graphics'), 'balanced');
  assert.equal(detectPreset('Adreno (TM) 740'), 'balanced');
  assert.equal(detectPreset(''), 'balanced');
});

test('detectPreset: touch-first devices are capped at balanced', () => {
  assert.equal(detectPreset('Apple M1', true), 'balanced');
  assert.equal(detectPreset('Adreno (TM) 740', true), 'balanced');
  assert.equal(detectPreset('SwiftShader', true), 'low');
});

test('resolve: auto uses the detected preset and its row', () => {
  const r = resolve({}, 'low');
  assert.equal(r.preset, 'low');
  assert.equal(r.auto, true);
  for (const cat of Object.keys(CATEGORIES)) assert.equal(r[cat], presetTier('low', cat));
  assert.equal(r.post, false, 'Low renders straight to the canvas');
  assert.equal(r.adaptive, true);
  assert.equal(r.showFps, false);
  assert.equal(resolve({ preset: 'auto' }, 'nonsense').preset, 'balanced');
});

test('resolve: explicit preset beats detection; overrides beat the preset', () => {
  const r = resolve({ preset: 'high', bloom: 'off', shadows: 'low', sky: 'bogus' }, 'low');
  assert.equal(r.preset, 'high');
  assert.equal(r.auto, false);
  assert.equal(r.bloom, 'off');
  assert.equal(r.shadows, 'low');
  assert.equal(r.sky, presetTier('high', 'sky'), 'invalid override falls back to the preset tier');
  assert.equal(r.antialias, 'smaa');
  assert.equal(r.post, true);
});

test('resolve: render scale multiplies the preset scale and is clamped to 50–200 %', () => {
  assert.equal(resolve({ preset: 'high', render_scale: 1.5 }).scale, 1.5);
  assert.equal(resolve({ preset: 'high', render_scale: 9 }).scale, 2);
  assert.equal(resolve({ preset: 'high', render_scale: 0.1 }).scale, 0.5);
  assert.equal(resolve({ preset: 'low', render_scale: 1 }).scale, 0.85);
  assert.equal(resolve({ preset: 'ultra', render_scale: 2 }).scale, 2.5);
  assert.equal(resolve({ preset: 'high', render_scale: 'x' }).renderScale, 1);
});

test('choosePreset clears every per-category override but keeps other options', () => {
  const saved = { preset: 'high', bloom: 'off', particles: 'low', render_scale: 1.25, adaptive: false, show_fps: true };
  const next = choosePreset(saved, 'low');
  assert.equal(next.preset, 'low');
  for (const cat of Object.keys(CATEGORIES)) assert.equal(next[cat], undefined);
  assert.equal(next.render_scale, 1.25);
  assert.equal(next.adaptive, false);
  assert.equal(next.show_fps, true);
  assert.equal(choosePreset(saved, 'auto').preset, 'auto');
  assert.equal(saved.bloom, 'off', 'input is not mutated');
});

test('every preset defines every category with a valid tier', () => {
  for (const p of PRESETS) {
    for (const [cat, tiers] of Object.entries(CATEGORIES)) assert.ok(tiers.includes(presetTier(p, cat)), `${p}.${cat}`);
  }
});

test('describe summarises cost and pixels, localizable', () => {
  const r = resolve({ preset: 'high' }, 'low');
  assert.equal(describe(r, [1280, 800]), '2048² shadows · bloom · colour grade · reflections · SMAA · 1280×800 px');
  assert.equal(describe(resolve({ preset: 'low' })), 'no shadows · no anti-aliasing');
  assert.match(describe(r, [10, 20], GFX_STRINGS['de-DE'].summary), /2048²-Schatten .* 10×20 px/);
});

test('graphics settings persist under a namespaced key; legacy tier seeds the preset once', () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.equal(loadGraphics(storage), null);
  assert.deepEqual(initialGraphics(storage, 'high'), { preset: 'high' });
  assert.deepEqual(initialGraphics(storage, 'medium'), { preset: 'auto' });
  saveGraphics(storage, { preset: 'ultra', bloom: 'off' });
  assert.ok(mem.has(STORAGE_KEY));
  assert.deepEqual(initialGraphics(storage, 'low'), { preset: 'ultra', bloom: 'off' });
  mem.set(STORAGE_KEY, '{not json');
  assert.equal(loadGraphics(storage), null);
});

test('panel strings exist for every supported locale and key', () => {
  const locales = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
  const en = GFX_STRINGS['en-US'];
  for (const l of locales) {
    const s = GFX_STRINGS[l];
    assert.ok(s, l);
    for (const k of Object.keys(en)) assert.ok(s[k], `${l}.${k}`);
    for (const p of PRESETS) assert.ok(s.presets[p], `${l}.presets.${p}`);
    for (const [cat, tiers] of Object.entries(CATEGORIES)) {
      assert.ok(s.cats[cat], `${l}.cats.${cat}`);
      for (const t of tiers) assert.ok(s.tiers[t], `${l}.tiers.${t}`);
    }
    assert.match(s.auto, /\{tier\}/);
    assert.match(s.fromPreset, /\{tier\}/);
  }
  assert.equal(pickLocale('es-MX'), 'es-419');
  assert.equal(pickLocale('es-ES'), 'es-ES');
  assert.equal(pickLocale('fr-CA'), 'fr-CA');
  assert.equal(pickLocale('fr-BE'), 'fr-FR');
  assert.equal(pickLocale('en-AU'), 'en-GB');
  assert.equal(pickLocale('pt-PT'), 'pt-BR');
  assert.equal(pickLocale('ja-JP'), 'en-US');
});
