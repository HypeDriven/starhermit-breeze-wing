/**
 * Breeze Wing — Graphics settings section (inside the Settings screen).
 * Builds the controls, localizes them, persists per device (js/gfx.js
 * STORAGE_KEY) and applies every change to the renderer immediately.
 */

import { PRESETS, CATEGORIES, presetTier, choosePreset, loadGraphics, saveGraphics } from './gfx.js';

/* ------------------------------ strings ------------------------------ */

const EN_US = {
  graphics: 'Graphics', quality: 'Quality', auto: 'Auto (detected: {tier})', renderScale: 'Render scale',
  fromPreset: 'From preset ({tier})', adaptive: 'Adaptive resolution', showFps: 'Show frame rate',
  postFailed: 'Post-processing is unavailable on this device, so effects render without it.',
  presets: { low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra' },
  cats: { shadows: 'Shadows', bloom: 'Bloom', grade: 'Color grade', antialias: 'Anti-aliasing', reflections: 'Reflections', sky: 'Sky', scenery: 'Scenery', detail: 'Surface detail', particles: 'Particles' },
  tiers: { off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High', plain: 'Plain', detailed: 'Detailed', sparse: 'Sparse', normal: 'Normal', rich: 'Rich', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA' },
  summary: { noShadows: 'no shadows', shadows: '{n}² shadows', bloom: 'bloom', grade: 'color grade', reflections: 'reflections', noAA: 'no anti-aliasing', px: '{w}×{h} px' },
};

const EN_GB = {
  ...EN_US,
  cats: { ...EN_US.cats, grade: 'Colour grade' },
  summary: { ...EN_US.summary, grade: 'colour grade' },
};

const ES_419 = {
  graphics: 'Gráficos', quality: 'Calidad', auto: 'Automática (detectada: {tier})', renderScale: 'Escala de renderizado',
  fromPreset: 'Según el ajuste ({tier})', adaptive: 'Resolución adaptable', showFps: 'Mostrar cuadros por segundo',
  postFailed: 'El posprocesamiento no está disponible en este dispositivo; los efectos se muestran sin él.',
  presets: { low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
  cats: { shadows: 'Sombras', bloom: 'Resplandor', grade: 'Corrección de color', antialias: 'Suavizado de bordes', reflections: 'Reflejos', sky: 'Cielo', scenery: 'Paisaje', detail: 'Detalle de superficies', particles: 'Partículas' },
  tiers: { off: 'No', on: 'Sí', low: 'Bajo', medium: 'Medio', high: 'Alto', plain: 'Simple', detailed: 'Detallado', sparse: 'Escaso', normal: 'Normal', rich: 'Abundante', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA' },
  summary: { noShadows: 'sin sombras', shadows: 'sombras {n}²', bloom: 'resplandor', grade: 'corrección de color', reflections: 'reflejos', noAA: 'sin suavizado', px: '{w}×{h} px' },
};

const ES_ES = {
  ...ES_419,
  showFps: 'Mostrar fotogramas por segundo',
  renderScale: 'Escala de renderizado',
};

const DE_DE = {
  graphics: 'Grafik', quality: 'Qualität', auto: 'Automatisch (erkannt: {tier})', renderScale: 'Renderskalierung',
  fromPreset: 'Wie Voreinstellung ({tier})', adaptive: 'Adaptive Auflösung', showFps: 'Bildrate anzeigen',
  postFailed: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; Effekte werden ohne sie dargestellt.',
  presets: { low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra' },
  cats: { shadows: 'Schatten', bloom: 'Leuchteffekt', grade: 'Farbkorrektur', antialias: 'Kantenglättung', reflections: 'Spiegelungen', sky: 'Himmel', scenery: 'Landschaft', detail: 'Oberflächendetails', particles: 'Partikel' },
  tiers: { off: 'Aus', on: 'An', low: 'Niedrig', medium: 'Mittel', high: 'Hoch', plain: 'Einfach', detailed: 'Detailliert', sparse: 'Spärlich', normal: 'Normal', rich: 'Reich', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA' },
  summary: { noShadows: 'keine Schatten', shadows: '{n}²-Schatten', bloom: 'Leuchteffekt', grade: 'Farbkorrektur', reflections: 'Spiegelungen', noAA: 'keine Kantenglättung', px: '{w}×{h} px' },
};

const FR_FR = {
  graphics: 'Graphismes', quality: 'Qualité', auto: 'Auto (détectée : {tier})', renderScale: 'Échelle de rendu',
  fromPreset: 'Selon le préréglage ({tier})', adaptive: 'Résolution adaptative', showFps: 'Afficher les images par seconde',
  postFailed: 'Le post-traitement est indisponible sur cet appareil ; les effets sont rendus sans lui.',
  presets: { low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra' },
  cats: { shadows: 'Ombres', bloom: 'Halo lumineux', grade: 'Étalonnage des couleurs', antialias: 'Anticrénelage', reflections: 'Reflets', sky: 'Ciel', scenery: 'Décor', detail: 'Détail des surfaces', particles: 'Particules' },
  tiers: { off: 'Désactivé', on: 'Activé', low: 'Bas', medium: 'Moyen', high: 'Élevé', plain: 'Simple', detailed: 'Détaillé', sparse: 'Clairsemé', normal: 'Normal', rich: 'Riche', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA' },
  summary: { noShadows: 'sans ombres', shadows: 'ombres {n}²', bloom: 'halo lumineux', grade: 'étalonnage', reflections: 'reflets', noAA: 'sans anticrénelage', px: '{w}×{h} px' },
};

const FR_CA = {
  ...FR_FR,
  showFps: 'Afficher la fréquence d’images',
  cats: { ...FR_FR.cats, bloom: 'Lueur' },
  summary: { ...FR_FR.summary, bloom: 'lueur' },
};

const PT_BR = {
  graphics: 'Gráficos', quality: 'Qualidade', auto: 'Automática (detectada: {tier})', renderScale: 'Escala de renderização',
  fromPreset: 'Conforme a predefinição ({tier})', adaptive: 'Resolução adaptável', showFps: 'Mostrar taxa de quadros',
  postFailed: 'O pós-processamento não está disponível neste dispositivo; os efeitos são exibidos sem ele.',
  presets: { low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
  cats: { shadows: 'Sombras', bloom: 'Brilho', grade: 'Correção de cor', antialias: 'Suavização de bordas', reflections: 'Reflexos', sky: 'Céu', scenery: 'Cenário', detail: 'Detalhe das superfícies', particles: 'Partículas' },
  tiers: { off: 'Desligado', on: 'Ligado', low: 'Baixo', medium: 'Médio', high: 'Alto', plain: 'Simples', detailed: 'Detalhado', sparse: 'Esparso', normal: 'Normal', rich: 'Rico', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA' },
  summary: { noShadows: 'sem sombras', shadows: 'sombras {n}²', bloom: 'brilho', grade: 'correção de cor', reflections: 'reflexos', noAA: 'sem suavização', px: '{w}×{h} px' },
};

const IT_IT = {
  graphics: 'Grafica', quality: 'Qualità', auto: 'Automatica (rilevata: {tier})', renderScale: 'Scala di rendering',
  fromPreset: 'Da preimpostazione ({tier})', adaptive: 'Risoluzione adattiva', showFps: 'Mostra frequenza fotogrammi',
  postFailed: 'La post-elaborazione non è disponibile su questo dispositivo; gli effetti vengono resi senza.',
  presets: { low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra' },
  cats: { shadows: 'Ombre', bloom: 'Bagliore', grade: 'Correzione colore', antialias: 'Antialiasing', reflections: 'Riflessi', sky: 'Cielo', scenery: 'Scenario', detail: 'Dettaglio superfici', particles: 'Particelle' },
  tiers: { off: 'No', on: 'Sì', low: 'Basso', medium: 'Medio', high: 'Alto', plain: 'Semplice', detailed: 'Dettagliato', sparse: 'Rado', normal: 'Normale', rich: 'Ricco', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA' },
  summary: { noShadows: 'senza ombre', shadows: 'ombre {n}²', bloom: 'bagliore', grade: 'correzione colore', reflections: 'riflessi', noAA: 'senza antialiasing', px: '{w}×{h} px' },
};

export const GFX_STRINGS = {
  'en-US': EN_US, 'en-GB': EN_GB, 'es-419': ES_419, 'es-ES': ES_ES, 'de-DE': DE_DE,
  'fr-FR': FR_FR, 'fr-CA': FR_CA, 'pt-BR': PT_BR, 'it-IT': IT_IT,
};

/** Best supported locale for a BCP-47 tag (the game has no language setting). */
export function pickLocale(tag) {
  const t = String(tag || 'en-US');
  if (GFX_STRINGS[t]) return t;
  const [lang, region = ''] = t.split('-');
  const r = region.toUpperCase();
  if (lang === 'en') return ['GB', 'IE', 'AU', 'NZ', 'ZA', 'IN'].includes(r) ? 'en-GB' : 'en-US';
  if (lang === 'es') return r === 'ES' ? 'es-ES' : 'es-419';
  if (lang === 'fr') return r === 'CA' ? 'fr-CA' : 'fr-FR';
  if (lang === 'pt') return 'pt-BR';
  if (lang === 'de') return 'de-DE';
  if (lang === 'it') return 'it-IT';
  return 'en-US';
}

/** StarHermit account strings (title sign-in / invite, toasts). `{name}` = display name. */
export const ACCOUNT_STRINGS = {
  "en-US": {
    "signIn": "Sign in with StarHermit",
    "invite": "Invite a friend",
    "inviteCopied": "Invite link copied to the clipboard.",
    "inviteFailed": "Could not copy the invite link.",
    "offline": "Offline — progress is stored on this device.",
    "playingAs": "Playing as {name}",
    "synced": "progress synced",
    "saving": "saving…",
    "syncOff": "cloud sync unavailable",
    "signedOut": "Signed out of StarHermit — progress stays on this device."
  },
  "en-GB": {
    "signIn": "Sign in with StarHermit",
    "invite": "Invite a friend",
    "inviteCopied": "Invite link copied to the clipboard.",
    "inviteFailed": "Could not copy the invite link.",
    "offline": "Offline — progress is stored on this device.",
    "playingAs": "Playing as {name}",
    "synced": "progress synced",
    "saving": "saving…",
    "syncOff": "cloud sync unavailable",
    "signedOut": "Signed out of StarHermit — progress stays on this device."
  },
  "es-419": {
    "signIn": "Iniciar sesión con StarHermit",
    "invite": "Invitar a un amigo",
    "inviteCopied": "Enlace de invitación copiado al portapapeles.",
    "inviteFailed": "No se pudo copiar el enlace de invitación.",
    "offline": "Sin conexión: el progreso se guarda en este dispositivo.",
    "playingAs": "Jugando como {name}",
    "synced": "progreso sincronizado",
    "saving": "guardando…",
    "syncOff": "sincronización en la nube no disponible",
    "signedOut": "Sesión de StarHermit cerrada: el progreso se queda en este dispositivo."
  },
  "es-ES": {
    "signIn": "Iniciar sesión con StarHermit",
    "invite": "Invitar a un amigo",
    "inviteCopied": "Enlace de invitación copiado en el portapapeles.",
    "inviteFailed": "No se pudo copiar el enlace de invitación.",
    "offline": "Sin conexión: el progreso se guarda en este dispositivo.",
    "playingAs": "Jugando como {name}",
    "synced": "progreso sincronizado",
    "saving": "guardando…",
    "syncOff": "sincronización en la nube no disponible",
    "signedOut": "Sesión de StarHermit cerrada: el progreso se queda en este dispositivo."
  },
  "de-DE": {
    "signIn": "Mit StarHermit anmelden",
    "invite": "Freund einladen",
    "inviteCopied": "Einladungslink in die Zwischenablage kopiert.",
    "inviteFailed": "Einladungslink konnte nicht kopiert werden.",
    "offline": "Offline – der Fortschritt wird auf diesem Gerät gespeichert.",
    "playingAs": "Du spielst als {name}",
    "synced": "Fortschritt synchronisiert",
    "saving": "wird gespeichert …",
    "syncOff": "Cloud-Synchronisierung nicht verfügbar",
    "signedOut": "Von StarHermit abgemeldet – der Fortschritt bleibt auf diesem Gerät."
  },
  "fr-FR": {
    "signIn": "Se connecter avec StarHermit",
    "invite": "Inviter un ami",
    "inviteCopied": "Lien d’invitation copié dans le presse-papiers.",
    "inviteFailed": "Impossible de copier le lien d’invitation.",
    "offline": "Hors ligne : la progression est enregistrée sur cet appareil.",
    "playingAs": "Vous jouez en tant que {name}",
    "synced": "progression synchronisée",
    "saving": "enregistrement…",
    "syncOff": "synchronisation cloud indisponible",
    "signedOut": "Déconnecté de StarHermit : la progression reste sur cet appareil."
  },
  "fr-CA": {
    "signIn": "Se connecter avec StarHermit",
    "invite": "Inviter un ami",
    "inviteCopied": "Lien d’invitation copié dans le presse-papiers.",
    "inviteFailed": "Impossible de copier le lien d’invitation.",
    "offline": "Hors ligne : la progression est enregistrée sur cet appareil.",
    "playingAs": "Vous jouez en tant que {name}",
    "synced": "progression synchronisée",
    "saving": "enregistrement…",
    "syncOff": "synchronisation infonuagique indisponible",
    "signedOut": "Déconnecté de StarHermit : la progression reste sur cet appareil."
  },
  "pt-BR": {
    "signIn": "Entrar com a StarHermit",
    "invite": "Convidar um amigo",
    "inviteCopied": "Link de convite copiado para a área de transferência.",
    "inviteFailed": "Não foi possível copiar o link de convite.",
    "offline": "Offline — o progresso fica salvo neste dispositivo.",
    "playingAs": "Jogando como {name}",
    "synced": "progresso sincronizado",
    "saving": "salvando…",
    "syncOff": "sincronização na nuvem indisponível",
    "signedOut": "Você saiu da StarHermit — o progresso continua neste dispositivo."
  },
  "it-IT": {
    "signIn": "Accedi con StarHermit",
    "invite": "Invita un amico",
    "inviteCopied": "Link di invito copiato negli appunti.",
    "inviteFailed": "Impossibile copiare il link di invito.",
    "offline": "Offline: i progressi sono salvati su questo dispositivo.",
    "playingAs": "Stai giocando come {name}",
    "synced": "progressi sincronizzati",
    "saving": "salvataggio…",
    "syncOff": "sincronizzazione cloud non disponibile",
    "signedOut": "Disconnesso da StarHermit: i progressi restano su questo dispositivo."
  }
};

export function accountStrings(tag) { return ACCOUNT_STRINGS[pickLocale(tag)]; }

/* ------------------------------ panel ------------------------------- */

export class GraphicsPanel {
  /**
   * @param {HTMLElement} root  the Graphics <fieldset>
   * @param {import('./render.js').Renderer} renderer
   * @param {Storage} storage
   */
  constructor(root, renderer, storage, saved, locale) {
    this.root = root;
    this.renderer = renderer;
    this.storage = storage;
    this.saved = { ...(saved || {}) };
    this.locale = pickLocale(locale);
    this.s = GFX_STRINGS[this.locale];
    this._build();
    this.sync();
  }

  _build() {
    const s = this.s;
    const r = this.root;
    r.replaceChildren();
    r.lang = this.locale;
    const legend = document.createElement('legend');
    legend.textContent = s.graphics;
    r.append(legend);

    const grid = document.createElement('div');
    grid.className = 'gfx-grid';
    r.append(grid);

    const field = (labelText, control) => {
      const label = document.createElement('label');
      const span = document.createElement('span');
      span.textContent = labelText;
      label.append(span, control);
      grid.append(label);
      return label;
    };

    // Quality preset.
    this.presetSel = document.createElement('select');
    this.presetSel.id = 'gfx-preset';
    this.presetSel.dataset.gfx = 'preset';
    for (const v of ['auto', ...PRESETS]) this.presetSel.append(new Option(v === 'auto' ? '' : s.presets[v], v));
    this.presetSel.addEventListener('change', () => {
      this.saved = choosePreset(this.saved, this.presetSel.value);
      this._commit();
    });
    field(s.quality, this.presetSel).classList.add('gfx-wide');

    // Render scale 50–200 %.
    const wrap = document.createElement('span');
    wrap.className = 'gfx-scale';
    this.scaleInput = document.createElement('input');
    Object.assign(this.scaleInput, { type: 'range', id: 'gfx-scale', min: '50', max: '200', step: '5' });
    this.scaleInput.dataset.gfx = 'render_scale';
    this.scaleOut = document.createElement('output');
    this.scaleOut.id = 'gfx-scale-out';
    this.scaleOut.htmlFor = 'gfx-scale';
    wrap.append(this.scaleInput, this.scaleOut);
    this.scaleInput.addEventListener('input', () => {
      this.scaleOut.textContent = `${this.scaleInput.value}%`;
      this.saved.render_scale = Number(this.scaleInput.value) / 100;
      this._commit();
    });
    field(s.renderScale, wrap).classList.add('gfx-wide');

    // One select per category.
    this.catSel = {};
    for (const [cat, tiers] of Object.entries(CATEGORIES)) {
      const sel = document.createElement('select');
      sel.id = `gfx-${cat}`;
      sel.dataset.gfx = cat;
      sel.append(new Option('', 'preset'));
      for (const t of tiers) sel.append(new Option(s.tiers[t] || t, t));
      sel.addEventListener('change', () => {
        if (sel.value === 'preset') delete this.saved[cat];
        else this.saved[cat] = sel.value;
        this._commit();
      });
      this.catSel[cat] = sel;
      field(s.cats[cat], sel);
    }

    // Toggles.
    const check = (id, text, key, dflt) => {
      const label = document.createElement('label');
      label.className = 'check gfx-wide';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.id = id;
      input.dataset.gfx = key;
      input.addEventListener('change', () => {
        this.saved[key] = input.checked;
        this._commit();
      });
      label.append(input, document.createTextNode(` ${text}`));
      grid.append(label);
      return { input, dflt };
    };
    this.adaptive = check('gfx-adaptive', s.adaptive, 'adaptive', true);
    this.showFps = check('gfx-fps', s.showFps, 'show_fps', false);

    this.summary = document.createElement('p');
    this.summary.id = 'gfx-summary';
    this.summary.className = 'gfx-summary';
    this.postNote = document.createElement('p');
    this.postNote.id = 'gfx-post-note';
    this.postNote.className = 'gfx-note';
    this.postNote.textContent = s.postFailed;
    this.postNote.hidden = true;
    r.append(this.summary, this.postNote);
  }

  _commit() {
    saveGraphics(this.storage, this.saved);
    this.renderer.setGraphics(this.saved);
    this.sync();
    // Pixel size and post chain settle on the next frame.
    requestAnimationFrame(() => this.refreshInfo());
  }

  /** Reflect saved + resolved state in the controls. */
  sync() {
    const s = this.s;
    const q = this.renderer.q;
    const tierName = (p) => s.presets[p] || p;
    this.presetSel.options[0].textContent = s.auto.replace('{tier}', tierName(this.renderer.detected));
    this.presetSel.value = PRESETS.includes(this.saved.preset) ? this.saved.preset : 'auto';
    const pct = Math.round((Number(this.saved.render_scale) || 1) * 100);
    this.scaleInput.value = String(Math.min(200, Math.max(50, pct)));
    this.scaleOut.textContent = `${this.scaleInput.value}%`;
    for (const [cat, sel] of Object.entries(this.catSel)) {
      const pt = presetTier(q.preset, cat);
      sel.options[0].textContent = s.fromPreset.replace('{tier}', s.tiers[pt] || pt);
      sel.value = CATEGORIES[cat].includes(this.saved[cat]) ? this.saved[cat] : 'preset';
    }
    this.adaptive.input.checked = this.saved.adaptive !== false;
    this.showFps.input.checked = !!this.saved.show_fps;
    document.body.dataset.gfxPreset = q.preset;
    this.refreshInfo();
  }

  /** GPU · cost summary · W×H px, plus the post-processing note when relevant. */
  refreshInfo() {
    const info = this.renderer.graphicsInfo(this.s.summary);
    const fps = info.resolved.showFps && info.fps ? ` · ${info.fps} fps` : '';
    this.summary.textContent = `${info.gpu} · ${info.summary}${fps}`;
    this.postNote.hidden = !info.postFailed;
  }
}

/** Saved graphics for this device; older saves' quality tier seeds the preset once. */
export function initialGraphics(storage, legacyTier) {
  const saved = loadGraphics(storage);
  if (saved) return saved;
  if (legacyTier === 'low' || legacyTier === 'high') return { preset: legacyTier };
  return { preset: 'auto' };
}
