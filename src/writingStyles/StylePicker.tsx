/** Choosing one style from the whole library: a search box over a list, and a dropdown of it. */

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom';

import { t } from '../lib/i18n';
import { useLocale } from '../state/language';
import { useSettings } from '../state/settings';
import { searchStyles } from './library';
import { getStyle, listStyles } from './store';
import { genreLabel, type WritingStyle } from './types';

function kindHint(style: WritingStyle): string {
  if (style.kind === 'custom') return t('Mine');
  if (style.kind === 'technique') return t('Technique');
  return style.genres.slice(0, 2).map(genreLabel).join(', ');
}

/** A search box with a list under it. Arrow keys move, and Enter chooses. */
export function StyleSearchList(props: {
  value: string | null;
  onChoose: (styleId: string | null) => void;
  /** Adds a first choice for having no style of its own, with this label. */
  noneLabel?: string;
  autoFocus?: boolean;
  label?: string;
}) {
  useLocale();
  const custom = useSettings((s) => s.settings.writingStyles.custom);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const all = useMemo(() => listStyles(), [custom]);
  const matches = useMemo(() => searchStyles(all, query), [all, query]);
  const offerNone = props.noneLabel !== undefined && !query.trim();
  const count = matches.length + (offerNone ? 1 : 0);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (index: number) => {
    if (offerNone && index === 0) props.onChoose(null);
    else {
      const style = matches[index - (offerNone ? 1 : 0)];
      if (style) props.onChoose(style.id);
    }
  };

  const optionId = (index: number) => `${listId}-${index}`;

  return (
    <div className="style-search">
      <input
        className="input"
        type="search"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={count > 0 ? optionId(active) : undefined}
        aria-label={props.label ?? t('Search styles')}
        placeholder={t('Search by name, genre or trait')}
        autoFocus={props.autoFocus}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && count > 0) {
            e.preventDefault();
            setActive((i) => (i + 1) % count);
          } else if (e.key === 'ArrowUp' && count > 0) {
            e.preventDefault();
            setActive((i) => (i - 1 + count) % count);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            choose(active);
          }
        }}
      />
      <div className="style-search-list" id={listId} ref={listRef} role="listbox" aria-label={t('Styles')}>
        {offerNone && (
          <button
            type="button"
            id={optionId(0)}
            role="option"
            tabIndex={-1}
            aria-selected={active === 0}
            className={`menu-item${active === 0 ? ' is-active' : ''}`}
            onMouseEnter={() => setActive(0)}
            onClick={() => choose(0)}
          >
            <span>{props.noneLabel}</span>
          </button>
        )}
        {matches.map((style, i) => {
          const index = i + (offerNone ? 1 : 0);
          return (
            <button
              key={style.id}
              type="button"
              id={optionId(index)}
              role="option"
              tabIndex={-1}
              aria-selected={active === index}
              aria-current={style.id === props.value ? 'true' : undefined}
              className={`menu-item${active === index ? ' is-active' : ''}${style.id === props.value ? ' style-search-current' : ''}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(index)}
            >
              <span className="truncate">{style.name}</span>
              <span className="menu-shortcut truncate">{kindHint(style)}</span>
            </button>
          );
        })}
        {count === 0 && <p className="muted small style-search-empty">{t('No style matches that. Try a shorter search.')}</p>}
      </div>
    </div>
  );
}

/**
 * A searchable dropdown for choosing a style. Other modules embed this.
 * `value` is a style id, or null for none, which shows `noneLabel`.
 */
export function StylePicker(props: {
  value: string | null;
  onChange: (styleId: string | null) => void;
  /** Shown when nothing is chosen, and offered as a choice that clears it. */
  noneLabel?: string;
  /** Names a chosen style that is not in the library or this person's own styles. */
  fallbackName?: string | null;
  disabled?: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const locale = useLocale();
  const noneLabel = props.noneLabel ?? t('No style');
  const custom = useSettings((s) => s.settings.writingStyles.custom);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const name = useMemo(() => (props.value ? getStyle(props.value)?.name ?? props.fallbackName ?? t('Style not on this computer') : noneLabel), [props.value, props.fallbackName, noneLabel, custom, locale]);

  useLayoutEffect(() => {
    const button = buttonRef.current;
    const popup = popupRef.current;
    if (!open || !button || !popup) return undefined;
    return autoUpdate(button, popup, () => {
      void computePosition(button, popup, {
        placement: 'bottom-start',
        strategy: 'fixed',
        middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
      }).then(({ x, y }) => {
        popup.style.left = `${x}px`;
        popup.style.top = `${y}px`;
      });
    });
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!popupRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="select style-picker-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('{label}: {name}', { label: props.label ?? t('Writing style'), name })}
        disabled={props.disabled}
        onClick={() => setOpen(!open)}
      >
        <span className="truncate">{name}</span>
        <span aria-hidden="true" className="faint">▾</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={popupRef}
            className="style-picker-popup"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
                buttonRef.current?.focus();
              }
            }}
          >
            <StyleSearchList
              autoFocus
              value={props.value}
              noneLabel={noneLabel}
              label={props.label}
              onChoose={(id) => {
                setOpen(false);
                buttonRef.current?.focus();
                props.onChange(id);
              }}
            />
          </div>,
          document.body,
        )}
    </>
  );
}
