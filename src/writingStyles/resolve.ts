/**
 * Works out which style applies and turns it, with the writer's style guide, into the block
 * the AI receives. This sits in a cached prompt prefix, so the same inputs must always give
 * the same bytes: a fixed order, and no dates or counters.
 */

import { t } from '../lib/i18n';
import { formatGuide, hasGuide, mergeGuides } from './guide';
import { buildStylePrompt } from './prompt';
import type { StoredChoices, StoredGuide, StoredStyleChoice, WritingStyle } from './types';

export interface StyleRequest {
  /** The book being written. Worked out from `nodeId` when left out. */
  bookId?: string | null;
  /** The scene being written. */
  nodeId?: string | null;
  /** An explicit choice, such as a chat's. Beats everything else. */
  styleId?: string | null;
}

export interface StyleInstructions {
  /** What to give the AI. Empty if there is no style and no style guide. */
  text: string;
  styleName: string | null;
  /** Where each part came from, for showing what is sent. */
  sources: string[];
}

export type StyleLevel = 'chat' | 'scene' | 'book' | 'project';

export interface EffectiveStyle {
  styleId: string;
  name: string | null;
  prompt: string | null;
  level: StyleLevel;
}

/** Explicit choice, then scene, then book, then project. Skips a style that cannot be found. */
export function pickStyle(
  choices: StoredChoices,
  request: StyleRequest,
  lookup: (id: string) => WritingStyle | undefined,
): EffectiveStyle | null {
  const { bookId, nodeId, styleId } = request;
  const candidates: { level: StyleLevel; choice: StoredStyleChoice | undefined }[] = [
    { level: 'chat', choice: styleId ? { styleId } : undefined },
    { level: 'scene', choice: nodeId ? choices.scenes?.[nodeId] : undefined },
    { level: 'book', choice: bookId ? choices.books?.[bookId] : undefined },
    { level: 'project', choice: choices.project },
  ];
  for (const { level, choice } of candidates) {
    if (!choice) continue;
    const style = lookup(choice.styleId);
    if (style) return { styleId: choice.styleId, name: style.name, prompt: buildStylePrompt(style), level };
    // The project's own copy keeps a custom style working on another computer.
    if (choice.prompt) return { styleId: choice.styleId, name: choice.name ?? null, prompt: choice.prompt, level };
  }
  return null;
}

const LEVEL_NAMES: Record<StyleLevel, string> = {
  chat: 'this chat',
  scene: 'this scene',
  book: 'this book',
  project: 'this project',
};

export function levelName(level: StyleLevel): string {
  return LEVEL_NAMES[level];
}

/** Where the style came from, as the screen shows it. */
function styleSource(name: string, level: StyleLevel): string {
  switch (level) {
    case 'chat': return t('Style: {name} (for this chat)', { name });
    case 'scene': return t('Style: {name} (for this scene)', { name });
    case 'book': return t('Style: {name} (for this book)', { name });
    case 'project': return t('Style: {name} (for this project)', { name });
  }
}

/** Builds the block from what the project stores. No side effects, so tests call it directly. */
export function composeInstructions(
  choices: StoredChoices,
  guide: StoredGuide,
  request: StyleRequest,
  lookup: (id: string) => WritingStyle | undefined,
): StyleInstructions {
  const sources: string[] = [];
  const bookGuide = request.bookId ? guide.books?.[request.bookId] : undefined;
  const guideText = formatGuide(mergeGuides(guide.project, bookGuide));
  if (guideText) {
    if (hasGuide(guide.project)) sources.push(t('Style guide: project'));
    if (hasGuide(bookGuide)) sources.push(t('Style guide: book'));
  }

  const picked = pickStyle(choices, request, lookup);
  if (picked) sources.push(styleSource(picked.name ?? picked.styleId, picked.level));

  const parts: string[] = [];
  if (guideText) {
    const lead = picked
      ? "The writer's style guide. These are the writer's own rules, and they override the writing style below wherever the two differ."
      : "The writer's style guide. These are the writer's own rules.";
    parts.push(`${lead}\n${guideText}`);
  }
  if (picked?.prompt) parts.push(guideText ? `Writing style:\n${picked.prompt}` : picked.prompt);
  return { text: parts.join('\n\n'), styleName: picked?.name ?? null, sources };
}
