import { describe, expect, it } from 'vitest';

import type { Route } from './nav';
import {
  activateTab,
  activeTab,
  closeOtherTabs,
  closeSplit,
  closeTab,
  companionRoute,
  cycleTab,
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
  restoreLayout,
  saveLayout,
  setRatio,
  stepBack,
  stepForward,
  toggleSplit,
  type Layout,
} from './tabs';

const page = (id: string): Route => ({ view: 'page', id });
const routes = (layout: Layout, pane: 'main' | 'side' = 'main') =>
  paneById(layout, pane)?.tabs.map((t) => (t.route.view === 'page' ? t.route.id : t.route.view));

describe('history in a tab', () => {
  it('goes back and forward within the one tab', () => {
    let layout = freshLayout();
    layout = goTo(layout, 'main', page('a'));
    layout = goTo(layout, 'main', page('b'));
    expect(focusedTab(layout).route).toEqual(page('b'));
    layout = stepBack(layout, 'main');
    expect(focusedTab(layout).route).toEqual(page('a'));
    layout = stepForward(layout, 'main');
    expect(focusedTab(layout).route).toEqual(page('b'));
    expect(focusedTab(layout).back).toHaveLength(2);
  });

  it('keeps each tab apart', () => {
    let layout = goTo(freshLayout(), 'main', page('a'));
    const first = focusedTab(layout).id;
    layout = openTab(layout, 'main', page('x'));
    layout = goTo(layout, 'main', page('y'));
    layout = stepBack(layout, 'main');
    expect(focusedTab(layout).route).toEqual(page('x'));
    layout = activateTab(layout, first);
    expect(focusedTab(layout).back).toEqual([{ view: 'home' }]);
    expect(focusedTab(layout).forward).toEqual([]);
  });

  it('does not add history for the screen already showing', () => {
    let layout = goTo(freshLayout(), 'main', page('a'));
    layout = goTo(layout, 'main', page('a'));
    expect(focusedTab(layout).back).toHaveLength(1);
    layout = replaceRoute(layout, 'main', page('b'));
    expect(focusedTab(layout).back).toHaveLength(1);
    expect(focusedTab(layout).route).toEqual(page('b'));
  });

  it('ignores a pane that has gone', () => {
    const layout = freshLayout();
    expect(goTo(layout, 'side', page('a'))).toBe(layout);
    expect(replaceRoute(layout, 'side', page('a'))).toBe(layout);
  });
});

describe('tabs', () => {
  it('opens a new tab just after the current one', () => {
    let layout = openTab(freshLayout(), 'main', page('a'));
    layout = openTab(layout, 'main', page('b'));
    layout = activateTab(layout, paneById(layout, 'main')!.tabs[1].id);
    layout = openTab(layout, 'main', page('c'));
    expect(routes(layout)).toEqual(['home', 'a', 'c', 'b']);
    expect(focusedTab(layout).route).toEqual(page('c'));
  });

  it('closes to the next tab, or the one before it at the end', () => {
    let layout = openTab(openTab(freshLayout(), 'main', page('a')), 'main', page('b'));
    const tabs = paneById(layout, 'main')!.tabs;
    layout = activateTab(layout, tabs[1].id);
    layout = closeTab(layout, tabs[1].id);
    expect(focusedTab(layout).route).toEqual(page('b'));
    layout = closeTab(layout, tabs[2].id);
    expect(focusedTab(layout).route).toEqual({ view: 'home' });
  });

  it('keeps the current tab when another one closes', () => {
    let layout = openTab(openTab(freshLayout(), 'main', page('a')), 'main', page('b'));
    const tabs = paneById(layout, 'main')!.tabs;
    layout = closeTab(layout, tabs[0].id);
    expect(focusedTab(layout).route).toEqual(page('b'));
    expect(routes(layout)).toEqual(['a', 'b']);
  });

  it('shows the main page when the last tab closes', () => {
    let layout = goTo(freshLayout(), 'main', page('a'));
    layout = closeTab(layout, focusedTab(layout).id);
    expect(routes(layout)).toEqual(['home']);
    expect(focusedTab(layout).back).toEqual([]);
    expect(closeTab(layout, focusedTab(layout).id)).toBe(layout);
  });

  it('cycles in both directions and wraps', () => {
    let layout = openTab(openTab(freshLayout(), 'main', page('a')), 'main', page('b'));
    layout = cycleTab(layout, 'main', 1);
    expect(focusedTab(layout).route).toEqual({ view: 'home' });
    layout = cycleTab(layout, 'main', -1);
    expect(focusedTab(layout).route).toEqual(page('b'));
  });

  it('reorders within a pane', () => {
    const layout = openTab(openTab(freshLayout(), 'main', page('a')), 'main', page('b'));
    const [home] = paneById(layout, 'main')!.tabs;
    const moved = moveTab(layout, home.id, 'main', 2);
    expect(routes(moved)).toEqual(['a', 'b', 'home']);
    expect(focusedTab(moved).route).toEqual(page('b'));
    expect(moveTab(layout, home.id, 'main', 0)).toBe(layout);
  });

  it('closes the others', () => {
    const layout = openTab(openTab(freshLayout(), 'main', page('a')), 'main', page('b'));
    const keep = paneById(layout, 'main')!.tabs[1];
    expect(routes(closeOtherTabs(layout, keep.id))).toEqual(['a']);
  });
});

describe('the split', () => {
  it('opens a route beside and moves focus there', () => {
    const layout = openBeside(freshLayout(), page('a'));
    expect(routes(layout, 'side')).toEqual(['a']);
    expect(layout.focusedPaneId).toBe('side');
    expect(focusedTab(layout).route).toEqual(page('a'));
  });

  it('can leave focus where it was', () => {
    const layout = openBeside(freshLayout(), page('a'), { keepFocus: true });
    expect(layout.focusedPaneId).toBe('main');
    expect(focusedTab(layout).route).toEqual({ view: 'home' });
  });

  it('reuses a tab already showing that route beside', () => {
    let layout = openBeside(freshLayout(), page('a'));
    layout = focusOn(layout, 'main');
    layout = openBeside(layout, page('b'));
    layout = focusOn(layout, 'main');
    layout = openBeside(layout, page('a'));
    expect(routes(layout, 'side')).toEqual(['a', 'b']);
    expect(activeTab(paneById(layout, 'side')!).route).toEqual(page('a'));
  });

  it('moves a tab across instead of opening the document twice', () => {
    const layout = openTab(freshLayout(), 'main', page('a'));
    const tab = focusedTab(layout);
    const moved = moveTabBeside(layout, tab.id);
    expect(routes(moved)).toEqual(['home']);
    expect(routes(moved, 'side')).toEqual(['a']);
    expect(focusedTab(moved).id).toBe(tab.id);
  });

  it('leaves the main page behind when moving the only tab across', () => {
    const start = goTo(freshLayout(), 'main', page('a'));
    const moved = moveTabBeside(start, focusedTab(start).id);
    expect(routes(moved)).toEqual(['home']);
    expect(routes(moved, 'side')).toEqual(['a']);
  });

  it('closes the second pane with its last tab', () => {
    const layout = openBeside(freshLayout(), page('a'));
    const closed = closeTab(layout, focusedTab(layout).id);
    expect(closed.panes).toHaveLength(1);
    expect(closed.focusedPaneId).toBe('main');
  });

  it('lets the second pane take over when the first closes', () => {
    let layout = openBeside(freshLayout(), page('a'));
    layout = closeTab(layout, paneById(layout, 'main')!.tabs[0].id);
    expect(layout.panes.map((p) => p.id)).toEqual(['main']);
    expect(routes(layout)).toEqual(['a']);
    expect(layout.focusedPaneId).toBe('main');
  });

  it('closing the split moves the tabs across and keeps the one in use', () => {
    let layout = openTab(freshLayout(), 'main', page('a'));
    layout = openBeside(layout, page('a'));
    layout = openTab(layout, 'side', page('b'));
    const closed = closeSplit(layout);
    expect(routes(closed)).toEqual(['home', 'a', 'b']);
    expect(closed.panes).toHaveLength(1);
    expect(focusedTab(closed).route).toEqual(page('b'));
  });

  it('pairs a scene with the page last read, and a page with the book', () => {
    let layout = goTo(freshLayout(), 'main', page('a'));
    layout = goTo(layout, 'main', { view: 'write', nodeId: 'n' });
    expect(companionRoute(focusedTab(layout))).toEqual(page('a'));
    expect(companionRoute(focusedTab(freshLayout({ view: 'write' })))).toEqual({ view: 'home' });
    expect(companionRoute(focusedTab(freshLayout(page('x'))))).toEqual({ view: 'write' });
  });

  it('toggles', () => {
    const open = toggleSplit(freshLayout());
    expect(open.panes).toHaveLength(2);
    expect(toggleSplit(open).panes).toHaveLength(1);
  });

  it('keeps the split within limits', () => {
    expect(setRatio(freshLayout(), 0.01).splitRatio).toBe(0.2);
    expect(setRatio(freshLayout(), 0.99).splitRatio).toBe(0.8);
  });
});

describe('remembering a layout', () => {
  it('round-trips tabs, panes, focus, the split and scroll positions', () => {
    let layout = openTab(freshLayout(), 'main', page('a'));
    layout = openBeside(layout, { view: 'write', nodeId: 'n' });
    layout = setRatio(layout, 0.6);
    const scroll = new Map([[paneById(layout, 'main')!.tabs[1].id, 420]]);
    const saved = JSON.parse(JSON.stringify(saveLayout(layout, (id) => scroll.get(id) ?? 0)));
    const restoredScroll = new Map<string, number>();
    const back = restoreLayout(saved, () => true, (id, top) => restoredScroll.set(id, top))!;
    expect(routes(back)).toEqual(['home', 'a']);
    expect(routes(back, 'side')).toEqual(['write']);
    expect(back.focusedPaneId).toBe('side');
    expect(back.splitRatio).toBe(0.6);
    expect(activeTab(paneById(back, 'main')!).route).toEqual(page('a'));
    expect([...restoredScroll.values()]).toEqual([420]);
    expect(restoredScroll.has(paneById(back, 'main')!.tabs[1].id)).toBe(true);
  });

  it('keeps the history of each tab, without what no longer exists', () => {
    let layout = goTo(freshLayout(), 'main', page('gone'));
    layout = goTo(layout, 'main', page('a'));
    layout = goTo(layout, 'main', page('b'));
    layout = stepBack(layout, 'main');
    const saved = JSON.parse(JSON.stringify(saveLayout(layout, () => 0)));
    const back = restoreLayout(saved, (r) => r.view !== 'page' || r.id !== 'gone', () => {})!;
    expect(focusedTab(back).route).toEqual(page('a'));
    expect(focusedTab(back).back).toEqual([{ view: 'home' }]);
    expect(focusedTab(back).forward).toEqual([page('b')]);
  });

  it('quietly leaves out what no longer exists', () => {
    const saved = {
      panes: [
        { tabs: [{ route: page('gone') }, { route: page('a') }, { route: page('gone') }], active: 2 },
        { tabs: [{ route: page('gone') }], active: 0 },
      ],
      focused: 1,
      splitRatio: 0.3,
    };
    const back = restoreLayout(saved, (r) => r.view !== 'page' || r.id !== 'gone', () => {})!;
    expect(back.panes).toHaveLength(1);
    expect(routes(back)).toEqual(['a']);
    expect(back.focusedPaneId).toBe('main');
  });

  it('moves the second pane up when the first has nothing left', () => {
    const saved = { panes: [{ tabs: [{ route: page('gone') }], active: 0 }, { tabs: [{ route: page('a') }], active: 0 }], focused: 1 };
    const back = restoreLayout(saved, (r) => r.view !== 'page' || r.id !== 'gone', () => {})!;
    expect(back.panes.map((p) => p.id)).toEqual(['main']);
    expect(back.focusedPaneId).toBe('main');
  });

  it('survives nonsense from the settings file', () => {
    for (const junk of [null, undefined, 3, 'x', {}, { panes: 'no' }, { panes: [] }, { panes: [null] }, { panes: [{ tabs: [{}] }] }]) {
      expect(restoreLayout(junk, () => true, () => {})).toBeNull();
    }
  });
});
