/**
 * Word-level comparison of two versions. Lines are compared first and only changed
 * lines word by word, which keeps long articles fast and stops an unrelated rewrite
 * from turning into confetti.
 */

import { diffArrays, diffWordsWithSpace } from 'diff';

import { infoboxLines, normalizeInfobox } from './infobox';
import { pmToMarkdown, pmToPlainText } from '../editor/convert';
import { wordCount } from '../lib/text';
import type { PmNode } from '../lib/types';

export type RunKind = 'same' | 'ins' | 'del';

export interface DiffRun {
  kind: RunKind;
  text: string;
}

export interface DiffLine {
  kind: 'same' | 'changed';
  runs: DiffRun[];
}

/** A stretch of unchanged lines, which the UI can fold away. */
export interface DiffSkip {
  kind: 'skip';
  lines: DiffLine[];
}

const WORD_DIFF_TIMEOUT_MS = 300;
/** Below this share of shared text, showing old and new apart is easier to read. */
const MIN_SHARED = 0.3;

function splitLines(text: string): string[] {
  return text.split(/\n+/).filter((line) => line.trim() !== '');
}

function wholeLine(kind: RunKind, text: string): DiffLine {
  return { kind: kind === 'same' ? 'same' : 'changed', runs: [{ kind, text }] };
}

/** One old line against the new line that replaced it. */
function compareLine(older: string, newer: string): DiffLine[] {
  const changes = diffWordsWithSpace(older, newer, { timeout: WORD_DIFF_TIMEOUT_MS });
  if (!changes) return [wholeLine('del', older), wholeLine('ins', newer)];
  let shared = 0;
  for (const change of changes) {
    if (!change.added && !change.removed && change.value.trim()) shared += change.value.length;
  }
  if (shared < MIN_SHARED * Math.max(older.length, newer.length)) {
    return [wholeLine('del', older), wholeLine('ins', newer)];
  }
  const runs: DiffRun[] = changes.map((change) => ({
    kind: change.added ? 'ins' : change.removed ? 'del' : 'same',
    text: change.value,
  }));
  return [{ kind: 'changed', runs }];
}

export function compareTexts(older: string, newer: string): DiffLine[] {
  const lines: DiffLine[] = [];
  const changes = diffArrays(splitLines(older), splitLines(newer));
  for (let i = 0; i < changes.length; i += 1) {
    const change = changes[i];
    if (!change.added && !change.removed) {
      for (const line of change.value) lines.push(wholeLine('same', line));
      continue;
    }
    const next = changes[i + 1];
    if (change.removed && next?.added) {
      // Lines replaced in place are compared with each other, in order.
      const shared = Math.min(change.value.length, next.value.length);
      for (let j = 0; j < shared; j += 1) lines.push(...compareLine(change.value[j], next.value[j]));
      for (const line of change.value.slice(shared)) lines.push(wholeLine('del', line));
      for (const line of next.value.slice(shared)) lines.push(wholeLine('ins', line));
      i += 1;
      continue;
    }
    for (const line of change.value) lines.push(wholeLine(change.added ? 'ins' : 'del', line));
  }
  return lines;
}

/** Folds runs of unchanged lines, keeping `context` lines beside each change. */
export function foldUnchanged(lines: DiffLine[], context = 1): (DiffLine | DiffSkip)[] {
  const out: (DiffLine | DiffSkip)[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== 'same') {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    let end = i;
    while (end < lines.length && lines[end].kind === 'same') end += 1;
    const keepStart = i === 0 ? 0 : context;
    const keepEnd = end === lines.length ? 0 : context;
    const count = end - i;
    if (count > keepStart + keepEnd + 1) {
      out.push(...lines.slice(i, i + keepStart));
      out.push({ kind: 'skip', lines: lines.slice(i + keepStart, end - keepEnd) });
      out.push(...lines.slice(end - keepEnd, end));
    } else {
      out.push(...lines.slice(i, end));
    }
    i = end;
  }
  return out;
}

export function countChanges(lines: DiffLine[]): { inserted: number; deleted: number } {
  const counts = { inserted: 0, deleted: 0 };
  for (const line of lines) {
    for (const run of line.runs) {
      if (run.kind === 'ins') counts.inserted += wordCount(run.text);
      if (run.kind === 'del') counts.deleted += wordCount(run.text);
    }
  }
  return counts;
}

export interface VersionParts {
  content: PmNode;
  /** Absent for a revision made before these were stored. */
  infobox?: unknown;
  summary?: string;
}

/**
 * A version as comparable text. Markup mode uses Markdown, which also shows changes to
 * link targets, formatting and citations.
 */
export function versionText(version: VersionParts, markup: boolean, withExtras: boolean): string {
  const body = markup ? pmToMarkdown(version.content) : pmToPlainText(version.content);
  if (!withExtras) return body;
  const lines: string[] = [];
  if (version.summary) lines.push(`Summary: ${version.summary}`);
  lines.push(...infoboxLines(normalizeInfobox(version.infobox)));
  return [...lines, body].join('\n');
}
