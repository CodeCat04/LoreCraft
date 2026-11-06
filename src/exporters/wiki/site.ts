/**
 * A static wiki that works by opening index.html, with no server and nothing fetched
 * from the web. Search runs in the browser over an index loaded as a script, because
 * `fetch` does not work from file://.
 */

import { strToU8, zipSync, type Zippable } from 'fflate';

import { escapeHtml, pmToPlainText } from '../../editor/convert';
import { t } from '../../lib/i18n';
import { titleKey } from '../../lib/text';
import type { Page } from '../../lib/types';
import type { ExportInput } from '../types';
import { assetsInDoc, base64ToBytes, extensionFor, NameKeeper, pageResolver, slugify, xmlSafe } from '../util';
import { renderArticle, type ArticleLinks } from './article';
import css from './site.css?raw';
import clientScript from './site.client.js?raw';
import { SITE_FONTS, siteFontFiles } from './siteFonts';

/**
 * Scripts run only from the site's own files, so text that slipped past escaping still cannot
 * run as code. `file:` keeps the site's own scripts working when it is opened from a folder,
 * in browsers that don't count other local files as the same site. Pictures, video and styles
 * are left alone: figures size themselves with a style attribute and may show web pictures.
 */
export const SITE_CSP = "script-src 'self' file:; object-src 'none'; base-uri 'none'";

/** `root` leads from this file back to the top of the site. */
function layout(root: string, site: string, title: string, body: string): string {
  return xmlSafe(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta http-equiv="Content-Security-Policy" content="${SITE_CSP}"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${root}assets/site.css"/>
<script src="${root}assets/site.js"></script>
</head>
<body>
<header class="topbar">
<a class="site-name" href="${root}index.html">${escapeHtml(site)}</a>
<span class="spacer"></span>
<form class="search-form" action="${root}search.html" role="search">
<input type="search" name="q" placeholder="Search this wiki" aria-label="Search this wiki"/>
<button class="site-button" type="submit">Search</button>
</form>
<button id="mode-toggle" class="site-button" type="button">Light or dark</button>
</header>
<div class="layout">
<nav class="sidebar" aria-label="Wiki">
<ul>
<li><a href="${root}index.html">Main page</a></li>
<li><a href="${root}all-pages.html">All pages</a></li>
<li><a href="${root}categories.html">Categories</a></li>
<li><a href="${root}search.html">Search</a></li>
</ul>
</nav>
<main class="article-wrap">
${body}
</main>
</div>
</body>
</html>
`);
}

function articleHtml(page: Page, links: ArticleLinks, site: string): string {
  const article = renderArticle(page, links, site);
  return (
    `<h1 class="page-title">${escapeHtml(page.title)}</h1>${article.head}` +
    `<div class="article">${article.infobox}${article.body}</div>${article.references}${article.categories}`
  );
}

function listItem(page: Page, href: string): string {
  const summary = page.summary ? ` <span class="summary">${escapeHtml(page.summary)}</span>` : '';
  return `<li><a href="${escapeHtml(href)}">${escapeHtml(page.title)}</a>${summary}</li>`;
}

export function exportSite(input: ExportInput): Uint8Array {
  const { snapshot, assetData } = input;
  const site = snapshot.meta.name || 'LoreCraft';
  const files: Zippable = {};

  const home = snapshot.pages.find((p) => p.isHome);
  const slugs = new NameKeeper(['index', 'search', 'all-pages', 'categories']);
  const pageFile = new Map<string, string>();
  snapshot.pages.forEach((page, index) => {
    if (page === home) pageFile.set(page.id, 'index.html');
    else pageFile.set(page.id, `pages/${slugs.takeSlug(slugify(page.title) || `page-${index + 1}`, '.html')}`);
  });

  const categoryPages = new Map<string, Page[]>();
  for (const page of snapshot.pages) {
    for (const category of page.categories) {
      categoryPages.set(category, [...(categoryPages.get(category) ?? []), page]);
    }
  }
  const categorySlugs = new NameKeeper();
  const categoryFile = new Map<string, string>();
  [...categoryPages.keys()].forEach((name, index) => {
    categoryFile.set(name, `categories/${categorySlugs.takeSlug(slugify(name) || `category-${index + 1}`, '.html')}`);
  });

  const used = new Set<string>();
  for (const page of snapshot.pages) {
    assetsInDoc(page.content, used);
    if (page.infobox?.imageAssetId) used.add(page.infobox.imageAssetId);
  }
  const assetFile = new Map<string, string>();
  for (const asset of snapshot.assets) {
    if (!used.has(asset.id)) continue;
    const data = assetData.get(asset.id);
    if (data === undefined) {
      input.warn?.(t('{name} was too large to include in the site.', { name: asset.name }));
      continue;
    }
    const folder = asset.mime.startsWith('video/') ? 'media' : 'images';
    const path = `${folder}/${slugify(asset.id) || 'file'}.${extensionFor(asset)}`;
    assetFile.set(asset.id, path);
    files[path] = [base64ToBytes(data), { level: 0 }];
  }

  const resolve = pageResolver(snapshot.pages, titleKey);
  const linksFrom = (root: string): ArticleLinks => ({
    resolve,
    excludedPages: input.excludedPages,
    pageHref: (page) => {
      const file = pageFile.get(page.id);
      return file ? `${root}${file}` : null;
    },
    assetSrc: (id) => {
      const file = assetFile.get(id);
      return file ? `${root}${file}` : null;
    },
    videoSrc: (id) => {
      const file = assetFile.get(id);
      return file ? `${root}${file}` : null;
    },
    categoryHref: (name) => {
      const file = categoryFile.get(name);
      return file ? `${root}${file}` : null;
    },
    categoriesHref: `${root}categories.html`,
  });

  files['assets/site.css'] = strToU8(`${SITE_FONTS}\n${css}`);
  files['assets/site.js'] = strToU8(clientScript);
  for (const [path, bytes] of siteFontFiles()) files[path] = [bytes, { level: 0 }];

  snapshot.pages.forEach((page, index) => {
    const file = pageFile.get(page.id) as string;
    const root = file === 'index.html' ? '' : '../';
    files[file] = strToU8(layout(root, site, `${page.title} - ${site}`, articleHtml(page, linksFrom(root), site)));
    input.progress?.(index + 1, snapshot.pages.length);
  });

  if (!home) {
    const intro = `<h1 class="page-title">${escapeHtml(site)}</h1><p>This wiki has ${snapshot.pages.length} pages.</p>`;
    const list = snapshot.pages.map((p) => listItem(p, pageFile.get(p.id) as string)).join('');
    files['index.html'] = strToU8(layout('', site, site, `${intro}<ul class="page-list">${list}</ul>`));
  }
  const allList = snapshot.pages.map((p) => listItem(p, pageFile.get(p.id) as string)).join('');
  files['all-pages.html'] = strToU8(
    layout('', site, `All pages - ${site}`, `<h1 class="page-title">All pages</h1><ul class="page-list">${allList}</ul>`),
  );

  const categoryLinks = [...categoryPages.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, pages]) => `<li><a href="${escapeHtml(categoryFile.get(name) as string)}">${escapeHtml(name)}</a> (${pages.length})</li>`)
    .join('');
  files['categories.html'] = strToU8(
    layout('', site, `Categories - ${site}`, `<h1 class="page-title">Categories</h1><ul class="page-list">${categoryLinks}</ul>`),
  );
  for (const [name, pages] of categoryPages) {
    const list = pages.map((p) => listItem(p, `../${pageFile.get(p.id)}`)).join('');
    files[categoryFile.get(name) as string] = strToU8(
      layout('../', site, `${name} - ${site}`, `<h1 class="page-title">Category: ${escapeHtml(name)}</h1><ul class="page-list">${list}</ul>`),
    );
  }

  const searchEntries = snapshot.pages.map((page) => ({
    title: page.title,
    aliases: page.aliases,
    summary: page.summary,
    url: pageFile.get(page.id),
    text: pmToPlainText(page.content),
  }));
  files['assets/search-index.js'] = strToU8(xmlSafe(`window.LORECRAFT_SEARCH = ${JSON.stringify(searchEntries)};\n`));
  files['search.html'] = strToU8(
    layout(
      '',
      site,
      `Search - ${site}`,
      '<h1 class="page-title">Search</h1>' +
        '<p><input id="search-input" type="search" aria-label="Search this wiki" placeholder="Search this wiki"/></p>' +
        '<noscript><p class="no-script">Search needs JavaScript. See <a href="all-pages.html">all pages</a> instead.</p></noscript>' +
        '<p id="search-heading" role="status"></p><ul id="search-results" class="results"></ul>' +
        '<script src="assets/search-index.js"></script>',
    ),
  );
  return zipSync(files);
}
