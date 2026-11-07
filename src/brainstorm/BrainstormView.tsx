/**
 * The brainstorm board: pick what to brainstorm, and the AI puts short ideas on cards. Cards
 * are suggestions only. Keeping one sends it to the Inbox, and making a page goes through the
 * usual new-page dialog, so nothing lands in the project without the writer choosing it.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { askForNewPage } from '../editor/makePage';
import * as api from '../lib/api';
import { t } from '../lib/i18n';
import { titleKey } from '../lib/text';
import { toast } from '../shell/toasts';
import { useLocale } from '../state/language';
import { useTitles } from '../state/project';
import { openForWriting } from '../wiki/actions';
import { templateBody, templateFor, templateInfobox } from '../wiki/templates';
import { bodyFromIdea } from '../inbox/ideaToPage';
import { CATEGORIES, categoryById, type IdeaCard } from './ideas';
import { useBrainstorm, type FocusKind } from './store';

/** Makes a page from a card, after the writer checks the title and type. */
async function cardToPage(card: IdeaCard): Promise<boolean> {
  const pageType = categoryById(card.category).pageType;
  const page = await askForNewPage({
    heading: t('Make a page from this idea'),
    initialTitle: card.title,
    initialType: pageType,
    confirmLabel: t('Create page'),
    create: ({ title, type }) => {
      const template = templateFor(type);
      return api.pages.create({
        title,
        pageType: type,
        status: 'idea',
        content: bodyFromIdea(templateBody(template), card.detail, title),
        infobox: templateInfobox(template),
      });
    },
  });
  if (!page) return false;
  toast(t('Made the page “{title}”.', { title: page.title }), 'success', { label: t('Open'), run: () => openForWriting(page) });
  return true;
}

function ChosenPage() {
  useLocale();
  const entries = useTitles((s) => s.entries);
  const byKey = useTitles((s) => s.byKey);
  const chosen = useBrainstorm((s) => s.chosenPage);
  const setState = useBrainstorm((s) => s.set);
  const [text, setText] = useState(chosen?.title ?? '');
  const found = text.trim() ? byKey.get(titleKey(text)) : undefined;
  return (
    <span className="brainstorm-page-pick">
      <input
        className="input"
        list="brainstorm-pages"
        aria-label={t('Page to focus on')}
        placeholder={t('Page title')}
        value={text}
        onFocus={() => setState({ focusKind: 'page' })}
        onChange={(e) => {
          setText(e.target.value);
          const entry = byKey.get(titleKey(e.target.value));
          setState({ focusKind: 'page', chosenPage: entry ? { kind: 'page', id: entry.id, title: entry.title } : null });
        }}
      />
      <datalist id="brainstorm-pages">
        {entries.slice(0, 500).map((entry) => (
          <option key={entry.id} value={entry.title} />
        ))}
      </datalist>
      {text.trim() && !found && <span className="field-error small">{t('No page has that title.')}</span>}
    </span>
  );
}

function Card({ card, onGone, register }: { card: IdeaCard; onGone: (id: string) => void; register: (id: string, el: HTMLElement | null) => void }) {
  useLocale();
  const busy = useBrainstorm((s) => s.busy);
  const { keep, discard, moreLike } = useBrainstorm.getState();
  const category = categoryById(card.category);
  const canMakePage = !!category.pageType;

  const actions = {
    keep: async () => {
      onGone(card.id);
      await keep(card);
    },
    page: async () => {
      if (await cardToPage(card)) {
        onGone(card.id);
        discard(card);
      }
    },
    discard: () => {
      onGone(card.id);
      discard(card);
    },
    more: () => void moreLike(card),
  };

  // Single keys act on the card in focus, but not while typing in one of its buttons' places.
  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const key = e.key.toLowerCase();
    if (e.target !== e.currentTarget && key !== 'delete') return;
    if (key === 'k') void actions.keep();
    else if (key === 'n' && canMakePage) void actions.page();
    else if (key === 'm' && !busy) actions.more();
    else if (key === 'delete' || key === 'd') actions.discard();
    else return;
    e.preventDefault();
  };

  return (
    <li
      ref={(el) => register(card.id, el)}
      className="brainstorm-card"
      tabIndex={0}
      aria-label={card.detail ? `${card.title}. ${card.detail}` : card.title}
      aria-keyshortcuts={canMakePage ? 'K N M Delete' : 'K M Delete'}
      data-testid="brainstorm-card"
      onKeyDown={onKeyDown}
    >
      <div className="brainstorm-card-tag faint small">{category.label()}</div>
      <div className="brainstorm-card-title">{card.title}</div>
      {card.detail && <div className="brainstorm-card-detail muted">{card.detail}</div>}
      <div className="brainstorm-card-actions">
        <button type="button" className="btn btn-sm" title={t('Send it to the Inbox (K)')} aria-label={t('Keep “{idea}”', { idea: card.title })} onClick={() => void actions.keep()}>
          {t('Keep')}
        </button>
        {canMakePage && (
          <button type="button" className="btn btn-sm" title={t('Make a wiki page from it (N)')} aria-label={t('New page from “{idea}”', { idea: card.title })} onClick={() => void actions.page()}>
            {t('New page')}
          </button>
        )}
        <button
          type="button"
          className="btn btn-sm"
          disabled={!!busy}
          title={t('Ask for more ideas like this one (M)')}
          aria-label={t('More like “{idea}”', { idea: card.title })}
          onClick={actions.more}
        >
          {busy === card.id ? t('Thinking…') : t('More like this')}
        </button>
        <button type="button" className="btn btn-sm" title={t('Remove it from the board (Delete)')} aria-label={t('Discard “{idea}”', { idea: card.title })} onClick={actions.discard}>
          {t('Discard')}
        </button>
      </div>
    </li>
  );
}

export function BrainstormView() {
  useLocale();
  const state = useBrainstorm();
  const { category, note, focusKind, current, cards, busy, error, status } = state;
  const cardEls = useRef(new Map<string, HTMLElement>());
  const startRef = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<number | null>(null);
  const isCustom = category === 'custom';

  // What was open before the board came on screen is the "current" focus.
  useEffect(() => {
    useBrainstorm.getState().noteCurrent();
  }, []);

  // A card that goes away hands focus to the one now in its place, so the keyboard keeps going.
  useEffect(() => {
    if (pendingFocus.current === null) return;
    const index = Math.min(pendingFocus.current, cards.length - 1);
    pendingFocus.current = null;
    const next = index >= 0 ? cardEls.current.get(cards[index].id) : null;
    (next ?? startRef.current)?.focus();
  }, [cards]);

  const onGone = (id: string) => {
    pendingFocus.current = cards.findIndex((card) => card.id === id);
  };
  const register = (id: string, el: HTMLElement | null) => {
    if (el) cardEls.current.set(id, el);
    else cardEls.current.delete(id);
  };

  // Up and Down move between cards, Home and End to the ends.
  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const els = cards.map((card) => cardEls.current.get(card.id)).filter((el): el is HTMLElement => !!el);
    const at = els.findIndex((el) => el.contains(document.activeElement));
    if (at < 0) return;
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? els.length - 1 : Math.max(0, Math.min(els.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
    els[to]?.focus();
    e.preventDefault();
  };

  const canAsk = !busy && (!isCustom || !!note.trim()) && (focusKind !== 'page' || !!state.chosenPage);

  return (
    <div className="view-pad brainstorm" data-testid="brainstorm-view">
      <h1 className="view-title">{t('Brainstorm')}</h1>
      <p className="muted">{t('Pick what you need ideas for. Keep the good ones in your Inbox, or make pages from them.')}</p>
      <form
        className="brainstorm-form"
        aria-label={t('Brainstorm settings')}
        onSubmit={(e) => {
          e.preventDefault();
          if (canAsk) void state.brainstorm();
        }}
      >
        <label className="field">
          <span className="field-label">{t('Ideas for')}</span>
          <select className="select" value={category} onChange={(e) => state.set({ category: e.target.value as typeof category })}>
            {CATEGORIES.map((item) => (
              <option key={item.id} value={item.id}>{item.label()}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">{isCustom ? t('Your question') : t('Note (optional)')}</span>
          <input
            className="input"
            value={note}
            placeholder={isCustom ? t('What would you like ideas about?') : t('For example: for a northern port town')}
            onChange={(e) => state.set({ note: e.target.value })}
          />
        </label>
        <fieldset className="brainstorm-focus">
          <legend className="field-label">{t('Focus')}</legend>
          {(['none', 'current', 'page'] as FocusKind[]).map((kind) => (
            <label key={kind} className="brainstorm-focus-option">
              <input
                type="radio"
                name="brainstorm-focus"
                value={kind}
                checked={focusKind === kind}
                disabled={kind === 'current' && !current}
                onChange={() => state.set({ focusKind: kind })}
              />
              {kind === 'none' && t('The whole project')}
              {kind === 'current' && (current ? t('What was open: {title}', { title: current.title || t('Untitled scene') }) : t('What was open (nothing)'))}
              {kind === 'page' && t('A page')}
            </label>
          ))}
          {focusKind === 'page' && <ChosenPage />}
        </fieldset>
        <div className="brainstorm-buttons">
          <button ref={startRef} type="submit" className="btn btn-primary" disabled={!canAsk}>
            {busy === 'board' ? t('Thinking…') : t('Brainstorm')}
          </button>
          {busy && (
            <button type="button" className="btn" onClick={state.stop}>
              {t('Stop')}
            </button>
          )}
        </div>
      </form>

      <div className="brainstorm-live" role="status" aria-live="polite">{status}</div>
      {error && <p className="field-error" role="alert">{error}</p>}

      {cards.length > 0 && (
        <section className="brainstorm-board" aria-label={t('Ideas')}>
          <div className="brainstorm-board-bar">
            <span className="muted small">{cards.length === 1 ? t('1 idea') : t('{count} ideas', { count: cards.length })}</span>
            <span className="brainstorm-board-actions">
              <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => void state.more()}>
                {busy === 'board' ? t('Thinking…') : t('More')}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  state.clear();
                  startRef.current?.focus();
                }}
              >
                {t('Clear')}
              </button>
            </span>
          </div>
          <p className="faint small">{t('On a card: K keeps it, N makes a page, M asks for more like it, Delete discards it. Up and Down move between cards.')}</p>
          <ul className="brainstorm-cards" aria-label={t('Idea cards')} onKeyDown={onListKey}>
            {cards.map((card) => (
              <Card key={card.id} card={card} onGone={onGone} register={register} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

