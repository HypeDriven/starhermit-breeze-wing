/**
 * Breeze Wing — save-document tests: checksum integrity, migration,
 * descendant detection, and conflict merging.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSave, loadSave, writeSave, migrate, isDescendant, mergeSaves } from '../js/store.js';

function memStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

test('fresh profile when nothing stored', () => {
  const { doc, status } = loadSave(memStorage());
  assert.equal(status, 'fresh');
  assert.equal(doc.version, 1);
  assert.ok(doc.settings && doc.progress);
});

test('write→load round-trip preserves data and checksum', () => {
  const s = memStorage();
  const doc = defaultSave();
  doc.progress.totalRuns = 7;
  doc.settings.graphicsTier = 'high';
  assert.equal(writeSave(s, doc), true);
  const loaded = loadSave(s);
  assert.equal(loaded.status, 'loaded');
  assert.equal(loaded.doc.progress.totalRuns, 7);
  assert.equal(loaded.doc.settings.graphicsTier, 'high');
});

test('corrupted checksum resets cleanly and preserves evidence', () => {
  const s = memStorage();
  const doc = defaultSave();
  writeSave(s, doc);
  const raw = s.getItem('breezewing.save.v1');
  const tampered = JSON.parse(raw);
  tampered.progress.totalRuns = 9999; // tamper without fixing checksum
  s.setItem('breezewing.save.v1', JSON.stringify(tampered));
  const { doc: loaded, status } = loadSave(s);
  assert.equal(status, 'corrupt-reset');
  assert.equal(loaded.progress.totalRuns, 0);
  const keys = [...s._map.keys()];
  assert.ok(keys.some((k) => k.includes('corrupt')));
});

test('unreadable JSON handled', () => {
  const s = memStorage({ 'breezewing.save.v1': '{not json' });
  assert.equal(loadSave(s).status, 'unreadable');
});

test('migrate fills missing fields from defaults', () => {
  const d = migrate({ version: 0, progress: { totalRuns: 3 } });
  assert.equal(d.version, 1);
  assert.equal(d.progress.totalRuns, 3);
  assert.ok(d.settings.volumes);
});

test('isDescendant: strict progress supersets', () => {
  const a = defaultSave(); const b = defaultSave();
  a.progress.totalRuns = 5;
  a.progress.journey['journey-01'] = { cleared: true, bestScore: 100 };
  b.progress.totalRuns = 3;
  assert.equal(isDescendant(a, b), true);
  assert.equal(isDescendant(b, a), false);
});

test('mergeSaves unions progress from both sides', () => {
  const a = defaultSave(); const b = defaultSave();
  a.progress.journey['journey-01'] = { cleared: true, bestScore: 100 };
  b.progress.journey['journey-02'] = { cleared: true, bestScore: 250 };
  b.progress.achievements['first_clear'] = '2026-01-01T00:00:00Z';
  b.progress.daysPlayed = ['2026-01-01'];
  a.progress.daysPlayed = ['2026-01-02'];
  const m = mergeSaves(a, b);
  assert.ok(m.progress.journey['journey-01'].cleared);
  assert.ok(m.progress.journey['journey-02'].cleared);
  assert.ok(m.progress.achievements['first_clear']);
  assert.deepEqual([...m.progress.daysPlayed].sort(), ['2026-01-01', '2026-01-02']);
  // Inputs unchanged.
  assert.equal(Object.keys(a.progress.journey).length, 1);
});
