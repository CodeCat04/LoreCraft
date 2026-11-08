/**
 * Outside AI tools for canvases, consistency checks and media, at the edit level against the
 * real app: an edit shows live in the open canvas, a rule check runs and reports, a finding is
 * dismissed, a picture is labelled, and Undo takes each back. The suggest level only queues.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { addAsset, createProject, createWorkspace, launch, rpc, waitUntil } from './harness.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const doc = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const BOARD = '.canvas-board';

async function connectHttp(url, token) {
  const client = new Client({ name: 'e2e-canvas', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { text: result.content.map((c) => c.text).join('\n'), isError: result.isError === true };
}

async function read(client, name, args) {
  const result = await call(client, name, args);
  assert.equal(result.isError, false, `${name} failed: ${result.text}`);
  return result.text;
}

async function openSettingsTab(page) {
  await page.getByRole('button', { name: /^Text \d+%$/ }).click();
  await page.getByRole('tab', { name: 'AI tools (MCP)' }).click();
}

async function setLevel(page, level) {
  await openSettingsTab(page);
  await page.getByRole('combobox', { name: 'What outside tools can do' }).selectOption(level);
  await waitUntil(async () => (await rpc(page, 'mcp.status')).permission === level, 5000, `the ${level} level`);
}

async function openApplied(page, count) {
  await page.getByRole('menuitem', { name: 'AI', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Outside suggestions' }).click();
  await page.getByRole('heading', { name: `Applied by outside AI (${count})` }).waitFor();
}

describe('mcp canvases, checks and media', () => {
  let workspace;
  let app;
  let http;

  beforeEach(() => {
    workspace = createWorkspace();
  });

  afterEach(async () => {
    await http?.close().catch(() => {});
    http = null;
    if (app && !app.exited) await app.kill().catch(() => {});
    workspace.cleanup();
  });

  it('edits an open canvas live, runs a check, dismisses a finding and labels a picture, with Undo', async () => {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page, 'Ashfall');
    const aria = await rpc(page, 'pages.create', { title: 'Aria Vance', status: 'canon', content: doc('Aria crossed the ember gate.') });
    const secret = await rpc(page, 'pages.create', { title: 'Moon Secret', status: 'canon', content: doc('The moonstone betrays everyone.') });
    await rpc(page, 'pages.update', { id: secret.id, patch: { localOnly: true } });
    // Two pages sharing an alias: a rule check finds that.
    await rpc(page, 'pages.create', { title: 'Bren Hollow', aliases: ['The Smith'] });
    await rpc(page, 'pages.create', { title: 'Cal Hollow', aliases: ['The Smith'] });
    const picture = await addAsset(page, { name: 'north.jpg', mime: 'image/jpeg', base64: readFileSync(join(FIXTURES, 'tiny.jpg')).toString('base64'), width: 1, height: 1 });
    const board = await rpc(page, 'canvases.create', {
      title: 'War board',
      data: {
        nodes: [
          { id: 't1', type: 'text', text: 'The ember war', x: 0, y: 0, width: 260, height: 80 },
          { id: 's1', type: 'file', file: `lorecraft:page/${secret.id}`, x: 0, y: 300, width: 400, height: 300 },
        ],
        edges: [],
      },
    });

    // The writer has the canvas open.
    await page.getByRole('button', { name: 'Atlas', exact: true }).click();
    await page.locator('.nav-link', { hasText: 'War board' }).click();
    await page.locator(BOARD).waitFor();
    await page.locator('.canvas-card', { hasText: 'The ember war' }).waitFor();

    await openSettingsTab(page);
    await page.getByRole('checkbox', { name: 'Let outside AI tools connect' }).check();
    await waitUntil(async () => (await rpc(page, 'mcp.status')).running, 5000, 'the server to start');
    const { url, token } = await rpc(page, 'mcp.status');
    http = await connectHttp(url, token);

    // The suggest level only queues.
    const queued = await read(http, 'edit_canvas', { canvas: 'War board', operations: [{ op: 'add_text', text: 'Queued card' }] });
    assert.match(queued, /Nothing has changed yet/);
    assert.equal(await rpc(page, 'mcp.proposalCount'), 1);

    await setLevel(page, 'edit');
    await page.getByRole('button', { name: 'Atlas', exact: true }).click();
    await page.locator('.nav-link', { hasText: 'War board' }).click();
    await page.locator(BOARD).waitFor();

    // A hidden card is not there for the AI, and cannot be reached.
    const seen = await read(http, 'get_canvas', { title: 'War board' });
    assert.match(seen, /1 card is hidden/);
    assert.doesNotMatch(seen, /Moon Secret|moonstone/);
    assert.equal((await call(http, 'edit_canvas', { canvas: 'War board', operations: [{ op: 'remove', card: 's1' }] })).isError, true);

    // A canvas edit shows in the open board at once.
    const edited = await read(http, 'edit_canvas', {
      canvas: 'War board',
      operations: [
        { op: 'add_page', page: 'Aria Vance', as: 'aria' },
        { op: 'connect', from: 'The ember war', to: 'aria', label: 'leads' },
        { op: 'color', card: 'The ember war', color: 'red' },
      ],
    });
    assert.match(edited, /^Done: /);
    await page.locator('.canvas-card', { hasText: 'Aria Vance' }).waitFor();
    await page.locator('.canvas-card.has-color', { hasText: 'The ember war' }).waitFor();
    await waitUntil(async () => (await rpc(page, 'canvases.get', { id: board.id })).data.nodes.length === 3, 5000, 'the edit to be saved');
    const stored = (await rpc(page, 'canvases.get', { id: board.id })).data;
    assert.equal(stored.edges.length, 1);
    assert.equal(stored.nodes.find((n) => n.file === `lorecraft:page/${aria.id}`) !== undefined, true);

    // A rule check runs and says what it found.
    const ran = await read(http, 'run_consistency_check');
    assert.match(ran, /^Done: ran the rule checks\. \d+ open findings?/);
    const listed = await read(http, 'list_findings');
    const findingId = /The Smith.*\(id ([^)]+)\)/.exec(listed)?.[1] ?? /\(id ([^)]+)\)/.exec(listed)?.[1];
    assert.ok(findingId, listed);

    // A finding is dismissed.
    assert.match(await read(http, 'dismiss_finding', { id: findingId }), /^Done: dismissed/);
    assert.equal((await rpc(page, 'consistency.list', {})).find((f) => f.id === findingId).status, 'ignored');

    // A picture is labelled.
    const media = await read(http, 'list_media');
    assert.match(media, new RegExp(picture.id));
    assert.match(await read(http, 'label_media', { id: picture.id, label: 'Map of the north', description: 'A hand-drawn map.' }), /^Done: /);
    assert.equal((await rpc(page, 'media.get', { id: picture.id })).label, 'Map of the north');

    // Each shows under Applied by outside AI, and Undo takes it back.
    await openApplied(page, 4);
    await page.getByRole('button', { name: 'Undo: Map of the north' }).click();
    await waitUntil(async () => (await rpc(page, 'media.get', { id: picture.id })).label === '', 5000, 'the label to be undone');
    await page.getByRole('button', { name: /^Undo: .*The Smith/ }).click();
    await waitUntil(async () => (await rpc(page, 'consistency.list', {})).find((f) => f.id === findingId).status === 'open', 5000, 'the finding to reopen');
    await page.getByRole('button', { name: 'Undo: War board' }).click();
    await waitUntil(async () => (await rpc(page, 'canvases.get', { id: board.id })).data.nodes.length === 2, 5000, 'the canvas edit to be undone');
    await page.getByRole('button', { name: 'Undo: Rule checks' }).click();
    await page.getByRole('heading', { name: 'Applied by outside AI' }).waitFor({ state: 'detached' });

    // The open board shows the canvas as it was.
    await page.getByRole('button', { name: 'Atlas', exact: true }).click();
    await page.locator('.nav-link', { hasText: 'War board' }).click();
    await page.locator('.canvas-card', { hasText: 'The ember war' }).waitFor();
    assert.equal(await page.locator('.canvas-card', { hasText: 'Aria Vance' }).count(), 0);
  });
});
