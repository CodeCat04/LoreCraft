/**
 * Finds the words in a block of text. Runs in the worker, so it must not touch the DOM.
 * Offsets are UTF-16 positions in the text, which match ProseMirror positions inside a
 * block.
 */

export interface Token {
  from: number;
  to: number;
  word: string;
}

/**
 * Letters, combining marks and digits, joined by single inner apostrophes or hyphens.
 * A digit makes the whole token not a word, so it must be part of the match: otherwise
 * "3rd" would leave "rd" behind to be flagged.
 */
const WORD = /[\p{L}\p{M}\p{N}]+(?:['’\-‐‑][\p{L}\p{M}\p{N}]+)*/gu;

/** Web and email addresses are not words, even though parts of them look like it. */
const ADDRESS = /(?:https?:\/\/|www\.)\S+|[^\s@]+@[^\s@]+\.[^\s@]+/gi;

const HAS_DIGIT = /\p{N}/u;

/** The script a dictionary covers. Words in other scripts are left alone rather than all flagged. */
export type SpellScript = 'latin' | 'cyrillic';

const IN_SCRIPT: Record<SpellScript, RegExp> = {
  latin: /^[\p{Script=Latin}\p{M}'’\-‐‑]+$/u,
  cyrillic: /^[\p{Script=Cyrillic}\p{M}'’\-‐‑]+$/u,
};

function maskAddresses(text: string): string {
  if (!text.includes('.')) return text;
  return text.replace(ADDRESS, (match) => ' '.repeat(match.length));
}

/** The words worth checking. Numbers, addresses and other scripts are skipped. */
export function tokenize(text: string, script: SpellScript = 'latin'): Token[] {
  const tokens: Token[] = [];
  const masked = maskAddresses(text);
  const inScript = IN_SCRIPT[script];
  for (const match of masked.matchAll(WORD)) {
    const word = match[0];
    if (HAS_DIGIT.test(word) || !inScript.test(word)) continue;
    tokens.push({ from: match.index, to: match.index + word.length, word });
  }
  return tokens;
}

const HYPHEN = /[-‐‑]/;

/** The parts of a hyphenated word, each with its own range. */
export function hyphenParts(token: Token): Token[] {
  if (!HYPHEN.test(token.word)) return [token];
  const parts: Token[] = [];
  let at = token.from;
  for (const part of token.word.split(HYPHEN)) {
    parts.push({ from: at, to: at + part.length, word: part });
    at += part.length + 1;
  }
  return parts;
}

/** The form words are looked up in: composed accents and a straight apostrophe. */
export function normalizeWord(word: string): string {
  return word.normalize('NFC').replace(/’/g, "'");
}

/** The names and words a title or alias contributes to the custom word list. */
export function wordsInName(name: string, script: SpellScript = 'latin'): string[] {
  const words: string[] = [];
  for (const token of tokenize(name, script)) {
    const normalized = normalizeWord(token.word);
    words.push(normalized);
    const parts = hyphenParts(token);
    if (parts.length > 1) words.push(...parts.map((part) => normalizeWord(part.word)));
    for (const form of parts.length > 1 ? parts.map((part) => normalizeWord(part.word)) : [normalized]) {
      if (form.toLowerCase().endsWith("'s")) words.push(form.slice(0, -2));
    }
  }
  return words;
}
