/**
 * A book's point of view and tense. Both are optional, and empty means "not set". They live
 * in project meta, beside the writing-style choices, so older projects need no change: a
 * project without the key simply has nothing set.
 */

import * as api from '../lib/api';
import { t } from '../lib/i18n';
import { useProject } from '../state/project';

export const POV_OPTIONS = ['first', 'second', 'close-third', 'distant-third', 'omniscient', 'multiple'] as const;
export const TENSE_OPTIONS = ['past', 'present'] as const;

export type BookPov = (typeof POV_OPTIONS)[number];
export type BookTense = (typeof TENSE_OPTIONS)[number];

export interface BookVoice {
  pov?: BookPov;
  tense?: BookTense;
}

/** Project meta key: book id to its voice. */
export const VOICE_KEY = 'books.voice';

export function povLabel(pov: BookPov): string {
  switch (pov) {
    case 'first': return t('First person');
    case 'second': return t('Second person');
    case 'close-third': return t('Close third person');
    case 'distant-third': return t('Distant third person');
    case 'omniscient': return t('Omniscient');
    case 'multiple': return t('Third person, changing by scene');
  }
}

export function tenseLabel(tense: BookTense): string {
  return tense === 'past' ? t('Past') : t('Present');
}

/** Only known values survive, so a damaged or newer value reads as "not set". */
export function cleanVoice(value: unknown): BookVoice {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const voice: BookVoice = {};
  if (POV_OPTIONS.includes(raw.pov as BookPov)) voice.pov = raw.pov as BookPov;
  if (TENSE_OPTIONS.includes(raw.tense as BookTense)) voice.tense = raw.tense as BookTense;
  return voice;
}

/** The stored map, read loosely. Anything that is not an object gives an empty map. */
export function parseVoices(stored: string | null | undefined): Record<string, BookVoice> {
  if (!stored) return {};
  try {
    const parsed = JSON.parse(stored) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, BookVoice> = {};
    for (const [bookId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const voice = cleanVoice(value);
      if (voice.pov || voice.tense) out[bookId] = voice;
    }
    return out;
  } catch {
    return {};
  }
}

const hasProject = () => useProject.getState().status.open;

export async function loadBookVoice(bookId: string): Promise<BookVoice> {
  if (!hasProject()) return {};
  return parseVoices(await api.project.getMeta(VOICE_KEY))[bookId] ?? {};
}

// Writes are read-change-write, so they run one by one.
let queue: Promise<unknown> = Promise.resolve();

export function saveBookVoice(bookId: string, voice: BookVoice): Promise<void> {
  const work = async () => {
    const all = parseVoices(await api.project.getMeta(VOICE_KEY));
    const clean = cleanVoice(voice);
    if (clean.pov || clean.tense) all[bookId] = clean;
    else delete all[bookId];
    await api.project.setMeta(VOICE_KEY, JSON.stringify(all));
  };
  const result = queue.then(work, work);
  queue = result.catch(() => {});
  return result;
}
