/**
 * Works out what surrounds a book's chapters: its cover, front matter, and back matter
 * with any appendices built from the wiki. Everything comes out as ordinary documents, so
 * each format prints them with the code it already uses for scenes.
 *
 * The order is the usual one for a book. Front: cover, title page, copyright, dedication,
 * epigraph, then contents. Back: appendices, acknowledgments, about the author.
 */

import { pmToPlainText } from '../../editor/convert';
import { t } from '../../lib/i18n';
import type { AppendixSpec, MatterPage, Page, PmNode } from '../../lib/types';
import type { ExportSnapshot, MapInfo, SnapshotBook } from '../types';
import { isEmptyDoc, walkDoc, withoutWikiLinks, xmlSafe, xmlSafeDoc } from '../util';

export type MatterKey = 'copyright' | 'dedication' | 'epigraph' | 'acknowledgments' | 'aboutAuthor' | 'appendix';

export interface MatterSection {
  key: MatterKey;
  /** Shown as a heading on back matter. Front matter pages speak for themselves. */
  title: string;
  doc: PmNode;
}

export interface BookMatter {
  coverAssetId: string | null;
  titlePage: boolean;
  front: MatterSection[];
  back: MatterSection[];
  /** Things the person should hear about, such as an appendix that came out empty. */
  warnings: string[];
}

function text(value: string, marks?: PmNode['marks']): PmNode {
  return marks ? { type: 'text', text: value, marks } : { type: 'text', text: value };
}

function paragraph(...content: PmNode[]): PmNode {
  return { type: 'paragraph', content };
}

function written(page: MatterPage | undefined): PmNode | null {
  if (!page?.include || !page.content || isEmptyDoc(page.content)) return null;
  return withoutWikiLinks(xmlSafeDoc(page.content));
}

/** What a copyright page says when the writer has not written their own. */
function standardCopyright(book: SnapshotBook): PmNode {
  const details = book.publishing ?? {};
  const year = details.copyrightYear?.trim();
  const author = book.author.trim();
  const lines = [
    `Copyright © ${[year, author].filter(Boolean).join(' ')}`.trim(),
    'All rights reserved.',
    details.publisher?.trim() ? `Published by ${details.publisher.trim()}` : '',
    details.isbn?.trim() ? `ISBN ${details.isbn.trim()}` : '',
  ].filter(Boolean);
  return { type: 'doc', content: lines.map((line) => paragraph(text(xmlSafe(line)))) };
}

/** The first thing a page says, for a page with no summary. */
function firstParagraph(page: Page): string {
  let found = '';
  walkDoc(page.content, (node) => {
    if (!found && node.type === 'paragraph') found = pmToPlainText(node).trim();
  });
  return found;
}

/** Whether naming this page at the end of this book would give away a later one. */
function isSpoiler(page: Page, book: SnapshotBook, all: ExportSnapshot): boolean {
  if (!page.revealNodeId) return false;
  const node = all.nodes.find((n) => n.id === page.revealNodeId);
  if (!node) return false;
  const position = (id: string) => all.books.findIndex((b) => b.id === id);
  return position(node.bookId) > position(book.id);
}

function pageAllowed(page: Page, spec: AppendixSpec, book: SnapshotBook, all: ExportSnapshot): boolean {
  if (page.isHome || page.status === 'retconned') return false;
  if (spec.canonOnly && page.status !== 'canon') return false;
  return !(spec.hideSpoilers && isSpoiler(page, book, all));
}

function entriesDoc(spec: AppendixSpec, book: SnapshotBook, all: ExportSnapshot): PmNode | null {
  const types = new Set(spec.pageTypes);
  const categories = new Set(spec.categories);
  const pages = all.pages
    .filter((page) => types.has(page.pageType) || page.categories.some((c) => categories.has(c)))
    .filter((page) => pageAllowed(page, spec, book, all))
    .sort((a, b) => a.title.localeCompare(b.title));
  if (pages.length === 0) return null;
  const separator = spec.kind === 'glossary' ? ': ' : ' ';
  return {
    type: 'doc',
    content: pages.map((page) => {
      const about = (page.summary.trim() || firstParagraph(page)).replace(/\s+/g, ' ');
      return paragraph(
        text(xmlSafe(page.title), [{ type: 'bold' }]),
        ...(about ? [text(xmlSafe(`${separator}${about}`))] : []),
      );
    }),
  };
}

/** Each map as a full-width picture, with the places on it that may be named. */
function mapsDoc(spec: AppendixSpec, book: SnapshotBook, all: ExportSnapshot, maps: MapInfo[]): PmNode | null {
  const pageOf = new Map(all.pages.map((p) => [p.id, p]));
  const content: PmNode[] = [];
  for (const map of maps) {
    if (!map.assetId || !all.assets.some((a) => a.id === map.assetId && a.mime.startsWith('image/'))) continue;
    const title = xmlSafe(map.title) || 'Map';
    content.push({
      type: 'figure',
      attrs: { kind: 'picture', align: 'full', width: null, description: title },
      content: [
        { type: 'image', attrs: { assetId: map.assetId, alt: title, src: null, title: null } },
        { type: 'figcaption', content: [text(title)] },
      ],
    });
    const places = map.pins
      .filter((pin) => {
        const page = pin.pageId ? pageOf.get(pin.pageId) : undefined;
        return !page || pageAllowed(page, spec, book, all);
      })
      .map((pin) => xmlSafe(pin.label.trim() || (pin.pageId ? (pageOf.get(pin.pageId)?.title ?? '') : '')))
      .filter(Boolean);
    if (places.length > 0) content.push(paragraph(text(`Places shown: ${[...new Set(places)].join(', ')}.`)));
  }
  return content.length > 0 ? { type: 'doc', content } : null;
}

function appendixDoc(spec: AppendixSpec, book: SnapshotBook, all: ExportSnapshot): PmNode | null {
  return spec.kind === 'maps' ? mapsDoc(spec, book, all, all.maps) : entriesDoc(spec, book, all);
}

const APPENDIX_TITLES: Record<AppendixSpec['kind'], string> = {
  cast: 'Cast of Characters',
  glossary: 'Glossary',
  maps: 'Maps',
};

/**
 * `all` is the whole project, because appendices draw on the wiki even though a book
 * export holds no pages of its own.
 */
export function resolveMatter(book: SnapshotBook, all: ExportSnapshot): BookMatter {
  const details = book.publishing ?? {};
  const warnings: string[] = [];
  const front: MatterSection[] = [];
  if (details.copyright?.include) {
    front.push({ key: 'copyright', title: 'Copyright', doc: written(details.copyright) ?? standardCopyright(book) });
  }
  const dedication = written(details.dedication);
  if (dedication) front.push({ key: 'dedication', title: 'Dedication', doc: dedication });
  const epigraph = written(details.epigraph);
  if (epigraph) front.push({ key: 'epigraph', title: 'Epigraph', doc: epigraph });

  const back: MatterSection[] = [];
  for (const spec of details.appendices ?? []) {
    const title = xmlSafe((spec.title ?? '').trim()) || APPENDIX_TITLES[spec.kind];
    const doc = appendixDoc(spec, book, all);
    if (doc) back.push({ key: 'appendix', title, doc });
    else warnings.push(t('The appendix "{title}" in {book} found nothing to show, so it was left out.', { title, book: book.title }));
  }
  const acknowledgments = written(details.acknowledgments);
  if (acknowledgments) back.push({ key: 'acknowledgments', title: 'Acknowledgments', doc: acknowledgments });
  const about = written(details.aboutAuthor);
  if (about) back.push({ key: 'aboutAuthor', title: 'About the Author', doc: about });

  const cover = details.coverAssetId;
  const hasCover = Boolean(cover) && all.assets.some((a) => a.id === cover && a.mime.startsWith('image/'));
  if (cover && !hasCover) warnings.push(t('The cover picture of {book} is no longer in the project.', { book: book.title }));
  return {
    coverAssetId: hasCover ? (cover as string) : null,
    titlePage: details.titlePage !== false,
    front,
    back,
    warnings,
  };
}
