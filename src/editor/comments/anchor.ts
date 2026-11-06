/**
 * Where comments are in a document, and adding or removing their marks. Pure functions on
 * ProseMirror documents, so the same code serves an open editor and a stored document.
 */

import { getSchema } from '@tiptap/core';
import type { Node as ProseNode, Schema } from '@tiptap/pm/model';
import { Transform } from '@tiptap/pm/transform';

import type { PmNode } from '../../lib/types';
import { documentExtensions } from '../schema';

export const COMMENT_MARK = 'comment';

export interface TextRange {
  from: number;
  to: number;
}

let cachedSchema: Schema | null = null;

function documentSchema(): Schema {
  cachedSchema ??= getSchema(documentExtensions());
  return cachedSchema;
}

/** Each comment's stretches of text, in document order. Next-door stretches are joined. */
export function commentRanges(doc: ProseNode): Map<string, TextRange[]> {
  const out = new Map<string, TextRange[]>();
  doc.descendants((node, pos) => {
    if (!node.isInline) return true;
    for (const mark of node.marks) {
      if (mark.type.name !== COMMENT_MARK) continue;
      const id = String(mark.attrs.id);
      const list = out.get(id) ?? [];
      const last = list[list.length - 1];
      if (last && last.to === pos) last.to = pos + node.nodeSize;
      else list.push({ from: pos, to: pos + node.nodeSize });
      out.set(id, list);
    }
    return false;
  });
  return out;
}

/** The words a stretch of a document holds, as a comment would quote them. */
export function quoteOf(doc: ProseNode, from: number, to: number): string {
  return doc.textBetween(from, to, ' ', ' ').replace(/\s+/g, ' ').trim();
}

// ---- Finding quoted text --------------------------------------------------------

/** One unit of text as compared. Typed and typeset punctuation count as the same thing. */
function foldChar(c: string): string {
  switch (c) {
    case '‘':
    case '’':
    case '‚':
    case '′':
      return "'";
    case '“':
    case '”':
    case '„':
    case '″':
      return '"';
    case '–':
    case '—':
    case '‒':
    case '―':
      return '-';
    case '…':
      return '...';
    default:
      return /\s/.test(c) ? ' ' : c;
  }
}

function foldQuote(quote: string): string {
  let out = '';
  for (const c of quote.trim()) {
    const folded = foldChar(c);
    if (folded === ' ' && out.endsWith(' ')) continue;
    out += folded;
  }
  return out.replace(/-{2,}/g, '-');
}

/**
 * The first place these words appear. A model or a person may quote with straight
 * quotes where the text has curly ones, or across a paragraph break, and that still counts.
 */
export function findQuote(doc: ProseNode, quote: string): TextRange | null {
  const wanted = foldQuote(quote);
  if (!wanted) return null;
  let text = '';
  const positions: number[] = [];
  const push = (value: string, pos: number) => {
    for (const c of value) {
      if (c === ' ' && (text.endsWith(' ') || text === '')) continue;
      text += c;
      positions.push(pos);
    }
  };
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    push(' ', pos);
    node.forEach((child, offset) => {
      const start = pos + 1 + offset;
      if (child.isText) {
        const value = child.text ?? '';
        for (let i = 0; i < value.length; i += 1) push(foldChar(value[i]), start + i);
      } else if (child.type.name === 'hardBreak') {
        push(' ', start);
      }
    });
    return false;
  });
  let at = text.indexOf(wanted);
  if (at < 0) {
    const lower = text.toLowerCase();
    // A few characters change length in lower case, and then positions would not line up.
    if (lower.length === text.length) at = lower.indexOf(wanted.toLowerCase());
  }
  if (at < 0) return null;
  return { from: positions[at], to: positions[at + wanted.length - 1] + 1 };
}

// ---- Marks ---------------------------------------------------------------------

/** Adds this comment's mark to a transaction. It marks text only, not other inline nodes. */
export function addCommentMark(tr: Transform, id: string, from: number, to: number): void {
  const type = tr.doc.type.schema.marks[COMMENT_MARK];
  if (type) tr.addMark(from, to, type.create({ id }));
}

/** Removes every stretch of this comment. Other comments on the same text stay. */
export function removeCommentMark(tr: Transform, id: string): void {
  const type = tr.doc.type.schema.marks[COMMENT_MARK];
  if (!type) return;
  const mark = type.create({ id });
  for (const range of commentRanges(tr.doc).get(id) ?? []) {
    tr.removeMark(range.from, range.to, mark);
  }
}

// ---- Stored documents -----------------------------------------------------------

/**
 * A stored document with this quote marked, or null if the words are not in it. The
 * caller writes the result through `pages.update` or `nodes.update`.
 */
export function markQuoteInStored(content: PmNode, id: string, quote: string): PmNode | null {
  const doc = documentSchema().nodeFromJSON(content);
  const range = findQuote(doc, quote);
  if (!range) return null;
  const tr = new Transform(doc);
  addCommentMark(tr, id, range.from, range.to);
  return tr.doc.toJSON() as PmNode;
}

/**
 * A stored document with this stretch marked, or null if it holds other words there by
 * now. The positions come from a read-only copy of the same document.
 */
export function markRangeInStored(content: PmNode, id: string, range: TextRange, quote: string): PmNode | null {
  const doc = documentSchema().nodeFromJSON(content);
  const size = doc.content.size;
  if (range.from < 0 || range.to > size || quoteOf(doc, range.from, range.to) !== quote) {
    return markQuoteInStored(content, id, quote);
  }
  const tr = new Transform(doc);
  addCommentMark(tr, id, range.from, range.to);
  return tr.doc.toJSON() as PmNode;
}

/** A stored document without this comment's mark, or null if it had none. */
export function unmarkInStored(content: PmNode, id: string): PmNode | null {
  const doc = documentSchema().nodeFromJSON(content);
  if (!commentRanges(doc).has(id)) return null;
  const tr = new Transform(doc);
  removeCommentMark(tr, id);
  return tr.doc.toJSON() as PmNode;
}
