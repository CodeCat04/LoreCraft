import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ARTIFACTS, createProject, createWorkspace, launch, rpc, waitUntil, slowLimit, SLOW } from './harness.mjs';

const EDITOR = '.ProseMirror[contenteditable="true"]';

function row(page, title) {
  return page.getByRole('treeitem', { name: new RegExp(`^${title},`) });
}

function statusWords(page) {
  return page.locator('[data-status="write.words"]').innerText();
}

/** Drags with real mouse events, the same ones a person's hand produces. */
async function drag(page, from, to, { fraction = 0.5, hold } = {}) {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 10, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height * fraction, { steps: 10 });
  // A move after arriving, because the drag only starts tracking partway through.
  await page.mouse.move(b.x + b.width / 2 + 1, b.y + b.height * fraction);
  if (hold) await hold();
  await page.mouse.up();
}

async function book(page) {
  const books = await rpc(page, 'books.list');
  return books[0];
}

async function tree(page, bookId) {
  const rows = await rpc(page, 'nodes.tree', { bookId });
  const byParent = (parent) => rows.filter((r) => r.parentId === parent).sort((x, y) => x.position - y.position);
  return { rows, byParent, find: (title) => rows.find((r) => r.title === title) };
}

/**
 * Runs a command from the palette. The palette clears itself just after it opens, so a
 * test has to wait for that or it would type faster than any hand and lose the text.
 */
async function runFromPalette(page, name) {
  await page.keyboard.press('Control+k');
  const input = page.getByPlaceholder('Search pages and commands…');
  await waitUntil(() => input.evaluate((el) => el === document.activeElement), 2000, 'the palette to open');
  await page.waitForTimeout(30);
  await input.fill(name);
  await page.getByRole('option', { name }).first().waitFor();
  await page.keyboard.press('Enter');
}

function paragraph(text) {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function docOf(...texts) {
  return { type: 'doc', content: texts.map(paragraph) };
}

async function storedText(page, id) {
  const node = await rpc(page, 'nodes.get', { id });
  return JSON.stringify(node.content);
}

function waitForStored(page, id, text, ms = 5000) {
  return waitUntil(async () => (await storedText(page, id)).includes(text), ms, `"${text}" to be stored`);
}

describe('write', () => {
  let workspace;
  let app;

  beforeEach(() => {
    workspace = createWorkspace();
  });

  afterEach(async (t) => {
    if (t.passed === false && app && !app.exited) await app.screenshot('write-last-failure').catch(() => {});
    if (app && !app.exited) await app.kill().catch(() => {});
    workspace.cleanup();
  });

  /** Launches, makes a project and opens the Write area. Fails on any page error. */
  async function start(name = 'Write World') {
    app = await launch(workspace);
    const page = app.page;
    const problems = [];
    page.on('pageerror', (e) => problems.push(e.message));
    app.problems = problems;
    await createProject(page, name);
    await page.getByRole('button', { name: 'Write', exact: true }).click();
    await page.locator(EDITOR).waitFor();
    return page;
  }

  it('creates a book and chapters, and counts words as they are written', async () => {
    const page = await start();
    const first = await book(page);

    // A new book, from the sidebar.
    await page.getByRole('button', { name: 'New book' }).click();
    await page.getByRole('textbox').last().fill('The Second Book');
    await page.getByRole('button', { name: 'Create' }).click();
    await page.getByRole('combobox', { name: 'Book' }).locator('option:checked', { hasText: 'The Second Book' }).waitFor({ state: 'attached' });
    const books = await rpc(page, 'books.list');
    assert.equal(books.length, 2);
    const second = books.find((b) => b.id !== first.id);
    await row(page, 'Chapter 1').waitFor();

    // A new chapter comes with a first scene, ready to write in.
    await page.getByRole('button', { name: '+ Chapter' }).click();
    await row(page, 'Chapter 2').waitFor();
    await page.getByRole('button', { name: '+ Scene' }).click();
    await waitUntil(async () => (await tree(page, second.id)).byParent(null).length === 2, 3000, 'two chapters');
    const built = await tree(page, second.id);
    const chapter2 = built.find('Chapter 2');
    await waitUntil(async () => (await tree(page, second.id)).byParent(chapter2.id).length === 2, 3000, 'two scenes');
    const scenes = (await tree(page, second.id)).byParent(chapter2.id);
    assert.deepEqual(scenes.map((s) => s.title), ['Scene 1', 'Scene 2']);

    // Writing updates the count on its own, and the totals up the tree.
    await page.locator(EDITOR).click();
    await page.keyboard.type('One two three four five');
    await waitUntil(async () => /5 words in scene · 5 in book/.test(await statusWords(page)), 2000, 'the count in the status bar');
    await waitForStored(page, scenes[1].id, 'three four');
    const chapterRow = row(page, 'Chapter 2');
    assert.match(await chapterRow.getAttribute('aria-label'), /5 words/);

    // The stored count agrees with the live one.
    assert.equal((await rpc(page, 'nodes.get', { id: scenes[1].id })).wordCount, 5);

    // A selection shows its own count.
    await page.keyboard.press('Shift+Control+ArrowLeft');
    await page.keyboard.press('Shift+Control+ArrowLeft');
    await waitUntil(async () => /2 words selected/.test(await statusWords(page)), 2000, 'the selection count');
    await page.keyboard.press('End');
    await waitUntil(async () => /5 words in scene/.test(await statusWords(page)), 2000, 'the count back');

    // Today's progress shows beside it.
    await waitUntil(
      async () => /Today 5 of 1,000 words/.test(await page.locator('[data-status="write.goal"]').innerText()),
      4000,
      'daily progress',
    );

    // Switching back to the first book.
    await page.getByRole('combobox', { name: 'Book' }).selectOption(first.id);
    await waitUntil(async () => (await row(page, 'Scene 2').count()) === 0, 3000, 'the other book');
    assert.deepEqual(app.problems, []);
    await app.screenshot('write-book-created');
  });

  it('drags a scene to another chapter with the mouse, and refuses invalid drops', async () => {
    const page = await start();
    const { id: bookId } = await book(page);
    const start_ = await tree(page, bookId);
    const c1 = start_.find('Chapter 1');
    const c2 = await rpc(page, 'nodes.create', { bookId, kind: 'chapter', title: 'Chapter 2' });
    await rpc(page, 'nodes.create', { bookId, parentId: c1.id, kind: 'scene', title: 'Second' });
    const third = await rpc(page, 'nodes.create', { bookId, parentId: c2.id, kind: 'scene', title: 'Third' });
    const part = await rpc(page, 'nodes.create', { bookId, kind: 'part', title: 'Part One' });
    await row(page, 'Third').waitFor();

    // Reordering within a chapter.
    await drag(page, row(page, 'Second'), row(page, 'Scene 1'), { fraction: 0.2 });
    await waitUntil(async () => (await tree(page, bookId)).byParent(c1.id)[0].title === 'Second', 3000, 'the reorder');

    // Into the other chapter, between nothing and Third.
    await drag(page, row(page, 'Second'), row(page, 'Third'), { fraction: 0.2 });
    await waitUntil(async () => (await tree(page, bookId)).byParent(c2.id).length === 2, 3000, 'the move');
    let now = await tree(page, bookId);
    assert.deepEqual(now.byParent(c2.id).map((n) => n.title), ['Second', 'Third']);
    assert.deepEqual(now.byParent(c1.id).map((n) => n.title), ['Scene 1']);

    // Dropping on a chapter's row puts it at the end of that chapter.
    await drag(page, row(page, 'Scene 1'), row(page, 'Chapter 2'));
    await waitUntil(async () => (await tree(page, bookId)).byParent(c2.id).length === 3, 3000, 'the move into a chapter');
    now = await tree(page, bookId);
    assert.deepEqual(now.byParent(c2.id).map((n) => n.title), ['Second', 'Third', 'Scene 1']);

    // A scene cannot sit in a part: the drop is shown as not allowed, and nothing happens.
    let sawRefusal = false;
    await drag(page, row(page, 'Third'), row(page, 'Part One'), {
      hold: async () => {
        await page.locator('.binder-drop-line.is-refused, .binder-drop-box.is-refused').waitFor({ timeout: 2000 });
        await page.locator('.binder-drag-reason').waitFor({ timeout: 2000 });
        sawRefusal = await page.evaluate(() => document.documentElement.classList.contains('write-drag-refused'));
        await app.screenshot('write-drag-refused');
      },
    });
    assert.ok(sawRefusal, 'the page says the drop is not allowed');
    await page.waitForTimeout(200);
    now = await tree(page, bookId);
    assert.equal(now.rows.find((n) => n.id === third.id).parentId, c2.id);
    assert.equal(now.byParent(part.id).length, 0);
    assert.equal(await page.locator('.toast-error').count(), 0, 'no failure message');
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('write-dragging')), false);

    // Escape calls off a drag, and letting go then does nothing.
    const beforeEscape = (await tree(page, bookId)).rows.map((n) => `${n.id}:${n.parentId}:${n.position}`).sort();
    await drag(page, row(page, 'Scene 1'), row(page, 'Third'), {
      fraction: 0.2,
      hold: async () => {
        await page.locator('.binder-drop-line').waitFor({ timeout: 2000 });
        await page.keyboard.press('Escape');
        await page.locator('.binder-drop-line').waitFor({ state: 'detached', timeout: 2000 });
      },
    });
    await page.waitForTimeout(150);
    const afterEscape = (await tree(page, bookId)).rows.map((n) => `${n.id}:${n.parentId}:${n.position}`).sort();
    assert.deepEqual(afterEscape, beforeEscape);

    // A closed chapter opens when a scene is held over it, and takes the drop.
    const extra = await rpc(page, 'nodes.create', { bookId, parentId: c1.id, kind: 'scene', title: 'Extra' });
    await row(page, 'Extra').waitFor();
    await row(page, 'Chapter 1').locator('.binder-twisty').click();
    await row(page, 'Extra').waitFor({ state: 'detached' });
    await drag(page, row(page, 'Third'), row(page, 'Chapter 1'), {
      hold: () => row(page, 'Extra').waitFor({ timeout: 2000 }),
    });
    await waitUntil(async () => (await tree(page, bookId)).byParent(c1.id).length === 2, 3000, 'the scene in the opened chapter');
    assert.equal((await tree(page, bookId)).byParent(c1.id)[0].id, extra.id);
    await rpc(page, 'nodes.move', { id: third.id, parentId: c2.id, index: 1 });
    await waitUntil(async () => (await tree(page, bookId)).byParent(c2.id)[1].id === third.id, 3000, 'the scene back');

    // A chapter can go into a part.
    await drag(page, row(page, 'Chapter 2'), row(page, 'Part One'));
    await waitUntil(async () => (await tree(page, bookId)).byParent(part.id).length === 1, 3000, 'the chapter in the part');

    // Closing a branch hides what is in it, and writing elsewhere does not reopen it.
    // The drag library ignores clicks for a moment after a drop.
    await page.waitForTimeout(100);
    await row(page, 'Part One').locator('.binder-twisty').click();
    await row(page, 'Chapter 2').waitFor({ state: 'detached' });
    assert.equal(await row(page, 'Part One').getAttribute('aria-expanded'), 'false');
    await row(page, 'Scene 1').waitFor({ state: 'detached' });
    await row(page, 'Part One').locator('.binder-twisty').click();
    await row(page, 'Chapter 2').waitFor();

    // The arrow keys close and open branches and move along the rows.
    await row(page, 'Chapter 2').focus();
    await page.keyboard.press('ArrowLeft');
    await row(page, 'Second').waitFor({ state: 'detached' });
    await page.keyboard.press('ArrowRight');
    await row(page, 'Second').waitFor();
    await page.keyboard.press('Home');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')?.split(',')[0]), 'Chapter 1');

    // Ctrl+Alt with the arrows goes to another scene, even from a row, and moves nothing.
    const beforeShortcut = (await tree(page, bookId)).rows.map((n) => `${n.id}:${n.parentId}:${n.position}`).sort();
    await row(page, 'Scene 1').click();
    await waitUntil(async () => (await page.getByLabel('Scene title').inputValue()) === 'Scene 1', 3000, 'the scene');
    await row(page, 'Scene 1').focus();
    await page.keyboard.press('Control+Alt+ArrowUp');
    await waitUntil(async () => (await page.getByLabel('Scene title').inputValue()) !== 'Scene 1', 3000, 'the previous scene');
    const afterShortcut = (await tree(page, bookId)).rows.map((n) => `${n.id}:${n.parentId}:${n.position}`).sort();
    assert.deepEqual(afterShortcut, beforeShortcut);
    await page.waitForTimeout(100);

    // Moving from the keyboard, and the same rules apply.
    await row(page, 'Part One').focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')?.split(',')[0]), 'Second');
    await page.keyboard.press('Alt+ArrowDown');
    await waitUntil(async () => (await tree(page, bookId)).byParent(c2.id)[1].title === 'Second', 3000, 'the keyboard move');
    assert.deepEqual(app.problems, []);
  });

  it('switches scenes without losing or mixing text', async () => {
    const page = await start();
    const { id: bookId } = await book(page);
    const first = await tree(page, bookId);
    const chapter = first.find('Chapter 1');
    const sceneA = first.find('Scene 1');
    const sceneB = await rpc(page, 'nodes.create', { bookId, parentId: chapter.id, kind: 'scene', title: 'Scene 2' });
    await row(page, 'Scene 2').waitFor();

    // Switching right after typing, well inside the save delay.
    await page.locator(EDITOR).click();
    await page.keyboard.type('Alpha text belongs to A.');
    await page.keyboard.press('Control+Alt+ArrowDown');
    await page.locator(`${EDITOR}`).getByText('Alpha text').waitFor({ state: 'detached' });
    await page.keyboard.type('Beta text belongs to B.');
    await page.keyboard.press('Control+Alt+ArrowUp');
    await page.locator(EDITOR).getByText('Alpha text belongs to A.').waitFor();
    assert.equal(await page.locator(EDITOR).getByText('Beta text').count(), 0);
    await page.keyboard.press('Control+Alt+ArrowDown');
    await page.locator(EDITOR).getByText('Beta text belongs to B.').waitFor();
    await page.keyboard.press('Control+Alt+ArrowUp');
    await page.locator(EDITOR).getByText('Alpha text belongs to A.').waitFor();

    await waitForStored(page, sceneA.id, 'Alpha text');
    await waitForStored(page, sceneB.id, 'Beta text');
    assert.ok(!(await storedText(page, sceneA.id)).includes('Beta'));
    assert.ok(!(await storedText(page, sceneB.id)).includes('Alpha'));

    // The cursor comes back where it was, ready to carry on.
    await page.keyboard.type(' More.');
    await waitForStored(page, sceneA.id, 'A. More.');

    // A long scene comes back scrolled where it was left.
    const long = Array.from({ length: 200 }, (_, i) => `Paragraph number ${i} of a long scene.`);
    await rpc(page, 'nodes.update', { id: sceneB.id, patch: { content: docOf(...long) } });
    await page.keyboard.press('Control+Alt+ArrowDown');
    await page.locator(EDITOR).getByText('Paragraph number 199').waitFor();
    const scroller = page.locator('.write-scroll');
    await scroller.evaluate((el) => {
      el.scrollTop = 1500;
    });
    await waitUntil(() => scroller.evaluate((el) => el.scrollTop === 1500), 1000, 'the scroll');
    await page.waitForTimeout(100);
    await page.keyboard.press('Control+Alt+ArrowUp');
    await page.locator(EDITOR).getByText('Alpha text').waitFor();
    await page.keyboard.press('Control+Alt+ArrowDown');
    await page.locator(EDITOR).getByText('Paragraph number 199').waitFor();
    await waitUntil(() => scroller.evaluate((el) => Math.abs(el.scrollTop - 1500) < 2), 2000, 'the scroll position to return');

    // Previous and next buttons work too.
    await page.getByRole('button', { name: 'Previous scene' }).click();
    await page.locator(EDITOR).getByText('Alpha text').waitFor();
    await page.getByRole('button', { name: 'Next scene' }).click();
    await page.locator(EDITOR).getByText('Paragraph number 199').waitFor();
    assert.deepEqual(app.problems, []);
  });

  it('keeps scene text through a force-close', async () => {
    const page = await start('Crash Book');
    const { id: bookId } = await book(page);
    const scene = (await tree(page, bookId)).find('Scene 1');
    const line = 'The horses came down from the pass at dusk';
    await page.locator(EDITOR).click();
    await page.keyboard.type(line);
    await page.getByLabel('Synopsis').fill('They arrive');
    await waitForStored(page, scene.id, line);
    await waitUntil(async () => (await rpc(page, 'nodes.get', { id: scene.id })).synopsis === 'They arrive', 3000, 'the synopsis');

    await app.kill();

    app = await launch(workspace);
    await app.page.getByRole('heading', { name: 'Recover your work?' }).waitFor();
    await app.page.getByRole('button', { name: 'Recover' }).click();
    await app.page.locator('.topbar').waitFor();
    await app.page.getByRole('button', { name: 'Write', exact: true }).click();
    await app.page.locator(EDITOR).getByText(line).waitFor();
    assert.equal(await app.page.getByLabel('Synopsis').inputValue(), 'They arrive');
  });

  it('goes in and out of focus mode', async () => {
    const page = await start();
    await page.locator(EDITOR).click();
    await page.keyboard.type('Before focus.');

    await page.keyboard.press('F11');
    await page.locator('.topbar').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.sidebar').count(), 0);
    assert.equal(await page.locator('.statusbar').count(), 0);
    assert.equal(await page.locator('.scene-details').count(), 0);
    assert.equal(await page.locator('.write-bar').count(), 0);
    assert.equal(await page.locator('.toolbar').count(), 0);
    await page.locator(EDITOR).getByText('Before focus.').waitFor();

    // The count stays hidden until the mouse moves, and then fades away again.
    const hud = page.getByTestId('focus-hud');
    assert.equal(await hud.evaluate((el) => el.classList.contains('is-visible')), false);
    await page.mouse.move(400, 300);
    await page.mouse.move(420, 320);
    await waitUntil(() => hud.evaluate((el) => el.classList.contains('is-visible')), 1000, 'the count to appear');
    await waitUntil(async () => /2 words/.test(await hud.innerText()), 1000, 'the count');
    await waitUntil(() => hud.evaluate((el) => !el.classList.contains('is-visible')), 4000, 'the count to fade');
    await app.screenshot('write-focus-mode');

    // Writing carries on with the same editor and the same undo history.
    await page.keyboard.type(' During focus.');
    await page.keyboard.press('Escape');
    await page.locator('.topbar').waitFor();
    await page.locator('.statusbar').waitFor();
    await page.locator(EDITOR).getByText('Before focus. During focus.').waitFor();
    await page.keyboard.type(' After.');
    await page.locator(EDITOR).getByText('Before focus. During focus. After.').waitFor();

    // The button and F11 both toggle it.
    await page.getByRole('button', { name: 'Focus', exact: true }).click();
    await page.locator('.topbar').waitFor({ state: 'detached' });
    await page.keyboard.press('F11');
    await page.locator('.topbar').waitFor();

    // Escape closes the palette first, and leaves focus mode alone.
    await page.keyboard.press('F11');
    await page.locator('.topbar').waitFor({ state: 'detached' });
    await page.keyboard.press('Control+k');
    await page.getByPlaceholder('Search pages and commands…').waitFor();
    await page.keyboard.press('Escape');
    await page.getByPlaceholder('Search pages and commands…').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.topbar').count(), 0);

    // Going to another screen brings the window back too.
    await runFromPalette(page, 'Main page');
    await page.locator('.topbar').waitFor();

    // F11 from another screen goes straight to the page.
    await page.keyboard.press('F11');
    await page.locator('.topbar').waitFor({ state: 'detached' });
    await page.locator(EDITOR).getByText('Before focus.').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.topbar').waitFor();
    assert.deepEqual(app.problems, []);
  });

  it('keeps what is entered in the details panel', async () => {
    const page = await start();
    const { id: bookId } = await book(page);
    const first = await tree(page, bookId);
    const scene = first.find('Scene 1');
    await rpc(page, 'nodes.create', { bookId, parentId: first.find('Chapter 1').id, kind: 'scene', title: 'Scene 2' });
    const aria = await rpc(page, 'pages.create', { title: 'Aria Vale', pageType: 'character', aliases: ['The Pale Queen'] });
    await rpc(page, 'pages.create', { title: 'Tomas Reed', pageType: 'character' });
    await rpc(page, 'pages.create', { title: 'Silver Keep', pageType: 'place' });
    await row(page, 'Scene 2').waitFor();

    await page.getByLabel('Status').selectOption('revised');
    await page.getByLabel('In-world date').fill('In the time of rain');
    await page.locator('.details-date-hint').waitFor();
    // Everyday dates can be put in order too.
    await page.getByLabel('In-world date').fill('Thursday, October 13, 2022');
    await page.locator('.details-date-hint').waitFor({ state: 'detached' });
    await page.getByLabel('In-world date').fill('In the time of rain');
    await page.locator('.details-date-hint').waitFor();
    await page.getByLabel('In-world date').fill('312-04-15');
    await page.locator('.details-date-hint').waitFor({ state: 'detached' });
    await page.getByLabel('Synopsis').fill('They meet at the ford.');
    await page.getByLabel('Target words').fill('1500');
    await page.getByLabel('Notes').fill('Check the river name.');

    // Point of view suggests character pages only, including by alias.
    const pov = page.getByRole('combobox', { name: 'Point of view' });
    await pov.click();
    await page.getByRole('option', { name: 'Tomas Reed' }).waitFor();
    assert.equal(await page.getByRole('option', { name: 'Silver Keep' }).count(), 0);
    await pov.fill('pale');
    await page.getByRole('option', { name: 'Aria Vale' }).waitFor();
    assert.equal(await page.getByRole('option', { name: 'Tomas Reed' }).count(), 0);
    await page.keyboard.press('Enter');
    assert.equal(await pov.inputValue(), 'Aria Vale');
    await app.screenshot('write-details');

    // Switching away flushes the fields, even inside the save delay.
    await page.keyboard.press('Control+Alt+ArrowDown');
    await waitUntil(async () => (await page.getByLabel('Scene title').inputValue()) === 'Scene 2', 3000, 'the next scene');
    assert.equal(await page.getByLabel('Synopsis').inputValue(), '');

    const stored = await rpc(page, 'nodes.get', { id: scene.id });
    assert.equal(stored.status, 'revised');
    assert.equal(stored.storyDate, '312-04-15');
    assert.equal(stored.synopsis, 'They meet at the ford.');
    assert.equal(stored.targetWords, 1500);
    assert.equal(stored.notes, 'Check the river name.');
    assert.equal(stored.povPageId, aria.id);

    await page.keyboard.press('Control+Alt+ArrowUp');
    await waitUntil(async () => (await page.getByLabel('Synopsis').inputValue()) === 'They meet at the ford.', 3000, 'the synopsis');
    assert.equal(await page.getByLabel('Status').inputValue(), 'revised');
    assert.equal(await page.getByLabel('Notes').inputValue(), 'Check the river name.');
    assert.equal(await pov.inputValue(), 'Aria Vale');

    // Notes are not part of the tree, and they survive the panel being put away.
    await page.getByLabel('Notes').fill('Newer notes.');
    await waitUntil(async () => (await rpc(page, 'nodes.get', { id: scene.id })).notes === 'Newer notes.', 3000, 'the notes to save');
    await page.getByRole('button', { name: 'Details', exact: true }).click();
    await page.locator('.scene-details').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Details', exact: true }).click();
    assert.equal(await page.getByLabel('Notes').inputValue(), 'Newer notes.');
    await page.getByLabel('Notes').pressSequentially(' And more.');
    await waitUntil(async () => (await rpc(page, 'nodes.get', { id: scene.id })).notes.includes('And more.'), 3000, 'the longer notes');
    const savedNotes = (await rpc(page, 'nodes.get', { id: scene.id })).notes;
    assert.ok(savedNotes.includes('Newer notes.'), savedNotes);
    assert.ok(!savedNotes.includes('river'), `the older notes stay gone: ${savedNotes}`);

    // Clearing the box clears the point of view.
    await pov.fill('');
    await page.getByLabel('Synopsis').click();
    await waitUntil(async () => (await rpc(page, 'nodes.get', { id: scene.id })).povPageId === null, 3000, 'the cleared point of view');

    // The panel can be put away, and it stays away.
    await page.getByRole('button', { name: 'Details', exact: true }).click();
    assert.equal(await page.locator('.scene-details').count(), 0);
    await page.keyboard.press('Control+Alt+ArrowDown');
    await waitUntil(async () => (await page.getByLabel('Scene title').inputValue()) === 'Scene 2', 3000, 'the next scene');
    assert.equal(await page.locator('.scene-details').count(), 0);
    assert.deepEqual(app.problems, []);
  });

  it('underlines known names, lists them, and follows them', async () => {
    const page = await start();
    const { id: bookId } = await book(page);
    const scene = (await tree(page, bookId)).find('Scene 1');
    const aria = await rpc(page, 'pages.create', { title: 'Aria Vale', aliases: ['Aria'], summary: 'A rider from the north.' });
    await rpc(page, 'pages.create', { title: 'Silver Keep' });
    await rpc(page, 'pages.create', { title: 'Will' });

    await page.locator(EDITOR).click();
    await page.keyboard.type('Aria rode to Silver Keep. Ariadne stayed, and she will. Aria Vale slept.');

    // Marked with the page's title, whichever name was used, and only whole, exact names.
    const mentions = page.locator(`${EDITOR} .name-mention`);
    await waitUntil(async () => (await mentions.count()) === 3, 3000, 'the names to be marked');
    const marked = await mentions.evaluateAll((els) => els.map((e) => [e.textContent, e.getAttribute('data-wiki-target')]));
    assert.deepEqual(marked, [
      ['Aria', 'Aria Vale'],
      ['Silver Keep', 'Silver Keep'],
      ['Aria Vale', 'Aria Vale'],
    ]);
    const underline = await mentions.first().evaluate((el) => getComputedStyle(el).textDecorationStyle);
    assert.equal(underline, 'dotted');

    // Typing around a name keeps the marks right.
    await page.keyboard.type(' Will came.');
    await waitUntil(async () => (await mentions.count()) === 4, 3000, 'a new name to be marked');

    // The list reads the stored mentions, so it follows saving.
    const list = page.locator('.details-mentions');
    await waitUntil(async () => /Aria Vale\s*2/.test(await list.innerText()), 5000, 'the mentions list');
    assert.match(await list.innerText(), /Silver Keep\s*1/);
    assert.match(await list.innerText(), /Will\s*1/);
    assert.equal(await list.getByRole('button', { name: 'Aria Vale' }).getAttribute('data-wiki-target'), 'Aria Vale');
    await app.screenshot('write-names');

    // A new page lights up right away, without a reload.
    await page.keyboard.type(' Ariadne again.');
    await rpc(page, 'pages.create', { title: 'Ariadne' });
    await waitUntil(async () => (await page.locator(`${EDITOR} .name-mention[data-wiki-target="Ariadne"]`).count()) === 2, 3000, 'the new name');

    // Ctrl+click follows a name. A plain click just places the cursor.
    await waitForStored(page, scene.id, 'Ariadne again');
    await mentions.first().click();
    assert.equal(await page.locator(EDITOR).count(), 1);
    await mentions.first().click({ modifiers: ['Control'] });
    await page.locator('.wiki-title', { hasText: 'Aria Vale' }).waitFor();
    assert.equal(await page.locator(EDITOR).count(), 0);
    assert.equal(aria.title, 'Aria Vale');

    // Back to the scene with the list, and from the list to a page.
    await page.getByRole('button', { name: 'Write', exact: true }).click();
    await page.locator(EDITOR).waitFor();
    await page.locator('.details-mentions').getByRole('button', { name: 'Silver Keep' }).click();
    await page.locator('.wiki-title', { hasText: 'Silver Keep' }).waitFor();

    // The setting turns the marks off, and back on.
    await page.getByRole('button', { name: 'Write', exact: true }).click();
    await page.locator(EDITOR).waitFor();
    await waitUntil(async () => (await mentions.count()) > 0, 2000, 'the marks');
    const lineOf = () => mentions.first().evaluate((el) => getComputedStyle(el).textDecorationLine);
    assert.equal(await lineOf(), 'underline');
    await runFromPalette(page, 'Underline page names');
    // The line goes, but the names stay marked so their hover cards still work.
    await waitUntil(async () => (await lineOf()) === 'none', 2000, 'the underline to go');
    assert.ok((await mentions.count()) > 0, 'names keep their hover cards');
    await mentions.first().hover();
    await page.getByRole('tooltip').waitFor();
    await page.mouse.move(0, 0);
    const settings = await rpc(page, 'settings.get');
    assert.equal(settings.editor.highlightNames, false);
    await runFromPalette(page, 'Underline page names');
    await waitUntil(async () => (await lineOf()) === 'underline', 2000, 'the underline to return');
    assert.deepEqual(app.problems, []);
  });

  it('reorders scenes on the corkboard', async () => {
    const page = await start();
    const { id: bookId } = await book(page);
    const first = await tree(page, bookId);
    const chapter = first.find('Chapter 1');
    await rpc(page, 'nodes.update', { id: first.find('Scene 1').id, patch: { synopsis: 'Where it starts.' } });
    await rpc(page, 'nodes.create', { bookId, parentId: chapter.id, kind: 'scene', title: 'Scene 2', status: 'final' });
    const c = await rpc(page, 'nodes.create', { bookId, parentId: chapter.id, kind: 'scene', title: 'Scene 3', status: 'idea' });
    const other = await rpc(page, 'nodes.create', { bookId, kind: 'chapter', title: 'Chapter 2' });
    await row(page, 'Chapter 2').waitFor();

    await page.getByRole('button', { name: 'Corkboard' }).click();
    const card = (title) => page.locator('.cork-card', { has: page.getByRole('heading', { name: title, exact: true }) });
    await card('Scene 1').waitFor();
    assert.match(await card('Scene 1').innerText(), /Where it starts\./);
    assert.match(await card('Scene 2').innerText(), /Final/);
    assert.match(await card('Scene 3').innerText(), /Idea/);

    // Drag the last card to the front, with the mouse. The left edge means "before".
    await drag(page, card('Scene 3'), card('Scene 1'), {
      fraction: 0.5,
      hold: async () => {
        // Over the middle of the card, which is its right half by a pixel.
        await page.locator('.cork-card.is-drop-after').waitFor({ timeout: 2000 });
        const box = await card('Scene 1').boundingBox();
        await page.mouse.move(box.x + 8, box.y + box.height / 2, { steps: 3 });
        await page.locator('.cork-card.is-drop-before').waitFor({ timeout: 2000 });
        await app.screenshot('write-corkboard-drag');
      },
    });
    await waitUntil(async () => (await tree(page, bookId)).byParent(chapter.id)[0].id === c.id, 3000, 'the card to move');
    const order = (await tree(page, bookId)).byParent(chapter.id).map((n) => n.title);
    assert.deepEqual(order, ['Scene 3', 'Scene 1', 'Scene 2']);
    const shown = await page.locator('.cork-card-title').allInnerTexts();
    assert.deepEqual(shown, ['Scene 3', 'Scene 1', 'Scene 2']);

    // From the whole book's board, a card can move to another chapter. (dnd-kit swallows
    // clicks for a moment after a drop, and a test gets here faster than a hand can.)
    await page.waitForTimeout(100);
    await page.getByRole('button', { name: 'Show whole book' }).click();
    const empty = page.locator(`[data-chapter-id="${other.id}"] .cork-add`);
    await empty.waitFor();
    await drag(page, card('Scene 2'), empty);
    await waitUntil(async () => (await tree(page, bookId)).byParent(other.id).length === 1, 3000, 'the card in the other chapter');

    // From the keyboard too.
    await card('Scene 1').focus();
    await page.keyboard.press('Alt+ArrowLeft');
    await waitUntil(async () => (await tree(page, bookId)).byParent(chapter.id)[0].title === 'Scene 1', 3000, 'the keyboard move');

    // Ctrl+Alt with the arrows is a different command, and moves no card.
    const beforeShortcut = (await tree(page, bookId)).rows.map((n) => `${n.id}:${n.parentId}:${n.position}`).sort();
    await card('Scene 1').focus();
    await page.keyboard.press('Control+Alt+ArrowDown');
    await page.locator(EDITOR).waitFor();
    assert.deepEqual((await tree(page, bookId)).rows.map((n) => `${n.id}:${n.parentId}:${n.position}`).sort(), beforeShortcut);
    await page.getByRole('button', { name: 'Corkboard' }).click();
    await card('Scene 1').waitFor();
    await page.getByRole('button', { name: 'Show whole book' }).click();
    await page.locator('.cork-section').nth(1).waitFor();
    await app.screenshot('write-corkboard');

    // Clicking a card opens the scene.
    await card('Scene 1').click();
    await page.locator(EDITOR).waitFor();
    assert.equal(await page.getByLabel('Scene title').inputValue(), 'Scene 1');
    assert.deepEqual(app.problems, []);
  });

  it('reads a whole chapter and clicks through to edit', async () => {
    const page = await start();
    const { id: bookId } = await book(page);
    const first = await tree(page, bookId);
    const chapter = first.find('Chapter 1');
    const sceneA = first.find('Scene 1');
    await rpc(page, 'nodes.update', { id: sceneA.id, patch: { content: docOf('First scene words.', 'And another line of them.') } });
    const sceneB = await rpc(page, 'nodes.create', { bookId, parentId: chapter.id, kind: 'scene', title: 'Scene 2', content: docOf('Second scene words.') });
    await row(page, 'Scene 2').waitFor();
    await rpc(page, 'pages.create', { title: 'Second' });

    await page.getByRole('button', { name: 'Chapter', exact: true }).click();
    const page1 = page.locator('.read-page');
    await page1.getByText('First scene words.').waitFor();
    await page1.getByText('Second scene words.').waitFor();
    assert.equal(await page.locator(EDITOR).count(), 0, 'read-only');
    await page.locator('.read-page .name-mention[data-wiki-target="Second"]').waitFor();
    await app.screenshot('write-readthrough');

    // Clicking the text opens that scene with the cursor there.
    const line = page1.getByText('Second scene words.');
    const box = await line.boundingBox();
    await page.mouse.click(box.x + 3, box.y + box.height / 2);
    await page.locator(EDITOR).getByText('Second scene words.').waitFor();
    assert.equal(await page.getByLabel('Scene title').inputValue(), 'Scene 2');
    await page.keyboard.type('X');
    await waitForStored(page, sceneB.id, 'XSecond');

    // Clicking a chapter in the sidebar reads it.
    await row(page, 'Chapter 1').click();
    await page.locator('.read-chapter-title', { hasText: 'Chapter 1' }).waitFor();
    await page.locator('.read-page').getByText('XSecond scene words.').waitFor();

    // A long chapter loads its scenes as they come near, holding space for the rest.
    const big = await rpc(page, 'nodes.create', { bookId, kind: 'chapter', title: 'Long chapter' });
    const text = 'One line of a scene that goes on for a while without saying very much at all. ';
    const scenes = [];
    for (let i = 0; i < 12; i += 1) {
      scenes.push(
        await rpc(page, 'nodes.create', {
          bookId,
          parentId: big.id,
          kind: 'scene',
          title: `Long ${i + 1}`,
          content: docOf(`Start of long scene ${i + 1}.`, ...Array.from({ length: 40 }, () => text)),
        }),
      );
    }
    await row(page, 'Long chapter').click();
    await page.locator('.read-chapter-title', { hasText: 'Long chapter' }).waitFor();
    await page.getByText('Start of long scene 1.').waitFor();
    const loadedAtFirst = await page.locator('.read-scene-text').count();
    assert.ok(loadedAtFirst < 12, `only ${loadedAtFirst} of 12 loaded at first`);
    const reader = page.locator('.write-scroll');
    for (let i = 0; i < 60 && (await page.locator('.read-scene-text').count()) < 12; i += 1) {
      await reader.evaluate((el) => {
        el.scrollTop += el.clientHeight;
      });
      await page.waitForTimeout(60);
    }
    assert.equal(await page.locator('.read-scene-text').count(), 12);
    await page.getByText('Start of long scene 12.').waitFor();

    // Selecting a scene starts the read-through at that scene.
    await page.getByRole('button', { name: 'Scene', exact: true }).click();
    await page.locator(EDITOR).waitFor();
    await row(page, 'Long 9').click();
    await waitUntil(async () => (await page.getByLabel('Scene title').inputValue()) === 'Long 9', 3000, 'the scene');
    await page.getByRole('button', { name: 'Chapter', exact: true }).click();
    const target = page.locator(`[data-scene-id="${scenes[8].id}"]`);
    await target.waitFor();
    await waitUntil(async () => {
      const box = await target.boundingBox();
      return box && box.y < 500;
    }, 2000, 'the read-through to start at the scene');
    assert.deepEqual(app.problems, []);
  });

  it('edits status and synopsis in the outline', async () => {
    const page = await start();
    const { id: bookId } = await book(page);
    const first = await tree(page, bookId);
    const scene = first.find('Scene 1');
    const aria = await rpc(page, 'pages.create', { title: 'Aria Vale', pageType: 'character' });
    await rpc(page, 'nodes.update', {
      id: scene.id,
      patch: { povPageId: aria.id, storyDate: '312-04-15', targetWords: 900, content: docOf('Four words right here.') },
    });

    await page.getByRole('button', { name: 'Outline' }).click();
    const line = page.locator(`[data-outline-id="${scene.id}"]`);
    await line.waitFor();
    await waitUntil(async () => /Aria Vale/.test(await line.innerText()), 3000, 'the change made elsewhere to show');
    const text = await line.innerText();
    assert.match(text, /312-04-15/);
    assert.match(text, /\b4\b/);
    assert.match(text, /900/);

    await line.getByRole('combobox', { name: /Status of/ }).selectOption('final');
    await waitUntil(async () => (await rpc(page, 'nodes.get', { id: scene.id })).status === 'final', 3000, 'the status');

    const synopsis = line.getByRole('textbox', { name: /Synopsis of/ });
    await synopsis.fill('A short synopsis.');
    await page.keyboard.press('Enter');
    await waitUntil(async () => (await rpc(page, 'nodes.get', { id: scene.id })).synopsis === 'A short synopsis.', 3000, 'the synopsis');
    await app.screenshot('write-outline');

    // The binder's marker follows the change.
    assert.match(await row(page, 'Scene 1').getAttribute('aria-label'), /final/);

    // The title opens the scene.
    await line.getByRole('button', { name: 'Scene 1' }).click();
    await page.locator(EDITOR).waitFor();
    assert.deepEqual(app.problems, []);
  });

  it('deletes with undo, restores from the trash, and renames inline', async () => {
    const page = await start();
    const { id: bookId } = await book(page);
    const first = await tree(page, bookId);
    const chapter = first.find('Chapter 1');
    const s1 = first.find('Scene 1');
    await rpc(page, 'nodes.update', { id: s1.id, patch: { content: docOf('Words in the first scene.') } });
    const s2 = await rpc(page, 'nodes.create', { bookId, parentId: chapter.id, kind: 'scene', title: 'Scene 2', content: docOf('Words in the second scene.') });
    const s3 = await rpc(page, 'nodes.create', { bookId, parentId: chapter.id, kind: 'scene', title: 'Scene 3' });
    await row(page, 'Scene 3').waitFor();

    // Rename: F2 on the focused row, Enter to finish.
    await row(page, 'Scene 3').focus();
    await page.keyboard.press('F2');
    await page.getByRole('textbox', { name: 'Rename scene' }).fill('The river');
    await page.keyboard.press('Enter');
    await row(page, 'The river').waitFor();
    assert.equal((await rpc(page, 'nodes.get', { id: s3.id })).title, 'The river');

    // Rename: double-click, Escape to back out.
    await row(page, 'The river').dblclick();
    await page.getByRole('textbox', { name: 'Rename scene' }).fill('Nope');
    await page.keyboard.press('Escape');
    await row(page, 'The river').waitFor();
    assert.equal((await rpc(page, 'nodes.get', { id: s3.id })).title, 'The river');

    // The title above the text and the binder are the same thing.
    await row(page, 'Scene 2').click();
    await page.locator(EDITOR).getByText('Words in the second').waitFor();
    await page.getByLabel('Scene title').fill('Renamed above');
    await row(page, 'Renamed above').waitFor();

    // Deleting the open scene moves on to the next one, with an undo.
    await row(page, 'Renamed above').focus();
    await page.keyboard.press('Delete');
    await page.locator('.binder-undo').getByText('Deleted “Renamed above”.').waitFor();
    await waitUntil(async () => (await page.getByLabel('Scene title').inputValue()) === 'The river', 3000, 'the next scene');
    assert.equal(await row(page, 'Renamed above').count(), 0);
    await app.screenshot('write-undo');
    await page.locator('.binder-undo').getByRole('button', { name: 'Undo' }).click();
    await row(page, 'Renamed above').waitFor();
    let order = (await tree(page, bookId)).byParent(chapter.id).map((n) => n.id);
    assert.deepEqual(order, [s1.id, s2.id, s3.id], 'back in the same place');
    assert.ok((await storedText(page, s2.id)).includes('Words in the second'));

    // Deleting an open branch from the keyboard leaves focus on a row, not in the air.
    const doomed = await rpc(page, 'nodes.create', { bookId, kind: 'chapter', title: 'Fleeting chapter' });
    await rpc(page, 'nodes.create', { bookId, parentId: doomed.id, kind: 'scene', title: 'Fleeting scene' });
    await rpc(page, 'nodes.create', { bookId, kind: 'chapter', title: 'Staying chapter' });
    await row(page, 'Staying chapter').waitFor();
    await row(page, 'Fleeting chapter').focus();
    await page.keyboard.press('Delete');
    await row(page, 'Fleeting chapter').waitFor({ state: 'detached' });
    await waitUntil(
      () => page.evaluate(() => document.activeElement?.getAttribute('aria-label')?.split(',')[0] === 'Staying chapter'),
      2000,
      'focus to land on the next row',
    );
    await page.locator('.binder-undo').getByRole('button', { name: 'Dismiss' }).click();
    await rpc(page, 'nodes.delete', { id: (await tree(page, bookId)).find('Staying chapter').id });
    await row(page, 'Staying chapter').waitFor({ state: 'detached' });

    // Deleting a chapter takes its scenes, and the trash can bring them back.
    await row(page, 'Chapter 1').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page.locator('.binder-undo').getByText('its 3 scenes').waitFor();
    assert.equal(await page.getByRole('treeitem').count(), 0);
    await page.locator('.write-empty', { hasText: 'Nothing written yet' }).or(page.locator('.write-empty', { hasText: 'No chapters' })).first().waitFor();

    // Empty book: the buttons still work.
    await page.locator('.binder-undo').getByRole('button', { name: 'Dismiss' }).click();
    await page.getByRole('button', { name: 'Trash', exact: true }).click();
    const item = page.locator('.trash-item', { hasText: 'Chapter 1' });
    await item.waitFor();
    assert.match(await item.innerText(), /with 3 more inside/);
    assert.equal(await page.locator('.trash-item', { hasText: 'The river' }).count(), 0, 'its scenes come back with it');
    await app.screenshot('write-trash');
    await item.getByRole('button', { name: 'Restore' }).click();
    await row(page, 'Chapter 1').waitFor();
    await row(page, 'The river').waitFor();
    order = (await tree(page, bookId)).byParent(chapter.id).map((n) => n.id);
    assert.deepEqual(order, [s1.id, s2.id, s3.id]);

    // A deleted book comes back from the trash too.
    await page.getByRole('button', { name: 'New book' }).click();
    await page.getByRole('textbox').last().fill('Doomed');
    await page.getByRole('button', { name: 'Create' }).click();
    await page.getByRole('combobox', { name: 'Book' }).locator('option:checked', { hasText: 'Doomed' }).waitFor({ state: 'attached' });
    await page.getByRole('button', { name: 'Book settings' }).click();
    await page.getByRole('button', { name: 'Delete book' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete book' }).click();
    await page.locator('.binder-undo').getByText('Deleted “Doomed”.').waitFor();
    assert.equal((await rpc(page, 'books.list')).length, 1);
    assert.equal((await rpc(page, 'books.trash')).length, 1);
    await page.getByRole('button', { name: 'Trash', exact: true }).click();
    await page.locator('.trash-item', { hasText: 'Doomed' }).getByRole('button', { name: 'Restore' }).click();
    await waitUntil(async () => (await rpc(page, 'books.list')).length === 2, 3000, 'the book to return');
    assert.deepEqual(app.problems, []);
  });

  it('deletes trashed items forever, after asking', async () => {
    const page = await start();
    const bookId = (await book(page)).id;
    const chapter = (await tree(page, bookId)).rows.find((r) => r.kind === 'chapter');
    const keep = await rpc(page, 'nodes.create', { bookId, parentId: chapter.id, kind: 'scene', title: 'Kept scene' });
    const one = await rpc(page, 'nodes.create', { bookId, parentId: chapter.id, kind: 'scene', title: 'Gone one' });
    const two = await rpc(page, 'nodes.create', { bookId, parentId: chapter.id, kind: 'scene', title: 'Gone two' });
    await rpc(page, 'nodes.update', { id: one.id, patch: { content: docOf('Saved words.') }, snapshot: 'manual' });
    await rpc(page, 'nodes.delete', { id: one.id });
    await rpc(page, 'nodes.delete', { id: two.id });
    await page.getByRole('button', { name: 'Trash', exact: true }).click();
    const item = page.locator('.trash-item', { hasText: 'Gone one' });
    await item.waitFor();

    // Saying no keeps it.
    await item.getByRole('button', { name: 'Delete Gone one forever' }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByText('This can’t be undone.', { exact: false }).waitFor();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    assert.equal((await rpc(page, 'nodes.trash', { bookId })).length, 2);

    await item.getByRole('button', { name: 'Delete Gone one forever' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete forever' }).click();
    await item.waitFor({ state: 'detached' });
    assert.equal((await rpc(page, 'revisions.list', { kind: 'node', id: one.id })).length, 0);

    await page.getByRole('button', { name: 'Empty trash' }).click();
    await page.getByRole('alertdialog').getByText('This can’t be undone.', { exact: false }).waitFor();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Empty trash' }).click();
    await page.getByText('Nothing has been deleted from this book.').waitFor();
    assert.equal((await rpc(page, 'nodes.trash', { bookId })).length, 0);
    assert.ok((await tree(page, bookId)).find(keep.title), 'live scenes stay');
    assert.deepEqual(app.problems, []);
  });

  it('reorders books by dragging and by command, and finds scenes in the palette', async () => {
    const page = await start();
    const first = await book(page);
    const second = await rpc(page, 'books.create', { title: 'Second Book' });
    const third = await rpc(page, 'books.create', { title: 'Third Book' });
    const tree3 = await tree(page, third.id);
    const scene = tree3.rows.find((r) => r.kind === 'scene');
    await rpc(page, 'nodes.update', { id: scene.id, patch: { title: 'Lighthouse night' } });
    const order = async () => (await rpc(page, 'books.list')).map((b) => b.id);

    await page.getByRole('button', { name: 'Arrange books' }).click();
    const list = page.getByRole('list', { name: 'Book order' });
    await list.waitFor();
    await list.getByRole('button', { name: 'Move Third Book up' }).click();
    await waitUntil(async () => (await order())[1] === third.id, 5000, 'the arrow to move it');
    assert.deepEqual(await order(), [first.id, third.id, second.id]);

    await drag(page, list.locator('[data-book="Third Book"] .binder-book-order-title'), list.locator(`[data-book="${first.title}"]`), { fraction: 0.2 });
    await waitUntil(async () => (await order())[0] === third.id, 5000, 'the dragged book to go first');
    assert.deepEqual(await order(), [third.id, first.id, second.id]);

    // The command moves the open book.
    await page.getByRole('combobox', { name: 'Book' }).selectOption(second.id);
    await runFromPalette(page, 'Move book up');
    await waitUntil(async () => (await order())[1] === second.id, 5000, 'the command to move it');
    assert.deepEqual(await order(), [third.id, second.id, first.id]);

    // Scenes are in the palette with their book and chapter, and open from there.
    await page.keyboard.press('Control+k');
    const input = page.getByPlaceholder('Search pages and commands…');
    await waitUntil(() => input.evaluate((el) => el === document.activeElement), 2000, 'the palette to open');
    await page.waitForTimeout(30);
    await input.fill('lighthouse');
    const option = page.getByRole('option', { name: /Third Book.*Lighthouse night/ });
    await option.waitFor();
    await page.keyboard.press('Enter');
    await page.getByRole('treeitem', { name: /Lighthouse night/, selected: true }).waitFor();
    assert.deepEqual(app.problems, []);
  });

  it('makes the next scene with Ctrl+Enter at the end, and a line break elsewhere', async () => {
    const page = await start();
    const { id: bookId } = await book(page);
    const first = await tree(page, bookId);
    const chapter = first.find('Chapter 1');
    const scene = first.find('Scene 1');
    const later = await rpc(page, 'nodes.create', { bookId, parentId: chapter.id, kind: 'scene', title: 'Later' });
    await row(page, 'Later').waitFor();

    await page.locator(EDITOR).click();
    await page.keyboard.type('The end of a scene');
    // In the middle, Ctrl+Enter keeps its usual meaning. (The wait lets the editor hear
    // of the cursor moving, which takes longer than a test takes to press the next key.)
    await page.keyboard.press('Home');
    await page.waitForTimeout(50);
    await page.keyboard.press('Control+Enter');
    await page.locator(`${EDITOR} br`).first().waitFor({ state: 'attached' });
    assert.equal((await tree(page, bookId)).byParent(chapter.id).length, 2);

    // At the end, it makes a new scene right after this one, and goes there.
    await page.keyboard.press('Control+End');
    await page.waitForTimeout(50);
    await page.keyboard.press('Control+Enter');
    await waitUntil(async () => (await page.getByLabel('Scene title').inputValue()) === 'Scene 3', 3000, 'the new scene');
    await page.keyboard.type('Straight into the new one');
    await waitUntil(async () => (await tree(page, bookId)).byParent(chapter.id).length === 3, 3000, 'three scenes');
    const order = (await tree(page, bookId)).byParent(chapter.id);
    assert.deepEqual(order.map((n) => n.title), ['Scene 1', 'Scene 3', 'Later']);
    assert.equal(order[2].id, later.id);
    await waitForStored(page, order[1].id, 'Straight into');
    await waitForStored(page, scene.id, 'The end of a scene');
    assert.ok(!(await storedText(page, scene.id)).includes('Straight'));

    // Holding the keys down makes one scene, not one per repeat.
    await page.waitForTimeout(50);
    await page.keyboard.down('Control');
    await page.keyboard.down('Enter');
    await waitUntil(async () => (await tree(page, bookId)).byParent(chapter.id).length === 4, 3000, 'the fourth scene');
    await waitUntil(async () => (await page.getByLabel('Scene title').inputValue()) === 'Scene 4', 3000, 'the fourth scene to open');
    for (let i = 0; i < 5; i += 1) {
      await page.keyboard.down('Enter');
      await page.waitForTimeout(30);
    }
    await page.keyboard.up('Enter');
    await page.keyboard.up('Control');
    await page.waitForTimeout(150);
    assert.equal((await tree(page, bookId)).byParent(chapter.id).length, 4);

    // Neither does a second press that lands before the first has finished.
    await page.keyboard.press('Control+Enter');
    await page.keyboard.press('Control+Enter');
    await waitUntil(async () => (await page.getByLabel('Scene title').inputValue()) === 'Scene 5', 3000, 'the fifth scene to open');
    await page.waitForTimeout(150);
    assert.equal((await tree(page, bookId)).byParent(chapter.id).length, 5);
    assert.deepEqual(app.problems, []);
  });

  it('copes with empty books, books of only parts, and very long titles', async () => {
    const page = await start();
    const { id: bookId } = await book(page);
    const first = await tree(page, bookId);

    // A book of only parts.
    await rpc(page, 'nodes.delete', { id: first.find('Chapter 1').id });
    await page.locator('.write-empty', { hasText: 'Nothing written yet' }).waitFor();
    assert.equal(await page.getByRole('treeitem').count(), 0);
    await page.getByRole('button', { name: '+ Part' }).click();
    await row(page, 'Part 1').waitFor();
    await page.locator('.write-empty').waitFor();
    assert.equal(await page.locator(EDITOR).count(), 0);
    await page.getByRole('button', { name: 'Outline' }).click();
    await page.locator('.outline-part').waitFor();
    await page.getByRole('button', { name: 'Chapter', exact: true }).click();
    await page.locator('.write-empty', { hasText: 'No chapters yet' }).waitFor();

    // Adding a scene to a book of only parts makes a chapter in the part to hold it.
    await page.getByRole('button', { name: 'Scene', exact: true }).click();
    await page.getByRole('button', { name: '+ Scene' }).click();
    await page.locator(EDITOR).waitFor();
    const built = await tree(page, bookId);
    const part = built.find('Part 1');
    assert.equal(built.byParent(part.id)[0].kind, 'chapter');
    assert.equal(built.byParent(built.byParent(part.id)[0].id)[0].kind, 'scene');

    // A very long title stays inside its lines everywhere.
    const long = `The Exceedingly Long Title ${'and so on '.repeat(40)}and one unbreakable ${'x'.repeat(300)}`;
    const scene = built.byParent(built.byParent(part.id)[0].id)[0];
    await page.getByLabel('Scene title').fill(long);
    await waitUntil(async () => (await rpc(page, 'nodes.get', { id: scene.id })).title === long, 3000, 'the title');
    const overflows = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.write-page, .binder, .cork-board, .outline, .scene-details, .write-bar')]
          .filter((el) => el.scrollWidth > el.clientWidth + 1)
          .map((el) => el.className),
      );
    assert.deepEqual(await overflows(), []);
    await app.screenshot('write-long-title');
    await page.getByRole('button', { name: 'Corkboard' }).click();
    await page.locator('.cork-card').waitFor();
    assert.deepEqual(await overflows(), []);
    await page.getByRole('button', { name: 'Outline' }).click();
    await page.locator('.outline-scene').waitFor();
    assert.deepEqual(await overflows(), []);
    await page.getByRole('button', { name: 'Chapter', exact: true }).click();
    await page.locator('.read-scene').waitFor();
    assert.deepEqual(await overflows(), []);

    // No books at all.
    await rpc(page, 'books.delete', { id: bookId });
    await page.locator('.write-empty', { hasText: 'No books yet' }).waitFor();
    await page.getByRole('button', { name: 'Add a book' }).click();
    await page.getByRole('textbox').last().fill('A fresh start');
    await page.getByRole('button', { name: 'Create' }).click();
    await page.locator(EDITOR).waitFor();
    assert.deepEqual(app.problems, []);
  });

  it('shows progress: stats, streak, goal and book settings', async () => {
    const page = await start();
    const { id: bookId } = await book(page);
    const scene = (await tree(page, bookId)).find('Scene 1');
    await rpc(page, 'nodes.update', { id: scene.id, patch: { content: docOf('One two three four five six seven eight nine ten.') } });

    await page.getByRole('button', { name: 'Book settings' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Title', { exact: true }).fill('Renamed Book');
    await dialog.getByLabel('Subtitle').fill('A subtitle');
    await dialog.getByLabel('Author').fill('A. Writer');
    await dialog.getByLabel('Target words').fill('100');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('combobox', { name: 'Book' }).locator('option:checked', { hasText: 'Renamed Book' }).waitFor({ state: 'attached' });
    const stored = await book(page);
    assert.equal(stored.subtitle, 'A subtitle');
    assert.equal(stored.author, 'A. Writer');
    assert.equal(stored.targetWords, 100);

    await page.getByRole('button', { name: 'Writing stats' }).click();
    await page.getByRole('heading', { name: /Writing stats: Renamed Book/ }).waitFor();
    await waitUntil(async () => (await page.getByTestId('stat-today').innerText()) === '10 words', 2000, "today's count");
    assert.equal(await page.getByTestId('stat-writing-streak').innerText(), '1 day');
    assert.equal(await page.getByTestId('stat-book-total').innerText(), '10 words');
    assert.equal(await page.getByRole('progressbar', { name: 'Book word target' }).getAttribute('aria-valuenow'), '10');
    await page.getByTestId('chart-today-added').waitFor();
    assert.equal(await page.locator('.chart-column').count(), 30);

    // The chart answers to hover and to the keyboard, and has a table twin.
    await page.locator('.chart-column').last().hover();
    await page.locator('.chart-tooltip').getByText('10').waitFor();
    await page.mouse.move(10, 10);
    await page.locator('.chart-column[tabindex="0"]').focus();
    await page.keyboard.press('ArrowLeft');
    await page.locator('.chart-tooltip').getByText('written').waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-column')), '28');
    await page.getByText('Show as a table').click();
    assert.equal(await page.locator('.stats-table tbody tr').count(), 30);

    // Words taken out hang below the line, on the same scale as words put in.
    const many = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    await rpc(page, 'nodes.update', { id: scene.id, patch: { content: docOf(many) } });
    await rpc(page, 'nodes.update', { id: scene.id, patch: { content: docOf('Just these few words now.') } });
    await page.locator('.chart-bar-down').waitFor();
    const up = await page.locator('.chart-bar-up').boundingBox();
    const down = await page.locator('.chart-bar-down').boundingBox();
    assert.ok(down.y >= up.y + up.height - 1, 'removed sits under written');
    assert.ok(Math.abs(up.height / down.height - 60 / 55) < 0.1, `heights ${up.height} and ${down.height} match 60 and 55`);
    await waitUntil(async () => (await page.getByTestId('stat-today').innerText()) === '60 words', 2000, "today's new count");
    await app.screenshot('write-stats');
    assert.deepEqual(app.problems, []);
  });

  it('keeps the line being written centered, without fighting the mouse', async () => {
    const page = await start();
    const { id: bookId } = await book(page);
    const scene = (await tree(page, bookId)).find('Scene 1');
    const lines = Array.from({ length: 150 }, (_, i) => `Paragraph ${i} of a scene long enough to scroll through.`);
    await rpc(page, 'nodes.update', { id: scene.id, patch: { content: docOf(...lines) } });
    await page.locator(EDITOR).getByText('Paragraph 149').waitFor();

    await runFromPalette(page, 'Typewriter scrolling');
    await page.locator('.write-scroll.is-typewriter').waitFor();

    const scroller = page.locator('.write-scroll');
    const scrollTop = () => scroller.evaluate((el) => el.scrollTop);
    const caretOffCenter = () =>
      scroller.evaluate((el) => {
        const selection = window.getSelection();
        const box = selection.getRangeAt(0).getClientRects()[0] ?? selection.anchorNode.parentElement.getBoundingClientRect();
        const frame = el.getBoundingClientRect();
        return Math.abs((box.top + box.bottom) / 2 - (frame.top + frame.height / 2));
      });

    // Click a line near the top of the window, then write: the line comes to the middle.
    const target = page.locator(`${EDITOR} > p`).nth(3);
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    const before = await scrollTop();
    await page.mouse.click(box.x + 40, box.y + box.height / 2);
    await page.waitForTimeout(150);
    assert.equal(await scrollTop(), before, 'a click does not move the page');
    await page.keyboard.type('x');
    await waitUntil(async () => (await caretOffCenter()) < 30, 2000, 'the line to be centered');

    // Keys move it along. Each new line stays centered.
    await page.keyboard.press('Control+End');
    await page.waitForTimeout(120);
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press('Enter');
      await page.keyboard.type('New line');
      await page.waitForTimeout(40);
    }
    await waitUntil(async () => (await caretOffCenter()) < 30, 2000, 'the last line to be centered');

    // Scrolling by hand stays where it is put.
    const centered = await scrollTop();
    await page.mouse.move(box.x + 100, 450);
    await page.mouse.wheel(0, -900);
    await waitUntil(async () => (await scrollTop()) < centered - 100, 2000, 'the wheel to scroll');
    const scrolled = await scrollTop();
    await page.waitForTimeout(300);
    assert.equal(await scrollTop(), scrolled, 'manual scrolling is left alone');

    // So does selecting with the mouse.
    const start_ = page.locator(`${EDITOR} > p`).nth(100);
    await start_.scrollIntoViewIfNeeded();
    const first = await start_.boundingBox();
    const held = await scrollTop();
    await page.mouse.move(first.x + 5, first.y + 5);
    await page.mouse.down();
    await page.mouse.move(first.x + 200, first.y + 60, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    assert.equal(await scrollTop(), held, 'selecting does not move the page');
    assert.ok(await page.evaluate(() => !window.getSelection().isCollapsed));

    // A key that keeps the selection does not jump either.
    await page.keyboard.press('Shift+ArrowRight');
    await page.waitForTimeout(150);
    assert.equal(await scrollTop(), held);

    // Turned off, nothing moves when writing.
    await runFromPalette(page, 'Typewriter scrolling');
    await waitUntil(async () => (await page.locator('.write-scroll.is-typewriter').count()) === 0, 2000, 'the setting to go off');
    // Clicked twice, because the first takes focus back from the palette, and at this speed
    // the editor then restores its old selection a moment after the click.
    await page.locator(EDITOR).click({ position: { x: 40, y: 400 } });
    await page.waitForTimeout(60);
    await page.locator(EDITOR).click({ position: { x: 40, y: 400 } });
    await page.waitForTimeout(60);
    const off = await scrollTop();
    await page.keyboard.type('y');
    await page.waitForTimeout(150);
    assert.equal(await scrollTop(), off);
    assert.deepEqual(app.problems, []);
  });

  it('holds on to text when a save fails, and tries again', async () => {
    const page = await start();
    const { id: bookId } = await book(page);
    const scene = (await tree(page, bookId)).find('Scene 1');

    // The native side starts refusing writes, as it would with a disk problem.
    // Tauri's calls travel by fetch, so that is the place to stand in for it.
    await page.evaluate(() => {
      const realFetch = window.fetch.bind(window);
      window.__failSaves = true;
      window.fetch = (url, init) => {
        const body = typeof init?.body === 'string' ? init.body : '';
        if (window.__failSaves && String(url).includes('rpc') && body.includes('"nodes.update"')) {
          const refusal = JSON.stringify({ code: 'DATABASE', message: 'The disk is busy.' });
          return Promise.resolve(new Response(refusal, { headers: { 'Content-Type': 'application/json' } }));
        }
        return realFetch(url, init);
      };
    });
    await page.locator(EDITOR).click();
    await page.keyboard.type('Words that must not be lost.');
    await page.getByLabel('Synopsis').fill('A synopsis that must not be lost.');

    // One message per problem, however many times it tries.
    await page.locator('.toast-error').first().waitFor();
    await page.waitForTimeout(1600);
    assert.equal(await page.locator('.toast-error').count(), 2, 'one for the text and one for the fields');
    assert.ok(!(await storedText(page, scene.id)).includes('must not be lost'));
    assert.equal(await page.getByLabel('Synopsis').inputValue(), 'A synopsis that must not be lost.', 'what was typed stays on screen');

    // Once writes work again, everything arrives without anyone doing anything.
    await page.evaluate(() => {
      window.__failSaves = false;
    });
    await waitForStored(page, scene.id, 'Words that must not be lost.');
    await waitUntil(
      async () => (await rpc(page, 'nodes.get', { id: scene.id })).synopsis === 'A synopsis that must not be lost.',
      3000,
      'the synopsis to arrive',
    );

    // And nothing is left thinking there is unsaved work: a change elsewhere still shows.
    await page.waitForTimeout(200);
    await rpc(page, 'nodes.update', { id: scene.id, patch: { content: docOf('Changed by something else.') } });
    await page.locator(EDITOR).getByText('Changed by something else.').waitFor();
    assert.deepEqual(app.problems, []);
  });

  it('gives a scene a location and a cast, suggesting what its text names', async () => {
    const page = await start();
    const { id: bookId } = await book(page);
    const scene = (await tree(page, bookId)).find('Scene 1');
    const aria = await rpc(page, 'pages.create', { title: 'Aria Vale', pageType: 'character' });
    await rpc(page, 'pages.create', { title: 'Tomas Reed', pageType: 'character' });
    const mira = await rpc(page, 'pages.create', { title: 'Mira Holt', pageType: 'character' });
    const keep = await rpc(page, 'pages.create', { title: 'Silver Keep', pageType: 'place' });
    const ford = await rpc(page, 'pages.create', { title: 'Cold Ford', pageType: 'place' });
    const stored = () => rpc(page, 'nodes.get', { id: scene.id });

    await page.locator(EDITOR).click();
    await page.keyboard.type('Aria Vale rode to Silver Keep with Tomas Reed.');
    await waitForStored(page, scene.id, 'Tomas Reed');

    // One click on a place the text names sets the location.
    const location = page.getByRole('combobox', { name: 'Location' });
    const suggestedKeep = page.getByRole('button', { name: 'Set the location to Silver Keep' });
    await suggestedKeep.click();
    await waitUntil(async () => (await stored()).locationPageId === keep.id, 3000, 'the location to save');
    assert.equal(await location.inputValue(), 'Silver Keep');
    await suggestedKeep.waitFor({ state: 'detached' });

    // The picker offers places only.
    await location.click();
    await page.getByRole('option', { name: 'Cold Ford' }).waitFor();
    assert.equal(await page.getByRole('option', { name: 'Aria Vale' }).count(), 0);
    await location.fill('cold');
    await page.keyboard.press('Enter');
    await waitUntil(async () => (await stored()).locationPageId === ford.id, 3000, 'the typed location to save');
    assert.equal(await location.inputValue(), 'Cold Ford');

    // Clearing the box clears the location, and the suggestion is back.
    await location.fill('');
    await page.getByLabel('Synopsis').click();
    await waitUntil(async () => (await stored()).locationPageId === null, 3000, 'the location to clear');
    await suggestedKeep.waitFor();

    // A character the text names joins the cast with one click.
    const removeAria = page.getByRole('button', { name: 'Take Aria Vale out of the cast' });
    await page.getByRole('button', { name: 'Add Aria Vale to the cast' }).click();
    await removeAria.waitFor();
    await waitUntil(async () => (await rpc(page, 'nodes.cast', { id: scene.id })).includes(aria.id), 3000, 'the cast to save');
    assert.equal(await page.getByRole('button', { name: 'Add Aria Vale to the cast' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Add Mira Holt to the cast' }).count(), 0, 'not named in the text');

    // Anyone else can be added by name, and nobody can be added twice.
    const cast = page.getByRole('combobox', { name: 'Cast' });
    await cast.click();
    await page.getByRole('option', { name: 'Mira Holt' }).waitFor();
    assert.equal(await page.getByRole('option', { name: 'Aria Vale' }).count(), 0);
    assert.equal(await page.getByRole('option', { name: 'Silver Keep' }).count(), 0);
    await cast.fill('mira');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Take Mira Holt out of the cast' }).waitFor();
    assert.equal(await cast.inputValue(), '');
    await app.screenshot('write-location-cast');

    await removeAria.click();
    await page.getByRole('button', { name: 'Add Aria Vale to the cast' }).waitFor();
    await waitUntil(async () => (await rpc(page, 'nodes.cast', { id: scene.id })).length === 1, 3000, 'the removal to save');

    // It is all still there after going away and back, and the snapshot has it.
    await suggestedKeep.click();
    await waitUntil(async () => (await stored()).locationPageId === keep.id, 3000, 'the location to save again');
    await rpc(page, 'nodes.create', { bookId, parentId: scene.parentId, kind: 'scene', title: 'Scene 2' });
    await row(page, 'Scene 2').click();
    await waitUntil(async () => (await page.getByLabel('Scene title').inputValue()) === 'Scene 2', 3000, 'the next scene');
    assert.equal(await location.inputValue(), '');
    assert.equal(await page.getByRole('button', { name: 'Take Mira Holt out of the cast' }).count(), 0);
    await row(page, 'Scene 1').click();
    await page.getByRole('button', { name: 'Take Mira Holt out of the cast' }).waitFor();
    assert.equal(await location.inputValue(), 'Silver Keep');
    const snapshot = await rpc(page, 'snapshot.get');
    const inSnapshot = snapshot.nodes.find((n) => n.id === scene.id);
    assert.equal(inSnapshot.locationPageId, keep.id);
    assert.deepEqual(inSnapshot.castPageIds, [mira.id]);
    assert.deepEqual(app.problems, []);
  });

  it('splits a scene at the cursor and merges it back, keeping formatting and history', async () => {
    const page = await start();
    const { id: bookId } = await book(page);
    const first = await tree(page, bookId);
    const scene = first.find('Scene 1');
    const chapter = first.find('Chapter 1');
    const aria = await rpc(page, 'pages.create', { title: 'Aria Vale', pageType: 'character' });
    const scenesNow = async () => (await tree(page, bookId)).byParent(chapter.id).filter((r) => r.kind === 'scene');
    const title = () => page.getByLabel('Scene title').inputValue();
    const reasons = async (id) => (await rpc(page, 'revisions.list', { kind: 'node', id })).map((r) => r.reason);

    await rpc(page, 'nodes.setCast', { id: scene.id, pageIds: [aria.id] });
    await page.waitForTimeout(150);
    await rpc(page, 'nodes.update', {
      id: scene.id,
      patch: {
        status: 'revised',
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Plain ' },
                { type: 'text', text: 'bold words', marks: [{ type: 'bold' }] },
                { type: 'text', text: ' and the end.' },
              ],
            },
            paragraph('Second paragraph.'),
          ],
        },
      },
    });
    await page.locator(EDITOR).getByText('Second paragraph.').waitFor();

    // At the very start one side would be empty, so nothing happens.
    await page.locator(EDITOR).click();
    await page.keyboard.press('Control+Home');
    await page.waitForTimeout(50);
    await page.keyboard.press('Control+Alt+s');
    await page.getByText('Put the cursor inside the text').waitFor();
    assert.equal((await scenesNow()).length, 1);

    // Words typed a moment ago go with it, and the cut can fall inside bold text.
    await page.keyboard.type('Yes. ');
    for (let i = 0; i < 'Plain bold '.length; i += 1) await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(50);

    // If the native side refuses, nothing changes and the page can be written on again.
    await page.evaluate(() => {
      const realFetch = window.fetch.bind(window);
      window.__failSplits = true;
      window.fetch = (url, init) => {
        const body = typeof init?.body === 'string' ? init.body : '';
        if (window.__failSplits && String(url).includes('rpc') && body.includes('"nodes.split"')) {
          const refusal = JSON.stringify({ code: 'DATABASE', message: 'The disk is busy.' });
          return Promise.resolve(new Response(refusal, { headers: { 'Content-Type': 'application/json' } }));
        }
        return realFetch(url, init);
      };
    });
    await page.keyboard.press('Control+Alt+s');
    await page.getByText('Could not split the scene').waitFor();
    assert.equal((await scenesNow()).length, 1);
    await waitUntil(
      () => page.evaluate((editor) => document.activeElement === document.querySelector(editor), EDITOR),
      2000,
      'the editor to be usable again',
    );
    await page.evaluate(() => {
      window.__failSplits = false;
    });

    await runFromPalette(page, 'Split scene at the cursor');
    await waitUntil(async () => (await title()) === 'Scene 1 (continued)', 5000, 'the second half to open');

    let [left, right] = await scenesNow();
    assert.equal(left.id, scene.id);
    assert.equal(right.title, 'Scene 1 (continued)');
    assert.equal(right.status, 'revised');
    assert.deepEqual(await rpc(page, 'nodes.cast', { id: right.id }), [aria.id]);
    assert.deepEqual((await rpc(page, 'nodes.get', { id: left.id })).content.content, [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Yes. Plain ' },
          { type: 'text', text: 'bold ', marks: [{ type: 'bold' }] },
        ],
      },
    ]);
    assert.deepEqual((await rpc(page, 'nodes.get', { id: right.id })).content.content, [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'words', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' and the end.' },
        ],
      },
      paragraph('Second paragraph.'),
    ]);
    await page.locator(`${EDITOR} strong`, { hasText: 'words' }).waitFor();

    // The whole text was kept in the history first.
    const history = await rpc(page, 'revisions.list', { kind: 'node', id: left.id });
    const before = await rpc(page, 'revisions.get', { id: history.find((r) => r.reason === 'split').id });
    assert.ok(before.contentText.includes('Yes. Plain bold words and the end.'), before.contentText);
    assert.ok(before.contentText.includes('Second paragraph.'), before.contentText);

    // The new scene carries on being written, with focus already in it.
    await waitUntil(() => page.evaluate(() => document.activeElement?.classList.contains('ProseMirror')), 2000, 'focus in the new scene');
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' Later.');
    await waitForStored(page, right.id, 'Second paragraph. Later.');
    assert.ok(!(await storedText(page, left.id)).includes('Later'));

    // The menu only offers to split the open scene, where the cursor is.
    await row(page, 'Scene 1').click({ button: 'right' });
    assert.equal(await page.getByRole('menuitem', { name: /Split at the cursor/ }).isDisabled(), true);
    assert.equal(await page.getByRole('menuitem', { name: /Merge with next scene/ }).isDisabled(), false);
    await app.screenshot('write-scene-menu');

    // Merging from the menu while the second half is open goes to the first.
    await page.getByRole('menuitem', { name: /Merge with next scene/ }).click();
    await waitUntil(async () => (await title()) === 'Scene 1', 5000, 'the merged scene to open');
    await page.getByText(/Merged .*Scene 1 \(continued\).* into .*Scene 1/).waitFor();
    await waitUntil(async () => (await scenesNow()).length === 1, 3000, 'one scene left');
    const merged = (await rpc(page, 'nodes.get', { id: scene.id })).content.content;
    assert.equal(merged.length, 3, 'no blank paragraph at the join');
    assert.deepEqual(merged[1].content, [
      { type: 'text', text: 'words', marks: [{ type: 'bold' }] },
      { type: 'text', text: ' and the end.' },
    ]);
    await page.locator(EDITOR).getByText('Second paragraph. Later.').waitFor();
    assert.ok((await reasons(scene.id)).includes('merge'));
    assert.ok((await reasons(right.id)).includes('merge'));
    const gone = await rpc(page, 'nodes.get', { id: right.id });
    assert.ok(gone.deletedAt, 'the second half is in the trash');

    // With the first scene open, the shortcut merges in place, and writing carries on.
    await page.locator(EDITOR).click();
    await page.keyboard.press('Control+End');
    for (let i = 0; i < 'Second paragraph. Later.'.length; i += 1) await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(50);
    await page.keyboard.press('Control+Alt+s');
    await waitUntil(async () => (await title()) === 'Scene 1 (continued)', 5000, 'another split');
    [left, right] = await scenesNow();
    await row(page, 'Scene 1').click();
    await waitUntil(async () => (await title()) === 'Scene 1', 3000, 'the first half');
    await page.locator(EDITOR).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' Unsaved words.');
    await page.keyboard.press('Control+Alt+m');
    await page.locator(EDITOR).getByText('Second paragraph. Later.').waitFor();
    const whole = await storedText(page, scene.id);
    assert.ok(whole.includes('Unsaved words.'), whole);
    assert.ok(whole.includes('Second paragraph. Later.'), whole);
    await waitUntil(() => page.locator(EDITOR).evaluate((el) => el.getAttribute('contenteditable') === 'true'), 3000, 'the editor to be writable');
    await page.locator(EDITOR).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' The end.');
    await waitForStored(page, scene.id, 'Later. The end.');
    assert.ok((await storedText(page, scene.id)).includes('Unsaved words.'));

    // The last scene has nothing to merge with.
    await page.keyboard.press('Control+Alt+m');
    await page.getByText('This is the last scene in the book').waitFor();
    await row(page, 'Scene 1').click({ button: 'right' });
    assert.equal(await page.getByRole('menuitem', { name: /Merge with next scene/ }).isDisabled(), true);
    await page.keyboard.press('Escape');
    assert.deepEqual(app.problems, []);
  });

  it('shows plot threads across the chapters, and who is present where', async () => {
    const page = await start();
    const { id: bookId } = await book(page);
    const first = await tree(page, bookId);
    const sceneIds = [first.find('Scene 1').id];
    const threadCell = (thread, chapter) => page.locator(`[data-thread-cell="${thread}|${chapter}"]`);

    // An empty project says what to do.
    await page.getByRole('button', { name: 'Threads', exact: true }).click();
    await page.getByText('No plot threads yet').waitFor();
    await page.getByRole('button', { name: 'Presence', exact: true }).click();
    await page.getByText('No characters appear in this book yet').waitFor();

    // Six chapters with a scene each.
    await rpc(page, 'nodes.update', { id: first.find('Chapter 1').id, patch: { title: 'The long road to the northern gate and the winter beyond it' } });
    for (let c = 2; c <= 6; c += 1) {
      const chapter = await rpc(page, 'nodes.create', { bookId, parentId: null, kind: 'chapter', title: `Chapter ${c}` });
      const scene = await rpc(page, 'nodes.create', { bookId, parentId: chapter.id, kind: 'scene', title: `Scene ${c}` });
      sceneIds.push(scene.id);
    }
    await row(page, 'Scene 6').waitFor();
    const longChapter = 'The long road to the northern gate and the winter beyond it';

    // A thread, marked in two chapters from the board.
    await page.getByRole('button', { name: 'Threads', exact: true }).click();
    await page.getByRole('button', { name: 'Add a thread' }).click();
    await page.getByRole('textbox').last().fill('The missing heir');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await threadCell('The missing heir', 'Chapter 2').click();
    await page.getByRole('dialog').getByRole('checkbox', { name: 'Scene 2' }).check();
    await page.locator('[data-thread-cell="The missing heir|Chapter 2"] .thread-count').waitFor();
    await app.screenshot('write-thread-popup');
    await page.keyboard.press('Escape');
    await page.locator('.thread-popup').waitFor({ state: 'detached' });
    assert.equal(await threadCell('The missing heir', 'Chapter 2').evaluate((el) => el === document.activeElement), true);
    await threadCell('The missing heir', 'Chapter 4').click();
    await page.getByRole('dialog').getByRole('checkbox', { name: 'Scene 4' }).check();
    await page.locator('[data-thread-cell="The missing heir|Chapter 4"] .thread-count').waitFor();
    await page.locator('.chart-page-title').click();
    await page.locator('.thread-popup').waitFor({ state: 'detached' });

    // Threads can be put in order.
    await rpc(page, 'threads.create', { name: 'The storm' });
    await page.getByRole('button', { name: 'Move The storm up' }).click();
    await waitUntil(async () => (await rpc(page, 'threads.list'))[0].name === 'The storm', 3000, 'the new order');
    assert.ok(await page.getByRole('button', { name: 'Move The storm up' }).isDisabled());
    await page.getByRole('button', { name: 'Move The storm down' }).click();
    await waitUntil(async () => (await rpc(page, 'threads.list'))[0].name === 'The missing heir', 3000, 'the old order');
    await rpc(page, 'threads.delete', { id: (await rpc(page, 'threads.list'))[1].id });

    // Before it begins is not quiet. Between and after appearances is.
    const classes = async (chapter) => threadCell('The missing heir', chapter).getAttribute('class');
    assert.ok(!(await classes(longChapter)).includes('is-quiet'));
    assert.ok((await classes('Chapter 2')).includes('is-on'));
    assert.ok((await classes('Chapter 3')).includes('is-quiet'));
    assert.ok((await classes('Chapter 4')).includes('is-on'));
    assert.ok((await classes('Chapter 5')).includes('is-quiet'));
    assert.ok((await classes('Chapter 6')).includes('is-quiet'));
    const [made] = await rpc(page, 'threads.list');
    assert.deepEqual(
      (await rpc(page, 'threads.links', { bookId })).map((l) => l.nodeId).sort(),
      [sceneIds[1], sceneIds[3]].sort(),
    );

    // Renamed, recolored and described from its name.
    await page.getByRole('button', { name: 'The missing heir', exact: true }).click();
    await page.getByLabel('Name').fill('The lost heir');
    await page.getByLabel('Description').fill('Who really holds the keep.');
    await page.getByRole('button', { name: 'Color 2' }).click();
    await page.getByRole('button', { name: 'Save' }).click();
    await threadCell('The lost heir', 'Chapter 2').waitFor();
    const [renamed] = await rpc(page, 'threads.list');
    assert.equal(renamed.id, made.id);
    assert.equal(renamed.color, 'success');
    assert.equal(renamed.description, 'Who really holds the keep.');
    await app.screenshot('write-thread-board');

    // A very long name stays on its own line in its own column.
    const longName = 'The question of who really holds the keep, '.repeat(6).trim();
    const long = await rpc(page, 'threads.create', { name: longName, color: 'link' });
    const longHeader = page.locator('.thread-table tbody th', { hasText: longName });
    await longHeader.waitFor();
    assert.ok((await longHeader.boundingBox()).width < 260, 'the name is cut short, not the table stretched');
    await rpc(page, 'threads.delete', { id: long.id });
    await longHeader.waitFor({ state: 'detached' });

    // The scene's details show the same thing, and can change it.
    await page.locator(`[data-thread-cell="The lost heir|Chapter 4"]`).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Open' }).click();
    await waitUntil(async () => (await page.getByLabel('Scene title').inputValue().catch(() => '')) === 'Scene 4', 3000, 'scene 4 to open');
    const box = page.locator('.scene-details').getByRole('checkbox', { name: 'The lost heir' });
    assert.equal(await box.isChecked(), true);
    await box.uncheck();
    await waitUntil(async () => (await rpc(page, 'threads.links', { bookId })).length === 1, 3000, 'the thread to come off');

    // Characters: named in chapters 2 and 6, so away for 3, 4 and 5.
    await rpc(page, 'pages.create', { title: 'Aria Vale', pageType: 'character' });
    const bram = await rpc(page, 'pages.create', { title: 'Bram Stone', pageType: 'character' });
    await rpc(page, 'pages.create', { title: 'Never Seen', pageType: 'character' });
    await rpc(page, 'nodes.update', { id: sceneIds[1], patch: { content: docOf('Aria Vale rode out. Aria Vale came back.') } });
    await rpc(page, 'nodes.update', { id: sceneIds[5], patch: { content: docOf('Aria Vale slept.') } });
    await rpc(page, 'nodes.setCast', { id: sceneIds[0], pageIds: [bram.id] });
    await page.getByRole('button', { name: 'Presence', exact: true }).click();
    const ariaRow = page.locator('.presence-table tbody tr', { hasText: 'Aria Vale' });
    await ariaRow.waitFor();
    assert.deepEqual(
      await page.locator('.presence-table tbody th').allInnerTexts(),
      ['Bram Stone', 'Aria Vale'],
      'in order of first appearance, and only those who appear',
    );
    const cells = await ariaRow.locator('td.presence-cell').allInnerTexts();
    assert.deepEqual(cells, ['', '2', '', '', '', '1']);
    assert.equal(await ariaRow.locator('td.is-absent').count(), 3);
    await ariaRow.locator('.chart-table-note.is-long', { hasText: '3 chapters' }).waitFor();
    const bramRow = page.locator('.presence-table tbody tr', { hasText: 'Bram Stone' });
    assert.equal(await bramRow.locator('td.presence-cell').first().innerText(), '•');
    assert.equal(await page.locator('.presence-legend').isVisible(), true);
    assert.equal(
      await ariaRow.locator('td.presence-cell').nth(3).getAttribute('aria-label'),
      'Aria Vale is absent from Chapter 4',
    );
    await app.screenshot('write-presence');

    // It follows the text as it changes, and reads in light as well as dark.
    await rpc(page, 'nodes.update', { id: sceneIds[3], patch: { content: docOf('Aria Vale returned.') } });
    await waitUntil(async () => (await ariaRow.locator('td.is-absent').count()) === 0, 3000, 'the absence to end');
    await rpc(page, 'nodes.update', { id: sceneIds[3], patch: { content: docOf('Nobody here.') } });
    await waitUntil(async () => (await ariaRow.locator('td.is-absent').count()) === 3, 3000, 'the absence to return');
    const wasDark = await page.evaluate(() => document.documentElement.dataset.mode);
    await page.evaluate((mode) => { document.documentElement.dataset.mode = mode; }, wasDark === 'dark' ? 'light' : 'dark');
    await app.screenshot('write-presence-other-mode');
    await page.getByRole('button', { name: 'Threads', exact: true }).click();
    await threadCell('The lost heir', 'Chapter 2').waitFor();
    await app.screenshot('write-thread-board-other-mode');

    // Deleting a thread leaves the scenes alone.
    await page.getByRole('button', { name: 'The lost heir', exact: true }).click();
    await page.getByRole('button', { name: 'Delete thread' }).click();
    await page.getByRole('button', { name: 'Delete thread' }).last().click();
    await page.getByText('No plot threads yet').waitFor();
    assert.equal((await rpc(page, 'threads.list')).length, 0);
    assert.equal((await rpc(page, 'threads.links', { bookId })).length, 0);
    assert.equal((await rpc(page, 'nodes.get', { id: sceneIds[1] })).deletedAt, null);

    // The keyboard reaches both.
    await page.keyboard.press('Control+Alt+6');
    await page.locator('.presence-table').waitFor();
    await page.keyboard.press('Control+Alt+5');
    await page.getByText('No plot threads yet').waitFor();
    assert.deepEqual(app.problems, []);
  });

  it('shows text changed elsewhere, and never overwrites it with an old copy', async () => {
    const page = await start();
    const { id: bookId } = await book(page);
    const scene = (await tree(page, bookId)).find('Scene 1');
    await page.locator(EDITOR).click();
    await page.keyboard.type('First version.');
    await waitForStored(page, scene.id, 'First version.');
    const revision = await rpc(page, 'revisions.checkpoint', { kind: 'node', id: scene.id });

    // Another part of the app changes the stored text.
    await page.waitForTimeout(150);
    await rpc(page, 'nodes.update', { id: scene.id, patch: { content: docOf('Changed by something else.') } });
    await page.locator(EDITOR).getByText('Changed by something else.').waitFor();
    assert.equal(await page.locator(EDITOR).getByText('First version.').count(), 0);

    // Writing carries on from the new text.
    await page.locator(EDITOR).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' And more.');
    await waitForStored(page, scene.id, 'something else. And more.');

    // Restoring an old version shows it too.
    await page.waitForTimeout(150);
    await rpc(page, 'revisions.restore', { id: revision });
    await page.locator(EDITOR).getByText('First version.').waitFor();
    assert.ok((await storedText(page, scene.id)).includes('First version.'));

    // Renaming a page rewrites links without changing the scene's date.
    const page1 = await rpc(page, 'pages.create', { title: 'Old Name' });
    const linked = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A link', marks: [{ type: 'wikiLink', attrs: { target: 'Old Name' } }] }] }],
    };
    await rpc(page, 'nodes.update', { id: scene.id, patch: { content: linked } });
    await page.locator(`${EDITOR} a[data-wiki-target="Old Name"]`).waitFor();
    await rpc(page, 'pages.rename', { id: page1.id, newTitle: 'New Name', updateLinks: true, keepAlias: false });
    await page.locator(`${EDITOR} a[data-wiki-target="New Name"]`).waitFor();

    // Typing after that keeps the new link rather than bringing the old one back.
    await page.locator(EDITOR).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' done');
    await waitForStored(page, scene.id, ' done');
    assert.ok((await storedText(page, scene.id)).includes('New Name'));
    assert.ok(!(await storedText(page, scene.id)).includes('Old Name'));
    assert.deepEqual(app.problems, []);
  });

  it('forgets one project when another opens', async () => {
    const page = await start('First Project');
    await page.locator(EDITOR).click();
    await page.keyboard.type('Only in the first project.');
    const { id: firstBook } = await book(page);
    const first = (await tree(page, firstBook)).find('Scene 1');
    await waitForStored(page, first.id, 'Only in the first project.');
    await page.getByRole('button', { name: '+ Part' }).click();
    await row(page, 'Part 1').waitFor();

    // Discards the first project and starts another, as the File menu would.
    await rpc(page, 'project.close');
    await page.getByRole('heading', { name: 'LoreCraft' }).waitFor();
    await createProject(page, 'Second Project');
    await page.getByRole('button', { name: 'Write', exact: true }).click();
    await page.locator(EDITOR).waitFor();
    assert.equal(await row(page, 'Part 1').count(), 0);
    assert.equal(await page.locator(EDITOR).getByText('Only in the first').count(), 0);
    const { id: secondBook } = await book(page);
    assert.notEqual(secondBook, firstBook);
    assert.equal(await page.getByRole('combobox', { name: 'Book' }).inputValue(), secondBook);
    assert.deepEqual(app.problems, []);
  });

  it('has shortcuts for the views, and keeps the two text sizes separate', async () => {
    const page = await start();
    await page.locator(EDITOR).click();

    await page.keyboard.press('Control+Alt+3');
    await page.locator('.cork-board').waitFor();
    await page.keyboard.press('Control+Alt+4');
    await page.locator('.outline').waitFor();
    await page.keyboard.press('Control+Alt+2');
    await page.locator('.read-page').waitFor();
    await page.keyboard.press('Control+Alt+1');
    await page.locator(EDITOR).waitFor();

    // New scene and new chapter from anywhere, including another area.
    await page.getByRole('button', { name: 'Wiki', exact: true }).click();
    await page.locator(EDITOR).waitFor({ state: 'detached' });
    await page.keyboard.press('Control+Alt+Enter');
    await page.locator(EDITOR).waitFor();
    await waitUntil(async () => (await page.getByLabel('Scene title').inputValue()) === 'Scene 2', 3000, 'the new scene');
    await page.keyboard.press('Control+Alt+Shift+N');
    await row(page, 'Chapter 2').waitFor();

    // Back goes back through the scenes and views.
    await waitUntil(async () => (await page.getByLabel('Scene title').inputValue()) === 'Scene 1', 3000, 'the chapter\'s first scene');
    await page.keyboard.press('Alt+ArrowLeft');
    await waitUntil(async () => (await page.getByLabel('Scene title').inputValue()) === 'Scene 2', 3000, 'the previous scene');

    // Up from the first line reaches the title, and Enter comes back down.
    await page.locator(EDITOR).click();
    await page.keyboard.press('Control+Home');
    await page.waitForTimeout(50);
    await page.keyboard.press('ArrowUp');
    await waitUntil(() => page.evaluate(() => document.activeElement?.classList.contains('scene-title')), 1000, 'focus in the title');
    await page.keyboard.press('Enter');
    await waitUntil(() => page.evaluate(() => document.activeElement?.classList.contains('ProseMirror')), 1000, 'focus in the text');
    assert.equal(await page.getByLabel('Scene title').inputValue(), 'Scene 2', 'Enter did not add to the title');

    // A click in the margin goes into the text, and the scrollbar is left alone.
    await page.locator('.scene-title').focus();
    const sheet = await page.locator('.write-page').boundingBox();
    await page.mouse.click(sheet.x + 6, sheet.y + 300);
    await waitUntil(() => page.evaluate(() => document.activeElement?.classList.contains('ProseMirror')), 1000, 'focus in the text');

    // From the text to the binder and back, without the mouse.
    await page.locator(EDITOR).click();
    await page.keyboard.press('Control+Alt+b');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'treeitem');
    await page.keyboard.press('Escape');
    await waitUntil(() => page.evaluate(() => document.activeElement?.classList.contains('ProseMirror')), 1000, 'focus back in the text');

    // Clicking the row of the open scene goes back to writing too, and a branch's arrow
    // does not take the cursor out of the text at all.
    await row(page, 'Scene 2').click();
    await waitUntil(() => page.evaluate(() => document.activeElement?.classList.contains('ProseMirror')), 1000, 'focus in the text');
    await row(page, 'Chapter 1').locator('.binder-twisty').click();
    assert.ok(await page.evaluate(() => document.activeElement?.classList.contains('ProseMirror')));
    await row(page, 'Chapter 1').locator('.binder-twisty').click();

    // The details panel has a shortcut, and the menus reach the same commands.
    await page.locator('.scene-details').waitFor();
    await page.keyboard.press('Control+Alt+d');
    await page.locator('.scene-details').waitFor({ state: 'detached' });
    await page.keyboard.press('Control+Alt+d');
    await page.locator('.scene-details').waitFor();
    await page.getByRole('menuitem', { name: 'View' }).click();
    await page.getByRole('menuitem', { name: /Corkboard/ }).click();
    await page.locator('.cork-board').waitFor();
    await page.getByRole('menuitem', { name: 'Insert' }).click();
    await page.getByRole('menuitem', { name: /New part/ }).click();
    await row(page, 'Part 1').waitFor();
    await page.keyboard.press('Control+Shift+W');
    await page.locator(EDITOR).waitFor();

    // A key held down earlier does not stop the menus from working afterwards.
    await page.locator(EDITOR).click();
    await page.keyboard.down('x');
    await page.keyboard.down('x');
    await page.keyboard.up('x');
    await page.getByRole('menuitem', { name: 'Insert' }).click();
    await page.getByRole('menuitem', { name: /New chapter/ }).click();
    await row(page, 'Chapter 3').waitFor();
    await page.locator(EDITOR).waitFor();

    // Manuscript text follows the writing size and the binder follows the interface size.
    const sizes = () =>
      page.evaluate(() => ({
        title: parseFloat(getComputedStyle(document.querySelector('.scene-title')).fontSize),
        text: parseFloat(getComputedStyle(document.querySelector('.prose-manuscript')).fontSize),
        binder: parseFloat(getComputedStyle(document.querySelector('.binder-row')).fontSize),
        toolbar: parseFloat(getComputedStyle(document.querySelector('.write-page .toolbar')).fontSize),
      }));
    const before = await sizes();
    await page.keyboard.press('Control+=');
    await waitUntil(async () => (await sizes()).text > before.text, 2000, 'larger writing text');
    const larger = await sizes();
    assert.ok(larger.title > before.title, 'the title grows with the text');
    assert.equal(larger.binder, before.binder, 'the binder keeps its size');
    assert.equal(larger.toolbar, before.toolbar, 'the formatting bar keeps its size');
    await page.keyboard.press('Control+0');
    await page.keyboard.press('Control+Shift+=');
    await waitUntil(async () => (await sizes()).binder > before.binder, 2000, 'a larger interface');
    assert.equal((await sizes()).text, before.text, 'the text keeps its size');
    await page.keyboard.press('Control+Shift+0');
    assert.deepEqual(app.problems, []);
  });

  it('looks right in dark and light across themes', async () => {
    const page = await start();
    const { id: bookId } = await book(page);
    const first = await tree(page, bookId);
    const chapter = first.find('Chapter 1');
    await rpc(page, 'pages.create', { title: 'Aria Vale', aliases: ['Aria'], pageType: 'character' });
    await rpc(page, 'nodes.update', {
      id: first.find('Scene 1').id,
      patch: {
        status: 'revised',
        synopsis: 'Aria rides for the pass.',
        content: docOf('Aria rode out before the rain came down, and nobody spoke of it again.', 'The horses knew the way.'),
      },
    });
    const statuses = ['idea', 'outline', 'draft', 'final'];
    for (const status of statuses) {
      await rpc(page, 'nodes.create', { bookId, parentId: chapter.id, kind: 'scene', title: `A scene at ${status}`, status, synopsis: `This one is at ${status}.` });
    }
    await row(page, 'A scene at final').waitFor();
    await page.locator('.details-mentions').getByRole('button', { name: 'Aria Vale' }).waitFor();

    const views = [
      ['scene', () => page.getByRole('button', { name: 'Write', exact: true }).click(), EDITOR],
      ['chapter', () => page.getByRole('button', { name: 'Chapter', exact: true }).click(), '.read-page .prose'],
      ['corkboard', () => page.getByRole('button', { name: 'Corkboard' }).click(), '.cork-card'],
      ['outline', () => page.getByRole('button', { name: 'Outline', exact: true }).click(), '.outline-scene'],
      ['stats', () => page.getByRole('button', { name: 'Writing stats' }).click(), '.stat-tile'],
    ];
    for (const [theme, mode] of [['encyclopedia', 'light'], ['parchment', 'dark'], ['parchment', 'light'], ['midnight', 'dark'], ['typewriter', 'light']]) {
      await rpc(page, 'settings.update', { patch: { appearance: { theme, mode } } });
      await page.evaluate(([t, m]) => {
        document.documentElement.dataset.theme = t;
        document.documentElement.dataset.mode = m;
      }, [theme, mode]);
      for (const [name, open, selector] of views) {
        await open();
        await page.locator(selector).first().waitFor();
        await page.waitForTimeout(80);
        await app.screenshot(`write-theme-${theme}-${mode}-${name}`);
        if (name === 'outline') {
          // The whole area uses tokens, so nothing should keep the previous theme's colors.
          const painted = await page.evaluate(() => getComputedStyle(document.querySelector('.outline')).backgroundColor);
          const body = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
          assert.equal(painted, body);
        }
      }
    }
    assert.deepEqual(app.problems, []);
  });

  it('stays fast on a 20,000-word scene in a book of 300 scenes', async () => {
    const page = await start('Big Book');
    const { id: bookId } = await book(page);
    const first = await tree(page, bookId);

    // A cast of names, some of them in the text.
    const cast = Array.from({ length: 200 }, (_, i) => `Person${String.fromCharCode(65 + (i % 26))}${i}`);
    for (const name of cast.slice(0, 200)) await rpc(page, 'pages.create', { title: name, aliases: [`${name} the Elder`] });
    await rpc(page, 'pages.create', { title: 'Aria Vale', aliases: ['Aria'] });

    // 60 chapters of 5 scenes.
    const filler = 'The rain came down over the long road and nobody in the column spoke of it again that night.';
    const small = docOf(filler, filler);
    for (let c = 0; c < 60; c += 1) {
      const chapter = await rpc(page, 'nodes.create', { bookId, kind: 'chapter', title: `Book chapter ${c + 1}` });
      for (let s = 0; s < 5; s += 1) {
        await rpc(page, 'nodes.create', { bookId, parentId: chapter.id, kind: 'scene', title: `Scene ${c + 1}.${s + 1}`, content: small });
      }
    }

    // The long scene: 20,000 words in 600 paragraphs, with names every few sentences.
    const sentence = (i) => `${cast[i % cast.length]} watched the riders come over the ridge while Aria Vale counted them under her breath and said nothing about what she had seen at the ford.`;
    const paragraphs = Array.from({ length: 600 }, (_, i) => `${sentence(i)} ${sentence(i + 7)}`);
    const longScene = first.find('Scene 1');
    await rpc(page, 'nodes.update', { id: longScene.id, patch: { content: docOf(...paragraphs) } });
    const words = (await rpc(page, 'nodes.get', { id: longScene.id })).wordCount;
    assert.ok(words >= 20000, `the scene has ${words} words`);

    // Open it fresh, and time that.
    await row(page, 'Scene 60.5').waitFor({ timeout: 15000 });
    const rows = await page.getByRole('treeitem').count();
    assert.equal(rows, 362);
    await row(page, 'Scene 60.5').click();
    await page.locator(EDITOR).getByText('The rain came down').first().waitFor();
    const openStart = Date.now();
    await row(page, 'Scene 1').click();
    await page.locator(EDITOR).getByText(`${cast[599 % cast.length]} watched`).last().waitFor();
    const openMs = Date.now() - openStart;

    // Typing somewhere in the middle of the scene, with the names highlighted.
    await page.locator(EDITOR).evaluate((el) => {
      el.children[300].scrollIntoView({ block: 'center' });
    });
    await page.waitForTimeout(200);
    const target = page.locator(`${EDITOR} > p`).nth(300);
    const box = await target.boundingBox();
    await page.mouse.click(box.x + 10, box.y + 5);
    const marks = await page.locator(`${EDITOR} .name-mention`).count();
    assert.ok(marks > 1000, `${marks} names are marked`);

    await page.evaluate(() => {
      const samples = { handler: [], frame: [], longTasks: [] };
      window.__typing = samples;
      const editor = document.querySelector('.ProseMirror');
      editor.addEventListener(
        'keydown',
        () => {
          const start = performance.now();
          // The whole cost of the key: the browser's own insert, the editor's handling of
          // it, and everything that runs in the same turn.
          const channel = new MessageChannel();
          editor.addEventListener(
            'input',
            () => {
              channel.port1.onmessage = () => samples.handler.push(performance.now() - start);
              channel.port2.postMessage(0);
            },
            { once: true },
          );
          // From the key to the frame that shows it.
          requestAnimationFrame(() => {
            const after = new MessageChannel();
            after.port1.onmessage = () => samples.frame.push(performance.now() - start);
            after.port2.postMessage(0);
          });
        },
        true,
      );
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) samples.longTasks.push(entry.duration);
      }).observe({ type: 'longtask' });
      // The browser's own measure of input to next paint, in steps of 8 ms. It only
      // reports the slower ones, so keys not listed here took less than 16 ms.
      samples.slowInputs = {};
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name !== 'keydown') continue;
          samples.slowInputs[entry.duration] = (samples.slowInputs[entry.duration] ?? 0) + 1;
        }
      }).observe({ type: 'event', durationThreshold: 16 });
    });

    // Several bursts, with pauses so that saving and the word counts run as well.
    const burst = 'the quick brown fox jumps over the lazy dog and Aria Vale watched it go ';
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.type(burst, { delay: 12 });
      await page.waitForTimeout(700);
    }
    const measured = await page.evaluate(() => window.__typing);

    // Word counts stay right, and the text was stored.
    await waitForStored(page, longScene.id, 'lazy dog and Aria Vale watched it go the quick');
    const after = (await rpc(page, 'nodes.get', { id: longScene.id })).wordCount;
    assert.equal(after, words + 15 * 6);
    await waitUntil(async () => (await statusWords(page)).startsWith(`${after.toLocaleString()} words in scene`), 3000, 'the live count');

    const stats = (values) => {
      const sorted = [...values].sort((x, y) => x - y);
      const at = (p) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] * 10) / 10;
      return { samples: sorted.length, p50: at(0.5), p95: at(0.95), max: at(1) };
    };

    // Frame by frame: dragging in the big tree, including past its bottom edge.
    const watchFrames = () =>
      page.evaluate(() => {
        window.__frames = [];
        let last = performance.now();
        const tick = (now) => {
          window.__frames.push(now - last);
          last = now;
          window.__frameId = requestAnimationFrame(tick);
        };
        window.__frameId = requestAnimationFrame(tick);
      });
    const stopFrames = () =>
      page.evaluate(() => {
        cancelAnimationFrame(window.__frameId);
        return window.__frames;
      });
    await watchFrames();
    await row(page, 'Scene 1.2').waitFor();
    const binderTree = page.locator('.binder-tree');
    const a = await row(page, 'Scene 1.2').boundingBox();
    const treeBox = await binderTree.boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    const scrollBefore = await binderTree.evaluate((el) => el.scrollTop);
    for (let i = 1; i <= 40; i += 1) {
      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + ((treeBox.y + treeBox.height - 6 - a.y) * i) / 40);
    }
    // Held near the edge, the list scrolls by itself.
    await waitUntil(async () => (await binderTree.evaluate((el) => el.scrollTop)) > scrollBefore + 200, 5000, 'the binder to scroll during a drag');
    await page.mouse.move(a.x + a.width / 2, treeBox.y + treeBox.height / 2);
    await page.waitForTimeout(100);
    await page.mouse.up();
    const frames = await stopFrames();
    await waitUntil(async () => {
      const now = await tree(page, bookId);
      return now.rows.find((r) => r.title === 'Scene 1.2').parentId !== now.find('Book chapter 1').id;
    }, 3000, 'the scene to move after scrolling');

    // The other views of the same big book.
    const timed = async (run, ready) => {
      const started = Date.now();
      await run();
      await ready.waitFor();
      return Date.now() - started;
    };
    await page.getByRole('button', { name: 'Wiki', exact: true }).click();
    await page.locator('.binder').waitFor({ state: 'detached' });
    const openWriteMs = await timed(() => page.getByRole('button', { name: 'Write', exact: true }).click(), row(page, 'Scene 60.5'));
    const outlineMs = await timed(() => page.getByRole('button', { name: 'Outline', exact: true }).click(), page.locator('.outline-scene').last());
    await page.getByRole('button', { name: 'Corkboard' }).click();
    await page.locator('.cork-board').waitFor();
    const wholeBoardMs = await page.getByRole('button', { name: 'Show whole book' }).count()
      ? await timed(() => page.getByRole('button', { name: 'Show whole book' }).click(), page.locator('.cork-section').nth(50))
      : 0;
    await page.waitForTimeout(200);
    await watchFrames();
    const firstCard = page.locator('.cork-card').nth(1);
    const cardBox = await firstCard.boundingBox();
    await page.mouse.move(cardBox.x + 20, cardBox.y + 20);
    await page.mouse.down();
    for (let i = 1; i <= 40; i += 1) await page.mouse.move(cardBox.x + 20 + i * 8, cardBox.y + 20 + i * 4);
    await page.mouse.up();
    const cardFrames = await stopFrames();

    const report = {
      words: after,
      paragraphs: 600,
      namesMarked: marks,
      binderRows: rows,
      openLongSceneMs: openMs,
      openWriteAreaMs: openWriteMs,
      openOutlineMs: outlineMs,
      openWholeBookBoardMs: wholeBoardMs,
      cardDragFrameMs: stats(cardFrames),
      keyToEndOfHandlingMs: stats(measured.handler),
      keyToFrameMs: stats(measured.frame),
      longTasksOver50ms: measured.longTasks.map(Math.round),
      keysAtEachSlowDurationMs: measured.slowInputs,
      dragFrameMs: stats(frames),
    };
    console.log(JSON.stringify(report, null, 2));
    mkdirSync(ARTIFACTS, { recursive: true });
    writeFileSync(join(ARTIFACTS, 'write-latency.json'), JSON.stringify(report, null, 2));

    // Numbers well under what anyone can feel, with room for a machine that is busy with
    // other things during the test. The report above has the real ones.
    assert.ok(report.keyToEndOfHandlingMs.p95 < slowLimit(33), `key handling ${JSON.stringify(report.keyToEndOfHandlingMs)}`);
    assert.ok(report.keyToFrameMs.p95 < slowLimit(50), `key to frame ${JSON.stringify(report.keyToFrameMs)}`);
    assert.ok(
      report.longTasksOver50ms.length <= (SLOW > 1 ? 2 : 0),
      `long tasks while typing ${JSON.stringify(report.longTasksOver50ms)}`,
    );
    assert.deepEqual(app.problems, []);
    await app.screenshot('write-big-board');
  });
});
