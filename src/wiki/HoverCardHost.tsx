/**
 * Shows a page's summary when hovering any element with `data-wiki-target`, which covers
 * wiki links and the name highlights in the manuscript. One listener on the document
 * serves them all, so screens only need to set the attribute.
 */

import { useEffect, useRef, useState } from 'react';
import { computePosition, flip, offset, shift } from '@floating-ui/dom';

import { STATUSES } from './actions';
import { useSyncPageTypes } from './pageTypes';
import { typeLabel } from './templates';
import { HoverFacts } from '../facts';
import { useLocale } from '../state/language';
import { useTitles } from '../state/project';
import { t } from '../lib/i18n';

const SHOW_DELAY_MS = 350;

interface Shown {
  target: string;
  anchor: Element;
}

function targetOf(node: EventTarget | null): Element | null {
  return node instanceof Element ? node.closest('[data-wiki-target]') : null;
}

/** Where the mouse last was, for finding a link that was redrawn underneath it. */
let lastPoint: { x: number; y: number } | null = null;

function targetUnderMouse(): Element | null {
  return lastPoint ? targetOf(document.elementFromPoint(lastPoint.x, lastPoint.y)) : null;
}

export function HoverCardHost() {
  // Mounted for as long as a project is open, which is what the type list needs too.
  useSyncPageTypes();
  useLocale();
  const [shown, setShown] = useState<Shown | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [grew, setGrew] = useState(0);
  const entry = useTitles((s) => (shown ? s.resolve(shown.target) : undefined));

  useEffect(() => {
    let timer: number | undefined;
    let pending: Element | null = null;

    const hide = () => {
      window.clearTimeout(timer);
      pending = null;
      setShown(null);
    };
    const showSoon = (anchor: Element) => {
      if (pending === anchor) return;
      window.clearTimeout(timer);
      pending = anchor;
      timer = window.setTimeout(() => {
        // A title list arriving can redraw the link, which is still the same link.
        const current = anchor.isConnected ? anchor : targetUnderMouse();
        const target = current?.getAttribute('data-wiki-target');
        if (current && target) setShown({ target, anchor: current });
      }, SHOW_DELAY_MS);
    };

    const onOver = (e: MouseEvent) => {
      lastPoint = { x: e.clientX, y: e.clientY };
      // Not while dragging out a selection.
      if (e.buttons !== 0) return;
      const anchor = targetOf(e.target);
      if (anchor) showSoon(anchor);
      else if (pending) hide();
    };
    const onOut = (e: MouseEvent) => {
      const from = targetOf(e.target);
      if (from && from !== targetOf(e.relatedTarget)) hide();
    };
    const onFocusIn = (e: FocusEvent) => {
      const anchor = targetOf(e.target);
      // Keyboard focus only. A mouse click has already shown the card by hovering.
      if (anchor && (e.target as Element).matches(':focus-visible')) showSoon(anchor);
    };
    const onFocusOut = (e: FocusEvent) => {
      if (targetOf(e.target)) hide();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };

    document.addEventListener('mouseover', onOver);
    document.addEventListener('mouseout', onOut);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('mousedown', hide);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', hide, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('mouseout', onOut);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('mousedown', hide);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', hide, true);
    };
  }, []);

  useEffect(() => {
    const card = cardRef.current;
    if (!shown || !card) return;
    let cancelled = false;
    void computePosition(shown.anchor, card, {
      placement: 'bottom-start',
      strategy: 'fixed',
      middleware: [offset(6), flip(), shift({ padding: 8 })],
    }).then(({ x, y }) => {
      if (cancelled) return;
      card.style.left = `${x}px`;
      card.style.top = `${y}px`;
      card.style.visibility = 'visible';
    });
    return () => {
      cancelled = true;
    };
  }, [shown, entry, grew]);

  // A card must not outlive the link it describes, such as after opening that link.
  useEffect(() => {
    if (!shown) return;
    const check = window.setInterval(() => {
      if (shown.anchor.isConnected) return;
      const current = targetUnderMouse();
      const target = current?.getAttribute('data-wiki-target');
      setShown(current && target === shown.target ? { target, anchor: current } : null);
    }, 300);
    return () => window.clearInterval(check);
  }, [shown]);

  if (!shown) return null;
  const status = entry && STATUSES.find((s) => s.value === entry.status);
  const inEditor = shown.anchor.closest('.ProseMirror[contenteditable="true"]') !== null;
  return (
    <div className="wiki-hovercard" role="tooltip" ref={cardRef} style={{ visibility: 'hidden' }}>
      {entry ? (
        <>
          <div className="wiki-hovercard-title">{entry.title}</div>
          <div className="wiki-hovercard-meta">
            <span className="badge">{typeLabel(entry.pageType)}</span>
            {status && <span className={`badge badge-${status.value}`}>{status.label}</span>}
          </div>
          <p className={entry.summary ? 'wiki-hovercard-summary' : 'wiki-hovercard-summary faint'}>
            {entry.summary || t('No summary yet.')}
          </p>
          <HoverFacts pageId={entry.id} onShown={() => setGrew((n) => n + 1)} />
        </>
      ) : (
        <>
          <div className="wiki-hovercard-title">{shown.target}</div>
          <p className="wiki-hovercard-summary faint">{t('This page does not exist yet. Follow the link to create it.')}</p>
        </>
      )}
      {inEditor && <p className="wiki-hovercard-hint faint">{t('Ctrl+click to open')}</p>}
    </div>
  );
}
