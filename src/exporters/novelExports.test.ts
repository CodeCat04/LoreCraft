/** Every novel format, read back: DOCX with mammoth, EPUB and PDF source by their structure. */

import { strFromU8, unzipSync } from 'fflate';
import mammoth from 'mammoth';

import { bigBookSnapshot, fixtureInput, fixtureSnapshot } from './testFixture';
import { exportDocx } from './novel/docx';
import { exportEpub } from './novel/epub';
import { exportNovelMarkdown, exportNovelText } from './novel/text';
import { buildNovelPrintDocument, buildWikiPrintDocument } from './print/document';
import { exportCsv } from './wiki/csv';
import { exportJson } from './wiki/json';
import { exportJsonl } from './wiki/jsonl';
import { exportMarkdown } from './wiki/markdown';
import { exportSite } from './wiki/site';
import { exportXml } from './wiki/xml';
import { exportYaml } from './wiki/yaml';
import { markdownToPm, pmToPlainText } from '../editor/convert';
import { applyScope } from './scope';
import { DEFAULT_OPTIONS, type ExportInput, type ExportOptions } from './types';

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function parseStrict(text: string, type: DOMParserSupportedType): Document {
  const parsed = new DOMParser().parseFromString(text, type);
  const error = parsed.querySelector('parsererror');
  if (error) throw new Error(`Not well-formed: ${error.textContent}\n${text.slice(0, 200)}`);
  return parsed;
}

const oneBook: Partial<ExportOptions> = { scope: 'book', bookId: 'book-1' };

describe('novel Markdown', () => {
  const text = decode(exportNovelMarkdown(fixtureInput(oneBook)));

  it('has a title, parts, chapters and separators in reading order', () => {
    expect(text).toContain('# The Silver Road');
    expect(text).toContain('*Book One*');
    expect(text).toContain('by Élodie "E." Writer');
    expect(text).toContain('### Arrival');
    expect(text).toContain('## Part Two: Night');
    expect(text).toContain('### Snow & Ice');
    expect(text).toContain('* * *');
    expect(text.indexOf('Arrival')).toBeLessThan(text.indexOf('Snow & Ice'));
    expect(text).toContain('Snow fell on *the* road.');
  });

  it('turns wiki links into plain words and pictures into labeled lines', () => {
    expect(text).not.toContain('[[Silver Vale');
    expect(text).toContain('Vale.');
    expect(text).toContain('\\[Picture 1: Aria, by Silver\\]');
    expect(text).toContain('\\[Video 1: The ride to the gate (Riders in snow)\\]');
    expect(text).not.toContain('asset:');
  });

  it('numbers figures through the whole book', () => {
    expect(text).toContain('\\[Video 2: Linked ride\\]');
    expect(text).toContain('\\[Table 1: Her ranks\\]');
  });

  it('reads back through a Markdown parser', () => {
    const plain = pmToPlainText(markdownToPm(text));
    expect(plain).toContain('<angle> & ampersand');
    expect(plain).toContain('Éowyn Þórr');
  });

  it('prints scene titles on request, and covers all books', () => {
    const titled = decode(exportNovelMarkdown(fixtureInput({ ...oneBook, sceneTitles: true })));
    expect(titled).toContain('#### The Gate');
    expect(titled).not.toContain('* * *');
    const all = decode(exportNovelMarkdown(fixtureInput({ scope: 'books' })));
    expect(all).toContain('# The Silver Road');
    expect(all).toContain('# Second & Last');
  });
});

describe('novel plain text', () => {
  const bytes = exportNovelText(fixtureInput(oneBook));
  const text = decode(bytes);

  it('is readable text with Windows line ends', () => {
    expect(text).toContain('THE SILVER ROAD\r\n');
    expect(text).toContain('PART TWO: NIGHT\r\n=====');
    expect(text).toContain('Arrival\r\n-------');
    expect(text).toContain('* * *');
    expect(text).not.toMatch(/[^\r]\n/);
    expect(text).toContain('[Picture 1: Aria, by Silver]');
    expect(text).not.toContain('**');
  });
});

describe('Word document', () => {
  let files: Record<string, Uint8Array>;
  let html: string;
  let warnings: string[];
  let bytes: Uint8Array;

  beforeAll(async () => {
    warnings = [];
    bytes = await exportDocx(fixtureInput(oneBook, undefined, warnings));
    files = unzipSync(bytes);
    html = (await mammoth.convertToHtml({ buffer: Buffer.from(bytes) })).value;
  }, 60_000);

  const xmlFile = (name: string) => parseStrict(strFromU8(files[name]), 'application/xml');

  it('every part of the package is well-formed XML', () => {
    expect(Object.keys(files)).toContain('word/document.xml');
    for (const name of Object.keys(files)) {
      if (name.endsWith('.xml') || name.endsWith('.rels')) xmlFile(name);
    }
  });

  it('uses real heading styles, nested for parts', () => {
    const styles = [...xmlFile('word/document.xml').getElementsByTagName('w:pStyle')].map((s) => s.getAttribute('w:val'));
    expect(styles).toContain('Title');
    expect(styles).toContain('Heading1');
    expect(styles).toContain('Heading2');
    const defined = [...xmlFile('word/styles.xml').getElementsByTagName('w:style')].map((s) => s.getAttribute('w:styleId'));
    for (const id of ['Title', 'Heading1', 'Heading2', 'Heading3', 'BodyText', 'FirstParagraph', 'SceneBreak', 'Caption']) {
      expect(defined).toContain(id);
    }
    // Word shows "Heading 1" in its navigation pane by this name.
    const names = [...xmlFile('word/styles.xml').getElementsByTagName('w:style')].map((s) => s.getElementsByTagName('w:name')[0]?.getAttribute('w:val')?.toLowerCase());
    expect(names).toContain('heading 1');
  });

  it('reads back with mammoth: title, headings and text', () => {
    expect(html).toContain('Arrival');
    expect(html).toMatch(/<h1[^>]*>Part Two: Night<\/h1>/);
    expect(html).toMatch(/<h2[^>]*>Arrival<\/h2>/);
    expect(html).toMatch(/<h2[^>]*>Snow &amp; Ice<\/h2>/);
    expect(html).toContain('Élodie');
    expect(html).toContain('Éowyn Þórr');
    expect(html).toContain('&lt;angle&gt; &amp; ampersand');
    expect(html).toContain('<em>the</em>');
    expect(html).toContain('* * *');
    expect(html).toContain('<table>');
    expect(html).toContain('<li>one</li>');
    expect(html).not.toContain('\u0001');
    expect(strFromU8(files['word/document.xml'])).not.toContain('\u0001');
  });

  it('turns wiki links into plain words', () => {
    expect(html).not.toContain('Silver Vale');
  });

  it('embeds pictures with their labels', () => {
    expect(html).toMatch(/<img [^>]*src="data:image\/png;base64/);
    expect(Object.keys(files).some((name) => name.startsWith('word/media/'))).toBe(true);
    expect(html).toContain('Picture 1. ');
    expect(html).toContain('Aria, by Silver');
    expect(strFromU8(files['word/document.xml'])).toContain('descr="Aria, by Silver"');
  });

  it('wraps text around a left or right figure with a frame shared by its label', () => {
    const document = strFromU8(files['word/document.xml']);
    const frames = document.match(/<w:framePr [^>]*>/g) ?? [];
    expect(frames.length).toBe(2);
    expect(frames[0]).toBe(frames[1]);
    expect(frames[0]).toContain('w:xAlign="left"');
    expect(frames[0]).toContain('w:wrap="around"');
  });

  it('shows a video as a labeled placeholder or a link', () => {
    expect(html).toContain('[Video 1: The ride to the gate (Riders in snow)] (video file: ride.mp4)');
    expect(html).toContain('<a href="https://example.com/ride.mp4">https://example.com/ride.mp4</a>');
    expect(html).toContain('Video 2. ');
  });

  it('labels a table beneath it', () => {
    expect(html).toContain('Table 1. ');
    expect(html).toContain('Her ranks');
  });

  it('keeps references as footnotes', () => {
    expect(strFromU8(files['word/footnotes.xml'])).toContain('A source');
    expect(html).toContain('A source');
  });

  it('meets the rules Word is strict about', () => {
    for (const name of Object.keys(files).filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n))) {
      const part = xmlFile(name).documentElement;
      expect(part.getElementsByTagName('w:p').length, name).toBeGreaterThan(0);
    }
    for (const cell of xmlFile('word/document.xml').getElementsByTagName('w:tc')) {
      expect(cell.lastElementChild?.tagName).toBe('w:p');
    }
  });

  it('has page numbers', () => {
    const footer = Object.keys(files).filter((n) => n.startsWith('word/footer')).map((n) => strFromU8(files[n])).join('');
    expect(footer).toContain('PAGE');
  });

  it('records the title and author', () => {
    const core = strFromU8(files['docProps/core.xml']);
    expect(core).toContain('The Silver Road');
    expect(core).toContain('Élodie');
  });

  describe('in standard manuscript format', () => {
    let manuscript: Record<string, Uint8Array>;
    let manuscriptHtml: string;

    beforeAll(async () => {
      const made = await exportDocx(fixtureInput({ ...oneBook, manuscriptFormat: true }));
      manuscript = unzipSync(made);
      manuscriptHtml = (await mammoth.convertToHtml({ buffer: Buffer.from(made) })).value;
    }, 60_000);

    it('is 12 point, double spaced, with one-inch margins', () => {
      const styles = strFromU8(manuscript['word/styles.xml']);
      expect(styles).toContain('w:line="480"');
      expect(styles).toContain('<w:sz w:val="24"/>');
      expect(styles).toContain('Times New Roman');
      const document = strFromU8(manuscript['word/document.xml']);
      expect(document).toMatch(/w:top="1440"[^>]*w:left="1440"|w:left="1440"[^>]*w:top="1440"/);
    });

    it('has a running head with author, title and page number', () => {
      const headers = Object.keys(manuscript).filter((n) => n.startsWith('word/header')).map((n) => strFromU8(manuscript[n])).join('');
      expect(headers).toContain('Writer / The Silver Road / ');
      expect(headers).toContain('PAGE');
    });

    it('has a title page with a word count, # between scenes, and an end', () => {
      expect(manuscriptHtml).toContain('about ');
      expect(manuscriptHtml).toContain('words');
      expect(manuscriptHtml).toContain('<p>#</p>');
      expect(manuscriptHtml).toContain('THE END');
    });
  });

  it('holds all books, each with a title', async () => {
    const made = await exportDocx(fixtureInput({ scope: 'books' }));
    const all = (await mammoth.convertToHtml({ buffer: Buffer.from(made) })).value;
    expect(all).toMatch(/<h1[^>]*>The Silver Road<\/h1>/);
    expect(all).toMatch(/<h1[^>]*>Second &amp; Last<\/h1>/);
    expect(all).toMatch(/<h2[^>]*>Only Chapter<\/h2>/);
    // A chapter with no title still gets a heading.
    expect(all).toMatch(/<h2[^>]*>Chapter \d+<\/h2>/);
  });

  it('leaves out a filtered scene', async () => {
    const made = await exportDocx(fixtureInput({ ...oneBook, scenes: 'written' }));
    const text = (await mammoth.extractRawText({ buffer: Buffer.from(made) })).value;
    expect(text).not.toContain('The hall was empty');
    expect(text).toContain('Aria rode to the gate');
  });
});

describe('EPUB', () => {
  const bytes = exportEpub(fixtureInput({ ...oneBook, language: 'en-GB' }));
  const files = unzipSync(bytes);
  const names = Object.keys(files);

  it('starts with an uncompressed mimetype, as readers require', () => {
    expect(names[0]).toBe('mimetype');
    expect(strFromU8(files.mimetype)).toBe('application/epub+zip');
    // The zip's first local file header: name at 30, no extra field, stored, and data at once.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(8, true)).toBe(0);
    expect(view.getUint16(28, true)).toBe(0);
    expect(strFromU8(bytes.slice(30, 38))).toBe('mimetype');
    expect(strFromU8(bytes.slice(38, 58))).toBe('application/epub+zip');
  });

  it('has a container that leads to the package', () => {
    const container = parseStrict(strFromU8(files['META-INF/container.xml']), 'application/xml');
    expect(container.querySelector('rootfile')!.getAttribute('full-path')).toBe('OEBPS/content.opf');
  });

  const opf = parseStrict(strFromU8(files['OEBPS/content.opf']), 'application/xml');

  it('has the metadata EPUB 3 requires', () => {
    expect(opf.documentElement.getAttribute('version')).toBe('3.0');
    const id = opf.documentElement.getAttribute('unique-identifier');
    expect(opf.getElementById(id!)!.textContent).toBe('urn:uuid:book-1');
    expect(opf.getElementsByTagName('dc:title')[0].textContent).toBe('The Silver Road');
    expect(opf.getElementsByTagName('dc:language')[0].textContent).toBe('en-GB');
    expect(opf.getElementsByTagName('dc:creator')[0].textContent).toBe('Élodie "E." Writer');
    const modified = [...opf.getElementsByTagName('meta')].find((m) => m.getAttribute('property') === 'dcterms:modified')!;
    expect(modified.textContent).toBe('2024-06-01T12:00:00Z');
  });

  it('lists everything in the manifest, and the spine reads through it', () => {
    const items = [...opf.getElementsByTagName('item')];
    const hrefs = items.map((i) => `OEBPS/${i.getAttribute('href')}`);
    for (const href of hrefs) expect(names).toContain(href);
    for (const name of names) {
      if (name.startsWith('OEBPS/') && name !== 'OEBPS/content.opf') expect(hrefs).toContain(name);
    }
    const ids = items.map((i) => i.getAttribute('id')!);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z_][\w.-]*$/);
    const nav = items.find((i) => i.getAttribute('properties') === 'nav')!;
    expect(nav.getAttribute('href')).toBe('nav.xhtml');
    const spine = [...opf.getElementsByTagName('itemref')].map((r) => r.getAttribute('idref')!);
    expect(spine.length).toBeGreaterThan(2);
    for (const idref of spine) expect(ids).toContain(idref);
  });

  it('every XHTML file is well-formed, and holds only legal characters', () => {
    const pages = names.filter((n) => n.endsWith('.xhtml'));
    expect(pages.length).toBeGreaterThan(3);
    for (const name of pages) {
      const doc = parseStrict(strFromU8(files[name]), 'application/xhtml+xml');
      expect(doc.documentElement.namespaceURI).toBe('http://www.w3.org/1999/xhtml');
      expect(doc.querySelector('title')!.textContent).toBeTruthy();
    }
    parseStrict(strFromU8(files['OEBPS/toc.ncx']), 'application/xml');
  });

  const nav = parseStrict(strFromU8(files['OEBPS/nav.xhtml']), 'application/xhtml+xml');

  it('has a working table of contents, nested by part', () => {
    const toc = nav.querySelector('nav[*|type="toc"], nav')!;
    const links = [...toc.querySelectorAll('a')];
    expect(links.map((a) => a.textContent)).toEqual(['Arrival', 'Part Two: Night', 'Snow & Ice']);
    for (const link of links) expect(names).toContain(`OEBPS/${link.getAttribute('href')}`);
    expect(toc.querySelector('li > ol > li > a')!.textContent).toBe('Snow & Ice');
    const chapter = parseStrict(strFromU8(files[`OEBPS/${links[0].getAttribute('href')}`]), 'application/xhtml+xml');
    expect(chapter.querySelector('h1')!.textContent).toBe('Arrival');
  });

  const chapterText = () => names.filter((n) => n.includes('chapter')).map((n) => strFromU8(files[n])).join('');

  it('holds the text, escaped, with scene separators and no wiki links', () => {
    const text = chapterText();
    expect(text).toContain('Éowyn Þórr');
    expect(text).toContain('&lt;angle&gt; &amp; ampersand');
    expect(text).toContain(']]&gt;');
    expect(text).toContain('<hr class="scene-break"/>');
    expect(text).not.toContain('\u0001');
    expect(text).not.toContain('wiki-link');
  });

  it('embeds pictures with labels, and turns videos into labels and links', () => {
    const text = chapterText();
    expect(text).toContain('class="figure figure-left"');
    expect(text).toContain('src="images/img-asset-portrait.png"');
    expect(names).toContain('OEBPS/images/img-asset-portrait.png');
    expect(text).toContain('<span class="figure-name">Picture 1.</span>');
    expect(text).not.toContain('<video');
    expect(text).toContain('class="video-missing"');
    expect(text).toContain('The ride to the gate');
    expect(text).toContain('<a href="https://example.com/ride.mp4">');
    expect(text).toContain('<span class="figure-name">Table 1.</span>');
    expect(names.some((n) => n.endsWith('.mp4'))).toBe(false);
  });

  it('turns references into linked notes', () => {
    const text = chapterText();
    expect(text).toContain('epub:type="noteref"');
    expect(text).toContain('epub:type="footnote"');
    expect(text).toContain('A source');
  });

  it('has a title page and part page', () => {
    const titlePage = strFromU8(files[names.find((n) => n.includes('title'))!]);
    expect(titlePage).toContain('The Silver Road');
    expect(titlePage).toContain('Book One');
    expect(titlePage).toContain('Élodie &quot;E.&quot; Writer');
    expect(strFromU8(files[names.find((n) => n.includes('part'))!])).toContain('Part Two: Night');
  });

  it('holds all books, with each one in the contents', () => {
    const all = unzipSync(exportEpub(fixtureInput({ scope: 'books' })));
    const navText = parseStrict(strFromU8(all['OEBPS/nav.xhtml']), 'application/xhtml+xml');
    const top = [...navText.querySelector('nav')!.querySelector('ol')!.children].map((li) => li.querySelector('a')!.textContent);
    expect(top).toEqual(['The Silver Road', 'Second & Last']);
    const package_ = parseStrict(strFromU8(all['OEBPS/content.opf']), 'application/xml');
    expect(package_.getElementsByTagName('dc:title')[0].textContent).toBe('The Vale & <Co>');
  });

  it('still makes a valid file from an empty book', () => {
    const snapshot = fixtureSnapshot();
    snapshot.nodes = [];
    const empty = unzipSync(exportEpub(fixtureInput({ ...oneBook }, snapshot)));
    parseStrict(strFromU8(empty['OEBPS/nav.xhtml']), 'application/xhtml+xml');
    expect(parseStrict(strFromU8(empty['OEBPS/content.opf']), 'application/xml').getElementsByTagName('itemref').length).toBeGreaterThan(0);
  });
});

describe('PDF source documents', () => {
  const parse = (html: string) => new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');

  function expectInternalLinksResolve(page: Document) {
    for (const link of page.querySelectorAll('a[href^="#"]')) {
      const id = link.getAttribute('href')!.slice(1);
      expect(page.getElementById(id), `#${id}`).not.toBeNull();
    }
  }

  describe('a whole wiki', () => {
    const made = buildWikiPrintDocument(fixtureInput({ scope: 'wiki', pageSize: 'a4' }));
    const page = parse(made.html);

    it('has a title page, contents with a slot per page, and every article', () => {
      expect(page.querySelector('.title-page h1')!.textContent).toBe('The Vale & <Co>');
      expect(page.querySelectorAll('.wiki-article').length).toBe(fixtureSnapshot().pages.length);
      const slots = [...page.querySelectorAll('[data-page-of]')];
      expect(slots.length).toBe(fixtureSnapshot().pages.length);
      for (const slot of slots) expect(page.getElementById(slot.getAttribute('data-page-of')!)).not.toBeNull();
      expect(made.css).toContain('size: 210mm 297mm');
      expect(made.css).toContain('counter(page)');
    });

    it('every link inside the document has a target', () => {
      expectInternalLinksResolve(page);
      expect(page.querySelectorAll('a[href^="#"]').length).toBeGreaterThan(20);
    });

    it('keeps article parts, with ids that do not collide', () => {
      const ids = [...page.querySelectorAll('[id]')].map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
      const aria = [...page.querySelectorAll('.wiki-article')].find((a) => a.querySelector('.page-title')!.textContent === 'Aria Vale')!;
      expect(aria.querySelector('.contents')!.textContent).toContain('Death');
      expect(aria.querySelector('.infobox img')!.getAttribute('src')).toBe('#asset/asset-portrait');
      expect(aria.querySelector('.references')!.textContent).toContain('Annals');
      expect(aria.querySelector('.categories')!.textContent).toContain('Characters');
      expect(aria.querySelector('figure.figure-right img')!.getAttribute('src')).toBe('#asset/asset-map');
      expect(aria.querySelector('figure.figure-right')!.getAttribute('style')).toContain('45%');
      expect(aria.querySelector('.wiki-link-red')).not.toBeNull();
    });

    it('treats video as a labeled placeholder or link, and takes no remote images', () => {
      expect(page.querySelector('video')).toBeNull();
      expect(made.html).toContain('class="video-missing"');
      expect(made.html).toContain('<a href="https://example.com/ride.mp4">');
      expect(made.html).not.toContain('evil.example');
      expect(made.html).not.toContain('javascript:');
      expect(made.html).not.toContain('\u0001');
    });

    it('holds no image bytes, which the print page fetches itself', () => {
      expect(made.html).not.toContain('base64');
    });
  });

  it('a single page has no title page, and unlinks pages not in the PDF', () => {
    const made = buildWikiPrintDocument(fixtureInput({ scope: 'page', pageId: 'aria', pageSize: 'letter' }));
    const page = parse(made.html);
    expect(made.title).toBe('Aria Vale');
    expect(page.querySelector('.title-page')).toBeNull();
    expect(page.querySelectorAll('.wiki-article').length).toBe(1);
    expectInternalLinksResolve(page);
    // Silver Vale exists but is not in this PDF. A missing page is still red.
    expect(page.querySelector('a[href*="silver"]')).toBeNull();
    expect(page.querySelector('.article')!.textContent).toContain('the Vale');
    expect([...page.querySelectorAll('.article .wiki-link-red')].map((e) => e.textContent)).toContain('a missing page');
    expect(made.css).toContain('size: 8.5in 11in');
  });

  describe('a novel', () => {
    const made = buildNovelPrintDocument(fixtureInput({ ...oneBook, language: 'fr' }));
    const page = parse(made.html);

    it('has a title page, contents, chapters and separators', () => {
      expect(made.title).toBe('The Silver Road');
      expect(made.author).toBe('Élodie "E." Writer');
      expect(made.language).toBe('fr');
      expect(page.querySelector('.title-page .book-title')!.textContent).toBe('The Silver Road');
      expect(page.querySelector('.title-page .subtitle')!.textContent).toBe('Book One');
      expect([...page.querySelectorAll('.toc-title')].map((e) => e.textContent)).toEqual(['Arrival', 'Part Two: Night', 'Snow & Ice']);
      expect(page.querySelector('.part-title')!.textContent).toBe('Part Two: Night');
      expect(page.querySelector('.chapter-title')!.textContent).toBe('Arrival');
      expect(page.querySelector('.scene-break')!.textContent).toBe('* * *');
      expect(made.css).toContain('size: 6in 9in');
      expectInternalLinksResolve(page);
    });

    it('has no wiki links, and floats pictures so text wraps', () => {
      expect(page.querySelector('.wiki-link, .wiki-link-red')).toBeNull();
      const figure = page.querySelector('figure.figure-left')!;
      expect(figure.querySelector('img')!.getAttribute('src')).toBe('#asset/asset-portrait');
      expect(figure.querySelector('figcaption')!.textContent).toBe('Picture 1. Aria, by Silver');
    });

    it('nests headings so bookmarks follow the book', () => {
      expect(page.querySelector('h1.book-title')).not.toBeNull();
      expect(page.querySelector('h1.part-title')).not.toBeNull();
      expect(page.querySelector('h2.chapter-title')).not.toBeNull();
    });

    it('collects citations as notes at the end of a chapter', () => {
      expect(page.querySelector('.chapter-notes li')!.textContent).toBe('A source');
      expectInternalLinksResolve(page);
    });

    it('can be a manuscript, with a running head that escapes its text', () => {
      const manuscript = buildNovelPrintDocument(fixtureInput({ ...oneBook, manuscriptFormat: true, pageSize: 'a5' }));
      expect(manuscript.html).toContain('doc-manuscript');
      expect(manuscript.html).toContain('about ');
      expect(manuscript.html).toContain('THE END');
      expect(manuscript.html).not.toContain('book-contents');
      expect(parse(manuscript.html).querySelector('.scene-break')!.textContent).toBe('#');
      expect(manuscript.css).toContain('size: 8.5in 11in');
      expect(manuscript.css).toContain('"Writer / The Silver Road / "');
      expect(manuscript.css).toContain('@top-right');
    });

    it('holds all books, with figure numbers per book', () => {
      const all = buildNovelPrintDocument(fixtureInput({ scope: 'books' }));
      expect(all.title).toBe('The Vale & <Co>');
      const body = parse(all.html);
      expect([...body.querySelectorAll('.book-title')].map((e) => e.textContent)).toEqual(['The Silver Road', 'Second & Last']);
      expect(body.querySelectorAll('h2.part-title').length).toBe(1);
      expectInternalLinksResolve(body);
    });
  });
});

describe('a 100,000-word book', () => {
  const big = bigBookSnapshot(100_000);
  const input = (overrides: Partial<ExportOptions> = {}): ExportInput => {
    const options = { ...DEFAULT_OPTIONS, scope: 'book' as const, bookId: 'big', ...overrides };
    const scoped = applyScope(big, options);
    return { snapshot: scoped.snapshot, excludedPages: scoped.excludedPages, assetData: new Map(), options, exportedAt: '2024-06-01T12:00:00.000Z' };
  };

  const total = big.nodes.reduce((sum, n) => sum + n.wordCount, 0);
  it('really is that long', () => {
    expect(total).toBeGreaterThan(95_000);
    expect(total).toBeLessThan(110_000);
  });

  const timed = async <T,>(name: string, limitMs: number, run: () => T | Promise<T>): Promise<T> => {
    const start = performance.now();
    const out = await run();
    const elapsed = performance.now() - start;
    // eslint-disable-next-line no-console
    console.log(`${name}: ${Math.round(elapsed)} ms`);
    expect(elapsed, name).toBeLessThan(limitMs);
    return out;
  };

  it('every format finishes in reasonable time and holds the whole text', async () => {
    const lastLine = 'Paragraph 0';
    expect(decode(await timed('JSON', 5000, () => exportJson(input())))).toContain(lastLine);
    expect(decode(await timed('JSONL', 5000, () => exportJsonl(input()))).split('\n').length).toBeGreaterThan(200);
    expect((await timed('Markdown', 8000, () => exportMarkdown(input()))).length).toBeGreaterThan(1000);
    expect(decode(await timed('YAML', 15000, () => exportYaml(input())))).toContain(lastLine);
    expect(decode(await timed('XML', 8000, () => exportXml(input())))).toContain(lastLine);
    expect((await timed('CSV', 5000, () => exportCsv(input({ csvBundle: true })))).length).toBeGreaterThan(1000);
    expect(decode(await timed('novel Markdown', 5000, () => exportNovelMarkdown(input())))).toContain(lastLine);
    expect(decode(await timed('novel text', 5000, () => exportNovelText(input())))).toContain(lastLine);
    const epub = await timed('EPUB', 10000, () => exportEpub(input()));
    expect(Object.keys(unzipSync(epub)).filter((n) => n.includes('chapter')).length).toBe(40);
    const printed = await timed('PDF source', 5000, () => buildNovelPrintDocument(input()));
    expect(printed.html.length).toBeGreaterThan(500_000);
    const docx = await timed('DOCX', 30000, () => exportDocx(input()));
    const text = (await timed('mammoth reading it back', 60000, () => mammoth.extractRawText({ buffer: Buffer.from(docx) }))).value;
    expect(text.split(/\s+/).length).toBeGreaterThan(95_000);
  }, 180_000);

  it('the site handles many pages', () => {
    const many = fixtureSnapshot();
    const template = many.pages[1];
    for (let i = 0; i < 1000; i += 1) {
      many.pages.push({ ...template, id: `extra-${i}`, title: `Extra Page ${i}`, aliases: [], infobox: { fields: [] } });
    }
    const start = performance.now();
    const files = unzipSync(exportSite(fixtureInput({ scope: 'wiki' }, many)));
    expect(performance.now() - start).toBeLessThan(30_000);
    expect(Object.keys(files).filter((p) => p.startsWith('pages/')).length).toBeGreaterThan(1000);
  }, 60_000);
});
