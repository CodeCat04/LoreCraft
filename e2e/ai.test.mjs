/**
 * The AI module, driven through the real app.
 *
 * "real model" tests use the local server at 127.0.0.1:8080 and need it running. They skip
 * with a clear message if it is not. Its answers vary, so they check what is true whatever
 * it writes: the flow works, the document changes only when told to, nothing is lost.
 *
 * "mock" tests use scripts/mock-ai-server.mjs for Anthropic and OpenAI, because real keys
 * are not available here. They show the app speaks those wire formats as documented. They
 * do not show the real services behave that way.
 */

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';

import { ANTHROPIC_KEY, OPENAI_KEY, startMockServer } from '../scripts/mock-ai-server.mjs';
import { createProject, createWorkspace, launch, rpc, waitUntil, addAsset } from './harness.mjs';

const LOCAL = 'http://127.0.0.1:8080/v1';
// A local model usually answers in seconds, and sometimes thinks for minutes.
const ANSWER_TIME = 240_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const textBlock = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const makeDoc = (...content) => ({ type: 'doc', content });

async function homeDoc(page) {
  return (await rpc(page, 'pages.home')).content;
}

function plainOf(doc) {
  const out = [];
  const walk = (node) => {
    if (node.type === 'text') out.push(node.text);
    node.content?.forEach(walk);
  };
  walk(doc);
  return out.join('');
}

/** A project whose main page holds this document, showing it. */
async function openHome(app, doc) {
  const { page } = app;
  await createProject(page, 'AI World');
  const home = await rpc(page, 'pages.home');
  await rpc(page, 'pages.update', { id: home.id, patch: { content: doc } });
  // A reload shows what is stored, the same as reopening the project.
  await page.reload();
  await page.locator('.prose').first().waitFor();
  await waitUntil(async () => (await page.locator('.ProseMirror').first().innerText()).includes(plainOf(doc).slice(0, 12)), 5000, 'the page to show');
  return home;
}

/** Selects a phrase in the editor, the way dragging across it would. */
async function selectText(page, phrase, scope = '.ProseMirror') {
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
        const first = range.getClientRects()[0];
        const rects = range.getClientRects();
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

/** Selects from the start of one paragraph to the end of another, across what lies between. */
async function selectAcross(page, scope) {
  await page.evaluate((selector) => {
    const root = document.querySelector(selector);
    root.focus();
    const paragraphs = root.querySelectorAll('p');
    const range = document.createRange();
    range.setStart(paragraphs[0].firstChild, 0);
    const last = paragraphs[paragraphs.length - 1].firstChild;
    range.setEnd(last, last.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, scope);
}

async function setProfiles(page, profiles, routingId) {
  const routing = routingId ? { chat: routingId, rewrite: routingId, extract: routingId, consistency: routingId } : undefined;
  await rpc(page, 'settings.update', { patch: { ai: { profiles, ...(routing ? { routing } : {}) } } });
  // Settings load at startup, so a reload is what makes them current in the UI.
  await page.reload();
  await page.locator('.topbar, .start-card').first().waitFor();
}

async function openPane(page) {
  if ((await page.getByTestId('ai-pane').count()) === 0) {
    await page.getByRole('button', { name: 'AI', exact: true }).click();
  }
  await page.getByTestId('ai-pane').waitFor();
}

async function send(page, text) {
  const input = page.getByRole('textbox', { name: 'Message the AI' });
  await input.fill(text);
  await input.press('Enter');
}

async function lastAnswerText(page) {
  const answers = page.getByTestId('ai-assistant');
  const count = await answers.count();
  return count === 0 ? '' : answers.nth(count - 1).innerText();
}

const sendButton = (page) => page.getByTestId('ai-pane').getByRole('button', { name: 'Send', exact: true });

async function waitForIdle(page, timeout = ANSWER_TIME) {
  await sendButton(page).waitFor({ timeout });
}

async function waitForChanges(page, timeout = ANSWER_TIME) {
  await page.getByRole('region', { name: 'Suggested changes' }).waitFor({ timeout });
}

/** Waits for a review dialog. If a message shows instead, fails with what it says. */
async function waitForReview(page) {
  const review = page.getByTestId('ai-review');
  const message = page.locator('.toast:not(.toast-success)').first();
  const said = await Promise.race([
    review.waitFor({ timeout: ANSWER_TIME }).then(() => null),
    message.waitFor({ timeout: ANSWER_TIME }).then(() => message.innerText()),
  ]);
  assert.equal(said, null, 'The app showed a message instead of a review');
  return review;
}

async function isLocalServerUp() {
  try {
    const response = await fetch(`${LOCAL}/models`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** A tiny real PNG, half red and half blue, so a vision answer can be checked. */
function redBluePng() {
  const chunk = (type, data) => {
    const name = Buffer.from(type, 'latin1');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc32(Buffer.concat([name, data])) >>> 0);
    return Buffer.concat([length, name, data, check]);
  };
  const width = 64;
  const height = 64;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = x < width / 2 ? [220, 20, 20] : [20, 40, 220];
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// The real local model
// ---------------------------------------------------------------------------

describe('AI with the real local model', () => {
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

  const SENTENCE = 'The old dragon sleeps under the silver vale.';

  it('rewrites a selected sentence as tracked changes, and accepting it updates the document and history', async (t) => {
    if (!up) return t.skip('no local server');
    app = await launch(workspace);
    const { page } = app;
    const home = await openHome(app, makeDoc(textBlock(`Before it. ${SENTENCE} After it.`)));

    await selectText(page, SENTENCE);
    await page.getByRole('dialog', { name: 'AI actions for the selected text' }).getByRole('button', { name: 'Ask AI' }).click();
    const box = page.getByRole('textbox', { name: 'What should change?' });
    await box.fill('Replace the word "dragon" with "wyvern". Change nothing else.');
    await box.press('Enter');

    await waitForChanges(page);
    await page.locator('.ai-del').first().waitFor();
    await page.locator('.ai-ins').first().waitFor();
    await app.screenshot('ai-tracked-wiki-dark');

    // A suggestion is only decoration: nothing is stored until it is accepted.
    assert.ok(!plainOf(await homeDoc(page)).includes('wyvern'), 'not stored while pending');
    assert.ok(plainOf(await homeDoc(page)).includes(SENTENCE));

    await page.getByRole('button', { name: 'Accept all' }).click();
    await page.getByRole('region', { name: 'Suggested changes' }).waitFor({ state: 'detached' });
    assert.equal(await page.locator('.ai-del').count(), 0);

    await waitUntil(async () => plainOf(await homeDoc(page)).toLowerCase().includes('wyvern'), 5000, 'the accepted text to be stored');
    const stored = plainOf(await homeDoc(page));
    assert.ok(stored.startsWith('Before it. '), `the rest stays: ${stored}`);
    assert.ok(stored.endsWith(' After it.'), `the rest stays: ${stored}`);

    const history = await rpc(page, 'revisions.list', { kind: 'page', id: home.id });
    const before = history.find((r) => r.reason === 'ai');
    assert.ok(before, 'a snapshot was taken before the edit');
    const saved = await rpc(page, 'revisions.get', { id: before.id });
    assert.ok(saved.contentText.includes(SENTENCE), 'the snapshot holds the text from before the edit');

    // Works in Read mode, which is the mode this page is in.
    assert.equal(await page.locator('.ProseMirror').first().getAttribute('contenteditable'), 'false');
  });

  it('leaves the text untouched when a suggestion is rejected', async (t) => {
    if (!up) return t.skip('no local server');
    app = await launch(workspace);
    const { page } = app;
    await openHome(app, makeDoc(textBlock(SENTENCE)));
    const before = JSON.stringify(await homeDoc(page));

    await selectText(page, SENTENCE);
    await page.getByRole('button', { name: 'Ask AI' }).click();
    const box = page.getByRole('textbox', { name: 'What should change?' });
    await box.fill('Rewrite this to be more dramatic.');
    await box.press('Enter');
    await waitForChanges(page);

    await page.getByRole('button', { name: 'Reject all' }).click();
    await page.getByRole('region', { name: 'Suggested changes' }).waitFor({ state: 'detached' });
    await page.getByText(SENTENCE).waitFor();
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(JSON.stringify(await homeDoc(page)), before);
    assert.equal(await page.locator('.ai-del, .ai-ins').count(), 0);
  });

  it('sends a selection to the pane and streams an answer', async (t) => {
    if (!up) return t.skip('no local server');
    app = await launch(workspace);
    const { page } = app;
    await openHome(app, makeDoc(textBlock(SENTENCE)));

    await selectText(page, SENTENCE);
    await page.getByRole('button', { name: 'Send to pane' }).click();
    await page.getByTestId('ai-chip').waitFor();
    assert.ok((await page.getByTestId('ai-chip').innerText()).includes('dragon'));

    await send(page, 'In one short sentence, what creature is mentioned here?');
    await page.getByTestId('ai-live').waitFor({ timeout: 15_000 });
    await waitForIdle(page);
    const answer = await lastAnswerText(page);
    assert.match(answer.toLowerCase(), /dragon/);
    await page.getByTestId('ai-usage').last().waitFor();
    assert.match(await page.getByTestId('ai-usage').last().innerText(), /\d+ in · \d+ out/);
    await page.getByTestId('ai-totals').waitFor({ timeout: 5000 });
    await app.screenshot('ai-pane-answer');
  });

  it('stops a response partway, leaving the conversation and document consistent', async (t) => {
    if (!up) return t.skip('no local server');
    app = await launch(workspace);
    const { page } = app;
    await openHome(app, makeDoc(textBlock(SENTENCE)));
    const before = JSON.stringify(await homeDoc(page));

    await openPane(page);
    await send(page, 'Write a very long story about the dragon, at least two thousand words.');
    await page.getByRole('button', { name: 'Stop' }).waitFor();
    // Let some of the answer itself arrive, then stop it.
    await waitUntil(async () => {
      const text = page.getByTestId('ai-live').locator('.ai-md');
      return (await text.count()) > 0 && (await text.innerText()).length > 20;
    }, ANSWER_TIME, 'some of the answer');
    const started = Date.now();
    await page.getByRole('button', { name: 'Stop' }).click();
    await waitForIdle(page, 5000);
    assert.ok(Date.now() - started < 3000, 'stopping is prompt');
    assert.equal(JSON.stringify(await homeDoc(page)), before, 'the document is untouched');

    // The conversation still works.
    await send(page, 'Say only the word: ready');
    await waitForIdle(page);
    assert.match((await lastAnswerText(page)).toLowerCase(), /ready/);
  });

  it('uses a lore tool to answer', async (t) => {
    if (!up) return t.skip('no local server');
    app = await launch(workspace);
    const { page } = app;
    await createProject(page, 'Tool World');
    // Named nowhere in the message, so the model has to go and look.
    await rpc(page, 'pages.create', {
      title: 'Ember Keep',
      status: 'canon',
      content: makeDoc(textBlock('The keep is guarded by exactly seventeen iron wolves.')),
    });
    await openPane(page);
    await send(page, 'Use the search_lore tool to search for "iron wolves", then tell me how many there are.');
    await page.getByTestId('ai-tool').first().waitFor({ timeout: ANSWER_TIME });
    await waitForIdle(page);
    assert.match(await page.getByTestId('ai-tool').first().innerText(), /Searched|Read page/);
    const answers = await page.getByTestId('ai-assistant').allInnerTexts();
    assert.match(answers.join(' ').toLowerCase(), /seventeen|17/);
  });

  it('knows what figures a document holds, and keeps one through a rewrite that crosses it', async (t) => {
    if (!up) return t.skip('no local server');
    app = await launch(workspace);
    const { page } = app;
    const figure = {
      type: 'figure',
      attrs: { kind: 'picture', align: 'left', width: 35, description: 'Aria stands beneath it at dawn' },
      content: [
        { type: 'image', attrs: { assetId: 'not-a-real-asset', alt: '' } },
        { type: 'figcaption', content: [{ type: 'text', text: 'The Silver Gate' }] },
      ],
    };
    await openHome(app, makeDoc(textBlock('The first paragraph is about the gate.'), figure, textBlock('The second paragraph goes on from there.')));

    await openPane(page);
    await send(page, 'What picture is in the open document, and what is its caption? Answer in one short sentence.');
    await waitForIdle(page);
    assert.match((await lastAnswerText(page)).toLowerCase(), /silver gate/);

    const before = await homeDoc(page);
    await selectAcross(page, '.ProseMirror');
    await page.getByRole('button', { name: 'Ask AI' }).click();
    const box = page.getByRole('textbox', { name: 'What should change?' });
    await box.fill('Make these two paragraphs a little more vivid.');
    await box.press('Enter');
    await waitForChanges(page);
    await page.getByRole('button', { name: 'Accept all' }).click();
    await page.getByRole('region', { name: 'Suggested changes' }).waitFor({ state: 'detached' });
    await waitUntil(async () => JSON.stringify(await homeDoc(page)) !== JSON.stringify(before), 5000, 'the change to be stored');

    const after = await homeDoc(page);
    const figures = after.content.filter((n) => n.type === 'figure');
    assert.equal(figures.length, 1, 'the figure is still there');
    assert.deepEqual(figures[0].attrs, figure.attrs, 'with every attribute unchanged');
    assert.equal(figures[0].content[0].attrs.assetId, 'not-a-real-asset');
    assert.equal(plainOf(figures[0]), 'The Silver Gate');
    assert.notEqual(plainOf(after), plainOf(before), 'and the text around it did change');
  });

  it('reads an image through the real server', async (t) => {
    if (!up) return t.skip('no local server');
    const props = await (await fetch('http://127.0.0.1:8080/props')).json();
    if (!props.modalities?.vision) return t.skip('this server does not report vision');
    app = await launch(workspace);
    const { page } = app;
    await createProject(page, 'Vision World');
    const asset = await addAsset(page, { name: 'colors.png', mime: 'image/png', base64: redBluePng().toString('base64'), width: 64, height: 64 });
    assert.deepEqual(await rpc(page, 'ai.imageSupport', { profileId: 'local' }), { supported: true, source: 'detected' });

    const answer = await page.evaluate(async (assetId) => {
      const { describeImage } = await window.__aiE2e.vision();
      return describeImage(assetId, { prompt: 'What two colors does this picture show, and which is on the left? Answer in one short sentence.' });
    }, asset.id);
    assert.match(answer.toLowerCase(), /red/);
    assert.match(answer.toLowerCase(), /blue/);
    console.log(`Vision answer from the local server: ${answer}`);
  });

  it('completeJson gets usable JSON from a model that does not support structured output', async (t) => {
    if (!up) return t.skip('no local server');
    app = await launch(workspace);
    const { page } = app;
    await createProject(page, 'JSON World');
    const value = await page.evaluate(async () => {
      const { completeJson } = await window.__aiE2e.client();
      return completeJson(
        {
          task: 'extract',
          prompt: 'Give the capital of France as JSON with a single key "capital".',
          // The local server refuses this, and the client carries on without it.
          schema: { name: 'capital', schema: { type: 'object', properties: { capital: { type: 'string' } }, required: ['capital'], additionalProperties: false } },
        },
        (v) => {
          if (typeof v?.capital !== 'string') throw new Error('Expected {"capital": "..."}.');
          return v;
        },
      );
    });
    assert.match(value.capital, /Paris/);
  });

  it('runs the whole-page actions on a brand-new page with only a title', async (t) => {
    if (!up) return t.skip('no local server');
    app = await launch(workspace);
    const { page } = app;
    await createProject(page, 'Action World');
    await rpc(page, 'pages.create', { title: 'Aria Vale', status: 'canon', content: makeDoc(textBlock('Aria Vale is a ranger who guards the Silver Gate. She was born in Highmere.')) });
    const created = await rpc(page, 'pages.create', { title: 'Silver Gate', status: 'draft' });

    const palette = async (text) => {
      await page.keyboard.press('Control+k');
      await page.locator('.palette-input').fill(text);
      await page.keyboard.press('Enter');
    };
    await palette('Silver Gate');
    await page.getByRole('heading', { name: 'Silver Gate' }).waitFor();

    // A field goes through a review, and is stored only on accepting.
    await palette('Write a summary');
    const review = await waitForReview(page);
    assert.equal((await rpc(page, 'pages.get', { id: created.id })).summary, '', 'nothing stored yet');
    await review.getByRole('button', { name: 'Accept' }).click();
    await waitUntil(async () => (await rpc(page, 'pages.get', { id: created.id })).summary.length > 0, 5000, 'the summary to be stored');

    // JSON from a model with no structured output, through a real repair path if needed.
    await palette('Suggest infobox fields');
    await waitForReview(page);
    assert.ok((await review.getByRole('checkbox').count()) > 0, 'it offers fields');
    await review.getByRole('button', { name: /^Add/ }).click();
    await waitUntil(async () => (await rpc(page, 'pages.get', { id: created.id })).infobox.fields.length > 0, 5000, 'the fields to be stored');

    // A whole article, as tracked changes, on an empty document.
    await palette('Flesh out this page');
    await waitForChanges(page);
    await page.locator('.ai-ins').first().waitFor();
    assert.equal(plainOf((await rpc(page, 'pages.get', { id: created.id })).content), '', 'nothing stored yet');
    await app.screenshot('ai-flesh-out');
    await page.getByRole('button', { name: 'Accept all' }).click();
    await waitUntil(async () => plainOf((await rpc(page, 'pages.get', { id: created.id })).content).length > 40, 5000, 'the article to be stored');
  });

  it('summarizes scenes, then their chapter and book, with the real model', async (t) => {
    if (!up) return t.skip('no local server');
    app = await launch(workspace);
    const { page } = app;
    await createProject(page, 'Summary World');
    await setProfiles(page, [{ id: 'local', name: 'Local model', kind: 'openai-compatible', baseUrl: LOCAL, model: '', isCloud: false }], 'local');
    const books = await rpc(page, 'books.list');
    const tree = await rpc(page, 'nodes.tree', { bookId: books[0].id });
    const first = tree.find((n) => n.kind === 'scene');
    const second = await rpc(page, 'nodes.create', { bookId: books[0].id, parentId: first.parentId, kind: 'scene', title: 'The Gate' });
    await rpc(page, 'nodes.update', { id: first.id, patch: { content: makeDoc(textBlock('Aria Vale walked all night to reach the Silver Gate, carrying her dead brother\'s bow.')) } });
    await rpc(page, 'nodes.update', { id: second.id, patch: { content: makeDoc(textBlock('At dawn the guards refused her. She shot the bell from its rope and they let her pass.')) } });
    await page.evaluate(() => window.__aiE2e.summaries().runSummaries());
    const status = await page.evaluate(() => window.__aiE2e.summaries().status());
    assert.equal(status.state, 'idle', JSON.stringify(status));
    const rows = await rpc(page, 'summaries.list', { bookId: books[0].id });
    assert.deepEqual(rows.map((r) => r.level), ['book', 'chapter', 'scene', 'scene']);
    for (const row of rows) assert.ok(row.summary.trim().length > 10, `${row.level}: ${row.summary}`);
    assert.match(rows[2].summary, /Aria/, rows[2].summary);
    const story = await page.evaluate((id) => window.__aiE2e.summaries().getStorySoFar({ nodeId: id, includeLocalOnly: true }), second.id);
    assert.equal(story.entries.length, 1);
    assert.equal(story.entries[0].id, first.id);
  });

  it('runs the scene actions in the manuscript', async (t) => {
    if (!up) return t.skip('no local server');
    app = await launch(workspace);
    const { page } = app;
    await createProject(page, 'Scene World');
    const books = await rpc(page, 'books.list');
    const tree = await rpc(page, 'nodes.tree', { bookId: books[0].id });
    const scene = tree.find((n) => n.kind === 'scene');
    const opening = 'Aria reached the gate at dusk. The guards did not look up.';
    await rpc(page, 'nodes.update', { id: scene.id, patch: { content: makeDoc(textBlock(opening)) } });
    await page.evaluate((id) => window.__aiE2e.mountScene(id), scene.id);
    await page.locator('.prose-manuscript').click();

    const palette = async (text) => {
      await page.keyboard.press('Control+k');
      await page.locator('.palette-input').fill(text);
      await page.keyboard.press('Enter');
    };
    await palette("Describe this scene's synopsis");
    const review = await waitForReview(page);
    await review.getByRole('button', { name: 'Accept' }).click();
    await waitUntil(async () => (await rpc(page, 'nodes.get', { id: scene.id })).synopsis.length > 0, 5000, 'the synopsis to be stored');

    await palette('Continue writing');
    await waitForChanges(page);
    await page.locator('.ai-ins').first().waitFor();
    assert.equal(plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content), opening, 'not stored yet');
    await page.getByRole('button', { name: 'Accept all' }).click();
    await waitUntil(async () => plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content).length > opening.length, 5000, 'the new text to be stored');
    assert.ok(plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content).startsWith(opening), 'what was there stays');
  });

  it('shows what to do when the server is down, and keeps what was typed', async () => {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page, 'Down World');
    await setProfiles(page, [
      { id: 'local', name: 'Local model', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', model: 'x', isCloud: false },
    ]);
    await page.locator('.prose').first().waitFor();
    await openPane(page);
    const typed = 'A long question I do not want to type twice.';
    await send(page, typed);
    const card = page.getByTestId('ai-error');
    await card.waitFor({ timeout: 15_000 });
    assert.equal(await card.getAttribute('data-code'), 'SERVER_DOWN');
    const message = await card.innerText();
    assert.match(message, /Nothing is answering at http:\/\/127\.0\.0\.1:9\/v1/);
    assert.match(message, /Start your model server/);
    assert.doesNotMatch(message, /panic|stack|reqwest|Error:/);
    assert.equal(await page.getByRole('textbox', { name: 'Message the AI' }).inputValue(), typed, 'what was typed is still there');
    await app.screenshot('ai-server-down');

    // The same for the box in place, where the request stays in the box.
    await page.getByRole('button', { name: 'Dismiss' }).first().click();
    await selectText(page, 'Welcome');
    await page.getByRole('button', { name: 'Ask AI' }).click();
    const box = page.getByRole('textbox', { name: 'What should change?' });
    await box.fill('Make this better');
    await box.press('Enter');
    await page.locator('.ai-ask-failure').waitFor({ timeout: 15_000 });
    assert.match(await page.locator('.ai-ask-failure').innerText(), /Start your model server/);
    assert.equal(await box.inputValue(), 'Make this better');
  });
});

// ---------------------------------------------------------------------------
// Tracked changes in the manuscript, with an exact reply from the mock
// ---------------------------------------------------------------------------

describe('AI against the mock server', () => {
  let workspace;
  let app;
  let mock;

  const anthropicProfile = () => ({
    id: 'claude', name: 'Claude', kind: 'anthropic', baseUrl: mock.url, model: 'claude-opus-5-5', isCloud: true,
    inputCostPerMTok: 4, outputCostPerMTok: 20, effort: 'high',
  });
  const openAiProfile = () => ({
    id: 'gpt', name: 'OpenAI', kind: 'openai', baseUrl: `${mock.url}/v1`, model: 'gpt-6-astra', isCloud: true,
    inputCostPerMTok: 10, outputCostPerMTok: 50, effort: 'medium',
  });
  const localProfile = () => ({
    id: 'local', name: 'Local model', kind: 'openai-compatible', baseUrl: `${mock.url}/v1`, model: 'mock-local', isCloud: false,
  });

  const sent = async (path) => {
    const list = await (await fetch(`${mock.url}/__mock/requests`)).json();
    return list.filter((r) => r.path === path);
  };

  async function start(profile, key) {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page, 'Mock World');
    if (key) await rpc(page, 'ai.setKey', { profileId: profile.id, key });
    await rpc(page, 'settings.update', { patch: { ai: { cloudWarningDismissed: true } } });
    await setProfiles(page, [profile, ...(profile.id === 'local' ? [] : [localProfile()])], profile.id);
    await page.locator('.prose').first().waitFor();
    return page;
  }

  /** A scene in a real manuscript editor, with this text. */
  async function openScene(page, doc) {
    const books = await rpc(page, 'books.list');
    const tree = await rpc(page, 'nodes.tree', { bookId: books[0].id });
    const scene = tree.find((n) => n.kind === 'scene');
    await rpc(page, 'nodes.update', { id: scene.id, patch: { content: doc } });
    await page.evaluate((id) => window.__aiE2e.mountScene(id), scene.id);
    await page.locator('.prose-manuscript').waitFor();
    return scene;
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

  it('shows tracked changes in the manuscript, one change at a time, in dark and light', async () => {
    const page = await start(localProfile());
    const scene = await openScene(
      page,
      makeDoc(
        textBlock('Aria drew her bow and waited at the gate. The old dragon slept under the silver vale, and no one had dared to wake it.'),
        textBlock('Morning came slowly over the hills.'),
      ),
    );
    await selectText(page, 'The old dragon slept under the silver vale, and no one had dared to wake it.', '.prose-manuscript');
    await page.getByRole('button', { name: 'Ask AI' }).click();
    const box = page.getByRole('textbox', { name: 'What should change?' });
    await box.fill('[mock:say=The ancient dragon slept under the silver mountain, and no one had dared to rouse it.]');
    await box.press('Enter');
    await waitForChanges(page);

    const inserted = await page.locator('.ai-ins').allInnerTexts();
    const deleted = await page.locator('.ai-del').allInnerTexts();
    assert.deepEqual(deleted, ['old', 'vale', 'wake'], 'word-level changes, not one big block');
    assert.deepEqual(inserted, ['ancient', 'mountain', 'rouse']);
    await app.screenshot('ai-tracked-manuscript-dark');
    await page.evaluate(() => { document.documentElement.dataset.mode = 'light'; });
    await app.screenshot('ai-tracked-manuscript-light');
    await page.evaluate(() => { document.documentElement.dataset.mode = 'dark'; });

    // Accept the first, reject the next, and accept the rest by keyboard.
    await page.getByRole('button', { name: 'Accept this change (Alt+A)' }).first().click();
    await waitUntil(async () => (await page.locator('[data-hunk]').count()) === 2, 3000, 'one change accepted');
    await page.getByRole('button', { name: 'Reject this change (Alt+R)' }).first().click();
    await waitUntil(async () => (await page.locator('[data-hunk]').count()) === 1, 3000, 'one change rejected');
    await page.keyboard.press('Alt+Shift+A');
    await page.getByRole('region', { name: 'Suggested changes' }).waitFor({ state: 'detached', timeout: 3000 });

    const expected = 'Aria drew her bow and waited at the gate. The ancient dragon slept under the silver vale, and no one had dared to rouse it.';
    await waitUntil(async () => plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content).includes('rouse'), 5000, 'it to be stored');
    const stored = plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content);
    assert.ok(stored.startsWith(expected), `only what was accepted changed: ${stored}`);
    const revisions = await rpc(page, 'revisions.list', { kind: 'node', id: scene.id });
    assert.ok(revisions.some((r) => r.reason === 'ai'), 'a snapshot was taken');
  });

  it('undoes an accepted change with Ctrl+Z', async () => {
    const page = await start(localProfile());
    const scene = await openScene(page, makeDoc(textBlock('The dragon sleeps.')));
    await selectText(page, 'The dragon sleeps.', '.prose-manuscript');
    await page.getByRole('button', { name: 'Ask AI' }).click();
    const box = page.getByRole('textbox', { name: 'What should change?' });
    await box.fill('[mock:say=The wyvern sleeps.]');
    await box.press('Enter');
    await waitForChanges(page);
    await page.getByRole('button', { name: 'Accept all' }).click();
    await page.getByRole('region', { name: 'Suggested changes' }).waitFor({ state: 'detached' });
    await page.getByText('The wyvern sleeps.').waitFor();

    await page.locator('.prose-manuscript').click();
    await page.keyboard.press('Control+z');
    await page.getByText('The dragon sleeps.').waitFor();
    await waitUntil(async () => plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content) === 'The dragon sleeps.', 5000, 'the undo to be stored');
  });

  it('marks a suggestion stale, rather than corrupting text, when its text is edited', async () => {
    const page = await start(localProfile());
    await openScene(page, makeDoc(textBlock('Keep the first part. The dragon sleeps here. Keep the last part.')));
    await selectText(page, 'The dragon sleeps here.', '.prose-manuscript');
    await page.getByRole('button', { name: 'Ask AI' }).click();
    const box = page.getByRole('textbox', { name: 'What should change?' });
    await box.fill('[mock:say=The wyvern naps there.]');
    await box.press('Enter');
    await waitForChanges(page);

    // Typing before the range moves it, and the suggestion still applies.
    await page.locator('.prose-manuscript').click();
    await page.keyboard.press('Control+Home');
    await page.keyboard.type('New start. ');
    assert.equal(await page.getByText('can no longer be applied').count(), 0);

    // Typing inside it does not.
    const inside = await page.evaluate(() => {
      const el = document.querySelector('.ai-del');
      const rect = el.getBoundingClientRect();
      return { x: rect.left + 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.click(inside.x, inside.y);
    await page.keyboard.type('X');
    await page.getByText('can no longer be applied').waitFor();
    assert.equal(await page.locator('.ai-ins').count(), 0, 'the stale changes are gone from view');
    await page.getByRole('button', { name: 'Discard' }).click();
    await page.getByText('can no longer be applied').waitFor({ state: 'detached' });
    const text = await page.locator('.prose-manuscript').innerText();
    assert.ok(text.includes('New start.') && text.includes('Keep the last part.'), text);
    assert.ok(!text.includes('wyvern'), 'nothing from the suggestion got in');
  });

  it('shows a preview while streaming, and Stop leaves the document alone', async () => {
    const page = await start(localProfile());
    const scene = await openScene(page, makeDoc(textBlock('A short line to rewrite.')));
    await selectText(page, 'A short line to rewrite.', '.prose-manuscript');
    await page.getByRole('button', { name: 'Ask AI' }).click();
    const box = page.getByRole('textbox', { name: 'What should change?' });
    await box.fill('[mock:slow]');
    await box.press('Enter');
    await page.locator('.ai-preview:not(:empty)').waitFor({ timeout: 10_000 });
    assert.match(await page.locator('.ai-preview').innerText(), /rain/);

    await page.locator('.ai-ask').getByRole('button', { name: 'Stop' }).click();
    await page.locator('.ai-ask').getByRole('button', { name: 'Ask', exact: true }).waitFor({ timeout: 3000 });
    assert.equal(await box.inputValue(), '[mock:slow]', 'the request is still in the box');
    assert.equal(await page.locator('.ai-del, .ai-ins').count(), 0);
    assert.equal(plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content), 'A short line to rewrite.');
    await page.keyboard.press('Escape');
    await page.locator('.ai-ask').waitFor({ state: 'detached' });
  });

  // ---- Local only -------------------------------------------------------------

  it('Local only: withholds marked pages and scenes from a cloud profile, and says so', async () => {
    const page = await start(anthropicProfile(), ANTHROPIC_KEY);
    const secret = 'The hidden vault lies under the old mill.';
    await rpc(page, 'pages.create', { title: 'Mill Secret', status: 'canon', content: makeDoc(textBlock(secret)) });
    const marked = await rpc(page, 'pages.getByTitle', { title: 'Mill Secret' });
    await rpc(page, 'pages.update', { id: marked.id, patch: { localOnly: true } });

    await openPane(page);
    await page.getByRole('textbox', { name: 'Message the AI' }).fill('What about Mill Secret?');
    await page.getByRole('tab', { name: 'What is sent' }).click();
    const row = page.locator('[data-testid="ai-context-item"][data-state="localOnly"]', { hasText: 'Mill Secret' });
    await row.waitFor();
    assert.match(await row.innerText(), /marked local only/);
    await app.screenshot('ai-local-only-context');
    await page.getByRole('tab', { name: 'Chat' }).click();
    await send(page, 'What about Mill Secret?');
    await waitForIdle(page);
    const [request] = await sent('/v1/messages');
    assert.ok(!JSON.stringify(request.body).includes('hidden vault'), 'its text does not go');

    // Nor through a tool, whichever one is asked.
    const tool = (name, input) => page.evaluate(([n, i]) => window.__aiE2e.tools().runLoreTool({ type: 'toolCall', id: 't', name: n, input: i }, true), [name, input]);
    assert.match((await tool('get_page', { title: 'Mill Secret' })).content, /marked local only/);
    assert.ok(!(await tool('search_lore', { query: 'vault' })).content.includes('Mill Secret'));
    assert.ok(!(await tool('list_pages', {})).content.includes('Mill Secret'));
    // A local model can read it, and the result is marked so it never goes on to the cloud.
    const local = await page.evaluate(() => window.__aiE2e.tools().runLoreTool({ type: 'toolCall', id: 't', name: 'get_page', input: { title: 'Mill Secret' } }, false));
    assert.match(local.content, /hidden vault/);
    assert.equal(local.localOnly, true);
  });

  it('Local only: a marked document cannot be rewritten by a cloud profile, and the mark can be set from the pane', async () => {
    const page = await start(anthropicProfile(), ANTHROPIC_KEY);
    const doc = makeDoc(textBlock('The dragon sleeps here.'));
    const scene = await openScene(page, doc);
    await openPane(page);
    await page.getByRole('tab', { name: 'What is sent' }).click();
    await page.getByRole('checkbox', { name: /Local only/ }).check();
    await waitUntil(async () => (await rpc(page, 'nodes.get', { id: scene.id })).localOnly === true, 5000, 'the mark to be stored');
    await page.locator('[data-testid="ai-context-item"][data-state="localOnly"]').first().waitFor();

    await selectText(page, 'The dragon sleeps here.', '.prose-manuscript');
    await page.getByRole('button', { name: 'Ask AI' }).click();
    const box = page.getByRole('textbox', { name: 'What should change?' });
    await box.fill('Make it better');
    await box.press('Enter');
    await page.getByText('marked local only', { exact: false }).first().waitFor();
    assert.equal((await sent('/v1/messages')).length, 0, 'nothing went out');
  });

  it('Local only: what a local model read stays back when the chat moves to a cloud profile', async () => {
    const page = await start(anthropicProfile(), ANTHROPIC_KEY);
    await rpc(page, 'pages.create', { title: 'Mill Secret', status: 'canon', content: makeDoc(textBlock('The hidden vault lies under the mill.')) });
    const marked = await rpc(page, 'pages.getByTitle', { title: 'Mill Secret' });
    await rpc(page, 'pages.update', { id: marked.id, patch: { localOnly: true } });
    await openPane(page);
    // The first turn, on the local profile, reads the page.
    await page.getByRole('combobox', { name: 'AI profile' }).selectOption('local');
    await send(page, 'What about Mill Secret?');
    await waitForIdle(page);
    const localRequest = (await sent('/v1/chat/completions')).pop();
    assert.match(JSON.stringify(localRequest.body), /hidden vault/, 'a local model can have it');

    // Then the same chat moves to the cloud. Asking again cannot send it.
    await page.getByRole('combobox', { name: 'AI profile' }).selectOption(anthropicProfile().id);
    await page.getByRole('button', { name: 'Regenerate', exact: true }).click();
    await page.getByText('held local-only material').first().waitFor();
    assert.equal((await sent('/v1/messages')).length, 0, 'nothing went out');
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await page.getByRole('tab', { name: 'What is sent' }).click();
    await page.getByTestId('ai-history-withheld').waitFor();
    await page.getByRole('tab', { name: 'Chat' }).click();
    await send(page, 'And the weather?');
    await waitForIdle(page);
    const [cloudRequest] = await sent('/v1/messages');
    const body = JSON.stringify(cloudRequest.body);
    assert.ok(!body.includes('hidden vault'), 'its text does not go');
    assert.ok(!body.includes('This is a mock answer to: What about Mill Secret'), 'nor what the local model said after reading it');
  });

  // ---- Spending ---------------------------------------------------------------

  it('Spending: warns at 80 percent, stops at the limit, and can be overridden for the month', async () => {
    const page = await start(anthropicProfile(), ANTHROPIC_KEY);
    const month = new Date().toISOString().slice(0, 7);
    await rpc(page, 'settings.update', { patch: { ai: { spending: { limitUsd: 1, month, spentUsd: 0.8 } } } });
    await page.reload();
    await page.locator('.prose').first().waitFor();
    await openPane(page);
    await send(page, 'First');
    await waitForIdle(page);
    await page.locator('.toast', { hasText: 'cloud spending limit' }).waitFor();
    const counted = (await rpc(page, 'settings.get', {})).ai.spending;
    assert.ok(counted.spentUsd > 0.8, `it was counted: ${counted.spentUsd}`);
    assert.equal(counted.warnedMonth, month);

    await rpc(page, 'settings.update', { patch: { ai: { spending: { spentUsd: 1 } } } });
    await page.reload();
    await page.locator('.prose').first().waitFor();
    const before = (await sent('/v1/messages')).length;
    await openPane(page);
    await send(page, 'Second');
    const dialog = page.getByRole('alertdialog');
    await dialog.getByText('Cloud spending limit reached').waitFor();
    await app.screenshot('ai-spending-limit');
    await dialog.getByRole('button', { name: 'Stop' }).click();
    await page.getByText('cloud limit this month').first().waitFor();
    assert.equal((await sent('/v1/messages')).length, before, 'nothing went out');
    assert.ok((await page.getByRole('textbox', { name: 'Message the AI' }).inputValue()).includes('Second'), 'what was typed is still there');

    await send(page, 'Second');
    await dialog.getByRole('button', { name: 'Allow for the rest of this month' }).click();
    await waitForIdle(page);
    assert.equal((await sent('/v1/messages')).length, before + 1, 'it went out');
    assert.equal((await rpc(page, 'settings.get', {})).ai.spending.overrideMonth, month);

    // A local profile is never held back, and settings show where things stand.
    await page.getByRole('combobox', { name: 'AI profile' }).selectOption('local');
    await rpc(page, 'settings.update', { patch: { ai: { spending: { overrideMonth: '' } } } });
    await send(page, 'Third');
    await waitForIdle(page);
    assert.equal(await dialog.count(), 0);
  });

  it('estimateRunCost prices text with the profile, for whole-book runs', async () => {
    const page = await start(anthropicProfile(), ANTHROPIC_KEY);
    const estimate = await page.evaluate(async () => {
      const { estimateRunCost, profileForTask } = window.__aiE2e.client();
      return estimateRunCost('a'.repeat(4000), { ...profileForTask('extract'), inputCostPerMTok: 10, outputCostPerMTok: 40 });
    });
    assert.equal(estimate.inputTokens, 1000);
    assert.equal(estimate.outputTokens, 250);
    assert.ok(Math.abs(estimate.usd - 0.02) < 1e-9, String(estimate.usd));
  });

  // ---- Summaries --------------------------------------------------------------

  /** A second scene after the project's first, and both with text. */
  async function twoScenes(page) {
    const books = await rpc(page, 'books.list');
    const tree = await rpc(page, 'nodes.tree', { bookId: books[0].id });
    const first = tree.find((n) => n.kind === 'scene');
    const second = await rpc(page, 'nodes.create', { bookId: books[0].id, parentId: first.parentId, kind: 'scene', title: 'Second scene' });
    await rpc(page, 'nodes.update', { id: first.id, patch: { content: makeDoc(textBlock('Aria reaches the gate at dusk.')) } });
    await rpc(page, 'nodes.update', { id: second.id, patch: { content: makeDoc(textBlock('Bram opens it from the inside.')) } });
    return { bookId: books[0].id, first, second };
  }

  const runSummaries = (page) => page.evaluate(() => window.__aiE2e.summaries().runSummaries());

  it('Summaries: keeps them up to date, redoing only what changed, without marking the project changed', async () => {
    const page = await start(localProfile());
    const { bookId, first } = await twoScenes(page);
    await runSummaries(page);
    const rows = await rpc(page, 'summaries.list', { bookId });
    assert.deepEqual(rows.map((r) => r.level), ['book', 'chapter', 'scene', 'scene']);
    assert.ok(rows.every((r) => r.summary.length > 0), JSON.stringify(rows));
    const made = (await sent('/v1/chat/completions')).length;
    assert.equal(made, 4, 'two scenes, their chapter, and the book');

    // Nothing changed, so nothing is asked. After a reload as much as before it.
    await page.reload();
    await page.locator('.prose').first().waitFor();
    await runSummaries(page);
    assert.equal((await sent('/v1/chat/completions')).length, made);

    // One scene changes, and only it is asked about.
    await rpc(page, 'nodes.update', { id: first.id, patch: { content: makeDoc(textBlock('Aria turns back at the gate.')) } });
    await runSummaries(page);
    const requests = await sent('/v1/chat/completions');
    assert.equal(requests.length, made + 1);
    assert.match(JSON.stringify(requests.at(-1).body), /Aria turns back/);
    assert.ok(!JSON.stringify(requests.at(-1).body).includes('Bram'));
  });

  it('Summaries: the writer can read and edit one, and it stays until they ask for a new one', async () => {
    const page = await start(localProfile());
    const { bookId, first } = await twoScenes(page);
    await runSummaries(page);
    await openPane(page);
    await page.getByRole('tab', { name: 'Story so far' }).click();
    const item = page.locator(`[data-testid="ai-story-item"][data-title="${first.title}"]`);
    await item.getByRole('button', { name: /^Edit/ }).click();
    await item.getByRole('textbox').fill('My own words about the gate.');
    await item.getByRole('button', { name: 'Save' }).click();
    await item.getByText('edited by you').waitFor();
    await app.screenshot('ai-story-panel');

    await rpc(page, 'nodes.update', { id: first.id, patch: { content: makeDoc(textBlock('It all changed.')) } });
    await runSummaries(page);
    const row = async () => (await rpc(page, 'summaries.list', { bookId })).find((r) => r.id === first.id);
    assert.equal((await row()).summary, 'My own words about the gate.');
    await item.getByText('stays as you wrote it').waitFor();

    await item.getByRole('button', { name: /^Make a new/ }).click();
    await waitUntil(async () => (await row()).edited === false && (await row()).summary.includes('mock answer'), 15_000, 'a new summary');
  });

  it('Summaries: start by themselves once typing pauses, and step aside for the person', async () => {
    const page = await start(localProfile());
    const { first } = await twoScenes(page);
    const status = () => page.evaluate(() => window.__aiE2e.summaries().status());
    await page.evaluate(() => window.__aiE2e.summaries().watch(300));
    await rpc(page, 'nodes.update', { id: first.id, patch: { content: makeDoc(textBlock('[mock:hang] Aria reaches the gate.')) } });
    await waitUntil(async () => (await status()).state === 'running', 10_000, 'it to start by itself');

    await openPane(page);
    await send(page, 'Hello there');
    await waitUntil(async () => (await status()).state === 'waiting', 10_000, 'it to step aside');
    assert.match((await status()).message, /Waiting while the model answers you/);
    await waitForIdle(page);
    assert.match(await lastAnswerText(page), /mock answer to: Hello there/);
  });

  it('Summaries: stopping cancels the request and saves nothing', async () => {
    const page = await start(localProfile());
    const books = await rpc(page, 'books.list');
    const tree = await rpc(page, 'nodes.tree', { bookId: books[0].id });
    const scene = tree.find((n) => n.kind === 'scene');
    await rpc(page, 'nodes.update', { id: scene.id, patch: { content: makeDoc(textBlock('[mock:hang] Aria waits.')) } });
    await openPane(page);
    await page.getByRole('tab', { name: 'Story so far' }).click();
    void runSummaries(page);
    const status = page.getByTestId('ai-story-status');
    await page.locator('[data-testid="ai-story-status"][data-state="running"]').waitFor();
    await status.getByRole('button', { name: 'Stop' }).click();
    await page.locator('[data-testid="ai-story-status"][data-state="stopped"]').waitFor();
    const rows = await rpc(page, 'summaries.list', { bookId: books[0].id });
    assert.ok(rows.every((r) => r.summary === ''), JSON.stringify(rows));
  });

  it('Summaries: go into the context for a later scene, and leave out what is marked local only for the cloud', async () => {
    const page = await start(anthropicProfile(), ANTHROPIC_KEY);
    const { bookId, first, second } = await twoScenes(page);
    // Made as a local model would have made them.
    await rpc(page, 'summaries.edit', { kind: 'node', id: first.id, summary: 'Aria came to the gate.' });
    const story = await page.evaluate((id) => window.__aiE2e.summaries().getStorySoFar({ nodeId: id }), second.id);
    assert.equal(story.entries[0].summary, 'Aria came to the gate.');

    await page.evaluate((id) => window.__aiE2e.mountScene(id), second.id);
    await page.locator('.prose-manuscript').waitFor();
    await page.locator('.prose-manuscript').click();
    await openPane(page);
    await page.getByRole('tab', { name: 'What is sent' }).click();
    const row = page.locator('[data-testid="ai-context-item"][data-state="included"]', { hasText: 'The story so far' });
    await row.waitFor();
    await page.getByRole('tab', { name: 'Chat' }).click();
    await send(page, 'What next?');
    await waitForIdle(page);
    assert.match(JSON.stringify((await sent('/v1/messages')).at(-1).body), /Aria came to the gate/);

    // Marked, it goes no further.
    await rpc(page, 'nodes.update', { id: first.id, patch: { localOnly: true } });
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await send(page, 'And now?');
    await waitForIdle(page);
    assert.ok(!JSON.stringify((await sent('/v1/messages')).at(-1).body).includes('Aria came to the gate'));
    const local = await rpc(page, 'summaries.storySoFar', { bookId, includeLocalOnly: true });
    assert.equal(local.holdsLocalOnly, true);
  });

  it('Summaries: on a cloud profile they wait to be allowed', async () => {
    const page = await start(anthropicProfile(), ANTHROPIC_KEY);
    const { bookId } = await twoScenes(page);
    await runSummaries(page);
    assert.equal((await sent('/v1/messages')).length, 0, 'nothing went out on its own');
    const status = await page.evaluate(() => window.__aiE2e.summaries().status());
    assert.equal(status.state, 'off');
    assert.match(status.message, /Allow that in Settings/);
    await rpc(page, 'settings.update', { patch: { ai: { summaries: { allowCloud: true } } } });
    await page.reload();
    await page.locator('.prose').first().waitFor();
    await runSummaries(page);
    assert.equal((await sent('/v1/messages')).length, 4);
    const rows = await rpc(page, 'summaries.list', { bookId });
    assert.ok(rows.every((r) => r.summary.length > 0));
  });

  it('Settings: shows the spending limit and summary settings', async () => {
    const page = await start(anthropicProfile(), ANTHROPIC_KEY);
    await rpc(page, 'settings.update', { patch: { ai: { spending: { limitUsd: 20, month: new Date().toISOString().slice(0, 7), spentUsd: 5 } } } });
    await page.reload();
    await page.locator('.prose').first().waitFor();
    await page.keyboard.press('Control+,');
    await page.getByRole('tab', { name: 'AI', exact: true }).click();
    const spent = page.getByTestId('ai-spent');
    await spent.scrollIntoViewIfNeeded();
    assert.match(await spent.innerText(), /\$5\.00 of \$20\.00 \(25%\)/);
    await page.getByTestId('ai-summary-settings').getByRole('checkbox').first().waitFor();
    await app.screenshot('ai-settings-limits');
  });

  it('works in the real Write screen: Ask AI, accept, and the story so far', async () => {
    const page = await start(localProfile());
    const { first, second } = await twoScenes(page);
    await rpc(page, 'summaries.edit', { kind: 'node', id: first.id, summary: 'Aria came to the gate.' });
    await rpc(page, 'nodes.update', { id: second.id, patch: { content: makeDoc(textBlock('The dragon sleeps here.')) } });
    await page.getByRole('button', { name: 'Write', exact: true }).click();
    const editor = page.locator('.ProseMirror[contenteditable="true"]');
    await editor.first().waitFor();
    await page.getByRole('treeitem', { name: /Second scene/ }).first().click();
    await page.getByText('The dragon sleeps here.').first().waitFor();

    await selectText(page, 'The dragon sleeps here.', '.ProseMirror[contenteditable="true"]');
    await page.getByRole('button', { name: 'Ask AI' }).click();
    const box = page.getByRole('textbox', { name: 'What should change?' });
    await box.fill('[mock:say=The wyvern sleeps here.]');
    await box.press('Enter');
    await waitForChanges(page);
    await app.screenshot('ai-write-screen');
    assert.match(JSON.stringify((await sent('/v1/chat/completions')).at(-1).body), /Aria came to the gate/, 'it knows what came before');
    await page.getByRole('button', { name: 'Accept all' }).click();
    await waitUntil(async () => plainOf((await rpc(page, 'nodes.get', { id: second.id })).content).includes('wyvern'), 5000, 'the change to be stored');
  });

  it('shows a whole-document action while it runs, and can stop it', async () => {
    const page = await start(localProfile());
    const doc = makeDoc(textBlock('[mock:hang] Aria waits at the gate.'));
    const scene = await openScene(page, doc);
    await page.locator('.prose-manuscript').click();
    const palette = async (text) => {
      await page.keyboard.press('Control+k');
      await page.locator('.palette-input').fill(text);
      await page.keyboard.press('Enter');
    };
    const bar = page.getByRole('status', { name: 'AI at work' });

    // One that ends in tracked changes, stopped with its button.
    await palette('Continue writing');
    await bar.getByText('Continue writing').waitFor();
    await app.screenshot('ai-action-running');
    await bar.getByRole('button', { name: 'Stop' }).click();
    await bar.waitFor({ state: 'detached' });
    assert.equal(await page.locator('.ai-ins').count(), 0, 'no suggestion from a stopped action');

    // One that ends in a review, stopped from the command palette.
    await palette("Describe this scene's synopsis");
    await bar.getByText("Describe this scene's synopsis").waitFor();
    await palette('Stop the running AI action');
    await bar.waitFor({ state: 'detached' });
    assert.equal(await page.getByTestId('ai-review').count(), 0, 'no review from a stopped action');

    // Nothing is left over, and nothing changed.
    assert.equal(await page.locator('.toast-error').count(), 0, 'stopping is not an error');
    const stored = await rpc(page, 'nodes.get', { id: scene.id });
    assert.equal(plainOf(stored.content), plainOf(doc));
    assert.equal(stored.synopsis, '');
  });

  it('keeps what is revealed later out of AI working in a scene', async () => {
    const page = await start(localProfile());
    const books = await rpc(page, 'books.list');
    const later = await rpc(page, 'nodes.create', { bookId: books[0].id, kind: 'chapter', title: 'Chapter 2' });
    const laterScene = await rpc(page, 'nodes.create', { bookId: books[0].id, parentId: later.id, kind: 'scene', title: 'The twist' });
    await rpc(page, 'pages.create', { title: 'Aria', status: 'canon', content: makeDoc(textBlock('ARIA IS A RANGER.')) });
    await rpc(page, 'pages.create', { title: 'Bram Kell', status: 'canon', content: makeDoc(textBlock('THE TRAITOR IS BRAM.')) });
    const traitor = await rpc(page, 'pages.getByTitle', { title: 'Bram Kell' });
    await rpc(page, 'pages.update', { id: traitor.id, patch: { revealNodeId: laterScene.id } });
    await openScene(page, makeDoc(textBlock('Aria looks for Bram Kell at the gate.')));

    // Ask AI on a selection.
    await selectText(page, 'Aria looks for Bram Kell at the gate.', '.prose-manuscript');
    await page.getByRole('button', { name: 'Ask AI' }).click();
    const box = page.getByRole('textbox', { name: 'What should change?' });
    await box.fill('[mock:say=Aria waits at the gate.]');
    await box.press('Enter');
    await waitForChanges(page);
    let words = JSON.stringify((await sent('/v1/chat/completions')).at(-1).body);
    assert.match(words, /ARIA IS A RANGER/, 'what is known so far is sent');

    assert.doesNotMatch(words, /THE TRAITOR IS BRAM/, 'Ask AI keeps the later reveal out');
    await page.getByRole('button', { name: 'Reject all' }).click();

    // Continue writing, from the palette.
    const before = (await sent('/v1/chat/completions')).length;
    await page.locator('.prose-manuscript').click();
    await page.keyboard.press('Control+k');
    await page.locator('.palette-input').fill('Continue writing');
    await page.keyboard.press('Enter');
    await waitUntil(async () => (await sent('/v1/chat/completions')).length > before, 10000, 'the continue request');
    words = JSON.stringify((await sent('/v1/chat/completions')).at(-1).body);
    assert.match(words, /ARIA IS A RANGER/);
    assert.doesNotMatch(words, /THE TRAITOR IS BRAM/, 'Continue keeps the later reveal out');
  });

  it('marks a result stale if its text was edited while the model was working', async () => {
    const page = await start(localProfile());
    const scene = await openScene(page, makeDoc(textBlock('Keep this. The dragon sleeps here. Keep that.')));
    await selectText(page, 'The dragon sleeps here.', '.prose-manuscript');
    await page.getByRole('button', { name: 'Ask AI' }).click();
    const box = page.getByRole('textbox', { name: 'What should change?' });
    await box.fill('[mock:wait=The wyvern naps there.]');
    await box.press('Enter');
    await page.locator('.ai-ask-status').waitFor();

    // Type inside the text it is reading.
    const at = await page.evaluate(() => {
      const rect = document.querySelector('.ai-target').getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.click(at.x, at.y);
    await page.keyboard.type('MINE');

    await page.getByText('can no longer be applied').waitFor({ timeout: 10_000 });
    await waitUntil(async () => plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content).includes('MINE'), 5000, 'the typing to be stored');
    const stored = plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content);
    assert.ok(!stored.includes('wyvern'), `the late answer did not get in: ${stored}`);
    assert.ok(stored.startsWith('Keep this.') && stored.endsWith('Keep that.'), stored);
    await page.getByRole('button', { name: 'Discard' }).click();
  });

  it('keeps suggestions when leaving a document and coming back, if it is unchanged', async () => {
    const page = await start(localProfile());
    const scene = await openScene(page, makeDoc(textBlock('The dragon sleeps here.')));
    await selectText(page, 'The dragon sleeps here.', '.prose-manuscript');
    await page.getByRole('button', { name: 'Ask AI' }).click();
    const box = page.getByRole('textbox', { name: 'What should change?' });
    await box.fill('[mock:say=The wyvern sleeps here.]');
    await box.press('Enter');
    await waitForChanges(page);

    await page.evaluate(() => window.__aiE2e.unmount());
    await page.locator('.prose-manuscript').waitFor({ state: 'detached' });
    await new Promise((r) => setTimeout(r, 300));
    await page.evaluate((id) => window.__aiE2e.mountScene(id), scene.id);
    await waitForChanges(page, 5000);
    assert.deepEqual(await page.locator('.ai-del').allInnerTexts(), ['dragon']);
    await page.getByRole('button', { name: 'Accept all' }).click();
    await waitUntil(async () => plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content).includes('wyvern'), 5000, 'it to be stored');
  });

  it('keeps a figure when a rewrite crosses it, with the reply split around it', async () => {
    const page = await start(localProfile());
    const figure = {
      type: 'figure',
      attrs: { kind: 'picture', align: 'left', width: 35, description: 'Hand drawn' },
      content: [{ type: 'image', attrs: { assetId: 'a-picture', alt: '' } }, { type: 'figcaption', content: [{ type: 'text', text: 'The map' }] }],
    };
    const scene = await openScene(page, makeDoc(textBlock('First words here.'), figure, textBlock('Second words here.')));
    await selectAcross(page, '.prose-manuscript');
    await page.getByRole('button', { name: 'Ask AI' }).click();
    const box = page.getByRole('textbox', { name: 'What should change?' });
    // A reply that drops the marker, and tries to replace the picture with its own.
    await box.fill('[mock:say=New words entirely. ![Stolen](https://evil.example/x.png)[/mock]');
    await box.press('Enter');
    await waitForChanges(page);
    await page.getByRole('button', { name: 'Accept all' }).click();
    await page.getByRole('region', { name: 'Suggested changes' }).waitFor({ state: 'detached' });
    await waitUntil(async () => plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content).includes('New words'), 5000, 'it to be stored');

    const stored = (await rpc(page, 'nodes.get', { id: scene.id })).content;
    const figures = stored.content.filter((n) => n.type === 'figure');
    assert.equal(figures.length, 1);
    assert.deepEqual(figures[0].attrs, figure.attrs);
    assert.equal(figures[0].content[0].attrs.assetId, 'a-picture');
    assert.doesNotMatch(JSON.stringify(stored), /evil\.example/);

    const request = (await sent('/v1/chat/completions')).pop();
    const words = request.body.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    assert.match(words, /\{\{KEEP 1: \[Picture 1: The map \(Hand drawn\)\]\}\}/, 'the model sees the marker, with its number and label');
    assert.match(words, /stand for|stands for/, 'and is told what such lines are');
  });

  it('fleshes out a brand-new page with only a title', async () => {
    const page = await start(localProfile());
    const created = await rpc(page, 'pages.create', { title: 'Silver Gate' });
    await page.keyboard.press('Control+k');
    await page.locator('.palette-input').fill('Silver Gate');
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Silver Gate' }).waitFor();
    await page.keyboard.press('Control+k');
    await page.locator('.palette-input').fill('Flesh out this page');
    await page.keyboard.press('Enter');
    await waitForChanges(page);
    const request = (await sent('/v1/chat/completions')).pop();
    assert.match(JSON.stringify(request.body.messages), /Silver Gate/, 'the title goes with it');
    assert.equal(plainOf((await rpc(page, 'pages.get', { id: created.id })).content), '', 'nothing stored yet');
    await page.getByRole('button', { name: 'Accept all' }).click();
    await waitUntil(async () => plainOf((await rpc(page, 'pages.get', { id: created.id })).content).length > 0, 5000, 'it to be stored');
  });

  // ---- Anthropic -----------------------------------------------------------

  it('Anthropic: streams an answer, using the documented request', async () => {
    const page = await start(anthropicProfile(), ANTHROPIC_KEY);
    await openPane(page);
    await send(page, 'Hello there');
    await waitForIdle(page);
    assert.match(await lastAnswerText(page), /mock answer to: Hello there/);

    const [request] = await sent('/v1/messages');
    assert.equal(request.headers['anthropic-version'], '2026-10-21');
    assert.equal(request.headers['x-api-key'], ANTHROPIC_KEY);
    assert.equal(request.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
    assert.equal(request.body.model, 'claude-opus-5-5');
    assert.equal(request.body.fallbacks, 'default');
    assert.deepEqual(request.body.thinking, { type: 'adaptive', display: 'summarized' });
    assert.equal(request.body.output_config.effort, 'high');
    assert.deepEqual(request.body.tool_choice, { type: 'auto' });
    assert.ok(request.body.tools.every((t) => t.eager_input_streaming === true));
    assert.deepEqual(request.body.tools.map((t) => t.name), [...request.body.tools.map((t) => t.name)].sort());
    assert.deepEqual(request.body.system[0].cache_control, { type: 'ephemeral' });
    for (const banned of ['temperature', 'top_p', 'top_k']) assert.equal(request.body[banned], undefined);

    // Costs show, from the profile's rates.
    assert.match(await page.getByTestId('ai-usage').last().innerText(), /\$/);
  });

  it('Anthropic: a tool loop replays thinking unchanged, and a second turn stays valid', async () => {
    const page = await start(anthropicProfile(), ANTHROPIC_KEY);
    await rpc(page, 'pages.create', { title: 'Aria', status: 'canon', content: makeDoc(textBlock('Aria is a ranger of the Silver Vale.')) });
    await openPane(page);
    await send(page, '[mock:tool=ranger] Who is the ranger?');
    await page.getByTestId('ai-tool').first().waitFor({ timeout: 15_000 });
    await waitForIdle(page);
    assert.match(await lastAnswerText(page), /The lore search said/);

    const round = await sent('/v1/messages');
    assert.equal(round.length, 2);
    const replay = round[1].body.messages;
    const turn = replay[replay.length - 2];
    assert.equal(turn.role, 'assistant');
    const thinking = turn.content.find((b) => b.type === 'thinking');
    assert.ok(thinking?.signature?.startsWith('sig_'), 'thinking goes back with its signature');
    const call = turn.content.find((b) => b.type === 'tool_use');
    assert.equal(JSON.stringify(call.input), JSON.stringify({ query: 'ranger', limit: 5 }), 'tool input goes back with its key order intact');
    const results = replay[replay.length - 1].content;
    assert.equal(results[0].type, 'tool_result');
    assert.match(String(results[0].content), /Aria/);
    assert.equal(JSON.stringify(round[1].body.system), JSON.stringify(round[0].body.system), 'the system prompt is frozen');
    assert.equal(JSON.stringify(round[1].body.tools), JSON.stringify(round[0].body.tools), 'the tools are frozen');

    // The mock refuses any later thinking block if the history before it changed at all.
    await send(page, 'And another question');
    await waitForIdle(page);
    assert.equal(await page.getByTestId('ai-error').count(), 0);
    assert.match(await lastAnswerText(page), /mock answer to: And another question/);
    const all = await sent('/v1/messages');
    const first = JSON.stringify(all[1].body.messages);
    const later = JSON.stringify(all[2].body.messages);
    assert.ok(later.startsWith(first.slice(0, -1)), 'history only ever grows');
  });

  it('Anthropic: bad tool input goes back as an error and does not run', async () => {
    const page = await start(anthropicProfile(), ANTHROPIC_KEY);
    await openPane(page);
    await send(page, '[mock:invalid-json]');
    await waitForIdle(page);
    assert.match(await lastAnswerText(page), /I sent bad input and was told so/);
    const round = await sent('/v1/messages');
    const result = round[1].body.messages.at(-1).content[0];
    assert.equal(result.is_error, true);
    assert.deepEqual(JSON.parse(result.content), { INVALID_JSON: '{"title":"Aria' });
  });

  it('Anthropic: a refusal says so, discards what started, and offers another profile', async () => {
    const page = await start(anthropicProfile(), ANTHROPIC_KEY);
    await openPane(page);
    await send(page, '[mock:refusal-mid]');
    const card = page.getByTestId('ai-error');
    await card.waitFor({ timeout: 15_000 });
    assert.equal(await card.getAttribute('data-code'), 'REFUSAL');
    const message = await card.innerText();
    assert.match(message, /declined/);
    assert.match(message, /another profile, such as a local model/);
    assert.doesNotMatch(await lastAnswerText(page), /I started writing this/);
    await app.screenshot('ai-refusal');

    // The refused turn is not sent back, and a local profile can take it from here.
    await page.getByRole('combobox', { name: 'AI profile' }).selectOption('local');
    await page.getByTestId('ai-error').getByRole('button', { name: 'Try again' }).click();
    await waitForIdle(page);
    await page.getByTestId('ai-assistant').last().getByText(/mock answer/).waitFor({ timeout: 10_000 });
    const local = (await sent('/v1/chat/completions')).pop();
    assert.doesNotMatch(JSON.stringify(local.body.messages), /I started writing this/);
  });

  it('Anthropic: a refusal on Ask AI keeps the request and allows another profile', async () => {
    const page = await start(anthropicProfile(), ANTHROPIC_KEY);
    await selectText(page, 'Welcome');
    await page.getByRole('button', { name: 'Ask AI' }).click();
    const box = page.getByRole('textbox', { name: 'What should change?' });
    await box.fill('[mock:refusal]');
    await box.press('Enter');
    await page.locator('.ai-ask-failure').waitFor({ timeout: 15_000 });
    assert.match(await page.locator('.ai-ask-failure').innerText(), /declined/);
    assert.equal(await box.inputValue(), '[mock:refusal]');
    assert.equal(await page.locator('.ai-del, .ai-ins').count(), 0);
    await page.locator('.ai-ask-profile select').selectOption('local');
    await box.fill('[mock:say=Greetings]');
    await box.press('Enter');
    await waitForChanges(page);
  });

  it('Anthropic: a mid-stream fallback finishes the answer and is reported', async () => {
    const page = await start(anthropicProfile(), ANTHROPIC_KEY);
    await openPane(page);
    await send(page, '[mock:fallback]');
    await waitForIdle(page);
    const answer = await lastAnswerText(page);
    assert.match(answer, /The first model wrote this, and the fallback model finished it\./);
    assert.match(await page.getByTestId('ai-usage').last().innerText(), /claude-opus-5/);

    // Echoing it back follows the fallback rules, or the mock would refuse the next turn.
    await send(page, 'Next question');
    await waitForIdle(page);
    assert.equal(await page.getByTestId('ai-error').count(), 0);
    const later = (await sent('/v1/messages')).pop();
    const turn = later.body.messages.find((m) => m.role === 'assistant');
    assert.ok(!turn.content.some((b) => b.type === 'thinking' || b.type === 'fallback'));
    assert.deepEqual(turn.content.map((b) => b.text), ['The first model wrote this, ', 'and the fallback model finished it.']);
  });

  it('Anthropic: hitting the limit offers more room, and a tool cut off does not run', async () => {
    const page = await start(anthropicProfile(), ANTHROPIC_KEY);
    await openPane(page);
    await send(page, '[mock:max-tokens-tool]');
    const card = page.getByTestId('ai-error');
    await card.waitFor({ timeout: 15_000 });
    assert.equal(await card.getAttribute('data-code'), 'MAX_TOKENS');
    assert.equal((await sent('/v1/messages')).length, 1, 'the tool did not run, so nothing was sent back');
    await card.getByRole('button', { name: 'Dismiss' }).click();

    // The next turn answers the cut-off call, or the request would be invalid.
    await send(page, 'Next question');
    await waitForIdle(page);
    assert.equal(await page.getByTestId('ai-error').count(), 0);
    assert.match(await lastAnswerText(page), /mock answer to: Next question/);
  });

  it('Anthropic: a paused turn resumes by sending it back, with no new user message', async () => {
    const page = await start(anthropicProfile(), ANTHROPIC_KEY);
    await openPane(page);
    await send(page, '[mock:pause]');
    await waitForIdle(page);
    assert.match(await lastAnswerText(page), /Resumed after the pause\./);
    const round = await sent('/v1/messages');
    assert.equal(round.length, 2);
    const last = round[1].body.messages.at(-1);
    assert.equal(last.role, 'assistant');
    assert.equal(last.content[0].type, 'server_tool_use');
  });

  it('Anthropic: retries when overloaded, before and during the stream', async () => {
    const page = await start(anthropicProfile(), ANTHROPIC_KEY);
    await openPane(page);
    await send(page, '[mock:rate-limit-once]');
    await waitForIdle(page);
    assert.equal(await page.getByTestId('ai-error').count(), 0);
    assert.equal((await sent('/v1/messages')).length, 2);
    await page.getByRole('button', { name: 'New', exact: true }).click();

    await fetch(`${mock.url}/__mock/reset`, { method: 'POST' });
    await send(page, '[mock:sse-overloaded-once]');
    await waitForIdle(page);
    assert.equal(await page.getByTestId('ai-error').count(), 0);
    assert.equal((await sent('/v1/messages')).length, 2);
  });

  it('Anthropic: caching uses a stable prefix, and repeated requests read from it', async () => {
    const page = await start(anthropicProfile(), ANTHROPIC_KEY);
    await rpc(page, 'pages.create', { title: 'Aria', status: 'canon', content: makeDoc(textBlock('A ranger.')) });
    await openPane(page);
    await send(page, 'Tell me about Aria');
    await waitForIdle(page);
    await send(page, 'Tell me more about Aria');
    await waitForIdle(page);
    const [first, second] = await sent('/v1/messages');
    const lore = (request) => request.body.messages[0].content.find((b) => String(b.text).startsWith('<lore>'));
    assert.ok(lore(first), 'lore goes in the first message');
    assert.ok(lore(second), 'and stays there unchanged');
    assert.equal(lore(first).text, lore(second).text);
    // Sent once, not again in the second question.
    assert.doesNotMatch(JSON.stringify(second.body.messages.at(-1)), /<lore>/);
    assert.equal(first.body.cache_control?.type, 'ephemeral');
  });

  it('Anthropic: a bad key gets a clear message, and the key goes nowhere it should not', async () => {
    const secret = 'sk-ant-this-is-wrong-and-secret';
    const page = await start(anthropicProfile(), secret);
    await openPane(page);
    await send(page, 'Hello');
    const card = page.getByTestId('ai-error');
    await card.waitFor({ timeout: 15_000 });
    assert.equal(await card.getAttribute('data-code'), 'BAD_KEY');
    assert.match(await card.innerText(), /did not accept the API key/);

    // The mock echoes the key in its error. It must not come through to anywhere visible.
    const seen = await page.evaluate(() => document.body.innerText + JSON.stringify(localStorage));
    assert.ok(!seen.includes(secret), 'not on screen');
    const settings = await rpc(page, 'settings.get');
    assert.ok(!JSON.stringify(settings).includes(secret), 'not in settings');
    assert.equal(await rpc(page, 'ai.hasKey', { profileId: 'claude' }), true);
    await assert.rejects(rpc(page, 'ai.getKey', { profileId: 'claude' }));
    // The test store is only used under the harness, in this test's own folder.
    assert.ok(existsSync(workspace.dataDir));
    for (const file of readdirSync(workspace.dataDir)) {
      if (file === 'test-api-keys.json') continue;
      if (file.endsWith('.json')) assert.ok(!readFileSync(`${workspace.dataDir}/${file}`, 'utf8').includes(secret), `not in ${file}`);
    }
  });

  it('Anthropic: an unknown model, and a request too long, get clear messages', async () => {
    const page = await start({ ...anthropicProfile(), model: 'claude-nonexistent' }, ANTHROPIC_KEY);
    await openPane(page);
    await send(page, 'Hello');
    let card = page.getByTestId('ai-error');
    await card.waitFor({ timeout: 15_000 });
    assert.equal(await card.getAttribute('data-code'), 'UNKNOWN_MODEL');
    assert.match(await card.innerText(), /claude-nonexistent/);

    await card.getByRole('button', { name: 'Dismiss' }).click();
    await rpc(page, 'settings.update', { patch: { ai: { profiles: [anthropicProfile(), localProfile()] } } });
    await page.reload();
    await page.locator('.prose').first().waitFor();
    await openPane(page);
    await send(page, '[mock:too-long]');
    card = page.getByTestId('ai-error');
    await card.waitFor({ timeout: 15_000 });
    assert.equal(await card.getAttribute('data-code'), 'CONTEXT_TOO_LONG');
    assert.match(await card.innerText(), /Lower the context size/);
  });

  it('Anthropic: structured output and repair both reach usable JSON', async () => {
    const page = await start(anthropicProfile(), ANTHROPIC_KEY);
    const schema = { name: 'fields', schema: { type: 'object', properties: { fields: { type: 'array', items: { type: 'object' } } }, required: ['fields'], additionalProperties: false } };
    const value = await page.evaluate(async (s) => {
      const { completeJson } = await window.__aiE2e.client();
      return completeJson(
        { task: 'extract', prompt: '[mock:json=bad-first] Give me fields.', schema: s },
        (v) => {
          if (!Array.isArray(v?.fields)) throw new Error('Expected {"fields": [...]}.');
          return v;
        },
      );
    }, schema);
    assert.equal(value.fields[0].value, 'The Silver Vale');
    const round = await sent('/v1/messages');
    assert.equal(round.length, 2, 'the first reply was not what was asked for, so it asked again');
    assert.equal(round[0].body.output_config.format.type, 'json_schema');
    assert.match(JSON.stringify(round[1].body.messages.at(-1)), /could not be used/);
    assert.equal(round[1].body.messages.at(-1).role, 'user', 'no assistant prefill');
  });

  it('Anthropic: an image goes as a base64 source', async () => {
    const page = await start(anthropicProfile(), ANTHROPIC_KEY);
    const base64 = redBluePng().toString('base64');
    const asset = await addAsset(page, { name: 'colors.png', mime: 'image/png', base64, width: 64, height: 64 });
    const answer = await page.evaluate(async (id) => {
      const { describeImage } = await window.__aiE2e.vision();
      return describeImage(id, { prompt: '[mock:say=A red and blue picture.]' });
    }, asset.id);
    assert.equal(answer, 'A red and blue picture.');
    const request = (await sent('/v1/messages')).pop();
    const image = request.body.messages[0].content.find((b) => b.type === 'image');
    assert.deepEqual(image.source, { type: 'base64', media_type: 'image/png', data: base64 });
  });

  it('asks before the first send to a cloud provider, and no means nothing is sent', async () => {
    const page = await start(anthropicProfile(), ANTHROPIC_KEY);
    await rpc(page, 'settings.update', { patch: { ai: { cloudWarningDismissed: false } } });
    await page.reload();
    await page.locator('.prose').first().waitFor();
    await openPane(page);
    const typed = 'Something for the cloud';
    await send(page, typed);
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /Send this to Anthropic\?/);
    await app.screenshot('ai-cloud-confirm');

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await sendButton(page).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Message the AI' }).inputValue(), typed, 'what was typed comes back');
    assert.equal((await sent('/v1/messages')).length, 0, 'nothing was sent');

    await sendButton(page).click();
    await page.getByRole('alertdialog').getByRole('button', { name: "Send, and don't ask again" }).click();
    await waitForIdle(page);
    assert.equal((await sent('/v1/messages')).length, 1);
    const stored = await rpc(page, 'settings.get');
    assert.equal(stored.ai.cloudWarningDismissed, true);
  });

  // ---- OpenAI -------------------------------------------------------------

  it('OpenAI: streams through the Responses API, using the documented request', async () => {
    const page = await start(openAiProfile(), OPENAI_KEY);
    await openPane(page);
    await send(page, 'Hello there');
    await waitForIdle(page);
    assert.match(await lastAnswerText(page), /mock answer to: Hello there/);
    const [request] = await sent('/v1/responses');
    assert.equal(request.headers.authorization, `Bearer ${OPENAI_KEY}`);
    assert.equal(request.body.store, false);
    assert.equal(request.body.model, 'gpt-6-astra');
    assert.ok(request.body.max_output_tokens > 0);
    assert.deepEqual(request.body.reasoning, { summary: 'auto', effort: 'medium' });
    assert.equal(request.body.tools[0].type, 'function');
    assert.equal(request.body.tool_choice, 'auto');
    assert.equal(request.body.max_tokens, undefined);
    assert.equal(request.body.max_completion_tokens, undefined);
    await page.getByTestId('ai-assistant').last().locator('.ai-thinking').waitFor();
  });

  it('OpenAI: a tool loop replays reasoning and calls whole, and a second turn stays valid', async () => {
    const page = await start(openAiProfile(), OPENAI_KEY);
    await rpc(page, 'pages.create', { title: 'Aria', status: 'canon', content: makeDoc(textBlock('Aria is a ranger.')) });
    await openPane(page);
    await send(page, '[mock:tool=ranger] Who is the ranger?');
    await page.getByTestId('ai-tool').first().waitFor({ timeout: 15_000 });
    await waitForIdle(page);
    assert.match(await lastAnswerText(page), /The lore search said/);
    const round = await sent('/v1/responses');
    assert.equal(round.length, 2);
    const items = round[1].body.input;
    assert.ok(items.some((i) => i.type === 'reasoning' && i.encrypted_content), 'reasoning goes back encrypted');
    assert.ok(items.some((i) => i.type === 'message' && i.phase === 'commentary'), 'the phase is kept');
    const call = items.find((i) => i.type === 'function_call');
    assert.ok(call);
    const output = items.find((i) => i.type === 'function_call_output');
    assert.equal(output.call_id, call.call_id);
    assert.match(output.output, /Aria/);

    await send(page, 'And another question');
    await waitForIdle(page);
    assert.equal(await page.getByTestId('ai-error').count(), 0);
    assert.match(await lastAnswerText(page), /mock answer to: And another question/);
  });

  it('OpenAI: a refusal, a limit, a failure and an unavailable field are all handled', async () => {
    const page = await start(openAiProfile(), OPENAI_KEY);
    await openPane(page);

    await send(page, '[mock:refusal]');
    let card = page.getByTestId('ai-error');
    await card.waitFor({ timeout: 15_000 });
    assert.equal(await card.getAttribute('data-code'), 'REFUSAL');
    assert.match(await card.innerText(), /I cannot help with that request/);
    await card.getByRole('button', { name: 'Dismiss' }).click();

    await send(page, '[mock:max-tokens]');
    card = page.getByTestId('ai-error');
    await card.waitFor({ timeout: 15_000 });
    assert.equal(await card.getAttribute('data-code'), 'MAX_TOKENS');
    await card.getByRole('button', { name: 'Dismiss' }).click();

    await send(page, '[mock:quota]');
    card = page.getByTestId('ai-error');
    await card.waitFor({ timeout: 15_000 });
    assert.equal(await card.getAttribute('data-code'), 'BILLING');
    await card.getByRole('button', { name: 'Dismiss' }).click();

    await page.getByRole('textbox', { name: 'Message the AI' }).fill('');
    await send(page, '[mock:summary-unverified] Without a summary, please.');
    await waitForIdle(page);
    assert.equal(await page.getByTestId('ai-error').count(), 0, 'the refused field was dropped, and it carried on');
  });

  it('OpenAI: an image goes as an input_image with a data address', async () => {
    const page = await start(openAiProfile(), OPENAI_KEY);
    const base64 = redBluePng().toString('base64');
    const asset = await addAsset(page, { name: 'colors.png', mime: 'image/png', base64, width: 64, height: 64 });
    await page.evaluate(async (id) => {
      const { describeImage } = await window.__aiE2e.vision();
      await describeImage(id);
    }, asset.id);
    const request = (await sent('/v1/responses')).pop();
    const part = request.body.input[0].content.find((p) => p.type === 'input_image');
    assert.equal(part.image_url, `data:image/png;base64,${base64}`);
  });

  // ---- Settings -------------------------------------------------------------

  it('Settings: add a profile, save a key it cannot show, test it, list models, route to it', async () => {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page, 'Settings World');
    await page.keyboard.press('Control+,');
    await page.getByRole('tab', { name: 'AI', exact: true }).click();
    const settings = page.getByTestId('ai-settings');
    await settings.waitFor();
    await page.getByText('What stays here and what is sent').waitFor();
    await settings.getByRole('button', { name: 'Anthropic' }).click();
    await page.getByRole('tab', { name: 'Claude' }).waitFor();

    const card = page.getByTestId('ai-profile-card');
    assert.equal(await card.getByRole('combobox', { name: 'Model', exact: true }).inputValue(), 'claude-opus-5-5');
    await card.getByLabel('Address').fill(mock.url);

    // No key yet.
    await card.getByRole('button', { name: 'Test connection' }).click();
    await waitUntil(async () => /API key/.test(await card.getByTestId('connection-result').innerText().catch(() => '')), 5000, 'the no-key message');

    await card.getByLabel('API key').fill(ANTHROPIC_KEY);
    await card.getByRole('button', { name: 'Save key' }).click();
    await waitUntil(async () => /A key is saved/.test(await card.getByTestId('key-status').innerText()), 5000, 'the key to be saved');
    assert.equal(await card.getByLabel('API key').inputValue(), '', 'the field is write-only');

    await card.getByRole('button', { name: 'Test connection' }).click();
    await waitUntil(async () => /Connected to Anthropic/.test(await card.getByTestId('connection-result').innerText().catch(() => '')), 5000, 'the connection result');
    await app.screenshot('ai-settings');

    await card.getByRole('button', { name: 'List models' }).click();
    await waitUntil(async () => /available/.test(await card.innerText()), 5000, 'the model list');
    const options = await card.locator('datalist option').evaluateAll((list) => list.map((o) => o.value));
    assert.ok(options.includes('claude-opus-5-5') && options.includes('claude-haiku-5-5'), `all pages of the list: ${options}`);

    await settings.getByLabel('Chat').selectOption({ label: 'Claude' });
    const stored = await rpc(page, 'settings.get');
    const claude = stored.ai.profiles.find((p) => p.name === 'Claude');
    assert.equal(stored.ai.routing.chat, claude.id);
    assert.equal(claude.isCloud, true);
    assert.equal(claude.kind, 'anthropic');
    assert.ok(!JSON.stringify(stored).includes(ANTHROPIC_KEY), 'the key is not in settings');

    await page.getByRole('button', { name: 'Delete this profile' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('tab', { name: 'Claude' }).waitFor({ state: 'detached' });
    assert.equal(await rpc(page, 'ai.hasKey', { profileId: claude.id }), false, 'its key goes with it');
    assert.equal((await rpc(page, 'settings.get')).ai.routing.chat, 'local', 'routing falls back');
  });

  // ---- The rest of the pane -------------------------------------------------

  it('Context view shows what is sent, per item, with pins, exclusions and spoilers', async () => {
    const page = await start(anthropicProfile(), ANTHROPIC_KEY);
    const books = await rpc(page, 'books.list');
    const tree = await rpc(page, 'nodes.tree', { bookId: books[0].id });
    const chapter = tree.find((n) => n.kind === 'chapter');
    const later = await rpc(page, 'nodes.create', { bookId: books[0].id, kind: 'chapter', title: 'Chapter 2' });
    const laterScene = await rpc(page, 'nodes.create', { bookId: books[0].id, parentId: later.id, kind: 'scene', title: 'The twist' });
    const aria = await rpc(page, 'pages.create', { title: 'Aria', status: 'canon', content: makeDoc(textBlock('A ranger.')) });
    await rpc(page, 'pages.create', { title: 'Traitor', status: 'canon', content: makeDoc(textBlock('THE TRAITOR IS BRAM.')) });
    const traitor = await rpc(page, 'pages.getByTitle', { title: 'Traitor' });
    await rpc(page, 'pages.update', { id: traitor.id, patch: { revealNodeId: laterScene.id } });

    await openPane(page);
    await page.getByRole('textbox', { name: 'Message the AI' }).fill('What about Aria and the Traitor?');
    await page.getByRole('tab', { name: 'What is sent' }).click();
    const view = page.getByTestId('ai-context');
    await view.waitFor();
    await page.getByText('This is sent to Anthropic.').waitFor();
    await waitUntil(async () => (await page.getByTestId('ai-context-item').count()) >= 2, 5000, 'the items');
    const row = (name) => page.getByTestId('ai-context-item').filter({ hasText: name });
    assert.match(await row('Aria').innerText(), /tokens/);
    assert.match(await row('Traitor').innerText(), /tokens/);
    await app.screenshot('ai-context-view');

    // The limit hides what is revealed later, in the view as well as in what is sent.
    await page.locator('.ai-context-limit select').selectOption(chapter.id);
    await waitUntil(async () => (await row('Traitor').getAttribute('data-state')) === 'spoiler', 5000, 'the spoiler limit');
    assert.match(await row('Traitor').innerText(), /hidden by/);

    await row('Aria').getByRole('button', { name: 'Exclude' }).click();
    await waitUntil(async () => (await row('Aria').getAttribute('data-state')) === 'excluded', 5000, 'the exclusion');

    await page.getByRole('tab', { name: 'Chat' }).click();
    await sendButton(page).click();
    await waitForIdle(page);
    const request = (await sent('/v1/messages')).pop();
    const words = JSON.stringify(request.body.messages);
    assert.doesNotMatch(words, /THE TRAITOR IS BRAM/, 'the spoiler stays out');
    assert.doesNotMatch(words, /A ranger\./, 'the excluded page stays out');
    const conversation = (await rpc(page, 'ai.listConversations'))[0];
    assert.deepEqual(conversation.context.excluded, [aria.id]);
    assert.equal(conversation.context.asOfNodeId, chapter.id);
  });

  it('Prompt library: built-ins, a new prompt with a variable, and using it', async () => {
    const page = await start(localProfile());
    await openPane(page);
    await page.getByRole('tab', { name: 'Prompts' }).click();
    await page.getByTestId('ai-prompts').waitFor();
    await page.locator('.ai-prompt-item').filter({ hasText: 'Tighten' }).waitFor();
    await page.getByRole('button', { name: 'New prompt' }).click();
    await page.getByLabel('Name').fill('Page check');
    await page.locator('.ai-prompt-editor textarea').fill('[mock:say=Looked at it] Check this: {{page}}');
    await page.getByLabel('Used for').selectOption('chat');
    await page.getByRole('button', { name: 'Save' }).click();
    const item = page.locator('.ai-prompt-item').filter({ hasText: 'Page check' });
    await item.waitFor();
    await item.getByRole('button', { name: 'Use' }).click();
    assert.match(await page.getByRole('textbox', { name: 'Message the AI' }).inputValue(), /Check this/);
    await sendButton(page).click();
    await waitForIdle(page);
    assert.match(await lastAnswerText(page), /Looked at it/);
    const request = (await sent('/v1/chat/completions')).pop();
    const words = JSON.stringify(request.body.messages);
    assert.match(words, /<document>/, 'the variable is filled in');
    assert.match(words, /Welcome to/, 'with the open page');
  });

  it('Conversations: answers link to pages, survive a restart, and can be switched between', async () => {
    const page = await start(localProfile());
    await rpc(page, 'pages.create', { title: 'Silver Gate', status: 'canon' });
    await openPane(page);
    await send(page, '[mock:say=See [[Silver Gate]] for that. <img src=x onerror=alert(1)> <script>alert(2)</script>[/mock]');
    await waitForIdle(page);
    const answer = page.getByTestId('ai-assistant').last();
    // Untrusted output: no raw HTML reaches the page.
    assert.equal(await answer.locator('img, script').count(), 0);
    assert.match(await answer.innerText(), /<img src=x/);
    await app.screenshot('ai-pane-dark');
    await page.evaluate(() => { document.documentElement.dataset.mode = 'light'; });
    await app.screenshot('ai-pane-light');
    await page.evaluate(() => { document.documentElement.dataset.mode = 'dark'; });
    await answer.locator('a[data-wiki-target="Silver Gate"]').click();
    await page.getByRole('heading', { name: 'Silver Gate' }).waitFor();

    await page.getByRole('button', { name: 'New', exact: true }).click();
    assert.equal(await page.getByTestId('ai-assistant').count(), 0);
    await send(page, '[mock:say=Second chat.]');
    await waitForIdle(page);
    const list = await rpc(page, 'ai.listConversations');
    assert.equal(list.length, 2);

    await page.reload();
    await page.locator('.topbar').waitFor();
    await openPane(page);
    await page.getByRole('combobox', { name: 'Conversation' }).selectOption(list[1].id);
    await page.getByTestId('ai-assistant').first().locator('a[data-wiki-target]').waitFor();
  });

  it('Versions: edit a message and rerun, switch back, regenerate, and they survive a reload', async () => {
    const page = await start(localProfile());
    await openPane(page);
    const pane = page.getByTestId('ai-pane');
    const userText = () => pane.getByTestId('ai-user').first().locator('.ai-user-text').innerText();
    const messageVersions = () => pane.getByTestId('ai-user').first().getByRole('group', { name: 'Versions of this message' });
    const replyVersions = () => pane.getByTestId('ai-assistant').last().getByRole('group', { name: 'Versions of this reply' });
    const status = page.getByTestId('ai-reply-status');

    await send(page, '[mock:take=Gate]');
    await waitForIdle(page);
    assert.match(await lastAnswerText(page), /Gate Take 1\./);
    assert.equal(await messageVersions().count(), 0, 'one version shows no arrows');

    // The keyboard: Up in the empty box opens the last message, and Escape puts it back.
    const input = page.getByRole('textbox', { name: 'Message the AI' });
    await input.focus();
    await page.keyboard.press('ArrowUp');
    const editor = page.getByRole('textbox', { name: 'Edit your message' });
    await editor.waitFor();
    assert.equal(await editor.inputValue(), '[mock:take=Gate]');
    await page.keyboard.press('Escape');
    await editor.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Edit', 'focus goes back to Edit');
    assert.match(await lastAnswerText(page), /Gate Take 1\./, 'cancelling changes nothing');

    // The button: change the words, and Ctrl+Enter saves and runs them.
    await pane.getByTestId('ai-user').first().getByRole('button', { name: 'Edit', exact: true }).click();
    await editor.fill('[mock:take=Wall]');
    await editor.press('Control+Enter');
    await waitForIdle(page);
    await waitUntil(async () => /Wall Take 1\./.test(await lastAnswerText(page)), 5000, 'the new answer');
    assert.equal(await userText(), '[mock:take=Wall]');
    assert.equal(await pane.getByTestId('ai-assistant').count(), 1, 'the old reply is not on screen');
    assert.match(await messageVersions().innerText(), /2 of 2/);
    await waitUntil(async () => (await status.innerText()) === 'Reply finished.', 5000, 'the screen reader to hear the reply finished');

    // The earlier version is still there, as it was.
    await messageVersions().getByRole('button', { name: 'Previous version' }).click();
    await waitUntil(async () => (await userText()) === '[mock:take=Gate]', 5000, 'the earlier version');
    assert.match(await lastAnswerText(page), /Gate Take 1\./);
    assert.match(await messageVersions().innerText(), /1 of 2/);

    // Regenerate asks the same question again and keeps the first reply.
    await pane.getByRole('button', { name: 'Regenerate', exact: true }).click();
    await waitForIdle(page);
    await waitUntil(async () => /Gate Take 2\./.test(await lastAnswerText(page)), 5000, 'the regenerated answer');
    assert.match(await replyVersions().innerText(), /2 of 2/);
    await replyVersions().getByRole('button', { name: 'Previous version' }).click();
    await waitUntil(async () => /Gate Take 1\./.test(await lastAnswerText(page)), 5000, 'the first reply');
    await replyVersions().getByRole('button', { name: 'Next version' }).click();
    await waitUntil(async () => /Gate Take 2\./.test(await lastAnswerText(page)), 5000, 'the second reply');

    const [chat] = await rpc(page, 'ai.listConversations');
    const { messages } = await rpc(page, 'ai.getConversation', { id: chat.id });
    assert.equal(messages.length, 5, 'two questions and three replies, all kept');

    // After a reload, the chat opens on the version last shown, with the others a step away.
    await page.reload();
    await page.locator('.topbar').waitFor();
    await openPane(page);
    await page.getByRole('combobox', { name: 'Conversation' }).selectOption(chat.id);
    await waitUntil(async () => /Gate Take 2\./.test(await lastAnswerText(page)), 5000, 'the chat to open');
    assert.equal(await userText(), '[mock:take=Gate]');
    assert.match(await replyVersions().innerText(), /2 of 2/);
    assert.match(await messageVersions().innerText(), /1 of 2/);
    await messageVersions().getByRole('button', { name: 'Next version' }).click();
    await waitUntil(async () => (await userText()) === '[mock:take=Wall]', 5000, 'the edited version');
    assert.match(await lastAnswerText(page), /Wall Take 1\./);
    const requests = await sent('/v1/chat/completions');
    assert.equal(requests.length, 3, 'switching versions sends nothing');
  });

  it('Versions: on a cloud profile, an edit and a new reply still stop at the spending limit', async () => {
    const page = await start(anthropicProfile(), ANTHROPIC_KEY);
    await openPane(page);
    const pane = page.getByTestId('ai-pane');
    await send(page, '[mock:take=Tower]');
    await waitForIdle(page);
    assert.match(await lastAnswerText(page), /Tower Take 1\./);
    const [chat] = await rpc(page, 'ai.listConversations');

    const month = new Date().toISOString().slice(0, 7);
    await rpc(page, 'settings.update', { patch: { ai: { spending: { limitUsd: 1, month, spentUsd: 1 } } } });
    await page.reload();
    await page.locator('.prose').first().waitFor();
    await openPane(page);
    await page.getByRole('combobox', { name: 'Conversation' }).selectOption(chat.id);
    await pane.getByTestId('ai-assistant').first().waitFor();
    const before = (await sent('/v1/messages')).length;
    const dialog = page.getByRole('alertdialog');

    await pane.getByRole('button', { name: 'Regenerate', exact: true }).click();
    await dialog.getByText('Cloud spending limit reached').waitFor();
    await dialog.getByRole('button', { name: 'Stop' }).click();
    await waitForIdle(page);
    assert.equal((await sent('/v1/messages')).length, before, 'nothing went out');
    assert.match(await lastAnswerText(page), /Tower Take 1\./, 'the reply there was still shows');
    assert.equal(await pane.getByTestId('ai-turn-versions').count(), 0, 'and no empty version was made');

    await pane.getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'Edit your message' });
    await editor.fill('[mock:take=Keep]');
    await pane.getByRole('button', { name: 'Save & run' }).click();
    await dialog.getByText('Cloud spending limit reached').waitFor();
    await dialog.getByRole('button', { name: 'Stop' }).click();
    await editor.waitFor();
    assert.equal(await editor.inputValue(), '[mock:take=Keep]', 'the edit is not lost');
    assert.equal((await sent('/v1/messages')).length, before, 'nothing went out');
    assert.equal((await rpc(page, 'ai.getConversation', { id: chat.id })).messages.length, 2);

    // Allowed, the edit runs as a new version, and the request replays a valid history.
    await editor.press('Control+Enter');
    await dialog.getByRole('button', { name: 'Allow for the rest of this month' }).click();
    await waitForIdle(page);
    await waitUntil(async () => /Keep Take 1\./.test(await lastAnswerText(page)), 5000, 'the new answer');
    assert.equal((await sent('/v1/messages')).length, before + 1);
    assert.match(await pane.getByRole('group', { name: 'Versions of this message' }).innerText(), /2 of 2/);
  });

  it('Replace selection and Insert from the pane arrive as tracked changes', async () => {
    const page = await start(localProfile());
    const scene = await openScene(page, makeDoc(textBlock('The dragon sleeps here.')));
    await selectText(page, 'dragon', '.prose-manuscript');
    await page.getByRole('button', { name: 'Send to pane' }).click();
    await page.getByTestId('ai-chip').waitFor();
    await send(page, '[mock:say=wyvern]');
    await waitForIdle(page);
    await page.getByTestId('ai-assistant').last().getByRole('button', { name: 'Replace selection' }).click();
    await waitForChanges(page);
    assert.equal(plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content), 'The dragon sleeps here.', 'not stored yet');
    await page.getByRole('button', { name: 'Accept all' }).click();
    await page.getByRole('region', { name: 'Suggested changes' }).waitFor({ state: 'detached' });
    await waitUntil(async () => plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content) === 'The wyvern sleeps here.', 5000, 'the replacement');

    await page.getByTestId('ai-assistant').last().getByRole('button', { name: 'Insert' }).click();
    await waitForChanges(page);
    await page.keyboard.press('Alt+Shift+R');
    await page.getByRole('region', { name: 'Suggested changes' }).waitFor({ state: 'detached' });
  });

  it('A proposal from the model changes nothing until the person chooses it', async () => {
    const page = await start(localProfile());
    const before = await rpc(page, 'pages.list');
    await page.evaluate(async () => {
      const { runLoreTool } = await window.__aiE2e.tools();
      window.__toolResult = await runLoreTool({ type: 'toolCall', id: 'c', name: 'propose_new_page', input: { title: 'A New Place', body: 'It is new.' } });
    });
    assert.deepEqual((await rpc(page, 'pages.list')).map((p) => p.id), before.map((p) => p.id), 'nothing was created');
    const result = await page.evaluate(() => window.__toolResult);
    assert.match(result.content, /Nothing has been created/);
  });

  it('Keyboard: open the box, cancel with Esc, submit with Enter, toggle the pane', async () => {
    const page = await start(localProfile());
    await openScene(page, makeDoc(textBlock('The dragon sleeps.')));
    await page.locator('.prose-manuscript').click();
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('Shift+End');
    // The editor sees a selection a moment after the browser makes it, and a script can
    // press the next key sooner than that. The menu shows once it has.
    await page.getByRole('button', { name: 'Ask AI' }).waitFor();
    await page.keyboard.press('Control+Shift+k');
    const box = page.getByRole('textbox', { name: 'What should change?' });
    await box.waitFor();
    await page.keyboard.type('Something');
    await page.keyboard.press('Escape');
    await box.waitFor({ state: 'detached' });

    await page.keyboard.press('Control+Shift+k');
    await box.waitFor();
    await page.keyboard.type('[mock:say=The wyvern sleeps.]');
    await page.keyboard.press('Enter');
    await waitForChanges(page);
    await page.keyboard.press('Alt+r');
    await page.getByRole('region', { name: 'Suggested changes' }).waitFor({ state: 'detached' });

    assert.equal(await page.getByTestId('ai-pane').count(), 0);
    await page.keyboard.press('Control+Shift+a');
    await page.getByTestId('ai-pane').waitFor();
    await page.keyboard.press('Control+Shift+a');
    await page.getByTestId('ai-pane').waitFor({ state: 'detached' });
  });

  it('The window keeps responding during a long fast stream', async () => {
    const page = await start(localProfile());
    await openPane(page);
    await send(page, '[mock:slow]');
    await page.getByTestId('ai-live').waitFor();
    // A blocked main thread would show up as this taking far longer than the timers asked.
    const worstGap = await page.evaluate(
      () =>
        new Promise((resolve) => {
          let last = performance.now();
          let worst = 0;
          const started = last;
          const tick = () => {
            const now = performance.now();
            worst = Math.max(worst, now - last);
            last = now;
            if (now - started > 1500) resolve(worst);
            else setTimeout(tick, 10);
          };
          tick();
        }),
    );
    assert.ok(worstGap < 400, `the longest stall was ${Math.round(worstGap)} ms`);
    // And the input still works while it streams.
    const input = page.getByRole('textbox', { name: 'Message the AI' });
    await input.fill('typing during the stream');
    assert.equal(await input.inputValue(), 'typing during the stream');
    await page.getByRole('button', { name: 'Stop' }).click();
    await waitForIdle(page, 5000);
  });
});
