/**
 * The writer's default style for "Rewrite in a style…", and the styles they used last.
 * No side effects here, so tests call these directly.
 */

import { t } from '../lib/i18n';
import { pickStyle, type EffectiveStyle, type StyleLevel } from './resolve';
import type { StoredChoices, WritingStyle } from './types';

/** How many recently used styles the picker shows first. */
export const RECENT_LIMIT = 5;

/** The style a rewrite uses when the writer does not choose one: scene, then book, then project. */
export function rewriteDefault(
  choices: StoredChoices,
  request: { bookId?: string | null; nodeId?: string | null },
  lookup: (id: string) => WritingStyle | undefined,
): EffectiveStyle | null {
  // No explicit choice here: that is what the writer is about to make.
  return pickStyle(choices, { bookId: request.bookId, nodeId: request.nodeId }, lookup);
}

/** The label at the top of the picker, such as "Project style: Tolkien". */
export function defaultLabel(level: StyleLevel, name: string): string {
  switch (level) {
    case 'scene': return t('Scene style: {name}', { name });
    case 'book': return t('Book style: {name}', { name });
    case 'chat':
    case 'project': return t('Project style: {name}', { name });
  }
}

/** A stored list, read back safely. Anything that is not a list of ids gives an empty list. */
export function parseRecent(stored: string | null | undefined): string[] {
  if (!stored) return [];
  try {
    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed)) return [];
    const ids = parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
    return [...new Set(ids)].slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

/** Puts a style at the front of the recent list, once, and keeps the newest few. */
export function pushRecent(list: readonly string[], styleId: string, limit = RECENT_LIMIT): string[] {
  return [styleId, ...list.filter((id) => id !== styleId)].slice(0, limit);
}

/**
 * The picker's order with nothing typed: the given ids first, in that order, then the rest.
 * An id twice, or one with no style on this computer, is skipped.
 */
export function pickerOrder(all: readonly WritingStyle[], first: readonly (string | null | undefined)[]): WritingStyle[] {
  const byId = new Map(all.map((style) => [style.id, style]));
  const front: WritingStyle[] = [];
  const seen = new Set<string>();
  for (const id of first) {
    if (!id || seen.has(id)) continue;
    const style = byId.get(id);
    if (!style) continue;
    seen.add(id);
    front.push(style);
  }
  return [...front, ...all.filter((style) => !seen.has(style.id))];
}
