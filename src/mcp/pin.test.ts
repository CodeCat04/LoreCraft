import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, withDefaults, type Settings } from '../lib/settings';
import { freshLayout, openBeside, openTab, type Layout } from '../state/tabs';
import { listInSight, nextReady, showListIn } from './pin';

const LIST = { view: 'proposals' } as const;

describe('where the pinned list opens', () => {
  it('opens beside the writing when no tab holds it', () => {
    expect(showListIn(freshLayout({ view: 'write' }))).toEqual({ kind: 'beside' });
  });

  it('reuses the tab already showing it, in whichever pane', () => {
    const layout = openBeside(freshLayout({ view: 'write' }), LIST);
    const side = layout.panes[1];
    expect(showListIn(layout)).toEqual({ kind: 'activate', tabId: side.activeTabId, paneId: 'side' });
    expect(listInSight(layout)).toBe(true);
  });

  it('brings a list in a back tab to the front, instead of opening a second one', () => {
    const start = freshLayout(LIST);
    const listTab = start.panes[0].tabs[0].id;
    const layout: Layout = openTab(start, 'main', { view: 'home' });
    expect(listInSight(layout)).toBe(false);
    expect(showListIn(layout)).toEqual({ kind: 'activate', tabId: listTab, paneId: 'main' });
  });
});

describe('the suggestion ready next', () => {
  it('is the one after the one dealt with', () => {
    expect(nextReady(['a', 'b', 'c'], 'b', ['a', 'c'])).toBe('c');
  });

  it('is the one before when the last one went', () => {
    expect(nextReady(['a', 'b', 'c'], 'c', ['a', 'b'])).toBe('b');
  });

  it('skips others that went at the same time, and counts new arrivals', () => {
    expect(nextReady(['a', 'b', 'c', 'd'], 'b', ['a', 'd', 'e'])).toBe('d');
    expect(nextReady(['a'], 'a', ['z'])).toBe('z');
  });

  it('is none when nothing is left, or the one dealt with is still there', () => {
    expect(nextReady(['a'], 'a', [])).toBeNull();
    expect(nextReady(['a', 'b'], 'a', ['a', 'b'])).toBeNull();
  });
});

describe('the pin setting', () => {
  it('starts unpinned, also for settings saved before it existed', () => {
    expect(DEFAULT_SETTINGS.mcp.pinned).toBe(false);
    const old = withDefaults<Settings>({ appearance: { theme: 'encyclopedia' } }, DEFAULT_SETTINGS);
    expect(old.mcp).toEqual({ pinned: false });
    expect(withDefaults<Settings>({ mcp: { pinned: true } }, DEFAULT_SETTINGS).mcp.pinned).toBe(true);
  });
});
