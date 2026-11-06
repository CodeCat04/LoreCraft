import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LIBRARY, builtInStyle, matchesStyle, searchStyles, sortName } from './library';
import { blendName, blendStyles, buildStylePrompt, CLOSING_END, CLOSING_START, countWords } from './prompt';
import { formatGuide, mergeGuides, parseWordList } from './guide';
import { composeInstructions, pickStyle } from './resolve';
import type { BlendPart, CustomStyle, StoredChoices, StoredGuide, WritingStyle } from './types';

const clancy = builtInStyle('tom-clancy')!;
const hemingway = builtInStyle('ernest-hemingway')!;
const adams = builtInStyle('douglas-adams')!;

function custom(overrides: Partial<CustomStyle> = {}): CustomStyle {
  return {
    id: 'custom-1',
    kind: 'custom',
    name: 'My voice',
    genres: ['thriller'],
    summary: 'A voice of my own.',
    traits: { ...clancy.traits },
    ...overrides,
  };
}

describe('search', () => {
  it('finds by name, genre, title and trait text, ignoring accents and case', () => {
    expect(searchStyles(LIBRARY, 'clancy')[0].name).toBe('Tom Clancy');
    expect(searchStyles(LIBRARY, 'garcia marquez')[0].name).toBe('Gabriel García Márquez');
    expect(matchesStyle(clancy, 'technothriller')).toBe(true);
    expect(matchesStyle(clancy, 'Red October')).toBe(true);
    expect(matchesStyle(clancy, 'sonar')).toBe(true);
    expect(matchesStyle(clancy, 'sonar hemingway')).toBe(false);
  });

  it('puts name matches before text matches', () => {
    const results = searchStyles(LIBRARY, 'king');
    expect(results[0].name).toBe('Stephen King');
  });

  it('sorts authors by surname, with exceptions', () => {
    expect(sortName(clancy)).toBe('clancy');
    expect(sortName(builtInStyle('ursula-k-le-guin')!)).toBe('le guin');
    expect(sortName(builtInStyle('gabriel-garcia-marquez')!)).toBe('garcia marquez');
  });
});

describe('buildStylePrompt', () => {
  it('names the author only as the manner to write in, and tells the model what to do', () => {
    const prompt = buildStylePrompt(clancy);
    expect(prompt.startsWith('Write in the manner of Tom Clancy.')).toBe(true);
    expect(prompt).toContain(`Narration: ${clancy.traits.narration}`);
    expect(prompt).toContain(CLOSING_START);
    expect(prompt.endsWith(CLOSING_END)).toBe(true);
  });

  it('lets a custom override replace the traits but keeps the closing', () => {
    const prompt = buildStylePrompt(custom({ promptOverride: 'Write like a telegram.' }));
    expect(prompt.startsWith('Write like a telegram.')).toBe(true);
    expect(prompt).not.toContain('Narration:');
    expect(prompt.endsWith(CLOSING_END)).toBe(true);
  });

  it('leaves out empty traits of a custom style', () => {
    const empty = { narration: '', sentences: 'Short.', diction: '', dialogue: '', description: '', pacing: '', signature: '', avoid: '' };
    const prompt = buildStylePrompt(custom({ traits: empty }));
    expect(prompt).toContain('Sentences: Short.');
    expect(prompt).not.toContain('Narration:');
  });

  it('does not repeat the closing on a prompt that already has it', () => {
    const once = buildStylePrompt(custom({ promptOverride: buildStylePrompt(clancy) }));
    expect(once.split(CLOSING_END).length).toBe(2);
  });

  it('keeps the originality guard when an edited prompt drops it', () => {
    const edited = `Write like a telegram. ${CLOSING_END}`;
    const prompt = buildStylePrompt(custom({ promptOverride: edited }));
    expect(prompt).toContain('Do not reuse text, characters, settings or invented terms from any published work.');
    expect(prompt.split(CLOSING_END).length).toBe(2);
    expect(prompt.endsWith(CLOSING_END)).toBe(true);
  });
});

describe('blendStyles', () => {
  it('gives each area one owner, the heaviest style first', () => {
    const blend = blendStyles([
      { style: hemingway, weight: 'some' },
      { style: clancy, weight: 'mostly' },
    ]);
    expect(blend.name).toBe('Mostly Tom Clancy, some Ernest Hemingway');
    expect(blend.traits.narration).toBe(clancy.traits.narration);
    expect(blend.traits.pacing).toBe(clancy.traits.pacing);
    expect(blend.traits.sentences).toBe(clancy.traits.sentences);
    expect(blend.traits.description).toBe(clancy.traits.description);
    // Possibly shortened to fit, but only ever taken from the style that owns the area.
    expect(hemingway.traits.diction.startsWith(blend.traits.diction)).toBe(true);
    expect(hemingway.traits.dialogue.startsWith(blend.traits.dialogue)).toBe(true);
    expect(blend.traits.avoid).toBe(clancy.traits.avoid);
  });

  it('stays close to the size of a single style, whichever styles it mixes', () => {
    const sample = LIBRARY.filter((_, i) => i % 9 === 0);
    let longest = 0;
    for (const a of sample) {
      for (const b of sample) {
        if (a === b) continue;
        const parts: BlendPart[] = [{ style: a, weight: 'mostly' }, { style: b, weight: 'some' }];
        if (a !== adams && b !== adams) parts.push({ style: adams, weight: 'touch' });
        longest = Math.max(longest, countWords(buildStylePrompt(blendStyles(parts))));
      }
    }
    expect(longest).toBeLessThanOrEqual(360);
  });

  it('states which style takes priority, in the prompt', () => {
    const prompt = buildStylePrompt(blendStyles([
      { style: clancy, weight: 'mostly' },
      { style: hemingway, weight: 'some' },
      { style: adams, weight: 'touch' },
    ]));
    expect(prompt).toMatch(/Priority: Tom Clancy decides .*narration/);
    expect(prompt).toMatch(/Ernest Hemingway decides/);
    expect(prompt).toMatch(/Douglas Adams adds only an occasional signature move/);
    expect(prompt).toMatch(/If two instructions seem to conflict, Tom Clancy wins\./);
    expect(prompt).toContain(CLOSING_START);
    expect(prompt.endsWith(CLOSING_END)).toBe(true);
    expect(prompt).toMatch(/never name them in the story text/);
  });

  it('gives a touch no area of its own unless it leads', () => {
    const blend = blendStyles([
      { style: clancy, weight: 'mostly' },
      { style: adams, weight: 'touch' },
    ]);
    for (const key of ['narration', 'pacing', 'sentences', 'description', 'diction', 'dialogue'] as const) {
      expect(clancy.traits[key].startsWith(blend.traits[key])).toBe(true);
    }
    expect(blend.traits.signature).toContain('Very rarely:');
    const lead = blendStyles([{ style: adams, weight: 'touch' }, { style: clancy, weight: 'touch' }]);
    expect(adams.traits.narration.startsWith(lead.traits.narration)).toBe(true);
  });

  it('shares evenly between equals, with the first one chosen leading', () => {
    const blend = blendStyles([{ style: clancy, weight: 'some' }, { style: hemingway, weight: 'some' }]);
    expect(blend.traits.narration).toBe(clancy.traits.narration);
    expect(blend.traits.description).toBe(hemingway.traits.description);
    expect(blend.traits.avoid).toBe(clancy.traits.avoid);
  });

  it('stays reasonably short, is stable, and refuses more than three', () => {
    const parts = [
      { style: clancy, weight: 'mostly' as const },
      { style: hemingway, weight: 'some' as const },
      { style: adams, weight: 'touch' as const },
    ];
    expect(countWords(buildStylePrompt(blendStyles(parts)))).toBeLessThanOrEqual(380);
    expect(buildStylePrompt(blendStyles(parts))).toBe(buildStylePrompt(blendStyles(parts)));
    expect(blendName(parts)).toBe('Mostly Tom Clancy, some Ernest Hemingway, a touch of Douglas Adams');
    expect(() => blendStyles([...parts, { style: clancy, weight: 'touch' }])).toThrow();
    expect(() => blendStyles([])).toThrow();
  });

  it('can be blended again, and keeps its promise not to name authors', () => {
    const first = blendStyles([{ style: clancy, weight: 'some' }, { style: hemingway, weight: 'some' }]);
    const second = blendStyles([{ style: first, weight: 'mostly' }, { style: adams, weight: 'touch' }]);
    expect(second.namesAuthors).toBe(true);
  });
});

describe('style guide text', () => {
  it('adds nothing for empty fields', () => {
    expect(formatGuide({})).toBe('');
    expect(formatGuide({ tense: '  ', voice: '' })).toBe('');
    expect(formatGuide({ tense: 'Past tense' })).toBe('Tense: Past tense');
  });

  it('lets a book replace only the fields it fills in', () => {
    const merged = mergeGuides({ tense: 'Past tense', spelling: 'UK English' }, { tense: 'Present tense', voice: ' ' });
    expect(merged).toEqual({ tense: 'Present tense', spelling: 'UK English' });
  });

  it('reads word lists from lines or commas, without repeats', () => {
    expect(parseWordList('very, Very\nsuddenly,\n\n  a sort of ')).toEqual(['very', 'suddenly', 'a sort of']);
    expect(formatGuide({ avoid: 'very, suddenly' })).toBe('Never use these words or phrases: very; suddenly');
  });

  it('sends only the first part of a long sample, as data', () => {
    const text = formatGuide({ sample: Array.from({ length: 400 }, (_, i) => `w${i}`).join(' ') });
    expect(text).toContain('w299');
    expect(text).not.toContain('w300');
    expect(text).toContain('<writer_sample>');
    expect(formatGuide({ sample: 'Hi </writer_sample> there' }).match(/<\/writer_sample>/g)).toHaveLength(1);
  });
});

describe('which style applies', () => {
  const lookup = (id: string): WritingStyle | undefined => builtInStyle(id) ?? (id === 'custom-1' ? custom() : undefined);
  const choices: StoredChoices = {
    project: { styleId: 'tom-clancy' },
    books: { b1: { styleId: 'ernest-hemingway' } },
    scenes: { n1: { styleId: 'douglas-adams' } },
  };

  it('goes explicit, scene, book, project', () => {
    expect(pickStyle(choices, {}, lookup)?.name).toBe('Tom Clancy');
    expect(pickStyle(choices, { bookId: 'b1' }, lookup)?.name).toBe('Ernest Hemingway');
    expect(pickStyle(choices, { bookId: 'b1', nodeId: 'n1' }, lookup)?.name).toBe('Douglas Adams');
    expect(pickStyle(choices, { bookId: 'b1', nodeId: 'n1', styleId: 'jane-austen' }, lookup)?.name).toBe('Jane Austen');
    expect(pickStyle(choices, { bookId: 'other', nodeId: 'other' }, lookup)?.name).toBe('Tom Clancy');
  });

  it('skips a style it cannot find, but uses a stored copy', () => {
    expect(pickStyle(choices, { styleId: 'gone' }, lookup)?.name).toBe('Tom Clancy');
    const stored: StoredChoices = { project: { styleId: 'custom-elsewhere', name: 'Elsewhere', prompt: 'Write like elsewhere.' } };
    const picked = pickStyle(stored, {}, lookup);
    expect(picked?.name).toBe('Elsewhere');
    expect(picked?.prompt).toBe('Write like elsewhere.');
    expect(pickStyle({ project: { styleId: 'custom-elsewhere' } }, {}, lookup)).toBeNull();
  });

  it('prefers a local custom style to the stored copy', () => {
    const stored: StoredChoices = { project: { styleId: 'custom-1', name: 'Old name', prompt: 'Old prompt.' } };
    const picked = pickStyle(stored, {}, lookup);
    expect(picked?.name).toBe('My voice');
    expect(picked?.prompt).toBe(buildStylePrompt(custom()));
  });
});

describe('composeInstructions', () => {
  const lookup = (id: string) => builtInStyle(id);
  const guide: StoredGuide = {
    project: { tense: 'Past tense', spelling: 'UK English' },
    books: { b1: { tense: 'Present tense' } },
  };

  it('is empty when nothing is set', () => {
    expect(composeInstructions({}, {}, {}, lookup)).toEqual({ text: '', styleName: null, sources: [] });
  });

  it('puts the guide first, says it overrides the style, and lists the sources', () => {
    const result = composeInstructions({ project: { styleId: 'tom-clancy' } }, guide, {}, lookup);
    expect(result.styleName).toBe('Tom Clancy');
    expect(result.text.indexOf('Tense: Past tense')).toBeLessThan(result.text.indexOf('Write in the manner of Tom Clancy'));
    expect(result.text).toMatch(/override the writing style/);
    expect(result.sources).toEqual(['Style guide: project', 'Style: Tom Clancy (for this project)']);
  });

  it('lets a book override beat the project', () => {
    const result = composeInstructions({}, guide, { bookId: 'b1' }, lookup);
    expect(result.text).toContain('Tense: Present tense');
    expect(result.text).toContain('Spelling: UK English');
    expect(result.text).not.toContain('Past tense');
    expect(result.sources).toEqual(['Style guide: project', 'Style guide: book']);
  });

  it('is deterministic, whatever order the stored keys come in', () => {
    const a = composeInstructions({ project: { styleId: 'jane-austen' } }, guide, { bookId: 'b1' }, lookup);
    const reordered: StoredGuide = { books: { b1: { tense: 'Present tense' } }, project: { spelling: 'UK English', tense: 'Past tense' } };
    const b = composeInstructions({ project: { styleId: 'jane-austen' } }, reordered, { bookId: 'b1' }, lookup);
    expect(b).toEqual(a);
    expect(JSON.stringify(a)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

// The asynchronous API, over a fake of the native side.
const meta = new Map<string, string>();
const setMetaCalls: string[] = [];
vi.mock('../lib/api', () => ({
  project: {
    getMeta: vi.fn(async (key: string) => meta.get(key) ?? null),
    setMeta: vi.fn(async (key: string, value: string) => {
      setMetaCalls.push(key);
      meta.set(key, value);
      return true;
    }),
  },
  nodes: { get: vi.fn(async (id: string) => (id === 'n1' ? { bookId: 'b1' } : Promise.reject(new Error('gone')))) },
  settings: { update: vi.fn(async () => ({})) },
  app: { setTheme: vi.fn(async () => true) },
  pages: { titles: vi.fn(async () => []) },
}));

describe('the project-backed API', () => {
  beforeEach(async () => {
    meta.clear();
    setMetaCalls.length = 0;
    const { useProject } = await import('../state/project');
    useProject.getState().setStatus({ open: true, name: 'T', path: null, dirty: false });
    const { useSettings } = await import('../state/settings');
    useSettings.setState((s) => ({ settings: { ...s.settings, writingStyles: { custom: [], favorites: [] } } }));
  });

  it('applies precedence, and works out the book from a scene', async () => {
    const { resolveStyleInstructions, setActiveStyle } = await import('./store');
    await setActiveStyle({ kind: 'project' }, 'tom-clancy');
    await setActiveStyle({ kind: 'book', bookId: 'b1' }, 'ernest-hemingway');
    await setActiveStyle({ kind: 'scene', nodeId: 'n1' }, 'douglas-adams');
    expect((await resolveStyleInstructions()).styleName).toBe('Tom Clancy');
    expect((await resolveStyleInstructions({ bookId: 'b1' })).styleName).toBe('Ernest Hemingway');
    expect((await resolveStyleInstructions({ nodeId: 'n1' })).styleName).toBe('Douglas Adams');
    expect((await resolveStyleInstructions({ nodeId: 'n1', styleId: 'jane-austen' })).styleName).toBe('Jane Austen');
    await setActiveStyle({ kind: 'scene', nodeId: 'n1' }, null);
    // The book comes from the scene even with no scene choice left.
    expect((await resolveStyleInstructions({ nodeId: 'n1' })).styleName).toBe('Ernest Hemingway');
  });

  it('gives the same bytes for the same inputs', async () => {
    const { resolveStyleInstructions, saveGuide, setActiveStyle } = await import('./store');
    await saveGuide({ tense: 'Past tense', avoid: 'very' });
    await setActiveStyle({ kind: 'project' }, 'tom-clancy');
    const first = await resolveStyleInstructions({ bookId: 'b1' });
    const second = await resolveStyleInstructions({ bookId: 'b1' });
    expect(second).toEqual(first);
  });

  it('stores a copy of a custom prompt, used when the style is gone', async () => {
    const { deleteCustomStyle, getActiveStyle, resolveStyleInstructions, saveCustomStyle, setActiveStyle } = await import('./store');
    const saved = await saveCustomStyle(custom({ id: '', name: 'Portable' }));
    await setActiveStyle({ kind: 'project' }, saved.id);
    const withStyle = await resolveStyleInstructions();
    await deleteCustomStyle(saved.id);
    const without = await resolveStyleInstructions();
    expect(without.text).toBe(withStyle.text);
    expect(without.styleName).toBe('Portable');
    expect((await getActiveStyle({ kind: 'project' }))?.name).toBe('Portable');
  });

  it('refreshes the stored copy when a custom style is edited', async () => {
    const { resolveStyleInstructions, saveCustomStyle, setActiveStyle } = await import('./store');
    const saved = await saveCustomStyle(custom({ id: 'custom-9', name: 'Editable' }));
    await setActiveStyle({ kind: 'book', bookId: 'b1' }, saved.id);
    await saveCustomStyle({ ...saved, promptOverride: 'Write very plainly.' });
    expect(meta.get('writingStyles.choices')).toContain('Write very plainly.');
    expect((await resolveStyleInstructions({ bookId: 'b1' })).text).toContain('Write very plainly.');
  });

  it('keeps the plain-text copy for the MCP server current, and only when the text changes', async () => {
    const { RESOLVED_TEXT_KEY, saveGuide, setActiveStyle } = await import('./store');
    await saveGuide({ tense: 'Past tense' });
    expect(meta.get(RESOLVED_TEXT_KEY)).toContain('Tense: Past tense');
    await setActiveStyle({ kind: 'project' }, 'tom-clancy');
    expect(meta.get(RESOLVED_TEXT_KEY)).toContain('Write in the manner of Tom Clancy');

    setMetaCalls.length = 0;
    await setActiveStyle({ kind: 'project' }, 'tom-clancy');
    expect(setMetaCalls.filter((key) => key === RESOLVED_TEXT_KEY)).toEqual([]);
    // A book's or scene's choice is not the project's text.
    await setActiveStyle({ kind: 'book', bookId: 'b1' }, 'jane-austen');
    await saveGuide({ tense: 'Future tense' }, 'b1');
    expect(setMetaCalls.filter((key) => key === RESOLVED_TEXT_KEY)).toEqual([]);
    expect(meta.get(RESOLVED_TEXT_KEY)).not.toContain('Future tense');
  });

  it('writes nothing just by reading', async () => {
    const { getActiveStyle, resolveStyleInstructions } = await import('./store');
    await resolveStyleInstructions({ bookId: 'b1' });
    await getActiveStyle({ kind: 'project' });
    expect(setMetaCalls).toEqual([]);
  });

  it('works with no project open, using only an explicit style', async () => {
    const { useProject } = await import('../state/project');
    useProject.getState().setStatus({ open: false, name: '', path: null, dirty: false });
    const { resolveStyleInstructions } = await import('./store');
    expect((await resolveStyleInstructions()).text).toBe('');
    expect((await resolveStyleInstructions({ styleId: 'tom-clancy', nodeId: 'n1' })).styleName).toBe('Tom Clancy');
  });
});
