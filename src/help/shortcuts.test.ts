import { describe, expect, it } from 'vitest';

import type { Command } from '../shell/commands';
import { shortcutGroups, shortcutKeys, shortcutText } from './shortcuts';

function command(id: string, title: string, shortcut?: string, extra: Partial<Command> = {}): Command {
  return { id, title, shortcut, run: () => {}, ...extra };
}

const COMMANDS: Command[] = [
  command('file.save', 'Save', 'Ctrl+S', { menu: 'File', order: 20 }),
  command('file.saveAs', 'Save as…', 'Ctrl+Shift+S', { menu: 'File', order: 21 }),
  command('file.close', 'Close project', undefined, { menu: 'File', order: 30 }),
  command('view.bigger', 'Larger writing text', 'Ctrl+=', { menu: 'View', order: 30 }),
  command('view.bigger2', 'Larger writing text', 'Ctrl++', { palette: false }),
  command('view.back', 'Back', 'Alt+ArrowLeft', { menu: 'View', order: 10, keywords: 'history previous' }),
  command('help.shortcuts', 'Keyboard shortcuts', 'F1', { menu: 'Help' }),
  command('wiki.focus', 'Jump to search', 'Ctrl+L'),
];

function names(groups: ReturnType<typeof shortcutGroups>) {
  return groups.map((g) => g.name);
}

function rowsOf(groups: ReturnType<typeof shortcutGroups>, name: string) {
  return groups.find((g) => g.name === name)?.rows ?? [];
}

describe('shortcuts list', () => {
  it('splits keys, including the plus key, and uses plain names', () => {
    expect(shortcutKeys('Ctrl+Shift+A')).toEqual(['Ctrl', 'Shift', 'A']);
    expect(shortcutKeys('Ctrl++')).toEqual(['Ctrl', '+']);
    expect(shortcutKeys('Ctrl+=')).toEqual(['Ctrl', '=']);
    expect(shortcutKeys('Alt+ArrowLeft')).toEqual(['Alt', 'Left']);
    expect(shortcutKeys('Ctrl+,')).toEqual(['Ctrl', ',']);
    expect(shortcutKeys('F1')).toEqual(['F1']);
    expect(shortcutKeys('Ctrl+s')).toEqual(['Ctrl', 'S']);
    expect(shortcutText('Ctrl+Alt+ArrowUp')).toBe('Ctrl+Alt+Up');
  });

  it('groups by menu in menu order, and leaves out commands without a shortcut', () => {
    const groups = shortcutGroups(COMMANDS);
    expect(names(groups)).toEqual(['File', 'View', 'Help', 'Other', 'In the text editor']);
    expect(rowsOf(groups, 'File').map((r) => r.title)).toEqual(['Save', 'Save as']);
  });

  it('keeps menu order within a group', () => {
    expect(rowsOf(shortcutGroups(COMMANDS), 'View').map((r) => r.title)).toEqual(['Back', 'Larger writing text']);
  });

  it('joins a second shortcut to the command it repeats', () => {
    const row = rowsOf(shortcutGroups(COMMANDS), 'View').find((r) => r.title === 'Larger writing text');
    expect(row?.shortcuts).toEqual([['Ctrl', '='], ['Ctrl', '+']]);
    expect(rowsOf(shortcutGroups(COMMANDS), 'Other').map((r) => r.title)).toEqual(['Jump to search']);
  });

  it('finds a new command without being told about it', () => {
    const more = [...COMMANDS, command('new.thing', 'Brand new thing', 'Ctrl+Alt+Q', { menu: 'Tools' })];
    expect(rowsOf(shortcutGroups(more), 'Tools').map((r) => r.title)).toEqual(['Brand new thing']);
  });

  it('searches titles, keys, menus and keywords, ignoring case and word order', () => {
    const titles = (q: string) => shortcutGroups(COMMANDS, q).flatMap((g) => g.rows.map((r) => r.title));
    expect(titles('save')).toEqual(['Save', 'Save as']);
    expect(titles('SAVE AS')).toEqual(['Save as']);
    expect(titles('ctrl+shift+s')).toEqual(['Save as']);
    expect(titles('shift ctrl s')).toEqual(['Save as']);
    expect(titles('Ctrl+S')).toEqual(['Save', 'Save as']);
    expect(titles('ctrl+sh')).toEqual(['Save as']);
    expect(titles('alt+left')).toEqual(['Back']);
    expect(titles('f1')).toEqual(['Keyboard shortcuts']);
    expect(titles('help')).toEqual(['Keyboard shortcuts']);
    expect(titles('history')).toEqual(['Back']);
    expect(titles('left')).toEqual(['Back']);
    expect(titles('bold')).toEqual(['Bold']);
    expect(titles('no such thing')).toEqual([]);
    expect(names(shortcutGroups(COMMANDS, 'no such thing'))).toEqual([]);
  });

  it('does not mistake one group for another when two commands share a title', () => {
    const same = [
      command('a', 'Find', 'Ctrl+F', { menu: 'Edit' }),
      command('b', 'Find', 'Ctrl+Shift+F', { menu: 'Tools' }),
    ];
    const groups = shortcutGroups(same);
    expect(rowsOf(groups, 'Edit')[0].shortcuts).toEqual([['Ctrl', 'F']]);
    expect(rowsOf(groups, 'Tools')[0].shortcuts).toEqual([['Ctrl', 'Shift', 'F']]);
  });
});
