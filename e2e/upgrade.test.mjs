import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { answerNextDialog, createWorkspace, launch, rpc, waitUntil } from './harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Made by LoreCraft 0.1.0. Tests copy it and never open it in place. */
const SAMPLE = join(ROOT, 'src-tauri', 'testdata', 'projects', 'sample-0.1.0.lorecraft');

describe('upgrade', () => {
  let workspace;
  let app;

  beforeEach(() => {
    workspace = createWorkspace();
  });

  afterEach(async () => {
    if (app && !app.exited) await app.kill().catch(() => {});
    workspace.cleanup();
  });

  /** Opens `file` from the start screen, the way a person would. */
  async function openFromStart(path) {
    await app.page.getByRole('heading', { name: 'LoreCraft' }).waitFor();
    await answerNextDialog(app.page, path);
    await app.page.getByRole('button', { name: 'Open project…' }).click();
  }

  it('opens a project 0.1.0 saved, keeps an edit through a force-close, and leaves the file alone', async () => {
    const file = workspace.file('Saltmarsh.lorecraft');
    copyFileSync(SAMPLE, file);
    const original = readFileSync(file);

    app = await launch(workspace);
    await openFromStart(file);
    await app.page.locator('.topbar').waitFor();
    const aria = await rpc(app.page, 'pages.getByTitle', { title: 'Aria Vell' });
    assert.equal(aria.infobox.caption, 'Aria on the harbour wall');
    assert.ok(JSON.stringify(aria.content).includes('"type":"figure"'));

    // An edit, typed in the editor, then a crash before any save.
    const line = 'The tide turned at noon';
    await app.page.getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = app.page.locator('.ProseMirror[contenteditable="true"]');
    await editor.click();
    await app.page.keyboard.press('Control+End');
    await app.page.keyboard.type(line);
    await waitUntil(async () => JSON.stringify((await rpc(app.page, 'pages.home')).content).includes(line), 5000, 'the edit to be stored');
    await app.kill();
    assert.deepEqual(readFileSync(file), original, 'opening and upgrading do not touch the file');

    app = await launch(workspace);
    await app.page.getByRole('heading', { name: 'Recover your work?' }).waitFor();
    await app.page.getByRole('button', { name: 'Recover' }).click();
    await app.page.locator('.topbar').waitFor();
    await app.page.getByText(line).waitFor();
    const comments = await rpc(app.page, 'comments.list');
    assert.equal(comments.length, 2);
    const minimum = await rpc(app.page, 'project.getMeta', { key: 'min_reader_version' });
    assert.equal(minimum, '0.1.0');
    assert.deepEqual(readFileSync(file), original, 'recovering does not touch it either');
  });

  it('refuses a project from a newer LoreCraft, names the version it needs, and leaves the file alone', async () => {
    const file = workspace.file('Future.lorecraft');
    copyFileSync(SAMPLE, file);
    const db = new DatabaseSync(file);
    db.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('min_reader_version', '99.0.0'), ('written_by_version', '99.0.2')",
    );
    db.close();
    const before = readFileSync(file);

    app = await launch(workspace);
    await openFromStart(file);
    const toast = app.page.locator('.toasts').getByText(/saved by LoreCraft 99\.0\.2/);
    await toast.waitFor();
    assert.match(await toast.innerText(), /which added things this version can't read\. Update LoreCraft to 99\.0 or later to open it\./);
    await app.screenshot('upgrade-too-new');
    assert.equal(await app.page.locator('.topbar').count(), 0, 'still on the start screen');
    assert.deepEqual(readFileSync(file), before);
  });

  it('says a damaged project is damaged, not that it is something else', async () => {
    const file = workspace.file('Wiped.lorecraft');
    writeFileSync(file, Buffer.alloc(8192));
    app = await launch(workspace);
    await openFromStart(file);
    const toast = app.page.locator('.toasts').getByText(/Wiped\.lorecraft is damaged/);
    await toast.waitFor();
    assert.match(await toast.innerText(), /An earlier save may be in Backups\.$/);
  });
});
