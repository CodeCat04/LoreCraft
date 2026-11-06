/** The novel as one Markdown file or one plain text file. */

import { pmToMarkdown, pmToPlainText } from '../../editor/convert';
import type { ExportInput } from '../types';
import { utf8 } from '../util';
import { figureNumberer, figuresAsLines, outlineBooks, type BookOutline, type ChapterOutline } from './structure';

/** Heading levels depend on what sits above a chapter. */
function markdownBook(outline: BookOutline, input: ExportInput, shift: number): string {
  const out: string[] = [];
  const heading = (level: number, text: string) => `${'#'.repeat(level + shift)} ${text}`;
  const { book } = outline;
  out.push(heading(1, book.title));
  if (book.subtitle) out.push(`*${book.subtitle}*`);
  if (book.author) out.push(`by ${book.author}`);
  const next = figureNumberer();

  const chapter = (item: ChapterOutline, level: number) => {
    out.push(heading(level, item.title));
    item.scenes.forEach((scene, index) => {
      if (input.options.sceneTitles && scene.node.title.trim()) {
        out.push(heading(level + 1, scene.node.title.trim()));
      } else if (index > 0) {
        out.push('* * *');
      }
      const body = pmToMarkdown(figuresAsLines(scene.doc, next));
      if (body) out.push(body);
    });
  };

  for (const item of outline.items) {
    if (item.type === 'part') {
      out.push(heading(2, item.title));
      item.chapters.forEach((c) => chapter(c, 3));
    } else {
      chapter(item, outline.hasParts ? 3 : 2);
    }
  }
  return out.join('\n\n');
}

export function exportNovelMarkdown(input: ExportInput): Uint8Array {
  const books = outlineBooks(input.snapshot);
  return utf8(`${books.map((b) => markdownBook(b, input, 0)).join('\n\n')}\n`);
}

function textBook(outline: BookOutline, input: ExportInput): string {
  const out: string[] = [];
  const { book } = outline;
  out.push(book.title.toUpperCase());
  if (book.subtitle) out.push(book.subtitle);
  if (book.author) out.push(`by ${book.author}`);
  const next = figureNumberer();

  const chapter = (item: ChapterOutline) => {
    out.push(`\n${item.title}\n${'-'.repeat(Math.min(60, [...item.title].length))}`);
    item.scenes.forEach((scene, index) => {
      if (input.options.sceneTitles && scene.node.title.trim()) out.push(scene.node.title.trim());
      else if (index > 0) out.push('* * *');
      const body = pmToPlainText(figuresAsLines(scene.doc, next));
      if (body) out.push(body);
    });
  };

  for (const item of outline.items) {
    if (item.type === 'part') {
      out.push(`\n${item.title.toUpperCase()}\n${'='.repeat(Math.min(60, [...item.title].length))}`);
      item.chapters.forEach(chapter);
    } else {
      chapter(item);
    }
  }
  return out.join('\n\n');
}

export function exportNovelText(input: ExportInput): Uint8Array {
  const books = outlineBooks(input.snapshot);
  // CRLF, so that it reads properly in Notepad on the platform this is built for.
  const text = books.map((b) => textBook(b, input)).join('\n\n\n').replace(/\r?\n/g, '\r\n');
  return utf8(`${text}\r\n`);
}
