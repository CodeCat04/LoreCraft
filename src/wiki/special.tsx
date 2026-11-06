/** The special pages: lists of the wiki as a whole. None of them load page content. */

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';

import { STATUSES, restoreFromTrash } from './actions';
import { wikiPages, type WikiListFilter } from './api';
import { PageLink, RouteLink, WikiLink } from './links';
import { openNewPageDialog } from './NewPageDialog';
import { loadPref, savePref } from './session';
import { usePageTypes } from './pageTypes';
import { typeLabel, typePlural } from './templates';
import { foldName } from '../editor/linkSuggest';
import { RelatedByMeaning } from '../meaning/Related';
import { confirm } from '../shell/dialogs';
import { toast } from '../shell/toasts';
import { useDataVersion, useLoad } from '../state/events';
import { useNav } from '../state/nav';
import { useTitles } from '../state/project';
import * as api from '../lib/api';
import { errorMessage } from '../lib/rpc';
import { formatNumber, relativeTime, snippetParts } from '../lib/text';
import type { PageMeta, PageStatus } from '../lib/types';
import { t } from '../lib/i18n';
import { useLocale } from '../state/language';

const PAGE_STEP = 200;

function usePagesVersion() {
  return useDataVersion('pages', 'pageContent');
}

function Special(props: { title: string; intro?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="view-pad wiki-special">
      <h1 className="view-title">{props.title}</h1>
      {props.intro && <p className="muted wiki-special-intro">{props.intro}</p>}
      {props.actions}
      {props.children}
    </div>
  );
}

function StatusBadge({ status }: { status: PageStatus }) {
  const label = STATUSES.find((s) => s.value === status)?.label ?? status;
  return <span className={`badge badge-${status}`}>{label}</span>;
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="empty-state">{children}</div>;
}

/** A list long enough to slow the window is shown in steps. */
function usePaged<T>(items: T[]) {
  const [shown, setShown] = useState(PAGE_STEP);
  return {
    visible: items.slice(0, shown),
    more:
      items.length > shown ? (
        <button type="button" className="btn wiki-show-more" onClick={() => setShown(shown + PAGE_STEP)}>
          {t('Show {count} more of {total}', {
            count: formatNumber(Math.min(PAGE_STEP, items.length - shown)),
            total: formatNumber(items.length),
          })}
        </button>
      ) : null,
  };
}

function PageTable({ pages, wordsFirst = false }: { pages: PageMeta[]; wordsFirst?: boolean }) {
  useLocale();
  const { visible, more } = usePaged(pages);
  return (
    <>
      <table className="data-table wiki-page-table">
        <thead>
          <tr>
            <th scope="col">{t('Title')}</th>
            <th scope="col">{t('Type')}</th>
            <th scope="col">{t('Status')}</th>
            <th scope="col" className="wiki-num">{t('Words')}</th>
            <th scope="col">{t('Edited')}</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((page) => (
            <tr key={page.id} data-page={page.title}>
              <td className="wiki-cell-title">
                <PageLink id={page.id} title={page.title} />
              </td>
              <td>{typeLabel(page.pageType)}</td>
              <td><StatusBadge status={page.status} /></td>
              <td className={`wiki-num${wordsFirst ? ' wiki-strong' : ''}`}>{formatNumber(page.wordCount)}</td>
              <td title={new Date(page.updatedAt).toLocaleString()}>{relativeTime(page.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {more}
    </>
  );
}

// ---- All pages ----------------------------------------------------------------------

type SortKey = NonNullable<WikiListFilter['sort']>;

function sorts(): { value: SortKey; label: string }[] {
  return [
    { value: 'title', label: t('Title') },
    { value: 'updated', label: t('Recently edited') },
    { value: 'created', label: t('Recently created') },
    { value: 'words', label: t('Most words') },
    { value: 'fewestWords', label: t('Fewest words') },
  ];
}

export function AllPagesView(props: { category?: string; pageType?: string; status?: string }) {
  useLocale();
  const { category, pageType, status } = props;
  const version = usePagesVersion();
  const go = useNav((s) => s.go);
  const types = usePageTypes((s) => s.types);
  const [sort, setSort] = useState<SortKey>(() => loadPref('allPagesSort', 'title'));
  const [filter, setFilter] = useState('');
  const { data: pages } = useLoad(
    () => wikiPages.list({ category, pageType, status: status as PageStatus | undefined, sort }),
    [category, pageType, status, sort, version],
  );
  const { data: categories } = useLoad(() => api.pages.categories(), [version]);

  const shown = useMemo(() => {
    const q = foldName(filter);
    if (!q) return pages ?? [];
    return (pages ?? []).filter((p) => [p.title, ...p.aliases].some((name) => foldName(name).includes(q)));
  }, [pages, filter]);

  const change = (patch: { category?: string; pageType?: string; status?: string }) => {
    const next = { category, pageType, status, ...patch };
    go({
      view: 'allPages',
      ...(next.category ? { category: next.category } : {}),
      ...(next.pageType ? { pageType: next.pageType } : {}),
      ...(next.status ? { status: next.status } : {}),
    });
  };

  const noFilters = !category && !pageType && !status && !filter;
  const typeTitle = pageType ? typePlural(pageType) : null;

  return (
    <Special title={category ? t('Category: {name}', { name: category }) : typeTitle ?? t('All pages')}>
      <form className="wiki-filters" role="search" aria-label={t('Filter pages')} onSubmit={(e) => e.preventDefault()}>
        <label className="wiki-filter wiki-filter-grow">
          <span className="field-label">{t('Name')}</span>
          <input
            className="input"
            type="search"
            value={filter}
            placeholder={t('Filter by name')}
            onChange={(e) => setFilter(e.target.value)}
          />
        </label>
        <label className="wiki-filter">
          <span className="field-label">{t('Type')}</span>
          <select className="select" aria-label={t('Type')} value={pageType ?? ''} onChange={(e) => change({ pageType: e.target.value || undefined })}>
            <option value="">{t('Any type')}</option>
            {types.map((template) => (
              <option key={template.type} value={template.type}>{typeLabel(template.type)}</option>
            ))}
            {pageType && !types.some((template) => template.type === pageType) && <option value={pageType}>{typeLabel(pageType)}</option>}
          </select>
        </label>
        <label className="wiki-filter">
          <span className="field-label">{t('Status')}</span>
          <select className="select" aria-label={t('Status')} value={status ?? ''} onChange={(e) => change({ status: e.target.value || undefined })}>
            <option value="">{t('Any status')}</option>
            {STATUSES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </label>
        <label className="wiki-filter">
          <span className="field-label">{t('Category')}</span>
          <select className="select" aria-label={t('Category')} value={category ?? ''} onChange={(e) => change({ category: e.target.value || undefined })}>
            <option value="">{t('Any category')}</option>
            {(categories ?? []).map((c) => (
              <option key={c.name} value={c.name}>{c.name}</option>
            ))}
            {category && !(categories ?? []).some((c) => c.name === category) && <option value={category}>{category}</option>}
          </select>
        </label>
        <label className="wiki-filter">
          <span className="field-label">{t('Sort by')}</span>
          <select
            className="select"
            aria-label={t('Sort by')}
            value={sort}
            onChange={(e) => {
              const next = e.target.value as SortKey;
              setSort(next);
              savePref('allPagesSort', next);
            }}
          >
            {sorts().map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </label>
      </form>
      {pages && (
        <p className="muted small wiki-count" role="status">
          {shown.length === 1 ? t('1 page') : t('{count} pages', { count: shown.length.toLocaleString() })}
        </p>
      )}
      {pages && shown.length === 0 ? (
        <Empty>
          {noFilters ? t('No pages yet.') : t('No pages match these filters.')}{' '}
          <button type="button" className="link-button" onClick={() => void openNewPageDialog(filter)}>
            {t('Create a page')}
          </button>
        </Empty>
      ) : category && sort === 'title' ? (
        <LetterList pages={shown} />
      ) : (
        <PageTable pages={shown} wordsFirst={sort === 'words' || sort === 'fewestWords'} />
      )}
    </Special>
  );
}

/** Pages in columns under their first letter, the way a category page lists them. */
function LetterList({ pages }: { pages: PageMeta[] }) {
  const groups = useMemo(() => {
    const byLetter = new Map<string, PageMeta[]>();
    for (const page of pages) {
      const letter = foldName(page.title).charAt(0).toUpperCase() || '#';
      const list = byLetter.get(letter);
      if (list) list.push(page);
      else byLetter.set(letter, [page]);
    }
    return [...byLetter];
  }, [pages]);
  return (
    <div className="wiki-letter-columns">
      {groups.map(([letter, list]) => (
        <section key={letter} className="wiki-letter-group">
          <h2 className="wiki-letter">{letter}</h2>
          <ul>
            {list.map((page) => (
              <li key={page.id}>
                <PageLink id={page.id} title={page.title} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ---- Categories -----------------------------------------------------------------------

export function CategoriesView() {
  useLocale();
  const version = usePagesVersion();
  const { data: categories } = useLoad(() => api.pages.categories(), [version]);
  return (
    <Special title={t('Categories')} intro={t('Every category in this project. Add one to a page from its Edit tab.')}>
      {categories?.length === 0 && <Empty>{t('No categories yet.')}</Empty>}
      {categories && categories.length > 0 && (
        <ul className="wiki-columns">
          {categories.map((c) => (
            <li key={c.name}>
              <RouteLink route={{ view: 'allPages', category: c.name }}>{c.name}</RouteLink>{' '}
              <span className="faint">({formatNumber(c.count)})</span>
            </li>
          ))}
        </ul>
      )}
    </Special>
  );
}

// ---- Recent changes ---------------------------------------------------------------------

const RECENT_LIMIT = 200;

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'long' });
}

export function RecentView() {
  useLocale();
  const version = usePagesVersion();
  const { data: pages } = useLoad(() => wikiPages.list({ sort: 'updated', limit: RECENT_LIMIT }), [version]);
  const days = useMemo(() => {
    const groups = new Map<string, PageMeta[]>();
    for (const page of pages ?? []) {
      const day = dayLabel(page.updatedAt);
      const list = groups.get(day);
      if (list) list.push(page);
      else groups.set(day, [page]);
    }
    return [...groups];
  }, [pages]);
  return (
    <Special
      title={t('Recent changes')}
      intro={t('The {count} most recently changed pages, newest first.', { count: RECENT_LIMIT })}
    >
      {days.map(([day, list]) => (
        <section key={day} className="wiki-recent-day">
          <h2 className="wiki-section-title">{day}</h2>
          <ul className="wiki-recent-list">
            {list.map((page) => (
              <li key={page.id}>
                <span className="wiki-recent-time">
                  {new Date(page.updatedAt).toLocaleTimeString(undefined, { timeStyle: 'short' })}
                </span>{' '}
                {page.createdAt === page.updatedAt && <span className="badge badge-new">{t('New')}</span>}{' '}
                <PageLink id={page.id} title={page.title} />{' '}
                <span className="faint">
                  {page.wordCount === 1
                    ? t('{type}, 1 word', { type: typeLabel(page.pageType) })
                    : t('{type}, {count} words', { type: typeLabel(page.pageType), count: page.wordCount.toLocaleString() })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {pages?.length === 0 && <Empty>{t('No changes yet.')}</Empty>}
    </Special>
  );
}

// ---- Wanted, orphaned and short pages -------------------------------------------------------

export function WantedView() {
  useLocale();
  const version = useDataVersion('pages', 'pageContent', 'nodeContent');
  const { data: wanted } = useLoad(() => api.pages.wanted(), [version]);
  return (
    <Special
      title={t('Wanted pages')}
      intro={t('Links point at these names, but the pages do not exist yet. The most wanted come first.')}
    >
      {wanted?.length === 0 && <Empty>{t('No red links. Every link goes somewhere.')}</Empty>}
      {wanted && wanted.length > 0 && (
        <ol className="wiki-wanted-list">
          {wanted.map((item) => (
            <li key={item.key}>
              <WikiLink target={item.title} />{' '}
              <span className="faint">
                {item.count === 1 ? t('(1 document)') : t('({count} documents)', { count: item.count.toLocaleString() })}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Special>
  );
}

export function OrphansView() {
  useLocale();
  const version = usePagesVersion();
  const { data: orphans } = useLoad(() => api.pages.orphans(), [version]);
  return (
    <Special
      title={t('Orphaned pages')}
      intro={t('No other page links to these, so a reader could only find them by searching.')}
    >
      {orphans?.length === 0 && <Empty>{t('Every page has a link pointing at it.')}</Empty>}
      {orphans && orphans.length > 0 && <PageTable pages={orphans} />}
    </Special>
  );
}

const DEFAULT_SHORT_WORDS = 100;

export function StubsView() {
  useLocale();
  const version = usePagesVersion();
  const [limit, setLimit] = useState(() => loadPref('shortPageWords', DEFAULT_SHORT_WORDS));
  const [typed, setTyped] = useState(String(limit));
  const { data: pages } = useLoad(
    () => wikiPages.list({ underWords: limit, excludeHome: true, sort: 'fewestWords' }),
    [limit, version],
  );

  // Holds off until typing pauses, since each change reloads the list.
  useEffect(() => {
    const value = Number(typed);
    if (!Number.isInteger(value) || value < 1 || value === limit) return;
    const timer = window.setTimeout(() => {
      setLimit(value);
      savePref('shortPageWords', value);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [typed, limit]);

  return (
    <Special title={t('Short pages')} intro={t('Pages that could use more writing, shortest first.')}>
      <form className="wiki-filters" onSubmit={(e) => e.preventDefault()}>
        <label className="wiki-filter">
          <span className="field-label">{t('Under this many words')}</span>
          <input
            className="input wiki-input-number"
            type="number"
            min={1}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </label>
      </form>
      {pages?.length === 0 && (
        <Empty>
          {limit === 1 ? t('No pages under 1 word.') : t('No pages under {count} words.', { count: limit.toLocaleString() })}
        </Empty>
      )}
      {pages && pages.length > 0 && <PageTable pages={pages} wordsFirst />}
    </Special>
  );
}

// ---- Trash -----------------------------------------------------------------------------------

export function TrashView() {
  useLocale();
  const version = usePagesVersion();
  const { data: pages, reload } = useLoad(() => wikiPages.list({ deleted: true, sort: 'updated' }), [version]);

  const purge = async (ids: string[], title: string, message: string) => {
    const yes = await confirm({ title, message, confirmLabel: t('Delete permanently'), danger: true });
    if (!yes) return;
    try {
      for (const id of ids) await api.pages.purge(id);
      toast(
        ids.length === 1
          ? t('Deleted 1 page permanently.')
          : t('Deleted {count} pages permanently.', { count: ids.length.toLocaleString() }),
      );
    } catch (e) {
      toast(errorMessage(e), 'error');
      reload();
    }
  };

  return (
    <Special
      title={t('Trash')}
      intro={t('Pages here can be restored with their history. Deleting one permanently cannot be undone.')}
      actions={
        pages && pages.length > 1 ? (
          <div className="wiki-special-actions">
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() =>
                void purge(
                  pages.map((p) => p.id),
                  t('Empty the trash?'),
                  t('This permanently deletes {count} pages and their history. It cannot be undone.', {
                    count: pages.length.toLocaleString(),
                  }),
                )
              }
            >
              {t('Empty the trash')}
            </button>
          </div>
        ) : null
      }
    >
      {pages?.length === 0 && <Empty>{t('The trash is empty.')}</Empty>}
      {pages && pages.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t('Title')}</th>
              <th scope="col">{t('Type')}</th>
              <th scope="col">{t('Moved to trash')}</th>
              <th scope="col"><span className="wiki-visually-hidden">{t('Actions')}</span></th>
            </tr>
          </thead>
          <tbody>
            {pages.map((page) => (
              <tr key={page.id} data-page={page.title}>
                <td className="wiki-cell-title">
                  <RouteLink route={{ view: 'page', id: page.id }}>{page.title}</RouteLink>
                </td>
                <td>{typeLabel(page.pageType)}</td>
                <td>{relativeTime(page.deletedAt ?? page.updatedAt)}</td>
                <td className="wiki-row-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    aria-label={t('Restore {title}', { title: page.title })}
                    onClick={() => void restoreFromTrash(page.id, page.title)}
                  >
                    {t('Restore')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    aria-label={t('Delete {title} permanently', { title: page.title })}
                    onClick={() =>
                      void purge(
                        [page.id],
                        t('Delete “{title}” permanently?', { title: page.title }),
                        t('The page and its history will be gone for good. This cannot be undone.'),
                      )
                    }
                  >
                    {t('Delete permanently')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Special>
  );
}

// ---- Search ------------------------------------------------------------------------------------

const SEARCH_LIMIT = 100;

export function SearchView({ q }: { q: string }) {
  useLocale();
  const version = useDataVersion('pages', 'pageContent', 'nodeContent');
  const go = useNav((s) => s.go);
  const [kind, setKind] = useState<'page' | 'node' | ''>('');
  const [typed, setTyped] = useState(q);
  const { data: hits, error } = useLoad(
    () => api.search.query(q, kind || undefined, SEARCH_LIMIT),
    [q, kind, version],
  );
  const exact = useTitles((s) => s.resolve(q));
  const [noPageBefore, noPageAfter] = t('There is no page called {title}.').split('{title}');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (typed.trim()) go({ view: 'search', q: typed.trim() });
  };

  return (
    <Special title={t('Search results')}>
      <form className="wiki-filters" role="search" onSubmit={submit}>
        <label className="wiki-filter wiki-filter-grow">
          <span className="field-label">{t('Search for')}</span>
          <input className="input" type="search" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </label>
        <label className="wiki-filter">
          <span className="field-label">{t('Look in')}</span>
          <select className="select" aria-label={t('Look in')} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="">{t('Pages and scenes')}</option>
            <option value="page">{t('Pages')}</option>
            <option value="node">{t('Scenes')}</option>
          </select>
        </label>
        <button type="submit" className="btn">{t('Search')}</button>
      </form>
      {!exact && (
        <p className="wiki-search-create">
          {noPageBefore}
          <b>{q}</b>
          {noPageAfter}{' '}
          <button type="button" className="link-button" onClick={() => void openNewPageDialog(q)}>
            {t('Create it')}
          </button>
        </p>
      )}
      {error && <p className="field-error" role="alert">{error.message}</p>}
      {hits && (
        <p className="muted small wiki-count" role="status">
          {hits.length === SEARCH_LIMIT
            ? t('The first {count} results', { count: SEARCH_LIMIT })
            : hits.length === 1
              ? t('1 result')
              : t('{count} results', { count: hits.length.toLocaleString() })}
        </p>
      )}
      {hits?.length === 0 && <Empty>{t('Nothing matches “{q}”.', { q })}</Empty>}
      <ul className="wiki-search-results">
        {hits?.map((hit) => (
          <li key={`${hit.kind}:${hit.id}`} className="wiki-search-hit">
            <div className="wiki-search-title">
              {hit.kind === 'page' ? (
                <PageLink id={hit.id} title={hit.title} />
              ) : (
                <RouteLink route={{ view: 'write', bookId: hit.bookId ?? undefined, nodeId: hit.id }}>
                  {hit.title || t('Untitled scene')}
                </RouteLink>
              )}
              {hit.kind === 'node' && <span className="badge">{t('Scene')}</span>}
            </div>
            {hit.snippet && (
              <p className="wiki-search-snippet">
                {snippetParts(hit.snippet).map((part, index) =>
                  part.match ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>,
                )}
              </p>
            )}
          </li>
        ))}
      </ul>
      <RelatedByMeaning q={q} kind={kind} />
    </Special>
  );
}
