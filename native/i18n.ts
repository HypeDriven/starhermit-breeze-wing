// Localization: the engine's string tables (assets/strings.json, generated from
// the browser build's: English source strings as keys, the nine StarHermit
// locales; en-GB, es-ES and fr-CA hold their differences, the chain reads the
// rest) in the interface language the runtime reports (Options › Language, else
// the account's preferred language or the device's). The account lines are the
// engine's `starhermit.*` keys.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));

type Vars = Record<string, string | number>;
/** An English source string in the player's language; `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars | null): string { return strings.t(key, vars ?? undefined); }
/** Marks an English key that is translated with T() when shown. */
export const N = (s: string): string => s;
/** A content config's display name in the player's language (content is authored in English). */
export function cfgName(c: unknown): string {
  const cfg = c as { mode?: string; dateKey?: string; name: string } | null | undefined;
  if (!cfg) return "";
  if (cfg.mode === "daily" && cfg.dateKey) return T("Daily Breeze — {date}", { date: cfg.dateKey });
  if (cfg.mode === "journey") {
    const m = /^Mastery: (.+)$/.exec(cfg.name);
    if (m) return T("Mastery: {sky}", { sky: T(m[1]!) });
    const n = /^(.+) (\d+)$/.exec(cfg.name);
    if (n) return T("{sky} {n}", { sky: T(n[1]!), n: n[2]! });
  }
  return T(cfg.name);
}
