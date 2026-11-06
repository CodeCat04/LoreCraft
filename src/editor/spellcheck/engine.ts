/**
 * Decides which words are misspelled. The dictionary itself is passed in, so this logic
 * can be tested without a worker. Lore names are held apart from the dictionary, which
 * makes them cheap to replace whenever a page is added or renamed.
 */

import { hyphenParts, normalizeWord, tokenize, wordsInName, type SpellScript } from './tokenize';

/** What this needs from a dictionary. See `hunspell.ts`. */
export interface SpellBackend {
  correct: (word: string) => boolean;
  suggest: (word: string) => string[];
}

/** A misspelling, as [from, to] offsets in the text it was found in. */
export type SpellRange = [number, number];

/** Words that stand with a leading apostrophe, which the tokenizer leaves off. */
const ELISIONS = new Set([
  'tis', 'twas', 'twere', 'twill', 'til', 'em', 'cause', 'neath', 'gainst', 'tween', 'twixt', 'bout', 'round',
]);

/** Fine at the front of a hyphenated word, though not all are words alone. */
const HYPHEN_PREFIXES = new Set([
  're', 'un', 'non', 'pre', 'post', 'anti', 'semi', 'co', 'ex', 'mid', 'sub', 'multi', 'pro', 'neo', 'proto',
  'quasi', 'demi', 'pseudo', 'inter', 'intra', 'micro', 'macro', 'mis', 'over', 'under', 'self', 'half',
]);

/** Short all-capital words are almost always acronyms or Roman numerals. */
const MAX_ACRONYM_LETTERS = 6;
const MAX_SUGGESTIONS = 6;
/** How far off a lore name can be, by length of the word, and still be offered. */
const LORE_DISTANCE_BY_LENGTH = (length: number) => (length <= 4 ? 1 : 2);

function isAcronym(word: string): boolean {
  return word.length <= MAX_ACRONYM_LETTERS && word === word.toUpperCase() && word !== word.toLowerCase();
}

/**
 * Edit distance where swapping two neighbors counts half, because that is the commonest
 * typing slip. It lifts "the" above "ten" as a fix for "teh".
 */
export function typingDistance(a: string, b: string): number {
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i += 1) {
    rows[i] = [i];
  }
  for (let j = 1; j <= b.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, rows[i - 2][j - 2] + 0.5);
      }
      rows[i][j] = best;
    }
  }
  return rows[a.length][b.length];
}

/** Makes a suggestion match how the word was typed at its start. */
function matchCase(suggestion: string, word: string): string {
  if (word.length > 1 && word === word.toUpperCase()) return suggestion.toUpperCase();
  if (word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase()) {
    return suggestion[0].toUpperCase() + suggestion.slice(1);
  }
  return suggestion;
}

export class SpellEngine {
  private backend: SpellBackend;
  /** lower case -> as first written, for suggestions. */
  private custom = new Map<string, string>();
  private ignored = new Set<string>();
  private cache = new Map<string, boolean>();
  private script: SpellScript;

  constructor(backend: SpellBackend, script: SpellScript = 'latin') {
    this.backend = backend;
    this.script = script;
  }

  /** Replaces the lore: page titles, aliases and the project dictionary. */
  setNames(names: string[]) {
    this.custom.clear();
    for (const name of names) {
      for (const word of wordsInName(name, this.script)) {
        const key = word.toLowerCase();
        const existing = this.custom.get(key);
        // Keeps the capitalized form when a name appears both ways.
        if (existing === undefined || existing === key) this.custom.set(key, word);
      }
    }
    this.cache.clear();
  }

  ignore(word: string) {
    this.ignored.add(normalizeWord(word).toLowerCase());
    this.cache.clear();
  }

  clearIgnored() {
    this.ignored.clear();
    this.cache.clear();
  }

  private known(word: string): boolean {
    const cached = this.cache.get(word);
    if (cached !== undefined) return cached;
    const result = this.lookUp(word);
    this.cache.set(word, result);
    return result;
  }

  private lookUp(word: string): boolean {
    const lower = word.toLowerCase();
    if (this.custom.has(lower) || this.ignored.has(lower)) return true;
    if (lower.endsWith("'s") && this.known(word.slice(0, -2))) return true;
    // The dictionary has its own plural rules. Lore names need these.
    if (lower.endsWith('s') && this.custom.has(lower.slice(0, -1))) return true;
    if (lower.endsWith('es') && this.custom.has(lower.slice(0, -2))) return true;
    return this.backend.correct(word);
  }

  /** The misspelled ranges in a block of text. */
  check(text: string): SpellRange[] {
    const ranges: SpellRange[] = [];
    for (const token of tokenize(text, this.script)) {
      if (token.word.length < 2) continue;
      const word = normalizeWord(token.word);
      if (isAcronym(word) || this.known(word)) continue;
      const before = text[token.from - 1];
      if ((before === "'" || before === '’') && ELISIONS.has(word.toLowerCase())) continue;
      const parts = hyphenParts(token);
      if (parts.length === 1) {
        ranges.push([token.from, token.to]);
        continue;
      }
      parts.forEach((part, index) => {
        const piece = normalizeWord(part.word);
        if (piece.length < 2 || isAcronym(piece) || this.known(piece)) return;
        if (index === 0 && HYPHEN_PREFIXES.has(piece.toLowerCase())) return;
        ranges.push([part.from, part.to]);
      });
    }
    return ranges;
  }

  /** The best replacements, nearest first. Lore names can be among them. */
  suggest(rawWord: string): string[] {
    const word = normalizeWord(rawWord);
    if (word.toLowerCase().endsWith("'s") && word.length > 2) {
      const stem = word.slice(0, -2);
      const ending = word.slice(-2);
      return this.suggest(stem).map((suggestion) => suggestion + ending);
    }
    const lower = word.toLowerCase();
    const limit = LORE_DISTANCE_BY_LENGTH(lower.length);
    const scored = new Map<string, { text: string; score: number }>();
    const offer = (text: string, score: number) => {
      const key = text.toLowerCase();
      const existing = scored.get(key);
      if (!existing || score < existing.score) scored.set(key, { text, score });
    };
    for (const [key, original] of this.custom) {
      if (Math.abs(key.length - lower.length) > limit) continue;
      const distance = typingDistance(lower, key);
      // A name from this world beats a dictionary word at the same distance.
      if (distance <= limit) offer(original, distance - 0.25);
    }
    for (const suggestion of this.backend.suggest(word)) {
      offer(matchCase(suggestion, word), typingDistance(lower, suggestion.toLowerCase()));
    }
    return [...scored.values()]
      .sort((a, b) => a.score - b.score || a.text.localeCompare(b.text))
      .slice(0, MAX_SUGGESTIONS)
      .map((entry) => entry.text);
  }
}
