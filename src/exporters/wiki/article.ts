/**
 * Renders a wiki page as HTML the way the app shows it in src/wiki/PageView.tsx: status
 * banner, summary, infobox, contents box, sections, references and categories. The static
 * site and the wiki PDF both use this, and they differ only in where links and images point.
 */

import { escapeHtml, pmToHtml } from '../../editor/convert';
import { titleKey } from '../../lib/text';
import type { Page, PageStatus, PmNode } from '../../lib/types';
import { extractHeadings, type OutlineHeading } from '../../wiki/outline';
import { typeLabel } from '../../wiki/templates';
import { isEmptyDoc, mapDoc, onlyOutsideLinks, walkDoc } from '../util';

export interface ArticleLinks {
  /** Where a link to this page goes, or null if it has no place in this document. */
  pageHref: (page: Page) => string | null;
  resolve: (target: string) => Page | undefined;
  /** Pages that exist but were left out, whose links become plain text, not red links. */
  excludedPages: Set<string>;
  assetSrc: (assetId: string) => string | null;
  videoSrc?: (assetId: string) => string | null;
  categoryHref?: (name: string) => string | null;
  /** Where the list of all categories is. */
  categoriesHref?: string;
}

export interface RenderedArticle {
  /** What sits above the article: status banner, where it is from, summary, other names. */
  head: string;
  infobox: string;
  /** The article itself, holding its contents box. */
  body: string;
  references: string;
  categories: string;
}

/** The same as in src/wiki/Contents.tsx, a component that exports cannot load. */
const MIN_HEADINGS_FOR_CONTENTS = 2;

/** The same words as the banners in src/wiki/PageView.tsx. */
const BANNERS: Partial<Record<PageStatus, string>> = {
  retconned: 'This page has been retconned. It no longer counts as canon.',
  idea: 'This page is an idea. It is not part of canon yet.',
  draft: 'This page is a draft. It may change before it becomes canon.',
};

function renderHead(page: Page, project: string): string {
  const banner = page.isHome ? undefined : BANNERS[page.status];
  const badges = page.isHome
    ? ''
    : `<span class="badge">${escapeHtml(typeLabel(page.pageType))}</span>` +
      (page.status === 'canon' ? '<span class="badge badge-canon">Canon</span>' : '');
  return (
    (banner ? `<p class="notice notice-${escapeHtml(page.status)}">${banner}</p>` : '') +
    `<div class="page-subtitle"><span>From ${escapeHtml(project)}</span>${badges}</div>` +
    (page.summary ? `<p class="summary">${escapeHtml(page.summary)}</p>` : '') +
    (page.aliases.length
      ? `<p class="aka"><span class="aka-label">Also known as</span> ${escapeHtml(page.aliases.join(', '))}</p>`
      : '')
  );
}

function renderContents(headings: OutlineHeading[], idFor: (index: number) => string): string {
  if (headings.length < MIN_HEADINGS_FOR_CONTENTS) return '';
  const items = headings
    .map(
      (heading) =>
        `<li class="toc-level-${Math.min(heading.level - 1, 3)}"><a href="#${escapeHtml(idFor(heading.index))}">` +
        `<span class="toc-number">${escapeHtml(heading.number)}</span> ` +
        `<span>${escapeHtml(heading.text || 'Untitled section')}</span></a></li>`,
    )
    .join('');
  return `<nav class="contents" aria-label="Contents"><div class="contents-title">Contents</div><ol>${items}</ol></nav>`;
}

/**
 * Puts the contents box between the lead and the first heading, as the app does. A heading
 * inside a quote or a list counts towards the numbers, but the box does not go there.
 */
function withContents(html: string, doc: PmNode, contents: string, idFor: (index: number) => string): string {
  if (!contents) return html;
  let before = 0;
  for (const block of doc.content ?? []) {
    if (block.type === 'heading') {
      const level = Math.min(6, Math.max(1, Number(block.attrs?.level ?? 1)));
      // All text is escaped by now, so this can only find the heading.
      const start = html.indexOf(`<h${level} id="${escapeHtml(idFor(before))}"`);
      return start < 0 ? html : html.slice(0, start) + contents + html.slice(start);
    }
    walkDoc(block, (node) => {
      if (node.type === 'heading') before += 1;
    });
  }
  return html;
}

function fieldValue(value: string, kind: string, links: ArticleLinks): string {
  const linkOne = (name: string): string => {
    const shown = escapeHtml(name);
    if (links.excludedPages.has(titleKey(name))) return shown;
    const page = links.resolve(name);
    const href = page ? links.pageHref(page) : null;
    if (href) return `<a class="wiki-link" href="${escapeHtml(href)}">${shown}</a>`;
    return page ? shown : `<span class="wiki-link-red">${shown}</span>`;
  };
  if (kind === 'page') return value.trim() ? linkOne(value.trim()) : '';
  if (kind === 'pages') {
    return value
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
      .map(linkOne)
      .join(', ');
  }
  return escapeHtml(value).replace(/\r?\n/g, '<br/>');
}

function renderInfobox(page: Page, links: ArticleLinks): string {
  const box = page.infobox;
  const fields = (box?.fields ?? []).filter((f) => f.value.trim());
  const src = box?.imageAssetId ? links.assetSrc(box.imageAssetId) : null;
  if (fields.length === 0 && !src && !box?.caption) return '';
  const image = src
    ? `<figure class="infobox-image"><img src="${escapeHtml(src)}" alt="${escapeHtml(box.caption || page.title)}"/>` +
      `${box.caption ? `<figcaption>${escapeHtml(box.caption)}</figcaption>` : ''}</figure>`
    : box?.caption
      ? `<div class="infobox-caption">${escapeHtml(box.caption)}</div>`
      : '';
  const rows = fields
    .map(
      (f) =>
        `<tr><th scope="row">${escapeHtml(f.label || f.key)}</th><td>${fieldValue(f.value, f.kind, links)}</td></tr>`,
    )
    .join('');
  return (
    `<aside class="infobox"><div class="infobox-title">${escapeHtml(page.title)}</div>${image}` +
    `${rows ? `<table><tbody>${rows}</tbody></table>` : ''}</aside>`
  );
}

/** Links to pages left out of the export would lead nowhere, so they become plain words. */
function unlinkExcluded(doc: PmNode, links: ArticleLinks): PmNode {
  if (links.excludedPages.size === 0) return doc;
  return mapDoc(doc, (node) => {
    const wiki = node.marks?.find((m) => m.type === 'wikiLink');
    if (!wiki || !links.excludedPages.has(titleKey(String(wiki.attrs?.target ?? '')))) return node;
    const marks = node.marks?.filter((m) => m !== wiki);
    const next: PmNode = { ...node };
    if (marks?.length) next.marks = marks;
    else delete next.marks;
    return next;
  }) as PmNode;
}

/**
 * `prefix` keeps section and reference ids apart when one document holds many articles.
 * All text is escaped by `pmToHtml` and the helpers here.
 */
export function renderArticle(page: Page, links: ArticleLinks, project: string, prefix = ''): RenderedArticle {
  const doc = unlinkExcluded(onlyOutsideLinks(page.content), links);
  const sectionId = (index: number) => `${prefix}sec-${index + 1}`;
  const notes: string[] = [];
  let headingIndex = 0;
  const body = pmToHtml(doc, {
    wikiHref: (target) => {
      const page_ = links.resolve(target);
      return page_ ? links.pageHref(page_) : null;
    },
    assetSrc: links.assetSrc,
    videoSrc: links.videoSrc,
    remoteImages: false,
    headingId: () => {
      const id = sectionId(headingIndex);
      headingIndex += 1;
      return id;
    },
    reference: (text) => {
      notes.push(text);
      const n = notes.length;
      return (
        `<sup class="reference" id="${prefix}ref-${n}"><a href="#${prefix}note-${n}" title="${escapeHtml(text)}">[${n}]</a></sup>`
      );
    },
  });
  const references = notes.length
    ? `<section class="references"><h2>References</h2><ol>${notes
        .map(
          (text, i) =>
            `<li id="${prefix}note-${i + 1}"><a class="ref-back" href="#${prefix}ref-${i + 1}" aria-label="Back to citation ${i + 1}">↑</a> ${escapeHtml(text)}</li>`,
        )
        .join('')}</ol></section>`
    : '';
  const categoriesTitle = links.categoriesHref ? `<a href="${escapeHtml(links.categoriesHref)}">Categories</a>` : 'Categories';
  const categories = page.categories.length
    ? `<div class="categories">${categoriesTitle}: ${page.categories
        .map((name) => {
          const href = links.categoryHref?.(name);
          return href ? `<a href="${escapeHtml(href)}">${escapeHtml(name)}</a>` : `<span>${escapeHtml(name)}</span>`;
        })
        .join(' <span class="sep">|</span> ')}</div>`
    : '';
  return {
    head: renderHead(page, project),
    infobox: renderInfobox(page, links),
    body: isEmptyDoc(doc)
      ? '<p class="empty-page">This page is empty.</p>'
      : withContents(body, doc, renderContents(extractHeadings(doc), sectionId), sectionId),
    references,
    categories,
  };
}
