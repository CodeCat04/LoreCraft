/**
 * The requests for drafting a scene: from rough notes, from its synopsis, or from a premise
 * the writer types. Kept short, since small local models do these too. No side effects here,
 * so tests call these directly. The book's point of view and tense, the style, the lore and
 * the scene's text go with every request through the context, not from here.
 */

import { fence } from '../prompts';

export const DRAFT_LENGTHS = ['short', 'medium', 'long'] as const;
export type DraftLength = (typeof DRAFT_LENGTHS)[number];

/** About how many words each length asks for. */
export const DRAFT_WORDS: Record<DraftLength, number> = { short: 300, medium: 800, long: 2000 };

/** The most a local model is asked to write in one go. Longer drafts are written in parts. */
export const LOCAL_PART_WORDS = 900;

/** How much of the draft so far goes back with each later part, in words. */
const SO_FAR_WORDS = 1200;

export type DraftMode = 'notes' | 'synopsis' | 'premise';

export function isDraftLength(value: unknown): value is DraftLength {
  return DRAFT_LENGTHS.includes(value as DraftLength);
}

/** How many parts a draft is written in: one for a cloud model, more for long local ones. */
export function draftParts(length: DraftLength, isCloud: boolean): number {
  if (isCloud) return 1;
  return Math.max(1, Math.ceil(DRAFT_WORDS[length] / LOCAL_PART_WORDS));
}

/** What the model is told about the scene, beyond its text. Names only: lore pages go as context. */
export interface SceneBrief {
  title: string;
  pov?: string | null;
  cast?: string[];
  location?: string | null;
  /** Synopses of the scenes either side, in reading order. */
  before?: string | null;
  after?: string | null;
}

export interface DraftPart {
  /** From 1. */
  index: number;
  of: number;
  /** What the earlier parts wrote. */
  soFar: string;
}

export interface DraftSpec {
  mode: DraftMode;
  length: DraftLength;
  brief: SceneBrief;
  /** The synopsis or premise. Notes come as the selection instead. */
  plan?: string;
  part?: DraftPart;
}

/** Quotes text inside a block of this name, so nothing in it can close the block. */
function quoted(tag: string, text: string): string {
  const safe = fence(text).replace(new RegExp(`<(\\/?)${tag}\\b`, 'gi'), `< $1${tag}`);
  return `<${tag}>\n${safe.trim()}\n</${tag}>`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function briefLines(brief: SceneBrief): string[] {
  const lines = [`- Scene: ${oneLine(brief.title)}`];
  if (brief.pov) lines.push(`- Point-of-view character: ${oneLine(brief.pov)}`);
  const cast = (brief.cast ?? []).map(oneLine).filter(Boolean);
  if (cast.length > 0) lines.push(`- Cast: ${cast.join(', ')}`);
  if (brief.location) lines.push(`- Location: ${oneLine(brief.location)}`);
  if (brief.before) lines.push(`- The scene before: ${oneLine(brief.before)}`);
  if (brief.after) lines.push(`- The scene after: ${oneLine(brief.after)}`);
  return lines;
}

/** The last words of a draft, so a later part knows where to pick up without the whole of it. */
export function tailWords(text: string, words = SO_FAR_WORDS): string {
  const all = text.trim().split(/(\s+)/);
  // Words and the spaces between them alternate, so twice as many pieces.
  if (all.length <= words * 2) return text.trim();
  return `…${all.slice(-words * 2).join('').trimStart()}`;
}

function partLines(part: DraftPart | undefined, words: number): string[] {
  if (!part || part.of <= 1) return [`Write about ${words} words.`];
  const each = Math.round(words / part.of);
  if (part.index === 1) {
    return [
      `The scene is written in ${part.of} parts. Write only part 1: about ${each} words, covering the start of what happens. Stop at a natural break. Do not end the scene.`,
    ];
  }
  const lines = [quoted('draft', tailWords(part.soFar)), ''];
  lines.push(
    part.index < part.of
      ? `The <draft> block is the scene so far. Write part ${part.index} of ${part.of}: about ${each} words that carry straight on from where it stops, covering what happens next. Do not repeat it. Do not end the scene.`
      : `The <draft> block is the scene so far. Write the last part, ${part.index} of ${part.of}: about ${each} words that carry straight on from where it stops, cover the rest of what happens, and end the scene. Do not repeat it.`,
  );
  return lines;
}

/** The request for one part of a draft. */
export function draftInstruction(spec: DraftSpec): string {
  const words = DRAFT_WORDS[spec.length];
  const out: string[] = [];
  switch (spec.mode) {
    case 'notes':
      out.push(
        'The <selection> block holds my rough notes for this scene: loose thoughts, beats or bullet points. Write them out as a finished scene in prose.',
        'Keep every event and detail from the notes, in their order. Do not add new plot events. Turn notes into action, dialogue and description.',
      );
      break;
    case 'synopsis':
      out.push(
        'Write this scene from its synopsis, in the <plan> block. Show what happens through action, dialogue and description. Do not add new plot events.',
        '',
        quoted('plan', spec.plan ?? ''),
      );
      break;
    case 'premise':
      out.push(
        'Write a first draft of this scene from what I want to happen, in the <plan> block. Show it through action, dialogue and description.',
        '',
        quoted('plan', spec.plan ?? ''),
      );
      break;
  }
  out.push('', 'About the scene:', ...briefLines(spec.brief), '');
  out.push(...partLines(spec.part, words));
  out.push('Reply with only the prose, with no title, notes or commentary.');
  return out.join('\n');
}
