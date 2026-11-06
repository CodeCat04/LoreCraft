/**
 * No single click destroys work: "Don't save", Discard on the recovery screen and an
 * unreadable settings file all keep what they replace, through the real app.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { allowPath, createProject, createWorkspace, launch, rpc, waitUntil } from './harness.mjs';

describe('discard', () => {
  let workspace;
  let app;

  beforeEach(() => {
    workspace = createWorkspace();
  });

  afterEach(async () => {
    if (app && !app.exited) await app.kill().catch(() => {});
    workspace.cleanup();
  });

  async function openMenuItem(page, menu, item) {
    await page.locator('.menu-title', { hasText: new RegExp(`^${menu}$`) }).click();
    await page.getByRole('menuitem', { name: item }).click();
  }

  const saveState = (page) => page.getByTestId('save-state').innerText();

  function discardedRow(page) {
    return page.getByTestId('backup-row').filter({ hasText: 'Changes you chose not to save' });
  }

  it("keeps the changes after Don't save, and Restore brings them back", async () => {
    app = await launch(workspace);
    const { page } = app;
    const path = workspace.file('world.lorecraft');
    await createProject(page, 'Discard World');
    await allowPath(page, path);
    await rpc(page, 'project.saveAs', { path });
    await waitUntil(async () => /All changes saved/.test(await saveState(page)), 5000, 'the save');
    await rpc(page, 'pages.create', { title: 'Second thoughts' });
    await waitUntil(async () => (await rpc(page, 'project.status')).dirty, 5000, 'unsaved work');
    const saved = readFileSync(path);

    await openMenuItem(page, 'File', /^Close project/);
    await page.getByRole('heading', { name: /Save changes/ }).waitFor();
    await page.getByRole('button', { name: "Don't save" }).click();
    await page.getByRole('heading', { name: 'LoreCraft' }).waitFor();
    assert.deepEqual(readFileSync(path), saved, 'the file did not change');

    await page.getByRole('button', { name: /^world/ }).first().click();
    await page.locator('.topbar').waitFor();
    assert.equal(await rpc(page, 'pages.getByTitle', { title: 'Second thoughts' }), null);

    await openMenuItem(page, 'File', /^Backups/);
    await page.getByTestId('backups').waitFor();
    const row = discardedRow(page);
    await row.waitFor();
    assert.match(await row.innerText(), /kept until/);
    await app.screenshot('discard-backups');
    await row.getByRole('button', { name: /^Restore/ }).click();
    await page.getByRole('heading', { name: 'Restore this backup?' }).waitFor();
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await page.getByTestId('backups').waitFor({ state: 'detached' });

    assert.ok(await rpc(page, 'pages.getByTitle', { title: 'Second thoughts' }), 'the changes are back');
    const status = await rpc(page, 'project.status');
    assert.equal(status.path, path);
    assert.equal(status.dirty, true, 'and wait for a save');
  });

  it('keeps work discarded on the recovery screen, even from a project never saved', async () => {
    app = await launch(workspace);
    await createProject(app.page, 'Crash World');
    await rpc(app.page, 'pages.create', { title: 'Lost and found' });
    await waitUntil(async () => (await rpc(app.page, 'project.status')).dirty, 5000, 'unsaved work');
    await app.kill();

    app = await launch(workspace);
    const { page } = app;
    await page.getByRole('heading', { name: 'Recover your work?' }).waitFor();
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    const sure = page.getByRole('alertdialog');
    await sure.getByText(/where you can get it back for 14 days/).waitFor();
    await sure.getByRole('button', { name: 'Discard', exact: true }).click();
    await page.getByRole('heading', { name: 'LoreCraft' }).waitFor();
    assert.deepEqual(await rpc(page, 'project.listRecoverable'), []);

    await page.getByRole('button', { name: 'Backups', exact: true }).click();
    await page.getByTestId('backups').waitFor();
    const row = discardedRow(page);
    await row.waitFor();
    assert.match(await row.innerText(), /Crash World/);
    await row.getByRole('button', { name: /^Open a copy/ }).click();
    await page.getByTestId('backups').waitFor({ state: 'detached' });
    await page.locator('.topbar').waitFor();
    assert.ok(await rpc(page, 'pages.getByTitle', { title: 'Lost and found' }), 'the work is back');
    assert.equal((await rpc(page, 'project.status')).name, 'Crash World (backup copy)');
  });

  it('keeps an unreadable settings file aside, uses the backup, and says so', async () => {
    app = await launch(workspace);
    await rpc(app.page, 'settings.update', { patch: { save: { backupsToKeep: 7 } } });
    await rpc(app.page, 'settings.update', { patch: { save: { backupsToKeep: 8 } } });
    await app.kill();
    const settingsFile = join(workspace.dataDir, 'settings.json');
    assert.ok(existsSync(`${settingsFile}.bak`), 'the previous version is kept');
    writeFileSync(settingsFile, '{ "save": { "backupsToKe');

    app = await launch(workspace);
    const { page } = app;
    await page.getByText(/Your settings file could not be read, so LoreCraft went back to its backup copy/).waitFor();
    const settings = await rpc(page, 'settings.get');
    assert.equal(settings.save.backupsToKeep, 7, 'the backup, not the defaults');
    const broken = readdirSync(workspace.dataDir).filter((name) => name.startsWith('settings.broken-'));
    assert.equal(broken.length, 1);
    assert.equal(readFileSync(join(workspace.dataDir, broken[0]), 'utf8'), '{ "save": { "backupsToKe');
  });
});
