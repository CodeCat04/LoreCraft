/** Names that could be confused: near-duplicates, and one name used by two pages. */

import { t } from '../../lib/i18n';
import { titleKey } from '../../lib/text';
import type { FindingDraft } from '../types';
import { pageEvidence, type World, type WorldPage } from './world';

/** Lower case, no accents, no leading article, only letters, digits and single spaces. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^(the|a|an) /, '');
}

/** Edit distance with swaps counted as one, stopping early once past `limit`. */
export function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let before: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, before[j - 2] + 1);
      }
      current[j] = value;
      if (value < best) best = value;
    }
    if (best > limit) return limit + 1;
    before = previous;
    previous = current;
  }
  return previous[b.length];
}

const DIRECTIONS = /^(north|south|east|west|upper|lower|inner|outer|high|low|old|new)/;

/** Whether two different names are close enough to be a slip rather than a choice. */
export function namesLookAlike(left: string, right: string): boolean {
  return normalizedLookAlike(normalizeName(left), normalizeName(right));
}

function normalizedLookAlike(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  if (shorter < 4) return false;
  // "Book 1" and "Book 2" differ on purpose.
  if (a.replace(/\p{N}/gu, '') === b.replace(/\p{N}/gu, '')) return false;
  // So do a thing and several of them.
  if (a === `${b}s` || b === `${a}s`) return false;
  const distance = editDistance(a, b, 2);
  if (distance <= 1) return true;
  if (distance > 2) return false;
  // Two letters apart only counts in long single words that begin and end alike.
  if (shorter < 8 || a.includes(' ') || b.includes(' ')) return false;
  if (a[0] !== b[0] || a[a.length - 1] !== b[b.length - 1]) return false;
  return !(DIRECTIONS.test(a) && DIRECTIONS.test(b));
}

function namesOf(page: WorldPage): string[] {
  return [page.title, ...(page.aliases ?? [])];
}

/** Pages whose names matter here. Retconned ones are no longer part of the world. */
function namedPages(world: World): WorldPage[] {
  return world.pages.filter((page) => page.status !== 'retconned' && !page.isHome);
}

/**
 * Every way of removing up to `depth` letters from a word. Two words within that many edits share
 * one, which finds the close pairs without comparing every name with every other.
 */
function deletions(word: string, depth: number): Set<string> {
  const out = new Set<string>([word]);
  let current = [word];
  for (let step = 0; step < depth; step += 1) {
    const next: string[] = [];
    for (const item of current) {
      for (let i = 0; i < item.length; i += 1) {
        const shorter = item.slice(0, i) + item.slice(i + 1);
        if (!out.has(shorter)) {
          out.add(shorter);
          next.push(shorter);
        }
      }
    }
    current = next;
  }
  return out;
}

export function similarNames(world: World): FindingDraft[] {
  const pages = namedPages(world);
  // Titles come first, so a pair of titles is what gets reported for a pair of pages.
  const entries = pages
    .flatMap((page) => namesOf(page).map((name, index) => ({ page, name, isTitle: index === 0, key: titleKey(name), norm: normalizeName(name) })))
    .filter((entry) => entry.norm.length >= 4)
    .sort((a, b) => Number(b.isTitle) - Number(a.isTitle));

  // Only long single words can be two edits apart and still count.
  const buckets = new Map<string, number[]>();
  entries.forEach((entry, index) => {
    const depth = entry.norm.length >= 8 && !entry.norm.includes(' ') ? 2 : 1;
    for (const variant of deletions(entry.norm, depth)) {
      const bucket = buckets.get(variant);
      if (bucket) bucket.push(index);
      else buckets.set(variant, [index]);
    }
  });

  const closest = new Map<string, { left: WorldPage; right: WorldPage; a: string; b: string }>();
  const compared = new Set<string>();
  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const pair = `${bucket[i]}:${bucket[j]}`;
        if (compared.has(pair)) continue;
        compared.add(pair);
        const one = entries[bucket[i]];
        const other = entries[bucket[j]];
        if (one.page.id === other.page.id) continue;
        // The same name exactly is the job of `sharedAliases`.
        if (one.key === other.key) continue;
        if (!normalizedLookAlike(one.norm, other.norm)) continue;
        const [left, right, a, b] =
          one.page.id < other.page.id
            ? [one.page, other.page, one.name, other.name]
            : [other.page, one.page, other.name, one.name];
        const key = `${left.id}:${right.id}`;
        const existing = closest.get(key);
        // The earliest entries in the list are the titles, which read best.
        if (!existing || (existing.a !== left.title && a === left.title && b === right.title)) closest.set(key, { left, right, a, b });
      }
    }
  }

  return [...closest.values()].map(({ left, right, a, b }) => ({
    source: 'rule',
    rule: 'similar-names',
    severity: 'warning',
    title: t('"{a}" and "{b}" look alike', { a, b }),
    detail: t(
      '{left} and {right} are separate pages with nearly the same name, so readers and the AI can mix them up. If this is one character or place, merge the pages. If the names are meant to be close, mark this intentional.',
      { left: left.title, right: right.title },
    ),
    evidence: [pageEvidence(left, a), pageEvidence(right, b)],
    fingerprint: `similar-names:${left.id}:${right.id}`,
  }));
}

export function sharedAliases(world: World): FindingDraft[] {
  const pages = namedPages(world);
  const byKey = new Map<string, { page: WorldPage; name: string; isTitle: boolean }[]>();
  for (const page of pages) {
    const seen = new Set<string>();
    for (const name of namesOf(page)) {
      const key = titleKey(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const uses = byKey.get(key) ?? [];
      uses.push({ page, name, isTitle: titleKey(page.title) === key });
      byKey.set(key, uses);
    }
  }
  const findings: FindingDraft[] = [];
  for (const [key, uses] of byKey) {
    if (uses.length < 2) continue;
    const titled = uses.find((use) => use.isTitle);
    const name = uses[0].name;
    findings.push({
      source: 'rule',
      rule: 'shared-alias',
      severity: 'warning',
      title: t('"{name}" is used by {count} pages', { name, count: uses.length }),
      detail: titled
        ? t('A link to "{name}" always goes to the page with that title, {page}. Remove the alias from the other page, or rename one of them.', { name, page: titled.page.title })
        : t('A link to "{name}" can only go to one of these pages. Remove the alias from all but one.', { name }),
      evidence: uses.map((use) => pageEvidence(use.page, use.isTitle ? `Title: ${use.name}` : `Also known as: ${use.name}`)),
      fingerprint: `shared-alias:${key}`,
    });
  }
  return findings;
}
