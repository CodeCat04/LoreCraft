/** What a page made from an idea starts with. */

import type { PmNode } from '../lib/types';

const MAX_TITLE_CHARS = 80;

/** The first line, cut at a word if it is long, without the punctuation that ends a sentence. */
export function titleFromIdea(text: string): string {
  const line = text.trim().split(/\r?\n/, 1)[0].trim();
  let title = line;
  if (title.length > MAX_TITLE_CHARS) {
    const cut = title.slice(0, MAX_TITLE_CHARS + 1);
    const space = cut.lastIndexOf(' ');
    title = space > 0 ? cut.slice(0, space) : cut.slice(0, MAX_TITLE_CHARS);
  }
  return title.replace(/[\s.,;:!?…—–-]+$/u, '');
}

/**
 * A template's body with the idea as its opening text, one paragraph per block of lines.
 * An idea that is only a title has nothing to add, so the page starts empty as usual.
 */
export function bodyFromIdea(body: PmNode, text: string, title: string): PmNode {
  const trimmed = text.trim();
  const same = trimmed.replace(/[\s.,;:!?…—–-]+$/u, '') === title.trim();
  if (same || !trimmed) return body;
  const blocks = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): PmNode => ({ type: 'paragraph', content: [{ type: 'text', text: line }] }));
  const rest = body.content ?? [];
  // The empty lead paragraph of a template gives way to the idea.
  const first = rest[0];
  const after = first?.type === 'paragraph' && !first.content?.length ? rest.slice(1) : rest;
  return { ...body, content: [...blocks, ...after] };
}
