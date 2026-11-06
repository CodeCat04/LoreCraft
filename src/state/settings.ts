import { create } from 'zustand';

import * as api from '../lib/api';
import { DEFAULT_SETTINGS, withDefaults, writingStyle, type Settings } from '../lib/settings';

export const MIN_SCALE = 0.7;
export const MAX_SCALE = 2;
const SCALE_STEP = 0.1;

function clampScale(value: number): number {
  return Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, value)) * 100) / 100;
}

function apply(settings: Settings) {
  const root = document.documentElement;
  const { theme, mode, uiScale, contentScale } = settings.appearance;
  root.dataset.theme = theme;
  root.dataset.mode = mode;
  root.style.setProperty('--ui-scale', String(uiScale));
  root.style.setProperty('--content-scale', String(contentScale));

  // Only what the writer chose goes here, so a theme's own fonts and colors keep working.
  const writing = writingStyle(settings.editor);
  const setOrClear = (name: string, value: string | null) => {
    if (value === null) root.style.removeProperty(name);
    else root.style.setProperty(name, value);
  };
  setOrClear('--writing-font', writing.font);
  setOrClear('--article-font', settings.editor.writingFontInWiki ? writing.font : null);
  root.style.setProperty('--writing-line-height', writing.lineHeight);
  root.style.setProperty('--writing-page-width', writing.pageWidth);
  root.dataset.paragraphs = writing.paragraphs;
}

interface SettingsStore {
  settings: Settings;
  /** Applies stored settings at startup. */
  hydrate: (stored: unknown) => void;
  /** Merges a partial update. Arrays replace. Saved to disk immediately. */
  update: (patch: DeepPartial<Settings>) => Promise<void>;
  bumpContentScale: (direction: 1 | -1 | 0) => void;
  bumpUiScale: (direction: 1 | -1 | 0) => void;
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (infer U)[]
    ? U[]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

function mergeLocal<T>(base: T, patch: DeepPartial<T>): T {
  const out = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    const current = out[key];
    if (
      value && typeof value === 'object' && !Array.isArray(value) &&
      current && typeof current === 'object' && !Array.isArray(current)
    ) {
      out[key] = mergeLocal(current, value as DeepPartial<typeof current>);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  hydrate: (stored) => {
    const settings = withDefaults(stored, DEFAULT_SETTINGS);
    apply(settings);
    set({ settings });
    void api.app.setTheme(settings.appearance.mode === 'dark').catch(() => {});
  },
  update: async (patch) => {
    const settings = mergeLocal(get().settings, patch);
    apply(settings);
    set({ settings });
    if (patch.appearance?.mode) {
      void api.app.setTheme(patch.appearance.mode === 'dark').catch(() => {});
    }
    await api.settings.update(patch);
  },
  bumpContentScale: (direction) => {
    const current = get().settings.appearance.contentScale;
    const contentScale = direction === 0 ? 1 : clampScale(current + direction * SCALE_STEP);
    void get().update({ appearance: { contentScale } });
  },
  bumpUiScale: (direction) => {
    const current = get().settings.appearance.uiScale;
    const uiScale = direction === 0 ? 1 : clampScale(current + direction * SCALE_STEP);
    void get().update({ appearance: { uiScale } });
  },
}));
