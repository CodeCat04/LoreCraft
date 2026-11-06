/** What the article's chrome derives from its document: contents and references. */

import type { PmNode } from '../lib/types';

export interface OutlineHeading {
  /** Position among the document's headings. Matches their order in the page. */
  index: number;
  level: number;
  text: string;
  /** For example `2.1`. */
  number: string;
}

function textOf(node: PmNode): string {
  if (node.type === 'text') return node.text ?? '';
  return (node.content ?? []).map(textOf).join('');
}

export function extractHeadings(doc: PmNode): OutlineHeading[] {
  const raw: { level: number; text: string }[] = [];
  const walk = (node: PmNode) => {
    if (node.type === 'heading') {
      raw.push({ level: Number(node.attrs?.level ?? 1), text: textOf(node).trim() });
      return;
    }
    node.content?.forEach(walk);
  };
  walk(doc);

  // Numbering follows nesting, so an article that skips a level still reads cleanly.
  const stack: { level: number; count: number }[] = [];
  return raw.map((heading, index) => {
    while (stack.length > 0 && stack[stack.length - 1].level > heading.level) stack.pop();
    const top = stack[stack.length - 1];
    if (top && top.level === heading.level) top.count += 1;
    else stack.push({ level: heading.level, count: 1 });
    return {
      index,
      level: stack.length,
      text: heading.text,
      number: stack.map((s) => s.count).join('.'),
    };
  });
}

export function extractReferences(doc: PmNode): string[] {
  const refs: string[] = [];
  const walk = (node: PmNode) => {
    if (node.type === 'reference') refs.push(String(node.attrs?.text ?? ''));
    node.content?.forEach(walk);
  };
  walk(doc);
  return refs;
}

/** A document with nothing to read in it: no text, images, tables or citations. */
export function isDocEmpty(doc: PmNode): boolean {
  const hasContent = (node: PmNode): boolean => {
    if (node.type === 'text') return Boolean(node.text?.trim());
    if (['image', 'table', 'reference', 'horizontalRule'].includes(node.type)) return true;
    return (node.content ?? []).some(hasContent);
  };
  return !hasContent(doc);
}

/** A document holding only empty paragraphs, which a template can safely replace. */
export function isDocBlank(doc: PmNode): boolean {
  return (doc.content ?? []).every((n) => n.type === 'paragraph' && isDocEmpty(n));
}
