/**
 * Plan a story, driven through the real app: every step by hand with no AI, saved progress,
 * Create and Undo, Apply structure, and one run with the real local model.
 *
 * The "real model" test uses the local server at 127.0.0.1:8080 and skips if it is not
 * running. Its answers vary, so it checks only what is true whatever it writes.
 */

import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it } from 'node:test';

import { createProject, createWorkspace, launch, rpc, waitUntil } from './harness.mjs';

const LOCAL = 'http://127.0.0.1:8080/v1';
const ANSWER_TIME = 300_000;

async function isLocalServerUp() {
  try {
    const response = await fetch(`${LOCAL}/models`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Nothing answers here, so every AI request fails the way a missing server does. */
async function aiOff(page) {
  const profile = { id: 'nowhere', name: 'Nowhere', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', model: '', isCloud: false };
  await rpc(page, 'settings.update', {
    patch: { ai: { profiles: [profile], routing: { chat: 'nowhere', rewrite: 'nowhere', extract: 'nowhere', consistency: 'nowhere' } } },
  });
  await page.reload();
  await page.locator('.topbar').waitFor();
}

async function openWizard(page) {
  await page.keyboard.press('Control+k');
  await page.locator('.palette-input').fill('Plan a story');
  await page.keyboard.press('Enter');
  await page.getByTestId('plan-view').waitFor();
}

const stepHeading = (page) => page.locator('#plan-step-title');
const next = (page) => page.getByTestId('plan-view').getByRole('button', { name: 'Next', exact: true }).click();

async function treeOf(page, bookId) {
  const tree = await rpc(page, 'nodes.tree', { bookId });
  return tree.sort((a, b) => a.position - b.position);
}

describe('plan a story', () => {
  let workspace;
  let app;
  let up = false;

  before(async () => {
    up = await isLocalServerUp();
    if (!up) console.log(`SKIPPING the real-model test: nothing is answering at ${LOCAL}`);
  });

  beforeEach(() => {
    workspace = createWorkspace();
  });

  afterEach(async () => {
    if (app && !app.exited) await app.kill().catch(() => {});
    workspace.cleanup();
  });

  it('works by hand with no AI, saves progress, creates on Review, and can be undone', async () => {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page, 'Plan World');
    await aiOff(page);
    const gate = await rpc(page, 'pages.create', { title: 'Silver Gate', pageType: 'place', status: 'canon', summary: 'The northern pass.' });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));

    await openWizard(page);
    assert.match(await stepHeading(page).innerText(), /Step 1 of 7: Braindump/);
    await page.getByRole('textbox', { name: 'Braindump' }).fill('A ranger guards a gate. A smuggler wants through.');
    await next(page);

    // The AI is asked on its own, cannot be reached, and the step still works by hand.
    assert.match(await stepHeading(page).innerText(), /Synopsis/);
    await page.getByRole('alert').filter({ hasText: 'The AI could not help' }).waitFor({ timeout: 30_000 });
    await page.getByRole('textbox', { name: 'Synopsis' }).fill('Aria guards the Silver Gate. Bren wants through it.');

    // From here on, no AI at all.
    await page.getByRole('checkbox', { name: 'Use AI suggestions' }).uncheck();
    assert.equal(await page.getByRole('button', { name: 'Ask again' }).count(), 0);
    await next(page);

    assert.match(await stepHeading(page).innerText(), /Characters/);
    await page.getByRole('button', { name: 'Add a character' }).click();
    await page.getByRole('textbox', { name: 'Name of Item 1' }).fill('Aria Vale');
    await page.getByRole('textbox', { name: 'Role of Aria Vale' }).fill('A ranger');
    await page.getByRole('textbox', { name: 'Description of Aria Vale' }).fill('Blunt and dry.');
    await page.getByRole('button', { name: 'Add a character' }).click();
    await page.getByRole('textbox', { name: 'Name of Item 2' }).fill('Bren Holt');
    await page.getByRole('button', { name: 'Add a character' }).click();
    await page.getByRole('button', { name: 'Remove Item 3' }).click();
    await next(page);

    assert.match(await stepHeading(page).innerText(), /World/);
    await page.getByRole('button', { name: 'Add a place, group or thing' }).click();
    await page.getByRole('textbox', { name: 'Name of Item 1' }).fill('Silver Gate');
    await page.getByRole('textbox', { name: 'Name of Silver Gate' }).blur();
    await page.getByText('In the wiki', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Add a place, group or thing' }).click();
    await page.getByRole('textbox', { name: 'Name of Item 2' }).fill('The Watch');
    await page.getByRole('combobox', { name: 'Type of The Watch' }).selectOption('faction');

    // Leave and come back: everything is where it was.
    await page.waitForTimeout(800);
    await page.reload();
    await page.locator('.topbar').waitFor();
    await openWizard(page);
    assert.match(await stepHeading(page).innerText(), /World/);
    assert.equal(await page.getByRole('textbox', { name: 'Name of The Watch' }).inputValue(), 'The Watch');
    await page.getByRole('button', { name: /^2\. Synopsis$/ }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Synopsis' }).inputValue(), 'Aria guards the Silver Gate. Bren wants through it.');
    await page.getByRole('button', { name: /^4\. World$/ }).click();
    await page.getByRole('button', { name: 'Skip' }).click();

    assert.match(await stepHeading(page).innerText(), /Structure/);
    await page.getByRole('radio', { name: /Story circle/ }).check();
    await next(page);

    assert.match(await stepHeading(page).innerText(), /Outline/);
    await page.getByRole('button', { name: 'Start from the beats of Story circle' }).click();
    assert.equal(await page.locator('[data-plan-chapter]').count(), 8);
    // Keep two chapters: delete the rest from the end.
    for (let i = 8; i > 2; i -= 1) {
      await page.getByRole('button', { name: `Delete ${(await page.getByRole('textbox', { name: `Title of chapter ${i}` }).inputValue())}`, exact: true }).click();
    }
    assert.equal(await page.locator('[data-plan-chapter]').count(), 2);
    await page.getByRole('button', { name: 'Move Want up' }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Title of chapter 1' }).inputValue(), 'Want');
    await page.getByRole('textbox', { name: 'Title of Want, scene 1' }).fill('At the gate');
    await page.getByRole('textbox', { name: 'Synopsis of Want, scene 1' }).fill('Bren asks Aria to open the gate. She refuses.');
    await page.getByRole('combobox', { name: 'Point of view of Want, scene 1' }).selectOption('Aria Vale');
    await page.getByRole('textbox', { name: 'Cast of Want, scene 1' }).fill('Aria Vale, Bren Holt');
    await page.getByRole('textbox', { name: 'Cast of Want, scene 1' }).blur();
    await page.getByRole('button', { name: 'Add a scene to Want' }).click();
    await page.getByRole('textbox', { name: 'Title of Want, scene 2' }).fill('Night');
    await page.getByRole('textbox', { name: 'Synopsis of Want, scene 2' }).fill('Bren tries the gate alone.');
    await next(page);

    assert.match(await stepHeading(page).innerText(), /Review/);
    const pagesBefore = (await rpc(page, 'pages.list', {})).length;
    const booksBefore = (await rpc(page, 'books.list')).length;
    const firstBook = (await rpc(page, 'books.list'))[0].id;
    const nodesBefore = (await treeOf(page, firstBook)).length;
    const review = await page.locator('.plan-review').innerText();
    assert.match(review, /New pages, as drafts \(3\)/);
    assert.match(review, /Existing pages, linked as they are \(1\)/);
    assert.match(review, /2 chapters and 3 scenes/);
    await page.getByRole('textbox', { name: 'Title of the new book' }).fill('The Gate');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.getByRole('status', { name: 'Made from the plan' }).waitFor();
    assert.match(await page.locator('.plan-done').innerText(), /Made 3 draft pages, 2 chapters and 3 scenes in “The Gate”\. Linked 1 existing pages\./);
    await app.screenshot('plan-done');

    const pages = await rpc(page, 'pages.list', {});
    assert.equal(pages.length, pagesBefore + 3);
    assert.equal((await treeOf(page, firstBook)).length, nodesBefore, 'the other book is not touched');
    const aria = pages.find((p) => p.title === 'Aria Vale');
    const bren = pages.find((p) => p.title === 'Bren Holt');
    const watch = pages.find((p) => p.title === 'The Watch');
    assert.equal(aria.status, 'draft');
    assert.equal(aria.pageType, 'character');
    assert.equal(aria.summary, 'A ranger');
    assert.equal(watch.pageType, 'faction');
    assert.equal(pages.filter((p) => p.title === 'Silver Gate').length, 1, 'the existing page is not made again');
    const book = (await rpc(page, 'books.list')).find((b) => b.title === 'The Gate');
    assert.ok(book, 'a new book');
    const tree = await treeOf(page, book.id);
    const chapters = tree.filter((n) => n.kind === 'chapter');
    assert.deepEqual(chapters.map((c) => c.title), ['Want', 'Comfort']);
    const scenes = tree.filter((n) => n.parentId === chapters[0].id).sort((a, b) => a.position - b.position);
    assert.deepEqual(scenes.map((s) => s.title), ['At the gate', 'Night']);
    assert.equal(scenes[0].synopsis, 'Bren asks Aria to open the gate. She refuses.');
    assert.equal(scenes[0].povPageId, aria.id);
    assert.deepEqual((await rpc(page, 'nodes.cast', { id: scenes[0].id })).sort(), [aria.id, bren.id].sort());
    assert.equal(gate.status, 'canon');

    // Undo puts it all in the trash.
    await page.getByRole('button', { name: 'Undo: move it all to the trash' }).click();
    await page.getByText('Everything the plan made is in the trash.').waitFor();
    assert.equal((await rpc(page, 'books.list')).length, booksBefore);
    assert.equal((await rpc(page, 'pages.list', {})).length, pagesBefore);

    // Start over clears the plan.
    await page.getByRole('button', { name: 'Start over' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Start over' }).click();
    assert.match(await stepHeading(page).innerText(), /Braindump/);
    assert.equal(await page.getByRole('textbox', { name: 'Braindump' }).inputValue(), '');
  });

  it('applies a structure to an existing book, after review, without touching what is there', async () => {
    app = await launch(workspace);
    const { page } = app;
    await createProject(page, 'Structure World');
    const [{ id: bookId }] = await rpc(page, 'books.list');
    const kept = await rpc(page, 'nodes.create', { bookId, kind: 'chapter', title: 'Midpoint', parentId: null });
    const before = await treeOf(page, bookId);
    await page.keyboard.press('Control+Shift+w');
    await page.keyboard.press('Control+Alt+4');
    await page.locator('.outline').waitFor();
    await page.getByRole('button', { name: 'Apply structure…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Apply a story structure' });
    await dialog.waitFor();
    // Three acts is first. Its Midpoint is already a chapter, so it starts unticked.
    assert.equal(await dialog.getByRole('checkbox', { name: /^Midpoint/ }).isChecked(), false);
    await dialog.getByRole('checkbox', { name: /^Climax/ }).uncheck();
    await dialog.getByRole('button', { name: 'Add 7 chapters' }).click();
    await waitUntil(async () => (await treeOf(page, bookId)).length === before.length + 7, 10_000, 'the chapters');
    const tree = await treeOf(page, bookId);
    const top = tree.filter((n) => n.parentId === null);
    const added = top.slice(-7);
    assert.deepEqual(added.map((n) => n.title), ['Setup', 'Inciting incident', 'First turning point', 'Rising complications', 'Things fall apart', 'Lowest point', 'Resolution']);
    assert.match(added[0].synopsis, /ordinary life/);
    for (const node of before) assert.equal(tree.find((n) => n.id === node.id)?.title, node.title, 'what was there stays');
    assert.equal(tree.find((n) => n.id === kept.id).title, 'Midpoint');
  });

  it('runs through every step with the real local model', async (t) => {
    if (!up) return t.skip('no local server');
    app = await launch(workspace);
    const { page } = app;
    await createProject(page, 'Model World');
    await rpc(page, 'pages.create', { title: 'Aria Vale', pageType: 'character', status: 'canon', summary: 'A ranger who guards the Silver Gate.' });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await openWizard(page);
    await page.getByRole('textbox', { name: 'Braindump' }).fill(
      'Aria Vale, a ranger, guards the Silver Gate in the north. A charming smuggler named Bren wants to get a crate through. The crate holds something that wakes up. Short and tense, three chapters.',
    );

    const waitForAi = async () => {
      const busy = page.getByRole('status').filter({ hasText: 'Asking the AI' });
      await busy.waitFor({ timeout: 5000 }).catch(() => {});
      await busy.waitFor({ state: 'detached', timeout: ANSWER_TIME });
      const problem = page.getByRole('alert').filter({ hasText: 'The AI could not help' });
      if (await problem.count()) console.log(`The model's problem: ${await problem.innerText()}`);
    };

    await next(page);
    await waitForAi();
    const synopsis = await page.getByRole('textbox', { name: 'Synopsis' }).inputValue();
    console.log(`Synopsis: ${synopsis.slice(0, 300)}`);
    assert.ok(synopsis.length > 40, 'a synopsis was drafted');

    await next(page);
    await waitForAi();
    const characters = await page.locator('[data-plan-entity]').count();
    console.log(`Characters suggested: ${characters}`);
    assert.ok(characters >= 1, 'characters were suggested');
    // Aria is already in the wiki, so she is linked rather than made again.
    const ariaCard = page.locator('[data-plan-entity="Aria Vale"]');
    if (await ariaCard.count()) assert.equal(await ariaCard.getByText('In the wiki').count(), 1);

    await next(page);
    await waitForAi();
    console.log(`World items suggested: ${await page.locator('[data-plan-entity]').count()}`);

    await next(page);
    await page.getByRole('radio', { name: /Three acts/ }).check();
    await next(page);
    await waitForAi();
    const chapterCount = await page.locator('[data-plan-chapter]').count();
    console.log(`Chapters proposed: ${chapterCount}`);
    assert.ok(chapterCount >= 1, 'chapters were proposed');

    await next(page);
    await page.getByRole('textbox', { name: 'Title of the new book' }).fill('The Crate');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.getByRole('status', { name: 'Made from the plan' }).waitFor({ timeout: 60_000 });
    await app.screenshot('plan-real-model');

    const book = (await rpc(page, 'books.list')).find((b) => b.title === 'The Crate');
    const tree = await rpc(page, 'nodes.tree', { bookId: book.id });
    assert.equal(tree.filter((n) => n.kind === 'chapter').length, chapterCount);
    const scenes = tree.filter((n) => n.kind === 'scene');
    assert.ok(scenes.length >= 1);
    assert.ok(scenes.some((s) => s.synopsis.trim()), 'scenes have synopses to draft from');
    const pages = await rpc(page, 'pages.list', {});
    assert.equal(pages.filter((p) => p.title === 'Aria Vale').length, 1, 'no duplicate of the existing page');
    assert.ok(pages.filter((p) => p.title !== 'Aria Vale').every((p) => p.status === 'draft' || p.isHome), 'new pages are drafts');
  });
});
