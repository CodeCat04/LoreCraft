/**
 * The article on screen, so commands and the sidebar can act on it. Each pane can show one, and
 * `useWikiSession` always holds the focused pane's.
 */

import type { Editor } from '@tiptap/core';
import { create } from 'zustand';

import { useNav } from '../state/nav';
import type { PaneId } from '../state/tabs';

export type PageTab = 'read' | 'edit' | 'history' | 'talk';

interface WikiSession {
  pageId: string | null;
  title: string;
  /** The article's editor, once it exists. */
  editor: Editor | null;
  tab: PageTab;
  /** Changes tab the way the article's own tabs do, keeping the reader's place. */
  switchTab: ((tab: PageTab) => void) | null;
}

const EMPTY: WikiSession = {
  pageId: null,
  title: '',
  editor: null,
  tab: 'read',
  switchTab: null,
};

export const useWikiSession = create<WikiSession>(() => EMPTY);

const byPane = new Map<PaneId, WikiSession>();

function showFocused() {
  useWikiSession.setState(byPane.get(useNav.getState().focusedPaneId) ?? EMPTY);
}

let lastFocused: PaneId = useNav.getState().focusedPaneId;
useNav.subscribe((nav) => {
  if (nav.focusedPaneId === lastFocused) return;
  lastFocused = nav.focusedPaneId;
  showFocused();
});

/** The article in a pane has changed. A view outside any pane counts as the first. */
export function publishSession(paneId: PaneId | null, session: WikiSession) {
  byPane.set(paneId ?? 'main', session);
  showFocused();
}

export function clearSession(paneId: PaneId | null, pageId: string) {
  const pane = paneId ?? 'main';
  if (byPane.get(pane)?.pageId !== pageId) return;
  byPane.delete(pane);
  showFocused();
}

/** Small per-install conveniences, such as whether the contents box is folded. */
export function loadPref<T>(key: string, fallback: T): T {
  try {
    const stored = localStorage.getItem(`wiki.${key}`);
    return stored === null ? fallback : (JSON.parse(stored) as T);
  } catch {
    return fallback;
  }
}

export function savePref(key: string, value: unknown) {
  try {
    localStorage.setItem(`wiki.${key}`, JSON.stringify(value));
  } catch {
    // These are only conveniences, so losing one does no harm.
  }
}
