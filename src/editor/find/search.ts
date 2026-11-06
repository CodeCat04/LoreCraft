/**
 * Finding text in a document. This is plain logic over the document, with no view, so a
 * search on a long book costs a few milliseconds and can be tested on its own.
 */

import type { Node as ProseNode } from '@tiptap/pm/model';

export interface FindOptions {
  query: string;
  matchCase: boolean;
  wholeWord: boolean;
}

export interface FindMatch {
  from: number;
  to: number;
}

/** Stands in for anything in a block that is not text, so a match cannot cross it. */
const NOT_TEXT = '￼';

/** What the editor's typing rules turn into something else, so the plain form still finds it. */
const SAME_AS: [readonly string[], string][] = [
  [['...', '…'], '(?:\\.\\.\\.|…)'],
  [['--', '—'], '(?:--|—)'],
  [["'", '‘', '’'], "['‘’]"],
  [['"', '“', '”'], '["“”]'],
  [[' ', ' '], '[ \\u00A0]'],
];

const WORD_CHAR = '[\\p{L}\\p{M}\\p{N}_]';

function patternSource(query: string): string {
  let source = '';
  let at = 0;
  outer: while (at < query.length) {
    for (const [forms, replacement] of SAME_AS) {
      const form = forms.find((f) => query.startsWith(f, at));
      if (form) {
        source += replacement;
        at += form.length;
        continue outer;
      }
    }
    // By code point, so an emoji stays whole under the `u` flag.
    const char = String.fromCodePoint(query.codePointAt(at)!);
    source += char.replace(/[\^$\\.*+?()[\]{}|/]/, '\\$&');
    at += char.length;
  }
  return source;
}

/** The search as a pattern, or null if there is nothing to look for. */
export function buildPattern(options: FindOptions): RegExp | null {
  const { query, matchCase, wholeWord } = options;
  if (!query || query.includes(NOT_TEXT)) return null;
  const source = patternSource(query);
  const bounded = wholeWord ? `(?<!${WORD_CHAR})${source}(?!${WORD_CHAR})` : source;
  // A pattern rather than comparing lower-cased text, because lower-casing can change a
  // string's length, and offsets into the text have to stay true.
  return new RegExp(bounded, matchCase ? 'gu' : 'giu');
}

function blockText(block: ProseNode): string {
  let text = '';
  block.forEach((child) => {
    // Offsets in this string are offsets in the block, which is what makes a match that
    // runs across differently formatted text simple: it is one run of the string.
    text += child.isText ? child.text! : NOT_TEXT.repeat(child.nodeSize);
  });
  return text;
}

/** Every match in document order. A match stays within one block. */
export function findMatches(doc: ProseNode, options: FindOptions): FindMatch[] {
  const pattern = buildPattern(options);
  if (!pattern) return [];
  const matches: FindMatch[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const text = blockText(node);
    const start = pos + 1;
    pattern.lastIndex = 0;
    for (let found = pattern.exec(text); found; found = pattern.exec(text)) {
      matches.push({ from: start + found.index, to: start + found.index + found[0].length });
    }
    return false;
  });
  return matches;
}

/** The index of the first match starting at or after `pos`, or -1 if none does. */
export function firstAtOrAfter(matches: FindMatch[], pos: number): number {
  let low = 0;
  let high = matches.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (matches[middle].from < pos) low = middle + 1;
    else high = middle;
  }
  return low < matches.length ? low : -1;
}

/** The match to go to from `pos`, wrapping around to the first. -1 with no matches at all. */
export function nextMatchFrom(matches: FindMatch[], pos: number): number {
  if (matches.length === 0) return -1;
  const found = firstAtOrAfter(matches, pos);
  return found === -1 ? 0 : found;
}

/**
 * Which matches to draw, as index bounds `[start, end)`. Drawing costs far more than
 * searching, and a letter can match hundreds of thousands of times in a book, so at most
 * `limit` are drawn, as many on each side of `around` as fit in `from..to`.
 */
export function drawnSpan(
  matches: FindMatch[],
  range: { from: number; to: number },
  around: number,
  limit: number,
): { start: number; end: number } {
  if (matches.length <= limit) return { start: 0, end: matches.length };
  const inRangeStart = firstAtOrAfter(matches, range.from);
  const first = inRangeStart === -1 ? matches.length : inRangeStart;
  const afterRange = firstAtOrAfter(matches, range.to + 1);
  const last = afterRange === -1 ? matches.length : afterRange;
  if (last - first <= limit) return { start: first, end: last };
  const middle = firstAtOrAfter(matches, around);
  const center = middle === -1 ? last : Math.min(Math.max(middle, first), last);
  const start = Math.max(first, Math.min(center - (limit >> 1), last - limit));
  return { start, end: start + limit };
}

/**
 * A selection to look for, if it looks like something someone wants to find. Spaces at the
 * edges go, because double-clicking a word on Windows selects the space after it as well.
 */
export function seedFromSelection(text: string): string | null {
  if (text.length > 200 || /[\r\n￼]/.test(text)) return null;
  return text.trim() || null;
}
