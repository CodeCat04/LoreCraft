/**
 * The right-click menu on a misspelled word. Plain DOM rather than React, because it
 * belongs to a ProseMirror plugin and has no place in the component tree.
 */

import type { EditorView } from '@tiptap/pm/view';

import { errorMessage } from '../../lib/rpc';
import { toast } from '../../shell/toasts';
import { t } from '../../lib/i18n';
import { spellClient } from './client';

export interface MisspelledWord {
  from: number;
  to: number;
  word: string;
}

let closeOpenMenu: (() => void) | null = null;

export function closeSpellMenu() {
  closeOpenMenu?.();
}

function item(label: string, onChoose: () => void, className = ''): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `menu-item ${className}`.trim();
  button.setAttribute('role', 'menuitem');
  button.textContent = label;
  // Keeps the editor's selection, and stops the outside-click check from closing early.
  button.addEventListener('mousedown', (e) => e.preventDefault());
  button.addEventListener('click', onChoose);
  return button;
}

function separator(): HTMLElement {
  const line = document.createElement('div');
  line.className = 'menu-sep';
  return line;
}

export function openSpellMenu(view: EditorView, target: MisspelledWord, x: number, y: number) {
  closeSpellMenu();

  const menu = document.createElement('div');
  menu.className = 'menu-popup spell-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', t('Spelling of {word}', { word: target.word }));
  menu.dataset.testid = 'spell-menu';

  const close = (refocus = true) => {
    if (closeOpenMenu !== closeThis) return;
    closeOpenMenu = null;
    menu.remove();
    window.removeEventListener('mousedown', onOutside, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('resize', onBlur);
    window.removeEventListener('scroll', onBlur, true);
    if (refocus && !view.isDestroyed) view.focus();
  };
  const closeThis = () => close(false);

  const place = () => {
    const rect = menu.getBoundingClientRect();
    const margin = 8;
    menu.style.left = `${Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin))}px`;
    menu.style.top = `${Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin))}px`;
  };

  const replaceWith = (text: string) => {
    close();
    if (view.isDestroyed) return;
    // The document can only have moved on if something else edited it while the menu
    // was open, in which case these positions no longer mean this word.
    const { doc } = view.state;
    if (target.to > doc.content.size || doc.textBetween(target.from, target.to) !== target.word) return;
    view.dispatch(view.state.tr.insertText(text, target.from, target.to).scrollIntoView());
  };

  const status = document.createElement('div');
  status.className = 'menu-label';
  status.textContent = t('Looking for suggestions…');
  const suggestionList = document.createElement('div');
  suggestionList.append(status);

  const addButton = item(t('Add "{word}" to dictionary', { word: target.word }), () => {
    close();
    spellClient.addWord(target.word).catch((e) => {
      toast(t('Could not add the word: {error}', { error: errorMessage(e) }), 'error');
    });
  });
  const ignoreButton = item(t('Ignore in this session'), () => {
    close();
    spellClient.ignoreWord(target.word);
  });
  menu.append(suggestionList, separator(), addButton, ignoreButton);

  const items = () => [...menu.querySelectorAll<HTMLButtonElement>('button')];
  let usedKeyboard = false;

  const onOutside = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) close(false);
  };
  const onBlur = () => close(false);
  const onKey = (e: KeyboardEvent) => {
    usedKeyboard = true;
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    if (e.key === 'Escape') {
      close();
    } else if (e.key === 'ArrowDown') {
      next = list[(at + 1) % list.length];
    } else if (e.key === 'ArrowUp') {
      next = list[(at - 1 + list.length) % list.length];
    } else if (e.key === 'Home') {
      next = list[0];
    } else if (e.key === 'End') {
      next = list[list.length - 1];
    } else if (e.key === 'Tab') {
      close();
    } else if (e.key === 'Enter' || e.key === ' ') {
      return;
    } else {
      // Typing goes back to the document, as in a native menu.
      close();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    next?.focus();
  };

  closeOpenMenu = closeThis;
  document.body.append(menu);
  place();
  addButton.focus();
  window.addEventListener('mousedown', onOutside, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', onBlur);
  window.addEventListener('resize', onBlur);
  // Any scroll moves the word away from the menu. Scroll events do not bubble, hence capture.
  window.addEventListener('scroll', onBlur, true);

  void spellClient.suggest(target.word).then((suggestions) => {
    if (closeOpenMenu !== closeThis) return;
    suggestionList.replaceChildren();
    if (suggestions.length === 0) {
      status.textContent = t('No suggestions');
      suggestionList.append(status);
    } else {
      for (const suggestion of suggestions) {
        suggestionList.append(item(suggestion, () => replaceWith(suggestion), 'spell-suggestion'));
      }
      // Focus moves to the best fix, unless someone has already moved on from where it began.
      if (!usedKeyboard && document.activeElement === addButton) items()[0]?.focus();
    }
    place();
  });
}
