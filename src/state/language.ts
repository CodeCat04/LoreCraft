/**
 * The language of the open project. It is stored in the project's `language` meta value and
 * falls back to the app's default, so a project without a choice follows the default.
 */

import { listen } from '@tauri-apps/api/event';
import { useSyncExternalStore } from 'react';
import { create } from 'zustand';

import * as api from '../lib/api';
import { currentLocale, setLocale, subscribeLocale } from '../lib/i18n';
import { DEFAULT_WRITING_LANGUAGE, languageInfo } from '../lib/languages';
import { useProject } from './project';
import { useSettings } from './settings';

interface ProjectLanguageStore {
  /** The project's own choice, or null if it has none or no project is open. */
  language: string | null;
}

export const useProjectLanguage = create<ProjectLanguageStore>(() => ({ language: null }));

function effective(projectLanguage: string | null, defaultLanguage: string): string {
  if (projectLanguage && languageInfo(projectLanguage)) return projectLanguage;
  return languageInfo(defaultLanguage) ? defaultLanguage : DEFAULT_WRITING_LANGUAGE;
}

/** The language the open project is written in. */
export function writingLanguage(): string {
  return effective(useProjectLanguage.getState().language, useSettings.getState().settings.language.writing);
}

/** The same, for a component. */
export function useWritingLanguage(): string {
  const projectLanguage = useProjectLanguage((s) => s.language);
  const defaultLanguage = useSettings((s) => s.settings.language.writing);
  return effective(projectLanguage, defaultLanguage);
}

/** Re-renders a component that uses `t()` when the interface language changes. */
export function useLocale(): string {
  return useSyncExternalStore(subscribeLocale, currentLocale);
}

/** Switches the interface language, and keeps it for next time. */
export async function changeInterfaceLanguage(code: string): Promise<void> {
  await setLocale(code);
  await useSettings.getState().update({ language: { interface: code } });
}

let latestLoad = 0;

async function loadProjectLanguage() {
  latestLoad += 1;
  const thisLoad = latestLoad;
  let language: string | null = null;
  if (useProject.getState().status.open) {
    try {
      language = (await api.project.getMeta('language')) || null;
    } catch {
      language = null;
    }
  }
  // An older answer must not replace a newer one when projects change quickly.
  if (thisLoad === latestLoad) useProjectLanguage.setState({ language });
}

/** Saves the project's language. An empty value goes back to following the app's default. */
export async function setProjectLanguage(code: string): Promise<void> {
  await api.project.setMeta('language', code);
  useProjectLanguage.setState({ language: code || null });
}

/** Keeps the language current as projects open and close. Call once at startup. */
export async function startLanguageTracking(): Promise<void> {
  let wasOpen = useProject.getState().status.open;
  useProject.subscribe((state) => {
    const { open } = state.status;
    if (open === wasOpen) return;
    wasOpen = open;
    void loadProjectLanguage();
  });
  await listen<{ entity: string }>('data://changed', (event) => {
    const { entity } = event.payload;
    if (entity === 'all' || entity === 'meta') void loadProjectLanguage();
  });
  await loadProjectLanguage();
}
