/** App-wide settings, stored by the native side as one JSON document. */

import type { CustomStyle } from '../writingStyles/types';

export type ThemeId = 'encyclopedia' | 'parchment' | 'typewriter' | 'midnight' | 'lorekeeper' | 'contrast';
export type ThemeMode = 'dark' | 'light';

export const THEMES: { id: ThemeId; name: string; description: string }[] = [
  { id: 'encyclopedia', name: 'Encyclopedia', description: 'Clean reference-book styling, the default' },
  { id: 'parchment', name: 'Parchment', description: 'Warm paper and old-style serif type' },
  { id: 'typewriter', name: 'Typewriter', description: 'Stark contrast and monospaced type' },
  { id: 'midnight', name: 'Midnight Ink', description: 'Deep blue tones and a modern serif' },
  { id: 'lorekeeper', name: 'Lorekeeper', description: 'Sepia ink, parchment and terracotta' },
  { id: 'contrast', name: 'High contrast', description: 'The strongest text contrast, and clear borders' },
];

export interface WritingFont {
  /** What the settings store. An empty value in settings means the theme's own font. */
  id: string;
  name: string;
  /** A CSS font-family list. It ends in a generic family, for when a system font is missing. */
  stack: string;
  /** Bundled fonts ship with the app. System fonts depend on this computer. */
  source: 'bundled' | 'system';
}

export const WRITING_FONTS: WritingFont[] = [
  { id: 'opendyslexic', name: 'OpenDyslexic (dyslexia-friendly)', stack: "'OpenDyslexic', 'Comic Sans MS', sans-serif", source: 'bundled' },
  { id: 'atkinson', name: 'Atkinson Hyperlegible (letters easy to tell apart)', stack: "'Atkinson Hyperlegible', 'Segoe UI', sans-serif", source: 'bundled' },
  { id: 'source-serif', name: 'Source Serif', stack: "'Source Serif 4', Georgia, serif", source: 'bundled' },
  { id: 'eb-garamond', name: 'EB Garamond', stack: "'EB Garamond', Georgia, serif", source: 'bundled' },
  { id: 'libertinus', name: 'Libertinus Serif', stack: "'Libertinus Serif', Georgia, serif", source: 'bundled' },
  { id: 'courier-prime', name: 'Courier Prime', stack: "'Courier Prime', 'Courier New', monospace", source: 'bundled' },
  { id: 'inter', name: 'Inter', stack: "'Inter', 'Segoe UI', sans-serif", source: 'bundled' },
  { id: 'georgia', name: 'Georgia', stack: 'Georgia, serif', source: 'system' },
  { id: 'times', name: 'Times New Roman', stack: "'Times New Roman', Times, serif", source: 'system' },
  { id: 'cambria', name: 'Cambria', stack: 'Cambria, Georgia, serif', source: 'system' },
  { id: 'palatino', name: 'Palatino Linotype', stack: "'Palatino Linotype', Palatino, 'Book Antiqua', serif", source: 'system' },
  { id: 'garamond', name: 'Garamond', stack: "Garamond, 'EB Garamond', serif", source: 'system' },
  { id: 'calibri', name: 'Calibri', stack: 'Calibri, Carlito, sans-serif', source: 'system' },
  { id: 'segoe', name: 'Segoe UI', stack: "'Segoe UI', system-ui, sans-serif", source: 'system' },
  { id: 'arial', name: 'Arial', stack: 'Arial, Helvetica, sans-serif', source: 'system' },
  { id: 'verdana', name: 'Verdana', stack: 'Verdana, Geneva, sans-serif', source: 'system' },
  { id: 'courier-new', name: 'Courier New', stack: "'Courier New', Courier, monospace", source: 'system' },
  { id: 'consolas', name: 'Consolas', stack: "Consolas, 'Courier New', monospace", source: 'system' },
];

export type ParagraphStyle = 'spaced' | 'indented';

/** Line spacing and page width, in the units the settings screen shows. */
export const LINE_SPACING = { min: 1.2, max: 2.6, step: 0.05, standard: 1.75 };
/** Page width in em of the manuscript text, so it stays the same line length at any text size. */
export const PAGE_WIDTH = { min: 28, max: 80, step: 1, standard: 48 };

function clamp(value: unknown, range: { min: number; max: number; standard: number }): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : range.standard;
  return Math.min(range.max, Math.max(range.min, number));
}

export interface WritingStyle {
  /** A font-family list, or null to use the theme's own. */
  font: string | null;
  lineHeight: string;
  pageWidth: string;
  paragraphs: ParagraphStyle;
}

/** Turns the stored settings into CSS values. Anything out of range falls back to something usable. */
export function writingStyle(editor: {
  writingFont?: unknown;
  lineSpacing?: unknown;
  pageWidth?: unknown;
  paragraphStyle?: unknown;
}): WritingStyle {
  return {
    font: WRITING_FONTS.find((f) => f.id === editor.writingFont)?.stack ?? null,
    lineHeight: String(clamp(editor.lineSpacing, LINE_SPACING)),
    pageWidth: `${clamp(editor.pageWidth, PAGE_WIDTH)}em`,
    paragraphs: editor.paragraphStyle === 'indented' ? 'indented' : 'spaced',
  };
}

export type ProviderKind = 'openai-compatible' | 'openai' | 'anthropic';

export interface AiProfile {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  /** Sent to the provider's servers, so the UI warns before sending. */
  isCloud: boolean;
  /** Optional, shown as cost estimates. US dollars per million tokens. */
  inputCostPerMTok?: number;
  outputCostPerMTok?: number;
  /** Upper limit on response tokens. */
  maxTokens?: number;
  /** How much context to send, in tokens. */
  contextTokens?: number;
  /** Anthropic and OpenAI: low | medium | high | xhigh | max. */
  effort?: string;
  /**
   * Whether this profile may be sent images. Unset means automatic: yes for Anthropic and
   * OpenAI, and for a local server whatever its `/props` reports, or no if it does not say.
   */
  supportsImages?: boolean;
}

export type AiTask = 'chat' | 'rewrite' | 'extract' | 'consistency';

export interface RecentFile {
  path: string;
  name: string;
  openedAt: string;
}

/** A project's tabs, panes and places, as `src/shell/workspace.ts` left them. */
export interface SavedWorkspace {
  /** The project's id, or its path if an old file has none. */
  key: string;
  savedAt: string;
  layout: unknown;
  places: unknown;
}

export interface Settings {
  appearance: {
    theme: ThemeId;
    mode: ThemeMode;
    /** Interface size, 1 = 100%. */
    uiScale: number;
    /** Article and manuscript text size, 1 = 100%. */
    contentScale: number;
  };
  editor: {
    spellcheck: boolean;
    typewriterScroll: boolean;
    showFormattingBar: boolean;
    dailyWordGoal: number;
    /** Underlines known page names in the manuscript. */
    highlightNames: boolean;
    /** An id from `WRITING_FONTS`. Empty means the theme's own font. */
    writingFont: string;
    /** Use the writing font for wiki articles too. */
    writingFontInWiki: boolean;
    /** Line height of the manuscript. */
    lineSpacing: number;
    /** Width of the manuscript page, in em of its text. */
    pageWidth: number;
    paragraphStyle: ParagraphStyle;
  };
  help: {
    /** The first-run guide has been shown. It appears once, and Help can reopen it. */
    guideSeen: boolean;
  };
  save: {
    /** Backups kept per project. 0 turns them off. */
    backupsToKeep: number;
    /** Save to the file automatically every N minutes. 0 turns it off. */
    autoSaveMinutes: number;
    /** Open the last project at startup, with its tabs and places as they were. */
    reopenLast: boolean;
  };
  /** Where things were left. Kept here because the project file must not change for it. */
  session: {
    lastProject: string | null;
    workspaces: SavedWorkspace[];
  };
  ai: {
    paneOpen: boolean;
    paneWidth: number;
    profiles: AiProfile[];
    routing: Record<AiTask, string>;
    /** Skip the warning before sending to a cloud provider. */
    cloudWarningDismissed: boolean;
    showThinking: boolean;
    /** How many versions a rewrite gives, from 2 to 5. */
    rewriteVersions: number;
    /** Cloud spending. Kept here because the limit covers every project. */
    spending: {
      /** Dollars a month. 0 means no limit. */
      limitUsd: number;
      /** The month `spentUsd` is for, as YYYY-MM. */
      month: string;
      spentUsd: number;
      /** The month the 80 percent warning was last shown. */
      warnedMonth: string;
      /** The month the writer chose to go past the limit. */
      overrideMonth: string;
    };
    /** Story-so-far summaries, made in the background. */
    summaries: {
      enabled: boolean;
      /** Whether a cloud profile may make them, which sends the book there. */
      allowCloud: boolean;
    };
    /** Search by meaning. Off until the writer turns it on. */
    embeddings: {
      enabled: boolean;
      /** `builtin` runs here, and `profile` uses one of the profiles above. */
      source: string;
      profileId: string;
      /** The embeddings model, for a profile. */
      model: string;
    };
  };
  language: {
    /** The language of projects that have not chosen one. */
    writing: string;
    /** The language of menus, buttons and messages. */
    interface: string;
  };
  updates: {
    /** Ask GitHub for the latest version at startup. Off unless someone turns it on. */
    checkAtStartup: boolean;
  };
  recent: RecentFile[];
  writingStyles: {
    /** The person's own styles, available to every project. */
    custom: CustomStyle[];
    /** Ids of favorite styles. */
    favorites: string[];
  };
}

export const LOCAL_PROFILE_ID = 'local';

export const DEFAULT_SETTINGS: Settings = {
  appearance: { theme: 'encyclopedia', mode: 'dark', uiScale: 1, contentScale: 1 },
  editor: {
    spellcheck: true,
    typewriterScroll: false,
    showFormattingBar: true,
    dailyWordGoal: 1000,
    highlightNames: true,
    writingFont: '',
    writingFontInWiki: false,
    lineSpacing: LINE_SPACING.standard,
    pageWidth: PAGE_WIDTH.standard,
    paragraphStyle: 'spaced',
  },
  help: { guideSeen: false },
  save: { backupsToKeep: 10, autoSaveMinutes: 0, reopenLast: true },
  session: { lastProject: null, workspaces: [] },
  ai: {
    paneOpen: false,
    paneWidth: 420,
    profiles: [
      {
        id: LOCAL_PROFILE_ID,
        name: 'Local model',
        kind: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8080/v1',
        model: '',
        isCloud: false,
      },
    ],
    routing: {
      chat: LOCAL_PROFILE_ID,
      rewrite: LOCAL_PROFILE_ID,
      extract: LOCAL_PROFILE_ID,
      consistency: LOCAL_PROFILE_ID,
    },
    cloudWarningDismissed: false,
    showThinking: false,
    rewriteVersions: 3,
    spending: { limitUsd: 0, month: '', spentUsd: 0, warnedMonth: '', overrideMonth: '' },
    summaries: { enabled: true, allowCloud: false },
    embeddings: { enabled: false, source: 'builtin', profileId: '', model: '' },
  },
  language: { writing: 'en-US', interface: 'en' },
  updates: { checkAtStartup: false },
  recent: [],
  writingStyles: { custom: [], favorites: [] },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Fills in anything missing, so settings from older versions still work. */
export function withDefaults<T>(stored: unknown, defaults: T): T {
  if (!isPlainObject(stored) || !isPlainObject(defaults)) {
    return (stored === undefined || stored === null ? defaults : stored) as T;
  }
  const out: Record<string, unknown> = { ...stored };
  for (const [key, value] of Object.entries(defaults)) {
    out[key] = withDefaults(stored[key], value);
  }
  return out as T;
}
