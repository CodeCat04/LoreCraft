/** The Writing styles screen in the real app, and how a style reaches the AI. */

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { startMockServer } from '../scripts/mock-ai-server.mjs';
import { allowPath, createProject, createWorkspace, launch, rpc, waitUntil } from './harness.mjs';

const textBlock = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const makeDoc = (...content) => ({ type: 'doc', content });

async function openStyles(page, command = 'Writing styles…') {
  await page.getByRole('menuitem', { name: 'AI', exact: true }).click();
  await page.getByRole('menuitem', { name: command }).click();
  await page.getByTestId('styles-page').waitFor();
}

const statusItem = (page) => page.locator('[data-status="writing-style"]');

async function waitForStatus(page, text) {
  await waitUntil(async () => (await statusItem(page).innerText().catch(() => '')) === text, 5000, `the status bar to say ${text}`);
}

const openTab = (page, name) => page.getByRole('tab', { name, exact: true }).click();

async function shots(app, name) {
  await app.screenshot(`styles-${name}-encyclopedia-dark`);
  for (const [theme, mode] of [['encyclopedia', 'light'], ['parchment', 'dark'], ['typewriter', 'light'], ['midnight', 'dark']]) {
    await app.page.evaluate(([t, m]) => {
      document.documentElement.dataset.theme = t;
      document.documentElement.dataset.mode = m;
    }, [theme, mode]);
    await app.screenshot(`styles-${name}-${theme}-${mode}`);
  }
  await app.page.evaluate(() => {
    document.documentElement.dataset.theme = 'encyclopedia';
    document.documentElement.dataset.mode = 'dark';
  });
}

describe('writing styles', () => {
  let workspace;
  let app;

  beforeEach(() => {
    workspace = createWorkspace();
  });

  afterEach(async () => {
    if (app && !app.exited) await app.kill().catch(() => {});
    workspace.cleanup();
  });

  it('finds a style, shows its prompt, and keeps it through save and reopen', async () => {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page, 'Style World');
    await openStyles(page);

    const rows = page.locator('.styles-row');
    assert.ok((await rows.count()) >= 130, 'the whole library is listed');
    await waitForStatus(page, 'Style: none');
    await shots(app, 'browse');

    await page.getByRole('searchbox', { name: 'Search styles' }).fill('Clancy');
    await rows.first().getByText('Tom Clancy').waitFor();
    await page.getByRole('heading', { name: 'Tom Clancy' }).waitFor();
    await page.getByRole('heading', { name: 'How they write' }).waitFor();
    const prompt = await page.getByTestId('style-prompt').innerText();
    assert.match(prompt, /^Write in the manner of Tom Clancy\./);
    assert.match(prompt, /Narration: .*\nSentences: /);
    assert.match(prompt, /Write original prose in this manner\./);
    assert.match(prompt, /the lore wins over style\.$/);
    assert.doesNotMatch(prompt, /Red October/);

    // By keyboard: down from the search box into the list, and back.
    await page.getByRole('searchbox', { name: 'Search styles' }).fill('');
    await page.getByRole('searchbox', { name: 'Search styles' }).fill('technothriller');
    const list = page.getByRole('listbox', { name: 'Styles' });
    await page.getByRole('searchbox', { name: 'Search styles' }).press('ArrowDown');
    assert.equal(await list.evaluate((el) => el === document.activeElement), true);
    const before = await page.locator('.styles-detail h2').innerText();
    await page.keyboard.press('ArrowDown');
    await waitUntil(async () => (await page.locator('.styles-detail h2').innerText()) !== before, 3000, 'the selection to move');
    await page.getByRole('searchbox', { name: 'Search styles' }).fill('Clancy');
    await page.getByRole('heading', { name: 'Tom Clancy' }).waitFor();

    // A favorite, and the filters.
    await page.getByRole('button', { name: 'Add Tom Clancy to favorites' }).click();
    await page.getByRole('button', { name: 'Remove Tom Clancy from favorites' }).waitFor();
    await page.getByRole('searchbox', { name: 'Search styles' }).fill('');
    await page.getByRole('button', { name: '★ Favorites' }).click();
    await waitUntil(async () => (await rows.count()) === 1, 3000, 'only the favorite');
    await page.getByRole('button', { name: '★ Favorites' }).click();
    await page.getByRole('button', { name: 'Techniques', exact: true }).click();
    await page.getByRole('option', { name: /Deep third person/ }).waitFor();
    assert.ok((await rows.count()) >= 20);
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await page.getByRole('combobox', { name: 'Genre' }).selectOption('western');
    await page.getByRole('option', { name: /Cormac McCarthy/ }).waitFor();
    await page.getByRole('combobox', { name: 'Genre' }).selectOption('');
    await page.getByRole('searchbox', { name: 'Search styles' }).fill('Clancy');

    await page.getByRole('button', { name: 'Use for this project' }).click();
    await page.getByTestId('style-active-badge').waitFor();
    await page.getByTestId('style-in-use').getByText('this project').waitFor();
    await waitForStatus(page, 'Style: Tom Clancy');
    await app.screenshot('styles-in-use');

    const path = workspace.file('styled.lorecraft');
    await allowPath(page, path);
    await rpc(page, 'project.saveAs', { path });
    await waitUntil(async () => /All changes saved/.test(await page.getByTestId('save-state').innerText()), 5000, 'the saved state');
    await rpc(page, 'project.close');
    await page.getByRole('heading', { name: 'LoreCraft' }).waitFor();
    await page.getByRole('button', { name: /^styled/ }).first().click();
    await page.locator('.topbar').waitFor();

    await waitForStatus(page, 'Style: Tom Clancy');
    // Opening reads the style, and must not count as a change to the project.
    assert.equal((await rpc(page, 'project.status')).dirty, false, 'a clean project stays clean');
    const copied = await rpc(page, 'project.getMeta', { key: 'styleGuide.text' });
    assert.match(copied, /Write in the manner of Tom Clancy/);

    // The status bar item opens the screen.
    await statusItem(page).click();
    await page.getByTestId('styles-page').waitFor();
    await page.getByRole('searchbox', { name: 'Search styles' }).fill('Tom Clancy');
    await page.getByTestId('style-active-badge').waitFor();
  });

  it('applies style guide rules, with a book override beating the project', async () => {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page, 'Guide World');
    const books = await rpc(page, 'books.list');
    const bookId = books[0].id;

    await openStyles(page, 'Your style guide…');
    await page.getByRole('tab', { name: 'Your style guide' }).waitFor();
    await page.getByText('Nothing yet. Fill in a rule').waitFor();

    await page.getByRole('combobox', { name: 'Tense' }).selectOption('Past tense');
    await page.getByRole('combobox', { name: 'Spelling' }).selectOption('UK English');
    await page.getByRole('textbox', { name: 'Words and phrases to avoid' }).fill('suddenly, very\nsort of');
    const preview = page.getByTestId('style-instructions');
    await waitUntil(async () => /Never use these words or phrases: suddenly; very; sort of/.test(await preview.innerText().catch(() => '')), 5000, 'the rule in the preview');
    const projectText = await preview.innerText();
    assert.match(projectText, /Tense: Past tense/);
    assert.match(projectText, /Spelling: UK English/);
    assert.doesNotMatch(projectText, /Point of view/, 'empty fields add nothing');
    assert.equal(await page.getByTestId('style-sources').innerText(), 'Style guide: project');
    await waitUntil(async () => /Past tense/.test((await rpc(page, 'project.getMeta', { key: 'styleGuide.text' })) ?? ''), 3000, 'the copy for the MCP server');
    await app.screenshot('styles-guide-dark');

    await page.getByRole('combobox', { name: 'Rules for' }).selectOption(bookId);
    await page.getByRole('combobox', { name: 'Tense' }).waitFor();
    await page.getByRole('combobox', { name: 'Tense' }).selectOption('Present tense');
    await waitUntil(async () => /Tense: Present tense/.test(await preview.innerText().catch(() => '')), 5000, 'the book rule in the preview');
    const bookText = await preview.innerText();
    assert.doesNotMatch(bookText, /Past tense/);
    assert.match(bookText, /Spelling: UK English/, 'other rules still come from the project');
    assert.match(await page.getByTestId('style-sources').innerText(), /Style guide: book/);
    assert.match(await page.getByRole('combobox', { name: 'Spelling' }).locator('option').first().innerText(), /Same as the project: UK English/);

    // A style on top: the guide comes first and says it wins.
    await openTab(page, 'Browse');
    await page.getByRole('searchbox', { name: 'Search styles' }).fill('Austen');
    await page.getByRole('button', { name: 'Use for this book' }).click();
    await page.getByRole('option', { name: /Jane Austen/ }).locator('[data-testid="style-active-badge"]').waitFor();
    await openTab(page, 'Your style guide');
    await page.getByRole('combobox', { name: 'Rules for' }).selectOption(bookId);
    await waitUntil(async () => /Write in the manner of Jane Austen/.test(await preview.innerText().catch(() => '')), 5000, 'the style in the preview');
    const both = await preview.innerText();
    assert.ok(both.indexOf('Tense: Present tense') < both.indexOf('Write in the manner of Jane Austen'));
    assert.match(both, /override the writing style/);
    // The project's own copy has neither the book's rule nor its style.
    const copied = await rpc(page, 'project.getMeta', { key: 'styleGuide.text' });
    assert.doesNotMatch(copied, /Present tense|Jane Austen/);

    // It all survives saving and reopening.
    const path = workspace.file('guided.lorecraft');
    await allowPath(page, path);
    await rpc(page, 'project.saveAs', { path });
    await rpc(page, 'project.close');
    await page.getByRole('heading', { name: 'LoreCraft' }).waitFor();
    await page.getByRole('button', { name: /^guided/ }).first().click();
    await page.locator('.topbar').waitFor();
    await openStyles(page, 'Your style guide…');
    await waitUntil(async () => /Tense: Past tense/.test(await preview.innerText().catch(() => '')), 5000, 'the rules after reopening');
    assert.equal((await rpc(page, 'project.status')).dirty, false);
  });

  it('keeps a custom style after a restart, and works with no project open', async () => {
    app = await launch(workspace);
    let { page } = app;
    await createProject(page, 'Custom World');
    await openStyles(page);
    await openTab(page, 'My styles');
    await page.getByText('You have no styles of your own yet.').waitFor();
    await page.getByRole('button', { name: 'New style' }).click();
    await page.getByRole('textbox', { name: 'Name' }).fill('Telegram voice');
    await page.getByRole('textbox', { name: /^Sentences/ }).fill('Write in very short lines.');
    await page.getByRole('checkbox', { name: 'Thriller', exact: true }).check();
    await app.screenshot('styles-editor-dark');
    await page.getByRole('button', { name: 'Save style' }).click();
    await page.getByRole('button', { name: 'Edit Telegram voice' }).waitFor();

    // Using it stores a copy of its prompt in the project.
    await openTab(page, 'Browse');
    await page.getByRole('button', { name: 'Mine', exact: true }).click();
    await page.getByRole('heading', { name: 'Telegram voice' }).waitFor();
    const prompt = await page.getByTestId('style-prompt').innerText();
    assert.match(prompt, /Sentences: Write in very short lines\./);
    assert.match(prompt, /Write original prose in this manner\./);
    await page.getByRole('button', { name: 'Use for this project' }).click();
    await waitForStatus(page, 'Style: Telegram voice');
    const stored = JSON.parse(await rpc(page, 'project.getMeta', { key: 'writingStyles.choices' }));
    assert.match(stored.project.prompt, /Write in very short lines/);
    assert.equal(stored.project.name, 'Telegram voice');

    // Edit a copy of a library style.
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search styles' }).fill('Hemingway');
    await page.getByRole('heading', { name: 'Ernest Hemingway' }).waitFor();
    await page.getByRole('button', { name: 'Edit a copy' }).click();
    await page.getByRole('textbox', { name: 'Your own prompt' }).fill('Write like a very tired fisherman.');
    await page.getByRole('button', { name: 'Save style' }).click();
    await page.getByRole('button', { name: 'Edit Ernest Hemingway (my copy)' }).waitFor();

    const path = workspace.file('custom.lorecraft');
    await allowPath(page, path);
    await rpc(page, 'project.saveAs', { path });
    await rpc(page, 'project.close');
    // The next launch must show the start screen rather than reopening this project.
    await rpc(page, 'settings.update', { patch: { save: { reopenLast: false } } });
    await app.kill();

    app = await launch(workspace);
    page = app.page;
    await page.getByRole('heading', { name: 'LoreCraft' }).waitFor();

    // No project is open, and the screen is still reachable, with project actions turned off.
    await page.keyboard.press('Control+k');
    await page.getByPlaceholder('Search pages and commands…').fill('Writing styles');
    await page.getByPlaceholder('Search pages and commands…').press('Enter');
    await page.getByTestId('styles-page').waitFor();
    await app.screenshot('styles-no-project-dark');
    await page.getByRole('button', { name: 'Mine', exact: true }).click();
    await page.getByRole('heading', { name: /Telegram voice|Ernest Hemingway \(my copy\)/ }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Use for this project' }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Use for this book' }).isDisabled(), true);
    await openTab(page, 'Your style guide');
    await page.getByText('A style guide belongs to a project.').waitFor();
    await openTab(page, 'My styles');
    await page.getByRole('button', { name: 'Edit Telegram voice' }).waitFor();
    await page.getByRole('button', { name: 'Close', exact: true }).click();

    await page.getByRole('button', { name: /^custom/ }).first().click();
    await page.locator('.topbar').waitFor();
    await waitForStatus(page, 'Style: Telegram voice');
    assert.equal((await rpc(page, 'project.status')).dirty, false);

    // On a computer without the custom style, the project's copy keeps working.
    await rpc(page, 'settings.update', { patch: { writingStyles: { custom: [] } } });
    await page.reload();
    await page.locator('.topbar').waitFor();
    await waitForStatus(page, 'Style: Telegram voice');
    await openStyles(page);
    await page.getByRole('button', { name: 'Mine', exact: true }).click();
    await page.getByRole('heading', { name: 'Telegram voice' }).waitFor();
    assert.match(await page.getByTestId('style-prompt').innerText(), /Write in very short lines/);
  });

  it('blends two styles and saves the blend', async () => {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page, 'Blend World');
    await openStyles(page);
    await page.getByRole('searchbox', { name: 'Search styles' }).fill('Clancy');
    await page.getByRole('heading', { name: 'Tom Clancy' }).waitFor();
    await page.getByRole('button', { name: 'Blend', exact: true }).click();
    await page.getByText('Choose at least two styles').waitFor();

    await page.getByRole('button', { name: /^Style 2:/ }).click();
    const search = page.getByRole('combobox', { name: 'Style 2', exact: true });
    await search.fill('Hemingway');
    await search.press('Enter');

    const box = page.getByTestId('blend-prompt');
    await box.waitFor();
    const prompt = await box.innerText();
    assert.match(prompt, /^Write in this style: Mostly Tom Clancy, some Ernest Hemingway\./);
    assert.match(prompt, /Priority: Tom Clancy decides .*Ernest Hemingway decides/);
    assert.match(prompt, /If two instructions seem to conflict, Tom Clancy wins\./);
    assert.match(prompt, /never name them in the story text/);
    await app.screenshot('styles-blend-dark');

    await page.getByRole('combobox', { name: 'How much of style 2' }).selectOption('touch');
    await waitUntil(async () => /a touch of Ernest Hemingway/.test(await box.innerText()), 3000, 'the blend to follow the weight');
    await page.getByRole('combobox', { name: 'How much of style 2' }).selectOption('some');

    await page.getByRole('button', { name: 'Save as a custom style' }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('heading', { name: 'Mostly Tom Clancy, some Ernest Hemingway' }).waitFor();
    assert.match(await page.getByTestId('style-prompt').innerText(), /Priority: Tom Clancy decides/);
    const settings = await rpc(page, 'settings.get');
    assert.equal(settings.writingStyles.custom.length, 1);
  });
});

describe('writing styles with the AI', () => {
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

  async function start() {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page, 'AI Style World');
    const profile = { id: 'local', name: 'Local model', kind: 'openai-compatible', baseUrl: `${mock.url}/v1`, model: 'mock-local', isCloud: false };
    const routing = { chat: 'local', rewrite: 'local', extract: 'local', consistency: 'local' };
    await rpc(page, 'settings.update', { patch: { ai: { profiles: [profile], routing } } });
    await page.reload();
    await page.locator('.topbar').waitFor();
    const books = await rpc(page, 'books.list');
    const tree = await rpc(page, 'nodes.tree', { bookId: books[0].id });
    const scene = tree.find((n) => n.kind === 'scene');
    return { page, scene };
  }

  async function send(page, text) {
    const input = page.getByRole('textbox', { name: 'Message the AI' });
    await input.fill(text);
    await input.press('Enter');
  }

  async function useStyle(page, name) {
    await page.getByRole('menuitem', { name: 'AI', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Use a style…' }).click();
    const search = page.getByRole('combobox', { name: 'Search styles' });
    await search.fill(name);
    await page.getByRole('option', { name: new RegExp(name) }).first().waitFor();
    await search.press('Enter');
  }

  it('can take a chosen style away again', async () => {
    const { page } = await start();
    await useStyle(page, 'Ernest Hemingway');
    await waitForStatus(page, 'Style: Ernest Hemingway');
    await page.getByRole('menuitem', { name: 'AI', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Use a style…' }).click();
    await page.getByRole('option', { name: 'No style here' }).click();
    await waitForStatus(page, 'Style: none');
  });

  it('sends the style with chat messages, and a chat can choose its own', async () => {
    const { page } = await start();
    await useStyle(page, 'Ernest Hemingway');
    await waitForStatus(page, 'Style: Ernest Hemingway');

    await page.getByRole('button', { name: 'AI', exact: true }).click();
    await page.getByTestId('ai-pane').waitFor();
    await send(page, '[mock:say=First reply.] Hello');
    await page.getByTestId('ai-assistant').last().getByText('First reply.').waitFor({ timeout: 30_000 });
    let requests = await chatRequests();
    assert.match(requests.at(-1), /<writing_style>/);
    assert.match(requests.at(-1), /Write in the manner of Ernest Hemingway/);

    // A second turn does not send it again, since the model already has it.
    await send(page, '[mock:say=Second reply.] Again');
    await page.getByTestId('ai-assistant').last().getByText('Second reply.').waitFor({ timeout: 30_000 });
    requests = await chatRequests();
    assert.equal(requests.at(-1).split('Write in the manner of Ernest Hemingway').length - 1, 1, 'sent once in the conversation');

    await page.getByRole('button', { name: /^Writing style for this chat:/ }).click();
    const search = page.getByRole('combobox', { name: 'Writing style for this chat' });
    await search.fill('Austen');
    await search.press('Enter');
    await app.screenshot('styles-ai-pane-dark');
    await send(page, '[mock:say=Third reply.] Once more');
    await page.getByTestId('ai-assistant').last().getByText('Third reply.').waitFor({ timeout: 30_000 });
    requests = await chatRequests();
    assert.match(requests.at(-1), /Write in the manner of Jane Austen/);
  });

  it('sets a style for a scene, and rewrites a selection in a style as tracked changes', async () => {
    const { page, scene } = await start();
    await rpc(page, 'nodes.update', { id: scene.id, patch: { content: makeDoc(textBlock('The dragon sleeps [mock:say=The wyvern sleeps now.] now.')) } });
    await page.reload();
    await page.locator('.topbar').waitFor();
    await page.getByRole('button', { name: 'Write', exact: true }).click();
    await page.locator('.prose-manuscript').waitFor();

    if ((await page.locator('.scene-details').count()) === 0) await page.getByRole('button', { name: 'Details', exact: true }).click();
    await page.getByRole('button', { name: /^Writing style for this scene:/ }).click();
    const search = page.getByRole('combobox', { name: 'Writing style for this scene' });
    await search.fill('Dan Brown');
    await search.press('Enter');
    await page.getByRole('button', { name: 'Writing style for this scene: Dan Brown' }).waitFor();
    await waitUntil(async () => {
      const choices = JSON.parse((await rpc(page, 'project.getMeta', { key: 'writingStyles.choices' })) ?? '{}');
      return choices.scenes?.[scene.id]?.styleId === 'dan-brown';
    }, 3000, 'the scene choice to be stored');
    await app.screenshot('styles-scene-details-dark');

    await page.locator('.prose-manuscript').click();
    await page.keyboard.press('Control+a');
    await page.getByRole('button', { name: 'Rewrite in a style…' }).click();
    const picker = page.getByRole('combobox', { name: 'Rewrite in which style?' });
    await picker.fill('Clancy');
    await picker.press('Enter');
    await page.getByRole('region', { name: 'Suggested changes' }).waitFor({ timeout: 30_000 });
    await waitUntil(async () => (await page.locator('.ai-ins, .ai-del').count()) > 0, 5000, 'tracked changes to show');
    const stored = await rpc(page, 'nodes.get', { id: scene.id });
    assert.match(JSON.stringify(stored.content), /The dragon sleeps/, 'the document itself has not changed');
    const requests = await chatRequests();
    assert.match(requests.at(-1), /Write in the manner of Tom Clancy/);
    assert.doesNotMatch(requests.at(-1), /Write in the manner of Dan Brown/, 'the rewrite style beats the scene style');
  });

  it('drafts a style from chosen scenes, for review before saving', async () => {
    const { page, scene } = await start();
    const draft = JSON.stringify({
      summary: 'This writer keeps it short. Scenes start late and leave early.',
      narration: 'Stay close to one person.',
      sentences: 'Keep sentences short.',
      diction: 'Use plain words.',
      dialogue: 'Let people interrupt.',
      description: 'Describe only what is used.',
      pacing: 'Start each scene late.',
      signature: 'End on an object.',
      avoid: 'Avoid adverbs.',
    });
    await rpc(page, 'nodes.update', { id: scene.id, patch: { content: makeDoc(textBlock(`Rain on the glass. [mock:say=${draft}] She left.`)) } });
    await openStyles(page);
    await openTab(page, 'Build from my writing');
    await app.screenshot('styles-build-dark');
    await page.getByRole('checkbox', { name: new RegExp(scene.title) }).check();
    await page.getByRole('button', { name: 'Draft a style from these scenes' }).click();

    // Nothing is saved until the writer has looked at it.
    await page.getByRole('heading', { name: 'New style' }).waitFor({ timeout: 30_000 });
    assert.equal(await page.getByRole('textbox', { name: /^Sentences/ }).inputValue(), 'Keep sentences short.');
    assert.equal((await rpc(page, 'settings.get')).writingStyles?.custom?.length ?? 0, 0);
    const requests = await chatRequests();
    assert.match(requests.at(-1), /Rain on the glass/);

    await page.getByRole('textbox', { name: 'Name' }).fill('My plain voice');
    await page.getByRole('button', { name: 'Save style' }).click();
    await page.getByRole('button', { name: 'Edit My plain voice' }).waitFor();
    assert.equal((await rpc(page, 'settings.get')).writingStyles.custom[0].name, 'My plain voice');
  });
});
