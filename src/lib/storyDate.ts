/**
 * In-world dates are free text, because every world has its own calendar. To put
 * them in order we derive a number from the common shapes, and return null when
 * we cannot, rather than guess.
 *
 * Understood: "312", "312-04-15", "312/4", "Year 312", "312 AE", "-40", "40 BE",
 * "Third Age 312". Eras come from project settings, as `{ name, offset, negative }`.
 * Read them with `getEras()` wherever dates are put in order.
 *
 * A project can also name its months, as `{ months: [{ name, days }] }`. Then "15 Frostmoot
 * 312", "Frostmoot 312" and "15 Frostmoot 312 AE" are understood too, and sort exactly where
 * "312-04-15" would if Frostmoot is the fourth month. Read both with `getDateContext()`, or
 * just use `getEras()`: the list it returns brings the calendar along, so `parseStoryDate(text,
 * await getEras())` reads the project's months. Pass a calendar, or null, to say otherwise.
 *
 * A project without its own months uses the everyday ones, so "Thursday, October 13, 2022",
 * "13 Oct 2022" and "October 2022" sort exactly where "2022-10-13" would. A weekday in front
 * is left out, and the names can be English or the interface language's.
 */

import * as api from './api';
import { currentLocale, t } from './i18n';

export interface Era {
  /** As written in dates, for example "AE" or "Third Age". Case-insensitive. */
  name: string;
  /** Added to the year so that eras sort correctly against each other. */
  offset: number;
  /** Years count backwards in this era, like BC. */
  negative?: boolean;
}

export interface CalendarMonth {
  name: string;
  /** The month's length. A sort key holds two digits for the day, so 99 at most. */
  days: number;
}

/** A project's own months, in the order they fall in a year. */
export interface Calendar {
  months: CalendarMonth[];
}

/** What it takes to read the project's dates. */
export interface DateContext {
  eras: Era[];
  calendar?: Calendar | null;
}

/** A date taken apart. The year has its era applied. Zero means the month or day is not given. */
export interface StoryDateParts {
  year: number;
  month: number;
  day: number;
}

/** A sort key holds two digits each for the month and the day. */
export const MAX_MONTHS = 99;
export const MAX_MONTH_DAYS = 99;

const calendarsOfEras = new WeakMap<Era[], Calendar>();

// ---- Month and weekday names ---------------------------------------------------------

const EVERYDAY_MONTHS: CalendarMonth[] = (
  [
    ['January', 31], ['February', 29], ['March', 31], ['April', 30], ['May', 31], ['June', 30],
    ['July', 31], ['August', 31], ['September', 30], ['October', 31], ['November', 30], ['December', 31],
  ] as const
).map(([name, days]) => ({ name, days }));

/** Shortenings people write that `Intl` does not give. */
const EXTRA_MONTH_NAMES: [string, number][] = [['sept', 8]];
const EXTRA_WEEKDAY_NAMES = ['tues', 'weds', 'thur', 'thurs'];

/** A name for a month, in lowercase, and which month it is, counting from 0. */
interface MonthName {
  name: string;
  index: number;
}

/** The months a date may name: the project's own, or the everyday ones. */
interface MonthNames {
  months: CalendarMonth[];
  names: MonthName[];
  everyday: boolean;
}

function tidyName(name: string): string {
  return name.replace(/\.$/, '').trim().toLowerCase();
}

/** The names `Intl` gives each month or weekday, long and short, in a language. */
function intlNames(locale: string, kind: 'month' | 'weekday', count: number, dateOf: (i: number) => number): string[][] {
  const out: string[][] = Array.from({ length: count }, () => []);
  const styles: Intl.DateTimeFormatOptions[] =
    kind === 'month'
      ? [{ month: 'long' }, { month: 'short' }, { month: 'long', day: 'numeric' }, { month: 'short', day: 'numeric' }]
      : [{ weekday: 'long' }, { weekday: 'short' }];
  try {
    for (const style of styles) {
      const format = new Intl.DateTimeFormat(locale, { ...style, timeZone: 'UTC' });
      for (let i = 0; i < count; i += 1) {
        const part = format.formatToParts(dateOf(i)).find((p) => p.type === kind)?.value;
        if (part && /\p{L}/u.test(part)) out[i].push(tidyName(part));
      }
    }
  } catch {
    // A language Intl does not know adds no names.
  }
  return out;
}

function everydayLocales(): string[] {
  const locale = currentLocale();
  return locale && !/^en\b/i.test(locale) ? ['en', locale] : ['en'];
}

interface EverydayNames {
  months: MonthNames;
  /** Longest first, so "thursday" is tried before "thu". */
  weekdays: string[];
}

const everydayCache = new Map<string, EverydayNames>();

function everydayNames(): EverydayNames {
  const locales = everydayLocales();
  const key = locales.join('|');
  const cached = everydayCache.get(key);
  if (cached) return cached;
  const monthNames = new Map<string, number>();
  const weekdays = new Set<string>(EXTRA_WEEKDAY_NAMES);
  EVERYDAY_MONTHS.forEach((month, index) => monthNames.set(month.name.toLowerCase(), index));
  for (const [name, index] of EXTRA_MONTH_NAMES) monthNames.set(name, index);
  for (const locale of locales) {
    intlNames(locale, 'month', 12, (i) => Date.UTC(2001, i, 15)).forEach((names, index) => {
      for (const name of names) if (!monthNames.has(name)) monthNames.set(name, index);
    });
    // 7 January 2001 was a Sunday.
    for (const names of intlNames(locale, 'weekday', 7, (i) => Date.UTC(2001, 0, 7 + i))) {
      for (const name of names) weekdays.add(name);
    }
  }
  const result: EverydayNames = {
    months: { months: EVERYDAY_MONTHS, names: [...monthNames].map(([name, index]) => ({ name, index })), everyday: true },
    weekdays: [...weekdays].sort((a, b) => b.length - a.length),
  };
  everydayCache.set(key, result);
  return result;
}

function monthNamesFor(calendar: Calendar | null): MonthNames {
  if (calendar?.months.length) {
    return {
      months: calendar.months,
      names: calendar.months.map((month, index) => ({ name: month.name.toLowerCase(), index })),
      everyday: false,
    };
  }
  return everydayNames().months;
}

/** The text without a weekday in front, as in "Thursday, 13 October 2022", or null if it has none. */
function withoutWeekday(text: string): string | null {
  const lower = text.toLowerCase();
  for (const name of everydayNames().weekdays) {
    if (!lower.startsWith(name)) continue;
    const gap = /^\.?,?\s+/.exec(text.slice(name.length));
    if (gap) return text.slice(name.length + gap[0].length).trim() || null;
  }
  return null;
}

/** The calendar to use: the one given, or the one that came with the eras from `getEras()`. */
export function calendarFor(eras: Era[], calendar?: Calendar | null): Calendar | null {
  return calendar === undefined ? (calendarsOfEras.get(eras) ?? null) : calendar;
}

interface EraSplit {
  era?: Era;
  rest: string;
}

function splitEra(text: string, eras: Era[]): EraSplit {
  const lower = text.toLowerCase();
  for (const candidate of [...eras].sort((a, b) => b.name.length - a.name.length)) {
    const name = candidate.name.toLowerCase();
    if (lower.startsWith(`${name} `)) return { era: candidate, rest: text.slice(name.length).trim() };
    if (lower.endsWith(` ${name}`)) return { era: candidate, rest: text.slice(0, -name.length).trim() };
  }
  return { rest: text };
}

function eraYear(year: number, era: Era | undefined): number {
  if (era?.negative) return era.offset - year;
  return (era?.offset ?? 0) + year;
}

function numericParts(text: string, era: Era | undefined): StoryDateParts | null {
  const match = /^(-?\d+)(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?$/.exec(text.replace(/^year\s+/i, ''));
  if (!match) return null;
  return {
    year: eraYear(Number(match[1]), era),
    month: match[2] ? Number(match[2]) : 0,
    day: match[3] ? Number(match[3]) : 0,
  };
}

const DAY_FIRST = /^(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?/i;
/** "15, 312", or "15 312" when a year follows, so that "Frostmoot 15 AE" is still the year 15. */
const DAY_AFTER_MONTH = /^(\d{1,2})(?:st|nd|rd|th)?(?:\s*,\s*|\s+(?=-?\d))/i;

/** The month a text starts with. A longer name wins, so "Frostmoot" is not read as "Frost". */
function monthAtStart(lower: string, names: MonthName[]): MonthName | null {
  let best: MonthName | null = null;
  for (const candidate of names) {
    if (!lower.startsWith(candidate.name)) continue;
    const after = lower[candidate.name.length];
    if (after !== undefined && !/[\s,.]/.test(after)) continue;
    if (!best || candidate.name.length > best.name.length) best = candidate;
  }
  return best;
}

/** Reads "15 Frostmoot 312", "Frostmoot 312" and "Frostmoot 15, 312", with an era on the year. */
function namedParts(text: string, eras: Era[], names: MonthNames): StoryDateParts | null {
  const lower = text.replace(/\s+/g, ' ').trim().toLowerCase();
  const lead = DAY_FIRST.exec(lower);
  const afterDay = lead ? lower.slice(lead[0].length) : lower;
  const found = monthAtStart(afterDay, names.names);
  if (!found) return null;
  const index = found.index;
  const month = names.months[index];

  let rest = afterDay.slice(found.name.length).replace(/^[\s,.]+/, '');
  let day = lead ? Number(lead[1]) : 0;
  if (!lead) {
    const trailing = DAY_AFTER_MONTH.exec(rest);
    if (trailing) {
      day = Number(trailing[1]);
      if (day === 0) return null;
      rest = rest.slice(trailing[0].length);
    }
  } else if (day === 0) {
    return null;
  }
  if (day > month.days) return null;

  const { era, rest: yearText } = splitEra(rest, eras);
  const year = /^(?:year\s+)?(-?\d+)$/.exec(yearText);
  return year ? { year: eraYear(Number(year[1]), era), month: index + 1, day } : null;
}

/**
 * Takes a date apart, or returns null if it cannot be ordered. Use this rather than the sort
 * key when working out how much time lies between two dates.
 */
export function parseStoryDateParts(
  input: string,
  eras: Era[] = [],
  calendar?: Calendar | null,
): StoryDateParts | null {
  const text = input.trim();
  if (!text) return null;
  const names = monthNamesFor(calendarFor(eras, calendar));
  const parts = partsOf(text, eras, names);
  if (parts) return parts;
  const dated = withoutWeekday(text);
  return dated ? partsOf(dated, eras, names) : null;
}

function partsOf(text: string, eras: Era[], names: MonthNames): StoryDateParts | null {
  const { era, rest } = splitEra(text, eras);
  const numeric = numericParts(rest, era);
  if (numeric) return numeric;
  // A month's name can begin like an era's, so the whole text gets the first try.
  const whole = namedParts(text, eras, names);
  if (whole || !era) return whole;
  const named = namedParts(rest, [], names);
  return named && { ...named, year: eraYear(named.year, era) };
}

/** The sort key for a date taken apart. */
export function sortKeyOf(parts: StoryDateParts): number {
  // Months and days run forward inside a year even when the years count backwards.
  return parts.year + parts.month / 100 + parts.day / 10000;
}

export function parseStoryDate(input: string, eras: Era[] = [], calendar?: Calendar | null): number | null {
  const parts = parseStoryDateParts(input, eras, calendar);
  return parts ? sortKeyOf(parts) : null;
}

/** The year a sort key falls in. Parts of a year always sort above the year itself. */
export function storyYear(sort: number): number {
  return Math.floor(sort);
}

/** Takes a sort key apart again. A sort key holds exactly what a date said. */
export function partsOfSort(sort: number): StoryDateParts {
  const year = storyYear(sort);
  const within = Math.round((sort - year) * 10000);
  return { year, month: Math.floor(within / 100), day: within % 100 };
}

// ---- Time between dates -------------------------------------------------------------

/** A plain year when a project has no calendar: twelve months, none longer than 31 days. */
const PLAIN_MONTHS = 12;
const PLAIN_DAYS = 31;

function yearLength(calendar: Calendar): number {
  return calendar.months.reduce((total, month) => total + month.days, 0);
}

function fitsCalendar(parts: StoryDateParts, calendar: Calendar): boolean {
  const month = calendar.months[parts.month - 1];
  return !!month && parts.day <= month.days;
}

/** How far through its year a date falls, from 0 up to but not including 1. */
function positionInYear(parts: StoryDateParts, useDay: boolean, calendar: Calendar | null, plain: boolean): number {
  const day = useDay ? parts.day - 1 : 0;
  if (calendar) {
    const before = calendar.months.slice(0, parts.month - 1).reduce((total, month) => total + month.days, 0);
    return (before + day) / yearLength(calendar);
  }
  if (plain) return (parts.month - 1 + day / PLAIN_DAYS) / PLAIN_MONTHS;
  // Past anything a calendar we know of holds. This still keeps them in order.
  return (parts.month - 1 + day / (MAX_MONTH_DAYS + 1)) / (MAX_MONTHS + 1);
}

/**
 * Years from one date to another, negative if it runs backwards. It is exact to the coarser
 * of the two dates, so a year alone on either side gives whole years, and it never rounds up
 * past a birthday: 21.99 is still 21 until the day itself.
 */
export function yearsBetween(from: StoryDateParts, to: StoryDateParts, calendar?: Calendar | null): number {
  const whole = to.year - from.year;
  if (from.month === 0 || to.month === 0) return whole;
  const useDay = from.day > 0 && to.day > 0;
  const known = calendar?.months.length && fitsCalendar(from, calendar) && fitsCalendar(to, calendar) ? calendar : null;
  const plain = [from, to].every((d) => d.month <= PLAIN_MONTHS && d.day <= PLAIN_DAYS);
  return whole + positionInYear(to, useDay, known, plain) - positionInYear(from, useDay, known, plain);
}

// ---- Explaining and writing dates ---------------------------------------------------

/** What is wrong with a date that seems to use a calendar month. Null if it does not seem to. */
function explainMonthDate(text: string, eras: Era[], names: MonthNames): string | null {
  const tidy = text.replace(/\s+/g, ' ');
  const lower = tidy.toLowerCase();
  const lead = DAY_FIRST.exec(lower);
  const afterDay = lead ? lower.slice(lead[0].length) : lower;
  const found = monthAtStart(afterDay, names.names);
  if (found) {
    const start = lead ? lead[0].length : 0;
    // An everyday month is named as the writer wrote it, in whatever language that was.
    const month = names.everyday
      ? { ...names.months[found.index], name: tidy.slice(start, start + found.name.length) }
      : names.months[found.index];
    let rest = afterDay.slice(found.name.length).replace(/^[\s,.]+/, '');
    let day = lead ? Number(lead[1]) : 0;
    const trailing = lead ? null : DAY_AFTER_MONTH.exec(rest);
    if (trailing) {
      day = Number(trailing[1]);
      rest = rest.slice(trailing[0].length);
    }
    if (day > month.days || ((lead || trailing) && day === 0)) {
      return month.days === 1
        ? t('{month} has 1 day, so it has no day {day}.', { month: month.name, day })
        : t('{month} has {days} days, so it has no day {day}.', { month: month.name, days: month.days, day });
    }
    if (!/\d/.test(splitEra(rest, eras).rest)) return t('Add a year, as in "{month} 312".', { month: month.name });
    return null;
  }
  if (lead && !names.everyday) {
    const unknown = /^(\S.*?),?\s+(?:year\s+)?-?\d+$/i.exec(tidy.slice(lead[0].length));
    if (unknown) return t('"{name}" is not a month in this project\'s calendar.', { name: unknown[1] });
  }
  return null;
}

/** Says why a date cannot be ordered, in words that lead to a fix, in the interface language. */
export function explainStoryDate(input: string, eras: Era[] = [], calendar?: Calendar | null): string {
  const trimmed = input.trim();
  if (!trimmed) return t('No date is set.');
  const text = withoutWeekday(trimmed) ?? trimmed;
  const months = calendarFor(eras, calendar);
  const hasMonths = !!months?.months.length;
  const problem = explainMonthDate(text, eras, monthNamesFor(months));
  if (problem) return problem;
  const eraLike = /^(\S.*?)\s+-?\d[\d\-/.]*$/.exec(text) ?? /^-?\d[\d\-/.]*\s+(\S.*)$/.exec(text);
  const candidate = eraLike?.[1];
  // Era names are capitalized, which keeps "sometime in 312" out of this message.
  if (candidate && /^\p{Lu}/u.test(candidate) && !/^year$/i.test(candidate)) {
    const known = eras.some((era) => era.name.toLowerCase() === candidate.toLowerCase());
    if (!known) {
      return hasMonths
        ? t('"{name}" is not a known era or month. Add it in era settings, or change the date.', { name: candidate })
        : t('"{name}" is not a known era. Add it in era settings, or change the date.', { name: candidate });
    }
  }
  const named = months?.months[0]?.name;
  return named
    ? t('Not a date that can be put in order. Use a year such as 312, 312-04-15 or 15 {month} 312.', { month: named })
    : t('Not a date that can be put in order. Use a year such as 312 or 312-04-15.');
}

/** Short eras follow the year, as in "312 AE". Longer names lead, as in "Third Age 3". */
function withEraName(year: number | string, era: Era): string {
  return era.name.length <= 4 ? `${year} ${era.name}` : `${era.name} ${year}`;
}

/** The era a year is best written in, and the year as that era counts it. */
function eraForYear(year: number, eras: Era[]): { era: Era; shown: number } | null {
  const forward = eras
    .filter((era) => !era.negative && era.offset <= year)
    .sort((a, b) => b.offset - a.offset)[0];
  if (forward) return { era: forward, shown: year - forward.offset };
  const backward = eras
    .filter((era) => era.negative && era.offset >= year)
    .sort((a, b) => a.offset - b.offset)[0];
  if (backward) return { era: backward, shown: backward.offset - year };
  return null;
}

/** Writes a year the way the project's eras would, or as a plain number without them. */
export function formatStoryYear(year: number, eras: Era[] = []): string {
  const written = eraForYear(year, eras);
  return written ? withEraName(written.shown, written.era) : String(year);
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Writes a sort key as a date, using the project's month names where it can. What this
 * writes reads back to the same sort key.
 */
export function formatStoryDate(sort: number, eras: Era[] = [], calendar?: Calendar | null): string {
  const { year, month, day } = partsOfSort(sort);
  if (month === 0 && day === 0) return formatStoryYear(year, eras);
  const named = calendarFor(eras, calendar)?.months[month - 1];
  if (named && day <= named.days) {
    return `${day > 0 ? `${day} ` : ''}${named.name} ${formatStoryYear(year, eras)}`;
  }
  const within = `-${twoDigits(month)}${day > 0 ? `-${twoDigits(day)}` : ''}`;
  const written = eraForYear(year, eras);
  return written ? withEraName(`${written.shown}${within}`, written.era) : `${year}${within}`;
}

// ---- Settings -----------------------------------------------------------------------

/** Reads stored eras, dropping anything that could not be used to order a date. */
export function parseEras(json: string | null | undefined): Era[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const eras: Era[] = [];
  for (const entry of parsed as Partial<Era>[]) {
    if (!entry || typeof entry.name !== 'string' || !entry.name.trim()) continue;
    const offset = Number(entry.offset ?? 0);
    if (!Number.isFinite(offset)) continue;
    const era: Era = { name: entry.name.trim(), offset };
    if (entry.negative) era.negative = true;
    eras.push(era);
  }
  return eras;
}

/**
 * Reads a stored calendar. It is all or nothing: leaving out one bad month would quietly
 * renumber every month after it, and with that every date in the project.
 */
export function parseCalendar(json: string | null | undefined): Calendar | null {
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const entries = (parsed as Partial<Calendar> | null)?.months;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_MONTHS) return null;
  const months: CalendarMonth[] = [];
  for (const entry of entries as Partial<CalendarMonth>[]) {
    const name = typeof entry?.name === 'string' ? entry.name.replace(/\s+/g, ' ').trim() : '';
    const days = Number(entry?.days);
    if (!/\p{L}/u.test(name) || !Number.isInteger(days) || days < 1 || days > MAX_MONTH_DAYS) return null;
    months.push({ name, days });
  }
  return { months };
}

const ERAS_META_KEY = 'eras';
const CALENDAR_META_KEY = 'calendar';

/** The project's eras. Pass them to `parseStoryDate` wherever dates are put in order. */
export async function getEras(): Promise<Era[]> {
  const [stored, calendar] = await Promise.all([api.project.getMeta(ERAS_META_KEY), getCalendar()]);
  const eras = parseEras(stored);
  if (calendar) calendarsOfEras.set(eras, calendar);
  return eras;
}

export async function setEras(eras: Era[]): Promise<void> {
  await api.project.setMeta(ERAS_META_KEY, JSON.stringify(eras));
}

/** The project's own months, or null if it does not name any. */
export async function getCalendar(): Promise<Calendar | null> {
  return parseCalendar(await api.project.getMeta(CALENDAR_META_KEY));
}

/** Null or no months puts the project back on plain numbered dates. */
export async function setCalendar(calendar: Calendar | null): Promise<void> {
  await api.project.setMeta(CALENDAR_META_KEY, JSON.stringify({ months: calendar?.months ?? [] }));
}

/** The eras and calendar together, to pass to `parseStoryDate`. */
export async function getDateContext(): Promise<DateContext> {
  const eras = await getEras();
  return { eras, calendar: calendarFor(eras) };
}
