/**
 * Word documents. `mammoth` turns the file into HTML, and the editor's own schema turns
 * that into a document, so anything Word has that the app does not simply falls away.
 */

import { DOMParser as ProseParser } from '@tiptap/pm/model';

import { pmToPlainText } from '../../editor/convert';
import type { PmNode } from '../../lib/types';
import { mapDoc } from '../util';
import { documentProblem, documentSchema } from './schemaCheck';
import {
  emptyPayload,
  type ImportProblem,
  type Normalized,
  type PayloadAsset,
  type PayloadNode,
  type PayloadPage,
} from './types';

export interface DocxOptions {
  /** One wiki page, a page per heading, or a book with chapters and scenes. */
  mode: 'page' | 'pages' | 'book';
  /** The heading level that starts a new page, for `pages`. */
  splitLevel: number;
  /** From the file's name, when the document has no title of its own. */
  fallbackTitle: string;
}

const SCENE_BREAK = /^\s*(?:[*#~•⁂_\-–—]\s*){1,5}$/;
const PART_HEADING = /^\s*(part|book|volume)\b/i;
const FIGURE_LABEL = /^\s*(figure|picture|table|video)\s+\d+\s*[.:]\s*/i;

function headingLevel(node: PmNode): number | null {
  return node.type === 'heading' ? Number(node.attrs?.level ?? 1) : null;
}

function plain(node: PmNode): string {
  return pmToPlainText(node).trim();
}

function toDoc(blocks: PmNode[]): PmNode {
  return { type: 'doc', content: blocks.length > 0 ? blocks : [{ type: 'paragraph' }] };
}

interface Parsed {
  doc: PmNode;
  title: string | null;
  subtitle: string | null;
  author: string | null;
  assets: PayloadAsset[];
}

/** Word footnotes become the app's citations. */
function convertFootnotes(root: Element) {
  const noteText = new Map<string, string>();
  for (const item of root.querySelectorAll('li[id^="footnote-"], li[id^="endnote-"]')) {
    const copy = item.cloneNode(true) as Element;
    copy.querySelectorAll('a[href^="#footnote-ref"], a[href^="#endnote-ref"]').forEach((a) => a.remove());
    noteText.set(item.id, (copy.textContent ?? '').trim());
  }
  for (const link of root.querySelectorAll('a[href^="#footnote-"], a[href^="#endnote-"]')) {
    const id = (link.getAttribute('href') ?? '').slice(1);
    const text = noteText.get(id);
    if (text === undefined) continue;
    const sup = root.ownerDocument.createElement('sup');
    sup.setAttribute('data-reference', '');
    sup.setAttribute('data-text', text);
    (link.closest('sup') ?? link).replaceWith(sup);
  }
  for (const item of [...root.querySelectorAll('li[id^="footnote-"], li[id^="endnote-"]')]) {
    const list = item.parentElement;
    item.remove();
    if (list && list.children.length === 0) list.remove();
  }
}

/** Pictures come as `data:` URLs, and leave as files in the project. */
function extractImages(root: Element): PayloadAsset[] {
  const assets: PayloadAsset[] = [];
  const stamp = Date.now().toString(36);
  root.querySelectorAll('img').forEach((img, index) => {
    const match = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(img.getAttribute('src') ?? '');
    if (!match) {
      img.remove();
      return;
    }
    const id = `import-${stamp}-${index + 1}`;
    const extension = match[1].split('/')[1].replace('jpeg', 'jpg');
    assets.push({ id, name: `image-${index + 1}.${extension}`, mime: match[1], base64: match[2] });
    img.setAttribute('src', `asset:${id}`);
    img.setAttribute('data-asset-id', id);
  });
  return assets;
}

function takeText(root: Element, selector: string): string | null {
  const element = root.querySelector(selector);
  if (!element) return null;
  const text = (element.textContent ?? '').trim();
  element.remove();
  return text || null;
}

/**
 * Wraps each picture in a figure, taking the next paragraph as its label if it is one, and
 * each table that has a label too. Only blocks at the top level can become figures.
 */
function intoFigures(blocks: PmNode[], captions: Set<string>): PmNode[] {
  const out: PmNode[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    const next = blocks[i + 1];
    const labeled = next?.type === 'paragraph' && captions.has(plain(next));
    if (block.type !== 'image' && !(block.type === 'table' && labeled)) {
      out.push(block);
      continue;
    }
    let caption: PmNode[] = [];
    let kind = block.type === 'table' ? 'table' : 'figure';
    if (labeled) {
      const label = FIGURE_LABEL.exec(plain(next));
      if (label && block.type === 'image' && label[1].toLowerCase() === 'picture') kind = 'picture';
      caption = (next.content ?? []).map((node, index) => {
        if (index !== 0 || node.type !== 'text' || !label) return node;
        return { ...node, text: (node.text ?? '').replace(FIGURE_LABEL, '') };
      }).filter((node) => node.type !== 'text' || node.text);
      i += 1;
    }
    const description = String(block.attrs?.alt ?? '');
    const figcaption: PmNode = caption.length > 0 ? { type: 'figcaption', content: caption } : { type: 'figcaption' };
    out.push({
      type: 'figure',
      attrs: { kind, align: 'center', width: null, description },
      content: [block, figcaption],
    });
  }
  return out;
}

/** The parser needs an address to accept a picture, but it is only the asset that counts. */
function withStoredImages(doc: PmNode): PmNode {
  return mapDoc(doc, (node) =>
    node.type === 'image' ? { ...node, attrs: { assetId: node.attrs?.assetId, alt: node.attrs?.alt ?? '', src: null, title: null } } : node,
  ) as PmNode;
}

export function parseDocxHtml(html: string): Parsed {
  const page = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');
  const root = page.body;
  convertFootnotes(root);
  const assets = extractImages(root);
  const title = takeText(root, 'h1.doc-title');
  const subtitle = takeText(root, 'p.doc-subtitle');
  const authorLine = takeText(root, 'p.doc-author');
  const head = takeText(root, 'p.doc-head');
  const author = authorLine?.replace(/^by\s+/i, '') ?? head?.split('\t')[0] ?? null;
  const captions = new Set<string>();
  root.querySelectorAll('p.doc-caption').forEach((p) => captions.add((p.textContent ?? '').trim()));
  const parsed = withStoredImages(ProseParser.fromSchema(documentSchema()).parse(root).toJSON() as PmNode);
  return { doc: { ...parsed, content: intoFigures(parsed.content ?? [], captions) }, title, subtitle, author, assets };
}

function splitIntoPages(parsed: Parsed, options: DocxOptions): PayloadPage[] {
  const pages: PayloadPage[] = [];
  let title = parsed.title ?? options.fallbackTitle;
  let blocks: PmNode[] = [];
  const flush = () => {
    if (blocks.length > 0) pages.push({ source: title, title, content: toDoc(blocks) });
    blocks = [];
  };
  for (const block of parsed.doc.content ?? []) {
    const level = headingLevel(block);
    if (level !== null && level <= options.splitLevel) {
      flush();
      title = plain(block) || options.fallbackTitle;
    } else {
      blocks.push(block);
    }
  }
  flush();
  // A heading with nothing under it is still a page someone meant to write.
  return pages.length > 0 ? pages : [{ source: title, title, content: toDoc([]) }];
}

function splitIntoBook(parsed: Parsed, options: DocxOptions): { children: PayloadNode[]; scenes: number } {
  const blocks = parsed.doc.content ?? [];
  const usesParts = blocks.some((b) => headingLevel(b) === 2) && blocks.some((b) => headingLevel(b) === 1 && PART_HEADING.test(plain(b)));
  const chapterLevel = usesParts ? 2 : 1;
  const sceneLevel = usesParts ? 3 : 2;

  const top: PayloadNode[] = [];
  let part: PayloadNode | null = null;
  let chapter: PayloadNode | null = null;
  let scene: PmNode[] = [];
  let sceneTitle = '';
  let sceneNumber = 0;
  let total = 0;

  const openChapter = (title: string) => {
    chapter = { kind: 'chapter', title, children: [] };
    if (part) part.children?.push(chapter);
    else top.push(chapter);
    sceneNumber = 0;
  };
  const flushScene = () => {
    const hasText = scene.some((b) => plain(b) || b.type === 'figure');
    if (!hasText) {
      scene = [];
      return;
    }
    if (!chapter) openChapter(options.fallbackTitle);
    sceneNumber += 1;
    total += 1;
    chapter?.children?.push({
      kind: 'scene',
      title: sceneTitle || `Scene ${sceneNumber}`,
      content: toDoc(scene),
    });
    scene = [];
    sceneTitle = '';
  };

  for (const block of blocks) {
    const level = headingLevel(block);
    const text = plain(block);
    if (usesParts && level === 1) {
      flushScene();
      part = { kind: 'part', title: text, children: [] };
      top.push(part);
      chapter = null;
    } else if (level === chapterLevel) {
      flushScene();
      openChapter(text || `Chapter ${top.length + 1}`);
    } else if (level === sceneLevel) {
      flushScene();
      sceneTitle = text;
    } else if (block.type === 'paragraph' && text && SCENE_BREAK.test(text)) {
      flushScene();
    } else if (block.type === 'paragraph' && text === 'THE END') {
      // A manuscript's closing line belongs to the format, not the story.
    } else {
      scene.push(block);
    }
  }
  flushScene();
  return { children: top, scenes: total };
}

export function normalizeDocxHtml(html: string, options: DocxOptions): Normalized {
  const parsed = parseDocxHtml(html);
  const problems: ImportProblem[] = [];
  const payload = emptyPayload();
  payload.assets = parsed.assets;
  const check = (doc: PmNode | undefined, item: string) => {
    const problem = doc ? documentProblem(doc) : null;
    if (problem) problems.push({ severity: 'error', item, field: 'content', message: problem });
  };
  if (options.mode === 'page') {
    const title = parsed.title ?? options.fallbackTitle;
    payload.pages = [{ source: title, title, content: parsed.doc }];
    check(parsed.doc, title);
  } else if (options.mode === 'pages') {
    payload.pages = splitIntoPages(parsed, options);
    payload.pages.forEach((page) => check(page.content, page.title));
  } else {
    const { children } = splitIntoBook(parsed, options);
    const title = parsed.title ?? options.fallbackTitle;
    payload.books = [{ source: title, title, subtitle: parsed.subtitle ?? undefined, author: parsed.author ?? undefined, children }];
    const walk = (nodes: PayloadNode[] | undefined) =>
      nodes?.forEach((node) => {
        check(node.content, node.title);
        walk(node.children);
      });
    walk(children);
  }
  return { payload, problems };
}
