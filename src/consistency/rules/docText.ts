/** Reading a document for the rules: its text, its links, and the sentence around a spot. */

import type { PmNode } from '../../lib/types';

export interface LinkInText {
  target: string;
  from: number;
  to: number;
}

export interface TextBlock {
  text: string;
  links: LinkInText[];
}

/** Every block of text in a document, with where each wiki link falls in it. */
export function textBlocks(doc: PmNode | null | undefined): TextBlock[] {
  const blocks: TextBlock[] = [];
  const walk = (node: PmNode) => {
    const inline = node.content?.some((child) => child.type === 'text' || child.type === 'hardBreak' || child.type === 'reference');
    if (inline) {
      let text = '';
      const links: LinkInText[] = [];
      for (const child of node.content ?? []) {
        if (child.type === 'hardBreak') {
          text += '\n';
          continue;
        }
        if (child.type !== 'text') continue;
        const piece = child.text ?? '';
        for (const mark of child.marks ?? []) {
          const target = mark.type === 'wikiLink' ? mark.attrs?.target : undefined;
          if (typeof target !== 'string' || !target.trim()) continue;
          // Marks split text into runs, so a link can continue over several of them.
          const last = links[links.length - 1];
          if (last && last.target === target && last.to === text.length) last.to += piece.length;
          else links.push({ target, from: text.length, to: text.length + piece.length });
        }
        text += piece;
      }
      if (text.trim()) blocks.push({ text, links });
      return;
    }
    node.content?.forEach(walk);
  };
  if (doc) walk(doc);
  return blocks;
}

/** Where sentences start and end in a run of text. */
function sentenceRanges(text: string): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  const ending = /[.!?…]+["'”’)\]]*(?=\s|$)|\n+/g;
  let start = 0;
  for (const match of text.matchAll(ending)) {
    const end = match.index + match[0].length;
    if (text.slice(start, end).trim()) ranges.push({ from: start, to: end });
    start = end;
  }
  if (text.slice(start).trim()) ranges.push({ from: start, to: text.length });
  return ranges;
}

/** The sentence holding this spot in a block. */
export function sentenceAround(text: string, from: number, to: number = from): string {
  for (const range of sentenceRanges(text)) {
    if (from >= range.from && from < range.to) {
      // A quote that runs over a sentence end keeps all of what it covers.
      return text.slice(range.from, Math.max(range.to, to)).trim();
    }
  }
  return text.trim();
}

export function sentencesOf(text: string): string[] {
  return sentenceRanges(text).map((range) => text.slice(range.from, range.to).trim());
}

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[\p{L}\p{N}_]/u.test(c);
}

/** True if the name appears as whole words, ignoring case. */
export function namesInText(text: string, name: string): boolean {
  const needle = name.trim().toLowerCase();
  if (needle.length < 2) return false;
  const lower = text.toLowerCase();
  let from = 0;
  for (;;) {
    const at = lower.indexOf(needle, from);
    if (at < 0) return false;
    if (!isWordChar(lower[at - 1]) && !isWordChar(lower[at + needle.length])) return true;
    from = at + 1;
  }
}

/**
 * True if the name appears as a name: whole words, as the wiki writes it, except that its first
 * letter may differ to start a sentence. A page called "Hope" is not named in "she had hope".
 */
export function namesAsName(text: string, name: string): boolean {
  const wanted = name.trim();
  if (wanted.length < 2) return false;
  const rest = wanted.slice(1);
  let from = 0;
  for (;;) {
    const at = text.indexOf(rest, from);
    if (at < 0) return false;
    from = at + 1;
    const first = text[at - 1];
    if (first === undefined || first.toLowerCase() !== wanted[0].toLowerCase()) continue;
    if (first !== wanted[0] && !(at - 1 === 0 || /[.!?"'“‘(\s]/.test(text[at - 2]))) continue;
    if (first !== wanted[0] && first !== first.toUpperCase()) continue;
    if (!isWordChar(text[at - 2]) && !isWordChar(text[at + rest.length])) return true;
  }
}

const WORD = /[\p{L}\p{N}]+/gu;

const wordCache = new WeakMap<PmNode, Set<string>>();

/** Every word in a document, kept once read, since the rules ask again and again. */
function wordsIn(doc: PmNode): Set<string> {
  let words = wordCache.get(doc);
  if (!words) {
    words = new Set<string>();
    for (const block of textBlocks(doc)) {
      for (const word of block.text.toLowerCase().match(WORD) ?? []) words.add(word);
    }
    wordCache.set(doc, words);
  }
  return words;
}

/** Whether a document could name this at all. Most scenes do not, which keeps the rules fast. */
function mightName(words: Set<string>, name: string): boolean {
  const first = name.toLowerCase().match(WORD)?.[0];
  return first !== undefined && words.has(first);
}

/** Every sentence of a document that uses one of these names. */
export function sentencesNaming(doc: PmNode | null | undefined, names: string[]): string[] {
  if (!doc) return [];
  const words = wordsIn(doc);
  if (!names.some((name) => mightName(words, name))) return [];
  const found: string[] = [];
  for (const block of textBlocks(doc)) {
    for (const sentence of sentencesOf(block.text)) {
      if (names.some((name) => namesAsName(sentence, name))) found.push(sentence);
    }
  }
  return found;
}
