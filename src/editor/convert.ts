/**
 * Converts between ProseMirror JSON, Markdown, HTML and plain text. Everything that
 * reads or writes documents outside the editor should go through here.
 */

import MarkdownItFactory, { type MarkdownIt, type StateInline, type Token } from 'markdown-it';

import type { PmNode } from '../lib/types';

export const EMPTY_DOC: PmNode = { type: 'doc', content: [{ type: 'paragraph' }] };

type PmMark = NonNullable<PmNode['marks']>[number];

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

const FIGURE_NAMES: Record<string, string> = {
  figure: 'Figure',
  picture: 'Picture',
  table: 'Table',
  video: 'Video',
};

/** One labeled picture, video or table, as the AI and exporters see it. */
export interface FigureInfo {
  kind: string;
  /** Counts within its kind, in document order, starting at 1. */
  number: number;
  /** For example "Figure 2". */
  name: string;
  caption: string;
  description: string;
  align: string;
  width: number | null;
  /** Which media it holds. */
  media: 'image' | 'video' | 'table' | 'none';
  assetId: string | null;
  /** The address of a linked video, rather than one stored in the project. */
  url: string | null;
}

/** Counts figures per kind. Share one across documents to number them as one work. */
export function figureNumberer() {
  const counts = new Map<string, number>();
  return (kind: string): number => {
    const next = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, next);
    return next;
  };
}

export function figureInfo(node: PmNode, number: number): FigureInfo {
  const kind = String(node.attrs?.kind ?? 'figure');
  const children = node.content ?? [];
  const media = children.find((c) => c.type !== 'figcaption');
  const caption = children.find((c) => c.type === 'figcaption');
  const width = node.attrs?.width;
  return {
    kind,
    number,
    name: `${FIGURE_NAMES[kind] ?? 'Figure'} ${number}`,
    caption: caption ? pmToPlainText(caption) : '',
    description: String(node.attrs?.description ?? ''),
    align: String(node.attrs?.align ?? 'right'),
    width: typeof width === 'number' ? width : null,
    media:
      media?.type === 'image' || media?.type === 'video' || media?.type === 'table'
        ? media.type
        : 'none',
    assetId: media?.attrs?.assetId ? String(media.attrs.assetId) : null,
    url: media?.attrs?.url ? String(media.attrs.url) : null,
  };
}

/** Every figure in a document, in order. Works at any nesting depth. */
export function describeFigures(doc: PmNode): FigureInfo[] {
  const out: FigureInfo[] = [];
  const next = figureNumberer();
  const walk = (node: PmNode) => {
    if (node.type === 'figure') out.push(figureInfo(node, next(String(node.attrs?.kind ?? 'figure'))));
    node.content?.forEach(walk);
  };
  walk(doc);
  return out;
}

/** The line that stands for a figure in plain text, so the AI knows it is there. */
export function figureToLine(info: FigureInfo): string {
  const label = info.caption || 'no label';
  return `[${info.name}: ${label}${info.description ? ` (${info.description})` : ''}]`;
}

// ---------------------------------------------------------------------------
// Lists that fill themselves in
// ---------------------------------------------------------------------------

export interface PageListQuery {
  pageType: string;
  category: string;
  status: string;
  sort: string;
  /** An infobox field, by key or label. Lists from before this was added have none. */
  field?: string;
  /** What that field holds at the start of the story. */
  fieldValue?: string;
}

export function pageListQuery(node: PmNode): PageListQuery {
  const read = (name: string) => String(node.attrs?.[name] ?? '');
  return {
    pageType: read('pageType'),
    category: read('category'),
    status: read('status'),
    sort: read('sort') || 'title',
    field: read('field'),
    fieldValue: read('fieldValue'),
  };
}

/** Whether the query filters by a field, which needs both a field and a value. */
export function hasFieldFilter(query: PageListQuery): boolean {
  return Boolean(query.field?.trim() && query.fieldValue?.trim());
}

/**
 * Whether a page's infobox holds the field with that value before any change in the story.
 * Ignores case. A field of several titles matches when any one does. Same as `pages.list`.
 */
export function infoboxMatches(fields: ListableField[] | undefined, field: string, value: string): boolean {
  const name = field.trim().toLowerCase();
  const wanted = value.trim().toLowerCase();
  return (fields ?? []).some((f) => {
    if ((f.key ?? '').trim().toLowerCase() !== name && (f.label ?? '').trim().toLowerCase() !== name) return false;
    const held = (f.value ?? '').trim().toLowerCase();
    return held === wanted || held.split(',').some((part) => part.trim() === wanted);
  });
}

export interface ListableField {
  key?: string;
  label?: string;
  value?: string;
}

/** A list's query in words, for its caption and for text with no live list. */
export function describePageList(query: PageListQuery): string {
  let text = 'All pages';
  if (query.pageType) text += ` of type ${query.pageType.replace(/_/g, ' ')}`;
  if (query.category) text += ` in the category ${query.category}`;
  if (query.status) text += ` with the status ${query.status}`;
  if (hasFieldFilter(query)) text += `, where ${query.field!.trim()} is ${query.fieldValue!.trim()}`;
  return text;
}

/** What a list needs to know about a page. */
export interface ListablePage {
  title: string;
  pageType: string;
  status: string;
  categories: string[];
  isHome?: boolean;
  wordCount?: number;
  createdAt?: string;
  updatedAt?: string;
  infobox?: { fields?: ListableField[] };
}

/** The titles a list shows, in its order. Matches what `pages.list` returns in the app. */
export function pageListResults(query: PageListQuery, pages: ListablePage[]): string[] {
  const matching = pages.filter(
    (page) =>
      !page.isHome &&
      (!query.pageType || page.pageType === query.pageType) &&
      (!query.status || page.status === query.status) &&
      (!query.category || page.categories.includes(query.category)) &&
      (!hasFieldFilter(query) || infoboxMatches(page.infobox?.fields, query.field!, query.fieldValue!)),
  );
  const newestFirst = (a?: string, b?: string) => (b ?? '').localeCompare(a ?? '');
  const byTitle = (a: ListablePage, b: ListablePage) => a.title.localeCompare(b.title);
  matching.sort((a, b) => {
    if (query.sort === 'updated') return newestFirst(a.updatedAt, b.updatedAt) || byTitle(a, b);
    if (query.sort === 'created') return newestFirst(a.createdAt, b.createdAt) || byTitle(a, b);
    if (query.sort === 'words') return (b.wordCount ?? 0) - (a.wordCount ?? 0) || byTitle(a, b);
    return byTitle(a, b);
  });
  return matching.map((page) => page.title);
}

function linkedTitleItem(title: string): PmNode {
  return {
    type: 'listItem',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: title, marks: [{ type: 'wikiLink', attrs: { target: title } }] }],
      },
    ],
  };
}

/**
 * Replaces each list block with what it shows today, as an ordinary bulleted list. A live
 * query means nothing outside the app, so exports run on documents passed through this.
 */
export function expandPageLists(doc: PmNode, pages: ListablePage[]): PmNode {
  if (!doc.content) return doc;
  let changed = false;
  const content = doc.content.map((child) => {
    if (child.type === 'pageList') {
      changed = true;
      const titles = pageListResults(pageListQuery(child), pages);
      return titles.length > 0
        ? { type: 'bulletList', content: titles.map(linkedTitleItem) }
        : { type: 'paragraph', content: [{ type: 'text', text: 'No pages match yet.' }] };
    }
    const next = expandPageLists(child, pages);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...doc, content } : doc;
}

function pageListLine(node: PmNode): string {
  return `[List: ${describePageList(pageListQuery(node))}]`;
}

// ---------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------

const BLOCKS = new Set(['paragraph', 'heading', 'codeBlock', 'tableRow', 'horizontalRule']);

/**
 * Plain text with blank lines between blocks. Wiki links keep only their label, and a
 * figure becomes a line naming it, its label and its description.
 */
export function pmToPlainText(node: PmNode): string {
  const out: string[] = [];
  const next = figureNumberer();
  const walk = (n: PmNode) => {
    if (n.type === 'figure') {
      const info = figureInfo(n, next(String(n.attrs?.kind ?? 'figure')));
      out.push(figureToLine(info), '\n\n');
      // A table's cells are real text, so they stay. Other media have none.
      n.content?.filter((c) => c.type === 'table').forEach(walk);
      return;
    }
    if (n.type === 'canvasEmbed') {
      out.push('[Canvas]', '\n\n');
      return;
    }
    if (n.type === 'pageList') {
      out.push(pageListLine(n), '\n\n');
      return;
    }
    if (n.type === 'text') out.push(n.text ?? '');
    else if (n.type === 'hardBreak') out.push('\n');
    n.content?.forEach((child, index) => {
      if (n.type === 'tableRow' && index > 0) out.push('\t');
      walk(child);
    });
    if (BLOCKS.has(n.type)) out.push('\n\n');
  };
  walk(node);
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

/**
 * Comments are notes to the writer, so nothing made from a document shows them. A comment
 * splits text into runs, and those join up again here, so a link stays one link.
 */
function withoutComments(nodes: PmNode[]): PmNode[] {
  if (!nodes.some((node) => node.marks?.some((m) => m.type === 'comment'))) return nodes;
  const out: PmNode[] = [];
  for (const node of nodes) {
    const marks = node.marks?.filter((m) => m.type !== 'comment');
    const clean: PmNode = { ...node };
    if (marks?.length) clean.marks = marks;
    else delete clean.marks;
    const last = out[out.length - 1];
    if (last?.type === 'text' && clean.type === 'text' && JSON.stringify(last.marks ?? []) === JSON.stringify(clean.marks ?? [])) {
      last.text = (last.text ?? '') + (clean.text ?? '');
    } else {
      out.push(clean);
    }
  }
  return out;
}

/** A copy of a document with its comment marks taken out. */
export function stripCommentMarks(node: PmNode): PmNode {
  if (!node.content) return node;
  return { ...node, content: withoutComments(node.content).map(stripCommentMarks) };
}

// ---------------------------------------------------------------------------
// ProseMirror to Markdown
// ---------------------------------------------------------------------------

function escapeMarkdown(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/([*`[\]~<])/g, '\\$1')
    .replace(/&(?=#?\w+;)/g, '\\&')
    .replace(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, '\\_');
}

/**
 * Keeps a line that begins like a heading, list, rule or code block from becoming one.
 * Markdown cannot hold leading spaces in a paragraph, so those go.
 */
function escapeLineStart(line: string): string {
  return line
    .replace(/^[ \t]+/, '')
    .replace(/^(#{1,6}(?:\s|$)|>|[-+](?:\s|$))/, (marker: string) => `\\${marker}`)
    .replace(/^(\d+)([.)](?:\s|$))/, (_, digits: string, rest: string) => `${digits}\\${rest}`)
    .replace(/^([-=])(?=\1*\s*$)/, '\\$1');
}

function escapeParagraph(text: string): string {
  return text.split('\n').map(escapeLineStart).join('\n');
}

/** A code span, using enough backticks that any in the code stay literal. */
function codeSpan(code: string): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = '`'.repeat(longest + 1);
  const pad = code.startsWith('`') || code.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${code}${pad}${ticks}`;
}

/** Spaces and parentheses would end a Markdown link early. */
function markdownUrl(url: string): string {
  return url.replace(/[\s()<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

/** Inside `[[ ]]` and `^[ ]`, brackets and pipes need a backslash to stay literal. */
function escapeBrackets(text: string, pipe: boolean): string {
  return text
    .replace(pipe ? /([\\[\]|])/g : /([\\[\]])/g, '\\$1')
    .replace(/\s*\n\s*/g, ' ');
}

function unescapeBrackets(text: string): string {
  return text.replace(/\\([\\[\]|])/g, '$1');
}

const STACK_MARKS: Record<string, string> = { bold: '**', italic: '*', strike: '~~' };

/** Whitespace at the edge of a marked run would stop the markers from working. */
function splitMarkedEdges(nodes: PmNode[]): PmNode[] {
  const out: PmNode[] = [];
  for (const node of nodes) {
    const stacked = node.marks?.some((m) => m.type in STACK_MARKS);
    const match = node.type === 'text' && stacked ? /^(\s*)([\s\S]*?)(\s*)$/.exec(node.text ?? '') : null;
    if (!match || (!match[1] && !match[3]) || !match[2]) {
      out.push(node);
      continue;
    }
    const plainMarks = node.marks?.filter((m) => !(m.type in STACK_MARKS));
    const edge = (value: string): PmNode =>
      plainMarks?.length ? { type: 'text', text: value, marks: plainMarks } : { type: 'text', text: value };
    if (match[1]) out.push(edge(match[1]));
    out.push({ ...node, text: match[2] });
    if (match[3]) out.push(edge(match[3]));
  }
  return out;
}

function inlineToMarkdown(inline: PmNode[] | undefined): string {
  if (!inline) return '';
  const nodes = splitMarkedEdges(withoutComments(inline));
  let out = '';
  let open: string[] = [];

  const closeTo = (keep: string[]) => {
    while (open.length > keep.length || open.some((m, i) => m !== keep[i])) {
      const mark = open.pop();
      if (!mark) break;
      out += STACK_MARKS[mark];
    }
  };

  for (const node of nodes) {
    const marks = node.marks ?? [];
    const stacked = marks.map((m) => m.type).filter((t) => t in STACK_MARKS);
    // Marks that continue from the previous run stay open.
    let shared = 0;
    while (shared < open.length && stacked.includes(open[shared])) shared += 1;
    closeTo(open.slice(0, shared));
    for (const type of stacked) {
      if (!open.includes(type)) {
        out += STACK_MARKS[type];
        open = [...open, type];
      }
    }

    if (node.type === 'text') {
      const raw = node.text ?? '';
      let piece: string;
      if (marks.some((m) => m.type === 'code')) {
        piece = codeSpan(raw);
      } else {
        piece = escapeMarkdown(raw);
      }
      const wiki = marks.find((m) => m.type === 'wikiLink');
      const link = marks.find((m) => m.type === 'link');
      if (wiki) {
        const target = String(wiki.attrs?.target ?? '');
        const shownTarget = escapeBrackets(target, true);
        piece = raw === target ? `[[${shownTarget}]]` : `[[${shownTarget}|${escapeBrackets(raw, false)}]]`;
      } else if (link) {
        piece = `[${piece}](${markdownUrl(String(link.attrs?.href ?? ''))})`;
      }
      out += piece;
    } else if (node.type === 'hardBreak') {
      out += '  \n';
    } else if (node.type === 'reference') {
      out += `^[${escapeBrackets(String(node.attrs?.text ?? ''), false)}]`;
    } else if (node.type === 'image') {
      out += imageMarkdown(node);
    }
  }
  closeTo([]);
  return out;
}

function imageMarkdown(node: PmNode): string {
  const alt = escapeMarkdown(String(node.attrs?.alt ?? ''));
  const assetId = node.attrs?.assetId;
  const src = assetId ? `asset:${String(assetId)}` : markdownUrl(String(node.attrs?.src ?? ''));
  return `![${alt}](${src})`;
}


/**
 * Markdown has no figures, so the label becomes the alt text and the description the
 * title. Layout is not kept: the JSON export is the lossless one.
 */
function figureToMarkdown(node: PmNode): string {
  const info = figureInfo(node, 0);
  const media = (node.content ?? []).find((c) => c.type !== 'figcaption');
  if (media?.type === 'table') {
    const caption = info.caption ? `\n\nTable: ${info.caption}` : '';
    return tableToMarkdown(media) + caption;
  }
  const alt = escapeMarkdown(info.caption);
  const title = info.description ? ` "${info.description.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : '';
  if (media?.type === 'video') {
    const target = info.assetId ? `asset:${info.assetId}` : markdownUrl(info.url ?? '');
    return `![${alt}](video:${target}${title})`;
  }
  const src = info.assetId ? `asset:${info.assetId}` : markdownUrl(String(media?.attrs?.src ?? ''));
  return `![${alt}](${src}${title})`;
}

function prefixLines(text: string, first: string, rest: string): string {
  return text
    .split('\n')
    .map((line, index) => (index === 0 ? first : line ? rest : rest.trimEnd()) + line)
    .join('\n');
}

function tableToMarkdown(table: PmNode): string {
  const rows = (table.content ?? []).map((row) =>
    (row.content ?? []).map((cell) =>
      (cell.content ?? [])
        .map((child) => inlineToMarkdown(child.content))
        .join(' ')
        .replace(/\s*\n\s*/g, ' ')
        .replace(/\|/g, '\\|'),
    ),
  );
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  return [
    line(rows[0]),
    line(Array.from({ length: width }, () => '---')),
    ...rows.slice(1).map(line),
  ].join('\n');
}

function blockToMarkdown(node: PmNode): string {
  switch (node.type) {
    case 'paragraph':
      return escapeParagraph(inlineToMarkdown(node.content));
    case 'heading':
      return `${'#'.repeat(Number(node.attrs?.level ?? 1))} ${inlineToMarkdown(node.content).replace(/\s*\n\s*/g, ' ')}`;
    case 'blockquote':
      return prefixLines(blocksToMarkdown(node.content), '> ', '> ');
    case 'bulletList':
      return (node.content ?? [])
        .map((item) => prefixLines(blocksToMarkdown(item.content), '- ', '  '))
        .join('\n');
    case 'orderedList': {
      const start = Number(node.attrs?.start ?? 1);
      return (node.content ?? [])
        .map((item, i) => {
          const marker = `${start + i}. `;
          return prefixLines(blocksToMarkdown(item.content), marker, ' '.repeat(marker.length));
        })
        .join('\n');
    }
    case 'codeBlock': {
      const language = String(node.attrs?.language ?? '');
      const code = (node.content ?? []).map((c) => c.text ?? '').join('');
      const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
      const fence = '`'.repeat(Math.max(3, longest + 1));
      return `${fence}${language}\n${code}\n${fence}`;
    }
    case 'horizontalRule':
      return '---';
    case 'pageList':
      return escapeMarkdown(pageListLine(node));
    case 'canvasEmbed':
      return escapeMarkdown('[Canvas]');
    case 'image':
      return imageMarkdown(node);
    case 'figure':
      return figureToMarkdown(node);
    case 'table':
      return tableToMarkdown(node);
    default:
      return inlineToMarkdown(node.content);
  }
}

function blocksToMarkdown(nodes: PmNode[] | undefined): string {
  return (nodes ?? []).map(blockToMarkdown).join('\n\n');
}

export function pmToMarkdown(doc: PmNode): string {
  return blocksToMarkdown(doc.content).trim();
}

// ---------------------------------------------------------------------------
// Markdown parsing, shared by import and AI output
// ---------------------------------------------------------------------------

/** `[[Target]]`, `[[Target|Label]]`. A backslash keeps a bracket or pipe literal. */
function wikiLinkRule(state: StateInline, silent: boolean): boolean {
  const { src, pos, posMax } = state;
  if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false;
  let end = -1;
  let split = -1;
  for (let i = pos + 2; i + 1 < posMax; i += 1) {
    const c = src[i];
    if (c === '\\' && '\\[]|'.includes(src[i + 1])) i += 1;
    else if (c === '[' || c === '\n') return false;
    else if (c === '|' && split < 0) split = i;
    else if (c === ']' && src[i + 1] === ']') {
      end = i;
      break;
    }
  }
  if (end < 0) return false;
  const inner = src.slice(pos + 2, end);
  if (!inner.trim()) return false;
  if (!silent) {
    const target = unescapeBrackets(split >= 0 ? src.slice(pos + 2, split) : inner).trim();
    const label = unescapeBrackets(split >= 0 ? src.slice(split + 1, end) : inner).trim();
    const token = state.push('wiki_link', '', 0);
    token.meta = { target, label };
    token.content = label;
  }
  state.pos = end + 2;
  return true;
}

/** `^[citation text]` */
function referenceRule(state: StateInline, silent: boolean): boolean {
  const { src, pos, posMax } = state;
  if (src.charCodeAt(pos) !== 0x5e || src.charCodeAt(pos + 1) !== 0x5b) return false;
  let depth = 1;
  let i = pos + 2;
  for (; i < posMax && depth > 0; i += 1) {
    const c = src[i];
    if (c === '\\') i += 1;
    else if (c === '[') depth += 1;
    else if (c === ']') depth -= 1;
  }
  if (depth !== 0) return false;
  if (!silent) {
    const token = state.push('reference', '', 0);
    token.content = unescapeBrackets(src.slice(pos + 2, i - 1));
  }
  state.pos = i;
  return true;
}

function lorePlugin(md: MarkdownIt) {
  md.inline.ruler.before('link', 'wiki_link', wikiLinkRule);
  md.inline.ruler.before('wiki_link', 'reference', referenceRule);
}

const parser = new MarkdownItFactory({ html: false, linkify: false, breaks: false }).use(lorePlugin);

function addMark(marks: PmMark[], mark: PmMark): PmMark[] {
  return [...marks, mark];
}

/** The editor sorts marks itself, so a fixed order keeps equal text comparing equal. */
const MARK_ORDER = ['link', 'wikiLink', 'bold', 'italic', 'strike', 'underline', 'code'];

function sortMarks(marks: PmMark[]): PmMark[] {
  return [...marks].sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
}

/** The schema lets `code` stand only alone. A link matters more than the code style. */
function allowedMarks(marks: PmMark[]): PmMark[] {
  if (!marks.some((m) => m.type === 'code') || marks.length === 1) return marks;
  const links = marks.filter((m) => m.type === 'link' || m.type === 'wikiLink');
  return links.length > 0 ? marks.filter((m) => m.type !== 'code') : marks.filter((m) => m.type === 'code');
}

function inlineTokensToPm(tokens: Token[]): PmNode[] {
  const out: PmNode[] = [];
  let marks: PmMark[] = [];
  const pushText = (text: string, extra?: PmMark[]) => {
    if (!text) return;
    const all = sortMarks(allowedMarks(extra ? [...marks, ...extra] : marks));
    const node: PmNode = { type: 'text', text };
    if (all.length > 0) node.marks = all;
    const last = out[out.length - 1];
    if (last?.type === 'text' && JSON.stringify(last.marks ?? []) === JSON.stringify(node.marks ?? [])) {
      last.text = (last.text ?? '') + text;
    } else {
      out.push(node);
    }
  };
  const drop = (type: string) => {
    const index = marks.map((m) => m.type).lastIndexOf(type);
    if (index >= 0) marks = [...marks.slice(0, index), ...marks.slice(index + 1)];
  };
  for (const token of tokens) {
    switch (token.type) {
      case 'text':
        pushText(token.content);
        break;
      case 'softbreak':
        pushText(' ');
        break;
      case 'hardbreak':
        out.push({ type: 'hardBreak' });
        break;
      case 'code_inline':
        pushText(token.content, [{ type: 'code' }]);
        break;
      case 'strong_open':
        marks = addMark(marks, { type: 'bold' });
        break;
      case 'strong_close':
        drop('bold');
        break;
      case 'em_open':
        marks = addMark(marks, { type: 'italic' });
        break;
      case 'em_close':
        drop('italic');
        break;
      case 's_open':
        marks = addMark(marks, { type: 'strike' });
        break;
      case 's_close':
        drop('strike');
        break;
      case 'link_open':
        marks = addMark(marks, { type: 'link', attrs: { href: String(token.attrGet('href') ?? '') } });
        break;
      case 'link_close':
        drop('link');
        break;
      case 'wiki_link':
        pushText(String(token.meta?.label), [
          { type: 'wikiLink', attrs: { target: String(token.meta?.target) } },
        ]);
        break;
      case 'reference':
        out.push({ type: 'reference', attrs: { text: token.content } });
        break;
      case 'image':
        out.push(imageTokenToFigure(token));
        break;
      default:
        if (token.content) pushText(token.content);
    }
  }
  return out;
}

function withContent(node: PmNode, content: PmNode[]): PmNode {
  return content.length > 0 ? { ...node, content } : node;
}

function figureNode(
  kind: string,
  media: PmNode,
  caption: PmNode[],
  description = '',
): PmNode {
  return {
    type: 'figure',
    attrs: { kind, align: 'right', width: null, description },
    content: [media, withContent({ type: 'figcaption' }, caption)],
  };
}

/** Every Markdown image becomes a figure. The `video:` prefix marks a video. */
function imageTokenToFigure(token: Token): PmNode {
  const src = String(token.attrGet('src') ?? '');
  // The parsed children, because the token's own content still holds its escapes.
  const alt = (token.children ?? []).map((child) => child.content).join('');
  const caption: PmNode[] = alt ? [{ type: 'text', text: alt }] : [];
  const description = String(token.attrGet('title') ?? '');
  if (src.startsWith('video:')) {
    const target = src.slice('video:'.length);
    const attrs = target.startsWith('asset:')
      ? { assetId: target.slice('asset:'.length), url: null }
      : { assetId: null, url: target };
    return figureNode('video', { type: 'video', attrs }, caption, description);
  }
  const attrs: Record<string, unknown> = { alt };
  if (src.startsWith('asset:')) attrs.assetId = src.slice('asset:'.length);
  else attrs.src = src;
  return figureNode('figure', { type: 'image', attrs }, caption, description);
}

/** A heading can only hold text, so a figure in one leaves just its label. */
function figuresToText(nodes: PmNode[]): PmNode[] {
  return nodes.flatMap((node) =>
    node.type === 'figure'
      ? ((node.content ?? []).find((c) => c.type === 'figcaption')?.content ?? [])
      : [node],
  );
}

const TABLE_CAPTION = /^Table:\s*/;

/**
 * Tidies parsed blocks. Figures parse as inline but belong at block level, and a
 * `Table: text` line straight after a table is that table's label.
 */
function liftFigures(blocks: PmNode[]): PmNode[] {
  const out: PmNode[] = [];
  for (const block of blocks) {
    const previous = out[out.length - 1];
    const first = block.content?.[0];
    if (
      block.type === 'paragraph' && previous?.type === 'table' &&
      first?.type === 'text' && TABLE_CAPTION.test(first.text ?? '')
    ) {
      const rest = [{ ...first, text: (first.text ?? '').replace(TABLE_CAPTION, '') }, ...(block.content ?? []).slice(1)]
        .filter((n) => n.type !== 'text' || n.text);
      out[out.length - 1] = figureNode('table', previous, rest);
      continue;
    }
    if (block.type !== 'paragraph' || !block.content?.some((c) => c.type === 'figure')) {
      out.push(block);
      continue;
    }
    let run: PmNode[] = [];
    const flush = () => {
      if (run.length > 0) out.push({ type: 'paragraph', content: run });
      run = [];
    };
    for (const child of block.content) {
      if (child.type === 'figure') {
        flush();
        out.push(child);
      } else {
        run.push(child);
      }
    }
    flush();
  }
  return out;
}

function tokensToBlocks(tokens: Token[]): PmNode[] {
  let index = 0;

  const parseUntil = (close: string | null): PmNode[] => {
    const blocks: PmNode[] = [];
    while (index < tokens.length) {
      const token = tokens[index];
      if (close && token.type === close) {
        index += 1;
        return liftFigures(blocks);
      }
      index += 1;
      switch (token.type) {
        case 'paragraph_open': {
          const inline = tokens[index];
          index += 2; // inline, paragraph_close
          blocks.push(withContent({ type: 'paragraph' }, inlineTokensToPm(inline.children ?? [])));
          break;
        }
        case 'heading_open': {
          const inline = tokens[index];
          index += 2;
          const level = Math.min(4, Number(token.tag.slice(1)));
          blocks.push(
            withContent({ type: 'heading', attrs: { level } }, figuresToText(inlineTokensToPm(inline.children ?? []))),
          );
          break;
        }
        case 'blockquote_open':
          blocks.push({ type: 'blockquote', content: nonEmpty(parseUntil('blockquote_close')) });
          break;
        case 'bullet_list_open':
          blocks.push({ type: 'bulletList', content: parseItems('bullet_list_close') });
          break;
        case 'ordered_list_open': {
          const start = Number(token.attrGet('start') ?? 1);
          blocks.push({
            type: 'orderedList',
            attrs: { start },
            content: parseItems('ordered_list_close'),
          });
          break;
        }
        case 'fence':
        case 'code_block': {
          const code = token.content.replace(/\n$/, '');
          const language = token.info.trim() || null;
          blocks.push(
            withContent({ type: 'codeBlock', attrs: { language } }, code ? [{ type: 'text', text: code }] : []),
          );
          break;
        }
        case 'hr':
          blocks.push({ type: 'horizontalRule' });
          break;
        case 'table_open':
          blocks.push(parseTable());
          break;
        default:
          break;
      }
    }
    return liftFigures(blocks);
  };

  const nonEmpty = (blocks: PmNode[]): PmNode[] =>
    blocks.length > 0 ? blocks : [{ type: 'paragraph' }];

  const parseItems = (close: string): PmNode[] => {
    const items: PmNode[] = [];
    while (index < tokens.length) {
      const token = tokens[index];
      index += 1;
      if (token.type === close) break;
      if (token.type === 'list_item_open') {
        const content = nonEmpty(parseUntil('list_item_close'));
        // A list item must begin with a paragraph.
        if (content[0].type !== 'paragraph') content.unshift({ type: 'paragraph' });
        items.push({ type: 'listItem', content });
      }
    }
    return items;
  };

  const parseTable = (): PmNode => {
    const rows: PmNode[] = [];
    let row: PmNode[] = [];
    while (index < tokens.length) {
      const token = tokens[index];
      index += 1;
      if (token.type === 'table_close') break;
      if (token.type === 'tr_open') row = [];
      else if (token.type === 'tr_close') rows.push({ type: 'tableRow', content: row });
      else if (token.type === 'th_open' || token.type === 'td_open') {
        const inline = tokens[index];
        index += 2;
        row.push({
          type: token.type === 'th_open' ? 'tableHeader' : 'tableCell',
          content: nonEmpty(liftFigures([withContent({ type: 'paragraph' }, inlineTokensToPm(inline.children ?? []))])),
        });
      }
    }
    return { type: 'table', content: rows };
  };

  return nonEmpty(parseUntil(null));
}

export function markdownToPm(markdown: string): PmNode {
  const tokens = parser.parse(markdown, {});
  return { type: 'doc', content: tokensToBlocks(tokens) };
}

// ---------------------------------------------------------------------------
// ProseMirror to HTML, for exporters
// ---------------------------------------------------------------------------

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface HtmlOptions {
  /** Where a wiki link goes. Returning null renders it as a broken link. */
  wikiHref?: (target: string) => string | null;
  /** The URL for a project image. */
  assetSrc?: (assetId: string) => string | null;
  /** The URL for a project video. Without one, a video becomes a text placeholder. */
  videoSrc?: (assetId: string) => string | null;
  /** How to show a citation. The default is a star with the text as a tooltip. */
  reference?: (text: string) => string;
  /** An id for a heading, so links can point at it. */
  headingId?: (text: string, level: number) => string | null;
  /** Set false for documents that must not load anything from the web. */
  remoteImages?: boolean;
  /** Keeps figure numbers running across calls. From `figureNumberer`. */
  nextFigure?: (kind: string) => number;
}

/**
 * A link or picture address from a document, which may have come from someone else. Only
 * web and mail addresses, and addresses within the same site, get through. It is checked as
 * a browser reads it: tabs and line breaks anywhere are ignored, and so are spaces and control
 * characters around it, so `java&#9;script:` is `javascript:`. An address starting `//` or
 * `\\` names another computer, which from a page opened from disk on Windows is a network
 * share that is handed the reader's Windows credentials.
 */
export function safeUrl(url: string): string | null {
  // eslint-disable-next-line no-control-regex
  const seen = url.replace(/[\t\n\r]/g, '').replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(seen)?.[1].toLowerCase();
  if (scheme !== undefined) return ['http', 'https', 'mailto'].includes(scheme) ? escapeUrl(seen) : null;
  return /^[/\\]{2}/.test(seen) ? null : escapeUrl(seen);
}

/**
 * Writes what an address cannot hold as it is, such as a space or a quotation mark, as `%XX`,
 * so it is valid in the XHTML of an EPUB as well as in a browser. An escape already there stays,
 * and a `%` that starts none becomes `%25`.
 */
function escapeUrl(url: string): string {
  // eslint-disable-next-line no-control-regex
  return url.replace(/%(?![0-9a-f]{2})|[\x00-\x20"<>^`{|}\x7f]/gi, (c) => encodeURIComponent(c));
}

function inlineToHtml(nodes: PmNode[] | undefined, options: HtmlOptions): string {
  return withoutComments(nodes ?? [])
    .map((node) => {
      if (node.type === 'hardBreak') return '<br/>';
      if (node.type === 'reference') {
        const text = String(node.attrs?.text ?? '');
        return options.reference
          ? options.reference(text)
          : `<sup class="reference" title="${escapeHtml(text)}">*</sup>`;
      }
      if (node.type === 'image') return imageToHtml(node, options);
      let html = escapeHtml(node.text ?? '');
      for (const mark of node.marks ?? []) {
        switch (mark.type) {
          case 'bold':
            html = `<strong>${html}</strong>`;
            break;
          case 'italic':
            html = `<em>${html}</em>`;
            break;
          case 'underline':
            html = `<u>${html}</u>`;
            break;
          case 'strike':
            html = `<s>${html}</s>`;
            break;
          case 'code':
            html = `<code>${html}</code>`;
            break;
          case 'link': {
            const href = safeUrl(String(mark.attrs?.href ?? ''));
            if (href) html = `<a href="${escapeHtml(href)}">${html}</a>`;
            break;
          }
          case 'wikiLink': {
            const target = String(mark.attrs?.target ?? '');
            const href = options.wikiHref ? options.wikiHref(target) : null;
            html = href
              ? `<a class="wiki-link" href="${escapeHtml(href)}">${html}</a>`
              : `<span class="wiki-link-red">${html}</span>`;
            break;
          }
          default:
            break;
        }
      }
      return html;
    })
    .join('');
}

function imageToHtml(node: PmNode, options: HtmlOptions): string {
  const assetId = node.attrs?.assetId ? String(node.attrs.assetId) : null;
  const remote = options.remoteImages === false ? null : safeUrl(String(node.attrs?.src ?? ''));
  const src = assetId ? options.assetSrc?.(assetId) : remote;
  const alt = escapeHtml(String(node.attrs?.alt ?? ''));
  return src ? `<img src="${escapeHtml(src)}" alt="${alt}"/>` : `<em>[image: ${alt}]</em>`;
}

function videoToHtml(node: PmNode, options: HtmlOptions): string {
  const assetId = node.attrs?.assetId ? String(node.attrs.assetId) : null;
  const url = node.attrs?.url ? safeUrl(String(node.attrs.url)) : null;
  if (url) return `<p class="video-link"><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`;
  const src = assetId ? options.videoSrc?.(assetId) : null;
  return src
    ? `<video controls="controls" src="${escapeHtml(src)}"></video>`
    : '<p class="video-missing"><em>[video]</em></p>';
}

function figureToHtml(
  node: PmNode,
  options: HtmlOptions,
  next: (kind: string) => number,
): string {
  const info = figureInfo(node, next(String(node.attrs?.kind ?? 'figure')));
  const caption = (node.content ?? []).find((c) => c.type === 'figcaption');
  const media = (node.content ?? []).find((c) => c.type !== 'figcaption');
  const style = info.width ? ` style="width: ${Number(info.width)}%"` : '';
  const align = /^(left|right|center|full)$/.test(info.align) ? info.align : 'right';
  const alt = info.description || info.caption;
  // An image takes its alt text from the figure's description or label.
  const shown = media?.type === 'image' ? { ...media, attrs: { ...media.attrs, alt } } : media;
  const body = shown ? toHtml(shown, options, next) : '';
  return (
    `<figure class="figure figure-${align}"${style}>${body}` +
    `<figcaption><span class="figure-name">${escapeHtml(info.name)}.</span> ` +
    `${inlineToHtml(caption?.content, options)}</figcaption></figure>`
  );
}

function cellSpans(cell: PmNode): string {
  const span = (name: string) => {
    const value = Number(cell.attrs?.[name] ?? 1);
    return value > 1 ? ` ${name}="${value}"` : '';
  };
  return span('colspan') + span('rowspan');
}

/** Well-formed XHTML, so the same output works in EPUB. */
export function pmToHtml(node: PmNode, options: HtmlOptions = {}): string {
  return toHtml(node, options, options.nextFigure ?? figureNumberer());
}

function toHtml(node: PmNode, options: HtmlOptions, next: (kind: string) => number): string {
  const children = () => (node.content ?? []).map((c) => toHtml(c, options, next)).join('');
  switch (node.type) {
    case 'doc':
      return children();
    case 'paragraph':
      return `<p>${inlineToHtml(node.content, options)}</p>`;
    case 'pageList':
      return `<p><em>${escapeHtml(pageListLine(node))}</em></p>`;
    case 'canvasEmbed':
      return '<p><em>[Canvas]</em></p>';
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)));
      const id = options.headingId?.(pmToPlainText(node), level);
      const idAttr = id ? ` id="${escapeHtml(id)}"` : '';
      return `<h${level}${idAttr}>${inlineToHtml(node.content, options)}</h${level}>`;
    }
    case 'blockquote':
      return `<blockquote>${children()}</blockquote>`;
    case 'bulletList':
      return `<ul>${children()}</ul>`;
    case 'orderedList': {
      const start = Number(node.attrs?.start ?? 1);
      return start !== 1 && Number.isFinite(start)
        ? `<ol start="${start}">${children()}</ol>`
        : `<ol>${children()}</ol>`;
    }
    case 'listItem':
      return `<li>${children()}</li>`;
    case 'codeBlock':
      return `<pre><code>${escapeHtml((node.content ?? []).map((c) => c.text ?? '').join(''))}</code></pre>`;
    case 'horizontalRule':
      return '<hr/>';
    case 'image':
      return imageToHtml(node, options);
    case 'video':
      return videoToHtml(node, options);
    case 'figure':
      return figureToHtml(node, options, next);
    case 'table':
      return `<table><tbody>${children()}</tbody></table>`;
    case 'tableRow':
      return `<tr>${children()}</tr>`;
    case 'tableHeader':
      return `<th${cellSpans(node)}>${children()}</th>`;
    case 'tableCell':
      return `<td${cellSpans(node)}>${children()}</td>`;
    default:
      return inlineToHtml([node], options);
  }
}

// ---------------------------------------------------------------------------
// Rendering AI output
// ---------------------------------------------------------------------------

const safeRenderer = new MarkdownItFactory({ html: false, linkify: false, breaks: true }).use(lorePlugin);
// Models could otherwise make the app request remote images.
safeRenderer.disable('image');
// A link can only be a web or mail address. Any other scheme, such as one that starts another
// program on the computer, stays plain text.
safeRenderer.validateLink = (url) => /^(https?|mailto):/i.test(url.trim());
safeRenderer.renderer.rules.wiki_link = (tokens, idx) => {
  const meta = tokens[idx].meta as { target: string; label: string };
  return `<a class="wiki-link" data-wiki-target="${escapeHtml(meta.target)}">${escapeHtml(meta.label)}</a>`;
};
safeRenderer.renderer.rules.reference = (tokens, idx) =>
  `<sup class="reference-inline">[${escapeHtml(tokens[idx].content)}]</sup>`;

/**
 * Turns untrusted Markdown into HTML that is safe to insert. Raw HTML is escaped,
 * unsafe link schemes are dropped by markdown-it, and images are not rendered.
 */
export function renderMarkdownSafe(markdown: string): string {
  return safeRenderer.render(markdown);
}
