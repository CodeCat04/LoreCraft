import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';

import * as extras from '../api';
import { PageAutocomplete, matchTitles } from '../common/PageAutocomplete';
import { WindowedList, type WindowedListHandle } from '../common/WindowedList';
import { getDateContext, storyYear } from '../../lib/storyDate';
import { t } from '../../lib/i18n';
import { errorMessage } from '../../lib/rpc';
import { formatNumber } from '../../lib/text';
import { runCommand } from '../../shell/commands';
import { useDataVersion, useLoad } from '../../state/events';
import { useLocale } from '../../state/language';
import { useNav } from '../../state/nav';
import { useProject, useTitles } from '../../state/project';
import {
  TIMELINE_KINDS,
  assembleTimeline,
  dateRange,
  filterTimeline,
  indexOfYear,
  overviewRows,
  startsNewYear,
  zoomSteps,
  type OverviewRow,
  type TimelineItem,
  type TimelineKind,
  type TimelineLink,
  type UnplacedItem,
} from './assemble';
import { openEraSettings } from './EraSettings';

const DETAIL_ROW_REM = 2.25;
const OVERVIEW_ROW_REM = 3.25;
const UNPLACED_ROW_REM = 5.25;
/** With more items than this, the view opens zoomed out. */
const OPEN_ZOOMED_OUT_ABOVE = 200;
/** One notch of Ctrl+wheel moves one zoom level, however fast the wheel reports. */
const WHEEL_ZOOM_GAP_MS = 180;

/** Choices that should still be there after visiting a page and coming back. */
interface TimelineUi {
  hidden: ReadonlySet<TimelineKind>;
  bookId: string;
  page: { id: string; title: string } | null;
  /** Index into the zoom steps, where one past the end is every item. Null until chosen. */
  zoom: number | null;
  /** The year to scroll to when the view next draws. */
  anchorYear: number | null;
  patch: (change: Partial<Omit<TimelineUi, 'patch' | 'reset'>>) => void;
  reset: () => void;
}

const useTimelineUi = create<TimelineUi>((set) => ({
  hidden: new Set(),
  bookId: '',
  page: null,
  zoom: null,
  anchorYear: null,
  patch: (change) => set(change),
  reset: () => set({ hidden: new Set(), bookId: '', page: null, zoom: null, anchorYear: null }),
}));

/** Counts resets, so a view that closes after one does not write over it. */
let resets = 0;

/** Filters name things in one project, so they must not outlive it. */
export function resetTimelineUi() {
  resets += 1;
  useTimelineUi.getState().reset();
}

function followLink(link: TimelineLink, edit = false) {
  const { go } = useNav.getState();
  if (link.kind === 'scene') go({ view: 'write', bookId: link.bookId, nodeId: link.id });
  else go(edit ? { view: 'page', id: link.id, tab: 'edit' } : { view: 'page', id: link.id });
}

/** The summary over the list, with each count read so it suits the language. */
function summaryText(placed: number, unplaced: number): string {
  const vars = { count: formatNumber(placed), unplaced: formatNumber(unplaced) };
  if (unplaced === 0) return placed === 1 ? t('1 item in order') : t('{count} items in order', vars);
  if (placed === 1) {
    return unplaced === 1
      ? t('1 item in order, 1 that cannot be placed')
      : t('1 item in order, {unplaced} that cannot be placed', vars);
  }
  return unplaced === 1
    ? t('{count} items in order, 1 that cannot be placed', vars)
    : t('{count} items in order, {unplaced} that cannot be placed', vars);
}

function DetailRow(props: { item: TimelineItem; newYear: boolean; tabIndex: 0 | -1 }) {
  useLocale();
  const { item, newYear, tabIndex } = props;
  const isSpan = item.endSort !== undefined;
  return (
    <div
      className={`tl-row tl-kind-${item.kind}${newYear ? ' is-new-year' : ''}`}
      data-timeline-item={item.key}
    >
      <span className="tl-date" title={dateRange(item)}>{dateRange(item)}</span>
      <span className="tl-rail" aria-hidden="true">
        <span className={isSpan ? 'tl-mark tl-mark-span' : 'tl-mark'} />
      </span>
      <button
        type="button"
        className="link-button tl-title truncate"
        data-row-focus
        tabIndex={tabIndex}
        data-wiki-target={item.link.kind === 'page' ? item.title : undefined}
        onClick={() => followLink(item.link)}
      >
        {item.title}
      </button>
      <span className="tl-detail truncate" title={item.detail}>{item.detail}</span>
      {item.problem && <span className="badge tl-problem">{item.problem}</span>}
    </div>
  );
}

function OverviewRowView(props: {
  row: OverviewRow;
  largest: number;
  tabIndex: 0 | -1;
  onZoom: (year: number) => void;
}) {
  useLocale();
  const { row, largest, tabIndex, onZoom } = props;
  if (row.type === 'gap') {
    return (
      <div className="tl-gap">
        {row.years === 1
          ? t('1 year with nothing recorded')
          : t('{count} years with nothing recorded', { count: formatNumber(row.years) })}
      </div>
    );
  }
  return (
    <button
      type="button"
      className="tl-bucket"
      data-row-focus
      tabIndex={tabIndex}
      data-bucket={row.from}
      aria-label={
        row.count === 1
          ? t('{label}: 1 item. Zoom in.', { label: row.label })
          : t('{label}: {count} items. Zoom in.', { label: row.label, count: formatNumber(row.count) })
      }
      onClick={() => onZoom(row.from)}
    >
      <span className="tl-bucket-label">{row.label}</span>
      <span className="tl-bucket-main">
        <span className="tl-bucket-bar" style={{ width: `${Math.max(2, (row.count / largest) * 100)}%` }}>
          {TIMELINE_KINDS.map(({ kind }) =>
            row.byKind[kind] ? (
              <span key={kind} className={`tl-kind-${kind} tl-bucket-part`} style={{ flexGrow: row.byKind[kind] }} />
            ) : null,
          )}
        </span>
        <span className="tl-bucket-titles truncate">{row.titles.join(', ')}</span>
      </span>
      <span className="tl-bucket-count">{formatNumber(row.count)}</span>
    </button>
  );
}

function UnplacedRow({ item, tabIndex }: { item: UnplacedItem; tabIndex: 0 | -1 }) {
  useLocale();
  const labelled = t('{label}: {value}', { label: item.detail, value: item.dateText });
  return (
    <div className={`tl-unplaced-item tl-kind-${item.kind}`} data-unplaced-item={item.key}>
      <div className="tl-unplaced-head">
        <span className="tl-title truncate" title={item.title}>{item.title}</span>
        <button
          type="button"
          className="btn btn-sm"
          data-row-focus
          tabIndex={tabIndex}
          aria-label={t('Fix the date of {title}', { title: item.title })}
          onClick={() => followLink(item.link, true)}
        >
          {t('Fix')}
        </button>
      </div>
      <div className="tl-unplaced-date truncate" title={labelled}>
        {item.dateText ? labelled : item.detail}
      </div>
      <div className="tl-unplaced-reason" title={item.reason}>{item.reason}</div>
    </div>
  );
}

function EmptyTimeline() {
  useLocale();
  return (
    <div className="empty-state atlas-empty">
      <h2 className="atlas-empty-title">{t('Nothing on the timeline yet')}</h2>
      <p>
        {t(
          'The timeline builds itself from dates you already keep. Give an event page a date, a character a birth date, a place a founding date, or a scene a story date, and it appears here in order.',
        )}
      </p>
      <div className="atlas-empty-actions">
        <button type="button" className="btn btn-primary" onClick={() => void runCommand('wiki.newPage')}>
          {t('New page')}
        </button>
        <button type="button" className="btn" onClick={() => void openEraSettings()}>
          {t('Era settings')}
        </button>
      </div>
    </div>
  );
}

function FilterBar(props: {
  counts: Partial<Record<TimelineKind, number>>;
  books: { id: string; title: string }[];
  zoomLabel: string;
  canZoomIn: boolean;
  canZoomOut: boolean;
  onZoom: (delta: number) => void;
}) {
  useLocale();
  const { counts, books, zoomLabel, canZoomIn, canZoomOut, onZoom } = props;
  const { hidden, bookId, page, patch } = useTimelineUi();
  const [pageText, setPageText] = useState('');
  const choosePage = (entry: { id: string; title: string }) => {
    patch({ page: { id: entry.id, title: entry.title } });
    setPageText('');
  };
  return (
    <div className="atlas-toolbar" role="group" aria-label={t('Timeline filters')}>
      <div className="atlas-chips" role="group" aria-label={t('Types to show')}>
        {TIMELINE_KINDS.filter(({ kind }) => counts[kind]).map(({ kind, label }) => {
          const showing = !hidden.has(kind);
          return (
            <button
              key={kind}
              type="button"
              className={`chip tl-kind-${kind}${showing ? ' is-on' : ''}`}
              aria-pressed={showing}
              onClick={() => {
                const next = new Set(hidden);
                if (showing) next.add(kind);
                else next.delete(kind);
                patch({ hidden: next });
              }}
            >
              <span className="chip-dot" aria-hidden="true" />
              {label} <span className="chip-count">{formatNumber(counts[kind] ?? 0)}</span>
            </button>
          );
        })}
      </div>
      {books.length > 0 && (
        <select
          className="select"
          aria-label={t('Book')}
          title={t('A book shows its own scenes and the pages they mention')}
          value={bookId}
          onChange={(e) => patch({ bookId: e.target.value })}
        >
          <option value="">{t('All books')}</option>
          {books.map((book) => (
            <option key={book.id} value={book.id}>{book.title}</option>
          ))}
        </select>
      )}
      {page ? (
        <button
          type="button"
          className="chip is-on"
          aria-label={t('Stop filtering by {name}', { name: page.title })}
          title={t('Stop filtering by this page')}
          onClick={() => patch({ page: null })}
        >
          {page.title} <span aria-hidden="true">×</span>
        </button>
      ) : (
        <div className="tl-page-filter">
          <PageAutocomplete
            label={t('Filter by page')}
            placeholder={t('Filter by page')}
            value={pageText}
            onChange={setPageText}
            onPick={choosePage}
            onEnter={(text) => {
              const best = matchTitles(useTitles.getState().entries, text)[0];
              if (best) choosePage(best);
            }}
          />
        </div>
      )}
      <span className="atlas-toolbar-spacer" />
      <div className="tl-zoom" role="group" aria-label={t('Zoom')}>
        <button
          type="button"
          className="btn btn-sm"
          aria-label={t('Zoom out')}
          title={t('Zoom out (Ctrl+wheel)')}
          disabled={!canZoomOut}
          onClick={() => onZoom(-1)}
        >
          −
        </button>
        <span className="tl-zoom-label" role="status">{zoomLabel}</span>
        <button
          type="button"
          className="btn btn-sm"
          aria-label={t('Zoom in')}
          title={t('Zoom in (Ctrl+wheel)')}
          disabled={!canZoomIn}
          onClick={() => onZoom(1)}
        >
          +
        </button>
      </div>
    </div>
  );
}

function stepLabel(step: number | undefined): string {
  if (step === undefined) return t('Every item');
  return step === 1 ? t('Every year') : t('Every {count} years', { count: formatNumber(step) });
}

/** What the overview list is called for screen readers. */
function overviewLabel(step: number | undefined): string {
  if (step === undefined || step === 1) return t('Timeline overview, every year');
  return t('Timeline overview, every {count} years', { count: formatNumber(step) });
}

export function TimelineView(): ReactNode {
  const locale = useLocale();
  const version = useDataVersion('pages', 'pageContent', 'nodes', 'nodeContent', 'books', 'meta', 'extras');
  const isOpen = useProject((s) => s.status.open);
  const { hidden, bookId, page, zoom: chosenZoom, anchorYear, patch } = useTimelineUi();

  const { data, error } = useLoad(async () => {
    if (!isOpen) return null;
    const [sources, dates] = await Promise.all([extras.timelineData(), getDateContext()]);
    return { sources, eras: dates.eras, calendar: dates.calendar };
  }, [version, isOpen]);

  const { data: bookScope } = useLoad(
    () => (bookId ? extras.timelineScope({ bookId }) : Promise.resolve(null)),
    [bookId, version],
  );
  const { data: pageScope } = useLoad(
    () => (page ? extras.timelineScope({ pageId: page.id }) : Promise.resolve(null)),
    [page?.id, version],
  );

  // The labels it gives each date are in the interface language, so a new language rebuilds it.
  const timeline = useMemo(
    () => (data ? assembleTimeline(data.sources, data.eras, data.calendar) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, locale],
  );

  const counts = useMemo(() => {
    const out: Partial<Record<TimelineKind, number>> = {};
    if (timeline) {
      for (const entry of [...timeline.items, ...timeline.unplaced]) {
        out[entry.kind] = (out[entry.kind] ?? 0) + 1;
      }
    }
    return out;
  }, [timeline]);

  const filtered = useMemo(() => {
    if (!timeline) return null;
    const scopes = [bookId ? bookScope : null, page ? pageScope : null]
      .filter((scope): scope is extras.TimelineScope => !!scope)
      .map((scope) => ({ pageIds: new Set(scope.pageIds), sceneIds: new Set(scope.sceneIds) }));
    return filterTimeline(timeline, { hidden, scopes });
  }, [timeline, hidden, bookId, bookScope, page, pageScope]);

  const eras = data?.eras ?? [];
  const items = filtered?.items ?? [];
  const steps = useMemo(() => zoomSteps(items), [items]);
  const openingZoom = items.length > OPEN_ZOOMED_OUT_ABOVE ? 0 : steps.length;
  const zoom = Math.min(chosenZoom ?? openingZoom, steps.length);
  const step = steps[zoom];
  const isDetail = step === undefined;

  const buckets = useMemo(
    () => (isDetail ? [] : overviewRows(items, step, eras)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isDetail, items, step, eras, locale],
  );
  const largest = useMemo(
    () => buckets.reduce((max, row) => (row.type === 'bucket' ? Math.max(max, row.count) : max), 1),
    [buckets],
  );

  const list = useRef<WindowedListHandle>(null);

  const yearAtRow = useCallback(
    (index: number): number | null => {
      if (isDetail) {
        const item = items[index];
        return item ? storyYear(item.sort) : null;
      }
      for (let i = index; i < buckets.length; i += 1) {
        const row = buckets[i];
        if (row?.type === 'bucket') return row.from;
      }
      return null;
    },
    [isDetail, items, buckets],
  );

  const zoomBy = useCallback(
    (delta: number, year?: number | null) => {
      const next = Math.max(0, Math.min(steps.length, zoom + delta));
      if (next === zoom) return;
      const anchor = year ?? yearAtRow(list.current?.topIndex() ?? 0);
      patch({ zoom: next, anchorYear: anchor });
    },
    [steps.length, zoom, yearAtRow, patch],
  );

  // Keeps the same stretch of time in view after zooming, or after coming back to the view.
  useLayoutEffect(() => {
    if (anchorYear === null || !filtered || !list.current) return;
    const index = isDetail
      ? indexOfYear(items, anchorYear)
      : buckets.findIndex((row) => row.type === 'bucket' && row.to > anchorYear);
    if (index >= 0) list.current.scrollToIndex(index);
    patch({ anchorYear: null });
  }, [anchorYear, filtered, isDetail, items, buckets, patch]);

  // Remembers where the list was when leaving, for the back button. A layout effect,
  // because by the time a plain effect is cleaned up the list has already gone.
  const yearOnLeaving = useRef<() => number | null>(() => null);
  yearOnLeaving.current = () => (list.current ? yearAtRow(list.current.topIndex()) : null);
  useLayoutEffect(() => {
    const resetsAtStart = resets;
    return () => {
      // A year from the last project means nothing in the next one.
      if (resets === resetsAtStart) patch({ anchorYear: yearOnLeaving.current() });
    };
  }, [patch]);

  // A filter can outlive its book, which then could never be chosen again to clear it.
  const books = data?.sources.books;
  useEffect(() => {
    if (bookId && books && !books.some((book) => book.id === bookId)) patch({ bookId: '' });
  }, [bookId, books, patch]);

  // Ctrl+wheel needs a listener React cannot make, one that can cancel the page zoom.
  const wheelTime = useRef(0);
  const wheelAction = useRef<(e: WheelEvent) => void>(() => {});
  wheelAction.current = (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const now = performance.now();
    if (now - wheelTime.current < WHEEL_ZOOM_GAP_MS) return;
    wheelTime.current = now;
    const index = list.current?.indexAt(e.clientY) ?? 0;
    zoomBy(e.deltaY < 0 ? 1 : -1, yearAtRow(index));
  };
  const shellRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return undefined;
    const onWheel = (e: WheelEvent) => wheelAction.current(e);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  if (error) {
    return (
      <div className="view-pad">
        <h1 className="view-title">{t('Timeline')}</h1>
        <p className="error-detail">{t('Could not load the timeline: {reason}', { reason: errorMessage(error) })}</p>
      </div>
    );
  }
  if (!timeline || !filtered) {
    return <div className="atlas-view" />;
  }

  const hasAnything = timeline.items.length + timeline.unplaced.length > 0;
  const hasResults = filtered.items.length + filtered.unplaced.length > 0;
  const filtering = hidden.size > 0 || !!bookId || !!page;

  return (
    <div className="atlas-view" data-testid="timeline-view">
      <header className="atlas-header">
        <h1 className="atlas-title">{t('Timeline')}</h1>
        {hasAnything && (
          <p className="atlas-summary" role="status">
            {summaryText(filtered.items.length, filtered.unplaced.length)}
          </p>
        )}
        <span className="atlas-toolbar-spacer" />
        {hasAnything && (
          <button type="button" className="btn btn-sm" onClick={() => void openEraSettings()}>
            {t('Era settings')}
          </button>
        )}
      </header>

      {!hasAnything ? (
        <EmptyTimeline />
      ) : (
        <>
          <FilterBar
            counts={counts}
            books={data?.sources.books ?? []}
            zoomLabel={stepLabel(step)}
            canZoomIn={zoom < steps.length}
            canZoomOut={zoom > 0}
            onZoom={(delta) => zoomBy(delta)}
          />
          {!hasResults ? (
            <div className="empty-state atlas-empty">
              <p>{t('Nothing matches these filters.')}</p>
              {filtering && (
                <div className="atlas-empty-actions">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => patch({ hidden: new Set(), bookId: '', page: null })}
                  >
                    {t('Clear filters')}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="tl-body" ref={shellRef}>
              <div className="tl-main">
                {items.length === 0 ? (
                  <div className="empty-state atlas-empty">
                    <p>{t('Nothing here can be put in order yet. Fix the dates listed alongside.')}</p>
                  </div>
                ) : isDetail ? (
                  <WindowedList
                    key="detail"
                    handle={list}
                    label={t('Timeline, earliest first')}
                    className="tl-list"
                    count={items.length}
                    rowRem={DETAIL_ROW_REM}
                    rowKey={(i) => items[i].key}
                    renderRow={(i, tabIndex) => (
                      <DetailRow item={items[i]} newYear={startsNewYear(items, i)} tabIndex={tabIndex} />
                    )}
                  />
                ) : (
                  <WindowedList
                    key={`overview:${step}`}
                    handle={list}
                    label={overviewLabel(step)}
                    className="tl-list"
                    count={buckets.length}
                    rowRem={OVERVIEW_ROW_REM}
                    isFocusable={(i) => buckets[i]?.type === 'bucket'}
                    renderRow={(i, tabIndex) => (
                      <OverviewRowView
                        row={buckets[i]}
                        largest={largest}
                        tabIndex={tabIndex}
                        onZoom={(year) => zoomBy(1, year)}
                      />
                    )}
                  />
                )}
              </div>
              {filtered.unplaced.length > 0 && (
                <aside className="tl-unplaced" aria-labelledby="tl-unplaced-title" data-testid="timeline-unplaced">
                  <h2 id="tl-unplaced-title" className="tl-unplaced-title">
                    {t('Cannot be placed ({count})', { count: formatNumber(filtered.unplaced.length) })}
                  </h2>
                  <p className="tl-unplaced-intro">
                    {t('These dates cannot be put in order, so they are not on the timeline.')}
                  </p>
                  <WindowedList
                    label={t('Items that cannot be placed')}
                    className="tl-unplaced-list"
                    count={filtered.unplaced.length}
                    rowRem={UNPLACED_ROW_REM}
                    rowKey={(i) => filtered.unplaced[i].key}
                    renderRow={(i, tabIndex) => <UnplacedRow item={filtered.unplaced[i]} tabIndex={tabIndex} />}
                  />
                </aside>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
