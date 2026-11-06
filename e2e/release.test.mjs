/**
 * Log files and update checks in the real app. The update check talks to a local stub, so
 * this never reaches GitHub, and the app's opening of browsers and folders is recorded
 * rather than carried out, so nothing appears on the desktop.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

import { createProject, createWorkspace, launch, rpc, waitUntil } from './harness.mjs';

const SECRET_KEY = 'sk-ant-e2e-secret-value-12345';
// Words that would not appear in any error message, so finding one in a log means a leak.
const STORY_WORDS = ['Vaelthrix', 'Unforgiven', 'Ashmoor', 'Isolde', 'silverwound'];
const STORY = 'Vaelthrix the Unforgiven burned Ashmoor while Queen Isolde hid the silverwound';
const NOTES = '## What changed\n\n- Maps got **faster**\n\n<img src=x onerror="window.__hacked = true">\n\n[Details](https://example.com/details)';

function readLogs(dataDir) {
  const dir = join(dataDir, 'logs');
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .map((name) => readFileSync(join(dir, name), 'utf8'))
    .join('');
}

function assertNoLeak(log, extra = []) {
  for (const word of [...STORY_WORDS, ...extra]) assert.ok(!log.includes(word), `${word} reached the log:\n${log}`);
}

/** The `{ code, message }` a native call failed with, or null if it worked. */
function rpcError(page, method, params) {
  return page.evaluate(
    ([m, p]) => window.__TAURI_INTERNALS__.invoke('rpc', { method: m, params: p ?? null }).then(() => null, (e) => e),
    [method, params],
  );
}

async function openHelpItem(page, name) {
  await page.getByRole('menuitem', { name: 'Help', exact: true }).click();
  await page.getByRole('menuitem', { name }).click();
}

/**
 * Starts the app again in the same folder. WebView2 refuses a folder its last browser
 * process has not let go of yet, which takes longer on a busy machine, and the app then
 * exits at once, so this waits a moment and tries a second time.
 */
async function relaunch(workspace, options) {
  await new Promise((done) => setTimeout(done, 1500));
  try {
    return await launch(workspace, options);
  } catch {
    await new Promise((done) => setTimeout(done, 5000));
    return launch(workspace, options);
  }
}

/** Answers like GitHub's release API, and remembers what it was asked. */
function startStub() {
  const state = { requests: [], reply: { status: 404, body: { message: 'Not Found' } } };
  const server = createServer((request, response) => {
    state.requests.push({ url: request.url, headers: request.headers });
    response.writeHead(state.reply.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(state.reply.body));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        state,
        url: `http://127.0.0.1:${server.address().port}/repos/CodeCat04/LoreCraft/releases/latest`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

const release = (tag, body = NOTES) => ({
  status: 200,
  body: {
    tag_name: tag,
    name: `LoreCraft ${tag}`,
    body,
    html_url: `https://github.com/CodeCat04/LoreCraft/releases/tag/${tag}`,
    published_at: '2026-11-05T10:00:00Z',
    draft: false,
    prerelease: false,
  },
});

describe('log files', () => {
  let workspace;
  let app;

  before(async () => {
    workspace = createWorkspace();
    app = await launch(workspace);
    await createProject(app.page, 'Log test');
    const page = await rpc(app.page, 'pages.create', { title: 'Vaelthrix', summary: STORY });
    assert.ok(page.id);
  });

  after(async () => {
    await app?.kill();
    workspace?.cleanup();
  });

  it('notes the start with the version and platform', async () => {
    const log = readLogs(workspace.dataDir);
    assert.match(log, /INFO app\.start version=\d+\.\d+\.\d+ os=windows arch=/);
  });

  it('records uncaught errors and rejections without the text they carried', async () => {
    await app.page.evaluate((story) => {
      setTimeout(() => {
        throw new Error(`Could not save ${story}`);
      });
      setTimeout(() => JSON.parse(story));
      void Promise.reject(new TypeError(`Bad value in ${story}`));
      void Promise.reject(story);
    }, STORY);
    await waitUntil(() => (readLogs(workspace.dataDir).match(/js\.uncaught/g) ?? []).length >= 4, 8000, 'the errors to reach the log');
    const log = readLogs(workspace.dataDir);
    assert.match(log, /ERROR js\.uncaught origin=error name=Error message="Could not save … the … while/);
    assert.match(log, /ERROR js\.uncaught origin=error name=SyntaxError/);
    assert.match(log, /ERROR js\.uncaught origin=rejection name=TypeError/);
    assertNoLeak(log);
  });

  it('keeps where an error came from, but not the message at the top of its stack', async () => {
    await app.page.evaluate((story) => {
      const error = new RangeError('Position 12 out of range');
      error.stack = `RangeError: ${story}\n    at resolve (http://tauri.localhost/assets/main-abc123.js:10:20)\n    at http://tauri.localhost/assets/main-abc123.js:1:2`;
      setTimeout(() => {
        throw error;
      });
    }, STORY);
    await waitUntil(() => /name=RangeError/.test(readLogs(workspace.dataDir)), 5000, 'the error to reach the log');
    const log = readLogs(workspace.dataDir);
    assert.match(log, /name=RangeError message="Position 12 out of range" stack=resolve@main-abc123\.js:10:20<main-abc123\.js:1:2/);
    assertNoLeak(log);
  });

  it('records a failed call by its method and code', async () => {
    assert.equal((await rpcError(app.page, 'pages.get', { id: STORY })).code, 'NOT_FOUND');
    const log = readLogs(workspace.dataDir);
    assert.match(log, /WARN rpc\.failed method=pages\.get code=NOT_FOUND/);
    assertNoLeak(log);
  });

  it('records a panic with where it happened, and the app carries on', async () => {
    const failed = await rpcError(app.page, 'app.e2ePanic', { message: `slice failed in \`${STORY}\` ${STORY}` });
    assert.equal(failed.code, 'INTERNAL');
    await waitUntil(() => /ERROR app\.panic/.test(readLogs(workspace.dataDir)), 5000, 'the panic to reach the log');
    const log = readLogs(workspace.dataDir);
    assert.match(log, /ERROR app\.panic thread=\S+ at=\S*app\.rs:\d+:\d+/);
    assert.match(log, /ERROR rpc\.failed method=app\.e2ePanic code=INTERNAL/);
    assertNoLeak(log);
    assert.equal(await rpc(app.page, 'project.status').then((s) => s.open), true, 'still working');
  });

  it('keeps AI text and keys out, through a real failed request', async () => {
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        // A server quoting everything back: the worst case for a log.
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: `Rejected ${SECRET_KEY} for ${body}` } }));
      });
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    await rpc(app.page, 'settings.update', {
      patch: { ai: { profiles: [{ id: 'echo', name: 'Echo', kind: 'anthropic', baseUrl, model: 'claude-opus-5-5', isCloud: true }] } },
    });
    await rpc(app.page, 'ai.setKey', { profileId: 'echo', key: SECRET_KEY });
    // The same command the AI pane uses, with Tauri's channel reduced to what it sends.
    const failure = await app.page.evaluate(
      (story) =>
        new Promise((resolve, reject) => {
          const { invoke, transformCallback } = window.__TAURI_INTERNALS__;
          const id = transformCallback(({ message }) => {
            if (message?.type === 'error' || message?.type === 'done') resolve(message);
          });
          invoke('ai_stream', {
            request: {
              streamId: 'e2e-log',
              profileId: 'echo',
              system: story,
              messages: [{ role: 'user', content: [{ type: 'text', text: story }] }],
            },
            onEvent: `__CHANNEL__:${id}`,
          }).catch(reject);
        }),
      STORY,
    );
    server.close();
    assert.equal(failure.type, 'error', JSON.stringify(failure));
    assert.equal(failure.code, 'BAD_REQUEST');
    const log = readLogs(workspace.dataDir);
    assert.match(log, /WARN ai\.failed code=BAD_REQUEST/);
    assertNoLeak(log, [SECRET_KEY, 'sk-ant']);
  });

  it('shows the log folder and copies diagnostics with no content', async () => {
    const { page } = app;
    await openHelpItem(page, 'Open log folder');
    const logFolder = join(workspace.dataDir, 'logs');
    await waitUntil(async () => (await rpc(page, 'media.e2eOpened')).includes(logFolder), 3000, 'the folder to be opened');

    await openHelpItem(page, 'Copy diagnostics');
    // An off-screen window may not get the clipboard, so either outcome has to be right.
    const shown = page.locator('.support-diagnostics');
    await waitUntil(
      async () => (await shown.count()) > 0 || (await page.getByText('Diagnostics copied').count()) > 0,
      5000,
      'the diagnostics',
    );
    if (await shown.count()) await page.getByRole('button', { name: 'Close' }).click();

    const { text } = await rpc(page, 'app.diagnostics');
    assert.match(text, /^LoreCraft \d+\.\d+\.\d+/);
    assert.match(text, /OS: Windows/);
    assert.match(text, /Web view: \d+/);
    assert.ok(!text.includes(workspace.root), text);
    assert.ok(!text.includes(process.env.USERNAME || 'no-such-user'), text);
    assertNoLeak(text);
  });
});

describe('update checks', () => {
  let stub;
  let workspace;
  let app;

  const dialogText = () => app.page.locator('.dialog').innerText();

  async function closeDialog(name) {
    await app.page.getByRole('button', { name }).click();
    await app.page.locator('.dialog').waitFor({ state: 'detached' });
  }

  before(async () => {
    stub = await startStub();
    workspace = createWorkspace();
    app = await launch(workspace, { env: { LORECRAFT_UPDATE_URL: stub.url } });
    // The menus belong to an open project.
    await createProject(app.page, 'Update test');
  });

  after(async () => {
    await app?.kill();
    workspace?.cleanup();
    await stub?.close();
  });

  it('makes no network call on its own by default', async () => {
    const settings = await rpc(app.page, 'settings.get');
    assert.equal(settings.updates?.checkAtStartup ?? false, false);
    await app.page.waitForTimeout(5000);
    assert.equal(stub.state.requests.length, 0);
  });

  it('shows a newer version with its notes and a link, safely', async () => {
    stub.state.reply = release('v9.1.0');
    await openHelpItem(app.page, 'Check for updates');
    await app.page.getByRole('heading', { name: 'LoreCraft 9.1.0 is available' }).waitFor();
    const request = stub.state.requests.at(-1);
    assert.equal(request.headers['user-agent'], 'LoreCraft', 'the request names only the app');
    assert.equal(request.headers.authorization, undefined);
    const text = await dialogText();
    assert.match(text, /What changed/);
    assert.match(text, /faster/);
    assert.equal(await app.page.evaluate(() => window.__hacked), undefined, 'raw HTML in notes does not run');
    assert.equal(await app.page.locator('.support-notes img').count(), 0);

    await app.screenshot('release-update-available');

    // A link in the notes opens a browser rather than moving the app's window.
    const before = app.page.url();
    await app.page.locator('.support-notes a').click();
    assert.equal(app.page.url(), before);
    await waitUntil(async () => (await rpc(app.page, 'media.e2eOpened')).includes('https://example.com/details'), 3000, 'the link to open');

    await app.page.getByRole('button', { name: 'Open the release page' }).click();
    await waitUntil(
      async () => (await rpc(app.page, 'media.e2eOpened')).includes('https://github.com/CodeCat04/LoreCraft/releases/tag/v9.1.0'),
      3000,
      'the release page to open',
    );
    await app.page.locator('.dialog').waitFor({ state: 'detached' });
  });

  it('says so when this is the latest version', async () => {
    const { version } = await rpc(app.page, 'app.bootstrap');
    stub.state.reply = release(`v${version}`);
    await openHelpItem(app.page, 'Check for updates');
    await app.page.getByRole('heading', { name: 'LoreCraft is up to date' }).waitFor();
    assert.ok((await dialogText()).includes(version));
    await closeDialog('OK');
  });

  it('explains no releases, or a private repository, when asked by hand', async () => {
    stub.state.reply = { status: 404, body: { message: 'Not Found' } };
    await openHelpItem(app.page, 'Check for updates');
    await app.page.getByRole('heading', { name: 'No releases found' }).waitFor();
    await closeDialog('OK');
  });

  it('explains a rate limit', async () => {
    stub.state.reply = { status: 403, body: { message: 'API rate limit exceeded' } };
    await openHelpItem(app.page, 'Check for updates');
    await app.page.getByText('limiting requests').waitFor();
    await closeDialog('OK');
  });

  it('turns the startup setting on from Settings, and it survives a restart', async () => {
    await app.page.keyboard.press('Control+,');
    await app.page.getByRole('tab', { name: 'Updates and logs' }).click();
    const box = app.page.getByRole('checkbox', { name: /Check for updates at startup/ });
    assert.equal(await box.isChecked(), false);
    await box.check();
    await waitUntil(async () => (await rpc(app.page, 'settings.get')).updates?.checkAtStartup === true, 3000, 'the setting to save');
    await app.screenshot('release-settings');
    await app.kill();

    stub.state.reply = release('v9.2.0');
    stub.state.requests.length = 0;
    app = await relaunch(workspace, { env: { LORECRAFT_UPDATE_URL: stub.url } });
    await waitUntil(() => stub.state.requests.length === 1, 15000, 'the startup check');
    // It only mentions the update, and leaves the person where they were.
    await app.page.locator('.toast').getByText('LoreCraft 9.2.0 is available').waitFor();
    assert.equal(await app.page.locator('.dialog').count(), 0);
    await app.screenshot('release-update-notice');
    await app.page.getByRole('button', { name: "See what's new" }).click();
    await app.page.getByRole('heading', { name: 'LoreCraft 9.2.0 is available' }).waitFor();
    await closeDialog('Close');
    assert.equal(await app.page.locator('.toast').count(), 0, 'pressing it dismissed the notice');
  });

  it('stays quiet at startup when GitHub is unreachable', async () => {
    await app.kill();
    // Nothing is listening here any more.
    await stub.close();
    const url = stub.url;
    stub = null;
    app = await relaunch(workspace, { env: { LORECRAFT_UPDATE_URL: url } });
    await waitUntil(() => /INFO update\.check status=offline/.test(readLogs(workspace.dataDir)), 15000, 'the startup check');
    await app.page.waitForTimeout(300);
    assert.equal(await app.page.locator('.dialog').count(), 0);
    assert.equal(await app.page.locator('.toast').count(), 0);

    // Asked by hand, the same failure gets a clear answer. No project is open here, so
    // this goes through the command palette.
    await app.page.keyboard.press('Control+k');
    await app.page.keyboard.type('Check for updates');
    await app.page.keyboard.press('Enter');
    await app.page.getByText('GitHub could not be reached').waitFor();
    await closeDialog('OK');
  });
});

describe('a platform without PDF export', () => {
  let workspace;
  let app;

  before(async () => {
    workspace = createWorkspace();
    app = await launch(workspace, { env: { LORECRAFT_E2E_NO_PDF: '1' } });
    await createProject(app.page, 'No PDF');
  });

  after(async () => {
    await app?.kill();
    workspace?.cleanup();
  });

  it('says so on the export screen, before anyone picks a file', async () => {
    const { page } = app;
    assert.equal((await rpc(page, 'app.bootstrap')).platform.pdf, false);
    await page.getByRole('menuitem', { name: 'File', exact: true }).click();
    await assert.rejects(
      page.getByRole('menuitem', { name: 'Export this page as PDF' }).click({ timeout: 800, trial: true }),
      'the page command is unavailable',
    );
    await page.getByRole('menuitem', { name: 'Export…' }).click();
    const radios = page.getByRole('radio', { name: /^PDF/ });
    await radios.first().waitFor();
    assert.equal(await radios.count(), 2);
    for (const radio of await radios.all()) assert.equal(await radio.isDisabled(), true);
    assert.equal(await page.getByText('PDF export works on Windows and Linux').count(), 2);
    assert.equal(await page.getByRole('radio', { name: /^Word document/ }).isEnabled(), true);
    await app.screenshot('release-no-pdf');
  });

  it('refuses a direct request with the same clear message', async () => {
    const path = workspace.file('out.pdf');
    await rpc(app.page, 'app.e2eAllowPath', { path });
    const error = await rpcError(app.page, 'print.pdf', { title: 'T', html: '<p>x</p>', path });
    assert.equal(error.code, 'NOT_SUPPORTED');
    assert.match(error.message, /works on Windows and Linux/);
    assert.equal(existsSync(path), false);
  });
});
