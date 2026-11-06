/**
 * MediaWiki XML for Special:Import, schema version 0.11 (the default since MediaWiki
 * 1.39, https://www.mediawiki.org/xml/export-0.11.xsd). Each page's body is wikitext.
 * Aliases become redirects, Talk notes become Talk pages, and each page type used gets
 * an infobox template. Picture files are named but cannot travel in the XML, so upload
 * them to the wiki under those names.
 */

import { pmToPlainText } from '../../editor/convert';
import { titleKey } from '../../lib/text';
import type { Page, PmNode } from '../../lib/types';
import type { AssetMeta, ExportInput } from '../types';
import { assetFileName, NameKeeper, pageResolver, utf8, xmlAttr, xmlSafe, xmlSafeDoc, xmlText } from '../util';

const NS_MAIN = 0;
const NS_TALK = 1;
const NS_TEMPLATE = 10;

const NAMESPACES: [number, string][] = [
  [-2, 'Media'], [-1, 'Special'], [0, ''], [1, 'Talk'], [2, 'User'], [3, 'User talk'], [4, 'Project'],
  [5, 'Project talk'], [6, 'File'], [7, 'File talk'], [8, 'MediaWiki'], [9, 'MediaWiki talk'],
  [10, 'Template'], [11, 'Template talk'], [12, 'Help'], [13, 'Help talk'], [14, 'Category'], [15, 'Category talk'],
];

/**
 * A title starting with one of these would land in that namespace, or be refused. MediaWiki reads
 * any run of spaces and underscores as one, inside the name and around the colon.
 */
const NAMESPACE_PREFIX = /^(media|special|talk|user|user[ _]+talk|project|project[ _]+talk|file|image|file[ _]+talk|image[ _]+talk|mediawiki|mediawiki[ _]+talk|template|template[ _]+talk|help|help[ _]+talk|category|category[ _]+talk)[\s_]*:[\s_]*/i;

/** Direction marks MediaWiki drops from titles, so `Talk\u200E:X` is the Talk page of X. */
const TITLE_MARKS = /[\u200E\u200F\u202A-\u202E]/g;

const LONGEST_TITLE_BYTES = 255;

/** The longest start of `text` that fits in `max` bytes of UTF-8. */
function clipBytes(text: string, max: number): string {
  let bytes = 0;
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes > max) break;
    out += char;
  }
  return out;
}

/** Makes a title MediaWiki accepts. See Manual:Page title. */
export function mediaWikiTitle(title: string): string {
  let out = xmlSafe(title)
    .replace(TITLE_MARKS, '')
    .replace(/[#<>[\]{}|]/g, '-')
    .replace(/%([0-9a-f]{2})/gi, '% $1')
    .replace(/~{3,}/g, '~~')
    .replace(/&(?=#?\w+;)/g, 'and ')
    .replace(/[\s\u180E]+/g, ' ')
    // MediaWiki trims spaces and underscores from both ends, and one leading colon means nothing.
    .replace(/^[:\s_]+/, '')
    .replace(/[\s_]+$/, '');
  out = out.replace(NAMESPACE_PREFIX, (_all, prefix: string) => `${prefix} - `);
  if (out === '.' || out === '..' || out.startsWith('./') || out.startsWith('../') || out.includes('/./') || out.includes('/../')) {
    out = `Page ${out}`;
  }
  return clipBytes(out, LONGEST_TITLE_BYTES).trim() || 'Untitled';
}

/**
 * A page title in the text form the dump's <title> holds: spaces, not underscores. MediaWiki reads
 * `Silver_Vale` and `Silver Vale` as one page, so they must be told apart before import.
 */
function pageTitle(title: string): string {
  return mediaWikiTitle(title.replace(/_/g, ' '));
}

/** `Name (2)`, cut short where needed so the number still fits in 255 bytes. */
function numberedTitle(title: string, n: number): string {
  const suffix = ` (${n})`;
  return `${clipBytes(title, LONGEST_TITLE_BYTES - utf8(suffix).length).trimEnd()}${suffix}`;
}

/** Characters that would mean something to wikitext become character references. */
function wikiText(text: string, tableOrTemplate = false): string {
  let out = xmlSafe(text)
    .replace(/&(?=#?\w+;)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;')
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;')
    .replace(/'{2,}/g, (run) => '&#39;'.repeat(run.length))
    .replace(/~{3,}/g, (run) => '&#126;'.repeat(run.length))
    .replace(/__([A-Z]+)__/g, '&#95;&#95;$1&#95;&#95;')
    .replace(/\s*\n\s*/g, ' ');
  if (tableOrTemplate) out = out.replace(/\|/g, '&#124;');
  return out;
}

/** Wikitext reads these at the start of a line as lists, headings and code. */
function guardLineStart(line: string): string {
  return line
    .replace(/^\s+/, '')
    .replace(/^[*#:;=]/, (c) => `&#${c.charCodeAt(0)};`)
    .replace(/^-{4}/, '&#45;---');
}

interface Context {
  resolve: (target: string) => Page | undefined;
  titleOf: Map<string, string>;
  fileName: (assetId: string) => string | null;
  excluded: Set<string>;
  references: boolean;
}

function linkTo(target: string, context: Context): string {
  const page = context.resolve(target);
  const title = page ? (context.titleOf.get(page.id) ?? mediaWikiTitle(page.title)) : mediaWikiTitle(target);
  // A leading colon stops a prefix such as `fr:` from being read as another wiki.
  return title.includes(':') ? `:${title}` : title;
}

function pageLink(target: string, label: string, context: Context, inCell: boolean): string {
  const shown = wikiText(label, inCell);
  if (context.excluded.has(titleKey(target))) return shown;
  const link = linkTo(target, context);
  return link === label ? `[[${link}]]` : `[[${link}|${shown}]]`;
}

function inlineToWiki(nodes: PmNode[] | undefined, context: Context, inCell = false): string {
  let out = '';
  const list = nodes ?? [];
  list.forEach((node, index) => {
    if (node.type === 'hardBreak') {
      out += '<br />';
      return;
    }
    if (node.type === 'reference') {
      context.references = true;
      out += `<ref>${wikiText(String(node.attrs?.text ?? ''), inCell)}</ref>`;
      return;
    }
    if (node.type !== 'text') return;
    const raw = node.text ?? '';
    const marks = node.marks ?? [];
    const has = (type: string) => marks.some((m) => m.type === type);
    let piece: string;
    if (has('code')) {
      piece = `<code>${wikiText(raw, inCell)}</code>`;
    } else {
      const wiki = marks.find((m) => m.type === 'wikiLink');
      const link = marks.find((m) => m.type === 'link');
      if (wiki) {
        piece = pageLink(String(wiki.attrs?.target ?? ''), raw, context, inCell);
      } else if (link) {
        const href = xmlSafe(String(link.attrs?.href ?? ''));
        piece = /^(https?:|mailto:)/i.test(href)
          ? `[${href.replace(/ /g, '%20').replace(/\]/g, '%5D')} ${wikiText(raw, inCell)}]`
          : wikiText(raw, inCell);
      } else {
        piece = wikiText(raw, inCell);
        // An apostrophe beside a bold or italic marker would change what the marker means.
        if (has('bold') || has('italic')) piece = piece.replace(/^'|'$/g, '&#39;');
      }
      if (has('underline')) piece = `<u>${piece}</u>`;
      if (has('strike')) piece = `<s>${piece}</s>`;
      if (has('italic')) piece = `''${piece}''`;
      if (has('bold')) piece = `'''${piece}'''`;
      // Two runs of apostrophes must not run together.
      const next = list[index + 1];
      const nextQuoted = next?.marks?.some((m) => m.type === 'bold' || m.type === 'italic');
      if (out.endsWith("'") && piece.startsWith("'")) out += '<nowiki/>';
      else if (piece.endsWith("'") && nextQuoted) piece += '<nowiki/>';
    }
    out += piece;
  });
  return out;
}

function tableToWiki(table: PmNode, context: Context, caption?: string): string {
  const lines = ['{| class="wikitable"'];
  if (caption) lines.push(`|+ ${caption}`);
  for (const row of table.content ?? []) {
    lines.push('|-');
    for (const cell of row.content ?? []) {
      const marker = cell.type === 'tableHeader' ? '!' : '|';
      const colspan = Number(cell.attrs?.colspan ?? 1);
      const rowspan = Number(cell.attrs?.rowspan ?? 1);
      const spans = `${colspan > 1 ? `colspan="${colspan}" ` : ''}${rowspan > 1 ? `rowspan="${rowspan}" ` : ''}`;
      const text = (cell.content ?? [])
        .map((block) => (block.type === 'paragraph' ? inlineToWiki(block.content, context, true) : blockToWiki(block, context)))
        .join('<br />');
      lines.push(spans ? `${marker} ${spans}| ${text}` : `${marker} ${text}`);
    }
  }
  lines.push('|}');
  return lines.join('\n');
}

const FIGURE_LABELS: Record<string, string> = { figure: 'Figure', picture: 'Picture', table: 'Table', video: 'Video' };

/** Figure numbers run per kind within one document, as `describeFigures` counts them. */
function figureToWiki(node: PmNode, context: Context, counts: Map<string, number>): string {
  const kind = String(node.attrs?.kind ?? 'figure');
  const number = (counts.get(kind) ?? 0) + 1;
  counts.set(kind, number);
  const media = node.content?.find((c) => c.type !== 'figcaption');
  const captionNode = node.content?.find((c) => c.type === 'figcaption');
  const name = `${FIGURE_LABELS[kind] ?? 'Figure'} ${number}.`;
  const caption = `${name} ${inlineToWiki(captionNode?.content, context)}`.trim();
  if (media?.type === 'table') return tableToWiki(media, context, caption);
  if (media?.type === 'image') {
    const file = media.attrs?.assetId ? context.fileName(String(media.attrs.assetId)) : null;
    if (file) {
      const align = String(node.attrs?.align ?? 'right');
      const position = align === 'left' ? 'left' : align === 'center' || align === 'full' ? 'center' : 'right';
      const alt = wikiText(String(node.attrs?.description || pmToPlainText(captionNode ?? { type: 'text' })), true);
      return `[[File:${file}|thumb|${position}|alt=${alt}|${caption}]]`;
    }
    return `''[${caption}]''`;
  }
  if (media?.attrs?.url) {
    const url = xmlSafe(String(media.attrs.url)).replace(/ /g, '%20').replace(/\]/g, '%5D');
    return /^https?:/i.test(url) ? `[${url} ${caption}]` : `''[${caption}]''`;
  }
  const file = media?.attrs?.assetId ? context.fileName(String(media.attrs.assetId)) : null;
  return file ? `[[Media:${file}|${caption}]]` : `''[${caption}]''`;
}

function listToWiki(list: PmNode, prefix: string, context: Context, counts: Map<string, number>): string {
  const marker = list.type === 'orderedList' ? '#' : '*';
  const lines: string[] = [];
  for (const item of list.content ?? []) {
    const text: string[] = [];
    const nested: string[] = [];
    for (const block of item.content ?? []) {
      if (block.type === 'bulletList' || block.type === 'orderedList') {
        nested.push(listToWiki(block, `${prefix}${marker}`, context, counts));
      } else if (block.type === 'paragraph') {
        text.push(inlineToWiki(block.content, context));
      } else {
        // Blocks in a list item stay on its line, or wikitext would end the list.
        text.push(blockToWiki(block, context, counts).replace(/\n/g, ' '));
      }
    }
    lines.push(`${prefix}${marker} ${text.filter(Boolean).join('<br />')}`.trimEnd(), ...nested);
  }
  return lines.join('\n');
}

function blockToWiki(node: PmNode, context: Context, counts: Map<string, number> = new Map()): string {
  switch (node.type) {
    case 'paragraph':
      return guardLineStart(inlineToWiki(node.content, context));
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 2)));
      const marker = '='.repeat(level);
      return `${marker} ${inlineToWiki(node.content, context)} ${marker}`;
    }
    case 'blockquote':
      return `<blockquote>\n${blocksToWiki(node.content, context, counts)}\n</blockquote>`;
    case 'bulletList':
      return listToWiki(node, '', context, counts);
    case 'orderedList': {
      // Wikitext lists always count from 1. A simple list can say otherwise in HTML.
      const start = Number(node.attrs?.start ?? 1);
      const simple = (node.content ?? []).every((item) => item.content?.length === 1 && item.content[0].type === 'paragraph');
      if (start === 1 || !simple) return listToWiki(node, '', context, counts);
      const items = (node.content ?? []).map((item) => `<li>${inlineToWiki(item.content?.[0].content, context)}</li>`);
      return `<ol start="${start}">${items.join('')}</ol>`;
    }
    case 'codeBlock': {
      const code = (node.content ?? []).map((c) => c.text ?? '').join('');
      return `<pre>${xmlSafe(code).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`;
    }
    case 'horizontalRule':
      return '----';
    case 'table':
      return tableToWiki(node, context);
    case 'figure':
      return figureToWiki(node, context, counts);
    case 'image': {
      const file = node.attrs?.assetId ? context.fileName(String(node.attrs.assetId)) : null;
      const alt = wikiText(String(node.attrs?.alt ?? ''), true);
      return file ? `[[File:${file}|thumb|${alt}]]` : `''[image: ${alt}]''`;
    }
    case 'video':
      return node.attrs?.url ? `[${xmlSafe(String(node.attrs.url))}]` : "''[video]''";
    default:
      return inlineToWiki(node.content, context);
  }
}

function blocksToWiki(nodes: PmNode[] | undefined, context: Context, counts: Map<string, number>): string {
  return (nodes ?? []).map((block) => blockToWiki(block, context, counts)).filter(Boolean).join('\n\n');
}

export function pmToWikitext(doc: PmNode, context: Context): { text: string; references: boolean } {
  context.references = false;
  const text = blocksToWiki(xmlSafeDoc(doc).content, context, new Map());
  return { text, references: context.references };
}

function infoboxName(page: Page): string {
  const type = page.pageType && page.pageType !== 'article' && page.pageType !== 'home' ? ` ${page.pageType}` : '';
  return pageTitle(`Infobox${type}`);
}

function templateParam(key: string): string {
  return xmlSafe(key).replace(/[=|{}[\]<>\n]/g, '_').trim();
}

function infoboxCall(page: Page, context: Context): string {
  const box = page.infobox;
  if (!box?.fields?.length && !box?.imageAssetId && !box?.caption) return '';
  const lines = [`{{${infoboxName(page)}`, `| name = ${wikiText(page.title, true)}`];
  const file = box.imageAssetId ? context.fileName(box.imageAssetId) : null;
  if (file) lines.push(`| image = [[File:${file}|250px]]`);
  if (box.caption) lines.push(`| caption = ${wikiText(box.caption, true)}`);
  for (const field of box.fields ?? []) {
    let value: string;
    if (field.kind === 'page') {
      value = field.value.trim() ? pageLink(field.value.trim(), field.value.trim(), context, true) : '';
    } else if (field.kind === 'pages') {
      value = field.value
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => pageLink(name, name, context, true))
        .join(', ');
    } else {
      value = xmlSafe(field.value).split('\n').map((line) => wikiText(line, true)).join('<br />');
    }
    lines.push(`| ${templateParam(field.key)} = ${value}`);
  }
  lines.push('}}');
  return lines.join('\n');
}

/** The template a page type's infobox calls, so the import shows something straight away. */
function infoboxTemplate(fields: Map<string, string>): string {
  const rows = [...fields].flatMap(([key, label]) => ['|-', `! ${wikiText(label, true)}`, `| {{{${key}|}}}`]);
  return [
    '<includeonly>{| class="infobox" style="float: right; clear: right; width: 22em; margin: 0 0 1em 1em;"',
    '|+ {{{name|{{PAGENAME}}}}}',
    '|-',
    '| colspan="2" style="text-align: center;" | {{{image|}}}<br />{{{caption|}}}',
    ...rows,
    '|}</includeonly><noinclude>Made by LoreCraft for imported pages. Rows with no value stay blank.</noinclude>',
  ].join('\n');
}

/** SHA-1 as MediaWiki stores it: base 36 and padded to 31 characters. */
export function mediaWikiSha1(bytes: Uint8Array): string {
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const length = bytes.length;
  const padded = new Uint8Array((((length + 8) >> 6) + 1) * 64);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(length / 0x20000000));
  view.setUint32(padded.length - 4, (length << 3) >>> 0);
  const w = new Uint32Array(80);
  const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let t = 0; t < 16; t += 1) w[t] = view.getUint32(offset + t * 4);
    for (let t = 16; t < 80; t += 1) w[t] = rotl(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
    let [a, b, c, d, e] = h;
    for (let t = 0; t < 80; t += 1) {
      const f = t < 20 ? (b & c) | (~b & d) : t < 40 ? b ^ c ^ d : t < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = t < 20 ? 0x5a827999 : t < 40 ? 0x6ed9eba1 : t < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const next = (rotl(a, 5) + f + e + k + w[t]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30) >>> 0;
      b = a;
      a = next;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
  }
  let value = 0n;
  for (const word of h) value = (value << 32n) | BigInt(word);
  return value.toString(36).padStart(31, '0');
}

/**
 * An xsd:dateTime in the form MediaWiki writes and reads back (TS_ISO_8601): a four-digit year
 * from 0001, whole seconds, UTC. A date outside that, or one that cannot be read, takes the next
 * candidate, and the time now when none will do, rather than `+010000-…` or a thrown RangeError.
 */
function timestamp(...candidates: (string | undefined)[]): string {
  for (const candidate of [...candidates, new Date().toISOString()]) {
    if (!candidate) continue;
    const date = new Date(candidate);
    const year = date.getUTCFullYear();
    if (!Number.isNaN(date.getTime()) && year >= 1 && year <= 9999) return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  return '1970-01-01T00:00:00Z';
}

export function exportMediaWiki(input: ExportInput): Uint8Array {
  const { snapshot } = input;
  const names = new NameKeeper();
  const titleOf = new Map<string, string>();
  for (const page of snapshot.pages) {
    const title = pageTitle(page.title);
    titleOf.set(page.id, names.take(title, '', (n) => numberedTitle(title, n)));
  }
  const assetOf = new Map(snapshot.assets.map((a) => [a.id, a]));
  const fileNames = new NameKeeper();
  const fileNameOf = new Map<string, string>();
  const fileName = (id: string): string | null => {
    const known = fileNameOf.get(id);
    if (known) return known;
    const asset: AssetMeta | undefined = assetOf.get(id);
    if (!asset) return null;
    const name = mediaWikiTitle(assetFileName(asset, fileNames));
    fileNameOf.set(id, name);
    return name;
  };
  const context: Context = {
    resolve: pageResolver(snapshot.pages, titleKey),
    titleOf,
    fileName,
    excluded: input.excludedPages,
    references: false,
  };

  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    '<mediawiki xmlns="http://www.mediawiki.org/xml/export-0.11/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ',
    'xsi:schemaLocation="http://www.mediawiki.org/xml/export-0.11/ http://www.mediawiki.org/xml/export-0.11.xsd" ',
    'version="0.11" xml:lang="en">\n',
    '<siteinfo>\n',
    `<sitename>${xmlText(snapshot.meta.name ?? 'LoreCraft')}</sitename>\n`,
    '<generator>LoreCraft</generator>\n<case>first-letter</case>\n<namespaces>\n',
    ...NAMESPACES.map(([key, name]) => `<namespace key="${key}" case="first-letter"${name ? `>${name}</namespace>` : ' />'}\n`),
    '</namespaces>\n</siteinfo>\n',
  ];

  let nextId = 1;
  const addPage = (title: string, ns: number, text: string, when: string | undefined, redirect?: string) => {
    const id = nextId;
    nextId += 1;
    const bytes = utf8(text);
    const sha1 = mediaWikiSha1(bytes);
    out.push(
      `<page>\n<title>${xmlText(title)}</title>\n<ns>${ns}</ns>\n<id>${id}</id>\n`,
      redirect ? `<redirect title="${xmlAttr(redirect)}" />\n` : '',
      `<revision>\n<id>${id}</id>\n<timestamp>${timestamp(when, input.exportedAt)}</timestamp>\n`,
      '<contributor><username>LoreCraft</username></contributor>\n<comment>Exported from LoreCraft</comment>\n',
      `<origin>${id}</origin>\n<model>wikitext</model>\n<format>text/x-wiki</format>\n`,
      `<text bytes="${bytes.length}" sha1="${sha1}" xml:space="preserve">${xmlText(text)}</text>\n`,
      `<sha1>${sha1}</sha1>\n</revision>\n</page>\n`,
    );
  };

  const templates = new Map<string, Map<string, string>>();
  const taken = new NameKeeper();
  snapshot.pages.forEach((page) => taken.take(titleOf.get(page.id) ?? page.title));

  snapshot.pages.forEach((page, index) => {
    const title = titleOf.get(page.id) ?? page.title;
    const { text, references } = pmToWikitext(page.content, context);
    const infobox = infoboxCall(page, context);
    const categories = page.categories.map((c) => `[[Category:${mediaWikiTitle(c)}]]`);
    const parts = [
      infobox,
      page.status === 'canon' ? '' : `<!-- LoreCraft status: ${page.status} -->`,
      text,
      references ? '== References ==\n<references />' : '',
      categories.join('\n'),
    ];
    addPage(title, NS_MAIN, parts.filter(Boolean).join('\n\n'), page.updatedAt);

    if (page.notes) {
      const talk = pmToWikitext(page.notes, context);
      if (talk.text) {
        const tail = talk.references ? '\n\n<references />' : '';
        addPage(`Talk:${title}`, NS_TALK, `${talk.text}${tail}`, page.updatedAt);
      }
    }
    if (infobox) {
      const name = infoboxName(page);
      const fields = templates.get(name) ?? new Map<string, string>();
      for (const field of page.infobox?.fields ?? []) {
        if (!fields.has(templateParam(field.key))) fields.set(templateParam(field.key), field.label || field.key);
      }
      templates.set(name, fields);
    }
    for (const alias of page.aliases) {
      const aliasTitle = pageTitle(alias);
      if (titleKey(aliasTitle) === titleKey(title)) continue;
      const free = taken.take(aliasTitle);
      if (free !== aliasTitle) continue;
      addPage(aliasTitle, NS_MAIN, `#REDIRECT [[${title.includes(':') ? `:${title}` : title}]]`, page.updatedAt, title);
    }
    input.progress?.(index + 1, snapshot.pages.length);
  });

  for (const [name, fields] of templates) {
    addPage(`Template:${name}`, NS_TEMPLATE, infoboxTemplate(fields), input.exportedAt);
  }
  out.push('</mediawiki>\n');
  return utf8(out.join(''));
}
