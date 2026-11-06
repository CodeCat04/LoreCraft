/** Small helpers the exporters share: encoding, escaping, file names and document walking. */

import { strToU8 } from 'fflate';

import type { PmNode } from '../lib/types';
import type { AssetMeta } from './types';

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

export const utf8 = (text: string): Uint8Array => strToU8(text);

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
  }
  return btoa(parts.join(''));
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

/** RFC 5646 syntax, which EPUB and Word expect of a language tag, with the primary codes that exist. */
const LANGUAGE_TAG =
  /^(?:[a-z]{2,3}(?:-[a-z]{3}){0,3}(?:-[a-z]{4})?(?:-(?:[a-z]{2}|\d{3}))?(?:-(?:[a-z\d]{5,8}|\d[a-z\d]{3}))*(?:-[a-wyz\d](?:-[a-z\d]{2,8})+)*(?:-x(?:-[a-z\d]{1,8})+)?|x(?:-[a-z\d]{1,8})+)$/i;

/**
 * The language code typed in the export screen as a real tag. It is typed by hand, so "en_US"
 * or "English" is likely. `valid` is false when it had to fall back to English.
 */
export function languageTag(typed: string): { tag: string; valid: boolean } {
  const cleaned = typed.trim().replace(/_/g, '-');
  if (!cleaned) return { tag: 'en', valid: true };
  return LANGUAGE_TAG.test(cleaned) ? { tag: cleaned, valid: true } : { tag: 'en', valid: false };
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

/** XML 1.0 cannot hold these at all, even as character references. */
const NOT_XML = new RegExp('[^\\t\\n\\r\\u0020-\\uD7FF\\uE000-\\uFFFD\\u{10000}-\\u{10FFFF}]', 'gu');

export function xmlSafe(text: string): string {
  return text.replace(NOT_XML, '');
}

export function xmlText(text: string): string {
  return xmlSafe(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#13;');
}

export function xmlAttr(text: string): string {
  return xmlText(text)
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#9;')
    .replace(/\n/g, '&#10;');
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export function walkDoc(node: PmNode, visit: (node: PmNode) => void) {
  visit(node);
  node.content?.forEach((child) => walkDoc(child, visit));
}

/** A rewritten copy. `change` may return the node given, a new one, or null to drop it. */
export function mapDoc(node: PmNode, change: (node: PmNode) => PmNode | null): PmNode | null {
  const changed = change(node);
  if (!changed?.content) return changed;
  const content: PmNode[] = [];
  for (const child of changed.content) {
    const next = mapDoc(child, change);
    if (next) content.push(next);
  }
  return { ...changed, content };
}

/** Every picture or video a document points at. */
export function assetsInDoc(doc: PmNode | null | undefined, into: Set<string> = new Set()): Set<string> {
  if (!doc) return into;
  walkDoc(doc, (node) => {
    if ((node.type === 'image' || node.type === 'video') && node.attrs?.assetId) {
      into.add(String(node.attrs.assetId));
    }
  });
  return into;
}

/** A copy whose text and attributes hold only characters XML can carry. */
export function xmlSafeDoc(doc: PmNode): PmNode {
  const clean = (value: unknown): unknown => {
    if (typeof value === 'string') return xmlSafe(value);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v)]));
    }
    return value;
  };
  return mapDoc(doc, (node) => {
    const next: PmNode = { ...node };
    if (node.text !== undefined) next.text = xmlSafe(node.text);
    if (node.attrs) next.attrs = clean(node.attrs) as Record<string, unknown>;
    if (node.marks) {
      next.marks = node.marks.map((mark) =>
        mark.attrs ? { ...mark, attrs: clean(mark.attrs) as Record<string, unknown> } : mark,
      );
    }
    return next;
  }) as PmNode;
}

/** A novel is read, not browsed, so wiki links become plain words. */
export function withoutWikiLinks(doc: PmNode): PmNode {
  return mapDoc(doc, (node) => {
    if (!node.marks?.some((m) => m.type === 'wikiLink')) return node;
    const marks = node.marks.filter((m) => m.type !== 'wikiLink');
    const next: PmNode = { ...node };
    if (marks.length > 0) next.marks = marks;
    else delete next.marks;
    return next;
  }) as PmNode;
}

/**
 * Only absolute links stay. A link to `#x` or a local path has nothing to point at in a
 * finished document, and a strict reader reports it as an error.
 */
export function onlyOutsideLinks(doc: PmNode): PmNode {
  return mapDoc(doc, (node) => {
    const link = node.marks?.find((m) => m.type === 'link');
    if (!link || /^(https?:|mailto:)/i.test(String(link.attrs?.href ?? ''))) return node;
    const marks = node.marks?.filter((m) => m !== link);
    const next: PmNode = { ...node };
    if (marks?.length) next.marks = marks;
    else delete next.marks;
    return next;
  }) as PmNode;
}

export function isEmptyDoc(doc: PmNode | null | undefined): boolean {
  if (!doc) return true;
  let empty = true;
  walkDoc(doc, (node) => {
    if (node.type === 'text' && node.text?.trim()) empty = false;
    if (node.type === 'image' || node.type === 'video' || node.type === 'horizontalRule' || node.type === 'reference') {
      empty = false;
    }
  });
  return empty;
}

// ---------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------

/** Windows refuses these whatever follows the dot, so `CON.md` is no better than `CON`. */
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i;

const LONGEST_NAME = 100;

/**
 * Makes text safe as one part of a Windows path. `#`, `^`, `[` and `]` are legal there
 * but break Obsidian's links, so they go too.
 */
export function safeFileName(name: string, fallback = 'Untitled'): string {
  let out = xmlSafe(name)
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*#^[\]\u0000-\u001F\u007F-\u009F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if ([...out].length > LONGEST_NAME) out = [...out].slice(0, LONGEST_NAME).join('');
  // Windows drops trailing dots and spaces, and a leading dot hides a file in Obsidian.
  out = out.replace(/[.\s]+$/, '').replace(/^[.\s]+/, '_');
  if (!out) return fallback;
  return RESERVED.test(out) ? out.replace(/^[^.]*/, (name) => `${name}_`) : out;
}

/** Hands out names no other name here equals, ignoring case as Windows does. */
export class NameKeeper {
  private readonly taken = new Set<string>();

  constructor(reserved: string[] = []) {
    reserved.forEach((name) => this.taken.add(name.toLowerCase()));
  }

  /** The extension, with its dot, is not part of what gets numbered. */
  take(name: string, extension = '', numbered = (n: number) => `${name} (${n})`): string {
    let candidate = name;
    let n = 2;
    while (this.taken.has(`${candidate}${extension}`.toLowerCase())) {
      candidate = numbered(n);
      n += 1;
    }
    this.taken.add(`${candidate}${extension}`.toLowerCase());
    return `${candidate}${extension}`;
  }

  /** For names that go in URLs, which should stay free of spaces. */
  takeSlug(name: string, extension = ''): string {
    return this.take(name, extension, (n) => `${name}-${n}`);
  }
}

/** For the static site: plain ASCII, so links survive any unzip tool or browser. */
export function slugify(text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return RESERVED.test(slug) ? `${slug}-page` : slug;
}

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/ogg': 'ogv',
  'video/quicktime': 'mov',
};

export function extensionFor(asset: Pick<AssetMeta, 'mime' | 'name'>): string {
  const known = EXTENSIONS[asset.mime];
  if (known) return known;
  const match = /\.([a-z0-9]{1,8})$/i.exec(asset.name);
  return match ? match[1].toLowerCase() : 'bin';
}

/** A file name for an asset that keeps its own name where it can. */
export function assetFileName(asset: AssetMeta, keeper: NameKeeper): string {
  const extension = `.${extensionFor(asset)}`;
  const base = asset.name.toLowerCase().endsWith(extension)
    ? asset.name.slice(0, -extension.length)
    : asset.name.replace(/\.[a-z0-9]{1,8}$/i, '');
  return keeper.take(safeFileName(base, 'image'), extension);
}

export function formatBytes(size: number): string {
  if (size >= 1024 * 1024 * 1024) return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} bytes`;
}

// ---------------------------------------------------------------------------
// Names in documents
// ---------------------------------------------------------------------------

/** Checks an ISBN's length and check digit, the mistakes a typo makes. */
export function isbnLooksRight(value: string): boolean {
  const isbn = value.replace(/[\s-]/g, '').toUpperCase();
  if (/^\d{13}$/.test(isbn)) {
    const sum = [...isbn].reduce((total, digit, i) => total + Number(digit) * (i % 2 === 0 ? 1 : 3), 0);
    return sum % 10 === 0;
  }
  if (/^\d{9}[\dX]$/.test(isbn)) {
    const sum = [...isbn].reduce((total, digit, i) => total + (digit === 'X' ? 10 : Number(digit)) * (10 - i), 0);
    return sum % 11 === 0;
  }
  return false;
}

/** Obsidian tags hold letters, numbers, `_`, `-` and `/`, and at least one non-digit. */
export function categoryToTag(category: string): string | null {
  const tag = category
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_/-]/gu, '')
    .replace(/-{2,}/g, '-');
  return /[\p{L}_/-]/u.test(tag) ? tag : null;
}

/** Looks up a page by a wiki link's target. A title outranks another page's alias. */
export function pageResolver<T extends { title: string; aliases: string[] }>(
  pages: T[],
  key: (title: string) => string,
): (target: string) => T | undefined {
  const byKey = new Map<string, T>();
  for (const page of pages) {
    for (const alias of page.aliases) byKey.set(key(alias), page);
  }
  for (const page of pages) byKey.set(key(page.title), page);
  return (target) => byKey.get(key(target));
}
