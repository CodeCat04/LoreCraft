/**
 * What happens when the working copy cannot be written, as on a full disk, and when a
 * document holds something this version cannot show. `app.e2eFailWrites` makes chosen
 * methods fail the way a full disk would. In both cases the writer's text must survive.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { answerNextDialog, createProject, createWorkspace, launch, rpc, waitUntil } from './harness.mjs';

const EDITOR = '.ProseMirror[contenteditable="true"]';
const NOT_SAVED = 'Not saved yet, trying again';

const failWrites = (page, methods) => rpc(page, 'app.e2eFailWrites', { methods });

function unwrittenStatus(page) {
  return page.locator('[data-status="unwritten"]');
}

async function homeStored(page) {
  return JSON.stringify(await rpc(page, 'pages.home'));
}

async function firstScene(page) {
  const [book] = await rpc(page, 'books.list');
  const rows = await rpc(page, 'nodes.tree', { bookId: book.id });
  return rows.find((r) => r.kind === 'scene') ?? rows.find((r) => r.parentId !== null);
}

/** A document from a newer LoreCraft, holding a kind of block this version has never seen. */
const fromNewerVersion = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Mira opened the gate.' }] },
    {
      type: 'spellCircle',
      attrs: { power: 3 },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The circle hummed.' }] }],
    },
  ],
};

describe('saving', () => {
  let workspace;
  let app;

  beforeEach(() => {
    workspace = createWorkspace();
  });

  afterEach(async (t) => {
    if (t.passed === false && app && !app.exited) await app.screenshot('saving-last-failure').catch(() => {});
    if (app && !app.exited) await app.kill().catch(() => {});
    workspace.cleanup();
  });

  async function start(name) {
    app = await launch(workspace);
    const page = app.page;
    const problems = [];
    page.on('pageerror', (e) => problems.push(e.message));
    app.problems = problems;
    await createProject(page, name);
    return page;
  }

  /** The "could not be stored" question: checks it names what, then answers it. */
  async function answerUnwritten(page, answer) {
    const dialog = page.getByRole('alertdialog');
    await dialog.getByRole('heading', { name: 'Some changes could not be stored' }).waitFor();
    const message = await dialog.getByTestId('unwritten-message').innerText();
    assert.match(message, /could not store: .*the page “[^”]+”/);
    assert.match(message, /the title of “[^”]+”/);
    assert.match(await dialog.innerText(), /not enough space/);
    await dialog.getByRole('button', { name: answer }).click();
    await dialog.waitFor({ state: 'detached' });
  }

  it('keeps what was typed in a page through failed writes, and Save, Close and Exit stop until it is stored', async () => {
    const page = await start('Disk World');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.locator(EDITOR);
    await editor.waitFor();
    const oldTitle = (await rpc(page, 'pages.home')).title;
    await failWrites(page, ['pages.update', 'pages.rename']);

    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' The well runs dry in summer.');
    await page.getByLabel('Summary').fill('A village by the well');
    const title = page.getByLabel('Page title');
    await title.fill('Dry Well');
    await title.press('Enter');

    // The status bar says so, and stays while nothing gets through.
    await waitUntil(async () => (await unwrittenStatus(page).innerText().catch(() => '')) === NOT_SAVED, 5000, 'the not saved status');
    await page.waitForTimeout(3500);
    assert.equal(await unwrittenStatus(page).innerText(), NOT_SAVED);
    assert.equal((await homeStored(page)).includes('runs dry'), false);
    // The text is still on screen, after several failed tries.
    assert.match(await editor.innerText(), /The well runs dry in summer\./);
    assert.equal(await page.getByLabel('Summary').inputValue(), 'A village by the well');
    assert.equal(await title.inputValue(), 'Dry Well');
    assert.equal((await rpc(page, 'pages.home')).title, oldTitle);

    // Leaving the page and coming back shows what was typed, not the older stored text.
    await page.getByRole('button', { name: 'Write', exact: true }).click();
    await page.locator('.write-page').waitFor();
    await page.getByRole('button', { name: 'Wiki', exact: true }).click();
    await page.locator('.wiki-body').getByText('The well runs dry in summer.', { exact: false }).waitFor();
    await page.locator('.wiki-summary').getByText('A village by the well').waitFor();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await editor.waitFor();
    assert.equal(await title.inputValue(), 'Dry Well');

    // Saving stops and says why. Nothing is asked about where to save.
    await page.keyboard.press('Control+s');
    await answerUnwritten(page, 'Keep editing');
    assert.equal((await rpc(page, 'project.status')).path, null);

    // So does closing the project.
    await page.getByRole('menuitem', { name: 'File' }).click();
    await page.getByRole('menuitem', { name: 'Close project' }).click();
    await answerUnwritten(page, 'Keep editing');
    await page.locator('.topbar').waitFor();
    assert.match(await editor.innerText(), /The well runs dry in summer\./);

    // And so does leaving the app.
    await page.getByRole('menuitem', { name: 'File' }).click();
    await page.getByRole('menuitem', { name: 'Exit' }).click();
    await answerUnwritten(page, 'Keep editing');
    await page.waitForTimeout(500);
    assert.equal(app.exited, false);
    assert.equal((await homeStored(page)).includes('runs dry'), false);

    // Once writing works again, "Try again" stores it and the save goes on.
    await page.keyboard.press('Control+s');
    const dialog = page.getByRole('alertdialog');
    await dialog.getByRole('heading', { name: 'Some changes could not be stored' }).waitFor();
    await failWrites(page, []);
    const path = workspace.file('disk.lorecraft');
    await answerNextDialog(page, path);
    await dialog.getByRole('button', { name: 'Try again' }).click();
    await waitUntil(() => existsSync(path), 10000, 'the project to be saved');
    const stored = await rpc(page, 'pages.home');
    assert.match(JSON.stringify(stored.content), /The well runs dry in summer\./);
    assert.equal(stored.summary, 'A village by the well');
    assert.equal(stored.title, 'Dry Well');
    await waitUntil(async () => (await unwrittenStatus(page).count()) === 0, 5000, 'the status to clear');
    await waitUntil(async () => /All changes saved/.test(await page.getByTestId('save-state').innerText()), 5000, 'the saved state');
    assert.deepEqual(app.problems, []);
  });

  it('keeps a scene through failed writes, even after leaving it, and stores it once writes work', async () => {
    const page = await start('Scene World');
    await page.getByRole('button', { name: 'Write', exact: true }).click();
    const editor = page.locator(EDITOR);
    await editor.waitFor();
    const scene = await firstScene(page);
    await failWrites(page, ['nodes.update']);

    await editor.click();
    await page.keyboard.type('Rain on the tower roof.');
    await waitUntil(async () => (await unwrittenStatus(page).innerText().catch(() => '')) === NOT_SAVED, 5000, 'the not saved status');

    // Leaving the scene and coming back shows what was typed, not the older stored text.
    await page.getByRole('button', { name: 'Wiki', exact: true }).click();
    await page.locator('.wiki-page').waitFor();
    await page.getByRole('button', { name: 'Write', exact: true }).click();
    await editor.waitFor();
    await waitUntil(async () => /Rain on the tower roof\./.test(await editor.innerText()), 5000, 'the typed text to show again');
    const before = await rpc(page, 'nodes.get', { id: scene.id });
    assert.equal(JSON.stringify(before.content).includes('Rain on the tower'), false);

    // It carries on from there, and everything reaches the file once writes work.
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' Then thunder.');
    await failWrites(page, []);
    await waitUntil(
      async () => /Rain on the tower roof\. ?Then thunder\./.test(JSON.stringify((await rpc(page, 'nodes.get', { id: scene.id })).content)),
      40000,
      'the scene to be stored',
    );
    await waitUntil(async () => (await unwrittenStatus(page).count()) === 0, 5000, 'the status to clear');
    assert.deepEqual(app.problems, []);
  });

  it('shows text from a newer version read-only in pages, talk and scenes, and never changes it', async () => {
    const page = await start('Future World');
    const home = await rpc(page, 'pages.home');
    const scene = await firstScene(page);
    await rpc(page, 'nodes.update', { id: scene.id, patch: { content: fromNewerVersion } });
    // Not from the editor, so the open page reloads to show it.
    await rpc(page, 'pages.update', { id: home.id, patch: { content: fromNewerVersion, notes: fromNewerVersion } });

    const note = page.locator('.wiki-body [data-testid="unreadable-note"]');
    await note.waitFor();
    assert.match(
      await note.innerText(),
      /This text uses something this version of LoreCraft can't show\. Update LoreCraft to edit it\. Nothing here will be changed\./,
    );
    await page.locator('.wiki-body').getByText('Mira opened the gate.').waitFor();
    await page.locator('.wiki-body').getByText('The circle hummed.').waitFor();

    // Edit leaves it read-only, and typing changes nothing that is stored.
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.locator('.wiki-body .ProseMirror[contenteditable="false"]').waitFor();
    assert.equal(await page.locator(`.wiki-body ${EDITOR}`).count(), 0);
    await page.locator('.wiki-body').getByText('Mira opened the gate.').click();
    await page.keyboard.type('xyz');
    await page.waitForTimeout(1200);

    // The talk page is read-only too.
    await page.getByRole('button', { name: 'Talk', exact: true }).click();
    await page.locator('.wiki-talk [data-testid="unreadable-note"]').waitFor();
    assert.equal(await page.locator(`.wiki-talk ${EDITOR}`).count(), 0);

    // And so is the scene.
    await page.getByRole('button', { name: 'Write', exact: true }).click();
    await page.locator('.write-page [data-testid="unreadable-note"]').waitFor();
    await page.locator('.write-page').getByText('The circle hummed.').waitFor();
    assert.equal(await page.locator(`.write-page ${EDITOR}`).count(), 0);
    await page.locator('.write-page').getByText('Mira opened the gate.').click();
    await page.keyboard.type('xyz');
    await page.waitForTimeout(1200);

    const storedPage = await rpc(page, 'pages.get', { id: home.id });
    assert.deepEqual(storedPage.content, fromNewerVersion);
    assert.deepEqual(storedPage.notes, fromNewerVersion);
    const storedScene = await rpc(page, 'nodes.get', { id: scene.id });
    assert.deepEqual(storedScene.content, fromNewerVersion);
    await app.screenshot('saving-newer-version');
  });
});
