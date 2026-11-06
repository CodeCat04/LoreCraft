/** Puts a field's changes into words, for the infobox and for the AI. */

import { orderedChanges, type FieldChange, type MomentResolver } from '../lib/facts';
import type { InfoboxField } from '../lib/types';

export interface StoryNames {
  resolve: MomentResolver;
  /** How a scene reads in a sentence, or null if it no longer exists. */
  nodeLabel: (nodeId: string) => string | null;
}

/** When a change happens, as in "Chapter 10" or "15 Frostmoot 312". Null if nothing says. */
export function whenOf(change: FieldChange, nodeLabel: StoryNames['nodeLabel']): string | null {
  const scene = change.nodeId ? nodeLabel(change.nodeId) : null;
  const date = change.date?.trim() || null;
  if (scene && date) return `${scene} (${date})`;
  return scene ?? date;
}

export interface HistoryStep {
  change: FieldChange;
  /** "from Chapter 10", or null if nothing places the change in the story. */
  from: string | null;
}

/** The changes in story order, each with when it happens. */
export function historySteps(field: InfoboxField, names: StoryNames): HistoryStep[] {
  return orderedChanges(field, names.resolve).map((change) => {
    const when = whenOf(change, names.nodeLabel);
    return { change, from: when ? `from ${when}` : null };
  });
}

/**
 * The whole history in one line, as in "blonde, then black from Chapter 10". A field that
 * starts empty begins with its first change.
 */
export function historyText(field: InfoboxField, names: StoryNames): string {
  const start = field.value.trim();
  const steps = historySteps(field, names).map(({ change, from }) => {
    const note = change.note?.trim() ? ` (${change.note.trim()})` : '';
    return `${change.value}${from ? ` ${from}` : ' (not yet placed in the story)'}${note}`;
  });
  const [first, ...rest] = start ? [start, ...steps] : steps;
  return [first ?? '', ...rest.map((step) => `then ${step}`)].filter(Boolean).join(', ');
}
