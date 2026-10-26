// Localization coverage: every English key the engine client (native/*.ts)
// and the content use is translated in every locale (en-GB → en-US, es-ES →
// es-419, fr-CA → fr-FR inherit), placeholders and markup survive, no table
// keeps a key nothing uses, and the locale switches and falls back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { codeKeys, audit } from './i18n-common.mjs';
import { STRINGS } from '../js/strings.js';
import { T, setLocale, currentLang, cfgName, LOCALES } from '../js/i18n.js';
import { THEMES, LESSONS, CHALLENGES, PRACTICE_PRESETS, ACHIEVEMENTS, JOURNEY, scoreChaseContent, dailyContent } from '../js/content.js';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

export function usedKeys() {
  const keys = new Set();
  for (const f of readdirSync(new URL('native/', ROOT)).filter((n) => n.endsWith('.ts'))) codeKeys(read(`native/${f}`)).forEach((k) => keys.add(k));
  codeKeys(read('js/i18n.js')).forEach((k) => keys.add(k));
  for (const t of Object.values(THEMES)) keys.add(t.name);
  for (const l of LESSONS) { keys.add(l.name); keys.add(l.lesson.prompt); keys.add(l.lesson.goalText); }
  for (const c of CHALLENGES) { keys.add(c.name); keys.add(c.blurb); }
  for (const p of PRACTICE_PRESETS) { keys.add(p.name); keys.add(p.difficulty); }
  keys.add(scoreChaseContent('x').name);
  for (const a of ACHIEVEMENTS) { keys.add(a.name); keys.add(a.desc); }
  // Results reasons (a table of keys in screens.ts) and the setup facts' content-driven lines.
  for (const k of ['You met the sea.', 'You clipped the sky.', 'A gate edge caught your wing.', 'Out of flaps — so close!', 'Time ran out.', 'Lesson complete!', 'Every gate threaded.', 'You headed home early.']) keys.add(k);
  ['3', '2', '1'].forEach((k) => keys.delete(k));
  return [...keys].sort();
}

test('ships the nine StarHermit locales', () => {
  assert.deepEqual(LOCALES, ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT']);
});

test('found the keys in code', () => assert.ok(usedKeys().length > 150, String(usedKeys().length)));

test('every used key is translated in every locale; placeholders and markup intact; no unused keys', () => {
  assert.deepEqual(audit(STRINGS, usedKeys()), []);
});

test('content names translate at display time', () => {
  setLocale('de-DE');
  assert.equal(currentLang(), 'de-DE');
  assert.equal(T('Resume'), 'Fortsetzen');
  assert.ok(cfgName(JOURNEY[0]).length > 0);
  assert.ok(cfgName(dailyContent('2026-10-26')).includes('2026-10-26'));
  setLocale('fr-CA');
  assert.equal(T('Gate {n}. Score {score}.', { n: 2, score: 9 }), 'Porte 2. Pointage 9.');
  assert.equal(T('Flaps left: {n}', { n: 4 }).includes('4'), true);
  setLocale('en-GB');
  assert.equal(T('Color palette'), 'Colour palette');
  setLocale('xx-YY');
  assert.equal(currentLang(), 'en-US');
  assert.equal(T('Flaps left: {n}', { n: 4 }), 'Flaps left: 4');
});
