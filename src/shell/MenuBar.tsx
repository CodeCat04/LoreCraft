/**
 * The menu bar, which follows the WAI-ARIA menubar pattern. Alt or F10 moves focus to it, the
 * arrow keys move between and within menus, Enter or Space opens a menu or runs an item, and
 * Escape closes the menu, then gives focus back to where it was.
 */

import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import {
  allCommands,
  commandsVersion,
  isEnabled,
  MENU_NAMES,
  subscribeCommands,
  type Command,
  type MenuName,
} from './commands';
import { openProject } from './fileActions';
import { t } from '../lib/i18n';
import { useLocale } from '../state/language';
import { useSettings } from '../state/settings';

function menuLabel(menu: MenuName): string {
  switch (menu) {
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
  }
}

function shortName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function itemsFor(menu: MenuName): Command[] {
  return allCommands()
    .filter((c) => c.menu === menu)
    .sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
}

export function MenuBar() {
  useLocale();
  const [open, setOpen] = useState<MenuName | null>(null);
  // Which item of a menu opened from the keyboard takes focus once it is on screen.
  const [focusItem, setFocusItem] = useState<'first' | 'last' | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const titles = useRef(new Map<MenuName, HTMLButtonElement>());
  // Where focus was before it came to the menu bar, to give it back.
  const returnTo = useRef<HTMLElement | null>(null);
  const openedByKey = useRef(false);
  useSyncExternalStore(subscribeCommands, commandsVersion);
  const recent = useSettings((s) => s.settings.recent);
  const menus = MENU_NAMES.filter((menu) => itemsFor(menu).length > 0);

  const giveFocusBack = () => {
    const back = returnTo.current;
    returnTo.current = null;
    if (back?.isConnected) back.focus();
    else if (ref.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  };

  const openMenu = (menu: MenuName, which: 'first' | 'last' | null) => {
    setOpen(menu);
    setFocusItem(which);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      // A menu opened with the mouse, while focus is somewhere else.
      if (e.key === 'Escape' && !ref.current?.contains(document.activeElement)) setOpen(null);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !focusItem) return;
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('.menu-popup [role="menuitem"]:not(:disabled)') ?? [])];
    (focusItem === 'first' ? items[0] : items[items.length - 1])?.focus();
    setFocusItem(null);
  }, [open, focusItem]);

  // Alt on its own, pressed and let go, or F10, moves focus to the menu bar and back.
  useEffect(() => {
    let altAlone = false;
    const toggle = () => {
      if (document.querySelector('[role="dialog"]')) return;
      if (ref.current?.contains(document.activeElement)) {
        setOpen(null);
        giveFocusBack();
        return;
      }
      const first = ref.current?.querySelector<HTMLButtonElement>('.menu-title');
      first?.focus();
    };
    const onDown = (e: KeyboardEvent) => {
      if (e.key === 'Alt') {
        altAlone = !e.repeat && !e.ctrlKey && !e.shiftKey && !e.metaKey;
        return;
      }
      altAlone = false;
      if (e.key === 'F10' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        e.preventDefault();
        toggle();
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt' && altAlone) {
        e.preventDefault();
        toggle();
      }
      altAlone = false;
    };
    const reset = () => {
      altAlone = false;
    };
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    window.addEventListener('mousedown', reset, true);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
      window.removeEventListener('mousedown', reset, true);
      window.removeEventListener('blur', reset);
    };
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const menu = target.closest<HTMLElement>('[data-menu]')?.dataset.menu as MenuName | undefined;
    if (!menu) return;
    const inPopup = !!target.closest('.menu-popup');
    const neighbour = (step: number) => menus[(menus.indexOf(menu) + step + menus.length) % menus.length];
    const items = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>('.menu-popup [role="menuitem"]:not(:disabled)') ?? [])];
    const moveWithin = (step: number) => {
      const list = items();
      const index = list.indexOf(target as HTMLButtonElement);
      list[(index + step + list.length) % list.length]?.focus();
    };
    let handled = true;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowLeft': {
        // With a menu open, the next one opens in its place.
        const next = neighbour(e.key === 'ArrowRight' ? 1 : -1);
        if (open) openMenu(next, 'first');
        else titles.current.get(next)?.focus();
        break;
      }
      case 'ArrowDown':
        if (inPopup) moveWithin(1);
        else openMenu(menu, 'first');
        break;
      case 'ArrowUp':
        if (inPopup) moveWithin(-1);
        else openMenu(menu, 'last');
        break;
      case 'Home':
      case 'End':
        if (inPopup) {
          const list = items();
          (e.key === 'Home' ? list[0] : list[list.length - 1])?.focus();
        } else {
          titles.current.get(e.key === 'Home' ? menus[0] : menus[menus.length - 1])?.focus();
        }
        break;
      case 'Enter':
      case ' ':
        // On an item, the button's own click runs it.
        if (inPopup) handled = false;
        else {
          openedByKey.current = true;
          window.setTimeout(() => (openedByKey.current = false), 0);
          openMenu(menu, 'first');
        }
        break;
      case 'Escape':
        if (open) {
          setOpen(null);
          titles.current.get(menu)?.focus();
        } else {
          giveFocusBack();
        }
        break;
      case 'Tab':
        setOpen(null);
        returnTo.current = null;
        handled = false;
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  /** Runs an item. From the keyboard, focus goes back first, so the command acts where it was. */
  const activate = (e: { detail: number }, run: () => void) => {
    setOpen(null);
    if (e.detail === 0) giveFocusBack();
    else returnTo.current = null;
    run();
  };

  return (
    <div
      className="menubar"
      ref={ref}
      role="menubar"
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        const from = e.relatedTarget as HTMLElement | null;
        if (from && !ref.current?.contains(from)) returnTo.current = from;
      }}
    >
      {menus.map((menu) => {
        const items = itemsFor(menu);
        return (
          <div key={menu} className="menu" data-menu={menu}>
            <button
              ref={(el) => {
                if (el) titles.current.set(menu, el);
                else titles.current.delete(menu);
              }}
              type="button"
              className={`menu-title${open === menu ? ' is-open' : ''}`}
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={open === menu}
              onClick={(e) => {
                // Enter and Space already opened it.
                if (openedByKey.current) return;
                if (open === menu) setOpen(null);
                // A click with no pointer, as from a screen reader, also moves into the menu.
                else openMenu(menu, e.detail === 0 ? 'first' : null);
              }}
              onMouseEnter={() => open && setOpen(menu)}
            >
              {menuLabel(menu)}
            </button>
            {open === menu && (
              <div className="menu-popup" role="menu" aria-label={menuLabel(menu)}>
                {items.map((item, i) => {
                  const section = Math.floor((item.order ?? 50) / 10);
                  const previous = items[i - 1];
                  const newSection = previous && Math.floor((previous.order ?? 50) / 10) !== section;
                  return (
                    <div key={item.id} role="none">
                      {newSection && <div className="menu-sep" role="separator" />}
                      <button
                        type="button"
                        className="menu-item"
                        role="menuitem"
                        tabIndex={-1}
                        disabled={!isEnabled(item)}
                        onClick={(e) => activate(e, () => void item.run())}
                      >
                        <span>{item.title}</span>
                        {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
                      </button>
                    </div>
                  );
                })}
                {menu === 'File' && recent.length > 0 && (
                  <>
                    <div className="menu-sep" role="separator" />
                    <div className="menu-label" role="presentation">{t('Recent')}</div>
                    {recent.slice(0, 8).map((file) => (
                      <button
                        key={file.path}
                        type="button"
                        className="menu-item"
                        role="menuitem"
                        tabIndex={-1}
                        title={file.path}
                        onClick={(e) => activate(e, () => void openProject(file.path))}
                      >
                        <span>{shortName(file.path)}</span>
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
