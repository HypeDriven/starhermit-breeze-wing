import test from 'node:test';
import '../js/gpu-level.js'; // window.StarHermitGpu (globalThis in Node)
import assert from 'node:assert/strict';
import {
  PRESETS, CATEGORIES, detectPreset, detectLevel, presetForLevel, BUDGETS, resolve, presetTier, choosePreset, describe,
  loadGraphics, saveGraphics, STORAGE_KEY,
} from '../js/gfx.js';
import { GFX_STRINGS, pickLocale, initialGraphics } from '../js/gfx-ui.js';

const desk = { webgl: true, webgl2: true, cores: 8, memoryGb: 8 };
const phone = { webgl: true, webgl2: true, mobile: true, cores: 8, memoryGb: 8 };

test('hardware level → preset: Low 0, Balanced 4, High 10, Ultra 17', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', desk), 'low');
  assert.equal(detectLevel('llvmpipe (LLVM 15.0.7, 256 bits)', desk), 0);
  assert.equal(detectPreset('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0)', desk), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)', desk), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)', desk), 'balanced');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0)', desk), 'high');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0)', desk), 'ultra');
  assert.equal(detectLevel('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', desk), 20);
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', desk), 'ultra');
  assert.equal(detectPreset('', desk), 'balanced');
  assert.equal(presetForLevel(3), 'low');
  assert.equal(presetForLevel(16), 'high');
});

test('phones and tablets are capped at Balanced; software GPUs stay Low', () => {
  assert.equal(detectPreset('Adreno (TM) 740', phone), 'balanced');
  assert.ok(detectLevel('Adreno (TM) 740', phone) <= 9);
  assert.equal(detectPreset('NVIDIA GeForce RTX 5090', phone), 'balanced');
  assert.equal(detectPreset('Mali-G77', phone), 'low');
  assert.equal(detectPreset('SwiftShader', phone), 'low');
});

test('every preset has an explicit budget; counts grow from Low to Ultra and scale with the level', () => {
  const order = ['low', 'balanced', 'high', 'ultra'];
  for (const p of order) for (const k of ['material', 'cloudDetail', 'scenery', 'tufts', 'particles', 'motes']) assert.ok(BUDGETS[p][k] != null, `${p}.${k}`);
  for (let i = 1; i < order.length; i++) {
    for (const k of ['cloudDetail', 'scenery', 'tufts', 'particles', 'motes']) assert.ok(BUDGETS[order[i]][k] >= BUDGETS[order[i - 1]][k], `${order[i]}.${k}`);
  }
  assert.equal(BUDGETS.low.material, 'lambert');
  const lowR = resolve({ preset: 'low' }, 'low', 0);
  assert.equal(lowR.budget.islands, 6);
  assert.equal(lowR.budget.motes, 0);
  const u17 = resolve({ preset: 'ultra' }, 'ultra', 17).budget, u20 = resolve({ preset: 'ultra' }, 'ultra', 20).budget;
  assert.ok(u20.pool > u17.pool && u20.islands >= u17.islands);
  assert.deepEqual(resolve({ preset: 'ultra' }, 'low', 0).budget, u17, 'a manual Ultra on a weak GPU keeps the Ultra floor budget');
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
