/**
 * The shortcuts list. Almost all of it comes from the command registry, so a new command with
 * a shortcut appears by itself. The exception is the keys the text editor handles itself.
 */

import { t } from '../lib/i18n';
import { MENU_NAMES, type Command, type MenuName } from '../shell/commands';

export interface ShortcutRow {
  id: string;
  title: string;
  /** Each way of pressing it, as keys. `Ctrl+Shift+A` is `['Ctrl', 'Shift', 'A']`. */
  shortcuts: string[][];
}

export interface ShortcutGroup {
  name: string;
  rows: ShortcutRow[];
}

/** What the text editor does by itself, rather than through a command. Titles in the interface language. */
function editorKeys(): { id: string; title: string; shortcut: string }[] {
  return [
    { id: 'Undo', title: t('Undo'), shortcut: 'Ctrl+Z' },
    { id: 'Redo', title: t('Redo'), shortcut: 'Ctrl+Y' },
    { id: 'Bold', title: t('Bold'), shortcut: 'Ctrl+B' },
    { id: 'Italic', title: t('Italic'), shortcut: 'Ctrl+I' },
    { id: 'Underline', title: t('Underline'), shortcut: 'Ctrl+U' },
  ];
}
const OTHER_GROUP = 'Other';

/** A group's heading: its menu's name, or one of the two groups that are not menus. */
function groupLabel(name: MenuName | typeof OTHER_GROUP): string {
  switch (name) {
    case 'File':
      return t('File');
    case 'Edit':
      return t('Edit');
    case 'View':
      return t('View');
    case 'Insert':
      return t('Insert');
    case 'AI':
      return t('AI');
    case 'Tools':
      return t('Tools');
    case 'Help':
      return t('Help');
    default:
      return t('Other');
  }
}

const KEY_NAMES: Record<string, string> = {
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
};

/** Splits a shortcut into keys, including the `+` key in `Ctrl++`. */
export function shortcutKeys(shortcut: string): string[] {
  const parts = shortcut.split('+').filter(Boolean);
  if (shortcut.endsWith('+')) parts.push('+');
  return parts.map((key) => KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key));
}

/** A shortcut as words, for sentences: `Ctrl+Shift+A`. */
export function shortcutText(shortcut: string): string {
  return shortcutKeys(shortcut).join('+');
}

function compareCommands(a: Command, b: Command): number {
  return (a.order ?? 50) - (b.order ?? 50) || a.title.localeCompare(b.title);
}

function queryWords(query: string): string[] {
  return query.toLowerCase().replaceAll('+', ' ').split(/\s+/).filter(Boolean);
}

/** `Ctrl+S` or `shift ctrl s`, as opposed to words from a command's name. */
function isKeySearch(query: string): boolean {
  return /\+/.test(query.trim().slice(1)) || /^(ctrl|shift|alt)\b/i.test(query.trim());
}

/**
 * Whether a row answers a search. A search for keys looks at each shortcut's keys alone, so
 * that the `s` of `Ctrl+S` does not match every name with an s in it. Otherwise any part of
 * the row's text will do.
 */
function matches(query: string, text: string, shortcuts: string[]): boolean {
  const words = queryWords(query);
  if (!isKeySearch(query)) {
    const target = [text, ...shortcuts, ...shortcuts.map(shortcutText)].join(' ').toLowerCase();
    return words.every((word) => target.includes(word));
  }
  return shortcuts.some((shortcut) => {
    const keys = shortcutKeys(shortcut).map((key) => key.toLowerCase());
    return words.every((word) => keys.some((key) => key === word || (word.length > 1 && key.startsWith(word))));
  });
}

/**
 * Groups by menu in the menus' own order. A second shortcut for the same thing, kept out of
 * the menus, such as `Ctrl++` beside `Ctrl+=`, joins the row of the command it repeats.
 */
export function shortcutGroups(commands: Command[], query = ''): ShortcutGroup[] {
  const withKeys = commands.filter((c) => c.shortcut);
  const primaries = withKeys.filter((c) => c.menu).sort(compareCommands);
  const rows = new Map<string, { command: Command; shortcuts: string[] }>();
  for (const command of primaries) {
    const key = `${command.menu}/${command.title}`;
    const row = rows.get(key);
    if (row) row.shortcuts.push(command.shortcut!);
    else rows.set(key, { command, shortcuts: [command.shortcut!] });
  }
  const others: Command[] = [];
  for (const command of withKeys.filter((c) => !c.menu)) {
    const same = [...rows.values()].find((row) => row.command.title === command.title);
    if (same) same.shortcuts.push(command.shortcut!);
    else others.push(command);
  }

  const groups: ShortcutGroup[] = [];
  for (const menu of [...MENU_NAMES, OTHER_GROUP] as const) {
    const name = groupLabel(menu);
    const inGroup =
      menu === OTHER_GROUP
        ? others.sort(compareCommands).map((command) => ({ command, shortcuts: [command.shortcut!] }))
        : [...rows.values()].filter((row) => row.command.menu === menu);
    const shown = inGroup
      .filter(({ command, shortcuts }) => matches(query, `${command.title} ${name} ${command.keywords ?? ''}`, shortcuts))
      .map(({ command, shortcuts }) => ({
        id: command.id,
        title: command.title.replace(/…$/, ''),
        shortcuts: shortcuts.map(shortcutKeys),
      }));
    if (shown.length > 0) groups.push({ name, rows: shown });
  }

  const editorGroup = t('In the text editor');
  const editorRows = editorKeys()
    .filter((key) => matches(query, `${key.title} ${editorGroup}`, [key.shortcut]))
    .map((key) => ({
      id: `editor.${key.id}`,
      title: key.title,
      shortcuts: [shortcutKeys(key.shortcut)],
    }));
  if (editorRows.length > 0) groups.push({ name: editorGroup, rows: editorRows });
  return groups;
}
