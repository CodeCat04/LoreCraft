import { createContext, useContext } from 'react';
import { create } from 'zustand';

import {
  activateTab,
  activeTab,
  closeOtherTabs,
  closeTab,
  cycleTab,
  focusedPane,
  focusedTab,
  focusOn,
  freshLayout,
  goTo,
  moveTab,
  moveTabBeside,
  openBeside,
  openTab,
  paneById,
  replaceRoute,
  setRatio,
  stepBack,
  stepBy,
  stepForward,
  toggleSplit,
  type Layout,
  type PaneId,
} from './tabs';

/** How the Write area shows the book. Leaving it out means the scene editor. */
export type WriteMode = 'scene' | 'read' | 'cork' | 'outline' | 'threads' | 'presence' | 'trash';

/** Every screen in the app. Add new screens here and in `src/shell/routes.tsx`. */
export type Route =
  | { view: 'home' }
  | { view: 'page'; id: string; tab?: 'read' | 'edit' | 'history' | 'talk' }
  /** A link target with no page yet, shown as Wikipedia shows a missing article. */
  | { view: 'missing'; title: string }
  | { view: 'allPages'; category?: string; pageType?: string; status?: string }
  | { view: 'categories' }
  | { view: 'recent' }
  | { view: 'wanted' }
  | { view: 'orphans' }
  | { view: 'stubs' }
  | { view: 'trash' }
  | { view: 'inbox' }
  | { view: 'search'; q: string }
  | { view: 'replace' }
  | { view: 'write'; bookId?: string; nodeId?: string; mode?: WriteMode }
  | { view: 'stats'; bookId?: string }
  | { view: 'consistency' }
  | { view: 'timeline' }
  | { view: 'graph'; pageId?: string }
  | { view: 'familyTree'; pageId?: string }
  | { view: 'maps'; mapId?: string }
  | { view: 'canvas'; id: string }
  | { view: 'notes' }
  | { view: 'export' }
  | { view: 'import' }
  | { view: 'proposals' }
  | { view: 'brainstorm' }
  | { view: 'styles'; tab?: string }
  | { view: 'publishing'; bookId?: string }
  | { view: 'settings'; tab?: string }
  | { view: 'media' }
  /** Plan a story, the step-by-step wizard. */
  | { view: 'plan'; bookId?: string };

/**
 * Everything `useNav` offers. `route`, `back` and `forward` describe the front tab of one
 * pane, and `go` and friends act on it: the pane a component sits in when it uses the hook,
 * otherwise the focused pane, which is also what `useNav.getState()` always gives. So a
 * screen, a sidebar and a command can all carry on as if there were one current screen.
 */
export interface NavStore extends Layout {
  route: Route;
  back: Route[];
  forward: Route[];
  go: (route: Route) => void;
  /** Changes the current screen without adding a history entry. */
  replace: (route: Route) => void;
  goBack: () => void;
  goForward: () => void;
  /** Moves through the history by several entries: -2 is two back, 3 is three forward. */
  jump: (offset: number) => void;

  openTab: (route: Route) => void;
  /** Closes a tab, or the focused pane's current one. */
  closeTab: (tabId?: string) => void;
  closeOtherTabs: (tabId: string) => void;
  activateTab: (tabId: string) => void;
  cycleTab: (direction: 1 | -1) => void;
  moveTab: (tabId: string, paneId: PaneId, index: number) => void;
  openBeside: (route: Route, options?: { keepFocus?: boolean }) => void;
  moveTabBeside: (tabId: string) => void;
  toggleSplit: () => void;
  focusPane: (paneId: PaneId) => void;
  setSplitRatio: (ratio: number) => void;
  /** Starts over with this layout, or with one tab on the main page. */
  resetLayout: (layout?: Layout) => void;
}

/** The public fields, worked out from a layout so they can never disagree with it. */
function withCurrent(layout: Layout) {
  const tab = focusedTab(layout);
  return { ...layout, route: tab.route, back: tab.back, forward: tab.forward };
}

const store = create<NavStore>((set) => {
  const apply = (change: (s: NavStore) => Layout) =>
    set((s) => {
      const next = change(s);
      return next === s ? s : withCurrent(next);
    });
  return {
    ...withCurrent(freshLayout()),
    go: (route) => apply((s) => goTo(s, s.focusedPaneId, route)),
    replace: (route) => apply((s) => replaceRoute(s, s.focusedPaneId, route)),
    goBack: () => apply((s) => stepBack(s, s.focusedPaneId)),
    goForward: () => apply((s) => stepForward(s, s.focusedPaneId)),
    jump: (offset) => apply((s) => stepBy(s, s.focusedPaneId, offset)),
    openTab: (route) => apply((s) => openTab(s, s.focusedPaneId, route)),
    closeTab: (tabId) => apply((s) => closeTab(s, tabId ?? focusedTab(s).id)),
    closeOtherTabs: (tabId) => apply((s) => closeOtherTabs(s, tabId)),
    activateTab: (tabId) => apply((s) => activateTab(s, tabId)),
    cycleTab: (direction) => apply((s) => cycleTab(s, s.focusedPaneId, direction)),
    moveTab: (tabId, paneId, index) => apply((s) => moveTab(s, tabId, paneId, index)),
    openBeside: (route, options) => apply((s) => openBeside(s, route, options)),
    moveTabBeside: (tabId) => apply((s) => moveTabBeside(s, tabId)),
    toggleSplit: () => apply((s) => toggleSplit(s)),
    focusPane: (paneId) => apply((s) => focusOn(s, paneId)),
    setSplitRatio: (ratio) => apply((s) => setRatio(s, ratio)),
    resetLayout: (layout) => {
      const { panes, focusedPaneId, splitRatio } = layout ?? freshLayout();
      set(withCurrent({ panes, focusedPaneId, splitRatio }));
    },
  };
});

/** The pane a component is showing in. Null for the sidebar, dialogs and the like. */
export const PaneContext = createContext<PaneId | null>(null);

type PaneActions = Pick<NavStore, 'go' | 'replace' | 'goBack' | 'goForward' | 'jump'>;

function actionsFor(paneId: PaneId): PaneActions {
  const apply = (change: (s: NavStore) => Layout) =>
    store.setState((s) => {
      const next = change(s);
      return next === s ? s : withCurrent(next);
    });
  return {
    go: (route) => apply((s) => goTo(s, paneId, route)),
    replace: (route) => apply((s) => replaceRoute(s, paneId, route)),
    goBack: () => apply((s) => stepBack(s, paneId)),
    goForward: () => apply((s) => stepForward(s, paneId)),
    jump: (offset) => apply((s) => stepBy(s, paneId, offset)),
  };
}

// One set per pane, so that a component holding on to `go` always has the same function.
const paneActions: Record<PaneId, PaneActions> = { main: actionsFor('main'), side: actionsFor('side') };

function seenFrom(s: NavStore, paneId: PaneId): NavStore {
  const pane = paneById(s, paneId);
  const tab = pane ? activeTab(pane) : focusedTab(s);
  return { ...s, route: tab.route, back: tab.back, forward: tab.forward, ...paneActions[paneId] };
}

function useNavHook<T>(selector: (s: NavStore) => T): T {
  const paneId = useContext(PaneContext);
  return store(paneId ? (s) => selector(seenFrom(s, paneId)) : selector);
}

/** `route`, `back` and `forward` set directly apply to the focused pane's current tab. */
function setState(partial: Partial<Pick<NavStore, 'route' | 'back' | 'forward'>>) {
  store.setState((s) => {
    const tab = focusedTab(s);
    const pane = focusedPane(s);
    const tabs = pane.tabs.map((t) => (t.id === tab.id ? { ...tab, ...partial } : t));
    return withCurrent({ ...s, panes: s.panes.map((p) => (p.id === pane.id ? { ...p, tabs } : p)) });
  });
}

export const useNav = Object.assign(useNavHook, {
  getState: store.getState,
  subscribe: store.subscribe,
  setState,
});

export function usePaneId(): PaneId | null {
  return useContext(PaneContext);
}

/** For effects and callbacks, which should not steal focus for a pane in the background. */
export function isFocusedPane(paneId: PaneId | null): boolean {
  return paneId === null || store.getState().focusedPaneId === paneId;
}

/** True if this component's pane is the focused one, or it is not in a pane at all. */
export function useIsFocusedPane(): boolean {
  const paneId = useContext(PaneContext);
  return store((s) => paneId === null || s.focusedPaneId === paneId);
}

/** Follows a link: in the same tab, or a new one if Ctrl was held. */
export function followRoute(route: Route, event?: { ctrlKey?: boolean; metaKey?: boolean }) {
  if (event?.ctrlKey || event?.metaKey) store.getState().openTab(route);
  else store.getState().go(route);
}

/** Which top-level area a route belongs to, for the tab bar and sidebar. */
export type Area = 'wiki' | 'write' | 'consistency' | 'atlas' | 'other';

export function areaOf(route: Route): Area {
  switch (route.view) {
    case 'write':
    case 'stats':
    case 'plan':
      return 'write';
    case 'consistency':
      return 'consistency';
    case 'timeline':
    case 'graph':
    case 'familyTree':
    case 'maps':
    case 'canvas':
      return 'atlas';
    case 'export':
    case 'import':
    case 'proposals':
    case 'brainstorm':
    case 'styles':
    case 'publishing':
    case 'settings':
    case 'media':
      return 'other';
    default:
      return 'wiki';
  }
}
