/**
 * CSV to RFC 4180: CRLF line ends, doubled quotes, and a UTF-8 byte order mark so that
 * Excel reads accented names correctly.
 */

import { zipSync } from 'fflate';

import { pmToPlainText } from '../../editor/convert';
import type { Page } from '../../lib/types';
import { localOnlyNodes } from '../localOnly';
import type { ExportInput, ExportOptions } from '../types';
import { utf8 } from '../util';

const BOM = '﻿';

/** Excel runs a cell starting with one of these as a formula, even from a CSV file. */
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value: unknown, guard: boolean): string {
  // A NUL ends the cell early in Excel and in most parsers.
  let text = String(value ?? '').replace(/\0/g, '');
  if (guard && FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function table(rows: unknown[][], options: ExportOptions): string {
  const guard = options.csvGuardFormulas;
  return `${BOM}${rows.map((row) => row.map((value) => cell(value, guard)).join(',')).join('\r\n')}\r\n`;
}

function list(values: string[]): string {
  return values.join('; ');
}

/** Infobox fields become columns, in the order they first appear. */
function pagesTable(pages: Page[], options: ExportOptions): string {
  const fieldKeys: string[] = [];
  for (const page of pages) {
    for (const field of page.infobox?.fields ?? []) {
      if (!fieldKeys.includes(field.key)) fieldKeys.push(field.key);
    }
  }
  const header = [
    'id', 'title', 'type', 'status', 'summary', 'aliases', 'categories', 'word_count', 'is_home', 'local_only',
    'created_at', 'updated_at', ...fieldKeys.map((k) => `infobox_${k}`), 'text',
  ];
  const rows = pages.map((page) => {
    const fields = new Map((page.infobox?.fields ?? []).map((f) => [f.key, f.value]));
    return [
      page.id, page.title, page.pageType, page.status, page.summary, list(page.aliases), list(page.categories),
      page.wordCount, page.isHome, page.localOnly === true, page.createdAt, page.updatedAt,
      ...fieldKeys.map((k) => fields.get(k) ?? ''),
      pmToPlainText(page.content),
    ];
  });
  return table([header, ...rows], options);
}

function scenesTable(input: ExportInput): string {
  const { snapshot, options } = input;
  const titleOf = new Map(snapshot.pages.map((p) => [p.id, p.title]));
  const bookOf = new Map(snapshot.books.map((b) => [b.id, b.title]));
  const nodeOf = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const header = [
    'id', 'book', 'part', 'chapter', 'title', 'order', 'status', 'pov', 'story_date', 'synopsis', 'notes',
    'word_count', 'target_words', 'local_only', 'created_at', 'updated_at', 'text',
  ];
  // A scene in a marked chapter or part counts as marked.
  const marked = localOnlyNodes(snapshot.nodes);
  const rows = snapshot.nodes
    .filter((n) => n.kind === 'scene')
    .map((node, index) => {
      const chapter = node.parentId ? nodeOf.get(node.parentId) : undefined;
      const part = chapter?.parentId ? nodeOf.get(chapter.parentId) : undefined;
      return [
        node.id, bookOf.get(node.bookId) ?? '', part?.title ?? '', chapter?.title ?? '', node.title, index + 1,
        node.status, node.povPageId ? (titleOf.get(node.povPageId) ?? '') : '', node.storyDate, node.synopsis,
        node.notes, node.wordCount, node.targetWords, marked.has(node.id), node.createdAt, node.updatedAt, pmToPlainText(node.content),
      ];
    });
  return table([header, ...rows], options);
}

function relationshipsTable(input: ExportInput): string {
  const { snapshot, options } = input;
  const titleOf = new Map(snapshot.pages.map((p) => [p.id, p.title]));
  const rows = snapshot.relationships.map((r) => [
    r.fromPageId, titleOf.get(r.fromPageId) ?? '', r.toPageId, titleOf.get(r.toPageId) ?? '', r.kind, r.note,
  ]);
  return table([['from_id', 'from', 'to_id', 'to', 'kind', 'note'], ...rows], options);
}

export function exportCsv(input: ExportInput): Uint8Array {
  const { snapshot, options } = input;
  const pages = pagesTable(snapshot.pages, options);
  if (!options.csvBundle) return utf8(pages);
  return zipSync({
    'pages.csv': utf8(pages),
    'scenes.csv': utf8(scenesTable(input)),
    'relationships.csv': utf8(relationshipsTable(input)),
  });
}
