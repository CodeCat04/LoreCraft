/** The built-in styles, how they sort, and how they are searched. */

import { AUTHORS, TECHNIQUES } from './authors';
import { genreName, type WritingStyle } from './types';

export const LIBRARY: WritingStyle[] = [...AUTHORS, ...TECHNIQUES];

const BY_ID = new Map<string, WritingStyle>(LIBRARY.map((style) => [style.id, style]));

export function builtInStyle(id: string): WritingStyle | undefined {
  return BY_ID.get(id);
}

/** Surnames of more than one word, or that do not come last. */
const SURNAMES: Record<string, string> = {
  'Ursula K. Le Guin': 'Le Guin',
  'John le Carré': 'le Carré',
  'Daphne du Maurier': 'du Maurier',
  'Gabriel García Márquez': 'García Márquez',
  'Arthur Conan Doyle': 'Conan Doyle',
  'Liu Cixin': 'Liu',
  'James S.A. Corey': 'Corey',
  'Lois McMaster Bujold': 'Bujold',
};

/** Accents and case do not count in search or sort, so Garcia finds García. */
export function plainText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Authors sort by surname, as in a bookshop. Everything else sorts by name. */
export function sortName(style: WritingStyle): string {
  const name = style.kind === 'author' ? (SURNAMES[style.name] ?? style.name.split(' ').pop() ?? style.name) : style.name;
  return plainText(name);
}

export function compareStyles(a: WritingStyle, b: WritingStyle): number {
  return sortName(a).localeCompare(sortName(b)) || a.id.localeCompare(b.id);
}

const haystacks = new WeakMap<WritingStyle, string>();

function haystack(style: WritingStyle): string {
  let text = haystacks.get(style);
  if (text === undefined) {
    text = plainText(
      [
        style.name,
        ...style.genres.map(genreName),
        style.kind === 'author' ? style.knownFor.join(' ') : '',
        style.summary,
        ...Object.values(style.traits),
      ].join(' '),
    );
    haystacks.set(style, text);
  }
  return text;
}

/** Every word must appear somewhere in the style's name, genres, titles or text. */
export function matchesStyle(style: WritingStyle, query: string): boolean {
  const words = plainText(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = haystack(style);
  return words.every((word) => text.includes(word));
}

/** Filters by the query, with matches on the name first. Stable otherwise. */
export function searchStyles(styles: WritingStyle[], query: string): WritingStyle[] {
  const matching = styles.filter((style) => matchesStyle(style, query));
  const words = plainText(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return matching;
  const inName = (style: WritingStyle) => {
    const name = plainText(style.name);
    return words.every((word) => name.includes(word));
  };
  return [...matching.filter(inName), ...matching.filter((style) => !inName(style))];
}
