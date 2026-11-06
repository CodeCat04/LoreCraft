/**
 * The novel as EPUB 3. The structure is the standard one: an uncompressed `mimetype`
 * first in the zip, `META-INF/container.xml`, an OPF package, a navigation document, and
 * one XHTML file per chapter. A `toc.ncx` is included for older readers.
 */

import { strToU8, zipSync, type Zippable } from 'fflate';

import { escapeHtml, pmToHtml } from '../../editor/convert';
import { t } from '../../lib/i18n';
import type { AssetMeta, ExportInput } from '../types';
import { base64ToBytes, languageTag, onlyOutsideLinks, xmlAttr, xmlSafe, xmlText } from '../util';
import type { MatterKey, MatterSection } from './matter';
import { figureNumberer, outlineBooks, type ChapterOutline } from './structure';

/** What EPUB readers must be able to show. Anything else needs a fallback in the file. */
const CORE_IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const STYLESHEET = `@charset "UTF-8";
body { margin: 5%; font-family: serif; line-height: 1.5; }
h1, h2, h3, h4 { font-family: serif; font-weight: normal; text-align: center; line-height: 1.25; }
h1 { font-size: 1.6em; margin: 3em 0 1.5em; }
h2 { font-size: 1.3em; margin: 2em 0 1em; }
h3 { font-size: 1.1em; margin: 1.5em 0 0.5em; }
p { margin: 0; text-indent: 1.5em; text-align: justify; }
h1 + p, h2 + p, h3 + p, h4 + p, hr + p, .scene > p:first-child, blockquote p, li p, td p, th p, figcaption, .title-page p { text-indent: 0; }
hr.scene-break { border: 0; margin: 1.5em 0; text-align: center; }
hr.scene-break::before { content: "* * *"; }
blockquote { margin: 1em 1.5em; font-style: italic; }
pre { white-space: pre-wrap; font-size: 0.9em; }
table { border-collapse: collapse; margin: 1em auto; }
th, td { border: 1px solid #888; padding: 0.25em 0.5em; }
.title-page { text-align: center; margin-top: 25%; }
.title-page h1 { font-size: 2.2em; margin: 0 0 0.5em; }
.subtitle { font-style: italic; font-size: 1.2em; }
.author { margin-top: 2em; font-size: 1.1em; }
.part-page { text-align: center; margin-top: 30%; }
.figure { margin: 0.5em 0 1em; }
.figure-right { float: right; clear: right; width: 40%; margin-left: 1em; }
.figure-left { float: left; clear: left; width: 40%; margin-right: 1em; }
.figure-center { width: 60%; margin-left: auto; margin-right: auto; }
.figure-full { width: 100%; }
.figure img { display: block; width: 100%; height: auto; }
figcaption { font-size: 0.85em; margin-top: 0.3em; text-align: left; }
.figure-name { font-weight: bold; }
.video-missing { text-align: center; font-style: italic; }
aside.footnote { font-size: 0.9em; }
.cover-page { margin: 0; padding: 0; text-align: center; }
.cover-page img { max-width: 100%; max-height: 100vh; }
.matter p { text-indent: 0; margin: 0 0 0.6em; text-align: left; }
.matter-copyright { margin-top: 40%; font-size: 0.85em; }
.matter-dedication, .matter-epigraph { margin-top: 25%; text-align: center; }
.matter-dedication p, .matter-epigraph p { text-align: center; }
.matter-epigraph { font-style: italic; }
`;

/** How a reading system is told what each kind of page is. */
const MATTER_TYPES: Record<MatterKey, string> = {
  copyright: 'copyright-page',
  dedication: 'dedication',
  epigraph: 'epigraph',
  acknowledgments: 'acknowledgments',
  aboutAuthor: 'backmatter',
  appendix: 'appendix',
};

function xhtml(language: string, title: string, body: string): string {
  const lang = xmlAttr(language);
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n' +
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}">\n` +
    `<head>\n<meta charset="UTF-8"/>\n<title>${xmlText(title)}</title>\n` +
    '<link rel="stylesheet" type="text/css" href="style.css"/>\n</head>\n' +
    `<body>\n${body}\n</body>\n</html>\n`
  );
}

interface TocEntry {
  title: string;
  href: string;
  children: TocEntry[];
}

function navList(entries: TocEntry[]): string {
  return `<ol>${entries
    .map(
      (e) =>
        `<li><a href="${xmlAttr(e.href)}">${xmlText(e.title)}</a>${e.children.length ? navList(e.children) : ''}</li>`,
    )
    .join('')}</ol>`;
}

/**
 * NCX 2005-1 wants one play order per page: a book's entry and its first chapter can be
 * the same file, and two numbers for one file is an error.
 */
function ncxPoints(entries: TocEntry[], counter: { n: number }, order: Map<string, number>): string {
  return entries
    .map((e) => {
      counter.n += 1;
      if (!order.has(e.href)) order.set(e.href, order.size + 1);
      return (
        `<navPoint id="nav-${counter.n}" playOrder="${order.get(e.href)}"><navLabel><text>${xmlText(e.title)}</text></navLabel>` +
        `<content src="${xmlAttr(e.href)}"/>${ncxPoints(e.children, counter, order)}</navPoint>`
      );
    })
    .join('');
}

/** Text for a title or label, which a reader shows as a gap, or a validator rejects, if empty. */
function label(value: string, fallback: string): string {
  return xmlSafe(value).replace(/\s+/g, ' ').trim() || fallback;
}

function ncxDepth(entries: TocEntry[]): number {
  return entries.reduce((depth, e) => Math.max(depth, 1 + ncxDepth(e.children)), 0);
}

export function exportEpub(input: ExportInput): Uint8Array {
  const { snapshot, options } = input;
  // Readers need a real tag to hyphenate, and EPUB requires one.
  const { tag: language, valid } = languageTag(options.language);
  if (!valid) {
    input.warn?.(t('"{code}" is not a language code such as en or pt-BR, so the ebook says it is in English (en).', { code: options.language.trim() }));
  }
  const outlines = outlineBooks(snapshot);
  const manyBooks = outlines.length > 1;
  const content: Record<string, string> = { 'style.css': STYLESHEET };
  const spine: string[] = [];
  const toc: TocEntry[] = [];

  const firstOf: { coverId?: string; coverFile?: string; titleFile?: string } = {};

  const assetOf = new Map(snapshot.assets.map((a) => [a.id, a]));
  const usedImages = new Map<string, AssetMeta>();
  // An asset keeps the id it had in an imported file, which may hold spaces, "#" or ":".
  // Those cannot go in a file name, a URL or a manifest id, so such a picture is numbered.
  const imageNames = new Map<string, string>();
  const takenNames = new Set<string>();
  const imageName = (id: string): string => {
    let name = imageNames.get(id);
    if (name) return name;
    name = `img-${id}`;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || takenNames.has(name.toLowerCase())) {
      let n = imageNames.size + 1;
      while (takenNames.has(`img-${n}`)) n += 1;
      name = `img-${n}`;
    }
    imageNames.set(id, name);
    takenNames.add(name.toLowerCase());
    return name;
  };
  const imageFile = (asset: AssetMeta) => `images/${imageName(asset.id)}.${CORE_IMAGE_TYPES[asset.mime]}`;
  const assetSrc = (id: string): string | null => {
    const asset = assetOf.get(id);
    const extension = asset ? CORE_IMAGE_TYPES[asset.mime] : undefined;
    if (!asset || !extension || !input.assetData.has(id)) return null;
    usedImages.set(id, asset);
    return imageFile(asset);
  };

  let fileNumber = 0;
  const addFile = (prefix: string, title: string, body: string): string => {
    fileNumber += 1;
    const name = `${prefix}${String(fileNumber).padStart(4, '0')}.xhtml`;
    content[name] = xhtml(language, title, body);
    spine.push(name);
    return name;
  };

  outlines.forEach((outline, bookIndex) => {
    const { book } = outline;
    const { matter } = book;
    const title = label(book.title, 'Untitled');
    const firstFile = fileNumber;
    const coverSrc = matter?.coverAssetId ? assetSrc(matter.coverAssetId) : null;
    if (coverSrc) {
      const file = addFile(
        'cover',
        'Cover',
        `<section class="cover-page" epub:type="cover"><img src="${xmlAttr(coverSrc)}" alt="${xmlAttr(`Cover of ${title}`)}"/></section>`,
      );
      // A reader's library shows one cover, so with many books it is the first book's.
      if (!firstOf.coverId) {
        firstOf.coverId = matter?.coverAssetId ?? undefined;
        firstOf.coverFile = file;
      }
    }
    if (matter?.titlePage !== false) {
      const titlePage =
        '<section class="title-page" epub:type="titlepage">' +
        `<h1>${escapeHtml(title)}</h1>` +
        (book.subtitle ? `<p class="subtitle">${escapeHtml(xmlSafe(book.subtitle))}</p>` : '') +
        (book.author ? `<p class="author">${escapeHtml(xmlSafe(book.author))}</p>` : '') +
        '</section>';
      const file = addFile('title', title, titlePage);
      firstOf.titleFile ??= file;
    }
    const bookEntries: TocEntry[] = [];
    const next = figureNumberer();

    const matterFile = (section: MatterSection, heading: boolean): string => {
      const html = pmToHtml(onlyOutsideLinks(section.doc), { assetSrc, remoteImages: false, nextFigure: next });
      const shown = heading ? `<h1>${escapeHtml(section.title)}</h1>` : '';
      return addFile(
        'matter',
        section.title,
        `<section class="matter matter-${section.key}" epub:type="${MATTER_TYPES[section.key]}">${shown}${html}</section>`,
      );
    };
    for (const section of matter?.front ?? []) matterFile(section, false);

    const chapterFile = (chapter: ChapterOutline): TocEntry => {
      let notes = '';
      let noteCount = 0;
      const prefix = `n${fileNumber + 1}-`;
      const parts: string[] = [];
      chapter.scenes.forEach((scene, index) => {
        const sceneTitle = options.sceneTitles ? label(scene.node.title, '') : '';
        if (sceneTitle) parts.push(`<h2>${escapeHtml(sceneTitle)}</h2>`);
        else if (index > 0) parts.push('<hr class="scene-break"/>');
        const html = pmToHtml(onlyOutsideLinks(scene.doc), {
          assetSrc,
          remoteImages: false,
          nextFigure: next,
          reference: (text) => {
            noteCount += 1;
            const n = noteCount;
            notes += `<aside class="footnote" epub:type="footnote" id="${prefix}${n}"><p>${n}. ${escapeHtml(text)}</p></aside>`;
            return `<a epub:type="noteref" href="#${prefix}${n}"><sup>${n}</sup></a>`;
          },
        });
        parts.push(`<div class="scene">${html}</div>`);
      });
      const chapterTitle = label(chapter.title, 'Chapter');
      const body =
        `<section epub:type="chapter" role="doc-chapter"><h1>${escapeHtml(chapterTitle)}</h1>${parts.join('')}</section>${notes}`;
      return { title: chapterTitle, href: addFile('chapter', chapterTitle, body), children: [] };
    };

    for (const item of outline.items) {
      if (item.type === 'part') {
        const partTitle = label(item.title, 'Part');
        const partFile = addFile(
          'part',
          partTitle,
          `<section class="part-page" epub:type="part"><h1>${escapeHtml(partTitle)}</h1></section>`,
        );
        bookEntries.push({ title: partTitle, href: partFile, children: item.chapters.map(chapterFile) });
      } else {
        bookEntries.push(chapterFile(item));
      }
    }
    for (const section of matter?.back ?? []) {
      bookEntries.push({ title: section.title, href: matterFile(section, true), children: [] });
    }
    // Everything above may be turned off, but a book with no files still has a place to point.
    if (fileNumber === firstFile) addFile('title', title, `<section class="title-page"><h1>${escapeHtml(title)}</h1></section>`);
    const startFile = spine[spine.length - (fileNumber - firstFile)];
    if (manyBooks) toc.push({ title, href: startFile, children: bookEntries });
    else toc.push(...bookEntries);
    input.progress?.(bookIndex + 1, outlines.length);
  });

  // The navigation document is required, and must not be the only thing in the spine.
  if (spine.length === 0) addFile('title', 'Empty', '<p>This book has no chapters yet.</p>');
  const single = outlines.length === 1 ? outlines[0].book : null;
  const docTitle = label(single?.title ?? '', '') || label(snapshot.meta.name ?? '', 'Untitled');
  const nav =
    `<nav epub:type="toc" id="toc"><h1>Contents</h1>${navList(toc.length ? toc : [{ title: docTitle, href: spine[0], children: [] }])}</nav>` +
    '<nav epub:type="landmarks" hidden="hidden"><ol>' +
    (firstOf.coverFile ? `<li><a epub:type="cover" href="${xmlAttr(firstOf.coverFile)}">Cover</a></li>` : '') +
    (firstOf.titleFile ? `<li><a epub:type="titlepage" href="${xmlAttr(firstOf.titleFile)}">Title page</a></li>` : '') +
    '<li><a epub:type="toc" href="nav.xhtml">Contents</a></li>' +
    `<li><a epub:type="bodymatter" href="${xmlAttr(spine.find((name) => name.startsWith('chapter') || name.startsWith('part')) ?? spine[0])}">Start</a></li></ol></nav>`;
  content['nav.xhtml'] = xhtml(language, 'Contents', nav);

  const identifier = `urn:uuid:${single?.id ?? snapshot.meta.project_id ?? '00000000-0000-4000-8000-000000000000'}`;
  const ncx =
    '<?xml version="1.0" encoding="UTF-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">' +
    `<head><meta name="dtb:uid" content="${xmlAttr(identifier)}"/><meta name="dtb:depth" content="${Math.max(1, ncxDepth(toc))}"/>` +
    '<meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>' +
    `<docTitle><text>${xmlText(docTitle)}</text></docTitle><navMap>` +
    `${ncxPoints(toc.length ? toc : [{ title: docTitle, href: spine[0], children: [] }], { n: 0 }, new Map())}</navMap></ncx>\n`;

  const authors = [...new Set(outlines.map((o) => xmlSafe(o.book.author).trim()).filter(Boolean))];
  const modified = new Date(input.exportedAt).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const details = single?.publishing ?? {};
  const clean = (value: string | undefined) => xmlSafe(value ?? '').trim();
  const year = /^\d{4}$/.test(clean(details.copyrightYear)) ? clean(details.copyrightYear) : '';
  const rights = clean(details.copyrightYear) || authors[0] ? `Copyright © ${[clean(details.copyrightYear), authors[0]].filter(Boolean).join(' ')}` : '';
  const isbn = clean(details.isbn).replace(/[\s-]/g, '');
  const series = clean(details.series);
  const seriesNumber = clean(details.seriesNumber);
  const metadata = [
    isbn ? `<dc:identifier id="isbn">urn:isbn:${xmlText(isbn)}</dc:identifier>` : '',
    clean(details.description) ? `<dc:description>${xmlText(clean(details.description))}</dc:description>` : '',
    clean(details.publisher) ? `<dc:publisher>${xmlText(clean(details.publisher))}</dc:publisher>` : '',
    year ? `<dc:date>${year}</dc:date>` : '',
    single && rights ? `<dc:rights>${xmlText(rights)}</dc:rights>` : '',
    series ? `<meta property="belongs-to-collection" id="series">${xmlText(series)}</meta>` : '',
    series ? '<meta refines="#series" property="collection-type">series</meta>' : '',
    series && seriesNumber ? `<meta refines="#series" property="group-position">${xmlText(seriesNumber)}</meta>` : '',
    // Calibre and some older readers look for these instead.
    series ? `<meta name="calibre:series" content="${xmlAttr(series)}"/>` : '',
    series && seriesNumber ? `<meta name="calibre:series_index" content="${xmlAttr(seriesNumber)}"/>` : '',
    firstOf.coverId ? `<meta name="cover" content="${imageName(firstOf.coverId)}"/>` : '',
  ]
    .filter(Boolean)
    .map((line) => `${line}\n`)
    .join('');
  const textFiles = Object.keys(content).filter((name) => name.endsWith('.xhtml') && name !== 'nav.xhtml');
  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    '<item id="style" href="style.css" media-type="text/css"/>',
    ...textFiles.map((name) => `<item id="${name.replace('.xhtml', '')}" href="${name}" media-type="application/xhtml+xml"/>`),
    ...[...usedImages.values()].map((asset) => {
      const properties = asset.id === firstOf.coverId ? ' properties="cover-image"' : '';
      return `<item id="${imageName(asset.id)}" href="${imageFile(asset)}" media-type="${asset.mime}"${properties}/>`;
    }),
  ];
  const opf =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" ' +
    `xml:lang="${xmlAttr(language)}">\n<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n` +
    `<dc:identifier id="book-id">${xmlText(identifier)}</dc:identifier>\n` +
    `<dc:title>${xmlText(docTitle)}</dc:title>\n<dc:language>${xmlText(language)}</dc:language>\n` +
    authors.map((a) => `<dc:creator>${xmlText(a)}</dc:creator>\n`).join('') +
    metadata +
    `<meta property="dcterms:modified">${modified}</meta>\n</metadata>\n` +
    `<manifest>\n${manifest.join('\n')}\n</manifest>\n<spine toc="ncx">\n` +
    spine.map((name) => `<itemref idref="${name.replace('.xhtml', '')}"/>`).join('\n') +
    // The landmarks link to the contents, and EPUB 3.3 wants whatever the navigation
    // document links to in the spine. Out of the reading order, as before.
    '\n<itemref idref="nav" linear="no"/>\n</spine>\n</package>\n';

  const files: Zippable = {
    // Readers find out what this file is from these exact first bytes.
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
        '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>\n',
    ),
    'OEBPS/content.opf': strToU8(opf),
    'OEBPS/toc.ncx': strToU8(ncx),
  };
  for (const [name, text] of Object.entries(content)) files[`OEBPS/${name}`] = strToU8(text);
  for (const asset of usedImages.values()) {
    const data = input.assetData.get(asset.id) as string;
    files[`OEBPS/${imageFile(asset)}`] = [base64ToBytes(data), { level: 0 }];
  }
  return zipSync(files);
}
