/**
 * The portable zip, unzipped and run as a writer would: all data lands in `data` beside the
 * program, and nothing in the harness's own data folder. Uses the release zip from
 * `npm run portable` when there is one, or else zips the built exe the same way.
 *
 * The harness's LORECRAFT_DATA_DIR always wins over portable mode, so these runs leave it
 * out and say they are tests with LORECRAFT_E2E_PORTABLE instead.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { createProject, createWorkspace, findBuiltExe, launch, rpc, waitUntil } from './harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const RELEASE_ZIP = join(ROOT, 'src-tauri', 'target', 'release', 'bundle', 'portable', `LoreCraft_${VERSION}_x64-portable.zip`);

const PORTABLE_ENV = {
  LORECRAFT_DATA_DIR: undefined,
  WEBVIEW2_USER_DATA_FOLDER: undefined,
  LORECRAFT_E2E_PORTABLE: '1',
};

/** Unzips the portable zip into the workspace's `bin`, where the harness runs the exe. */
function unzipPortable(workspace) {
  let zip = RELEASE_ZIP;
  if (process.env.LORECRAFT_EXE || !existsSync(zip)) {
    zip = workspace.file('portable.zip');
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'portable.mjs'), '--exe', findBuiltExe(), '--out', zip]);
  }
  const bin = join(workspace.root, 'bin');
  // Windows' own unzip, so the zip is checked by a reader other than the one that wrote it.
  execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${bin}'`]);
  return bin;
}

describe('portable', () => {
  it('keeps every file it writes in the data folder beside the program', async () => {
    const workspace = createWorkspace();
    try {
      const bin = unzipPortable(workspace);
      for (const name of ['lorecraft.exe', 'portable', 'LICENSE', 'README.txt', 'THIRD_PARTY_LICENSES.txt']) {
        assert.ok(existsSync(join(bin, name)), `${name} is in the zip`);
      }
      assert.ok(existsSync(join(bin, 'dictionaries', 'en-US', 'index.dic')), 'the dictionaries are at their installed path');

      const app = await launch(workspace, { env: PORTABLE_ENV });
      try {
        const data = join(bin, 'data');
        const info = await rpc(app.page, 'app.info');
        assert.equal(info.dataDir, data);
        assert.equal(info.portable, true);
        await rpc(app.page, 'settings.update', { patch: { ai: { cloudWarningDismissed: true } } });
        await waitUntil(() => existsSync(join(data, 'settings.json')), 10_000, 'settings in the data folder');
        assert.ok(existsSync(join(data, 'logs')), 'logs in the data folder');
        assert.ok(existsSync(join(data, 'webview')), 'WebView2 files in the data folder');

        await createProject(app.page, 'Portable World');
        await app.page.locator('.menu-title', { hasText: /^Help$/ }).click();
        await app.page.getByRole('menuitem', { name: 'About LoreCraft' }).click();
        await waitUntil(async () => (await app.page.getByTestId('about-data-dir').innerText()) === data, 5000, 'the data folder in About');
        assert.match(await app.page.getByTestId('about-portable').innerText(), /Portable/);
      } finally {
        await app.kill();
      }
      assert.ok(!existsSync(workspace.dataDir), "nothing went to the harness's data folder");
      assert.ok(!existsSync(workspace.webviewDir), "nothing went to the harness's WebView2 folder");
      const outside = readdirSync(workspace.root).filter((name) => !['bin', 'portable.zip'].includes(name));
      assert.deepEqual(outside, []);
    } finally {
      workspace.cleanup();
    }
  });

  it('says plainly when the data folder cannot be written, instead of moving to AppData', async () => {
    const workspace = createWorkspace();
    try {
      const bin = unzipPortable(workspace);
      // A file where the folder should be, which cannot be written into, like a locked drive.
      writeFileSync(join(bin, 'data'), 'in the way');
      const env = { ...process.env, LORECRAFT_E2E: '1', ...PORTABLE_ENV };
      delete env.LORECRAFT_DATA_DIR;
      delete env.WEBVIEW2_USER_DATA_FOLDER;
      const run = spawnSync(join(bin, 'lorecraft.exe'), [], { env, encoding: 'utf8', timeout: 30_000, windowsHide: true });
      assert.equal(run.status, 1);
      assert.match(run.stderr, /cannot write to its data folder/);
      assert.match(run.stderr, /delete the file named "portable"/);
      assert.ok(!existsSync(workspace.dataDir));
    } finally {
      workspace.cleanup();
    }
  });
});
