/** The library: search and filters on the left, one style in full on the right. */

import { useEffect, useMemo, useRef } from 'react';

import * as api from '../lib/api';
import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { choose } from '../shell/dialogs';
import { toast } from '../shell/toasts';
import { useDataVersion, useLoad } from '../state/events';
import { useLocale } from '../state/language';
import { useProject } from '../state/project';
import { useSettings } from '../state/settings';
import type { Book } from '../lib/types';
import { compareStyles, searchStyles, sortName } from './library';
import { buildStylePrompt, countWords } from './prompt';
import { deleteStyleAsking, isOwnStyle, removeProjectCopyAsking } from './removeStyle';
import { getStyle, listStyles, loadChoices, setActiveStyle, toggleFavorite } from './store';
import { GENRES, TRAIT_FIELDS, genreLabel, traitLabel, type CustomStyle, type StoredChoices, type WritingStyle } from './types';
import { copyOf, goToTab, useStylesUi, type KindFilter } from './uiStore';

const KINDS: KindFilter[] = ['all', 'author', 'technique', 'custom'];

function kindLabel(kind: KindFilter): string {
  switch (kind) {
    case 'all': return t('All');
    case 'author': return t('Authors');
    case 'technique': return t('Techniques');
    case 'custom': return t('Mine');
  }
}

/** Copies text, with a fallback for when the clipboard API is not allowed. */
export async function copyText(text: string, done = t('Copied.')): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const box = document.createElement('textarea');
    box.value = text;
    box.style.position = 'fixed';
    box.style.opacity = '0';
    document.body.append(box);
    box.select();
    document.execCommand('copy');
    box.remove();
  }
  toast(done, 'success');
}

/** A custom style this project uses, but which is not on this computer. */
function projectCopies(choices: StoredChoices | undefined): CustomStyle[] {
  if (!choices) return [];
  const seen = new Set<string>();
  const stored = [choices.project, ...Object.values(choices.books ?? {}), ...Object.values(choices.scenes ?? {})];
  return stored.flatMap((choice) => {
    if (!choice?.prompt || getStyle(choice.styleId) || seen.has(choice.styleId)) return [];
    seen.add(choice.styleId);
    return [{
      id: choice.styleId,
      kind: 'custom' as const,
      name: choice.name ?? t('Saved style'),
      genres: [],
      summary: t('This project carries a copy of this style. The custom style itself is not on this computer, so only its prompt is shown. Edit a copy to add it to your own styles, or remove it from this project.'),
      traits: { narration: '', sentences: '', diction: '', dialogue: '', description: '', pacing: '', signature: '', avoid: '' },
      promptOverride: choice.prompt,
    }];
  });
}

/** Where a style is in use, in words, for this project. */
function usesOf(styleId: string, choices: StoredChoices | undefined, books: Book[]): string[] {
  if (!choices) return [];
  const uses: string[] = [];
  if (choices.project?.styleId === styleId) uses.push(t('this project'));
  for (const book of books) {
    if (choices.books?.[book.id]?.styleId === styleId) uses.push(book.title);
  }
  const scenes = Object.values(choices.scenes ?? {}).filter((c) => c.styleId === styleId).length;
  if (scenes > 0) uses.push(scenes === 1 ? t('one scene') : t('{count} scenes', { count: scenes }));
  return uses;
}

function Actions({ style, choices, books }: { style: WritingStyle; choices: StoredChoices | undefined; books: Book[] }) {
  useLocale();
  const open = useProject((s) => s.status.open);
  const set = useStylesUi((s) => s.set);
  const slots = useStylesUi((s) => s.slots);
  const usedByProject = choices?.project?.styleId === style.id;

  const run = async (work: () => Promise<void>, done: string) => {
    try {
      await work();
      toast(done, 'success');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const useForBook = async () => {
    let book: Book | null = books[0] ?? null;
    if (books.length > 1) {
      book = await choose<Book | null>({
        title: t('Use {name} for which book?', { name: style.name }),
        dismissValue: null,
        choices: [...books.map((b) => ({ label: b.title, value: b as Book | null })), { label: t('Cancel'), value: null }],
      });
    }
    if (!book) return;
    const chosen = book;
    await run(
      () => setActiveStyle({ kind: 'book', bookId: chosen.id }, style.id),
      t('Using {name} for {book}.', { name: style.name, book: chosen.title }),
    );
  };

  const addToBlend = () => {
    if (!slots.some((slot) => slot.styleId === style.id)) {
      const free = slots.findIndex((slot) => !slot.styleId);
      const at = free >= 0 ? free : slots.length - 1;
      set({ slots: slots.map((slot, i) => (i === at ? { ...slot, styleId: style.id } : slot)) });
    }
    goToTab('blend');
  };

  const needsProject = open ? undefined : t('Open a project to use a style.');
  return (
    <div className="styles-actions" role="group" aria-label={t('What to do with this style')}>
      <button
        type="button"
        className={`btn${usedByProject ? '' : ' btn-primary'}`}
        disabled={!open}
        title={needsProject}
        onClick={() =>
          void (usedByProject
            ? run(() => setActiveStyle({ kind: 'project' }, null), t('This project no longer has a style.'))
            : run(() => setActiveStyle({ kind: 'project' }, style.id), t('Using {name} for this project.', { name: style.name })))
        }
      >
        {usedByProject ? t('Stop using for this project') : t('Use for this project')}
      </button>
      <button
        type="button"
        className="btn"
        disabled={!open || books.length === 0}
        title={needsProject ?? (books.length === 0 ? t('This project has no books yet.') : undefined)}
        onClick={() => void useForBook()}
      >
        {t('Use for this book')}
      </button>
      <button type="button" className="btn" onClick={() => void copyText(buildStylePrompt(style), t('Prompt copied.'))}>
        {t('Copy prompt')}
      </button>
      <button
        type="button"
        className="btn"
        onClick={() => {
          set({ editing: copyOf(style) });
          goToTab('mine');
        }}
      >
        {t('Edit a copy')}
      </button>
      <button type="button" className="btn" onClick={addToBlend}>{t('Blend')}</button>
      {style.kind === 'custom' && (isOwnStyle(style.id) ? (
        <button
          type="button"
          className="btn btn-danger"
          aria-label={t('Delete {name}', { name: style.name })}
          onClick={() => void deleteStyleAsking(style)}
        >
          {t('Delete')}
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-danger"
          disabled={!open}
          onClick={() => void removeProjectCopyAsking(style)}
        >
          {t('Remove from this project')}
        </button>
      ))}
    </div>
  );
}

function Detail({ style, choices, books }: { style: WritingStyle; choices: StoredChoices | undefined; books: Book[] }) {
  useLocale();
  const favorites = useSettings((s) => s.settings.writingStyles.favorites);
  const isFavorite = favorites.includes(style.id);
  const prompt = useMemo(() => buildStylePrompt(style), [style]);
  const uses = usesOf(style.id, choices, books);
  const traits = TRAIT_FIELDS.filter(({ key }) => style.traits[key].trim());
  const words = countWords(prompt);

  return (
    <article className="styles-detail" aria-label={style.name}>
      <header className="styles-detail-head">
        <div className="styles-detail-title">
          <h2>{style.name}</h2>
          <button
            type="button"
            className={`icon-btn styles-star${isFavorite ? ' is-on' : ''}`}
            aria-pressed={isFavorite}
            aria-label={isFavorite ? t('Remove {name} from favorites', { name: style.name }) : t('Add {name} to favorites', { name: style.name })}
            title={isFavorite ? t('Remove from favorites') : t('Add to favorites')}
            onClick={() => void toggleFavorite(style.id)}
          >
            {isFavorite ? '★' : '☆'}
          </button>
        </div>
        <div className="styles-detail-tags">
          {style.kind === 'technique' && <span className="badge">{t('Technique')}</span>}
          {style.kind === 'custom' && <span className="badge">{t('Mine')}</span>}
          {style.genres.map((genre) => <span key={genre} className="badge">{genreLabel(genre)}</span>)}
        </div>
        {style.kind === 'author' && (
          <p className="styles-known"><span className="muted">{t('Known for')}</span> <cite>{style.knownFor.join(', ')}</cite></p>
        )}
        {uses.length > 0 && (
          <p className="styles-in-use" data-testid="style-in-use">{t('In use for {places}', { places: uses.join(', ') })}</p>
        )}
      </header>

      <Actions style={style} choices={choices} books={books} />

      <section className="styles-section">
        <h3>{style.kind === 'author' ? t('How they write') : t('How it reads')}</h3>
        <p className="styles-summary">{style.summary}</p>
      </section>

      {traits.length > 0 && (
        <section className="styles-section">
          <h3>{t('What the AI is told to do')}</h3>
          <dl className="styles-traits">
            {traits.map(({ key }) => (
              <div key={key} className="styles-trait">
                <dt>{traitLabel(key)}</dt>
                <dd>{style.traits[key]}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <section className="styles-section">
        <div className="styles-section-head">
          <h3>{t('The full prompt')}</h3>
          <span className="faint small">{words === 1 ? t('1 word') : t('{count} words', { count: words })}</span>
        </div>
        <pre className="styles-prompt" tabIndex={0} aria-label={t('Prompt for {name}', { name: style.name })} data-testid="style-prompt">{prompt}</pre>
      </section>
    </article>
  );
}

export function BrowseTab() {
  useLocale();
  const { query, genre, kind, favoritesOnly, selectedId, set } = useStylesUi();
  const custom = useSettings((s) => s.settings.writingStyles.custom);
  const favorites = useSettings((s) => s.settings.writingStyles.favorites);
  const isOpen = useProject((s) => s.status.open);
  const metaVersion = useDataVersion('meta');
  const bookVersion = useDataVersion('books');
  const { data: choices } = useLoad(loadChoices, [isOpen, metaVersion]);
  const { data: bookList } = useLoad(() => (isOpen ? api.books.list() : Promise.resolve([] as Book[])), [isOpen, bookVersion]);
  const books = bookList ?? [];
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const all = useMemo(
    () => [...listStyles(), ...projectCopies(choices)].sort(compareStyles),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [custom, choices],
  );

  const filtered = useMemo(() => {
    const narrowed = all.filter((style) => {
      if (kind !== 'all' && style.kind !== kind) return false;
      if (genre && !style.genres.includes(genre as never)) return false;
      if (favoritesOnly && !favorites.includes(style.id)) return false;
      return true;
    });
    return searchStyles(narrowed, query);
  }, [all, kind, genre, favoritesOnly, favorites, query]);

  const selected = filtered.find((s) => s.id === selectedId) ?? filtered[0] ?? null;

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected?.id]);

  const projectStyleId = choices?.project?.styleId ?? null;
  const usedIds = useMemo(() => {
    const ids = new Set<string>();
    if (choices?.project) ids.add(choices.project.styleId);
    Object.values(choices?.books ?? {}).forEach((c) => ids.add(c.styleId));
    return ids;
  }, [choices]);

  const move = (step: number) => {
    if (filtered.length === 0) return;
    const at = selected ? filtered.findIndex((s) => s.id === selected.id) : -1;
    const next = filtered[Math.min(filtered.length - 1, Math.max(0, at + step))];
    set({ selectedId: next.id });
  };

  // Letters only help when the list is in its plain sorted order.
  const showLetters = !query.trim();
  let lastLetter = '';

  return (
    <div className="styles-browse">
      <div className="styles-list-column">
        <div className="styles-filters">
          <input
            ref={searchRef}
            className="input"
            type="search"
            aria-label={t('Search styles')}
            placeholder={t('Search name, genre or trait')}
            value={query}
            onChange={(e) => set({ query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                listRef.current?.focus();
                move(selected ? 1 : 0);
              }
            }}
          />
          <div className="styles-filter-row" role="group" aria-label={t('Kind of style')}>
            {KINDS.map((id) => (
              <button
                key={id}
                type="button"
                className={`styles-chip${kind === id ? ' is-on' : ''}`}
                aria-pressed={kind === id}
                onClick={() => set({ kind: id })}
              >
                {kindLabel(id)}
              </button>
            ))}
          </div>
          <div className="styles-filter-row">
            <select className="select styles-genre" aria-label={t('Genre')} value={genre} onChange={(e) => set({ genre: e.target.value })}>
              <option value="">{t('All genres')}</option>
              {GENRES.map((g) => <option key={g.id} value={g.id}>{genreLabel(g.id)}</option>)}
            </select>
            <button
              type="button"
              className={`styles-chip${favoritesOnly ? ' is-on' : ''}`}
              aria-pressed={favoritesOnly}
              onClick={() => set({ favoritesOnly: !favoritesOnly })}
            >
              {t('★ Favorites')}
            </button>
          </div>
          <div className="faint small" role="status">
            {filtered.length === 1 ? t('1 style') : t('{count} styles', { count: filtered.length })}
          </div>
        </div>

        <div
          ref={listRef}
          className="styles-list"
          role="listbox"
          tabIndex={0}
          aria-label={t('Styles')}
          aria-activedescendant={selected ? `style-row-${selected.id}` : undefined}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              move(1);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              if (selected && filtered[0]?.id === selected.id) searchRef.current?.focus();
              else move(-1);
            } else if (e.key === 'Home') {
              e.preventDefault();
              if (filtered[0]) set({ selectedId: filtered[0].id });
            } else if (e.key === 'End') {
              e.preventDefault();
              const last = filtered[filtered.length - 1];
              if (last) set({ selectedId: last.id });
            }
          }}
        >
          {filtered.length === 0 && (
            <div className="styles-empty">
              {kind === 'custom' && !query && !genre && !favoritesOnly ? (
                <>
                  <p>{t('You have no styles of your own yet.')}</p>
                  <p className="muted">{t('Pick any style and choose Edit a copy, or start one in My styles.')}</p>
                </>
              ) : favoritesOnly && favorites.length === 0 ? (
                <>
                  <p>{t('You have no favorites yet.')}</p>
                  <p className="muted">{t('Select a style and press the star beside its name.')}</p>
                </>
              ) : (
                <>
                  <p>{t('No style matches.')}</p>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => set({ query: '', genre: '', kind: 'all', favoritesOnly: false })}
                  >
                    {t('Clear the search and filters')}
                  </button>
                </>
              )}
            </div>
          )}
          {filtered.map((style) => {
            const letter = sortName(style).charAt(0).toUpperCase();
            const newLetter = showLetters && letter !== lastLetter;
            lastLetter = letter;
            const isSelected = selected?.id === style.id;
            const isFavorite = favorites.includes(style.id);
            const inUse = usedIds.has(style.id);
            return (
              <div key={style.id} role="presentation">
                {newLetter && <div className="styles-letter" aria-hidden="true">{letter}</div>}
                <div
                  id={`style-row-${style.id}`}
                  role="option"
                  aria-selected={isSelected}
                  className={`styles-row${isSelected ? ' is-selected' : ''}${inUse ? ' is-in-use' : ''}`}
                  onClick={() => set({ selectedId: style.id })}
                >
                  <span className="styles-row-name">
                    <span className="truncate">{style.name}</span>
                    {isFavorite && <span className="styles-row-star" aria-label={t('Favorite')}>★</span>}
                    {inUse && (
                      <span className="badge badge-canon styles-row-badge" data-testid="style-active-badge">
                        {projectStyleId === style.id ? t('In use') : t('In a book')}
                      </span>
                    )}
                  </span>
                  <span className="styles-row-sub truncate">
                    {style.kind === 'custom' ? t('Mine') : style.genres.slice(0, 2).map(genreLabel).join(', ')}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="styles-detail-column">
        {selected ? (
          <Detail key={selected.id} style={selected} choices={choices} books={books} />
        ) : (
          <div className="styles-empty">
            <p>{t('Choose a style to see how it writes.')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
