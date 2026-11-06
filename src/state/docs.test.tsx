import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  allPlaces,
  docPlace,
  isDocClaimed,
  rememberCursorAt,
  rememberScrollAt,
  rememberTabScroll,
  resetPlaces,
  setDocPlace,
  subscribePlaces,
  tabScrollOf,
  useDocClaim,
  type DocClaim,
} from './docs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('claims', () => {
  let root: Root;
  const seen: Record<string, DocClaim> = {};

  function Viewer({ name, docKey, wanted }: { name: string; docKey: string; wanted: boolean }) {
    seen[name] = useDocClaim(docKey, wanted);
    return null;
  }

  type Shown = { name: string; docKey?: string; wanted?: boolean };

  function show(viewers: Shown[]) {
    act(() => {
      root.render(
        viewers.map(({ name, docKey = 'node:1', wanted = true }) => (
          <Viewer key={name} name={name} docKey={docKey} wanted={wanted} />
        )),
      );
    });
  }

  beforeEach(() => {
    root = createRoot(document.createElement('div'));
  });

  afterEach(() => {
    act(() => root.unmount());
    expect(isDocClaimed('node:1')).toBe(false);
  });

  it('lets the first view edit and blocks the second', () => {
    show([{ name: 'a' }, { name: 'b' }]);
    expect(seen.a.state).toBe('mine');
    expect(seen.b.state).toBe('blocked');
    expect(seen.b.watchOthers).toBe(true);
    expect(seen.a.watchOthers).toBe(false);
  });

  it('never blocks a view on its own, not even on its first render', () => {
    const states: string[] = [];
    function Recorder() {
      states.push(useDocClaim('node:1', true).state);
      return null;
    }
    act(() => root.render(<Recorder />));
    expect(states.every((s) => s === 'mine')).toBe(true);
  });

  it('hands the document on when the first view goes', () => {
    show([{ name: 'a' }, { name: 'b' }]);
    show([{ name: 'b' }]);
    expect(seen.b.state).toBe('mine');
    expect(seen.b.watchOthers).toBe(false);
  });

  it('hands it on when the first view stops editing', () => {
    show([{ name: 'a' }, { name: 'b' }]);
    show([{ name: 'a', wanted: false }, { name: 'b' }]);
    expect(seen.a.state).toBe('free');
    expect(seen.a.watchOthers).toBe(true);
    expect(seen.b.state).toBe('mine');
  });

  it('lets a blocked view take over, which blocks the other', () => {
    show([{ name: 'a' }, { name: 'b' }]);
    act(() => seen.b.takeOver());
    expect(seen.b.state).toBe('mine');
    expect(seen.a.state).toBe('blocked');
  });

  it('lets go of a take-over by a view that never got to edit', () => {
    show([{ name: 'a' }, { name: 'b', wanted: false }]);
    act(() => seen.b.takeOver());
    show([{ name: 'a' }]);
    expect(seen.a.state).toBe('mine');
  });

  it('a reader blocks no one', () => {
    show([{ name: 'reader', wanted: false }, { name: 'editor' }]);
    expect(seen.reader.state).toBe('free');
    expect(seen.reader.watchOthers).toBe(true);
    expect(seen.editor.state).toBe('mine');
  });

  it('keeps different documents apart', () => {
    show([{ name: 'a' }, { name: 'b', docKey: 'node:2' }]);
    expect(seen.a.state).toBe('mine');
    expect(seen.b.state).toBe('mine');
    expect(isDocClaimed('node:2')).toBe(true);
  });

  it('follows a view to its next document', () => {
    show([{ name: 'a' }, { name: 'b' }]);
    show([{ name: 'a', docKey: 'node:2' }, { name: 'b' }]);
    expect(seen.a.state).toBe('mine');
    expect(seen.b.state).toBe('mine');
  });
});

describe('places', () => {
  beforeEach(() => resetPlaces());

  it('keeps the cursor and the scroll position of a document together', () => {
    rememberCursorAt('node:1', 5, 9);
    rememberScrollAt('node:1', 300);
    expect(docPlace('node:1')).toEqual({ anchor: 5, head: 9, scrollTop: 300 });
    rememberScrollAt('node:2', 40);
    expect(docPlace('node:2')).toEqual({ anchor: 0, head: 0, scrollTop: 40 });
  });

  it('remembers how far each tab was scrolled', () => {
    rememberTabScroll('tab-1', 120);
    expect(tabScrollOf('tab-1')).toBe(120);
    expect(tabScrollOf('tab-2')).toBe(0);
  });

  it('says when something changes, until told to stop', () => {
    const listener = vi.fn();
    const stop = subscribePlaces(listener);
    rememberCursorAt('node:1', 1, 1);
    rememberScrollAt('node:1', 1);
    rememberTabScroll('tab-1', 1);
    setDocPlace('node:2', { anchor: 2, head: 2, scrollTop: -1 });
    expect(listener).toHaveBeenCalledTimes(4);
    stop();
    rememberCursorAt('node:1', 2, 2);
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('starts over from what was saved, and ignores anything malformed', () => {
    rememberCursorAt('node:old', 1, 1);
    rememberTabScroll('tab-1', 10);
    resetPlaces({ 'node:1': { anchor: 3, head: 4, scrollTop: 50 }, 'node:bad': { anchor: 'x' }, 'node:worse': null });
    expect(allPlaces()).toEqual({ 'node:1': { anchor: 3, head: 4, scrollTop: 50 } });
    expect(tabScrollOf('tab-1')).toBe(0);
    for (const junk of [null, undefined, 3, 'x']) {
      resetPlaces(junk);
      expect(allPlaces()).toEqual({});
    }
  });
});
