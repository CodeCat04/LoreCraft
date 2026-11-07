import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: () => new Promise(() => {}) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }));

import { ContextMenuHost } from './ContextMenu';
import { historyEntries, NavButtons, useMouseNavigation } from './NavButtons';
import { useNav, type Route } from '../state/nav';
import { useTitles } from '../state/project';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const page = (id: string): Route => ({ view: 'page', id });

function Harness() {
  useMouseNavigation();
  return (
    <>
      <NavButtons />
      <ContextMenuHost />
    </>
  );
}

const button = (direction: 'back' | 'forward') =>
  document.querySelector<HTMLButtonElement>(`[data-testid="nav-${direction}"]`)!;
const currentId = () => {
  const route = useNav.getState().route;
  return route.view === 'page' ? route.id : route.view;
};

function side(button: number) {
  act(() => {
    for (const type of ['mousedown', 'mouseup', 'auxclick']) {
      const event = new MouseEvent(type, { button, bubbles: true, cancelable: true });
      document.body.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
  });
}

describe('Back and Forward buttons', () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    useNav.getState().resetLayout();
    const entries = [
      { id: 'a', title: 'Alder', aliases: [] },
      { id: 'b', title: 'Birch', aliases: [] },
    ];
    useTitles.setState({ byId: new Map(entries.map((e) => [e.id, e])) } as never);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<Harness />));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('is disabled with nowhere to go, and names itself and its shortcut', () => {
    expect(button('back').disabled).toBe(true);
    expect(button('forward').disabled).toBe(true);
    expect(button('back').getAttribute('aria-label')).toBe('Back');
    expect(button('forward').getAttribute('aria-label')).toBe('Forward');
    expect(button('back').title).toContain('Alt+←');
    expect(button('forward').title).toContain('Alt+→');
  });

  it('goes back and forward through the focused tab', () => {
    act(() => useNav.getState().go(page('a')));
    act(() => useNav.getState().go(page('b')));
    expect(button('back').disabled).toBe(false);
    expect(button('forward').disabled).toBe(true);
    act(() => button('back').click());
    expect(currentId()).toBe('a');
    expect(button('forward').disabled).toBe(false);
    act(() => button('forward').click());
    expect(currentId()).toBe('b');
  });

  it('follows the tab in front', () => {
    act(() => useNav.getState().go(page('a')));
    expect(button('back').disabled).toBe(false);
    act(() => useNav.getState().openTab(page('b')));
    expect(button('back').disabled).toBe(true);
  });

  it('answers the mouse side buttons, and keeps the web view from navigating', () => {
    act(() => useNav.getState().go(page('a')));
    act(() => useNav.getState().go(page('b')));
    side(3);
    expect(currentId()).toBe('a');
    side(4);
    expect(currentId()).toBe('b');
  });

  it('lists recent pages by title on right-click, and jumps to one', async () => {
    act(() => useNav.getState().go(page('a')));
    act(() => useNav.getState().go(page('b')));
    act(() => useNav.getState().go({ view: 'recent' }));
    await act(async () => {
      button('back').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    });
    const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(items.map((i) => i.textContent)).toEqual(['Birch', 'Alder', 'Main page']);
    act(() => items[1].click());
    expect(currentId()).toBe('a');
    expect(useNav.getState().forward).toEqual([page('b'), { view: 'recent' }]);
  });
});

describe('history entries for the menu', () => {
  it('lists the nearest first, with the offset that reaches each', () => {
    const back = [page('a'), page('b'), page('c')];
    const forward = [page('d'), page('e')];
    expect(historyEntries('back', back, forward).map((e) => e.offset)).toEqual([-1, -2, -3]);
    expect(historyEntries('back', back, forward)[0].route).toEqual(page('c'));
    expect(historyEntries('forward', back, forward).map((e) => e.offset)).toEqual([1, 2]);
    expect(historyEntries('back', back, forward, 2)).toHaveLength(2);
  });
});
