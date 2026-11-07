/**
 * Decides what lore goes with a request, inside the profile's budget.
 *
 * The order is pinned pages, then pages named in or linked from the selection and the
 * request, then the current document's, then related pages. The output is deterministic:
 * the same project state gives the same bytes, with no timestamps, so provider caches hit.
 * In a conversation, what the model already has is not sent again unless it changed.
 *
 * Document text comes from `pmToPlainText`, because that is what turns each figure into a
 * numbered `[Figure 2: label (description)]` line. The `content_text` column has no numbers.
 */

import * as coreApi from '../lib/api';
import { languageInfo, languageInstruction } from '../lib/languages';
import { isUnspacedScript, titleKey } from '../lib/text';
import { writingLanguage } from '../state/language';
import { describeFigures, figureToLine, pmToPlainText } from '../editor/convert';
import { factLines, promptMoment, wholeStoryMoment, type PromptMoment } from '../facts/prompt';
import { buildStoryIndex, sceneCount, type StoryIndex } from '../facts/storyIndex';
import { getDateContext, type DateContext } from '../lib/storyDate';
import { searchForAi } from '../meaning/lore';
import { useTitles } from '../state/project';
import { resolveStyleInstructions } from '../writingStyles/store';
import type { AiProfile } from '../lib/settings';
import type { Backlinks, Book, Node, NodeMeta, Page, PageStatus, PmNode, SearchHit, TitleEntry } from '../lib/types';
import { loadBookVoice, type BookVoice } from '../write/bookVoice';
import { attr, fence, narrationInstruction } from './prompts';
import { getStorySoFar, type StoryParams, type StorySoFar } from './summaries/api';
import { storyForContext } from './summaries/contextBlock';
import type { TextBlock } from './types';
import { t } from '../lib/i18n';

// ---------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------

/** A rough count: about four characters per token, and fewer for non-Latin text. */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4 + other / 1.5);
}

const DEFAULT_CONTEXT_LOCAL = 32_000;
const DEFAULT_CONTEXT_CLOUD = 40_000;

export function contextBudget(profile: AiProfile): number {
  if (profile.contextTokens && profile.contextTokens > 0) return profile.contextTokens;
  return profile.isCloud ? DEFAULT_CONTEXT_CLOUD : DEFAULT_CONTEXT_LOCAL;
}

/** A short stable fingerprint, for noticing that a page has changed. */
export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function shorten(text: string, tokens: number, note: string): string {
  const maxChars = Math.max(0, tokens * 4 - note.length);
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastBreak = Math.max(cut.lastIndexOf('\n\n'), cut.lastIndexOf('. '));
  return `${lastBreak > maxChars * 0.5 ? cut.slice(0, lastBreak + 1) : cut}\n${note}`;
}

// ---------------------------------------------------------------------------
// Reading order and spoilers
// ---------------------------------------------------------------------------

export interface ReadingOrder {
  /** Where each node falls across the whole series. */
  index: Map<string, number>;
  /** The last position inside each node, so a chapter's limit includes its scenes. */
  lastWithin: Map<string, number>;
  /** Page id to the scene it first appears in, for pages with no reveal point of their own. */
  firstAppearances?: Map<string, string>;
}

/** Books in order, each book's tree in reading order. */
export function buildReadingOrder(trees: { nodes: NodeMeta[] }[]): ReadingOrder {
  const index = new Map<string, number>();
  const lastWithin = new Map<string, number>();
  let next = 0;
  for (const { nodes } of trees) {
    const children = new Map<string | null, NodeMeta[]>();
    for (const node of nodes) {
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node);
      children.set(node.parentId, siblings);
    }
    for (const siblings of children.values()) siblings.sort((a, b) => a.position - b.position);
    const walk = (parent: string | null) => {
      for (const node of children.get(parent) ?? []) {
        index.set(node.id, next);
        next += 1;
        walk(node.id);
        lastWithin.set(node.id, next - 1);
      }
    };
    walk(null);
  }
  return { index, lastWithin };
}

/** What the model may know: everything up to and including this point in the story. */
export interface SpoilerLimit {
  cutoff: number;
  order: ReadingOrder;
}

/**
 * The spoiler limit for AI working inside a document: a scene knows only what is known as of
 * itself, as a chat limited to it would. Wiki pages and notes have no place in the story.
 */
export function asOfSource(source: { kind: string; id: string } | null | undefined): string | null {
  return source?.kind === 'node' ? source.id : null;
}

export function spoilerLimit(order: ReadingOrder, asOfNodeId: string | null | undefined): SpoilerLimit | null {
  if (!asOfNodeId) return null;
  const cutoff = order.lastWithin.get(asOfNodeId) ?? order.index.get(asOfNodeId);
  return cutoff === undefined ? null : { cutoff, order };
}

export function isNodeHidden(limit: SpoilerLimit | null, nodeId: string | null | undefined): boolean {
  if (!limit || !nodeId) return false;
  const at = limit.order.index.get(nodeId);
  return at !== undefined && at > limit.cutoff;
}

/** The scene from which a page is known: the writer's choice, or else its first appearance. */
export function revealPoint(page: { id?: string; revealNodeId: string | null }, order?: ReadingOrder | null): string | null {
  return page.revealNodeId || (page.id ? order?.firstAppearances?.get(page.id) : null) || null;
}

export function isPageHidden(limit: SpoilerLimit | null, page: { id?: string; revealNodeId: string | null }): boolean {
  return isNodeHidden(limit, revealPoint(page, limit?.order));
}

// ---------------------------------------------------------------------------
// Where lore comes from
// ---------------------------------------------------------------------------

/** Everything context assembly and the lore tools read. Replaced with a fake in tests. */
export interface LoreSource {
  titles(): TitleEntry[];
  page(id: string): Promise<Page | null>;
  pageByTitle(title: string): Promise<Page | null>;
  backlinks(id: string): Promise<Backlinks>;
  search(query: string, limit: number, kind?: 'page' | 'node'): Promise<SearchHit[]>;
  /** Optional, so a fake without it simply has no story to tell. */
  storySoFar?(params: StoryParams): Promise<StorySoFar>;
  node(id: string): Promise<Node | null>;
  books(): Promise<Book[]>;
  tree(bookId: string): Promise<NodeMeta[]>;
  listPages(filter: coreApi.PageListFilter): ReturnType<typeof coreApi.pages.list>;
  firstAppearances?(): Promise<Record<string, string>>;
  /** The project's eras and calendar. Without them, only plain dates can be ordered. */
  dates?(): Promise<DateContext>;
  /** A book's point of view and tense. Without it, none is set. */
  bookVoice?(bookId: string): Promise<BookVoice>;
}

export function defaultLore(): LoreSource {
  return {
    titles: () => useTitles.getState().entries,
    page: (id) => coreApi.pages.get(id).catch(() => null),
    pageByTitle: (title) => coreApi.pages.getByTitle(title).catch(() => null),
    backlinks: (id) => coreApi.pages.backlinks(id),
    search: (query, limit, kind) => searchForAi(query, limit, kind),
    storySoFar: getStorySoFar,
    node: (id) => coreApi.nodes.get(id).catch(() => null),
    books: () => coreApi.books.list(),
    tree: (bookId) => coreApi.nodes.tree(bookId),
    listPages: (filter) => coreApi.pages.list(filter),
    firstAppearances: () => coreApi.pages.firstAppearances(),
    dates: () => getDateContext(),
    bookVoice: (bookId) => loadBookVoice(bookId),
  };
}

/**
 * The point of view and tense a scene is written in: its book's setting, with the scene's
 * own point-of-view character. Empty for anything that is not a scene, or with nothing set.
 * Every request that writes prose for the book gets this, through the style block.
 */
export async function narrationFor(
  source: { kind: string; id: string } | null | undefined,
  lore: LoreSource = defaultLore(),
): Promise<string> {
  if (!source || source.kind !== 'node' || !lore.bookVoice) return '';
  const node = await lore.node(source.id);
  if (!node) return '';
  const voice = await lore.bookVoice(node.bookId);
  const pov = node.povPageId ? lore.titles().find((entry) => entry.id === node.povPageId)?.title : undefined;
  return narrationInstruction(voice, pov);
}

export async function loadReadingOrder(lore: LoreSource): Promise<ReadingOrder> {
  const books = await lore.books();
  const sorted = [...books].sort((a, b) => a.position - b.position);
  const trees = await Promise.all(sorted.map(async (book) => ({ nodes: await lore.tree(book.id) })));
  const order = buildReadingOrder(trees);
  const first = await lore.firstAppearances?.().catch(() => null);
  if (first) order.firstAppearances = new Map(Object.entries(first));
  return order;
}

/** An outline of every book: chapters and scenes with their synopses, for `{{book}}`. */
export async function bookOutline(lore: LoreSource = defaultLore(), forCloud = false): Promise<string> {
  const books = [...(await lore.books())].sort((a, b) => a.position - b.position);
  const parts: string[] = [];
  for (const book of books) {
    const tree = await lore.tree(book.id);
    const { index } = buildReadingOrder([{ nodes: tree }]);
    const lines = tree
      .filter((node) => !(forCloud && node.localOnly))
      .sort((a, b) => (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0))
      .map((node) => {
        const indent = node.kind === 'scene' ? '    ' : node.kind === 'chapter' && node.parentId ? '  ' : '';
        return `${indent}${node.title}${node.synopsis ? `: ${node.synopsis}` : ''}`;
      });
    parts.push([book.title, ...lines].join('\n'));
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Finding pages in text
// ---------------------------------------------------------------------------

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[\p{L}\p{N}_]/u.test(c);
}

/** A name can stop here, as in `MentionMatcher`. Scripts without spaces have no word edges. */
function isNameEdge(inner: string, outer: string | undefined): boolean {
  if (!isWordChar(outer)) return true;
  return isUnspacedScript(inner.codePointAt(0) as number) || isUnspacedScript((outer as string).codePointAt(0) as number);
}

/** True if the name appears in the text as whole words, where its script has them. */
function containsName(lowerText: string, name: string): boolean {
  const needle = name.trim().toLowerCase();
  if (needle.length < 2) return false;
  let from = 0;
  for (;;) {
    const at = lowerText.indexOf(needle, from);
    if (at < 0) return false;
    if (isNameEdge(needle[0], lowerText[at - 1]) && isNameEdge(needle[needle.length - 1], lowerText[at + needle.length])) return true;
    from = at + 1;
  }
}

/** Pages whose title or an alias appears in the text. */
export function pagesNamedIn(text: string, titles: TitleEntry[]): TitleEntry[] {
  const lower = text.toLowerCase();
  if (!lower.trim()) return [];
  return titles.filter((entry) => [entry.title, ...entry.aliases].some((name) => containsName(lower, name)));
}

/** Wiki-link targets written in Markdown, as in `[[Target|Label]]`. */
export function linkTargetsInMarkdown(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\]/g)) out.push(match[1].trim());
  return out;
}

export function linkTargetsInDoc(doc: PmNode | null | undefined): string[] {
  const out: string[] = [];
  const walk = (node: PmNode) => {
    for (const mark of node.marks ?? []) {
      if (mark.type === 'wikiLink' && mark.attrs?.target) out.push(String(mark.attrs.target));
    }
    node.content?.forEach(walk);
  };
  if (doc) walk(doc);
  return out;
}

// ---------------------------------------------------------------------------
// Formatting pages
// ---------------------------------------------------------------------------

const STATUS_MEANING: Record<PageStatus, string> = {
  canon: 'canon: established fact',
  draft: 'draft: tentative, may change',
  idea: 'idea: not established, use only if asked',
  retconned: 'retconned: no longer true',
};

export function statusTag(status: PageStatus): string {
  return STATUS_MEANING[status] ?? status;
}

/** Everything the facts of a page need to know about the story, read at most once. */
function storyLoader(lore: LoreSource): () => Promise<StoryIndex> {
  let story: Promise<StoryIndex> | null = null;
  const load = async () => {
    const [books, dates] = await Promise.all([lore.books(), lore.dates?.() ?? { eras: [], calendar: null }]);
    const trees = new Map(await Promise.all(books.map(async (book) => [book.id, await lore.tree(book.id)] as const)));
    return buildStoryIndex(books, (id) => trees.get(id) ?? [], dates);
  };
  return () => (story ??= load());
}

/** The node the spoiler limit stops at. */
function nodeAtLimit(limit: SpoilerLimit | null): string | null {
  if (!limit) return null;
  for (const [id, at] of limit.order.index) if (at === limit.cutoff) return id;
  return null;
}

export type MomentForPage = (page: Page) => Promise<PromptMoment | null>;

/**
 * Decides what point in the story a page's facts are given as of: the open scene, but never
 * past the spoiler limit, and otherwise the whole story. A page with nothing that depends on
 * this gets null, so that its text stays the same from scene to scene and the story is not read.
 */
export function factsMoments(lore: LoreSource, sceneId: string | null, limit: SpoilerLimit | null, storyIndex = storyLoader(lore)): MomentForPage {
  const limitNode = nodeAtLimit(limit);
  const atPoint = !!sceneId || !!limitNode;
  return async (page) => {
    const fields = page.infobox?.fields ?? [];
    const matters =
      fields.some((f) => (f.changes?.length ?? 0) > 0) ||
      (atPoint && fields.some((f) => (f.key === 'born' || f.key === 'died') && f.value.trim() !== ''));
    if (!matters) return null;
    try {
      const index = await storyIndex();
      const scene = sceneId && index.order.has(sceneId) && !isNodeHidden(limit, sceneId) ? sceneId : null;
      const at = scene ?? limitNode;
      return at && index.nodes.has(at) ? promptMoment(index, at, { omitLater: !!limit }) : wholeStoryMoment(index);
    } catch {
      return null;
    }
  };
}

function pageBody(page: Page, moment?: PromptMoment | null): string {
  const lines: string[] = [];
  if (page.aliases.length > 0) lines.push(`Also known as: ${page.aliases.join(', ')}`);
  if (page.categories.length > 0) lines.push(`Categories: ${page.categories.join(', ')}`);
  if (page.summary) lines.push(`Summary: ${page.summary}`);
  lines.push(...factLines(page, moment));
  const body = pmToPlainText(page.content);
  if (body) lines.push(body);
  return lines.join('\n');
}

/** A page as the model sees it. Tagged with its status, and fenced as data. */
export function formatPage(page: Page, maxTokens?: number, moment?: PromptMoment | null): { text: string; shortened: boolean } {
  const open = `<page title="${attr(page.title)}" status="${attr(statusTag(page.status))}" type="${attr(page.pageType)}">`;
  let body = pageBody(page, moment);
  let shortened = false;
  if (maxTokens !== undefined) {
    const room = maxTokens - estimateTokens(open) - 4;
    if (estimateTokens(body) > room) {
      body = shorten(body, Math.max(room, 40), '[Shortened to fit. Use get_page to read all of it.]');
      shortened = true;
    }
  }
  return { text: `${open}\n${fence(body)}\n</page>`, shortened };
}

/** A figure line for each figure in a document, for when its text had to be cut. */
function figureList(doc: PmNode): string {
  const lines = describeFigures(doc).map(figureToLine);
  return lines.length > 0 ? `Figures in this document:\n${lines.join('\n')}` : '';
}

/** Up to `tokens` of the document, centered on the selection if there is one. */
function excerpt(doc: PmNode, tokens: number, selectionText: string): { text: string; shortened: boolean } {
  const full = pmToPlainText(doc);
  if (estimateTokens(full) <= tokens) return { text: full, shortened: false };
  const figures = figureList(doc);
  const room = Math.max(200, tokens * 4 - figures.length - 80);
  const needle = selectionText.trim().slice(0, 60);
  const at = needle ? full.indexOf(needle) : -1;
  const center = at >= 0 ? at + Math.min(selectionText.length, room) / 2 : full.length;
  const start = Math.max(0, Math.round(center - room / 2));
  const end = Math.min(full.length, start + room);
  const before = start > 0 ? '[Earlier text not shown.]\n' : '';
  const after = end < full.length ? '\n[Later text not shown.]' : '';
  const parts = [`${before}${full.slice(start, end)}${after}`];
  if (figures) parts.push(figures);
  return { text: parts.join('\n\n'), shortened: true };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export type ItemKind = 'language' | 'selection' | 'document' | 'page' | 'story' | 'style';

/**
 * `included` goes in this request. `already` is in the conversation from an earlier turn.
 * The others are left out: by the person (`excluded`), by the spoiler limit (`spoiler`),
 * because an idea page was not asked about (`idea`), for lack of room (`budget`), or
 * because it is marked local only and this goes to a cloud profile (`localOnly`).
 */
export type ItemState = 'included' | 'already' | 'excluded' | 'spoiler' | 'idea' | 'budget' | 'localOnly';

export type ItemReason = 'language' | 'selection' | 'document' | 'pinned' | 'named' | 'linked' | 'related' | 'story' | 'style';

/** One thing that could be sent, as shown in the context view. */
export interface ContextItem {
  /** It is marked local only, or was made from something that is. */
  localOnly?: boolean;
  id: string;
  kind: ItemKind;
  title: string;
  status?: PageStatus;
  pageId?: string;
  reason: ItemReason;
  state: ItemState;
  /** Exactly what is sent. Empty if it is left out. */
  text: string;
  tokens: number;
  /** Some of it was cut to fit, and the text says so. */
  shortened: boolean;
  hash: string;
}

export interface ContextRequest {
  budgetTokens: number;
  /** Tokens already spoken for: system prompt, tools, history and the request itself. */
  reservedTokens?: number;
  /** The document in front of the person, including edits not yet saved. */
  source?: { kind: 'page' | 'node' | 'notes'; id: string; title: string } | null;
  doc?: PmNode | null;
  /** The request already quotes the document, so it need not be sent as well. */
  skipDocument?: boolean;
  /** Selected text. Always sent whole, whatever the budget. */
  selections?: { id: string; title: string; text: string; localOnly?: boolean }[];
  /** The person's own request, which can name pages. */
  instruction?: string;
  pinned?: string[];
  excluded?: string[];
  asOfNodeId?: string | null;
  /** A writing style for this request, over the scene's, book's and project's. */
  styleId?: string | null;
  /** What this conversation has already sent: item id to hash. */
  alreadySent?: Map<string, string>;
  /** The language to write in. The open project's, unless given. */
  language?: string;
  /** This goes to a cloud profile, so anything marked local only is withheld. */
  forCloud?: boolean;
}

export interface AssembledContext {
  items: ContextItem[];
  /** The language to write in, or empty. Goes first, as it almost never changes. */
  languageBlock: string;
  /** The style guide and writing style, or empty. Comes first, since it rarely changes. */
  styleBlock: string;
  /** All the lore, as one fixed block, or empty. Ends where the caching boundary goes. */
  loreBlock: string;
  /** The current document, or empty. */
  documentBlock: string;
  /** The selections, whole. */
  selectionBlocks: string[];
  /** Tokens this request adds, not counting what is reserved. */
  addedTokens: number;
  budgetTokens: number;
  reservedTokens: number;
  /** Things the person should know, in plain words. */
  warnings: string[];
  limit: SpoilerLimit | null;
}

/** The language note, if the language calls for one. Sent once per conversation. */
function languageItem(code: string, alreadySent: Map<string, string>): ContextItem | null {
  const instruction = languageInstruction(code);
  if (!instruction) return null;
  const text = `<language>${instruction}</language>`;
  const hash = hashText(text);
  return {
    id: 'language', kind: 'language', title: languageInfo(code)?.name ?? code, reason: 'language',
    state: alreadySent.get('language') === hash ? 'already' : 'included',
    text, tokens: estimateTokens(text), shortened: false, hash,
  };
}

function sortByTitle(entries: TitleEntry[]): TitleEntry[] {
  return [...entries].sort((a, b) => {
    const left = titleKey(a.title);
    const right = titleKey(b.title);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

async function documentItem(
  request: ContextRequest,
  roomTokens: number,
  lore: LoreSource,
  selectionText: string,
  momentFor: MomentForPage,
  storyIndex: () => Promise<StoryIndex>,
): Promise<{ item: ContextItem; povPageId?: string; localOnly: boolean } | null> {
  const { source, doc } = request;
  if (!source || !doc || source.kind === 'notes') return null;
  const header: string[] = [];
  let povPageId: string | undefined;
  let attrs = `title="${attr(source.title)}"`;
  let localOnly = false;
  if (source.kind === 'page') {
    const page = await lore.page(source.id);
    if (page) {
      localOnly = !!page.localOnly;
      attrs += ` kind="wiki page" status="${attr(statusTag(page.status))}" type="${attr(page.pageType)}"`;
      if (page.summary) header.push(`Summary: ${page.summary}`);
      header.push(...factLines(page, await momentFor(page)));
    } else {
      attrs += ' kind="wiki page"';
    }
  } else {
    const node = await lore.node(source.id);
    attrs += ' kind="manuscript scene"';
    if (node) {
      localOnly = !!node.localOnly;
      if (node.synopsis) header.push(`Synopsis: ${node.synopsis}`);
      if (node.storyDate) header.push(`Story date: ${node.storyDate}`);
      const place = await storyIndex().then((index) => sceneCount(index, source.id)).catch(() => null);
      if (place) header.push(`Reading order: scene ${place.scene} of ${place.of}`);
      povPageId = node.povPageId ?? undefined;
      const pov = povPageId ? lore.titles().find((t) => t.id === povPageId) : undefined;
      if (pov) header.push(`Point of view: ${pov.title}`);
    }
  }
  // Labeled, so that nothing here gets written into the text as if it had been there.
  const headerText = header.length > 0 ? `Stored with this document, not part of its text:\n${header.join('\n')}\n\nIts text:\n` : '';
  const room = Math.max(120, roomTokens - estimateTokens(headerText) - 30);
  const body = excerpt(doc, room, selectionText);
  const text = `<document ${attrs}>\n${fence(headerText + (body.text || '[No text yet.]'))}\n</document>`;
  return {
    povPageId,
    localOnly,
    item: {
      id: `doc:${source.id}`,
      kind: 'document',
      title: source.title,
      reason: 'document',
      state: 'included',
      text,
      tokens: estimateTokens(text),
      shortened: body.shortened,
      hash: hashText(text),
    },
  };
}

/** Gathers the context for one request. Reads as little as the budget needs. */
export async function assembleContext(request: ContextRequest, lore: LoreSource = defaultLore()): Promise<AssembledContext> {
  const warnings: string[] = [];
  const budget = request.budgetTokens;
  const reserved = request.reservedTokens ?? 0;
  const alreadySent = request.alreadySent ?? new Map<string, string>();
  const excluded = new Set(request.excluded ?? []);
  const pinned = new Set(request.pinned ?? []);
  const items: ContextItem[] = [];

  const language = languageItem(request.language ?? writingLanguage(), alreadySent);
  if (language) items.push(language);
  const languageBlock = language?.state === 'included' ? language.text : '';
  const languageTokens = languageBlock ? language?.tokens ?? 0 : 0;

  const order = request.asOfNodeId ? await loadReadingOrder(lore) : null;
  const limit = order ? spoilerLimit(order, request.asOfNodeId) : null;

  // The selection is always sent whole. A budget it cannot fit is the person's to know
  // about, not something to fix by quietly cutting their text.
  const selectionBlocks: string[] = [];
  let selectionTokens = 0;
  const isWithheld = (item: { localOnly?: boolean }) => !!request.forCloud && !!item.localOnly;
  const selections = (request.selections ?? []).filter((s) => !isWithheld(s));
  for (const selection of (request.selections ?? []).filter(isWithheld)) {
    items.push({
      id: selection.id, kind: 'selection', title: selection.title, reason: 'selection',
      state: 'localOnly', text: '', tokens: 0, shortened: false, hash: '',
    });
  }
  const selectionText = selections.map((s) => s.text).join('\n\n');
  for (const selection of selections) {
    const text = `<selection from="${attr(selection.title)}">\n${fence(selection.text)}\n</selection>`;
    const tokens = estimateTokens(text);
    selectionTokens += tokens;
    selectionBlocks.push(text);
    items.push({
      id: selection.id, kind: 'selection', title: selection.title, reason: 'selection',
      state: 'included', text, tokens, shortened: false, hash: hashText(text), localOnly: selection.localOnly,
    });
  }
  if (selectionTokens + reserved > budget) {
    warnings.push(
      t(
        'The selected text is about {count} tokens, which with the rest of this request is more than this profile\'s context size of {budget}. It will be sent in full, and the model may refuse it if it is too long.',
        { count: selectionTokens.toLocaleString(), budget: budget.toLocaleString() },
      ),
    );
  }

  // The writer's own rules for how the book should read go with every request.
  const style = await resolveStyleInstructions({
    nodeId: request.source?.kind === 'node' ? request.source.id : undefined,
    styleId: request.styleId,
  }).catch(() => null);
  // The book's point of view and tense travel with the style, as the author's own rules.
  const narration = await narrationFor(request.source, lore).catch(() => '');
  const styleText = [style?.text, narration].filter(Boolean).join('\n\n');
  let styleBlock = '';
  if (styleText) {
    const text = `<writing_style>\n${styleText.replace(/<(\/?)writing_style\b/gi, '< $1writing_style')}\n</writing_style>`;
    const hash = hashText(text);
    const already = alreadySent.get('style') === hash;
    if (!already) styleBlock = text;
    const title = style?.styleName
      ? t('Writing style: {name}', { name: style.styleName })
      : style?.text ? t('Style guide') : t('Point of view and tense');
    items.push({
      id: 'style', kind: 'style', title, reason: 'style',
      state: already ? 'already' : 'included', text: already ? '' : text, tokens: already ? 0 : estimateTokens(text), shortened: false, hash,
    });
  }
  const styleTokens = styleBlock ? estimateTokens(styleBlock) : 0;

  let room = Math.max(0, budget - reserved - selectionTokens - styleTokens - languageTokens);
  let documentBlock = '';
  let documentTokens = 0;
  const storyIndex = storyLoader(lore);
  const momentFor = factsMoments(lore, request.source?.kind === 'node' ? request.source.id : null, limit, storyIndex);
  const made = request.skipDocument ? null : await documentItem(request, Math.floor(room * 0.5), lore, selectionText, momentFor, storyIndex);
  // A scene past the limit is a spoiler even when it happens to be the one open.
  const documentWithheld = !!made && isWithheld(made);
  const documentHidden = documentWithheld || (request.source?.kind === 'node' && isNodeHidden(limit, request.source.id));
  if (made) {
    const { item } = made;
    item.localOnly = made.localOnly;
    if (documentHidden) {
      item.state = documentWithheld ? 'localOnly' : 'spoiler';
      item.text = '';
      item.tokens = 0;
    } else if (alreadySent.get(item.id) === item.hash) {
      item.state = 'already';
      item.text = '';
    } else {
      documentBlock = item.text;
      documentTokens = item.tokens;
    }
    items.push(item);
    room = Math.max(0, room - documentTokens);
  }

  // ---- Which pages, in order of how much they matter --------------------------------
  const titles = lore.titles();
  const byId = new Map(titles.map((t) => [t.id, t]));
  const currentPageId = request.source?.kind === 'page' ? request.source.id : null;
  const resolve = (target: string) => {
    const key = titleKey(target);
    return titles.find((t) => titleKey(t.title) === key) ?? titles.find((t) => t.aliases.some((a) => titleKey(a) === key));
  };
  const addable = (entry: TitleEntry | undefined): entry is TitleEntry => !!entry && entry.id !== currentPageId;

  const seen = new Set<string>();
  const queue: { entry: TitleEntry; reason: ItemReason; asked: boolean }[] = [];
  const enqueue = (entries: TitleEntry[], reason: ItemReason, asked: boolean) => {
    for (const entry of sortByTitle(entries)) {
      if (!seen.has(entry.id)) {
        seen.add(entry.id);
        queue.push({ entry, reason, asked });
      }
    }
  };

  enqueue([...pinned].map((id) => byId.get(id)).filter(addable), 'pinned', true);

  const selectionLinks = selections.flatMap((s) => linkTargetsInMarkdown(s.text));
  enqueue(selectionLinks.map(resolve).filter(addable), 'linked', true);
  const askedText = `${selectionText}\n${request.instruction ?? ''}`;
  enqueue(pagesNamedIn(askedText, titles).filter(addable), 'named', true);

  if (request.doc && !documentHidden) {
    const docEntries = linkTargetsInDoc(request.doc).map(resolve).filter(addable);
    const pov = made?.povPageId ? byId.get(made.povPageId) : undefined;
    enqueue(addable(pov) ? [pov, ...docEntries] : docEntries, 'linked', false);
    enqueue(pagesNamedIn(pmToPlainText(request.doc), titles).filter(addable), 'named', false);
  }

  // ---- Fill the budget --------------------------------------------------------------
  const blocks: { title: string; text: string }[] = [];
  const story = await storyForContext(request, lore, room);
  if (story) {
    items.push(...story.items);
    const delivered = story.items.find((item) => item.state === 'included');
    if (delivered && alreadySent.get(delivered.id) === delivered.hash) {
      delivered.state = 'already';
    } else if (story.text) {
      blocks.push({ title: 'The story so far', text: story.text });
      room = Math.max(0, room - story.tokens);
    }
  }
  const perPage = Math.max(300, Math.floor(room / 3));
  const place = async (entry: TitleEntry, reason: ItemReason, asked: boolean): Promise<Page | null> => {
    const base = {
      id: `page:${entry.id}`, kind: 'page' as const, title: entry.title, status: entry.status,
      pageId: entry.id, reason, text: '', tokens: 0, shortened: false, hash: '',
    };
    if (excluded.has(entry.id)) {
      items.push({ ...base, state: 'excluded' });
      return null;
    }
    if (entry.status === 'idea' && !asked) {
      items.push({ ...base, state: 'idea' });
      return null;
    }
    const page = await lore.page(entry.id);
    if (!page) return null;
    if (isPageHidden(limit, page)) {
      items.push({ ...base, state: 'spoiler' });
      return null;
    }
    if (isWithheld(page)) {
      items.push({ ...base, state: 'localOnly' });
      return null;
    }
    const moment = await momentFor(page);
    const whole = formatPage(page, undefined, moment);
    const hash = hashText(whole.text);
    if (alreadySent.get(base.id) === hash) {
      items.push({ ...base, state: 'already', hash });
      return page;
    }
    if (room < 80) {
      items.push({ ...base, state: 'budget', tokens: estimateTokens(whole.text), hash });
      return page;
    }
    const fitted = formatPage(page, Math.min(perPage, room), moment);
    const tokens = estimateTokens(fitted.text);
    room = Math.max(0, room - tokens);
    blocks.push({ title: entry.title, text: fitted.text });
    items.push({ ...base, state: 'included', text: fitted.text, tokens, shortened: fitted.shortened, hash, localOnly: page.localOnly });
    return page;
  };

  const placed: Page[] = [];
  for (const { entry, reason, asked } of queue) {
    const page = await place(entry, reason, asked);
    if (page) placed.push(page);
  }

  // Related pages only get what room is left. They are never ideas or retconned facts,
  // which are for when they are asked about.
  if (room >= 80) {
    const related = new Map<string, TitleEntry>();
    const consider = (entry: TitleEntry | undefined) => {
      if (addable(entry) && !seen.has(entry.id) && entry.status !== 'idea' && entry.status !== 'retconned') {
        related.set(entry.id, entry);
      }
    };
    // What the rest of the wiki says about the open page. On a new page with only a title,
    // that is all there is to go on.
    const openPage = request.source?.kind === 'page' && !documentWithheld ? request.source : null;
    if (openPage) {
      const back = await lore.backlinks(openPage.id).catch(() => null);
      back?.pages.forEach((p) => consider(byId.get(p.id)));
    }
    for (const page of placed.slice(0, 8)) {
      linkTargetsInDoc(page.content).forEach((target) => consider(resolve(target)));
      const back = await lore.backlinks(page.id).catch(() => null);
      back?.pages.forEach((p) => consider(byId.get(p.id)));
    }
    // Capitalized words in the selection are likely names, and a search finds pages that
    // mention them, or the open page, without being titled after them.
    const names = [...new Set(selectionText.match(/[\p{Lu}][\p{L}\p{N}'’-]{3,}/gu) ?? [])].slice(0, 4);
    const searches = openPage ? [openPage.title, ...names] : names;
    const hits = await Promise.all(searches.map((query) => lore.search(query, 5, 'page').catch(() => [] as SearchHit[])));
    hits.flat().forEach((hit) => consider(byId.get(hit.id)));
    enqueue([...related.values()].slice(0, 20), 'related', false);
    for (const { entry, reason, asked } of queue.filter((q) => q.reason === 'related')) {
      if (room < 80) {
        items.push({
          id: `page:${entry.id}`, kind: 'page', title: entry.title, status: entry.status, pageId: entry.id,
          reason, state: 'budget', text: '', tokens: 0, shortened: false, hash: '',
        });
        continue;
      }
      await place(entry, reason, asked);
    }
  }

  const loreBlock = blocks.length > 0 ? `<lore>\n${blocks.map((b) => b.text).join('\n')}\n</lore>` : '';
  const addedTokens = languageTokens + styleTokens + selectionTokens + documentTokens + (loreBlock ? estimateTokens(loreBlock) : 0);
  const leftOut = items.filter((i) => i.state === 'budget').length;
  if (leftOut > 0) {
    warnings.push(
      leftOut === 1
        ? t('1 related page was left out for lack of room. Raise the context size in Settings > AI to include more, or pin the ones that matter.')
        : t('{count} related pages were left out for lack of room. Raise the context size in Settings > AI to include more, or pin the ones that matter.', { count: leftOut }),
    );
  }

  return {
    items,
    languageBlock,
    styleBlock,
    loreBlock,
    documentBlock,
    selectionBlocks,
    addedTokens,
    budgetTokens: budget,
    reservedTokens: reserved,
    warnings,
    limit,
  };
}

/** What the lore block is called where people see it. */
function loreLabel(count: number, story: boolean): string {
  if (count === 0 && story) return t('The story so far');
  if (story) {
    return count === 1
      ? t('Lore: 1 page and the story so far')
      : t('Lore: {count} pages and the story so far', { count });
  }
  return count === 1 ? t('Lore: 1 page') : t('Lore: {count} pages', { count });
}

/**
 * The context as message blocks, stable content first. The marker after the lore is where
 * a provider's cache can stop, since the document and selection change far more often.
 */
export function contextToBlocks(context: AssembledContext): TextBlock[] {
  const blocks: TextBlock[] = [];
  const delivered = (kind: ItemKind) =>
    context.items
      .filter((item) => item.kind === kind && item.state === 'included')
      .map((item) => ({ id: item.id, hash: item.hash }));
  const holdsLocalOnly = (...kinds: ItemKind[]) =>
    context.items.some((item) => kinds.includes(item.kind) && item.state === 'included' && item.localOnly);
  if (context.languageBlock) {
    blocks.push({
      type: 'text', text: context.languageBlock, hidden: true,
      label: t('Language'), contextItems: delivered('language'),
    });
  }
  if (context.styleBlock) {
    const item = context.items.find((i) => i.kind === 'style');
    blocks.push({
      type: 'text', text: context.styleBlock, hidden: true,
      label: item?.title ?? t('Writing style'), contextItems: delivered('style'),
    });
  }
  if (context.loreBlock) {
    const count = delivered('page').length;
    const story = delivered('story').length > 0;
    blocks.push({
      type: 'text', text: context.loreBlock, hidden: true, cache: true,
      label: loreLabel(count, story),
      contextItems: [...delivered('page'), ...delivered('story')],
      ...(holdsLocalOnly('page', 'story') ? { localOnly: true } : {}),
    });
  }
  if (context.documentBlock) {
    const item = context.items.find((i) => i.kind === 'document');
    blocks.push({
      type: 'text', text: context.documentBlock, hidden: true,
      label: item ? t('Open: {title}', { title: item.title }) : t('Open document'), contextItems: delivered('document'),
      ...(holdsLocalOnly('document') ? { localOnly: true } : {}),
    });
  }
  const selections = context.items.filter((i) => i.kind === 'selection' && i.state === 'included');
  context.selectionBlocks.forEach((text, index) => {
    blocks.push({
      type: 'text', text, hidden: true,
      label: selections[index] ? t('Selected from {title}', { title: selections[index].title }) : t('Selected from the document'),
      ...(selections[index]?.localOnly ? { localOnly: true } : {}),
    });
  });
  return blocks;
}

/** What earlier turns of a conversation delivered, so it need not go again. */
export function sentItems(messages: { content: { type: string; contextItems?: { id: string; hash: string }[] }[] }[]): Map<string, string> {
  const sent = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.content) {
      for (const item of block.contextItems ?? []) sent.set(item.id, item.hash);
    }
  }
  return sent;
}
