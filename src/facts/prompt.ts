/**
 * Infobox facts as a model should read them. Anything that puts facts in a prompt should use
 * this, so that a model never takes a starting value as the truth at a later scene.
 *
 * A page whose fields never change reads as plain `Label: value` lines. Nothing about it
 * varies from scene to scene, so a conversation does not have to send it again.
 */

import {
  ageFactFromFields,
  changeApplies,
  fieldValueAt,
  formatAge,
  formatDeath,
  type AgeFact,
  type FieldChange,
  type StoryMoment,
} from '../lib/facts';
import { formatStoryDate, type DateContext } from '../lib/storyDate';
import type { Infobox, InfoboxField } from '../lib/types';
import { historySteps, historyText, whenOf, type StoryNames } from './history';
import { momentOf, nodeLabel, sceneCount, type StoryIndex } from './storyIndex';

/**
 * A point in the story to report facts at. With no position and no date, the page's whole
 * history is reported instead, which is right for working on the wiki page itself.
 */
export interface PromptMoment extends StoryMoment, StoryNames {
  dates: DateContext;
  /** How this point reads, as in "Chapter 12, Scene 2". */
  label?: string | null;
  /** The in-world date as written. */
  date?: string | null;
  /** Its place in reading order, counted from 1, and how many scenes there are. */
  position?: { scene: number; of: number } | null;
  /** Leave out what happens after this point, under the spoiler limit. */
  omitLater?: boolean;
}

/** A moment for a node, from the story's index. */
export function promptMoment(index: StoryIndex, nodeId: string, options: { omitLater?: boolean } = {}): PromptMoment {
  const moment = momentOf(index, nodeId);
  const date = moment.dateSort !== null && moment.dateSort !== undefined && !moment.dateInferred
    ? index.nodes.get(nodeId)?.storyDate || formatStoryDate(moment.dateSort, index.dates.eras, index.dates.calendar)
    : null;
  return {
    ...moment,
    ...storyNames(index),
    dates: index.dates,
    label: nodeLabel(index, nodeId),
    date,
    position: sceneCount(index, nodeId),
    omitLater: options.omitLater,
  };
}

/** The whole story rather than one point in it. */
export function wholeStoryMoment(index: StoryIndex): PromptMoment {
  return { nodeOrder: null, dateSort: null, ...storyNames(index), dates: index.dates };
}

function storyNames(index: StoryIndex): StoryNames {
  return { resolve: index.resolve, nodeLabel: (id) => nodeLabel(index, id) };
}

function isPointInStory(moment: PromptMoment): boolean {
  return (moment.nodeOrder ?? null) !== null || (moment.dateSort ?? null) !== null;
}

function momentHeading(moment: PromptMoment): string {
  const details = [
    moment.position ? `scene ${moment.position.scene} of ${moment.position.of} in reading order` : '',
    moment.date ? `in-world date ${moment.date}` : '',
  ].filter(Boolean);
  const place = moment.label ?? 'this point in the story';
  return `Facts as of ${place}${details.length > 0 ? ` (${details.join(', ')})` : ''}:`;
}

function changedBefore(field: InfoboxField, applied: FieldChange[], moment: PromptMoment): string {
  const start = field.value.trim();
  const steps = applied.map((change) => {
    const when = whenOf(change, moment.nodeLabel);
    const note = change.note?.trim() ? ` (${change.note.trim()})` : '';
    return `${change.value}${when ? ` from ${when}` : ''}${note}`;
  });
  return [start ? `${start} at first` : '', ...steps].filter(Boolean).join(', then ');
}

/** One field at a moment, on a line. Shows what changed and when, and what is still to come. */
function fieldAtMoment(field: InfoboxField, moment: PromptMoment): string | null {
  const value = fieldValueAt(field, moment, moment.resolve).trim();
  const inOrder = historySteps(field, moment);
  const applied = inOrder.filter(({ change }) => changeApplies(change, moment, moment.resolve)).map((s) => s.change);
  const later = inOrder.filter(({ change, from }) => from && !changeApplies(change, moment, moment.resolve));

  const parts: string[] = [];
  if (value) parts.push(`${field.label}: ${value}.`);
  // Under a spoiler limit, not even that it gets a value later.
  else if (applied.length === 0 && (later.length === 0 || moment.omitLater)) return null;
  else parts.push(`${field.label}: not set yet.`);

  if (applied.length > 0) {
    parts.push(`Changed during the story: ${changedBefore(field, applied, moment)}.`);
  }
  if (later.length > 0 && !moment.omitLater) {
    const steps = later.map(({ change, from }) => `${change.value} ${from}`);
    parts.push(`Later, and not yet true here: ${steps.join(', then ')}.`);
  }
  return parts.join(' ');
}

function ageLine(fact: AgeFact, moment: PromptMoment): string | null {
  switch (fact.state) {
    case 'alive':
      return `Age at this point: ${formatAge(fact.years)}.`;
    case 'dead':
      return `${formatDeath(fact.died, fact.ageAtDeath, moment.dates)}, so not alive at this point.`;
    case 'unborn':
      return `Not born yet at this point (born ${fact.born}).`;
    default:
      return null;
  }
}

/** The lines for a page's facts. See `factsForPrompt`. */
export function factLines(page: { infobox?: Infobox | null }, moment?: PromptMoment | null): string[] {
  const fields = page.infobox?.fields ?? [];
  const changes = (field: InfoboxField) => (field.changes?.length ?? 0) > 0;
  if (!moment) {
    // Nothing to place the changes with, so they are given as written.
    return fields.flatMap((field) => {
      const dated = (field.changes ?? []).map((c) => `${c.value}${c.date ? ` from ${c.date}` : ''}`);
      const all = [field.value.trim(), ...dated].filter(Boolean);
      return all.length > 0 ? [`${field.label}: ${all.join(', then ')}`] : [];
    });
  }
  if (!isPointInStory(moment)) {
    return fields.flatMap((field) => {
      if (!changes(field)) return field.value ? [`${field.label}: ${field.value}`] : [];
      return [`${field.label}: ${historyText(field, moment)}`];
    });
  }

  const fact = ageFactFromFields(fields, moment, moment.resolve, moment.dates);
  const age = ageLine(fact, moment);
  const showing = fields.flatMap((field) => {
    // A worked-out age takes the place of a typed one, which cannot keep up with the story.
    if (field.key === 'age' && age) return [];
    // A death still to come is a later fact like any other.
    if (field.key === 'died' && moment.omitLater && !changes(field) && fact.state !== 'dead') return [];
    if (changes(field)) {
      const line = fieldAtMoment(field, moment);
      return line ? [line] : [];
    }
    return field.value ? [`${field.label}: ${field.value}`] : [];
  });
  const anyChange = fields.some(changes);
  if (!anyChange && !age) return showing;
  return [momentHeading(moment), ...(age ? [age] : []), ...showing];
}

/**
 * A page's infobox as text for a prompt. Given a point in the story, each value is the one
 * true at that point, along with what changed and when, and the character's age there. Given
 * no point, it is the whole history. Empty if the page has no facts.
 */
export function factsForPrompt(page: { infobox?: Infobox | null }, moment?: PromptMoment | null): string {
  return factLines(page, moment).join('\n');
}
