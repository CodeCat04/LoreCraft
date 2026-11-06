import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { allowPath, answerNextDialog, createProject, createWorkspace, launch, rpc, waitUntil } from './harness.mjs';

const EDITOR = '.ProseMirror[contenteditable="true"]';

function row(page, title) {
  return page.getByRole('treeitem', { name: new RegExp(`^${title},`) });
}

function docOf(...texts) {
  return { type: 'doc', content: texts.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })) };
}

async function runFromPalette(page, name) {
  await page.keyboard.press('Control+k');
  const input = page.getByPlaceholder('Search pages and commands…');
  await waitUntil(() => input.evaluate((el) => el === document.activeElement), 2000, 'the palette to open');
  await page.waitForTimeout(30);
  await input.fill(name);
  await page.getByRole('option', { name }).first().waitFor();
  await page.keyboard.press('Enter');
}

function textOf(doc) {
  return (doc?.content ?? []).map((block) => (block.content ?? []).map((run) => run.text ?? '').join('')).join('\n');
}

async function storedText(page, id) {
  return textOf((await rpc(page, 'nodes.get', { id })).content);
}

describe('history', () => {
  let workspace;
  let app;

  beforeEach(() => {
    workspace = createWorkspace();
  });

  afterEach(async (t) => {
    if (t.passed === false && app && !app.exited) await app.screenshot('history-last-failure').catch(() => {});
    if (app && !app.exited) await app.kill().catch(() => {});
    workspace.cleanup();
  });

  async function start() {
    app = await launch(workspace);
    const page = app.page;
    const problems = [];
    page.on('pageerror', (e) => problems.push(e.message));
    app.problems = problems;
    await createProject(page, 'History World');
    await page.getByRole('button', { name: 'Write', exact: true }).click();
    await page.locator(EDITOR).waitFor();
    const [book] = await rpc(page, 'books.list');
    const rows = await rpc(page, 'nodes.tree', { bookId: book.id });
    return {
      page,
      bookId: book.id,
      scene: rows.find((r) => r.kind === 'scene'),
      chapter: rows.find((r) => r.kind === 'chapter'),
    };
  }

  it("shows a scene's history, compares a version with the current text, and restores it", async () => {
    const { page, scene } = await start();
    await rpc(page, 'nodes.update', { id: scene.id, patch: { content: docOf('The first draft.') } });
    await page.locator(EDITOR).getByText('The first draft.').waitFor();
    await rpc(page, 'revisions.checkpoint', { kind: 'node', id: scene.id });
    await rpc(page, 'nodes.update', { id: scene.id, patch: { content: docOf('The second draft.') } });
    await page.locator(EDITOR).getByText('The second draft.').waitFor();

    await runFromPalette(page, 'Scene history');
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('heading', { name: 'History of “Scene 1”' }).waitFor();
    await dialog.getByRole('cell', { name: 'Checkpoint', exact: true }).waitFor();

    // The comparison is the wiki's, against the current text.
    await dialog.getByRole('button', { name: /^Compare the version from/ }).first().click();
    const diff = dialog.locator('.wiki-diff-body');
    await diff.locator('del', { hasText: 'first' }).waitFor();
    await diff.locator('ins', { hasText: 'second' }).waitFor();
    await app.screenshot('history-scene-compare');

    // An old version can be read as it was.
    await dialog.getByRole('button', { name: /^View the version from/ }).first().click();
    await dialog.getByText('It may differ from the current scene.', { exact: false }).waitFor();
    await dialog.locator('.wiki-old-version').getByText('The first draft.').waitFor();

    // Restoring saves the current text first, so the restore can itself be undone.
    await dialog.getByRole('button', { name: /^Restore the version from/ }).first().click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Restore', exact: true }).click();
    await page.getByText('Restored that version.').waitFor();
    await page.locator(EDITOR).getByText('The first draft.').waitFor();
    assert.equal(await page.getByRole('heading', { name: 'History of “Scene 1”' }).count(), 0, 'the dialog closes');
    assert.equal(await storedText(page, scene.id), 'The first draft.');
    const [newest] = await rpc(page, 'revisions.list', { kind: 'node', id: scene.id });
    assert.equal(newest.reason, 'restore');
    assert.equal(textOf((await rpc(page, 'revisions.get', { id: newest.id })).content), 'The second draft.');

    // The scene's menu opens it too.
    await row(page, 'Scene 1').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'History…' }).click();
    await page.getByRole('dialog').getByRole('cell', { name: 'Before a restore', exact: true }).waitFor();
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).last().click();
    assert.deepEqual(app.problems, []);
  });

  it('points from a merge to the history, and undoing it does not repeat the text', async () => {
    const { page, bookId, scene, chapter } = await start();
    await rpc(page, 'nodes.update', { id: scene.id, patch: { content: docOf('Alpha one.') } });
    const second = await rpc(page, 'nodes.create', { bookId, parentId: chapter.id, kind: 'scene', title: 'Second', afterId: scene.id });
    await rpc(page, 'nodes.update', { id: second.id, patch: { content: docOf('Bravo two.') } });
    await row(page, 'Second').waitFor();
    await row(page, 'Scene 1').click();
    await page.locator(EDITOR).getByText('Alpha one.').waitFor();

    await page.locator(EDITOR).click();
    await page.keyboard.press('Control+Alt+m');
    await page.locator(EDITOR).getByText('Bravo two.').waitFor();
    assert.equal(await storedText(page, scene.id), 'Alpha one.\nBravo two.');

    // The toast leads to the history, where the text from before the merge is.
    await page.getByRole('button', { name: 'Show history' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('cell', { name: 'Before a merge', exact: true }).first().waitFor();
    await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();

    // Undo brings the scene back and takes its text back out of the other.
    await page.locator('.binder-undo').getByRole('button', { name: 'Undo' }).click();
    await waitUntil(async () => (await storedText(page, scene.id)) === 'Alpha one.', 5000, 'the merged text to leave');
    const back = await rpc(page, 'nodes.get', { id: second.id });
    assert.equal(back.deletedAt, null);
    assert.equal(textOf(back.content), 'Bravo two.');
    assert.equal((await rpc(page, 'search.query', { q: 'Bravo' })).length, 1, 'its words are in one place');
    await row(page, 'Second').waitFor();
    assert.deepEqual(app.problems, []);
  });

  it('undoes a project-wide replace, except where the text was edited since', async () => {
    const { page, scene } = await start();
    const notes = await rpc(page, 'pages.create', { title: 'Notes' });
    await rpc(page, 'pages.update', { id: notes.id, patch: { content: docOf('The ember gate opens.') } });
    const other = await rpc(page, 'pages.create', { title: 'Other' });
    await rpc(page, 'pages.update', { id: other.id, patch: { content: docOf('Past the ember gate.') } });
    await rpc(page, 'nodes.update', { id: scene.id, patch: { content: docOf('She ran to the ember gate.') } });

    await page.keyboard.press('Control+Shift+F');
    await page.getByRole('heading', { name: 'Find and replace' }).waitFor();
    await page.getByLabel('Find', { exact: true }).fill('ember');
    await page.getByLabel('Replace with').fill('iron');
    await page.getByLabel('Find', { exact: true }).press('Enter');
    await page.getByRole('region', { name: 'Preview' }).getByText('3 matches in 3 documents').waitFor();
    await page.getByRole('button', { name: 'Replace 3 matches' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Replace' }).click();
    await page.getByText('Replaced 3 matches in 3 documents').waitFor();

    // Someone carries on writing in one of them first.
    await rpc(page, 'pages.update', { id: other.id, patch: { content: docOf('Past the iron gate, and on.') } });
    await page.getByRole('status').filter({ hasText: 'Replaced 3 matches' }).getByRole('button', { name: 'Undo' }).click();
    await page.getByText(/Undone, except for “Other”/).waitFor();
    assert.equal(textOf((await rpc(page, 'pages.get', { id: notes.id })).content), 'The ember gate opens.');
    assert.equal(await storedText(page, scene.id), 'She ran to the ember gate.');
    assert.equal(textOf((await rpc(page, 'pages.get', { id: other.id })).content), 'Past the iron gate, and on.');
    assert.deepEqual(app.problems, []);
  });

  it('undoes an import: what it made goes to the trash', async () => {
    const { page } = await start();
    const path = workspace.file('ember-gate.md');
    writeFileSync(path, '# Ember Gate\n\nThe gate burns at night.\n');
    await page.getByRole('menuitem', { name: 'File' }).click();
    await page.getByRole('menuitem', { name: 'Import…', exact: true }).click();
    await page.getByRole('heading', { name: 'Import', exact: true }).waitFor();
    await answerNextDialog(page, path);
    await page.getByRole('button', { name: 'Choose file…' }).click();
    await page.getByTestId('import-preview').waitFor({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    const result = page.getByTestId('import-result');
    await result.waitFor({ timeout: 60_000 });
    const made = (await rpc(page, 'pages.list', {})).find((p) => /ember/i.test(p.title));
    assert.ok(made?.id, 'the import made the page');

    await result.getByRole('button', { name: 'Undo this import' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Undo the import' }).click();
    await page.getByText('Undone.', { exact: true }).waitFor();
    const trash = await rpc(page, 'pages.list', { deleted: true });
    assert.ok(trash.some((p) => p.id === made.id), 'it is in the trash, not gone');
    assert.deepEqual(app.problems, []);
  });

  it('undoes a split so the text comes back exactly', async () => {
    const { page, scene } = await start();
    await rpc(page, 'nodes.update', { id: scene.id, patch: { content: docOf('One two three.') } });
    await page.locator(EDITOR).getByText('One two three.').waitFor();
    await page.locator(EDITOR).click();
    await page.keyboard.press('Control+Home');
    for (let i = 0; i < 'One tw'.length; i += 1) await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(50);
    await page.keyboard.press('Control+Alt+s');
    await waitUntil(async () => (await page.getByLabel('Scene title').inputValue()) === 'Scene 1 (continued)', 5000, 'the split');
    assert.equal(await storedText(page, scene.id), 'One tw');

    await page.locator('.binder-undo').getByRole('button', { name: 'Undo' }).click();
    await waitUntil(async () => (await storedText(page, scene.id)) === 'One two three.', 5000, 'the whole text back');
    const stored = await rpc(page, 'nodes.get', { id: scene.id });
    assert.equal(stored.content.content.length, 1, 'one paragraph again, not two');
    assert.deepEqual(app.problems, []);
  });

  it('changes how long this project keeps history in Settings, and the change is still there after reopening', async () => {
    const { page } = await start();
    const openSaving = async () => {
      await page.keyboard.press('Control+,');
      await page.getByRole('tab', { name: 'Saving' }).click();
      await waitUntil(async () => (await page.getByTestId('retention-keepAllDays').inputValue()) !== '', 3000, 'the stored values');
    };
    await openSaving();
    assert.equal(await page.getByTestId('retention-keepAllDays').inputValue(), '14');
    await page.getByText('checkpoints you make yourself, are always kept', { exact: false }).waitFor();

    // A daily period shorter than the full one is refused before anything is sent.
    await page.getByTestId('retention-keepAllDays').fill('30');
    await page.getByTestId('retention-dailyForDays').fill('20');
    assert.equal(await page.getByTestId('retention-save').isDisabled(), true);
    await page.getByTestId('retention-dailyForDays').fill('200');
    await page.getByTestId('retention-keepLatest').fill('25');
    await page.getByTestId('retention-save').click();
    await waitUntil(async () => (await rpc(page, 'revisions.retention')).keepLatest === 25, 3000, 'the change to be stored');

    const path = workspace.file('retention.lorecraft');
    await allowPath(page, path);
    await rpc(page, 'project.saveAs', { path });
    await rpc(page, 'project.close');
    await page.getByRole('heading', { name: 'LoreCraft' }).waitFor();
    await rpc(page, 'project.open', { path });
    await page.locator('.topbar').waitFor();

    await openSaving();
    assert.equal(await page.getByTestId('retention-keepAllDays').inputValue(), '30');
    assert.equal(await page.getByTestId('retention-dailyForDays').inputValue(), '200');
    assert.equal(await page.getByTestId('retention-keepLatest').inputValue(), '25');
    assert.equal(await page.getByTestId('retention-enabled').isChecked(), true);
    assert.deepEqual(app.problems, []);
  });
});
