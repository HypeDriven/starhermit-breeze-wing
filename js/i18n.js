/* Breeze Wing — localization (an ES module, pure: no DOM).
 *
 * Nine locales: en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT.
 * English source strings are the keys; js/strings.js holds the tables
 * (en-GB, es-ES and fr-CA carry only their differences from en-US, es-419
 * and fr-FR). The engine client (native/i18n.ts) picks the locale from the
 * runtime's interface language (Options › Language, else the account's
 * preferred language or the device's) and calls setLocale; T() falls back
 * regional → parent → English and fills {name} placeholders.
 * Content (js/content.js) keeps its English names as data; cfgName names it
 * in the current language at display time.
 */
import { STRINGS } from './strings.js';

export const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
const PARENT = { 'en-GB': 'en-US', 'es-ES': 'es-419', 'fr-CA': 'fr-FR' };
const hasOwn = Object.prototype.hasOwnProperty;
let lang = 'en-US';

export function setLocale(tag) { lang = LOCALES.includes(tag) ? tag : 'en-US'; }
export function currentLang() { return lang; }

function lookup(key) {
  for (let l = lang; l; l = PARENT[l]) {
    const t = STRINGS[l];
    if (t && hasOwn.call(t, key)) return t[key];
  }
  return key;
}

/** Translate an English source string; {name} placeholders filled from vars. */
export function T(key, vars) {
  let s = lookup(String(key));
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (hasOwn.call(vars, k) ? String(vars[k]) : m));
  return s;
}

/** Marks an English key that is translated with T() when shown. */
export const N = (s) => s;

/** Display name of a content config (content is authored in English). */
export function cfgName(cfg) {
  if (!cfg) return '';
  if (cfg.mode === 'daily' && cfg.dateKey) return T('Daily Breeze — {date}', { date: cfg.dateKey });
  if (cfg.mode === 'journey') {
    const m = /^Mastery: (.+)$/.exec(cfg.name);
    if (m) return T('Mastery: {sky}', { sky: T(m[1]) });
    const n = /^(.+) (\d+)$/.exec(cfg.name);
    if (n) return T('{sky} {n}', { sky: T(n[1]), n: n[2] });
  }
  return T(cfg.name);
}
