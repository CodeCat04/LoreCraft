/**
 * Launches the real app and drives it through WebView2's DevTools port. Each launch is
 * isolated: its own data folder and port, off-screen, so runs can overlap and do not
 * take over the screen.
 *
 * Build first with `npm run app:debug`. Set LORECRAFT_EXE to test a specific binary.
 */

import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ARTIFACTS = join(ROOT, 'e2e', 'artifacts');

export function findBuiltExe() {
  const candidates = [
    process.env.LORECRAFT_EXE,
    process.env.CARGO_TARGET_DIR && join(process.env.CARGO_TARGET_DIR, 'debug', 'lorecraft.exe'),
    join(ROOT, 'src-tauri', 'target', 'debug', 'lorecraft.exe'),
    join(ROOT, '.build', 'target', 'debug', 'lorecraft.exe'),
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`No built app. Run "npm run app:debug". Looked in:\n${candidates.join('\n')}`);
  return found;
}

/**
 * Lays out the files the installer puts beside the program (`bundle.resources` in
 * src-tauri/tauri.conf.json): the dictionaries and the third-party licenses. A copied exe
 * then finds them where an installed one does, so a release build is tested as shipped.
 */
function placeResources(binDir) {
  const tauriDir = join(ROOT, 'src-tauri');
  const config = JSON.parse(readFileSync(join(tauriDir, 'tauri.conf.json'), 'utf8'));
  const resources = config.bundle?.resources ?? {};
  const entries = Array.isArray(resources) ? resources.map((path) => [path, path]) : Object.entries(resources);
  for (const [from, to] of entries) {
    cpSync(join(tauriDir, from), join(binDir, to), { recursive: true });
  }
}

function freePort() {
  return new Promise((res, rej) => {
    const server = createServer();
    server.unref();
    server.on('error', rej);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => res(port));
    });
  });
}

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

/** One folder per test. Removed by `workspace.cleanup()`. */
export function createWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'lorecraft-e2e-'));
  return {
    root,
    dataDir: join(root, 'data'),
    webviewDir: join(root, 'webview'),
    file: (name) => join(root, name),
    cleanup: () => {
      for (let i = 0; i < 10; i += 1) {
        try {
          rmSync(root, { recursive: true, force: true });
          return;
        } catch {
          // WebView2 helper processes can hold files for a moment after exit.
          execFileSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 300']);
        }
      }
    },
  };
}

/**
 * Starts the app. Returns a handle whose `page` is a Playwright page on the real UI.
 * `args` are passed to the app, for example a project file to open.
 */
export async function launch(workspace, { args = [], env = {} } = {}) {
  const built = findBuiltExe();
  // A running exe cannot be overwritten on Windows, so run a private copy. That leaves
  // the build output free for rebuilds while tests run.
  const binDir = join(workspace.root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const exe = join(binDir, 'lorecraft.exe');
  if (!existsSync(exe)) {
    copyFileSync(built, exe);
    placeResources(binDir);
  }

  const port = await freePort();
  const child = spawn(exe, args, {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      LORECRAFT_E2E: '1',
      LORECRAFT_DATA_DIR: workspace.dataDir,
      WEBVIEW2_USER_DATA_FOLDER: workspace.webviewDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: [
        `--remote-debugging-port=${port}`,
        '--disable-features=CalculateNativeWinOcclusion',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ].join(' '),
      ...env,
    },
  });
  // The last thing the app said, to explain a failed start.
  let said = '';
  child.stderr.on('data', (chunk) => {
    said = (said + chunk).slice(-2000);
  });
  child.stderr.unref();
  let exited = false;
  let exitCode = null;
  child.on('exit', (code) => {
    exited = true;
    exitCode = code;
  });

  let browser;
  let page;
  const connect = async () => {
    browser = await waitFor(
      () =>
        exited
          ? Promise.reject(new Error(`The app exited during startup, code ${exitCode}: ${said.trim()}`))
          : chromium.connectOverCDP(`http://127.0.0.1:${port}`),
      45_000,
      'the app to start',
    );
    page = await waitFor(
      () => browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith('about:')),
      15_000,
      'the app window',
    );
    await page.waitForLoadState('domcontentloaded');
  };
  await connect();

  const handle = {
    get page() {
      return page;
    },
    get browser() {
      return browser;
    },
    child,
    get exited() {
      return exited;
    },
    /**
     * Playwright copies every request body over DevTools, which swamps the connection during
     * a large upload. Disconnect for that stretch, act with `quietSend` and `quietEvaluate`,
     * then reconnect. The app carries on regardless, and `page` is new after reconnecting.
     */
    async disconnect() {
      await browser.close();
    },
    reconnect: connect,
    /** Sends one DevTools command over a bare connection that watches nothing else. */
    async quietSend(method, params) {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const target = targets.find((t) => t.type === 'page' && !t.url.startsWith('about:'));
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        socket.onopen = res;
        socket.onerror = () => rej(new Error('Could not reach the page'));
      });
      try {
        return await new Promise((res, rej) => {
          socket.onmessage = (event) => {
            const reply = JSON.parse(event.data);
            if (reply.id !== 1) return;
            if (reply.result?.exceptionDetails || reply.error) rej(new Error(JSON.stringify(reply)));
            else res(reply.result);
          };
          socket.send(JSON.stringify({ id: 1, method, params }));
        });
      } finally {
        socket.close();
      }
    },
    /** Evaluates an expression in the page over a bare connection, awaiting any promise. */
    async quietEvaluate(expression) {
      const { result } = await handle.quietSend('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      return result.value;
    },
    /** Kills the process with no chance to clean up, like a crash or power loss. */
    async kill() {
      await browser.close().catch(() => {});
      if (!exited) execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
      await waitFor(() => exited, 10_000, 'the app to die');
      // WebView2's helpers outlive the app by a moment, longer on a busy machine, and hold
      // their folder until they go. Carries on if the file stays, as a new start may still work.
      const lock = join(workspace.webviewDir, 'EBWebView', 'lockfile');
      const deadline = Date.now() + 10_000;
      while (existsSync(lock) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 400));
    },
    /** Waits for a clean exit started by the app. */
    async waitForExit(timeoutMs = 15_000) {
      await waitFor(() => exited, timeoutMs, 'the app to exit');
      await browser.close().catch(() => {});
    },
    /** Saves a screenshot to e2e/artifacts and returns the path. */
    async screenshot(name) {
      mkdirSync(ARTIFACTS, { recursive: true });
      const path = join(ARTIFACTS, `${name}.png`);
      await page.screenshot({ path });
      return path;
    },
    /** A screenshot over a bare connection, for the stretch after `disconnect`. */
    async quietScreenshot(name) {
      mkdirSync(ARTIFACTS, { recursive: true });
      const path = join(ARTIFACTS, `${name}.png`);
      const { data } = await handle.quietSend('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path, Buffer.from(data, 'base64'));
      return path;
    },
  };
  return handle;
}

/** Calls the native RPC directly, for test setup and assertions. */
export function rpc(page, method, params) {
  return page.evaluate(
    ([m, p]) => window.__TAURI_INTERNALS__.invoke('rpc', { method: m, params: p ?? null }),
    [method, params],
  );
}

/**
 * Native file dialogs cannot be driven from a test, so this approves a path the same
 * way a dialog would. It only works under the E2E flag.
 */
export function allowPath(page, path) {
  return rpc(page, 'app.e2eAllowPath', { path });
}

/**
 * Makes the next native file dialog answer with this path, so a test can press the same
 * buttons a person would. It only works under the E2E flag.
 */
export function answerNextDialog(page, path) {
  return rpc(page, 'app.e2eQueuePick', { path });
}

/**
 * Stores bytes through the real upload path, for test setup. The bytes must really be a
 * supported type. Returns the finished asset.
 */
export function addAsset(page, { name, mime, base64, width, height }) {
  return page.evaluate(
    async ({ name, mime, base64, width, height }) => {
      const { invoke } = window.__TAURI_INTERNALS__;
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const sha256 = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
      const { id, chunkSize } = await invoke('rpc', { method: 'media.uploadBegin', params: { name, mime, size: bytes.length } });
      for (let index = 0, offset = 0; offset < bytes.length; index += 1, offset += chunkSize) {
        await invoke('media_upload_chunk', bytes.slice(offset, offset + chunkSize), {
          headers: { 'x-asset-id': id, 'x-chunk-index': String(index) },
        });
      }
      return invoke('rpc', { method: 'media.uploadFinish', params: { id, sha256, width, height } });
    },
    { name, mime, base64, width, height },
  );
}

/** What is stored for an asset, with its bytes as base64. */
export function readAsset(page, id) {
  return page.evaluate(async (id) => {
    const { invoke } = window.__TAURI_INTERNALS__;
    const info = await invoke('rpc', { method: 'media.get', params: { id } });
    const buffer = await invoke('media_read', { id, offset: 0, length: 16 * 1024 * 1024 });
    let binary = '';
    for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
    return { ...info, base64: btoa(binary) };
  }, id);
}

/** Creates a project from the start screen UI. */
export async function createProject(page, name = 'Test World') {
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('textbox').fill(name);
  await page.getByRole('button', { name: 'Create' }).click();
  await page.locator('.topbar').waitFor();
}

export const waitUntil = waitFor;

/** How much slower than a developer machine this one may be. CI sets LORECRAFT_E2E_SLOW on
 * small shared runners, so timing limits still catch real slowness without failing there. */
export const SLOW = Math.max(1, Number(process.env.LORECRAFT_E2E_SLOW) || 1);

/** A timing limit in milliseconds, stretched for a slow machine. */
export const slowLimit = (ms) => ms * SLOW;
