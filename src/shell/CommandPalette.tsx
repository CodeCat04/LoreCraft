import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { allCommands, isEnabled } from './commands';
import { useUi } from '../state/ui';
import { useTitles } from '../state/project';
import { useNav } from '../state/nav';
import { titleKey } from '../lib/text';
import { t } from '../lib/i18n';
import { useLocale } from '../state/language';
import { rpc } from '../lib/rpc';
import { useDataVersion } from '../state/events';

/** Every scene in reading order, labeled with its book and chapter. */
const sceneOptions = () => rpc<{ id: string; label: string }[]>('pages.sceneOptions');

interface Item {
  key: string;
  label: string;
  hint?: string;
  group: string;
  run: () => void;
}

function matches(query: string, haystack: string): boolean {
  const q = query.toLowerCase().trim();
  if (!q) return true;
  const text = haystack.toLowerCase();
  return q.split(/\s+/).every((word) => text.includes(word));
}

/** Ctrl+K: jump to any page or scene, or run any command. */
export function CommandPalette() {
  const locale = useLocale();
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPaletteOpen);
  const titles = useTitles((s) => s.entries);
  const [query, setQuery] = useState('');
  const [scenes, setScenes] = useState<{ id: string; label: string }[]>([]);
  const sceneVersion = useDataVersion('books', 'nodes');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** Where the pointer was last seen over the list, so only real movement picks a row. */
  const pointer = useRef<{ x: number; y: number } | null>(null);
  /** Where the keyboard was before the palette opened, to go back to when it closes. */
  const returnFocus = useRef<HTMLElement | null>(null);

  // Before the browser handles anything else, so what is typed straight after Ctrl+K is
  // never cleared. A passive effect can run late on a busy machine, after the typing.
  useLayoutEffect(() => {
    if (open) {
      const active = document.activeElement;
      returnFocus.current = active instanceof HTMLElement && active !== document.body ? active : null;
      setQuery('');
      setIndex(0);
      pointer.current = null;
      inputRef.current?.focus();
    } else {
      // A command that moved the keyboard somewhere on purpose keeps it there.
      const back = returnFocus.current;
      returnFocus.current = null;
      const active = document.activeElement;
      if (back?.isConnected && (!active || active === document.body)) back.focus({ preventScroll: true });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    sceneOptions().then(
      (list) => live && setScenes(list),
      () => live && setScenes([]),
    );
    return () => {
      live = false;
    };
  }, [open, sceneVersion]);

  // The list comes up and filters under a pointer that may be resting there, and the browser
  // reports that as the pointer moving onto a row. Only a pointer that really moved picks one,
  // so Enter runs the match the keyboard is on.
  const pointerMoved = (e: React.MouseEvent, row: number) => {
    const last = pointer.current;
    pointer.current = { x: e.clientX, y: e.clientY };
    if (last && (last.x !== e.clientX || last.y !== e.clientY)) setIndex(row);
  };

  const items = useMemo<Item[]>(() => {
    if (!open) return [];
    const pages: Item[] = titles
      .filter((entry) => matches(query, `${entry.title} ${entry.aliases.join(' ')}`))
      .sort((a, b) => {
        // Titles that start with the query come first.
        const q = titleKey(query);
        return Number(titleKey(b.title).startsWith(q)) - Number(titleKey(a.title).startsWith(q));
      })
      .slice(0, 12)
      .map((entry) => ({
        key: `page:${entry.id}`,
        label: entry.title,
        hint: entry.pageType === 'article' ? undefined : entry.pageType,
        group: t('Pages'),
        run: () => useNav.getState().go({ view: 'page', id: entry.id }),
      }));
    // Scenes only once something is typed, since a whole series would bury the commands.
    const sceneItems: Item[] = !query.trim()
      ? []
      : scenes
          .filter((scene) => matches(query, scene.label))
          .slice(0, 12)
          .map((scene) => ({
            key: `scene:${scene.id}`,
            label: scene.label,
            group: t('Scenes'),
            run: () => useNav.getState().go({ view: 'write', nodeId: scene.id }),
          }));
    const commands: Item[] = allCommands()
      .filter((c) => c.palette !== false && isEnabled(c))
      .filter((c) => matches(query, `${c.title} ${c.keywords ?? ''} ${c.menu ?? ''}`))
      .slice(0, 30)
      .map((c) => ({
        key: `cmd:${c.id}`,
        label: c.title,
        hint: c.shortcut,
        group: t('Commands'),
        run: () => void c.run(),
      }));
    // With no query, commands are the more useful starting list.
    return query.trim() ? [...pages, ...sceneItems, ...commands] : [...commands, ...pages];
  }, [open, query, titles, scenes, locale]);

  useEffect(() => setIndex(0), [query]);

  useEffect(() => {
    listRef.current?.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  if (!open) return null;

  const close = () => setOpen(false);
  const runItem = (item: Item | undefined) => {
    if (!item) return;
    close();
    item.run();
  };

  return (
    <div className="dialog-backdrop palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label={t('Command palette')}>
        <input
          role="combobox"
          aria-label={t('Search pages and commands')}
          aria-expanded={items.length > 0}
          aria-controls="palette-list"
          aria-autocomplete="list"
          aria-activedescendant={items[index] ? `palette-option-${index}` : undefined}
          ref={inputRef}
          className="palette-input"
          placeholder={t('Search pages and commands…')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              close();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.min(items.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              runItem(items[index]);
            }
          }}
        />
        <div className="palette-list" id="palette-list" ref={listRef} role="listbox" aria-label={t('Pages and commands')}>
          {items.length === 0 && <div className="palette-empty" role="status">{t('Nothing matches.')}</div>}
          {items.map((item, i) => (
            <div key={item.key} role="presentation">
              {(i === 0 || items[i - 1].group !== item.group) && (
                <div className="palette-group" role="presentation" aria-hidden="true">{item.group}</div>
              )}
              <button
                type="button"
                id={`palette-option-${i}`}
                tabIndex={-1}
                role="option"
                aria-selected={i === index}
                className={`palette-item${i === index ? ' is-selected' : ''}`}
                onMouseMove={(e) => pointerMoved(e, i)}
                onClick={() => runItem(item)}
              >
                <span>{item.label}</span>
                {item.hint && <span className="menu-shortcut">{item.hint}</span>}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
