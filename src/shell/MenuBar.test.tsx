import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: () => new Promise(() => {}) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }));

import { registerCommands } from './commands';
import { MenuBar } from './MenuBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ran: string[] = [];

registerCommands([
  { id: 'test.new', title: 'New page', menu: 'File', order: 1, run: () => void ran.push('new') },
  { id: 'test.save', title: 'Save', menu: 'File', order: 2, run: () => void ran.push('save') },
  { id: 'test.off', title: 'Not now', menu: 'File', order: 3, when: () => false, run: () => void ran.push('off') },
  { id: 'test.undo', title: 'Undo', menu: 'Edit', order: 1, run: () => void ran.push('undo') },
  { id: 'test.find', title: 'Find', menu: 'Edit', order: 2, run: () => void ran.push('find') },
]);

const active = () => document.activeElement as HTMLElement;
const label = () => active().textContent;

function key(key: string, type: 'keydown' | 'keyup' = 'keydown', init: KeyboardEventInit = {}) {
  act(() => {
    active().dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...init }));
  });
}

/** Pressing and letting go of a key, as a person does. */
function press(name: string) {
  key(name);
  key(name, 'keyup');
}

describe('menu bar from the keyboard', () => {
  let root: Root;
  let host: HTMLDivElement;
  let writing: HTMLTextAreaElement;

  beforeEach(() => {
    ran.length = 0;
    host = document.createElement('div');
    writing = document.createElement('textarea');
    document.body.append(writing, host);
    root = createRoot(host);
    act(() => root.render(<MenuBar />));
    writing.focus();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    writing.remove();
  });

  it('takes focus with Alt on its own, and gives it back with Escape', () => {
    press('Alt');
    expect(active().getAttribute('role')).toBe('menuitem');
    expect(label()).toBe('File');
    press('Escape');
    expect(active()).toBe(writing);
  });

  it('does not take focus for Alt held with another key', () => {
    key('Alt');
    key('a', 'keydown', { altKey: true });
    key('a', 'keyup', { altKey: true });
    key('Alt', 'keyup');
    expect(active()).toBe(writing);
  });

  it('moves between and within menus with the arrow keys, and Enter runs an item', () => {
    press('F10');
    expect(label()).toBe('File');
    press('ArrowRight');
    expect(label()).toBe('Edit');
    press('ArrowRight');
    expect(label()).toBe('File');

    press('ArrowDown');
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(label()).toContain('New page');
    press('ArrowDown');
    expect(label()).toContain('Save');
    // An item that is not available is passed over.
    press('ArrowDown');
    expect(label()).toContain('New page');
    press('ArrowUp');
    expect(label()).toContain('Save');

    // Right goes to the next menu, open.
    press('ArrowRight');
    expect(label()).toContain('Undo');
    press('ArrowLeft');
    expect(label()).toContain('New page');

    // Enter on a button clicks it, with no pointer.
    act(() => {
      (active() as HTMLButtonElement).click();
    });
    expect(ran).toEqual(['new']);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(active()).toBe(writing);
  });

  it('closes the menu with Escape, then gives focus back with another', () => {
    press('F10');
    press('ArrowRight');
    press('Enter');
    expect(label()).toContain('Undo');
    press('Escape');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(label()).toBe('Edit');
    press('Escape');
    expect(active()).toBe(writing);
    expect(ran).toEqual([]);
  });
});
