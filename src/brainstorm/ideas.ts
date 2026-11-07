/**
 * What the brainstorm board asks for and how it reads the answer. Pure, so it can be tested
 * without a model. The model is asked for one small JSON object, and anything close to it is
 * accepted, since small local models rarely get JSON exactly right.
 */

import { t } from '../lib/i18n';
import { READING_THE_MATERIAL } from '../ai/prompts';

export type BrainstormCategoryId =
  | 'names'
  | 'places'
  | 'twists'
  | 'next'
  | 'conflicts'
  | 'world'
  | 'titles'
  | 'objects'
  | 'dialogue'
  | 'traits'
  | 'custom';

export interface BrainstormCategory {
  id: BrainstormCategoryId;
  /** Shown to the writer. */
  label: () => string;
  /** Sent to the model, in English like every other prompt. */
  ask: string;
  /** The page type a card can become. Only names, places and objects make pages. */
  pageType?: string;
}

export const CATEGORIES: BrainstormCategory[] = [
  { id: 'names', label: () => t('Character names'), ask: 'names for characters, each with a few words on who might carry it', pageType: 'character' },
  { id: 'places', label: () => t('Place names'), ask: 'names for places, each with a few words on what the place is like', pageType: 'place' },
  { id: 'twists', label: () => t('Plot twists'), ask: 'plot twists that would surprise a reader but still fit what is established' },
  { id: 'next', label: () => t('What happens next'), ask: 'different things that could happen next in the story' },
  { id: 'conflicts', label: () => t('Conflicts'), ask: 'conflicts between characters, groups or ideas that could drive the story' },
  { id: 'world', label: () => t('World details'), ask: 'small, concrete details of the world: customs, foods, sayings, laws, crafts, weather' },
  { id: 'titles', label: () => t('Titles'), ask: 'titles for the book, a chapter or a scene' },
  { id: 'objects', label: () => t('Objects'), ask: 'objects or artifacts that could matter in the story, each with what makes it special', pageType: 'item' },
  { id: 'dialogue', label: () => t('Dialogue lines'), ask: 'single lines of dialogue a character could say, in their voice' },
  { id: 'traits', label: () => t('Character traits'), ask: 'character traits, habits or quirks that would make someone memorable' },
  { id: 'custom', label: () => t('Your own question'), ask: '' },
];

export function categoryById(id: string): BrainstormCategory {
  return CATEGORIES.find((category) => category.id === id) ?? CATEGORIES[0];
}

/** One idea on the board. */
export interface IdeaCard {
  id: string;
  category: BrainstormCategoryId;
  /** A few words: the name, the twist in brief, the line itself. */
  title: string;
  /** One sentence more, or empty. */
  detail: string;
}

export const IDEA_COUNT = 8;
const MAX_IDEAS = 16;
const MAX_TITLE = 160;
const MAX_DETAIL = 400;

export const BRAINSTORM_SYSTEM = `You help a novelist brainstorm in LoreCraft, where they keep a wiki of their invented world beside their manuscript. Give short, varied, specific ideas that fit their world and story. Never repeat an idea you are told is already on the board.

${READING_THE_MATERIAL}

Reply with only JSON in this form: {"ideas":[{"title":"a few words","detail":"one short sentence"}]}`;

export const BRAINSTORM_SCHEMA = {
  name: 'brainstorm_ideas',
  schema: {
    type: 'object',
    properties: {
      ideas: {
        type: 'array',
        items: {
          type: 'object',
          properties: { title: { type: 'string' }, detail: { type: 'string' } },
          required: ['title', 'detail'],
          additionalProperties: false,
        },
      },
    },
    required: ['ideas'],
    additionalProperties: false,
  },
};

export interface IdeaRequest {
  category: BrainstormCategoryId;
  /** The writer's note, or their whole question for `custom`. */
  note: string;
  /** What the board is about, if anything: a scene or page title. */
  focusTitle?: string;
  /** Ideas already on the board, so they are not given again. */
  existing: string[];
  /** Asked from one card: more in its vein. */
  like?: Pick<IdeaCard, 'title' | 'detail'>;
  count?: number;
}

/** The request the writer's choices make. Short, for small models. */
export function ideaPrompt(request: IdeaRequest): string {
  const count = request.count ?? IDEA_COUNT;
  const category = categoryById(request.category);
  const note = request.note.trim();
  const lines: string[] = [];
  if (category.id === 'custom') {
    lines.push(`Give ${count} short ideas that answer this: ${note || 'anything that would help this story'}`);
  } else {
    lines.push(`Give ${count} ${category.ask}.`);
    if (note) lines.push(`The author adds: ${note}`);
  }
  if (request.focusTitle) lines.push(`Focus on "${request.focusTitle}".`);
  if (request.like) {
    const like = request.like.detail ? `${request.like.title}: ${request.like.detail}` : request.like.title;
    lines.push(`Give more in the same vein as this one, but not the same: ${like}`);
  }
  const existing = request.existing.slice(-30);
  if (existing.length > 0) lines.push(`Already on the board, so do not repeat: ${existing.join('; ')}`);
  lines.push('Keep each title to a few words and each detail to one sentence.');
  return lines.join('\n');
}

function clean(value: unknown, max: number): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const text = String(value)
    .replace(/\s+/g, ' ')
    .replace(/^\s*(?:[-*•]|\d{1,2}[.)])\s+/u, '')
    .trim()
    .replace(/^["“”']+|["“”']+$/gu, '')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function firstText(item: Record<string, unknown>, keys: string[], max: number): string {
  for (const key of keys) {
    const found = clean(item[key], max);
    if (found) return found;
  }
  return '';
}

/** A plain string idea: "Name — what it is" or "Name: what it is" splits into two. */
function fromString(text: string): { title: string; detail: string } {
  const line = clean(text, MAX_TITLE + MAX_DETAIL);
  const split = /^(.{1,80}?)\s+[—–-]\s+(.+)$/u.exec(line) ?? /^([^:]{1,60}):\s+(.+)$/u.exec(line);
  if (split) return { title: clean(split[1], MAX_TITLE), detail: clean(split[2], MAX_DETAIL) };
  return { title: clean(line, MAX_TITLE), detail: '' };
}

/**
 * The ideas in whatever the model sent: `{"ideas": [...]}`, a bare list, objects with other
 * key names, or plain strings. Throws when there are none, with a message for the model.
 */
export function parseIdeas(value: unknown): { title: string; detail: string }[] {
  let list: unknown = value;
  if (list && typeof list === 'object' && !Array.isArray(list)) {
    const record = list as Record<string, unknown>;
    list = record.ideas ?? record.suggestions ?? record.items ?? record.results ?? Object.values(record).find(Array.isArray);
  }
  if (!Array.isArray(list)) throw new Error('Reply with {"ideas": [{"title": "...", "detail": "..."}]}.');
  const out: { title: string; detail: string }[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    let idea: { title: string; detail: string };
    if (typeof item === 'string' || typeof item === 'number') idea = fromString(String(item));
    else if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      idea = {
        title: firstText(record, ['title', 'name', 'idea', 'line', 'text', 'summary'], MAX_TITLE),
        detail: firstText(record, ['detail', 'details', 'description', 'why', 'explanation', 'note'], MAX_DETAIL),
      };
      if (!idea.title && idea.detail) idea = fromString(idea.detail);
    } else continue;
    const key = idea.title.toLowerCase();
    if (!idea.title || seen.has(key)) continue;
    seen.add(key);
    out.push(idea);
    if (out.length >= MAX_IDEAS) break;
  }
  if (out.length === 0) throw new Error('There were no ideas in that reply. Give at least one, each with a "title".');
  return out;
}

/** Drops ideas already on the board, by title. */
export function withoutRepeats<T extends { title: string }>(ideas: T[], board: { title: string }[]): T[] {
  const taken = new Set(board.map((card) => card.title.toLowerCase()));
  return ideas.filter((idea) => !taken.has(idea.title.toLowerCase()));
}

/** What a kept card says in the Inbox: the idea first, so it can become a page, then the tag. */
export function inboxText(card: Pick<IdeaCard, 'title' | 'detail' | 'category'>): string {
  const lines = [card.title];
  if (card.detail) lines.push(card.detail);
  lines.push(t('Brainstorm: {category}', { category: categoryById(card.category).label() }));
  return lines.join('\n');
}

/** Puts new cards right after the one they came from, or at the end. */
export function insertAfter(board: IdeaCard[], afterId: string | null, cards: IdeaCard[]): IdeaCard[] {
  const at = afterId ? board.findIndex((card) => card.id === afterId) : -1;
  if (at < 0) return [...board, ...cards];
  return [...board.slice(0, at + 1), ...cards, ...board.slice(at + 1)];
}
