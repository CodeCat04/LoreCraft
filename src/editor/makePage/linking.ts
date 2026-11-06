/**
 * Turning selected words into a wiki link: what counts as linkable, and where else in the
 * document the same name appears. Plain logic over the document, so it can be tested alone.
 */

import type { MarkType, Node as ProseNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';

import { findMatches, type FindMatch } from '../find/search';

export interface LinkRange {
  from: number;
  to: number;
  text: string;
}

/** A longer selection is a passage, not a name, and the button would only be clutter. */
export const MAX_NAME_CHARS = 80;

/** Names this short make too many false matches. The same rule as automatic name detection. */
const MIN_MENTION_CHARS = 3;

const NOT_TEXT = '￼';
const LEADING_NOISE = /^[\s"'“‘«([]+/u;
const TRAILING_NOISE = /[\s"'”’»)\].,;:!?…—–-]+$/u;

function wikiLinkType(doc: ProseNode): MarkType {
  return doc.type.schema.marks.wikiLink;
}

/**
 * The name a selection covers, without the spaces and punctuation that come along when
 * selecting by hand, or null if it could not be a link. A link stays within one block and
 * has no brackets or citations in it, which would not survive being saved as Markdown.
 */
export function linkableRange(doc: ProseNode, from: number, to: number): LinkRange | null {
  // The selection menu keeps a selection for a moment after the text changes, so the
  // range can run past the end of a document that just got shorter.
  if (from >= to || from < 0 || to > doc.content.size) return null;
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  if (!$from.sameParent($to) || !$from.parent.isTextblock) return null;
  if (!$from.parent.type.allowsMarkType(wikiLinkType(doc))) return null;
  const raw = doc.textBetween(from, to, undefined, NOT_TEXT);
  if (/[[\]|\n￼]/.test(raw)) return null;
  const leading = LEADING_NOISE.exec(raw)?.[0].length ?? 0;
  const trailing = TRAILING_NOISE.exec(raw.slice(leading))?.[0].length ?? 0;
  const text = raw.slice(leading, raw.length - trailing);
  if (!text || text.length > MAX_NAME_CHARS) return null;
  return { from: from + leading, to: to - trailing, text };
}

/** The page this whole range already links to, or null if any of it is not linked. */
export function linkedTarget(doc: ProseNode, range: { from: number; to: number }): string | null {
  const type = wikiLinkType(doc);
  let target: string | null = null;
  let whole = true;
  doc.nodesBetween(range.from, range.to, (node) => {
    if (!node.isText) return true;
    const mark = type.isInSet(node.marks);
    if (!mark) whole = false;
    else target ??= String(mark.attrs.target);
    return false;
  });
  return whole ? target : null;
}

/** The names to try when looking up a selection: as written, then without a possessive. */
export function nameCandidates(text: string): string[] {
  const without = text.replace(/['’]s$/u, '');
  return without !== text && without ? [text, without] : [text];
}

/**
 * Where else these names appear as plain text: whole words with the same capitals, as for
 * automatic name detection. Text already linked, code and headings are left alone, since a
 * heading is a label for its section rather than a mention. Where names overlap the longest
 * wins, so "Silver Vale" is one link and not a link around "Vale".
 */
export function otherMentions(doc: ProseNode, names: string[], skip: { from: number; to: number } | null): FindMatch[] {
  const linkTypes = ['wikiLink', 'link', 'code'].map((name) => doc.type.schema.marks[name]).filter(Boolean);
  const wikiLink = wikiLinkType(doc);
  const found: FindMatch[] = [];
  for (const name of new Set(names)) {
    if (name.length < MIN_MENTION_CHARS) continue;
    for (const match of findMatches(doc, { query: name, matchCase: true, wholeWord: true })) {
      if (skip && match.from < skip.to && match.to > skip.from) continue;
      const parent = doc.resolve(match.from).parent;
      if (parent.type.name === 'heading' || !parent.type.allowsMarkType(wikiLink)) continue;
      if (linkTypes.some((type) => doc.rangeHasMark(match.from, match.to, type))) continue;
      found.push(match);
    }
  }
  found.sort((a, b) => a.from - b.from || b.to - a.to);
  const kept: FindMatch[] = [];
  let end = -1;
  for (const match of found) {
    if (match.from >= end) {
      kept.push(match);
      end = match.to;
    }
  }
  return kept;
}

/** Adds the links to a transaction. Typing straight after one should not extend it. */
export function addLinks(tr: Transaction, ranges: { from: number; to: number }[], target: string): Transaction {
  const type = wikiLinkType(tr.doc);
  const mark = type.create({ target });
  for (const range of ranges) tr.addMark(range.from, range.to, mark);
  return tr.removeStoredMark(type);
}
