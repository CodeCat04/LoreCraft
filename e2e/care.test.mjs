/**
 * Backups, help and writing comfort, through the real app.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';

import { allowPath, answerNextDialog, createProject, createWorkspace, launch, rpc, waitUntil } from './harness.mjs';

describe('care', () => {
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

  function saveState(page) {
    return page.getByTestId('save-state').innerText();
  }

  async function savedProject(page, path) {
    await allowPath(page, path);
    await rpc(page, 'project.saveAs', { path });
    await waitUntil(async () => /All changes saved/.test(await saveState(page)), 5000, 'the save to finish');
  }

  describe('backups', () => {
    /** A saved project holding the page "First", then later unsaved or saved pages. */
    async function projectWithABackup(page, path) {
      await createProject(page, 'Backup World');
      await rpc(page, 'pages.create', { title: 'First' });
      await savedProject(page, path);
      await rpc(page, 'pages.create', { title: 'Second' });
      await page.keyboard.press('Control+s');
      await waitUntil(async () => (await rpc(page, 'project.listBackups')).length === 1, 5000, 'the first backup');
    }

    async function openBackupsScreen(page) {
      await openMenuItem(page, 'File', /^Backups/);
      await page.getByTestId('backups').waitFor();
    }

    it('lists backups, opens one as a copy, and overwrites nothing', async () => {
      app = await launch(workspace);
      const { page } = app;
      const path = workspace.file('world.lorecraft');
      await projectWithABackup(page, path);
      const before = readFileSync(path);

      await openBackupsScreen(page);
      const rows = page.getByTestId('backup-row');
      await rows.first().waitFor();
      assert.equal(await rows.count(), 1);
      const row = await rows.first().innerText();
      assert.match(row, /\d+ KB/, 'shows the size');
      assert.match(row, /just now|minute/, 'shows the time');
      await app.screenshot('care-backups');

      const backup = (await rpc(page, 'project.listBackups'))[0];
      const backupBytes = readFileSync(backup.path);

      await rows.first().getByRole('button', { name: /^Open a copy/ }).click();
      await page.getByTestId('backups').waitFor({ state: 'detached' });
      await page.getByText(/Your project and its backups have not changed/).waitFor();

      const status = await rpc(page, 'project.status');
      assert.equal(status.name, 'world (backup copy)');
      assert.equal(status.path, null);
      assert.equal(status.dirty, true);
      assert.match(await saveState(page), /Not saved to a file yet/);
      assert.ok(await rpc(page, 'pages.getByTitle', { title: 'First' }));
      assert.equal(await rpc(page, 'pages.getByTitle', { title: 'Second' }), null, 'this is the older version');

      assert.deepEqual(readFileSync(path), before, 'the project file did not change');
      assert.deepEqual(readFileSync(backup.path), backupBytes, 'the backup did not change');

      // Saving the copy asks where, and the suggested name is the copy's own.
      const copy = workspace.file('copy.lorecraft');
      await answerNextDialog(page, copy);
      await page.keyboard.press('Control+s');
      await waitUntil(() => existsSync(copy), 5000, 'the copy to save where asked');
      assert.deepEqual(readFileSync(path), before, 'saving the copy did not touch the original');
    });

    it('asks before restoring, and keeps the current state as another backup', async () => {
      app = await launch(workspace);
      const { page } = app;
      const path = workspace.file('world.lorecraft');
      await projectWithABackup(page, path);
      await rpc(page, 'pages.create', { title: 'Unsaved' });
      const saved = readFileSync(path);

      await openBackupsScreen(page);
      await page.getByTestId('backup-row').first().getByRole('button', { name: /^Restore/ }).click();

      // Saying no changes nothing.
      await page.getByRole('heading', { name: 'Restore this backup?' }).waitFor();
      await app.screenshot('care-restore-confirm');
      await page.getByRole('button', { name: 'Cancel' }).click();
      assert.ok(await rpc(page, 'pages.getByTitle', { title: 'Unsaved' }));
      assert.equal((await rpc(page, 'project.listBackups')).length, 1);

      await page.getByTestId('backup-row').first().getByRole('button', { name: /^Restore/ }).click();
      await page.getByRole('heading', { name: 'Restore this backup?' }).waitFor();
      await page.getByRole('button', { name: 'Restore', exact: true }).click();
      await page.getByTestId('backups').waitFor({ state: 'detached' });
      await page.getByText(/What you had before is kept as a backup/).waitFor();

      assert.equal(await rpc(page, 'pages.getByTitle', { title: 'Unsaved' }), null);
      assert.equal(await rpc(page, 'pages.getByTitle', { title: 'Second' }), null);
      assert.ok(await rpc(page, 'pages.getByTitle', { title: 'First' }));

      // The project is still the same file, which waits for a save.
      const status = await rpc(page, 'project.status');
      assert.equal(status.path, path);
      assert.equal(status.dirty, true);
      assert.deepEqual(readFileSync(path), saved);

      const list = await rpc(page, 'project.listBackups');
      assert.equal(list.length, 2);
      assert.equal(list[0].beforeRestore, true);

      // The way back works: open the list again and restore what was kept.
      await openBackupsScreen(page);
      await page.getByText('kept before a restore').waitFor();
      await page.getByTestId('backup-row').first().getByRole('button', { name: /^Restore/ }).click();
      await page.getByRole('button', { name: 'Restore', exact: true }).click();
      await page.getByTestId('backups').waitFor({ state: 'detached' });
      assert.ok(await rpc(page, 'pages.getByTitle', { title: 'Unsaved' }), 'the unsaved page came back');
    });

    it('shows the restored version after restoring with a scene open', async () => {
      app = await launch(workspace);
      const { page } = app;
      await createProject(page, 'Scene World');
      const books = await rpc(page, 'books.list');
      const tree = await rpc(page, 'nodes.tree', { bookId: books[0].id });
      const chapter = tree.find((n) => n.kind === 'chapter');
      const doc = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
      const scene = await rpc(page, 'nodes.create', { bookId: books[0].id, parentId: chapter.id, kind: 'scene', title: 'Kept', content: doc('The older words.') });
      await savedProject(page, workspace.file('scenes.lorecraft'));

      // A later version: the scene changes, and another appears.
      await rpc(page, 'nodes.update', { id: scene.id, patch: { content: doc('The newer words.') } });
      await rpc(page, 'nodes.create', { bookId: books[0].id, parentId: chapter.id, kind: 'scene', title: 'Later', content: doc('Written later.') });
      await page.keyboard.press('Control+s');
      await waitUntil(async () => (await rpc(page, 'project.listBackups')).length === 1, 5000, 'the backup');

      // The scene that will disappear is the one on screen.
      await page.getByRole('button', { name: 'Write', exact: true }).click();
      await page.getByRole('treeitem', { name: /^Later,/ }).click();
      await page.locator('.prose-manuscript').getByText('Written later.').waitFor();

      await openBackupsScreen(page);
      await page.getByTestId('backup-row').first().getByRole('button', { name: /^Restore/ }).click();
      await page.getByRole('button', { name: 'Restore', exact: true }).click();
      await page.getByTestId('backups').waitFor({ state: 'detached' });
      await page.getByText(/What you had before is kept as a backup/).waitFor();

      await page.getByRole('button', { name: 'Write', exact: true }).click();
      assert.equal(await page.getByRole('treeitem', { name: /^Later,/ }).count(), 0, 'the later scene is gone');
      await page.getByRole('treeitem', { name: /^Kept,/ }).click();
      await page.locator('.prose-manuscript').getByText('The older words.').waitFor();
      assert.equal(await page.getByText('This screen hit a problem').count(), 0);
      await app.screenshot('care-restored-scene');

      // Nothing on screen wrote the old version back over the restored one.
      await page.waitForTimeout(800);
      assert.match(JSON.stringify((await rpc(page, 'nodes.get', { id: scene.id })).content), /The older words/);
      assert.equal((await rpc(page, 'nodes.tree', { bookId: books[0].id })).filter((n) => n.title === 'Later').length, 0);
    });

    it('loses nothing to a force-close after a restore or after opening a copy', async () => {
      app = await launch(workspace);
      let { page } = app;
      const path = workspace.file('world.lorecraft');
      await projectWithABackup(page, path);
      await rpc(page, 'pages.create', { title: 'Unsaved' });

      await openBackupsScreen(page);
      await page.getByTestId('backup-row').first().getByRole('button', { name: /^Restore/ }).click();
      await page.getByRole('button', { name: 'Restore', exact: true }).click();
      await page.getByTestId('backups').waitFor({ state: 'detached' });
      await rpc(page, 'pages.create', { title: 'After the restore' });
      await app.kill();

      // The restored project comes back, still tied to its file, with the work done since.
      app = await launch(workspace);
      ({ page } = app);
      await page.getByRole('heading', { name: 'Recover your work?' }).waitFor();
      await page.getByRole('button', { name: 'Recover' }).click();
      await page.locator('.topbar').waitFor();
      let status = await rpc(page, 'project.status');
      assert.equal(status.path, path);
      assert.equal(status.dirty, true);
      assert.ok(await rpc(page, 'pages.getByTitle', { title: 'After the restore' }));
      assert.equal(await rpc(page, 'pages.getByTitle', { title: 'Second' }), null);

      // And so does what the restore replaced, which is waiting among the backups.
      const kept = (await rpc(page, 'project.listBackups')).find((b) => b.beforeRestore);
      assert.ok(kept, 'the state before the restore was kept');
      await rpc(page, 'project.restoreBackup', { path: kept.path });
      assert.ok(await rpc(page, 'pages.getByTitle', { title: 'Unsaved' }));
      assert.ok(await rpc(page, 'pages.getByTitle', { title: 'Second' }));

      // A copy that was never saved also survives, as unsaved work with no file.
      await page.keyboard.press('Control+s');
      await waitUntil(async () => /All changes saved/.test(await saveState(page)), 5000, 'the save');
      const saved = readFileSync(path);
      const oldest = (await rpc(page, 'project.listBackups')).at(-1);
      await rpc(page, 'project.openBackup', { path: oldest.path });
      await rpc(page, 'pages.create', { title: 'Only in the copy' });
      await app.kill();

      app = await launch(workspace);
      ({ page } = app);
      await page.getByRole('heading', { name: 'Recover your work?' }).waitFor();
      await page.getByRole('button', { name: 'Recover' }).click();
      await page.locator('.topbar').waitFor();
      status = await rpc(page, 'project.status');
      assert.equal(status.name, 'world (backup copy)');
      assert.equal(status.path, null);
      assert.ok(await rpc(page, 'pages.getByTitle', { title: 'Only in the copy' }));
      assert.deepEqual(readFileSync(path), saved, 'the project file was never touched');
    });

    it('asks about unsaved work before opening a copy over it', async () => {
      app = await launch(workspace);
      const { page } = app;
      await projectWithABackup(page, workspace.file('world.lorecraft'));
      await rpc(page, 'pages.create', { title: 'Unsaved' });
      await waitUntil(async () => /kept safe/.test(await saveState(page)), 5000, 'the unsaved state');

      await openBackupsScreen(page);
      await page.getByTestId('backup-row').first().getByRole('button', { name: /^Open a copy/ }).click();
      await page.getByRole('heading', { name: /Save changes to/ }).waitFor();
      await page.getByRole('button', { name: 'Cancel' }).click();
      assert.ok(await rpc(page, 'pages.getByTitle', { title: 'Unsaved' }), 'still the same project');
      assert.notEqual((await rpc(page, 'project.status')).dirty, false);
    });

    it('refuses anything outside the backups folder', async () => {
      app = await launch(workspace);
      const { page } = app;
      const path = workspace.file('world.lorecraft');
      await projectWithABackup(page, path);
      const backup = (await rpc(page, 'project.listBackups'))[0];
      const outside = [path, `${backup.path}\\..\\..\\..\\..\\world.lorecraft`, workspace.file('missing.lorecraft')];
      for (const target of outside) {
        for (const method of ['project.openBackup', 'project.restoreBackup']) {
          const answer = await page.evaluate(
            ([m, p]) => window.__TAURI_INTERNALS__.invoke('rpc', { method: m, params: { path: p } }).then(() => 'accepted', (e) => e.code),
            [method, target],
          );
          assert.equal(answer, 'PATH_NOT_ALLOWED', `${method} ${target}`);
        }
      }
      assert.equal((await rpc(page, 'project.status')).path, path, 'the same project is still open');
    });

    it('is reachable from the start screen, for a lost or damaged file', async () => {
      app = await launch(workspace);
      const { page } = app;
      await projectWithABackup(page, workspace.file('world.lorecraft'));
      await page.keyboard.press('Control+s');
      await waitUntil(async () => /All changes saved/.test(await saveState(page)), 5000, 'the save');
      await rpc(page, 'project.close');
      await page.getByRole('heading', { name: 'LoreCraft' }).waitFor();

      await page.getByRole('navigation', { name: 'Help' }).getByRole('button', { name: 'Backups' }).click();
      await page.getByTestId('backups').waitFor();
      const row = page.getByTestId('backup-row').first();
      assert.match(await row.innerText(), /^world/, 'names the project each one came from');
      assert.equal(await row.getByRole('button', { name: /^Restore/ }).count(), 0, 'nothing open to restore into');
      await row.getByRole('button', { name: /^Open a copy/ }).click();
      await page.locator('.topbar').waitFor();
      assert.equal((await rpc(page, 'project.status')).name, 'world (backup copy)');
    });
  });

  describe('help', () => {
    it('F1 opens a searchable list of shortcuts from the command registry', async () => {
      app = await launch(workspace);
      const { page } = app;
      await createProject(page, 'Help World');

      await page.keyboard.press('F1');
      const screen = page.getByTestId('shortcuts');
      await screen.waitFor();
      await app.screenshot('care-shortcuts');

      // Commands from several modules, grouped under their menus.
      for (const heading of ['File', 'View', 'AI', 'Help']) {
        await screen.getByRole('heading', { name: heading, exact: true }).waitFor();
      }
      await screen.getByRole('row', { name: /^Save Ctrl ?S$/ }).waitFor();
      await screen.getByRole('row', { name: /^Keyboard shortcuts F1$/ }).waitFor();

      // Every command with a shortcut is listed, without anyone listing it by hand.
      const registered = await page.evaluate(() => document.querySelectorAll('[data-testid="shortcuts"] tr').length);
      assert.ok(registered > 25, `found ${registered} rows`);

      // They scroll down rather than running off to the side.
      const box = await page.getByTestId('shortcut-scroll').evaluate((el) => ({ wide: el.scrollWidth, room: el.clientWidth, tall: el.scrollHeight, height: el.clientHeight }));
      assert.ok(box.wide <= box.room, `${box.wide} wide in ${box.room}`);
      assert.ok(box.height > 100, 'the list has room');

      const search = screen.getByRole('searchbox', { name: 'Search shortcuts' });
      assert.ok(await search.evaluate((el) => el === document.activeElement), 'search has the keyboard');
      await search.fill('ctrl+shift+s');
      await screen.getByRole('row', { name: /^Save as/ }).waitFor();
      assert.equal(await screen.locator('tr').count(), 1);
      await search.fill('no such shortcut');
      await screen.getByText('No shortcut matches that search.').waitFor();

      // Pressing F1 again does not stack a second copy, and Escape closes it.
      await page.keyboard.press('F1');
      assert.equal(await page.getByTestId('shortcuts').count(), 1);
      await page.keyboard.press('Escape');
      await screen.waitFor({ state: 'detached' });
    });

    it('works on the start screen too, with no project open', async () => {
      app = await launch(workspace);
      const { page } = app;
      await page.getByRole('heading', { name: 'LoreCraft' }).waitFor();
      await app.screenshot('care-start');
      await page.keyboard.press('F1');
      await page.getByTestId('shortcuts').waitFor();
      await page.keyboard.press('Escape');

      await page.getByRole('navigation', { name: 'Help' }).getByRole('button', { name: 'Getting started' }).click();
      await page.getByTestId('getting-started').waitFor();
      await page.getByRole('button', { name: 'Close', exact: true }).click();
    });

    it('shows About with the version, license, data folder and GitHub link', async () => {
      app = await launch(workspace);
      const { page } = app;
      await createProject(page, 'Help World');
      await openMenuItem(page, 'Help', 'About LoreCraft');
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('heading', { name: 'About LoreCraft' }).waitFor();
      await waitUntil(async () => /\d+\.\d+\.\d+/.test(await page.getByTestId('about-version').innerText()), 3000, 'the version');
      const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
      assert.equal(await page.getByTestId('about-version').innerText(), version);
      assert.equal(await page.getByTestId('about-data-dir').innerText(), workspace.dataDir);
      await dialog.getByText('AGPL-3.0-only', { exact: true }).waitFor();
      await dialog.getByRole('button', { name: 'github.com/CodeCat04/LoreCraft' }).waitFor();
      await app.screenshot('care-about');
      await page.keyboard.press('Escape');
    });

    it('shows Getting started from the Help menu, with real shortcuts in its text', async () => {
      app = await launch(workspace);
      const { page } = app;
      await createProject(page, 'Help World');
      await openMenuItem(page, 'Help', 'Getting started');
      const screen = page.getByTestId('getting-started');
      await screen.waitFor();
      await screen.getByText('Ctrl+N', { exact: true }).waitFor();
      await screen.getByText('Ctrl+Shift+A', { exact: true }).waitFor();
      await app.screenshot('care-getting-started');
      await page.keyboard.press('Escape');
    });

    /** Checks what the sample world holds after the import. */
    async function assertSampleWorld(page) {
      await page.locator('.topbar').waitFor();
      await page.getByText(/Opened the sample world/).waitFor();
      const status = await rpc(page, 'project.status');
      assert.equal(status.name, 'The Saltmarch');
      assert.equal(status.path, null);
      assert.equal(status.dirty, true);

      const pages = await rpc(page, 'pages.list', {});
      assert.ok(pages.length >= 14 && pages.length <= 18, `${pages.length} pages`);
      const statuses = new Set(pages.map((p) => p.status));
      assert.deepEqual([...statuses].sort(), ['canon', 'draft', 'idea', 'retconned']);

      const wren = await rpc(page, 'pages.getByTitle', { title: 'Wren Halloway' });
      assert.equal(wren.pageType, 'character');
      assert.ok(wren.aliases.includes('Little Wick'));
      assert.ok(wren.categories.includes('Characters'));
      assert.equal(wren.infobox.fields.find((f) => f.key === 'eyes').value, 'Grey');
      assert.equal(wren.infobox.fields.find((f) => f.key === 'born').kind, 'date');

      // Wiki links resolved, and the page on the planted mistakes is linked from the front.
      const backlinks = await rpc(page, 'pages.backlinks', { id: wren.id });
      assert.ok(backlinks.pages.length >= 3, 'other pages link here');
      const home = await rpc(page, 'pages.home');
      assert.equal(home.title, 'The Saltmarch');
      assert.match(JSON.stringify(home.content), /About this sample/);

      // Only the two pages left unwritten on purpose are wanted.
      const wanted = (await rpc(page, 'pages.wanted')).map((w) => w.title).sort();
      assert.deepEqual(wanted, ['Hob Corrow', 'The Tithe Barges']);

      // The book replaced the empty one, with its scenes, dates and points of view.
      const books = await rpc(page, 'books.list');
      assert.equal(books.length, 1);
      assert.equal(books[0].title, 'The Unlit Road');
      const tree = await rpc(page, 'nodes.tree', { bookId: books[0].id });
      const chapters = tree.filter((n) => n.kind === 'chapter');
      const scenes = tree.filter((n) => n.kind === 'scene');
      assert.equal(chapters.length, 2);
      assert.equal(scenes.length, 6);
      const stair = scenes.find((s) => s.title === 'The Guildhall Stair');
      assert.equal(stair.storyDate, '412-03-16');
      assert.ok(stair.povPageId, 'the point of view resolved to a page');
      assert.ok(stair.locationPageId, 'the location resolved to a page');
      const body = await rpc(page, 'nodes.get', { id: stair.id });
      assert.match(JSON.stringify(body.content), /Oswin Halloway/);
      const threads = await rpc(page, 'threads.list');
      assert.deepEqual(threads.map((t) => t.name), ['The missing oil', 'Wren and Tam']);
      assert.ok((await rpc(page, 'threads.links', { bookId: books[0].id })).length >= 6, 'scenes carry the threads');

      // The planted mistake really is there to find: he died before this scene.
      const oswin = await rpc(page, 'pages.getByTitle', { title: 'Oswin Halloway' });
      assert.equal(oswin.infobox.fields.find((f) => f.key === 'died').value, '409-11-02');
      const cast = (await rpc(page, 'snapshot.get')).nodes.find((n) => n.id === stair.id).castPageIds;
      assert.ok(cast.includes(oswin.id), 'and he is in its cast');
      const key = await rpc(page, 'pages.getByTitle', { title: 'The Tallow Key' });
      assert.equal(key.infobox.fields.find((f) => f.key === 'owner').changes[0].value, 'Wren Halloway');
      assert.ok((await rpc(page, 'pages.getByTitle', { title: 'Bram Kettridge' })), 'the near-duplicate page');
      assert.match(
        JSON.stringify((await rpc(page, 'pages.getByTitle', { title: 'About this sample' })).content),
        /The Guildhall Stair/,
      );
    }

    it('opens the sample world from the start screen', async () => {
      app = await launch(workspace);
      const { page } = app;
      await page.getByRole('button', { name: 'Open sample world' }).click();
      await assertSampleWorld(page);
      await page.getByRole('heading', { name: 'The Saltmarch' }).waitFor();
      await app.screenshot('care-sample-home');

      // The article and its infobox as a person sees them.
      await page.getByRole('link', { name: 'Wren Halloway' }).first().click();
      await page.getByRole('heading', { name: 'Wren Halloway' }).waitFor();
      await page.getByText('Born', { exact: true }).waitFor();
      await app.screenshot('care-sample-page');

      // And the book.
      await page.getByRole('button', { name: 'Write', exact: true }).click();
      await page.getByRole('treeitem', { name: /^Eleven Dark Posts,/ }).click();
      await page.locator('.prose-manuscript').getByText(/lamps along the causeway/).waitFor();
      await app.screenshot('care-sample-write');

      // The dates and relationships feed the timeline and the graph.
      await page.getByRole('button', { name: 'Atlas', exact: true }).click();
      await page.getByText('The Long Flood').first().waitFor();
      await page.getByText(/409/).first().waitFor();
      await app.screenshot('care-sample-timeline');
      await page.getByRole('button', { name: 'Relationship graph' }).click();
      await page.waitForTimeout(1500);
      await app.screenshot('care-sample-graph');
    });

    it('opens the sample world from the Help menu, asking about unsaved work first', async () => {
      app = await launch(workspace);
      const { page } = app;
      await createProject(page, 'My Own World');
      await rpc(page, 'pages.create', { title: 'Precious' });
      await waitUntil(async () => /kept safe/.test(await saveState(page)), 5000, 'the unsaved state');

      await openMenuItem(page, 'Help', 'Open sample world');
      await page.getByRole('heading', { name: /Save changes to/ }).waitFor();
      await page.getByRole('button', { name: 'Cancel' }).click();
      assert.equal((await rpc(page, 'project.status')).name, 'My Own World');
      assert.ok(await rpc(page, 'pages.getByTitle', { title: 'Precious' }));

      await rpc(page, 'pages.delete', { id: (await rpc(page, 'pages.getByTitle', { title: 'Precious' })).id });
      const saved = workspace.file('own.lorecraft');
      await savedProject(page, saved);
      await openMenuItem(page, 'Help', 'Open sample world');
      await assertSampleWorld(page);
      assert.ok(existsSync(saved), 'the project that was open is still there');
    });

    it('shows the first-run guide once, without blocking anything, and Help reopens it', async () => {
      const env = { LORECRAFT_E2E_GUIDE: '1' };
      app = await launch(workspace, { env });
      let { page } = app;
      const guide = page.getByTestId('first-run-guide');
      await guide.waitFor();
      await app.screenshot('care-guide');

      // It does not take the keyboard or stop anything: a project opens behind it.
      await createProject(page, 'Guided World');
      await guide.waitFor();
      assert.equal((await rpc(page, 'project.status')).name, 'Guided World');
      assert.equal(await page.locator('.dialog-backdrop').count(), 0, 'it is not a modal dialog');
      assert.equal((await rpc(page, 'settings.get')).help.guideSeen, true);

      // The steps can be walked through.
      const titles = [];
      for (;;) {
        titles.push(await guide.getByRole('heading').innerText());
        const next = guide.getByRole('button', { name: 'Next' });
        if ((await next.count()) === 0) break;
        await next.click();
      }
      assert.equal(titles.length, 5);
      assert.match(titles.join(' | '), /wiki.*Write.*AI.*safe/i);
      await guide.getByRole('button', { name: 'Back' }).click();
      assert.equal(await guide.getByRole('heading').innerText(), titles[3]);
      await guide.getByRole('button', { name: 'Close the guide' }).click();
      await guide.waitFor({ state: 'detached' });

      // Help brings it back with the keyboard on it, Enter moves on, and Escape puts it away.
      await openMenuItem(page, 'Help', 'Show the first-run guide');
      await guide.waitFor();
      assert.equal(await guide.getByRole('heading').innerText(), titles[0]);
      await page.keyboard.press('Enter');
      await waitUntil(async () => (await guide.getByRole('heading').innerText()) === titles[1], 3000, 'the next step');
      await page.keyboard.press('Escape');
      await guide.waitFor({ state: 'detached' });
      await app.kill();

      // It does not come back by itself on the next launch.
      app = await launch(workspace, { env });
      ({ page } = app);
      await page.getByRole('heading', { name: /Recover|LoreCraft/ }).first().waitFor();
      await page.waitForTimeout(800);
      assert.equal(await page.getByTestId('first-run-guide').count(), 0);
    });

    it('keeps the guide out of ordinary test runs', async () => {
      app = await launch(workspace);
      const { page } = app;
      await page.getByRole('heading', { name: 'LoreCraft' }).waitFor();
      await page.waitForTimeout(800);
      assert.equal(await page.getByTestId('first-run-guide').count(), 0);
      assert.equal((await rpc(page, 'settings.get')).help, undefined, 'and it is not marked as seen');
    });
  });

  describe('writing comfort', () => {
    /** Styles of the manuscript text in the preview on the Writing tab. */
    function previewStyle(page) {
      return page.getByTestId('writing-preview').evaluate((el) => {
        const [first, second] = el.querySelectorAll('p');
        const style = getComputedStyle(el);
        return {
          font: style.fontFamily,
          lineHeight: parseFloat(style.lineHeight) / parseFloat(style.fontSize),
          firstIndent: parseFloat(getComputedStyle(first).textIndent),
          secondIndent: parseFloat(getComputedStyle(second).textIndent),
          gap: parseFloat(getComputedStyle(first).marginBottom),
        };
      });
    }

    async function openWritingSettings(page) {
      await page.keyboard.press('Control+,');
      await page.getByRole('tab', { name: 'Writing' }).click();
      await page.getByTestId('writing-preview').waitFor();
    }

    it('changes the font, spacing, width and paragraphs of the manuscript, and remembers them', async () => {
      app = await launch(workspace);
      let { page } = app;
      await createProject(page, 'Comfort World');
      await openWritingSettings(page);

      const standard = await previewStyle(page);
      assert.match(standard.font, /Source Serif 4/, 'the theme decides by default');
      assert.ok(Math.abs(standard.lineHeight - 1.75) < 0.01);
      assert.equal(standard.secondIndent, 0);
      assert.ok(standard.gap > 0);
      await app.screenshot('care-writing-settings');

      await page.getByLabel('Writing font').selectOption({ label: 'OpenDyslexic (dyslexia-friendly)' });
      await page.getByLabel('Line spacing').fill('2.2');
      await page.getByLabel('Page width').fill('36');
      await page.getByRole('button', { name: 'First-line indents' }).click();

      await waitUntil(async () => /OpenDyslexic/.test((await previewStyle(page)).font), 3000, 'the font to change');
      const changed = await previewStyle(page);
      assert.ok(Math.abs(changed.lineHeight - 2.2) < 0.01, `line height ${changed.lineHeight}`);
      assert.equal(changed.firstIndent, 0, 'the first paragraph starts flush');
      assert.ok(changed.secondIndent > 0, 'later paragraphs indent');
      assert.equal(changed.gap, 0, 'and there is no gap between them');
      await app.screenshot('care-writing-settings-changed');

      // The bundled font really loads, with no network to fetch it from.
      await waitUntil(
        () => page.evaluate(() => document.fonts.load("16px 'OpenDyslexic'").then((f) => f.length > 0)),
        5000,
        'the font file to load',
      );

      // It applies in the manuscript itself.
      const books = await rpc(page, 'books.list');
      const chapter = await rpc(page, 'nodes.create', { bookId: books[0].id, parentId: null, kind: 'chapter', title: 'One' });
      await rpc(page, 'nodes.create', {
        bookId: books[0].id,
        parentId: chapter.id,
        kind: 'scene',
        title: 'Opening',
        content: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'The first paragraph.' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'The second paragraph.' }] },
          ],
        },
      });
      await page.getByRole('button', { name: 'Write', exact: true }).click();
      await page.getByRole('treeitem', { name: /^Opening,/ }).click();
      const editor = page.locator('.prose-manuscript').first();
      await editor.getByText('The second paragraph.').waitFor();
      const inScene = await editor.evaluate((el) => {
        const [first, second] = el.querySelectorAll('p');
        const sheet = el.closest('.write-page');
        return {
          font: getComputedStyle(el).fontFamily,
          lineHeight: parseFloat(getComputedStyle(el).lineHeight) / parseFloat(getComputedStyle(el).fontSize),
          firstIndent: parseFloat(getComputedStyle(first).textIndent),
          secondIndent: parseFloat(getComputedStyle(second).textIndent),
          pageWidthEm: parseFloat(getComputedStyle(sheet).maxWidth) / parseFloat(getComputedStyle(sheet).fontSize),
        };
      });
      assert.match(inScene.font, /OpenDyslexic/);
      assert.ok(Math.abs(inScene.lineHeight - 2.2) < 0.01);
      assert.equal(inScene.firstIndent, 0);
      assert.ok(inScene.secondIndent > 0);
      assert.ok(Math.abs(inScene.pageWidthEm - 36) < 0.01, `page width ${inScene.pageWidthEm}em`);
      await app.screenshot('care-writing-scene');

      // Wiki articles keep their font unless asked.
      const articleFont = () =>
        page.evaluate(() => {
          const probe = document.createElement('div');
          probe.className = 'prose prose-article';
          document.body.append(probe);
          const font = getComputedStyle(probe).fontFamily;
          probe.remove();
          return font;
        });
      assert.doesNotMatch(await articleFont(), /OpenDyslexic/);
      await openWritingSettings(page);
      await page.getByLabel('Use this font for wiki articles too').check();
      await waitUntil(async () => /OpenDyslexic/.test(await articleFont()), 3000, 'articles to follow');
      await app.kill();

      // A new launch brings it all back.
      app = await launch(workspace);
      ({ page } = app);
      await waitUntil(() => page.evaluate(() => document.documentElement.dataset.paragraphs), 10_000, 'settings to load');
      const stored = await page.evaluate(() => {
        const root = document.documentElement;
        return {
          font: root.style.getPropertyValue('--writing-font'),
          height: root.style.getPropertyValue('--writing-line-height'),
          width: root.style.getPropertyValue('--writing-page-width'),
          paragraphs: root.dataset.paragraphs,
        };
      });
      assert.match(stored.font, /OpenDyslexic/);
      assert.equal(stored.height, '2.2');
      assert.equal(stored.width, '36em');
      assert.equal(stored.paragraphs, 'indented');
    });

    it('goes back to the standard page, so the theme chooses the font again', async () => {
      app = await launch(workspace);
      const { page } = app;
      await createProject(page, 'Comfort World');
      await openWritingSettings(page);
      await page.getByLabel('Writing font').selectOption({ label: 'Georgia' });
      await waitUntil(async () => /^Georgia/.test((await previewStyle(page)).font), 3000, 'the font to change');

      await page.getByRole('button', { name: 'Go back to the standard page' }).click();
      await waitUntil(async () => /Source Serif 4/.test((await previewStyle(page)).font), 3000, 'the font to reset');
      await page.getByRole('tab', { name: 'Appearance' }).click();
      await page.getByRole('button', { name: /^Typewriter/ }).click();
      await page.getByRole('tab', { name: 'Writing' }).click();
      await waitUntil(async () => /Courier Prime/.test((await previewStyle(page)).font), 3000, 'the theme to decide');
    });

    it('offers a high contrast theme in dark and light', async () => {
      app = await launch(workspace);
      const { page } = app;
      await createProject(page, 'Comfort World');
      await page.keyboard.press('Control+,');
      await page.getByRole('button', { name: /^High contrast/ }).click();
      await waitUntil(() => page.evaluate(() => document.documentElement.dataset.theme === 'contrast'), 3000, 'the theme');
      const colors = () =>
        page.evaluate(() => ({
          bg: getComputedStyle(document.body).backgroundColor,
          text: getComputedStyle(document.body).color,
        }));
      assert.deepEqual(await colors(), { bg: 'rgb(0, 0, 0)', text: 'rgb(255, 255, 255)' });
      await app.screenshot('care-contrast-dark');

      await page.getByRole('button', { name: 'Light', exact: true }).click();
      await waitUntil(async () => (await colors()).bg === 'rgb(255, 255, 255)', 3000, 'light mode');
      assert.equal((await colors()).text, 'rgb(0, 0, 0)');
      await app.screenshot('care-contrast-light');

      await openMenuItem(page, 'View', 'Theme: Encyclopedia');
      await waitUntil(() => page.evaluate(() => document.documentElement.dataset.theme === 'encyclopedia'), 3000, 'the menu to change it');
    });
  });
});
