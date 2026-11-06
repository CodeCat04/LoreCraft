import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { allowPath, createProject, createWorkspace, launch, rpc, waitUntil } from './harness.mjs';

const para = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = (...texts) => ({ type: 'doc', content: texts.map(para) });

/** Puts this text in the new project's first scene, then opens that scene. */
async function openScene(page, ...texts) {
  const [book] = await rpc(page, 'books.list');
  await rpc(page, 'books.update', { id: book.id, patch: { title: 'Book One' } });
  const rows = await rpc(page, 'nodes.tree', { bookId: book.id });
  const scene = rows.find((r) => r.kind === 'scene');
  const chapter = rows.find((r) => r.id === scene.parentId);
  await rpc(page, 'nodes.update', { id: scene.id, patch: { title: 'Arrival', content: doc(...texts) } });
  if (chapter) await rpc(page, 'nodes.update', { id: chapter.id, patch: { title: 'Chapter One' } });
  await page.getByRole('button', { name: 'Write', exact: true }).click();
  await page.locator('.ProseMirror[contenteditable="true"]').waitFor();
  return { book, chapter, scene };
}

/** Selects the first place these words appear in the open editor. */
async function selectWords(page, words) {
  await page.evaluate((target) => {
    const root = document.querySelector('.ProseMirror');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    // Comments and highlights split text into several DOM nodes.
    const parts = [];
    let whole = '';
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      parts.push({ node, start: whole.length });
      whole += node.textContent;
    }
    const at = whole.indexOf(target);
    if (at < 0) throw new Error(`"${target}" is not in the editor`);
    const place = (offset) => {
      const part = parts.findLast((p) => p.start <= offset);
      return [part.node, offset - part.start];
    };
    const range = document.createRange();
    range.setStart(...place(at));
    range.setEnd(...place(at + target.length - 1));
    range.setEnd(range.endContainer, range.endOffset + 1);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    root.focus();
  }, words);
  // The editor learns of a new selection from an event, so give it a frame before any keys.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** Types a comment into the box that Ctrl+Alt+C opens. */
async function writeComment(page, words, body, { todo = false } = {}) {
  await selectWords(page, words);
  await page.keyboard.press('Control+Alt+c');
  const box = page.getByRole('dialog', { name: 'New comment' });
  await box.waitFor();
  await box.getByRole('textbox', { name: 'Comment' }).fill(body);
  if (todo) await box.getByRole('checkbox', { name: 'To-do' }).check();
  await box.getByRole('button', { name: 'Save' }).click();
  await box.waitFor({ state: 'detached' });
}

async function storedScene(page, id) {
  return rpc(page, 'nodes.get', { id });
}

function commentMarks(node, out = []) {
  for (const mark of node.marks ?? []) {
    if (mark.type === 'comment') out.push({ id: mark.attrs.id, text: node.text });
  }
  (node.content ?? []).forEach((child) => commentMarks(child, out));
  return out;
}

describe('comments and to-dos', () => {
  let workspace;
  let app;

  beforeEach(() => {
    workspace = createWorkspace();
  });

  afterEach(async () => {
    if (app && !app.exited) await app.kill().catch(() => {});
    workspace.cleanup();
  });

  it('adds a comment from the keyboard, keeps it through a reload and edits around it, then resolves it', async () => {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page, 'Comment World');
    const { scene } = await openScene(page, 'The old gate held fast against the storm.', 'A second paragraph follows here.');
    await page.locator('.ProseMirror[contenteditable="true"]').waitFor();

    await writeComment(page, 'old gate', 'Is this the same gate as in chapter two?');

    const card = page.locator('.comment-card');
    await card.waitFor();
    await page.locator('.comment-range', { hasText: 'old gate' }).first().waitFor();
    await app.screenshot('notes-comment-margin');

    await waitUntil(async () => commentMarks((await storedScene(page, scene.id)).content).length > 0, 5000, 'the mark to be stored');
    const stored = await storedScene(page, scene.id);
    assert.deepEqual(commentMarks(stored.content).map((m) => m.text), ['old gate']);
    assert.equal(stored.wordCount, 13, 'a comment changes no words');
    assert.equal(stored.content.content[0].type, 'paragraph', 'the shortcut does not also make a code block');

    // Beside the text, level with the line it belongs to.
    const [cardBox, textBox, editorBox] = await Promise.all([
      card.boundingBox(),
      page.locator('.comment-range').first().boundingBox(),
      page.locator('.ProseMirror').boundingBox(),
    ]);
    assert.ok(cardBox.x >= editorBox.x + editorBox.width, 'the card is beside the text');
    assert.ok(Math.abs(cardBox.y - textBox.y) < 12, `the card is level with its text: ${cardBox.y} and ${textBox.y}`);

    // A reload shows it again in the same place.
    await page.reload();
    await page.locator('.topbar').waitFor();
    await page.getByRole('button', { name: 'Write', exact: true }).click();
    await page.locator('.comment-range', { hasText: 'old gate' }).first().waitFor();
    await card.waitFor();

    // Typing at the edge does not extend the comment, and typing before it moves it.
    await selectWords(page, 'held fast');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.type(', mossy');
    await page.keyboard.press('Control+Home');
    await page.keyboard.type('Then ');
    const firstLine = async () => (await storedScene(page, scene.id)).content.content[0].content.map((n) => n.text).join('');
    await waitUntil(async () => (await firstLine()).startsWith('Then The old gate, mossy held'), 10000, 'the edits to be stored').catch(
      async (e) => {
        throw new Error(`${e.message}. Stored: "${await firstLine()}"`);
      },
    );
    const after = await storedScene(page, scene.id);
    assert.deepEqual(commentMarks(after.content).map((m) => m.text), ['old gate'], 'typing at its edge does not extend it');

    // Clicking the card highlights its text.
    await card.locator('.comment-card-body').click();
    await page.locator('.comment-range.is-active', { hasText: 'old gate' }).first().waitFor();

    // Editing the comment.
    await card.getByRole('button', { name: 'Edit' }).click();
    await card.getByRole('textbox', { name: 'Edit comment' }).fill('Same gate, I checked.');
    await page.keyboard.press('Enter');
    await card.getByText('Same gate, I checked.').waitFor();

    // Ticking it as a to-do.
    await card.getByRole('button', { name: 'To-do' }).click();
    await card.getByRole('checkbox', { name: 'Mark to-do as done' }).check();
    await waitUntil(async () => (await rpc(page, 'comments.list'))[0].done === true, 3000, 'the tick to be stored');
    await card.getByRole('checkbox').uncheck();

    // Resolving takes it out of the margin, and its mark stays in case it is reopened.
    await card.getByRole('button', { name: 'Resolve' }).click();
    await card.waitFor({ state: 'detached' });
    assert.equal(await page.locator('.comment-range').count(), 0, 'its text is no longer highlighted');
    assert.equal(commentMarks((await storedScene(page, scene.id)).content).length, 1);
    assert.equal((await rpc(page, 'comments.list'))[0].resolved, true);
  });

  it('lets comments overlap, and deleting one leaves the other', async () => {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page);
    const { scene } = await openScene(page, 'One two three four five six.');
    await page.locator('.ProseMirror[contenteditable="true"]').waitFor();
    await writeComment(page, 'two three four', 'First');
    await writeComment(page, 'four five', 'Second');
    await page.locator('.comment-range.is-overlap', { hasText: 'four' }).waitFor();
    await waitUntil(async () => commentMarks((await storedScene(page, scene.id)).content).length === 4, 5000, 'both marks to be stored');

    page.on('dialog', () => {});
    const first = page.locator('.comment-card', { hasText: 'First' });
    await first.hover();
    await first.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
    await first.waitFor({ state: 'detached' });
    await page.locator('.comment-card', { hasText: 'Second' }).waitFor();
    await waitUntil(
      async () => {
        const marks = commentMarks((await storedScene(page, scene.id)).content);
        return marks.map((m) => m.text).join('') === 'four five';
      },
      5000,
      'only the second mark to be left',
    );
  });

  it('adds a comment while reading a whole chapter, and stays on that screen', async () => {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page);
    const { scene } = await openScene(page, 'A sentence to read through and remark on.');
    await page.getByRole('button', { name: 'Chapter', exact: true }).click();
    await page.locator('.read-scene-text .ProseMirror').waitFor();

    await selectWords(page, 'read through');
    await page.getByRole('dialog', { name: 'AI actions for the selected text' }).getByRole('button', { name: 'Comment' }).click();
    const box = page.getByRole('dialog', { name: 'New comment' });
    await box.getByRole('textbox', { name: 'Comment' }).click();
    await box.getByRole('textbox', { name: 'Comment' }).fill('Noted while reading');
    await box.getByRole('button', { name: 'Save' }).click();

    // The text here is a read-only copy, so the mark has to reach the stored scene itself.
    await waitUntil(
      async () => commentMarks((await storedScene(page, scene.id)).content).map((m) => m.text).join('') === 'read through',
      5000,
      'the mark to be stored',
    );
    const card = page.locator('.comment-card', { hasText: 'Noted while reading' });
    await card.waitFor();
    await page.locator('.read-scene-text .comment-range', { hasText: 'read through' }).first().waitFor();
    await card.locator('.comment-card-body').click();
    assert.equal(await page.locator('.read-page').count(), 1, 'a click on a card does not leave for the editor');
  });

  it('brings a comment back with its text on undo, and undo does not take a comment away', async () => {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page);
    const { scene } = await openScene(page, 'Keep this start. Lose these words now.');
    await writeComment(page, 'these words', 'Worth keeping?');
    const card = page.locator('.comment-card');
    await card.waitFor();

    // Undo after adding a comment leaves the comment on the text.
    await page.locator('.ProseMirror').click();
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(300);
    assert.equal(await card.getByText(/Text removed/).count(), 0);
    await page.locator('.comment-range', { hasText: 'these words' }).first().waitFor();

    await selectWords(page, 'Lose these words now.');
    await page.keyboard.press('Delete');
    await card.getByText('Text removed: “these words”').waitFor();
    await page.keyboard.press('Control+z');
    await card.getByText(/Text removed/).waitFor({ state: 'detached' });
    await page.locator('.comment-range', { hasText: 'these words' }).first().waitFor();
    await waitUntil(
      async () => commentMarks((await storedScene(page, scene.id)).content).map((m) => m.text).join('') === 'these words',
      5000,
      'the mark to be stored again',
    );
  });

  it('puts comments under the text when the window is too narrow for a column', async () => {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page);
    await openScene(page, 'A sentence to remark on in a narrow window.');
    await writeComment(page, 'remark on', 'Narrow comment');
    const card = page.locator('.comment-card');
    await card.waitFor();
    await page.setViewportSize({ width: 820, height: 800 });
    await page.locator('.comment-margin[data-mode="stacked"]').waitFor();
    await page.getByRole('heading', { name: 'Comments', exact: true }).waitFor();
    const [cardBox, editorBox] = await Promise.all([card.boundingBox(), page.locator('.ProseMirror').boundingBox()]);
    assert.ok(cardBox.y >= editorBox.y + editorBox.height, 'the card is under the text');
    assert.ok(cardBox.x + cardBox.width <= 820, 'the card fits in the window');
    await card.getByRole('button', { name: 'Resolve' }).waitFor();
    await app.screenshot('notes-comment-stacked');
  });

  it('adds a comment from the selection menu in the wiki, in Read mode too', async () => {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page);
    const created = await rpc(page, 'pages.create', { title: 'The Gate', content: doc('The gate stands at the edge of the world.') });
    await page.getByRole('button', { name: /All pages/ }).click();
    await page.getByRole('link', { name: 'The Gate' }).or(page.getByRole('button', { name: 'The Gate' })).first().click();
    await page.locator('.wiki-title', { hasText: 'The Gate' }).waitFor();

    await selectWords(page, 'edge of the world');
    await page.getByRole('dialog', { name: 'AI actions for the selected text' }).getByRole('button', { name: 'Comment' }).click();
    const box = page.getByRole('dialog', { name: 'New comment' });
    await box.getByRole('textbox', { name: 'Comment' }).fill('How far is that?');
    await box.getByRole('button', { name: 'Save' }).click();
    await page.locator('.comment-card', { hasText: 'How far is that?' }).waitFor();
    await app.screenshot('notes-wiki-margin');
    await waitUntil(
      async () => commentMarks((await rpc(page, 'pages.get', { id: created.id })).content).length > 0,
      5000,
      'the mark to be stored',
    );

    // It stays with the page after going away and coming back.
    await page.getByRole('button', { name: 'Main page' }).click();
    await page.locator('.comment-card').waitFor({ state: 'detached' });
    await page.evaluate(() => history.length);
    await page.getByRole('button', { name: /Comments and to-dos/ }).click();
    await page.getByRole('heading', { name: 'Comments and to-dos' }).waitFor();
    await page.getByRole('button', { name: 'How far is that?' }).click();
    await page.locator('.comment-range.is-active', { hasText: 'edge of the world' }).first().waitFor();
  });

  it('lists everything across the project, filters it, jumps to it, and keeps comments whose text is gone', async () => {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page);
    const { scene } = await openScene(page, 'Doomed words go here. Safe words stay here.');
    await page.locator('.ProseMirror[contenteditable="true"]').waitFor();
    await writeComment(page, 'Doomed words', 'About the doomed words', { todo: true });
    await writeComment(page, 'Safe words', 'About the safe words');
    const pageRow = await rpc(page, 'pages.create', { title: 'Mara', content: doc('Mara was born in the north.') });
    await rpc(page, 'comments.add', { sourceKind: 'page', sourceId: pageRow.id, body: 'Check the date', author: 'ai' });

    // Deleting the text it was attached to.
    await selectWords(page, 'Doomed words go here. ');
    await page.keyboard.press('Delete');
    await page.locator('.comment-card', { hasText: 'About the doomed words' }).getByText(/Text removed/).waitFor();
    await app.screenshot('notes-text-removed');
    await waitUntil(
      async () => !commentMarks((await storedScene(page, scene.id)).content).some((m) => m.text.includes('Doomed')),
      5000,
      'the deletion to be stored',
    );

    await page.keyboard.press('Control+Alt+Shift+C');
    await page.getByRole('heading', { name: 'Comments and to-dos' }).waitFor();
    const items = page.locator('.notes-item');
    await waitUntil(async () => (await items.count()) === 3, 3000, 'all three to be listed');
    await page.locator('.notes-item', { hasText: 'About the doomed words' }).getByText('Text removed: “Doomed words”').waitFor();
    await page.locator('.notes-item', { hasText: 'About the safe words' }).getByText('“Safe words”').waitFor();
    await page.locator('.notes-item', { hasText: 'About the safe words' }).getByText('Book One › Chapter One › Arrival').waitFor();
    await app.screenshot('notes-list');

    await page.getByRole('combobox', { name: 'Kind' }).selectOption('todos');
    await waitUntil(async () => (await items.count()) === 1, 2000, 'only the to-do');
    await page.getByRole('combobox', { name: 'Kind' }).selectOption('all');
    await page.getByRole('combobox', { name: 'From' }).selectOption('ai');
    await waitUntil(async () => (await items.count()) === 1, 2000, 'only the AI comment');
    await page.getByRole('combobox', { name: 'From' }).selectOption('all');
    await page.getByRole('combobox', { name: 'Where' }).selectOption('wiki');
    await waitUntil(async () => (await items.count()) === 1, 2000, 'only the wiki comment');
    await page.getByRole('combobox', { name: 'Where' }).selectOption('all');
    await page.getByRole('searchbox', { name: 'Containing' }).fill('safe');
    await waitUntil(async () => (await items.count()) === 1, 2000, 'only the matching one');
    await page.getByRole('searchbox', { name: 'Containing' }).fill('');

    // Resolved items leave the open list and appear under the other filter.
    await page.locator('.notes-item', { hasText: 'Check the date' }).getByRole('button', { name: 'Resolve' }).click();
    await waitUntil(async () => (await items.count()) === 2, 2000, 'the resolved one to leave');
    await page.getByRole('combobox', { name: 'Show' }).selectOption('closed');
    await waitUntil(async () => (await items.count()) === 1, 2000, 'the resolved one to be shown');
    await page.locator('.notes-item', { hasText: 'Check the date' }).getByRole('button', { name: 'Reopen' }).click();
    await waitUntil(async () => (await items.count()) === 0, 2000, 'it to go back');
    await page.getByRole('combobox', { name: 'Show' }).selectOption('open');

    // Jumping to one opens its scene and highlights its text.
    await page.locator('.notes-item', { hasText: 'About the safe words' }).getByRole('button', { name: 'Go to' }).click();
    await page.locator('.comment-range.is-active', { hasText: 'Safe words' }).first().waitFor();
  });

  it('attaches a comment through the API to an open document and to a stored one', async () => {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page);
    const stored = await rpc(page, 'pages.create', { title: 'Stored', content: doc('The “quoted words” are here.') });
    const { scene } = await openScene(page, 'Words in the open scene, here.');
    await page.locator('.ProseMirror[contenteditable="true"]').waitFor();

    const results = await page.evaluate(
      async ({ pageId, sceneId }) => {
        const api = window.__notesE2e;
        const open = await api.addComment({ kind: 'node', id: sceneId, body: 'On the open one', author: 'ai', quote: 'open scene' });
        const closed = await api.addComment({ kind: 'page', id: pageId, body: 'On the stored one', author: 'MCP', quote: '"quoted words"', isTodo: true });
        const missing = await api.addComment({ kind: 'page', id: pageId, body: 'Quote not found', quote: 'not in the page' });
        const whole = await api.addComment({ kind: 'page', id: pageId, body: 'About all of it' });
        return { open, closed, missing, whole };
      },
      { pageId: stored.id, sceneId: scene.id },
    );
    assert.equal(results.open.anchored, true);
    assert.equal(results.closed.anchored, true);
    assert.equal(results.closed.author, 'MCP');
    assert.equal(results.closed.isTodo, true);
    assert.equal(results.missing.anchored, false);
    assert.equal(results.whole.anchored, false);

    await page.locator('.comment-range', { hasText: 'open scene' }).first().waitFor();
    await waitUntil(async () => commentMarks((await storedScene(page, scene.id)).content).length === 1, 5000, 'the open mark to be stored');
    const page2 = await rpc(page, 'pages.get', { id: stored.id });
    assert.deepEqual(commentMarks(page2.content).map((m) => m.text), ['“quoted words”']);
  });

  it('keeps comments out of what leaves the project', async () => {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page);
    const created = await rpc(page, 'pages.create', { title: 'Gate', content: doc('The old gate held.') });
    const comment = await rpc(page, 'comments.add', { sourceKind: 'page', sourceId: created.id, body: 'x' });
    const marked = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [
          { type: 'text', text: 'The ' },
          { type: 'text', text: 'old', marks: [{ type: 'comment', attrs: { id: comment.id } }] },
          { type: 'text', text: ' gate held.' },
        ],
      }],
    };
    await rpc(page, 'pages.update', { id: created.id, patch: { content: marked } });
    const found = await rpc(page, 'search.query', { q: 'old gate' });
    assert.ok(found.some((hit) => hit.id === created.id || hit.entityId === created.id), 'the text still reads across the mark');
    const snapshot = await rpc(page, 'snapshot.get');
    assert.equal(JSON.stringify(snapshot).includes('"comment"'), false);
    assert.deepEqual(snapshot.pages.find((p) => p.id === created.id).content, doc('The old gate held.'));
  });
});

describe('prose checks', () => {
  let workspace;
  let app;

  beforeEach(() => {
    workspace = createWorkspace();
  });

  afterEach(async () => {
    if (app && !app.exited) await app.kill().catch(() => {});
    workspace.cleanup();
  });

  const checkButton = (page, check) => page.locator(`.prose-check-count[data-check="${check}"]`);

  async function countOf(page, check) {
    return Number((await checkButton(page, check).innerText()).replace(/,/g, ''));
  }

  async function waitForCount(page, check, expected) {
    await waitUntil(async () => (await countOf(page, check)) === expected, 5000, `${check} to count ${expected}`);
  }

  it('highlights without changing the document or marking it dirty', async () => {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page);
    const { scene } = await openScene(
      page,
      'She felt the the cold. Slowly the door was opened by someone unseen.',
      'The lantern swung and the lantern fell. He saw it happen.',
    );
    const path = workspace.file('prose.lorecraft');
    await allowPath(page, path);
    await rpc(page, 'project.saveAs', { path });
    await waitUntil(async () => /All changes saved/.test(await page.getByTestId('save-state').innerText()), 3000, 'the saved state');
    const before = await rpc(page, 'nodes.get', { id: scene.id });

    await page.getByRole('button', { name: 'Prose', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Prose checks' });
    await panel.waitFor();
    await waitForCount(page, 'doubled', 1);
    assert.equal(await countOf(page, 'filter'), 2, 'felt and saw');
    assert.equal(await countOf(page, 'adverb'), 1, 'slowly');
    assert.equal(await countOf(page, 'passive'), 1, 'was opened');
    assert.equal(await countOf(page, 'repeated'), 2, 'both uses of lantern');
    await panel.locator('[data-prose="words"]', { hasText: '24' }).waitFor();

    // On by default for some checks, and switched per check.
    await page.locator('.prose-hit-doubled', { hasText: 'the the' }).waitFor();
    assert.equal(await page.locator('.prose-hit-filter').count(), 0);
    await panel.getByRole('checkbox', { name: 'Highlight filter words' }).check();
    await page.locator('.prose-hit-filter', { hasText: 'felt' }).waitFor();
    await page.locator('.prose-hit-filter', { hasText: 'saw' }).waitFor();
    await panel.getByRole('checkbox', { name: 'Highlight repeated close together' }).check();
    await page.locator('.prose-hit-repeated', { hasText: 'lantern' }).first().waitFor();
    await panel.getByRole('checkbox', { name: 'Highlight adverbs' }).check();
    await panel.getByRole('checkbox', { name: 'Highlight passive-looking phrases' }).check();
    await app.screenshot('notes-prose-panel');
    await panel.getByRole('checkbox', { name: 'Highlight filter words' }).uncheck();
    await page.locator('.prose-hit-filter').first().waitFor({ state: 'detached' });

    // A count steps through its matches, without touching the selection or the text.
    await checkButton(page, 'filter').click();
    await page.locator('.prose-current', { hasText: 'felt' }).waitFor();
    await checkButton(page, 'filter').click();
    await page.locator('.prose-current', { hasText: 'saw' }).waitFor();
    await checkButton(page, 'filter').click();
    await page.locator('.prose-current', { hasText: 'felt' }).waitFor();

    // Nothing was written, and the project is still saved.
    await page.waitForTimeout(800);
    assert.match(await page.getByTestId('save-state').innerText(), /All changes saved/);
    const after = await rpc(page, 'nodes.get', { id: scene.id });
    assert.deepEqual(after.content, before.content);
    assert.equal(after.updatedAt, before.updatedAt);
    assert.deepEqual(
      await page.evaluate(() => [...document.querySelectorAll('.ProseMirror p')].map((p) => p.textContent)),
      ['She felt the the cold. Slowly the door was opened by someone unseen.', 'The lantern swung and the lantern fell. He saw it happen.'],
    );

    // Editing moves the highlights with the text and updates the counts.
    await page.locator('.ProseMirror').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' It was the the end.');
    await waitForCount(page, 'doubled', 2);
  });

  it('keeps typing smooth in a long scene while the checks run in a worker', async (t) => {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page);
    const paragraph = 'The lantern swung slowly while she felt the old stone gate was opened by nobody at all, and the the wind seemed to wait.';
    const texts = Array.from({ length: 1500 }, () => paragraph);
    await openScene(page, ...texts);
    const workersBefore = page.workers().length;

    await page.getByRole('button', { name: 'Prose', exact: true }).click();
    await waitForCount(page, 'doubled', 1500);
    assert.ok(page.workers().length > workersBefore, 'the checks have a worker of their own');

    await page.evaluate(() => {
      window.__longest = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__longest = Math.max(window.__longest, entry.duration);
      }).observe({ entryTypes: ['longtask'] });
    });
    await page.locator('.ProseMirror').click();
    await page.keyboard.press('Control+End');
    const started = Date.now();
    await page.keyboard.type(' She typed along while the the checks ran.', { delay: 25 });
    const typing = Date.now() - started;
    await waitForCount(page, 'doubled', 1501);
    const longest = await page.evaluate(() => window.__longest);
    t.diagnostic(`42 keys in ${typing} ms, longest main-thread task ${Math.round(longest)} ms`);
    console.log(`42 keys in ${typing} ms, longest main-thread task ${Math.round(longest)} ms`);
    assert.ok(typing < 42 * 25 + 3000, `typing took ${typing} ms`);
  });

  it('does not count names as overused, and compares a scene with the rest of the book', async () => {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page);
    await rpc(page, 'pages.create', { title: 'Mara Vale' });
    const [book] = await rpc(page, 'books.list');
    const rows = await rpc(page, 'nodes.tree', { bookId: book.id });
    const first = rows.find((r) => r.kind === 'scene');
    const line = 'Mara Vale lifted the ember and Mara Vale looked at the ember, because the ember was warm and Mara Vale knew it. ';
    await rpc(page, 'nodes.update', { id: first.id, patch: { content: doc(line, line) } });
    const filler = Array.from({ length: 1200 }, (_, i) => `plain${i}`).join(' ');
    const second = await rpc(page, 'nodes.create', {
      bookId: book.id,
      parentId: first.parentId,
      kind: 'scene',
      title: 'Later',
      content: doc(`She felt nothing. ${filler}.`),
    });
    await page.getByRole('button', { name: 'Write', exact: true }).click();
    await page.locator('.ProseMirror[contenteditable="true"]').waitFor();

    await page.keyboard.press('Control+Alt+p');
    const panel = page.getByRole('complementary', { name: 'Prose checks' });
    await panel.waitFor();
    await panel.locator('.prose-terms summary').click();
    await panel.locator('.prose-term', { hasText: 'ember' }).waitFor();
    const terms = await panel.locator('.prose-term-text').allInnerTexts();
    assert.ok(terms.includes('ember'), `ember is listed in ${terms.join(', ')}`);
    assert.ok(!terms.some((t) => /mara|vale/i.test(t)), `no names in ${terms.join(', ')}`);

    // Clicking a term steps through it.
    await panel.locator('.prose-term', { hasText: 'ember' }).click();
    await page.locator('.prose-current', { hasText: 'ember' }).waitFor();

    // The book scope includes the other scene, and stepping there opens it.
    assert.equal(await countOf(page, 'filter'), 4, 'looked and knew, twice over');
    await panel.getByRole('button', { name: 'Book' }).click();
    await waitForCount(page, 'filter', 5);
    for (let i = 0; i < 5; i += 1) await checkButton(page, 'filter').click();
    await page.locator('.prose-current', { hasText: 'felt' }).waitFor();
    await page.locator('.ProseMirror').getByText('She felt').waitFor();
    assert.ok((await page.locator('.scene-title').inputValue()) === 'Later', `opened ${second.title}`);
  });

  it('reads aloud with a voice and speed, highlights the sentence, pauses and stops', async (t) => {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page);
    await openScene(page, 'One short sentence here. Another short sentence follows it.', 'A third one in a new paragraph.');
    await page.getByRole('button', { name: 'Prose', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Prose checks' });
    await panel.waitFor();

    const voices = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const read = () => speechSynthesis.getVoices().map((v) => `${v.name} (${v.lang})${v.localService ? '' : ' online'}`);
          if (read().length > 0) resolve(read());
          speechSynthesis.addEventListener('voiceschanged', () => resolve(read()));
          setTimeout(() => resolve(read()), 3000);
        }),
    );
    t.diagnostic(`Voices in WebView2: ${voices.length ? voices.join(', ') : 'none'}`);
    console.log(`Voices in WebView2: ${voices.length ? voices.join(', ') : 'none'}`);

    if (voices.length === 0) {
      await panel.getByText(/no speech voices/).waitFor();
      assert.equal(await panel.getByRole('button', { name: 'Read aloud' }).count(), 0);
      await app.screenshot('notes-read-aloud-no-voices');
      return;
    }

    // Speech never starts without somewhere to play it, as on a CI runner with no sound card.
    const speakers = await page.evaluate(async () => {
      try {
        const devices = await navigator.mediaDevices?.enumerateDevices?.();
        return devices ? devices.filter((d) => d.kind === 'audiooutput').length : -1;
      } catch {
        return -1;
      }
    });
    if (speakers === 0 || process.env.LORECRAFT_E2E_NO_AUDIO) {
      t.skip('no audio output device');
      return;
    }

    const voiceBox = panel.getByRole('combobox', { name: 'Voice' });
    assert.ok((await voiceBox.locator('option').count()) > voices.length, 'every voice and the default');
    await voiceBox.selectOption({ index: 1 });
    await panel.getByRole('combobox', { name: 'Speed' }).selectOption('2');

    await page.locator('.ProseMirror').click();
    await page.keyboard.press('Control+Home');
    await panel.getByRole('button', { name: 'Read aloud' }).click();
    await page.locator('.prose-reading', { hasText: 'One short sentence here.' }).waitFor();
    await app.screenshot('notes-read-aloud');
    await panel.getByRole('button', { name: 'Pause' }).click();
    await panel.getByRole('button', { name: 'Resume' }).click();
    await page.locator('.prose-reading', { hasText: 'Another short sentence follows it.' }).waitFor({ timeout: 15000 });
    await panel.getByRole('button', { name: 'Stop' }).click();
    await page.locator('.prose-reading').waitFor({ state: 'detached' });
    await panel.getByRole('button', { name: 'Read aloud' }).waitFor();

    // The selection alone, through to the end by itself.
    await selectWords(page, 'A third one');
    await panel.getByRole('button', { name: 'Read aloud' }).click();
    await page.locator('.prose-reading', { hasText: 'A third one' }).waitFor();
    await page.locator('.prose-reading').waitFor({ state: 'detached', timeout: 15000 });
    await panel.getByRole('button', { name: 'Read aloud' }).waitFor();
    assert.equal(await page.locator('.ProseMirror').getByText('One short sentence here.').count(), 1, 'the text is untouched');
  });
});
