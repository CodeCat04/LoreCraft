/**
 * The small bar over a document. It sits at the top right of whatever scrolls the document,
 * and stays there while the page moves under it. The boxes are uncontrolled, so a keystroke
 * reaches the controller without a render here or anywhere else.
 */

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import type { Editor } from '@tiptap/core';

import { t } from '../../lib/i18n';
import { toast } from '../../shell/toasts';
import { useLocale } from '../../state/language';
import type { EditorSource } from '../RichEditor';
import { controllerFor } from './controller';

function findLabel(kind: EditorSource['kind']): string {
  switch (kind) {
    case 'page':
      return t('Find in this page');
    case 'node':
      return t('Find in this scene');
    case 'notes':
      return t('Find in these notes');
  }
}

function countText(total: number, current: number, hasQuery: boolean): string {
  if (!hasQuery) return '';
  if (total === 0) return t('No matches');
  return t('{current} of {total}', { current: (current + 1).toLocaleString(), total: total.toLocaleString() });
}

export function FindBar({ editor, editable, kind }: { editor: Editor; editable: boolean; kind: EditorSource['kind'] }) {
  useLocale();
  const controller = controllerFor(editor);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [showReplace, setShowReplace] = useState(false);
  const [hasQuery, setHasQuery] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const replaceFocusWanted = useRef(false);
  /** Undo means the replacing just done, until the writer goes back to typing in a box. */
  const undoGoesToDocument = useRef(false);

  const { open, focusRequest, replaceRequested, query } = state;

  // Ctrl+F or Ctrl+H, whether opening or already open.
  useLayoutEffect(() => {
    if (!open) return;
    const box = findRef.current;
    if (!box) return;
    box.value = query;
    setHasQuery(query !== '');
    box.focus();
    box.select();
    if (replaceRequested) {
      setShowReplace(true);
      // With nothing to look for yet, that comes first.
      replaceFocusWanted.current = query !== '';
    }
    // Only a new request should take the keyboard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, focusRequest]);

  // After the row has come up, whether from a request or the button.
  useEffect(() => {
    if (!replaceFocusWanted.current || !replaceRef.current) return;
    replaceFocusWanted.current = false;
    replaceRef.current.focus();
    replaceRef.current.select();
  });

  // Keeps to the corner of what scrolls, as the window or the panes around it change size.
  const scroller = open ? controller.scrollContainer : null;
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const bar = barRef.current;
      if (!bar) return;
      const port = scroller?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
      // Formatting bars stick to the top of the same area, and this should not hide them.
      const toolbar = scroller?.querySelector<HTMLElement>('.wiki-toolbar, .toolbar');
      const below = toolbar && toolbar.getClientRects().length > 0 ? toolbar.offsetHeight : 0;
      bar.style.top = `calc(${port.top + below}px + 0.5rem)`;
      bar.style.right = `calc(${Math.max(0, window.innerWidth - port.right)}px + 1.25rem)`;
      // A narrow pane keeps the bar to itself, with its controls wrapping.
      bar.style.maxWidth = `calc(${port.width}px - 2rem)`;
    };
    place();
    window.addEventListener('resize', place);
    const observer = scroller ? new ResizeObserver(place) : null;
    if (scroller) observer?.observe(scroller);
    return () => {
      window.removeEventListener('resize', place);
      observer?.disconnect();
    };
  }, [open, scroller, showReplace, editable]);

  if (!open) return null;

  const canReplace = editable && showReplace;
  const count = countText(state.total, state.current, hasQuery);
  const noMatches = hasQuery && state.settled && state.total === 0;

  const onFindKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      controller.step(e.shiftKey ? -1 : 1);
    }
  };

  // The buttons disable themselves when no matches are left, and a disabled button that has
  // the keyboard swallows every key, Escape included. So the keyboard goes back to the box.
  const replaceOne = () => {
    controller.replaceCurrent(replaceRef.current?.value ?? '');
    replaceRef.current?.focus();
    undoGoesToDocument.current = true;
  };
  const replaceEvery = () => {
    const changed = controller.replaceAll(replaceRef.current?.value ?? '');
    replaceRef.current?.focus();
    undoGoesToDocument.current = changed > 0;
    if (changed === 0) toast(t('Nothing to replace.'));
    else if (changed === 1) toast(t('Replaced 1 match.'));
    else toast(t('Replaced {count} matches.', { count: changed.toLocaleString() }));
  };

  return (
    // Clicks stay here, because the text behind this acts on them. Read-through opens a
    // scene on a click, for one.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      ref={barRef}
      className="find-bar"
      role="search"
      aria-label={findLabel(kind)}
      onClick={(e) => e.stopPropagation()}
      onChange={() => {
        undoGoesToDocument.current = false;
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          e.stopPropagation();
          controller.close();
        } else if (undoGoesToDocument.current && e.ctrlKey && !e.altKey && ['z', 'y'].includes(e.key.toLowerCase())) {
          e.preventDefault();
          if (e.key.toLowerCase() === 'z' && !e.shiftKey) editor.commands.undo();
          else editor.commands.redo();
        } else if (e.altKey && !e.ctrlKey && e.key.toLowerCase() === 'c') {
          e.preventDefault();
          controller.toggleCase();
        } else if (e.altKey && !e.ctrlKey && e.key.toLowerCase() === 'w') {
          e.preventDefault();
          controller.toggleWholeWord();
        }
      }}
    >
      <div className="find-row">
        <input
          ref={findRef}
          className="input find-input"
          type="text"
          placeholder={findLabel(kind)}
          aria-label={findLabel(kind)}
          spellCheck={false}
          defaultValue={query}
          onChange={(e) => {
            const value = e.target.value;
            setHasQuery((had) => (had === (value !== '') ? had : value !== ''));
            controller.setQuery(value);
          }}
          onKeyDown={onFindKey}
        />
        <span className={`find-count${noMatches ? ' is-none' : ''}`} role="status" aria-live="polite" data-testid="find-count">
          {state.settled ? count : count && <span className="faint">{count}</span>}
        </span>
        <button
          type="button"
          className="btn btn-sm find-toggle"
          aria-pressed={state.matchCase}
          aria-label={t('Match case')}
          title={t('Match case ({shortcut})', { shortcut: 'Alt+C' })}
          onClick={() => controller.toggleCase()}
        >
          Aa
        </button>
        <button
          type="button"
          className="btn btn-sm find-toggle"
          aria-pressed={state.wholeWord}
          aria-label={t('Whole words only')}
          title={t('Whole words only ({shortcut})', { shortcut: 'Alt+W' })}
          onClick={() => controller.toggleWholeWord()}
        >
          {t('Word')}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          aria-label={t('Previous match')}
          title={t('Previous match ({shortcut})', { shortcut: 'Shift+Enter' })}
          aria-disabled={state.total === 0}
          onClick={() => controller.step(-1)}
        >
          ↑
        </button>
        <button
          type="button"
          className="btn btn-sm"
          aria-label={t('Next match')}
          title={t('Next match ({shortcut})', { shortcut: 'Enter' })}
          aria-disabled={state.total === 0}
          onClick={() => controller.step(1)}
        >
          ↓
        </button>
        {editable && (
          <button
            type="button"
            className="btn btn-sm find-toggle"
            aria-pressed={showReplace}
            aria-label={t('Show replace')}
            title={t('Replace text ({shortcut})', { shortcut: 'Ctrl+H' })}
            onClick={() => {
              replaceFocusWanted.current = !showReplace;
              setShowReplace(!showReplace);
            }}
          >
            {t('Replace')}
          </button>
        )}
        <button type="button" className="btn btn-sm" aria-label={t('Close find')} title={t('Close ({shortcut})', { shortcut: 'Esc' })} onClick={() => controller.close()}>
          ×
        </button>
      </div>
      {canReplace && (
        <div className="find-row">
          <input
            ref={replaceRef}
            className="input find-input"
            type="text"
            placeholder={t('Replace with')}
            aria-label={t('Replace with')}
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
              e.preventDefault();
              if (e.ctrlKey) replaceEvery();
              else replaceOne();
            }}
          />
          <button
            type="button"
            className="btn btn-sm"
            title={t('Replace this match and go to the next ({shortcut})', { shortcut: 'Enter' })}
            disabled={state.total === 0}
            onClick={replaceOne}
          >
            {t('Replace this')}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            title={t('Replace every match ({shortcut}). Undo takes it all back in one step.', { shortcut: 'Ctrl+Enter' })}
            disabled={state.total === 0}
            onClick={replaceEvery}
          >
            {t('Replace all')}
          </button>
        </div>
      )}
    </div>
  );
}
