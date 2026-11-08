/**
 * The MCP tools for writing styles, the default style, the prompt library, the idea inbox and
 * comments, at the edit level with Undo, and at the suggest level, through a real MCP client
 * against the real executable. Setup as in `mcp.test.mjs`.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createProject, createWorkspace, launch, rpc, waitUntil } from './harness.mjs';

const doc = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

async function connectHttp(url, token) {
  const client = new Client({ name: 'Claude Code', version: '1.0.0' });
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

async function done(client, name, args) {
  const text = await read(client, name, args);
  assert.match(text, /^Done: /, `${name}: ${text}`);
  return text;
}

async function seed(page) {
  const aria = await rpc(page, 'pages.create', { title: 'Aria Vance', status: 'canon', content: doc('Aria crossed the ember gate at dawn.') });
  const secret = await rpc(page, 'pages.create', { title: 'Moon Secret', content: doc('The moonstone betrays everyone.') });
  await rpc(page, 'pages.update', { id: secret.id, patch: { localOnly: true } });
  const [book] = await rpc(page, 'books.list');
  const tree = await rpc(page, 'nodes.tree', { bookId: book.id });
  const scene = tree.find((n) => n.kind === 'scene');
  await rpc(page, 'nodes.update', { id: scene.id, patch: { title: 'The gate at dawn', content: doc('Rain fell on the ember gate.') } });
  return { aria, secret, scene };
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

const choices = async (page) => JSON.parse((await rpc(page, 'project.getMeta', { key: 'writingStyles.choices' })) ?? '{}');
const ideaList = (page) => rpc(page, 'ideas.list', {});
const commentsOn = (page, id) => rpc(page, 'comments.list', { sourceKind: 'page', sourceId: id });

describe('mcp: styles, prompts, ideas and comments', () => {
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

  it('changes styles, the default style, prompts, ideas and comments directly, and Undo takes each back', async () => {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page, 'Ashfall');
    const { aria } = await seed(page);
    await openSettingsTab(page);
    await page.getByRole('checkbox', { name: 'Let outside AI tools connect' }).check();
    await waitUntil(async () => (await rpc(page, 'mcp.status')).running, 5000, 'the server to start');
    const status = await rpc(page, 'mcp.status');
    await page.getByRole('combobox', { name: 'What outside tools can do' }).selectOption('edit');
    await waitUntil(async () => (await rpc(page, 'mcp.status')).permission === 'edit', 5000, 'the edit level');
    client = await connectHttp(status.url, status.token);

    // The style guide names its fields.
    await done(client, 'set_style_guide', { tense: 'Past tense', voice: 'Wry.' });
    const guide = await read(client, 'get_style_guide');
    assert.match(guide, /## tense \(Tense\)\nPast tense/);
    assert.match(guide, /## voice/);

    // Writing styles: the library is there, a new style is made, and it becomes the default.
    assert.match(await read(client, 'list_writing_styles', { query: 'christie' }), /Agatha Christie \(id agatha-christie; author/);
    assert.match(await read(client, 'get_writing_style', { style: 'agatha-christie' }), /Prompt given to the AI:\nWrite in the manner of Agatha Christie\./);
    await done(client, 'create_writing_style', { name: 'Glass voice', prompt: 'Bright, brittle sentences.' });
    const mine = await read(client, 'list_writing_styles', { kind: 'custom' });
    assert.match(mine, /Glass voice \(id custom-/);
    const builtIn = await call(client, 'update_writing_style', { style: 'agatha-christie', name: 'Mine' });
    assert.equal(builtIn.isError, true);
    assert.match(builtIn.text, /built-in style/);
    await done(client, 'set_default_style', { style: 'Glass voice' });
    assert.equal((await choices(page)).project.name, 'Glass voice');
    assert.match(await read(client, 'list_writing_styles', { kind: 'custom' }), /Project default style: Glass voice/);

    // A prompt of the writer's own.
    await done(client, 'create_prompt', { name: 'Tighten', template: 'Tighten this: {{selection}}', scope: 'selection' });
    assert.match(await read(client, 'list_prompts', { scope: 'selection' }), /Tighten/);

    // Ideas: added with Undo at this level, then marked done.
    await done(client, 'add_idea', { text: 'What if the gate remembers?' });
    const [idea] = (await ideaList(page)).filter((i) => i.text.startsWith('What if the gate remembers?'));
    assert.ok(idea, 'the idea is in the inbox');
    assert.match(await read(client, 'list_ideas'), /What if the gate remembers\?/);
    await done(client, 'resolve_idea', { id: idea.id, status: 'done' });
    assert.equal((await ideaList(page)).find((i) => i.id === idea.id).status, 'done');

    // A comment on a quoted passage, through the app's comment code.
    await done(client, 'add_comment', { target: 'page', title: 'Aria Vance', quote: 'the ember gate', text: 'Which gate is this?' });
    const [comment] = await commentsOn(page, aria.id);
    assert.equal(comment.author, 'Claude Code');
    assert.match(JSON.stringify((await rpc(page, 'pages.get', { id: aria.id })).content), /"type":"comment"/);
    assert.match(await read(client, 'list_comments', { title: 'Aria Vance' }), /Which gate is this\?/);
    const hidden = await call(client, 'add_comment', { title: 'Moon Secret', quote: 'moonstone', text: 'x' });
    assert.equal(hidden.isError, true);

    // Each shows under Applied by outside AI, and Undo takes them back, newest first.
    await page.getByRole('menuitem', { name: 'AI', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Outside suggestions' }).click();
    await page.getByRole('heading', { name: 'Applied by outside AI (7)' }).waitFor();
    await app.screenshot('mcp-organize-applied');

    await page.getByRole('button', { name: 'Undo: Aria Vance' }).click();
    await waitUntil(async () => (await commentsOn(page, aria.id)).length === 0, 5000, 'the comment to go');
    assert.doesNotMatch(JSON.stringify((await rpc(page, 'pages.get', { id: aria.id })).content), /"type":"comment"/);

    await page.getByRole('button', { name: /^Undo: Idea: What if the gate/ }).first().click();
    await waitUntil(async () => (await ideaList(page)).find((i) => i.id === idea.id)?.status === 'open', 5000, 'the idea to open again');
    await page.getByRole('button', { name: /^Undo: Idea: What if the gate/ }).first().click();
    await waitUntil(async () => !(await ideaList(page)).some((i) => i.id === idea.id), 5000, 'the idea to go');

    await page.getByRole('button', { name: 'Undo: Tighten' }).click();
    await waitUntil(async () => !/Tighten/.test(await read(client, 'list_prompts', { scope: 'selection' })), 5000, 'the prompt to go');

    await page.getByRole('button', { name: 'Undo: Default style for the project' }).click();
    await waitUntil(async () => !(await choices(page)).project, 5000, 'the default style to clear');

    await page.getByRole('button', { name: 'Undo: Glass voice' }).click();
    await waitUntil(async () => !/Glass voice/.test(await read(client, 'list_writing_styles', { kind: 'custom' })), 5000, 'the style to go');

    await page.getByRole('button', { name: 'Undo: Style guide' }).click();
    await page.getByRole('heading', { name: /Applied by outside AI/ }).waitFor({ state: 'detached' });

    // At the suggest level a style waits for the writer, and an idea still goes straight in.
    await setLevel(page, 'suggest');
    assert.match(await read(client, 'create_writing_style', { name: 'Later', prompt: 'Slow.' }), /does not exist yet/);
    assert.equal(await rpc(page, 'mcp.proposalCount'), 1);
    assert.doesNotMatch(await read(client, 'list_writing_styles', { kind: 'custom' }), /Later/);
    assert.match(await read(client, 'add_idea', { text: 'A second idea.' }), /Added to the writer's idea inbox/);
    assert.ok((await ideaList(page)).some((i) => i.text.startsWith('A second idea.')));
    assert.equal(await rpc(page, 'mcp.proposalCount'), 1);
  });
});
