/**
 * Drafting a scene from notes, a synopsis or a premise, and a book's point of view and tense,
 * in the real app. The model is scripts/mock-ai-server.mjs set up as a local profile, so its
 * answers are known and the requests can be read back.
 */

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { startMockServer } from '../scripts/mock-ai-server.mjs';
import { createProject, createWorkspace, launch, rpc, waitUntil } from './harness.mjs';

const textBlock = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const makeDoc = (...content) => ({ type: 'doc', content });
/** A new scene's document: one empty paragraph. */
const emptyDoc = () => makeDoc({ type: 'paragraph' });

function plainOf(doc) {
  const out = [];
  const walk = (node) => {
    if (node.type === 'text') out.push(node.text);
    node.content?.forEach(walk);
  };
  walk(doc);
  return out.join('');
}

describe('drafting a scene', () => {
  let workspace;
  let app;
  let mock;

  before(async () => {
    mock = await startMockServer();
  });

  after(async () => {
    await mock.close();
  });

  beforeEach(async () => {
    workspace = createWorkspace();
    await fetch(`${mock.url}/__mock/reset`, { method: 'POST' });
  });

  afterEach(async () => {
    if (app && !app.exited) await app.kill().catch(() => {});
    workspace.cleanup();
  });

  const chatRequests = async () => {
    const list = await (await fetch(`${mock.url}/__mock/requests`)).json();
    return list.filter((r) => r.path === '/v1/chat/completions').map((r) => JSON.stringify(r.body ?? r));
  };

  /** A project with a local profile, and its first scene open with this content and synopsis. */
  async function start(content, synopsis = '') {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page, 'Drafting World');
    const profile = { id: 'local', name: 'Local model', kind: 'openai-compatible', baseUrl: `${mock.url}/v1`, model: 'mock-local', isCloud: false };
    const routing = { chat: 'local', rewrite: 'local', extract: 'local', consistency: 'local' };
    await rpc(page, 'settings.update', { patch: { ai: { profiles: [profile], routing } } });
    const books = await rpc(page, 'books.list');
    const tree = await rpc(page, 'nodes.tree', { bookId: books[0].id });
    const scene = tree.find((n) => n.kind === 'scene');
    await rpc(page, 'nodes.update', { id: scene.id, patch: { content, synopsis } });
    await page.reload();
    await page.locator('.topbar').waitFor();
    await page.getByRole('button', { name: 'Write', exact: true }).click();
    await page.locator('.prose-manuscript').waitFor();
    return { page, scene, bookId: books[0].id };
  }

  async function aiMenu(page, item) {
    await page.getByRole('menuitem', { name: 'AI', exact: true }).click();
    await page.getByRole('menuitem', { name: item, exact: true }).click();
  }

  const suggestions = (page) => page.getByRole('region', { name: 'Suggested changes' });

  it('sets point of view and tense for a book, and writes selected notes as a scene in them', async () => {
    const notes = 'mara at the mill. finds the letter. cries? [mock:say=I stand in the mill and read the letter twice.]';
    const { page, scene, bookId } = await start(makeDoc(textBlock(notes)));

    // Book settings: both fields start empty, and save as soon as they are chosen.
    await page.getByRole('button', { name: 'Book settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Book settings' });
    const pov = settings.getByRole('combobox', { name: 'Point of view' });
    const tense = settings.getByRole('combobox', { name: 'Tense' });
    assert.equal(await pov.inputValue(), '');
    assert.equal(await tense.inputValue(), '');
    await pov.selectOption('first');
    await tense.selectOption('present');
    await app.screenshot('drafting-book-settings-dark');
    await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
    await waitUntil(async () => {
      const stored = JSON.parse((await rpc(page, 'project.getMeta', { key: 'books.voice' })) ?? '{}');
      return stored[bookId]?.pov === 'first' && stored[bookId]?.tense === 'present';
    }, 3000, 'the point of view and tense to be stored');

    // Select the notes, and write them as a scene.
    await page.locator('.prose-manuscript').click();
    await page.keyboard.press('Control+a');
    const length = page.getByRole('combobox', { name: 'Length of the scene' });
    await length.selectOption('short');
    await app.screenshot('drafting-selection-menu-dark');
    await page.getByRole('button', { name: 'Write as a scene', exact: true }).click();
    await suggestions(page).waitFor({ timeout: 30_000 });
    // The reply is inside the notes' own marker, so the change shows as the notes struck out.
    await waitUntil(async () => (await page.locator('.ai-ins, .ai-del').count()) > 0, 5000, 'tracked changes to show');
    assert.match(await page.locator('.ai-del').first().innerText(), /mara/);
    let requests = await chatRequests();
    const sent = requests.at(-1);
    assert.match(sent, /rough notes for this scene/);
    assert.match(sent, /about 300 words/);
    assert.match(sent, /Narration for this book/);
    assert.match(sent, /Point of view: first person/);
    assert.match(sent, /Tense: present tense/);
    let stored = await rpc(page, 'nodes.get', { id: scene.id });
    assert.equal(plainOf(stored.content), notes, 'the notes stay until the writer accepts');
    await app.screenshot('drafting-notes-suggested-dark');
    await page.getByRole('button', { name: 'Reject all' }).click();
    await waitUntil(async () => (await page.locator('.ai-ins, .ai-del').count()) === 0, 5000, 'the suggestions to go');

    // The shortcut does the same.
    const before = requests.length;
    await page.locator('.prose-manuscript').click();
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+Shift+E');
    await suggestions(page).waitFor({ timeout: 30_000 });
    requests = await chatRequests();
    assert.ok(requests.length > before, 'the shortcut sent a request');
    assert.match(requests.at(-1), /rough notes for this scene/);
    await page.getByRole('button', { name: 'Reject all' }).click();
    await waitUntil(async () => (await page.locator('.ai-ins, .ai-del').count()) === 0, 5000, 'the suggestions to go');

    // Continue, which was there before, follows the book's point of view and tense too.
    await page.locator('.prose-manuscript').click();
    await aiMenu(page, 'Continue writing');
    // With nothing typed and one version, the Guided Continue box runs Continue as before.
    await page.getByRole('textbox', { name: 'What should happen next?' }).press('Enter');
    await suggestions(page).waitFor({ timeout: 30_000 });
    requests = await chatRequests();
    assert.match(requests.at(-1), /Point of view: first person/);
    assert.match(requests.at(-1), /Tense: present tense/);
    stored = await rpc(page, 'nodes.get', { id: scene.id });
    assert.equal(plainOf(stored.content), notes);
  });

  it('drafts a scene from its synopsis, in parts for a long local draft', async () => {
    const { page, scene } = await start(emptyDoc(), 'Mara leaves the mill at night. [mock:take=Part]');
    await page.locator('.prose-manuscript').click();
    await aiMenu(page, 'Draft from synopsis…');
    const dialog = page.getByRole('dialog', { name: 'Draft from synopsis' });
    await dialog.waitFor();
    assert.match(await dialog.getByTestId('draft-synopsis').innerText(), /Mara leaves the mill/);
    await dialog.getByRole('radio', { name: /^Long/ }).check();
    await dialog.getByText('The local model writes this in 3 parts, one after another.').waitFor();
    await app.screenshot('drafting-synopsis-dialog-dark');
    const before = (await chatRequests()).length;
    await dialog.getByRole('button', { name: 'Write the draft' }).click();
    await suggestions(page).waitFor({ timeout: 60_000 });
    const requests = (await chatRequests()).slice(before);
    assert.equal(requests.length, 3, 'one request for each part');
    assert.match(requests[0], /Write this scene from its synopsis/);
    assert.match(requests[0], /Write only part 1/);
    assert.match(requests[1], /part 2 of 3/);
    assert.match(requests[1], /Part Take 1\./, 'the second part is given the first');
    assert.match(requests[2], /the last part, 3 of 3/);
    let stored = await rpc(page, 'nodes.get', { id: scene.id });
    assert.equal(plainOf(stored.content), '', 'nothing is written until accepted');
    await page.getByRole('button', { name: 'Accept all' }).click();
    await waitUntil(async () => {
      stored = await rpc(page, 'nodes.get', { id: scene.id });
      return /Part Take 1\.[\s\S]*Part Take 2\.[\s\S]*Part Take 3\./.test(JSON.stringify(stored.content));
    }, 10_000, 'the accepted draft to be saved, all three parts in order');
  });

  it('writes a first draft from a premise, and Stop leaves nothing behind', async () => {
    const { page, scene } = await start(emptyDoc());
    await page.locator('.prose-manuscript').click();
    const bar = page.getByRole('status', { name: 'AI at work' });

    // A model that never answers, stopped with the button under the scene.
    await aiMenu(page, 'First draft…');
    let dialog = page.getByRole('dialog', { name: 'First draft' });
    await dialog.getByRole('textbox', { name: 'What should happen?' }).fill('[mock:hang] Mara comes home.');
    await dialog.getByRole('button', { name: 'Write the draft' }).click();
    await bar.getByText('First draft').waitFor();
    await bar.getByRole('button', { name: 'Stop' }).click();
    await bar.waitFor({ state: 'detached' });
    assert.equal(await page.locator('.ai-ins').count(), 0, 'no suggestion from a stopped draft');
    assert.equal(await page.locator('.toast-error').count(), 0, 'stopping is not an error');

    // Then a real one.
    await aiMenu(page, 'First draft…');
    dialog = page.getByRole('dialog', { name: 'First draft' });
    const premise = dialog.getByRole('textbox', { name: 'What should happen?' });
    await premise.fill('[mock:say=The door opened on an empty room.] Mara comes home to find Joss gone.');
    await dialog.getByRole('radio', { name: /^Short/ }).check();
    await app.screenshot('drafting-first-draft-dialog-dark');
    await dialog.getByRole('button', { name: 'Write the draft' }).click();
    await suggestions(page).waitFor({ timeout: 30_000 });
    const sent = (await chatRequests()).at(-1);
    assert.match(sent, /first draft of this scene/);
    assert.match(sent, /Mara comes home to find Joss gone/);
    await page.getByRole('button', { name: 'Accept all' }).click();
    await waitUntil(async () => {
      const stored = await rpc(page, 'nodes.get', { id: scene.id });
      return plainOf(stored.content).includes('The door opened on an empty room.');
    }, 10_000, 'the accepted draft to be saved');
  });
});
