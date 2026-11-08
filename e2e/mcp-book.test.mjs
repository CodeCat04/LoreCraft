/**
 * The manuscript structure and book tools over MCP, at the edit level: each change shows in
 * the binder and Book settings, and Undo under Applied by outside AI takes it back. At the
 * suggest level a change waits for the writer instead.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createProject, createWorkspace, launch, rpc, waitUntil } from './harness.mjs';

const doc = (...paras) => ({ type: 'doc', content: paras.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })) });

async function connectHttp(url, token) {
  const client = new Client({ name: 'e2e-book', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.map((c) => c.text).join('\n');
  assert.equal(result.isError === true, false, `${name} failed: ${text}`);
  return text;
}

async function openSettingsTab(page) {
  await page.getByRole('button', { name: /^Text \d+%$/ }).click();
  await page.getByRole('tab', { name: 'AI tools (MCP)' }).click();
}

describe('mcp book and structure tools', () => {
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

  it('changes books, the binder and threads directly, and undoes each; suggest still queues', async () => {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page, 'Ashfall');
    const [book] = await rpc(page, 'books.list');
    const tree = await rpc(page, 'nodes.tree', { bookId: book.id });
    const chapter = tree.find((n) => n.kind === 'chapter');
    const s1 = tree.find((n) => n.kind === 'scene');
    await rpc(page, 'nodes.update', { id: s1.id, patch: { content: doc('The gate is old.', 'Rain fell on the keep.') } });
    const s2 = await rpc(page, 'nodes.create', { bookId: book.id, parentId: chapter.id, kind: 'scene', title: 'Scene 2' });
    const s3 = await rpc(page, 'nodes.create', { bookId: book.id, parentId: chapter.id, kind: 'scene', title: 'Scene 3' });

    await openSettingsTab(page);
    await page.getByRole('checkbox', { name: 'Let outside AI tools connect' }).check();
    await waitUntil(async () => (await rpc(page, 'mcp.status')).running, 5000, 'the server to start');
    const status = await rpc(page, 'mcp.status');
    await page.getByRole('combobox', { name: 'What outside tools can do' }).selectOption('edit');
    await waitUntil(async () => (await rpc(page, 'mcp.status')).permission === 'edit', 5000, 'the edit level');
    await page.keyboard.press('Escape');
    client = await connectHttp(status.url, status.token);

    await page.getByRole('button', { name: 'Write', exact: true }).click();
    const binder = page.getByRole('tree', { name: 'Book contents' });
    await binder.waitFor();
    const scenes = async () =>
      (await binder.getByRole('treeitem').allInnerTexts()).map((s) => s.split('\n')[0].trim()).filter((s) => /^Scene/.test(s));

    // Book settings.
    assert.match(await call(client, 'get_book_settings'), /Point of view: \(not set\)/);
    assert.match(await call(client, 'update_book', { new_title: 'The Ash', pov: 'first', tense: 'past', target_words: 90000 }), /^Done: /);
    await page.getByRole('button', { name: 'Book settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Book settings' });
    assert.equal(await settings.getByRole('textbox', { name: 'Title', exact: true }).inputValue(), 'The Ash');
    assert.equal(await settings.getByRole('combobox', { name: 'Point of view' }).inputValue(), 'first');
    assert.equal(await settings.getByRole('combobox', { name: 'Tense' }).inputValue(), 'past');
    await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.match(await call(client, 'get_book_settings'), /Point of view: first/);

    // The binder: rename, move, split and trash.
    assert.match(await call(client, 'rename_node', { id: chapter.id, new_title: 'Opening' }), /^Done: /);
    await binder.getByRole('treeitem', { name: /^Opening, chapter/ }).waitFor();
    assert.match(await call(client, 'move_node', { id: s2.id, before: s1.id }), /^Done: /);
    await waitUntil(async () => (await scenes()).join('|') === 'Scene 2|Scene 1|Scene 3', 5000, 'the binder to show the move');
    assert.match(await call(client, 'split_scene', { id: s1.id, quote: 'Rain fell' }), /^Done: /);
    await waitUntil(async () => (await scenes()).join('|') === 'Scene 2|Scene 1|Scene 1 (continued)|Scene 3', 5000, 'the binder to show the split');
    assert.match(await call(client, 'trash_node', { id: s3.id }), /^Done: /);
    await waitUntil(async () => (await scenes()).join('|') === 'Scene 2|Scene 1|Scene 1 (continued)', 5000, 'the binder to drop the trashed scene');
    assert.ok((await rpc(page, 'nodes.trash', { bookId: book.id })).some((n) => n.id === s3.id), 'it is in the trash, not purged');

    // Plot threads.
    assert.match(await call(client, 'create_thread', { name: 'The war' }), /^Done: /);
    assert.match(await call(client, 'add_scene_to_thread', { thread: 'The war', scene: s1.id }), /^Done: /);
    assert.match(await call(client, 'get_threads'), /The war[\s\S]*Scene 1/);

    // Undo each, newest first.
    await page.getByRole('menuitem', { name: 'AI', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Outside suggestions' }).click();
    await page.getByRole('heading', { name: 'Applied by outside AI (7)' }).waitFor();
    await app.screenshot('mcp-book-applied');
    const undo = (title) => page.getByRole('button', { name: `Undo: ${title}`, exact: true }).click();
    await undo('The war / Scene 1');
    await page.getByRole('heading', { name: 'Applied by outside AI (6)' }).waitFor();
    await undo('The war');
    await waitUntil(async () => (await rpc(page, 'threads.list')).length === 0, 5000, 'the thread to go');
    await undo('Scene 3');
    await waitUntil(async () => !(await rpc(page, 'nodes.get', { id: s3.id })).deletedAt, 5000, 'the trashed scene to come back');
    await undo('Scene 1');
    await waitUntil(async () => (await rpc(page, 'nodes.tree', { bookId: book.id })).filter((n) => n.kind === 'scene').length === 3, 5000, 'the split to be undone');
    await undo('Scene 2');
    await undo('Chapter 1');
    await undo('Book One');
    await page.getByRole('heading', { name: /^Applied by outside AI/ }).waitFor({ state: 'detached' });
    const order = (await rpc(page, 'nodes.tree', { bookId: book.id })).filter((n) => n.kind === 'scene').sort((a, b) => a.position - b.position);
    assert.deepEqual(order.map((n) => n.title), ['Scene 1', 'Scene 2', 'Scene 3']);
    assert.equal((await rpc(page, 'nodes.get', { id: s1.id })).content.content.length, 2, 'the split scene is whole again');
    assert.equal((await rpc(page, 'nodes.get', { id: chapter.id })).title, 'Chapter 1');
    assert.equal((await rpc(page, 'books.list'))[0].title, 'Book One');
    assert.match(await call(client, 'get_book_settings'), /Point of view: \(not set\)/);

    // Back at the suggest level, a change waits for the writer.
    await openSettingsTab(page);
    await page.getByRole('combobox', { name: 'What outside tools can do' }).selectOption('suggest');
    await waitUntil(async () => (await rpc(page, 'mcp.status')).permission === 'suggest', 5000, 'the suggest level');
    assert.match(await call(client, 'rename_node', { id: s2.id, new_title: 'Later' }), /Nothing has changed yet/);
    assert.equal(await rpc(page, 'mcp.proposalCount'), 1);
    assert.equal((await rpc(page, 'nodes.get', { id: s2.id })).title, 'Scene 2');
  });
});
