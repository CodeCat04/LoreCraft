/**
 * Back and Forward at the left of the top bar, and the mouse's side buttons. Both follow the
 * focused tab and pane, through the same history as View › Back and Forward.
 */

import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';

import { openContextMenu } from './ContextMenu';
import { routeNamesNow, routeTitle } from './routeTitles';
import { useNav, type Route } from '../state/nav';
import { canvases, type CanvasMeta } from '../canvas/api';
import { t } from '../lib/i18n';
import { useLocale } from '../state/language';

/** How many entries the right-click menu lists. */
export const HISTORY_MENU_SIZE = 10;
const LONG_PRESS_MS = 500;

/** `MouseEvent.button` for the side buttons, XButton1 and XButton2. */
const MOUSE_BACK = 3;
const MOUSE_FORWARD = 4;

type Direction = 'back' | 'forward';

/**
 * The entries a menu lists, nearest first, each with the offset that reaches it. Back counts
 * down from -1, Forward up from 1.
 */
export function historyEntries(direction: Direction, back: Route[], forward: Route[], limit = HISTORY_MENU_SIZE) {
  const list = direction === 'back' ? [...back].reverse() : forward;
  return list.slice(0, limit).map((route, i) => ({ route, offset: direction === 'back' ? -(i + 1) : i + 1 }));
}

function ArrowIcon({ direction }: { direction: Direction }) {
  return (
    <svg className="nav-arrow-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d={direction === 'back' ? 'M10 3 L5 8 L10 13' : 'M6 3 L11 8 L6 13'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A modal dialog has the floor, so the screen behind it must not change. */
function dialogIsOpen(): boolean {
  return !!document.querySelector('[aria-modal="true"]');
}

/** The mouse's side buttons go back and forward, and never move the window itself. */
export function useMouseNavigation() {
  useEffect(() => {
    const isSide = (e: MouseEvent) => e.button === MOUSE_BACK || e.button === MOUSE_FORWARD;
    // Without this, the web view would try to go back a page on its own.
    const stop = (e: MouseEvent) => {
      if (isSide(e)) e.preventDefault();
    };
    const onUp = (e: MouseEvent) => {
      if (!isSide(e)) return;
      e.preventDefault();
      if (dialogIsOpen()) return;
      const nav = useNav.getState();
      if (e.button === MOUSE_BACK) nav.goBack();
      else nav.goForward();
    };
    window.addEventListener('mousedown', stop, true);
    window.addEventListener('mouseup', onUp, true);
    window.addEventListener('auxclick', stop, true);
    return () => {
      window.removeEventListener('mousedown', stop, true);
      window.removeEventListener('mouseup', onUp, true);
      window.removeEventListener('auxclick', stop, true);
    };
  }, []);
}

function NavButton({ direction }: { direction: Direction }) {
  useLocale();
  const count = useNav((s) => (direction === 'back' ? s.back.length : s.forward.length));
  const pressTimer = useRef<number | null>(null);
  const pressed = useRef(false);
  const label = direction === 'back' ? t('Back') : t('Forward');
  const shortcut = direction === 'back' ? 'Alt+←' : 'Alt+→';

  const showMenu = async (x: number, y: number) => {
    const { back, forward, jump } = useNav.getState();
    const entries = historyEntries(direction, back, forward);
    if (entries.length === 0) return;
    // Canvas names are not kept anywhere in memory, so they are read only when needed.
    const canvasList: CanvasMeta[] = entries.some((e) => e.route.view === 'canvas')
      ? await canvases.list().catch(() => [])
      : [];
    openContextMenu(
      x,
      y,
      direction === 'back' ? t('Go back to') : t('Go forward to'),
      entries.map(({ route, offset }) => ({
        label: routeTitle(route, routeNamesNow(route, canvasList)),
        run: () => jump(offset),
      })),
    );
  };

  const clearPress = () => {
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  useEffect(() => clearPress, []);

  const onContextMenu = (e: ReactMouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    clearPress();
    // The menu key reports no position, so the menu opens under the button.
    const box = e.currentTarget.getBoundingClientRect();
    const fromKeyboard = e.clientX === 0 && e.clientY === 0;
    void showMenu(fromKeyboard ? box.left : e.clientX, fromKeyboard ? box.bottom : e.clientY);
  };

  // Holding the button down shows the same list, for a pen or a touch screen.
  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    pressed.current = false;
    if (e.button !== 0 || e.pointerType === 'mouse') return;
    const box = e.currentTarget.getBoundingClientRect();
    clearPress();
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null;
      pressed.current = true;
      void showMenu(box.left, box.bottom);
    }, LONG_PRESS_MS);
  };

  return (
    <button
      type="button"
      className="btn nav-arrow"
      data-testid={`nav-${direction}`}
      aria-label={label}
      title={t('{action} ({shortcut}). Right-click for recent pages.', { action: label, shortcut })}
      disabled={count === 0}
      onClick={() => {
        if (pressed.current) {
          pressed.current = false;
          return;
        }
        const nav = useNav.getState();
        if (direction === 'back') nav.goBack();
        else nav.goForward();
      }}
      onContextMenu={onContextMenu}
      onPointerDown={onPointerDown}
      onPointerUp={clearPress}
      onPointerLeave={clearPress}
      onPointerCancel={clearPress}
    >
      <ArrowIcon direction={direction} />
    </button>
  );
}

export function NavButtons() {
  useLocale();
  return (
    <div className="nav-arrows" role="group" aria-label={t('History')}>
      <NavButton direction="back" />
      <NavButton direction="forward" />
    </div>
  );
}
