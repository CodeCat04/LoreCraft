// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import mammoth from 'mammoth';

import type { BookPublishing, PmNode } from '../lib/types';
import { normalizeLorebookFile } from './import/lorebookFile';
import { exportDocx } from './novel/docx';
import { exportEpub } from './novel/epub';
import { resolveMatter } from './novel/matter';
import { buildNovelPrintDocument, buildWikiPrintDocument } from './print/document';
import { applyScope } from './scope';
import { doc, fixtureInput, fixtureSnapshot, para, text } from './testFixture';
import { DEFAULT_OPTIONS, type ExportOptions, type ExportSnapshot } from './types';
import { isbnLooksRight } from './util';
import { exportJson } from './wiki/json';

const matter = (words: string) => ({ include: true, content: doc(para(text(words))) });

const FULL: BookPublishing = {
  coverAssetId: 'asset-portrait',
  series: 'The Vale & Beyond',
  seriesNumber: '2',
  description: 'A ranger rides <north> & back.',
  language: 'fr',
  publisher: 'Silver Gate Press',
  isbn: '978-1-234-56789-7',
  copyrightYear: '2026',
  copyright: { include: true, content: null },
  dedication: matter('For the riders.'),
  epigraph: matter('Not all roads run north.'),
  acknowledgments: matter('My thanks to the Wardens.'),
  aboutAuthor: matter('She lives by the sea.'),
  appendices: [
    { title: 'Who Is Who', kind: 'cast', categories: [], pageTypes: ['character'], canonOnly: true, hideSpoilers: true },
    { title: 'Terms', kind: 'glossary', categories: ['世界'], pageTypes: [], canonOnly: false, hideSpoilers: true },
    { title: 'The Maps', kind: 'maps', categories: [], pageTypes: [], canonOnly: true, hideSpoilers: true },
  ],
};

function world(details: BookPublishing = FULL): ExportSnapshot {
  const snapshot = fixtureSnapshot();
  snapshot.books[0].publishing = details;
  return snapshot;
}

const OPTIONS: Partial<ExportOptions> = { scope: 'book', bookId: 'book-1' };

function parse(textValue: string): Document {
  const parsed = new DOMParser().parseFromString(textValue, 'application/xml');
  const error = parsed.querySelector('parsererror');
  if (error) throw new Error(`Not well-formed: ${error.textContent}\n${textValue.slice(0, 300)}`);
  return parsed;
}

describe('what surrounds a book', () => {
  const bookOf = (snapshot: ExportSnapshot) => snapshot.books[0];

  it('comes in the usual order', () => {
    const resolved = resolveMatter(bookOf(world()), world());
    expect(resolved.front.map((s) => s.key)).toEqual(['copyright', 'dedication', 'epigraph']);
    expect(resolved.back.map((s) => s.title)).toEqual(['Who Is Who', 'Terms', 'The Maps', 'Acknowledgments', 'About the Author']);
    expect(resolved.titlePage).toBe(true);
    expect(resolved.coverAssetId).toBe('asset-portrait');
  });

  it('writes a standard copyright notice from the details when none is written', () => {
    const resolved = resolveMatter(bookOf(world()), world());
    const notice = resolved.front[0].doc.content!.map((p) => p.content![0].text);
    expect(notice).toEqual([
      'Copyright © 2026 Élodie "E." Writer',
      'All rights reserved.',
      'Published by Silver Gate Press',
      'ISBN 978-1-234-56789-7',
    ]);
  });

  it('leaves out what was turned off or left empty', () => {
    const details: BookPublishing = {
      titlePage: false,
      copyright: { include: false, content: null },
      dedication: { include: false, content: doc(para(text('Hidden.'))) },
      epigraph: { include: true, content: doc(para()) },
    };
    const resolved = resolveMatter(bookOf(world(details)), world(details));
    expect(resolved.front).toEqual([]);
    expect(resolved.back).toEqual([]);
    expect(resolved.titlePage).toBe(false);
  });

  it('warns about a cover that is gone, and an appendix that came out empty', () => {
    const details: BookPublishing = {
      coverAssetId: 'gone',
      appendices: [{ title: 'Nobody', kind: 'cast', categories: ['No such category'], pageTypes: [], canonOnly: true, hideSpoilers: true }],
    };
    const resolved = resolveMatter(bookOf(world(details)), world(details));
    expect(resolved.coverAssetId).toBeNull();
    expect(resolved.back).toEqual([]);
    expect(resolved.warnings.join(' ')).toMatch(/Nobody/);
    expect(resolved.warnings.join(' ')).toMatch(/cover/);
  });

  describe('an appendix', () => {
    const titles = (doc_: PmNode) => doc_.content!.map((p) => p.content![0].text);
    const onlyAppendix = (snapshot: ExportSnapshot, spec: Partial<NonNullable<BookPublishing['appendices']>[number]>) => {
      snapshot.books[0].publishing = {
        appendices: [{ title: 'A', kind: 'cast', categories: [], pageTypes: ['character'], canonOnly: true, hideSpoilers: true, ...spec }],
      };
      return resolveMatter(snapshot.books[0], snapshot).back[0];
    };

    it('lists pages by title with their summaries', () => {
      const section = onlyAppendix(fixtureSnapshot(), {});
      expect(titles(section.doc)).toContain('Aria Vale');
      const aria = section.doc.content!.find((p) => p.content![0].text === 'Aria Vale')!;
      expect(aria.content![0].marks).toEqual([{ type: 'bold' }]);
      expect(aria.content![1].text).toBe(' A ranger of the north & beyond.');
    });

    it('never holds retconned pages or the main page, whatever is asked', () => {
      const section = onlyAppendix(fixtureSnapshot(), { pageTypes: ['article', 'home'], canonOnly: false });
      const names = titles(section.doc);
      expect(names).not.toContain('Old Tale');
      expect(names).not.toContain('Main Page');
    });

    it('holds only canon pages if asked', () => {
      const snapshot = fixtureSnapshot();
      snapshot.pages.find((p) => p.id === 'aria')!.status = 'draft';
      expect(onlyAppendix(snapshot, { pageTypes: ['character'], canonOnly: true })).toBeUndefined();
      const snapshotAgain = fixtureSnapshot();
      snapshotAgain.pages.find((p) => p.id === 'aria')!.status = 'draft';
      expect(titles(onlyAppendix(snapshotAgain, { canonOnly: false }).doc)).toContain('Aria Vale');
    });

    it('holds back a page revealed in a later book, but not one revealed by now', () => {
      const later = fixtureSnapshot();
      later.nodes.find((n) => n.id === 'scene-gate')!.bookId = 'book-2';
      expect(onlyAppendix(later, {})).toBeUndefined();

      const allowed = fixtureSnapshot();
      allowed.nodes.find((n) => n.id === 'scene-gate')!.bookId = 'book-2';
      expect(titles(onlyAppendix(allowed, { hideSpoilers: false }).doc)).toContain('Aria Vale');

      // Aria's reveal is in this book, so by its end she is no secret.
      expect(titles(onlyAppendix(fixtureSnapshot(), {}).doc)).toContain('Aria Vale');
    });

    it('of maps shows each picture, and the places that may be named', () => {
      const snapshot = fixtureSnapshot();
      snapshot.maps = [
        {
          id: 'm1',
          title: 'The North',
          assetId: 'asset-map',
          pins: [
            { pageId: 'silver', label: 'The Vale', x: 0, y: 0 },
            { pageId: 'old', label: 'Retconned Place', x: 0, y: 0 },
            { pageId: null, label: 'Lone Tower', x: 0, y: 0 },
          ],
        },
        { id: 'm2', title: 'No picture', assetId: null, pins: [] },
      ];
      const section = onlyAppendix(snapshot, { kind: 'maps', pageTypes: [], canonOnly: false });
      expect(section.doc.content![0].type).toBe('figure');
      expect(section.doc.content![0].content![0].attrs!.assetId).toBe('asset-map');
      const places = section.doc.content![1].content![0].text;
      expect(places).toContain('Lone Tower');
      expect(places).not.toContain('Retconned Place');
      expect(section.doc.content).toHaveLength(2);
    });
  });

  it('brings the pictures it needs into the export, even though a book has no pages', () => {
    const snapshot = world();
    snapshot.maps = [{ id: 'm1', title: 'The North', assetId: 'asset-map', pins: [] }];
    const scoped = applyScope(snapshot, { ...DEFAULT_OPTIONS, ...OPTIONS }).snapshot;
    const ids = scoped.assets.map((a) => a.id);
    expect(ids).toContain('asset-portrait');
    expect(ids).toContain('asset-map');
    expect(scoped.pages).toEqual([]);
  });

  it('stays out of a manuscript', () => {
    const scoped = applyScope(world(), { ...DEFAULT_OPTIONS, ...OPTIONS, manuscriptFormat: true }).snapshot;
    expect(scoped.books[0].matter).toBeUndefined();
  });

  it('can be turned off for an export', () => {
    const scoped = applyScope(world(), { ...DEFAULT_OPTIONS, ...OPTIONS, bookMatter: false }).snapshot;
    expect(scoped.books[0].matter).toBeUndefined();
  });
});

describe('an EPUB with publishing details', () => {
  const files = unzipSync(exportEpub(fixtureInput({ ...OPTIONS, language: 'fr' }, world())));
  const opf = parse(strFromU8(files['OEBPS/content.opf']));
  const metaByProperty = (name: string) => [...opf.getElementsByTagName('meta')].find((m) => m.getAttribute('property') === name);

  it('names everything in its metadata', () => {
    const one = (tag: string) => opf.getElementsByTagName(tag)[0]?.textContent;
    expect(one('dc:language')).toBe('fr');
    expect(one('dc:publisher')).toBe('Silver Gate Press');
    expect(one('dc:description')).toBe('A ranger rides <north> & back.');
    expect(one('dc:date')).toBe('2026');
    expect(one('dc:rights')).toBe('Copyright © 2026 Élodie "E." Writer');
    const identifiers = [...opf.getElementsByTagName('dc:identifier')].map((i) => i.textContent);
    expect(identifiers).toContain('urn:isbn:9781234567897');
    expect(identifiers).toContain('urn:uuid:book-1');
    expect(metaByProperty('belongs-to-collection')!.textContent).toBe('The Vale & Beyond');
    expect(metaByProperty('group-position')!.textContent).toBe('2');
    expect(metaByProperty('collection-type')!.textContent).toBe('series');
  });

  it('has a proper cover', () => {
    const items = [...opf.getElementsByTagName('item')];
    const cover = items.find((i) => i.getAttribute('properties') === 'cover-image')!;
    expect(cover.getAttribute('id')).toBe('img-asset-portrait');
    expect(files[`OEBPS/${cover.getAttribute('href')}`]).toBeDefined();
    const legacy = [...opf.getElementsByTagName('meta')].find((m) => m.getAttribute('name') === 'cover')!;
    expect(legacy.getAttribute('content')).toBe('img-asset-portrait');
    const first = opf.getElementsByTagName('itemref')[0].getAttribute('idref')!;
    expect(first).toMatch(/^cover/);
    expect(strFromU8(files[`OEBPS/${first}.xhtml`])).toContain('epub:type="cover"');
    expect(strFromU8(files[`OEBPS/${first}.xhtml`])).toContain(cover.getAttribute('href')!);
  });

  it('reads in the right order, and every page is well-formed', () => {
    const spine = [...opf.getElementsByTagName('itemref')].map((r) => r.getAttribute('idref')!);
    const textOf = (id: string) => strFromU8(files[`OEBPS/${id}.xhtml`]);
    for (const id of spine) parse(textOf(id));
    const position = (words: string) => spine.findIndex((id) => textOf(id).includes(words));
    const order = [
      'epub:type="cover"',
      'epub:type="titlepage"',
      'epub:type="copyright-page"',
      'For the riders.',
      'Not all roads run north.',
      'Arrival',
      'Who Is Who',
      'Terms',
      'The Maps',
      'My thanks to the Wardens.',
      'She lives by the sea.',
    ].map(position);
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('lists the back matter in the table of contents', () => {
    const nav = strFromU8(files['OEBPS/nav.xhtml']);
    parse(nav);
    for (const title of ['Arrival', 'Who Is Who', 'Acknowledgments', 'About the Author']) expect(nav).toContain(title);
    expect(nav).toContain('epub:type="cover"');
    expect(nav).not.toContain('Dedication');
  });

  it('leaves the title page out if asked', () => {
    const plain = unzipSync(exportEpub(fixtureInput(OPTIONS, world({ titlePage: false }))));
    const names = Object.keys(plain).filter((n) => /OEBPS\/title/.test(n));
    expect(names).toEqual([]);
  });

  it('has no cover or series metadata when a book has none', () => {
    const plain = unzipSync(exportEpub(fixtureInput(OPTIONS)));
    const text_ = strFromU8(plain['OEBPS/content.opf']);
    expect(text_).not.toContain('cover-image');
    expect(text_).not.toContain('belongs-to-collection');
    expect(text_).not.toContain('dc:publisher');
  });
});

describe('a Word document with publishing details', () => {
  it('has the cover first, then everything in order, with chapters numbered from 1', async () => {
    const files = unzipSync(await exportDocx(fixtureInput(OPTIONS, world())));
    const documentXml = strFromU8(files['word/document.xml']);
    parse(documentXml);
    const picture = documentXml.indexOf('<w:drawing>');
    const places = ['The Silver Road', 'Copyright ©', 'For the riders.', 'Not all roads run north.', 'Arrival', 'Who Is Who', 'My thanks to the Wardens.', 'She lives by the sea.']
      .map((words) => documentXml.indexOf(words));
    expect(places.every((at) => at >= 0)).toBe(true);
    expect([...places].sort((a, b) => a - b)).toEqual(places);
    expect(picture).toBeLessThan(places[0]);

    // Front matter is a section of its own, and numbering starts again after it.
    expect(documentXml).toContain('w:pgNumType');
    expect(documentXml.match(/<w:start="1"|w:start="1"/)).toBeTruthy();
    expect(documentXml.match(/<w:sectPr/g)!.length).toBe(2);
    expect(strFromU8(files['docProps/core.xml'])).toContain('A ranger rides');
  });

  it('reads back', async () => {
    const bytes = await exportDocx(fixtureInput(OPTIONS, world()));
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    expect(value).toContain('Copyright © 2026');
    expect(value).toContain('Who Is Who');
    expect(value).toContain('Aria Vale A ranger of the north');
  });

  it('is a plain manuscript in manuscript format', async () => {
    const files = unzipSync(await exportDocx(fixtureInput({ ...OPTIONS, manuscriptFormat: true }, world())));
    const documentXml = strFromU8(files['word/document.xml']);
    expect(documentXml).not.toContain('For the riders.');
    expect(documentXml).not.toContain('Who Is Who');
    expect(documentXml.match(/<w:sectPr/g)!.length).toBe(1);
  });
});

describe('a PDF with publishing details', () => {
  const page = (options: Partial<ExportOptions> = {}, snapshot = world()) => {
    const built = buildNovelPrintDocument(fixtureInput({ ...OPTIONS, ...options }, snapshot));
    const root = new DOMParser().parseFromString(built.html, 'text/html');
    return { ...built, root, text: root.body.textContent ?? '' };
  };

  it('reads in the right order, and lists the back matter in its contents', () => {
    const { root, text: words } = page();
    const places = ['Copyright ©', 'For the riders.', 'Not all roads run north.', 'Contents', 'Who Is Who', 'My thanks to the Wardens.', 'She lives by the sea.'].map((w) => words.indexOf(w));
    expect(places.every((at) => at >= 0)).toBe(true);
    expect([...places].sort((a, b) => a - b)).toEqual(places);
    expect(root.querySelector('main')!.firstElementChild!.className).toBe('cover-page');
    expect(root.querySelector('.cover-page img')!.getAttribute('src')).toBe('#asset/asset-portrait');
    expect(root.querySelector('.book-contents')!.textContent).toContain('Who Is Who');
    expect(root.querySelector('.book-contents')!.textContent).toContain('About the Author');
  });

  it('is a plain reading PDF unless asked', () => {
    const { css, root } = page();
    expect(root.querySelector('.doc-print')).toBeNull();
    expect(css).toContain('@bottom-center');
    expect(css).not.toContain(':left');
  });

  it('when print-ready, has trim size, mirrored margins, right-hand chapters and running heads', () => {
    const { css, root } = page({ printReady: true, pageSize: 'digest' });
    expect(css).toContain('size: 5.5in 8.5in');
    expect(css).toMatch(/@page :left \{ margin-left: 0\.625in; margin-right: 0\.875in;/);
    expect(css).toMatch(/@page :right \{ margin-left: 0\.875in; margin-right: 0\.625in;/);
    // A chapter's heads are counter styles of the page number, which the print page narrows
    // to the pages after the one the chapter opens on.
    expect(css).toContain('@counter-style running-1-chapter { system: cyclic; symbols: "Arrival"; }');
    expect(css).toContain('@counter-style running-1-right { system: extends running-1-chapter; }');
    expect(css).toMatch(/@page running-1:right \{ @top-right \{ content: counter\(page, running-1-right\);/);
    expect(css).toContain('@counter-style running-1-book { system: cyclic; symbols: "The Silver Road"; }');
    expect(css).toMatch(/@page running-1:left \{ @top-left \{ content: counter\(page, running-1-left\);/);
    expect(css).toContain('@counter-style lorecraft-no-head { system: cyclic; symbols: ""; }');
    expect(root.querySelector('.chapter.running-1')!.getAttribute('data-running-head')).toBe('running-1');
    const backMatter = root.querySelector('.matter-acknowledgments')!;
    expect(backMatter.getAttribute('data-running-head')).toBe(backMatter.className.match(/running-\d+/)![0]);
    expect(css).toContain('@page :left { @top-left { content: "The Silver Road"');
    expect(css).toContain('@bottom-left { content: counter(page)');
    expect(css).toContain('@bottom-right { content: counter(page)');
    expect(root.querySelector('.doc-print')).not.toBeNull();
    expect(root.querySelector('.chapter.running-1')!.getAttribute('data-right-page')).toBe('true');
    expect(root.querySelector('.book-contents')!.getAttribute('data-right-page')).toBe('true');
    expect(root.querySelector('.matter-dedication')!.getAttribute('data-right-page')).toBe('true');
    expect(root.querySelector('.matter-copyright')!.getAttribute('data-right-page')).toBeNull();
    expect(root.querySelectorAll('.chapter.running-1')).toHaveLength(1);
    // A printer takes the cover separately.
    expect(root.querySelector('.cover-page')).toBeNull();
  });

  it('when print-ready, each choice can be turned off', () => {
    const { css, root } = page({ printReady: true, mirrorMargins: false, chaptersOnRight: false, runningHeaders: false });
    expect(css).toMatch(/@page :left \{ margin-left: 0\.75in; margin-right: 0\.75in;/);
    expect(css).not.toContain('@top-right { content: "');
    expect(root.querySelector('[data-right-page]')).toBeNull();
    expect(root.querySelector('.running-1')).toBeNull();
  });

  it('gives the page a real language tag, however the code was typed', () => {
    expect(page({ language: 'pt_BR' }).language).toBe('pt-BR');
    expect(page({ language: 'Français' }).language, 'not a code, so English').toBe('en');
    expect(page({ language: '' }).language).toBe('en');
    expect(buildWikiPrintDocument(fixtureInput({ scope: 'wiki', language: ' en_GB ' }, world())).language).toBe('en-GB');
  });

  it('escapes a title in a running head', () => {
    const snapshot = world();
    snapshot.nodes.find((n) => n.id === 'ch-1')!.title = 'The "Quoted" \\ Chapter';
    expect(page({ printReady: true }, snapshot).css).toContain('symbols: "The \\"Quoted\\" \\\\ Chapter"');
  });
});

describe('publishing details in a LoreCraft file', () => {
  it('survive a round trip', () => {
    const file = JSON.parse(new TextDecoder().decode(exportJson(fixtureInput({ scope: 'project' }, world()))));
    expect(file.books[0].publishing.series).toBe('The Vale & Beyond');
    const { payload, problems } = normalizeLorebookFile(file);
    expect(problems.filter((p) => p.severity === 'error')).toEqual([]);
    expect(payload.books[0].publishing).toEqual(FULL);
    expect(file.assets.map((a: { id: string }) => a.id)).toContain('asset-portrait');
  });

  it('accept the short forms an AI is likely to write', () => {
    const { payload, problems } = normalizeLorebookFile({
      format: 'lorebook',
      version: 1,
      books: [{
        title: 'B',
        publishing: { seriesNumber: 2, copyrightYear: 2026, dedication: 'For **you**.', appendices: [{ kind: 'maps' }] },
      }],
    });
    expect(problems).toEqual([]);
    const details = payload.books[0].publishing!;
    expect(details.seriesNumber).toBe('2');
    expect(details.copyrightYear).toBe('2026');
    expect(details.dedication?.include).toBe(true);
    expect(details.dedication?.content?.type).toBe('doc');
    expect(details.appendices?.[0]).toMatchObject({ kind: 'maps', canonOnly: true, hideSpoilers: true });
  });

  it('name the field when something is wrong', () => {
    const { problems } = normalizeLorebookFile({
      format: 'lorebook',
      version: 1,
      books: [{ title: 'B', publishing: { isbn: {}, appendices: [{ kind: 'nonsense' }], dedication: 5 } }],
    });
    const fields = problems.filter((p) => p.severity === 'error').map((p) => p.field);
    expect(fields).toContain('publishing.isbn');
    expect(fields).toContain('publishing.appendices[0].kind');
    expect(fields).toContain('publishing.dedication');
    expect(problems[0].item).toContain('"B"');
  });
});

describe('an ISBN check', () => {
  it('passes good ones, written any usual way', () => {
    for (const good of ['9781234567897', '978-1-234-56789-7', '978 1 234 56789 7', '0-306-40615-2', '080442957X']) {
      expect(isbnLooksRight(good), good).toBe(true);
    }
  });

  it('catches a typo or the wrong length', () => {
    for (const bad of ['9781234567890', '12345', '0-306-40615-3', 'ISBN']) expect(isbnLooksRight(bad), bad).toBe(false);
  });
});
