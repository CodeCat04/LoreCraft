/**
 * The layout of open documents: one or two panes, each with its own tabs, and each tab with
 * its own back and forward history. Everything here is a pure function from one layout to
 * the next, so `nav.ts` stays a thin store and this can be tested without a screen.
 */

import type { Route } from './nav';

/** Panes are named by position. The second one only exists while the view is split. */
export type PaneId = 'main' | 'side';

export interface NavTab {
  id: string;
  route: Route;
  back: Route[];
  forward: Route[];
}

export interface NavPane {
  id: PaneId;
  tabs: NavTab[];
  activeTabId: string;
}

export interface Layout {
  panes: NavPane[];
  focusedPaneId: PaneId;
  /** The share of the width the first pane takes. */
  splitRatio: number;
}

const MAX_HISTORY = 100;
export const MIN_SPLIT = 0.2;
export const MAX_SPLIT = 0.8;
const HOME: Route = { view: 'home' };

let tabCounter = 0;

export function newTab(route: Route): NavTab {
  tabCounter += 1;
  return { id: `tab-${tabCounter}`, route, back: [], forward: [] };
}

export function freshLayout(route: Route = HOME): Layout {
  const tab = newTab(route);
  return { panes: [{ id: 'main', tabs: [tab], activeTabId: tab.id }], focusedPaneId: 'main', splitRatio: 0.5 };
}

function sameRoute(a: Route, b: Route): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function paneById(layout: Layout, id: PaneId): NavPane | undefined {
  return layout.panes.find((p) => p.id === id);
}

export function activeTab(pane: NavPane): NavTab {
  return pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0];
}

export function focusedPane(layout: Layout): NavPane {
  return paneById(layout, layout.focusedPaneId) ?? layout.panes[0];
}

export function focusedTab(layout: Layout): NavTab {
  return activeTab(focusedPane(layout));
}

function otherPaneId(id: PaneId): PaneId {
  return id === 'main' ? 'side' : 'main';
}

export function paneOfTab(layout: Layout, tabId: string): NavPane | undefined {
  return layout.panes.find((p) => p.tabs.some((t) => t.id === tabId));
}

function withPane(layout: Layout, id: PaneId, change: (pane: NavPane) => NavPane): Layout {
  return { ...layout, panes: layout.panes.map((p) => (p.id === id ? change(p) : p)) };
}

function withActiveTab(layout: Layout, id: PaneId, change: (tab: NavTab) => NavTab): Layout {
  const pane = paneById(layout, id);
  if (!pane) return layout;
  const tab = activeTab(pane);
  const next = change(tab);
  if (next === tab) return layout;
  return withPane(layout, id, (p) => ({ ...p, tabs: p.tabs.map((t) => (t.id === tab.id ? next : t)) }));
}

/** Puts things right after tabs have moved or closed. A pane never stands empty. */
function settle(layout: Layout): Layout {
  const main = paneById(layout, 'main');
  const side = paneById(layout, 'side');
  let panes: NavPane[];
  if (main && main.tabs.length > 0) {
    panes = side && side.tabs.length > 0 ? [main, side] : [main];
  } else if (side && side.tabs.length > 0) {
    // The first pane closed, so what was beside it takes its place.
    panes = [{ ...side, id: 'main' }];
  } else {
    const tab = newTab(HOME);
    panes = [{ id: 'main', tabs: [tab], activeTabId: tab.id }];
  }
  const fixed = panes.map((p) => (p.tabs.some((t) => t.id === p.activeTabId) ? p : { ...p, activeTabId: p.tabs[0].id }));
  const focused = fixed.some((p) => p.id === layout.focusedPaneId) ? layout.focusedPaneId : 'main';
  return { ...layout, panes: fixed, focusedPaneId: focused };
}

// ---- Moving within a tab ----------------------------------------------------------------

export function goTo(layout: Layout, paneId: PaneId, route: Route): Layout {
  return withActiveTab(layout, paneId, (tab) =>
    sameRoute(tab.route, route)
      ? tab
      : { ...tab, route, back: [...tab.back, tab.route].slice(-MAX_HISTORY), forward: [] },
  );
}

export function replaceRoute(layout: Layout, paneId: PaneId, route: Route): Layout {
  return withActiveTab(layout, paneId, (tab) => (sameRoute(tab.route, route) ? tab : { ...tab, route }));
}

export function stepBack(layout: Layout, paneId: PaneId): Layout {
  return withActiveTab(layout, paneId, (tab) => {
    const previous = tab.back[tab.back.length - 1];
    if (!previous) return tab;
    return { ...tab, route: previous, back: tab.back.slice(0, -1), forward: [tab.route, ...tab.forward] };
  });
}

export function stepForward(layout: Layout, paneId: PaneId): Layout {
  return withActiveTab(layout, paneId, (tab) => {
    const next = tab.forward[0];
    if (!next) return tab;
    return { ...tab, route: next, back: [...tab.back, tab.route], forward: tab.forward.slice(1) };
  });
}

// ---- Tabs ----------------------------------------------------------------------------------

/** Opens a tab just after the current one. A tab already showing this route is reused. */
export function openTab(layout: Layout, paneId: PaneId, route: Route, options: { reuse?: boolean } = {}): Layout {
  const pane = paneById(layout, paneId);
  if (!pane) return layout;
  const existing = options.reuse ? pane.tabs.find((t) => sameRoute(t.route, route)) : undefined;
  if (existing) return activateTab(layout, existing.id);
  const tab = newTab(route);
  const at = pane.tabs.findIndex((t) => t.id === pane.activeTabId) + 1;
  return withPane(layout, paneId, (p) => ({
    ...p,
    tabs: [...p.tabs.slice(0, at), tab, ...p.tabs.slice(at)],
    activeTabId: tab.id,
  }));
}

export function activateTab(layout: Layout, tabId: string): Layout {
  const pane = paneOfTab(layout, tabId);
  if (!pane || pane.activeTabId === tabId) return layout;
  return withPane(layout, pane.id, (p) => ({ ...p, activeTabId: tabId }));
}

/** Closes a tab. The one after it takes over, or the one before if it was the last. */
export function closeTab(layout: Layout, tabId: string): Layout {
  const pane = paneOfTab(layout, tabId);
  if (!pane) return layout;
  // Closing a bare main page, alone in the window, would only show the same thing again.
  const only = layout.panes.length === 1 && pane.tabs.length === 1;
  if (only && pane.tabs[0].route.view === 'home' && pane.tabs[0].back.length === 0) return layout;
  const at = pane.tabs.findIndex((t) => t.id === tabId);
  const tabs = pane.tabs.filter((t) => t.id !== tabId);
  const heir = pane.activeTabId === tabId ? (tabs[at] ?? tabs[at - 1])?.id : pane.activeTabId;
  return settle(withPane(layout, pane.id, (p) => ({ ...p, tabs, activeTabId: heir ?? '' })));
}

export function closeOtherTabs(layout: Layout, tabId: string): Layout {
  const pane = paneOfTab(layout, tabId);
  if (!pane) return layout;
  return withPane(layout, pane.id, (p) => ({ ...p, tabs: p.tabs.filter((t) => t.id === tabId), activeTabId: tabId }));
}

export function cycleTab(layout: Layout, paneId: PaneId, direction: 1 | -1): Layout {
  const pane = paneById(layout, paneId);
  if (!pane || pane.tabs.length < 2) return layout;
  const at = pane.tabs.findIndex((t) => t.id === pane.activeTabId);
  const next = pane.tabs[(at + direction + pane.tabs.length) % pane.tabs.length];
  return activateTab(layout, next.id);
}

/** Moves a tab to a place in a pane, which is made if it does not exist yet. */
export function moveTab(layout: Layout, tabId: string, toPaneId: PaneId, toIndex: number): Layout {
  const from = paneOfTab(layout, tabId);
  const tab = from?.tabs.find((t) => t.id === tabId);
  if (!from || !tab) return layout;
  if (from.id === toPaneId) {
    const rest = from.tabs.filter((t) => t.id !== tabId);
    const at = Math.max(0, Math.min(rest.length, toIndex));
    const tabs = [...rest.slice(0, at), tab, ...rest.slice(at)];
    if (tabs.every((t, i) => t.id === from.tabs[i].id)) return layout;
    return withPane(layout, from.id, (p) => ({ ...p, tabs }));
  }
  const at = from.tabs.findIndex((t) => t.id === tabId);
  const left = from.tabs.filter((t) => t.id !== tabId);
  const heir = from.activeTabId === tabId ? (left[at] ?? left[at - 1])?.id : from.activeTabId;
  const panes = layout.panes.map((p) => (p.id === from.id ? { ...p, tabs: left, activeTabId: heir ?? '' } : p));
  const target = panes.find((p) => p.id === toPaneId);
  const moved: NavPane = target
    ? {
        ...target,
        tabs: [...target.tabs.slice(0, toIndex), tab, ...target.tabs.slice(toIndex)],
        activeTabId: tab.id,
      }
    : { id: toPaneId, tabs: [tab], activeTabId: tab.id };
  const merged = target ? panes.map((p) => (p.id === toPaneId ? moved : p)) : [...panes, moved];
  return settle({ ...layout, panes: merged, focusedPaneId: toPaneId });
}

// ---- The split --------------------------------------------------------------------------

/**
 * Opens a route in the pane beside the focused one. With `keepFocus`, the person carries on
 * where they were, as when opening a character's page while writing a scene.
 */
export function openBeside(layout: Layout, route: Route, options: { keepFocus?: boolean } = {}): Layout {
  const here = layout.focusedPaneId;
  const there = otherPaneId(here);
  if (paneById(layout, there)) {
    const opened = openTab(layout, there, route, { reuse: true });
    return options.keepFocus ? opened : { ...opened, focusedPaneId: there };
  }
  const tab = newTab(route);
  const pane: NavPane = { id: there, tabs: [tab], activeTabId: tab.id };
  return { ...layout, panes: [...layout.panes, pane], focusedPaneId: options.keepFocus ? here : there };
}

/**
 * "Open beside" on a tab: the tab moves across, so the document is not open twice. If it was
 * the only tab in its pane, the pane is left showing the main page instead of closing.
 */
export function moveTabBeside(layout: Layout, tabId: string): Layout {
  const pane = paneOfTab(layout, tabId);
  if (!pane) return layout;
  const there = otherPaneId(pane.id);
  const target = paneById(layout, there);
  const index = target ? target.tabs.length : 0;
  if (pane.tabs.length > 1 || target) return moveTab(layout, tabId, there, index);
  const home = newTab(HOME);
  const filled = withPane(layout, pane.id, (p) => ({ ...p, tabs: [...p.tabs, home] }));
  return moveTab(filled, tabId, there, 0);
}

/** What a new pane shows: the other half of writing beside the wiki. */
export function companionRoute(tab: NavTab): Route {
  if (tab.route.view !== 'write') return { view: 'write' };
  return [...tab.back].reverse().find((r) => r.view === 'page') ?? HOME;
}

/** Closes the split. The tabs from the second pane join the first, so nothing is lost. */
export function closeSplit(layout: Layout): Layout {
  const main = paneById(layout, 'main');
  const side = paneById(layout, 'side');
  if (!main || !side) return layout;
  const focused = activeTab(focusedPane(layout)).id;
  const open = new Set(main.tabs.map((t) => JSON.stringify(t.route)));
  const joining = side.tabs.filter((t) => !open.has(JSON.stringify(t.route)));
  const tabs = [...main.tabs, ...joining];
  return {
    ...layout,
    panes: [{ ...main, tabs, activeTabId: tabs.some((t) => t.id === focused) ? focused : main.activeTabId }],
    focusedPaneId: 'main',
  };
}

export function toggleSplit(layout: Layout): Layout {
  if (layout.panes.length > 1) return closeSplit(layout);
  return openBeside(layout, companionRoute(focusedTab(layout)));
}

export function focusOn(layout: Layout, paneId: PaneId): Layout {
  if (layout.focusedPaneId === paneId || !paneById(layout, paneId)) return layout;
  return { ...layout, focusedPaneId: paneId };
}

export function setRatio(layout: Layout, ratio: number): Layout {
  return { ...layout, splitRatio: Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, ratio)) };
}

// ---- Remembering a layout -----------------------------------------------------------------

export interface SavedTab {
  route: Route;
  back?: Route[];
  forward?: Route[];
  /** How far the pane was scrolled, where the view uses the pane's own scrolling. */
  scrollTop?: number;
}

/** History kept across restarts, per tab and direction. */
const SAVED_HISTORY = 20;

export interface SavedPane {
  tabs: SavedTab[];
  active: number;
}

export interface SavedLayout {
  panes: SavedPane[];
  focused: number;
  splitRatio: number;
}

export function saveLayout(layout: Layout, scrollOf: (tabId: string) => number): SavedLayout {
  const panes = layout.panes.map((pane) => ({
    tabs: pane.tabs.map((tab) => {
      const saved: SavedTab = { route: tab.route };
      if (tab.back.length > 0) saved.back = tab.back.slice(-SAVED_HISTORY);
      if (tab.forward.length > 0) saved.forward = tab.forward.slice(0, SAVED_HISTORY);
      const scrollTop = Math.round(scrollOf(tab.id));
      if (scrollTop > 0) saved.scrollTop = scrollTop;
      return saved;
    }),
    active: Math.max(0, pane.tabs.findIndex((t) => t.id === pane.activeTabId)),
  }));
  return {
    panes,
    focused: Math.max(0, layout.panes.findIndex((p) => p.id === layout.focusedPaneId)),
    splitRatio: layout.splitRatio,
  };
}

function isRoute(value: unknown): value is Route {
  return typeof value === 'object' && value !== null && typeof (value as { view?: unknown }).view === 'string';
}

/**
 * Builds a layout from what was remembered, leaving out anything that no longer exists. It
 * comes from a settings file, so nothing about its shape is taken on trust.
 */
export function restoreLayout(
  saved: unknown,
  keep: (route: Route) => boolean,
  onScroll: (tabId: string, scrollTop: number) => void,
): Layout | null {
  const source = saved as Partial<SavedLayout> | null | undefined;
  if (!source || !Array.isArray(source.panes)) return null;
  const panes: NavPane[] = [];
  let focused: PaneId | null = null;
  source.panes.slice(0, 2).forEach((pane, paneIndex) => {
    const savedTabs = Array.isArray(pane?.tabs) ? pane.tabs : [];
    const tabs: NavTab[] = [];
    let activeTabId = '';
    savedTabs.forEach((saved, index) => {
      if (!isRoute(saved?.route) || !keep(saved.route)) return;
      const history = (list: unknown) => (Array.isArray(list) ? list.filter((r) => isRoute(r) && keep(r)) : []);
      const tab = { ...newTab(saved.route), back: history(saved.back), forward: history(saved.forward) };
      tabs.push(tab);
      if (typeof saved.scrollTop === 'number' && saved.scrollTop > 0) onScroll(tab.id, saved.scrollTop);
      // If the tab that was in front has gone, its nearest neighbor before it stands in.
      if (index <= (pane.active ?? 0)) activeTabId = tab.id;
    });
    if (tabs.length === 0) return;
    const id: PaneId = panes.length === 0 ? 'main' : 'side';
    panes.push({ id, tabs, activeTabId: activeTabId || tabs[0].id });
    if (paneIndex === source.focused) focused = id;
  });
  if (panes.length === 0) return null;
  const ratio = typeof source.splitRatio === 'number' ? source.splitRatio : 0.5;
  return setRatio({ panes, focusedPaneId: focused ?? 'main', splitRatio: 0.5 }, ratio);
}
