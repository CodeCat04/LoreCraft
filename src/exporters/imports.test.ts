/** What each importer makes of its source. The native side is tested in `rpc/import.rs`. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { strFromU8, unzipSync } from 'fflate';
import { getSchema } from '@tiptap/core';
import { Node as ProseNode } from '@tiptap/pm/model';
import { parse as parseYaml } from 'yaml';

import { describeFigures, markdownToPm, pmToPlainText } from '../editor/convert';
import { documentExtensions } from '../editor/schema';
import type { PmNode } from '../lib/types';
import { normalizeDocxHtml, parseDocxHtml } from './import/docx';
import { KNOWN_FIELDS } from './import/infoboxFields';
import { normalizeLorebookFile } from './import/lorebookFile';
import { docxBytesToHtml } from './import/mammoth';
import { DEFAULT_MARKDOWN_OPTIONS, normalizeMarkdownFiles, type MarkdownFile } from './import/markdownFiles';
import { decodeText, normalizeText, textToDoc } from './import/text';
import type { ImportProblem, PayloadNode, PayloadPage } from './import/types';
import { exportDocx } from './novel/docx';
import { fixtureInput, fixtureSnapshot } from './testFixture';
import { exportJson } from './wiki/json';
import { exportMarkdown } from './wiki/markdown';
import { exportYaml } from './wiki/yaml';

const schema = getSchema(documentExtensions());
const valid = (doc: PmNode | undefined | null) => {
  if (doc) ProseNode.fromJSON(schema, doc).check();
};
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const errors = (problems: ImportProblem[]) => problems.filter((p) => p.severity === 'error');
const find = (problems: ImportProblem[], item: string, field: string) =>
  problems.find((p) => p.item.includes(item) && p.field === field);

describe('a scene’s location, cast and plot threads', () => {
  const exported = () => JSON.parse(new TextDecoder().decode(exportJson(fixtureInput({ scope: 'project' }))));

  it('are written by the JSON export, by name', () => {
    const file = exported();
    const gate = file.books[0].children[0].children[0];
    expect(gate.title).toBe('The Gate');
    expect(gate.location).toBe('Silver Vale');
    expect(gate.cast).toEqual(['Aria Vale', 'Silver Vale']);
    expect(gate.threads).toEqual(['thread-road']);
    expect(file.threads.map((t: { name: string }) => t.name)).toEqual(['The Long Road', 'Not Started']);
  });

  it('are read back', () => {
    const { payload, problems } = normalizeLorebookFile(exported());
    expect(problems.filter((p) => p.severity === 'error')).toEqual([]);
    const gate = payload.books[0].children![0].children![0];
    expect(gate.location).toBe('Silver Vale');
    expect(gate.cast).toEqual(['Aria Vale', 'Silver Vale']);
    expect(gate.threads).toEqual(['thread-road']);
    expect(payload.threads[0]).toEqual({ id: 'thread-road', name: 'The Long Road', color: 'green', description: 'Getting home.', position: 0 });
  });

  it('only come with the book they belong to', () => {
    const { snapshot } = fixtureInput({ scope: 'book', bookId: 'book-2' });
    expect(snapshot.threads).toEqual([]);
    expect(snapshot.nodeThreads).toEqual([]);
    const { snapshot: first } = fixtureInput({ scope: 'book', bookId: 'book-1' });
    expect(first.threads.map((t) => t.name)).toEqual(['The Long Road']);
    expect(fixtureInput({ scope: 'wiki' }).snapshot.threads).toEqual([]);
  });

  it('name the item and field when something is wrong', () => {
    const { problems } = normalizeLorebookFile({
      format: 'lorebook',
      version: 1,
      threads: [{ color: 'green' }, 'not an object', { name: 'Fine', position: 'first' }],
      books: [{ title: 'B', children: [{ kind: 'chapter', children: [{ kind: 'scene', cast: 'Aria', threads: [5] }] }] }],
    });
    const errors = problems.filter((p) => p.severity === 'error').map((p) => `${p.item}|${p.field}`);
    expect(errors).toContain('threads[0]|name');
    expect(errors.some((e) => e.startsWith('threads[1]'))).toBe(true);
    expect(errors).toContain('threads[2] "Fine"|position');
    expect(errors.some((e) => e.endsWith('|cast'))).toBe(true);
    expect(errors.some((e) => e.endsWith('|threads[0]'))).toBe(true);
  });

  it('must be a list at the top of a file', () => {
    const { problems } = normalizeLorebookFile({ format: 'lorebook', version: 1, threads: 'lots' });
    expect(problems).toContainEqual(expect.objectContaining({ severity: 'error', field: 'threads' }));
  });
});

describe('the format documented in docs/IMPORT_FORMAT.md', () => {
  const docs = readFileSync(join(process.cwd(), 'docs/IMPORT_FORMAT.md'), 'utf8');
  const example = /## A complete example[\s\S]*?```json\n([\s\S]*?)\n```/.exec(docs)?.[1] ?? '';

  it('has a complete example that imports with no problems at all', () => {
    const { payload, problems } = normalizeLorebookFile(JSON.parse(example));
    expect(problems).toEqual([]);
    expect(payload.pages.length).toBe(6);
    expect(payload.books.length).toBe(1);
    payload.pages.forEach((page) => {
      valid(page.content);
      valid(page.notes);
    });
    const walk = (nodes?: PayloadNode[]) => nodes?.forEach((n) => { valid(n.content); walk(n.children); });
    walk(payload.books[0].children);
  });

  it('the example shows each feature it promises', () => {
    const { payload } = normalizeLorebookFile(JSON.parse(example));
    const aria = payload.pages.find((p) => p.title === 'Aria Vale') as PayloadPage;
    expect(aria.status).toBe('canon');
    expect(aria.aliases).toContain('The Ranger');
    expect(aria.categories).toContain('Rangers');
    expect(aria.infobox?.fields.find((f) => f.key === 'born')).toEqual({ key: 'born', label: 'Born', kind: 'date', value: '12 Frost 1204' });
    expect(aria.infobox?.fields.find((f) => f.key === 'parents')).toEqual({ key: 'parents', label: 'Parents', kind: 'pages', value: 'Marek Vale, Sefa Vale' });
    expect(aria.infobox?.fields.find((f) => f.key === 'favourite_blade')?.label).toBe('Favourite blade');
    const text = JSON.stringify(aria.content);
    expect(text).toContain('"wikiLink"');
    expect(text).toContain('"reference"');
    const figures = describeFigures(aria.content!);
    expect(figures.map((f) => f.name)).toEqual(['Figure 1', 'Table 1']);
    expect(figures[0]).toMatchObject({ caption: 'Aria as a child, from the Warden rolls', description: 'A green sketch of a girl with a bow', assetId: 'aria-portrait' });
    expect(figures[1]).toMatchObject({ caption: 'Her ranks', media: 'table' });
    expect(payload.pages.map((p) => p.status)).toEqual(['canon', 'canon', 'canon', 'draft', 'idea', 'retconned']);
    const book = payload.books[0];
    expect(book.children?.map((c) => c.kind)).toEqual(['part', 'chapter']);
    const gate = book.children?.[0].children?.[0];
    expect(gate?.children?.map((s) => s.title)).toEqual(['Dusk', 'The Empty Hall']);
    expect(gate?.children?.[0].pov).toBe('Aria Vale');
  });

  it('documents every infobox key the templates use, as the code has them', () => {
    const keys = ['born', 'died', 'age', 'species', 'gender', 'affiliation', 'location', 'founded', 'dissolved', 'date', 'start', 'end', 'parents', 'spouse', 'children', 'leader', 'members', 'owner', 'creator', 'height', 'eyes', 'hair'];
    expect(Object.keys(KNOWN_FIELDS).sort()).toEqual([...keys].sort());
    for (const key of keys) {
      const { label, kind } = KNOWN_FIELDS[key];
      expect(docs).toContain(`| \`${key}\` | ${label} | ${kind} |`);
    }
  });

  it('shows a figure the way the schema wants it', () => {
    const block = /### Figures[\s\S]*?```json\n([\s\S]*?)\n```/.exec(docs)?.[1] ?? '';
    const doc = { type: 'doc', content: [JSON.parse(block)] };
    valid(doc);
    expect(describeFigures(doc)[0]).toMatchObject({ name: 'Picture 1', caption: 'The road north', align: 'left', width: 40 });
  });

  it('every kind of Markdown it describes makes a valid document', () => {
    const rows = [...docs.matchAll(/^\| `([^`]+)`.*\|$/gm)].map((m) => m[1]).filter((cell) => /^[!^[#>-]|^\*\*|^\d\./.test(cell));
    expect(rows.length).toBeGreaterThan(4);
    for (const markdown of rows) valid(markdownToPm(markdown));
    valid(markdownToPm('![The ride](video:asset:clip1)'));
    expect(describeFigures(markdownToPm('![The ride](video:asset:clip1)'))[0]).toMatchObject({ kind: 'video', assetId: 'clip1', caption: 'The ride' });
    expect(describeFigures(markdownToPm('![The ride](video:https://example.com/ride.mp4)'))[0]).toMatchObject({ kind: 'video', url: 'https://example.com/ride.mp4' });
    expect(describeFigures(markdownToPm('![The road north](asset:map1 "A map of the road")'))[0]).toMatchObject({ kind: 'figure', assetId: 'map1', caption: 'The road north', description: 'A map of the road' });
  });

  it('has error examples in the words the importer really uses', () => {
    const { problems } = normalizeLorebookFile({
      format: 'lorebook',
      version: 1,
      pages: [{ title: 'Silver Vale', status: 'published' }, { title: 'Aria', content: { type: 'doc', content: [{ type: 'video-player' }] } }],
      books: [{ title: 'The Silver Road', children: [{ kind: 'chapter', title: 'Interlude', children: [{ kind: 'part' }] }] }],
    });
    expect(find(problems, 'pages[0] "Silver Vale"', 'status')?.message).toBe('"published" is not one of canon, draft, idea, retconned');
    expect(docs).toContain('"published" is not one of canon, draft, idea, retconned');
    expect(find(problems, '"Interlude".children[0]', 'kind')?.message).toContain('a part cannot go inside a chapter.');
    expect(docs).toContain('a part cannot go inside a chapter.');
    expect(find(problems, 'pages[1] "Aria"', 'content')?.message).toContain('Unknown node type: video-player');
  });
});

describe('validation names the item and the field', () => {
  const base = { format: 'lorebook', version: 1 };

  it('refuses a file that is not this format', () => {
    expect(normalizeLorebookFile([]).problems[0].message).toContain('one object');
    expect(find(normalizeLorebookFile({}).problems, 'the file', 'format')).toBeDefined();
    expect(find(normalizeLorebookFile({ format: 'other', version: 1 }).problems, 'the file', 'format')).toBeDefined();
    expect(find(normalizeLorebookFile({ format: 'lorebook' }).problems, 'the file', 'version')).toBeDefined();
    expect(find(normalizeLorebookFile({ format: 'lorebook', version: 9 }).problems, 'the file', 'version')?.message).toContain('newer version');
  });

  const cases: [string, unknown, string, string][] = [
    ['a missing title', { pages: [{}] }, 'pages[0]', 'title'],
    ['a blank title', { pages: [{ title: '  ' }] }, 'pages[0]', 'title'],
    ['a title of the wrong type', { pages: [{ title: 5 }] }, 'pages[0]', 'title'],
    ['a page that is not an object', { pages: ['x'] }, 'pages[0]', ''],
    ['pages that are not a list', { pages: {} }, 'the file', 'pages'],
    ['a bad status', { pages: [{ title: 'A', status: 'published' }] }, 'pages[0] "A"', 'status'],
    ['aliases as one text', { pages: [{ title: 'A', aliases: 'B' }] }, 'pages[0] "A"', 'aliases'],
    ['a bad category', { pages: [{ title: 'A', categories: ['ok', 1] }] }, 'pages[0] "A"', 'categories[1]'],
    ['content of the wrong type', { pages: [{ title: 'A', content: 5 }] }, 'pages[0] "A"', 'content'],
    ['content that is not a doc', { pages: [{ title: 'A', content: { type: 'paragraph' } }] }, 'pages[0] "A"', 'content'],
    ['an unknown node', { pages: [{ title: 'A', content: { type: 'doc', content: [{ type: 'hologram' }] } }] }, 'pages[0] "A"', 'content'],
    ['an invalid structure', { pages: [{ title: 'A', content: { type: 'doc', content: [{ type: 'listItem' }] } }] }, 'pages[0] "A"', 'content'],
    ['an infobox in the wrong shape', { pages: [{ title: 'A', infobox: 'x' }] }, 'pages[0] "A"', 'infobox'],
    ['infobox fields in the wrong shape', { pages: [{ title: 'A', infobox: { fields: { born: 1 } } }] }, 'pages[0] "A"', 'infobox.fields'],
    ['an infobox field with no key', { pages: [{ title: 'A', infobox: { fields: [{ value: 'x' }] } }] }, 'pages[0] "A"', 'infobox.fields[0].key'],
    ['an infobox field of a bad kind', { pages: [{ title: 'A', infobox: { fields: [{ key: 'k', kind: 'colour' }] } }] }, 'pages[0] "A"', 'infobox.fields[0].kind'],
    ['a book with no title', { books: [{}] }, 'books[0]', 'title'],
    ['a scene at the top of a book', { books: [{ title: 'B', children: [{ kind: 'scene' }] }] }, 'books[0] "B".children[0]', 'kind'],
    ['a part in a part', { books: [{ title: 'B', children: [{ kind: 'part', children: [{ kind: 'part' }] }] }] }, 'children[0].children[0]', 'kind'],
    ['a missing kind', { books: [{ title: 'B', children: [{ title: 'X' }] }] }, 'children[0] "X"', 'kind'],
    ['an unknown kind', { books: [{ title: 'B', children: [{ kind: 'volume' }] }] }, 'children[0]', 'kind'],
    ['text in a chapter', { books: [{ title: 'B', children: [{ kind: 'chapter', content: 'words' }] }] }, 'children[0]', 'content'],
    ['a scene holding things', { books: [{ title: 'B', children: [{ kind: 'chapter', children: [{ kind: 'scene', children: [{ kind: 'scene' }] }] }] }] }, 'children[0].children[0]', 'children'],
    ['a bad scene status', { books: [{ title: 'B', children: [{ kind: 'chapter', children: [{ kind: 'scene', status: 'done' }] }] }] }, 'children[0].children[0]', 'status'],
    ['a bad target', { books: [{ title: 'B', targetWords: 'many' }] }, 'books[0] "B"', 'targetWords'],
  ];

  it.each(cases)('reports %s', (_name, fields, item, field) => {
    const { problems } = normalizeLorebookFile({ ...base, ...(fields as object) });
    const problem = find(errors(problems), item, field);
    expect(problem, JSON.stringify(problems)).toBeDefined();
  });

  it('leaves invalid items out, so a preview still shows the rest', () => {
    const { payload } = normalizeLorebookFile({ ...base, pages: [{ title: 'Good' }, { title: 'Bad', status: 'x' }] });
    expect(payload.pages.map((p) => p.title)).toEqual(['Good']);
  });

  it('names and types fields as the wiki templates do', () => {
    const field = (pageType: string, key: string, value: unknown) => {
      const { payload } = normalizeLorebookFile({ ...base, pages: [{ title: 'A', pageType, infobox: { fields: [{ key, value }] } }] });
      return payload.pages[0].infobox?.fields[0];
    };
    expect(field('character', 'location', 'Vale')).toMatchObject({ label: 'Home', kind: 'page' });
    expect(field('place', 'location', 'Vale')).toMatchObject({ label: 'Part of', kind: 'page' });
    expect(field('faction', 'location', 'Vale')).toMatchObject({ label: 'Headquarters', kind: 'page' });
    expect(field('unheard of', 'location', 'Vale')).toMatchObject({ label: 'Location', kind: 'page' });
    expect(field('article', 'trade_routes', 'Salt')).toMatchObject({ label: 'Trade routes', kind: 'text' });
    expect(field('character', 'age', 30)).toMatchObject({ kind: 'number', value: '30' });
    expect(field('character', 'age', 'about 30')).toMatchObject({ kind: 'text', value: 'about 30' });
    expect(field('faction', 'leader', ['A', 'B'])).toMatchObject({ kind: 'pages', value: 'A, B' });
  });

  it('reads the same fields from a note', () => {
    const { payload } = vault({ 'Aria.md': '---\ntype: character\nlocation: Vale\nage: about 30\nleader: [A, B]\n---\nx' });
    expect(payload.pages[0].infobox?.fields).toEqual([
      { key: 'age', label: 'Age', kind: 'text', value: 'about 30' },
      { key: 'location', label: 'Home', kind: 'page', value: 'Vale' },
      { key: 'leader', label: 'Leader', kind: 'pages', value: 'A, B' },
    ]);
  });

  it('keeps anything else stored in an infobox', () => {
    const { payload } = normalizeLorebookFile({
      ...base,
      pages: [{ title: 'A', infobox: { template: 'hero', fields: [{ key: 'born', value: '1', pinned: true }] } }],
    });
    expect(payload.pages[0].infobox).toEqual({
      template: 'hero',
      fields: [{ key: 'born', label: 'Born', kind: 'date', value: '1', pinned: true }],
    });
  });

  it('warns about fields it does not know, naming what it does', () => {
    const { problems } = normalizeLorebookFile({ ...base, extra: 1, pages: [{ title: 'A', body: 'typo for content' }] });
    expect(find(problems, 'the file', 'extra')?.severity).toBe('warning');
    const typo = find(problems, 'pages[0] "A"', 'body');
    expect(typo?.severity).toBe('warning');
    expect(typo?.message).toContain('content');
  });

  it('turns away documents nested too deeply to send', () => {
    let node: PmNode = { type: 'paragraph' };
    for (let i = 0; i < 40; i += 1) node = { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }, node] }] };
    const { problems } = normalizeLorebookFile({ ...base, pages: [{ title: 'Deep', content: { type: 'doc', content: [node] } }] });
    expect(find(problems, 'Deep', 'content')?.message).toContain('nested too deeply');
  });

  it('accepts a file naming a path for an asset only by dropping the path', () => {
    const { payload } = normalizeLorebookFile({ ...base, assets: [{ id: 'a', name: 'a.png', mime: 'image/png', base64: 'AAEC', path: 'C:/secret.png' }] });
    expect(payload.assets[0]).toEqual({ id: 'a', name: 'a.png', mime: 'image/png', base64: 'AAEC' });
  });
});

describe('LoreCraft export read back', () => {
  it('JSON comes back with every document and field intact', () => {
    const source = fixtureSnapshot();
    const { payload, problems } = normalizeLorebookFile(JSON.parse(decode(exportJson(fixtureInput()))));
    expect(errors(problems)).toEqual([]);
    // The one thing it could not carry is reported.
    expect(problems.map((p) => p.item)).toEqual(['assets[4] "whole film.mp4"']);
    expect(payload.pages.length).toBe(source.pages.length);
    for (const page of source.pages) {
      const back = payload.pages.find((p) => p.title === page.title) as PayloadPage;
      expect(back.content).toEqual(page.content);
      expect(back.notes ?? null).toEqual(page.notes);
      expect(back.status).toBe(page.status);
      expect(back.pageType).toBe(page.pageType);
      expect(back.summary).toBe(page.summary);
      expect(back.aliases).toEqual(page.aliases);
      expect(back.categories).toEqual(page.categories);
      expect(back.isHome).toBe(page.isHome);
      expect(back.createdAt).toBe(page.createdAt);
      expect(back.updatedAt).toBe(page.updatedAt);
      for (const field of page.infobox.fields) expect(back.infobox?.fields).toContainEqual(field);
      expect(back.infobox?.imageAssetId).toBe(page.infobox.imageAssetId);
    }
    const gate = payload.books[0].children?.[0].children?.[0];
    expect(gate).toMatchObject({ id: 'scene-gate', kind: 'scene', title: 'The Gate', status: 'revised', pov: 'Aria Vale', storyDate: '1 Frost 1220', targetWords: 1500, notes: 'Tighten <this>.' });
    expect(gate?.content).toEqual(source.nodes[1].content);
    expect(payload.books[0].writingLog).toEqual([{ day: '2024-03-01', wordsAdded: 500, wordsRemoved: 20 }]);
    expect(payload.relationships.length).toBe(2);
    expect(payload.dictionary).toEqual(source.dictionary);
    expect(payload.meta['wiki.setting']).toBe('kept');
    expect(payload.maps.length).toBe(1);
    expect(payload.assets.find((a) => a.id === 'asset-map')?.base64).toBeTruthy();
    expect(payload.assets.find((a) => a.id === 'asset-huge')).toBeUndefined();
  });

  it('YAML comes back, in both ways of writing documents', () => {
    const exact = normalizeLorebookFile(parseYaml(decode(exportYaml(fixtureInput({ bodyFormat: 'prosemirror' })))));
    expect(errors(exact.problems)).toEqual([]);
    expect(exact.payload.pages[1].content).toEqual(fixtureSnapshot().pages.find((p) => p.title === exact.payload.pages[1].title)?.content);
    const readable = normalizeLorebookFile(parseYaml(decode(exportYaml(fixtureInput()))));
    expect(errors(readable.problems)).toEqual([]);
    const aria = readable.payload.pages.find((p) => p.title === 'Aria Vale') as PayloadPage;
    valid(aria.content);
    expect(pmToPlainText(aria.content!)).toContain('<angle> & ampersand');
    expect(describeFigures(aria.content!).length).toBeGreaterThan(3);
  });
});

function vault(files: Record<string, string>, others: string[] = [], options = DEFAULT_MARKDOWN_OPTIONS) {
  const list: MarkdownFile[] = Object.entries(files).map(([path, text]) => ({ path, text }));
  return normalizeMarkdownFiles(list, others, 'C:/vault', options);
}

function textOf(page: PayloadPage | undefined): string {
  return page?.content ? pmToPlainText(page.content) : '';
}

describe('Markdown files', () => {
  it('makes a page from a plain file, named by the file', () => {
    const { payload, problems } = vault({ 'Aria Vale.md': 'Born in [[Silver Vale|the Vale]].\n\n## Early life\n\nA ranger.' });
    expect(problems).toEqual([]);
    const page = payload.pages[0];
    expect(page.title).toBe('Aria Vale');
    valid(page.content);
    expect(JSON.stringify(page.content)).toContain('"target":"Silver Vale"');
  });

  it('reads front matter', () => {
    const { payload } = vault({
      'x.md': `---
title: "Aria: The Ranger"
aliases: [The Ranger, Red]
tags: [character, north/rangers]
status: canon
type: character
summary: A ranger.
born: 12 Frost 1204
spouse: Dorn Ash
unknown_key: ignored
created: 2024-01-02T03:04:05Z
---

Text.
`,
    });
    const page = payload.pages[0];
    expect(page.title).toBe('Aria: The Ranger');
    expect(page.aliases).toEqual(['The Ranger', 'Red']);
    expect(page.categories).toEqual(['character', 'north/rangers']);
    expect(page.status).toBe('canon');
    expect(page.pageType).toBe('character');
    expect(page.summary).toBe('A ranger.');
    expect(page.createdAt).toBe('2024-01-02T03:04:05.000Z');
    expect(page.infobox?.fields).toEqual([
      { key: 'born', label: 'Born', kind: 'date', value: '12 Frost 1204' },
      { key: 'spouse', label: 'Spouse', kind: 'pages', value: 'Dorn Ash' },
    ]);
    expect(textOf(page)).toBe('Text.');
  });

  it('accepts a single value where a list is usual', () => {
    const { payload } = vault({ 'a.md': '---\naliases: Red\ntags: one, two three\n---\nx' });
    expect(payload.pages[0].aliases).toEqual(['Red']);
    expect(payload.pages[0].categories).toEqual(['one', 'two', 'three']);
  });

  it('keeps a file with broken front matter, and says so', () => {
    const { payload, problems } = vault({ 'a.md': '---\ntitle: [unclosed\n---\nBody.' });
    expect(payload.pages[0].title).toBe('a');
    expect(problems[0]).toMatchObject({ severity: 'warning', item: 'a.md', field: 'front matter' });
    expect(textOf(payload.pages[0])).toContain('Body.');
  });

  it('goes by the file name, as a vault does, without repeating it as a heading', () => {
    const named = vault({ 'Aria Vale.md': '# Overview\n\nA ranger.' }).payload.pages[0];
    expect(named.title).toBe('Aria Vale');
    expect(textOf(named)).toContain('Overview');
    const same = vault({ 'Aria Vale.md': '# Aria Vale\n\nA ranger.' }).payload.pages[0];
    expect(textOf(same)).toBe('A ranger.');
  });

  it('takes the title from a first heading when the file name says nothing', () => {
    for (const name of ['notes.md', 'README.md', 'Untitled 3.md']) {
      const page = vault({ [name]: '# The Long Frost\n\nIt was cold.' }).payload.pages[0];
      expect(page.title).toBe('The Long Frost');
      expect(textOf(page)).toBe('It was cold.');
    }
  });

  it('leaves equals signs alone unless they make a highlight', () => {
    const { payload } = vault({ 'a.md': 'If a == b == c then ==this== is marked.' });
    expect(textOf(payload.pages[0])).toBe('If a == b == c then this is marked.');
  });

  it('keeps categories and tags together', () => {
    const { payload } = vault({ 'a.md': '---\ncategories: [Rangers & Scouts]\ntags: [Rangers-Scouts, extra]\n---\nx' });
    expect(payload.pages[0].categories).toEqual(['Rangers & Scouts', 'extra']);
  });

  it('turns folders into categories only when asked', () => {
    const files = { 'People/Elves/Aria.md': 'x' };
    expect(vault(files).payload.pages[0].categories).toEqual([]);
    const on = vault(files, [], { ...DEFAULT_MARKDOWN_OPTIONS, foldersAsCategories: true });
    expect(on.payload.pages[0].categories).toEqual(['People', 'Elves']);
  });

  it('keeps notes with the same name apart', () => {
    const { payload, problems } = vault({ 'People/Ash.md': 'a person', 'Places/Ash.md': 'a place' });
    expect(payload.pages.map((p) => p.title).sort()).toEqual(['Ash', 'Ash (Places)']);
    expect(problems[0].severity).toBe('warning');
  });

  it('never interprets raw HTML', () => {
    const { payload } = vault({ 'a.md': '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>' });
    expect(textOf(payload.pages[0])).toContain('<script>');
    expect(JSON.stringify(payload.pages[0].content)).not.toContain('"type":"image"');
  });
});

describe('Obsidian vaults', () => {
  it('reads every form of link', () => {
    const { payload } = vault({
      'a.md': '[[Page|Label]] [[folder/Deep Page]] [[Page#Heading]] [[Page#Heading|Shown]] [[Page^block]] \\[[not a link]]',
    });
    const links = (payload.pages[0].content!.content![0].content ?? [])
      .filter((n) => n.marks?.some((m) => m.type === 'wikiLink'))
      .map((n) => [n.marks![0].attrs!.target, n.text]);
    expect(links).toEqual([
      ['Page', 'Label'],
      ['Deep Page', 'Deep Page'],
      ['Page', 'Page > Heading'],
      ['Page', 'Shown'],
      ['Page', 'Page > block'],
    ]);
    expect(textOf(payload.pages[0])).toContain('[[not a link]]');
  });

  it('points links at titles, when a note names itself differently', () => {
    const { payload } = vault({
      'file-name.md': '---\ntitle: The Real Name\n---\nx',
      'other.md': '[[file-name]] and [[file-name|with label]]',
    });
    const other = payload.pages.find((p) => p.title === 'other');
    const targets = other!.content!.content![0].content!.filter((n) => n.marks).map((n) => [n.marks![0].attrs!.target, n.text]);
    expect(targets).toEqual([['The Real Name', 'The Real Name'], ['The Real Name', 'with label']]);
  });

  it('turns #tags into categories and takes them out of the text', () => {
    const { payload } = vault({ 'a.md': 'Some #lore text with #deep/tag here.\n\n# not a tag\n\n#only-tags #on-this-line\n\nA url http://x.com/#frag and `#code` and C# stay.\n' });
    const page = payload.pages[0];
    expect(page.categories?.sort()).toEqual(['deep/tag', 'lore', 'on-this-line', 'only-tags']);
    const text = textOf(page);
    expect(text).toContain('Some text with here.');
    expect(text).toContain('not a tag');
    expect(text).toContain('http://x.com/#frag');
    expect(text).toContain('#code');
    expect(text).toContain('C#');
    expect(text).not.toContain('#lore');
  });

  it('leaves code blocks alone', () => {
    const { payload } = vault({ 'a.md': '```\n#notatag [[not a link]] ![[nope.png]]\n```\n' });
    expect(payload.pages[0].categories).toEqual([]);
    expect(textOf(payload.pages[0])).toContain('#notatag [[not a link]] ![[nope.png]]');
    expect(payload.assets).toEqual([]);
  });

  it('can leave #tags as they are', () => {
    const { payload } = vault({ 'a.md': 'Some #lore here.' }, [], { ...DEFAULT_MARKDOWN_OPTIONS, tagsAsCategories: false });
    expect(payload.pages[0].categories).toEqual([]);
    expect(textOf(payload.pages[0])).toBe('Some #lore here.');
  });

  it('merges front matter tags and inline tags', () => {
    const { payload } = vault({ 'a.md': '---\ntags: [one]\n---\nx #two' });
    expect(payload.pages[0].categories?.sort()).toEqual(['one', 'two']);
  });

  it('imports embedded images as assets, wherever they are in the vault', () => {
    const { payload, problems } = vault(
      {
        'notes/a.md': '![[map.png]]\n\n![[attachments/photo one.jpg|My caption]]\n\n![[map.png|300]]\n\n![alt text](../pictures/rel.webp "A title")\n\n![[missing.png]]\n\n![[Other Note]]\n\n![[clip.mp4|The ride]]\n\n![[notes.pdf]]',
      },
      ['pictures/map.png', 'attachments/photo one.jpg', 'pictures/rel.webp', 'clips/clip.mp4', 'notes.pdf'],
    );
    expect(problems).toEqual([{ severity: 'warning', item: 'notes/a.md', field: 'body', message: 'shows missing.png, which is not in the chosen folder.' }]);
    const page = payload.pages[0];
    valid(page.content);
    const figures = describeFigures(page.content!);
    expect(figures.map((f) => [f.kind, f.caption])).toEqual([
      ['figure', ''],
      ['figure', 'My caption'],
      ['figure', ''],
      ['figure', 'alt text'],
      ['video', 'The ride'],
    ]);
    expect(figures[3].description).toBe('A title');
    expect(figures[0].assetId).toBe(figures[2].assetId);
    expect(payload.assets.map((a) => [a.name, a.mime, a.path])).toEqual([
      ['map.png', 'image/png', 'C:/vault/pictures/map.png'],
      ['photo one.jpg', 'image/jpeg', 'C:/vault/attachments/photo one.jpg'],
      ['clip.mp4', 'video/mp4', 'C:/vault/clips/clip.mp4'],
      ['rel.webp', 'image/webp', 'C:/vault/pictures/rel.webp'],
    ]);
    const text = textOf(page);
    expect(text).toContain('missing.png');
    expect(JSON.stringify(page.content)).toContain('"target":"Other Note"');
  });

  it('turns remote images into figures, and remote videos into video figures', () => {
    const { payload } = vault({ 'a.md': '![pic](https://example.com/a.png)\n\n![clip](https://example.com/a.mp4)\n\n![tube](https://youtu.be/abc)' });
    const figures = describeFigures(payload.pages[0].content!);
    expect(figures.map((f) => [f.kind, f.url])).toEqual([
      ['figure', null],
      ['video', 'https://example.com/a.mp4'],
      ['video', 'https://youtu.be/abc'],
    ]);
  });

  it('handles callouts, comments and highlights', () => {
    const { payload } = vault({ 'a.md': '> [!warning] Careful now\n> Inside.\n\nVisible %%hidden%% text with ==marked== words.' });
    const text = textOf(payload.pages[0]);
    expect(text).toContain('Warning: Careful now');
    expect(text).toContain('Inside.');
    expect(text).toContain('Visible  text with marked words.');
    expect(text).not.toContain('hidden');
    expect(text).not.toContain('[!warning]');
    expect(payload.pages[0].content!.content![0].type).toBe('blockquote');
  });
});

describe("LoreCraft's own Markdown export read back", () => {
  const files = unzipSync(exportMarkdown(fixtureInput()));
  const list = Object.entries(files)
    .filter(([path]) => path.endsWith('.md'))
    .map(([path, bytes]) => ({ path, text: strFromU8(bytes) }));
  const others = Object.keys(files).filter((path) => !path.endsWith('.md'));
  const { payload, problems } = normalizeMarkdownFiles(list, others, 'C:/out');

  it('has no errors, and every document is valid', () => {
    expect(errors(problems)).toEqual([]);
    payload.pages.forEach((page) => valid(page.content));
  });

  it('brings every page back with its real title and metadata', () => {
    const source = fixtureSnapshot();
    expect(payload.pages.map((p) => p.title).sort()).toEqual(source.pages.map((p) => p.title).sort());
    const aria = payload.pages.find((p) => p.title === 'Aria Vale') as PayloadPage;
    expect(aria.aliases).toEqual(['The Ranger', 'Éowyn "Red" Þórr']);
    expect(aria.categories).toEqual(['Characters', 'Rangers & Scouts']);
    expect(aria.status).toBe('canon');
    expect(aria.pageType).toBe('character');
    expect(aria.summary).toBe('A ranger of the north & beyond.');
    expect(aria.createdAt).toBe('2024-03-01T10:20:30.000Z');
    expect(aria.infobox?.fields.map((f) => f.key)).toContain('born');
    expect(pmToPlainText(aria.notes!)).toContain('Check her age');
    expect(payload.pages.find((p) => p.title === 'Main Page')?.isHome).toBe(true);
  });

  it('points links back at real titles, through the cleaned-up file names', () => {
    const aria = payload.pages.find((p) => p.title === 'Aria Vale') as PayloadPage;
    const text = JSON.stringify(aria.content);
    expect(text).toContain('"target":"Silver Vale"');
    expect(text).toContain('"target":"CON"');
    expect(text).toContain('"target":"Aria Vale"');
    const con = JSON.stringify(payload.pages.find((p) => p.title === 'A|B [draft] <x> #1')?.content);
    expect(con).toContain('"target":"A|B [draft] <x> #1"');
  });

  it('brings text and figures back', () => {
    const aria = payload.pages.find((p) => p.title === 'Aria Vale') as PayloadPage;
    const plain = pmToPlainText(aria.content!);
    expect(plain).toContain('<angle> & ampersand');
    expect(plain).toContain('[[not a link]]');
    expect(plain).toContain('* not a list');
    const figures = describeFigures(aria.content!);
    // The last is a bare picture with an outside address, which reads back as a figure.
    expect(figures.map((f) => f.media)).toEqual(['image', 'image', 'table', 'video', 'video', 'image', 'image']);
    expect(figures[0]).toMatchObject({ caption: 'The road north', description: 'A map of the northern road' });
    expect(figures[3].caption).toBe('The ride to the gate');
    expect(figures[4]).toMatchObject({ caption: 'Linked ride', url: 'https://example.com/ride.mp4' });
  });

  it('does not repeat the infobox picture in the text, and restores it', () => {
    const aria = payload.pages.find((p) => p.title === 'Aria Vale') as PayloadPage;
    const portrait = payload.assets.find((a) => a.name === 'portrait of aria.png');
    expect(aria.infobox?.imageAssetId).toBe(portrait?.id);
    expect(aria.content!.content![0].type).toBe('paragraph');
    expect(portrait?.path).toBe('C:/out/Assets/portrait of aria.png');
  });

  it('rebuilds books from scene files, in order', () => {
    const book = payload.books.find((b) => b.title === 'The Silver Road');
    expect(book).toMatchObject({ subtitle: 'Book One', author: 'Élodie "E." Writer', targetWords: 90000 });
    expect(book?.children?.map((n) => [n.kind, n.title])).toEqual([['chapter', 'Arrival'], ['part', 'Part Two: Night']]);
    const arrival = book?.children?.[0];
    expect(arrival?.children?.map((s) => s.title)).toEqual(['The Gate', 'Inside']);
    expect(arrival?.children?.[0]).toMatchObject({ pov: 'Aria Vale', status: 'revised', storyDate: '1 Frost 1220', notes: 'Tighten <this>.' });
    valid(arrival?.children?.[0].content);
    expect(book?.children?.[1].children?.[0].children?.[0].title).toBe('First Snow');
    expect(payload.books.map((b) => b.title)).toContain('Second & Last');
  });
});

describe('a loose Markdown file', () => {
  it('says when a picture beside it cannot be read', () => {
    const { problems } = vault({ 'a.md': '![map](map.png)' });
    expect(problems[0]).toMatchObject({ severity: 'warning', item: 'a.md', field: 'body' });
    expect(problems[0].message).toContain('map.png');
  });
});

describe('plain text', () => {
  it('treats blank lines as paragraphs, and takes no Markdown from it', () => {
    const doc = textToDoc('# not a heading\n\n*not italic*\r\n\r\nthird [[not a link]]');
    expect(doc.content!.length).toBe(3);
    expect(pmToPlainText(doc)).toBe('# not a heading\n\n*not italic*\n\nthird [[not a link]]');
    expect(JSON.stringify(doc)).not.toContain('"marks"');
    valid(doc);
  });

  it('treats each line as a paragraph when there are no blank lines', () => {
    expect(textToDoc('one\ntwo\nthree').content!.length).toBe(3);
  });

  it('joins lines wrapped by a program, and keeps short lines such as verse', () => {
    const wrapped = `${'x'.repeat(70)}\n${'y'.repeat(70)}\nend\n\nnext`;
    expect(textToDoc(wrapped).content![0].content![0].text).toBe(`${'x'.repeat(70)} ${'y'.repeat(70)} end`);
    const verse = textToDoc('short line\nanother\n\nnext');
    expect(verse.content![0].content!.map((n) => n.type)).toEqual(['text', 'hardBreak', 'text']);
    valid(verse);
  });

  it('makes a valid empty document from nothing', () => {
    valid(textToDoc(''));
    valid(textToDoc('\n\n  \n'));
  });

  it('reads common encodings', () => {
    expect(decodeText(new TextEncoder().encode('\uFEFFÉowyn'))).toBe('Éowyn');
    expect(decodeText(new Uint8Array([0xc9, 0x6f]))).toBe('Éo');
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0xc9, 0x00]))).toBe('É');
    expect(decodeText(new Uint8Array([0xfe, 0xff, 0x00, 0xc9]))).toBe('É');
  });

  it('becomes a page or a scene, wherever asked', () => {
    expect(normalizeText('x', { mode: 'page', title: 'T' }).payload.pages[0].title).toBe('T');
    const newBook = normalizeText('x', { mode: 'scene', title: 'T' }).payload.books[0];
    expect(newBook.title).toBe('T');
    expect(newBook.children?.[0].children?.[0]).toMatchObject({ kind: 'scene', title: 'T' });
    const inChapter = normalizeText('x', { mode: 'scene', title: 'T', bookId: 'b', chapterId: 'c' }).payload.books[0];
    expect(inChapter).toMatchObject({ intoBookId: 'b', intoParentId: 'c' });
    expect(inChapter.children?.[0].kind).toBe('scene');
    const inBook = normalizeText('x', { mode: 'scene', title: 'T', bookId: 'b' }).payload.books[0];
    expect(inBook.intoBookId).toBe('b');
    expect(inBook.children?.[0].kind).toBe('chapter');
  });
});

describe('Word documents', () => {
  const html = [
    '<h1>Aria Vale</h1><p>Intro with <strong>bold</strong>, <em>italic</em>, <u>under</u> and a <a href="https://example.com">link</a>.</p>',
    '<h2>Early life</h2><p>Born<sup><a href="#footnote-1" id="footnote-ref-1">[1]</a></sup> in the north.</p>',
    '<ul><li>one</li><li>two</li></ul>',
    '<table><tr><td><p>A</p></td><td><p>B</p></td></tr></table>',
    '<p><img src="data:image/png;base64,AAEC" alt="A sketch"/></p><p class="doc-caption">Figure 3. The road &amp; more</p>',
    '<h1>Silver Vale</h1><p>A valley.</p><p>* * *</p><p>After a break.</p>',
    '<ol><li id="footnote-1"><p>Annals, vol. 2 <a href="#footnote-ref-1">↑</a></p></li></ol>',
  ].join('');

  it('as one page keeps everything, and is a valid document', () => {
    const { payload, problems } = normalizeDocxHtml(html, { mode: 'page', splitLevel: 1, fallbackTitle: 'From the File' });
    expect(problems).toEqual([]);
    expect(payload.pages.length).toBe(1);
    expect(payload.pages[0].title).toBe('From the File');
    valid(payload.pages[0].content);
    const text = pmToPlainText(payload.pages[0].content!);
    expect(text).toContain('Early life');
    expect(text).toContain('Silver Vale');
    const json = JSON.stringify(payload.pages[0].content);
    expect(json).toContain('"type":"bold"');
    expect(json).toContain('"type":"italic"');
    expect(json).toContain('"type":"underline"');
    expect(json).toContain('"href":"https://example.com"');
    expect(json).toContain('"type":"table"');
    expect(json).toContain('"type":"bulletList"');
  });

  it('turns footnotes into citations, removing the list of notes', () => {
    const { payload } = normalizeDocxHtml(html, { mode: 'page', splitLevel: 1, fallbackTitle: 'T' });
    const json = JSON.stringify(payload.pages[0].content);
    expect(json).toContain('"type":"reference"');
    expect(json).toContain('"text":"Annals, vol. 2"');
    expect(pmToPlainText(payload.pages[0].content!)).not.toContain('↑');
  });

  it('turns pictures into assets and figures, with the caption as the label', () => {
    const { payload } = normalizeDocxHtml(html, { mode: 'page', splitLevel: 1, fallbackTitle: 'T' });
    expect(payload.assets.length).toBe(1);
    expect(payload.assets[0]).toMatchObject({ name: 'image-1.png', mime: 'image/png', base64: 'AAEC' });
    const figures = describeFigures(payload.pages[0].content!);
    expect(figures.length).toBe(1);
    expect(figures[0]).toMatchObject({ kind: 'figure', caption: 'The road & more', description: 'A sketch', assetId: payload.assets[0].id });
  });

  it('keeps a picture inside a list valid, and labels a table', () => {
    const { payload, problems } = normalizeDocxHtml(
      '<ul><li><p>Item</p><p><img src="data:image/png;base64,AAEC" alt="In a list"/></p></li></ul><table><tr><td><p>A</p></td></tr></table><p class="doc-caption">Table 1. Ranks</p>',
      { mode: 'page', splitLevel: 1, fallbackTitle: 'T' },
    );
    expect(problems).toEqual([]);
    valid(payload.pages[0].content);
    expect(JSON.stringify(payload.pages[0].content)).not.toContain('asset:import');
    const [figure] = describeFigures(payload.pages[0].content!);
    expect(figure).toMatchObject({ kind: 'table', name: 'Table 1', caption: 'Ranks', media: 'table' });
  });

  it('as pages, splits at headings', () => {
    const { payload } = normalizeDocxHtml(html, { mode: 'pages', splitLevel: 1, fallbackTitle: 'T' });
    expect(payload.pages.map((p) => p.title)).toEqual(['Aria Vale', 'Silver Vale']);
    payload.pages.forEach((p) => valid(p.content));
    expect(pmToPlainText(payload.pages[0].content!)).toContain('Early life');
    const deeper = normalizeDocxHtml(html, { mode: 'pages', splitLevel: 2, fallbackTitle: 'T' }).payload;
    expect(deeper.pages.map((p) => p.title)).toEqual(['Aria Vale', 'Early life', 'Silver Vale']);
  });

  it('as pages, keeps text before the first heading', () => {
    const { payload } = normalizeDocxHtml('<p>Foreword.</p><h1>One</h1><p>x</p>', { mode: 'pages', splitLevel: 1, fallbackTitle: 'Book Name' });
    expect(payload.pages.map((p) => p.title)).toEqual(['Book Name', 'One']);
  });

  it('as a book, makes chapters at Heading 1 and scenes at Heading 2', () => {
    const { payload } = normalizeDocxHtml(
      '<h1>One</h1><h2>Dawn</h2><p>a</p><h2>Dusk</h2><p>b</p><h1>Two</h1><p>c</p><p>* * *</p><p>d</p><p>#</p><p>e</p><p>THE END</p>',
      { mode: 'book', splitLevel: 1, fallbackTitle: 'My Book' },
    );
    const book = payload.books[0];
    expect(book.title).toBe('My Book');
    expect(book.children?.map((c) => [c.kind, c.title])).toEqual([['chapter', 'One'], ['chapter', 'Two']]);
    expect(book.children?.[0].children?.map((s) => s.title)).toEqual(['Dawn', 'Dusk']);
    expect(book.children?.[1].children?.map((s) => [s.title, pmToPlainText(s.content!)])).toEqual([['Scene 1', 'c'], ['Scene 2', 'd'], ['Scene 3', 'e']]);
  });

  it('as a book, understands parts', () => {
    const { payload } = normalizeDocxHtml('<h1>Part One</h1><h2>Ch A</h2><h3>S1</h3><p>a</p><h1>Part Two</h1><h2>Ch B</h2><p>b</p>', { mode: 'book', splitLevel: 1, fallbackTitle: 'B' });
    const top = payload.books[0].children;
    expect(top?.map((c) => [c.kind, c.title])).toEqual([['part', 'Part One'], ['part', 'Part Two']]);
    expect(top?.[0].children?.[0].children?.[0].title).toBe('S1');
  });

  it('as a book, makes a usable book from a document with no headings', () => {
    const { payload } = normalizeDocxHtml('<p>Just text.</p>', { mode: 'book', splitLevel: 1, fallbackTitle: 'Plain' });
    expect(payload.books[0].children?.[0]).toMatchObject({ kind: 'chapter', title: 'Plain' });
    expect(payload.books[0].children?.[0].children?.length).toBe(1);
  });

  it('never runs anything from the document', () => {
    const hostile = parseDocxHtml('<p onclick="x()">Text<script>bad()</script></p><img src="https://evil.example/x.png"/>');
    expect(JSON.stringify(hostile.doc)).not.toContain('evil.example');
    expect(JSON.stringify(hostile.doc)).not.toContain('onclick');
    expect(JSON.stringify(hostile.doc)).not.toContain('bad()');
  });

  it("reads LoreCraft's own Word export back through mammoth", async () => {
    const bytes = await exportDocx(fixtureInput({ scope: 'book', bookId: 'book-1' }));
    const docxHtml = await docxBytesToHtml(bytes.slice().buffer as ArrayBuffer);
    const { payload, problems } = normalizeDocxHtml(docxHtml, { mode: 'book', splitLevel: 1, fallbackTitle: 'Wrong' });
    expect(problems).toEqual([]);
    const book = payload.books[0];
    expect(book).toMatchObject({ title: 'The Silver Road', subtitle: 'Book One', author: 'Élodie "E." Writer' });
    expect(book.children?.map((c) => [c.kind, c.title])).toEqual([['chapter', 'Arrival'], ['part', 'Part Two: Night']]);
    const arrival = book.children?.[0];
    expect(arrival?.children?.length).toBe(2);
    const first = arrival?.children?.[0].content;
    valid(first);
    expect(pmToPlainText(first!)).toContain('Aria rode to the gate');
    const figures = describeFigures(first!);
    expect(figures[0]).toMatchObject({ kind: 'picture', caption: 'Aria, by Silver' });
    expect(JSON.stringify(first)).toContain('"type":"reference"');
    expect(JSON.stringify(first)).toContain('"text":"A source"');
    expect(payload.assets.length).toBeGreaterThan(0);
    expect(book.children?.[1].children?.[0].title).toBe('Snow & Ice');
  }, 60_000);

  it('reads a manuscript-format export back, finding the author in its head', async () => {
    const bytes = await exportDocx(fixtureInput({ scope: 'book', bookId: 'book-2', manuscriptFormat: true }));
    const docxHtml = await docxBytesToHtml(bytes.slice().buffer as ArrayBuffer);
    const { payload } = normalizeDocxHtml(docxHtml, { mode: 'book', splitLevel: 1, fallbackTitle: 'Wrong' });
    expect(payload.books[0].title).toBe('Second & Last');
    expect(payload.books[0].children?.[0].title).toBe('Only Chapter');
    expect(pmToPlainText(payload.books[0].children![0].children![0].content!)).toBe('The end of it all.');
  }, 60_000);
});
