/**
 * Drafting help, driven through the real app: Guided Continue, with a direction and a choice
 * of versions, and Describe with the senses on a selection.
 *
 * "real model" tests use the local server at 127.0.0.1:8080, and skip if it is not running.
 * Its answers vary, so they check what is true whatever it writes. The rest use
 * scripts/mock-ai-server.mjs, whose replies are exact.
 */

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { startMockServer } from '../scripts/mock-ai-server.mjs';
import { createProject, createWorkspace, launch, rpc, waitUntil } from './harness.mjs';

const LOCAL = 'http://127.0.0.1:8080/v1';
const ANSWER_TIME = 240_000;

const para = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const makeDoc = (...content) => ({ type: 'doc', content });

function plainOf(doc) {
  const out = [];
  const walk = (node) => {
    if (node.type === 'text') out.push(node.text);
    node.content?.forEach(walk);
  };
  walk(doc);
  return out.join('');
}

async function selectText(page, phrase, scope = '.prose-manuscript') {
  const located = await page.evaluate(
    ([needle, selector]) => {
      const root = document.querySelector(selector);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.data.indexOf(needle);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + needle.length);
        const rects = range.getClientRects();
        const first = rects[0];
        const last = rects[rects.length - 1];
        return { x1: first.left + 1, y1: first.top + first.height / 2, x2: last.right - 1, y2: last.top + last.height / 2 };
      }
      return null;
    },
    [phrase, scope],
  );
  assert.ok(located, `Could not find "${phrase}" to select`);
  await page.mouse.move(located.x1, located.y1);
  await page.mouse.down();
  await page.mouse.move(located.x2, located.y2, { steps: 4 });
  await page.mouse.up();
}

async function setProfiles(page, profiles, routingId) {
  const routing = { chat: routingId, rewrite: routingId, extract: routingId, consistency: routingId };
  await rpc(page, 'settings.update', { patch: { ai: { profiles, routing } } });
  await page.reload();
  await page.locator('.topbar, .start-card').first().waitFor();
}

/** A scene in a real manuscript editor, with this text. */
async function openBench(page, doc) {
  const books = await rpc(page, 'books.list');
  const tree = await rpc(page, 'nodes.tree', { bookId: books[0].id });
  const scene = tree.find((n) => n.kind === 'scene');
  await rpc(page, 'nodes.update', { id: scene.id, patch: { content: doc } });
  await page.evaluate((id) => window.__aiE2e.mountScene(id), scene.id);
  await page.locator('.prose-manuscript').waitFor();
  return scene;
}

async function palette(page, text) {
  await page.keyboard.press('Control+k');
  await page.locator('.palette-input').fill(text);
  await page.keyboard.press('Enter');
}

/** Opens Guided Continue from the command palette, as the AI menu does. */
async function openContinue(page) {
  await page.locator('.prose-manuscript').click();
  await palette(page, 'Continue writing');
  const box = page.getByRole('textbox', { name: 'What should happen next?' });
  await box.waitFor();
  return box;
}

const version = (page, n) => page.getByRole('region', { name: `Version ${n}`, exact: true });
const group = (page, sense) => page.locator(`[data-testid="ai-senses-group"][data-sense="${sense}"]`);

async function isLocalServerUp() {
  try {
    const response = await fetch(`${LOCAL}/models`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function localModel() {
  const response = await fetch(`${LOCAL}/models`, { signal: AbortSignal.timeout(3000) });
  const list = await response.json();
  return list.data?.[0]?.id ?? 'local';
}

async function makePlace(page) {
  return rpc(page, 'pages.create', {
    title: 'Silver Gate',
    pageType: 'place',
    status: 'canon',
    content: makeDoc(para('The Silver Gate guards the northern pass. Its bars smell of pine tar, and it has never been breached.')),
  });
}

// ---------------------------------------------------------------------------
// The mock, for exact replies
// ---------------------------------------------------------------------------

describe('drafting help, against the mock server', () => {
  let workspace;
  let app;
  let mock;

  const localProfile = () => ({ id: 'local', name: 'Local model', kind: 'openai-compatible', baseUrl: `${mock.url}/v1`, model: 'mock-local', isCloud: false });

  const sent = async () => {
    const list = await (await fetch(`${mock.url}/__mock/requests`)).json();
    return list.filter((r) => r.path === '/v1/chat/completions');
  };
  const wordsOf = (request) => request.body.messages.map((m) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => p.text ?? '').join('\n'))).join('\n');

  async function start() {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page, 'Drafting World');
    await setProfiles(page, [localProfile()], 'local');
    await page.locator('.prose').first().waitFor();
    return page;
  }

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

  // ---- Guided Continue ------------------------------------------------------------------

  it('Continue takes a direction, and with one version gives one tracked change at the end', async () => {
    const page = await start();
    const opening = 'Aria reached the gate at dusk.';
    const scene = await openBench(page, makeDoc(para(opening)));
    const box = await openContinue(page);
    await app.screenshot('guided-continue-box');
    assert.equal((await sent()).length, 0, 'nothing goes out until asked');
    assert.ok(await page.getByRole('radio', { name: '1 version' }).isChecked(), 'one version unless asked for more');
    await box.fill('She finds the letter. [mock:say=She found the letter under the stone.]');
    await box.press('Enter');

    await page.getByRole('region', { name: 'Suggested changes' }).waitFor({ timeout: 15_000 });
    const requests = await sent();
    assert.equal(requests.length, 1);
    const words = wordsOf(requests[0]);
    assert.match(words, /Continue this scene from where it stops/, 'the Continue prompt is still there');
    assert.match(words, /What should happen next, in the author's words: She finds the letter\./, 'and the direction after it');
    assert.equal(await page.locator('.ai-del').count(), 0, 'nothing is taken away');
    assert.match((await page.locator('.ai-ins').allInnerTexts()).join(' '), /letter under the stone/);
    assert.equal(plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content), opening, 'not stored until accepted');

    await page.getByRole('button', { name: 'Accept all' }).click();
    await waitUntil(async () => plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content).includes('under the stone'), 5000, 'it to be stored');
    assert.ok(plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content).startsWith(opening), 'what was there stays first');
  });

  it('Continue with an empty box and Escape: Escape sends nothing, Enter is plain Continue', async () => {
    const page = await start();
    await openBench(page, makeDoc(para('Aria reached the gate at dusk.')));
    let box = await openContinue(page);
    await page.keyboard.press('Escape');
    await box.waitFor({ state: 'detached' });
    assert.equal((await sent()).length, 0, 'Escape sends nothing');

    box = await openContinue(page);
    await box.press('Enter');
    await page.getByRole('region', { name: 'Suggested changes' }).waitFor({ timeout: 15_000 });
    const words = wordsOf((await sent())[0]);
    assert.match(words, /Continue this scene from where it stops/);
    assert.doesNotMatch(words, /in the author's words/, 'no direction was added');
  });

  it('Continue shows two versions to choose from, and only the one chosen is inserted', async () => {
    const page = await start();
    const opening = 'Aria reached the gate at dusk.';
    const scene = await openBench(page, makeDoc(para(opening)));
    const box = await openContinue(page);
    await box.fill('[mock:version=The gate swung open]');
    await page.getByRole('radio', { name: '2 versions' }).check();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();

    await page.getByTestId('ai-versions').waitFor();
    await waitUntil(async () => (await page.locator('[data-testid="ai-version"][data-status="done"]').count()) === 2, 30_000, 'both versions');
    await app.screenshot('guided-continue-versions');
    assert.equal(await page.getByTestId('ai-version').count(), 2);
    const texts = (await page.getByTestId('ai-version-text').allInnerTexts()).map((t) => t.trim());
    assert.deepEqual(texts, ['The gate swung open Take 1.', 'The gate swung open Take 2.']);
    assert.equal(await page.locator('.ai-ins, .ai-del').count(), 0, 'nothing in the document yet');

    const requests = await sent();
    assert.equal(requests.length, 2);
    requests.forEach((request, index) => {
      const words = wordsOf(request);
      assert.match(words, new RegExp(`version ${index + 1} of 2`));
      assert.match(words, /Continue this scene from where it stops/);
      assert.doesNotMatch(words, /closest to the original/, 'angles for continuing, not rewriting');
    });

    await version(page, 2).getByRole('button', { name: 'Use this one' }).click();
    await page.getByRole('region', { name: 'Suggested changes' }).waitFor();
    await page.getByTestId('ai-versions').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.ai-del').count(), 0);
    const inserted = (await page.locator('.ai-ins').allInnerTexts()).join(' ');
    assert.match(inserted, /Take 2/);
    assert.doesNotMatch(inserted, /Take 1/, 'only the chosen one');
    assert.equal(plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content), opening, 'not stored until accepted');

    await page.getByRole('button', { name: 'Accept all' }).click();
    await waitUntil(async () => plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content).includes('Take 2'), 5000, 'it to be stored');
    assert.equal(plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content), `${opening}The gate swung open Take 2.`);
  });

  it('Continue runs versions one at a time on a local server, streams them, and Stop leaves the text alone', async () => {
    const page = await start();
    const opening = 'Aria reached the gate at dusk.';
    const scene = await openBench(page, makeDoc(para(opening)));
    const box = await openContinue(page);
    await box.fill('[mock:slow]');
    await page.getByRole('radio', { name: '3 versions' }).check();
    await box.press('Enter');

    await waitUntil(async () => (await version(page, 1).getByTestId('ai-version-text').innerText()).length > 10, 15_000, 'the first to stream');
    assert.equal(await version(page, 1).getAttribute('data-status'), 'writing');
    assert.equal(await version(page, 2).getAttribute('data-status'), 'queued');
    assert.equal(await version(page, 3).getAttribute('data-status'), 'queued');
    assert.equal((await sent()).length, 1, 'only one request is out');

    await page.getByTestId('ai-versions').getByRole('button', { name: 'Stop' }).click();
    await waitUntil(async () => (await page.locator('[data-testid="ai-version"][data-status="stopped"]').count()) === 3, 5000, 'all three to stop');
    assert.equal((await sent()).length, 1, 'the others never went out');
    assert.equal(await page.locator('.ai-ins, .ai-del').count(), 0);

    // Back goes to the box, with the direction still in it.
    await page.getByTestId('ai-versions').getByRole('button', { name: 'Back' }).click();
    assert.equal(await page.getByRole('textbox', { name: 'What should happen next?' }).inputValue(), '[mock:slow]');
    await page.keyboard.press('Escape');
    await page.getByRole('textbox', { name: 'What should happen next?' }).waitFor({ state: 'detached' });
    assert.equal(plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content), opening);
  });

  // ---- Describe with the senses ----------------------------------------------------------

  it('Describe gives options by sense from the lore, and inserts the ticked ones as one tracked change', async () => {
    const page = await start();
    await makePlace(page);
    const reply = JSON.stringify({
      sight: ['Frost silvered the bars.', 'Torches guttered on the wall.'],
      sound: ['A chain clinked somewhere above.'],
      smell: ['Pine tar, sharp and old.'],
      touch: ['The iron bit through her gloves.'],
      taste: ['Woodsmoke on her tongue.'],
      metaphor: ['The gate stood like a held breath.'],
    });
    const moment = `Aria stopped at the Silver Gate. [mock:say=${reply}[/mock]`;
    const after = 'The guards slept.';
    const scene = await openBench(page, makeDoc(para(`${moment} ${after}`)));
    await selectText(page, 'Aria stopped at the Silver Gate.');
    await page.getByRole('button', { name: 'Describe with the senses' }).click();

    const panel = page.getByTestId('ai-senses');
    await panel.waitFor();
    await waitUntil(async () => (await group(page, 'sight').getByRole('checkbox').count()) === 2, 15_000, 'the options');
    await app.screenshot('guided-senses');
    for (const sense of ['sight', 'sound', 'smell', 'touch', 'taste', 'metaphor']) {
      assert.ok((await group(page, sense).getByRole('checkbox').count()) >= 1, `options for ${sense}`);
    }
    assert.match(await group(page, 'metaphor').innerText(), /Metaphor/);
    const words = wordsOf((await sent())[0]);
    assert.match(words, /never been breached/, 'the lore of the place in the selection was sent');

    // Nothing to insert until something is ticked.
    assert.ok(await panel.getByRole('button', { name: 'Insert' }).isDisabled());
    await group(page, 'sight').getByRole('checkbox', { name: 'Frost silvered the bars.' }).check();
    await group(page, 'smell').getByRole('checkbox', { name: 'Pine tar, sharp and old.' }).check();
    await panel.getByRole('button', { name: 'Insert' }).click();

    await page.getByRole('region', { name: 'Suggested changes' }).waitFor();
    await panel.waitFor({ state: 'detached' });
    assert.equal(await page.locator('.ai-del').count(), 0, 'nothing is taken away');
    assert.equal(await page.locator('.ai-ins').count(), 1, 'one change');
    assert.match(await page.locator('.ai-ins').innerText(), /Frost silvered the bars\. Pine tar, sharp and old\./);
    assert.equal(plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content), `${moment} ${after}`, 'not stored until accepted');

    await page.getByRole('button', { name: 'Accept all' }).click();
    await waitUntil(async () => plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content).includes('Gate. Frost'), 5000, 'it to be stored');
    assert.equal(
      plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content),
      `Aria stopped at the Silver Gate. Frost silvered the bars. Pine tar, sharp and old. [mock:say=${reply}[/mock] ${after}`,
      'right after the selection, in the same paragraph',
    );
  });

  it('Describe reads a reply in prose, "More" refreshes one group and keeps what is ticked, and Escape closes it', async () => {
    const page = await start();
    const scene = await openBench(page, makeDoc(para('Aria waited by the docks. [mock:take=Smell: Tar and wet rope[/mock]')));
    await selectText(page, 'Aria waited by the docks.');
    await palette(page, 'Describe with the senses');
    await page.getByTestId('ai-senses').waitFor();
    const smell = group(page, 'smell');
    await waitUntil(async () => (await smell.getByRole('checkbox').count()) === 1, 15_000, 'the option read from prose');
    assert.equal((await smell.getByRole('checkbox').allInnerTexts()).length, 1);
    await smell.getByRole('checkbox', { name: 'Tar and wet rope Take 1.' }).check();

    await smell.getByRole('button', { name: 'More for Smell' }).click();
    await waitUntil(async () => (await smell.getByRole('checkbox').count()) === 2, 15_000, 'a new option');
    assert.ok(await smell.getByRole('checkbox', { name: 'Tar and wet rope Take 1.' }).isChecked(), 'the ticked one stays');
    await smell.getByRole('checkbox', { name: 'Tar and wet rope Take 2.' }).waitFor();
    const more = wordsOf((await sent())[1]);
    assert.match(more, /smell only/);
    assert.match(more, /- Tar and wet rope Take 1\./, 'it asks for something different');

    await page.keyboard.press('Escape');
    await page.getByTestId('ai-senses').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.ai-ins').count(), 0, 'closing inserts nothing');
    assert.equal(plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content), 'Aria waited by the docks. [mock:take=Smell: Tar and wet rope[/mock]');
  });

  it('Describe says so when the model gives no options, and can try again', async () => {
    const page = await start();
    await openBench(page, makeDoc(para('Aria waited by the docks. [mock:say=I would rather not.]')));
    await selectText(page, 'Aria waited by the docks.');
    await page.getByRole('button', { name: 'Describe with the senses' }).click();
    const panel = page.getByTestId('ai-senses');
    await panel.getByRole('alert').waitFor({ timeout: 15_000 });
    assert.match(await panel.getByRole('alert').innerText(), /no options/);
    await panel.getByRole('button', { name: 'Try again' }).click();
    await waitUntil(async () => (await sent()).length === 2, 10_000, 'a second request');
  });
});

// ---------------------------------------------------------------------------
// The real local model
// ---------------------------------------------------------------------------

describe('drafting help, with the real local model', () => {
  let workspace;
  let app;
  let up = false;

  before(async () => {
    up = await isLocalServerUp();
    if (!up) console.log(`SKIPPING real-model tests: nothing is answering at ${LOCAL}`);
  });

  beforeEach(() => {
    workspace = createWorkspace();
  });

  afterEach(async () => {
    if (app && !app.exited) await app.kill().catch(() => {});
    workspace.cleanup();
  });

  async function startReal() {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page, 'Real Drafting World');
    const profile = { id: 'local', name: 'Local model', kind: 'openai-compatible', baseUrl: LOCAL, model: await localModel(), isCloud: false };
    await setProfiles(page, [profile], 'local');
    await page.locator('.prose').first().waitFor();
    return page;
  }

  it('describes a moment with the senses, and inserts a ticked option as a tracked change', async (t) => {
    if (!up) return t.skip('no local server');
    const page = await startReal();
    await makePlace(page);
    const moment = 'Aria stopped at the Silver Gate and looked up.';
    const scene = await openBench(page, makeDoc(para(moment)));
    await selectText(page, moment);
    await page.getByRole('button', { name: 'Describe with the senses' }).click();
    const panel = page.getByTestId('ai-senses');
    await waitUntil(async () => (await panel.getByRole('checkbox').count()) > 0 || (await panel.getByRole('alert').count()) > 0, ANSWER_TIME, 'options or a message');
    await app.screenshot('guided-senses-real');
    const options = await panel.getByRole('checkbox').count();
    console.log(`Real Describe with the senses: ${options} options`);
    assert.ok(options >= 3, 'a small model gives usable options');
    await panel.getByRole('checkbox').first().check();
    await panel.getByRole('button', { name: 'Insert' }).click();
    await page.getByRole('region', { name: 'Suggested changes' }).waitFor();
    assert.equal(await page.locator('.ai-del').count(), 0);
    assert.equal(plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content), moment, 'not stored until accepted');
  });

  it('continues with a direction, as two versions to choose from', async (t) => {
    if (!up) return t.skip('no local server');
    const page = await startReal();
    const opening = 'Aria reached the gate at dusk. The guards did not look up.';
    const scene = await openBench(page, makeDoc(para(opening)));
    const box = await openContinue(page);
    await box.fill('She finds a letter tucked in the gate. Keep it to two sentences.');
    await page.getByRole('radio', { name: '2 versions' }).check();
    await box.press('Enter');
    await waitUntil(async () => (await page.locator('[data-testid="ai-version"][data-status="done"]').count()) === 2, ANSWER_TIME * 2, 'both versions');
    await app.screenshot('guided-continue-real');
    await version(page, 1).getByRole('button', { name: 'Use this one' }).click();
    await page.getByRole('region', { name: 'Suggested changes' }).waitFor();
    assert.equal(await page.locator('.ai-del').count(), 0, 'nothing is taken away');
    assert.equal(plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content), opening, 'not stored until accepted');
  });
});
