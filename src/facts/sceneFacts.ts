/** Which facts about a person are worth showing beside a scene, as of that scene. */

import {
  ageFactFromFields,
  changeInEffect,
  fieldValueAt,
  formatAge,
  formatDeath,
  type AgeFact,
  type MomentResolver,
  type StoryMoment,
} from '../lib/facts';
import type { DateContext } from '../lib/storyDate';
import type { InfoboxField } from '../lib/types';
import { whenOf, type StoryNames } from './history';

export interface SceneFact {
  key: string;
  label: string;
  value: string;
  /** "since Chapter 10", when a change gave it this value. */
  since: string | null;
}

/** Birth and death are said by the age. A typed age cannot keep up with the story. */
const COVERED_BY_AGE = new Set(['born', 'died', 'age']);
const MAX_FACTS = 6;

/** The facts as of a moment, the ones that have changed first. Long text is left to the page. */
export function keyFacts(fields: InfoboxField[], moment: StoryMoment, names: StoryNames, fact: AgeFact): SceneFact[] {
  const out = fields.flatMap((field): (SceneFact & { changed: boolean })[] => {
    if (field.kind === 'longtext') return [];
    // A typed age is only left out when something better takes its place.
    if (COVERED_BY_AGE.has(field.key) && (field.key !== 'age' || fact.state !== 'unknown')) return [];
    const value = fieldValueAt(field, moment, names.resolve).trim();
    if (!value) return [];
    const change = changeInEffect(field, moment, names.resolve);
    const when = change ? whenOf(change, names.nodeLabel) : null;
    return [{
      key: field.key,
      label: field.label,
      value,
      since: when ? `since ${when}` : null,
      changed: (field.changes?.length ?? 0) > 0,
    }];
  });
  const changedFirst = [...out.filter((f) => f.changed), ...out.filter((f) => !f.changed)];
  return changedFirst.slice(0, MAX_FACTS).map(({ changed: _changed, ...fact_ }) => fact_);
}

/** One line on someone's age at a moment, or null if there is nothing to say. */
export function ageText(
  fields: InfoboxField[],
  moment: StoryMoment,
  resolve: MomentResolver,
  dates: DateContext,
): string | null {
  const fact = ageFactFromFields(fields, moment, resolve, dates);
  switch (fact.state) {
    case 'alive':
      return `Age ${formatAge(fact.years)}`;
    case 'dead':
      return formatDeath(fact.died, fact.ageAtDeath, dates);
    case 'unborn':
      return `Not born yet (born ${fact.born})`;
    default:
      return null;
  }
}
