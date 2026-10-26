// The engine client's save document and the browser build's account data
// (js/migrate.js): the old cloud save (the SDK's save.json, the whole browser
// document) migrates, two devices' progress merges field by field, and the
// old per-player settings keep only what the game still owns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  progressFromSave, progressFromBrowserSave, saveDoc, mergeProgress, migrateSetting,
  GAME_SETTING_KEYS, BROWSER_SETTING_KEYS, DEFAULT_SETTINGS, normalizeProgress,
} from '../js/migrate.js';
import { defaultSave, writeSave } from '../js/store.js';

function browserDoc(progress) {
  const doc = defaultSave();
  Object.assign(doc.progress, progress);
  const mem = { setItem() {} };
  writeSave(mem, doc); // the checksum the browser build stored
  return doc;
}

test('the browser build cloud save migrates its progress', () => {
  const doc = browserDoc({ tutorialDone: true, lessons: { 'learn-1': true }, journey: { 'journey-01': { cleared: true, bestScore: 1400, bestTicks: 1200 } }, totalRuns: 7 });
  const p = progressFromBrowserSave(JSON.stringify(doc));
  assert.equal(p.tutorialDone, true);
  assert.equal(p.journey['journey-01'].bestScore, 1400);
  assert.equal(p.totalRuns, 7);
  assert.deepEqual(p.achievements, {});
  assert.equal(progressFromBrowserSave('not json'), null);
  assert.equal(progressFromBrowserSave(null), null);
  assert.equal(progressFromBrowserSave('{"settings":{}}'), null);
});

test('engine saves round-trip and reject other shapes', () => {
  const p = normalizeProgress({ totalGates: 12 });
  assert.deepEqual(progressFromSave(saveDoc(p)), p);
  assert.equal(progressFromSave({ v: 2, progress: p }), null);
  assert.equal(progressFromSave(null), null);
  assert.equal(progressFromSave([]), null);
});

test('two devices merge field by field, the local boards without duplicates', () => {
  const run = { name: 'Ana', score: 900, date: '2026-10-20', contentId: 'daily-2026-10-20', seed: 1, you: true };
  const a = normalizeProgress({ lessons: { 'learn-1': true }, journey: { 'journey-01': { cleared: true, bestScore: 1000, bestTicks: 1300 } }, best: { x: 5 }, localBoard: [run], daysPlayed: ['2026-10-20'], totalRuns: 3 });
  const b = normalizeProgress({ lessons: { 'learn-2': true }, journey: { 'journey-01': { cleared: false, bestScore: 1200, bestTicks: 1250 } }, best: { x: 9 }, localBoard: [run], daysPlayed: ['2026-10-21'], achievements: { first_clear: '2026-10-20T00:00:00Z' }, totalRuns: 5 });
  const m = mergeProgress(a, b);
  assert.deepEqual(Object.keys(m.lessons).sort(), ['learn-1', 'learn-2']);
  assert.deepEqual(m.journey['journey-01'], { cleared: true, bestScore: 1200, bestTicks: 1250 });
  assert.equal(m.best.x, 9);
  assert.equal(m.localBoard.length, 1);
  assert.deepEqual(m.daysPlayed.sort(), ['2026-10-20', '2026-10-21']);
  assert.ok(m.achievements.first_clear);
  assert.equal(m.totalRuns, 5);
  // merging a copy with itself changes nothing
  assert.deepEqual(mergeProgress(m, m), m);
  assert.deepEqual(mergeProgress(null, a), a);
  assert.deepEqual(mergeProgress(b, null), b);
});

test('old settings: the game keeps its own, the runtime owns the rest', () => {
  assert.deepEqual(GAME_SETTING_KEYS.sort(), ['assistArc', 'colorPalette', 'haptics', 'leftHanded']);
  for (const k of GAME_SETTING_KEYS) assert.ok(BROWSER_SETTING_KEYS.includes(k));
  assert.ok(BROWSER_SETTING_KEYS.includes('volumes') && BROWSER_SETTING_KEYS.includes('ui.language'));
  assert.equal(migrateSetting('colorPalette', 'tritanopia'), 'tritanopia');
  assert.equal(migrateSetting('colorPalette', 'mauve'), undefined);
  assert.equal(migrateSetting('assistArc', false), false);
  assert.equal(migrateSetting('haptics', 'yes'), undefined);
  assert.equal(migrateSetting('volumes', { music: 0.2 }), undefined);
  assert.equal(migrateSetting('reducedMotion', true), undefined);
  assert.deepEqual(DEFAULT_SETTINGS, { colorPalette: 'default', leftHanded: false, assistArc: true, haptics: true });
});
