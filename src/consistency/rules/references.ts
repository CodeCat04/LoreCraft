/** Things that point somewhere: scene details, wiki links and infobox fields. */

import { allFieldValues } from '../../lib/facts';
import { t } from '../../lib/i18n';
import { titleKey } from '../../lib/text';
import type { InfoboxField } from '../../lib/types';
import type { FindingDraft } from '../types';
import { sentenceAround, textBlocks } from './docText';
import { pageEvidence, sceneEvidence, sceneTitle, type World, type WorldPage } from './world';

// ---------------------------------------------------------------------------
// Scene details
// ---------------------------------------------------------------------------

export function missingReferences(world: World): FindingDraft[] {
  const findings: FindingDraft[] = [];
  for (const node of world.nodes) {
    const add = (pageId: string, field: 'pov' | 'location' | 'cast') => {
      const scene = sceneTitle(node);
      // Whole sentences for each detail, since the words around it change with it in other languages.
      const text = {
        pov: {
          title: t('{scene} has a point of view that no longer exists', { scene }),
          detail: t("The page set as this scene's point of view has been deleted. Restore it from the trash, or choose another in the scene details."),
          quote: t('Point of view: a deleted page'),
        },
        location: {
          title: t('{scene} has a location that no longer exists', { scene }),
          detail: t("The page set as this scene's location has been deleted. Restore it from the trash, or choose another in the scene details."),
          quote: t('Location: a deleted page'),
        },
        cast: {
          title: t('{scene} has a cast member that no longer exists', { scene }),
          detail: t("The page set as this scene's cast member has been deleted. Restore it from the trash, or choose another in the scene details."),
          quote: t('Cast member: a deleted page'),
        },
      }[field];
      findings.push({
        source: 'rule',
        rule: 'missing-reference',
        severity: 'warning',
        title: text.title,
        detail: text.detail,
        evidence: [sceneEvidence(node, text.quote)],
        fingerprint: `missing-reference:${node.id}:${field}:${pageId}`,
      });
    };
    if (node.povPageId && !world.pageById.has(node.povPageId)) add(node.povPageId, 'pov');
    if (node.locationPageId && !world.pageById.has(node.locationPageId)) add(node.locationPageId, 'location');
    for (const pageId of node.castPageIds ?? []) {
      if (!world.pageById.has(pageId)) add(pageId, 'cast');
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Wiki links
// ---------------------------------------------------------------------------

export function brokenLinks(world: World): FindingDraft[] {
  const findings: FindingDraft[] = [];
  const check = (kind: 'page' | 'node', id: string, doc: Parameters<typeof textBlocks>[0], make: (quote: string) => FindingDraft['evidence'][number]) => {
    const seen = new Set<string>();
    for (const block of textBlocks(doc)) {
      for (const link of block.links) {
        const key = titleKey(link.target);
        if (!key || seen.has(key) || world.pageByName.has(key)) continue;
        seen.add(key);
        findings.push({
          source: 'rule',
          rule: 'broken-link',
          severity: 'info',
          title: t('Link to "{target}", which has no page', { target: link.target.trim() }),
          detail: t('This is fine if the page is still to be written, or if a page by that name is in the trash. Otherwise, correct the link.'),
          evidence: [make(sentenceAround(block.text, link.from, link.to))],
          fingerprint: `broken-link:${kind}:${id}:${key}`,
        });
      }
    }
  };
  for (const page of world.pages) {
    // A retconned page's links are not part of the world.
    if (page.status !== 'retconned') check('page', page.id, page.content, (quote) => pageEvidence(page, quote));
  }
  for (const node of world.scenes) {
    check('node', node.id, node.content, (quote) => sceneEvidence(node, quote));
  }
  return findings;
}

/** The titles an infobox field names: its current value and any it held before. */
function fieldTargets(field: InfoboxField): string[] {
  const targets = new Set<string>();
  for (const value of allFieldValues(field)) {
    const names = field.kind === 'pages' ? value.split(',') : [value];
    for (const name of names) {
      if (name.trim()) targets.add(name.trim());
    }
  }
  return [...targets];
}

function linkFields(page: WorldPage): InfoboxField[] {
  return (page.infobox?.fields ?? []).filter((field) => field.kind === 'page' || field.kind === 'pages');
}

export function brokenFieldLinks(world: World): FindingDraft[] {
  const findings: FindingDraft[] = [];
  for (const page of world.pages) {
    if (page.status === 'retconned') continue;
    for (const field of linkFields(page)) {
      for (const target of fieldTargets(field)) {
        const key = titleKey(target);
        if (world.pageByName.has(key)) continue;
        findings.push({
          source: 'rule',
          rule: 'broken-field-link',
          severity: 'warning',
          title: t('{page}\'s {field} points to "{target}", which has no page', { page: page.title, field: field.label.toLowerCase(), target }),
          detail: t('Correct the field, create the page, or restore it from the trash.'),
          evidence: [pageEvidence(page, `${field.label}: ${target}`)],
          fingerprint: `broken-field-link:${page.id}:${field.key}:${key}`,
        });
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Retconned pages
// ---------------------------------------------------------------------------

/** A canon page can talk about something being retconned, as long as it says so. */
const NOT_AS_FACT =
  /\b(retcon\w*|formerly|no longer|once (?:believed|thought|said)|previously|was thought|were thought|superseded|replaced|disproved|debunked|discredited|apocryphal|myth\w*|legend\w*|rumou?r\w*|false|falsely|mistaken\w*|earlier drafts?)\b/i;

export function retconnedLinks(world: World): FindingDraft[] {
  const findings: FindingDraft[] = [];
  for (const page of world.pages) {
    if (page.status !== 'canon') continue;
    const seen = new Set<string>();
    const add = (target: WorldPage, quote: string) => {
      if (seen.has(target.id) || target.id === page.id) return;
      seen.add(target.id);
      findings.push({
        source: 'rule',
        rule: 'retconned-link',
        severity: 'warning',
        title: t('{page} treats {target} as fact, but it is retconned', { page: page.title, target: target.title }),
        detail: t("{page} is canon and refers to {target} as if it still holds. Update this page, or restore the other page's status if the retcon has been dropped.", { page: page.title, target: target.title }),
        evidence: [pageEvidence(page, quote), pageEvidence(target, target.summary || `Status: retconned`)],
        fingerprint: `retconned-link:${page.id}:${target.id}`,
      });
    };
    for (const block of textBlocks(page.content)) {
      for (const link of block.links) {
        const target = world.pageByName.get(titleKey(link.target));
        if (target?.status !== 'retconned') continue;
        const sentence = sentenceAround(block.text, link.from, link.to);
        if (!NOT_AS_FACT.test(sentence)) add(target, sentence);
      }
    }
    for (const field of linkFields(page)) {
      for (const name of fieldTargets(field)) {
        const target = world.pageByName.get(titleKey(name));
        if (target?.status === 'retconned') add(target, `${field.label}: ${name}`);
      }
    }
  }
  return findings;
}
