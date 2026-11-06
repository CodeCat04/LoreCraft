import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { t } from '../../lib/i18n';
import { titleKey } from '../../lib/text';
import type { TitleEntry } from '../../lib/types';
import { useLocale } from '../../state/language';
import { useTitles } from '../../state/project';

const MAX_OPTIONS = 8;

/** Pages whose title or alias holds the text, with those that start with it first. */
export function matchTitles(entries: TitleEntry[], text: string, excludeId?: string): TitleEntry[] {
  const key = titleKey(text);
  if (!key) return [];
  const leading: TitleEntry[] = [];
  const inner: TitleEntry[] = [];
  for (const entry of entries) {
    if (entry.id === excludeId) continue;
    const names = [entry.title, ...entry.aliases].map(titleKey);
    if (names.some((name) => name.startsWith(key))) leading.push(entry);
    else if (names.some((name) => name.includes(key))) inner.push(entry);
    if (leading.length >= MAX_OPTIONS) break;
  }
  return [...leading, ...inner].slice(0, MAX_OPTIONS);
}

interface Props {
  value: string;
  onChange: (text: string) => void;
  onPick: (entry: TitleEntry) => void;
  label: string;
  placeholder?: string;
  autoFocus?: boolean;
  excludeId?: string;
  /** Enter was pressed with no option highlighted. */
  onEnter?: (text: string) => void;
  onEscape?: () => void;
}

/** A text box that offers page titles as you type. */
export function PageAutocomplete(props: Props) {
  useLocale();
  const { value, onChange, onPick, label, placeholder, autoFocus, excludeId, onEnter, onEscape } = props;
  const entries = useTitles((s) => s.entries);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [box, setBox] = useState<{ left: number; top: number; width: number } | null>(null);
  const options = useMemo(() => matchTitles(entries, value, excludeId), [entries, value, excludeId]);
  const showing = open && options.length > 0;

  // Fixed, because dialogs and map overlays would clip an absolute popup.
  useLayoutEffect(() => {
    if (!showing || !input.current) return;
    const rect = input.current.getBoundingClientRect();
    setBox({ left: rect.left, top: rect.bottom + 2, width: rect.width });
  }, [showing, value]);

  const pick = (entry: TitleEntry) => {
    onPick(entry);
    setOpen(false);
    setHighlight(-1);
  };

  return (
    <div className="autocomplete">
      <input
        ref={input}
        className="input"
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={showing}
        aria-controls={listId}
        aria-activedescendant={showing && highlight >= 0 ? `${listId}-${highlight}` : undefined}
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setHighlight(-1);
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && options.length > 0) {
            e.preventDefault();
            setOpen(true);
            setHighlight((h) => (h + 1) % options.length);
          } else if (e.key === 'ArrowUp' && options.length > 0) {
            e.preventDefault();
            setOpen(true);
            setHighlight((h) => (h <= 0 ? options.length - 1 : h - 1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (showing && highlight >= 0) pick(options[highlight]);
            else onEnter?.(value);
          } else if (e.key === 'Escape') {
            if (showing) {
              // The first Escape closes the list and leaves any surrounding form open.
              e.stopPropagation();
              e.nativeEvent.stopImmediatePropagation();
              setOpen(false);
            } else {
              onEscape?.();
            }
          }
        }}
      />
      <div
        id={listId}
        className="autocomplete-popup"
        role="listbox"
        aria-label={t('{label}: suggestions', { label })}
        hidden={!showing}
        style={box ?? undefined}
      >
        {showing &&
          options.map((entry, index) => (
            <button
              key={entry.id}
              id={`${listId}-${index}`}
              type="button"
              tabIndex={-1}
              role="option"
              aria-selected={index === highlight}
              className={`menu-item${index === highlight ? ' is-highlighted' : ''}`}
              // Keeps focus in the text box, so the list does not close before the click lands.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => pick(entry)}
            >
              <span className="truncate">{entry.title}</span>
              {entry.pageType !== 'article' && <span className="menu-shortcut">{entry.pageType}</span>}
            </button>
          ))}
      </div>
    </div>
  );
}
