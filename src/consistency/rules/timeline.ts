/**
 * Errors in time. A date that cannot be put in order is never a problem here: every check
 * needs `parseStoryDate` to understand both sides, and says nothing otherwise. Facts that
 * change during the story are read as of the moment in question, through `fieldValueAt`.
 */

import { allFieldValues } from '../../lib/facts';
import { t } from '../../lib/i18n';
import { parseStoryDate } from '../../lib/storyDate';
import { titleKey } from '../../lib/text';
import type { InfoboxField } from '../../lib/types';
import type { Evidence, FindingDraft } from '../types';
import { certainlyBefore, yearsBetween } from './dates';
import { sentencesNaming } from './docText';
import {
  fieldAtScene,
  fieldOf,
  pageEvidence,
  sceneDate,
  sceneEvidence,
  sceneSort,
  sceneTitle,
  statesFacts,
  type World,
  type WorldNode,
  type WorldPage,
} from './world';

function sortOf(world: World, value: string): number | null {
  return value.trim() ? parseStoryDate(value, world.eras) : null;
}

function fieldQuote(field: InfoboxField, value: string): string {
  return `${field.label}: ${value}`;
}

// ---------------------------------------------------------------------------
// Dates on one page
// ---------------------------------------------------------------------------

const DATE_PAIRS: { first: string; second: string; describe: (page: string) => string }[] = [
  { first: 'born', second: 'died', describe: (page) => t('{page} dies before being born', { page }) },
  { first: 'founded', second: 'dissolved', describe: (page) => t('{page} ends before it was founded', { page }) },
  { first: 'start', second: 'end', describe: (page) => t('{page} ends before it begins', { page }) },
];

/** Every value a field has held that can be put in order. */
function orderedValues(world: World, field: InfoboxField): { value: string; sort: number }[] {
  const values: { value: string; sort: number }[] = [];
  for (const value of allFieldValues(field)) {
    const sort = sortOf(world, value);
    if (sort !== null) values.push({ value, sort });
  }
  return values;
}

export function dateOrder(world: World): FindingDraft[] {
  const findings: FindingDraft[] = [];
  for (const page of world.pages) {
    if (!statesFacts(page)) continue;
    for (const pair of DATE_PAIRS) {
      const firstField = fieldOf(page, pair.first);
      const secondField = fieldOf(page, pair.second);
      if (!firstField || !secondField) continue;
      const firsts = orderedValues(world, firstField);
      const seconds = orderedValues(world, secondField);
      if (firsts.length === 0 || seconds.length === 0) continue;
      // With values that changed, any pair that fits means there is no contradiction yet.
      const fits = firsts.some((a) => seconds.some((b) => !certainlyBefore(b.sort, a.sort)));
      if (fits) continue;
      findings.push({
        source: 'rule',
        rule: 'date-order',
        severity: 'error',
        title: pair.describe(page.title),
        detail: t('{second} is earlier than {first} on this page. One of the dates needs to change.', { second: secondField.label, first: firstField.label.toLowerCase() }),
        evidence: [
          pageEvidence(page, fieldQuote(firstField, firsts[0].value)),
          pageEvidence(page, fieldQuote(secondField, seconds[0].value)),
        ],
        fingerprint: `date-order:${page.id}:${pair.first}:${pair.second}`,
      });
    }
  }
  return findings;
}

export function parentOrder(world: World): FindingDraft[] {
  const findings: FindingDraft[] = [];
  for (const child of world.pages) {
    if (!statesFacts(child)) continue;
    const parents = fieldOf(child, 'parents');
    const born = fieldOf(child, 'born');
    if (!parents || !born) continue;
    const childBorn = sortOf(world, born.value);
    if (childBorn === null) continue;
    for (const name of parents.value.split(',')) {
      const parent = world.pageByName.get(titleKey(name));
      if (!parent || !statesFacts(parent)) continue;
      const parentField = fieldOf(parent, 'born');
      const parentBorn = parentField ? sortOf(world, parentField.value) : null;
      if (!parentField || parentBorn === null || !certainlyBefore(childBorn, parentBorn)) continue;
      findings.push({
        source: 'rule',
        rule: 'parent-order',
        severity: 'error',
        title: t('{child} was born before their parent {parent}', { child: child.title, parent: parent.title }),
        detail: t('{child} lists {parent} as a parent, but was born first. One of the dates or the relationship needs to change.', { child: child.title, parent: parent.title }),
        evidence: [
          pageEvidence(child, fieldQuote(born, born.value)),
          pageEvidence(parent, fieldQuote(parentField, parentField.value)),
        ],
        fingerprint: `parent-order:${child.id}:${parent.id}`,
      });
    }
  }
  return findings;
}

/**
 * A child born more than a year after a parent died. A child can be born after a father's
 * death, so a gap under a whole year is let pass.
 */
export function bornAfterParentDied(world: World): FindingDraft[] {
  const findings: FindingDraft[] = [];
  for (const child of world.pages) {
    if (!statesFacts(child)) continue;
    const parents = fieldOf(child, 'parents');
    const born = fieldOf(child, 'born');
    if (!parents || !born) continue;
    const childBorn = sortOf(world, born.value);
    if (childBorn === null) continue;
    for (const name of parents.value.split(',')) {
      const parent = world.pageByName.get(titleKey(name));
      if (!parent || !statesFacts(parent)) continue;
      const diedField = fieldOf(parent, 'died');
      const parentDied = diedField ? sortOf(world, diedField.value) : null;
      if (!diedField || parentDied === null || yearsBetween(parentDied, childBorn) < 2) continue;
      findings.push({
        source: 'rule',
        rule: 'born-after-parent-died',
        severity: 'error',
        title: t('{child} was born after their parent {parent} died', { child: child.title, parent: parent.title }),
        detail: t('{child} lists {parent} as a parent, but was born more than a year after {parent} died. One of the dates or the relationship needs to change.', { child: child.title, parent: parent.title }),
        evidence: [
          pageEvidence(child, fieldQuote(born, born.value)),
          pageEvidence(parent, fieldQuote(diedField, diedField.value)),
        ],
        fingerprint: `born-after-parent-died:${child.id}:${parent.id}`,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// People in scenes
// ---------------------------------------------------------------------------

/** How a page takes part in a scene. Being present is more than being named. */
function presence(page: WorldPage, node: WorldNode): 'pov' | 'cast' | 'named' | null {
  if (node.povPageId === page.id) return 'pov';
  if (node.castPageIds?.includes(page.id)) return 'cast';
  return sentencesNaming(node.content, namesOf(page)).length > 0 ? 'named' : null;
}

function namesOf(page: WorldPage): string[] {
  return [page.title, ...(page.aliases ?? [])];
}

/**
 * Words that show a sentence is about someone gone, which is what a story does with its
 * dead, rather than a mistake. They do not rule out a mistake, so being present still counts.
 */
const REMEMBERING =
  /\b(grave|graves|tomb|tombs|buried|burial|funeral|mourn\w*|grie(?:f|ve\w*)|memor\w*|remember\w*|recall\w*|the late|dead|death|died|dies|killed|slain|ghost\w*|spirit|shade|widow\w*|orphan\w*|legacy|honou?r of|portrait|statue|once|used to|had been|had once|would have|long gone|gone now|lost)\b/i;

export function afterDeath(world: World): FindingDraft[] {
  const findings: FindingDraft[] = [];
  for (const page of world.pages) {
    if (!statesFacts(page)) continue;
    const died = fieldOf(page, 'died');
    if (!died) continue;
    for (const node of world.scenes) {
      const when = sceneSort(world, node);
      if (when === null) continue;
      // Read as of this scene, so a death that is undone later or earlier is respected.
      const value = fieldAtScene(world, died, node);
      const death = sortOf(world, value);
      if (death === null || !certainlyBefore(death, when)) continue;
      const how = presence(page, node);
      if (!how) continue;
      const date = sceneDate(world, node);
      if (how === 'named') {
        const sentences = sentencesNaming(node.content, namesOf(page));
        const plain = sentences.find((sentence) => !REMEMBERING.test(sentence));
        if (!plain) continue;
        findings.push({
          source: 'rule',
          rule: 'after-death',
          severity: 'warning',
          title: t('{page} is named in a scene after their death', { page: page.title }),
          detail: t(
            '{scene} is dated {date}, after {page} died in {died}, and reads as if they are still around. If this is a memory or a report of them, mark it intentional.',
            { scene: sceneTitle(node), date, page: page.title, died: value },
          ),
          evidence: [pageEvidence(page, fieldQuote(died, value)), sceneEvidence(node, plain)],
          fingerprint: `after-death:${page.id}:${node.id}`,
        });
      } else {
        findings.push({
          source: 'rule',
          rule: 'after-death',
          severity: 'error',
          title: t('{page} appears in a scene after their death', { page: page.title }),
          detail:
            how === 'pov'
              ? t('{scene} is dated {date}, after {page} died in {died}, but is told from their point of view.', { scene: sceneTitle(node), date, page: page.title, died: value })
              : t('{scene} is dated {date}, after {page} died in {died}, but lists them in its cast.', { scene: sceneTitle(node), date, page: page.title, died: value }),
          evidence: [
            pageEvidence(page, fieldQuote(died, value)),
            sceneEvidence(node, how === 'pov' ? t('Point of view: {page}, dated {date}', { page: page.title, date }) : t('Cast: {page}, dated {date}', { page: page.title, date })),
          ],
          fingerprint: `after-death:${page.id}:${node.id}`,
        });
      }
    }
  }
  return findings;
}

export function beforeBirth(world: World): FindingDraft[] {
  const findings: FindingDraft[] = [];
  for (const page of world.pages) {
    if (!statesFacts(page)) continue;
    const born = fieldOf(page, 'born');
    if (!born) continue;
    for (const node of world.scenes) {
      const when = sceneSort(world, node);
      if (when === null) continue;
      const value = fieldAtScene(world, born, node);
      const birth = sortOf(world, value);
      if (birth === null || !certainlyBefore(when, birth)) continue;
      // Naming someone before their birth can be a prophecy or a plan. Being there cannot.
      const pov = node.povPageId === page.id;
      if (!pov && !node.castPageIds?.includes(page.id)) continue;
      const date = sceneDate(world, node);
      findings.push({
        source: 'rule',
        rule: 'before-birth',
        severity: 'error',
        title: t('{page} appears in a scene before their birth', { page: page.title }),
        detail: pov
          ? t('{scene} is dated {date}, before {page} was born in {born}, but is told from their point of view.', { scene: sceneTitle(node), date, page: page.title, born: value })
          : t('{scene} is dated {date}, before {page} was born in {born}, but lists them in its cast.', { scene: sceneTitle(node), date, page: page.title, born: value }),
        evidence: [
          pageEvidence(page, fieldQuote(born, value)),
          sceneEvidence(node, pov ? t('Point of view: {page}, dated {date}', { page: page.title, date }) : t('Cast: {page}, dated {date}', { page: page.title, date })),
        ],
        fingerprint: `before-birth:${page.id}:${node.id}`,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Age
// ---------------------------------------------------------------------------

function parseAge(value: string): number | null {
  const match = /^\s*(\d{1,4})(?:\s*(?:years?(?:\s+old)?|yrs?|y\/o))?\s*$/i.exec(value);
  return match ? Number(match[1]) : null;
}

/** A birthday may or may not have passed, so a year either way still fits. */
const AGE_SLACK = 1;

function fits(age: number, born: number, at: number): boolean {
  return Math.abs(yearsBetween(born, at) - age) <= AGE_SLACK;
}

/**
 * An age is a statement about one moment, usually when the page was written or the story
 * begins, and a single value cannot be right in every later scene. So each value of the field
 * is checked against the scenes where it holds, and is only wrong if it fits none of them.
 */
export function ageVsBorn(world: World): FindingDraft[] {
  const findings: FindingDraft[] = [];
  for (const page of world.pages) {
    if (!statesFacts(page)) continue;
    const age = fieldOf(page, 'age');
    const born = fieldOf(page, 'born');
    if (!age || !born) continue;

    const byValue = new Map<string, { node: WorldNode; when: number; birth: number; bornValue: string }[]>();
    for (const node of world.scenes) {
      const when = sceneSort(world, node);
      if (when === null || !presence(page, node)) continue;
      const bornValue = fieldAtScene(world, born, node);
      const birth = sortOf(world, bornValue);
      if (birth === null) continue;
      const value = fieldAtScene(world, age, node);
      if (parseAge(value) === null) continue;
      const list = byValue.get(value) ?? [];
      list.push({ node, when, birth, bornValue });
      byValue.set(value, list);
    }

    for (const [value, scenes] of byValue) {
      const years = parseAge(value) as number;
      if (scenes.some((scene) => fits(years, scene.birth, scene.when))) continue;
      // A change dated when the value was recorded is its own moment.
      const recorded = (age.changes ?? [])
        .filter((change) => change.value === value && change.date)
        .map((change) => parseStoryDate(change.date as string, world.eras));
      if (recorded.some((at) => at !== null && fits(years, scenes[0].birth, at))) continue;

      const first = scenes[0];
      const expected = yearsBetween(first.birth, first.when);
      const date = sceneDate(world, first.node);
      const evidence: Evidence[] = [
        pageEvidence(page, `${fieldQuote(born, first.bornValue)}; ${fieldQuote(age, value)}`),
        sceneEvidence(first.node, t('Story date: {date}', { date })),
      ];
      findings.push({
        source: 'rule',
        rule: 'age-vs-born',
        severity: 'error',
        title: t("{page}'s age does not fit their birth date", { page: page.title }),
        detail: t(
          'Born in {born}, {page} would be about {expected} in {scene} ({date}), not {age}. If the age changes during the story, add that as a change on the field.',
          { born: first.bornValue, page: page.title, expected, scene: sceneTitle(first.node), date, age: value },
        ),
        evidence,
        fingerprint: `age-vs-born:${page.id}:${value.trim()}`,
      });
    }
  }
  return findings;
}
