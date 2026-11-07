/**
 * The brainstorm board and prompt files, against the mock AI server set up as a local
 * profile. Cards are suggestions: keeping one puts it in the Inbox, and a page is made only
 * through the new-page dialog. Prompt files export, and import after a preview that skips
 * exact copies and renames clashes.
 *
 * The last test uses the local server at 127.0.0.1:8080, and skips if it is not running.
 */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { startMockServer } from '../scripts/mock-ai-server.mjs';
import { answerNextDialog, createProject, createWorkspace, launch, rpc, waitUntil } from './harness.mjs';

const LOCAL = 'http://127.0.0.1:8080/v1';

/** A messy reply, as small models write: prose, a code fence, a trailing comma and a bare string. */
const IDEAS = 'Here are some ideas: ```json {"ideas": [{"title": "Saltmere", "detail": "A drowned town."}, {"title": "Gullhaven", "detail": "A port of grey gulls."}, "Ashford — a mill town on the river",]} ```';

describe('Brainstorm board and prompt files', () => {
  let workspace;
  let app;
  let mock;
  let problems;

  const sent = async () => {
    const list = await (await fetch(`${mock.url}/__mock/requests`)).json();
    return list.filter((r) => r.path === '/v1/chat/completions');
  };
  const lastUserText = (request) =>
    request.body.messages
      .filter((m) => m.role === 'user')
      .map((m) => (typeof m.content === 'string' ? m.content : m.content.map((b) => b.text ?? '').join('\n')))
      .join('\n');

  async function start(profile) {
    app = await launch(workspace);
    const { page } = app;
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await createProject(page, 'Idea World');
    const routing = { chat: profile.id, rewrite: profile.id, extract: profile.id, consistency: profile.id };
    await rpc(page, 'settings.update', { patch: { ai: { profiles: [profile], routing, cloudWarningDismissed: true } } });
    await page.reload();
    await page.locator('.topbar').waitFor();
    return page;
  }

  /** Ctrl+K, then the command by its name, chosen with the arrow keys and Enter. */
  const palette = async (page, text) => {
    await page.keyboard.press('Control+k');
    await page.locator('.palette-input').fill(text);
    const options = page.getByRole('option');
    await options.filter({ hasText: text }).first().waitFor();
    const labels = await options.allTextContents();
    const at = labels.findIndex((label) => label.startsWith(text));
    assert.ok(at >= 0, `"${text}" is in the palette: ${labels.join(', ')}`);
    for (let i = 0; i < at; i += 1) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
  };

  before(async () => {
    mock = await startMockServer();
  });

  after(async () => {
    await mock.close();
  });

  beforeEach(async () => {
    workspace = createWorkspace();
    problems = [];
    await fetch(`${mock.url}/__mock/reset`, { method: 'POST' });
  });

  afterEach(async () => {
    if (app && !app.exited) await app.kill().catch(() => {});
    workspace.cleanup();
  });

  it('brainstorms ideas onto cards, keeps one in the Inbox, makes a page from another, and works by keyboard', async () => {
    const page = await start({ id: 'local', name: 'Local model', kind: 'openai-compatible', baseUrl: `${mock.url}/v1`, model: 'mock-local', isCloud: false });
    const home = await rpc(page, 'pages.home');
    await rpc(page, 'pages.update', {
      id: home.id,
      patch: { content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The coast of the Vale is cold and wet.' }] }] } },
    });
    await page.reload();
    await page.locator('.prose').first().waitFor();

    // From Ctrl+K, with the open page as the focus.
    await palette(page, 'Brainstorm…');
    const view = page.getByTestId('brainstorm-view');
    await view.waitFor();
    await view.getByLabel('Ideas for').selectOption({ label: 'Place names' });
    const current = view.getByRole('radio', { name: /What was open:/ });
    assert.equal(await current.isEnabled(), true, 'the page that was open can be the focus');
    await current.check();
    const note = view.getByRole('textbox', { name: 'Note (optional)' });
    await note.fill(`[mock:say=${IDEAS}[/mock]`);
    await note.press('Enter');

    const cards = view.getByTestId('brainstorm-card');
    await waitUntil(async () => (await cards.count()) === 3, 10_000, 'the board');
    assert.deepEqual(await cards.locator('.brainstorm-card-title').allTextContents(), ['Saltmere', 'Gullhaven', 'Ashford']);
    await view.getByRole('status').filter({ hasText: '3 new ideas.' }).waitFor();
    const first = (await sent()).pop();
    assert.match(JSON.stringify(first.body.messages[0]), /brainstorm/i, 'the brainstorm instructions go first');
    assert.match(lastUserText(first), /names for places/);
    assert.match(lastUserText(first), /coast of the Vale is cold/, 'the open page goes with it');

    // Keyboard: K keeps the card in focus, and focus moves on to the next one.
    await cards.first().focus();
    await page.keyboard.press('k');
    await waitUntil(async () => (await cards.count()) === 2, 10_000, 'the board');
    const inbox = await rpc(page, 'ideas.list', { status: 'open' });
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].text, 'Saltmere\nA drowned town.\nBrainstorm: Place names');
    assert.equal(inbox[0].sourceId, home.id, 'the idea remembers what it was about');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.includes('Gullhaven')), true, 'focus moves to the next card');

    // M asks for more like the card in focus. The mock repeats itself, so nothing new comes.
    await page.keyboard.press('m');
    await waitUntil(async () => (await sent()).length === 2, 10_000, 'the request');
    const like = (await sent()).pop();
    assert.match(lastUserText(like), /same vein as this one, but not the same: Gullhaven: A port of grey gulls\./);
    assert.match(lastUserText(like), /do not repeat: Saltmere; Gullhaven; Ashford/, "kept ideas count as seen");
    await view.getByRole('alert').filter({ hasText: 'only repeated ideas' }).waitFor();
    assert.equal(await cards.count(), 2, 'the board stays as it was');

    // Delete discards. Nothing is saved for it.
    await page.keyboard.press('Delete');
    await waitUntil(async () => (await cards.count()) === 1, 10_000, 'the board');
    assert.equal((await rpc(page, 'ideas.list', { status: 'open' })).length, 1);

    // A new page goes through the usual dialog, with the type set for a place.
    await view.getByRole('button', { name: 'New page from “Ashford”' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('textbox').first().inputValue(), 'Ashford');
    assert.equal(await dialog.getByLabel('Type').inputValue(), 'place');
    assert.equal((await rpc(page, 'pages.list', {})).some((p) => p.title === 'Ashford'), false, 'nothing is made before the writer confirms');
    await dialog.getByRole('button', { name: 'Create page' }).click();
    await waitUntil(async () => (await cards.count()) === 0, 10_000, 'the board');
    const made = await rpc(page, 'pages.getByTitle', { title: 'Ashford' });
    assert.equal(made.pageType, 'place');
    assert.equal(made.status, 'idea');
    assert.match(JSON.stringify(made.content), /a mill town on the river/);

    // The board survives going elsewhere and coming back from the AI menu.
    await note.fill(`[mock:say=${IDEAS}[/mock]`);
    await view.getByRole('button', { name: 'Brainstorm', exact: true }).click();
    await waitUntil(async () => (await cards.count()) === 3, 10_000, 'the board');
    await palette(page, 'Inbox');
    await page.getByRole('heading', { name: 'Inbox' }).waitFor();
    await page.getByRole('menubar').getByRole('menuitem', { name: 'AI', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Brainstorm…' }).click();
    await view.waitFor();
    assert.equal(await cards.count(), 3, 'the board is as it was left');

    // More asks for the same kind again, and Clear empties the board.
    await view.getByRole('button', { name: 'More', exact: true }).click();
    await waitUntil(async () => (await sent()).length === 4, 10_000, 'the request');
    assert.match(lastUserText((await sent()).pop()), /names for places[\s\S]*do not repeat: Saltmere; Gullhaven; Ashford/);
    await view.getByRole('button', { name: 'Brainstorm', exact: true }).and(page.locator(':enabled')).waitFor();
    await view.getByRole('button', { name: 'Clear' }).click();
    assert.equal(await cards.count(), 0);
    assert.deepEqual(problems, []);
  });

  it('exports prompts to a file and imports them after a preview', async () => {
    const page = await start({ id: 'local', name: 'Local model', kind: 'openai-compatible', baseUrl: `${mock.url}/v1`, model: 'mock-local', isCloud: false });
    await rpc(page, 'ai.savePrompt', { name: 'Darker', description: 'More shadow', template: 'Make this darker:\n\n{{selection}}', scope: 'selection', action: 'replace' });
    await rpc(page, 'ai.savePrompt', { name: 'Ask the map', template: 'Where is it?', scope: 'chat', action: 'chat' });
    await page.getByRole('button', { name: 'AI', exact: true }).click();
    await page.getByTestId('ai-pane').waitFor();
    await page.getByRole('tab', { name: 'Prompts' }).click();
    const library = page.getByTestId('ai-prompts');
    await library.locator('.ai-prompt-item').filter({ hasText: 'Darker' }).waitFor();

    // All custom prompts, and no built-ins.
    const allPath = workspace.file('mine.json');
    await answerNextDialog(page, allPath);
    await library.getByRole('button', { name: 'Export all custom…' }).click();
    await waitUntil(async () => {
      try {
        return JSON.parse(readFileSync(allPath, 'utf8')).prompts.length === 2;
      } catch {
        return false;
      }
    }, 10_000, 'the file');
    const all = JSON.parse(readFileSync(allPath, 'utf8'));
    assert.equal(all.lorecraft_prompts, 1);
    assert.deepEqual(all.prompts.map((p) => p.name).sort(), ['Ask the map', 'Darker']);
    assert.deepEqual(all.prompts.find((p) => p.name === 'Darker'), {
      name: 'Darker', description: 'More shadow', template: 'Make this darker:\n\n{{selection}}', scope: 'selection', action: 'replace',
    });

    // One prompt.
    const onePath = workspace.file('one.json');
    await answerNextDialog(page, onePath);
    await library.getByRole('button', { name: 'Export “Darker”' }).click();
    await waitUntil(async () => {
      try {
        return JSON.parse(readFileSync(onePath, 'utf8')).prompts.length === 1;
      } catch {
        return false;
      }
    }, 10_000, 'the file');

    // Import: an exact copy is skipped, a clash is renamed, and a bad scope is left out.
    const importPath = workspace.file('shared.json');
    writeFileSync(importPath, JSON.stringify({
      lorecraft_prompts: 1,
      prompts: [
        all.prompts.find((p) => p.name === 'Darker'),
        { name: 'Darker', description: '', template: 'Even darker.', scope: 'selection', action: 'replace' },
        { name: 'Name a tavern', template: 'Name a tavern for: ', scope: 'chat' },
        { name: 'Broken', template: 'x', scope: 'everywhere' },
      ],
    }));
    await answerNextDialog(page, importPath);
    await library.getByRole('button', { name: 'Import…' }).click();
    const preview = page.getByTestId('ai-prompt-import');
    await preview.waitFor();
    await preview.getByText('Already in this project. Skipped.').waitFor();
    await preview.getByText('A different prompt has this name, so it is added as “Darker (2)”.').waitFor();
    await preview.getByText('Prompt 4 (“Broken”) has an unknown "scope", so it is left out.').waitFor();
    assert.equal((await rpc(page, 'ai.listPrompts', {})).some((p) => p.name === 'Name a tavern'), false, 'nothing is saved before the writer says so');
    await preview.getByRole('button', { name: 'Import 2 prompts' }).click();
    await library.locator('.ai-prompt-item').filter({ hasText: 'Darker (2)' }).waitFor();
    const names = (await rpc(page, 'ai.listPrompts', {})).filter((p) => !p.builtin).map((p) => p.name).sort();
    assert.deepEqual(names, ['Ask the map', 'Darker', 'Darker (2)', 'Name a tavern']);
    const tavern = (await rpc(page, 'ai.listPrompts', {})).find((p) => p.name === 'Name a tavern');
    assert.equal(tavern.action, 'chat', 'a chat prompt without an action answers in the pane');

    // Something that is not a prompt file says so, and adds nothing.
    const wrongPath = workspace.file('wrong.json');
    writeFileSync(wrongPath, JSON.stringify({ format: 'lorebook', version: 1, pages: [] }));
    await answerNextDialog(page, wrongPath);
    await library.getByRole('button', { name: 'Import…' }).click();
    await page.getByText('This is not a LoreCraft prompt file.').waitFor();
    assert.deepEqual(problems, []);
  });

  it('brainstorms with a real local model', async (t) => {
    let model = 'local-model';
    try {
      const listing = await (await fetch(`${LOCAL}/models`, { signal: AbortSignal.timeout(2000) })).json();
      model = process.env.LORECRAFT_E2E_MODEL ?? listing?.data?.[0]?.id ?? model;
    } catch {
      t.skip('no local AI server at 127.0.0.1:8080');
      return;
    }
    const page = await start({ id: 'local', name: 'Local model', kind: 'openai-compatible', baseUrl: LOCAL, model, isCloud: false });
    await rpc(page, 'pages.create', { title: 'Saltmere', status: 'canon', pageType: 'place' });
    await palette(page, 'Brainstorm…');
    const view = page.getByTestId('brainstorm-view');
    await view.waitFor();
    await view.getByLabel('Ideas for').selectOption({ label: 'Character names' });
    await view.getByRole('textbox', { name: 'Note (optional)' }).fill('fishermen from Saltmere');
    await view.getByRole('button', { name: 'Brainstorm', exact: true }).click();
    const cards = view.getByTestId('brainstorm-card');
    await waitUntil(async () => (await cards.count()) > 0 || (await view.getByRole('alert').count()) > 0, 240_000, 'ideas from the local model');
    assert.ok((await cards.count()) > 0, `no ideas: ${await view.getByRole('alert').textContent().catch(() => '')}`);
  });
});
