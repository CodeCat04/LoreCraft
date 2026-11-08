/**
 * The wiki tools over MCP at the edit level: each change is made at once, shows in the open
 * page, and Undo under Applied by outside AI takes it back. Local-only pages stay out of
 * reach, and the suggest level only queues.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createProject, createWorkspace, launch, rpc, waitUntil } from './harness.mjs';

const doc = (text, link) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text, ...(link ? { marks: [{ type: 'wikiLink', attrs: { target: link } }] } : {}) }] }],
});

async function connectHttp(url, token) {
  const client = new Client({ name: 'e2e-wiki', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { text: result.content.map((c) => c.text).join('\n'), isError: result.isError === true };
}

async function done(client, name, args) {
  const result = await call(client, name, args);
  assert.equal(result.isError, false, `${name} failed: ${result.text}`);
  assert.match(result.text, /^Done: /, `${name}: ${result.text}`);
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
  await page.keyboard.press('Escape');
}

async function openPage(page, title) {
  await page.keyboard.press('Control+k');
  await page.locator('.palette-input').fill(title);
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: title }).waitFor();
}

describe('mcp wiki tools', () => {
  let workspace;
  let app;
  let client;

  beforeEach(() => {
    workspace = createWorkspace();
  });

  afterEach(async () => {
    await client?.close().catch(() => {});
    if (app && !app.exited) await app.kill().catch(() => {});
    workspace.cleanup();
  });

  it('changes pages at the edit level, shows it, and undoes it', async () => {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page, 'Ashfall');
    const aria = await rpc(page, 'pages.create', {
      title: 'Aria',
      pageType: 'character',
      content: doc('A smith.'),
      infobox: { fields: [{ key: 'born', label: 'Born', kind: 'date', value: '312' }] },
    });
    const gate = await rpc(page, 'pages.create', { title: 'Gate', pageType: 'place', content: doc('Aria', 'Aria') });
    const secret = await rpc(page, 'pages.create', { title: 'Moon Secret', content: doc('Hidden.') });
    await rpc(page, 'pages.update', { id: secret.id, patch: { localOnly: true } });

    await openSettingsTab(page);
    await page.getByRole('checkbox', { name: 'Let outside AI tools connect' }).check();
    await waitUntil(async () => (await rpc(page, 'mcp.status')).running, 5000, 'the server to start');
    const status = await rpc(page, 'mcp.status');
    await page.keyboard.press('Escape');
    await setLevel(page, 'edit');
    client = await connectHttp(status.url, status.token);
    await openPage(page, 'Aria');

    // The infobox changes in the open page.
    await done(client, 'set_infobox_fields', { title: 'Aria', fields: [{ label: 'Born', value: '300' }, { label: 'Home', value: 'Gate', kind: 'page' }] });
    await page.locator('.wiki-infobox').getByText('300').waitFor();
    await page.locator('.wiki-infobox').getByText('Gate').waitFor();

    await done(client, 'update_page', { title: 'Aria', status: 'canon', add_categories: ['Smiths'] });
    await waitUntil(async () => (await rpc(page, 'pages.get', { id: aria.id })).status === 'canon', 5000, 'the status');

    // A rename follows links and says how many documents changed.
    const renamed = await done(client, 'rename_page', { title: 'Aria', new_title: 'Aria Vale' });
    assert.match(renamed, /1 document/);
    await page.getByRole('heading', { name: 'Aria Vale' }).waitFor();
    assert.match(JSON.stringify((await rpc(page, 'pages.get', { id: gate.id })).content), /Aria Vale/);

    await done(client, 'add_talk_note', { title: 'Aria Vale', text: 'Check her age against the war.' });
    await done(client, 'add_relationship', { from: 'Aria Vale', to: 'Gate', kind: 'ally' });
    assert.equal((await rpc(page, 'extras.relationshipList', { pageId: aria.id })).length, 1);
    await done(client, 'trash_page', { title: 'Gate' });
    assert.ok((await rpc(page, 'pages.get', { id: gate.id })).deletedAt);

    // The Talk tab shows the note.
    await page.getByRole('button', { name: 'Talk', exact: true }).click();
    await page.locator('.wiki-talk').getByText('Check her age against the war.').waitFor();

    // Local-only pages cannot be found, so they cannot be changed.
    const refused = await call(client, 'update_page', { title: 'Moon Secret', status: 'canon' });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /not found/);

    // Each shows under Applied by outside AI, and Undo takes them back, newest first.
    await page.getByRole('menuitem', { name: 'AI', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Outside suggestions' }).click();
    await page.getByRole('heading', { name: 'Applied by outside AI (6)' }).waitFor();
    await page.getByRole('button', { name: 'Undo: Gate', exact: true }).click();
    await waitUntil(async () => !(await rpc(page, 'pages.get', { id: gate.id })).deletedAt, 5000, 'the page to come back');
    await page.getByRole('button', { name: 'Undo: Aria Vale ally Gate' }).click();
    await waitUntil(async () => (await rpc(page, 'extras.relationshipList', { pageId: aria.id })).length === 0, 5000, 'the relationship to go');
    await page.getByRole('button', { name: 'Undo: Aria Vale', exact: true }).click();
    await waitUntil(async () => !/Check her age/.test(JSON.stringify((await rpc(page, 'pages.get', { id: aria.id })).notes)), 5000, 'the note to go');
    await page.getByRole('button', { name: 'Undo: Aria', exact: true }).first().click();
    await waitUntil(async () => (await rpc(page, 'pages.get', { id: aria.id })).title === 'Aria', 5000, 'the old title');
    assert.doesNotMatch(JSON.stringify((await rpc(page, 'pages.get', { id: gate.id })).content), /Aria Vale/);
    await page.getByRole('button', { name: 'Undo: Aria', exact: true }).first().click();
    await waitUntil(async () => (await rpc(page, 'pages.get', { id: aria.id })).status === 'draft', 5000, 'the old status');
    await page.getByRole('button', { name: 'Undo: Aria', exact: true }).first().click();
    await waitUntil(
      async () => (await rpc(page, 'pages.get', { id: aria.id })).infobox.fields.map((f) => f.value).join() === '312',
      5000,
      'the old infobox',
    );
    await page.getByRole('heading', { name: 'Applied by outside AI' }).waitFor({ state: 'detached' });

    // At the suggest level, a change only waits for the writer.
    await setLevel(page, 'suggest');
    const queued = await call(client, 'trash_page', { title: 'Gate' });
    assert.match(queued.text, /Nothing has changed yet/);
    assert.equal(await rpc(page, 'mcp.proposalCount'), 1);
    assert.equal((await rpc(page, 'pages.get', { id: gate.id })).deletedAt, null);
  });
});
