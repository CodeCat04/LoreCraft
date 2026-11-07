/**
 * Applies a suggestion from an outside AI to a document, without an editor being open.
 *
 * A client quotes plain text. It never sees marks, so a word it leaves alone must keep its
 * link or italics: the replacement is compared with the quote word by word, and only the
 * words that differ are written. A figure or table can never be part of a change. Text on
 * either side of one is a separate stretch, so a quote cannot reach across it.
 */

import { getSchema } from '@tiptap/core';
import { Mark, Node as ProseNode, type Schema } from '@tiptap/pm/model';
import { Transform } from '@tiptap/pm/transform';
import { diffChars, diffWordsWithSpace } from 'diff';

import {
  applyHunks,
  computeHunks,
  computeInsertion,
  FigureSafetyError,
  isProtected,
  keptNodesIntact,
  planRewrite,
  planToMarkdown,
  type Hunk,
} from '../editor/ai/hunks';
import { markdownToPm, pmToPlainText } from '../editor/convert';
import { documentExtensions } from '../editor/schema';
import { t } from '../lib/i18n';
import type { PmNode } from '../lib/types';
import type { InsertPayload, TextProposal } from './api';

let cached: Schema | null = null;
function schema(): Schema {
  cached ??= getSchema(documentExtensions());
  return cached;
}

const SENTINEL = '​';
const WORD_DIFF_TIMEOUT_MS = 800;
/** Marks that say what a word is, so typing next to one does not extend it. */
const NOT_INHERITED = new Set(['link', 'wikiLink', 'code']);
const BLOCK_SYNTAX = /^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|\|)/;

function straighten(c: string): string {
  if (c === '‘' || c === '’') return "'";
  if (c === '“' || c === '”') return '"';
  return c;
}

const INVISIBLE = new Set(['​', '‌', '‍', '⁠', '﻿']);
const DASHES = new Set(['-', '‐', '‑', '‒', '–', '—', '―', '−']);

/** Rust's `char::is_whitespace`, which also counts U+0085. */
function isSpace(c: string): boolean {
  return c === '\u0085' || /^\s$/u.test(c);
}

/** What one character reads as, apart from spaces and dashes. */
function plainChars(c: string): string {
  return c === '…' ? '...' : straighten(c);
}

/**
 * How a quote is compared with a document. Must match `normalize_quote` in
 * `src-tauri/src/mcp/text.rs`, and `quote-cases.json` holds cases both sides check.
 * Models straighten curly quotes, rewrap lines, and type `--` or `...`. Every dash and run
 * of dashes reads as one `-` with no space on either side, an ellipsis as three dots,
 * invisible characters not at all, and any run of spaces as one.
 */
export function normalizeQuote(text: string): string {
  let out = '';
  let space = false;
  for (const raw of text) {
    if (INVISIBLE.has(raw)) continue;
    if (isSpace(raw)) {
      space = true;
      continue;
    }
    if (DASHES.has(raw)) {
      space = false;
      if (!out.endsWith('-')) out += '-';
      continue;
    }
    if (space && out && !out.endsWith('-')) out += ' ';
    space = false;
    out += plainChars(raw);
  }
  return out;
}

/** Emphasis a model adds to a quote is dropped when the text has none, since it reads plain text. */
export function needleFor(quote: string, haystack: string): string {
  let needle = normalizeQuote(quote);
  let stripped = false;
  for (const mark of ['*', '_']) {
    if (needle.includes(mark) && !haystack.includes(mark)) {
      needle = needle.split(mark).join('');
      stripped = true;
    }
  }
  return stripped ? normalizeQuote(needle) : needle;
}

interface Stretch {
  text: string;
  /** For each character of `text`, the document positions it covers. */
  from: number[];
  to: number[];
}

function newStretch(): Stretch {
  return { text: '', from: [], to: [] };
}

/** Adds one character as `normalizeQuote` would read it. */
function pushChar(stretch: Stretch, c: string, from: number, to: number): void {
  if (INVISIBLE.has(c)) return;
  const add = (ch: string) => {
    stretch.text += ch;
    stretch.from.push(from);
    stretch.to.push(to);
  };
  if (isSpace(c)) {
    if (stretch.text === '' || stretch.text.endsWith(' ') || stretch.text.endsWith('-')) return;
    add(' ');
  } else if (DASHES.has(c)) {
    if (stretch.text.endsWith(' ')) {
      stretch.text = stretch.text.slice(0, -1);
      stretch.from.pop();
      stretch.to.pop();
    }
    if (stretch.text.endsWith('-')) stretch.to[stretch.to.length - 1] = to;
    else add('-');
  } else {
    for (const ch of plainChars(c)) add(ch);
  }
}

function collectStretches(doc: ProseNode): Stretch[] {
  const done: Stretch[] = [];
  let current = newStretch();
  const finish = () => {
    if (current.text) done.push(current);
    current = newStretch();
  };
  const addBlock = (node: ProseNode, pos: number) => {
    node.forEach((child, offset) => {
      const at = pos + 1 + offset;
      if (child.isText) {
        const text = child.text ?? '';
        for (let i = 0; i < text.length; i += 1) pushChar(current, text[i], at + i, at + i + 1);
      } else if (child.type.name === 'hardBreak') {
        pushChar(current, ' ', at, at + child.nodeSize);
      }
    });
    // The break between two blocks reads as a space.
    const end = pos + node.nodeSize - 1;
    pushChar(current, ' ', end, end);
  };
  const walk = (parent: ProseNode, parentPos: number, inProtected: boolean) => {
    parent.forEach((node, offset) => {
      const pos = parentPos + offset;
      if (isProtected(node)) {
        finish();
        walk(node, pos + 1, true);
        finish();
      } else if (node.isTextblock) {
        addBlock(node, pos);
        // Inside a figure or table, each block of text stands alone.
        if (inProtected) finish();
      } else if (!node.isLeaf) {
        walk(node, pos + 1, inProtected);
      } else if (node.isBlock) {
        // A rule or other leaf block breaks the text as well.
        finish();
      }
    });
  };
  walk(doc, 0, false);
  finish();
  return done;
}

export type QuoteMatch = { from: number; to: number } | { problem: 'missing' | 'repeated' };

/** Every place a quote is in a document, in document positions and reading order. */
export function findAllQuotes(doc: ProseNode, quote: string): { from: number; to: number }[] {
  const stretches = collectStretches(doc);
  const needle = needleFor(quote, stretches.map((s) => s.text).join('\n'));
  if (!needle) return [];
  const found: { from: number; to: number }[] = [];
  for (const stretch of stretches) {
    let at = stretch.text.indexOf(needle);
    while (at !== -1) {
      found.push({ from: stretch.from[at], to: stretch.to[at + needle.length - 1] });
      at = stretch.text.indexOf(needle, at + needle.length);
    }
  }
  return found;
}

/** Where a quote is in a document, in document positions. */
export function findQuote(doc: ProseNode, quote: string): QuoteMatch {
  const found = findAllQuotes(doc, quote);
  if (found.length > 1) return { problem: 'repeated' };
  return found[0] ?? { problem: 'missing' };
}

/**
 * A stretch from the start of one quote to the end of another. The end must be the only
 * match that comes after the start, as in `propose_rewrite` in `suggest.rs`.
 */
export function findRange(doc: ProseNode, fromQuote: string, toQuote: string): QuoteMatch {
  const start = findQuote(doc, fromQuote);
  if ('problem' in start) return start;
  const ends = findAllQuotes(doc, toQuote).filter((m) => m.from >= start.from && m.to >= start.to);
  if (ends.length > 1) return { problem: 'repeated' };
  return ends.length === 1 ? { from: start.from, to: ends[0].to } : { problem: 'missing' };
}

interface OldChar {
  c: string;
  pos: number;
  size: number;
  marks: readonly Mark[];
}

/** The characters of one block between two positions. */
function oldChars(block: ProseNode, blockPos: number, from: number, to: number): OldChar[] {
  const chars: OldChar[] = [];
  block.forEach((child, offset) => {
    const at = blockPos + 1 + offset;
    if (at + child.nodeSize <= from || at >= to) return;
    if (child.isText) {
      const text = child.text ?? '';
      for (let i = 0; i < text.length; i += 1) {
        const pos = at + i;
        if (pos >= from && pos < to) chars.push({ c: text[i], pos, size: 1, marks: child.marks });
      }
    } else if (child.type.name === 'hardBreak') {
      chars.push({ c: '\n', pos: at, size: child.nodeSize, marks: child.marks });
    }
  });
  return chars;
}

interface NewChar {
  c: string;
  marks: readonly Mark[];
}

/**
 * Reads one paragraph of a reply as inline text. Line by line, so a line that opens with
 * "1." or "-" stays the words it is rather than turning into a list.
 */
function parseInline(paragraph: string): NewChar[] {
  const out: NewChar[] = [];
  const lines = paragraph.split('\n');
  lines.forEach((line, index) => {
    if (index > 0) out.push({ c: '\n', marks: [] });
    const parsed = markdownToPm(SENTINEL + line.trim());
    const block = parsed.content?.[0];
    const nodes = block?.type === 'paragraph' ? (block.content ?? []) : [];
    for (const node of nodes) {
      // A model cannot place media or anything else that holds more than words.
      if (node.type !== 'text') continue;
      const inline = ProseNode.fromJSON(schema(), node);
      // By UTF-16 unit, like document positions and the comparison.
      const value = inline.text ?? '';
      for (let i = 0; i < value.length; i += 1) {
        if (value[i] !== SENTINEL) out.push({ c: value[i], marks: inline.marks });
      }
    }
  });
  return out;
}

/** Text as compared: curly marks and spaces do not count as a difference on their own. */
function comparable(chars: { c: string }[]): string {
  return chars.map((ch) => (/^\s$/u.test(ch.c) ? ' ' : straighten(ch.c))).join('');
}

interface Change {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

function diffRuns(older: string, newer: string): Change[] {
  // Words read best, but two long and wholly different texts can take too long.
  const parts =
    diffWordsWithSpace(older, newer, { timeout: WORD_DIFF_TIMEOUT_MS }) ??
    diffChars(older, newer, { timeout: WORD_DIFF_TIMEOUT_MS });
  if (!parts) {
    return [{ oldStart: 0, oldEnd: older.length, newStart: 0, newEnd: newer.length }];
  }
  const changes: Change[] = [];
  let oldAt = 0;
  let newAt = 0;
  for (const part of parts) {
    const size = part.value.length;
    if (!part.added && !part.removed) {
      oldAt += size;
      newAt += size;
      continue;
    }
    const last = changes[changes.length - 1];
    const change: Change =
      last && last.oldEnd === oldAt && last.newEnd === newAt
        ? last
        : { oldStart: oldAt, oldEnd: oldAt, newStart: newAt, newEnd: newAt };
    if (change !== last) changes.push(change);
    if (part.removed) {
      oldAt += size;
      change.oldEnd = oldAt;
    } else {
      newAt += size;
      change.newEnd = newAt;
    }
  }
  return changes;
}

function withMarks(base: readonly Mark[], extra: readonly Mark[]): readonly Mark[] {
  let set: readonly Mark[] = base;
  for (const mark of extra) set = mark.addToSet(set);
  return set;
}

/** Inserted words take on what surrounds them, so a word changed in italics stays italic. */
function buildNodes(chars: NewChar[], inherited: readonly Mark[]): ProseNode[] {
  const s = schema();
  const nodes: ProseNode[] = [];
  let text = '';
  let marks: readonly Mark[] = [];
  const flush = () => {
    if (text) nodes.push(s.text(text, marks));
    text = '';
  };
  for (const ch of chars) {
    if (ch.c === '\n') {
      flush();
      nodes.push(s.nodes.hardBreak.create());
      continue;
    }
    const next = withMarks(inherited, ch.marks);
    if (!text || !Mark.sameSet(marks, next)) {
      flush();
      marks = next;
    }
    text += ch.c;
  }
  flush();
  return nodes;
}

/** Writes one block's changes into the transform, last first so positions hold. */
function applyToBlock(tr: Transform, olds: OldChar[], news: NewChar[], rangeFrom: number): void {
  const changes = diffRuns(comparable(olds), comparable(news));

  // Marks the reply adds to words it otherwise leaves alone, such as *this*. These change
  // no positions, so they go first while the old positions still hold.
  let oldIndex = 0;
  let newIndex = 0;
  const addMarks = (count: number) => {
    for (let i = 0; i < count; i += 1) {
      const older = olds[oldIndex + i];
      for (const mark of news[newIndex + i].marks) {
        if (older.size === 1 && !mark.isInSet(older.marks)) tr.addMark(older.pos, older.pos + 1, mark);
      }
    }
  };
  for (const change of changes) {
    addMarks(change.oldStart - oldIndex);
    oldIndex = change.oldEnd;
    newIndex = change.newEnd;
  }
  addMarks(olds.length - oldIndex);

  for (const change of [...changes].reverse()) {
    const removed = change.oldEnd > change.oldStart;
    const before = change.oldStart > 0 ? olds[change.oldStart - 1] : null;
    const from = removed ? olds[change.oldStart].pos : before ? before.pos + before.size : rangeFrom;
    const to = removed ? olds[change.oldEnd - 1].pos + olds[change.oldEnd - 1].size : from;
    const inherited = removed
      ? olds[change.oldStart].marks
      : (before?.marks ?? olds[0]?.marks ?? []).filter((m) => !NOT_INHERITED.has(m.type.name));
    tr.replaceWith(from, to, buildNodes(news.slice(change.newStart, change.newEnd), inherited));
  }
}

/** The stretch of each text block a range covers, in order. */
function blocksIn(doc: ProseNode, from: number, to: number): { node: ProseNode; pos: number; from: number; to: number }[] {
  const blocks: { node: ProseNode; pos: number; from: number; to: number }[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    const start = Math.max(from, pos + 1);
    const end = Math.min(to, pos + node.nodeSize - 1);
    if (start < end) blocks.push({ node, pos, from: start, to: end });
    return false;
  });
  return blocks;
}

export type EditResult = { doc: PmNode } | { stale: string };

const staleMissing = () => t('The quoted text is no longer there, because the document has changed since this was suggested.');
const staleRepeated = () => t('The quoted text now appears more than once, so it is not clear which to change.');
const cannotApply = () => t('This change cannot be applied to the document as it stands.');

/**
 * Applies an edit to a stored document. Returns the new document, or says why not. The
 * words the replacement does not change, and everything outside the quote, are untouched.
 */
export function applyEdit(content: PmNode, quote: string, replacement: string): EditResult {
  const doc = ProseNode.fromJSON(schema(), content);
  const found = findQuote(doc, quote);
  if ('problem' in found) return { stale: found.problem === 'repeated' ? staleRepeated() : staleMissing() };
  try {
    const paragraphs = replacement.trim() ? replacement.trim().split(/\n\s*\n/) : [''];
    const blocks = blocksIn(doc, found.from, found.to);
    const wordsOnly =
      paragraphs.length === blocks.length && (blocks.length === 1 || !paragraphs.some((p) => BLOCK_SYNTAX.test(p)));
    let after: ProseNode;
    if (wordsOnly) {
      const tr = new Transform(doc);
      // Last block first, so positions earlier in the document still hold.
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        const block = blocks[i];
        applyToBlock(tr, oldChars(block.node, block.pos, block.from, block.to), parseInline(paragraphs[i]), block.from);
      }
      after = tr.doc;
    } else {
      // The structure changes, as when one paragraph becomes two. The AI rewrite path
      // already handles that, and refuses anything that would alter a figure.
      const plan = planRewrite(doc, found.from, found.to);
      if (!plan) return { stale: cannotApply() };
      after = applyHunks(doc, computeHunks(doc, plan, replacement)).doc;
    }
    after.check();
    if (!keptNodesIntact(doc, after, true) && !keptNodesIntact(doc, after)) return { stale: cannotApply() };
    return { doc: after.toJSON() as PmNode };
  } catch (error) {
    if (error instanceof FigureSafetyError) return { stale: error.message };
    return { stale: cannotApply() };
  }
}

// ---------------------------------------------------------------------------
// Longer writing: inserts and rewrites, as tracked changes
// ---------------------------------------------------------------------------

/** The changes a text suggestion makes, over `from..to`, or why it cannot be made now. */
export type PlannedChanges = { from: number; to: number; hunks: Hunk[] } | { stale: string };

const staleChanged = () =>
  t('The text has changed since this was suggested, so accepting it would undo your edits. Review it in the scene to choose the parts to keep.');
const staleAnchors = () => t('The start or end of the passage is no longer there, because the document has changed since this was suggested.');
const nothingChanges = () => t('This suggestion would not change anything now.');

function staleFor(problem: 'missing' | 'repeated', missing: () => string): { stale: string } {
  return { stale: problem === 'repeated' ? staleRepeated() : missing() };
}

/** Rewrites `from..to` into `replacement`, word by word and paragraph by paragraph. */
function rewriteRange(doc: ProseNode, from: number, to: number, replacement: string): PlannedChanges {
  const plan = planRewrite(doc, from, to);
  if (!plan) return { stale: cannotApply() };
  const hunks = computeHunks(doc, plan, replacement);
  return hunks.length ? { from: plan.from, to: plan.to, hunks } : { stale: nothingChanges() };
}

function planInsert(doc: ProseNode, payload: InsertPayload): PlannedChanges {
  const text = payload.text.trim();
  const insertAt = (position: number): PlannedChanges => {
    const hunks = computeInsertion(doc, position, text);
    return hunks.length ? { from: hunks[0].from, to: hunks[0].to, hunks } : { stale: nothingChanges() };
  };
  if (payload.at === 'start' || payload.at === 'end') {
    const block = payload.at === 'start' ? doc.firstChild : doc.lastChild;
    // An empty first or last paragraph is filled rather than left beside the new text.
    const empty = !!block && block.isTextblock && block.content.size === 0;
    if (payload.at === 'start') return insertAt(empty ? 1 : 0);
    return insertAt(empty ? doc.content.size - 1 : doc.content.size);
  }
  const found = findQuote(doc, payload.quote ?? '');
  if ('problem' in found) return staleFor(found.problem, staleMissing);
  const after = payload.at === 'after';
  const $pos = doc.resolve(after ? found.to : found.from);
  if ($pos.parent.isTextblock && after && $pos.parentOffset === $pos.parent.content.size) return insertAt(found.to);
  if ($pos.parent.isTextblock && !after && $pos.parentOffset === 0) return insertAt($pos.before());
  // Inside a paragraph, the words go in beside the quote, with a space between.
  const plan = planRewrite(doc, found.from, found.to);
  if (!plan) return { stale: cannotApply() };
  const quoted = planToMarkdown(doc, plan);
  return rewriteRange(doc, found.from, found.to, after ? `${quoted} ${text}` : `${text} ${quoted}`);
}

/**
 * The changes a text suggestion makes to `doc` as it is now, found again by its quotes.
 * `strict` refuses a whole rewrite of text that has changed since, since accepting it in
 * one go would lose the writer's edits. Reviewed in the scene, each change is shown.
 */
export function planTextProposal(doc: ProseNode, proposal: TextProposal, strict: boolean): PlannedChanges {
  try {
    if (proposal.kind === 'insert') return planInsert(doc, proposal.payload);
    if (proposal.kind === 'edit') {
      const found = findQuote(doc, proposal.payload.quote);
      if ('problem' in found) return staleFor(found.problem, staleMissing);
      return rewriteRange(doc, found.from, found.to, proposal.payload.replacement);
    }
    const { payload } = proposal;
    if (payload.mode === 'whole') {
      const now = normalizeQuote(pmToPlainText(doc.toJSON() as PmNode));
      if (strict && payload.original !== undefined && now !== normalizeQuote(payload.original)) return { stale: staleChanged() };
      if (now === '') return planInsert(doc, { at: 'start', text: payload.replacement });
      return rewriteRange(doc, 0, doc.content.size, payload.replacement);
    }
    const found = findRange(doc, payload.fromQuote ?? '', payload.toQuote ?? '');
    if ('problem' in found) return staleFor(found.problem, staleAnchors);
    return rewriteRange(doc, found.from, found.to, payload.replacement);
  } catch (error) {
    if (error instanceof FigureSafetyError) return { stale: error.message };
    return { stale: cannotApply() };
  }
}

/**
 * Applies a text suggestion to a stored document in one go. A short edit keeps the marks
 * of every word it leaves alone; longer writing goes through the same changes the writer
 * would review in the scene.
 */
export function applyTextProposal(content: PmNode, proposal: TextProposal): EditResult {
  if (proposal.kind === 'edit') return applyEdit(content, proposal.payload.quote, proposal.payload.replacement);
  const doc = ProseNode.fromJSON(schema(), content);
  const planned = planTextProposal(doc, proposal, true);
  if ('stale' in planned) return planned;
  try {
    const after = applyHunks(doc, planned.hunks).doc;
    after.check();
    if (!keptNodesIntact(doc, after)) return { stale: cannotApply() };
    return { doc: after.toJSON() as PmNode };
  } catch (error) {
    if (error instanceof FigureSafetyError) return { stale: error.message };
    return { stale: cannotApply() };
  }
}
