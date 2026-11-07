/**
 * The small menu for tabs and links, and what Ctrl+click, middle-click and right-click do on
 * any link to a page. One set of listeners on the window serves every link, so a screen only
 * needs to set `data-wiki-target`, as it already does for hover cards.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';

import { useNav, type Route } from '../state/nav';
import { useTitles } from '../state/project';
import { t } from '../lib/i18n';

export interface ContextMenuItem {
  label: string;
  shortcut?: string;
  run: () => void;
}

interface Open {
  x: number;
  y: number;
  label: string;
  items: ContextMenuItem[];
  /** Where keyboard focus goes back to. */
  returnTo: HTMLElement | null;
}

const useMenu = create<{ open: Open | null }>(() => ({ open: null }));

export function openContextMenu(x: number, y: number, label: string, items: ContextMenuItem[]) {
  useMenu.setState({ open: { x, y, label, items, returnTo: document.activeElement as HTMLElement | null } });
}

function closeMenu() {
  const { open } = useMenu.getState();
  useMenu.setState({ open: null });
  open?.returnTo?.focus?.({ preventScroll: true });
}

function OpenMenu({ menu }: { menu: Open }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: menu.x, top: menu.y });

  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    // Keep the whole menu on screen.
    setPosition({
      left: Math.max(8, Math.min(menu.x, window.innerWidth - box.width - 8)),
      top: Math.max(8, Math.min(menu.y, window.innerHeight - box.height - 8)),
    });
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [menu]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeMenu();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('blur', closeMenu);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('blur', closeMenu);
    };
  }, []);

  return (
    <div
      ref={ref}
      className="menu-popup context-menu"
      role="menu"
      aria-label={menu.label}
      style={{ position: 'fixed', left: position.left, top: position.top, right: 'auto' }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          closeMenu();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
          const at = items.indexOf(document.activeElement as HTMLElement);
          items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
        }
      }}
    >
      {menu.items.map((item, index) => (
        <button
          // A history list can name one page twice.
          key={`${index}:${item.label}`}
          type="button"
          className="menu-item"
          role="menuitem"
          onClick={() => {
            closeMenu();
            item.run();
          }}
        >
          <span>{item.label}</span>
          {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
        </button>
      ))}
    </div>
  );
}

export function ContextMenuHost() {
  const open = useMenu((s) => s.open);
  return open ? <OpenMenu key={`${open.x},${open.y}`} menu={open} /> : null;
}

// ---- Links -----------------------------------------------------------------------------------

function routeForTarget(target: string): Route {
  const entry = useTitles.getState().resolve(target);
  return entry ? { view: 'page', id: entry.id } : { view: 'missing', title: target };
}

/** The same choices for a link to any screen, from its own context menu event. */
export function showRouteMenu(e: { clientX: number; clientY: number; currentTarget: Element }, route: Route, label: string) {
  // The menu key reports no position, so it opens under the link.
  const box = e.currentTarget.getBoundingClientRect();
  const fromKeyboard = e.clientX === 0 && e.clientY === 0;
  const nav = useNav.getState;
  openContextMenu(fromKeyboard ? box.left : e.clientX, fromKeyboard ? box.bottom : e.clientY, label, [
    { label: t('Open'), run: () => nav().go(route) },
    { label: t('Open in new tab'), run: () => nav().openTab(route) },
    { label: t('Open beside'), run: () => nav().openBeside(route, { keepFocus: true }) },
  ]);
}

function linkAt(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>('[data-wiki-target]') : null;
}

function targetOf(link: HTMLElement | null): string | null {
  return link?.getAttribute('data-wiki-target') || null;
}

/** Puts middle-click and right-click on every page link. Call once at startup. */
export function startLinkActions() {
  // A middle-click would otherwise start the browser's scrolling mode first.
  window.addEventListener(
    'mousedown',
    (e) => {
      if (e.button === 1 && linkAt(e.target)) e.preventDefault();
    },
    true,
  );
  window.addEventListener('auxclick', (e) => {
    const target = e.button === 1 ? targetOf(linkAt(e.target)) : null;
    if (!target) return;
    e.preventDefault();
    useNav.getState().openTab(routeForTarget(target));
  });
  // Ahead of whatever a screen does with an ordinary click on its links. Documents see to their
  // own links, because a click there also places the cursor.
  window.addEventListener(
    'click',
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return;
      const link = linkAt(e.target);
      const target = targetOf(link);
      if (!target || link?.closest('.ProseMirror')) return;
      e.preventDefault();
      e.stopPropagation();
      useNav.getState().openTab(routeForTarget(target));
    },
    true,
  );
  window.addEventListener('contextmenu', (e) => {
    // The spelling menu or a screen's own menu came first. With text selected, the ordinary
    // menu for cut and copy is what is wanted.
    if (e.defaultPrevented) return;
    const link = linkAt(e.target);
    const target = targetOf(link);
    if (!link || !target || !window.getSelection()?.isCollapsed) return;
    e.preventDefault();
    showRouteMenu(
      { clientX: e.clientX, clientY: e.clientY, currentTarget: link },
      routeForTarget(target),
      t('Open {target}', { target }),
    );
  });
}
