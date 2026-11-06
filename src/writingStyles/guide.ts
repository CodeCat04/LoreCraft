/** The writer's own rules for a project or book, and how they read to the AI. */

import { countWords } from './prompt';
import type { GuideField, StyleGuide } from './types';

export interface GuideFieldInfo {
  key: GuideField;
  label: string;
  hint?: string;
  control: 'choice' | 'text' | 'long';
  /** Common answers for a `choice`. The writer can also type their own. */
  options?: string[];
}

export const GUIDE_FIELDS: GuideFieldInfo[] = [
  { key: 'tense', label: 'Tense', control: 'choice', options: ['Past tense', 'Present tense', 'Future tense'] },
  {
    key: 'pov',
    label: 'Point of view',
    control: 'choice',
    options: [
      'First person',
      'Second person',
      'Third person limited',
      'Third person omniscient',
      'Multiple viewpoints, one per chapter',
    ],
  },
  {
    key: 'distance',
    label: 'Narrative distance',
    control: 'choice',
    options: [
      'Deep, right inside one mind',
      'Close, with some narration of its own',
      'Moderate, like a storyteller nearby',
      'Distant, like a historian',
    ],
  },
  {
    key: 'spelling',
    label: 'Spelling',
    control: 'choice',
    options: ['US English', 'UK English', 'Canadian English', 'Australian English', 'Irish English', 'Indian English'],
  },
  {
    key: 'dialogue',
    label: 'Dialogue punctuation',
    control: 'choice',
    options: [
      'Double quotation marks',
      'Single quotation marks, double inside',
      'Em dashes to open speech',
      'No quotation marks',
    ],
  },
  { key: 'content', label: 'Content and tone', hint: 'For example how much violence or swearing, or how dark it gets.', control: 'long' },
  { key: 'voice', label: 'Voice notes', hint: 'Anything else about how this book should sound.', control: 'long' },
  { key: 'avoid', label: 'Words and phrases to avoid', hint: 'One per line, or separated by commas.', control: 'long' },
  { key: 'prefer', label: 'Words and phrases to prefer', hint: 'One per line, or separated by commas.', control: 'long' },
  { key: 'sample', label: 'Sample of your prose to match', hint: 'A short passage in your own voice. Only the first 300 words are sent.', control: 'long' },
];

export const SAMPLE_WORD_LIMIT = 300;

/** The book's filled-in fields replace the project's. Empty fields add nothing. */
export function mergeGuides(project: StyleGuide = {}, book: StyleGuide = {}): StyleGuide {
  const merged: StyleGuide = {};
  for (const { key } of GUIDE_FIELDS) {
    const value = (book[key]?.trim() || project[key]?.trim()) ?? '';
    if (value) merged[key] = value;
  }
  return merged;
}

export function hasGuide(guide: StyleGuide | undefined): boolean {
  return !!guide && GUIDE_FIELDS.some(({ key }) => guide[key]?.trim());
}

/** One word or phrase per line or comma, in order, without repeats. */
export function parseWordList(text: string | undefined): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const raw of (text ?? '').split(/[\n,]/)) {
    const word = raw.trim();
    const key = word.toLowerCase();
    if (word && !seen.has(key)) {
      seen.add(key);
      words.push(word);
    }
  }
  return words;
}

function firstWords(text: string, limit: number): string {
  if (countWords(text) <= limit) return text;
  const pattern = new RegExp(`^(?:\\s*\\S+){${limit}}`);
  return pattern.exec(text)?.[0] ?? text;
}

/**
 * The rules as plain instructions, in one fixed order, or an empty string if there are none.
 * It takes the sample from the writer, so it fences it as data rather than as instructions.
 */
export function formatGuide(guide: StyleGuide): string {
  const lines: string[] = [];
  const add = (label: string, value: string | undefined) => {
    const text = value?.trim();
    if (text) lines.push(`${label}: ${text}`);
  };
  add('Tense', guide.tense);
  add('Point of view', guide.pov);
  add('Narrative distance', guide.distance);
  add('Spelling', guide.spelling);
  add('Dialogue punctuation', guide.dialogue);
  add('Content and tone', guide.content);
  add('Voice', guide.voice);
  const avoid = parseWordList(guide.avoid);
  if (avoid.length > 0) lines.push(`Never use these words or phrases: ${avoid.join('; ')}`);
  const prefer = parseWordList(guide.prefer);
  if (prefer.length > 0) lines.push(`Prefer these words or phrases: ${prefer.join('; ')}`);
  const sample = guide.sample?.trim();
  if (sample) {
    const body = firstWords(sample, SAMPLE_WORD_LIMIT).replace(/<\/?writer_sample>/gi, '');
    lines.push(`Match the rhythm and voice of this sample of the writer's own prose. Do not reuse its content.\n<writer_sample>\n${body}\n</writer_sample>`);
  }
  return lines.join('\n');
}
