/**
 * The MCP server, through a real MCP client (`@modelcontextprotocol/sdk`) against the real
 * executable. Stdio runs use a copy patched to the Windows GUI subsystem, which is what a
 * release build uses, to prove pipes work there and that no console window is involved.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { allowPath, createProject, createWorkspace, launch, rpc, waitUntil } from './harness.mjs';

const doc = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

/** A copy of the app's exe marked as a GUI program, the way a release build is linked. */
function guiExe(workspace) {
  const target = join(workspace.root, 'bin', 'lorebook-gui.exe');
  if (!existsSync(target)) {
    const bytes = readFileSync(join(workspace.root, 'bin', 'lorecraft.exe'));
    const peHeader = bytes.readUInt32LE(0x3c);
    const subsystemAt = peHeader + 24 + 68;
    assert.ok([2, 3].includes(bytes.readUInt16LE(subsystemAt)), 'found the subsystem field');
    bytes.writeUInt16LE(2, subsystemAt); // IMAGE_SUBSYSTEM_WINDOWS_GUI
    writeFileSync(target, bytes);
  }
  return target;
}

async function connectStdio(workspace, args, name = 'e2e-stdio') {
  const client = new Client({ name, version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: guiExe(workspace),
    args: ['--mcp', ...args],
    env: { ...process.env, LORECRAFT_DATA_DIR: workspace.dataDir },
    stderr: 'pipe',
  });
  await client.connect(transport);
  return client;
}

async function connectHttp(url, token, name = 'e2e-http') {
  const client = new Client({ name, version: '2.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

/** A tool's text. An error result still has text, so it can be checked. */
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { text: result.content.map((c) => c.text).join('\n'), isError: result.isError === true };
}

async function read(client, name, args) {
  const result = await call(client, name, args);
  assert.equal(result.isError, false, `${name} failed: ${result.text}`);
  return result.text;
}

async function seed(page) {
  const aria = await rpc(page, 'pages.create', {
    title: 'Aria Vance',
    status: 'canon',
    summary: 'The queen who fell.',
    content: doc('Aria crossed the ember gate at dawn.'),
    aliases: ['The Ash Queen'],
    categories: ['People'],
  });
  await rpc(page, 'pages.create', { title: 'Old Keep', status: 'retconned', content: doc('The keep never existed.') });
  const secret = await rpc(page, 'pages.create', {
    title: 'Moon Secret',
    status: 'canon',
    content: doc('The moonstone betrays everyone in the last chapter.'),
  });
  const [book] = await rpc(page, 'books.list');
  const tree = await rpc(page, 'nodes.tree', { bookId: book.id });
  const scene = tree.find((n) => n.kind === 'scene');
  await rpc(page, 'nodes.update', {
    id: scene.id,
    patch: { title: 'The gate at dawn', synopsis: 'Aria arrives.', content: doc('Rain fell on the ember gate.') },
  });
  await rpc(page, 'pages.update', { id: secret.id, patch: { localOnly: true } });
  return { aria, secret, scene, book };
}

async function openSettingsTab(page) {
  await page.getByRole('button', { name: /^Text \d+%$/ }).click();
  await page.getByRole('tab', { name: 'AI tools (MCP)' }).click();
}

async function turnOn(page) {
  await openSettingsTab(page);
  await page.getByRole('checkbox', { name: 'Let outside AI tools connect' }).check();
  await waitUntil(async () => (await rpc(page, 'mcp.status')).running, 5000, 'the server to start');
  return rpc(page, 'mcp.status');
}

function raw(port, { path = '/mcp', method = 'POST', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      res.resume();
      resolve(res.statusCode);
      res.destroy();
    });
    req.on('error', reject);
    req.end(body);
  });
}

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
});

describe('mcp', () => {
  let workspace;
  let app;
  const clients = [];

  async function saved(path) {
    await allowPath(app.page, path);
    await rpc(app.page, 'project.saveAs', { path });
  }

  /** A clean exit. The call itself may not come back, since the window goes with it. */
  async function quit() {
    await rpc(app.page, 'app.quit').catch(() => {});
    await app.waitForExit();
  }

  /** Remembers a client so it is closed even if the test fails. */
  function track(client) {
    clients.push(client);
    return client;
  }

  beforeEach(() => {
    workspace = createWorkspace();
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close().catch(() => {});
    if (app && !app.exited) await app.kill().catch(() => {});
    workspace.cleanup();
  });

  it('reads the saved file over stdio with the app closed, without changing it', async () => {
    app = await launch(workspace);
    await createProject(app.page, 'Ashfall');
    await seed(app.page);
    await turnOn(app.page);
    const file = workspace.file('ashfall.lorecraft');
    await saved(file);
    await quit();
    assert.equal(existsSync(join(workspace.dataDir, 'mcp.json')), false, 'a clean exit removes the address');

    const before = readFileSync(file);
    const client = track(await connectStdio(workspace, ['--project', file]));

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of ['catch_me_up', 'search_lore', 'get_page', 'list_pages', 'get_outline', 'get_scene', 'get_chapter', 'get_timeline', 'get_relationships', 'list_findings', 'get_style_guide', 'propose_edit', 'propose_new_page', 'add_idea']) {
      assert.ok(names.includes(name), `${name} is listed`);
    }
    assert.match(tools.find((t) => t.name === 'get_page').description, /retconned/);

    const overview = await read(client, 'catch_me_up');
    assert.match(overview, /ashfall/);
    assert.match(overview, /last saved file/);
    assert.match(overview, /Aria Vance/);
    assert.match(overview, /The gate at dawn/);
    assert.doesNotMatch(overview, /Moon Secret|moonstone/);

    const small = await read(client, 'catch_me_up', { max_chars: 1200 });
    assert.ok(small.length <= 1200, `kept to the limit: ${small.length}`);
    assert.match(small, /Reading more/);

    const page = await read(client, 'get_page', { title: 'the ash queen' });
    assert.match(page, /# Aria Vance/);
    assert.match(page, /canon/);
    assert.match(page, /ember gate/);
    assert.match(await read(client, 'get_page', { title: 'Old Keep' }), /retconned/);

    const found = await read(client, 'search_lore', { query: 'ember' });
    assert.match(found, /Aria Vance/);
    assert.match(found, /The gate at dawn/);

    assert.match(await read(client, 'get_outline'), /The gate at dawn/);
    assert.ok((await call(client, 'get_page', { title: 'Moon Secret' })).isError);

    const refused = await call(client, 'propose_edit', {
      target: 'page',
      title: 'Aria Vance',
      quote: 'ember gate',
      replacement: 'iron gate',
    });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /need LoreCraft to be open/);

    const prompts = await client.listPrompts();
    assert.equal(prompts.prompts[0].name, 'catch_up');
    const resources = await client.listResources();
    const aria = resources.resources.find((r) => r.name === 'Aria Vance');
    assert.ok(aria);
    assert.equal(resources.resources.some((r) => r.name === 'Moon Secret'), false);
    const contents = await client.readResource({ uri: aria.uri });
    assert.match(contents.contents[0].text, /ember gate/);

    await client.close();
    assert.ok(before.equals(readFileSync(file)), 'the file is byte for byte the same');
    const beside = readdirSync(workspace.root).filter((name) => name.startsWith('ashfall'));
    assert.deepEqual(beside, ['ashfall.lorecraft'], 'nothing is left beside the file');
  });

  it('keeps stdout to protocol messages and exits when the client closes stdin', async () => {
    app = await launch(workspace);
    await createProject(app.page, 'Pipes');
    await turnOn(app.page);
    const file = workspace.file('pipes.lorecraft');
    await saved(file);
    await app.kill();

    const child = spawn(guiExe(workspace), ['--mcp', '--project', file], {
      env: { ...process.env, LORECRAFT_DATA_DIR: workspace.dataDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    const exited = new Promise((resolve) => child.on('exit', resolve));
    child.stdin.write(`${INITIALIZE}\n`);
    await waitUntil(() => stdout.includes('"id":1'), 15000, 'the initialize answer');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    // Nothing answers at the address a crash left behind, so this reads the file.
    assert.equal(existsSync(join(workspace.dataDir, 'mcp.json')), true, 'the kill left a stale address');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'catch_me_up', arguments: {} } })}\n`);
    await waitUntil(() => stdout.includes('"id":3'), 20000, 'the catch_me_up answer');
    child.stdin.end();
    assert.equal(await exited, 0);

    const lines = stdout.split('\n').filter(Boolean);
    assert.ok(lines.length >= 3);
    for (const line of lines) assert.equal(JSON.parse(line).jsonrpc, '2.0', `only protocol on stdout: ${line}`);
    const answer = JSON.parse(lines.find((l) => l.includes('"id":3')));
    assert.match(answer.result.content[0].text, /pipes/);
  });

  it('serves live work over HTTP and the stdio bridge, and applies a suggestion only when accepted', async () => {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page, 'Live World');
    const { aria, scene } = await seed(page);
    const status = await turnOn(page);
    await app.screenshot('mcp-settings');
    const file = workspace.file('live.lorecraft');
    await saved(file);

    // Not saved to the file: this only exists in the working copy.
    await rpc(page, 'pages.update', { id: aria.id, patch: { content: doc('Unsaved words about the comet over the gate.') } });
    assert.equal((await rpc(page, 'project.status')).dirty, true);

    const http = track(await connectHttp(status.url, status.token));
    assert.match(await read(http, 'get_page', { title: 'Aria Vance' }), /comet/);
    assert.match(await read(http, 'catch_me_up'), /live work/);

    const bridge = track(await connectStdio(workspace, ['--project', file]));
    assert.match(await read(bridge, 'get_page', { title: 'Aria Vance' }), /comet/);
    const noProject = track(await connectStdio(workspace, []));
    assert.match(await read(noProject, 'get_page', { title: 'Aria Vance' }), /comet/);

    await waitUntil(async () => {
      const names = (await rpc(page, 'mcp.status')).clients.map((c) => c.name);
      return names.includes('e2e-http') && names.includes('e2e-stdio');
    }, 5000, 'both clients to be listed');
    const activity = (await rpc(page, 'mcp.status')).activity;
    assert.ok(activity.some((a) => a.tool === 'get_page' && a.client === 'e2e-http'));
    assert.equal(JSON.stringify(activity).includes('comet'), false, 'the log holds no text');
    assert.equal(JSON.stringify(activity).includes('Aria'), false, 'the log holds no titles');
    await page.getByTestId('mcp-activity').scrollIntoViewIfNeeded();
    await app.screenshot('mcp-settings-active');

    // A suggestion changes nothing until accepted.
    const quoteOk = await read(http, 'propose_edit', {
      target: 'page',
      title: 'Aria Vance',
      quote: 'about the comet',
      replacement: 'about the falling star',
      reason: 'A comet does not fit the calendar.',
    });
    assert.match(quoteOk, /Nothing has changed yet/);
    assert.match(JSON.stringify((await rpc(page, 'pages.get', { id: aria.id })).content), /comet/);

    const missing = await call(http, 'propose_edit', { target: 'page', title: 'Aria Vance', quote: 'no such words', replacement: 'x' });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /not in/);

    await page.getByRole('button', { name: '1 outside suggestion' }).click();
    await page.getByRole('heading', { name: /Outside suggestions \(1\)/ }).waitFor();
    assert.match(await page.locator('.mcp-diff ins').first().innerText(), /falling star/);
    assert.match(await page.locator('.mcp-diff del').first().innerText(), /comet/);
    await app.screenshot('mcp-proposals');

    await page.getByRole('button', { name: 'Accept: Aria Vance' }).click();
    await waitUntil(
      async () => JSON.stringify((await rpc(page, 'pages.get', { id: aria.id })).content).includes('falling star'),
      5000,
      'the edit to apply',
    );
    assert.match(await read(http, 'get_page', { title: 'Aria Vance' }), /falling star/);
    const revisions = await rpc(page, 'revisions.list', { kind: 'page', id: aria.id });
    assert.ok(revisions.some((r) => r.reason === 'ai'), 'a revision was made first');
    await waitUntil(async () => (await rpc(page, 'mcp.proposalCount')) === 0, 3000, 'the list to empty');

    // Through the bridge, on a scene, and rejected.
    await read(bridge, 'propose_edit', { target: 'scene', id: scene.id, quote: 'Rain fell', replacement: 'Snow fell' });
    await page.getByRole('button', { name: 'Reject: The gate at dawn' }).click();
    await waitUntil(async () => (await rpc(page, 'mcp.proposalCount')) === 0, 3000, 'the rejection');
    assert.match(JSON.stringify((await rpc(page, 'nodes.get', { id: scene.id })).content), /Rain fell/);

    // Through the bridge, on a scene, and accepted.
    await read(bridge, 'propose_edit', { target: 'scene', id: scene.id, quote: 'Rain fell', replacement: 'Ash fell' });
    await page.getByRole('button', { name: 'Accept: The gate at dawn' }).click();
    await waitUntil(
      async () => JSON.stringify((await rpc(page, 'nodes.get', { id: scene.id })).content).includes('Ash fell'),
      5000,
      'the scene edit to apply',
    );
    // Saving already recorded this exact text, so the checkpoint has nothing new to store.
    const sceneRevisions = await rpc(page, 'revisions.list', { kind: 'node', id: scene.id });
    const versions = await Promise.all(sceneRevisions.map((r) => rpc(page, 'revisions.get', { id: r.id })));
    assert.ok(versions.some((v) => JSON.stringify(v).includes('Rain fell')), 'the old text is in History');

    // Many at once, after a question. Rejecting all changes nothing.
    await read(bridge, 'propose_edit', { target: 'scene', id: scene.id, quote: 'Ash fell', replacement: 'Hail fell' });
    await read(http, 'propose_edit', { target: 'page', title: 'Aria Vance', quote: 'falling star', replacement: 'bright omen' });
    await page.getByRole('heading', { name: /Outside suggestions \(2\)/ }).waitFor();
    await page.locator('.mcp-bulk').getByRole('button', { name: 'Reject all' }).click();
    const askReject = page.getByRole('alertdialog');
    await askReject.getByText('Reject all 2 suggestions?').waitFor();
    await askReject.getByRole('button', { name: 'Reject all' }).click();
    await waitUntil(async () => (await rpc(page, 'mcp.proposalCount')) === 0, 5000, 'every suggestion rejected');
    assert.match(JSON.stringify((await rpc(page, 'nodes.get', { id: scene.id })).content), /Ash fell/);
    assert.match(JSON.stringify((await rpc(page, 'pages.get', { id: aria.id })).content), /falling star/);

    // Accepting all makes every change.
    await read(bridge, 'propose_edit', { target: 'scene', id: scene.id, quote: 'Ash fell', replacement: 'Hail fell' });
    await read(http, 'propose_edit', { target: 'page', title: 'Aria Vance', quote: 'falling star', replacement: 'bright omen' });
    await page.getByRole('heading', { name: /Outside suggestions \(2\)/ }).waitFor();
    await page.locator('.mcp-bulk').getByRole('button', { name: 'Accept all' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Accept all' }).click();
    await waitUntil(async () => (await rpc(page, 'mcp.proposalCount')) === 0, 5000, 'every suggestion accepted');
    assert.match(JSON.stringify((await rpc(page, 'nodes.get', { id: scene.id })).content), /Hail fell/);
    assert.match(JSON.stringify((await rpc(page, 'pages.get', { id: aria.id })).content), /bright omen/);
    await rpc(page, 'pages.update', { id: aria.id, patch: { content: doc('Aria watched the sky, talking about the falling star.') } });

    // A figure beside an accepted edit keeps every attribute, and is named in plain text.
    const figure = {
      type: 'figure',
      attrs: { kind: 'figure', align: 'left', width: 35, description: 'Aria at dawn' },
      content: [
        { type: 'image', attrs: { assetId: 'asset-1', src: null, alt: null, title: null, width: null, height: null } },
        { type: 'figcaption', content: [{ type: 'text', text: 'The ember gate' }] },
      ],
    };
    const atlas = await rpc(page, 'pages.create', {
      title: 'Gate Atlas',
      status: 'draft',
      content: { type: 'doc', content: [doc('Words before.').content[0], figure, doc('Words after.').content[0]] },
    });
    assert.match(await read(http, 'get_page', { title: 'Gate Atlas' }), /\[Figure 1: The ember gate \(Aria at dawn\)\]/);
    await read(http, 'propose_edit', { target: 'page', id: atlas.id, quote: 'Words after.', replacement: 'Words afterwards.' });
    await page.getByRole('button', { name: 'Accept: Gate Atlas' }).click();
    await waitUntil(
      async () => JSON.stringify((await rpc(page, 'pages.get', { id: atlas.id })).content).includes('Words afterwards.'),
      5000,
      'the edit beside the figure',
    );
    const kept = (await rpc(page, 'pages.get', { id: atlas.id })).content.content[1];
    assert.deepEqual(kept.attrs, figure.attrs);
    assert.equal(kept.content[0].attrs.assetId, 'asset-1');

    // A quote that has gone by the time it is accepted says so and changes nothing.
    await read(http, 'propose_edit', { target: 'page', title: 'Aria Vance', quote: 'falling star', replacement: 'meteor' });
    await rpc(page, 'pages.update', { id: aria.id, patch: { content: doc('Rewritten entirely.') } });
    await page.getByRole('button', { name: 'Accept: Aria Vance' }).click();
    await page.getByRole('alert').filter({ hasText: 'no longer there' }).waitFor();
    assert.match(JSON.stringify((await rpc(page, 'pages.get', { id: aria.id })).content), /Rewritten entirely/);
    await page.getByRole('button', { name: 'Reject: Aria Vance' }).click();
    await waitUntil(async () => (await rpc(page, 'mcp.proposalCount')) === 0, 3000, 'the rejection');

    // A new page, created as a draft, with its Markdown read properly.
    await read(http, 'propose_new_page', {
      title: 'The Ember Gate',
      type: 'place',
      body: 'An *old* gate near [[Aria Vance]].\n\n<script>window.hacked = true</script>',
      summary: 'The city gate.',
      infobox: { Built: 'Year 12' },
      aliases: ['Old Gate'],
    });
    await page.getByRole('heading', { name: /Outside suggestions \(1\)/ }).waitFor();
    assert.equal(await page.evaluate(() => window.hacked === true), false);
    await app.screenshot('mcp-new-page');
    await page.getByRole('button', { name: 'Accept: The Ember Gate' }).click();
    const made = await waitUntil(() => rpc(page, 'pages.getByTitle', { title: 'The Ember Gate' }), 5000, 'the new page');
    assert.equal(made.status, 'draft');
    assert.equal(made.pageType, 'place');
    assert.deepEqual(made.aliases, ['Old Gate']);
    assert.equal(made.infobox.fields[0].label, 'Built');
    assert.match(JSON.stringify(made.content), /"italic"/);
    assert.match(JSON.stringify(made.content), /"wikiLink"/);
    const taken = await call(http, 'propose_new_page', { title: 'The Ember Gate', body: 'Again.' });
    assert.equal(taken.isError, true);

    // An idea goes to the writer's inbox, saying where it came from.
    await read(bridge, 'add_idea', { text: 'What if the gate remembers who passed?' });
    const ideas = await rpc(page, 'ideas.list', {});
    assert.ok(ideas.some((idea) => idea.text.includes('What if the gate remembers') && idea.text.includes('From e2e-stdio')));
  });

  it('pins the list: a live count in the top bar opens it beside, and accepting keeps the writer in it', async () => {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page, 'Pinned World');
    const { aria, scene } = await seed(page);
    const status = await turnOn(page);
    const http = track(await connectHttp(status.url, status.token));

    // Pinned from the list itself.
    await page.getByRole('menubar').getByRole('menuitem', { name: 'AI', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Outside suggestions' }).click();
    await page.getByRole('heading', { name: 'Outside suggestions' }).waitFor();
    const pin = page.getByRole('button', { name: 'Pin to top bar' });
    assert.equal(await pin.getAttribute('aria-pressed'), 'false');
    await pin.click();
    await waitUntil(async () => (await rpc(page, 'settings.get', {})).mcp?.pinned === true, 3000, 'the pin to be saved');
    assert.equal(await pin.getAttribute('aria-pressed'), 'true');
    const badge = page.getByTestId('mcp-pinned-badge');
    assert.equal(await badge.getAttribute('aria-label'), 'No outside suggestions waiting');

    // The writer goes back to writing. Suggestions arriving over MCP raise the count live.
    await page.locator('.area-tabs').getByRole('button', { name: 'Write' }).click();
    await read(http, 'propose_edit', { target: 'page', title: 'Aria Vance', quote: 'ember gate', replacement: 'iron gate' });
    await page.getByRole('button', { name: '1 outside suggestion' }).waitFor();
    await read(http, 'propose_edit', { target: 'scene', id: scene.id, quote: 'Rain fell', replacement: 'Snow fell' });
    await page.getByRole('button', { name: '2 outside suggestions' }).waitFor();
    assert.equal(await badge.locator('.mcp-badge-count').innerText(), '2');
    assert.equal(await page.getByRole('heading', { name: /Outside suggestions/ }).count(), 0, 'nothing opened by itself');
    // The count in sight is the news, so it is read out rather than shown again in a toast.
    assert.equal(await page.locator('.mcp-live').innerText(), '2 outside suggestions');
    assert.equal(await page.locator('.toast').filter({ hasText: 'left a suggestion' }).count(), 0);

    // The badge opens the list in the pane beside the writing.
    await badge.click();
    const beside = page.getByRole('region', { name: 'Second pane' });
    await beside.getByRole('heading', { name: 'Outside suggestions (2)' }).waitFor();
    await waitUntil(
      () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Suggestion: Aria Vance'),
      3000,
      'the first suggestion to be ready',
    );
    await app.screenshot('mcp-pinned');

    // A page named in a suggestion opens in the other pane, and the list stays.
    await beside.getByRole('button', { name: 'Aria Vance', exact: true }).click();
    await page.locator('main.content').getByRole('heading', { name: 'Aria Vance' }).first().waitFor();
    await beside.getByRole('heading', { name: 'Outside suggestions (2)' }).waitFor();

    // Accepting keeps the writer in the list, with the next suggestion ready.
    await beside.getByRole('button', { name: 'Accept: Aria Vance' }).click();
    await waitUntil(
      async () => JSON.stringify((await rpc(page, 'pages.get', { id: aria.id })).content).includes('iron gate'),
      5000,
      'the edit to apply',
    );
    await beside.getByRole('heading', { name: 'Outside suggestions (1)' }).waitFor();
    await page.getByRole('button', { name: '1 outside suggestion' }).waitFor();
    await waitUntil(
      () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Suggestion: The gate at dawn'),
      3000,
      'the next suggestion to be ready',
    );

    // Rejecting the last one leaves the list open, and the count at none.
    await beside.getByRole('button', { name: 'Reject: The gate at dawn' }).click();
    await beside.getByText('Nothing is waiting.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'No outside suggestions waiting' }).waitFor();
    assert.match(JSON.stringify((await rpc(page, 'nodes.get', { id: scene.id })).content), /Rain fell/);

    // The pin is remembered in the next session.
    await saved(workspace.file('pinned.lorecraft'));
    await rpc(page, 'settings.update', { patch: { save: { reopenLast: false } } });
    await quit();
    app = await launch(workspace);
    await createProject(app.page, 'Next Session');
    await app.page.getByRole('button', { name: 'No outside suggestions waiting' }).waitFor();
  });

  it('refuses a wrong token, a wrong origin or host, and everything when off', async () => {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page, 'Locked');
    await seed(page);
    const status = await turnOn(page);
    const { port, token } = status;
    const json = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    const good = { ...json, Authorization: `Bearer ${token}` };

    assert.equal(await raw(port, { headers: good, body: INITIALIZE }), 200);
    assert.equal(await raw(port, { headers: json, body: INITIALIZE }), 401, 'no token');
    assert.equal(await raw(port, { headers: { ...json, Authorization: 'Bearer wrong' }, body: INITIALIZE }), 401, 'wrong token');
    assert.equal(await raw(port, { headers: { ...good, Origin: 'https://evil.example' }, body: INITIALIZE }), 403, 'a web page');
    assert.equal(await raw(port, { headers: { ...good, Origin: 'null' }, body: INITIALIZE }), 403, 'a sandboxed page');
    assert.equal(await raw(port, { headers: { ...good, Origin: `http://localhost:${port + 1}` }, body: INITIALIZE }), 403, 'another local port');
    assert.equal(await raw(port, { headers: { ...good, Host: 'evil.example' }, body: INITIALIZE }), 403, 'DNS rebinding');
    assert.equal(await raw(port, { headers: { ...good, Host: `evil.example:${port}` }, body: INITIALIZE }), 403, 'DNS rebinding with the port');
    assert.equal(await raw(port, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), 403, 'a preflight');
    assert.equal(await raw(port, { path: '/status', method: 'GET' }), 401, 'status needs the token too');

    await assert.rejects(connectHttp(status.url, 'wrong-token'));

    // Rotating ends the old token at once, and the app's address file follows.
    const rotated = await rpc(page, 'mcp.rotateToken');
    assert.notEqual(rotated.token, token);
    assert.equal(await raw(port, { headers: good, body: INITIALIZE }), 401, 'the old token');
    assert.equal(await raw(port, { headers: { ...good, Authorization: `Bearer ${rotated.token}` }, body: INITIALIZE }), 200);
    assert.equal(JSON.parse(readFileSync(join(workspace.dataDir, 'mcp.json'), 'utf8')).token, rotated.token);

    // Read only: the suggestion tools leave the list and refuse if called anyway.
    const reader = track(await connectHttp(status.url, rotated.token));
    await page.getByLabel('What outside tools can do').selectOption('read');
    await waitUntil(async () => (await rpc(page, 'mcp.status')).permission === 'read', 3000, 'the permission');
    assert.equal((await reader.listTools()).tools.some((t) => t.name === 'propose_edit'), false);
    const refused = await call(reader, 'propose_new_page', { title: 'Nope', body: 'x' });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /read only/);
    await page.getByLabel('What outside tools can do').selectOption('suggest');

    // Off: nothing listens, the address has gone, and a stdio client is told why.
    const file = workspace.file('locked.lorecraft');
    await saved(file);
    await page.getByRole('checkbox', { name: 'Let outside AI tools connect' }).uncheck();
    await waitUntil(async () => !(await rpc(page, 'mcp.status')).running, 5000, 'the server to stop');
    await assert.rejects(raw(port, { headers: good, body: INITIALIZE }));
    assert.equal(existsSync(join(workspace.dataDir, 'mcp.json')), false);
    const off = track(await connectStdio(workspace, ['--project', file]));
    const turnedOff = await call(off, 'catch_me_up');
    assert.equal(turnedOff.isError, true);
    assert.match(turnedOff.text, /turned off/);
  });

  it('never lets a link in a suggestion take the window away from the app', async () => {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page, 'Linked');
    const status = await turnOn(page);
    const http = track(await connectHttp(status.url, status.token));
    // An outside AI's Markdown, which the writer reads before deciding. The address cannot resolve.
    const away = 'https://lorecraft-e2e.invalid/sign-in';
    await read(http, 'propose_new_page', { title: 'The Ember Gate', body: `Read [the history](${away}) first.` });
    await page.getByRole('button', { name: '1 outside suggestion' }).click();
    await page.getByRole('heading', { name: /Outside suggestions \(1\)/ }).waitFor();
    const before = page.url();

    // A web link opens in the browser, and the window stays on the app.
    await page.locator('.mcp-new-page a', { hasText: 'the history' }).click();
    await waitUntil(async () => (await rpc(page, 'media.e2eOpened')).includes(away), 5000, 'the link to open in the browser');
    assert.equal(page.url(), before);

    // Whatever starts a navigation, the window refuses it, and the log names only the scheme.
    const log = join(workspace.dataDir, 'logs', 'lorecraft.log');
    const refusals = () => (existsSync(log) ? readFileSync(log, 'utf8').split('window.navigation_blocked window=main scheme=https').length - 1 : 0);
    await page.evaluate((url) => {
      window.location.href = url;
    }, away);
    await waitUntil(() => refusals() === 1, 5000, 'the navigation to be refused');
    assert.equal(page.url(), before);
    assert.equal(readFileSync(log, 'utf8').includes('lorecraft-e2e.invalid'), false, 'the log holds no address');
    // Still the app, talking to the engine.
    assert.equal(await rpc(page, 'mcp.proposalCount'), 1);
  });

  it('hides local-only pages and scenes until the writer shares them', async () => {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page, 'Private');
    const { scene, secret } = await seed(page);
    await rpc(page, 'nodes.update', { id: scene.id, patch: { localOnly: true } });
    const status = await turnOn(page);
    const http = track(await connectHttp(status.url, status.token));

    assert.ok((await call(http, 'get_page', { title: 'Moon Secret' })).isError);
    assert.ok((await call(http, 'get_page', { id: secret.id })).isError);
    assert.ok((await call(http, 'get_scene', { id: scene.id })).isError);
    for (const [tool, args] of [['catch_me_up', {}], ['list_pages', {}], ['get_outline', {}], ['get_timeline', {}]]) {
      const text = await read(http, tool, args);
      assert.doesNotMatch(text, /Moon Secret|moonstone|The gate at dawn|Rain fell/, tool);
    }
    assert.match(await read(http, 'search_lore', { query: 'moonstone' }), /Nothing found/);
    assert.ok((await call(http, 'propose_edit', { target: 'page', id: secret.id, quote: 'moonstone', replacement: 'x' })).isError);

    await page.getByRole('checkbox', { name: /Share local-only content/ }).check();
    await waitUntil(async () => (await rpc(page, 'mcp.status')).shareLocalOnly, 3000, 'the setting');
    assert.match(await read(http, 'get_page', { title: 'Moon Secret' }), /moonstone/);
    assert.match(await read(http, 'get_scene', { id: scene.id }), /Rain fell/);
    assert.match(await read(http, 'search_lore', { query: 'moonstone' }), /Moon Secret/);
  });

  it('survives the app opening and closing around a stdio client', async () => {
    app = await launch(workspace);
    await createProject(app.page, 'Comings');
    await seed(app.page);
    await turnOn(app.page);
    const file = workspace.file('comings.lorecraft');
    await saved(file);

    const client = track(await connectStdio(workspace, ['--project', file]));
    assert.match(await read(client, 'catch_me_up'), /live work/);

    // A client that finishes leaves the app's list of connected tools.
    const brief = track(await connectStdio(workspace, ['--project', file], 'e2e-brief'));
    await read(brief, 'get_style_guide');
    const seen = await rpc(app.page, 'mcp.status');
    assert.equal(seen.clients.find((c) => c.name === 'e2e-brief')?.connected, true);
    assert.equal(seen.clients.find((c) => c.name === 'e2e-brief').version, '1.0.0', 'its own version');
    await brief.close();
    await waitUntil(
      async () => (await rpc(app.page, 'mcp.status')).clients.find((c) => c.name === 'e2e-brief')?.connected === false,
      10000,
      'the app to see it leave',
    );

    // The next launch must show the start screen, so that a different project can be made.
    await rpc(app.page, 'settings.update', { patch: { save: { reopenLast: false } } });
    await quit();
    assert.match(await read(client, 'catch_me_up'), /last saved file/);
    assert.match((await call(client, 'propose_edit', { target: 'page', title: 'Aria Vance', quote: 'ember', replacement: 'iron' })).text, /need LoreCraft to be open/);

    // A different project open in the app is not the one this client asked for.
    app = await launch(workspace);
    await createProject(app.page, 'Another');
    await waitUntil(async () => (await rpc(app.page, 'mcp.status')).running, 5000, 'the server to start');
    const other = await read(client, 'catch_me_up');
    assert.match(other, /comings/);
    assert.match(other, /last saved file/);

    // Opening the right project makes the same client live again, with no reconnecting.
    await allowPath(app.page, file);
    await rpc(app.page, 'project.open', { path: file });
    assert.match(await read(client, 'catch_me_up'), /live work/);
  });
});
