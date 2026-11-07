import type { Editor } from '@tiptap/core';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Registering every module would reach the Rust side. Nothing here needs an answer.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: () => new Promise(() => {}),
  convertFileSrc: (path: string) => path,
  Channel: class {},
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
}));

import { allCommands, commandForShortcut, normalizeShortcut, shortcutRunsCommand, type Command } from './commands';
import { registerCoreCommands } from './coreCommands';
import { registerModules } from './modules';
import { registerEditor, unregisterEditor } from '../editor/ai/registry';
import { useReadAloud } from '../prose/readAloud';
import { useProject } from '../state/project';
import { useWikiSession } from '../wiki/session';

/**
 * Commands that share a shortcut because they can never be available at the same time. Each
 * pair needs a test below that shows it.
 */
const EXCLUSIVE: Array<[string, string]> = [['prose.readAloud', 'prose.stopReading']];

function enabled(command: Command): boolean {
  try {
    return command.when ? command.when() : true;
  } catch {
    return false;
  }
}

function byShortcut(): Map<string, Command[]> {
  const groups = new Map<string, Command[]>();
  for (const command of allCommands()) {
    if (!command.shortcut) continue;
    const key = normalizeShortcut(command.shortcut);
    groups.set(key, [...(groups.get(key) ?? []), command]);
  }
  return groups;
}

/** Shortcuts that more than one command answers to right now. */
function clashesNow(): string[] {
  const clashes: string[] = [];
  for (const [key, group] of byShortcut()) {
    const live = group.filter(enabled);
    if (live.length > 1) clashes.push(`${key}: ${live.map((c) => c.id).join(', ')}`);
  }
  return clashes;
}

/** Enough of an editor for the registry: one that is on screen and can be edited. */
function fakeEditor(): Editor {
  return {
    isDestroyed: false,
    isEditable: true,
    state: { selection: { from: 1, to: 6, empty: false } },
  } as unknown as Editor;
}

beforeAll(() => {
  registerCoreCommands();
  registerModules();
});

describe('shortcuts', () => {
  it('give each shortcut to one command, unless the commands are never available together', () => {
    const shared: string[] = [];
    for (const [key, group] of byShortcut()) {
      if (group.length < 2) continue;
      const ids = group.map((c) => c.id).sort();
      const declared = EXCLUSIVE.some((pair) => [...pair].sort().join() === ids.join());
      if (!declared) shared.push(`${key}: ${ids.join(', ')}`);
    }
    expect(shared).toEqual([]);
  });

  it('keep Ctrl+Shift+K for Ask AI while a wiki page is being edited', () => {
    useProject.setState({ status: { open: true, name: 'World', path: null, dirty: false } });
    const editor = fakeEditor();
    registerEditor(editor, { kind: 'page', id: 'p1', title: 'Aria' });
    useWikiSession.setState({ pageId: 'p1', title: 'Aria', editor, tab: 'edit', switchTab: () => {} });
    try {
      expect(commandForShortcut('Ctrl+Shift+K')?.id).toBe('ai.ask');
      expect(commandForShortcut('Ctrl+Alt+K')?.id).toBe('wiki.insertLink');
      expect(clashesNow()).toEqual([]);
    } finally {
      unregisterEditor(editor);
      useWikiSession.setState({ pageId: null, title: '', editor: null, tab: 'read', switchTab: null });
    }
  });

  it('keep Ctrl+Shift+K for Ask AI in a scene', () => {
    useProject.setState({ status: { open: true, name: 'World', path: null, dirty: false } });
    const editor = fakeEditor();
    registerEditor(editor, { kind: 'node', id: 'n1', title: 'Arrival' });
    try {
      expect(commandForShortcut('Ctrl+Shift+K')?.id).toBe('ai.ask');
      expect(commandForShortcut('Ctrl+Shift+Y')?.id).toBe('ai.rewriteInMyStyle');
      expect(clashesNow()).toEqual([]);
    } finally {
      unregisterEditor(editor);
    }
  });

  it('read aloud and stop reading are never available together', () => {
    useProject.setState({ status: { open: true, name: 'World', path: null, dirty: false } });
    useReadAloud.setState({ status: 'idle' });
    expect(commandForShortcut('Ctrl+Alt+R')?.id).toBe('prose.readAloud');
    expect(clashesNow()).toEqual([]);
    useReadAloud.setState({ status: 'speaking' });
    expect(commandForShortcut('Ctrl+Alt+R')?.id).toBe('prose.stopReading');
    expect(clashesNow()).toEqual([]);
    useReadAloud.setState({ status: 'idle' });
  });
});

describe('shortcuts in text fields', () => {
  it('lets global shortcuts with modifiers run from a text field', () => {
    for (const key of ['Ctrl+Shift+Delete', 'Ctrl+K', 'Ctrl+Alt+K', 'Alt+ArrowLeft', 'F2', 'Shift+F3', 'Ctrl++']) {
      expect(shortcutRunsCommand(key, true), key).toBe(true);
    }
  });

  it('leaves keys that edit text to the field', () => {
    for (const key of ['Ctrl+A', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+Shift+Z', 'Ctrl+Backspace', 'Ctrl+Delete', 'Ctrl+C', 'Ctrl+V', 'Ctrl+ArrowLeft', 'Enter', 'Shift+Enter', 'a']) {
      expect(shortcutRunsCommand(key, true), key).toBe(false);
      expect(shortcutRunsCommand(key, false), key).toBe(true);
    }
  });

  it('never registers a command on a key that edits text', () => {
    const editing = ['Ctrl+A', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+Backspace', 'Ctrl+Delete'];
    for (const command of allCommands()) {
      if (!command.shortcut) continue;
      expect(editing.map(normalizeShortcut), command.id).not.toContain(normalizeShortcut(command.shortcut));
    }
  });
});
