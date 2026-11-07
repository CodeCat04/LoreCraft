import { assembleContext, contextToBlocks, narrationFor, type LoreSource } from './context';
import { narrationInstruction } from './prompts';
import { cleanVoice, parseVoices, type BookVoice } from '../write/bookVoice';
import { markdownToPm } from '../editor/convert';
import type { Book, Node, NodeMeta, TitleEntry } from '../lib/types';

function scene(id: string, extra: Partial<Node> = {}): Node {
  return {
    id, bookId: 'b1', parentId: null, kind: 'scene', title: id, position: 0, status: 'draft', povPageId: null,
    locationPageId: null, synopsis: '', wordCount: 0, targetWords: 0, storyDate: '', createdAt: '', updatedAt: '',
    deletedAt: null, content: { type: 'doc', content: [] }, notes: '', ...extra,
  };
}

function lore(nodes: Node[], voices: Record<string, BookVoice>, withVoice = true): LoreSource {
  const titles: TitleEntry[] = [{ id: 'mara', title: 'Mara', pageType: 'character', status: 'canon', summary: '', aliases: [] }];
  return {
    titles: () => titles,
    page: async () => null,
    pageByTitle: async () => null,
    backlinks: async () => ({ pages: [], scenes: [] }),
    search: async () => [],
    node: async (id) => nodes.find((n) => n.id === id) ?? null,
    books: async () => [{ id: 'b1', position: 0 } as Book],
    tree: async () => nodes as NodeMeta[],
    listPages: async () => [],
    ...(withVoice ? { bookVoice: async (bookId: string) => voices[bookId] ?? {} } : {}),
  };
}

describe('narrationInstruction', () => {
  it('is empty when nothing is set', () => {
    expect(narrationInstruction({})).toBe('');
    expect(narrationInstruction(null)).toBe('');
    expect(narrationInstruction(undefined, 'Mara')).toBe('');
  });

  it('states the point of view and tense', () => {
    const text = narrationInstruction({ pov: 'first', tense: 'present' });
    expect(text).toContain('Point of view: first person.');
    expect(text).toContain('Tense: present tense.');
    expect(narrationInstruction({ tense: 'past' })).not.toContain('Point of view');
    expect(narrationInstruction({ pov: 'omniscient' })).not.toContain('Tense');
  });

  it('keeps the scene’s own point-of-view character', () => {
    expect(narrationInstruction({ pov: 'first' }, 'Mara')).toContain('first person, told by Mara');
    expect(narrationInstruction({ pov: 'close-third' }, 'Mara')).toContain('staying with Mara');
    expect(narrationInstruction({ tense: 'past' }, 'Mara')).toContain("Point of view: Mara's.");
  });
});

describe('stored voices', () => {
  it('reads old, empty and damaged values as not set', () => {
    expect(parseVoices(null)).toEqual({});
    expect(parseVoices('')).toEqual({});
    expect(parseVoices('not json')).toEqual({});
    expect(parseVoices('[1,2]')).toEqual({});
    expect(parseVoices(JSON.stringify({ b1: { pov: 'first', tense: 'future' }, b2: { pov: 'sideways' } }))).toEqual({ b1: { pov: 'first' } });
    expect(cleanVoice({ pov: 'second', tense: 'present', extra: 1 })).toEqual({ pov: 'second', tense: 'present' });
  });
});

describe('narration in the context', () => {
  const nodes = [scene('s1', { povPageId: 'mara' }), scene('s2', { bookId: 'b2' })];
  const voices: Record<string, BookVoice> = { b1: { pov: 'first', tense: 'present' } };

  it('comes from the scene’s book, with its point-of-view character', async () => {
    const text = await narrationFor({ kind: 'node', id: 's1' }, lore(nodes, voices));
    expect(text).toContain('first person, told by Mara');
    expect(text).toContain('present tense');
    expect(await narrationFor({ kind: 'node', id: 's2' }, lore(nodes, voices))).toBe('');
    expect(await narrationFor({ kind: 'page', id: 's1' }, lore(nodes, voices))).toBe('');
    expect(await narrationFor(null, lore(nodes, voices))).toBe('');
    // A source with no way to read voices, as an older test fake, simply has none.
    expect(await narrationFor({ kind: 'node', id: 's1' }, lore(nodes, voices, false))).toBe('');
  });

  it('goes with every request for a scene, in the writing style block', async () => {
    const context = await assembleContext(
      {
        budgetTokens: 20_000,
        source: { kind: 'node', id: 's1', title: 's1' },
        doc: markdownToPm('She opened the door.'),
        selections: [{ id: 'selection', title: 's1', text: 'She opened the door.' }],
      },
      lore(nodes, voices),
    );
    expect(context.styleBlock).toMatch(/^<writing_style>\n/);
    expect(context.styleBlock).toContain('Narration for this book');
    expect(context.styleBlock).toContain('first person, told by Mara');
    const style = context.items.find((item) => item.kind === 'style');
    expect(style?.state).toBe('included');
    expect(contextToBlocks(context).some((block) => block.text.includes('present tense'))).toBe(true);
  });

  it('adds nothing when the book has no voice set', async () => {
    const context = await assembleContext(
      { budgetTokens: 20_000, source: { kind: 'node', id: 's2', title: 's2' }, doc: markdownToPm('Text.') },
      lore(nodes, voices),
    );
    expect(context.styleBlock).not.toContain('Narration for this book');
  });
});
