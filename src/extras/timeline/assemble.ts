/**
 * Builds the timeline from what the project already holds. Nothing is stored: the
 * dates live on pages and scenes. An item whose date cannot be ordered is reported in
 * `unplaced`, never dropped and never guessed at.
 */

import {
  explainStoryDate,
  formatStoryYear,
  parseStoryDate,
  storyYear,
  type Calendar,
  type Era,
} from '../../lib/storyDate';
import { t } from '../../lib/i18n';
import type { InfoboxField } from '../../lib/types';
import type { TimelinePageSource, TimelineSources } from '../api';

export type TimelineKind = 'event' | 'birth' | 'death' | 'founding' | 'dissolution' | 'scene' | 'change' | 'other';

/** Each label is read when shown, so it is in the current interface language. */
export const TIMELINE_KINDS: { kind: TimelineKind; readonly label: string }[] = [
  { kind: 'event', get label() { return t('Events'); } },
  { kind: 'birth', get label() { return t('Births'); } },
  { kind: 'death', get label() { return t('Deaths'); } },
  { kind: 'founding', get label() { return t('Foundings'); } },
  { kind: 'dissolution', get label() { return t('Dissolutions'); } },
  { kind: 'scene', get label() { return t('Scenes'); } },
  { kind: 'change', get label() { return t('Changes'); } },
  { kind: 'other', get label() { return t('Other dates'); } },
];

export type TimelineLink =
  | { kind: 'page'; id: string }
  | { kind: 'scene'; id: string; bookId: string };

export interface TimelineItem {
  key: string;
  kind: TimelineKind;
  title: string;
  /** What the date means, such as "Born" or the chapter a scene is in. */
  detail: string;
  /** The date as written. */
  dateText: string;
  sort: number;
  /** The end of a span. */
  endText?: string;
  endSort?: number;
  /** Something odd about the dates that the writer may want to fix. */
  problem?: string;
  link: TimelineLink;
  bookId?: string;
}

export interface UnplacedItem {
  key: string;
  kind: TimelineKind;
  title: string;
  /** Which date this is, such as "Born". */
  detail: string;
  dateText: string;
  reason: string;
  link: TimelineLink;
  bookId?: string;
}

export interface Timeline {
  items: TimelineItem[];
  unplaced: UnplacedItem[];
}

const SINGLE_DATE_KINDS: Record<string, { kind: TimelineKind; readonly detail: string }> = {
  born: { kind: 'birth', get detail() { return t('Born'); } },
  died: { kind: 'death', get detail() { return t('Died'); } },
  founded: { kind: 'founding', get detail() { return t('Founded'); } },
  dissolved: { kind: 'dissolution', get detail() { return t('Dissolved'); } },
};

const EVENT_KEYS = new Set(['date', 'start', 'end']);

/** Pure page-field values such as `page` kinds are not dates, whatever the key says. */
function holdsDate(field: InfoboxField): boolean {
  return field.kind !== 'page' && field.kind !== 'pages' && field.value.trim() !== '';
}

interface PageOut {
  items: TimelineItem[];
  unplaced: UnplacedItem[];
}

/** The project's dates, with its eras and calendar already applied. */
interface DateReader {
  sort: (text: string) => number | null;
  explain: (text: string) => string;
}

function addEventDates(
  page: TimelinePageSource,
  byKey: Map<string, InfoboxField>,
  hasOtherDates: boolean,
  dates: DateReader,
  out: PageOut,
) {
  const link: TimelineLink = { kind: 'page', id: page.id };
  const unplaced = (field: InfoboxField, fallback: string) =>
    out.unplaced.push({
      key: `${page.id}:${field.key}`,
      kind: 'event',
      title: page.title,
      detail: field.label || fallback,
      dateText: field.value,
      reason: dates.explain(field.value),
      link,
    });
  const sortOf = (field: InfoboxField | undefined) => (field ? dates.sort(field.value) : null);
  const date = byKey.get('date');
  const start = byKey.get('start');
  const end = byKey.get('end');
  const dateSort = sortOf(date);
  const startSort = sortOf(start);
  const endSort = sortOf(end);
  const base = { kind: 'event' as const, title: page.title, link };

  // Anything that cannot be read is listed, whatever else on the page can be placed.
  if (date && dateSort === null) unplaced(date, t('Date'));
  if (start && startSort === null) unplaced(start, t('Start'));
  if (end && endSort === null) unplaced(end, t('End'));

  // A date stands in for a start that is missing or unreadable.
  const opening = start && startSort !== null ? start : date && dateSort !== null ? date : null;
  const openingSort = opening === start ? startSort : dateSort;
  if (opening && openingSort !== null) {
    const item: TimelineItem = {
      ...base,
      key: `${page.id}:${opening.key}`,
      detail: t('Event'),
      dateText: opening.value,
      sort: openingSort,
    };
    if (end && endSort !== null) {
      item.endText = end.value;
      item.endSort = endSort;
      if (endSort < openingSort) item.problem = t('Ends before it starts');
    }
    out.items.push(item);
  } else if (end && endSort !== null) {
    out.items.push({
      ...base,
      key: `${page.id}:end`,
      detail: end.label || t('Ended'),
      dateText: end.value,
      sort: endSort,
    });
  }

  // A date that says something other than the start is a fact of its own.
  if (date && dateSort !== null && opening !== date && dateSort !== startSort) {
    out.items.push({
      ...base,
      key: `${page.id}:date`,
      detail: date.label || t('Date'),
      dateText: date.value,
      sort: dateSort,
    });
  }

  if (!date && !start && !end && !hasOtherDates && page.pageType === 'event') {
    out.unplaced.push({
      key: `${page.id}:none`,
      kind: 'event',
      title: page.title,
      detail: t('Date'),
      dateText: '',
      reason: t('This event has no date yet.'),
      link,
    });
  }
}

function addPage(page: TimelinePageSource, dates: DateReader, out: PageOut) {
  const link: TimelineLink = { kind: 'page', id: page.id };
  const byKey = new Map<string, InfoboxField>();
  const others: InfoboxField[] = [];
  for (const field of page.fields) {
    if (!holdsDate(field)) continue;
    const understood = EVENT_KEYS.has(field.key) || Object.hasOwn(SINGLE_DATE_KINDS, field.key);
    // Nothing stops a page having two fields with one key, and neither may be lost.
    if (understood && !byKey.has(field.key)) byKey.set(field.key, field);
    else if (understood || field.kind === 'date') others.push(field);
  }

  for (const [key, { kind, detail }] of Object.entries(SINGLE_DATE_KINDS)) {
    const field = byKey.get(key);
    if (!field) continue;
    const sort = dates.sort(field.value);
    if (sort === null) {
      out.unplaced.push({
        key: `${page.id}:${key}`,
        kind,
        title: page.title,
        detail: field.label || detail,
        dateText: field.value,
        reason: dates.explain(field.value),
        link,
      });
    } else {
      out.items.push({
        key: `${page.id}:${key}`,
        kind,
        title: page.title,
        detail: field.label || detail,
        dateText: field.value,
        sort,
        link,
      });
    }
  }

  addEventDates(page, byKey, others.length > 0, dates, out);

  others.forEach((field, index) => {
    const sort = dates.sort(field.value);
    const base = {
      key: `${page.id}:other:${index}`,
      kind: 'other' as const,
      title: page.title,
      detail: field.label || field.key,
      dateText: field.value,
      link,
    };
    if (sort === null) out.unplaced.push({ ...base, reason: dates.explain(field.value) });
    else out.items.push({ ...base, sort });
  });
}

/**
 * A fact that changes at a known time gets an entry of its own. A change made in a scene
 * happens on that scene's date, and one with no date to go on is simply not a timeline entry.
 * A date of its own that cannot be read is reported. A scene's already is, under the scene.
 */
function addChanges(page: TimelinePageSource, sceneDates: Map<string, string>, dates: DateReader, out: PageOut) {
  const link: TimelineLink = { kind: 'page', id: page.id };
  page.fields.forEach((field, fieldAt) => {
    (field.changes ?? []).forEach((change, changeAt) => {
      const own = change.date?.trim() ?? '';
      const ofScene = change.nodeId ? (sceneDates.get(change.nodeId) ?? '') : '';
      const base = {
        key: `${page.id}:change:${fieldAt}:${changeAt}`,
        kind: 'change' as const,
        title: page.title,
        detail: t('{label}: {value}', { label: field.label || field.key, value: change.value }),
        link,
      };
      for (const dateText of [own, ofScene]) {
        const sort = dateText ? dates.sort(dateText) : null;
        if (sort !== null) {
          out.items.push({ ...base, dateText, sort });
          return;
        }
      }
      if (own) out.unplaced.push({ ...base, dateText: own, reason: dates.explain(own) });
    });
  });
}

const KIND_ORDER: Record<TimelineKind, number> = {
  birth: 0,
  founding: 1,
  event: 2,
  scene: 3,
  change: 4,
  other: 5,
  dissolution: 6,
  death: 7,
};

export function assembleTimeline(sources: TimelineSources, eras: Era[], calendar?: Calendar | null): Timeline {
  const out: PageOut = { items: [], unplaced: [] };
  const dates: DateReader = {
    sort: (text) => parseStoryDate(text, eras, calendar),
    explain: (text) => explainStoryDate(text, eras, calendar),
  };
  const sceneDates = new Map(sources.scenes.map((scene) => [scene.id, scene.storyDate]));
  for (const page of sources.pages) {
    addPage(page, dates, out);
    addChanges(page, sceneDates, dates, out);
  }

  // Scenes on one date keep their reading order. Remembered by position so a
  // comparison never has to look anything up.
  const sceneOrder = new Map<string, number>();
  for (const scene of sources.scenes) {
    const link: TimelineLink = { kind: 'scene', id: scene.id, bookId: scene.bookId };
    const title = scene.title.trim() || t('Untitled scene');
    const detail = [scene.bookTitle, scene.chapterTitle].filter(Boolean).join(', ');
    const sort = dates.sort(scene.storyDate);
    const key = `scene:${scene.id}`;
    if (sort === null) {
      out.unplaced.push({
        key,
        kind: 'scene',
        title,
        detail,
        dateText: scene.storyDate,
        reason: dates.explain(scene.storyDate),
        link,
        bookId: scene.bookId,
      });
    } else {
      sceneOrder.set(key, scene.order);
      out.items.push({
        key,
        kind: 'scene',
        title,
        detail,
        dateText: scene.storyDate,
        sort,
        link,
        bookId: scene.bookId,
      });
    }
  }

  out.items.sort((a, b) => {
    if (a.sort !== b.sort) return a.sort - b.sort;
    if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (a.kind === 'scene') return (sceneOrder.get(a.key) ?? 0) - (sceneOrder.get(b.key) ?? 0);
    return a.title.localeCompare(b.title);
  });
  out.unplaced.sort((a, b) => a.title.localeCompare(b.title) || a.detail.localeCompare(b.detail));
  return out;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

export interface TimelineFilter {
  /** Kinds to hide. */
  hidden: ReadonlySet<TimelineKind>;
  /** Pages and scenes in scope, when filtering by a page or book. */
  scopes: { pageIds: ReadonlySet<string>; sceneIds: ReadonlySet<string> }[];
}

function inScopes(link: TimelineLink, scopes: TimelineFilter['scopes']): boolean {
  return scopes.every((scope) =>
    link.kind === 'page' ? scope.pageIds.has(link.id) : scope.sceneIds.has(link.id),
  );
}

export function filterTimeline(timeline: Timeline, filter: TimelineFilter): Timeline {
  const keep = (entry: { kind: TimelineKind; link: TimelineLink }) =>
    !filter.hidden.has(entry.kind) && inScopes(entry.link, filter.scopes);
  return { items: timeline.items.filter(keep), unplaced: timeline.unplaced.filter(keep) };
}

// ---------------------------------------------------------------------------
// Rows for display
// ---------------------------------------------------------------------------

/** Whether this item is the first of its year, which the detailed list marks with a rule. */
export function startsNewYear(items: TimelineItem[], index: number): boolean {
  return index === 0 || storyYear(items[index].sort) !== storyYear(items[index - 1].sort);
}

/** The first item in a year or later, or -1. */
export function indexOfYear(items: TimelineItem[], year: number): number {
  return items.findIndex((item) => storyYear(item.sort) >= year);
}

export type OverviewRow =
  | {
      type: 'bucket';
      from: number;
      /** Exclusive. */
      to: number;
      label: string;
      count: number;
      byKind: Partial<Record<TimelineKind, number>>;
      /** The first few titles, to tell buckets apart. */
      titles: string[];
    }
  | { type: 'gap'; years: number };

const NICE_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];
const MIN_OVERVIEW_BUCKETS = 6;
const MAX_OVERVIEW_BUCKETS = 30;
const MAX_LADDER_LEVELS = 3;
const TITLES_PER_BUCKET = 3;
/** Too few items to summarize. */
const MIN_ITEMS_FOR_OVERVIEW = 3;

/**
 * The widths in years to zoom through, widest first. Empty when there is too little to
 * summarize, in which case the detailed list is the whole view. `items` must be in order.
 */
export function zoomSteps(items: TimelineItem[]): number[] {
  if (items.length < MIN_ITEMS_FOR_OVERVIEW) return [];
  const span = storyYear(items[items.length - 1].sort) - storyYear(items[0].sort) + 1;
  const target = Math.min(
    MAX_OVERVIEW_BUCKETS,
    Math.max(MIN_OVERVIEW_BUCKETS, Math.ceil(Math.sqrt(items.length) * 2)),
  );
  const widest =
    NICE_STEPS.find((step) => step * target >= span) ?? NICE_STEPS[NICE_STEPS.length - 1];
  const steps = [widest];
  while (steps.length < MAX_LADDER_LEVELS) {
    const current = steps[steps.length - 1];
    if (current === 1) break;
    const finer = [...NICE_STEPS].reverse().find((step) => step <= current / 5);
    if (finer === undefined) break;
    steps.push(finer);
  }
  return steps;
}

export function overviewRows(items: TimelineItem[], step: number, eras: Era[]): OverviewRow[] {
  const rows: OverviewRow[] = [];
  let current: Extract<OverviewRow, { type: 'bucket' }> | undefined;
  for (const item of items) {
    const year = storyYear(item.sort);
    const from = Math.floor(year / step) * step;
    if (!current || current.from !== from) {
      if (current && from > current.to) rows.push({ type: 'gap', years: from - current.to });
      current = {
        type: 'bucket',
        from,
        to: from + step,
        label:
          step === 1
            ? formatStoryYear(from, eras)
            : t('{start} to {end}', { start: formatStoryYear(from, eras), end: formatStoryYear(from + step - 1, eras) }),
        count: 0,
        byKind: {},
        titles: [],
      };
      rows.push(current);
    }
    current.count += 1;
    current.byKind[item.kind] = (current.byKind[item.kind] ?? 0) + 1;
    if (current.titles.length < TITLES_PER_BUCKET) current.titles.push(item.title);
  }
  return rows;
}

/** How a span reads: "312 to 318". */
export function dateRange(item: TimelineItem): string {
  return item.endText ? t('{start} to {end}', { start: item.dateText, end: item.endText }) : item.dateText;
}
