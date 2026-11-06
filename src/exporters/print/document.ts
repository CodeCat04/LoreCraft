/**
 * Builds the HTML that the print window turns into a PDF: a wiki page, the whole wiki, a
 * book or all books. The browser engine then provides what a PDF library could not:
 * text wrapped around floated pictures, full Unicode through system fonts, and links.
 *
 * Images are written as `#asset/<id>`. The print page swaps in the real file, so image
 * bytes never pass through this code.
 */

import { escapeHtml, pmToHtml } from '../../editor/convert';
import { titleKey } from '../../lib/text';
import type { Page } from '../../lib/types';
import type { ExportInput, ExportOptions, PrintDocument } from '../types';
import { ASSET_URL_PREFIX, NO_HEAD_STYLE, RUNNING_HEAD_ATTRIBUTE, headStyles, headWords } from './constants';
import { isEmptyDoc, languageTag, onlyOutsideLinks, pageResolver, xmlSafe } from '../util';
import type { MatterSection } from '../novel/matter';
import { figureNumberer, outlineBooks, roundedWords, type BookOutline, type ChapterOutline } from '../novel/structure';
import { renderArticle, type ArticleLinks } from '../wiki/article';

export { ASSET_URL_PREFIX };

const PAGE_SIZES: Record<ExportOptions['pageSize'], string> = {
  pocket: '5in 8in',
  digest: '5.5in 8.5in',
  trade: '6in 9in',
  a5: '148mm 210mm',
  a4: '210mm 297mm',
  letter: '8.5in 11in',
};

/** Text for a CSS `content` string. */
function cssString(text: string): string {
  return `"${xmlSafe(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s+/g, ' ')}"`;
}

function assetSrc(id: string): string {
  return `${ASSET_URL_PREFIX}${id}`;
}

/** One line of a table of contents. The print page fills in the page number. */
function contentsLine(target: string, title: string, level: number): string {
  return (
    `<li class="toc-line toc-depth-${level}"><a href="#${target}"><span class="toc-title">${escapeHtml(title)}</span>` +
    `<span class="toc-dots"></span><span class="toc-page" data-page-of="${target}">000</span></a></li>`
  );
}

// ---------------------------------------------------------------------------
// Wiki
// ---------------------------------------------------------------------------

function articleHtml(page: Page, links: ArticleLinks, project: string, index: number, breakBefore: boolean): string {
  const article = renderArticle(page, links, project, `p${index}-`);
  return (
    `<article class="wiki-article${breakBefore ? ' new-page' : ''}">` +
    `<h1 class="page-title" id="page-${index}">${escapeHtml(page.title)}</h1>${article.head}` +
    `<div class="article">${article.infobox}${article.body}</div>${article.references}${article.categories}</article>`
  );
}

export function buildWikiPrintDocument(input: ExportInput): PrintDocument {
  const { snapshot, options } = input;
  const project = snapshot.meta.name || 'LoreCraft';
  const single = options.scope === 'page' || snapshot.pages.length === 1;
  const indexOf = new Map(snapshot.pages.map((p, i) => [p.id, i]));
  const links: ArticleLinks = {
    resolve: pageResolver(snapshot.pages, titleKey),
    excludedPages: input.excludedPages,
    pageHref: (page) => {
      const index = indexOf.get(page.id);
      return index === undefined ? null : `#page-${index}`;
    },
    assetSrc,
  };

  const parts: string[] = [];
  if (!single) {
    parts.push(
      `<section class="title-page"><h1>${escapeHtml(project)}</h1><p class="subtitle">A wiki of ${snapshot.pages.length} pages</p></section>`,
      '<nav class="book-contents new-page"><h2 class="contents-heading">Contents</h2><ol>',
      ...snapshot.pages.map((page, i) => contentsLine(`page-${i}`, page.title, 0)),
      '</ol></nav>',
    );
  }
  snapshot.pages.forEach((page, index) => {
    parts.push(articleHtml(page, links, project, index, !single));
    input.progress?.(index + 1, snapshot.pages.length);
  });

  const size = PAGE_SIZES[options.pageSize];
  const css =
    `@page { size: ${size}; margin: 0.9in 0.9in 0.9in 0.9in; @bottom-center { content: counter(page); font-family: 'Inter', sans-serif; font-size: 9pt; color: #555; } }\n` +
    '@page title-page { @bottom-center { content: none; } }\n';
  return {
    title: single && snapshot.pages[0] ? snapshot.pages[0].title : project,
    author: '',
    // The page's lang, which picks hyphenation and fonts, and the PDF's language.
    language: languageTag(options.language).tag,
    css,
    html: xmlSafe(`<main class="doc doc-wiki">${parts.join('')}</main>`),
  };
}

// ---------------------------------------------------------------------------
// Novel
// ---------------------------------------------------------------------------

/** The margin boxes a print-ready page can use, all off. */
const NO_MARGIN_BOXES = ['top-left', 'top-right', 'bottom-left', 'bottom-right']
  .map((box) => `@${box} { content: none; }`)
  .join(' ');

/** Front matter and blank pages carry no heads or numbers. */
const QUIET_PAGES = ['title-page', 'front-matter', 'part-divider', 'blank-page'];

function printReadyCss(options: ExportOptions, outline: BookOutline | undefined, heads: RunningHead[]): string {
  const size = PAGE_SIZES[options.pageSize];
  const box = "font-family: 'Source Serif 4', serif; font-size: 9pt;";
  // The inner margin is wider, because the binding swallows part of the page.
  const inner = options.mirrorMargins ? '0.875in' : '0.75in';
  const outer = options.mirrorMargins ? '0.625in' : '0.75in';
  const rules = [
    `@page { size: ${size}; margin-top: 0.8in; margin-bottom: 0.8in; }`,
    `@page :left { margin-left: ${outer}; margin-right: ${inner}; @bottom-left { content: counter(page); ${box} } }`,
    `@page :right { margin-left: ${inner}; margin-right: ${outer}; @bottom-right { content: counter(page); ${box} } }`,
  ];
  if (options.runningHeaders) {
    const bookTitle = outline?.book.title ?? '';
    rules.push(`@page :left { @top-left { content: ${cssString(bookTitle)}; ${box} font-style: italic; } }`);
    if (heads.length > 0) rules.push(`@counter-style ${NO_HEAD_STYLE} { system: cyclic; symbols: ""; }`);
    // Named pages give each chapter its own words, which a page rule cannot otherwise do.
    // The words are counter styles of the page number, which the print page narrows to the
    // pages after the chapter's first once it knows where that falls (see RUNNING_HEAD_ATTRIBUTE).
    for (const head of heads) {
      const words = headWords(head.page);
      const styles = headStyles(head.page);
      rules.push(
        `.${head.page} { page: ${head.page}; }`,
        `@counter-style ${words.left} { system: cyclic; symbols: ${cssString(head.bookTitle)}; }`,
        `@counter-style ${words.right} { system: cyclic; symbols: ${cssString(head.chapter)}; }`,
        `@counter-style ${styles.left} { system: extends ${words.left}; }`,
        `@counter-style ${styles.right} { system: extends ${words.right}; }`,
        `@page ${head.page}:left { @top-left { content: counter(page, ${styles.left}); ${box} font-style: italic; } }`,
        `@page ${head.page}:right { @top-right { content: counter(page, ${styles.right}); ${box} font-style: italic; } }`,
      );
    }
  }
  for (const name of QUIET_PAGES) {
    rules.push(`@page ${name}:left { ${NO_MARGIN_BOXES} }`, `@page ${name}:right { ${NO_MARGIN_BOXES} }`);
  }
  return `${rules.join('\n')}\n`;
}

interface RunningHead {
  /** The name of the page, and of the class that asks for it. */
  page: string;
  bookTitle: string;
  chapter: string;
}

function novelCss(options: ExportOptions, outline: BookOutline | undefined, heads: RunningHead[]): string {
  if (options.printReady && !options.manuscriptFormat) return printReadyCss(options, outline, heads);
  if (options.manuscriptFormat) {
    const surname = (outline?.book.author ?? '').trim().split(/\s+/).pop() ?? '';
    const head = [surname, outline?.book.title ?? ''].filter(Boolean).join(' / ');
    return (
      `@page { size: 8.5in 11in; margin: 1in; @top-right { content: ${cssString(head ? `${head} / ` : '')} counter(page); font-family: 'Courier Prime', 'Courier New', monospace; font-size: 12pt; } }\n` +
      '@page title-page { @top-right { content: none; } }\n'
    );
  }
  const height = PAGE_SIZES[options.pageSize].split(' ')[1];
  return (
    `@page { size: ${PAGE_SIZES[options.pageSize]}; margin: 0.85in 0.8in 0.9in 0.8in; @bottom-center { content: counter(page); font-family: 'Source Serif 4', serif; font-size: 9.5pt; } }\n` +
    '@page title-page { @bottom-center { content: none; } }\n' +
    '@page front-matter { @bottom-center { content: none; } }\n' +
    '@page cover { margin: 0; @bottom-center { content: none; } }\n' +
    // A hair under the full height, or rounding could push the picture onto a page of its own.
    `.cover-page img { width: 100%; height: calc(${height} - 2pt); }\n`
  );
}

function matterHtml(
  section: MatterSection,
  next: (kind: string) => number,
  classes: string,
  attributes: string,
  heading?: { tag: string; anchor: string },
): string {
  const html = pmToHtml(onlyOutsideLinks(section.doc), { assetSrc, remoteImages: false, nextFigure: next });
  const title = heading
    ? `<${heading.tag} class="chapter-title" id="${heading.anchor}">${escapeHtml(section.title)}</${heading.tag}>`
    : '';
  return `<section class="matter matter-${section.key} ${classes}"${attributes}>${title}${html}</section>`;
}

function chapterHtml(
  chapter: ChapterOutline,
  anchor: string,
  headingTag: string,
  sceneTag: string,
  options: ExportOptions,
  next: (kind: string) => number,
  pageClass = '',
  attributes = '',
): string {
  const separator = options.manuscriptFormat ? '#' : '* * *';
  const notes: string[] = [];
  const parts: string[] = [];
  chapter.scenes.forEach((scene, index) => {
    const sceneTitle = options.sceneTitles ? scene.node.title.trim() : '';
    if (sceneTitle) parts.push(`<${sceneTag} class="scene-title">${escapeHtml(sceneTitle)}</${sceneTag}>`);
    else if (index > 0) parts.push(`<p class="scene-break" aria-hidden="true">${separator}</p>`);
    if (isEmptyDoc(scene.doc)) return;
    const html = pmToHtml(onlyOutsideLinks(scene.doc), {
      assetSrc,
      remoteImages: false,
      nextFigure: next,
      reference: (text) => {
        notes.push(text);
        const n = notes.length;
        return `<sup class="note-mark"><a href="#${anchor}-note-${n}">${n}</a></sup>`;
      },
    });
    parts.push(`<div class="scene">${html}</div>`);
  });
  const notesHtml = notes.length
    ? `<section class="chapter-notes"><h${sceneTag.slice(1)} class="notes-title">Notes</h${sceneTag.slice(1)}><ol>${notes
        .map((text, i) => `<li id="${anchor}-note-${i + 1}">${escapeHtml(text)}</li>`)
        .join('')}</ol></section>`
    : '';
  return (
    `<section class="chapter new-page${pageClass ? ` ${pageClass}` : ''}"${attributes}><${headingTag} class="chapter-title" id="${anchor}">${escapeHtml(chapter.title)}</${headingTag}>` +
    `${parts.join('')}${notesHtml}</section>`
  );
}

export function buildNovelPrintDocument(input: ExportInput): PrintDocument {
  const { snapshot, options } = input;
  const outlines = outlineBooks(snapshot);
  const manyBooks = outlines.length > 1;
  const printReady = options.printReady && !options.manuscriptFormat;
  /** Marks what the print page must start on a right-hand page. */
  const rightPage = printReady && options.chaptersOnRight ? ' data-right-page="true"' : '';
  const heads: RunningHead[] = [];
  /** Asks for a page with this chapter's running head, when there are running heads. */
  const headPage = (bookTitle: string, chapter: string): string => {
    if (!printReady || !options.runningHeaders) return '';
    const page = `running-${heads.length + 1}`;
    heads.push({ page, bookTitle, chapter });
    return page;
  };
  /** Lets the print page find where a chapter with running heads starts. */
  const headAttribute = (page: string) => (page ? ` ${RUNNING_HEAD_ATTRIBUTE}="${page}"` : '');
  const out: string[] = [];
  let anchorNumber = 0;
  const nextAnchor = () => {
    anchorNumber += 1;
    return `sec-${anchorNumber}`;
  };

  outlines.forEach((outline, bookIndex) => {
    const { book } = outline;
    const base = manyBooks ? 2 : 1;
    const partTag = `h${base}`;
    const chapterTag = `h${base + (outline.hasParts ? 1 : 0)}`;
    const sceneTag = `h${base + (outline.hasParts ? 2 : 1)}`;
    const bookAnchor = nextAnchor();

    const toc: string[] = [];
    const body: string[] = [];
    const next = figureNumberer();
    // Worked out first, because figures are numbered in reading order.
    const frontPages = (book.matter?.front ?? []).map((section, index) => {
      const firstThing = index === 0 && bookIndex === 0 && book.matter?.titlePage === false && (!book.matter?.coverAssetId || printReady);
      // Copyright goes on the back of the title page. The others open on the right.
      return matterHtml(section, next, `front-matter${firstThing ? '' : ' new-page'}`, section.key === 'copyright' ? '' : rightPage);
    });
    for (const item of outline.items) {
      if (item.type === 'part') {
        const anchor = nextAnchor();
        toc.push(contentsLine(anchor, item.title, 0));
        body.push(
          `<section class="part-page new-page"${rightPage}><${partTag} class="part-title" id="${anchor}">${escapeHtml(item.title)}</${partTag}></section>`,
        );
        for (const chapter of item.chapters) {
          const chapterAnchor = nextAnchor();
          toc.push(contentsLine(chapterAnchor, chapter.title, 1));
          const head = headPage(book.title, chapter.title);
          body.push(chapterHtml(chapter, chapterAnchor, chapterTag, sceneTag, options, next, head, rightPage + headAttribute(head)));
        }
      } else {
        const anchor = nextAnchor();
        toc.push(contentsLine(anchor, item.title, 0));
        const head = headPage(book.title, item.title);
        body.push(chapterHtml(item, anchor, chapterTag, sceneTag, options, next, head, rightPage + headAttribute(head)));
      }
    }
    for (const section of book.matter?.back ?? []) {
      const anchor = nextAnchor();
      toc.push(contentsLine(anchor, section.title, 0));
      const head = headPage(book.title, section.title);
      body.push(matterHtml(section, next, `chapter new-page ${head}`, rightPage + headAttribute(head), { tag: chapterTag, anchor }));
    }

    const manuscriptHead = options.manuscriptFormat
      ? `<div class="manuscript-head"><span>${escapeHtml(book.author || 'Author')}</span><span>about ${roundedWords(outline.wordCount)} words</span></div>`
      : '';
    // A printer takes the cover as a file of its own, and it would throw the page sides out.
    const cover = book.matter?.coverAssetId && !printReady ? book.matter.coverAssetId : null;
    if (cover) {
      out.push(`<section class="cover-page"><img src="${assetSrc(cover)}" alt="${escapeHtml(`Cover of ${book.title}`)}"/></section>`);
    }
    if (book.matter?.titlePage !== false) {
      out.push(
        `<section class="title-page${bookIndex > 0 || cover ? ' new-page' : ''}"${rightPage}>${manuscriptHead}` +
          // A many-book PDF needs the title in the outline. Otherwise it is the document's own title.
          `<h1 class="book-title" id="${bookAnchor}">${escapeHtml(book.title)}</h1>` +
          (book.subtitle ? `<p class="subtitle">${escapeHtml(book.subtitle)}</p>` : '') +
          (book.author ? `<p class="author">by ${escapeHtml(book.author)}</p>` : '') +
          '</section>',
      );
    }
    out.push(...frontPages);
    if (toc.length > 0 && !options.manuscriptFormat) {
      out.push(`<nav class="book-contents new-page${printReady ? ' front-matter' : ''}"${rightPage}><h2 class="contents-heading">Contents</h2><ol>${toc.join('')}</ol></nav>`);
    }
    out.push(...body);
    if (options.manuscriptFormat) out.push('<p class="the-end">THE END</p>');
    input.progress?.(bookIndex + 1, outlines.length);
  });

  const single = outlines.length === 1 ? outlines[0].book : null;
  return {
    title: single?.title || snapshot.meta.name || 'LoreCraft',
    author: outlines.map((o) => o.book.author.trim()).filter((a, i, all) => a && all.indexOf(a) === i).join(', '),
    language: languageTag(options.language).tag,
    css: novelCss(options, outlines[0], heads),
    html: xmlSafe(
      `<main class="doc doc-novel${options.manuscriptFormat ? ' doc-manuscript' : ''}${printReady ? ' doc-print' : ''}">${out.join('')}</main>`,
    ),
  };
}
