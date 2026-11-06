/**
 * The EPUB read back the way a validator reads it: the zip container (OCF 3.3), then the
 * package document, spine, navigation, every content document and the NCX (EPUB 3.3).
 * Each check returns what it found wrong, so a failure names every problem at once.
 */

import { readFileSync } from 'node:fs';

import { strFromU8, unzipSync } from 'fflate';

import type { BookPublishing } from '../lib/types';
import { exportEpub } from './novel/epub';
import { doc, fixtureInput, fixtureSnapshot, para, text } from './testFixture';
import type { ExportOptions, ExportSnapshot } from './types';

const NS = {
  xhtml: 'http://www.w3.org/1999/xhtml',
  epub: 'http://www.idpf.org/2007/ops',
  opf: 'http://www.idpf.org/2007/opf',
  dc: 'http://purl.org/dc/elements/1.1/',
  container: 'urn:oasis:names:tc:opendocument:xmlns:container',
  ncx: 'http://www.daisy.org/z3986/2005/ncx/',
  xml: 'http://www.w3.org/XML/1998/namespace',
  svg: 'http://www.w3.org/2000/svg',
  mathml: 'http://www.w3.org/1998/Math/MathML',
};

// ---------------------------------------------------------------------------
// Reading the file
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  offset: number;
  flags: number;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  centralExtra: number;
  localFlags: number;
  localMethod: number;
  localExtra: number;
  localName: string;
}

/** The central directory and each local header, read from the raw bytes. */
function zipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error('No end of central directory');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error(`Bad central header ${i}`);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    if (view.getUint32(offset, true) !== 0x04034b50) throw new Error(`Bad local header ${i}`);
    const localNameLength = view.getUint16(offset + 26, true);
    out.push({
      name: decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)),
      offset,
      flags: view.getUint16(at + 8, true),
      method: view.getUint16(at + 10, true),
      crc: view.getUint32(at + 16, true),
      compressed: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      centralExtra: extra,
      localFlags: view.getUint16(offset + 6, true),
      localMethod: view.getUint16(offset + 8, true),
      localExtra: view.getUint16(offset + 28, true),
      localName: decoder.decode(bytes.subarray(offset + 30, offset + 30 + localNameLength)),
    });
    at += 46 + nameLength + extra + comment;
  }
  return out;
}

function crc32(data: Uint8Array): number {
  let crc = ~0;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function parseXml(source: string, type: DOMParserSupportedType = 'application/xml'): Document {
  const parsed = new DOMParser().parseFromString(source, type);
  const error = parsed.getElementsByTagName('parsererror')[0];
  if (error) throw new Error(`Not well-formed: ${error.textContent}\n${source.slice(0, 300)}`);
  return parsed;
}

interface Item {
  id: string;
  href: string;
  /** The zip entry it names, or null if the href is not a usable relative URL. */
  path: string | null;
  mediaType: string;
  properties: string[];
  fallback: string | null;
}

interface Epub {
  bytes: Uint8Array;
  files: Record<string, Uint8Array>;
  entries: ZipEntry[];
  opfPath: string;
  opf: Document;
  items: Item[];
  byId: Map<string, Item>;
  byPath: Map<string, Item>;
  spine: { idref: string; linear: string | null }[];
  docs: Map<string, Document>;
}

/** A URL a validator accepts as written: no spaces or other characters that need escaping. */
const URL_SAFE = /^(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9A-Fa-f]{2})*$/;
const hasScheme = (url: string) => /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//');

/** A relative URL resolved against the file it is in, as a zip entry name. */
function resolve(from: string, url: string): string | null {
  const [beforeFragment, ...fragment] = url.split('#');
  const path = beforeFragment.split('?')[0];
  const escaped = URL_SAFE.test(beforeFragment) && fragment.length <= 1 && URL_SAFE.test(fragment[0] ?? '');
  if (hasScheme(url) || path.startsWith('/') || !escaped) return null;
  const parts = from.split('/').slice(0, -1);
  if (path === '') return from;
  for (const segment of path.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (decoded === '..') parts.pop();
    else if (decoded !== '.' && decoded !== '') parts.push(decoded);
  }
  return parts.join('/');
}

function load(bytes: Uint8Array): Epub {
  const files = unzipSync(bytes);
  const entries = zipEntries(bytes);
  const container = parseXml(strFromU8(files['META-INF/container.xml']));
  const opfPath = container.getElementsByTagNameNS(NS.container, 'rootfile')[0]?.getAttribute('full-path') ?? '';
  const opf = parseXml(strFromU8(files[opfPath]));
  const items: Item[] = [...opf.getElementsByTagNameNS(NS.opf, 'item')].map((el) => {
    const href = el.getAttribute('href') ?? '';
    return {
      id: el.getAttribute('id') ?? '',
      href,
      path: resolve(opfPath, href),
      mediaType: el.getAttribute('media-type') ?? '',
      properties: (el.getAttribute('properties') ?? '').split(/\s+/).filter(Boolean),
      fallback: el.getAttribute('fallback'),
    };
  });
  const spine = [...opf.getElementsByTagNameNS(NS.opf, 'itemref')].map((el) => ({
    idref: el.getAttribute('idref') ?? '',
    linear: el.getAttribute('linear'),
  }));
  const docs = new Map<string, Document>();
  for (const item of items) {
    if (item.mediaType === 'application/xhtml+xml' && item.path && files[item.path]) {
      docs.set(item.path, parseXml(strFromU8(files[item.path]), 'application/xhtml+xml'));
    }
  }
  return {
    bytes,
    files,
    entries,
    opfPath,
    opf,
    items,
    byId: new Map(items.map((i) => [i.id, i])),
    byPath: new Map(items.filter((i) => i.path).map((i) => [i.path as string, i])),
    spine,
    docs,
  };
}

const all = (root: Document | Element, ns: string, name: string) => [...root.getElementsByTagNameNS(ns, name)];
const epubTypes = (el: Element) => (el.getAttributeNS(NS.epub, 'type') ?? '').split(/\s+/).filter(Boolean);
const ids = (document: Document) => new Set([...document.querySelectorAll('[id]')].map((e) => e.getAttribute('id')));
const words = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();

/** RFC 5646 syntax, with the primary language limited to the two and three letter codes that exist. */
const BCP47 =
  /^(?:[a-z]{2,3}(?:-[a-z]{3}){0,3}(?:-[a-z]{4})?(?:-(?:[a-z]{2}|\d{3}))?(?:-(?:[a-z\d]{5,8}|\d[a-z\d]{3}))*(?:-[a-wyz\d](?:-[a-z\d]{2,8})+)*(?:-x(?:-[a-z\d]{1,8})+)?|x(?:-[a-z\d]{1,8})+)$/i;
const NCNAME = /^[A-Za-z_][\w.-]*$/;
/** OCF 3.3, 6.2.3: characters a file name must not hold. */
const FORBIDDEN_IN_NAME = /["*:<>?\\|\u0000-\u001f\u007f-\u009f-﷐-﷯￰-￿]/;

const MAGIC: [string, (b: Uint8Array) => boolean][] = [
  ['image/png', (b) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)],
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/gif', (b) => /^GIF8[79]a/.test(strFromU8(b.subarray(0, 6)))],
  ['image/webp', (b) => strFromU8(b.subarray(0, 4)) === 'RIFF' && strFromU8(b.subarray(8, 12)) === 'WEBP'],
];
const FONT_TYPES = ['font/ttf', 'font/otf', 'font/woff', 'font/woff2', 'application/font-sfnt', 'application/vnd.ms-opentype', 'application/font-woff'];
const CORE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'application/xhtml+xml', 'text/css',
  'application/x-dtbncx+xml', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/opus', 'text/javascript',
  'application/javascript', 'application/ecmascript', 'application/smil+xml', 'application/pls+xml', ...FONT_TYPES,
]);

/** What a file should be declared as, from its name and first bytes. */
function actualType(name: string, bytes: Uint8Array): string | null {
  const magic = MAGIC.find(([, test]) => test(bytes))?.[0];
  if (magic) return magic;
  if (name.endsWith('.xhtml')) {
    const root = parseXml(strFromU8(bytes), 'application/xhtml+xml').documentElement;
    return root.namespaceURI === NS.xhtml && root.localName === 'html' ? 'application/xhtml+xml' : null;
  }
  if (name.endsWith('.ncx')) return parseXml(strFromU8(bytes)).documentElement.namespaceURI === NS.ncx ? 'application/x-dtbncx+xml' : null;
  if (name.endsWith('.css')) return 'text/css';
  if (/\.(ttf|otf|woff2?)$/.test(name)) return 'font';
  return null;
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

type Check = (epub: Epub) => string[];

const zipContainer: Check = ({ bytes, files, entries }) => {
  const problems: string[] = [];
  const first = entries.slice().sort((a, b) => a.offset - b.offset)[0];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (first.name !== 'mimetype' || first.offset !== 0) problems.push(`first entry is ${first.name} at ${first.offset}`);
  if (first.localMethod !== 0 || first.method !== 0) problems.push('mimetype is compressed');
  if (first.localExtra !== 0) problems.push('mimetype has an extra field');
  if (first.localFlags & 0x8 || first.flags & 0x8) problems.push('mimetype has a data descriptor (bit 3)');
  if (first.localFlags & 0x1) problems.push('mimetype is encrypted');
  if (view.getUint32(18, true) !== 20 || view.getUint32(22, true) !== 20) problems.push('mimetype sizes are not 20 in the local header');
  if (view.getUint32(14, true) !== crc32(files.mimetype)) problems.push('mimetype CRC is wrong');
  if (strFromU8(bytes.subarray(30, 38)) !== 'mimetype' || strFromU8(bytes.subarray(38, 58)) !== 'application/epub+zip') {
    problems.push('mimetype bytes are not at 30 and 38');
  }
  if (strFromU8(files.mimetype) !== 'application/epub+zip') problems.push('mimetype content is wrong');
  const folded = new Set<string>();
  for (const entry of entries) {
    if (entry.name !== entry.localName) problems.push(`${entry.name}: local and central names differ`);
    if (entry.flags & 0x1) problems.push(`${entry.name}: encrypted`);
    if (entry.method !== 0 && entry.method !== 8) problems.push(`${entry.name}: method ${entry.method}`);
    // Bit 11 says the name is UTF-8, which a name outside ASCII needs.
    if (/[^\x20-\x7e]/.test(entry.name) && !(entry.flags & 0x800)) problems.push(`${entry.name}: UTF-8 name without bit 11`);
    const segments = entry.name.split('/');
    if (entry.name.startsWith('/') || segments.some((s) => s === '' || s === '.' || s === '..')) problems.push(`${entry.name}: not a plain path`);
    for (const segment of segments) {
      if (FORBIDDEN_IN_NAME.test(segment) || segment.endsWith('.')) problems.push(`${entry.name}: forbidden characters in a file name`);
    }
    const key = entry.name.normalize('NFC').toLowerCase();
    if (folded.has(key)) problems.push(`${entry.name}: same name as another file, ignoring case`);
    folded.add(key);
    if (!(entry.name in files)) problems.push(`${entry.name}: not read back`);
  }
  return problems;
};

const containerFile: Check = ({ files }) => {
  const problems: string[] = [];
  const container = parseXml(strFromU8(files['META-INF/container.xml']));
  const root = container.documentElement;
  if (root.namespaceURI !== NS.container || root.localName !== 'container') problems.push('container root or namespace is wrong');
  if (root.getAttribute('version') !== '1.0') problems.push('container version is not 1.0');
  const rootfiles = all(container, NS.container, 'rootfile');
  if (rootfiles.length === 0) problems.push('no rootfile');
  for (const rootfile of rootfiles) {
    const path = rootfile.getAttribute('full-path') ?? '';
    if (!files[path]) problems.push(`rootfile ${path} is missing`);
    if (rootfile.getAttribute('media-type') !== 'application/oebps-package+xml') problems.push('rootfile media-type is wrong');
  }
  return problems;
};

const packageMetadata: Check = ({ opf }) => {
  const problems: string[] = [];
  const root = opf.documentElement;
  if (root.namespaceURI !== NS.opf || root.localName !== 'package') problems.push('package root or namespace is wrong');
  if (root.getAttribute('version') !== '3.0') problems.push('version is not 3.0');
  const metadata = all(opf, NS.opf, 'metadata');
  if (metadata.length !== 1) problems.push('there must be one metadata element');
  const unique = root.getAttribute('unique-identifier') ?? '';
  const identifier = all(opf, NS.dc, 'identifier').find((el) => el.getAttribute('id') === unique);
  if (!identifier || !words(identifier)) problems.push(`unique-identifier "${unique}" names no dc:identifier with a value`);
  const titles = all(opf, NS.dc, 'title');
  if (titles.length === 0 || titles.some((el) => !words(el))) problems.push('dc:title is missing or empty');
  const languages = all(opf, NS.dc, 'language');
  if (languages.length === 0) problems.push('dc:language is missing');
  for (const el of all(opf, NS.dc, '*')) if (!words(el)) problems.push(`dc:${el.localName} is empty`);
  const modified = all(opf, NS.opf, 'meta').filter((m) => m.getAttribute('property') === 'dcterms:modified' && !m.getAttribute('refines'));
  if (modified.length !== 1) problems.push(`${modified.length} dcterms:modified`);
  else if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(modified[0].textContent ?? '')) problems.push(`dcterms:modified "${modified[0].textContent}"`);
  const allIds = [...opf.querySelectorAll('[id]')].map((el) => el.getAttribute('id') ?? '');
  if (new Set(allIds).size !== allIds.length) problems.push('ids in the package repeat');
  for (const id of allIds) if (!NCNAME.test(id)) problems.push(`id "${id}" is not an XML name`);
  for (const meta of all(opf, NS.opf, 'meta')) {
    const refines = meta.getAttribute('refines');
    if (refines && !allIds.includes(refines.replace(/^#/, ''))) problems.push(`refines ${refines} names nothing`);
    if (meta.getAttribute('property') && !words(meta)) problems.push(`meta ${meta.getAttribute('property')} is empty`);
  }
  return problems;
};

const manifest: Check = ({ files, items, opfPath }) => {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!NCNAME.test(item.id)) problems.push(`item id "${item.id}" is not an XML name`);
    if (!item.path) {
      problems.push(`href "${item.href}" is not a relative URL with the right escaping`);
      continue;
    }
    if (item.href.includes('#')) problems.push(`href "${item.href}" has a fragment`);
    if (seen.has(item.path)) problems.push(`${item.path} is in the manifest twice`);
    seen.add(item.path);
    const bytes = files[item.path];
    if (!bytes) {
      problems.push(`${item.href} is not in the zip`);
      continue;
    }
    const actual = actualType(item.path, bytes);
    if (actual === 'font' ? !FONT_TYPES.includes(item.mediaType) : actual !== item.mediaType) {
      problems.push(`${item.href} is declared ${item.mediaType} but is ${actual}`);
    }
    if (!CORE_TYPES.has(item.mediaType) && !item.fallback) problems.push(`${item.href} is not a core media type and has no fallback`);
  }
  for (const name of Object.keys(files)) {
    if (name === 'mimetype' || name.startsWith('META-INF/') || name === opfPath) continue;
    if (!seen.has(name)) problems.push(`${name} is not in the manifest`);
  }
  return problems;
};

/** What each content document needs declared, from what it holds. */
function neededProperties(document: Document, path: string, files: Record<string, Uint8Array>): string[] {
  const needed: string[] = [];
  const remote = (url: string | null) => Boolean(url && hasScheme(url) && !/^(mailto|data):/i.test(url));
  const sources = [...document.querySelectorAll('img, audio, video, source, track, iframe, embed, input')].flatMap((el) => [
    el.getAttribute('src'),
    el.getAttribute('poster'),
  ]);
  sources.push(...[...document.querySelectorAll('object')].map((el) => el.getAttribute('data')));
  sources.push(...[...document.querySelectorAll('link')].filter((el) => /stylesheet/.test(el.getAttribute('rel') ?? '')).map((el) => el.getAttribute('href')));
  for (const link of document.querySelectorAll('link[href]')) {
    const css = resolve(path, link.getAttribute('href') ?? '');
    if (css && files[css] && /url\(\s*['"]?(https?:)?\/\//i.test(strFromU8(files[css]))) needed.push('remote-resources');
  }
  if (sources.some(remote)) needed.push('remote-resources');
  const scripted =
    document.querySelector('script, form, input, button, select, textarea') ||
    [...document.querySelectorAll('*')].some((el) => [...el.attributes].some((a) => /^on/i.test(a.name)));
  if (scripted) needed.push('scripted');
  if (document.getElementsByTagNameNS(NS.svg, '*').length) needed.push('svg');
  if (document.getElementsByTagNameNS(NS.mathml, '*').length) needed.push('mathml');
  return [...new Set(needed)].sort();
}

const manifestProperties: Check = ({ items, docs, files }) => {
  const problems: string[] = [];
  const known = new Set(['cover-image', 'mathml', 'nav', 'remote-resources', 'scripted', 'svg', 'switch']);
  for (const item of items) for (const p of item.properties) if (!known.has(p)) problems.push(`${item.href}: unknown property ${p}`);
  const nav = items.filter((i) => i.properties.includes('nav'));
  if (nav.length !== 1) problems.push(`${nav.length} items have the nav property`);
  if (nav[0] && nav[0].mediaType !== 'application/xhtml+xml') problems.push('nav is not XHTML');
  const covers = items.filter((i) => i.properties.includes('cover-image'));
  if (covers.length > 1) problems.push('more than one cover-image');
  for (const cover of covers) if (!cover.mediaType.startsWith('image/')) problems.push('cover-image is not an image');
  for (const [path, document] of docs) {
    const item = items.find((i) => i.path === path)!;
    const declared = item.properties.filter((p) => ['remote-resources', 'scripted', 'svg', 'mathml'].includes(p)).sort();
    const needed = neededProperties(document, path, files);
    if (declared.join(' ') !== needed.join(' ')) problems.push(`${item.href}: declares [${declared}] but needs [${needed}]`);
  }
  return problems;
};

const spineCheck: Check = ({ opf, spine, byId }) => {
  const problems: string[] = [];
  if (spine.length === 0) problems.push('the spine is empty');
  const seen = new Set<string>();
  for (const { idref, linear } of spine) {
    const item = byId.get(idref);
    if (!item) problems.push(`itemref ${idref} names no item`);
    if (seen.has(idref)) problems.push(`itemref ${idref} repeats`);
    seen.add(idref);
    if (linear !== null && linear !== 'yes' && linear !== 'no') problems.push(`linear="${linear}"`);
    let chain = item;
    const visited = new Set<string>();
    while (chain && chain.mediaType !== 'application/xhtml+xml' && chain.mediaType !== 'image/svg+xml' && chain.fallback && !visited.has(chain.id)) {
      visited.add(chain.id);
      chain = byId.get(chain.fallback);
    }
    if (item && (!chain || !['application/xhtml+xml', 'image/svg+xml'].includes(chain.mediaType))) problems.push(`${idref} is not a content document`);
  }
  if (!spine.some((s) => s.linear !== 'no')) problems.push('no linear item');
  const toc = all(opf, NS.opf, 'spine')[0]?.getAttribute('toc');
  const ncx = [...byId.values()].find((i) => i.mediaType === 'application/x-dtbncx+xml');
  if (ncx && toc !== ncx.id) problems.push(`spine toc="${toc}" but the NCX is ${ncx.id}`);
  if (toc && byId.get(toc)?.mediaType !== 'application/x-dtbncx+xml') problems.push('spine toc names something other than an NCX');
  return problems;
};

/** Every link and source in a document: where it points, and whether it is a hyperlink. */
function references(document: Document): { el: Element; url: string; hyperlink: boolean }[] {
  const out: { el: Element; url: string; hyperlink: boolean }[] = [];
  for (const el of document.getElementsByTagName('*')) {
    for (const name of ['href', 'src', 'poster', 'data']) {
      const url = el.getAttribute(name);
      if (url !== null) out.push({ el, url, hyperlink: name === 'href' && (el.localName === 'a' || el.localName === 'area') });
    }
  }
  return out;
}

const spineIds = (epub: Epub) => new Set(epub.spine.map((s) => epub.byId.get(s.idref)?.path));

/** Where a link inside the book points, or what is wrong with it. */
function target(epub: Epub, from: string, url: string, needsSpine: boolean): string | null {
  const path = resolve(from, url);
  if (!path) return `"${url}" in ${from} is not a relative URL with the right escaping`;
  const item = epub.byPath.get(path);
  if (!item) return `"${url}" in ${from} points at ${path}, which is not in the manifest`;
  if (needsSpine && item.mediaType === 'application/xhtml+xml' && !spineIds(epub).has(path)) {
    return `"${url}" in ${from} points at ${path}, which is not in the spine`;
  }
  const fragment = url.includes('#') ? decodeURIComponent(url.slice(url.indexOf('#') + 1)) : '';
  if (fragment && !ids(epub.docs.get(path)!).has(fragment)) return `"${url}" in ${from} names a missing id`;
  return null;
}

const navigation: Check = (epub) => {
  const problems: string[] = [];
  const navItem = epub.items.find((i) => i.properties.includes('nav'))!;
  const document = epub.docs.get(navItem.path!)!;
  const navs = all(document, NS.xhtml, 'nav');
  const tocs = navs.filter((n) => epubTypes(n).includes('toc'));
  if (tocs.length !== 1) problems.push(`${tocs.length} toc navs`);
  const checkList = (ol: Element, where: string, landmarks: boolean) => {
    const items = [...ol.children];
    if (items.length === 0) problems.push(`${where}: an empty ol`);
    for (const li of items) {
      if (li.localName !== 'li') problems.push(`${where}: ol holds ${li.localName}`);
      const [first, second, ...rest] = [...li.children];
      if (!first || (first.localName !== 'a' && first.localName !== 'span')) problems.push(`${where}: li does not start with a or span`);
      if (first?.localName === 'span' && second?.localName !== 'ol') problems.push(`${where}: span heading without a list`);
      if (second && second.localName !== 'ol') problems.push(`${where}: li holds ${second.localName}`);
      if (rest.length) problems.push(`${where}: li holds too much`);
      if (first && !words(first) && !first.querySelector('img[alt]')) problems.push(`${where}: a label is empty`);
      if (first?.localName === 'a') {
        const href = first.getAttribute('href');
        if (!href) problems.push(`${where}: a without href`);
        else {
          const wrong = target(epub, navItem.path!, href, true);
          if (wrong) problems.push(`${where}: ${wrong}`);
        }
        if (landmarks && epubTypes(first).length === 0) problems.push(`${where}: landmark without epub:type`);
      }
      if (second?.localName === 'ol') checkList(second, where, landmarks);
    }
  };
  for (const nav of navs) {
    const type = epubTypes(nav)[0] ?? 'nav';
    const lists = [...nav.children].filter((c) => c.localName === 'ol');
    const others = [...nav.children].filter((c) => c.localName !== 'ol' && !/^h[1-6]$|^hgroup$/.test(c.localName));
    if (lists.length !== 1 || others.length) problems.push(`${type}: must hold one ol after an optional heading`);
    if (lists[0]) checkList(lists[0], type, type === 'landmarks');
  }
  const landmarks = navs.find((n) => epubTypes(n).includes('landmarks'));
  if (landmarks) {
    const pairs = [...landmarks.querySelectorAll('a')].map((a) => `${epubTypes(a).join(' ')} ${a.getAttribute('href')}`);
    if (new Set(pairs).size !== pairs.length) problems.push('landmarks repeat a type and target');
  }
  return problems;
};

const PHRASING_ONLY = new Set(['p', 'span', 'a', 'em', 'strong', 'b', 'i', 'u', 's', 'sup', 'sub', 'small', 'code', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'label', 'q', 'cite', 'abbr', 'mark', 'dt']);
const BLOCKS = new Set(['address', 'article', 'aside', 'blockquote', 'div', 'dl', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul', 'li']);
const PARENTS: Record<string, string[]> = {
  li: ['ol', 'ul', 'menu'],
  tr: ['table', 'thead', 'tbody', 'tfoot'],
  td: ['tr'],
  th: ['tr'],
  tbody: ['table'],
  thead: ['table'],
  tfoot: ['table'],
  figcaption: ['figure'],
  dt: ['dl'],
  dd: ['dl'],
};
const KNOWN_TYPES = new Set([
  'cover', 'titlepage', 'halftitlepage', 'copyright-page', 'dedication', 'epigraph', 'acknowledgments', 'frontmatter',
  'bodymatter', 'backmatter', 'appendix', 'chapter', 'part', 'toc', 'landmarks', 'page-list', 'footnote', 'footnotes',
  'endnote', 'endnotes', 'rearnote', 'rearnotes', 'noteref', 'glossary', 'index', 'preface', 'foreword', 'prologue',
  'epilogue', 'afterword', 'colophon', 'contributors', 'other-credits', 'pagebreak', 'bibliography', 'loi', 'lot',
]);

const contentDocuments: Check = (epub) => {
  const problems: string[] = [];
  const language = all(epub.opf, NS.dc, 'language')[0]?.textContent ?? '';
  for (const [path, document] of epub.docs) {
    const at = (message: string) => problems.push(`${path}: ${message}`);
    const html = document.documentElement;
    if (html.namespaceURI !== NS.xhtml || html.localName !== 'html') at('root is not XHTML html');
    const titles = all(document, NS.xhtml, 'title');
    if (titles.length !== 1 || !words(titles[0])) at('title is missing or empty');
    const xmlLang = html.getAttributeNS(NS.xml, 'lang');
    const lang = html.getAttribute('lang');
    if (xmlLang !== lang) at(`xml:lang "${xmlLang}" and lang "${lang}" differ`);
    if (!lang || !BCP47.test(lang)) at(`lang "${lang}" is not a BCP 47 tag`);
    if (lang !== language) at(`lang "${lang}" is not the package language "${language}"`);
    const seen = new Set<string>();
    for (const el of document.getElementsByTagName('*')) {
      const id = el.getAttribute('id');
      if (id !== null) {
        if (!id || /\s/.test(id)) at(`id "${id}" is not usable`);
        if (seen.has(id)) at(`id "${id}" repeats`);
        seen.add(id);
      }
      for (const attribute of el.attributes) {
        if (attribute.prefix === 'epub' && attribute.namespaceURI !== NS.epub) at('epub: prefix in the wrong namespace');
      }
      for (const type of epubTypes(el)) if (!type.includes(':') && !KNOWN_TYPES.has(type)) at(`epub:type "${type}" is not in the vocabulary`);
      if (el.namespaceURI !== NS.xhtml) continue;
      const name = el.localName;
      if (BLOCKS.has(name)) {
        for (let up = el.parentElement; up; up = up.parentElement) {
          if (PHRASING_ONLY.has(up.localName)) {
            at(`${name} inside ${up.localName}`);
            break;
          }
        }
      }
      if (PARENTS[name] && !PARENTS[name].includes(el.parentElement?.localName ?? '')) at(`${name} inside ${el.parentElement?.localName}`);
      if (name === 'a' && el.parentElement?.closest('a')) at('a link inside a link');
      if (name === 'img' && !el.hasAttribute('alt')) at(`img ${el.getAttribute('src')} has no alt`);
      if (name === 'figure') {
        const captions = [...el.children].filter((c) => c.localName === 'figcaption');
        if (captions.length > 1) at('figure with more than one figcaption');
        if (captions[0] && captions[0] !== el.firstElementChild && captions[0] !== el.lastElementChild) at('figcaption in the middle of a figure');
      }
    }
    for (const { el, url, hyperlink } of references(document)) {
      if (hasScheme(url)) {
        if (/^javascript:/i.test(url)) at(`script link ${url}`);
        continue;
      }
      const wrong = target(epub, path, url, hyperlink);
      if (wrong) at(wrong);
      const item = epub.byPath.get(resolve(path, url) ?? '');
      if (item && ['img', 'video', 'audio', 'source'].includes(el.localName)) {
        const kind = el.localName === 'img' ? 'image/' : el.localName === 'source' ? '' : `${el.localName}/`;
        if (!item.mediaType.startsWith(kind)) at(`${el.localName} ${url} is ${item.mediaType}`);
        if (el.localName === 'img' && !CORE_TYPES.has(item.mediaType)) at(`img ${url} is not a core media type`);
      }
      if (el.localName === 'link' && item && item.mediaType !== 'text/css') at(`stylesheet ${url} is ${item.mediaType}`);
    }
  }
  return problems;
};

const footnotes: Check = (epub) => {
  const problems: string[] = [];
  for (const [path, document] of epub.docs) {
    for (const ref of [...document.getElementsByTagNameNS(NS.xhtml, 'a')].filter((a) => epubTypes(a).includes('noteref'))) {
      const href = ref.getAttribute('href') ?? '';
      const file = resolve(path, href);
      const note = file ? epub.docs.get(file)?.getElementById(decodeURIComponent(href.split('#')[1] ?? '')) : null;
      if (!note) {
        problems.push(`${path}: noteref ${href} has no note`);
        continue;
      }
      const types = epubTypes(note);
      if (!['footnote', 'endnote', 'rearnote', 'note'].some((t) => types.includes(t))) problems.push(`${path}: ${href} is not a note`);
      if (note.localName !== 'aside' && note.localName !== 'li') problems.push(`${path}: ${href} is a ${note.localName}`);
      if (!words(note)) problems.push(`${path}: note ${href} is empty`);
      if (note.contains(ref)) problems.push(`${path}: ${href} is inside its own note`);
    }
  }
  return problems;
};

const mediaElements: Check = (epub) => {
  const problems: string[] = [];
  for (const [path, document] of epub.docs) {
    for (const el of document.querySelectorAll('video, audio, source')) {
      const src = el.getAttribute('src');
      if (!src) {
        if (el.localName !== 'source' && !el.querySelector('source')) problems.push(`${path}: ${el.localName} with nothing to play`);
        continue;
      }
      if (hasScheme(src)) continue;
      const item = epub.byPath.get(resolve(path, src) ?? '');
      if (!item) problems.push(`${path}: ${el.localName} ${src} is not in the book`);
    }
  }
  return problems;
};

const ncxCheck: Check = (epub) => {
  const item = epub.items.find((i) => i.mediaType === 'application/x-dtbncx+xml');
  if (!item) return [];
  const problems: string[] = [];
  const ncx = parseXml(strFromU8(epub.files[item.path!]));
  const root = ncx.documentElement;
  if (root.namespaceURI !== NS.ncx || root.localName !== 'ncx' || root.getAttribute('version') !== '2005-1') problems.push('NCX root is wrong');
  const meta = (name: string) => all(ncx, NS.ncx, 'meta').find((m) => m.getAttribute('name') === name)?.getAttribute('content');
  const unique = epub.opf.documentElement.getAttribute('unique-identifier');
  const identifier = all(epub.opf, NS.dc, 'identifier').find((el) => el.getAttribute('id') === unique);
  if (meta('dtb:uid') !== identifier?.textContent?.trim()) problems.push(`dtb:uid ${meta('dtb:uid')} is not the package identifier`);
  const docTitle = all(ncx, NS.ncx, 'docTitle')[0];
  if (!docTitle || !words(docTitle)) problems.push('NCX docTitle is empty');
  const points = all(ncx, NS.ncx, 'navPoint');
  if (points.length === 0) problems.push('NCX has no navPoint');
  const depth = (el: Element): number => 1 + Math.max(0, ...[...el.children].filter((c) => c.localName === 'navPoint').map(depth));
  const navMap = all(ncx, NS.ncx, 'navMap')[0];
  const deepest = Math.max(0, ...[...navMap.children].filter((c) => c.localName === 'navPoint').map(depth));
  if (Number(meta('dtb:depth')) !== deepest) problems.push(`dtb:depth ${meta('dtb:depth')} but the navMap is ${deepest} deep`);
  const pointIds = points.map((p) => p.getAttribute('id') ?? '');
  if (new Set(pointIds).size !== pointIds.length || pointIds.some((id) => !NCNAME.test(id))) problems.push('navPoint ids repeat or are not XML names');
  const orderOf = new Map<string, string>();
  const srcOf = new Map<string, string>();
  for (const point of points) {
    const order = point.getAttribute('playOrder') ?? '';
    const content = [...point.children].find((c) => c.localName === 'content');
    const label = [...point.children].find((c) => c.localName === 'navLabel');
    const src = content?.getAttribute('src') ?? '';
    if (!/^[1-9]\d*$/.test(order)) problems.push(`playOrder "${order}"`);
    if (!label || !words(label)) problems.push(`navPoint ${point.getAttribute('id')} has no label`);
    const wrong = target(epub, item.path!, src, true);
    if (wrong) problems.push(wrong);
    // NCX 2005-1: the same target always has the same playOrder, and one playOrder one target.
    if (orderOf.has(src) && orderOf.get(src) !== order) problems.push(`${src} has playOrder ${orderOf.get(src)} and ${order}`);
    if (srcOf.has(order) && srcOf.get(order) !== src) problems.push(`playOrder ${order} is both ${srcOf.get(order)} and ${src}`);
    orderOf.set(src, order);
    srcOf.set(order, src);
  }
  return problems;
};

const languages: Check = ({ opf }) => {
  const problems: string[] = [];
  for (const el of all(opf, NS.dc, 'language')) if (!BCP47.test(el.textContent ?? '')) problems.push(`dc:language "${el.textContent}"`);
  const lang = opf.documentElement.getAttributeNS(NS.xml, 'lang');
  if (lang !== null && !BCP47.test(lang)) problems.push(`package xml:lang "${lang}"`);
  return problems;
};

const cover: Check = (epub) => {
  const problems: string[] = [];
  const covers = epub.items.filter((i) => i.properties.includes('cover-image'));
  const coverPages = [...epub.docs].filter(([, d]) => d.querySelector('body > section') && epubTypes(d.querySelector('body > section')!).includes('cover'));
  if (covers.length === 0) {
    if (coverPages.length) problems.push('a cover page but no cover-image');
    return problems;
  }
  const [image] = covers;
  const legacy = all(epub.opf, NS.opf, 'meta').find((m) => m.getAttribute('name') === 'cover');
  if (legacy && legacy.getAttribute('content') !== image.id) problems.push('meta name="cover" names another item');
  const first = epub.byId.get(epub.spine[0].idref)!;
  const page = epub.docs.get(first.path!)!;
  const img = page.querySelector('img');
  if (!img || resolve(first.path!, img.getAttribute('src') ?? '') !== image.path) problems.push('the first page in the spine does not show the cover image');
  const navItem = epub.items.find((i) => i.properties.includes('nav'))!;
  const landmark = [...epub.docs.get(navItem.path!)!.querySelectorAll('a')].find((a) => epubTypes(a).includes('cover'));
  if (!landmark || resolve(navItem.path!, landmark.getAttribute('href') ?? '') !== first.path) problems.push('no cover landmark to the cover page');
  return problems;
};

const CHECKS: [string, Check][] = [
  ['the zip container and its mimetype (OCF 3.3)', zipContainer],
  ['META-INF/container.xml leads to the package', containerFile],
  ['the package metadata EPUB 3.3 requires', packageMetadata],
  ['the manifest: every file, once, with its real media type', manifest],
  ['manifest properties match what each document holds', manifestProperties],
  ['the spine', spineCheck],
  ['the navigation document', navigation],
  ['every content document: XHTML, title, language, ids, nesting and links', contentDocuments],
  ['footnotes lead to notes', footnotes],
  ['video and audio play only what is in the book', mediaElements],
  ['the NCX', ncxCheck],
  ['language tags are BCP 47', languages],
  ['the cover', cover],
];

// ---------------------------------------------------------------------------
// The books checked
// ---------------------------------------------------------------------------

const matter = (value: string) => ({ include: true, content: doc(para(text(value))) });

const FULL: BookPublishing = {
  coverAssetId: 'asset-portrait',
  series: 'The Vale & Beyond',
  seriesNumber: '2',
  description: 'A ranger rides <north> & back.',
  language: 'fr',
  publisher: 'Silver Gate Press',
  isbn: '978-1-234-56789-7',
  copyrightYear: '2026',
  copyright: { include: true, content: null },
  dedication: matter('For the riders.'),
  epigraph: matter('Not all roads run north.'),
  acknowledgments: matter('My thanks to the Wardens.'),
  aboutAuthor: matter('She lives by the sea.'),
  appendices: [
    { title: 'Who Is Who', kind: 'cast', categories: [], pageTypes: ['character'], canonOnly: true, hideSpoilers: true },
    { title: 'Terms', kind: 'glossary', categories: ['世界'], pageTypes: [], canonOnly: false, hideSpoilers: true },
    { title: 'The Maps', kind: 'maps', categories: [], pageTypes: [], canonOnly: true, hideSpoilers: true },
  ],
};

function world(first?: BookPublishing, second?: BookPublishing): ExportSnapshot {
  const snapshot = fixtureSnapshot();
  if (first) snapshot.books[0].publishing = first;
  if (second) snapshot.books[1].publishing = second;
  return snapshot;
}

const oneBook: Partial<ExportOptions> = { scope: 'book', bookId: 'book-1' };
const emptyBook = () => {
  const snapshot = fixtureSnapshot();
  snapshot.nodes = [];
  return snapshot;
};

const CASES: [string, () => Uint8Array][] = [
  ['one book', () => exportEpub(fixtureInput(oneBook))],
  ['one book with publishing details, cover and book matter', () => exportEpub(fixtureInput({ ...oneBook, language: 'fr', bookMatter: true }, world(FULL)))],
  ['all books', () => exportEpub(fixtureInput({ scope: 'books' }))],
  ['all books, with details on the first and no title page on the second', () => exportEpub(fixtureInput({ scope: 'books' }, world(FULL, { titlePage: false })))],
  ['manuscript format, which EPUB leaves to the other formats', () => exportEpub(fixtureInput({ ...oneBook, manuscriptFormat: true }, world(FULL)))],
  ['an empty book', () => exportEpub(fixtureInput(oneBook, emptyBook()))],
  ['an empty book with a cover and no title page', () => exportEpub(fixtureInput(oneBook, (() => { const s = emptyBook(); s.books[0].publishing = { coverAssetId: 'asset-map', titlePage: false }; return s; })()))],
  ['no books at all', () => exportEpub(fixtureInput({ scope: 'book', bookId: 'no-such-book' }))],
  ['scene titles', () => exportEpub(fixtureInput({ ...oneBook, sceneTitles: true }))],
  ['the second book, with an empty chapter', () => exportEpub(fixtureInput({ scope: 'book', bookId: 'book-2' }))],
  ['written scenes only, in British English', () => exportEpub(fixtureInput({ ...oneBook, scenes: 'written', language: 'en-GB' }))],
  ['a picture whose id came from an imported file', () => exportEpub(awkwardAssetInput())],
  ['a language typed the way people write it', () => exportEpub(fixtureInput({ ...oneBook, language: 'pt_BR' }))],
  ['a language that is not a code', () => exportEpub(fixtureInput({ ...oneBook, language: 'Français' }))],
  ['titles made only of characters XML cannot hold', () => exportEpub(fixtureInput({ ...oneBook, sceneTitles: true }, controlTitles()))],
];

/** An imported file keeps its own asset ids, and they may hold anything. */
const AWKWARD_ID = 'Portrait: Aria/1 #2 %20.png';
function awkwardAssetInput() {
  const snapshot = JSON.parse(JSON.stringify(world({ coverAssetId: 'asset-portrait' })).replaceAll('asset-portrait', AWKWARD_ID)) as ExportSnapshot;
  const input = fixtureInput(oneBook, snapshot);
  input.assetData.set(AWKWARD_ID, input.assetData.get('asset-portrait')!);
  return input;
}

function controlTitles(): ExportSnapshot {
  const snapshot = fixtureSnapshot();
  snapshot.books[0].title = '\u0001';
  for (const node of snapshot.nodes) node.title = '\u0002 \u000B';
  return snapshot;
}

describe.each(CASES)('EPUB structure: %s', (_name, make) => {
  const epub = load(make());
  it.each(CHECKS)('%s', (_check, check) => {
    expect(check(epub)).toEqual([]);
  });
});

// Books made elsewhere, such as by the end-to-end tests into e2e/artifacts, can be held to the
// same checks: LORECRAFT_CHECK_EPUB="a.epub;b.epub" npx vitest run src/exporters/epubStructure.test.ts
const madeElsewhere = (process.env.LORECRAFT_CHECK_EPUB ?? '').split(';').filter(Boolean);
if (madeElsewhere.length > 0) {
  describe.each(madeElsewhere)('EPUB structure of %s', (path) => {
    const epub = load(new Uint8Array(readFileSync(path)));
    it.each(CHECKS)('%s', (_check, check) => {
      expect(check(epub)).toEqual([]);
    });
  });
}

describe('EPUB details a validator would reject', () => {
  it('turns a language typed by hand into a tag, and says when it cannot', () => {
    const typed = load(exportEpub(fixtureInput({ ...oneBook, language: ' pt_BR ' })));
    expect(all(typed.opf, NS.dc, 'language')[0].textContent).toBe('pt-BR');
    const warnings: string[] = [];
    const epub = load(exportEpub(fixtureInput({ ...oneBook, language: 'Français' }, undefined, warnings)));
    expect(all(epub.opf, NS.dc, 'language')[0].textContent).toBe('en');
    expect(warnings.join(' ')).toContain('Français');
    expect([...epub.docs.values()].every((d) => d.documentElement.getAttribute('lang') === 'en')).toBe(true);
  });

  it('still shows a picture whose id cannot be a file name, as the cover and in the text', () => {
    const epub = load(exportEpub(awkwardAssetInput()));
    const coverItem = epub.items.find((i) => i.properties.includes('cover-image'))!;
    expect(coverItem.path && epub.files[coverItem.path]).toBeTruthy();
    const shown = [...epub.docs].filter(([path, d]) => [...d.querySelectorAll('img')].some((img) => resolve(path, img.getAttribute('src')!) === coverItem.path));
    expect(shown.length).toBeGreaterThan(1);
  });

  it('numbers a chapter or part whose title is only characters XML cannot hold, as it does an untitled one', () => {
    const files = unzipSync(exportEpub(fixtureInput(oneBook, controlTitles())));
    const nav = new DOMParser().parseFromString(strFromU8(files['OEBPS/nav.xhtml']), 'application/xhtml+xml');
    const links = [...nav.querySelector('nav')!.querySelectorAll('a')].map((a) => a.textContent);
    expect(links).toEqual(['Chapter 1', 'Part 1', 'Chapter 2']);
  });

  it('gives a book entry and its first chapter one play order when they are the same page', () => {
    const epub = load(exportEpub(fixtureInput({ scope: 'books' }, world(undefined, { titlePage: false }))));
    const ncx = parseXml(strFromU8(epub.files['OEBPS/toc.ncx']));
    const second = [...all(ncx, NS.ncx, 'navMap')[0].children][1];
    const firstChild = [...second.children].find((c) => c.localName === 'navPoint')!;
    const src = (el: Element) => [...el.children].find((c) => c.localName === 'content')!.getAttribute('src');
    expect(src(second)).toBe(src(firstChild));
    expect(second.getAttribute('playOrder')).toBe(firstChild.getAttribute('playOrder'));
  });
});
