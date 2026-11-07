import { describe, expect, it } from 'vitest';

import { extractJson } from '../ai/json';
import { CATEGORIES, categoryById, ideaPrompt, inboxText, insertAfter, parseIdeas, withoutRepeats, type IdeaCard } from './ideas';

const card = (id: string, title: string): IdeaCard => ({ id, title, detail: '', category: 'names' });

describe('brainstorm ideas', () => {
  it('reads the asked-for shape', () => {
    expect(parseIdeas({ ideas: [{ title: 'Arven Tallis', detail: 'A ferryman.' }] })).toEqual([{ title: 'Arven Tallis', detail: 'A ferryman.' }]);
  });

  it('reads what small models send instead', () => {
    // A bare list of strings, with list markers and dashes.
    expect(parseIdeas(['1. Arven — a ferryman', '- "Mira": a smith', 'Oskar'])).toEqual([
      { title: 'Arven', detail: 'a ferryman' },
      { title: 'Mira', detail: 'a smith' },
      { title: 'Oskar', detail: '' },
    ]);
    // Other key names, and the list under another key.
    expect(parseIdeas({ suggestions: [{ name: 'Saltmere', description: 'A drowned town.' }] })).toEqual([{ title: 'Saltmere', detail: 'A drowned town.' }]);
    expect(parseIdeas({ whatever: [{ idea: 'The map is a lie', why: 'Drawn by the enemy.' }] })).toEqual([
      { title: 'The map is a lie', detail: 'Drawn by the enemy.' },
    ]);
    // Numbers in a title are kept.
    expect(parseIdeas(['1984 Harbour Street'])[0].title).toBe('1984 Harbour Street');
  });

  it('works with the loose JSON reader on a messy reply', () => {
    const reply = 'Sure! Here you go:\n```json\n{"ideas": [{"title": "Arven", "detail": "A ferryman.",},\n{"title": "Mira", "detail": "A sm';
    const extracted = extractJson(reply);
    expect(extracted).not.toBeNull();
    expect(parseIdeas(extracted!.value).map((idea) => idea.title)).toEqual(['Arven', 'Mira']);
  });

  it('drops repeats and blanks, and refuses a reply with no ideas', () => {
    expect(parseIdeas([{ title: 'Arven' }, { title: 'arven' }, { title: '' }, 3, null]).map((i) => i.title)).toEqual(['Arven', '3']);
    expect(() => parseIdeas({ ideas: [] })).toThrow(/no ideas/);
    expect(() => parseIdeas('just words')).toThrow(/ideas/);
  });

  it('caps the length of a card', () => {
    const [idea] = parseIdeas([{ title: 'x'.repeat(500), detail: 'y'.repeat(1000) }]);
    expect(idea.title.length).toBeLessThanOrEqual(160);
    expect(idea.detail.length).toBeLessThanOrEqual(400);
  });

  it('asks for the category, the note, the focus and more like a card', () => {
    const prompt = ideaPrompt({ category: 'places', note: 'cold coast', focusTitle: 'The Vale', existing: ['Saltmere'], like: { title: 'Gullhaven', detail: 'A port.' } });
    expect(prompt).toContain('8 names for places');
    expect(prompt).toContain('cold coast');
    expect(prompt).toContain('"The Vale"');
    expect(prompt).toContain('Gullhaven: A port.');
    expect(prompt).toContain('do not repeat: Saltmere');
    expect(ideaPrompt({ category: 'custom', note: 'Why is the moon red?', existing: [] })).toContain('answer this: Why is the moon red?');
  });

  it('only names, places and objects make pages', () => {
    expect(CATEGORIES.filter((c) => c.pageType).map((c) => [c.id, c.pageType])).toEqual([
      ['names', 'character'],
      ['places', 'place'],
      ['objects', 'item'],
    ]);
    expect(categoryById('unknown').id).toBe('names');
  });

  it('keeps the idea first in the Inbox, with its category after', () => {
    expect(inboxText({ title: 'Arven', detail: 'A ferryman.', category: 'names' })).toBe('Arven\nA ferryman.\nBrainstorm: Character names');
  });

  it('puts more ideas after the card they came from', () => {
    const board = [card('a', 'A'), card('b', 'B')];
    expect(insertAfter(board, 'a', [card('c', 'C')]).map((c) => c.id)).toEqual(['a', 'c', 'b']);
    expect(insertAfter(board, null, [card('c', 'C')]).map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(withoutRepeats([{ title: 'b' }, { title: 'D' }], board)).toEqual([{ title: 'D' }]);
  });
});
