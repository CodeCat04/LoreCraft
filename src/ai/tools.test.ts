import { buildReadingOrder, spoilerLimit, type LoreSource } from './context';
import { LORE_TOOLS, runTool, validateToolInput, type ToolContext } from './tools';
import { markdownToPm } from '../editor/convert';
import type { Book, Node, NodeMeta, Page, PmNode, TitleEntry } from '../lib/types';
import type { ToolCallBlock } from './types';

const figure: PmNode = {
  type: 'figure',
  attrs: { kind: 'picture', align: 'right', width: null, description: 'Aria at dawn' },
  content: [{ type: 'image', attrs: { assetId: 'i', alt: '' } }, { type: 'figcaption', content: [{ type: 'text', text: 'The gate' }] }],
};

function page(id: string, title: string, body: string, extra: Partial<Page> = {}): Page {
  return {
    id, title, status: 'canon', pageType: 'character', summary: '', wordCount: 0, isHome: false, revealNodeId: null,
    createdAt: '', updatedAt: '', deletedAt: null, aliases: [], categories: [],
    content: markdownToPm(body), infobox: { fields: [] }, notes: null, ...extra,
  };
}

function scene(id: string, title: string, parentId: string, position: number, content: PmNode): Node {
  return {
    id, bookId: 'b', parentId, kind: 'scene', title, position, status: 'draft', povPageId: null, locationPageId: null, synopsis: '', wordCount: 0,
    targetWords: 0, storyDate: '', createdAt: '', updatedAt: '', deletedAt: null, content, notes: '',
  };
}

const chapter = { id: 'ch', bookId: 'b', parentId: null, kind: 'chapter', title: 'Ch', position: 0 } as NodeMeta;
const nodes: Node[] = [
  scene('s1', 'Dawn', 'ch', 0, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Aria drew her bow.' }] }, figure] }),
  scene('s2', 'Dusk', 'ch', 1, markdownToPm('The twist happens.')),
  scene('s3', 'Dawn', 'ch', 2, markdownToPm('Another dawn.')),
];
const pages = [
  page('a', 'Aria', 'Aria is a ranger.', { content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Aria is a ranger.' }] }, figure] } }),
  page('late', 'Secret', 'THE TWIST', { revealNodeId: 's2' }),
];

const lore: LoreSource = {
  titles: () => pages.map((p) => ({ id: p.id, title: p.title, pageType: p.pageType, status: p.status, summary: '', aliases: p.aliases } as TitleEntry)),
  page: async (id) => pages.find((p) => p.id === id) ?? null,
  pageByTitle: async (title) => pages.find((p) => p.title.toLowerCase() === title.toLowerCase()) ?? null,
  backlinks: async () => ({ pages: [{ id: 'late', title: 'Secret', status: 'canon' }], scenes: [{ id: 's1', title: 'Dawn', bookId: 'b', count: 2 }, { id: 's2', title: 'Dusk', bookId: 'b', count: 1 }] }),
  search: async () => [
    { kind: 'page', id: 'a', title: 'Aria', snippet: 'a \u0002ranger\u0003', bookId: null },
    { kind: 'page', id: 'late', title: 'Secret', snippet: 'the twist', bookId: null },
    { kind: 'node', id: 's2', title: 'Dusk', snippet: 'twist', bookId: 'b' },
    { kind: 'node', id: 's1', title: 'Dawn', snippet: 'bow', bookId: 'b' },
  ],
  node: async (id) => nodes.find((n) => n.id === id) ?? null,
  books: async () => [{ id: 'b', position: 0 } as Book],
  tree: async () => [chapter, ...nodes],
  listPages: async () => pages,
};

const open: ToolContext = { lore, limit: null };
const limited: ToolContext = { lore, limit: spoilerLimit(buildReadingOrder([{ nodes: [chapter, ...nodes] }]), 's1') };

function call(name: string, input: unknown, invalid?: string): ToolCallBlock {
  return { type: 'toolCall', id: 'c1', name, input, invalid };
}

describe('tool definitions', () => {
  it('are sorted by name, with no way to write anything directly', () => {
    const names = LORE_TOOLS.map((t) => t.name);
    expect(names).toEqual([...names].sort());
    expect(names).toEqual(['get_backlinks', 'get_page', 'get_scene', 'list_pages', 'propose_edit', 'propose_new_page', 'search_lore']);
  });
});

describe('input validation', () => {
  const tool = LORE_TOOLS.find((t) => t.name === 'propose_edit')!;

  it('catches what eager streaming no longer checks', () => {
    expect(validateToolInput(tool, 'text')).toContain('object');
    expect(validateToolInput(tool, [])).toContain('object');
    expect(validateToolInput(tool, { kind: 'page', title: 'A', find: 'x' })).toContain('"replace"');
    expect(validateToolInput(tool, { kind: 'page', title: '  ', find: 'x', replace: 'y' })).toContain('"title"');
    expect(validateToolInput(tool, { kind: 'nope', title: 'A', find: 'x', replace: 'y' })).toContain('one of page, scene');
    expect(validateToolInput(tool, { kind: 'page', title: 7, find: 'x', replace: 'y' })).toContain('must be a string');
    expect(validateToolInput(tool, { kind: 'page', title: 'A', find: 'x', replace: 'y' })).toBeNull();
  });

  it('checks whole numbers', () => {
    const search = LORE_TOOLS.find((t) => t.name === 'search_lore')!;
    expect(validateToolInput(search, { query: 'x', limit: 1.5 })).toContain('whole number');
  });
});

describe('running tools', () => {
  it('turns unparseable input into an error result, with the bad text safely quoted', async () => {
    const bad = '{"title":"She said "hi"';
    const result = await runTool(call('get_page', {}, bad), open);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toEqual({ INVALID_JSON: bad });
  });

  it('reports invalid input and unknown tools without running anything', async () => {
    const missing = await runTool(call('get_page', {}), open);
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain('"title"');
    const unknown = await runTool(call('delete_everything', {}), open);
    expect(unknown.isError).toBe(true);
  });

  it('turns a failure into a result the model can read', async () => {
    const broken = { ...open, lore: { ...lore, pageByTitle: () => Promise.reject(new Error('disk on fire')) } };
    const result = await runTool(call('get_page', { title: 'Aria' }), broken);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('disk on fire');
  });

  it('get_page returns the page with its status and numbered figure lines', async () => {
    const result = await runTool(call('get_page', { title: 'aria' }), open);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('status="canon: established fact"');
    expect(result.content).toContain('[Picture 1: The gate (Aria at dawn)]');
  });

  it('get_scene returns the scene with numbered figure lines, and asks when a title repeats', async () => {
    const byId = await runTool(call('get_scene', { id: 's1' }), open);
    expect(byId.content).toContain('Aria drew her bow.');
    expect(byId.content).toContain('[Picture 1: The gate (Aria at dawn)]');

    const repeated = await runTool(call('get_scene', { title: 'Dawn' }), open);
    expect(repeated.isError).toBe(true);
    expect(repeated.content).toContain('id s1');
    expect(repeated.content).toContain('id s3');

    const unique = await runTool(call('get_scene', { title: 'dusk' }), open);
    expect(unique.content).toContain('The twist happens.');
  });

  it('search_lore cleans its snippets', async () => {
    const result = await runTool(call('search_lore', { query: 'x' }), open);
    expect(result.content).toContain('a ranger');
    expect(result.content).not.toMatch(/[\u0002\u0003]/);
  });

  it('propose_edit checks the quote is real, and changes nothing', async () => {
    const good = await runTool(call('propose_edit', { kind: 'page', title: 'Aria', find: 'a ranger', replace: 'a warden' }), open);
    expect(good.isError).toBeFalsy();
    expect(good.content).toContain('Nothing has changed');
    const bad = await runTool(call('propose_edit', { kind: 'page', title: 'Aria', find: 'not there', replace: 'x' }), open);
    expect(bad.isError).toBe(true);
    expect((await lore.page('a'))?.content).toEqual(pages[0].content);
  });

  it('propose_new_page refuses a name that exists, and creates nothing', async () => {
    const taken = await runTool(call('propose_new_page', { title: 'ARIA', body: 'x' }), open);
    expect(taken.isError).toBe(true);
    const fresh = await runTool(call('propose_new_page', { title: 'Brand New', body: 'x' }), open);
    expect(fresh.isError).toBeFalsy();
    expect(fresh.content).toContain('Nothing has been created');
  });
});

describe('the spoiler limit reaches the tools', () => {
  it('hides later pages and scenes as if they did not exist', async () => {
    const read = await runTool(call('get_page', { title: 'Secret' }), limited);
    expect(read.isError).toBe(true);
    expect(read.content).not.toContain('TWIST');

    const hidden = await runTool(call('get_scene', { id: 's2' }), limited);
    expect(hidden.isError).toBe(true);
    expect(hidden.content).not.toContain('twist');

    const search = await runTool(call('search_lore', { query: 'x' }), limited);
    expect(search.content).toContain('Aria');
    expect(search.content).toContain('Dawn');
    expect(search.content).not.toContain('Secret');
    expect(search.content).not.toContain('Dusk');

    const list = await runTool(call('list_pages', {}), limited);
    expect(list.content).toContain('Aria');
    expect(list.content).not.toContain('Secret');

    const back = await runTool(call('get_backlinks', { title: 'Aria' }), limited);
    expect(back.content).toContain('Dawn');
    expect(back.content).not.toContain('Secret');
    expect(back.content).not.toContain('Dusk');
  });

  it('shows everything without a limit', async () => {
    expect((await runTool(call('get_page', { title: 'Secret' }), open)).content).toContain('TWIST');
  });
});

describe('get_page and facts that change', () => {
  const changing = page('c', 'Changing', 'Text.', {
    infobox: { fields: [{ key: 'hair', label: 'Hair', kind: 'text', value: 'blonde', changes: [{ nodeId: 's2', value: 'black' }] }] },
  });
  const withPage: LoreSource = {
    ...lore,
    titles: () => [{ id: 'c', title: 'Changing', pageType: 'character', status: 'canon', summary: '', aliases: [] }],
    pageByTitle: async () => changing,
    page: async () => changing,
    books: async () => [{ id: 'b', position: 0, title: 'One' } as Book],
    tree: async () => [chapter, ...nodes],
  };
  const order = buildReadingOrder([{ nodes: [chapter, ...nodes] }]);

  it('gives the whole history with no limit', async () => {
    const result = await runTool(call('get_page', { title: 'Changing' }), { lore: withPage, limit: null } as ToolContext);
    expect(result.content).toContain('Hair: blonde, then black from');
  });

  it('gives only what is true by the spoiler limit', async () => {
    const result = await runTool(call('get_page', { title: 'Changing' }), { lore: withPage, limit: spoilerLimit(order, 's1') } as ToolContext);
    expect(result.content).toContain('Hair: blonde.');
    expect(result.content).not.toContain('black');
  });
});
