import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { allowPath, createProject, createWorkspace, launch, rpc, waitUntil } from './harness.mjs';

const EDITABLE = '.ProseMirror[contenteditable="true"]';

function paragraphs(...texts) {
  return { type: 'doc', content: texts.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })) };
}

function longDoc(prefix, count = 150) {
  return paragraphs(...Array.from({ length: count }, (_, i) => `${prefix} paragraph number ${i}, with enough words to fill out a line or two of the page.`));
}

function linkDoc(label, target) {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: label, marks: [{ type: 'wikiLink', attrs: { target } }] }] }],
  };
}

const pane = (page, id) => page.locator(`[data-pane-id="${id}"]`);
const tab = (page, name, id = 'main') => pane(page, id).getByRole('tab', { name, exact: true });

function tabNames(page, id = 'main') {
  return pane(page, id)
    .getByRole('tab')
    .evaluateAll((tabs) => tabs.map((t) => t.getAttribute('aria-label')));
}

async function waitForTabs(page, names, id = 'main') {
  await waitUntil(async () => JSON.stringify(await tabNames(page, id)) === JSON.stringify(names), 5000, `the tabs ${names}`);
}

async function openPage(page, title) {
  await page.locator('.top-search-input').fill(title);
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: title, exact: true }).first().waitFor();
}

async function firstScene(page) {
  const [book] = await rpc(page, 'books.list');
  const rows = await rpc(page, 'nodes.tree', { bookId: book.id });
  return { book, scene: rows.find((r) => r.kind === 'scene') };
}

async function storedScene(page, id) {
  return JSON.stringify((await rpc(page, 'nodes.get', { id })).content);
}

async function storedPage(page, id) {
  return JSON.stringify((await rpc(page, 'pages.get', { id })).content);
}

function waitForSaveState(page, pattern) {
  return waitUntil(async () => pattern.test(await page.getByTestId('save-state').innerText()), 5000, `the save state ${pattern}`);
}

/** Longer than the delay before tabs and places are written to the settings. */
const REMEMBER_MS = 2000;

/** Closes the app as a person would. The start screen has no menus, so it goes by the palette. */
async function exitApp(app) {
  const file = app.page.getByRole('menuitem', { name: 'File' });
  if (await file.count()) {
    await file.click();
    await app.page.getByRole('menuitem', { name: 'Exit' }).click();
  } else {
    await app.page.keyboard.press('Control+k');
    const input = app.page.getByPlaceholder('Search pages and commands…');
    await waitUntil(() => input.evaluate((el) => el === document.activeElement), 2000, 'the palette to open');
    await app.page.waitForTimeout(30);
    await input.fill('Exit');
    await app.page.getByRole('option', { name: 'Exit' }).first().waitFor();
    await app.page.keyboard.press('Enter');
  }
  await app.waitForExit();
}

describe('tabs', () => {
  let workspace;
  let app;
  let problems;

  beforeEach(() => {
    workspace = createWorkspace();
    problems = [];
  });

  afterEach(async (t) => {
    if (t.passed === false && app && !app.exited) await app.screenshot('tabs-last-failure').catch(() => {});
    if (app && !app.exited) await app.kill().catch(() => {});
    workspace.cleanup();
  });

  async function launchWatched() {
    app = await launch(workspace);
    app.page.on('pageerror', (e) => problems.push(e.message));
    return app.page;
  }

  async function start(name = 'Tab World') {
    const page = await launchWatched();
    await createProject(page, name);
    return page;
  }

  it('opens links in new tabs, each with its own history, and closes back to the main page', async () => {
    const page = await start();
    await rpc(page, 'pages.create', { title: 'Elara', pageType: 'character', status: 'canon', content: paragraphs('A wandering scribe.') });
    await rpc(page, 'pages.create', { title: 'Story', status: 'canon', content: linkDoc('the scribe', 'Elara') });
    await openPage(page, 'Story');
    await waitForTabs(page, ['Story']);

    // Ctrl+click on a link opens a new tab, and the first tab keeps its place.
    await page.locator('.ProseMirror a[data-wiki-target="Elara"]').click({ modifiers: ['Control'] });
    await page.getByRole('heading', { name: 'Elara', exact: true }).waitFor();
    await waitForTabs(page, ['Story', 'Elara']);
    assert.equal(await tab(page, 'Elara').getAttribute('aria-selected'), 'true');

    // The new tab has no history of its own, so Back has nowhere to go.
    await page.keyboard.press('Alt+ArrowLeft');
    await page.waitForTimeout(100);
    await page.getByRole('heading', { name: 'Elara', exact: true }).waitFor();

    // The first tab still does.
    await page.keyboard.press('Control+Tab');
    await page.getByRole('heading', { name: 'Story', exact: true }).waitFor();
    assert.equal(await tab(page, 'Story').getAttribute('aria-selected'), 'true');
    await page.keyboard.press('Alt+ArrowLeft');
    await waitForTabs(page, ['Main page', 'Elara']);
    await page.keyboard.press('Alt+ArrowRight');
    await waitForTabs(page, ['Story', 'Elara']);
    await page.keyboard.press('Control+Shift+Tab');
    await page.getByRole('heading', { name: 'Elara', exact: true }).waitFor();
    await page.keyboard.press('Control+Tab');
    await page.getByRole('heading', { name: 'Story', exact: true }).waitFor();

    // A middle-click also opens one, just after the current tab.
    await page.locator('.ProseMirror a[data-wiki-target="Elara"]').click({ button: 'middle' });
    await waitForTabs(page, ['Story', 'Elara', 'Elara']);
    assert.equal(await page.getByRole('heading', { name: 'Elara', exact: true }).count(), 1);

    // So does a link in a list of pages.
    await page.keyboard.press('Control+t');
    await waitForTabs(page, ['Story', 'Elara', 'Main page', 'Elara']);
    await app.screenshot('tabs-strip');

    // A drag reorders.
    const from = await tab(page, 'Story').boundingBox();
    const to = await tab(page, 'Main page').boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2, { steps: 3 });
    await page.mouse.move(to.x + to.width - 4, to.y + to.height / 2, { steps: 8 });
    await page.mouse.up();
    await waitForTabs(page, ['Elara', 'Main page', 'Story', 'Elara']);

    // So do the arrow keys, from the tab itself.
    await tab(page, 'Story').focus();
    await page.keyboard.press('Shift+ArrowLeft');
    await waitForTabs(page, ['Elara', 'Story', 'Main page', 'Elara']);

    // Closing, with a click on the cross, the middle button and the keyboard.
    await tab(page, 'Story').hover();
    await tab(page, 'Story').locator('.doc-tab-close').click();
    await waitForTabs(page, ['Elara', 'Main page', 'Elara']);
    await tab(page, 'Main page').click({ button: 'middle' });
    await waitForTabs(page, ['Elara', 'Elara']);
    await page.keyboard.press('Control+w');
    await waitForTabs(page, ['Elara']);
    await page.keyboard.press('Control+w');
    await waitForTabs(page, ['Main page']);
    await pane(page, 'main').locator('h1.wiki-title').waitFor();
    assert.equal(await tab(page, 'Main page').getAttribute('aria-selected'), 'true');
    assert.deepEqual(problems, []);
  });

  it('goes back and forward with the buttons, the mouse side buttons and the keyboard', async () => {
    const page = await start();
    await rpc(page, 'pages.create', { title: 'Alder', status: 'canon', content: linkDoc('the birch wood', 'Birch') });
    await rpc(page, 'pages.create', { title: 'Birch', status: 'canon', content: linkDoc('the cedar hall', 'Cedar') });
    const back = page.getByRole('button', { name: 'Back', exact: true });
    const forward = page.getByRole('button', { name: 'Forward', exact: true });
    const startUrl = page.url();
    assert.match(await back.getAttribute('title'), /Alt\+←/);
    assert.match(await forward.getAttribute('title'), /Alt\+→/);
    assert.ok(await back.isDisabled(), 'nowhere to go back to yet');
    assert.ok(await forward.isDisabled(), 'nowhere to go forward to yet');

    // Page A, then page B by its link.
    await openPage(page, 'Alder');
    await page.locator('.ProseMirror a[data-wiki-target="Birch"]').click();
    await waitForTabs(page, ['Birch']);
    assert.ok(await forward.isDisabled());

    // The buttons.
    await back.click();
    await waitForTabs(page, ['Alder']);
    assert.ok(await forward.isEnabled());
    await forward.click();
    await waitForTabs(page, ['Birch']);
    assert.ok(await forward.isDisabled());

    // The mouse's side buttons, which must not move the web view itself.
    const sideButton = (button) =>
      page.locator('[data-pane-id="main"] .content').evaluate((el, button) => {
        const prevented = ['mousedown', 'mouseup', 'auxclick'].map((type) => {
          const event = new MouseEvent(type, { button, buttons: 0, bubbles: true, cancelable: true, view: window });
          el.dispatchEvent(event);
          return event.defaultPrevented;
        });
        return prevented.every(Boolean);
      }, button);
    assert.ok(await sideButton(3), 'the web view does not go back on its own');
    await waitForTabs(page, ['Alder']);
    assert.ok(await sideButton(4));
    await waitForTabs(page, ['Birch']);
    assert.equal(page.url(), startUrl);

    // The keyboard.
    await page.keyboard.press('Alt+ArrowLeft');
    await waitForTabs(page, ['Alder']);
    await page.keyboard.press('Alt+ArrowRight');
    await waitForTabs(page, ['Birch']);

    // Right-click lists recent pages by title, nearest first, to jump to one.
    await back.click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Go back to' });
    await menu.waitFor();
    assert.deepEqual(await menu.getByRole('menuitem').allInnerTexts(), ['Alder', 'Main page']);
    await app.screenshot('nav-history-menu');
    await menu.getByRole('menuitem', { name: 'Main page' }).click();
    await waitForTabs(page, ['Main page']);
    assert.ok(await back.isDisabled());
    await forward.click({ button: 'right' });
    const ahead = page.getByRole('menu', { name: 'Go forward to' });
    assert.deepEqual(await ahead.getByRole('menuitem').allInnerTexts(), ['Alder', 'Birch']);
    await ahead.getByRole('menuitem', { name: 'Birch' }).click();
    await waitForTabs(page, ['Birch']);
    assert.ok(await forward.isDisabled());

    // A red link makes its page, and Back still leads to where it was followed from.
    await page.locator('.ProseMirror a[data-wiki-target="Cedar"]').click();
    await waitForTabs(page, ['Cedar']);
    await back.click();
    await waitForTabs(page, ['Birch']);
    await forward.click();
    await waitForTabs(page, ['Cedar']);

    // The palette, the sidebar and search results all leave history behind them.
    await page.keyboard.press('Control+k');
    const input = page.getByPlaceholder('Search pages and commands…');
    await waitUntil(() => input.evaluate((el) => el === document.activeElement), 2000, 'the palette to open');
    await input.fill('Alder');
    await page.getByRole('option', { name: 'Alder' }).first().waitFor();
    await page.keyboard.press('Enter');
    await waitForTabs(page, ['Alder']);
    await page.getByRole('navigation', { name: 'Wiki' }).getByRole('button', { name: 'Recent changes' }).click();
    await waitForTabs(page, ['Recent changes']);
    await page.locator('.top-search-input').fill('wood');
    await page.locator('.top-search-input').press('Enter');
    await waitForTabs(page, ['Search: wood']);
    await page.locator('[data-pane-id="main"] .content a[data-wiki-target="Alder"]').first().click();
    await waitForTabs(page, ['Alder']);
    for (const name of ['Search: wood', 'Recent changes', 'Alder', 'Cedar']) {
      await back.click();
      await waitForTabs(page, [name]);
    }

    // With two panes, the buttons follow the focused one.
    await page.keyboard.press('Control+\\');
    // Beside a wiki page, the new pane opens on the book.
    await tab(page, 'Write', 'side').waitFor();
    await waitUntil(() => back.isDisabled(), 2000, 'Back to follow the new pane');
    await pane(page, 'main').locator('.content').click({ position: { x: 4, y: 4 } });
    await waitUntil(() => back.isEnabled(), 2000, 'Back to follow the first pane');
    await back.click();
    await waitForTabs(page, ['Birch']);
    const sideTabs = await tabNames(page, 'side');
    assert.equal(sideTabs.length, 1);
    assert.ok(!['Birch', 'Cedar'].includes(sideTabs[0]), `the second pane stays on the book, not ${sideTabs[0]}`);
    assert.deepEqual(problems, []);
  });

  it('writes a scene with a wiki page open beside it', async () => {
    const page = await start();
    const elara = await rpc(page, 'pages.create', { title: 'Elara', pageType: 'character', status: 'canon', summary: 'A wandering scribe.', content: paragraphs('She keeps the old maps.') });
    const { scene } = await firstScene(page);

    await page.getByRole('button', { name: 'Write', exact: true }).click();
    await page.locator(EDITABLE).waitFor();
    assert.ok(await page.locator('.binder-tree').isVisible(), 'the sidebar shows the book');

    // The command opens a second pane, with the focus in it, ready to look something up.
    await page.keyboard.press('Control+\\');
    await tab(page, 'Main page', 'side').waitFor();
    await openPage(page, 'Elara');
    await pane(page, 'side').getByText('She keeps the old maps.').waitFor();
    await waitForTabs(page, ['Scene 1']);
    await waitForTabs(page, ['Elara'], 'side');
    assert.equal(await page.locator('.binder-tree').count(), 0, 'the sidebar follows the focused pane');

    // Clicking in the scene moves back to it, and typing goes there with the page still showing.
    await page.locator(EDITABLE).click();
    await page.locator('.binder-tree').waitFor();
    await page.keyboard.type('Elara unrolled the map. ');
    await waitUntil(async () => (await storedScene(page, scene.id)).includes('Elara unrolled the map.'), 5000, 'the scene to be stored');
    await pane(page, 'side').getByText('She keeps the old maps.').waitFor();
    assert.equal(await page.locator(EDITABLE).count(), 1);
    await app.screenshot('tabs-split');

    // The status bar and the commands act on the focused pane.
    await waitUntil(async () => /in scene/.test(await page.locator('[data-status="write.words"]').innerText()), 3000, 'the scene count');
    await pane(page, 'side').locator('h1.wiki-title').click();
    await page.locator('[data-status="wiki-words"]').waitFor();
    await page.keyboard.press('Control+e');
    await pane(page, 'side').locator(EDITABLE).waitFor();
    await waitForTabs(page, ['Elara'], 'side');
    await page.keyboard.press('Control+e');
    await waitUntil(async () => (await pane(page, 'side').locator(EDITABLE).count()) === 0, 3000, 'the page to go back to reading');

    // So does the AI: "this scene" means the focused pane's document, or there is none.
    const canContinue = async () => {
      await page.keyboard.press('Control+k');
      const input = page.getByPlaceholder('Search pages and commands…');
      await waitUntil(() => input.evaluate((el) => el === document.activeElement), 2000, 'the palette to open');
      await page.waitForTimeout(30);
      await input.fill('Continue writing');
      await page.waitForTimeout(100);
      const offered = (await page.getByRole('option', { name: 'Continue writing' }).count()) > 0;
      await page.keyboard.press('Escape');
      await input.waitFor({ state: 'detached' });
      return offered;
    };
    assert.equal(await canContinue(), false, 'not with the article in use');
    await pane(page, 'main').locator(EDITABLE).click();
    assert.equal(await canContinue(), true, 'with the scene in use');
    await pane(page, 'side').locator('h1.wiki-title').click();

    // Both panes keep working with the AI pane open too.
    await page.keyboard.press('Control+Shift+A');
    await page.getByRole('complementary', { name: 'AI assistant' }).waitFor();
    const widths = await page.evaluate(() => ({
      main: document.querySelector('[data-pane-id="main"]').getBoundingClientRect().width,
      side: document.querySelector('[data-pane-id="side"]').getBoundingClientRect().width,
      pageWidth: document.documentElement.scrollWidth,
      window: window.innerWidth,
    }));
    assert.ok(widths.main > 0 && widths.side > 0, `both panes have room: ${JSON.stringify(widths)}`);
    assert.ok(widths.pageWidth <= widths.window, 'no sideways scroll');
    await app.screenshot('tabs-split-ai');
    await page.keyboard.press('Control+Shift+A');

    // The divider moves with the mouse and the keyboard.
    const before = await pane(page, 'main').boundingBox();
    const divider = page.getByRole('separator', { name: 'Resize the two panes' });
    const box = await divider.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x - 100, box.y + 100, { steps: 5 });
    await page.mouse.up();
    const after = await pane(page, 'main').boundingBox();
    assert.ok(after.width < before.width - 50, 'the first pane got narrower');
    await divider.focus();
    await page.keyboard.press('ArrowRight');
    await waitUntil(async () => (await pane(page, 'main').boundingBox()).width > after.width, 2000, 'the keyboard to move it');

    // On a narrow window one pane sits above the other.
    const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    await page.setViewportSize({ width: 900, height: 700 });
    await waitUntil(async () => {
      const [a, b] = [await pane(page, 'main').boundingBox(), await pane(page, 'side').boundingBox()];
      return b.y > a.y + 100 && Math.abs(a.x - b.x) < 2;
    }, 3000, 'the panes to stack');
    await app.screenshot('tabs-split-narrow');
    await page.setViewportSize(size);

    // Focus mode shows only the page being written, even if the article was the one in use.
    await pane(page, 'side').locator('h1.wiki-title').click();
    await page.keyboard.press('F11');
    await page.locator('.topbar').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.doc-tabbar').first().isVisible(), false);
    assert.equal(await pane(page, 'side').isVisible(), false);
    await pane(page, 'main').locator(EDITABLE).waitFor();
    await waitUntil(() => page.evaluate(() => document.activeElement?.matches('[data-pane-id="main"] .ProseMirror')), 2000, 'the scene to have the keyboard');
    await page.keyboard.press('Control+End');
    await page.keyboard.type('Still typing.');
    await waitUntil(async () => (await storedScene(page, scene.id)).includes('Still typing.'), 5000, 'the typing to be stored');
    await page.keyboard.press('Escape');
    await page.locator('.topbar').waitFor();
    await pane(page, 'side').getByText('She keeps the old maps.').waitFor();
    await waitForTabs(page, ['Elara'], 'side');

    // A name in the manuscript opens beside the scene, and the writer keeps their place.
    await pane(page, 'side').locator('.doc-tab').click({ button: 'middle' });
    await pane(page, 'side').waitFor({ state: 'detached' });
    await page.locator('.name-mention').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Open beside' }).click();
    await pane(page, 'side').getByRole('heading', { name: 'Elara', exact: true }).waitFor();
    await page.locator('.binder-tree').waitFor();
    await waitUntil(() => page.evaluate(() => document.activeElement?.matches('[data-pane-id="main"] .ProseMirror')), 2000, 'the scene to keep the keyboard');
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' Typed after opening.');
    await waitUntil(async () => (await storedScene(page, scene.id)).includes('Typed after opening.'), 5000, 'the typing to go on');

    // Writing never moved the page beside, and links there open there.
    await pane(page, 'side').locator('.wiki-footer a', { hasText: 'Scene 1' }).click({ modifiers: ['Control'] });
    await waitForTabs(page, ['Elara', 'Scene 1'], 'side');
    await pane(page, 'side').locator('.doc-copy-note').waitFor();
    await page.keyboard.press('Control+w');
    await waitForTabs(page, ['Elara'], 'side');
    await pane(page, 'main').locator(EDITABLE).click();

    // "Open beside" on a tab moves it across, so the document is not open twice.
    await page.keyboard.press('Control+\\');
    await waitForTabs(page, ['Scene 1', 'Elara']);
    await tab(page, 'Elara').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Open beside' }).click();
    await waitForTabs(page, ['Scene 1']);
    await waitForTabs(page, ['Elara'], 'side');
    assert.ok(elara.id);

    // A tab can be dragged across too, and then back.
    await page.keyboard.press('Control+t');
    await waitForTabs(page, ['Elara', 'Main page'], 'side');
    const dragged = await tab(page, 'Main page', 'side').boundingBox();
    const into = await tab(page, 'Scene 1').boundingBox();
    await page.mouse.move(dragged.x + dragged.width / 2, dragged.y + dragged.height / 2);
    await page.mouse.down();
    await page.mouse.move(dragged.x - 20, dragged.y + dragged.height / 2, { steps: 3 });
    await page.mouse.move(into.x + into.width - 2, into.y + into.height / 2, { steps: 8 });
    await page.mouse.up();
    await waitForTabs(page, ['Scene 1', 'Main page']);
    await waitForTabs(page, ['Elara'], 'side');

    // The keyboard can get to the other pane, and back to the scene.
    await tab(page, 'Scene 1').click();
    await pane(page, 'main').locator(EDITABLE).waitFor();
    await pane(page, 'main').locator(EDITABLE).click();
    await page.keyboard.press('Control+Shift+|');
    await waitUntil(() => pane(page, 'side').evaluate((el) => el.classList.contains('is-focused')), 2000, 'the other pane to be in use');
    await page.keyboard.press('Control+Shift+|');
    await waitUntil(() => page.evaluate(() => document.activeElement?.matches('[data-pane-id="main"] .ProseMirror')), 2000, 'the scene to have the keyboard');
    assert.deepEqual(problems, []);
  });

  it('never lets two panes overwrite the same document', async () => {
    const page = await start();
    const elara = await rpc(page, 'pages.create', { title: 'Elara', pageType: 'character', status: 'canon', content: paragraphs('First words.') });
    const { scene } = await firstScene(page);

    // A scene in both panes: the second is a read-only copy that follows the first.
    await page.getByRole('button', { name: 'Write', exact: true }).click();
    await page.locator(EDITABLE).waitFor();
    await page.keyboard.press('Control+\\');
    await tab(page, 'Main page', 'side').waitFor();
    await page.getByRole('button', { name: 'Write', exact: true }).click();
    const sideNote = pane(page, 'side').locator('.doc-copy-note');
    await sideNote.waitFor();
    assert.match(await sideNote.innerText(), /being edited in the other pane/);
    assert.equal(await page.locator(EDITABLE).count(), 1);
    assert.equal(await pane(page, 'main').locator(EDITABLE).count(), 1);
    await app.screenshot('tabs-same-scene');

    await pane(page, 'main').locator(EDITABLE).click();
    await page.keyboard.type('Typed in the first pane. ');
    await pane(page, 'side').getByText('Typed in the first pane.').waitFor();

    // Asking to edit in the second pane swaps them, after the first has saved.
    await page.keyboard.type('More before the swap. ');
    await sideNote.getByRole('button', { name: 'Edit here' }).click();
    await pane(page, 'side').locator(EDITABLE).waitFor();
    await pane(page, 'main').locator('.doc-copy-note').waitFor();
    await pane(page, 'side').getByText('More before the swap.').waitFor();
    await pane(page, 'side').locator(EDITABLE).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('Typed in the second pane.');
    await pane(page, 'main').getByText('Typed in the second pane.').waitFor();
    await waitUntil(async () => {
      const stored = await storedScene(page, scene.id);
      return ['Typed in the first pane.', 'More before the swap.', 'Typed in the second pane.'].every((t) => stored.includes(t));
    }, 5000, 'all of the text to be stored');

    // Closing one copy hands the document to the other.
    await pane(page, 'side').getByRole('button', { name: 'Close the second pane' }).click();
    await pane(page, 'main').locator(EDITABLE).waitFor();
    await pane(page, 'main').locator(EDITABLE).getByText('Typed in the second pane.').waitFor();

    // The same with a wiki page: one edits, and the other reads along.
    await openPage(page, 'Elara');
    await page.keyboard.press('Control+\\');
    await waitForTabs(page, ['Elara']);
    const write = pane(page, 'side');
    await write.waitFor();
    await openPage(page, 'Elara');
    await pane(page, 'main').getByRole('button', { name: 'Edit', exact: true }).click();
    await pane(page, 'main').locator(EDITABLE).waitFor();
    const pageNote = pane(page, 'side').locator('.doc-copy-note');
    await pageNote.waitFor();
    assert.equal(await pane(page, 'side').locator(EDITABLE).count(), 0);
    await pane(page, 'main').locator(EDITABLE).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' Added beside the copy.');
    await pane(page, 'side').getByText('Added beside the copy.').waitFor();

    // The copy cannot be made to edit behind the other's back.
    await pane(page, 'side').getByRole('button', { name: 'Edit', exact: true }).click();
    await page.waitForTimeout(200);
    assert.equal(await pane(page, 'side').locator(EDITABLE).count(), 0);

    await pageNote.getByRole('button', { name: 'Edit here' }).click();
    await pane(page, 'side').locator(EDITABLE).waitFor();
    await pane(page, 'main').locator('.doc-copy-note').waitFor();
    await pane(page, 'side').locator(EDITABLE).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' And more from the other side.');
    await pane(page, 'main').getByText('And more from the other side.').waitFor();
    await waitUntil(async () => {
      const stored = await storedPage(page, elara.id);
      return ['First words.', 'Added beside the copy.', 'And more from the other side.'].every((t) => stored.includes(t));
    }, 5000, 'all of the page to be stored');
    assert.deepEqual(problems, []);
  });

  it('keeps two books side by side without mixing them up', async () => {
    const page = await start();
    const { book: first, scene: firstScene1 } = await firstScene(page);
    const second = await rpc(page, 'books.create', { title: 'The Second Book' });
    const chapter = await rpc(page, 'nodes.create', { bookId: second.id, parentId: null, kind: 'chapter', title: 'Chapter A' });
    const scene2 = await rpc(page, 'nodes.create', { bookId: second.id, parentId: chapter.id, kind: 'scene', title: 'Far Scene' });
    await rpc(page, 'nodes.update', { id: scene2.id, patch: { content: paragraphs('Words from the second book.') } });

    await page.getByRole('button', { name: 'Write', exact: true }).click();
    await pane(page, 'main').locator(EDITABLE).waitFor();
    await pane(page, 'main').locator(EDITABLE).click();
    await page.keyboard.type('Words from the first book.');
    await waitUntil(async () => (await storedScene(page, firstScene1.id)).includes('Words from the first book.'), 5000, 'the first scene to be stored');

    // The second pane goes to the other book. The first has to wait, but shows its scene.
    await page.keyboard.press('Control+\\');
    await tab(page, 'Main page', 'side').waitFor();
    await page.getByRole('button', { name: 'Write', exact: true }).click();
    await page.getByRole('combobox', { name: 'Book' }).selectOption(second.id);
    await page.getByRole('treeitem', { name: /^Far Scene,/ }).click();
    await pane(page, 'side').locator(EDITABLE).getByText('Words from the second book.').waitFor();
    await pane(page, 'main').locator('.doc-copy-note', { hasText: 'another book' }).waitFor();
    await pane(page, 'main').getByText('Words from the first book.').waitFor();
    assert.equal(await page.locator(EDITABLE).count(), 1);
    await app.screenshot('tabs-two-books');

    await pane(page, 'side').locator(EDITABLE).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' And more of them.');
    await waitUntil(async () => (await storedScene(page, scene2.id)).includes('And more of them.'), 5000, 'the second scene to be stored');

    // Clicking in the first pane brings its book back, with nothing lost, and swaps them over.
    await pane(page, 'main').locator('.doc-copy-note').click();
    await pane(page, 'main').locator(EDITABLE).getByText('Words from the first book.').waitFor();
    await pane(page, 'side').locator('.doc-copy-note', { hasText: 'another book' }).waitFor();
    await pane(page, 'side').getByText('And more of them.').waitFor();
    await waitForTabs(page, ['Scene 1']);
    await waitForTabs(page, ['Far Scene'], 'side');
    const options = await page.getByRole('combobox', { name: 'Book' }).inputValue();
    assert.equal(options, first.id);

    await pane(page, 'main').locator(EDITABLE).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' Still here.');
    await waitUntil(async () => (await storedScene(page, firstScene1.id)).includes('Still here.'), 5000, 'the typing to be stored');
    assert.ok(!(await storedScene(page, firstScene1.id)).includes('second book'));
    assert.ok(!(await storedScene(page, scene2.id)).includes('first book'));
    assert.deepEqual(problems, []);
  });

  it('reopens the last project with its tabs, panes and places', async () => {
    let page = await start('Reopen World');
    const path = workspace.file('reopen.lorecraft');
    await allowPath(page, path);
    await rpc(page, 'project.saveAs', { path });
    const atlas = await rpc(page, 'pages.create', { title: 'Atlas', status: 'canon', content: longDoc('Atlas') });
    await rpc(page, 'pages.create', { title: 'Elara', status: 'canon', content: paragraphs('She keeps the old maps.') });
    const gone = await rpc(page, 'pages.create', { title: 'Soon Deleted', status: 'canon', content: paragraphs('Not for long.') });
    const { scene } = await firstScene(page);
    await rpc(page, 'nodes.update', { id: scene.id, patch: { content: longDoc('Scene') } });

    // Three tabs in the first pane, one in the second.
    await openPage(page, 'Atlas');
    await page.keyboard.press('Control+t');
    await openPage(page, 'Soon Deleted');
    await page.keyboard.press('Control+t');
    await page.getByRole('button', { name: 'Write', exact: true }).click();
    await page.locator(EDITABLE).waitFor();
    await waitForTabs(page, ['Atlas', 'Soon Deleted', 'Scene 1']);
    await page.keyboard.press('Control+\\');
    await tab(page, 'Main page', 'side').waitFor();
    await openPage(page, 'Elara');

    // A place partway down the scene, with the cursor in view.
    const scroller = pane(page, 'main').locator('.write-scroll');
    await scroller.evaluate((el) => {
      el.scrollTop = 1500;
    });
    await page.waitForTimeout(100);
    const target = await pane(page, 'main').locator('.ProseMirror p', { hasText: 'Scene paragraph number 40,' }).first();
    await target.scrollIntoViewIfNeeded();
    await target.click({ position: { x: 10, y: 5 } });
    await page.keyboard.press('Home');
    const sceneScroll = await scroller.evaluate((el) => el.scrollTop);
    assert.ok(sceneScroll > 300, `the scene is scrolled: ${sceneScroll}`);

    // A place partway down the article.
    await tab(page, 'Atlas').click();
    await pane(page, 'main').getByText('Atlas paragraph number 0,').waitFor();
    const article = pane(page, 'main').locator('.content');
    await article.evaluate((el) => {
      el.scrollTop = 1200;
    });
    const articleScroll = await article.evaluate((el) => el.scrollTop);
    assert.ok(articleScroll > 300, `the article is scrolled: ${articleScroll}`);

    // The tab scene stays where it was while another tab is in front.
    await tab(page, 'Scene 1').click();
    await pane(page, 'main').locator(EDITABLE).waitFor();
    await waitUntil(async () => Math.abs((await scroller.evaluate((el) => el.scrollTop)) - sceneScroll) < 3, 3000, 'the scene to come back to its place');
    await tab(page, 'Atlas').click();
    await waitUntil(async () => Math.abs((await article.evaluate((el) => el.scrollTop)) - articleScroll) < 3, 3000, 'the article to come back to its place');
    await tab(page, 'Scene 1').click();
    await pane(page, 'main').locator(EDITABLE).waitFor();
    await page.locator('.top-search-input').click();
    await pane(page, 'main').locator('.write-page h1, .write-page textarea').first().waitFor();

    // A page deleted before the next start is no cause for complaint.
    await rpc(page, 'pages.delete', { id: gone.id });
    await page.keyboard.press('Control+s');
    await waitForSaveState(page, /All changes saved/);
    await page.waitForTimeout(REMEMBER_MS);
    await exitApp(app);

    page = await launchWatched();
    await page.locator('.topbar').waitFor();
    await waitForTabs(page, ['Atlas', 'Scene 1']);
    await waitForTabs(page, ['Elara'], 'side');
    assert.equal(await page.getByRole('heading', { name: 'Recover your work?' }).count(), 0);
    assert.equal(await tab(page, 'Scene 1').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('.toast').count(), 0, 'nothing to complain about');

    // The scene, scrolled as it was, with the cursor where it was, ready to carry on.
    const scene2 = pane(page, 'main').locator('.write-scroll');
    await pane(page, 'main').locator(EDITABLE).waitFor();
    await waitUntil(async () => Math.abs((await scene2.evaluate((el) => el.scrollTop)) - sceneScroll) < 3, 5000, 'the scene to be scrolled as it was');
    await pane(page, 'side').getByText('She keeps the old maps.').waitFor();

    // Coming back does not count as a change to the project.
    await page.waitForTimeout(REMEMBER_MS);
    await waitForSaveState(page, /All changes saved/);

    await page.keyboard.type('HERE');
    await waitUntil(async () => (await storedScene(page, scene.id)).includes('HEREScene paragraph number 40,'), 5000, 'typing to land where the cursor was');
    await page.keyboard.press('Control+z');

    // Back still works in a tab that came back.
    await page.keyboard.press('Alt+ArrowLeft');
    await waitForTabs(page, ['Atlas', 'Main page']);
    await page.keyboard.press('Alt+ArrowRight');
    await waitForTabs(page, ['Atlas', 'Scene 1']);
    await pane(page, 'main').locator(EDITABLE).waitFor();

    // The article, scrolled as it was.
    await tab(page, 'Atlas').click();
    const article2 = pane(page, 'main').locator('.content');
    await waitUntil(async () => Math.abs((await article2.evaluate((el) => el.scrollTop)) - articleScroll) < 3, 5000, 'the article to be scrolled as it was');
    assert.ok(atlas.id);
    await app.screenshot('tabs-reopened');
    assert.deepEqual(problems, []);

    await page.keyboard.press('Control+s');
    await waitForSaveState(page, /All changes saved/);
    await exitApp(app);

    // With the file gone there is simply nothing to reopen, and no one needs to be told.
    rmSync(path, { force: true });
    page = await launchWatched();
    await page.getByRole('button', { name: 'New project' }).waitFor();
    assert.equal(await page.locator('.topbar').count(), 0);
    assert.equal(await page.getByRole('heading', { name: 'Recover your work?' }).count(), 0);
    assert.equal(await page.locator('.toast').count(), 0, 'nothing to complain about');
    assert.deepEqual(problems, []);
  });

  it('puts off a recovery without opening anything else', async () => {
    const page = await start('Unsaved World');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.locator(EDITABLE).click();
    await page.keyboard.type('Words not saved to any file.');
    const home = await rpc(page, 'pages.home');
    await waitUntil(async () => (await storedPage(page, home.id)).includes('Words not saved to any file.'), 5000, 'the words to be stored');
    await app.kill();

    const again = await launchWatched();
    await again.getByRole('heading', { name: 'Recover your work?' }).waitFor();
    await again.getByRole('button', { name: 'Decide later' }).click();
    await again.getByRole('button', { name: 'New project' }).waitFor();
    assert.equal(await again.locator('.topbar').count(), 0);
    assert.deepEqual(problems, []);
  });

  it('leaves the project closed if it was closed on purpose, and can be turned off', async () => {
    let page = await start('Closed World');
    const path = workspace.file('closed.lorecraft');
    await allowPath(page, path);
    await rpc(page, 'project.saveAs', { path });
    await waitForSaveState(page, /All changes saved/);

    // Closing the project first means the next start is at the start screen.
    await page.getByRole('menuitem', { name: 'File' }).click();
    await page.getByRole('menuitem', { name: 'Close project' }).click();
    await page.getByRole('button', { name: 'New project' }).waitFor();
    await page.waitForTimeout(300);
    await exitApp(app);
    page = await launchWatched();
    await page.getByRole('button', { name: 'New project' }).waitFor();
    assert.equal(await page.locator('.topbar').count(), 0);

    // Opening it by hand brings it back as the one to reopen.
    await page.getByRole('button', { name: /^closed/ }).first().click();
    await page.locator('.topbar').waitFor();
    await page.waitForTimeout(300);
    await exitApp(app);
    page = await launchWatched();
    await page.locator('.topbar').waitFor();

    // And the setting turns all of this off.
    await page.keyboard.press('Control+,');
    await page.getByRole('tab', { name: 'Saving' }).click();
    const box = page.getByRole('checkbox', { name: /Reopen the last project/ });
    assert.equal(await box.isChecked(), true);
    await box.uncheck();
    await page.waitForTimeout(300);
    await exitApp(app);
    page = await launchWatched();
    await page.getByRole('button', { name: 'New project' }).waitFor();
    assert.equal(await page.locator('.topbar').count(), 0);
    assert.deepEqual(problems, []);
  });

  it('still offers recovery after a force-kill, and brings the tabs back with it', async () => {
    let page = await start('Crash World');
    const path = workspace.file('crash.lorecraft');
    await allowPath(page, path);
    await rpc(page, 'project.saveAs', { path });
    await rpc(page, 'pages.create', { title: 'Elara', status: 'canon', content: paragraphs('She keeps the old maps.') });
    const { scene } = await firstScene(page);

    await page.getByRole('button', { name: 'Write', exact: true }).click();
    await page.locator(EDITABLE).waitFor();
    await page.keyboard.press('Control+\\');
    await tab(page, 'Main page', 'side').waitFor();
    await openPage(page, 'Elara');
    await pane(page, 'main').locator(EDITABLE).click();
    const line = 'The horses came down from the pass at dusk';
    await page.keyboard.type(line);
    await waitUntil(async () => (await storedScene(page, scene.id)).includes(line), 5000, 'the line to be stored');
    await page.waitForTimeout(REMEMBER_MS);

    await app.kill();

    page = await launchWatched();
    await page.getByRole('heading', { name: 'Recover your work?' }).waitFor();
    await page.getByRole('button', { name: 'Recover' }).click();
    await page.locator('.topbar').waitFor();
    await pane(page, 'main').locator(EDITABLE).getByText(line).waitFor();
    await waitForTabs(page, ['Elara'], 'side');
    await waitForSaveState(page, /kept safe/);
    await app.screenshot('tabs-recovered');
    assert.deepEqual(problems, []);
  });
});
