/**
 * Pinning the Outside suggestions list. While it is pinned, its count stays in the top bar,
 * and the list opens as a tab in the pane beside the writing, so a page and the suggestions
 * for it can be seen side by side. The pane and tab system already sizes, saves and restores
 * that tab, so the list needs no panel of its own.
 */

import { create } from 'zustand';

import type { Layout, PaneId } from '../state/tabs';
import { activeTab } from '../state/tabs';

export type ShowList =
  /** A tab already holds the list: bring it to the front of its pane, and focus that pane. */
  | { kind: 'activate'; tabId: string; paneId: PaneId }
  /** No tab holds it yet: open one in the pane beside. */
  | { kind: 'beside' };

/** How to show the list. A tab already showing it is reused, never opened twice. */
export function showListIn(layout: Layout): ShowList {
  // The front tab of a pane first, so a list already in sight is the one used.
  for (const pane of layout.panes) {
    const tab = activeTab(pane);
    if (tab.route.view === 'proposals') return { kind: 'activate', tabId: tab.id, paneId: pane.id };
  }
  for (const pane of layout.panes) {
    const tab = pane.tabs.find((t) => t.route.view === 'proposals');
    if (tab) return { kind: 'activate', tabId: tab.id, paneId: pane.id };
  }
  return { kind: 'beside' };
}

/** True if a pane is showing the list now. */
export function listInSight(layout: Layout): boolean {
  return layout.panes.some((pane) => activeTab(pane).route.view === 'proposals');
}

/**
 * The suggestion to have ready once one has been dealt with: the next one in the list, or
 * the one before if it was the last. Null when none is left, or the handled one is still
 * there, as after a failed accept.
 */
export function nextReady(before: string[], handledId: string, now: string[]): string | null {
  if (now.includes(handledId) || now.length === 0) return null;
  const at = before.indexOf(handledId);
  if (at >= 0) {
    const after = before.slice(at + 1).find((id) => now.includes(id));
    if (after) return after;
    const earlier = before.slice(0, at).reverse().find((id) => now.includes(id));
    if (earlier) return earlier;
  }
  return now[0];
}

/** Asks the list to put the keyboard on its first suggestion, as after opening it from the badge. */
export const useListFocus = create<{ pending: boolean; ask: () => void; done: () => void }>((set) => ({
  pending: false,
  ask: () => set({ pending: true }),
  done: () => set({ pending: false }),
}));
