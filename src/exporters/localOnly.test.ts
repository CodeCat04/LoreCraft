/**
 * The local-only mark in exports. Formats that come back, and raw data, carry it. Formats
 * for other AI tools leave marked things out unless the writer asks, as the MCP server does.
 * Books and sites are for people, so they keep everything.
 */

import { parse as parseCsv } from 'csv-parse/sync';
import { strFromU8, unzipSync } from 'fflate';
import { parse as parseYaml } from 'yaml';

import { normalizeLorebookFile } from './import/lorebookFile';
import { normalizeMarkdownFiles } from './import/markdownFiles';
import type { PayloadNode } from './import/types';
import { exportDocx } from './novel/docx';
import { exportEpub } from './novel/epub';
import { exportNovelText } from './novel/text';
import { buildNovelPrintDocument, buildWikiPrintDocument } from './print/document';
import { formatById } from './registry';
import { fixtureInput, fixtureSnapshot } from './testFixture';
import type { ExportOptions, ExportSnapshot } from './types';
import { exportCsv } from './wiki/csv';
import { exportJson } from './wiki/json';
import { exportJsonl } from './wiki/jsonl';
import { exportMarkdown } from './wiki/markdown';
import { exportMediaWiki } from './wiki/mediawiki';
import { exportSillyTavern } from './wiki/sillytavern';
import { exportSite } from './wiki/site';
import { exportXml } from './wiki/xml';
import { exportYaml } from './wiki/yaml';

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** Silver Vale, the scene "First Snow", and the whole chapter "Only Chapter" are marked. */
function marked(): ExportSnapshot {
  const snapshot = fixtureSnapshot();
  snapshot.pages.find((p) => p.id === 'silver')!.localOnly = true;
  snapshot.nodes.find((n) => n.id === 'scene-snow')!.localOnly = true;
  snapshot.nodes.find((n) => n.id === 'ch-3')!.localOnly = true;
  return snapshot;
}

const input = (options: Partial<ExportOptions> = {}, warnings?: string[]) => fixtureInput(options, marked(), warnings);

function flatten(nodes: PayloadNode[]): PayloadNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children ?? [])]);
}

describe('formats that import back carry the mark', () => {
  it('JSON writes it on pages, scenes and chapters, and the importer reads it', () => {
    const file = JSON.parse(decode(exportJson(input())));
    expect(file.pages.find((p: { title: string }) => p.title === 'Silver Vale').localOnly).toBe(true);
    expect(file.pages.find((p: { title: string }) => p.title === 'Aria Vale').localOnly).toBe(false);
    const { payload, problems } = normalizeLorebookFile(file);
    expect(problems.filter((p) => p.field === 'localOnly')).toEqual([]);
    expect(payload.pages.find((p) => p.title === 'Silver Vale')?.localOnly).toBe(true);
    expect(payload.pages.find((p) => p.title === 'Aria Vale')?.localOnly).toBe(false);
    const nodes = flatten(payload.books.flatMap((b) => b.children ?? []));
    expect(nodes.find((n) => n.title === 'First Snow')?.localOnly).toBe(true);
    expect(nodes.find((n) => n.title === 'Only Chapter')?.localOnly).toBe(true);
    expect(nodes.find((n) => n.title === 'The Gate')?.localOnly).toBe(false);
  });

  it('YAML does the same', () => {
    const { payload } = normalizeLorebookFile(parseYaml(decode(exportYaml(input()))));
    expect(payload.pages.find((p) => p.title === 'Silver Vale')?.localOnly).toBe(true);
    expect(flatten(payload.books.flatMap((b) => b.children ?? [])).find((n) => n.title === 'First Snow')?.localOnly).toBe(true);
  });

  it('a mark that is not true or false is an error naming the field', () => {
    const { problems } = normalizeLorebookFile({ format: 'lorebook', version: 1, pages: [{ title: 'X', localOnly: 'yes' }] });
    expect(problems).toContainEqual(expect.objectContaining({ severity: 'error', field: 'localOnly' }));
  });

  it('Markdown writes it in front matter, scenes take their chapter\'s, and the importer reads it', () => {
    const files = unzipSync(exportMarkdown(input()));
    const text = (end: string) => strFromU8(files[Object.keys(files).find((path) => path.endsWith(end))!]);
    expect(text('Silver Vale.md')).toContain('local_only: true');
    expect(text('Aria Vale.md')).not.toContain('local_only');
    expect(text('First Snow.md')).toContain('local_only: true');
    expect(text('Only Scene.md')).toContain('local_only: true');
    expect(text('The Gate.md')).not.toContain('local_only');

    const list = Object.entries(files).filter(([path]) => path.endsWith('.md')).map(([path, bytes]) => ({ path, text: strFromU8(bytes) }));
    const others = Object.keys(files).filter((path) => !path.endsWith('.md'));
    const { payload } = normalizeMarkdownFiles(list, others, 'C:/out');
    expect(payload.pages.find((p) => p.title === 'Silver Vale')?.localOnly).toBe(true);
    expect(payload.pages.find((p) => p.title === 'Aria Vale')?.localOnly).toBeUndefined();
    const scenes = flatten(payload.books.flatMap((b) => b.children ?? []));
    expect(scenes.find((n) => n.title === 'First Snow')?.localOnly).toBe(true);
    expect(scenes.find((n) => n.title === 'Only Scene')?.localOnly).toBe(true);
    expect(scenes.find((n) => n.title === 'The Gate')?.localOnly).toBeUndefined();
  });

  it('a hand-written vault may write it in other ways', () => {
    const note = (name: string, front: string) => ({ path: `${name}.md`, text: `---\n${front}\n---\nText.` });
    const { payload } = normalizeMarkdownFiles([note('A', 'localOnly: true'), note('B', 'local-only: yes'), note('C', 'local_only: false')], [], 'C:/v');
    expect(payload.pages.map((p) => [p.title, p.localOnly])).toEqual([['A', true], ['B', true], ['C', undefined]]);
  });
});

describe('raw data carries the mark', () => {
  it('XML has a localOnly attribute on marked pages, chapters and scenes', () => {
    const xml = new DOMParser().parseFromString(decode(exportXml(input())), 'application/xml');
    const page = (title: string) => [...xml.getElementsByTagName('page')].find((p) => p.getAttribute('title') === title)!;
    expect(page('Silver Vale').getAttribute('localOnly')).toBe('true');
    expect(page('Aria Vale').hasAttribute('localOnly')).toBe(false);
    const scene = [...xml.getElementsByTagName('scene')].find((s) => s.getAttribute('title') === 'First Snow')!;
    expect(scene.getAttribute('localOnly')).toBe('true');
    const chapter = [...xml.getElementsByTagName('chapter')].find((s) => s.getAttribute('title') === 'Only Chapter')!;
    expect(chapter.getAttribute('localOnly')).toBe('true');
  });

  it('CSV has a local_only column for pages and scenes', () => {
    const read = (text: string) => parseCsv(text.replace(/^\uFEFF/, ''), { columns: true }) as Record<string, string>[];
    const pages = read(decode(exportCsv(input())));
    expect(pages.find((r) => r.title === 'Silver Vale')?.local_only).toBe('true');
    expect(pages.find((r) => r.title === 'Aria Vale')?.local_only).toBe('false');
    const bundle = unzipSync(exportCsv(input({ csvBundle: true })));
    const scenes = read(strFromU8(bundle['scenes.csv']));
    expect(scenes.find((r) => r.title === 'First Snow')?.local_only).toBe('true');
    expect(scenes.find((r) => r.title === 'Only Scene')?.local_only).toBe('true');
    expect(scenes.find((r) => r.title === 'The Gate')?.local_only).toBe('false');
  });
});

describe('formats for other AI tools leave marked things out unless asked', () => {
  it('offer the choice on the export screen, off by default', () => {
    expect(formatById('sillytavern').options).toContain('includeLocalOnly');
    expect(formatById('jsonl').options).toContain('includeLocalOnly');
    expect(fixtureInput().options.includeLocalOnly).toBe(false);
    for (const id of ['json', 'yaml', 'markdown', 'csv', 'xml', 'mediawiki', 'site', 'epub', 'docx', 'novel-pdf', 'wiki-pdf'] as const) {
      expect(formatById(id).options, id).not.toContain('includeLocalOnly');
    }
  });

  it('SillyTavern', () => {
    const warnings: string[] = [];
    const entries = (options: Partial<ExportOptions>, w?: string[]) =>
      Object.values(JSON.parse(decode(exportSillyTavern(input({ scope: 'wiki', ...options }, w)))).entries) as { comment: string; content: string }[];
    const plain = entries({}, warnings);
    expect(plain.map((e) => e.comment)).not.toContain('Silver Vale');
    expect(plain.map((e) => e.comment)).toContain('Aria Vale');
    expect(warnings.join(' ')).toContain('marked local only were left out');
    const asked = entries({ includeLocalOnly: true });
    expect(asked.find((e) => e.comment === 'Silver Vale')?.content).toContain('Home of');
  });

  it('JSONL, scenes in a marked chapter too, and says which records are marked when asked', () => {
    const lines = (options: Partial<ExportOptions>) =>
      decode(exportJsonl(input(options))).trim().split('\n').map((line) => JSON.parse(line) as { title: string; localOnly: boolean });
    const plain = lines({});
    const titles = plain.map((l) => l.title);
    expect(titles).not.toContain('Silver Vale');
    expect(titles).not.toContain('First Snow');
    expect(titles).not.toContain('Only Scene');
    expect(titles).toContain('The Gate');
    expect(plain.every((l) => l.localOnly === false)).toBe(true);
    const asked = lines({ includeLocalOnly: true });
    expect(asked.find((l) => l.title === 'Silver Vale')?.localOnly).toBe(true);
    expect(asked.find((l) => l.title === 'Only Scene')?.localOnly).toBe(true);
    expect(asked.find((l) => l.title === 'The Gate')?.localOnly).toBe(false);
  });
});

describe('formats for people keep everything', () => {
  const book2 = { scope: 'book', bookId: 'book-2' } as const;

  it('EPUB', () => {
    const files = unzipSync(exportEpub(input(book2)));
    const text = Object.keys(files).filter((n) => n.endsWith('.xhtml')).map((n) => strFromU8(files[n])).join('');
    expect(text).toContain('The end of it all.');
  });

  it('Word', async () => {
    const files = unzipSync(await exportDocx(input(book2)));
    expect(strFromU8(files['word/document.xml'])).toContain('The end of it all.');
  });

  it('PDF, plain text, the website and MediaWiki', () => {
    expect(buildNovelPrintDocument(input(book2)).html).toContain('The end of it all.');
    expect(decode(exportNovelText(input(book2)))).toContain('The end of it all.');
    expect(buildWikiPrintDocument(input({ scope: 'wiki' })).html).toContain('Home of');
    const site = unzipSync(exportSite(input({ scope: 'wiki' })));
    expect(Object.keys(site).some((n) => n.endsWith('.html') && strFromU8(site[n]).includes('Home of'))).toBe(true);
    expect(decode(exportMediaWiki(input({ scope: 'wiki' })))).toContain('<title>Silver Vale</title>');
  });
});
