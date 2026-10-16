// Localization coverage: every English key the markup, code and content use is
// translated in every locale (en-GB → en-US, es-ES → es-419, fr-CA → fr-FR
// inherit), placeholders and markup survive, and the language follows
// sh-language.js and switches live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadTables, codeKeys, htmlKeys, audit, bootI18n } from './i18n-common.mjs';
import { THEMES, LESSONS, CHALLENGES, PRACTICE_PRESETS, ACHIEVEMENTS, scoreChaseContent } from '../js/content.js';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

export function usedKeys() {
  const keys = new Set(htmlKeys(read('index.html')));
  for (const f of ['js/ui.js', 'js/main.js', 'js/platform.js']) codeKeys(read(f)).forEach((k) => keys.add(k));
  for (const t of Object.values(THEMES)) keys.add(t.name);
  for (const l of LESSONS) { keys.add(l.name); keys.add(l.lesson.prompt); keys.add(l.lesson.goalText); }
  for (const c of CHALLENGES) { keys.add(c.name); keys.add(c.blurb); }
  for (const p of PRACTICE_PRESETS) { keys.add(p.name); keys.add(p.difficulty); }
  keys.add(scoreChaseContent('x').name);
  for (const a of ACHIEVEMENTS) { keys.add(a.name); keys.add(a.desc); }
  ['3', '2', '1'].forEach((k) => keys.delete(k));
  return [...keys].sort();
}

test('every used key is translated in every locale; placeholders and markup intact', () => {
  assert.deepEqual(audit(loadTables(ROOT, 'js/strings.js', 'BW_STRINGS'), usedKeys()), []);
});

test('the locale follows sh-language and switches live', () => {
  const { I18N, events, doc } = bootI18n(ROOT, { strings: 'js/strings.js', i18n: 'js/i18n.js', global: 'BWI18N', languages: ['de-DE'] });
  assert.equal(I18N.lang, 'de-DE');
  assert.equal(doc.documentElement.lang, 'de-DE');
  assert.equal(I18N.T('Resume'), 'Fortsetzen');
  I18N.language.setChoice('fr-CA');
  assert.equal(I18N.lang, 'fr-CA');
  assert.equal(events.at(-1), 'fr-CA');
  assert.equal(I18N.T('Flaps left: {n}', { n: 4 }).includes('4'), true);
  I18N.language.setChoice('en-GB');
  assert.equal(I18N.T('Color palette'), 'Colour palette');
});
