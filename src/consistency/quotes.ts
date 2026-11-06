/**
 * Checking that a quote is really in its source. This is what filters invented contradictions
 * out of a model's answer, so it is deliberately strict about content and forgiving only about
 * typography: whitespace, quote marks, dashes and case.
 */

const REPLACEMENTS: Record<string, string> = {
  '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"', '«': '"', '»': '"',
  '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'", '`': "'",
  '–': '-', '—': '-', '―': '-', '−': '-', '‐': '-', '‑': '-',
  '…': '...',
};

const INVISIBLE = /[­​-‍⁠﻿]/;

export interface NormalizedText {
  text: string;
  /** For each character of `text`, where it came from in the original. */
  map: number[];
}

/** Lower case with plain punctuation and single spaces, and a way back to the original. */
export function normalizeWithMap(input: string): NormalizedText {
  let text = '';
  const map: number[] = [];
  let lastWasSpace = true;
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i];
    if (INVISIBLE.test(c) || c === '*') continue;
    if (/\s/.test(c)) {
      if (!lastWasSpace) {
        text += ' ';
        map.push(i);
        lastWasSpace = true;
      }
      continue;
    }
    const plain = REPLACEMENTS[c] ?? c;
    // One character can become several, as with an ellipsis or a ligature.
    const piece = plain.normalize('NFKC').toLowerCase();
    for (let j = 0; j < piece.length; j += 1) {
      text += piece[j];
      map.push(i);
    }
    lastWasSpace = false;
  }
  if (text.endsWith(' ')) {
    text = text.slice(0, -1);
    map.pop();
  }
  return { text, map };
}

export function normalizeForQuote(input: string): string {
  return normalizeWithMap(input.normalize('NFC')).text;
}

/** Punctuation a model adds or drops at the edges of a quote, which does not change it. */
const EDGES = /^[\s"'.,;:!?()[\]\-]+|[\s"'.,;:!?()[\]\-]+$/g;

/** A quote ready to look for: normalized, without the marks around it. */
export function cleanQuote(quote: string): string {
  return normalizeForQuote(quote).replace(EDGES, '');
}

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[\p{L}\p{N}]/u.test(c);
}

/** Where a clean quote sits in normalized text as whole words, or -1. */
export function indexOfWhole(haystack: string, needle: string): number {
  if (!needle) return -1;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return -1;
    if (!isWordChar(haystack[at - 1]) && !isWordChar(haystack[at + needle.length])) return at;
    from = at + 1;
  }
}

/**
 * Fewer words than this proves nothing, since they could be found almost anywhere. It matches
 * the three words the prompts ask for. An infobox line such as "Eyes: green" is anchored by its
 * field name, so two words are enough there.
 */
const MIN_WORDS = 3;
const MIN_FIELD_WORDS = 2;

export type QuoteProblem = 'empty' | 'too-short' | 'not-found';

/** Null if the quote is really in the source, otherwise why it is not good enough. */
export function quoteProblem(quote: string | null | undefined, source: string): QuoteProblem | null {
  if (typeof quote !== 'string') return 'empty';
  const needle = cleanQuote(quote);
  if (!needle) return 'empty';
  const words = needle.split(' ').filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
  if (words < (needle.includes(':') ? MIN_FIELD_WORDS : MIN_WORDS)) return 'too-short';
  return indexOfWhole(normalizeForQuote(source), needle) >= 0 ? null : 'not-found';
}

export function quoteOccurs(quote: string | null | undefined, source: string): boolean {
  return quoteProblem(quote, source) === null;
}

/** The exact words in the source that a verified quote matches, as the writer has them. */
export function originalWords(quote: string, source: string): string {
  const { text, map } = normalizeWithMap(source.normalize('NFC'));
  const needle = cleanQuote(quote);
  const at = indexOfWhole(text, needle);
  if (at < 0) return quote.trim();
  return source.normalize('NFC').slice(map[at], map[at + needle.length - 1] + 1);
}

/** The sentence or line around a quote, which stays the same when a model quotes less or more. */
export function sentenceHolding(quote: string, source: string): string {
  const original = source.normalize('NFC');
  const { text, map } = normalizeWithMap(original);
  const needle = cleanQuote(quote);
  const at = indexOfWhole(text, needle);
  if (at < 0) return normalizeForQuote(quote);
  const start = map[at];
  const end = map[at + needle.length - 1];
  const stops = /[.!?…]["'”’)\]]*\s|\n/g;
  let from = 0;
  for (const match of original.matchAll(stops)) {
    if (match.index + match[0].length <= start) from = match.index + match[0].length;
    else break;
  }
  stops.lastIndex = end;
  const after = stops.exec(original);
  const to = after ? after.index + after[0].length : original.length;
  return normalizeForQuote(original.slice(from, to));
}
