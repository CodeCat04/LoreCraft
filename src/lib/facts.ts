/**
 * Facts that change during the story. An infobox field holds its starting value, plus any
 * changes that take effect at a point in the story. Each change names a scene, an in-world
 * date, or both. The AI and the consistency checks ask what was true at a given moment, so
 * "dyed her hair in chapter 10" is not read as a contradiction.
 */

import {
  calendarFor,
  parseStoryDate,
  parseStoryDateParts,
  partsOfSort,
  sortKeyOf,
  yearsBetween,
  type DateContext,
  type StoryDateParts,
} from './storyDate';
import type { InfoboxField } from './types';

export interface FieldChange {
  /** The scene where this becomes true. */
  nodeId?: string | null;
  /** The in-world date when this becomes true, in the project's date format. */
  date?: string | null;
  value: string;
  note?: string;
}

/** A point in the story. Either part can be unknown. */
export interface StoryMoment {
  /** The scene's position in reading order. */
  nodeOrder?: number | null;
  /** A sort key from `parseStoryDate`. */
  dateSort?: number | null;
  /**
   * The date is how far the story has got, not the scene's own. That is enough to say what
   * has happened by then, but not to work out anyone's age.
   */
  dateInferred?: boolean;
}

export interface MomentResolver {
  /** A scene's position in reading order, or null if it no longer exists. */
  nodeOrder: (nodeId: string) => number | null;
  /** A date's sort key, or null if it cannot be ordered. Normally `parseStoryDate`. */
  dateSort: (date: string) => number | null;
  /**
   * A scene's in-world date as a sort key, if known. With this, a change made in a scene
   * happens on that scene's date, so a flashback told later still sees the old value.
   */
  nodeDateSort?: (nodeId: string) => number | null;
}

/** When a change happens in the world: its own date, or else the date of its scene. */
function changeDateSort(change: FieldChange, resolve: MomentResolver): number | null {
  const written = change.date ? resolve.dateSort(change.date) : null;
  if (written !== null) return written;
  return change.nodeId && resolve.nodeDateSort ? resolve.nodeDateSort(change.nodeId) : null;
}

/**
 * Whether a change has happened by a moment. In-world dates are compared when both sides
 * have one, since scenes may be told out of order. Otherwise reading order decides. When
 * neither applies, the change is treated as not having happened.
 */
export function changeApplies(change: FieldChange, moment: StoryMoment, resolve: MomentResolver): boolean {
  const changeDate = changeDateSort(change, resolve);
  if (changeDate !== null && moment.dateSort !== undefined && moment.dateSort !== null) {
    return changeDate <= moment.dateSort;
  }
  const changeOrder = change.nodeId ? resolve.nodeOrder(change.nodeId) : null;
  if (changeOrder !== null && moment.nodeOrder !== undefined && moment.nodeOrder !== null) {
    return changeOrder <= moment.nodeOrder;
  }
  return false;
}

/** Whether anything places a change in the story. One that nothing places never applies. */
export function changeIsPlaced(change: FieldChange, resolve: MomentResolver): boolean {
  return changeDateSort(change, resolve) !== null || (!!change.nodeId && resolve.nodeOrder(change.nodeId) !== null);
}

/** In-world dates decide when both have one, then reading order. Otherwise neither is first. */
function compareChanges(a: FieldChange, b: FieldChange, resolve: MomentResolver): number {
  const dateA = changeDateSort(a, resolve);
  const dateB = changeDateSort(b, resolve);
  if (dateA !== null && dateB !== null && dateA !== dateB) return dateA - dateB;
  const orderA = a.nodeId ? resolve.nodeOrder(a.nodeId) : null;
  const orderB = b.nodeId ? resolve.nodeOrder(b.nodeId) : null;
  if (orderA !== null && orderB !== null) return orderA - orderB;
  return 0;
}

/** A field's changes in story order. Those that nothing places come last, in the order written. */
export function orderedChanges(field: InfoboxField, resolve: MomentResolver): FieldChange[] {
  const changes = field.changes ?? [];
  const placed = changes
    .map((change, index) => ({ change, index }))
    .filter(({ change }) => changeIsPlaced(change, resolve))
    .sort((a, b) => compareChanges(a.change, b.change, resolve) || a.index - b.index)
    .map(({ change }) => change);
  return [...placed, ...changes.filter((change) => !changeIsPlaced(change, resolve))];
}

/** The change that gave a field its value at a moment, or null if it still has its first. */
export function changeInEffect(field: InfoboxField, moment: StoryMoment, resolve: MomentResolver): FieldChange | null {
  const applied = orderedChanges(field, resolve).filter((change) => changeApplies(change, moment, resolve));
  return applied[applied.length - 1] ?? null;
}

/** A field's value at a moment: its latest change by then, or its starting value. */
export function fieldValueAt(field: InfoboxField, moment: StoryMoment, resolve: MomentResolver): string {
  return changeInEffect(field, moment, resolve)?.value ?? field.value;
}

/** Every value a field has held, for checks that accept any of them without a moment. */
export function allFieldValues(field: InfoboxField): string[] {
  const values = [field.value, ...(field.changes ?? []).map((change) => change.value)];
  return [...new Set(values.filter((value) => value.trim() !== ''))];
}

/** Stored changes come from older versions and imports, so nothing about them is assumed. */
export function normalizeChanges(raw: unknown): FieldChange[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const changes: FieldChange[] = [];
  for (const entry of raw as (Partial<FieldChange> | null)[]) {
    if (!entry || typeof entry !== 'object') continue;
    const change: FieldChange = { value: String(entry.value ?? '') };
    if (entry.nodeId) change.nodeId = String(entry.nodeId);
    if (entry.date) change.date = String(entry.date);
    if (entry.note) change.note = String(entry.note);
    changes.push(change);
  }
  return changes.length > 0 ? changes : undefined;
}

/** A resolver's `dateSort` for a project's eras and calendar. */
export function dateResolver(dates: DateContext): MomentResolver['dateSort'] {
  return (date) => parseStoryDate(date, dates.eras, dates.calendar);
}

// ---- Age ----------------------------------------------------------------------------

/** A date as written, or a moment in the story, which has its date only as a sort key. */
export type AgeMoment = string | StoryMoment | null | undefined;

export interface AgeOptions extends Partial<DateContext> {
  /** The death date as written, if any. */
  died?: string | null;
}

export type AgeFact =
  /** Fractional when months and days are known on both dates. */
  | { state: 'alive'; years: number }
  | { state: 'dead'; died: string; ageAtDeath: number | null }
  | { state: 'unborn'; born: string }
  /** The dates cannot be ordered, so there is nothing to say. */
  | { state: 'unknown' };

function partsOfMoment(moment: AgeMoment, options: AgeOptions): StoryDateParts | null {
  if (moment === null || moment === undefined) return null;
  if (typeof moment === 'string') return parseStoryDateParts(moment, options.eras, options.calendar);
  if (moment.dateInferred || moment.dateSort === null || moment.dateSort === undefined) return null;
  return partsOfSort(moment.dateSort);
}

/** What can be said of someone's age at a moment. Never a guess. */
export function ageFactAt(born: string | null | undefined, moment: AgeMoment, options: AgeOptions = {}): AgeFact {
  const { eras = [], died } = options;
  const calendar = calendarFor(eras, options.calendar);
  const at = partsOfMoment(moment, options);
  if (!at) return { state: 'unknown' };
  const birth = born ? parseStoryDateParts(born, eras, calendar) : null;
  const death = died?.trim() ? parseStoryDateParts(died, eras, calendar) : null;
  if (died?.trim() && death && sortKeyOf(death) <= sortKeyOf(at)) {
    return { state: 'dead', died: died.trim(), ageAtDeath: birth ? yearsBetween(birth, death, calendar) : null };
  }
  if (!birth) return { state: 'unknown' };
  const years = yearsBetween(birth, at, calendar);
  return years < 0 ? { state: 'unborn', born: (born ?? '').trim() } : { state: 'alive', years };
}

/**
 * Someone's age at a moment, in years. Null rather than a guess when the dates cannot be
 * ordered, and null once they have died, or before they are born. `ageFactAt` says which.
 */
export function ageAt(born: string | null | undefined, moment: AgeMoment, options: AgeOptions = {}): number | null {
  const fact = ageFactAt(born, moment, options);
  return fact.state === 'alive' ? fact.years : null;
}

/** Ages count in completed years, however close the next birthday is. */
export function formatAge(years: number): string {
  return years < 1 ? 'under a year' : String(Math.floor(years));
}

/** "Died in 312", "Died in Frostmoot 312" or "Died on 15 Frostmoot 312", and how old they were. */
export function formatDeath(died: string, ageAtDeath: number | null, options: Partial<DateContext> = {}): string {
  const parts = parseStoryDateParts(died, options.eras, options.calendar);
  const when = `${parts && parts.day > 0 ? 'on' : 'in'} ${died}`;
  return ageAtDeath !== null && ageAtDeath >= 1 ? `Died ${when}, aged ${Math.floor(ageAtDeath)}` : `Died ${when}`;
}

/** What follows from a page's birth and death dates, as they stand at a moment. */
export function ageFactFromFields(
  fields: InfoboxField[],
  moment: StoryMoment,
  resolve: MomentResolver,
  dates: Partial<DateContext>,
): AgeFact {
  const valueOf = (key: string) => {
    const field = fields.find((f) => f.key === key);
    return field ? fieldValueAt(field, moment, resolve).trim() : '';
  };
  return ageFactAt(valueOf('born'), moment, { ...dates, died: valueOf('died') });
}
