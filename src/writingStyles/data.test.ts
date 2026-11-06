/** Checks every entry in the library, since it is the heart of this module. */

import { describe, expect, it } from 'vitest';

import { AUTHORS, TECHNIQUES } from './authors';
import { LIBRARY } from './library';
import { buildStylePrompt, CLOSING_END, CLOSING_START, countWords, PROMPT_WORD_LIMIT } from './prompt';
import { GENRES, TRAIT_FIELDS, type WritingStyle } from './types';

const REQUIRED_AUTHORS = [
  // Hard and classic SF
  'Arthur C. Clarke', 'Robert A. Heinlein', 'Isaac Asimov', 'Andy Weir', 'Neal Stephenson', 'Liu Cixin',
  'Alastair Reynolds', 'Kim Stanley Robinson', 'Vernor Vinge', 'Ray Bradbury', 'Philip K. Dick', 'William Gibson',
  'Frank Herbert', 'Ursula K. Le Guin', 'Octavia E. Butler', 'H.G. Wells', 'Jules Verne',
  // Space opera and military SF
  'David Weber', 'Iain M. Banks', 'John Scalzi', 'James S.A. Corey', 'Joe Haldeman', 'Orson Scott Card',
  'Lois McMaster Bujold', 'Martha Wells', 'Douglas Adams',
  // Thrillers
  'Tom Clancy', 'Michael Crichton', 'Clive Cussler', 'Frederick Forsyth', 'Robert Ludlum', 'Dan Brown', 'John Grisham',
  'Lee Child', 'James Patterson', 'Gillian Flynn', 'Stieg Larsson', 'Dean Koontz',
  // Fantasy
  'J.R.R. Tolkien', 'George R.R. Martin', 'Brandon Sanderson', 'Robert Jordan', 'Robin Hobb', 'Patrick Rothfuss',
  'Joe Abercrombie', 'Terry Pratchett', 'Neil Gaiman', 'Steven Erikson', 'N.K. Jemisin', 'Andrzej Sapkowski', 'Jim Butcher',
  // Young adult and children's
  'J.K. Rowling', 'Rick Riordan', 'Suzanne Collins', 'Philip Pullman', 'Leigh Bardugo', 'Sarah J. Maas', 'Roald Dahl',
  'C.S. Lewis', 'Stephenie Meyer',
  // Horror and gothic
  'Stephen King', 'H.P. Lovecraft', 'Edgar Allan Poe', 'Shirley Jackson', 'Clive Barker', 'Anne Rice', 'Mary Shelley', 'Bram Stoker',
  // Crime and mystery
  'Agatha Christie', 'Raymond Chandler', 'Dashiell Hammett', 'Arthur Conan Doyle', 'Michael Connelly', 'Ian Rankin',
  'Tana French', 'Elmore Leonard',
  // Literary and classics
  'Ernest Hemingway', 'Cormac McCarthy', 'Jane Austen', 'Charles Dickens', 'Virginia Woolf', 'William Faulkner',
  'F. Scott Fitzgerald', 'Toni Morrison', 'Margaret Atwood', 'Haruki Murakami', 'John Steinbeck', 'George Orwell',
  'Kurt Vonnegut', 'J.D. Salinger', 'Jack Kerouac', 'Gabriel García Márquez', 'Vladimir Nabokov', 'Kazuo Ishiguro',
  'Leo Tolstoy', 'Fyodor Dostoevsky', 'Herman Melville', 'Mark Twain', 'Harper Lee', 'David Foster Wallace', 'Donna Tartt',
  // Romance and historical
  'Nora Roberts', 'Colleen Hoover', 'Diana Gabaldon', 'Julia Quinn', 'Bernard Cornwell', 'Hilary Mantel', "Patrick O'Brian",
  'Ken Follett', 'Georgette Heyer',
];

const REQUIRED_TECHNIQUES = [
  'deep third person', 'first-person retrospective', 'omniscient narrator', 'unreliable narrator', 'hardboiled',
  'minimalist', 'lyrical', 'cozy', 'cinematic', 'epistolary', 'stream of consciousness', 'present-tense urgency',
  'grimdark', 'comedy of manners', 'fairy-tale voice', 'technical realism', 'gallows humor', 'slow-burn tension',
  'multi-pov ensemble',
];

/** Things from the books themselves. Only titles may come from an author's work. */
const FROM_THE_BOOKS = [
  'Jack Ryan', 'Harry Potter', 'Hogwarts', 'Muggle', 'Dumbledore', 'Frodo', 'Gandalf', 'Middle-earth', 'Hobbit', 'Westeros',
  'Lannister', 'Stark', 'Reacher', 'Bosch', 'Marlowe', 'Sam Spade', 'Sherlock', 'Holmes', 'Watson', 'Poirot', 'Marple',
  'Rebus', 'Atreides', 'Arrakis', 'Bene Gesserit', 'Mentat', 'Foundation', 'Seldon', 'Ansible', 'Discworld', 'Ankh-Morpork',
  'Vimes', 'Murderbot', 'Ender', 'Vorkosigan', 'Rocinante', 'Culture Mind', 'Dracula', 'Cthulhu', 'Lisbeth', 'Mockingjay',
  'Katniss', 'Tarkin', 'Nadsat', 'Winston Smith', 'Big Brother', 'Doublethink', 'Newspeak', 'Holden', 'Gatsby', 'Humbert',
  'Ishmael', 'Ahab', 'Scout Finch', 'Atticus', 'Severian', 'Kvothe', 'Geralt', 'Witcher', 'Dresden', 'Malazan', 'Mistborn',
  'Allomancy', 'Darrow', 'Hari ', 'So it goes', 'Reacher said nothing', 'Don\'t panic',
];

function proseOf(style: WritingStyle): string[] {
  return [style.summary, ...Object.values(style.traits)];
}

function traitText(style: WritingStyle): string {
  return Object.values(style.traits).join(' ');
}

function shingles(text: string, size = 3): Set<string> {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + size <= words.length; i += 1) out.add(words.slice(i, i + size).join(' '));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / (a.size + b.size - shared || 1);
}

const validGenres = new Set<string>(GENRES.map((g) => g.id));

describe('library data', () => {
  it('has enough of everything, including every required author and technique', () => {
    expect(AUTHORS.length).toBeGreaterThanOrEqual(100);
    expect(TECHNIQUES.length).toBeGreaterThanOrEqual(20);
    expect(LIBRARY.length).toBeGreaterThanOrEqual(130);
    const names = new Set(AUTHORS.map((a) => a.name));
    expect(REQUIRED_AUTHORS.filter((name) => !names.has(name))).toEqual([]);
    const techniques = TECHNIQUES.map((t) => t.name.toLowerCase());
    expect(REQUIRED_TECHNIQUES.filter((name) => !techniques.some((t) => t.includes(name.replace('-pov', ''))) && !techniques.includes(name))).toEqual([]);
  });

  it('has unique ids and names', () => {
    const ids = LIBRARY.map((s) => s.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    const names = LIBRARY.map((s) => s.name);
    expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([]);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it.each(LIBRARY.map((s) => [s.name, s] as const))('%s has complete, usable fields', (_name, style) => {
    expect(style.genres.length).toBeGreaterThan(0);
    for (const genre of style.genres) expect(validGenres).toContain(genre);
    expect(new Set(style.genres).size).toBe(style.genres.length);

    const sentences = style.summary.split(/(?<=[.!?])\s+(?=[A-Z])/).length;
    expect(sentences, 'summary sentences').toBeGreaterThanOrEqual(2);
    expect(sentences, 'summary sentences').toBeLessThanOrEqual(5);
    expect(countWords(style.summary), 'summary words').toBeGreaterThanOrEqual(25);

    for (const { key } of TRAIT_FIELDS) {
      const text = style.traits[key];
      expect(typeof text, key).toBe('string');
      expect(countWords(text), `${key} words`).toBeGreaterThanOrEqual(7);
      expect(text.trim(), key).toBe(text);
      expect(text, key).toMatch(/[.!?]$/);
    }

    if (style.kind === 'author') {
      expect(style.knownFor.length).toBeGreaterThanOrEqual(2);
      expect(style.knownFor.length).toBeLessThanOrEqual(3);
      for (const title of style.knownFor) expect(title.trim().length).toBeGreaterThan(0);
    } else {
      expect('knownFor' in style).toBe(false);
    }
  });

  it('has no links and nothing that looks like a quoted passage', () => {
    const problems: string[] = [];
    for (const style of LIBRARY) {
      for (const text of proseOf(style)) {
        if (/https?:|www\.|\.com\b/i.test(text)) problems.push(`${style.name}: link in "${text}"`);
        for (const quoted of text.match(/["“][^"”]*["”]/g) ?? []) {
          if (countWords(quoted) > 3) problems.push(`${style.name}: quoted passage ${quoted}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('takes only titles from the books, and keeps titles out of the instructions', () => {
    const problems: string[] = [];
    for (const style of LIBRARY) {
      const prose = proseOf(style).join(' ');
      for (const term of FROM_THE_BOOKS) {
        const pattern = new RegExp(`\\b${term.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
        // A name or title of the author's own may legitimately hold such a word.
        if (pattern.test(prose) && !pattern.test(style.name)) problems.push(`${style.name}: ${term.trim()}`);
      }
      if (style.kind === 'author') {
        for (const title of style.knownFor) {
          // Very short titles such as It are ordinary words.
          if (title.length >= 5 && traitText(style).includes(title)) problems.push(`${style.name}: title ${title} in a trait`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('does not reuse the same text across entries', () => {
    const whole = LIBRARY.map((style) => ({ style, set: shingles(traitText(style)) }));
    const problems: string[] = [];
    for (let i = 0; i < whole.length; i += 1) {
      for (let j = i + 1; j < whole.length; j += 1) {
        const score = jaccard(whole[i].set, whole[j].set);
        if (score > 0.12) problems.push(`${whole[i].style.name} and ${whole[j].style.name}: ${score.toFixed(2)}`);
      }
    }
    expect(problems).toEqual([]);

    for (const { key } of TRAIT_FIELDS) {
      const sets = LIBRARY.map((style) => ({ style, set: shingles(style.traits[key], 2) }));
      for (let i = 0; i < sets.length; i += 1) {
        for (let j = i + 1; j < sets.length; j += 1) {
          const score = jaccard(sets[i].set, sets[j].set);
          if (score > 0.4) problems.push(`${key}: ${sets[i].style.name} and ${sets[j].style.name}: ${score.toFixed(2)}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('buildStylePrompt over the library', () => {
  it.each(LIBRARY.map((s) => [s.name, s] as const))('%s has the full structure and fits the limit', (_name, style) => {
    const prompt = buildStylePrompt(style);
    expect(countWords(prompt), 'words').toBeLessThanOrEqual(PROMPT_WORD_LIMIT);
    expect(prompt).toContain(style.name);
    let last = -1;
    for (const { key, label } of TRAIT_FIELDS) {
      const at = prompt.indexOf(`${label}: ${style.traits[key]}`);
      expect(at, label).toBeGreaterThan(last);
      last = at;
    }
    expect(prompt.endsWith(CLOSING_END)).toBe(true);
    expect(prompt).toContain(CLOSING_START);
    expect(prompt).toMatch(/Do not reuse/);
    if (style.kind === 'author') {
      expect(prompt).toMatch(/never name the author in the story text/);
      for (const title of style.knownFor) {
        if (title.length >= 5) expect(prompt).not.toContain(title);
      }
    }
  });
});
