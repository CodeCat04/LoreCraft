/** Find in the page, making a page from selected text, and the idea inbox, in the real app. */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { startMockServer } from '../scripts/mock-ai-server.mjs';
import { createProject, createWorkspace, launch, rpc, waitUntil, slowLimit } from './harness.mjs';

function paragraph(...parts) {
  return {
    type: 'paragraph',
    content: parts.map((part) => (typeof part === 'string' ? { type: 'text', text: part } : part)),
  };
}

function doc(...content) {
  return { type: 'doc', content };
}

const bold = (text) => ({ type: 'text', text, marks: [{ type: 'bold' }] });

function textOf(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text;
  return (node.content ?? []).map(textOf).join(node.type === 'doc' ? '\n' : '');
}

function linksIn(node, found = []) {
  for (const mark of node.marks ?? []) {
    if (mark.type === 'wikiLink') found.push({ text: node.text, target: mark.attrs.target });
  }
  for (const child of node.content ?? []) linksIn(child, found);
  return found;
}

describe('find, make a page, inbox', () => {
  let workspace;
  let app;
  let page;
  let problems;

  const article = () => page.locator('.wiki-article .ProseMirror');
  const bar = () => page.getByRole('search', { name: /^Find in / });
  const findBox = () => page.getByRole('textbox', { name: /^Find in / });
  const replaceBox = () => page.getByRole('textbox', { name: 'Replace with' });
  const count = () => page.getByTestId('find-count');
  const matches = () => page.locator('.find-match');
  const currentMatch = () => page.locator('.find-match-current');

  async function start(name = 'Silver World') {
    app = await launch(workspace);
    page = app.page;
    problems = [];
    page.on('pageerror', (e) => problems.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(m.text());
    });
    await page.setViewportSize({ width: 1400, height: 900 });
    await createProject(page, name);
    await page.locator('.wiki-title').waitFor();
  }

  /** Makes a page through the backend and opens it in Read mode. */
  async function openPage(title, content, patch = {}) {
    const created = await rpc(page, 'pages.create', { title, content, ...patch });
    await waitUntil(
      () => page.evaluate((t) => document.querySelector('.top-search-input') !== null && t, title),
      5000,
      'the search box',
    );
    await page.keyboard.press('Control+l');
    await page.keyboard.type(title);
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: title, exact: true }).waitFor();
    return created;
  }

  async function stored(title) {
    return rpc(page, 'pages.getByTitle', { title });
  }

  async function waitForStored(title, check, label) {
    await waitUntil(async () => check(await stored(title)), 5000, label);
  }

  /** Selects the first occurrence of `text` in the editor, as a mouse drag would. */
  async function selectText(text, editor = '.wiki-article .ProseMirror') {
    await page.evaluate(
      ([what, selector]) => {
        const root = document.querySelector(selector);
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const at = node.textContent.indexOf(what);
          if (at >= 0) {
            window.getSelection().setBaseAndExtent(node, at, node, at + what.length);
            return;
          }
        }
        throw new Error(`${what} is not on screen`);
      },
      [text, editor],
    );
  }

  const menu = () => page.getByRole('dialog', { name: 'AI actions for the selected text' });

  beforeEach(() => {
    workspace = createWorkspace();
  });

  afterEach(async () => {
    if (app && !app.exited) await app.kill().catch(() => {});
    workspace.cleanup();
    assert.deepEqual(problems, [], 'the page logged no errors');
  });

  // ---- Item 4 ----------------------------------------------------------------------

  it('finds in Read mode, steps through matches, and closes back to the page', async () => {
    await start();
    const before = await openPage(
      'Aria',
      doc(
        paragraph('Aria walks the road. '),
        paragraph('The road is ', bold('lo'), 'ng and the ROAD is cold.'),
        paragraph('Broader than a roadside inn, the long road.'),
      ),
    );
    await page.keyboard.press('Control+f');
    await bar().waitFor();
    assert.ok(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Find in this page'), 'the box takes the keyboard');
    assert.equal(await page.getByRole('textbox', { name: 'Replace with' }).count(), 0, 'Read mode has no replacing');

    await page.keyboard.type('road');
    await waitUntil(async () => (await count().innerText()) === '1 of 6', 3000, '1 of 6');
    assert.equal(await matches().count(), 6);
    assert.equal(await currentMatch().count(), 1);
    await app.screenshot('find-read');
    await page.keyboard.press('Control+Shift+l');
    await page.waitForFunction(() => document.documentElement.dataset.mode === 'light');
    await app.screenshot('find-read-light');
    await page.keyboard.press('Control+Shift+l');
    await page.waitForFunction(() => document.documentElement.dataset.mode === 'dark');

    // Whole words leave out "Broader" and "roadside".
    await page.getByRole('button', { name: 'Whole words only' }).click();
    await waitUntil(async () => (await count().innerText()).endsWith(' of 4'), 3000, 'whole words');
    // Matching case leaves out ROAD too.
    await page.getByRole('button', { name: 'Match case' }).click();
    await waitUntil(async () => (await count().innerText()).endsWith(' of 3'), 3000, 'matching case');
    await page.getByRole('button', { name: 'Match case' }).click();
    await page.getByRole('button', { name: 'Whole words only' }).click();
    await waitUntil(async () => (await count().innerText()).endsWith(' of 6'), 3000, 'all again');

    // A match that runs across bold and plain text.
    await findBox().fill('long');
    await waitUntil(async () => (await count().innerText()) === '1 of 2', 3000, 'the bold match');
    assert.deepEqual(await matches().allTextContents(), ['lo', 'ng', 'long'], 'one match, in two pieces, then another');

    await findBox().fill('zzz');
    await waitUntil(async () => (await count().innerText()) === 'No matches', 3000, 'no matches');
    assert.equal(await matches().count(), 0);

    // Enter and Shift+Enter step around the ends.
    await findBox().fill('road');
    await waitUntil(async () => (await count().innerText()) === '1 of 6', 3000, 'road again');
    await page.keyboard.press('Enter');
    assert.equal(await count().innerText(), '2 of 6');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.press('Shift+Enter');
    assert.equal(await count().innerText(), '6 of 6');
    await page.keyboard.press('Enter');
    assert.equal(await count().innerText(), '1 of 6');
    await page.getByRole('button', { name: 'Next match' }).click();
    assert.equal(await count().innerText(), '2 of 6');
    await page.keyboard.press('F3');
    assert.equal(await count().innerText(), '3 of 6');
    await page.keyboard.press('Shift+F3');
    assert.equal(await count().innerText(), '2 of 6');

    // Opening again keeps the words, ready to be typed over.
    await page.keyboard.press('Control+f');
    assert.equal(await findBox().inputValue(), 'road');
    assert.ok(await page.evaluate(() => window.getSelection().toString() === 'road' || document.activeElement?.selectionEnd === 4));

    // Escape takes it all away, and looking changed nothing.
    await findBox().press('Escape');
    await bar().waitFor({ state: 'hidden' });
    assert.equal(await matches().count(), 0);
    await page.waitForFunction(() => document.activeElement !== document.body);
    assert.equal((await stored('Aria')).updatedAt, before.updatedAt, 'the page was not written to');

    // Ctrl+L stays project search, even with a document open.
    await page.keyboard.press('Control+l');
    assert.ok(await page.evaluate(() => document.activeElement?.classList.contains('top-search-input')));
    await page.keyboard.press('Escape');
  });

  it('with no document on screen, Ctrl+F still searches the project', async () => {
    await start();
    await page.getByRole('navigation', { name: 'Wiki' }).getByRole('button', { name: 'All pages' }).click();
    await page.getByRole('heading', { name: 'All pages' }).waitFor();
    await page.keyboard.press('Control+f');
    assert.ok(await page.evaluate(() => document.activeElement?.classList.contains('top-search-input')));
    assert.equal(await bar().count(), 0);
  });

  it('replaces in Edit mode as ordinary undoable edits, and returns the cursor', async () => {
    await start();
    await openPage(
      'Bram',
      doc(
        paragraph('Bram met Ser Tolin at the gate.'),
        paragraph('Ser ', bold('Tolin'), ' left. Later ', { type: 'text', text: 'Ser Tolin', marks: [{ type: 'wikiLink', attrs: { target: 'Ser Tolin' } }] }, ' came back.'),
        paragraph('The end.'),
      ),
    );
    await page.keyboard.press('Control+e');
    await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror'));
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('End');
    await page.keyboard.type(' Here');
    await waitForStored('Bram', (p) => textOf(p.content).includes('gate. Here'), 'the typing');

    // Ctrl+H opens with the replace row up, seeded with nothing.
    await page.keyboard.press('Control+h');
    await replaceBox().waitFor();
    await findBox().fill('ser tolin');
    await waitUntil(async () => (await count().innerText()).endsWith(' of 3'), 3000, 'three matches');
    await app.screenshot('find-replace');

    // Enter in the replace box replaces this one and moves on. Everything starts from the
    // cursor, so the first match is the one after it, wrapping around.
    await replaceBox().fill('the Captain');
    await page.keyboard.press('Enter');
    await waitForStored('Bram', (p) => textOf(p.content).includes('the Captain'), 'the first replacement');
    assert.equal((await count().innerText()).endsWith(' of 2'), true, 'one fewer');

    await page.getByRole('button', { name: 'Replace all' }).click();
    await waitUntil(async () => (await count().innerText()) === 'No matches', 3000, 'nothing left');
    await waitForStored('Bram', (p) => !textOf(p.content).includes('Ser Tolin'), 'all replaced');
    const after = await stored('Bram');
    assert.deepEqual(linksIn(after.content), [{ text: 'the Captain', target: 'Ser Tolin' }], 'a replaced link stays a link, with the new text');

    // Escape: the cursor is back where it was, and typing lands there.
    await page.keyboard.press('Escape');
    await bar().waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror'));
    await page.keyboard.type(' now');
    await waitForStored('Bram', (p) => textOf(p.content).includes('gate. Here now'), 'typing at the cursor');

    // Undo takes it back: the typing, then Replace all in one step, then the first one.
    await page.keyboard.press('Control+z');
    await waitForStored('Bram', (p) => !textOf(p.content).includes('Here now'), 'the typing undone');
    await page.keyboard.press('Control+z');
    await waitForStored('Bram', (p) => (textOf(p.content).match(/Ser Tolin/g) ?? []).length === 2, 'replace all undone');
    await page.keyboard.press('Control+z');
    await waitForStored('Bram', (p) => (textOf(p.content).match(/Ser Tolin/g) ?? []).length === 3, 'the first replacement undone');
  });

  it('keeps the palette on its top match while the pointer rests over the list', async () => {
    await start();
    await openPage('Pointer', doc(paragraph('Some text.')));
    const items = page.locator('.palette-item');

    // Find where the third row comes up, then rest the pointer there and open it again.
    await page.keyboard.press('Control+k');
    await items.nth(4).waitFor();
    const row = await items.nth(2).boundingBox();
    await page.keyboard.press('Escape');
    await page.locator('.palette-input').waitFor({ state: 'hidden' });
    const x = row.x + row.width / 2;
    const y = row.y + row.height / 2;
    await page.mouse.move(x, y);
    await page.keyboard.press('Control+k');
    await items.nth(4).waitFor();

    // The browser reports a list appearing under a resting pointer as a hover. That must not
    // move the choice, or Enter runs whatever happens to be under the pointer.
    await page.waitForTimeout(400);
    assert.equal(await items.first().getAttribute('aria-selected'), 'true', 'the top row is still the choice');
    await page.locator('.palette-input').fill('Find in this page');
    await page.waitForTimeout(200);
    assert.equal(await items.first().getAttribute('aria-selected'), 'true', 'the top match is the choice');

    // A pointer that really moves still picks a row.
    await page.locator('.palette-input').fill('');
    await items.nth(4).waitFor();
    await page.mouse.move(x + 6, y, { steps: 3 });
    await waitUntil(async () => (await items.nth(2).getAttribute('aria-selected')) === 'true', 3000, 'the row under a moving pointer');
    await page.keyboard.press('Escape');
  });

  it('keeps up with the writer: edits, clicks, modes and undo', async () => {
    await start();
    await openPage('Mill', doc(paragraph('The mill wheel turned. '), paragraph('The mill race ran fast.'), paragraph('Nothing else here.')));

    // Selected text is what to look for, and the selection menu keeps out of the way.
    await selectText('mill wheel');
    await menu().waitFor();
    await page.keyboard.press('Control+f');
    await bar().waitFor();
    assert.equal(await findBox().inputValue(), 'mill wheel');
    await waitUntil(async () => (await count().innerText()) === '1 of 1', 3000, 'the seeded search');
    await menu().waitFor({ state: 'hidden' });

    // Read to Edit with the bar open: same search, and replacing becomes possible.
    await findBox().fill('mill');
    await waitUntil(async () => (await count().innerText()).endsWith(' of 2'), 3000, 'two mills');
    assert.equal(await page.getByRole('button', { name: 'Show replace' }).count(), 0);
    await page.keyboard.press('Control+e');
    await page.getByRole('button', { name: 'Show replace' }).waitFor();
    assert.ok(await bar().isVisible());
    assert.equal(await matches().count(), 2, 'the highlights stayed');

    // Typing in the document with the bar open updates the count, without moving the page.
    await page.locator('.wiki-article .ProseMirror').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' A mill too.');
    await waitUntil(async () => (await count().innerText()).endsWith(' of 3'), 3000, 'the new match');
    assert.ok(await page.evaluate(() => document.activeElement?.classList.contains('ProseMirror')), 'the writer keeps the keyboard');

    // Having clicked in the text, Escape leaves the cursor where it was put.
    await page.keyboard.press('Escape');
    await bar().waitFor({ state: 'hidden' });
    await page.keyboard.type(' Done.');
    await waitForStored('Mill', (p) => textOf(p.content).includes('A mill too. Done.'), 'typing where the cursor was');

    // Ctrl+Z in the replace box takes back the replacement, not what was typed in the box.
    await page.keyboard.press('Control+h');
    await replaceBox().waitFor();
    assert.equal(await findBox().inputValue(), 'mill', 'the last search comes back');
    await waitUntil(async () => (await count().innerText()).endsWith(' of 3'), 3000, 'the same search');
    await replaceBox().fill('forge');
    await page.keyboard.press('Control+Enter');
    await waitForStored('Mill', (p) => !textOf(p.content).includes('mill'), 'all replaced');
    await page.keyboard.press('Control+z');
    await waitForStored('Mill', (p) => (textOf(p.content).match(/mill/g) ?? []).length === 3, 'undone from the box');
    assert.equal(await replaceBox().inputValue(), 'forge');
    await page.keyboard.press('Control+y');
    await waitForStored('Mill', (p) => !textOf(p.content).includes('mill'), 'redone from the box');
    await page.keyboard.press('Control+z');
    await waitForStored('Mill', (p) => (textOf(p.content).match(/mill/g) ?? []).length === 3, 'undone again');
    await page.keyboard.press('Escape');
    await bar().waitFor({ state: 'hidden' });

    // The palette reaches it too.
    await page.keyboard.press('Control+k');
    await page.locator('.palette-input').fill('Find in this page');
    await page.keyboard.press('Enter');
    await bar().waitFor();
    assert.ok(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')?.startsWith('Find in')));
    await page.keyboard.press('Escape');
    await bar().waitFor({ state: 'hidden' });

    // On the Talk tab it means the notes, not the hidden article.
    await page.getByRole('button', { name: 'Talk', exact: true }).click();
    const notes = page.locator('.wiki-talk .ProseMirror');
    await notes.click();
    await page.keyboard.type('Ask about the mill.');
    await page.keyboard.press('Control+f');
    await page.getByRole('search', { name: 'Find in these notes' }).waitFor();
    await waitUntil(async () => (await count().innerText()) === '1 of 1', 3000, 'one match in the notes');
    assert.equal(await page.locator('.wiki-talk .find-match').count(), 1);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.closest('.wiki-talk') !== null);
  });

  it('works in the chapter read-through and in focus mode', async () => {
    await start();
    const books = await rpc(page, 'books.list');
    const tree = await rpc(page, 'nodes.tree', { bookId: books[0].id });
    const scene = tree.find((n) => n.kind === 'scene');
    await rpc(page, 'nodes.update', { id: scene.id, patch: { content: doc(paragraph('The gate stood open. The gate was old.')) } });
    await page.getByRole('button', { name: 'Write', exact: true }).click();
    await page.locator('.write-page .ProseMirror').waitFor();
    await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror'));

    // Focus mode: Escape takes the nearest thing first.
    await page.keyboard.press('F11');
    await page.locator('.app.is-focus-mode').waitFor();
    await page.keyboard.press('Control+f');
    await page.getByRole('search', { name: 'Find in this scene' }).waitFor();
    await page.keyboard.type('gate');
    await waitUntil(async () => (await count().innerText()) === '1 of 2', 3000, 'two gates');
    await app.screenshot('find-focus-mode');
    await page.keyboard.press('Escape');
    await bar().waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.app.is-focus-mode').count(), 1, 'still in focus mode');
    await page.keyboard.press('Escape');
    await page.locator('.app.is-focus-mode').waitFor({ state: 'hidden' });

    // Read-through: a click in the bar stays in the bar, rather than opening the scene.
    await page.keyboard.press('Control+Alt+2');
    await page.locator('.read-scene-text .ProseMirror').waitFor();
    await page.keyboard.press('Control+f');
    await page.getByRole('search', { name: 'Find in this scene' }).waitFor();
    await waitUntil(async () => (await count().innerText()) === '1 of 2', 3000, 'the same search');
    await findBox().click();
    await page.getByRole('button', { name: 'Next match' }).click();
    assert.equal(await count().innerText(), '2 of 2');
    assert.equal(await page.locator('.read-scene-text .ProseMirror').count(), 1, 'still reading');
    await page.keyboard.press('Escape');
    await bar().waitFor({ state: 'hidden' });
  });

  it('finds in a scene, and stays usable on a very long document', async () => {
    await start();
    const books = await rpc(page, 'books.list');
    const tree = await rpc(page, 'nodes.tree', { bookId: books[0].id });
    const scene = tree.find((n) => n.kind === 'scene');
    // 100,000 words.
    const line = 'the quick brown fox jumps over the lazy dog and keeps on running through the deep dark wood ';
    const blocks = Array.from({ length: 5500 }, (_, i) => paragraph(`${line} line${i} `));
    await rpc(page, 'nodes.update', { id: scene.id, patch: { content: doc(...blocks) } });
    await page.getByRole('button', { name: 'Write', exact: true }).click();
    const editor = page.locator('.write-page .ProseMirror');
    await editor.waitFor();
    await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror'));

    await page.keyboard.press('Control+f');
    await bar().waitFor();
    const started = Date.now();
    await page.keyboard.type('the');
    await waitUntil(async () => (await count().innerText()).endsWith('16,500'), 8000, 'the count');
    const elapsed = Date.now() - started;
    console.log(`typing "the" to 16,500 counted matches took ${elapsed} ms`);
    assert.ok(elapsed < slowLimit(3000), `it took ${elapsed} ms`);
    const drawn = await matches().count();
    assert.ok(drawn > 0 && drawn <= 1501, `only what is near the screen is drawn: ${drawn}`);
    await app.screenshot('find-long');

    // Stepping stays quick, and the current match is on screen.
    const steps = Date.now();
    for (let i = 0; i < 20; i += 1) await page.keyboard.press('Enter');
    console.log(`20 steps took ${Date.now() - steps} ms`);
    assert.ok(Date.now() - steps < slowLimit(4000));

    // However far that went, Escape puts the page and the cursor back as they were.
    await findBox().fill('line4000');
    await waitUntil(async () => (await count().innerText()) === '1 of 1', 3000, 'a line far down');
    const scroller = () => page.evaluate(() => document.querySelector('.write-scroll').scrollTop);
    await waitUntil(async () => (await scroller()) > 1000, 3000, 'the page to scroll there');
    await page.keyboard.press('Escape');
    await bar().waitFor({ state: 'hidden' });
    assert.ok(await page.evaluate(() => document.activeElement?.classList.contains('ProseMirror')));
    assert.ok((await scroller()) < 200, 'back at the top');

    // Jumps far away and back: the last match, then the first.
    await page.keyboard.press('Control+f');
    await findBox().fill('line5499');
    await waitUntil(async () => (await count().innerText()) === '1 of 1', 3000, 'the last line');
    await waitUntil(
      () =>
        page.evaluate(() => {
          const box = document.querySelector('.find-match-current')?.getBoundingClientRect();
          return box && box.top > 0 && box.bottom < window.innerHeight;
        }),
      3000,
      'the match to scroll into view',
    );

    // Back to many, far down the document: highlights follow the scrolling.
    await findBox().fill('the');
    await waitUntil(async () => (await count().innerText()).endsWith('16,500'), 8000, 'the count again');
    await page.evaluate(() => {
      document.querySelector('.write-scroll').scrollTop = 0;
    });
    await waitUntil(
      () =>
        page.evaluate(() => {
          const box = document.querySelector('.write-scroll').getBoundingClientRect();
          return [...document.querySelectorAll('.find-match')].some((m) => {
            const r = m.getBoundingClientRect();
            return r.top >= box.top && r.bottom <= box.bottom;
          });
        }),
      3000,
      'highlights where the page is now',
    );

    // Replacing them all is one undoable step, and does not take long either.
    await page.keyboard.press('Control+h');
    await replaceBox().waitFor();
    await replaceBox().fill('that');
    const replacing = Date.now();
    await page.getByRole('button', { name: 'Replace all' }).click();
    await waitUntil(async () => (await count().innerText()) === 'No matches', 60000, 'all replaced');
    console.log(`replacing 16,500 matches took ${Date.now() - replacing} ms`);
    const undoing = Date.now();
    await page.keyboard.press('Control+z');
    await waitUntil(async () => (await count().innerText()).endsWith('16,500'), 60000, 'all back');
    console.log(`undoing them took ${Date.now() - undoing} ms`);

    await page.keyboard.press('Escape');
    await bar().waitFor({ state: 'hidden' });
    assert.equal(await matches().count(), 0);
  });

  // ---- Item 5 ----------------------------------------------------------------------

  it('makes a page from selected text, as a draft, without leaving', async () => {
    await start();
    await openPage('Journal', doc(paragraph('We rode to Silver Vale at dawn. Silver Vale was empty.'), paragraph('Nobody in Silver Vale spoke.')));
    await page.keyboard.press('Control+e');
    await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror'));

    await selectText('Silver Vale');
    await menu().getByRole('button', { name: 'Make a page' }).waitFor();
    await app.screenshot('make-page-menu');
    await menu().getByRole('button', { name: 'Make a page' }).click();
    const dialog = page.getByRole('dialog', { name: 'Make a page' });
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('textbox', { name: 'Title' }).inputValue(), 'Silver Vale');
    await app.screenshot('make-page-dialog');
    await dialog.getByRole('combobox', { name: 'Type' }).selectOption('place');
    await dialog.getByRole('checkbox', { name: /Also link the other 2 mentions/ }).check();
    await dialog.getByRole('button', { name: 'Create and link' }).click();
    await dialog.waitFor({ state: 'hidden' });

    // Still on the same page, in the same mode, with the link in place.
    await page.getByRole('textbox', { name: 'Page title' }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Page title' }).inputValue(), 'Journal');
    const made = await stored('Silver Vale');
    assert.equal(made.status, 'draft');
    assert.equal(made.pageType, 'place');
    assert.ok(made.infobox.fields.length > 0, 'it has the type’s fields');
    await waitForStored('Journal', (p) => linksIn(p.content).length === 3, 'three links');
    const links = linksIn((await stored('Journal')).content);
    assert.ok(links.every((l) => l.text === 'Silver Vale' && l.target === 'Silver Vale'));
    assert.equal(textOf((await stored('Journal')).content).includes('We rode to Silver Vale at dawn.'), true, 'the words did not change');
    await page.locator('.wiki-article .ProseMirror .wiki-link-ok').first().waitFor();
    assert.equal(await page.locator('.wiki-article .ProseMirror .wiki-link-red').count(), 0, 'blue from the start');
    await app.screenshot('make-page-linked');

    // One undo takes back the link and the mentions together.
    await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror'));
    await page.keyboard.press('Control+z');
    await waitForStored('Journal', (p) => linksIn(p.content).length === 0, 'links undone');

    // Changing the title to a page that exists links to that page instead.
    await selectText('dawn');
    await menu().getByRole('button', { name: 'Make a page' }).click();
    await dialog.waitFor();
    await dialog.getByRole('textbox', { name: 'Title' }).fill('silver vale');
    await dialog.getByRole('button', { name: 'Link to it' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await waitForStored('Journal', (p) => linksIn(p.content).length === 1, 'the link to the existing page');
    assert.deepEqual(linksIn((await stored('Journal')).content), [{ text: 'dawn', target: 'Silver Vale' }]);
    // The cursor is after the link, and typing does not extend it or replace it.
    await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror'));
    await page.keyboard.type('!');
    await waitForStored('Journal', (p) => textOf(p.content).includes('at dawn!.'), 'typing after the link');
    assert.deepEqual(linksIn((await stored('Journal')).content), [{ text: 'dawn', target: 'Silver Vale' }]);
  });

  it('links in one click when the name has a page, then offers the other mentions', async () => {
    await start();
    await rpc(page, 'pages.create', { title: 'Aria', aliases: ['The Grey Lady'] });
    const notes = await openPage('Notes', doc(paragraph('The Grey Lady spoke. Aria answered, and Aria left, and aria played. Aria’s horse waited.')));

    // Read mode is safe here, because the article still saves itself.
    await selectText('The Grey Lady');
    await menu().getByRole('button', { name: 'Link to page' }).waitFor();
    await menu().getByRole('button', { name: 'Link to page' }).click();
    await waitForStored('Notes', (p) => linksIn(p.content).length === 1, 'the link');
    assert.deepEqual(linksIn((await stored('Notes')).content), [{ text: 'The Grey Lady', target: 'Aria' }]);
    await page.locator('h1.wiki-title').waitFor();

    // With the words still selected, the same place offers the rest. The lower-case word
    // is not the name, and the possessive is.
    const others = menu().getByRole('button', { name: /Link \d+ other mentions?/ });
    await others.waitFor();
    assert.equal(await others.innerText(), 'Link 3 other mentions');
    await others.click();
    await waitForStored('Notes', (p) => linksIn(p.content).length === 4, 'the mentions');
    await others.waitFor({ state: 'hidden' });
    assert.ok(linksIn((await stored('Notes')).content).every((l) => l.target === 'Aria'));

    // Alt+L does the same from the keyboard, and there is nothing left to link here.
    await page.keyboard.press('Alt+l');
    await page.getByText('There is nothing to link in this selection.').waitFor();
    assert.equal(linksIn((await rpc(page, 'pages.get', { id: notes.id })).content).length, 4);

    // A possessive still finds its page.
    await openPage('Stable', doc(paragraph('Aria’s horse waited.')));
    await selectText('Aria’s');
    await menu().getByRole('button', { name: 'Link to page' }).click();
    await waitForStored('Stable', (p) => linksIn(p.content).length === 1, 'the possessive link');
    assert.deepEqual(linksIn((await stored('Stable')).content), [{ text: 'Aria’s', target: 'Aria' }]);

    // A page has no need to link to itself.
    await openPage('Aria Again', doc(paragraph('Here Aria Again sits.')));
    await selectText('Aria Again');
    await menu().getByRole('button', { name: 'Send to pane' }).waitFor();
    assert.equal(await menu().getByRole('button', { name: /Link to page|Make a page/ }).count(), 0);
  });

  it('keeps links out of an old version, and opens a scene before linking from read-through', async () => {
    await start();
    await openPage('Reader', doc(paragraph('Old text about Silver Vale.')));
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await page.getByRole('button', { name: 'Save a checkpoint' }).click();
    await page.getByRole('dialog', { name: 'Save a checkpoint' }).getByRole('textbox').fill('First');
    await page.keyboard.press('Enter');
    await page.getByRole('row', { name: /First/ }).getByRole('button', { name: /^View/ }).click();
    const old = page.getByRole('region', { name: 'Old version' });
    await old.waitFor();
    await selectText('Silver Vale', '.wiki-old-version .ProseMirror');
    await menu().getByRole('button', { name: 'Send to pane' }).waitFor();
    assert.equal(await menu().getByRole('button', { name: /Make a page|Link to page/ }).count(), 0);

    // The chapter read-through saves nothing, so linking goes through the scene's editor.
    const books = await rpc(page, 'books.list');
    const tree = await rpc(page, 'nodes.tree', { bookId: books[0].id });
    const scene = tree.find((n) => n.kind === 'scene');
    await rpc(page, 'nodes.update', { id: scene.id, patch: { content: doc(paragraph('They reached Salt Harbor at noon.')) } });
    await page.getByRole('button', { name: 'Write', exact: true }).click();
    await page.locator('.write-page .ProseMirror').waitFor();
    await page.keyboard.press('Control+Alt+2');
    const read = page.locator('.read-scene-text .ProseMirror');
    await read.waitFor();
    await selectText('Salt Harbor', '.read-scene-text .ProseMirror');
    await menu().getByRole('button', { name: 'Make a page' }).click();
    const dialog = page.getByRole('dialog', { name: 'Make a page' });
    await dialog.waitFor();
    await page.locator('.write-page .ProseMirror[contenteditable="true"]').waitFor();
    await dialog.getByRole('button', { name: 'Create and link' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await waitUntil(
      async () => linksIn((await rpc(page, 'nodes.get', { id: scene.id })).content).length === 1,
      5000,
      'the link in the stored scene',
    );
    assert.deepEqual(linksIn((await rpc(page, 'nodes.get', { id: scene.id })).content), [{ text: 'Salt Harbor', target: 'Salt Harbor' }]);
    assert.equal((await stored('Salt Harbor')).status, 'draft');
  });

  it('drafts a new page with AI when asked', async () => {
    const mock = await startMockServer();
    try {
      await start();
      await rpc(page, 'settings.update', {
        patch: {
          ai: {
            profiles: [{ id: 'local', name: 'Local model', kind: 'openai-compatible', baseUrl: `${mock.url}/v1`, model: 'mock-local', isCloud: false }],
            routing: { chat: 'local', rewrite: 'local', extract: 'local', consistency: 'local' },
          },
        },
      });
      await page.reload();
      await page.locator('.topbar').waitFor();
      await openPage('Chronicle', doc(paragraph('The Salt Road crossed the hills.')));
      await page.keyboard.press('Control+e');
      await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror'));
      await selectText('Salt Road');
      await menu().getByRole('button', { name: 'Make a page' }).click();
      const dialog = page.getByRole('dialog', { name: 'Make a page' });
      await dialog.waitFor();
      await dialog.getByRole('checkbox', { name: /Draft it with AI/ }).check();
      await dialog.getByRole('button', { name: 'Create and link' }).click();
      await dialog.waitFor({ state: 'hidden' });

      // The new page opens, with what the AI wrote as suggestions and nothing stored yet.
      await waitUntil(async () => (await page.getByRole('textbox', { name: 'Page title' }).inputValue().catch(() => '')) === 'Salt Road', 8000, 'the new page');
      await page.getByRole('region', { name: 'Suggested changes' }).waitFor({ timeout: 15000 });
      await app.screenshot('make-page-draft');
      assert.equal(textOf((await stored('Salt Road')).content).trim(), '', 'nothing is stored until it is accepted');
      const chronicle = await stored('Chronicle');
      assert.deepEqual(linksIn(chronicle.content), [{ text: 'Salt Road', target: 'Salt Road' }], 'the first page kept its link');
    } finally {
      await mock.close();
    }
  });

  // ---- Item 19 ----------------------------------------------------------------------

  it('captures an idea from anywhere without losing the cursor', async () => {
    await start();
    const aria = await openPage('Aria', doc(paragraph('Aria walks. ')));
    await page.keyboard.press('Control+e');
    await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror'));
    await page.keyboard.press('Control+End');
    await page.keyboard.type('Before ');

    await page.keyboard.press('Control+Alt+n');
    const box = page.getByRole('dialog', { name: 'New idea' });
    await box.waitFor();
    await app.screenshot('inbox-capture');
    await page.keyboard.type('A guild of smugglers');
    await page.keyboard.press('Enter');
    await box.waitFor({ state: 'hidden' });

    // Back in the text, and typing goes on from the same spot.
    await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror'));
    await page.keyboard.type('after.');
    await waitForStored('Aria', (p) => textOf(p.content).includes('Before after.'), 'the cursor kept its place');

    const [idea] = await rpc(page, 'ideas.list');
    assert.equal(idea.text, 'A guild of smugglers');
    assert.equal(idea.sourceKind, 'page');
    assert.equal(idea.sourceId, aria.id);

    // Escape saves nothing, but the words wait, selected, in case that was a slip.
    await page.keyboard.press('Control+Alt+n');
    await box.waitFor();
    await page.keyboard.type('Never mind');
    await page.keyboard.press('Escape');
    await box.waitFor({ state: 'hidden' });
    assert.equal((await rpc(page, 'ideas.list')).length, 1);
    await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror'));
    await page.keyboard.press('Control+Alt+n');
    await box.waitFor();
    assert.equal(await box.getByRole('textbox').inputValue(), 'Never mind');
    await page.keyboard.type('Said it');
    await page.keyboard.press('Enter');
    await box.waitFor({ state: 'hidden' });
    assert.equal((await rpc(page, 'ideas.list'))[0].text, 'Said it');

    // In a scene, it remembers the scene.
    const books = await rpc(page, 'books.list');
    const tree = await rpc(page, 'nodes.tree', { bookId: books[0].id });
    const scene = tree.find((n) => n.kind === 'scene');
    await page.getByRole('button', { name: 'Write', exact: true }).click();
    await page.locator('.write-page .ProseMirror').waitFor();
    await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror'));
    await page.keyboard.press('Control+Alt+n');
    await box.waitFor();
    await page.keyboard.type('From the book');
    await page.keyboard.press('Enter');
    await box.waitFor({ state: 'hidden' });
    const fromBook = (await rpc(page, 'ideas.list'))[0];
    assert.equal(fromBook.sourceKind, 'node');
    assert.equal(fromBook.sourceId, scene.id);
    assert.equal(fromBook.sourceBookId, books[0].id);
    await page.getByRole('button', { name: 'Wiki', exact: true }).click();

    // From a screen with no document at all, it remembers no place.
    await page.getByRole('navigation', { name: 'Wiki' }).getByRole('button', { name: 'All pages' }).click();
    await page.getByRole('heading', { name: 'All pages' }).waitFor();
    await page.keyboard.press('Control+Alt+n');
    await box.waitFor();
    await page.keyboard.type('First line');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('Second line');
    await page.keyboard.press('Enter');
    await box.waitFor({ state: 'hidden' });
    const newest = (await rpc(page, 'ideas.list'))[0];
    assert.equal(newest.text, 'First line\nSecond line');
    assert.equal(newest.sourceKind, null);
  });

  it('works through the inbox: edit, done, jump, turn into a page or a scene, delete', async () => {
    await start();
    const aria = await rpc(page, 'pages.create', { title: 'Aria' });
    const books = await rpc(page, 'books.list');
    const tree = await rpc(page, 'nodes.tree', { bookId: books[0].id });
    const scene = tree.find((n) => n.kind === 'scene');
    await rpc(page, 'ideas.add', { text: 'From a page', sourceKind: 'page', sourceId: aria.id });
    await rpc(page, 'ideas.add', { text: 'From a scene', sourceKind: 'node', sourceId: scene.id });
    await rpc(page, 'ideas.add', { text: 'The salt market\nIt moves at night.' });
    await rpc(page, 'ideas.add', { text: 'Throw this away' });

    const tools = page.getByRole('navigation', { name: 'Tools' });
    await waitUntil(async () => (await tools.getByRole('button', { name: /Inbox/ }).innerText()).includes('4'), 3000, 'the count in the sidebar');
    await tools.getByRole('button', { name: /Inbox/ }).click();
    await page.getByRole('heading', { name: 'Inbox' }).waitFor();
    const item = (text) => page.locator('.inbox-item', { hasText: text });
    await item('From a page').waitFor();
    await app.screenshot('inbox');

    // Edit in place.
    await item('From a page').getByRole('button', { name: 'Edit' }).click();
    const editBox = page.getByRole('textbox', { name: 'Idea text' });
    await editBox.fill('Changed on a page');
    await page.keyboard.press('Enter');
    await item('Changed on a page').waitFor();

    // Jump to where it was captured.
    await item('Changed on a page').getByRole('button', { name: 'From Aria' }).click();
    await page.getByRole('heading', { name: 'Aria', exact: true }).waitFor();
    await page.keyboard.press('Alt+ArrowLeft');
    await item('From a scene').getByRole('button', { name: /^From / }).click();
    await page.locator('.write-page .ProseMirror').waitFor();
    await page.keyboard.press('Alt+ArrowLeft');
    await page.getByRole('heading', { name: 'Inbox' }).waitFor();

    // Mark done moves it to the other list, and back.
    await item('Changed on a page').getByRole('button', { name: 'Mark done' }).click();
    await item('Changed on a page').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: /^Done \(1\)/ }).click();
    await item('Changed on a page').getByRole('button', { name: 'Put back' }).click();
    await item('Changed on a page').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: /^Open \(4\)/ }).click();

    // Delete asks first.
    await item('Throw this away').getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('alertdialog', { name: 'Delete this idea?' }).getByRole('button', { name: 'Delete' }).click();
    await item('Throw this away').waitFor({ state: 'hidden' });

    // Turn into a page, with status idea, and the rest of the idea as its text.
    await item('The salt market').getByRole('button', { name: 'Turn into a page' }).click();
    const dialog = page.getByRole('dialog', { name: 'Turn this idea into a page' });
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('textbox', { name: 'Title' }).inputValue(), 'The salt market');
    await dialog.getByRole('combobox', { name: 'Type' }).selectOption('place');
    await dialog.getByRole('button', { name: 'Create page' }).click();
    await page.getByRole('textbox', { name: 'Page title' }).waitFor();
    await page.getByRole('heading', { name: 'Inbox' }).waitFor({ state: 'hidden' });
    const made = await stored('The salt market');
    assert.equal(made.status, 'idea');
    assert.equal(made.pageType, 'place');
    assert.match(textOf(made.content), /It moves at night\./);
    const counts = await rpc(page, 'ideas.count');
    assert.deepEqual(counts, { open: 2, done: 1 });

    await page.keyboard.press('Alt+ArrowLeft');
    await page.getByRole('heading', { name: 'Inbox' }).waitFor();
    await tools.getByRole('button', { name: /Inbox/ }).waitFor();
    assert.ok((await tools.getByRole('button', { name: /Inbox/ }).innerText()).includes('2'));

    // Turn into a scene, at the end of the book it came from, with the idea as its text.
    await item('From a scene').getByRole('button', { name: 'Turn into a scene' }).click();
    await page.locator('.write-page .ProseMirror').waitFor();
    const after = await rpc(page, 'nodes.tree', { bookId: books[0].id });
    const madeScene = after.find((n) => n.kind === 'scene' && n.title === 'From a scene');
    assert.ok(madeScene, 'the scene is in the book');
    assert.match(textOf((await rpc(page, 'nodes.get', { id: madeScene.id })).content), /From a scene/);
    assert.deepEqual(await rpc(page, 'ideas.count'), { open: 1, done: 2 });
  });
});
