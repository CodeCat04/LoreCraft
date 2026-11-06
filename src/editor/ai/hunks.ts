/**
 * Turns an AI rewrite into word-level changes against the real document.
 *
 * Figures, tables and images are never part of a change. A range is split around them:
 * the model sees each one as a `{{KEEP n: ...}}` line, and its reply is split at those
 * lines, so every change falls strictly between them. If the model drops, reorders or
 * mangles a marker, the node still stays where it was. The nodes themselves never go
 * through Markdown, which would lose their layout.
 */

import { Fragment, Node as ProseNode, Slice, type Schema, type ResolvedPos } from '@tiptap/pm/model';
import { Transform } from '@tiptap/pm/transform';
import { diffArrays } from 'diff';

import { describeFigures, figureToLine, markdownToPm, pmToMarkdown, pmToPlainText } from '../convert';
import { t } from '../../lib/i18n';
import type { PmNode } from '../../lib/types';

/** Nodes a rewrite must not touch. */
const PROTECTED = new Set(['figure', 'table', 'image', 'video']);

export function isProtected(node: ProseNode): boolean {
  return PROTECTED.has(node.type.name);
}

export interface Hunk {
  id: string;
  /** The text this change removes. Equal for a pure insertion. */
  from: number;
  to: number;
  /** What replaces it, ready for `tr.replace`. */
  slice: Slice;
}

export interface KeptNode {
  from: number;
  to: number;
  node: ProseNode;
  /** The line the model sees, such as `[Figure 2: The gate (Aria at dawn)]`. */
  line: string;
}

/** A range to rewrite, split around what must not change. */
export interface RewritePlan {
  from: number;
  to: number;
  /** One more than `kept`: the text before, between and after the kept nodes. */
  segments: { from: number; to: number }[];
  kept: KeptNode[];
  /** Both ends are inside one text block, so no paragraph structure is involved. */
  inline: boolean;
  /** Inside a caption or table cell, where a reply must stay on one line. */
  inlineOnly: boolean;
}

function protectedDepth($pos: ResolvedPos): number | null {
  for (let depth = 1; depth <= $pos.depth; depth += 1) {
    if (isProtected($pos.node(depth))) return depth;
  }
  return null;
}

/**
 * Pulls a selection's ends out of any figure they fall inside. Returns null if nothing
 * is left to rewrite. A selection wholly within one caption or table cell stays as it is,
 * since that text is what the writer pointed at.
 */
export function safeRange(
  doc: ProseNode,
  from: number,
  to: number,
): { from: number; to: number; inlineOnly: boolean } | null {
  if (from >= to) return null;
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  const fromDepth = protectedDepth($from);
  const toDepth = protectedDepth($to);
  if (fromDepth !== null && toDepth !== null && $from.before(fromDepth) === $to.before(toDepth)) {
    if (!$from.sameParent($to) || !$from.parent.isTextblock) return null;
    const inner = trimEdges(doc, from, to);
    return inner ? { ...inner, inlineOnly: true } : null;
  }
  const start = fromDepth !== null ? $from.after(fromDepth) : from;
  const end = toDepth !== null ? $to.before(toDepth) : to;
  if (start >= end) return null;
  const inner = trimEdges(doc, start, end);
  return inner ? { ...inner, inlineOnly: false } : null;
}

/**
 * Leaves spaces at the edges of a selection out of it. Double-clicking a word on Windows
 * takes the space after it, and a model replies without one, which would run the word
 * into whatever follows.
 */
function trimEdges(doc: ProseNode, from: number, to: number): { from: number; to: number } | null {
  const isSpace = (at: number) => /^\s$/.test(doc.textBetween(at, at + 1));
  let start = from;
  let end = to;
  while (start < end && isSpace(start)) start += 1;
  while (end > start && isSpace(end - 1)) end -= 1;
  return start < end ? { from: start, to: end } : null;
}

/** Numbering comes from the whole document, so a figure keeps its real name in a range. */
function keptLines(doc: ProseNode): Map<number, string> {
  const infos = describeFigures(doc.toJSON() as PmNode);
  const lines = new Map<number, string>();
  let index = 0;
  doc.descendants((node, pos) => {
    if (node.type.name === 'figure') {
      const info = infos[index];
      index += 1;
      if (info) lines.set(pos, figureToLine(info));
    }
  });
  return lines;
}

function bareLine(node: ProseNode): string {
  if (node.type.name === 'table') return `[Table: ${node.textContent.slice(0, 60)}]`;
  return `[${node.type.name === 'video' ? 'Video' : 'Picture'}: ${String(node.attrs.alt ?? '') || 'no label'}]`;
}

/** Plans a rewrite of `from..to`. Returns null if there is nothing there to rewrite. */
export function planRewrite(doc: ProseNode, from: number, to: number): RewritePlan | null {
  const range = safeRange(doc, from, to);
  if (!range) return null;
  const lines = keptLines(doc);
  const kept: KeptNode[] = [];
  doc.nodesBetween(range.from, range.to, (node, pos) => {
    if (!isProtected(node)) return true;
    // A selection held inside one caption or cell is not crossing it.
    if (range.inlineOnly) return true;
    kept.push({ from: pos, to: pos + node.nodeSize, node, line: lines.get(pos) ?? bareLine(node) });
    return false;
  });
  const segments: { from: number; to: number }[] = [];
  let cursor = range.from;
  for (const item of kept) {
    segments.push({ from: cursor, to: item.from });
    cursor = item.to;
  }
  segments.push({ from: cursor, to: range.to });
  return {
    from: range.from,
    to: range.to,
    segments,
    kept,
    inline: doc.resolve(range.from).sameParent(doc.resolve(range.to)),
    inlineOnly: range.inlineOnly,
  };
}

/** True if the range holds any writing, rather than only figures. */
export function hasText(doc: ProseNode, plan: RewritePlan): boolean {
  return plan.segments.some((s) => s.from < s.to && doc.textBetween(s.from, s.to, ' ').trim().length > 0);
}

function sliceToDoc(doc: ProseNode, from: number, to: number): PmNode {
  if (from >= to) return { type: 'doc', content: [] };
  // Keeping the parents means a partly selected list still reads as a list.
  const slice = doc.slice(from, to, !doc.resolve(from).sameParent(doc.resolve(to)));
  const content = slice.content.toJSON() as PmNode[] | null;
  const nodes = content ?? [];
  if (nodes.length > 0 && (nodes[0].type === 'text' || slice.content.firstChild?.isInline)) {
    return { type: 'doc', content: [{ type: 'paragraph', content: nodes }] };
  }
  return { type: 'doc', content: nodes };
}

const KEEP_MARK = /\{\{\s*KEEP\s+(\d+)[^{}]*\}\}/g;

function keepMarker(index: number, line: string): string {
  return `{{KEEP ${index + 1}: ${line.replace(/[{}]/g, '')}}}`;
}

/** What the model is given to rewrite: Markdown, with a marker for each kept node. */
export function planToMarkdown(doc: ProseNode, plan: RewritePlan): string {
  const parts: string[] = [];
  plan.segments.forEach((segment, index) => {
    const text = pmToMarkdown(sliceToDoc(doc, segment.from, segment.to)).trim();
    if (text) parts.push(text);
    const kept = plan.kept[index];
    if (kept) parts.push(keepMarker(index, kept.line));
  });
  return parts.join('\n\n');
}

/** The same range as plain text, with real figure numbers, for showing a person. */
export function planToPlainText(doc: ProseNode, plan: RewritePlan): string {
  const parts: string[] = [];
  plan.segments.forEach((segment, index) => {
    const text = pmToPlainText(sliceToDoc(doc, segment.from, segment.to)).trim();
    if (text) parts.push(text);
    if (plan.kept[index]) parts.push(plan.kept[index].line);
  });
  return parts.join('\n\n');
}

/**
 * Splits a reply at its markers into one piece per segment. Markers can be missing, out
 * of order or repeated: a marker only counts when it is the next one or a later one, and
 * anything else is dropped from the text. The kept nodes are untouched either way.
 */
export function splitAtMarkers(reply: string, keptCount: number): string[] {
  const pieces: string[] = [];
  let current = '';
  let cursor = 0;
  let next = 1;
  for (const match of reply.matchAll(KEEP_MARK)) {
    current += reply.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    const number = Number(match[1]);
    if (number < next || number > keptCount) continue;
    pieces.push(current);
    current = '';
    // A skipped marker's segment has no new text.
    for (let skipped = next; skipped < number; skipped += 1) pieces.push('');
    next = number + 1;
  }
  current += reply.slice(cursor);
  pieces.push(current);
  while (pieces.length < keptCount + 1) pieces.push('');
  return pieces;
}

/** Removes markers from text going in somewhere with no kept nodes to line up with. */
export function stripMarkers(reply: string): string {
  return reply.replace(KEEP_MARK, '').replace(/\n{3,}/g, '\n\n').trim();
}

const KEPT_OUT_OF_REPLIES = new Set(['image', 'video']);

/**
 * AI output is untrusted. A model cannot place media: it has no assets, and a remote
 * address must not end up in the project. Its label is kept as text so nothing it
 * wrote silently vanishes.
 */
export function withoutModelMedia(nodes: PmNode[] | undefined): PmNode[] {
  const out: PmNode[] = [];
  for (const node of nodes ?? []) {
    if (node.type === 'figure') {
      const media = node.content?.find((c) => c.type !== 'figcaption');
      if (media && KEPT_OUT_OF_REPLIES.has(media.type)) {
        const caption = node.content?.find((c) => c.type === 'figcaption');
        if (caption?.content?.length) out.push({ type: 'paragraph', content: caption.content });
        continue;
      }
      out.push(node);
      continue;
    }
    if (KEPT_OUT_OF_REPLIES.has(node.type)) continue;
    out.push(node.content ? { ...node, content: withoutModelMedia(node.content) } : node);
  }
  return out;
}

function parseReply(markdown: string, schema: Schema, inlineOnly: boolean): ProseNode | null {
  const parsed = markdownToPm(markdown);
  let blocks = withoutModelMedia(parsed.content);
  if (inlineOnly) {
    // A caption or cell holds one line, so a longer reply is joined into one.
    const inline: PmNode[] = [];
    const collect = (nodes: PmNode[] | undefined) => {
      for (const node of nodes ?? []) {
        if (node.type === 'text' || node.type === 'hardBreak' || node.type === 'reference') {
          inline.push(node);
        } else {
          if (inline.length > 0) inline.push({ type: 'text', text: ' ' });
          collect(node.content);
        }
      }
    };
    collect(blocks);
    while (inline.length > 0 && inline[0].type === 'text' && inline[0].text === ' ') inline.shift();
    blocks = [{ type: 'paragraph', content: inline.length > 0 ? inline : undefined }];
  }
  if (blocks.length === 0) return null;
  try {
    const node = ProseNode.fromJSON(schema, { type: 'doc', content: blocks });
    node.check();
    return node;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

interface Token {
  /** What is compared. Text and marks both count, so bolding a word is a change. */
  key: string;
  from: number;
  to: number;
  isSpace: boolean;
}

const WORD = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*|\s+|[^\s\p{L}\p{N}]/gu;

function marksKey(node: ProseNode): string {
  // A model never sees comments, so one on a word does not make that word a change.
  const marks = node.marks.filter((m) => m.type.name !== 'comment');
  if (marks.length === 0) return '';
  const parts = marks.map((m) => `${m.type.name}${JSON.stringify(m.attrs)}`).sort();
  return `\u0001${parts.join('\u0001')}`;
}

function blockPath($pos: ResolvedPos): string {
  const names: string[] = [];
  for (let depth = 1; depth <= $pos.depth; depth += 1) {
    const node = $pos.node(depth);
    names.push(node.type.name === 'heading' ? `heading${String(node.attrs.level)}` : node.type.name);
  }
  return names.join('/');
}

/**
 * Every word, space and mark of punctuation in a range, plus one token for each break
 * between blocks. Positions are real, so a run of tokens is a real document range.
 */
function tokenize(doc: ProseNode, from: number, to: number): Token[] {
  const tokens: Token[] = [];
  let previous: { end: number; path: string } | null = null;

  const boundary = (start: number, path: string) => {
    if (previous) {
      tokens.push({ key: `\u0002${previous.path}|${path}`, from: previous.end, to: start, isSpace: false });
    }
  };

  doc.nodesBetween(from, to, (node, pos) => {
    // A figure or table counts as one unit, when it is wholly in the range. A reply can
    // hold a new table, and a range inside a caption is inside the figure, not across it.
    const unit = (isProtected(node) && pos >= from && pos + node.nodeSize <= to) || (node.isLeaf && node.isBlock);
    if (unit) {
      const path = `${blockPath(doc.resolve(pos))}/${node.type.name}`;
      boundary(pos, path);
      tokens.push({ key: `\u0003${JSON.stringify(node.toJSON())}`, from: pos, to: pos + node.nodeSize, isSpace: false });
      previous = { end: pos + node.nodeSize, path };
      return false;
    }
    if (!node.isTextblock) return true;

    const contentStart = pos + 1;
    const contentEnd = pos + node.nodeSize - 1;
    const path = blockPath(doc.resolve(contentStart));
    boundary(Math.max(contentStart, from), path);
    node.forEach((child, offset) => {
      const childFrom = contentStart + offset;
      const childTo = childFrom + child.nodeSize;
      if (childTo <= from || childFrom >= to) return;
      if (child.isText) {
        const start = Math.max(childFrom, from);
        const end = Math.min(childTo, to);
        const text = (child.text ?? '').slice(start - childFrom, end - childFrom);
        const marks = marksKey(child);
        for (const match of text.matchAll(WORD)) {
          const tokenFrom = start + match.index;
          tokens.push({
            key: match[0] + marks,
            from: tokenFrom,
            to: tokenFrom + match[0].length,
            isSpace: /^\s+$/.test(match[0]),
          });
        }
      } else {
        tokens.push({
          key: `\u0003${child.type.name}${JSON.stringify(child.attrs)}`,
          from: childFrom,
          to: childTo,
          isSpace: false,
        });
      }
    });
    previous = { end: Math.min(contentEnd, to), path };
    return false;
  });
  return tokens;
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

let nextHunkId = 1;
function hunkId(): string {
  nextHunkId += 1;
  return `h${nextHunkId}`;
}

interface Group {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

/** Word-level changes between two token lists, or null if the diff gave up. */
function diffGroups(oldTokens: Token[], newTokens: Token[]): Group[] | null {
  const changes = diffArrays(
    oldTokens.map((t) => t.key),
    newTokens.map((t) => t.key),
    // Two long, wholly different texts can take a long time to compare.
    { timeout: 800 },
  );
  if (!changes) return null;
  const groups: Group[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  for (const change of changes) {
    const count = change.count ?? change.value.length;
    if (!change.added && !change.removed) {
      oldIndex += count;
      newIndex += count;
      continue;
    }
    const last = groups[groups.length - 1];
    const group: Group =
      last && last.oldEnd === oldIndex && last.newEnd === newIndex
        ? last
        : { oldStart: oldIndex, oldEnd: oldIndex, newStart: newIndex, newEnd: newIndex };
    if (group !== last) groups.push(group);
    if (change.removed) {
      oldIndex += count;
      group.oldEnd = oldIndex;
    } else {
      newIndex += count;
      group.newEnd = newIndex;
    }
  }
  // "the quick" to "a slow" reads better as one change than as two with a kept space.
  const merged: Group[] = [];
  for (const group of groups) {
    const last = merged[merged.length - 1];
    if (last) {
      const between = oldTokens.slice(last.oldEnd, group.oldStart);
      if (between.length === 1 && between[0].isSpace) {
        last.oldEnd = group.oldEnd;
        last.newEnd = group.newEnd;
        continue;
      }
    }
    merged.push({ ...group });
  }
  return merged;
}

function wholeSegmentHunk(
  doc: ProseNode,
  segment: { from: number; to: number },
  reply: ProseNode,
  inlineOnly: boolean,
): Hunk {
  const $from = doc.resolve(segment.from);
  const $to = doc.resolve(segment.to);
  const content = reply.content;
  const first = content.firstChild;
  const last = content.lastChild;
  if (inlineOnly) {
    // A caption or cell keeps its own block. Only the words inside it change.
    return { id: hunkId(), from: segment.from, to: segment.to, slice: new Slice(content, 1, 1) };
  }
  // Whole blocks are replaced as whole blocks, so block types can change.
  const startsBlock = !$from.parent.isTextblock || $from.parentOffset === 0;
  const endsBlock = !$to.parent.isTextblock || $to.parentOffset === $to.parent.content.size;
  if (startsBlock && endsBlock) {
    return {
      id: hunkId(),
      from: $from.parent.isTextblock ? $from.before() : segment.from,
      to: $to.parent.isTextblock ? $to.after() : segment.to,
      slice: new Slice(content, 0, 0),
    };
  }
  const openStart = !startsBlock && first?.isTextblock ? 1 : 0;
  const openEnd = !endsBlock && last?.isTextblock ? 1 : 0;
  return { id: hunkId(), from: segment.from, to: segment.to, slice: new Slice(content, openStart, openEnd) };
}

function tokenHunks(oldTokens: Token[], newTokens: Token[], groups: Group[], reply: ProseNode, segment: { from: number; to: number }): Hunk[] {
  return groups.map((group) => {
    let from: number;
    let to: number;
    if (group.oldStart < group.oldEnd) {
      from = oldTokens[group.oldStart].from;
      to = oldTokens[group.oldEnd - 1].to;
    } else if (group.oldStart > 0) {
      from = oldTokens[group.oldStart - 1].to;
      to = from;
    } else {
      from = oldTokens[0]?.from ?? segment.from;
      to = from;
    }
    const slice =
      group.newStart < group.newEnd
        ? reply.slice(newTokens[group.newStart].from, newTokens[group.newEnd - 1].to)
        : Slice.empty;
    return { id: hunkId(), from, to, slice };
  });
}

/** Applies changes to a copy of the document. Later ones first, so positions hold. */
export function applyHunks(doc: ProseNode, hunks: Hunk[]): Transform {
  const tr = new Transform(doc);
  for (const hunk of [...hunks].sort((a, b) => b.from - a.from || b.to - a.to)) {
    tr.replace(hunk.from, hunk.to, hunk.slice);
  }
  return tr;
}

function tokensMatch(doc: Transform['doc'], from: number, to: number, expected: Token[]): boolean {
  const got = tokenize(doc, from, to);
  if (got.length !== expected.length) return false;
  return got.every((token, index) => token.key === expected[index].key);
}

function segmentHunks(doc: ProseNode, segment: { from: number; to: number }, markdown: string, inlineOnly: boolean): Hunk[] {
  const text = markdown.trim();
  const oldTokens = segment.from < segment.to ? tokenize(doc, segment.from, segment.to) : [];
  const reply = text ? parseReply(text, doc.type.schema, inlineOnly) : null;

  if (!reply || reply.textContent.trim() === '') {
    // No new text for this stretch, so what was there goes.
    if (oldTokens.length === 0) return [];
    return [{ id: hunkId(), from: segment.from, to: segment.to, slice: Slice.empty }];
  }
  if (oldTokens.length === 0) return [wholeSegmentHunk(doc, segment, reply, inlineOnly)];

  const newTokens = tokenize(reply, 0, reply.content.size);
  if (!inlineOnly && firstBlockTypeChanged(doc, segment, oldTokens[0], reply, newTokens[0])) {
    return [wholeSegmentHunk(doc, segment, reply, inlineOnly)];
  }
  const groups = diffGroups(oldTokens, newTokens);
  if (!groups) return [wholeSegmentHunk(doc, segment, reply, inlineOnly)];
  const hunks = tokenHunks(oldTokens, newTokens, groups, reply, segment);
  // Confirm the changes really produce the reply. Anything unusual in the structure
  // falls back to replacing the stretch whole, which is plainer but always right.
  try {
    const tr = applyHunks(doc, hunks);
    const start = tr.mapping.map(segment.from, -1);
    const end = tr.mapping.map(segment.to, 1);
    if (tokensMatch(tr.doc, start, end, newTokens)) return hunks;
  } catch {
    // Fall through to the whole stretch.
  }
  return [wholeSegmentHunk(doc, segment, reply, inlineOnly)];
}

function ownType($pos: ResolvedPos): string {
  const node = $pos.parent;
  return node.type.name === 'heading' ? `heading${String(node.attrs.level)}` : node.type.name;
}

/**
 * Turning a whole paragraph into a heading, say, cannot be expressed as a change of
 * words. A block only partly selected keeps its type, whatever the reply starts with.
 */
function firstBlockTypeChanged(
  doc: ProseNode,
  segment: { from: number; to: number },
  firstOld: Token,
  reply: ProseNode,
  firstNew: Token | undefined,
): boolean {
  if (!firstNew) return false;
  const $old = doc.resolve(firstOld.from);
  if (!$old.parent.isTextblock || $old.parentOffset !== 0 || segment.to < $old.end()) return false;
  return ownType($old) !== ownType(reply.resolve(firstNew.from));
}

/**
 * True if every figure, table and image is still there, unchanged and in the same order.
 * New ones may appear between them, since a model can add a table. Inside a caption or
 * cell the words are meant to change, so there only the node's identity must hold.
 */
export function keptNodesIntact(before: ProseNode, after: ProseNode, inlineOnly = false): boolean {
  const collect = (doc: ProseNode) => {
    const found: ProseNode[] = [];
    doc.descendants((node) => {
      if (!isProtected(node)) return true;
      found.push(node);
      return false;
    });
    return found;
  };
  const was = collect(before);
  const now = collect(after);
  if (inlineOnly) {
    return (
      was.length === now.length &&
      was.every((node, i) => node.type === now[i].type && JSON.stringify(node.attrs) === JSON.stringify(now[i].attrs))
    );
  }
  let matched = 0;
  for (const node of now) {
    if (matched < was.length && node.eq(was[matched])) matched += 1;
  }
  return matched === was.length;
}

export class FigureSafetyError extends Error {
  constructor() {
    super(t('That change would have altered a figure, so it was not applied.'));
    this.name = 'FigureSafetyError';
  }
}

/**
 * Word-level changes that turn a planned range into the reply. Throws rather than ever
 * returning a change that would alter a figure.
 */
export function computeHunks(doc: ProseNode, plan: RewritePlan, reply: string): Hunk[] {
  const pieces = plan.inlineOnly ? [stripMarkers(reply)] : splitAtMarkers(reply, plan.kept.length);
  const segments = plan.inlineOnly ? [{ from: plan.from, to: plan.to }] : plan.segments;
  const hunks = segments.flatMap((segment, index) => segmentHunks(doc, segment, pieces[index] ?? '', plan.inlineOnly));
  if (hunks.length > 0) {
    const tr = applyHunks(doc, hunks);
    if (!keptNodesIntact(doc, tr.doc, plan.inlineOnly)) throw new FigureSafetyError();
  }
  return hunks;
}

/**
 * One change that adds text at a position. A reply that continues mid-paragraph flows
 * into it. Otherwise it arrives as new blocks after the current one, and an empty block
 * there is replaced rather than left behind.
 */
export function computeInsertion(doc: ProseNode, position: number, markdown: string): Hunk[] {
  const reply = parseReply(stripMarkers(markdown), doc.type.schema, false);
  if (!reply || reply.textContent.trim() === '') return [];
  const content: Fragment = reply.content;

  let pos = position;
  const $start = doc.resolve(pos);
  const depth = protectedDepth($start);
  if (depth !== null) pos = $start.after(depth);
  const $pos = doc.resolve(pos);

  let hunk: Hunk;
  if (!$pos.parent.isTextblock) {
    hunk = { id: hunkId(), from: pos, to: pos, slice: new Slice(content, 0, 0) };
  } else if ($pos.parent.content.size === 0) {
    hunk = { id: hunkId(), from: $pos.before(), to: $pos.after(), slice: new Slice(content, 0, 0) };
  } else if ($pos.parentOffset === $pos.parent.content.size) {
    const after = $pos.after();
    hunk = { id: hunkId(), from: after, to: after, slice: new Slice(content, 0, 0) };
  } else {
    const last = content.lastChild;
    const flows = content.firstChild?.isTextblock ? 1 : 0;
    hunk = { id: hunkId(), from: pos, to: pos, slice: new Slice(content, flows, last?.isTextblock ? 1 : 0) };
  }
  const tr = applyHunks(doc, [hunk]);
  if (!keptNodesIntact(doc, tr.doc)) throw new FigureSafetyError();
  return [hunk];
}

/** Tidies what models tend to wrap around a rewrite. */
export function cleanReply(reply: string, original = ''): string {
  let text = reply.trim();
  const fence = /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fence) text = fence[1].trim();
  // Models sometimes echo the block they were given, tags and all.
  const echoed = /^<selection\b[^>]*>\s*([\s\S]*?)\s*<\/selection>$/.exec(text);
  if (echoed) text = echoed[1].trim();
  text = text.replace(/^(?:here(?:'|’)?s|here is|sure|certainly|okay|ok)\b[^\n]*:\s*\n+/i, '').trim();
  const open = text[0];
  const close = text[text.length - 1];
  const quoted = (open === '"' && close === '"') || (open === '“' && close === '”');
  // Only a wrapper if the original had none and there are no quotes inside it.
  if (quoted && !/^["“]/.test(original.trim()) && !/["“”]/.test(text.slice(1, -1))) {
    text = text.slice(1, -1).trim();
  }
  return text;
}
