/** Plain text files, as a wiki page or a scene. The text stays literal, not Markdown. */

import type { PmNode } from '../../lib/types';
import { emptyPayload, type ConflictPolicy, type Normalized } from './types';

/** Reads text that may not be UTF-8, since old manuscripts often are not. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** Long lines broken at one width were wrapped by a program, not by the writer. */
function looksHardWrapped(lines: string[]): boolean {
  return lines.length > 1 && lines.slice(0, -1).every((line) => line.trim().length >= 55);
}

function paragraph(text: string): PmNode {
  return text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' };
}

export function textToDoc(text: string): PmNode {
  const normal = text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').trim();
  if (!normal) return { type: 'doc', content: [{ type: 'paragraph' }] };
  const blocks = normal.split(/\n\s*\n/);
  // With no blank lines at all, each line is a paragraph.
  if (blocks.length === 1 && !looksHardWrapped(normal.split('\n'))) {
    return { type: 'doc', content: normal.split('\n').map((line) => paragraph(line.trim())) };
  }
  const content = blocks.map((block): PmNode => {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    if (looksHardWrapped(lines)) return paragraph(lines.join(' '));
    const inline: PmNode[] = [];
    lines.forEach((line, i) => {
      if (i > 0) inline.push({ type: 'hardBreak' });
      inline.push({ type: 'text', text: line });
    });
    return { type: 'paragraph', content: inline };
  });
  return { type: 'doc', content };
}

export interface TextOptions {
  mode: 'page' | 'scene';
  title: string;
  bookId?: string;
  /** A chapter to add the scene to. Without one, a new chapter is made. */
  chapterId?: string;
}

export function normalizeText(text: string, options: TextOptions, policy: ConflictPolicy = 'skip'): Normalized {
  const payload = emptyPayload(policy);
  const content = textToDoc(text);
  if (options.mode === 'page') {
    payload.pages.push({ source: options.title, title: options.title, content });
  } else {
    const scene = { source: options.title, kind: 'scene' as const, title: options.title, content };
    payload.books.push(
      options.chapterId
        ? { source: options.title, intoBookId: options.bookId, intoParentId: options.chapterId, children: [scene] }
        : options.bookId
          ? { source: options.title, intoBookId: options.bookId, children: [{ kind: 'chapter', title: options.title, children: [scene] }] }
          : { source: options.title, title: options.title, children: [{ kind: 'chapter', title: options.title, children: [scene] }] },
    );
  }
  return { payload, problems: [] };
}
