import { beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultLabel, parseRecent, pickerOrder, pushRecent, RECENT_LIMIT, rewriteDefault } from './defaults';
import { LIBRARY, builtInStyle } from './library';
import type { StoredChoices, WritingStyle } from './types';

const lookup = (id: string): WritingStyle | undefined => builtInStyle(id);

describe('the default style for a rewrite', () => {
  const choices: StoredChoices = {
    project: { styleId: 'tom-clancy' },
    books: { b1: { styleId: 'ernest-hemingway' } },
    scenes: { n1: { styleId: 'douglas-adams' } },
  };

  it('is the scene, then the book, then the project', () => {
    expect(rewriteDefault(choices, { bookId: 'b1', nodeId: 'n1' }, lookup)).toMatchObject({ styleId: 'douglas-adams', level: 'scene' });
    expect(rewriteDefault(choices, { bookId: 'b1', nodeId: 'n2' }, lookup)).toMatchObject({ styleId: 'ernest-hemingway', level: 'book' });
    expect(rewriteDefault(choices, { bookId: 'b2', nodeId: 'n2' }, lookup)).toMatchObject({ styleId: 'tom-clancy', level: 'project' });
    expect(rewriteDefault(choices, {}, lookup)).toMatchObject({ styleId: 'tom-clancy', level: 'project', name: 'Tom Clancy' });
  });

  it('is none when nothing is chosen', () => {
    expect(rewriteDefault({}, { bookId: 'b1', nodeId: 'n1' }, lookup)).toBeNull();
  });

  it('skips a style that cannot be found, but keeps a stored copy', () => {
    expect(rewriteDefault({ scenes: { n1: { styleId: 'gone' } }, project: { styleId: 'jane-austen' } }, { nodeId: 'n1' }, lookup)?.styleId).toBe('jane-austen');
    const copy: StoredChoices = { books: { b1: { styleId: 'custom-x', name: 'Elsewhere', prompt: 'Write like elsewhere.' } } };
    expect(rewriteDefault(copy, { bookId: 'b1' }, lookup)).toMatchObject({ styleId: 'custom-x', name: 'Elsewhere', level: 'book' });
  });

  it('names where it comes from', () => {
    expect(defaultLabel('project', 'Tolkien')).toBe('Project style: Tolkien');
    expect(defaultLabel('book', 'Tolkien')).toBe('Book style: Tolkien');
    expect(defaultLabel('scene', 'Tolkien')).toBe('Scene style: Tolkien');
  });
});

describe('the recent list', () => {
  it('puts the newest first, once, and keeps five', () => {
    let list: string[] = [];
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) list = pushRecent(list, id);
    expect(list).toEqual(['f', 'e', 'd', 'c', 'b']);
    expect(list).toHaveLength(RECENT_LIMIT);
    expect(pushRecent(list, 'c')).toEqual(['c', 'f', 'e', 'd', 'b']);
    expect(pushRecent(['a'], 'a')).toEqual(['a']);
  });

  it('reads back only a list of ids', () => {
    expect(parseRecent(null)).toEqual([]);
    expect(parseRecent('not json')).toEqual([]);
    expect(parseRecent('{"a":1}')).toEqual([]);
    expect(parseRecent('["a", 3, "", "b", "a"]')).toEqual(['a', 'b']);
    expect(parseRecent(JSON.stringify(['1', '2', '3', '4', '5', '6', '7']))).toHaveLength(RECENT_LIMIT);
  });

  it('orders the picker: the default, then recent, then the rest', () => {
    const ordered = pickerOrder(LIBRARY, ['jane-austen', 'tom-clancy', 'jane-austen', 'gone', 'ernest-hemingway']);
    expect(ordered.slice(0, 3).map((s) => s.id)).toEqual(['jane-austen', 'tom-clancy', 'ernest-hemingway']);
    expect(ordered).toHaveLength(LIBRARY.length);
    expect(new Set(ordered.map((s) => s.id)).size).toBe(LIBRARY.length);
    expect(pickerOrder(LIBRARY, [null, undefined])).toEqual(LIBRARY);
  });
});

const meta = new Map<string, string>();
const setMetaCalls: string[] = [];
vi.mock('../lib/api', () => ({
  project: {
    getMeta: vi.fn(async (key: string) => meta.get(key) ?? null),
    setMeta: vi.fn(async (key: string, value: string) => {
      setMetaCalls.push(key);
      meta.set(key, value);
      return true;
    }),
  },
  nodes: { get: vi.fn(async (id: string) => (id === 'n1' ? { bookId: 'b1' } : Promise.reject(new Error('gone')))) },
  settings: { update: vi.fn(async () => ({})) },
  app: { setTheme: vi.fn(async () => true) },
  pages: { titles: vi.fn(async () => []) },
}));

describe('defaults and recent styles in a project', () => {
  beforeEach(async () => {
    meta.clear();
    setMetaCalls.length = 0;
    const { useProject } = await import('../state/project');
    useProject.getState().setStatus({ open: true, name: 'T', path: null, dirty: false });
    const { useSettings } = await import('../state/settings');
    useSettings.setState((s) => ({ settings: { ...s.settings, writingStyles: { custom: [], favorites: [] } } }));
  });

  it('resolves the default for a scene through its book', async () => {
    const { resolveRewriteDefault, setActiveStyle } = await import('./store');
    expect(await resolveRewriteDefault({ nodeId: 'n1' })).toBeNull();
    await setActiveStyle({ kind: 'project' }, 'tom-clancy');
    expect(await resolveRewriteDefault({ nodeId: 'n1' })).toMatchObject({ styleId: 'tom-clancy', level: 'project' });
    await setActiveStyle({ kind: 'book', bookId: 'b1' }, 'ernest-hemingway');
    expect(await resolveRewriteDefault({ nodeId: 'n1' })).toMatchObject({ styleId: 'ernest-hemingway', level: 'book' });
    await setActiveStyle({ kind: 'scene', nodeId: 'n1' }, 'douglas-adams');
    expect(await resolveRewriteDefault({ nodeId: 'n1' })).toMatchObject({ styleId: 'douglas-adams', level: 'scene' });
    // A wiki page has no scene or book, so only the project's applies.
    expect(await resolveRewriteDefault({})).toMatchObject({ styleId: 'tom-clancy', level: 'project' });
  });

  it('remembers the last five styles per project, and writes only on a change', async () => {
    const { loadRecentStyles, recordRecentStyle } = await import('./store');
    expect(await loadRecentStyles()).toEqual([]);
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) await recordRecentStyle(id);
    expect(await loadRecentStyles()).toEqual(['f', 'e', 'd', 'c', 'b']);
    setMetaCalls.length = 0;
    await recordRecentStyle('f');
    expect(setMetaCalls).toEqual([]);
    await recordRecentStyle('b');
    expect(await loadRecentStyles()).toEqual(['b', 'f', 'e', 'd', 'c']);
  });

  it('has no default and no recent list with no project open', async () => {
    const { useProject } = await import('../state/project');
    useProject.getState().setStatus({ open: false, name: '', path: null, dirty: false });
    const { loadRecentStyles, recordRecentStyle, resolveRewriteDefault } = await import('./store');
    await recordRecentStyle('tom-clancy');
    expect(setMetaCalls).toEqual([]);
    expect(await loadRecentStyles()).toEqual([]);
    expect(await resolveRewriteDefault({ nodeId: 'n1' })).toBeNull();
  });
});
