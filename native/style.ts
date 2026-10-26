// The look of the menus and HUD: the browser build's style sheet, rewritten
// class-based in tools/ui-style.css and converted once with `starhermit css`
// into assets/ui-style.json (`npm run css`), registered at start with the
// theme the runtime's own widgets (checkboxes, selects, scroll bars) fall
// back to. The browser build's body classes that swapped the palette are
// token sets here: the three colour-vision palettes (the game's setting) and
// high contrast (the runtime's accessibility option).
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

type Tokens = Record<string, string | number>;
let base: Tokens = {};

const PALETTES: Record<string, Tokens> = {
  deuteranopia: { accent: "#0067c2", "accent-hover": "#0a74d0", "accent-2": "#e0a100" },
  protanopia: { accent: "#0a6ed1", "accent-hover": "#167cdd", "accent-2": "#c99300" },
  tritanopia: { accent: "#c8373e", "accent-hover": "#d4464c", "accent-2": "#008f8f" },
};
const HIGH_CONTRAST: Tokens = {
  ink: "#000000", "ink-soft": "#1a1a1a", paper: "#fffffffa", accent: "#b32400", "accent-hover": "#c42a00",
  "accent-2": "#003da5", focus: "#000000", line: "#000000", "line-soft": "#000000",
};
export const ACCENT: Record<string, number> = { default: 0xd94f2b, deuteranopia: 0x0067c2, protanopia: 0x0a6ed1, tritanopia: 0xc8373e };

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  base = { ...(css.tokens as Tokens) };
  ui.setTheme({
    fontSize: 16, smallSize: 13, headingSize: 24, padding: 8, spacing: 8, radius: 12,
    text: "#1d2733", muted: "#44566b", panel: "#fffcf6", control: "#ffffff", hovered: "#f2f7ff",
    pressed: "#e4ecf8", field: "#ffffff", accent: "#d94f2b", focus: "#ffb43c", outline: "#1e2d462e",
  });
  ui.setTokens(css.tokens);
  ui.setAnimations(css.animations);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$ink" } },
    paragraph: { text: { color: "$ink" } },
    checkbox: {
      text: { color: "$ink" }, minHeight: 44,
      parts: { box: { background: "#ffffff", border: { width: 2, color: "$line" }, radius: 5 }, mark: { background: "$accent" } },
    },
    select: { text: { color: "$ink" }, background: "#ffffff", border: { width: 2, color: "$line" }, radius: 8, minHeight: 44 },
    scrollArea: { parts: { bar: { background: "$ink-soft", radius: 4 } } },
  });
}

let paletteKey = "";
/** The palette tokens: high contrast over the colour-vision palette over the sheet's. */
export function applyPalette(palette: string, highContrast: boolean): void {
  const key = `${palette}:${highContrast}`;
  if (key === paletteKey) return;
  paletteKey = key;
  const tokens: Tokens = { ...base, ...(PALETTES[palette] ?? {}) };
  if (highContrast) Object.assign(tokens, HIGH_CONTRAST);
  ui.setTokens(tokens);
}
