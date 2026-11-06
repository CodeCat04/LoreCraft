/**
 * The main area of the window: one pane, or two side by side, each with its own tabs. Only a
 * pane's front tab is on screen. A tab in the back keeps its route and history, and its place
 * in the document is remembered in `state/docs.ts`.
 */

import { Fragment, memo, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';

import { openContextMenu } from './ContextMenu';
import { ErrorBoundary } from './ErrorBoundary';
import { RouteView } from './routes';
import { rememberTabScroll, tabScrollOf } from '../state/docs';
import { PaneContext, useNav, type Route } from '../state/nav';
import { useTitles } from '../state/project';
import { MAX_SPLIT, MIN_SPLIT, activeTab, type NavPane, type NavTab, type PaneId } from '../state/tabs';
import { useUi } from '../state/ui';
import { displayTitle } from '../write/tree';
import { useWrite } from '../write/store';
import { t } from '../lib/i18n';
import { useLocale } from '../state/language';

import { useCanvasList } from '../canvas/api';

import '../styles/tabs.css';

/** Read when shown, so they follow the interface language. */
const WRITE_MODE_TITLES: Record<string, () => string> = {
  read: () => t('Chapter'),
  cork: () => t('Corkboard'),
  outline: () => t('Outline'),
  threads: () => t('Plot threads'),
  presence: () => t('Character presence'),
  trash: () => t('Manuscript trash'),
};

const PLAIN_TITLES: Record<string, () => string> = {
  home: () => t('Main page'),
  allPages: () => t('All pages'),
  categories: () => t('Categories'),
  recent: () => t('Recent changes'),
  wanted: () => t('Wanted pages'),
  orphans: () => t('Orphaned pages'),
  stubs: () => t('Short pages'),
  trash: () => t('Trash'),
  replace: () => t('Find and replace'),
  stats: () => t('Writing stats'),
  consistency: () => t('Consistency'),
  timeline: () => t('Timeline'),
  graph: () => t('Relationships'),
  maps: () => t('Maps'),
  export: () => t('Export'),
  import: () => t('Import'),
  settings: () => t('Settings'),
  write: () => t('Write'),
};

/** The Write area knows one book at a time, and a tab can be on another one by now. */
const lastNodeTitles = new Map<string, string>();

function useTabTitle(route: Route): string {
  useLocale();
  const canvasList = useCanvasList();
  const canvasTitle = route.view === 'canvas' ? canvasList.find((c) => c.id === route.id)?.title : undefined;
  const pageTitle = useTitles((s) => (route.view === 'page' ? s.byId.get(route.id)?.title : undefined));
  const nodeId = route.view === 'write' ? route.nodeId : undefined;
  const currentNodeTitle = useWrite((s) => {
    const node = nodeId ? s.index.byId.get(nodeId) : undefined;
    return node ? displayTitle(node) : undefined;
  });
  if (nodeId && currentNodeTitle) lastNodeTitles.set(nodeId, currentNodeTitle);
  const nodeTitle = currentNodeTitle ?? (nodeId ? lastNodeTitles.get(nodeId) : undefined);
  switch (route.view) {
    case 'page':
      return pageTitle ?? t('Page');
    case 'missing':
      return route.title;
    case 'canvas':
      return canvasTitle ?? t('Canvas');
    case 'search':
      return t('Search: {query}', { query: route.q });
    case 'allPages':
      return route.category ?? PLAIN_TITLES.allPages();
    case 'write':
      if (route.mode && route.mode !== 'scene' && !nodeTitle) return WRITE_MODE_TITLES[route.mode]?.() ?? t('Write');
      return nodeTitle ?? t('Write');
    default:
      return PLAIN_TITLES[route.view]?.() ?? sentenceCase(route.view);
  }
}

/** For a screen with no title of its own here yet. `someView` comes out as "Some view". */
function sentenceCase(name: string): string {
  const words = name.replace(/([A-Z])/g, ' $1').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const DRAG_THRESHOLD_PX = 6;

/** Follows a dragged tab. Within its pane it moves live. Across panes it moves on release. */
function startTabDrag(e: ReactPointerEvent, tabId: string, fromPane: PaneId) {
  if (e.button !== 0 || (e.target as HTMLElement).closest('.doc-tab-close')) return;
  const start = { x: e.clientX, y: e.clientY };
  let dragging = false;
  let drop: { paneId: PaneId; index: number } | null = null;
  const mark = (strip: Element | null) => {
    document.querySelectorAll('.doc-tabs.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'));
    strip?.classList.add('is-drop-target');
  };
  const move = (ev: PointerEvent) => {
    // The button came up outside the window, where no release could be seen.
    if (ev.buttons === 0) {
      drop = null;
      up();
      return;
    }
    if (!dragging) {
      if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) < DRAG_THRESHOLD_PX) return;
      dragging = true;
      document.documentElement.classList.add('tab-dragging');
    }
    const strip = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('[data-pane-tabs]');
    drop = null;
    mark(null);
    if (!strip) return;
    const paneId = strip.dataset.paneTabs as PaneId;
    const others = [...strip.querySelectorAll<HTMLElement>('[data-tab-id]')].filter((el) => el.dataset.tabId !== tabId);
    const after = others.findIndex((el) => {
      const box = el.getBoundingClientRect();
      return ev.clientX < box.left + box.width / 2;
    });
    const index = after < 0 ? others.length : after;
    if (paneId === fromPane) {
      useNav.getState().moveTab(tabId, paneId, index);
    } else {
      drop = { paneId, index };
      mark(strip);
    }
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    document.documentElement.classList.remove('tab-dragging');
    mark(null);
    if (drop) useNav.getState().moveTab(tabId, drop.paneId, drop.index);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

function showTabMenu(x: number, y: number, tab: NavTab, title: string, paneTabs: number) {
  const nav = useNav.getState;
  const items = [
    { label: t('Open beside'), run: () => nav().moveTabBeside(tab.id) },
    { label: t('Close'), shortcut: 'Ctrl+W', run: () => nav().closeTab(tab.id) },
  ];
  if (paneTabs > 1) items.push({ label: t('Close other tabs'), run: () => nav().closeOtherTabs(tab.id) });
  openContextMenu(x, y, t('Tab {title}', { title }), items);
}

const DocTab = memo(function DocTab(props: {
  tab: NavTab;
  paneId: PaneId;
  active: boolean;
  index: number;
  count: number;
  focusSibling: (index: number) => void;
}) {
  const { tab, paneId, active, index, count, focusSibling } = props;
  const title = useTabTitle(tab.route);
  const nav = useNav.getState;

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case 'Enter':
      case ' ':
        e.preventDefault();
        nav().activateTab(tab.id);
        return;
      case 'Delete':
        e.preventDefault();
        nav().closeTab(tab.id);
        return;
      case 'ArrowLeft':
      case 'ArrowRight': {
        if (e.ctrlKey || e.altKey) return;
        e.preventDefault();
        const to = index + (e.key === 'ArrowLeft' ? -1 : 1);
        if (e.shiftKey) {
          if (to >= 0 && to < count) nav().moveTab(tab.id, paneId, to);
        } else {
          focusSibling((to + count) % count);
        }
        return;
      }
      case 'Home':
        e.preventDefault();
        focusSibling(0);
        return;
      case 'End':
        e.preventDefault();
        focusSibling(count - 1);
        return;
      default:
    }
  };

  return (
    <div
      role="tab"
      tabIndex={active ? 0 : -1}
      aria-selected={active}
      aria-label={title}
      title={title}
      className={`doc-tab${active ? ' is-active' : ''}`}
      data-tab-id={tab.id}
      onClick={() => nav().activateTab(tab.id)}
      onPointerDown={(e) => startTabDrag(e, tab.id, paneId)}
      onMouseDown={(e) => {
        // A middle-click would otherwise start the browser's scrolling mode first.
        if (e.button === 1) e.preventDefault();
      }}
      onAuxClick={(e) => {
        if (e.button === 1) nav().closeTab(tab.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const box = e.currentTarget.getBoundingClientRect();
        // The menu key reports no position, so it opens under the tab.
        const fromKeyboard = e.clientX === 0 && e.clientY === 0;
        showTabMenu(fromKeyboard ? box.left : e.clientX, fromKeyboard ? box.bottom : e.clientY, tab, title, count);
      }}
      onKeyDown={onKeyDown}
    >
      {/* Drawn from an attribute, so that looking for a page's name finds the page itself. */}
      <span className="doc-tab-title" data-title={title} />
      <span
        className="doc-tab-close"
        aria-hidden="true"
        onClick={(e) => {
          e.stopPropagation();
          nav().closeTab(tab.id);
        }}
      >
        ×
      </span>
    </div>
  );
});

function TabBar({ pane, split }: { pane: NavPane; split: boolean }) {
  useLocale();
  const stripRef = useRef<HTMLDivElement>(null);
  const focusSibling = (index: number) => {
    stripRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[index]?.focus();
  };
  const nav = useNav.getState;

  // With more tabs than fit, the one in front is always in sight.
  useEffect(() => {
    const strip = stripRef.current;
    const front = strip?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!strip || !front) return;
    if (front.offsetLeft < strip.scrollLeft) strip.scrollLeft = front.offsetLeft;
    else if (front.offsetLeft + front.offsetWidth > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = front.offsetLeft + front.offsetWidth - strip.clientWidth;
    }
  }, [pane.activeTabId, pane.tabs.length]);

  return (
    <div className="doc-tabbar">
      <div
        ref={stripRef}
        className="doc-tabs"
        role="tablist"
        aria-label={pane.id === 'main' ? t('Open documents') : t('Open documents in the second pane')}
        data-pane-tabs={pane.id}
        onWheel={(e) => {
          if (stripRef.current) stripRef.current.scrollLeft += e.deltaY;
        }}
      >
        {pane.tabs.map((tab, index) => (
          <DocTab
            key={tab.id}
            tab={tab}
            paneId={pane.id}
            active={tab.id === pane.activeTabId}
            index={index}
            count={pane.tabs.length}
            focusSibling={focusSibling}
          />
        ))}
      </div>
      <button
        type="button"
        className="icon-btn doc-tabbar-btn"
        aria-label={t('New tab')}
        title={t('New tab ({shortcut})', { shortcut: 'Ctrl+T' })}
        onClick={() => nav().openTab({ view: 'home' })}
      >
        +
      </button>
      <span className="doc-tabbar-spacer" />
      {pane.id === 'main' && !split && (
        <button
          type="button"
          className="icon-btn doc-tabbar-btn"
          aria-label={t('Open a second pane')}
          title={t('Open a second pane ({shortcut})', { shortcut: 'Ctrl+\\' })}
          onClick={() => nav().toggleSplit()}
        >
          ◫
        </button>
      )}
      {pane.id === 'side' && (
        <button
          type="button"
          className="icon-btn doc-tabbar-btn"
          aria-label={t('Close the second pane')}
          title={t('Close the second pane. Its tabs move to the first. ({shortcut})', { shortcut: 'Ctrl+\\' })}
          onClick={() => nav().toggleSplit()}
        >
          ×
        </button>
      )}
    </div>
  );
}

/** How long a restored position keeps waiting for the document to be tall enough. */
const RESTORE_TRIES = 60;
const RESTORE_STEP_MS = 50;

/** Scrolls to a remembered position, as soon as the content is there to scroll through. */
function scrollWhenReady(el: HTMLElement, top: number): () => void {
  el.scrollTop = top;
  if (Math.abs(el.scrollTop - top) <= 1) return () => {};
  let tries = 0;
  let timer = 0;
  const stop = () => {
    window.clearTimeout(timer);
    el.removeEventListener('wheel', stop);
    el.removeEventListener('pointerdown', stop);
    el.removeEventListener('keydown', stop);
  };
  const tick = () => {
    el.scrollTop = top;
    tries += 1;
    if (Math.abs(el.scrollTop - top) <= 1 || tries >= RESTORE_TRIES) stop();
    else timer = window.setTimeout(tick, RESTORE_STEP_MS);
  };
  // Anything the person does themselves ends the wait.
  el.addEventListener('wheel', stop, { passive: true });
  el.addEventListener('pointerdown', stop);
  el.addEventListener('keydown', stop);
  timer = window.setTimeout(tick, RESTORE_STEP_MS);
  return stop;
}

function PaneView({ pane, focused, split, ratio }: { pane: NavPane; focused: boolean; split: boolean; ratio: number }) {
  useLocale();
  const tab = activeTab(pane);
  const routeKey = JSON.stringify(tab.route);
  const scrollerRef = useRef<HTMLElement>(null);
  const shown = useRef<{ tabId: string; routeKey: string } | null>(null);

  const tabIdRef = useRef(tab.id);
  tabIdRef.current = tab.id;

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return undefined;
    const previous = shown.current;
    shown.current = { tabId: tab.id, routeKey };
    if (previous?.tabId === tab.id) {
      // A new screen starts at the top.
      if (previous.routeKey !== routeKey) el.scrollTo(0, 0);
      return undefined;
    }
    // A tab coming to the front picks up where it was.
    return scrollWhenReady(el, tabScrollOf(tab.id));
  }, [tab.id, routeKey]);

  const focusPane = () => useNav.getState().focusPane(pane.id);
  // A screen that puts focus somewhere as it opens is not the person moving to its pane. Using
  // the Tab key is, and so is focus arriving in a document, which only a command does.
  const followFocus = (e: React.FocusEvent) => {
    if (tabKeyDown || (e.target as HTMLElement).closest('.ProseMirror')) focusPane();
  };
  const body = (
    <ErrorBoundary resetKey={routeKey}>
      <RouteView key={tab.id} route={tab.route} />
    </ErrorBoundary>
  );
  const onScroll = (e: React.UIEvent<HTMLElement>) => rememberTabScroll(tabIdRef.current, e.currentTarget.scrollTop);

  return (
    <PaneContext.Provider value={pane.id}>
      <div
        className={`pane${focused ? ' is-focused' : ''}`}
        data-pane-id={pane.id}
        style={split ? { flexGrow: pane.id === 'main' ? ratio : 1 - ratio } : undefined}
        onPointerDownCapture={focusPane}
        onFocusCapture={followFocus}
      >
        <TabBar pane={pane} split={split} />
        {pane.id === 'main' ? (
          <main className="content" ref={scrollerRef} onScroll={onScroll}>
            {body}
          </main>
        ) : (
          <section className="content" aria-label={t('Second pane')} ref={scrollerRef} onScroll={onScroll}>
            {body}
          </section>
        )}
      </div>
    </PaneContext.Provider>
  );
}

function SplitResizer({ ratio, roomRef }: { ratio: number; roomRef: React.RefObject<HTMLDivElement | null> }) {
  useLocale();
  const setRatio = useNav((s) => s.setSplitRatio);
  return (
    <div
      className="split-resizer"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={t('Resize the two panes')}
      aria-valuemin={MIN_SPLIT * 100}
      aria-valuemax={MAX_SPLIT * 100}
      aria-valuenow={Math.round(ratio * 100)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          setRatio(ratio + (e.key === 'ArrowLeft' ? -0.02 : 0.02));
        }
      }}
      onDoubleClick={() => setRatio(0.5)}
      onPointerDown={(e) => {
        e.preventDefault();
        const handle = e.currentTarget;
        handle.setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent) => {
          const box = roomRef.current?.getBoundingClientRect();
          if (box && box.width > 0) setRatio((ev.clientX - box.left) / box.width);
        };
        const up = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
      }}
    />
  );
}

/** True from pressing Tab until the next key or click. */
let tabKeyDown = false;

export function Panes() {
  const panes = useNav((s) => s.panes);
  const focusedPaneId = useNav((s) => s.focusedPaneId);
  const ratio = useNav((s) => s.splitRatio);
  const focusMode = useUi((s) => s.focusMode);
  const roomRef = useRef<HTMLDivElement>(null);
  const split = panes.length > 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      tabKeyDown = e.key === 'Tab';
    };
    const onPointer = () => {
      tabKeyDown = false;
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointer, true);
    };
  }, []);

  return (
    <div className="panes-room">
      <div className={`panes${focusMode ? ' is-focus-mode' : ''}`} ref={roomRef}>
        {panes.map((pane, index) => (
          <Fragment key={pane.id}>
            {index === 1 && <SplitResizer ratio={ratio} roomRef={roomRef} />}
            <PaneView pane={pane} focused={pane.id === focusedPaneId} split={split} ratio={ratio} />
          </Fragment>
        ))}
      </div>
    </div>
  );
}
