/**
 * Which lore a scene is checked against, and how it reads at that moment in the story. Canon
 * is fact and draft is tentative. An idea is not fact and a retcon is no longer true, so
 * neither goes to the model, and it cannot find a contradiction with them.
 */

import { canSendTo } from '../../ai/limits/localOnly';
import { pmToPlainText } from '../../editor/convert';
import { fieldValueAt, type StoryMoment } from '../../lib/facts';
import { titleKey } from '../../lib/text';
import type { InfoboxField } from '../../lib/types';
import { namesInText, textBlocks } from '../rules/docText';
import { isNodeLocalOnly, statesFacts, type World, type WorldNode, type WorldPage } from '../rules/world';

/** A field's earlier and later values, for a model reading it at one moment. */
function historyLine(world: World, field: InfoboxField, cloud: boolean): string {
  const changes = (field.changes ?? []).filter((change) => change.value.trim() || change.date || change.nodeId);
  if (changes.length === 0) return '';
  const steps = changes.map((change) => {
    const node = change.nodeId ? world.nodeById.get(change.nodeId) : undefined;
    // A local-only scene's title stays here too.
    const scene = node && usableScene(world, node, cloud) ? node.title : '';
    const when = [change.date, scene ? `the scene "${scene}"` : ''].filter(Boolean).join(', ');
    return `${change.value.trim() || 'nothing'}${when ? ` from ${when}` : ''}${change.note ? ` (${change.note})` : ''}`;
  });
  return `${field.label} changes during the story: first ${field.value.trim() || 'nothing'}, then ${steps.join(', then ')}.`;
}

/**
 * A page as the model reads it at a moment, which is also what its quotes are checked against.
 * Without a moment, each field shows its starting value and its history.
 */
export function renderPage(world: World, page: WorldPage, moment: StoryMoment | null, cloud = false): string {
  const lines: string[] = [];
  if (page.aliases?.length) lines.push(`Also known as: ${page.aliases.join(', ')}`);
  if (page.summary?.trim()) lines.push(`Summary: ${page.summary.trim()}`);
  for (const field of page.infobox?.fields ?? []) {
    const value = moment ? fieldValueAt(field, moment, world.resolver) : field.value;
    if (value.trim()) lines.push(`${field.label}: ${value.trim()}`);
    const history = historyLine(world, field, cloud);
    if (history) lines.push(history);
  }
  const body = pmToPlainText(page.content);
  if (body) lines.push(body);
  return lines.join('\n');
}

/** Everything a page says, at any moment. For checking that an old quote still stands. */
export function everythingOnPage(world: World, page: WorldPage): string {
  const parts = [renderPage(world, page, null)];
  for (const field of page.infobox?.fields ?? []) {
    for (const change of field.changes ?? []) {
      if (change.value.trim()) parts.push(`${field.label}: ${change.value.trim()}`);
    }
  }
  return parts.join('\n');
}

function namesOf(page: WorldPage): string[] {
  return [page.title, ...(page.aliases ?? [])];
}

/** Words in many titles, which say nothing about which page is meant. */
const TITLE_WORDS = new Set([
  'the', 'and', 'for', 'lord', 'lady', 'king', 'queen', 'prince', 'princess', 'sir', 'dame', 'duke', 'duchess', 'captain',
  'master', 'mistress', 'house', 'city', 'town', 'old', 'new', 'great', 'high', 'first', 'last',
]);

function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}'’]+/u)
    .map((word) => word.replace(/['’]s?$/, ''))
    .filter((word) => word.length >= 3 && !TITLE_WORDS.has(word));
}

/**
 * The page a claim's subject means: by its whole name, or one named inside it ("Aria's left
 * hand"), or the one page with this word in its title ("Bram" for "Bram Tollan"). More than one
 * candidate means no answer, since guessing could compare two different people.
 */
export function subjectPage(world: World, subject: string): WorldPage | undefined {
  const exact = world.pageByName.get(titleKey(subject));
  if (exact) return exact;
  let best: WorldPage | undefined;
  let bestLength = 0;
  for (const page of world.pages) {
    if (page.isHome) continue;
    for (const name of namesOf(page)) {
      if (name.length > bestLength && name.length >= 3 && namesInText(subject, name)) {
        best = page;
        bestLength = name.length;
      }
    }
  }
  if (best) return best;
  const words = new Set(wordsOf(subject));
  if (words.size === 0) return undefined;
  const matches = world.pages.filter((page) => !page.isHome && wordsOf(page.title).some((word) => words.has(word)));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Pages that may go to this model. */
export function usablePage(page: WorldPage, cloud: boolean): boolean {
  return canSendTo({ isCloud: cloud }, page);
}

/** A scene inside a local-only chapter or part counts as local only too. */
export function usableScene(world: World, node: WorldNode, cloud: boolean): boolean {
  return canSendTo({ isCloud: cloud }, { localOnly: isNodeLocalOnly(world, node) });
}

/**
 * The pages a scene should be checked against, most relevant first: who and where the scene
 * says it is about, then what it links to, then what it names, then what its claims are about.
 */
export function pagesForScene(world: World, node: WorldNode, subjects: string[], cloud: boolean): WorldPage[] {
  const chosen = new Map<string, WorldPage>();
  const add = (page: WorldPage | undefined) => {
    if (page && statesFacts(page) && !page.isHome && usablePage(page, cloud)) chosen.set(page.id, page);
  };
  if (node.povPageId) add(world.pageById.get(node.povPageId));
  for (const id of node.castPageIds ?? []) add(world.pageById.get(id));
  if (node.locationPageId) add(world.pageById.get(node.locationPageId));
  for (const block of textBlocks(node.content)) {
    for (const link of block.links) add(world.pageByName.get(titleKey(link.target)));
  }
  const text = pmToPlainText(node.content);
  for (const page of world.pages) {
    if (namesOf(page).some((name) => namesInText(text, name))) add(page);
  }
  for (const subject of subjects) add(subjectPage(world, subject));
  return [...chosen.values()];
}

/** The canon pages a wiki page should agree with: those it links to, names or makes claims about. */
export function pagesForPage(world: World, page: WorldPage, subjects: string[], cloud: boolean): WorldPage[] {
  const chosen = new Map<string, WorldPage>();
  const add = (other: WorldPage | undefined) => {
    if (other && other.id !== page.id && other.status === 'canon' && !other.isHome && usablePage(other, cloud)) chosen.set(other.id, other);
  };
  for (const block of textBlocks(page.content)) {
    for (const link of block.links) add(world.pageByName.get(titleKey(link.target)));
  }
  for (const field of page.infobox?.fields ?? []) {
    if (field.kind === 'page' || field.kind === 'pages') {
      for (const name of field.value.split(',')) add(world.pageByName.get(titleKey(name)));
    }
  }
  const text = renderPage(world, page, null, cloud);
  for (const other of world.pages) {
    if (namesOf(other).some((name) => namesInText(text, name))) add(other);
  }
  for (const subject of subjects) add(subjectPage(world, subject));
  return [...chosen.values()];
}

/** A short stable fingerprint of some text, with its length to make a clash less likely. */
export function contentHash(text: string, salt = ''): string {
  let hash = 0x811c9dc5;
  const value = `${salt}\u0000${text}`;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(36)}-${value.length.toString(36)}`;
}
