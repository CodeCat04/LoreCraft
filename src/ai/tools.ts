/**
 * The tools a model can call. Every one is read-only or a proposal: nothing here writes
 * to the project, so text inside a lore page cannot cause an action however it is worded.
 * A proposal only records a suggestion, which the person can review and apply.
 *
 * Input is validated before anything runs, since streaming providers may hand over
 * malformed or partial arguments. Results obey the spoiler limit: what the model may not
 * know yet is treated as if it does not exist.
 */

import { titleKey } from '../lib/text';
import { pmToPlainText } from '../editor/convert';
import type { NodeMeta } from '../lib/types';
import { attr, fence } from './prompts';
import {
  factsMoments,
  formatPage,
  isNodeHidden,
  isPageHidden,
  statusTag,
  type LoreSource,
  type SpoilerLimit,
} from './context';
import type { ToolCallBlock, ToolDef, ToolResultBlock } from './types';

export const PROPOSE_EDIT = 'propose_edit';
export const PROPOSE_NEW_PAGE = 'propose_new_page';

/** Sorted by name, and the same on every request, since this is part of the cached prefix. */
export const LORE_TOOLS: ToolDef[] = [
  {
    name: 'get_backlinks',
    description: 'Find what links to or mentions a wiki page: the pages that link to it and the scenes that name it. Call this to see where something appears in the story.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string', description: 'The page title or an alias.' } },
      required: ['title'],
    },
  },
  {
    name: 'get_page',
    description: 'Read a whole wiki page, with its status, summary, infobox and text. Call this when a question depends on a page you have not been shown in full.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string', description: 'The page title or an alias.' } },
      required: ['title'],
    },
  },
  {
    name: 'get_scene',
    description: 'Read a scene of the manuscript. Call this when you need what actually happens in a scene. Scene titles can repeat, so use an id from search_lore if there is more than one.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The scene title.' },
        id: { type: 'string', description: 'The scene id, if known. Used instead of the title.' },
      },
    },
  },
  {
    name: 'list_pages',
    description: 'List wiki pages with their status and summary, optionally filtered. Call this to see what the wiki covers.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['canon', 'draft', 'idea', 'retconned'] },
        type: { type: 'string', description: 'A page type, such as character or place.' },
        category: { type: 'string' },
        limit: { type: 'integer', description: 'At most this many. The default is 50.' },
      },
    },
  },
  {
    name: PROPOSE_EDIT,
    description: 'Suggest changing text in a wiki page or scene. This changes nothing by itself: the author sees the suggestion and decides. Call this when the author asks for a change to a page or scene. Quote the text to change exactly as it appears.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['page', 'scene'] },
        title: { type: 'string', description: 'The page or scene to change.' },
        find: { type: 'string', description: 'The exact text to replace, copied from the page or scene. Keep it short enough to be unique.' },
        replace: { type: 'string', description: 'The new text, in Markdown.' },
        reason: { type: 'string', description: 'One sentence on why, for the author.' },
      },
      required: ['kind', 'title', 'find', 'replace'],
    },
  },
  {
    name: PROPOSE_NEW_PAGE,
    description: 'Suggest a new wiki page. This creates nothing by itself: the author sees the suggestion and decides. Call this when the author asks for a page that does not exist yet.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        type: { type: 'string', description: 'A page type, such as character, place, faction, item, event or concept.' },
        summary: { type: 'string', description: 'One or two sentences.' },
        body: { type: 'string', description: 'The article, in Markdown.' },
        reason: { type: 'string', description: 'One sentence on why, for the author.' },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'search_lore',
    description: 'Search the whole project, wiki and manuscript, for words or names. Call this first when you do not know which page or scene holds something.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for.' },
        limit: { type: 'integer', description: 'At most this many results. The default is 12.' },
      },
      required: ['query'],
    },
  },
];

/**
 * Checks tool input against its schema's simple rules, or returns what is wrong. With
 * eager input streaming the provider no longer checks this, so it must be checked here.
 */
export function validateToolInput(tool: ToolDef, input: unknown): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return 'The input must be an object.';
  const value = input as Record<string, unknown>;
  const schema = tool.inputSchema as {
    properties?: Record<string, { type?: string; enum?: string[] }>;
    required?: string[];
  };
  for (const name of schema.required ?? []) {
    if (value[name] === undefined || value[name] === null) return `"${name}" is required.`;
    if (schema.properties?.[name]?.type === 'string' && String(value[name]).trim() === '') return `"${name}" must not be empty.`;
  }
  for (const [name, rule] of Object.entries(schema.properties ?? {})) {
    const given = value[name];
    if (given === undefined || given === null) continue;
    if (rule.type === 'string' && typeof given !== 'string') return `"${name}" must be a string.`;
    if (rule.type === 'integer' && !Number.isInteger(given)) return `"${name}" must be a whole number.`;
    if (rule.enum && !rule.enum.includes(String(given))) return `"${name}" must be one of ${rule.enum.join(', ')}.`;
  }
  return null;
}

export interface ToolContext {
  lore: LoreSource;
  limit: SpoilerLimit | null;
  /** The model is a cloud one, so anything marked local only is withheld from it. */
  forCloud?: boolean;
  /** The tools this request declared, when that is not all of them. A model may try others. */
  allowed?: ReadonlySet<string>;
}

/** A result for one call. `content` is what the model reads. */
export interface ToolOutcome {
  content: string;
  isError?: boolean;
  localOnly?: boolean;
}

function pageOut({ limit, forCloud }: ToolContext, page: { revealNodeId: string | null; localOnly?: boolean }): boolean {
  return isPageHidden(limit, page) || (!!forCloud && !!page.localOnly);
}

async function sceneOut({ lore, limit, forCloud }: ToolContext, id: string): Promise<boolean> {
  if (isNodeHidden(limit, id)) return true;
  if (!forCloud) return false;
  const node = await lore.node(id);
  return !node || !!node.localOnly;
}

const WITHHELD = 'It is marked local only, so it cannot be sent to this provider. Say so if the author needs it.';

/** Long enough to be useful, small enough not to crowd out everything else. */
const MAX_RESULT_CHARS = 24_000;

function capped(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n[Result shortened. Ask for something narrower to see the rest.]`;
}

function clean(snippet: string): string {
  return snippet.replace(/[\u0002\u0003]/g, '').replace(/\s+/g, ' ').trim();
}

async function allScenes(lore: LoreSource): Promise<NodeMeta[]> {
  const books = await lore.books();
  const trees = await Promise.all(books.map((book) => lore.tree(book.id)));
  return trees.flat().filter((node) => node.kind === 'scene');
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, 200) : fallback;
}

function strip(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const handlers: Record<string, (input: Record<string, unknown>, context: ToolContext) => Promise<ToolOutcome>> = {
  async search_lore(input, context) {
    const { lore } = context;
    let localOnly = false;
    const hits = await lore.search(String(input.query), asNumber(input.limit, 12) * 2);
    const shown: string[] = [];
    for (const hit of hits) {
      if (hit.kind === 'page') {
        const entry = lore.titles().find((t) => t.id === hit.id);
        const page = entry ? await lore.page(hit.id) : null;
        if (!page || pageOut(context, page)) continue;
        localOnly ||= !!page.localOnly;
        shown.push(`- page "${hit.title}" (${statusTag(page.status)}): ${clean(hit.snippet)}`);
      } else {
        if (await sceneOut(context, hit.id)) continue;
        localOnly ||= (await lore.node(hit.id))?.localOnly === true;
        shown.push(`- scene "${hit.title}" (id ${hit.id}): ${clean(hit.snippet)}`);
      }
      if (shown.length >= asNumber(input.limit, 12)) break;
    }
    return { content: shown.length > 0 ? fence(shown.join('\n')) : `Nothing in the project matches "${String(input.query)}".`, localOnly };
  },

  async get_page(input, context) {
    const { lore, limit, forCloud } = context;
    const title = String(input.title);
    const page = await lore.pageByTitle(title);
    if (page && !page.deletedAt && forCloud && page.localOnly) return { content: `"${title}" cannot be read. ${WITHHELD}`, isError: true };
    if (!page || page.deletedAt || isPageHidden(limit, page)) {
      const key = titleKey(title);
      const near = lore.titles().filter((t) => titleKey(t.title).includes(key) && !(forCloud && t.localOnly)).slice(0, 5).map((t) => t.title);
      const hint = near.length > 0 ? ` Close matches: ${near.join(', ')}.` : '';
      return { content: `There is no page called "${title}".${hint}`, isError: true };
    }
    const moment = await factsMoments(lore, null, limit)(page);
    return { content: capped(formatPage(page, undefined, moment).text), localOnly: page.localOnly };
  },

  async list_pages(input, context) {
    const pages = await context.lore.listPages({
      status: input.status as never,
      pageType: input.type as string | undefined,
      category: input.category as string | undefined,
      limit: asNumber(input.limit, 50),
    });
    const shown = pages.filter((page) => !pageOut(context, page));
    const lines = shown
      .map((page) => `- ${page.title} (${page.pageType}, ${statusTag(page.status)})${page.summary ? `: ${strip(page.summary)}` : ''}`);
    return { content: lines.length > 0 ? capped(fence(lines.join('\n'))) : 'No pages match that.', localOnly: shown.some((page) => page.localOnly) };
  },

  async get_scene(input, context) {
    const { lore, limit, forCloud } = context;
    let id = typeof input.id === 'string' && input.id ? input.id : null;
    if (!id) {
      if (typeof input.title !== 'string' || !input.title.trim()) {
        return { content: 'Give the scene\'s title or id.', isError: true };
      }
      const key = titleKey(input.title);
      const matches = (await allScenes(lore)).filter((scene) => titleKey(scene.title) === key && !isNodeHidden(limit, scene.id) && !(forCloud && scene.localOnly));
      if (matches.length === 0) return { content: `There is no scene called "${input.title}".`, isError: true };
      if (matches.length > 1) {
        const list = matches.map((s) => `- "${s.title}" (id ${s.id})${s.synopsis ? `: ${strip(s.synopsis)}` : ''}`).join('\n');
        return { content: `Several scenes have that title. Call again with an id:\n${fence(list)}`, isError: true };
      }
      id = matches[0].id;
    }
    const node = await lore.node(id);
    if (!node || node.deletedAt || node.kind !== 'scene' || isNodeHidden(limit, id)) {
      return { content: `There is no scene with id "${id}".`, isError: true };
    }
    if (forCloud && node.localOnly) return { content: `That scene cannot be read. ${WITHHELD}`, isError: true };
    const lines: string[] = [];
    if (node.synopsis) lines.push(`Synopsis: ${node.synopsis}`);
    if (node.storyDate) lines.push(`Story date: ${node.storyDate}`);
    lines.push(`Status: ${node.status}`, '', pmToPlainText(node.content));
    return { content: capped(`<scene title="${attr(node.title)}" id="${attr(node.id)}">\n${fence(lines.join('\n'))}\n</scene>`), localOnly: node.localOnly };
  },

  async get_backlinks(input, context) {
    const { lore } = context;
    const title = String(input.title);
    const page = await lore.pageByTitle(title);
    if (!page || pageOut(context, page)) return { content: `There is no page called "${title}".`, isError: true };
    const links = await lore.backlinks(page.id);
    const lines: string[] = [];
    for (const source of links.pages) {
      const full = await lore.page(source.id);
      if (full && !pageOut(context, full)) lines.push(`- page "${source.title}" (${statusTag(source.status)})`);
    }
    for (const scene of links.scenes) {
      if (!(await sceneOut(context, scene.id))) lines.push(`- scene "${scene.title}" (id ${scene.id}), named ${scene.count} time${scene.count === 1 ? '' : 's'}`);
    }
    return { content: lines.length > 0 ? fence(lines.join('\n')) : `Nothing links to "${page.title}" yet.` };
  },

  async propose_edit(input, context) {
    const { lore, limit, forCloud } = context;
    const title = String(input.title);
    const find = String(input.find);
    let text: string | null = null;
    if (input.kind === 'page') {
      const page = await lore.pageByTitle(title);
      if (page && !pageOut(context, page)) text = pmToPlainText(page.content);
    } else {
      const key = titleKey(title);
      const scene = (await allScenes(lore)).find((s) => titleKey(s.title) === key && !isNodeHidden(limit, s.id) && !(forCloud && s.localOnly));
      const node = scene ? await lore.node(scene.id) : null;
      if (node) text = pmToPlainText(node.content);
    }
    if (text === null) return { content: `There is no ${String(input.kind)} called "${title}".`, isError: true };
    if (!text.includes(find)) {
      return { content: `That text is not in "${title}". Quote it exactly as it appears, and keep it short.`, isError: true };
    }
    return { content: 'The suggestion is in front of the author, who will decide. Nothing has changed yet.' };
  },

  async propose_new_page(input, { lore }) {
    const key = titleKey(String(input.title));
    const taken = lore.titles().find((t) => titleKey(t.title) === key || t.aliases.some((a) => titleKey(a) === key));
    if (taken) return { content: `A page called "${taken.title}" already exists. Use propose_edit to change it.`, isError: true };
    return { content: 'The suggestion is in front of the author, who will decide. Nothing has been created yet.' };
  },
};

/** Runs one call. Never throws: a failure is a result the model can respond to. */
export async function runTool(call: ToolCallBlock, context: ToolContext): Promise<ToolResultBlock> {
  const result = (outcome: ToolOutcome): ToolResultBlock => ({
    type: 'toolResult', toolCallId: call.id, name: call.name, content: outcome.content, isError: outcome.isError,
    ...(outcome.localOnly ? { localOnly: true } : {}),
  });
  if (call.invalid !== undefined) {
    // Built with the JSON library, so quotes in the bad input cannot break out of it.
    return result({ content: JSON.stringify({ INVALID_JSON: call.invalid }), isError: true });
  }
  const tool = LORE_TOOLS.find((t) => t.name === call.name);
  const handler = handlers[call.name];
  if (!tool || !handler || (context.allowed && !context.allowed.has(call.name))) {
    return result({ content: `There is no tool called "${call.name}".`, isError: true });
  }
  const problem = validateToolInput(tool, call.input);
  if (problem) return result({ content: `Bad input: ${problem}`, isError: true });
  try {
    return result(await handler(call.input as Record<string, unknown>, context));
  } catch (e) {
    return result({ content: `That could not be read: ${e instanceof Error ? e.message : String(e)}`, isError: true });
  }
}
