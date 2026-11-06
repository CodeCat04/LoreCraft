/**
 * More AI help, driven through the real app: talking to a character, beta-reader feedback,
 * several rewrite options, finding local servers, and the status bar.
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

const textNode = (text) => ({ type: 'text', text });
const para = (text) => ({ type: 'paragraph', content: [textNode(text)] });
const linked = (text, target) => ({ type: 'paragraph', content: [{ type: 'text', text, marks: [{ type: 'wikiLink', attrs: { target } }] }] });
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

/** Selects from the start of the first paragraph to the end of the last. */
async function selectAcross(page, scope = '.prose-manuscript') {
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
  await page.reload();
  await page.locator('.topbar, .start-card').first().waitFor();
}

async function firstScene(page) {
  const books = await rpc(page, 'books.list');
  const tree = await rpc(page, 'nodes.tree', { bookId: books[0].id });
  return { bookId: books[0].id, tree, scene: tree.find((n) => n.kind === 'scene') };
}

/** A scene in a real manuscript editor, with this text. */
async function openBench(page, doc) {
  const { scene } = await firstScene(page);
  await rpc(page, 'nodes.update', { id: scene.id, patch: { content: doc } });
  await page.evaluate((id) => window.__aiE2e.mountScene(id), scene.id);
  await page.locator('.prose-manuscript').waitFor();
  return scene;
}

async function send(page, text) {
  const input = page.getByRole('textbox', { name: 'Message the AI' });
  await input.fill(text);
  await input.press('Enter');
}

const sendButton = (page) => page.getByTestId('ai-pane').getByRole('button', { name: 'Send', exact: true });

async function lastAnswer(page) {
  const answers = page.getByTestId('ai-assistant');
  const count = await answers.count();
  return count === 0 ? '' : answers.nth(count - 1).innerText();
}

async function openPane(page) {
  if ((await page.getByTestId('ai-pane').count()) === 0) {
    await page.getByRole('button', { name: 'AI', exact: true }).click();
  }
  await page.getByTestId('ai-pane').waitFor();
}

async function openPage(page, title) {
  await page.keyboard.press('Control+k');
  await page.locator('.palette-input').fill(title);
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: title }).waitFor();
}

async function openFeedback(page) {
  await openPane(page);
  await page.getByRole('tab', { name: 'Feedback' }).click();
  await page.getByTestId('ai-feedback').waitFor();
}

async function askForVersions(page, instruction) {
  await page.getByRole('button', { name: 'Ask AI' }).click();
  const box = page.getByRole('textbox', { name: 'What should change?' });
  await box.fill(instruction);
  await page.getByRole('checkbox', { name: 'Show 3 versions' }).check();
  await box.press('Enter');
  await page.getByTestId('ai-versions').waitFor();
  return box;
}

const version = (page, n) => page.getByRole('region', { name: `Version ${n}`, exact: true });

async function isLocalServerUp() {
  try {
    const response = await fetch(`${LOCAL}/models`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** A small world with a character at its center. */
async function makeWorld(page) {
  const gate = await rpc(page, 'pages.create', {
    title: 'Silver Gate',
    pageType: 'place',
    status: 'canon',
    content: makeDoc(para('The Silver Gate guards the northern pass. It has never been breached.')),
  });
  const aria = await rpc(page, 'pages.create', {
    title: 'Aria Vale',
    pageType: 'character',
    status: 'canon',
    summary: 'A ranger who guards the Silver Gate.',
    aliases: ['Aria'],
    content: makeDoc(
      para('Aria Vale is a ranger of the north, blunt and dry-humored. She has guarded the gate for nine years.'),
      linked('Silver Gate', 'Silver Gate'),
    ),
  });
  return { gate, aria };
}

// ---------------------------------------------------------------------------
// The real local model
// ---------------------------------------------------------------------------

describe('more AI help, with the real local model', () => {
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

  it('talks in character, as a labeled chat stored like any other', async (t) => {
    if (!up) return t.skip('no local server');
    app = await launch(workspace);
    const { page } = app;
    await createProject(page, 'Character World');
    const { aria } = await makeWorld(page);
    await openPage(page, 'Aria Vale');
    await page.getByRole('button', { name: 'Talk to this character' }).click();
    await page.getByTestId('ai-character-banner').waitFor();
    assert.match(await page.getByTestId('ai-character-banner').innerText(), /Talking to Aria Vale/);

    await send(page, 'In one or two sentences: who are you, and what do you guard?');
    await page.getByTestId('ai-live').waitFor({ timeout: 15_000 });
    await sendButton(page).waitFor({ timeout: ANSWER_TIME });
    const answer = await lastAnswer(page);
    console.log(`In character, from the local server: ${answer}`);
    assert.match(answer, /Aria Vale \(AI\)/, 'each reply says who it is from');
    assert.match(answer.toLowerCase(), /gate/, 'it knows what its page says');
    assert.doesNotMatch(answer.toLowerCase(), /as an ai|language model/, 'it stays in character');
    await app.screenshot('companions-character-real');

    const [conversation] = await rpc(page, 'ai.listConversations');
    assert.equal(conversation.title, 'Talk to Aria Vale');
    assert.equal(conversation.context.character.pageId, aria.id);
  });

  it('says what is not established, and does not know what the character could not', async (t) => {
    if (!up) return t.skip('no local server');
    app = await launch(workspace);
    const { page } = app;
    await createProject(page, 'Secret World');
    await makeWorld(page);
    await rpc(page, 'pages.create', {
      title: 'The Regent',
      pageType: 'character',
      status: 'canon',
      content: makeDoc(para('The Regent rules from the far south, and has never met any ranger. In private, he alone knows that the crown is a forgery made of painted tin. He has told no one, ever.')),
    });
    await openPage(page, 'Aria Vale');
    await page.getByRole('button', { name: 'Talk to this character' }).click();
    await send(page, "What was your mother's name? Answer in one or two sentences.");
    await page.getByTestId('ai-live').waitFor({ timeout: 15_000 });
    await sendButton(page).waitFor({ timeout: ANSWER_TIME });
    const mother = await lastAnswer(page);
    console.log(`Asked what is not established: ${mother}`);
    assert.match(mother.toLowerCase(), /not established|don.t know|do not know|never knew|can.t say|cannot say|no name|not recorded|never told|couldn.t tell|don.t recall|won.t/, 'it does not make one up as fact');

    // A reply can take several turns, if the model looks something up first.
    const answersSoFar = await page.getByTestId('ai-assistant').count();
    await send(page, 'The Regent has a secret, about the crown. What is it? Answer in one or two sentences.');
    await waitUntil(async () => (await page.getByTestId('ai-assistant').count()) > answersSoFar, ANSWER_TIME, 'the second answer');
    await sendButton(page).waitFor({ timeout: ANSWER_TIME });
    const secret = await lastAnswer(page);
    console.log(`Asked what they could not know: ${secret}`);
    assert.doesNotMatch(secret.toLowerCase(), /\btin\b|forger|forged/, 'a ranger in the north cannot know that');
    await app.screenshot('companions-character-limits-real');
  });

  it('gives beta-reader notes whose quotes are all really in the text', async (t) => {
    if (!up) return t.skip('no local server');
    app = await launch(workspace);
    const { page } = app;
    await createProject(page, 'Beta World');
    const text = [
      'Aria reached the gate at dusk. The guards did not look up from their dice.',
      '"You are late," said the captain. "I am always late," said Aria. "That is why they pay me so little."',
      'Rain began to fall. Somewhere above them a horn sounded twice, and every man at the table stopped breathing.',
    ];
    const scene = await openBench(page, makeDoc(...text.map(para)));
    await openFeedback(page);
    await page.getByRole('combobox', { name: 'What to look for' }).selectOption('tension');
    await page.getByRole('button', { name: 'Get feedback' }).click();
    await page.getByTestId('ai-beta-result').waitFor({ timeout: ANSWER_TIME });
    await app.screenshot('companions-beta-real');

    const quotes = await page.locator('.ai-beta-quote').allInnerTexts();
    console.log(`Real beta reader: ${quotes.length} notes kept, quoting: ${JSON.stringify(quotes)}`);
    const whole = text.join(' ').replace(/\s+/g, ' ');
    for (const quote of quotes) assert.ok(whole.includes(quote.replace(/\s+/g, ' ').trim()), `not in the text: ${quote}`);
    assert.equal(plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content), text.join(''), 'it changed nothing');
  });

  it('writes three versions, one at a time, and choosing one gives tracked changes', async (t) => {
    if (!up) return t.skip('no local server');
    app = await launch(workspace);
    const { page } = app;
    await createProject(page, 'Versions World');
    const sentence = 'The old dragon slept under the silver vale.';
    const scene = await openBench(page, makeDoc(para(sentence)));
    await selectText(page, sentence);
    await askForVersions(page, 'Rewrite this one sentence to be more vivid. Keep it to one sentence.');
    await waitUntil(async () => (await page.getByTestId('ai-version').locator('[data-status]').count()) >= 0, 1000, 'the panel');
    await waitUntil(
      async () => (await page.locator('[data-testid="ai-version"][data-status="done"]').count()) === 3,
      ANSWER_TIME,
      'all three versions',
    );
    await app.screenshot('companions-versions-real');
    await version(page, 2).getByRole('button', { name: 'Use this one' }).click();
    await page.getByRole('region', { name: 'Suggested changes' }).waitFor();
    await page.locator('.ai-ins').first().waitFor();
    assert.equal(plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content), sentence, 'not stored until accepted');
  });
});

// ---------------------------------------------------------------------------
// The mock, for exact replies
// ---------------------------------------------------------------------------

describe('more AI help, against the mock server', () => {
  let workspace;
  let app;
  let mock;

  const localProfile = () => ({ id: 'local', name: 'Local model', kind: 'openai-compatible', baseUrl: `${mock.url}/v1`, model: 'mock-local', isCloud: false });
  const cloudProfile = () => ({ id: 'gpt', name: 'Cloud', kind: 'openai', baseUrl: `${mock.url}/v1`, model: 'gpt-6-astra', isCloud: true });

  const sent = async (path, method) => {
    const list = await (await fetch(`${mock.url}/__mock/requests`)).json();
    return list.filter((r) => r.path === path && (!method || r.method === method));
  };

  const wordsOf = (request) => request.body.messages.map((m) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => p.text ?? '').join('\n'))).join('\n');

  async function start(profile = localProfile()) {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page, 'Mock World');
    await rpc(page, 'settings.update', { patch: { ai: { cloudWarningDismissed: true } } });
    if (profile.id !== 'local') await rpc(page, 'ai.setKey', { profileId: profile.id, key: 'sk-openai-mock-key' });
    await setProfiles(page, [profile, ...(profile.id === 'local' ? [] : [localProfile()])], profile.id);
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

  // ---- Talking to a character --------------------------------------------------------

  it('plays a character from the picker, with their lore, and keeps to the limits', async () => {
    const page = await start();
    const { aria } = await makeWorld(page);
    const { bookId, scene } = await firstScene(page);
    await rpc(page, 'nodes.update', {
      id: scene.id,
      patch: { title: 'At the gate', synopsis: 'Aria holds the gate alone.', content: makeDoc(para('"Nobody passes," said Aria, and spat.')) },
    });
    const later = await rpc(page, 'nodes.create', { bookId, kind: 'chapter', title: 'A later chapter' });
    const laterScene = await rpc(page, 'nodes.create', { bookId, parentId: later.id, kind: 'scene', title: 'The betrayal', content: makeDoc(para('Aria sold the gate for gold.')) });
    await rpc(page, 'pages.create', { title: 'Traitor Plot', status: 'canon', content: makeDoc(para('Aria Vale secretly sells the keys.')) });
    const secret = await rpc(page, 'pages.getByTitle', { title: 'Traitor Plot' });
    await rpc(page, 'pages.update', { id: secret.id, patch: { revealNodeId: laterScene.id } });
    await rpc(page, 'pages.create', { title: 'Unused Idea', status: 'idea', content: makeDoc(para('Aria might be a dragon in disguise.')) });
    await rpc(page, 'pages.update', {
      id: aria.id,
      patch: { content: makeDoc(para('Aria Vale is a ranger of the north, blunt and dry-humored.'), linked('Silver Gate', 'Silver Gate'), linked('Traitor Plot', 'Traitor Plot'), linked('Unused Idea', 'Unused Idea')) },
    });

    await openPane(page);
    await page.getByRole('combobox', { name: 'Talk to a character' }).selectOption({ label: 'Aria Vale' });
    await page.getByTestId('ai-character-banner').waitFor();
    assert.match(await page.getByTestId('ai-character-banner').innerText(), /nothing said here changes canon/i);
    await app.screenshot('companions-character-empty');

    // Knows the story only as far as the first chapter.
    const limit = page.getByTestId('ai-character-banner').getByRole('combobox', { name: 'The AI knows up to' });
    const chapters = (await firstScene(page)).tree.filter((n) => n.kind === 'chapter');
    await limit.selectOption(chapters[0].id);

    // "What is sent" shows exactly that, including who it plays.
    await page.getByRole('tab', { name: 'What is sent' }).click();
    const playing = page.getByTestId('ai-context-character');
    await playing.waitFor();
    assert.match(await playing.innerText(), /Playing Aria Vale/);
    assert.match(await page.getByTestId('ai-context').innerText(), /get_backlinks, get_page, get_scene, list_pages, search_lore\. /);
    assert.doesNotMatch(await page.getByTestId('ai-context').innerText(), /propose_edit/);
    await page.getByRole('tab', { name: 'Chat' }).click();

    await send(page, '[mock:say=Nobody passes. *Spits.*\n\n(Not established: where I was born.)[/mock] Who are you?');
    await page.getByTestId('ai-assistant').waitFor({ timeout: 15_000 });
    await sendButton(page).waitFor({ timeout: 15_000 });
    assert.match(await lastAnswer(page), /Aria Vale \(AI\)/);
    assert.match(await lastAnswer(page), /Not established/);
    await app.screenshot('companions-character-mock');

    const [request] = await sent('/v1/chat/completions');
    const system = request.body.messages.find((m) => m.role === 'system').content;
    assert.match(typeof system === 'string' ? system : JSON.stringify(system), /You are playing a character/);
    const tools = request.body.tools.map((tool) => tool.function.name);
    assert.ok(tools.includes('search_lore'), 'it can look things up');
    assert.ok(!tools.some((name) => name.startsWith('propose')), `and propose nothing: ${tools}`);

    const words = wordsOf(request);
    assert.match(words, /you are playing Aria Vale/, 'it is told who it is');
    assert.match(words, /blunt and dry-humored/, 'with their page');
    assert.match(words, /never been breached/, 'and what is around them');
    assert.match(words, /Aria holds the gate alone/, 'and the scenes they are in');
    assert.match(words, /Nobody passes," said Aria/, 'with a sample of how they talk');
    assert.doesNotMatch(words, /sells the keys/, 'a page past the limit stays hidden');
    assert.doesNotMatch(words, /The betrayal|sold the gate/, 'so does a scene past the limit');
    assert.doesNotMatch(words, /dragon in disguise/, 'and an idea nobody asked about');
    assert.match(words, /Reply as Aria Vale/, 'and it is reminded of its limits');

    // A later message does not repeat what the conversation already has.
    await send(page, '[mock:say=Still here.] And now?');
    await waitUntil(async () => (await lastAnswer(page)).includes('Still here.'), 15_000, 'the second answer');
    const second = (await sent('/v1/chat/completions')).pop();
    const count = (wordsOf(second).match(/you are playing Aria Vale/g) ?? []).length;
    assert.equal(count, 1, 'the character is introduced once');

    const [conversation] = await rpc(page, 'ai.listConversations');
    assert.equal(conversation.title, 'Talk to Aria Vale');
    assert.equal(conversation.context.character.pageId, aria.id);

    // It is a conversation like any other: another chat is not in character, and it comes back.
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByTestId('ai-character-banner').waitFor({ state: 'detached' });
    await send(page, '[mock:say=Plain assistant.] Hello');
    await waitUntil(async () => (await lastAnswer(page)).includes('Plain assistant.'), 15_000, 'an ordinary answer');
    assert.doesNotMatch(await lastAnswer(page), /Aria Vale \(AI\)/);
    assert.equal(await page.getByRole('button', { name: 'Replace selection' }).count(), 1, 'with the usual actions');
    const plain = (await sent('/v1/chat/completions')).pop();
    assert.ok(plain.body.tools.some((tool) => tool.function.name === 'propose_edit'), 'and the usual tools');
    assert.doesNotMatch(JSON.stringify(plain.body.messages), /You are playing a character/);

    await page.getByRole('combobox', { name: 'Conversation' }).selectOption(conversation.id);
    await page.getByTestId('ai-character-banner').waitFor();
    assert.match(await lastAnswer(page), /Still here\./);
  });

  it('is offered in the command palette on a character page', async () => {
    const page = await start();
    await makeWorld(page);
    await openPage(page, 'Aria Vale');
    await page.keyboard.press('Control+k');
    await page.locator('.palette-input').fill('Talk to this character');
    await page.locator('.palette').getByText('Talk to this character').waitFor();
    await page.keyboard.press('Enter');
    await page.getByTestId('ai-character-banner').waitFor();
    assert.match(await page.getByTestId('ai-character-banner').innerText(), /Talking to Aria Vale/);
  });

  it('saves a reply to the Talk tab, and changes nothing else on the page', async () => {
    const page = await start();
    const { aria } = await makeWorld(page);
    await rpc(page, 'pages.update', { id: aria.id, patch: { notes: makeDoc(para('My own note, first.')) } });
    const before = await rpc(page, 'pages.get', { id: aria.id });

    await openPage(page, 'Aria Vale');
    await page.getByRole('button', { name: 'Talk to this character' }).click();
    await send(page, '[mock:say=I was **never** one for songs. ![Stolen](https://evil.example/x.png)[/mock] Do you sing?');
    await page.getByTestId('ai-assistant').waitFor({ timeout: 15_000 });
    assert.equal(await page.getByTestId('ai-assistant').getByRole('button', { name: 'Replace selection' }).count(), 0, 'a reply cannot go into a document from here');
    await page.getByRole('button', { name: 'Save as note' }).click();
    await page.getByText('Saved to the Talk tab').waitFor();

    const stored = await rpc(page, 'pages.get', { id: aria.id });
    const notes = plainOf(stored.notes);
    assert.match(notes, /My own note, first\./, 'what was there stays');
    assert.match(notes, /played by the AI\. This is not canon\./, 'it says what it is');
    assert.match(notes, /never one for songs/);
    assert.doesNotMatch(JSON.stringify(stored.notes), /evil\.example/, 'nothing from a remote address gets in');
    assert.deepEqual(stored.content, before.content, 'the article is untouched');
    assert.equal(stored.status, before.status);
    assert.deepEqual(stored.infobox, before.infobox);
    assert.equal(stored.summary, before.summary);

    await page.locator('.wiki-tabs').getByRole('button', { name: 'Talk', exact: true }).click();
    await page.locator('.wiki-talk').getByText('never one for songs').waitFor();
    await app.screenshot('companions-talk-note');
  });

  it('says so when a character has not appeared yet at the limit', async () => {
    const page = await start();
    const { aria } = await makeWorld(page);
    const { bookId, tree } = await firstScene(page);
    const later = await rpc(page, 'nodes.create', { bookId, kind: 'chapter', title: 'A later chapter' });
    await rpc(page, 'pages.update', { id: aria.id, patch: { revealNodeId: later.id } });
    await openPane(page);
    await page.getByRole('combobox', { name: 'Talk to a character' }).selectOption({ label: 'Aria Vale' });
    await page.getByTestId('ai-character-banner').getByRole('combobox', { name: 'The AI knows up to' }).selectOption(tree.find((n) => n.kind === 'chapter').id);
    await send(page, 'Who are you?');
    const card = page.getByTestId('ai-error');
    await card.waitFor({ timeout: 10_000 });
    assert.match(await card.innerText(), /has not appeared yet/);
    assert.equal((await sent('/v1/chat/completions')).length, 0, 'nothing was sent');
    assert.equal(await page.getByRole('textbox', { name: 'Message the AI' }).inputValue(), 'Who are you?', 'what was typed is still there');
  });

  // ---- Beta-reader feedback ----------------------------------------------------------

  // The reply travels in the scene's own text, so an invented quote is spelled with a JSON
  // escape: once parsed it says something that is nowhere in that text.
  const betaReply = JSON.stringify({
    summary: 'A strong **opening** that loses its nerve.',
    notes: [
      { quote: 'The "old" dragon slept under the vale.', note: 'This line hooks me. <img src=x onerror=alert(1)>' },
      { quote: 'Morning came slowly over the hills.', note: 'This is where it starts to drag.' },
      { quote: 'A sentence nobody ever wrote.', note: 'Invented.' },
      { quote: 'Aria wept.', note: 'Also invented.' },
    ],
  }).replace('nobody ever', 'nobody \\u0065ver').replace('Aria wept', 'Aria w\\u0065pt');

  it('shows notes with verified quotes, counts what it drops, and jumps to the passage', async () => {
    const page = await start();
    const doc = makeDoc(
      para('The “old” dragon slept under the vale.'),
      para('Morning came slowly over the hills. Nothing else happened for a long while.'),
      para(`[mock:say=${betaReply}[/mock]`),
    );
    const scene = await openBench(page, doc);
    const before = JSON.stringify((await rpc(page, 'nodes.get', { id: scene.id })).content);

    await openFeedback(page);
    await page.getByRole('combobox', { name: 'What to look for' }).selectOption('pacing');
    await page.getByRole('button', { name: 'Get feedback' }).click();
    await page.getByTestId('ai-beta-result').waitFor({ timeout: 15_000 });
    await app.screenshot('companions-beta-notes');

    const notes = page.getByTestId('ai-beta-note');
    assert.equal(await notes.count(), 2, 'only what is really in the text');
    assert.equal(await page.locator('.ai-beta-quote').first().innerText(), 'The “old” dragon slept under the vale.', "it shows the writer's own text");
    assert.match(await page.getByTestId('ai-beta-dropped').innerText(), /2 notes were left out/);
    assert.equal(await page.locator('.ai-beta-result img').count(), 0, 'no markup from a model gets through');
    assert.equal(await page.locator('.ai-beta-result strong').first().innerText(), 'opening');

    await notes.nth(1).click();
    await waitUntil(async () => (await page.evaluate(() => window.getSelection().toString())) === 'Morning came slowly over the hills.', 3000, 'the passage to be selected');

    const request = (await sent('/v1/chat/completions')).pop();
    assert.match(JSON.stringify(request.body.messages), /beta reader/);
    assert.match(wordsOf(request), /Your focus is pacing/);
    assert.equal(JSON.stringify((await rpc(page, 'nodes.get', { id: scene.id })).content), before, 'it rewrites nothing');
    assert.equal(await page.locator('.ai-del, .ai-ins').count(), 0, 'and suggests nothing');
  });

  it('reads a whole chapter, and jumps to the scene a note belongs to', async () => {
    const page = await start();
    const { bookId, tree, scene } = await firstScene(page);
    const chapter = tree.find((n) => n.id === scene.parentId);
    assert.ok(chapter, 'the starting scene is in a chapter');
    const reply = JSON.stringify({ summary: '', notes: [{ quote: 'The second scene ends here.', note: 'Good ending.' }] }).replace('scene ends', 'scene \\u0065nds');
    await rpc(page, 'nodes.update', { id: scene.id, patch: { title: 'First', content: makeDoc(para(`The first scene opens here. [mock:say=${reply}[/mock]`)) } });
    const second = await rpc(page, 'nodes.create', { bookId, parentId: chapter.id, kind: 'scene', title: 'Second', content: makeDoc(para('The second scene ends here.')) });

    await openFeedback(page);
    const what = page.getByRole('combobox', { name: 'What to read' });
    await what.selectOption(chapter.id);
    await page.getByRole('button', { name: 'Get feedback' }).click();
    await page.getByTestId('ai-beta-note').waitFor({ timeout: 15_000 });
    assert.match(await page.getByTestId('ai-beta-note').innerText(), /Second/, 'it says which scene');

    const request = (await sent('/v1/chat/completions')).pop();
    assert.match(wordsOf(request), /The first scene opens here/);
    assert.match(wordsOf(request), /The second scene ends here/);

    await page.getByTestId('ai-beta-note').click();
    await page.locator('.prose-manuscript').waitFor({ timeout: 5000 });
    await waitUntil(async () => (await page.evaluate(() => window.getSelection().toString())) === 'The second scene ends here.', 5000, 'the passage in the other scene');
    assert.ok(await page.locator('.prose-manuscript').getByText('The second scene ends here.').isVisible(), `scene ${second.id} is what is open`);
  });

  it('can be stopped, and says when there is nothing to read', async () => {
    const page = await start();
    await openBench(page, makeDoc(para('[mock:hang] Aria waits at the gate.')));
    await openFeedback(page);
    await page.getByRole('button', { name: 'Get feedback' }).click();
    await page.getByTestId('ai-feedback').getByRole('button', { name: 'Stop' }).click();
    await page.getByRole('button', { name: 'Get feedback' }).waitFor({ timeout: 5000 });
    assert.equal(await page.getByTestId('ai-beta-problem').count(), 0, 'stopping is not an error');

    await rpc(page, 'nodes.update', { id: (await firstScene(page)).scene.id, patch: { content: makeDoc({ type: 'paragraph' }) } });
    await page.getByRole('button', { name: 'Get feedback' }).click();
    await page.getByTestId('ai-beta-problem').waitFor({ timeout: 5000 });
    assert.match(await page.getByTestId('ai-beta-problem').innerText(), /nothing written here/);
  });

  // ---- Several rewrite options -------------------------------------------------------

  it('shows three versions side by side, and choosing one goes through tracked changes', async () => {
    const page = await start();
    const scene = await openBench(page, makeDoc(para('Keep this. The dragon sleeps here. Keep that.')));
    await selectText(page, 'The dragon sleeps here.');
    await askForVersions(page, '[mock:version=The wyvern naps there]');

    await waitUntil(async () => (await page.locator('[data-testid="ai-version"][data-status="done"]').count()) === 3, 30_000, 'all three versions');
    const texts = await page.getByTestId('ai-version-text').allInnerTexts();
    assert.deepEqual(texts.map((t) => t.trim()), ['The wyvern naps there Take 1.', 'The wyvern naps there Take 2.', 'The wyvern naps there Take 3.']);
    await app.screenshot('companions-versions');
    const boxes = await Promise.all([1, 2, 3].map((n) => version(page, n).boundingBox()));
    assert.ok(boxes[0].x < boxes[1].x && boxes[1].x < boxes[2].x, 'side by side');
    assert.equal(boxes[0].y, boxes[1].y);

    // Nothing has reached the document, and each request asked for its own version.
    assert.equal(await page.locator('.ai-del, .ai-ins').count(), 0);
    const requests = await sent('/v1/chat/completions');
    assert.equal(requests.length, 3);
    requests.forEach((request, index) => assert.match(wordsOf(request), new RegExp(`version ${index + 1} of 3`)));

    // Regenerating one leaves the others alone, and asks for something different.
    await version(page, 3).getByRole('button', { name: 'Regenerate' }).click();
    await waitUntil(async () => (await sent('/v1/chat/completions')).length === 4, 10_000, 'one more request');
    await waitUntil(async () => (await version(page, 3).getAttribute('data-status')) === 'done', 15_000, 'it to finish');
    assert.match(wordsOf((await sent('/v1/chat/completions')).pop()), /did not take this attempt/);
    assert.equal((await page.getByTestId('ai-version-text').allInnerTexts())[0].trim(), 'The wyvern naps there Take 1.');

    await version(page, 2).getByRole('button', { name: 'Use this one' }).click();
    await page.getByRole('region', { name: 'Suggested changes' }).waitFor();
    await page.getByTestId('ai-versions').waitFor({ state: 'detached' });
    assert.ok((await page.locator('.ai-ins').allInnerTexts()).join(' ').includes('Take'), 'it shows as tracked changes');
    assert.equal(plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content), 'Keep this. The dragon sleeps here. Keep that.', 'not stored yet');

    await page.getByRole('button', { name: 'Accept all' }).click();
    await waitUntil(async () => plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content).includes('Take 2'), 5000, 'it to be stored');
    assert.equal(plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content), 'Keep this. The wyvern naps there Take 2. Keep that.');
    const revisions = await rpc(page, 'revisions.list', { kind: 'node', id: scene.id });
    assert.ok(revisions.some((r) => r.reason === 'ai'), 'a snapshot was taken, as with any accepted edit');
  });

  it('still gives one suggestion straight away when the box is left unticked', async () => {
    const page = await start();
    const scene = await openBench(page, makeDoc(para('Keep this. The dragon sleeps here. Keep that.')));
    await selectText(page, 'The dragon sleeps here.');
    await page.getByRole('button', { name: 'Ask AI' }).click();
    const box = page.getByRole('textbox', { name: 'What should change?' });
    await box.fill('[mock:say=The wyvern naps there.]');
    await box.press('Enter');
    await page.getByRole('region', { name: 'Suggested changes' }).waitFor({ timeout: 15_000 });
    assert.equal(await page.getByTestId('ai-versions').count(), 0);
    assert.equal((await sent('/v1/chat/completions')).length, 1, 'one request');
    await page.getByRole('button', { name: 'Accept all' }).click();
    await waitUntil(async () => plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content) === 'Keep this. The wyvern naps there. Keep that.', 5000, 'it to be stored');
  });

  it('works from a quick action too', async () => {
    const page = await start();
    await openBench(page, makeDoc(para('The dragon sleeps here.')));
    await selectText(page, 'The dragon sleeps here.');
    await page.getByRole('button', { name: 'Ask AI' }).click();
    await page.getByRole('checkbox', { name: 'Show 3 versions' }).check();
    await app.screenshot('companions-ask-box');
    await page.getByRole('button', { name: 'Tighten', exact: true }).click();
    await page.getByTestId('ai-versions').waitFor();
    assert.match(await page.getByTestId('ai-versions').innerText(), /3 versions: Tighten/);
    await waitUntil(async () => (await page.locator('[data-testid="ai-version"][data-status="done"]').count()) === 3, 30_000, 'all three versions');
    assert.match(wordsOf((await sent('/v1/chat/completions'))[0]), /Tighten this passage/);
  });

  it('writes as many versions as the settings ask for', async () => {
    const page = await start();
    await rpc(page, 'settings.update', { patch: { ai: { rewriteVersions: 4 } } });
    await page.reload();
    await page.locator('.prose').first().waitFor();
    await openBench(page, makeDoc(para('The dragon sleeps here.')));
    await selectText(page, 'The dragon sleeps here.');
    await page.getByRole('button', { name: 'Ask AI' }).click();
    await page.getByRole('checkbox', { name: 'Show 4 versions' }).check();
    await page.getByRole('button', { name: 'Tighten', exact: true }).click();
    await page.getByTestId('ai-versions').waitFor();
    assert.match(await page.getByTestId('ai-versions').innerText(), /4 versions: Tighten/);
    await waitUntil(async () => (await page.locator('[data-testid="ai-version"][data-status="done"]').count()) === 4, 40_000, 'all four versions');
    assert.match(wordsOf((await sent('/v1/chat/completions'))[3]), /version 4 of 4/);
  });

  it('shows what an in-document request will send to a cloud provider, before sending', async () => {
    const page = await start(cloudProfile());
    await openBench(page, makeDoc(para('The dragon sleeps here.')));
    await selectText(page, 'The dragon sleeps here.');
    await page.getByRole('button', { name: 'Ask AI' }).click();
    await page.getByRole('textbox', { name: 'What should change?' }).fill('Make the dragon a wyvern.');
    await page.getByRole('button', { name: 'What will be sent' }).click();
    const preview = page.getByTestId('ai-sent-preview');
    await preview.getByText('Your request').waitFor({ timeout: 10_000 });
    await preview.getByText('Instructions for the model').waitFor();
    const opened = preview.locator('details').last();
    await opened.locator('summary').click();
    assert.match(await opened.innerText(), /Make the dragon a wyvern\./);
    assert.match(await preview.innerText(), /Cloud|OpenAI/);
    assert.equal((await sent('/v1/responses')).length, 0, 'nothing went out');
  });

  it('renames and deletes a chat from the keyboard, and the delete can be undone', async () => {
    const page = await start();
    const made = await rpc(page, 'ai.createConversation', { title: 'Gate questions', context: {} });
    await rpc(page, 'ai.addMessage', { conversationId: made.id, role: 'user', content: [{ type: 'text', text: 'Who guards the gate?' }] });
    await rpc(page, 'settings.update', { patch: { ai: { paneOpen: true } } });
    await page.reload();
    await page.getByTestId('ai-pane').waitFor();
    const picker = page.getByRole('combobox', { name: 'Conversation' });
    await waitUntil(async () => (await picker.locator('option').allInnerTexts()).includes('Gate questions'), 10_000, 'the chat to be listed');
    await picker.selectOption(made.id);
    await picker.focus();

    await page.keyboard.press('F2');
    const name = page.getByRole('dialog').getByRole('textbox');
    await name.fill('Gate answers');
    await name.press('Enter');
    await waitUntil(async () => (await rpc(page, 'ai.listConversations')).some((c) => c.title === 'Gate answers'), 5000, 'the rename');

    await picker.focus();
    await page.keyboard.press('Delete');
    await waitUntil(async () => (await rpc(page, 'ai.listConversations')).length === 0, 5000, 'the delete');
    await page.getByRole('button', { name: 'Undo' }).click();
    const back = await waitUntil(async () => (await rpc(page, 'ai.listConversations')).find((c) => c.title === 'Gate answers'), 5000, 'the chat to come back');
    const { messages } = await rpc(page, 'ai.getConversation', { id: back.id });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content[0].text, 'Who guards the gate?');
  });

  it('adds rather than replaces, for a prompt that continues the text', async () => {
    const page = await start();
    const scene = await openBench(page, makeDoc(para('The dragon sleeps here.')));
    await selectText(page, 'The dragon sleeps here.');
    await page.getByRole('button', { name: 'Ask AI' }).click();
    await page.getByRole('checkbox', { name: 'Show 3 versions' }).check();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await waitUntil(async () => (await page.locator('[data-testid="ai-version"][data-status="done"]').count()) === 3, 30_000, 'all three versions');
    await version(page, 3).getByRole('button', { name: 'Use this one' }).click();
    await page.getByRole('region', { name: 'Suggested changes' }).waitFor();
    assert.equal(await page.locator('.ai-del').count(), 0, 'nothing is taken away');
    await page.locator('.ai-ins').first().waitFor();
    await page.getByRole('button', { name: 'Accept all' }).click();
    await waitUntil(async () => plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content).length > 30, 5000, 'it to be stored');
    assert.ok(plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content).startsWith('The dragon sleeps here.'), 'what was there stays');
  });

  it('runs one at a time on a local server, and Stop leaves the document alone', async () => {
    const page = await start();
    const scene = await openBench(page, makeDoc(para('A short line to rewrite.')));
    await selectText(page, 'A short line to rewrite.');
    const box = await askForVersions(page, '[mock:slow]');

    await waitUntil(async () => (await version(page, 1).getByTestId('ai-version-text').innerText()).length > 10, 15_000, 'the first to stream');
    assert.equal(await version(page, 2).getAttribute('data-status'), 'queued');
    assert.equal(await version(page, 3).getAttribute('data-status'), 'queued');
    assert.match(await version(page, 2).innerText(), /Waiting its turn/);
    assert.equal((await sent('/v1/chat/completions')).length, 1, 'only one request is out');

    const started = Date.now();
    await page.getByTestId('ai-versions').getByRole('button', { name: 'Stop' }).click();
    await waitUntil(async () => (await page.locator('[data-testid="ai-version"][data-status="stopped"]').count()) === 3, 5000, 'all three to stop');
    assert.ok(Date.now() - started < 3000, 'stopping is prompt');
    assert.equal((await sent('/v1/chat/completions')).length, 1, 'the others never went out');
    assert.equal(await page.locator('.ai-del, .ai-ins').count(), 0);
    assert.equal(plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content), 'A short line to rewrite.');

    // A stopped version cannot be chosen, and Back returns to what was asked.
    assert.ok(await version(page, 1).getByRole('button', { name: 'Use this one' }).isDisabled());
    await page.getByTestId('ai-versions').getByRole('button', { name: 'Back' }).click();
    await box.waitFor();
    assert.equal(await box.inputValue(), '[mock:slow]');
    await page.keyboard.press('Escape');
    await page.locator('.ai-ask').waitFor({ state: 'detached' });
  });

  it('runs them together on a cloud profile', async () => {
    const page = await start(cloudProfile());
    await openBench(page, makeDoc(para('A short line to rewrite.')));
    await selectText(page, 'A short line to rewrite.');
    await askForVersions(page, '[mock:slow]');
    await waitUntil(async () => (await sent('/v1/responses')).length === 3, 10_000, 'all three requests to be out at once');
    await waitUntil(async () => (await page.locator('[data-testid="ai-version"][data-status="writing"]').count()) === 3, 15_000, 'all three to stream');
    await page.keyboard.press('Escape');
    await waitUntil(async () => (await page.locator('[data-testid="ai-version"][data-status="stopped"]').count()) === 3, 5000, 'Escape to stop them');
    await page.keyboard.press('Escape');
    await page.getByTestId('ai-versions').waitFor({ state: 'detached' });
  });

  it('keeps a figure when a chosen version crosses it', async () => {
    const page = await start();
    const figure = {
      type: 'figure',
      attrs: { kind: 'picture', align: 'left', width: 35, description: 'Hand drawn' },
      content: [{ type: 'image', attrs: { assetId: 'a-picture', alt: '' } }, { type: 'figcaption', content: [textNode('The map')] }],
    };
    const scene = await openBench(page, makeDoc(para('First words here.'), figure, para('Second words here.')));
    await selectAcross(page);
    await page.getByRole('button', { name: 'Ask AI' }).waitFor();
    // A reply that drops the marker, and tries to place a picture of its own.
    await askForVersions(page, '[mock:version=New words entirely. ![Stolen](https://evil.example/x.png)[/mock]');
    await waitUntil(async () => (await page.locator('[data-testid="ai-version"][data-status="done"]').count()) === 3, 30_000, 'all three versions');
    assert.match(await page.getByTestId('ai-versions').innerText(), /Figures in the selection stay/);
    assert.equal(await page.locator('.ai-version img').count(), 0, 'a model cannot show a picture');
    assert.match(wordsOf((await sent('/v1/chat/completions'))[0]), /\{\{KEEP 1: \[Picture 1: The map \(Hand drawn\)\]\}\}/, 'the model sees the marker');

    await version(page, 1).getByRole('button', { name: 'Use this one' }).click();
    await page.getByRole('region', { name: 'Suggested changes' }).waitFor();
    await page.getByRole('button', { name: 'Accept all' }).click();
    await waitUntil(async () => plainOf((await rpc(page, 'nodes.get', { id: scene.id })).content).includes('New words'), 5000, 'it to be stored');
    const stored = (await rpc(page, 'nodes.get', { id: scene.id })).content;
    const figures = stored.content.filter((n) => n.type === 'figure');
    assert.equal(figures.length, 1);
    assert.deepEqual(figures[0].attrs, figure.attrs);
    assert.equal(figures[0].content[0].attrs.assetId, 'a-picture');
    assert.doesNotMatch(JSON.stringify(stored), /evil\.example/);
  });

  // ---- Local servers and the status bar ----------------------------------------------

  it('finds a server on a common port, and offers to add it', async (t) => {
    // Any of these may be taken by something real, so use the first that is free.
    let server = null;
    for (const port of [5001, 5000, 8000, 1234]) {
      try {
        server = await startMockServer({ port });
        break;
      } catch {
        // Taken. Try the next.
      }
    }
    if (!server) return t.skip('none of the ports is free');
    try {
      const page = await start();
      await page.keyboard.press('Control+k');
      await page.locator('.palette-input').fill('Settings');
      await page.keyboard.press('Enter');
      await page.getByRole('tab', { name: 'AI', exact: true }).click();
      await page.getByRole('button', { name: 'Find local servers' }).click();
      const found = page.locator(`[data-testid="ai-found-server"][data-port="${server.port}"]`);
      await found.waitFor({ timeout: 5000 });
      assert.match(await found.innerText(), new RegExp(`http://127\\.0\\.0\\.1:${server.port}/v1`));
      assert.match(await found.innerText(), /gpt-6-astra/, 'it lists what it has');
      await app.screenshot('companions-find-servers');

      await found.getByRole('button', { name: 'Add' }).click();
      await found.getByRole('button', { name: 'Already added' }).waitFor();
      const settings = await rpc(page, 'settings.get');
      const added = settings.ai.profiles.find((p) => p.baseUrl === `http://127.0.0.1:${server.port}/v1`);
      assert.ok(added, 'a profile was added');
      assert.equal(added.kind, 'openai-compatible');
      assert.equal(added.isCloud, false);
    } finally {
      await server.close();
    }
  });

  it('shows the profile, the model and the last answer, and does not poll', async () => {
    const page = await start();
    const status = page.getByTestId('ai-status');
    await status.waitFor();
    assert.match(await status.innerText(), /Local model, mock-local, not used yet/);

    // Nothing goes to the server on its own.
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal((await sent('/v1/models', 'GET')).length, 0, 'no polling');
    assert.equal((await sent('/v1/chat/completions')).length, 0);

    await openPane(page);
    await send(page, '[mock:say=Hello.]');
    await waitUntil(async () => (await status.getAttribute('data-state')) === 'answered', 15_000, 'an answer');
    assert.match(await status.innerText(), /Local model, mock-local, answered just now/);
    await app.screenshot('companions-status');

    // On request, it asks.
    await fetch(`${mock.url}/__mock/reset`, { method: 'POST' });
    await status.click();
    await waitUntil(async () => (await sent('/v1/models', 'GET')).length === 1, 5000, 'the check');

    // And a failure says so, without any dialog in the way.
    await rpc(page, 'settings.update', { patch: { ai: { profiles: [{ ...localProfile(), baseUrl: 'http://127.0.0.1:9/v1' }] } } });
    await page.reload();
    await page.locator('.topbar').waitFor();
    await status.click();
    await waitUntil(async () => (await status.getAttribute('data-state')) === 'failed', 10_000, 'the failure');
    assert.match(await status.innerText(), /did not answer/);
  });
});
