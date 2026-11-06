/**
 * Checks a model's quotes against the writer's text. A model can misquote or invent a line
 * and sound just as sure, so a note whose quote is not really there is dropped, and the
 * person is told how many went.
 *
 * Comparing ignores what typing and typography change: runs of whitespace, curly or straight
 * quotes, the kind of dash, and "..." against "…". The words themselves must match exactly.
 */

import type { PmNode } from '../../lib/types';

const INVISIBLE = /[­​-‍⁠﻿]/;
const SINGLE_QUOTE = /[‘’‚‛′ʼ]/;
const DOUBLE_QUOTE = /[“”„‟″«»]/;
const DASH = /[-‐-―−]/;

export interface NormalizedText {
  text: string;
  /** For each character of `text`, where in the source it came from. */
  map: number[];
}

export function normalizeText(source: string): NormalizedText {
  let text = '';
  const map: number[] = [];
  const add = (piece: string, at: number) => {
    text += piece;
    for (let i = 0; i < piece.length; i += 1) map.push(at);
  };
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (INVISIBLE.test(c)) continue;
    if (/\s/.test(c)) {
      if (text && !text.endsWith(' ')) add(' ', i);
    } else if (SINGLE_QUOTE.test(c)) {
      add("'", i);
    } else if (DOUBLE_QUOTE.test(c)) {
      add('"', i);
    } else if (DASH.test(c)) {
      // "--" is how an em dash gets typed, so a run of dashes counts as one.
      if (!text.endsWith('-')) add('-', i);
    } else if (c === '…') {
      add('...', i);
    } else {
      add(c, i);
    }
  }
  if (text.endsWith(' ')) {
    text = text.slice(0, -1);
    map.pop();
  }
  return { text, map };
}

/** What a model tends to wrap around a quote. Tried only if the quote as written fails. */
function withoutWrapping(quote: string): string {
  let out = quote.trim();
  for (;;) {
    const next = out
      .replace(/^(?:\*{1,2}|_{1,2}|\.{3}|…)\s*/, '')
      .replace(/\s*(?:\*{1,2}|_{1,2}|\.{3}|…)$/, '');
    const open = next[0];
    const close = next[next.length - 1];
    const wrapped =
      next.length >= 2 &&
      ((open === '"' && close === '"') || (open === '“' && close === '”') || (open === "'" && close === "'") || (open === '‘' && close === '’'));
    const unwrapped = wrapped ? next.slice(1, -1).trim() : next;
    if (unwrapped === out) return out;
    out = unwrapped;
  }
}

/** Where a quote falls in the source, or null if it is not there. Offsets are in the source. */
export function findQuote(source: string | NormalizedText, quote: string): { from: number; to: number } | null {
  const haystack = typeof source === 'string' ? normalizeText(source) : source;
  for (const candidate of [quote, withoutWrapping(quote)]) {
    const needle = normalizeText(candidate).text;
    // A quote with no words in it would match any punctuation.
    if (!/[\p{L}\p{N}]/u.test(needle)) continue;
    const at = haystack.text.indexOf(needle);
    if (at >= 0) return { from: haystack.map[at], to: haystack.map[at + needle.length - 1] + 1 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Text from a document, with positions
// ---------------------------------------------------------------------------

/** Nodes with no content of their own, for a document read without its schema. */
const LEAF_TYPES = new Set(['hardBreak', 'horizontalRule', 'image', 'video', 'reference']);

export interface DocumentText {
  text: string;
  /** For each character of `text`, its position in the document. */
  positions: number[];
}

/**
 * A document's words, with a space where one block ends and the next begins, so a quote can
 * run across a line break. Positions count the way ProseMirror does: a leaf takes one, and
 * any other node takes one on each side of what is in it.
 */
export function documentText(doc: PmNode, isLeaf: (type: string) => boolean = (type) => LEAF_TYPES.has(type)): DocumentText {
  let text = '';
  const positions: number[] = [];
  let pos = 0;
  const add = (c: string, at: number) => {
    text += c;
    positions.push(at);
  };
  const walkChildren = (node: PmNode) => {
    for (const child of node.content ?? []) walk(child);
  };
  const walk = (node: PmNode) => {
    if (node.type === 'text') {
      const words = node.text ?? '';
      for (let i = 0; i < words.length; i += 1) add(words[i], pos + i);
      pos += words.length;
      return;
    }
    if (isLeaf(node.type)) {
      if (node.type === 'hardBreak') add(' ', pos);
      pos += 1;
      return;
    }
    pos += 1;
    walkChildren(node);
    // The end of any block is a break in the text.
    if (text && !text.endsWith(' ')) add(' ', pos);
    pos += 1;
  };
  walkChildren(doc);
  return { text, positions };
}

/** The range of a quote in a document, for selecting it. Null if it is no longer there. */
export function locateQuote(doc: PmNode, quote: string, isLeaf?: (type: string) => boolean): { from: number; to: number } | null {
  const { text, positions } = documentText(doc, isLeaf);
  const found = findQuote(text, quote);
  if (!found) return null;
  return { from: positions[found.from], to: positions[found.to - 1] + 1 };
}

// ---------------------------------------------------------------------------
// Checking a whole reply
// ---------------------------------------------------------------------------

export interface RawNote {
  quote: string;
  note: string;
}

/** A note whose quote is there. `quote` is the writer's own text, not the model's copy. */
export interface VerifiedNote {
  id: string;
  quote: string;
  note: string;
  sceneId: string;
  sceneTitle: string;
}

export interface VerifiedNotes {
  notes: VerifiedNote[];
  /** How many had a quote that is not in the text. */
  dropped: number;
}

/** Scenes are searched in order, so a quote belongs to the first place it occurs. */
export function verifyNotes(raw: RawNote[], scenes: { id: string; title: string; doc: PmNode }[]): VerifiedNotes {
  const indexed = scenes.map((scene) => {
    const { text } = documentText(scene.doc);
    return { scene, text, normalized: normalizeText(text) };
  });
  const notes: VerifiedNote[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  raw.forEach((item, index) => {
    for (const { scene, text, normalized } of indexed) {
      const found = findQuote(normalized, item.quote);
      if (found) {
        const quote = text.slice(found.from, found.to);
        const key = `${scene.id}|${quote}|${item.note}`;
        // A note repeated word for word says nothing new.
        if (!seen.has(key)) {
          seen.add(key);
          notes.push({ id: `note${index + 1}`, quote, note: item.note, sceneId: scene.id, sceneTitle: scene.title });
        }
        return;
      }
    }
    dropped += 1;
  });
  return { notes, dropped };
}
