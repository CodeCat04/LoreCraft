/** Choosing a page by name: used by `[[` in the editor and by the wiki's title fields. */

import { titleKey } from '../lib/text';
import type { TitleEntry } from '../lib/types';

export interface TitleMatch {
  entry: TitleEntry;
  /** Set when the query matched another name for the page rather than its title. */
  alias: string | null;
}

/** Compares names ignoring case, spacing and accents, so "eowyn" finds "Éowyn". */
export function foldName(name: string): string {
  return titleKey(name).normalize('NFD').replace(/\p{M}+/gu, '');
}

interface FoldedNames {
  title: string;
  aliases: string[];
}

// The list holds every page and is searched per keystroke. Entries are replaced when
// titles refresh, so this cannot go stale.
const foldedNames = new WeakMap<TitleEntry, FoldedNames>();

function foldedOf(entry: TitleEntry): FoldedNames {
  let folded = foldedNames.get(entry);
  if (!folded) {
    folded = { title: foldName(entry.title), aliases: entry.aliases.map(foldName) };
    foldedNames.set(entry, folded);
  }
  return folded;
}

/** Lower is better. Null means no match. */
function nameScore(name: string, query: string): number | null {
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(` ${query}`)) return 2;
  if (name.includes(query)) return 3;
  return null;
}

export function rankTitles(query: string, entries: TitleEntry[], limit = 8): TitleMatch[] {
  const q = foldName(query);
  if (!q) return entries.slice(0, limit).map((entry) => ({ entry, alias: null }));

  const scored: { match: TitleMatch; score: number }[] = [];
  for (const entry of entries) {
    const folded = foldedOf(entry);
    const titleScore = nameScore(folded.title, q);
    let score = titleScore === null ? null : titleScore * 2;
    let alias: string | null = null;
    folded.aliases.forEach((name, index) => {
      const aliasScore = nameScore(name, q);
      // A title beats an alias that matches equally well.
      if (aliasScore !== null && (score === null || aliasScore * 2 + 1 < score)) {
        score = aliasScore * 2 + 1;
        alias = entry.aliases[index];
      }
    });
    if (score !== null) scored.push({ match: { entry, alias }, score });
  }
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      a.match.entry.title.length - b.match.entry.title.length ||
      a.match.entry.title.localeCompare(b.match.entry.title),
  );
  return scored.slice(0, limit).map((s) => s.match);
}

/** True when `query` is exactly the title or another name of a listed page. */
export function isKnownName(query: string, entries: TitleEntry[]): boolean {
  const q = foldName(query);
  return entries.some((entry) => {
    const folded = foldedOf(entry);
    return folded.title === q || folded.aliases.includes(q);
  });
}

export interface LinkQuery {
  /** Where the opening brackets begin, in the text before the cursor. */
  start: number;
  /** How far the link's syntax reaches past the cursor. */
  trailing: number;
  /** The page being searched for. */
  query: string;
  /** Text to show for the link instead of the page's name. */
  label: string | null;
}

/** Longer than any page name. Stops a stray `[[` from taking over a whole paragraph. */
const MAX_QUERY_CHARS = 100;

/** Stands in for a line break or citation, which no link can contain. */
export const INLINE_LEAF = '￼';

const NOT_IN_A_LINK = /[[\]\n￼]/;

/**
 * Finds a link being typed, given the text before and after the cursor in one block.
 * Supports `[[query`, `[[query|label` and `[[query|label]]` with the cursor after the
 * query, which is what starting a link on selected text leaves behind.
 */
export function findLinkQuery(before: string, after = ''): LinkQuery | null {
  const start = before.lastIndexOf('[[');
  if (start < 0) return null;
  const inner = before.slice(start + 2);
  if (inner.length > MAX_QUERY_CHARS || NOT_IN_A_LINK.test(inner)) return null;
  const bar = inner.indexOf('|');
  if (bar >= 0) {
    return { start, trailing: 0, query: inner.slice(0, bar).trim(), label: inner.slice(bar + 1) };
  }
  const wrapped = /^\|([^[\]\n￼]*)\]\]/.exec(after);
  return {
    start,
    trailing: wrapped ? wrapped[0].length : 0,
    query: inner.trim(),
    label: wrapped ? wrapped[1] : null,
  };
}
