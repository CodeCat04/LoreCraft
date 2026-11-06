/** Every wiki data format, read back with a real parser. */

import { createHash } from 'node:crypto';

import { parse as parseCsv } from 'csv-parse/sync';
import { strFromU8, unzipSync } from 'fflate';
import { parse as parseYaml } from 'yaml';

import { markdownToPm, pmToPlainText } from '../editor/convert';
import { titleKey } from '../lib/text';
import type { PmNode } from '../lib/types';
import { applyScope } from './scope';
import { AWKWARD_TEXT, fixtureInput, fixtureSnapshot } from './testFixture';
import { exportCsv } from './wiki/csv';
import { exportJson } from './wiki/json';
import { exportJsonl } from './wiki/jsonl';
import { exportMarkdown } from './wiki/markdown';
import { exportMediaWiki, mediaWikiSha1, mediaWikiTitle } from './wiki/mediawiki';
import { exportSillyTavern } from './wiki/sillytavern';
import { exportSite, SITE_CSP } from './wiki/site';
import { exportXml } from './wiki/xml';
import { exportYaml } from './wiki/yaml';
import { base64ToBytes, safeFileName, slugify, utf8 } from './util';

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function parseXml(text: string): Document {
  const parsed = new DOMParser().parseFromString(text, 'application/xml');
  const error = parsed.querySelector('parsererror');
  if (error) throw new Error(`Not well-formed: ${error.textContent}`);
  return parsed;
}

describe('the checks themselves', () => {
  it('the XML parser refuses what it should', () => {
    expect(() => parseXml('<a><b></a>')).toThrow();
    expect(() => parseXml('<a>\u0001</a>')).toThrow();
    expect(() => parseXml('<a>&nope;</a>')).toThrow();
    expect(() => parseXml('<a>]]></a>')).toThrow();
    expect(parseXml('<a>fine &amp; good</a>').documentElement.textContent).toBe('fine & good');
  });
});

describe('file names', () => {
  it.each([
    ['CON', 'CON_'],
    ['con', 'con_'],
    ['aux.txt', 'aux_.txt'],
    ['COM1', 'COM1_'],
    ['LPT9.md', 'LPT9_.md'],
    ['Console', 'Console'],
    ['a<b>c:d"e/f\\g|h?i*j', 'a_b_c_d_e_f_g_h_i_j'],
    ['trailing dots...', 'trailing dots'],
    ['...dots...', '_dots'],
    ['  spaces  ', 'spaces'],
    ['tab\tand\nnewline', 'tab_and_newline'],
    ['ctrl\u0001char', 'ctrlchar'],
    ['#^[]', '____'],
    ['', 'Untitled'],
    ['...', 'Untitled'],
    ['龍の名前', '龍の名前'],
    ['Éowyn', 'Éowyn'],
  ])('%j becomes %j', (input, expected) => {
    expect(safeFileName(input)).toBe(expected);
  });

  it('keeps long names to a safe length without splitting a character', () => {
    const long = '🐉'.repeat(300);
    const safe = safeFileName(long);
    expect([...safe].length).toBeLessThanOrEqual(100);
    expect(safe.endsWith('🐉')).toBe(true);
  });

  it('makes ASCII addresses for the site', () => {
    expect(slugify('Éowyn "Red" Þórr')).toBe('eowyn-red-orr');
    expect(slugify('龍の名前')).toBe('');
    expect(slugify('CON')).toBe('con-page');
  });
});

describe('JSON', () => {
  const file = JSON.parse(decode(exportJson(fixtureInput())));

  it('keeps documents exactly, with every figure attribute', () => {
    const source = fixtureSnapshot();
    for (const page of source.pages) {
      const out = file.pages.find((p: { title: string }) => p.title === page.title);
      expect(out.content).toEqual(page.content);
      expect(out.infobox).toEqual(page.infobox);
      expect(out.aliases).toEqual(page.aliases);
      expect(out.categories).toEqual(page.categories);
      expect(out.status).toBe(page.status);
      expect(out.notes).toEqual(page.notes);
    }
    const figures = JSON.stringify(file.pages.find((p: { id: string }) => p.id === 'aria').content);
    expect(figures).toContain('"align":"right"');
    expect(figures).toContain('"width":45');
    expect(figures).toContain('"description":"A map of the northern road"');
  });

  it('keeps the manuscript tree in order', () => {
    const book = file.books[0];
    expect(book.children.map((n: { title: string }) => n.title)).toEqual(['Arrival', 'Part Two: Night']);
    expect(book.children[0].children.map((n: { title: string }) => n.title)).toEqual(['The Gate', 'Inside']);
    expect(book.children[1].children[0].children[0].title).toBe('First Snow');
    expect(book.children[0].children[0].pov).toBe('Aria Vale');
    expect(book.children[0].children[0].content).toEqual(fixtureSnapshot().nodes[1].content);
    expect(book.writingLog).toEqual([{ day: '2024-03-01', wordsAdded: 500, wordsRemoved: 20 }]);
  });

  it('carries relationships by name, and assets, maps and the rest', () => {
    expect(file.relationships[0]).toMatchObject({ from: 'Aria Vale', to: 'Silver Vale', kind: 'born in' });
    expect(file.assets.find((a: { id: string }) => a.id === 'asset-map').base64).toBeTruthy();
    expect(file.maps[0].pins[0].page).toBe('Silver Vale');
    expect(file.dictionary).toEqual(['Aelindor', 'Þórr']);
    expect(file.prompts[0].name).toBe('Tone');
    expect(file.project.meta['wiki.setting']).toBe('kept');
  });

  it('marks a file too large to carry instead of loading it', () => {
    const warnings: string[] = [];
    const parsed = JSON.parse(decode(exportJson(fixtureInput({}, undefined, warnings))));
    const huge = parsed.assets.find((a: { id: string }) => a.id === 'asset-huge');
    expect(huge.omitted).toBe(true);
    expect(huge.base64).toBeUndefined();
    expect(warnings.join()).toContain('whole film.mp4');
  });

  it('narrows to the wiki or one book', () => {
    const wiki = JSON.parse(decode(exportJson(fixtureInput({ scope: 'wiki' }))));
    expect(wiki.books).toEqual([]);
    expect(wiki.pages.length).toBe(fixtureSnapshot().pages.length);
    const book = JSON.parse(decode(exportJson(fixtureInput({ scope: 'book', bookId: 'book-2' }))));
    expect(book.pages).toEqual([]);
    expect(book.books.map((b: { title: string }) => b.title)).toEqual(['Second & Last']);
    expect(book.dictionary).toEqual([]);
  });
});

describe('filters', () => {
  const titles = (options: object) => applyScope(fixtureSnapshot(), { ...fixtureInput().options, ...options }).snapshot.pages.map((p) => p.title);

  it('canon only leaves out everything else', () => {
    const shown = titles({ canonOnly: true });
    expect(shown).toContain('Aria Vale');
    expect(shown).not.toContain('Rough Draft');
    expect(shown).not.toContain('Old Tale');
    expect(shown).not.toContain('aux.txt');
  });

  it('drafts and retconned pages can each be left out', () => {
    expect(titles({ includeDrafts: false })).not.toContain('Rough Draft');
    expect(titles({ includeDrafts: false })).toContain('Old Tale');
    expect(titles({ includeRetconned: false })).not.toContain('Old Tale');
    expect(titles({ includeRetconned: false })).toContain('Rough Draft');
  });

  it('relationships and asset lists follow the pages', () => {
    const { snapshot, excludedPages } = applyScope(fixtureSnapshot(), { ...fixtureInput().options, includeRetconned: false, scope: 'wiki' });
    expect(snapshot.relationships.length).toBe(1);
    expect(excludedPages.has(titleKey('Old Tale'))).toBe(true);
    expect(snapshot.assets.map((a) => a.id)).not.toContain('asset-unused');
  });

  it('scene filters drop emptied chapters and keep unstarted ones', () => {
    const options = { ...fixtureInput().options, scope: 'books' as const, scenes: 'revised' as const };
    const { snapshot } = applyScope(fixtureSnapshot(), options);
    const names = snapshot.nodes.map((n) => n.title);
    expect(names).toContain('The Gate');
    expect(names).not.toContain('Inside');
    expect(names).not.toContain('Only Chapter');
    expect(names).toContain('First Snow');
    expect(snapshot.nodes.find((n) => n.id === 'ch-empty')).toBeDefined();
  });
});

describe('JSONL', () => {
  const lines = decode(exportJsonl(fixtureInput())).split('\n');

  it('has one parseable record per page and scene, and ends with a newline', () => {
    expect(lines.pop()).toBe('');
    const records = lines.map((line) => JSON.parse(line));
    const source = fixtureSnapshot();
    expect(records.filter((r) => r.kind === 'page').length).toBe(source.pages.length);
    expect(records.filter((r) => r.kind === 'scene').length).toBe(source.nodes.filter((n) => n.kind === 'scene').length);
  });

  it('carries plain text and context, with figures named', () => {
    const records = lines.map((line) => JSON.parse(line));
    const aria = records.find((r) => r.title === 'Aria Vale');
    expect(aria.text).toContain('Éowyn Þórr');
    expect(aria.text).toContain('[Figure 1: The road north (A map of the northern road)]');
    expect(aria.text).not.toContain('{"type"');
    expect(aria.links).toContain('Missing <Page> & Co');
    expect(aria.infobox.born).toBe('12 Frost 1204');
    expect(aria.figures.map((f: { name: string }) => f.name)).toContain('Video 2');
    const gate = records.find((r) => r.title === 'The Gate');
    expect(gate).toMatchObject({ book: 'The Silver Road', chapter: 'Arrival', part: null, pov: 'Aria Vale' });
    expect(records.find((r) => r.title === 'First Snow').part).toBe('Part Two: Night');
  });
});

describe('CSV', () => {
  const rows = (text: string) => parseCsv(text.replace(/^\uFEFF/, ''), { columns: true, relaxColumnCount: false, skipEmptyLines: true }) as Record<string, string>[];

  it('starts with a byte order mark and uses CRLF', () => {
    const bytes = exportCsv(fixtureInput());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(decode(bytes)).toContain('\r\n');
  });

  it('reads back through a real CSV parser with awkward values intact', () => {
    const table = rows(decode(exportCsv(fixtureInput())));
    const source = fixtureSnapshot();
    expect(table.length).toBe(source.pages.length);
    const aria = table.find((r) => r.title === 'Aria Vale')!;
    expect(aria.aliases).toBe('The Ranger; Éowyn "Red" Þórr');
    expect(aria.categories).toBe('Characters; Rangers & Scouts');
    expect(aria.infobox_born).toBe('12 Frost 1204');
    expect(aria.text).toContain('<angle> & ampersand');
    expect(aria.text).toContain('"double"');
    expect(table.find((r) => r.title === 'Silver Vale')!.infobox_born).toBe('');
    expect(table.find((r) => r.id === 'formula')!.text).toContain('-5 cold, "quoted", and,\ncommas');
  });

  it('guards formulas by default, and can leave text exactly as it is', () => {
    const guarded = rows(decode(exportCsv(fixtureInput())));
    const row = guarded.find((r) => r.id === 'formula')!;
    expect(row.title).toBe("'=SUM(A1:A9)");
    expect(row.summary).toBe("'+1 sword");
    expect(row.text.startsWith("'-5")).toBe(true);
    const raw = rows(decode(exportCsv(fixtureInput({ csvGuardFormulas: false }))));
    expect(raw.find((r) => r.id === 'formula')!.title).toBe('=SUM(A1:A9)');
  });

  it('makes a zip of three tables on request', () => {
    const files = unzipSync(exportCsv(fixtureInput({ csvBundle: true })));
    expect(Object.keys(files).sort()).toEqual(['pages.csv', 'relationships.csv', 'scenes.csv']);
    for (const bytes of Object.values(files)) expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const scenes = rows(strFromU8(files['scenes.csv']));
    const gate = scenes.find((r) => r.title === 'The Gate')!;
    expect(gate).toMatchObject({ book: 'The Silver Road', chapter: 'Arrival', pov: 'Aria Vale', story_date: '1 Frost 1220', status: 'revised' });
    expect(scenes.find((r) => r.title === 'First Snow')!.part).toBe('Part Two: Night');
    const rels = rows(strFromU8(files['relationships.csv']));
    expect(rels[0]).toMatchObject({ from: 'Aria Vale', to: 'Silver Vale', kind: 'born in', note: 'North "side", <here>' });
  });
});

describe('YAML', () => {
  it('parses back to the same data as JSON when asked for ProseMirror', () => {
    const yaml = parseYaml(decode(exportYaml(fixtureInput({ bodyFormat: 'prosemirror' }))));
    const json = JSON.parse(decode(exportJson(fixtureInput())));
    expect(yaml).toEqual(json);
  });

  it('writes readable Markdown by default, with no anchors', () => {
    const text = decode(exportYaml(fixtureInput()));
    expect(text).not.toMatch(/(^|\s)[&*]a\d+\b/);
    const parsed = parseYaml(text);
    const aria = parsed.pages.find((p: { title: string }) => p.title === 'Aria Vale');
    expect(typeof aria.content).toBe('string');
    expect(aria.content).toContain('**Aria**');
    expect(aria.content).toContain('[[Silver Vale|the Vale]]');
    expect(pmToPlainText(markdownToPm(aria.content))).toContain('Éowyn Þórr');
  });

  it('survives control characters', () => {
    const parsed = parseYaml(decode(exportYaml(fixtureInput({ bodyFormat: 'prosemirror' }))));
    const aria = parsed.pages.find((p: { title: string }) => p.title === 'Aria Vale');
    expect(JSON.stringify(aria.content)).toContain('control\\u0001char');
  });
});

describe('XML', () => {
  const xml = parseXml(decode(exportXml(fixtureInput())));
  const page = (title: string) => [...xml.querySelectorAll('page')].find((p) => p.getAttribute('title') === title)!;

  it('is well-formed with the documented structure', () => {
    expect(xml.documentElement.localName).toBe('lorebook');
    expect(xml.querySelectorAll('page').length).toBe(fixtureSnapshot().pages.length);
    const aria = page('Aria Vale');
    expect(aria.getAttribute('status')).toBe('canon');
    expect([...aria.querySelectorAll('aliases > alias')].map((a) => a.textContent)).toEqual(['The Ranger', 'Éowyn "Red" Þórr']);
    expect(aria.querySelector('infobox > field[key="born"]')!.textContent).toBe('12 Frost 1204');
    expect(aria.querySelector('body')!.getAttribute('format')).toBe('markdown');
    expect(aria.querySelector('figures > figure[name="Picture 1"] > caption')!.textContent).toBe('Aria, by Silver');
    expect(aria.querySelector('talk > body')!.textContent).toContain('Check her age');
    expect(xml.querySelector('book part chapter scene')!.getAttribute('title')).toBe('First Snow');
    expect(xml.querySelector('relationship')!.getAttribute('kind')).toBe('born in');
  });

  it('keeps awkward text and removes only what XML cannot hold', () => {
    const body = page('Aria Vale').querySelector('text')!.textContent!;
    expect(body).toContain('<angle> & ampersand');
    expect(body).toContain('CDATA end');
    expect(body).toContain('🐉');
    expect(body).toContain('controlchar');
    expect(body).not.toContain('\u0001');
    expect(page('A|B [draft] <x> #1')).toBeDefined();
  });

  it('can hold ProseMirror JSON, with the text still safe', () => {
    const doc = parseXml(decode(exportXml(fixtureInput({ bodyFormat: 'prosemirror' }))));
    const body = doc.querySelector('page[title="Aria Vale"] > body')!;
    expect(body.getAttribute('format')).toBe('prosemirror-json');
    expect(JSON.parse(body.textContent!).type).toBe('doc');
  });

  it('holds up with a name full of markup', () => {
    const snapshot = fixtureSnapshot();
    snapshot.meta.name = 'A "b" <c> & \'d\' \u0002';
    const doc = parseXml(decode(exportXml(fixtureInput({}, snapshot))));
    expect(doc.documentElement.getAttribute('name')).toBe('A "b" <c> & \'d\' ');
  });
});

describe('Markdown vault', () => {
  const files = unzipSync(exportMarkdown(fixtureInput()));
  const paths = Object.keys(files);
  const read = (path: string) => strFromU8(files[path]);

  function frontMatter(text: string): Record<string, unknown> {
    const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
    if (!match) throw new Error(`No front matter in: ${text.slice(0, 80)}`);
    return parseYaml(match[1]);
  }

  it('has one file per page with safe names', () => {
    const wiki = paths.filter((p) => p.startsWith('Wiki/'));
    expect(wiki.length).toBe(fixtureSnapshot().pages.length);
    expect(wiki).toContain('Wiki/CON_.md');
    expect(wiki).toContain('Wiki/aux_.txt.md');
    expect(wiki).toContain('Wiki/What_ Why_ _Yes_.md');
    expect(wiki).toContain('Wiki/What_ Why_ _Yes_ (2).md');
    expect(wiki).toContain('Wiki/龍の名前.md');
    for (const path of paths) {
      for (const part of path.split('/')) {
        expect(part).not.toMatch(/[<>:"\\|?*\u0000-\u001f]/);
        expect(part).not.toMatch(/[. ]$/);
        expect(part).not.toMatch(/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i);
      }
    }
    expect(new Set(paths.map((p) => p.toLowerCase())).size).toBe(paths.length);
  });

  it('writes front matter a YAML parser reads back exactly', () => {
    const fields = frontMatter(read('Wiki/Aria Vale.md'));
    expect(fields.title).toBe('Aria Vale');
    expect(fields.aliases).toEqual(['The Ranger', 'Éowyn "Red" Þórr']);
    expect(fields.categories).toEqual(['Characters', 'Rangers & Scouts']);
    expect(fields.tags).toEqual(['Characters', 'Rangers-Scouts']);
    expect(fields.status).toBe('canon');
    expect(fields.type).toBe('character');
    expect((fields.infobox as { fields: { key: string }[] }).fields[0].key).toBe('born');
    expect(frontMatter(read('Wiki/What_ Why_ _Yes_.md')).title).toBe('What? Why: "Yes"');
  });

  it('links by file name, as Obsidian does, keeping labels and red links', () => {
    const aria = read('Wiki/Aria Vale.md');
    expect(aria).toContain('[[Silver Vale|the Vale]]');
    // An alias has no file of its own, so the link goes to the real one.
    expect(aria).toContain('[[Aria Vale|Ranger]]');
    expect(aria).toContain('[[Missing _Page_ & Co|a missing page]]');
    expect(aria).toContain('[[CON_|CON]]');
    expect(read('Wiki/Main Page.md')).toContain('[[Aria Vale|Aria]]');
  });

  it('holds the images, and points at them relative to each file', () => {
    expect(paths).toContain('Assets/map_north_.png');
    expect(paths).toContain('Assets/portrait of aria.png');
    expect(paths).toContain('Assets/ride.mp4');
    const aria = read('Wiki/Aria Vale.md');
    expect(aria).toContain('![The road north](../Assets/map_north_.png "A map of the northern road")');
    expect(aria).toContain('![The ride to the gate](../Assets/ride.mp4 "Riders in snow")');
    expect(aria).toContain('![Linked ride](https://example.com/ride.mp4)');
    expect(aria).toContain('[Video 3: Too large to carry');
    expect(aria).toContain('not included');
    expect(paths).not.toContain('Assets/whole film.mp4');
    const scene = read('Manuscript/The Silver Road/01 Arrival/01 The Gate.md');
    expect(scene).toContain('](../../../Assets/portrait%20of%20aria.png');
    expect(frontMatter(read('Wiki/Aria Vale.md'))).toHaveProperty('infobox.image', 'Assets/portrait of aria.png');
  });

  it('puts scenes in folders by book and chapter, with what rebuilds the tree', () => {
    expect(paths).toContain('Manuscript/The Silver Road/_book.md');
    expect(paths).toContain('Manuscript/The Silver Road/01 Part Two_ Night/02 Snow & Ice/01 First Snow.md');
    expect(paths).toContain('Manuscript/Second & Last/01 Only Chapter/01 Only Scene.md');
    const fields = frontMatter(read('Manuscript/The Silver Road/01 Arrival/01 The Gate.md'));
    expect(fields).toMatchObject({ kind: 'scene', book: 'The Silver Road', chapter: 'Arrival', status: 'revised', pov: 'Aria Vale', order: 1 });
    expect(frontMatter(read('Manuscript/The Silver Road/_book.md'))).toMatchObject({ kind: 'book', author: 'Élodie "E." Writer' });
  });

  it('body text reads back through the same parser the importer uses', () => {
    const body = read('Wiki/Aria Vale.md').replace(/^---\n[\s\S]*?\n---\n/, '');
    const plain = pmToPlainText(markdownToPm(body));
    expect(plain).toContain('<angle> & ampersand');
    expect(plain).toContain('[[not a link]]');
    expect(plain).toContain('* not a list');
    expect(plain).toContain('Level 1');
  });

  it('narrows to the wiki or one book', () => {
    const wikiOnly = Object.keys(unzipSync(exportMarkdown(fixtureInput({ scope: 'wiki' }))));
    expect(wikiOnly.some((p) => p.startsWith('Manuscript/'))).toBe(false);
    const oneBook = Object.keys(unzipSync(exportMarkdown(fixtureInput({ scope: 'book', bookId: 'book-2' }))));
    expect(oneBook.some((p) => p.startsWith('Wiki/'))).toBe(false);
    expect(oneBook).toContain('Manuscript/Second & Last/_book.md');
  });
});

describe('SillyTavern', () => {
  const file = JSON.parse(decode(exportSillyTavern(fixtureInput({ scope: 'wiki', includeRetconned: false }))));
  const entries: Record<string, unknown>[] = Object.values(file.entries);
  const entry = (title: string) => entries.find((e) => e.comment === title) as Record<string, unknown>;

  /** The fields SillyTavern's own template gives a new entry (world-info.js). */
  const TEMPLATE_FIELDS = [
    'key', 'keysecondary', 'comment', 'content', 'constant', 'vectorized', 'selective', 'selectiveLogic', 'addMemo',
    'order', 'position', 'disable', 'ignoreBudget', 'excludeRecursion', 'preventRecursion', 'matchPersonaDescription',
    'matchCharacterDescription', 'matchCharacterPersonality', 'matchCharacterDepthPrompt', 'matchScenario',
    'matchCreatorNotes', 'delayUntilRecursion', 'probability', 'useProbability', 'depth', 'outletName', 'group',
    'groupOverride', 'groupWeight', 'scanDepth', 'caseSensitive', 'matchWholeWords', 'useGroupScoring', 'automationId',
    'role', 'sticky', 'cooldown', 'delay', 'triggers',
  ];

  it('has the shape SillyTavern expects', () => {
    expect(file).toHaveProperty('entries');
    const aria = entry('Aria Vale');
    for (const field of TEMPLATE_FIELDS) expect(aria).toHaveProperty(field);
    // SillyTavern's editor finds an entry by its own uid, so it must be the entry's key.
    const pairs = Object.entries(file.entries as Record<string, { uid: number; displayIndex: number }>);
    expect(pairs.length).toBeGreaterThan(5);
    pairs.forEach(([key, value], index) => {
      expect(value.uid).toBe(Number(key));
      expect(value.uid).toBe(index);
      expect(value.displayIndex).toBe(index);
    });
  });

  it('trims keys and drops empty ones, since SillyTavern matches a blank key to every message', () => {
    const snapshot = fixtureSnapshot();
    const aria = snapshot.pages.find((p) => p.id === 'aria')!;
    aria.title = '  Aria Vale ';
    aria.aliases = ['The Ranger', '   ', ' The Ranger', ''];
    const made = JSON.parse(decode(exportSillyTavern(fixtureInput({ scope: 'wiki' }, snapshot))));
    const keys = (Object.values(made.entries) as { key: string[] }[]).map((e) => e.key);
    expect(keys).toContainEqual(['Aria Vale', 'The Ranger']);
    for (const list of keys) for (const key of list) expect(key.trim()).toBe(key);
    for (const list of keys) expect(list.length).toBeGreaterThan(0);
  });

  it('leaves out a page with nothing to say, which SillyTavern would skip anyway', () => {
    expect(entry('Empty Page')).toBeUndefined();
    for (const value of entries) expect(String(value.content).trim()).not.toBe('');
  });

  it('keys on title and aliases, with content from plain text and figure labels', () => {
    const aria = entry('Aria Vale');
    expect(aria.key).toEqual(['Aria Vale', 'The Ranger', 'Éowyn "Red" Þórr']);
    expect(aria.content).toContain('Born: 12 Frost 1204');
    expect(aria.content).toContain('Éowyn Þórr');
    expect(aria.content).toContain('[Picture 1: Aria, by Silver]');
    expect(aria.content).not.toContain('{"type"');
  });

  it('leaves out retconned pages by default, and the main page always', () => {
    expect(entry('Old Tale')).toBeUndefined();
    expect(entry('Main Page')).toBeUndefined();
    const all = JSON.parse(decode(exportSillyTavern(fixtureInput({ scope: 'wiki', includeRetconned: true }))));
    expect(Object.values(all.entries).some((e) => (e as { comment: string }).comment === 'Old Tale')).toBe(true);
  });

  it('can leave the infobox out', () => {
    const file2 = JSON.parse(decode(exportSillyTavern(fixtureInput({ scope: 'wiki', infoboxInContent: false }))));
    const aria = Object.values(file2.entries).find((e) => (e as { comment: string }).comment === 'Aria Vale') as { content: string };
    expect(aria.content).not.toContain('Born:');
  });
});

describe('MediaWiki', () => {
  const xml = parseXml(decode(exportMediaWiki(fixtureInput({ scope: 'wiki' }))));
  const pages = [...xml.getElementsByTagName('page')];
  const byTitle = (title: string) => pages.find((p) => p.getElementsByTagName('title')[0].textContent === title);
  const wikitext = (title: string) => byTitle(title)!.getElementsByTagName('text')[0].textContent!;

  it('uses schema 0.11 with the elements it requires, in order', () => {
    const root = xml.documentElement;
    expect(root.namespaceURI).toBe('http://www.mediawiki.org/xml/export-0.11/');
    expect(root.getAttribute('version')).toBe('0.11');
    expect(root.getAttribute('xml:lang')).toBe('en');
    const revision = byTitle('Silver Vale')!.getElementsByTagName('revision')[0];
    expect([...revision.children].map((c) => c.localName)).toEqual([
      'id', 'timestamp', 'contributor', 'comment', 'origin', 'model', 'format', 'text', 'sha1',
    ]);
    expect(revision.getElementsByTagName('timestamp')[0].textContent).toBe('2024-03-01T10:20:30Z');
    const ids = pages.map((p) => p.getElementsByTagName('id')[0].textContent);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('stores the size and a checksum MediaWiki would compute', () => {
    const text = byTitle('Silver Vale')!.getElementsByTagName('text')[0];
    const value = text.textContent!;
    expect(Number(text.getAttribute('bytes'))).toBe(utf8(value).length);
    const hex = createHash('sha1').update(value).digest('hex');
    expect(text.getAttribute('sha1')).toBe(BigInt(`0x${hex}`).toString(36).padStart(31, '0'));
    expect(mediaWikiSha1(utf8('abc'))).toBe(BigInt('0xa9993e364706816aba3e25717850c26c9cd0d89d').toString(36).padStart(31, '0'));
    expect(mediaWikiSha1(utf8('x'.repeat(1000)))).toBe(BigInt(`0x${createHash('sha1').update('x'.repeat(1000)).digest('hex')}`).toString(36).padStart(31, '0'));
  });

  it('converts formatting to wikitext', () => {
    const text = wikitext('Aria Vale');
    expect(text).toContain("'''Aria'''");
    expect(text).toContain("''the''");
    expect(text).toContain("'''''both'''''");
    expect(text).toContain('[[Silver Vale|the Vale]]');
    expect(text).toContain('== Early life ==');
    expect(text).toContain('=== Death ===');
    expect(text).toContain('{| class="wikitable"');
    expect(text).toContain('! Name');
    expect(text).toContain('| colspan="2" | Across both');
    expect(text).toContain('*#*#*#*#*# Level 1');
    expect(text).toContain('<ol start="3"><li>third item</li></ol>');
    expect(text).toContain('<u>words</u>');
    expect(text).toContain('<s>gone</s>');
    expect(text).toContain('<blockquote>');
    expect(text).toContain('<pre>let x = "&lt;&amp;>";');
    expect(text).toContain('----');
    expect(text).toContain('[https://example.com/a?b=1&c=2 the outside]');
    expect(text).toContain('[[Category:Characters]]');
    expect(text).toContain('[[Category:Rangers & Scouts]]');
    expect(text).toContain('<ref>Annals of the &lt;Vale> & more, vol. 2</ref>');
    expect(text).toContain('<references />');
  });

  it('calls an infobox template, and defines it', () => {
    const text = wikitext('Aria Vale');
    expect(text.startsWith('{{Infobox character\n')).toBe(true);
    expect(text).toContain('| born = 12 Frost 1204');
    expect(text).toContain('| location = [[Silver Vale]]');
    expect(text).toContain('| parents = [[Silver Vale]], [[Nobody Known]]');
    expect(text).toContain('| image = [[File:portrait of aria.png|250px]]');
    expect(text).toContain('Line &#124; two');
    const template = wikitext('Template:Infobox character');
    expect(template).toContain('{{{born|}}}');
    expect(template).toContain('! Born');
    expect(byTitle('Template:Infobox character')!.getElementsByTagName('ns')[0].textContent).toBe('10');
  });

  it('uses the label text for figures of every kind', () => {
    const text = wikitext('Aria Vale');
    expect(text).toContain('[[File:map_north_.png|thumb|right|alt=A map of the northern road|Figure 1. The road north]]');
    expect(text).toContain('|thumb|left|');
    expect(text).toContain('Picture 1. Aria, by [[Silver Vale|Silver]]');
    expect(text).toContain('|+ Table 1. Her ranks');
    expect(text).toContain('[[Media:ride.mp4|Video 1. The ride to the gate]]');
    expect(text).toContain('[https://example.com/ride.mp4 Video 2. Linked ride]');
    expect(text).toContain('Video 3. Too large to carry');
  });

  it('keeps wiki markup in text from meaning anything', () => {
    const text = wikitext('Aria Vale');
    expect(text).toContain('&#91;&#91;not a link&#93;&#93;');
    expect(text).toContain('&#123;&#123;not a template&#125;&#125;');
    expect(text).toContain('&lt;angle>');
    expect(text).toContain('&#42; not a list');
    expect(text).toContain('&#61; not a heading =');
    expect(text).not.toContain('\u0001');
    expect(text).not.toContain('javascript:');
    expect(text).toContain('danger');
    // Two apostrophes in a row would start italics, and a lone one beside bold would too.
    expect(text).toContain('&#39;&#39;quoted&#39;&#39;');
    expect(text).toContain("'''bold&#39;'''");
  });

  it('makes titles MediaWiki accepts, and links follow them', () => {
    expect(mediaWikiTitle('A|B [draft] <x> #1')).toBe('A-B -draft- -x- -1');
    expect(mediaWikiTitle('Category: Trick')).toBe('Category - Trick');
    expect(mediaWikiTitle('Talk:Page')).toBe('Talk - Page');
    expect(mediaWikiTitle('50%25 off')).toBe('50% 25 off');
    expect(mediaWikiTitle('../up')).toBe('Page ../up');
    expect(mediaWikiTitle(':leading')).toBe('leading');
    expect(mediaWikiTitle('x'.repeat(400)).length).toBe(255);
    expect(mediaWikiTitle('')).toBe('Untitled');
    expect(byTitle('A-B -draft- -x- -1')).toBeDefined();
    expect(byTitle('Category - Trick')).toBeDefined();
    expect(wikitext('A-B -draft- -x- -1')).toContain('[[A-B -draft- -x- -1|self]]');
    // Two titles that clean up the same stay apart.
    expect(byTitle('What? Why: "Yes"')).toBeDefined();
  });

  it('makes aliases redirects and Talk notes Talk pages', () => {
    const redirect = byTitle('The Ranger')!;
    expect(redirect.getElementsByTagName('redirect')[0].getAttribute('title')).toBe('Aria Vale');
    expect(redirect.getElementsByTagName('text')[0].textContent).toBe('#REDIRECT [[Aria Vale]]');
    const talk = byTitle('Talk:Aria Vale')!;
    expect(talk.getElementsByTagName('ns')[0].textContent).toBe('1');
    expect(talk.getElementsByTagName('text')[0].textContent).toContain('Check her age');
  });

  it('turns links to pages left out into plain words', () => {
    const doc = parseXml(decode(exportMediaWiki(fixtureInput({ scope: 'wiki', includeDrafts: false }))));
    const aria = [...doc.getElementsByTagName('page')].find((p) => p.getElementsByTagName('title')[0].textContent === 'Aria Vale')!;
    const text = aria.getElementsByTagName('text')[0].textContent!;
    expect(text).not.toContain('[[CON');
    expect(text).toContain(' and CON.');
  });
});

describe('static site', () => {
  const files = unzipSync(exportSite(fixtureInput({ scope: 'wiki' })));
  const paths = Object.keys(files);
  const pagesHtml = paths.filter((p) => p.endsWith('.html'));

  function parse(path: string): Document {
    return new DOMParser().parseFromString(strFromU8(files[path]), 'text/html');
  }

  function resolve(from: string, href: string): string {
    const parts = from.split('/').slice(0, -1);
    for (const part of decodeURI(href).split('/')) {
      if (part === '..') parts.pop();
      else if (part !== '.') parts.push(part);
    }
    return parts.join('/');
  }

  it('starts at index.html, showing the main page', () => {
    expect(paths).toContain('index.html');
    expect(parse('index.html').querySelector('.page-title')!.textContent).toBe('Main Page');
  });

  it('every local link and image resolves inside the zip, fragments included', () => {
    let checked = 0;
    for (const path of pagesHtml) {
      const page = parse(path);
      for (const element of page.querySelectorAll('a[href], img[src], link[href], script[src], video[src]')) {
        const url = element.getAttribute('href') ?? element.getAttribute('src')!;
        if (/^(https?:|mailto:)/.test(url)) continue;
        const [file, fragment] = url.split('#');
        const target = file ? resolve(path, file) : path;
        expect(paths, `${path} -> ${url}`).toContain(target);
        if (fragment && target.endsWith('.html')) {
          expect(parse(target).getElementById(fragment), `${path} -> ${url}`).not.toBeNull();
        }
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('asks for nothing from the web', () => {
    for (const path of pagesHtml) {
      const page = parse(path);
      for (const element of page.querySelectorAll('img[src], link[href], script[src], video[src], iframe, source')) {
        const url = element.getAttribute('href') ?? element.getAttribute('src') ?? '';
        expect(url, path).not.toMatch(/^(https?:)?\/\//);
      }
    }
    expect(strFromU8(files['assets/site.css'])).not.toMatch(/url\(['"]?(https?:)?\/\//);
    expect(strFromU8(files['pages/aria-vale.html'])).not.toContain('evil.example');
  });

  it('shows the parts of a wiki article', () => {
    const page = parse('pages/aria-vale.html');
    expect(page.querySelector('.page-title')!.textContent).toBe('Aria Vale');
    expect(page.querySelector('.contents')!.textContent).toContain('Early life');
    expect(page.querySelector('.infobox th')!.textContent).toBe('Born');
    expect(page.querySelector('.infobox-image img')!.getAttribute('src')).toBe('../images/asset-portrait.png');
    expect(page.querySelector('.infobox a')!.getAttribute('href')).toBe('../pages/silver-vale.html');
    expect(page.querySelector('.infobox .wiki-link-red')!.textContent).toBe('Nobody Known');
    expect(page.querySelector('.references li')!.textContent).toContain('Annals of the <Vale> & more');
    expect(page.querySelector('.categories')!.textContent).toContain('Rangers & Scouts');
    expect(page.querySelector('sup.reference a')!.getAttribute('href')).toBe('#note-1');
  });

  it('shows working links and red links', () => {
    const page = parse('pages/aria-vale.html');
    const links = [...page.querySelectorAll('.article a.wiki-link')].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toContainEqual(['the Vale', '../pages/silver-vale.html']);
    expect(links).toContainEqual(['Ranger', '../pages/aria-vale.html']);
    expect([...page.querySelectorAll('.article .wiki-link-red')].map((e) => e.textContent)).toContain('a missing page');
  });

  it('shows every kind of figure with its label', () => {
    const page = parse('pages/aria-vale.html');
    const figures = [...page.querySelectorAll('.article figure.figure')];
    expect(figures.length).toBe(7);
    const map = figures[0];
    expect(map.className).toContain('figure-right');
    expect(map.getAttribute('style')).toContain('45%');
    expect(map.querySelector('img')!.getAttribute('src')).toBe('../images/asset-map.png');
    expect(map.querySelector('img')!.getAttribute('alt')).toBe('A map of the northern road');
    expect(map.querySelector('figcaption')!.textContent).toBe('Figure 1. The road north');
    expect(figures[1].querySelector('figcaption a')!.getAttribute('href')).toBe('../pages/silver-vale.html');
    expect(figures[2].querySelector('table')).not.toBeNull();
    expect(figures[2].querySelector('figcaption')!.textContent).toBe('Table 1. Her ranks');
    const video = figures[3].querySelector('video')!;
    expect(video.getAttribute('src')).toBe('../media/asset-video.mp4');
    expect(paths).toContain('media/asset-video.mp4');
    expect(figures[4].querySelector('a')!.getAttribute('href')).toBe('https://example.com/ride.mp4');
    expect(figures[5].querySelector('.video-missing')).not.toBeNull();
    expect(figures[5].querySelector('figcaption')!.textContent).toBe('Video 3. Too large to carry');
    expect(paths.some((p) => p.includes('asset-huge'))).toBe(false);
  });

  it('escapes all content', () => {
    for (const path of pagesHtml) {
      expect(strFromU8(files[path])).not.toContain('<angle>');
      expect(strFromU8(files[path])).not.toContain('<Vale>');
      expect(parse(path).querySelector('script:not([src])')).toBeNull();
    }
    expect(strFromU8(files['pages/aria-vale.html'])).not.toContain('javascript:');
    const site = fixtureSnapshot();
    site.meta.name = '<img src=x onerror=alert(1)>';
    site.pages[0].title = '<script>alert(1)</script>';
    const hostile = unzipSync(exportSite(fixtureInput({ scope: 'wiki' }, site)));
    const page = new DOMParser().parseFromString(strFromU8(hostile['index.html']), 'text/html');
    expect(page.querySelector('.page-title')!.textContent).toBe('<script>alert(1)</script>');
    expect(page.querySelector('.site-name')!.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(page.querySelectorAll('img[onerror], script:not([src])').length).toBe(0);
  });

  it('lets scripts run only from its own files, set before any script loads', () => {
    for (const path of pagesHtml) {
      const head = parse(path).head;
      const policy = head.querySelector('meta[http-equiv="Content-Security-Policy"]');
      expect(policy?.getAttribute('content')).toBe(SITE_CSP);
      const first = head.querySelector('meta[http-equiv], script');
      expect(first, path).toBe(policy);
    }
    expect(SITE_CSP).toContain("script-src 'self'");
    expect(SITE_CSP).not.toContain('unsafe');
  });

  it('has lists of pages and categories', () => {
    const all = parse('all-pages.html');
    expect(all.querySelectorAll('.page-list li').length).toBe(fixtureSnapshot().pages.length);
    expect(parse('categories.html').querySelector('.page-list')!.textContent).toContain('Rangers & Scouts (1)');
    const category = paths.find((p) => p.startsWith('categories/rangers'))!;
    expect(parse(category).querySelector('.page-list a')!.getAttribute('href')).toBe('../pages/aria-vale.html');
  });

  it('has a search index that loads as a script', () => {
    const code = strFromU8(files['assets/search-index.js']);
    const entries = new Function('window', `${code}; return window.LORECRAFT_SEARCH;`)({}) as { title: string; url: string; text: string }[];
    expect(entries.length).toBe(fixtureSnapshot().pages.length);
    const aria = entries.find((e) => e.title === 'Aria Vale')!;
    expect(aria.url).toBe('pages/aria-vale.html');
    expect(aria.text).toContain('Éowyn Þórr');
    expect(paths).toContain('search.html');
  });

  it('gives pages with non-Latin titles an address too', () => {
    expect(paths.some((p) => /^pages\/page-\d+\.html$/.test(p))).toBe(true);
    const page = pagesHtml.find((p) => parse(p).querySelector('.page-title')?.textContent === '龍の名前')!;
    expect(page).toBeDefined();
    expect(parse(page).querySelector('.article')!.textContent).toContain('日本語の本文');
  });

  it('carries the fonts and the two color modes', () => {
    const css = strFromU8(files['assets/site.css']);
    expect(css).toContain('@font-face');
    expect(css).toContain('prefers-color-scheme: dark');
    for (const match of css.matchAll(/url\('fonts\/([^']+)'\)/g)) {
      expect(paths).toContain(`assets/fonts/${match[1]}`);
    }
    expect(files['assets/fonts/inter-latin-400.woff2'].length).toBeGreaterThan(1000);
    expect(strFromU8(files['assets/fonts/inter-latin-400.woff2'].slice(0, 4))).toBe('wOF2');
  });

  it('copies image bytes exactly', () => {
    const assets = fixtureInput().assetData;
    expect([...files['images/asset-map.png']]).toEqual([...base64ToBytes(assets.get('asset-map')!)]);
  });
});

describe('text helpers used by exports', () => {
  it('the awkward text really has the awkward parts', () => {
    const doc: PmNode = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: AWKWARD_TEXT }] }] };
    expect(pmToPlainText(doc)).toContain('\u0001');
  });
});
