import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { strFromU8, unzipSync } from 'fflate';
import { JSDOM } from 'jsdom';
import mammoth from 'mammoth';
import { chromium } from 'playwright-core';
import { parse as parseCsv } from 'csv-parse/sync';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parse as parseYaml } from 'yaml';

import { answerNextDialog, ARTIFACTS, createProject, createWorkspace, launch, rpc, waitUntil, addAsset, readAsset, slowLimit } from './harness.mjs';
import { buildWorld, solidPng } from './export-fixture.mjs';

function xml(text) {
  // jsdom throws on anything that is not well-formed.
  return new JSDOM(text, { contentType: 'application/xml' }).window.document;
}

/** Page count, per-page text with positions, links, and the fonts the file embeds. */
async function readPdf(path) {
  const bytes = readFileSync(path);
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  const raw = bytes.toString('latin1');
  const doc = await getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0 }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const annotations = await page.getAnnotations();
    pages.push({
      items: content.items.filter((i) => 'str' in i),
      text: content.items.map((i) => i.str ?? '').join(' '),
      links: annotations.filter((a) => a.subtype === 'Link'),
      view: page.view,
    });
  }
  const outline = (await doc.getOutline()) ?? [];
  const metadata = await doc.getMetadata();
  return {
    raw,
    doc,
    pages,
    outline,
    info: metadata.info,
    text: pages.map((p) => p.text).join('\n'),
    // Font changes split a word across items, as in "Ł" and "ukasz".
    words: pages.map((p) => p.items.map((i) => i.str).join('')).join('\n'),
    embeddedFonts: (raw.match(/\/FontFile[23]?\b/g) ?? []).length,
    // A font named but not embedded would have one of these with no font file.
    standardFonts: raw.match(/\/BaseFont\s*\/(Helvetica|Times-Roman|Courier)\b/g) ?? [],
  };
}

async function realBrowser() {
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      // Try the next one.
    }
  }
  return null;
}

function lineWidths(page) {
  const lines = new Map();
  for (const item of page.items) {
    if (!item.str.trim()) continue;
    const y = Math.round(item.transform[5]);
    const left = item.transform[4];
    const line = lines.get(y) ?? { left, right: left + item.width };
    line.left = Math.min(line.left, left);
    line.right = Math.max(line.right, left + item.width);
    lines.set(y, line);
  }
  return [...lines.entries()].map(([y, line]) => ({ y, ...line, width: line.right - line.left }));
}

describe('export and import', () => {
  let workspace;
  let app;
  let page;
  let world;
  const policyViolations = [];

  const watch = (target) => {
    target.on('console', (message) => {
      if (/Content Security Policy|Refused to/i.test(message.text())) policyViolations.push(message.text());
    });
    target.on('pageerror', (error) => policyViolations.push(`Page error: ${error.message}`));
  };

  /** Presses the same buttons a person would. The dialog answer is the only stand-in. */
  async function exportFile({ format, group, name, setup }) {
    const path = workspace.file(name);
    await answerNextDialog(page, path);
    await page.getByRole('menuitem', { name: 'File' }).click();
    await page.getByRole('menuitem', { name: 'Export…', exact: true }).click();
    await page.getByRole('heading', { name: 'Export', exact: true }).waitFor();
    await page.getByRole('group', { name: group }).getByRole('radio', { name: format }).check();
    if (setup) await setup();
    await page.getByRole('button', { name: 'Export…' }).click();
    await waitUntil(() => existsSync(path) && page.getByTestId('export-result').count().then((n) => n > 0), 240_000, `${name} to be written`).catch(async (error) => {
      const shown = await page.getByTestId('export-error').allInnerTexts();
      throw new Error(`${error.message}\n${shown.join('\n')}`);
    });
    const result = await page.getByTestId('export-result').innerText();
    assert.ok(result.includes(name), result);
    assert.ok(statSync(path).size > 0);
    return path;
  }

  const WIKI = 'Wiki data';
  const NOVEL = 'Novel';

  before(async () => {
    // Some exports are kept here, to be checked further after the run.
    mkdirSync(ARTIFACTS, { recursive: true });
    workspace = createWorkspace();
    app = await launch(workspace);
    page = app.page;
    watch(page);
    page.context().on('page', watch);
    await createProject(page, 'The Vale & Co');
    // Leaves the main page first, so that its editor is not holding an older copy to save.
    await page.getByRole('menuitem', { name: 'File' }).click();
    await page.getByRole('menuitem', { name: 'Export…', exact: true }).click();
    await page.getByRole('heading', { name: 'Export', exact: true }).waitFor();
    world = await buildWorld(page);
  });

  after(async () => {
    if (app && !app.exited) await app.kill().catch(() => {});
    workspace.cleanup();
  });

  describe('wiki data', () => {
    it('JSON holds the full project, with figures intact', async () => {
      const path = await exportFile({ format: /^JSON The whole/, group: WIKI, name: 'project.json' });
      const file = JSON.parse(readFileSync(path, 'utf8'));
      assert.equal(file.format, 'lorebook');
      const aria = file.pages.find((p) => p.title === 'Aria Vale');
      assert.equal(aria.status, 'canon');
      assert.deepEqual(aria.aliases, ['The Ranger', 'Éowyn "Red" Þórr']);
      assert.equal(aria.infobox.fields[0].value, '12 Frost 1204');
      const figure = aria.content.content.find((n) => n.type === 'figure');
      assert.deepEqual(figure.attrs, { kind: 'picture', align: 'right', width: null, description: 'A blue map of the northern road' });
      assert.equal(file.assets.length, 2);
      assert.ok(file.assets[0].base64.length > 10);
      assert.equal(file.books[0].children[0].children[0].pov, 'Aria Vale');
    });

    it('JSONL has one record per page or scene, leaving out what is marked local only unless asked', async () => {
      const path = await exportFile({ format: /^JSONL/, group: WIKI, name: 'project.jsonl' });
      const records = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(records.filter((r) => r.kind === 'page').length, 6);
      assert.equal(records.filter((r) => r.kind === 'scene').length, 2);
      assert.ok(!records.some((r) => r.title === 'CON' || r.title === 'First Snow'));
      assert.match(await page.getByTestId('export-result').innerText(), /marked local only were left out/);
      const aria = records.find((r) => r.title === 'Aria Vale');
      assert.ok(aria.text.includes('[Picture 1: The road north, from the old maps'));
      assert.equal(aria.localOnly, false);

      const include = () => page.getByTestId('export-include-local-only').getByRole('checkbox');
      const all = await exportFile({ format: /^JSONL/, group: WIKI, name: 'everything.jsonl', setup: () => include().check() });
      const everything = readFileSync(all, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(everything.filter((r) => r.kind === 'page').length, 7);
      assert.equal(everything.filter((r) => r.kind === 'scene').length, 3);
      assert.equal(everything.find((r) => r.title === 'CON').localOnly, true);
      assert.equal(everything.find((r) => r.title === 'First Snow').localOnly, true);
      // A choice made for one AI tool's file does not carry over to another's.
      await page.getByRole('group', { name: WIKI }).getByRole('radio', { name: /^SillyTavern/ }).check();
      assert.equal(await include().isChecked(), false);
      // The data formats and those for people have no such choice: they keep everything.
      await page.getByRole('group', { name: WIKI }).getByRole('radio', { name: /^JSON The whole/ }).check();
      assert.equal(await page.getByTestId('export-include-local-only').count(), 0);
    });

    it('Markdown is a zip with front matter, wiki links and safe names', async () => {
      const path = await exportFile({ format: /^Markdown A zip/, group: WIKI, name: 'vault.zip' });
      const files = unzipSync(readFileSync(path));
      const names = Object.keys(files);
      assert.ok(names.includes('Wiki/CON_.md'));
      assert.ok(names.includes('Wiki/What_ Why_ _Yes_.md'));
      const aria = strFromU8(files['Wiki/Aria Vale.md']);
      assert.ok(aria.startsWith('---\n'));
      assert.ok(aria.includes('[[Silver Vale|the Vale]]'));
      assert.deepEqual(parseYaml(/^---\n([\s\S]*?)\n---/.exec(aria)[1]).categories, ['Characters', 'Rangers & Scouts']);
      assert.equal(parseYaml(/^---\n([\s\S]*?)\n---/.exec(strFromU8(files['Wiki/CON_.md']))[1]).local_only, true);
      assert.equal(parseYaml(/^---\n([\s\S]*?)\n---/.exec(aria)[1]).local_only, undefined);
      assert.ok(names.includes('Assets/map_north_.png'));
      assert.ok(names.some((n) => n.startsWith('Manuscript/The Silver Road/') && n.endsWith('The Gate.md')));
    });

    it('CSV has a byte order mark, and parses', async () => {
      const path = await exportFile({ format: /^CSV/, group: WIKI, name: 'pages.csv' });
      const bytes = readFileSync(path);
      assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
      const rows = parseCsv(bytes.toString('utf8').replace(/^﻿/, ''), { columns: true });
      assert.equal(rows.length, 7);
      const aria = rows.find((r) => r.title === 'Aria Vale');
      assert.equal(aria.infobox_born, '12 Frost 1204');
      assert.equal(aria.local_only, 'false');
      assert.equal(rows.find((r) => r.title === 'CON').local_only, 'true');
      assert.ok(aria.text.includes('"double"'));
    });

    it('CSV can be a zip of three tables', async () => {
      const path = await exportFile({
        format: /^CSV/,
        group: WIKI,
        name: 'tables.zip',
        setup: () => page.getByRole('checkbox', { name: /Zip with scenes/ }).check(),
      });
      const files = unzipSync(readFileSync(path));
      assert.deepEqual(Object.keys(files).sort(), ['pages.csv', 'relationships.csv', 'scenes.csv']);
      await page.getByRole('checkbox', { name: /Zip with scenes/ }).uncheck();
    });

    it('YAML parses back', async () => {
      const path = await exportFile({ format: /^YAML/, group: WIKI, name: 'project.yaml' });
      const data = parseYaml(readFileSync(path, 'utf8'));
      assert.equal(data.pages.find((p) => p.title === 'Silver Vale').summary, 'A cold valley.');
    });

    it('XML is well-formed', async () => {
      const path = await exportFile({ format: /^XML/, group: WIKI, name: 'project.xml' });
      const doc = xml(readFileSync(path, 'utf8'));
      assert.equal(doc.querySelectorAll('page').length, 7);
      assert.ok(doc.querySelector('page[title="Aria Vale"] text').textContent.includes('<angle> & ampersand'));
      assert.equal(doc.querySelector('page[title="CON"]').getAttribute('localOnly'), 'true');
      assert.equal(doc.querySelector('scene[title="First Snow"]').getAttribute('localOnly'), 'true');
      assert.equal(doc.querySelector('page[title="Aria Vale"]').hasAttribute('localOnly'), false);
    });

    it('MediaWiki XML is well-formed, with wikitext', async () => {
      const path = await exportFile({ format: /^MediaWiki/, group: WIKI, name: 'mediawiki.xml' });
      // Kept, so it can be checked against the schema it names with a validator.
      copyFileSync(path, join(ARTIFACTS, 'export-mediawiki.xml'));
      const doc = xml(readFileSync(path, 'utf8'));
      assert.equal(doc.documentElement.getAttribute('version'), '0.11');
      const aria = [...doc.getElementsByTagName('page')].find((p) => p.getElementsByTagName('title')[0].textContent === 'Aria Vale');
      const text = aria.getElementsByTagName('text')[0].textContent;
      assert.ok(text.includes('{{Infobox character'));
      assert.ok(text.includes('[[Silver Vale|the Vale]]'));
      assert.ok(text.includes('Picture 1. The road north'));
    });

    it('SillyTavern leaves out retconned and local-only pages by default', async () => {
      const path = await exportFile({ format: /^SillyTavern/, group: WIKI, name: 'world.json' });
      const { entries } = JSON.parse(readFileSync(path, 'utf8'));
      const list = Object.values(entries);
      assert.ok(list.some((e) => e.comment === 'Aria Vale' && e.key.includes('The Ranger')));
      assert.ok(!list.some((e) => e.comment === 'Old Tale'));
      assert.ok(!list.some((e) => e.comment === 'CON'));
      for (const [key, entry] of Object.entries(entries)) assert.equal(entry.uid, Number(key));

      const include = () => page.getByTestId('export-include-local-only').getByRole('checkbox');
      const asked = await exportFile({ format: /^SillyTavern/, group: WIKI, name: 'world-all.json', setup: () => include().check() });
      const all = Object.values(JSON.parse(readFileSync(asked, 'utf8')).entries);
      assert.ok(all.some((e) => e.comment === 'CON' && e.content.includes('Windows reserves')));
      await include().uncheck();
    });

    it('SQLite is a real database copy', async () => {
      const path = await exportFile({ format: /^SQLite/, group: WIKI, name: 'copy.sqlite' });
      assert.equal(readFileSync(path).subarray(0, 15).toString(), 'SQLite format 3');
    });

    it('the static site works offline in a real browser', async (t) => {
      const path = await exportFile({ format: /^Website/, group: WIKI, name: 'site.zip' });
      const folder = workspace.file('site');
      for (const [name, bytes] of Object.entries(unzipSync(readFileSync(path)))) {
        const target = join(folder, name);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes);
      }
      const browser = await realBrowser();
      if (!browser) {
        t.skip('Neither Edge nor Chrome is installed.');
        return;
      }
      try {
        const site = await browser.newPage();
        const outside = [];
        const errors = [];
        site.on('request', (request) => {
          if (!request.url().startsWith('file:')) outside.push(request.url());
        });
        site.on('requestfailed', (request) => errors.push(`failed: ${request.url()}`));
        site.on('pageerror', (error) => errors.push(error.message));
        await site.goto(pathToFileURL(join(folder, 'index.html')).href);
        await site.getByRole('heading', { name: 'Main Page' }).waitFor();

        await site.getByRole('link', { name: 'Aria', exact: true }).click();
        await site.getByRole('heading', { name: 'Aria Vale', level: 1 }).waitFor();
        assert.equal(await site.locator('.infobox-image img').evaluate((img) => img.complete && img.naturalWidth > 0), true);
        assert.equal(await site.locator('figure.figure-right img').evaluate((img) => img.complete && img.naturalWidth > 0), true);
        assert.equal(await site.locator('figure.figure-right').evaluate((f) => getComputedStyle(f).float), 'right');
        // A web font from the zip, not a system font.
        assert.equal(await site.evaluate(() => document.fonts.check('16px Inter')), true);
        await site.screenshot({ path: join(ARTIFACTS, 'export-site-article.png') });

        await site.locator('.contents a').first().click();
        assert.ok(site.url().endsWith('#sec-1'));
        await site.locator('.article a.wiki-link', { hasText: 'the Vale' }).click();
        await site.getByRole('heading', { name: 'Silver Vale', level: 1 }).waitFor();

        const box = site.getByRole('searchbox').first();
        await box.fill('eowyn');
        await box.press('Enter');
        await site.getByRole('heading', { name: 'Search', level: 1 }).waitFor();
        await site.locator('#search-results a', { hasText: 'Aria Vale' }).waitFor();
        await site.locator('#search-input').fill('nothing matches this');
        await site.getByText('0 pages match').waitFor();

        await site.goto(pathToFileURL(join(folder, 'categories.html')).href);
        await site.getByRole('link', { name: 'Rangers & Scouts' }).click();
        await site.getByRole('heading', { name: 'Category: Rangers & Scouts' }).waitFor();

        await site.locator('#mode-toggle').click();
        const dark = await site.evaluate(() => getComputedStyle(document.body).backgroundColor);
        await site.locator('#mode-toggle').click();
        const light = await site.evaluate(() => getComputedStyle(document.body).backgroundColor);
        assert.notEqual(dark, light);

        assert.deepEqual(outside, [], 'nothing comes from the web');
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    });
  });

  describe('PDF, from the real browser engine under the real CSP', () => {
    it('one wiki page reads like the article, with text wrapped around pictures', async () => {
      const path = await exportFile({
        format: /^PDF One page or/,
        group: WIKI,
        name: 'aria.pdf',
        setup: async () => {
          await page.getByLabel('What to export').selectOption('page');
          await page.getByRole('combobox', { name: /^Page$/ }).selectOption(world.ariaId);
        },
      });
      const pdf = await readPdf(path);
      assert.equal(pdf.pages.length >= 2, true);
      assert.equal(pdf.info.Title, 'Aria Vale');
      assert.equal(pdf.info.Creator, 'LoreCraft');
      for (const words of ['Contents', 'Early life', 'Later years', 'Born', '12 Frost 1204', 'Picture 1.', 'The road north', 'Table 1.', 'Her ranks', 'Video 1.', 'The ride to the Gate', 'References', 'Annals of the Vale', 'Categories:', 'Rangers & Scouts', 'Éowyn', 'Þórr', 'Łukasz', 'Ελληνικά', 'Русский', '龍']) {
        assert.ok(pdf.words.includes(words), `${words} should be in the PDF`);
      }
      assert.ok(pdf.embeddedFonts >= 3, `fonts embedded: ${pdf.embeddedFonts}`);
      assert.deepEqual(pdf.standardFonts, [], 'every font is embedded');
      assert.ok(/LibertinusSerif/.test(pdf.raw), 'the serif heading font is embedded');

      // Lines beside the floated infobox and figure stop short of the full width.
      const [first] = pdf.pages;
      const lines = lineWidths(first).filter((l) => l.left < 90);
      const widest = Math.max(...lines.map((l) => l.width));
      const wrapped = lines.filter((l) => l.width < widest * 0.75 && l.width > widest * 0.3);
      assert.ok(wrapped.length >= 5, `wrapped lines: ${wrapped.length}`);
      assert.ok(lines.filter((l) => l.width > widest * 0.9).length >= 2, 'and text returns to full width below');

      // Links: inside the PDF for contents and citations, and out for web addresses.
      const links = pdf.pages.flatMap((p) => p.links);
      assert.ok(links.some((l) => typeof l.dest === 'string' && l.dest.endsWith('sec-1')), 'contents link');
      assert.ok(links.some((l) => typeof l.dest === 'string' && l.dest.endsWith('note-1')), 'citation link');
      assert.ok(links.some((l) => l.url === 'https://example.com/a?b=1&c=2'), 'outside link');
      assert.ok(links.some((l) => l.url === 'https://example.com/ride.mp4'), 'linked video');
      assert.ok(pdf.outline.length > 0, 'bookmarks');
      assert.ok(pdf.pages[0].items.some((item) => item.str.trim() === '1'), 'page number');
      // Pictures are in the file.
      assert.ok((pdf.raw.match(/\/Subtype\s*\/Image/g) ?? []).length >= 2, 'pictures embedded');
    });

    it('the whole wiki has contents with real page numbers, and links between articles', async () => {
      const path = await exportFile({
        format: /^PDF One page or/,
        group: WIKI,
        name: 'wiki.pdf',
        setup: () => page.getByLabel('What to export').selectOption('wiki'),
      });
      const pdf = await readPdf(path);
      assert.ok(pdf.pages.length >= 9, `pages: ${pdf.pages.length}`);
      assert.equal(pdf.info.Title, 'The Vale & Co');
      assert.ok(pdf.pages[0].text.includes('The Vale & Co'));
      const contents = pdf.pages[1].text;
      assert.ok(contents.includes('Contents'));
      assert.ok(!contents.includes('000'), 'the placeholders are filled in');

      // Each number in the contents is the page the article is really on.
      const links = pdf.pages[1].links.filter((l) => typeof l.dest === 'string' && l.dest.startsWith('page-'));
      assert.equal(links.length, 7);
      const titles = ['Aria Vale', 'CON', 'Empty Page', 'Main Page', 'Old Tale', 'Silver Vale', 'What? Why: "Yes"'];
      for (const title of titles) {
        const onPage = pdf.pages.findIndex((p, i) => i > 1 && p.items.some((item) => item.str === title && item.height > 15)) + 1;
        assert.ok(onPage > 2, `${title} has a page`);
        const line = pdf.pages[1].items.findIndex((item) => item.str === title);
        const after = pdf.pages[1].items.slice(line + 1).find((item) => /^\d+$/.test(item.str.trim()));
        assert.equal(Number(after.str), onPage, `${title} is listed on the right page`);
      }

      // A link from one article to another works inside the PDF.
      const allLinks = pdf.pages.flatMap((p) => p.links);
      assert.ok(allLinks.some((l) => typeof l.dest === 'string' && /^page-5$/.test(l.dest)), 'a link to Silver Vale');
    });

    it('one book has a title page, contents, chapters, numbers and wrapped pictures', async () => {
      const path = await exportFile({ format: /^PDF A typeset book/, group: NOVEL, name: 'book.pdf' });
      const pdf = await readPdf(path);
      assert.equal(pdf.info.Title, 'The Silver Road');
      assert.equal(pdf.info.Author, 'Élodie Writer');
      assert.ok(pdf.pages[0].text.includes('Book One of the Vale'));
      assert.ok(pdf.pages[1].text.includes('Contents'));
      assert.ok(pdf.pages[1].text.includes('Arrival'));
      assert.ok(pdf.text.includes('Part Two: The Long Night'));
      assert.ok(pdf.text.includes('Figure 1.'));
      assert.ok(pdf.text.includes('* * *'));
      assert.deepEqual(pdf.pages[0].view, [0, 0, 432, 648], 'six by nine inches');
      assert.ok(/SourceSerif/.test(pdf.raw), 'the serif font is embedded');
      assert.ok(pdf.embeddedFonts >= 1);
      assert.deepEqual(pdf.standardFonts, []);
      assert.ok(pdf.outline.some((o) => o.title === 'The Silver Road'));
      assert.ok(pdf.pages[2].items.some((i) => i.str.trim() === '3'), 'page numbers');
      assert.ok(!/^\s*1\s*$/m.test(pdf.pages[0].items.map((i) => i.str).join('\n')), 'none on the title page');
      assert.ok(!pdf.text.includes('wikiLink'));
      const wrapped = pdf.pages.flatMap(lineWidths).filter((l) => l.left > 150);
      assert.ok(wrapped.length >= 5, 'lines to the right of the floated picture');
    });

    it('a manuscript is double spaced with a running head', async () => {
      const path = await exportFile({
        format: /^PDF A typeset book/,
        group: NOVEL,
        name: 'manuscript.pdf',
        setup: () => page.getByRole('checkbox', { name: /Standard manuscript format/ }).check(),
      });
      const pdf = await readPdf(path);
      assert.deepEqual(pdf.pages[0].view, [0, 0, 612, 792]);
      assert.ok(pdf.pages[0].text.includes('about '));
      assert.ok(pdf.pages[1].text.includes('Writer / The Silver Road / 2'));
      assert.ok(pdf.text.includes('THE END'));
      assert.ok(/CourierPrime/.test(pdf.raw));
      const ys = [...new Set(pdf.pages[1].items.map((i) => Math.round(i.transform[5])))].sort((a, b) => b - a);
      const gaps = ys.slice(1).map((y, i) => ys[i] - y).filter((g) => g > 5);
      assert.ok(gaps.filter((g) => g >= 22 && g <= 26).length >= 10, `double spaced: ${gaps.join(',')}`);
      await page.getByRole('checkbox', { name: /Standard manuscript format/ }).uncheck();
    });

    it('all books fit in one file', async () => {
      await rpc(page, 'books.create', { title: 'A Second Book' });
      const path = await exportFile({
        format: /^PDF A typeset book/,
        group: NOVEL,
        name: 'books.pdf',
        setup: () => page.getByLabel('What to export').selectOption('books'),
      });
      const pdf = await readPdf(path);
      assert.ok(pdf.text.includes('The Silver Road'));
      assert.ok(pdf.text.includes('A Second Book'));
      await page.getByLabel('What to export').selectOption('book');
    });

    it('reports a clear error rather than freezing if the path cannot be written', async () => {
      const blocked = workspace.file('a-folder.pdf');
      mkdirSync(blocked);
      await answerNextDialog(page, blocked);
      await page.getByRole('group', { name: NOVEL }).getByRole('radio', { name: /^PDF A typeset book/ }).check();
      await page.getByRole('button', { name: 'Export…' }).click();
      await page.getByTestId('export-error').waitFor({ timeout: 60_000 });
      assert.match(await page.getByTestId('export-error').innerText(), /Could not export/);
      assert.equal(await page.getByRole('button', { name: 'Export…' }).isEnabled(), true);
      // The print window is gone, so another PDF can be made.
      const again = await exportFile({ format: /^PDF A typeset book/, group: NOVEL, name: 'again.pdf' });
      assert.ok(statSync(again).size > 1000);
    });
  });

  describe('novel', () => {
    it('DOCX is generated under the real CSP, and reads back with headings', async () => {
      const path = await exportFile({ format: /^Word document/, group: NOVEL, name: 'book.docx' });
      // Kept for src/exporters/docxStructure.test.ts, through LORECRAFT_CHECK_DOCX.
      copyFileSync(path, join(ARTIFACTS, 'export-book.docx'));
      const bytes = readFileSync(path);
      const html = (await mammoth.convertToHtml({ buffer: bytes })).value;
      assert.match(html, /<h1[^>]*>Part Two: The Long Night<\/h1>/);
      assert.match(html, /<h2[^>]*>Arrival<\/h2>/);
      assert.ok(html.includes('Figure 1. '));
      assert.ok(html.includes('Aria at the gate'));
      assert.match(html, /<img [^>]*src="data:image\/png/);
      const files = unzipSync(bytes);
      assert.ok(strFromU8(files['word/styles.xml']).includes('Heading1'));
      assert.ok(strFromU8(files['word/document.xml']).includes('w:framePr'), 'text wraps around the figure');
    });

    it('DOCX has a manuscript format', async () => {
      const path = await exportFile({
        format: /^Word document/,
        group: NOVEL,
        name: 'manuscript.docx',
        setup: () => page.getByRole('checkbox', { name: /Standard manuscript format/ }).check(),
      });
      copyFileSync(path, join(ARTIFACTS, 'export-manuscript.docx'));
      const files = unzipSync(readFileSync(path));
      assert.ok(strFromU8(files['word/styles.xml']).includes('w:line="480"'));
      const headers = Object.keys(files).filter((n) => n.startsWith('word/header')).map((n) => strFromU8(files[n])).join('');
      assert.ok(headers.includes('Writer / The Silver Road'));
      await page.getByRole('checkbox', { name: /Standard manuscript format/ }).uncheck();
    });

    it('EPUB has the required structure, and well-formed XHTML', async () => {
      const path = await exportFile({ format: /^EPUB/, group: NOVEL, name: 'book.epub' });
      // Kept for src/exporters/epubStructure.test.ts, through LORECRAFT_CHECK_EPUB.
      copyFileSync(path, join(ARTIFACTS, 'export-book.epub'));
      const bytes = readFileSync(path);
      assert.equal(bytes.subarray(30, 38).toString(), 'mimetype');
      assert.equal(bytes.subarray(38, 58).toString(), 'application/epub+zip');
      const files = unzipSync(bytes);
      const names = Object.keys(files);
      assert.equal(names[0], 'mimetype');
      assert.ok(names.includes('META-INF/container.xml'));
      for (const name of names.filter((n) => n.endsWith('.xhtml') || n.endsWith('.opf') || n.endsWith('.ncx'))) {
        xml(strFromU8(files[name]));
      }
      const nav = xml(strFromU8(files['OEBPS/nav.xhtml']));
      assert.ok([...nav.querySelectorAll('a')].some((a) => a.textContent === 'Arrival'));
      assert.ok(names.some((n) => n.startsWith('OEBPS/images/')));
    });

    it('DOCX turns a WebP picture into one Word can show', async () => {
      const base64 = await page.evaluate(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 40;
        canvas.height = 30;
        canvas.getContext('2d').fillRect(0, 0, 40, 30);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp'));
        const bytes = new Uint8Array(await blob.arrayBuffer());
        return btoa(String.fromCharCode(...bytes));
      });
      const { id } = await addAsset(page, { name: 'pic.webp', mime: 'image/webp', base64, width: 40, height: 30 });
      const chapter = (await rpc(page, 'nodes.tree', { bookId: world.bookId })).find((n) => n.kind === 'chapter');
      const added = await rpc(page, 'nodes.create', {
        bookId: world.bookId,
        parentId: chapter.id,
        kind: 'scene',
        title: 'With a WebP',
        content: { type: 'doc', content: [{ type: 'figure', attrs: { kind: 'figure', align: 'center', width: null, description: '' }, content: [
          { type: 'image', attrs: { assetId: id, alt: '' } },
          { type: 'figcaption', content: [{ type: 'text', text: 'A WebP picture' }] },
        ] }] },
      });
      const path = await exportFile({ format: /^Word document/, group: NOVEL, name: 'webp.docx' });
      const files = unzipSync(readFileSync(path));
      const media = Object.keys(files).filter((n) => n.startsWith('word/media/'));
      assert.ok(media.length >= 2, media.join());
      assert.ok(!media.some((n) => n.endsWith('.webp')));
      assert.ok((await mammoth.convertToHtml({ buffer: readFileSync(path) })).value.includes('A WebP picture'));
      await rpc(page, 'nodes.delete', { id: added.id });
    });

    it('Markdown and plain text hold the book in reading order', async () => {
      const md = readFileSync(await exportFile({ format: /^Markdown One Markdown/, group: NOVEL, name: 'book.md' }), 'utf8');
      assert.ok(md.startsWith('# The Silver Road'));
      assert.ok(md.indexOf('Arrival') < md.indexOf('Snowfall'));
      const text = readFileSync(await exportFile({ format: /^Plain text/, group: NOVEL, name: 'book.txt' }), 'utf8');
      assert.ok(text.startsWith('THE SILVER ROAD'));
      assert.ok(text.includes('[Figure 1: Aria at the gate]'));
    });
  });

  describe('publishing kit', () => {
    const doc = (words) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: words }] }] });

    async function hasPicture(pdf, pageNumber) {
      const operators = await (await pdf.doc.getPage(pageNumber)).getOperatorList();
      return operators.fnArray.includes(OPS.paintImageXObject);
    }

    it('the details screen keeps what is typed, and looks right', async () => {
      await page.getByRole('menuitem', { name: 'File' }).click();
      await page.getByRole('menuitem', { name: 'Publishing details…' }).click();
      await page.getByRole('heading', { name: 'Publishing details' }).waitFor();

      const coverPath = workspace.file('cover.png');
      writeFileSync(coverPath, solidPng(400, 640, [180, 40, 120]));
      await page.getByTestId('cover-file').setInputFiles(coverPath);
      await page.getByTestId('cover-image').waitFor();
      await waitUntil(() => page.getByTestId('cover-image').evaluate((img) => img.complete && img.naturalWidth === 400), 15_000, 'the cover to show');
      await app.screenshot('publishing-cover');

      await page.getByLabel('Series', { exact: true }).fill('The Vale Cycle');
      await page.getByLabel('Number in series').fill('2');
      await page.getByLabel('Description').fill('A ranger rides <north>.');
      await page.getByLabel('Publisher').fill('Silver Gate & Sons');
      await page.getByLabel('Language code').fill('en-GB');
      await page.getByLabel('ISBN').fill('978-1-234-56789-0');
      await page.getByText('does not look like a valid ISBN').waitFor();
      await page.getByLabel('ISBN').fill('978-1-234-56789-7');
      await page.getByText('does not look like a valid ISBN').waitFor({ state: 'hidden' });
      await page.getByLabel('Copyright year').fill('2026');

      await page.getByRole('checkbox', { name: /^Copyright page/ }).check();
      await page.getByRole('checkbox', { name: /^Dedication/ }).check();
      await page.locator('[data-matter="dedication"] .ProseMirror').click();
      await page.keyboard.type('For the riders.');

      await page.getByRole('button', { name: 'Add an appendix' }).click();
      const appendix = page.getByTestId('appendix');
      assert.equal(await appendix.getByRole('group', { name: 'Pages of these types' }).getByRole('checkbox', { name: 'Characters' }).isChecked(), true);
      assert.equal(await appendix.getByRole('group', { name: 'Or in these categories' }).getByRole('checkbox', { name: 'Characters' }).isChecked(), false);
      assert.equal(await appendix.getByLabel('Heading').inputValue(), 'Cast of Characters');

      await app.screenshot('publishing-dark');
      await page.evaluate(() => {
        document.documentElement.dataset.mode = 'light';
      });
      await app.screenshot('publishing-light');
      await page.evaluate(() => {
        document.documentElement.dataset.mode = 'dark';
      });

      await waitUntil(async () => {
        const book = (await rpc(page, 'books.list')).find((b) => b.id === world.bookId);
        return JSON.stringify(book.publishing.dedication ?? '').includes('For the riders.') && (book.publishing.appendices ?? []).length === 1;
      }, 15_000, 'the details to save themselves');
      const book = (await rpc(page, 'books.list')).find((b) => b.id === world.bookId);
      assert.equal(book.publishing.series, 'The Vale Cycle');
      assert.equal(book.publishing.isbn, '978-1-234-56789-7');
      assert.equal(book.title, 'The Silver Road');
      assert.ok(book.publishing.coverAssetId);
      assert.equal(book.publishing.copyright.include, true);

      // They are there on coming back.
      await page.getByRole('menuitem', { name: 'File' }).click();
      await page.getByRole('menuitem', { name: 'Export…', exact: true }).click();
      await page.getByRole('heading', { name: 'Export', exact: true }).waitFor();
      await page.getByRole('group', { name: NOVEL }).getByRole('radio', { name: /^EPUB/ }).check();
      assert.equal(await page.getByLabel('Language code').inputValue(), 'en-GB', 'the book’s language is the default');
      await page.getByRole('button', { name: 'Publishing details…' }).click();
      await page.getByRole('heading', { name: 'Publishing details' }).waitFor();
      assert.equal(await page.getByLabel('Series', { exact: true }).inputValue(), 'The Vale Cycle');
      assert.ok((await page.locator('[data-matter="dedication"] .ProseMirror').innerText()).includes('For the riders.'));
      await page.getByRole('menuitem', { name: 'File' }).click();
      await page.getByRole('menuitem', { name: 'Export…', exact: true }).click();
      await page.getByRole('heading', { name: 'Export', exact: true }).waitFor();

      // The rest is added directly, to keep these tests about what comes out.
      const second = (await rpc(page, 'books.list')).find((b) => b.id !== world.bookId);
      const later = second ?? (await rpc(page, 'books.create', { title: 'A Second Book' }));
      const laterTree = await rpc(page, 'nodes.tree', { bookId: later.id });
      await rpc(page, 'pages.update', { id: world.silverId, patch: { revealNodeId: laterTree.find((n) => n.kind === 'scene').id } });
      const map = await rpc(page, 'extras.mapCreate', { title: 'The North', assetId: world.mapImage });
      await rpc(page, 'extras.pinAdd', { mapId: map.id, pageId: world.ariaId, label: 'Her Gate', x: 0.5, y: 0.5 });
      await rpc(page, 'books.update', {
        id: world.bookId,
        patch: {
          publishing: {
            ...book.publishing,
            epigraph: { include: true, content: doc('Not all roads run north.') },
            acknowledgments: { include: true, content: doc('My thanks to the Wardens.') },
            aboutAuthor: { include: true, content: doc('She lives by the sea.') },
            appendices: [
              { title: 'Who Is Who', kind: 'cast', categories: [], pageTypes: ['character'], canonOnly: true, hideSpoilers: true },
              { title: 'Places', kind: 'glossary', categories: ['Places'], pageTypes: [], canonOnly: true, hideSpoilers: true },
              { title: 'Places With Spoilers', kind: 'glossary', categories: ['Places'], pageTypes: [], canonOnly: true, hideSpoilers: false },
              { title: 'The Maps', kind: 'maps', categories: [], pageTypes: [], canonOnly: true, hideSpoilers: true },
            ],
          },
        },
      });
    });

    it('an EPUB has its cover, metadata and matter in order', async () => {
      const path = await exportFile({ format: /^EPUB/, group: NOVEL, name: 'published.epub' });
      copyFileSync(path, join(ARTIFACTS, 'export-published.epub'));
      const result = await page.getByTestId('export-result').innerText();
      assert.match(result, /appendix "Places" in The Silver Road found nothing/, 'a spoiler-free list with nothing to show says so');
      const files = unzipSync(readFileSync(path));
      const opf = xml(strFromU8(files['OEBPS/content.opf']));
      const one = (tag) => opf.getElementsByTagName(tag)[0]?.textContent;
      assert.equal(one('dc:language'), 'en-GB');
      assert.equal(one('dc:publisher'), 'Silver Gate & Sons');
      assert.equal(one('dc:description'), 'A ranger rides <north>.');
      assert.equal(one('dc:date'), '2026');
      assert.ok([...opf.getElementsByTagName('dc:identifier')].some((i) => i.textContent === 'urn:isbn:9781234567897'));
      assert.ok([...opf.getElementsByTagName('meta')].some((m) => m.getAttribute('property') === 'belongs-to-collection' && m.textContent === 'The Vale Cycle'));
      const cover = [...opf.getElementsByTagName('item')].find((i) => i.getAttribute('properties') === 'cover-image');
      assert.ok(cover, 'the manifest names the cover');
      assert.ok(files[`OEBPS/${cover.getAttribute('href')}`].length > 100);

      const spine = [...opf.getElementsByTagName('itemref')].map((r) => r.getAttribute('idref'));
      const text = spine.map((id) => strFromU8(files[`OEBPS/${id}.xhtml`]));
      text.forEach((page_) => xml(page_));
      const at = (words) => text.findIndex((t) => t.includes(words));
      const order = ['epub:type="cover"', 'epub:type="titlepage"', 'Copyright © 2026 Élodie Writer', 'For the riders.', 'Not all roads run north.', 'Arrival', 'Snowfall', 'Who Is Who', 'Places With Spoilers', 'The Maps', 'My thanks to the Wardens.', 'She lives by the sea.'].map(at);
      assert.ok(order.every((n) => n >= 0), `all present: ${order}`);
      assert.deepEqual([...order].sort((a, b) => a - b), order);
      assert.ok(text[at('Who Is Who')].includes('Aria Vale'));
      assert.ok(text[at('Places With Spoilers')].includes('Silver Vale'), 'asked for, so it is there');
      assert.ok(text[at('The Maps')].includes('Her Gate'));
      assert.ok(strFromU8(files['OEBPS/nav.xhtml']).includes('Who Is Who'));
    });

    it('a Word document has them too, with chapters numbered from 1', async () => {
      const path = await exportFile({ format: /^Word document/, group: NOVEL, name: 'published.docx' });
      copyFileSync(path, join(ARTIFACTS, 'published.docx'));
      const files = unzipSync(readFileSync(path));
      const text = strFromU8(files['word/document.xml']);
      const order = ['<w:drawing>', 'The Silver Road', 'Copyright © 2026', 'For the riders.', 'Not all roads run north.', 'Arrival', 'Who Is Who', 'Places With Spoilers', 'The Maps', 'My thanks to the Wardens.', 'She lives by the sea.'].map((w) => text.indexOf(w));
      assert.ok(order.every((n) => n >= 0), `all present: ${order}`);
      assert.deepEqual([...order].sort((a, b) => a - b), order);
      assert.equal(text.match(/<w:sectPr/g).length, 2);
      assert.match(text, /<w:pgNumType w:start="1"/);
      const back = await mammoth.extractRawText({ buffer: readFileSync(path) });
      assert.ok(back.value.includes('My thanks to the Wardens.'));
    });

    it('a reading PDF opens on its cover and keeps its plain layout', async () => {
      const path = await exportFile({ format: /^PDF A typeset book/, group: NOVEL, name: 'published-reading.pdf' });
      copyFileSync(path, join(ARTIFACTS, 'published-reading.pdf'));
      const pdf = await readPdf(path);
      assert.equal(pdf.pages[0].text.trim(), '', 'nothing but the picture');
      assert.ok(await hasPicture(pdf, 1));
      assert.deepEqual(pdf.pages[0].view, [0, 0, 432, 648]);
      const at = (words) => pdf.pages.findIndex((p) => p.items.map((i) => i.str).join('').includes(words));
      const order = ['Book One of the Vale', 'Copyright © 2026', 'For the riders.', 'Not all roads run north.', 'Contents', 'Arrival', 'Who Is Who', 'My thanks to the Wardens.', 'She lives by the sea.'].map(at);
      assert.ok(order.every((n) => n >= 0), `all present: ${order}`);
      assert.deepEqual([...order].sort((a, b) => a - b), order);
      // The contents leads to the back matter by its real page number.
      const contents = pdf.pages[at('Contents')];
      const line = contents.items.findIndex((i) => i.str === 'Who Is Who');
      const number = contents.items.slice(line + 1).find((i) => /^\d+$/.test(i.str.trim()));
      assert.ok(pdf.pages[Number(number.str) - 1].items.some((i) => i.str === 'Who Is Who'), 'listed on the right page');
      // A picture of the map is in the appendix. The contents names it too, so this looks from the end.
      assert.ok(await hasPicture(pdf, pdf.pages.findLastIndex((p) => p.text.includes('The Maps')) + 1));
    });

    it('a print-ready PDF has trim size, mirrored margins, right-hand chapters, heads and numbers', async () => {
      const path = await exportFile({
        format: /^PDF A typeset book/,
        group: NOVEL,
        name: 'published-print.pdf',
        setup: async () => {
          await page.getByRole('checkbox', { name: /^Print-ready/ }).check();
          await page.getByLabel('Trim size').selectOption('digest');
        },
      });
      copyFileSync(path, join(ARTIFACTS, 'published-print.pdf'));
      const pdf = await readPdf(path);
      assert.deepEqual(pdf.pages[0].view, [0, 0, 396, 612], 'five and a half by eight and a half inches');
      assert.ok(pdf.pages[0].text.includes('The Silver Road'), 'no cover, for a printer');

      const isTitled = (p, words) => p.items.some((i) => i.str === words && i.height > 14);
      // Chapters and back matter are on right-hand pages, which have odd numbers.
      for (const title of ['Arrival', 'Snowfall', 'Who Is Who', 'Acknowledgments', 'About the Author']) {
        const index = pdf.pages.findIndex((p, i) => i > 2 && isTitled(p, title));
        assert.ok(index >= 0, `${title} has a page`);
        assert.equal((index + 1) % 2, 1, `${title} is on a right-hand page, not page ${index + 1}`);
      }
      // Copyright is on the back of the title page, and dedication on the next right-hand page.
      const dedication = pdf.pages.findIndex((p) => p.text.includes('For the riders.'));
      assert.ok(pdf.pages[1].text.includes('Copyright'));
      assert.equal((dedication + 1) % 2, 1);

      const leftEdge = (p) => Math.min(...p.items.filter((i) => i.str.trim() && i.transform[5] > 80 && i.transform[5] < 540).map((i) => i.transform[4]));
      const body = pdf.pages.map((p, i) => ({ p, number: i + 1 })).filter(({ p }) => p.items.filter((i) => i.str.trim()).length > 20);
      const lefts = body.filter(({ number }) => number % 2 === 0).map(({ p }) => leftEdge(p));
      const rights = body.filter(({ number }) => number % 2 === 1).map(({ p }) => leftEdge(p));
      assert.ok(lefts.length > 0 && rights.length > 0, `pages of both sides: ${lefts} / ${rights}`);
      // Text sits further from the left edge on right-hand pages, away from the binding.
      assert.ok(Math.min(...rights) > Math.min(...lefts) + 10, `margins mirror: ${lefts} / ${rights}`);

      // Running heads and numbers, on the outside of each page.
      const top = (p) => p.items.filter((i) => i.str.trim() && i.transform[5] > 560);
      const bottom = (p) => p.items.filter((i) => i.str.trim() && i.transform[5] < 60);
      const firstBody = pdf.pages.findIndex((p, i) => i > 2 && isTitled(p, 'Arrival'));
      const next = firstBody + 1;
      assert.ok(top(pdf.pages[next]).some((i) => i.str.includes('The Silver Road')), 'the book on left-hand pages');
      const rightPage = pdf.pages[next + 1];
      assert.ok(top(rightPage).some((i) => i.str.includes('Arrival')), 'the chapter on right-hand pages');
      assert.equal(bottom(pdf.pages[next]).at(-1).str.trim(), String(next + 1));
      assert.ok(bottom(pdf.pages[next])[0].transform[4] < 100, 'a left-hand number is at the left');
      assert.ok(bottom(rightPage)[0].transform[4] > 250, 'a right-hand number is at the right');

      // The page a chapter opens on has no running head, as in a printed book, but keeps
      // its number. Every other page of text after the first chapter has its head.
      const heads = pdf.pages.map((p, i) => `${i + 1}: ${top(p).map((item) => item.str).join(' ') || '-'}`).join(', ');
      for (const title of ['Arrival', 'Snowfall', 'Who Is Who', 'Acknowledgments', 'About the Author']) {
        const opening = pdf.pages.findIndex((p, i) => i > 2 && isTitled(p, title));
        assert.equal(top(pdf.pages[opening]).length, 0, `no head where ${title} opens, on page ${opening + 1}: ${heads}`);
        assert.equal(bottom(pdf.pages[opening]).at(-1)?.str.trim(), String(opening + 1), `${title} opens on a numbered page`);
      }
      const hasText = (p) => p.items.some((i) => i.str.trim() && i.transform[5] > 60 && i.transform[5] < 560);
      const opens = (p) => p.items.some((i) => i.str.trim() && i.height > 14);
      const continuing = pdf.pages.filter((p, i) => i > firstBody && hasText(p) && !opens(p));
      assert.ok(continuing.length >= 2, `pages that carry on a chapter: ${heads}`);
      for (const p of continuing) assert.ok(top(p).length > 0, `a page that carries on a chapter has its head: ${heads}`);

      // Title page, front matter and blank pages stay clean.
      assert.equal(top(pdf.pages[0]).length, 0);
      assert.equal(bottom(pdf.pages[0]).length, 0);
      assert.equal(top(pdf.pages[1]).length, 0);
      assert.equal(bottom(pdf.pages[dedication]).length, 0);
      const blanks = pdf.pages.filter((p) => !p.items.some((i) => i.str.trim() && i.transform[5] > 60 && i.transform[5] < 560));
      assert.ok(blanks.length > 0, 'right-hand chapters left some blank pages');
      for (const blank of blanks) assert.equal(blank.text.trim(), '', 'a blank page has no head or number');

      await page.getByRole('checkbox', { name: /^Print-ready/ }).uncheck();
    });

    it('a manuscript stays bare, whatever the book holds', async () => {
      const path = await exportFile({
        format: /^PDF A typeset book/,
        group: NOVEL,
        name: 'published-manuscript.pdf',
        setup: () => page.getByRole('checkbox', { name: /Standard manuscript format/ }).check(),
      });
      const pdf = await readPdf(path);
      assert.ok(!pdf.text.includes('For the riders.'));
      assert.ok(!pdf.text.includes('Who Is Who'));
      assert.ok(pdf.text.includes('THE END'));
      await page.getByRole('checkbox', { name: /Standard manuscript format/ }).uncheck();
      await rpc(page, 'pages.update', { id: world.silverId, patch: { revealNodeId: '' } });
    });

    it('the details screen opens from a book’s settings', async () => {
      await page.getByRole('button', { name: 'Write', exact: true }).click();
      await page.getByRole('button', { name: 'Book settings' }).first().click();
      await page.getByRole('button', { name: 'Publishing details…' }).click();
      await page.getByRole('heading', { name: 'Publishing details' }).waitFor();
      await page.getByLabel('Series', { exact: true }).waitFor();
      const shown = await page.getByLabel('Title', { exact: true }).inputValue();
      assert.ok((await rpc(page, 'books.list')).some((b) => b.title === shown));
    });
  });

  describe('the window stays responsive', () => {
    it('while a long book becomes a PDF and a Word document', async () => {
      const sentence = 'The riders crossed the frozen river at the ford, and nobody spoke of what they had seen. ';
      const paragraph = { type: 'paragraph', content: [{ type: 'text', text: sentence.repeat(8) }] };
      const scenes = Array.from({ length: 5 }, (_, s) => ({ kind: 'scene', title: `Scene ${s + 1}`, content: { type: 'doc', content: Array.from({ length: 4 }, () => paragraph) } }));
      const chapters = Array.from({ length: 40 }, (_, c) => ({ kind: 'chapter', title: `Chapter ${c + 1}`, children: scenes }));
      const report = await rpc(page, 'import.apply', { books: [{ title: 'The Long Book', author: 'Long Winded', children: chapters }] });
      assert.equal(report.applied, true);
      const big = (await rpc(page, 'books.list')).find((b) => b.title === 'The Long Book');
      const words = (await rpc(page, 'nodes.stats', { bookId: big.id })).words;
      assert.ok(words >= 100_000 && words < 110_000, `words: ${words}`);

      const watchGaps = () =>
        page.evaluate(() => {
          window.__gaps = [];
          let last = performance.now();
          window.__gapTimer = setInterval(() => {
            const now = performance.now();
            window.__gaps.push(now - last);
            last = now;
          }, 25);
        });
      const longestGap = () =>
        page.evaluate(() => {
          clearInterval(window.__gapTimer);
          return Math.max(...window.__gaps);
        });

      const chooseBig = () => page.getByLabel(/^Book/).selectOption(big.id);

      await watchGaps();
      let started = Date.now();
      const pdfPath = await exportFile({ format: /^PDF A typeset book/, group: NOVEL, name: 'long.pdf', setup: chooseBig });
      const pdfGap = await longestGap();
      const pdfMs = Date.now() - started;
      const pdf = await readPdf(pdfPath);
      assert.ok(pdf.pages.length > 250, `pages: ${pdf.pages.length}`);
      assert.ok(pdfGap < slowLimit(1500), `the window stalled for ${Math.round(pdfGap)} ms making a PDF`);

      await watchGaps();
      started = Date.now();
      const docxPath = await exportFile({ format: /^Word document/, group: NOVEL, name: 'long.docx', setup: chooseBig });
      const docxGap = await longestGap();
      const docxMs = Date.now() - started;
      const text = (await mammoth.extractRawText({ buffer: readFileSync(docxPath) })).value;
      assert.ok(text.split(/\s+/).length >= 100_000);
      assert.ok(docxGap < slowLimit(1500), `the window stalled for ${Math.round(docxGap)} ms making a Word document`);

      // eslint-disable-next-line no-console
      console.log(`Long book: ${pdf.pages.length} page PDF in ${pdfMs} ms, longest stall ${Math.round(pdfGap)} ms. DOCX in ${docxMs} ms, longest stall ${Math.round(docxGap)} ms.`);

      // Cancelling a long PDF stops it, and leaves nothing behind or stuck.
      const cancelled = workspace.file('cancelled.pdf');
      await answerNextDialog(page, cancelled);
      await page.getByRole('group', { name: NOVEL }).getByRole('radio', { name: /^PDF A typeset book/ }).check();
      await chooseBig();
      await page.getByRole('button', { name: 'Export…' }).click();
      await page.getByText('Laying out pages…').waitFor();
      await page.getByRole('button', { name: 'Cancel' }).click();
      await waitUntil(() => page.getByRole('button', { name: 'Export…' }).isEnabled(), 30_000, 'the cancel to finish');
      assert.equal(await page.getByTestId('export-error').count(), 0);
      assert.equal(existsSync(cancelled), false);
      await page.waitForTimeout(300);
      await page.getByLabel(/^Book/).selectOption(world.bookId);
      assert.ok(statSync(await exportFile({ format: /^PDF A typeset book/, group: NOVEL, name: 'after-cancel.pdf' })).size > 1000);

      await rpc(page, 'books.delete', { id: big.id });
    });
  });

  describe('import', () => {
    async function goToImport() {
      await page.getByRole('menuitem', { name: 'File' }).click();
      await page.getByRole('menuitem', { name: 'Import…', exact: true }).click();
      await page.getByRole('heading', { name: 'Import', exact: true }).waitFor();
    }

    async function chooseFile(path) {
      await goToImport();
      await answerNextDialog(page, path);
      await page.getByRole('button', { name: 'Choose file…' }).click();
    }

    async function chooseFolder(path) {
      await goToImport();
      await answerNextDialog(page, path);
      await page.getByRole('button', { name: 'Choose folder…' }).click();
    }

    const importButton = () => page.getByRole('button', { name: 'Import', exact: true });

    async function pressImport() {
      await importButton().click();
      await page.getByTestId('import-result').waitFor({ timeout: 120_000 });
      return page.getByTestId('import-result').innerText();
    }

    const tableText = () => page.getByTestId('import-preview').innerText();

    it('LoreCraft JSON round trips into a new project with nothing lost', async () => {
      const first = await exportFile({ format: /^JSON The whole/, group: WIKI, name: 'round-1.json' });

      await rpc(page, 'project.close');
      await createProject(page, 'A New Home');
      await chooseFile(first);
      await page.getByTestId('import-preview').waitFor({ timeout: 60_000 });
      assert.match(await page.getByTestId('import-preview-counts').innerText(), /new pages/);
      await app.screenshot('export-import-preview');
      await pressImport();
      await app.screenshot('export-import-result');

      const second = await exportFile({ format: /^JSON The whole/, group: WIKI, name: 'round-2.json' });
      const canonical = (path) => {
        const file = JSON.parse(readFileSync(path, 'utf8'));
        const nodeIds = new Map();
        const walk = (nodes, trail) => {
          for (const node of nodes ?? []) {
            nodeIds.set(node.id, `${trail}/${node.title}`);
            walk(node.children, `${trail}/${node.title}`);
          }
        };
        file.books.forEach((book) => walk(book.children, book.title));
        const clean = (value) => {
          if (Array.isArray(value)) return value.map(clean);
          if (value && typeof value === 'object') {
            return Object.fromEntries(
              Object.entries(value)
                .filter(([key]) => key !== 'id' && key !== 'exportedAt' && key !== 'createdAt' && key !== 'updatedAt')
                .map(([key, v]) => [key, key === 'revealNodeId' || key === 'nodeId' ? nodeIds.get(v) ?? v : clean(v)]),
            );
          }
          return value;
        };
        const { project, ...rest } = file;
        const assets = rest.assets;
        delete rest.assets;
        return { ...clean(rest), assets, meta: Object.fromEntries(Object.entries(project.meta).filter(([key]) => !['project_id', 'name', 'created_at'].includes(key))) };
      };
      const a = canonical(first);
      const b = canonical(second);
      // Books made for other tests are not part of what was compared.
      a.books = a.books.filter((book) => book.title !== 'A Second Book');
      b.books = b.books.filter((book) => book.title !== 'A Second Book');
      assert.deepEqual(b.pages, a.pages);
      assert.deepEqual(b.books, a.books);
      assert.deepEqual(b, a);
      // These come through in a form that compares, so check they are really there.
      const gate = a.books[0].children.find((n) => n.title === 'Arrival').children.find((n) => n.title === 'The Gate');
      assert.equal(gate.location, 'Silver Vale');
      assert.deepEqual(gate.cast, ['Aria Vale', 'Silver Vale']);
      assert.equal(gate.threads.length, 1);
      assert.deepEqual(a.threads.map((t) => t.name), ['The Long Road', 'Not Started Yet']);
      assert.equal(a.threads[0].color, 'green');
      assert.ok(a.meta.pageTypes.includes('Guild'), 'custom page types travel in meta');
      const facts = a.pages.find((p) => p.title === 'Aria Vale').infobox.fields.flatMap((f) => f.changes ?? []);
      assert.ok(facts.length > 0 && facts.every((c) => c.nodeId === 'The Silver Road/Arrival/Inside'), 'a fact that changes names its scene');
      assert.deepEqual(JSON.parse(readFileSync(second, 'utf8')).threads.map((t) => t.id), JSON.parse(readFileSync(first, 'utf8')).threads.map((t) => t.id));
      // The local-only mark comes back, so the new project keeps that writing from cloud AI too.
      assert.equal(a.pages.find((p) => p.title === 'CON').localOnly, true);
      assert.equal(a.pages.find((p) => p.title === 'Aria Vale').localOnly, false);
      const snow = a.books[0].children.find((n) => n.kind === 'part').children[0].children.find((n) => n.title === 'First Snow');
      assert.equal(snow.localOnly, true);
      assert.equal((await rpc(page, 'pages.getByTitle', { title: 'CON' })).localOnly, true);

      const rawFirst = JSON.parse(readFileSync(first, 'utf8'));
      const rawSecond = JSON.parse(readFileSync(second, 'utf8'));
      const ariaFirst = rawFirst.pages.find((p) => p.title === 'Aria Vale');
      const ariaSecond = rawSecond.pages.find((p) => p.title === 'Aria Vale');
      assert.equal(ariaSecond.createdAt, ariaFirst.createdAt, 'times survive too');
      assert.equal(ariaSecond.updatedAt, ariaFirst.updatedAt);
      assert.equal(ariaSecond.infobox.imageAssetId, ariaFirst.infobox.imageAssetId);

      // It really is usable: the main page and links work, and search finds imported text.
      const home = await rpc(page, 'pages.home');
      assert.equal(home.title, 'Main Page');
      assert.ok(JSON.stringify(home.content).includes('Welcome to the Vale'));
      assert.equal((await rpc(page, 'search.query', { q: 'Łukasz' })).length >= 1, true);
      assert.equal((await rpc(page, 'pages.wanted')).some((w) => w.title === 'Nowhere At All'), true);
    });

    it('a JSON file in the documented format arrives, and shows in the UI', async () => {
      const docs = readFileSync(new URL('../docs/IMPORT_FORMAT.md', import.meta.url), 'utf8');
      const example = /## A complete example[\s\S]*?```json\n([\s\S]*?)\n```/.exec(docs)[1];
      const path = workspace.file('world.json');
      writeFileSync(path, example);

      await rpc(page, 'project.close');
      await createProject(page, 'From the Docs');
      await chooseFile(path);
      await page.getByTestId('import-preview').waitFor({ timeout: 60_000 });
      assert.match(await tableText(), /Dorn Ash/);
      assert.match(await tableText(), /Book, 2 chapters, 3 scenes/);
      const result = await pressImport();
      assert.match(result, /Imported/);

      await page.getByTestId('import-result').getByRole('button', { name: 'Aria Vale' }).click();
      await page.getByRole('heading', { name: 'Aria Vale', level: 1 }).waitFor();
      await page.getByText('is a ranger of').waitFor();
      await page.locator('.ProseMirror figure').first().waitFor();

      const aria = await rpc(page, 'pages.getByTitle', { title: 'The Ranger' });
      assert.equal(aria.status, 'canon');
      assert.equal(aria.infobox.fields[0].label, 'Born');
      assert.equal((await rpc(page, 'pages.home')).title, 'The Vale');
      const books = await rpc(page, 'books.list');
      assert.deepEqual(books.map((b) => b.title), ['The Silver Road']);
      const snapshot = await rpc(page, 'snapshot.get');
      assert.equal(snapshot.relationships.length, 3);
      const stats = await rpc(page, 'nodes.stats', { bookId: books[0].id });
      assert.ok(stats.words > 20);
    });

    it('each conflict policy does what the preview says', async () => {
      const path = workspace.file('conflict.json');
      writeFileSync(path, JSON.stringify({
        format: 'lorebook',
        version: 1,
        pages: [
          { title: 'Dorn Ash', status: 'canon', content: 'Rewritten by the import.' },
          { title: 'Brand New', content: 'A new page.' },
        ],
      }));
      await chooseFile(path);
      await page.getByTestId('import-preview').waitFor({ timeout: 60_000 });
      assert.match(await tableText(), /Dorn Ash\s*Page\s*Skip/);
      assert.match(await tableText(), /Brand New\s*Page\s*Add/);

      await page.getByRole('radio', { name: /^Rename/ }).check();
      await page.getByText('Add with a new name').waitFor();
      assert.match(await tableText(), /as Dorn Ash \(2\)/);

      await page.getByRole('radio', { name: /^Overwrite/ }).check();
      await page.getByTestId('import-preview').getByText('Overwrite').waitFor();
      assert.equal((await rpc(page, 'pages.getByTitle', { title: 'Dorn Ash' })).status, 'idea', 'a preview changes nothing');

      const result = await pressImport();
      assert.match(result, /overwritten page/);
      assert.match(result, /saved in the History/);
      const dorn = await rpc(page, 'pages.getByTitle', { title: 'Dorn Ash' });
      assert.equal(dorn.status, 'canon');
      assert.ok(JSON.stringify(dorn.content).includes('Rewritten by the import'));
      const history = await rpc(page, 'revisions.list', { kind: 'page', id: dorn.id });
      assert.equal(history[0].reason, 'import');
      const saved = await rpc(page, 'revisions.get', { id: history[0].id });
      assert.ok(saved.contentText.includes('Possibly Aria'));
    });

    it('a file with mistakes names them, and changes nothing', async () => {
      const path = workspace.file('bad.json');
      writeFileSync(path, JSON.stringify({
        format: 'lorebook',
        version: 1,
        pages: [{ title: 'Fine Page' }, { title: 'Bad Page', status: 'published' }],
        books: [{ title: 'Bad Book', children: [{ kind: 'scene', title: 'Loose' }] }],
      }));
      const before_ = (await rpc(page, 'pages.titles')).length;
      await chooseFile(path);
      await page.getByTestId('import-problems').waitFor({ timeout: 60_000 });
      const problems = await page.getByTestId('import-problems').innerText();
      assert.match(problems, /pages\[1\] "Bad Page", status/);
      assert.match(problems, /"published" is not one of canon, draft, idea, retconned/);
      assert.match(problems, /children\[0\] "Loose", kind/);
      assert.equal(await importButton().isDisabled(), true);
      assert.equal((await rpc(page, 'pages.titles')).length, before_);

      writeFileSync(path, 'not json at all {');
      await chooseFile(path);
      await page.getByTestId('import-problems').getByText('could not be read').waitFor({ timeout: 60_000 });
    });

    it('a Markdown folder with Obsidian features arrives, images and all', async () => {
      const vault = workspace.file('vault');
      const write = (name, content) => {
        const target = join(vault, name);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
      };
      write('People/Mira Stone.md', `---
aliases: [The Smith, "Mira of the Forge"]
tags: [person, smiths]
status: canon
born: 3 Thaw 1190
---

Mira works the forge at [[Ember Hold|the Hold]]. #craft

![[portrait.png|A portrait of Mira]]

See [[Ember Hold#History]] and [[Nowhere Yet]].
`);
      write('Places/Ember Hold.md', '# Ember Hold\n\nA fortress. ==Very== old. %%secret note%%\n\n## History\n\nBuilt long ago by [[Mira Stone|the smith]].\n');
      write('attachments/portrait.png', solidPng(30, 40, [200, 40, 40]));
      write('.obsidian/workspace.json', '{"not":"a note"}');
      write('notes.docx', 'ignored');

      await chooseFolder(vault);
      await page.getByTestId('import-preview').waitFor({ timeout: 60_000 });
      assert.match(await tableText(), /Mira Stone/);
      assert.match(await tableText(), /Ember Hold/);
      assert.doesNotMatch(await tableText(), /workspace/);

      await page.getByRole('checkbox', { name: /folder names into categories/ }).check();
      await page.getByTestId('import-preview').waitFor({ timeout: 60_000 });
      await page.waitForTimeout(300);
      const result = await pressImport();
      assert.match(result, /2 new pages/);
      assert.match(result, /1 new picture/);

      await page.getByTestId('import-result').getByRole('button', { name: 'Mira Stone' }).click();
      await page.getByRole('heading', { name: 'Mira Stone', level: 1 }).waitFor();
      await page.getByText('works the forge').waitFor();
      await page.locator('.ProseMirror figure').waitFor();
      const mira = await rpc(page, 'pages.getByTitle', { title: 'The Smith' });
      assert.deepEqual(mira.categories, ['People', 'craft', 'person', 'smiths']);
      assert.equal(mira.status, 'canon');
      assert.equal(mira.infobox.fields[0].value, '3 Thaw 1190');
      const figure = mira.content.content.find((n) => n.type === 'figure');
      assert.equal(figure.content[1].content[0].text, 'A portrait of Mira');
      const stored = await readAsset(page, figure.content[0].attrs.assetId);
      assert.equal(stored.name, 'portrait.png');
      assert.deepEqual(Buffer.from(stored.base64, 'base64'), solidPng(30, 40, [200, 40, 40]));
      const hold = await rpc(page, 'pages.getByTitle', { title: 'Ember Hold' });
      assert.ok(hold.categories.includes('Places'));
      assert.ok(!JSON.stringify(hold.content).includes('secret note'));
      assert.ok((await rpc(page, 'pages.backlinks', { id: hold.id })).pages.some((p) => p.title === 'Mira Stone'));
    });

    it('a Word document imports under the real CSP, in each mode', async () => {
      const docxPath = workspace.file('book.docx');
      assert.ok(existsSync(docxPath));

      await chooseFile(docxPath);
      await page.getByTestId('import-preview').waitFor({ timeout: 60_000 });
      assert.match(await tableText(), /Page/);
      await page.getByLabel(/Import this document as/).selectOption('book');
      await page.getByText(/Book, \d+ chapters?, \d+ scenes?/).waitFor({ timeout: 60_000 });
      await page.getByRole('radio', { name: /^Rename/ }).check();
      await page.waitForTimeout(300);
      await page.getByText(/Book, \d+ chapters?, \d+ scenes?/).waitFor({ timeout: 60_000 });
      const result = await pressImport();
      assert.match(result, /new book/);
      const books = await rpc(page, 'books.list');
      const imported = books.find((b) => b.title.startsWith('The Silver Road') && b.author === 'Élodie Writer');
      assert.ok(imported, JSON.stringify(books.map((b) => b.title)));
      const tree = await rpc(page, 'nodes.tree', { bookId: imported.id });
      assert.ok(tree.some((n) => n.kind === 'part' && n.title === 'Part Two: The Long Night'));
      assert.ok(tree.some((n) => n.kind === 'chapter' && n.title === 'Arrival'));
      const scene = tree.find((n) => n.kind === 'scene');
      const full = await rpc(page, 'nodes.get', { id: scene.id });
      assert.ok(JSON.stringify(full.content).includes('rode to the gate'));
      assert.ok(JSON.stringify(full.content).includes('"type":"figure"'), 'the picture came back');

      await chooseFile(docxPath);
      await page.getByTestId('import-preview').waitFor({ timeout: 60_000 });
      await page.getByLabel(/Import this document as/).selectOption('pages');
      await page.getByTestId('import-preview').getByText('Part Two: The Long Night').waitFor({ timeout: 60_000 });
    });

    it('plain text becomes a page or a scene', async () => {
      const path = workspace.file('Old Notes.txt');
      writeFileSync(path, Buffer.from([0x54, 0x68, 0xe9, 0x20, 0x65, 0x6e, 0x64, 0x2e, 0x0d, 0x0a, 0x0d, 0x0a, 0x4e, 0x65, 0x78, 0x74]));
      await chooseFile(path);
      await page.getByTestId('import-preview').waitFor({ timeout: 60_000 });
      const result = await pressImport();
      assert.match(result, /new page/);
      const notes = await rpc(page, 'pages.getByTitle', { title: 'Old Notes' });
      assert.ok(JSON.stringify(notes.content).includes('Thé end.'));

      const books = await rpc(page, 'books.list');
      const tree = await rpc(page, 'nodes.tree', { bookId: books[0].id });
      const chapter = tree.find((n) => n.kind === 'chapter');
      await chooseFile(path);
      await page.getByTestId('import-preview').waitFor({ timeout: 60_000 });
      await page.getByLabel(/Import this text as/).selectOption('scene');
      await page.getByLabel(/^Book/).selectOption(books[0].id);
      await page.getByLabel(/^Chapter/).selectOption(chapter.id);
      await page.getByText('Add to the book').waitFor({ timeout: 60_000 });
      await pressImport();
      const after_ = await rpc(page, 'nodes.tree', { bookId: books[0].id });
      assert.ok(after_.some((n) => n.kind === 'scene' && n.title === 'Old Notes' && n.parentId === chapter.id));
    });
  });

  describe('the screens', () => {
    it('look right in dark and light, and can be used from the keyboard', async () => {
      await page.getByRole('menuitem', { name: 'File' }).click();
      await page.getByRole('menuitem', { name: 'Export…', exact: true }).click();
      await page.getByRole('heading', { name: 'Export', exact: true }).waitFor();
      await app.screenshot('export-view-dark');
      await page.evaluate(() => {
        document.documentElement.dataset.mode = 'light';
      });
      await app.screenshot('export-view-light');
      await page.evaluate(() => {
        document.documentElement.dataset.mode = 'dark';
      });

      const json = page.getByRole('radio', { name: /^JSON The whole/ });
      await json.focus();
      await page.keyboard.press('ArrowDown');
      assert.equal(await page.getByRole('radio', { name: /^JSONL/ }).isChecked(), true);
      assert.equal(await page.getByRole('heading', { name: 'JSONL' }).count(), 1);
      await page.getByRole('button', { name: 'Export…' }).focus();
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Export…');
    });

    it('offer a PDF of the page on screen', async () => {
      const home = await rpc(page, 'pages.home');
      await page.getByRole('menuitem', { name: 'View' }).click();
      await page.getByRole('menuitem', { name: 'Main page' }).click();
      await page.getByRole('heading', { name: home.title, level: 1 }).waitFor();
      await page.getByRole('menuitem', { name: 'File' }).click();
      await page.getByRole('menuitem', { name: 'Export this page as PDF…' }).click();
      await page.getByRole('heading', { name: 'Export', exact: true }).waitFor();
      assert.equal(await page.getByRole('group', { name: WIKI }).getByRole('radio', { name: /^PDF One page or/ }).isChecked(), true);
      assert.equal(await page.getByRole('combobox', { name: /^Page$/ }).inputValue(), home.id);
    });
  });

  it('nothing tripped the content security policy, in any window', () => {
    assert.deepEqual(policyViolations, []);
  });
});
