import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';

import { allowPath, createProject, createWorkspace, launch, rpc, waitUntil } from './harness.mjs';

describe('foundation', () => {
  let workspace;
  let app;

  beforeEach(() => {
    workspace = createWorkspace();
  });

  afterEach(async () => {
    if (app && !app.exited) await app.kill().catch(() => {});
    workspace.cleanup();
  });

  /** Types into the home page's editor and waits for it to reach the recovery copy. */
  async function typeInHome(page, text) {
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.locator('.ProseMirror[contenteditable="true"]');
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(text);
    await waitUntil(
      async () => (await rpc(page, 'pages.home')).content && JSON.stringify((await rpc(page, 'pages.home')).content).includes(text),
      5000,
      'the edit to be stored',
    );
  }

  it('opens in the default dark theme with the start screen', async () => {
    app = await launch(workspace);
    await app.page.getByRole('heading', { name: 'LoreCraft' }).waitFor();
    const theme = await app.page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      mode: document.documentElement.dataset.mode,
      bg: getComputedStyle(document.body).backgroundColor,
    }));
    assert.equal(theme.theme, 'encyclopedia');
    assert.equal(theme.mode, 'dark');
    assert.equal(theme.bg, 'rgb(16, 20, 24)');
    await app.screenshot('foundation-start');
  });

  it('keeps unsaved work through a force-close and restores it on request', async () => {
    app = await launch(workspace);
    await createProject(app.page, 'Crash World');
    const secret = 'The dragon sleeps under the vale';
    await typeInHome(app.page, secret);
    assert.match(await app.page.getByTestId('save-state').innerText(), /kept safe/);

    await app.kill();

    app = await launch(workspace);
    await app.page.getByRole('heading', { name: 'Recover your work?' }).waitFor();
    await app.screenshot('foundation-recovery');
    await app.page.getByRole('button', { name: 'Recover' }).click();
    await app.page.locator('.topbar').waitFor();
    await app.page.getByText(secret).waitFor();
    assert.match(await app.page.getByTestId('save-state').innerText(), /kept safe/);
  });

  it('saves to a file with Ctrl+S, reopens it, and shows the saved state', async () => {
    app = await launch(workspace);
    await createProject(app.page, 'Saved World');
    const line = 'Saved words stay saved';
    await typeInHome(app.page, line);

    const path = workspace.file('saved.lorecraft');
    await allowPath(app.page, path);
    await rpc(app.page, 'project.saveAs', { path });
    await waitUntil(async () => /All changes saved/.test(await app.page.getByTestId('save-state').innerText()), 3000, 'the saved state');
    assert.ok(existsSync(path));
    assert.equal(readFileSync(path).subarray(0, 15).toString(), 'SQLite format 3');

    await app.page.keyboard.press('Control+End');
    await app.page.keyboard.type(' plus more');
    await waitUntil(async () => /kept safe/.test(await app.page.getByTestId('save-state').innerText()), 3000, 'the dirty state');
    await app.page.keyboard.press('Control+s');
    await waitUntil(async () => /All changes saved/.test(await app.page.getByTestId('save-state').innerText()), 5000, 'Ctrl+S to finish');

    await rpc(app.page, 'project.close');
    await app.page.getByRole('heading', { name: 'LoreCraft' }).waitFor();
    await app.page.getByRole('button', { name: /^saved/ }).first().click();
    await app.page.getByText(`${line} plus more`).waitFor();
  });

  it('asks before closing with unsaved work, and closes cleanly when told to discard', async () => {
    app = await launch(workspace);
    await createProject(app.page);
    await typeInHome(app.page, 'Words to abandon');

    await app.page.getByRole('menuitem', { name: 'File' }).click();
    await app.page.getByRole('menuitem', { name: 'Exit' }).click();
    await app.page.getByRole('heading', { name: /Save changes/ }).waitFor();
    await app.page.getByRole('button', { name: 'Cancel' }).click();
    assert.equal(app.exited, false);

    await app.page.getByRole('menuitem', { name: 'File' }).click();
    await app.page.getByRole('menuitem', { name: 'Exit' }).click();
    await app.page.getByRole('button', { name: "Don't save" }).click();
    await app.waitForExit();

    // A deliberate discard must not come back as a recovery offer.
    app = await launch(workspace);
    await app.page.getByRole('heading', { name: 'LoreCraft' }).waitFor();
    assert.equal(await app.page.getByRole('heading', { name: 'Recover your work?' }).count(), 0);
  });

  it('changes themes and both text sizes independently', async () => {
    app = await launch(workspace);
    await createProject(app.page);
    const page = app.page;
    await page.locator('.prose').waitFor();
    const sizes = () =>
      page.evaluate(() => ({
        prose: parseFloat(getComputedStyle(document.querySelector('.prose')).fontSize),
        ui: parseFloat(getComputedStyle(document.documentElement).fontSize),
      }));

    const start = await sizes();
    await page.keyboard.press('Control+=');
    await waitUntil(async () => (await sizes()).prose > start.prose, 2000, 'larger writing text');
    assert.equal((await sizes()).ui, start.ui, 'the interface keeps its size');

    await page.keyboard.press('Control+0');
    await page.keyboard.press('Control+Shift+=');
    await waitUntil(async () => (await sizes()).ui > start.ui, 2000, 'a larger interface');
    assert.equal((await sizes()).prose, start.prose, 'writing text keeps its size');
    await page.keyboard.press('Control+Shift+0');

    const palette = [];
    for (const theme of ['encyclopedia', 'parchment', 'typewriter', 'midnight', 'lorekeeper']) {
      for (const mode of ['dark', 'light']) {
        await page.evaluate(
          ([t, m]) => {
            document.documentElement.dataset.theme = t;
            document.documentElement.dataset.mode = m;
          },
          [theme, mode],
        );
        const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        palette.push(bg);
        await app.screenshot(`theme-${theme}-${mode}`);
      }
    }
    assert.equal(new Set(palette).size, 10, 'every theme and mode looks different');
  });

  it('remembers settings across restarts', async () => {
    app = await launch(workspace);
    await rpc(app.page, 'settings.update', { patch: { appearance: { theme: 'parchment', mode: 'light' } } });
    await app.kill();
    app = await launch(workspace);
    await app.page.getByRole('heading', { name: 'LoreCraft' }).waitFor();
    const root = await app.page.evaluate(() => ({ ...document.documentElement.dataset }));
    assert.equal(root.theme, 'parchment');
    assert.equal(root.mode, 'light');
  });
});
