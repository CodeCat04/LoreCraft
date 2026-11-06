/**
 * Every user action with a name lives here, so menus, shortcuts and the palette
 * stay in agreement. Modules add theirs from `register()`.
 */

export type MenuName = 'File' | 'Edit' | 'View' | 'Insert' | 'AI' | 'Tools' | 'Help';

/** The menus, in the order the menu bar shows them. */
export const MENU_NAMES: MenuName[] = ['File', 'Edit', 'View', 'Insert', 'AI', 'Tools', 'Help'];

export interface Command {
  id: string;
  title: string;
  /** For example `Ctrl+Shift+A`. Keys use their `KeyboardEvent.key` names. */
  shortcut?: string;
  run: () => void | Promise<void>;
  /** Hidden and disabled while this returns false. */
  when?: () => boolean;
  menu?: MenuName;
  /** Menu items are sorted by this, and a new tens digit starts a new section. */
  order?: number;
  /** Set false to keep it out of the command palette. */
  palette?: boolean;
  /** Extra search words for the palette. */
  keywords?: string;
}

const commands = new Map<string, Command>();
const listeners = new Set<() => void>();
let version = 0;

export function registerCommand(command: Command) {
  commands.set(command.id, command);
  version += 1;
  listeners.forEach((l) => l());
}

export function registerCommands(list: Command[]) {
  list.forEach(registerCommand);
}

export function allCommands(): Command[] {
  return [...commands.values()];
}

export function getCommand(id: string): Command | undefined {
  return commands.get(id);
}

export function subscribeCommands(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function commandsVersion() {
  return version;
}

export function isEnabled(command: Command): boolean {
  return command.when ? command.when() : true;
}

export async function runCommand(id: string) {
  const command = commands.get(id);
  if (command && isEnabled(command)) await command.run();
}

/** Canonical form, so that `Ctrl+=` and `ctrl+=` match. */
export function normalizeShortcut(shortcut: string): string {
  const parts = shortcut.split('+').filter(Boolean);
  // `Ctrl++` splits to an empty final part.
  const key = shortcut.endsWith('+') ? '+' : (parts.pop() ?? '');
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  return [
    mods.has('ctrl') ? 'ctrl' : '',
    mods.has('shift') ? 'shift' : '',
    mods.has('alt') ? 'alt' : '',
    key.toLowerCase(),
  ]
    .filter(Boolean)
    .join('+');
}

function eventShortcut(e: KeyboardEvent): string {
  return [
    e.ctrlKey || e.metaKey ? 'ctrl' : '',
    e.shiftKey ? 'shift' : '',
    e.altKey ? 'alt' : '',
    e.key.toLowerCase(),
  ]
    .filter(Boolean)
    .join('+');
}

/** Browser shortcuts that make no sense in a desktop app. */
const BLOCKED = new Set([
  'f5', 'ctrl+r', 'ctrl+shift+r', 'ctrl+p', 'ctrl+shift+p', 'ctrl+u', 'ctrl+j', 'ctrl+h',
  'ctrl+g', 'ctrl+shift+g', 'ctrl+l', 'ctrl+t', 'ctrl+w', 'ctrl+shift+t', 'ctrl+d', 'f3', 'f7',
  'ctrl+shift+o', 'ctrl+shift+delete', 'alt+arrowleft', 'alt+arrowright',
  // Commands here, but the browser's meaning would apply while they are unavailable.
  'ctrl+n', 'ctrl+f', 'ctrl+e',
]);

/**
 * The command a shortcut runs right now. Two available commands must never share one, which
 * `commands.test.ts` checks, so the order here does not decide anything.
 */
export function commandForShortcut(shortcut: string): Command | undefined {
  const pressed = normalizeShortcut(shortcut);
  for (const command of commands.values()) {
    if (command.shortcut && normalizeShortcut(command.shortcut) === pressed && isEnabled(command)) return command;
  }
  return undefined;
}

/** Keys a text field uses to edit or move through its text, which no command may take there. */
const TEXT_EDITING = new Set([
  'ctrl+a', 'ctrl+z', 'ctrl+y', 'ctrl+shift+z', 'ctrl+x', 'ctrl+c', 'ctrl+v', 'ctrl+shift+v',
  'ctrl+backspace', 'ctrl+delete', 'ctrl+arrowleft', 'ctrl+arrowright', 'ctrl+shift+arrowleft',
  'ctrl+shift+arrowright', 'ctrl+home', 'ctrl+end', 'ctrl+shift+home', 'ctrl+shift+end',
]);

/**
 * Whether a key press may run a command. Outside text fields every shortcut can. Inside one,
 * global shortcuts with Ctrl or Alt, and function keys, still work, but keys that edit the text
 * and plain keys stay with the field.
 */
export function shortcutRunsCommand(shortcut: string, inTextField: boolean): boolean {
  if (!inTextField) return true;
  const pressed = normalizeShortcut(shortcut);
  if (TEXT_EDITING.has(pressed)) return false;
  const parts = pressed.split('+');
  const key = pressed.endsWith('+') ? '+' : parts[parts.length - 1];
  if (/^f\d{1,2}$/.test(key)) return true;
  return parts.includes('ctrl') || parts.includes('alt');
}

function isTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el?.closest) return false;
  if (el.isContentEditable || el.closest('textarea, [contenteditable="true"], .ProseMirror')) return true;
  if (!(el instanceof HTMLInputElement)) return false;
  return !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image'].includes(el.type);
}

/** Routes key presses to commands. Call once at startup. */
export function startShortcuts() {
  window.addEventListener('keydown', (e) => {
    // Ctrl+U is underline when typing in the editor, not "view source".
    const inEditor = (e.target as HTMLElement | null)?.closest?.('.ProseMirror');
    const pressed = eventShortcut(e);
    if (!shortcutRunsCommand(pressed, isTextField(e.target))) return;
    const command = commandForShortcut(pressed);
    if (command) {
      e.preventDefault();
      e.stopPropagation();
      void command.run();
      return;
    }
    if (BLOCKED.has(pressed) && !(inEditor && pressed === 'ctrl+u')) e.preventDefault();
  });
}

/** Keeps the browser's page menu away, but leaves cut, copy and paste in text fields. */
export function startContextMenuGuard() {
  window.addEventListener('contextmenu', (e) => {
    const target = e.target as HTMLElement | null;
    if (!target?.closest?.('input, textarea, [contenteditable="true"]')) e.preventDefault();
  });
}
