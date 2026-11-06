import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { readFileSync } from 'node:fs';

import { answerNextDialog, createProject, createWorkspace, launch, rpc, waitUntil } from './harness.mjs';

const searchBox = (page) => page.getByRole('combobox', { name: 'Search this project' });
const pageByTitle = (page, title) => rpc(page, 'pages.getByTitle', { title });

async function openPage(page, title) {
  await searchBox(page).fill(title);
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
}

function doc(text) {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

describe('wiki types, lists and first appearance', () => {
  let workspace;
  let app;
  let page;

  async function start(name = 'Lists') {
    app = await launch(workspace);
    page = app.page;
    await page.setViewportSize({ width: 1400, height: 900 });
    await createProject(page, name);
    await page.locator('.wiki-title').waitFor();
  }

  beforeEach(() => {
    workspace = createWorkspace();
  });

  afterEach(async () => {
    if (app && !app.exited) await app.kill().catch(() => {});
    workspace.cleanup();
  });

  it('creates, uses, copies and deletes a custom page type', async () => {
    await start();
    await page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name: 'Page types' }).click();
    const dialog = page.getByRole('dialog', { name: 'Page types' });
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'New type' }).click();

    const editor = page.getByRole('dialog', { name: 'New page type' });
    await editor.getByLabel('Name', { exact: true }).fill('Deity');
    await editor.getByLabel('Description').fill('A god or spirit.');
    await editor.getByRole('combobox', { name: 'Add a field' }).selectOption({ label: 'A field of your own' });
    await editor.getByRole('textbox', { name: 'Label of field 1' }).fill('Domain');
    assert.equal(await editor.getByRole('textbox', { name: 'Key of field 1' }).inputValue(), 'domain');
    await editor.getByRole('combobox', { name: 'Add a field' }).selectOption({ label: 'Leader' });
    assert.equal(await editor.getByRole('combobox', { name: 'Kind of field 2' }).inputValue(), 'page');
    await editor.getByRole('button', { name: 'Move field 2 up' }).click();
    await editor.getByRole('button', { name: 'Add a section' }).click();
    await editor.getByRole('textbox', { name: 'Section 1' }).fill('Worship');
    await editor.getByRole('button', { name: 'Add a section' }).click();
    await editor.getByRole('textbox', { name: 'Section 2' }).fill('Myths');
    await app.screenshot('types-editor');
    await editor.getByRole('button', { name: 'Save type' }).click();
    await page.getByRole('dialog', { name: 'Page types' }).getByText('A god or spirit.').waitFor();

    // A built-in type can be copied and changed.
    await page.getByRole('button', { name: 'Copy Character' }).click();
    const copy = page.getByRole('dialog', { name: 'New page type' });
    assert.equal(await copy.getByLabel('Name', { exact: true }).inputValue(), 'Character copy');
    await copy.getByLabel('Name', { exact: true }).fill('Hero');
    await copy.getByRole('button', { name: 'Remove field 1', exact: true }).click();
    await copy.getByRole('button', { name: 'Save type' }).click();
    await page.getByRole('button', { name: 'Change Hero' }).waitFor();
    await app.screenshot('types-list');
    await page.getByRole('button', { name: 'Done' }).click();

    // It is stored with the project.
    const stored = JSON.parse(await rpc(page, 'project.getMeta', { key: 'pageTypes' }));
    assert.deepEqual(stored.map((t) => t.label), ['Deity', 'Hero']);
    assert.equal(stored[1].fields.some((f) => f.key === 'born'), false, 'the copy changed');

    // The new page dialog offers it, with its fields and sections.
    await page.keyboard.press('Control+n');
    const newPage = page.getByRole('dialog', { name: 'New page' });
    await newPage.waitFor();
    await page.keyboard.type('Aurum');
    await newPage.getByLabel('Type').selectOption('deity');
    await newPage.getByText('A god or spirit.').waitFor();
    await page.keyboard.press('Enter');
    await page.getByRole('textbox', { name: 'Page title' }).waitFor();
    await waitUntil(async () => (await pageByTitle(page, 'Aurum'))?.pageType === 'deity', 5000, 'the page');
    const aurum = await pageByTitle(page, 'Aurum');
    assert.deepEqual(aurum.infobox.fields.map((f) => f.key), ['leader', 'domain']);
    assert.deepEqual(aurum.content.content.filter((n) => n.type === 'heading').map((n) => n.content[0].text), ['Worship', 'Myths']);

    // The sidebar and the filters know about it.
    const types = page.getByRole('navigation', { name: 'Page types' });
    await types.getByRole('button', { name: 'Deities 1' }).click();
    await page.getByRole('heading', { name: 'Deities' }).waitFor();
    assert.equal(await page.getByLabel('Type', { exact: true }).inputValue(), 'deity');
    await page.locator('tr[data-page="Aurum"]').waitFor();

    // So does the create screen for a red link.
    await rpc(page, 'pages.create', { title: 'Story', status: 'canon', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Argent', marks: [{ type: 'wikiLink', attrs: { target: 'Argent' } }] }] }] } });
    await openPage(page, 'Story');
    await page.locator('.ProseMirror a[data-wiki-target="Argent"]').click();
    // The click makes an article at once. Undo leads to the screen with the types.
    await page.locator('.toast').getByRole('button', { name: 'Undo', exact: true }).click();
    await page.getByRole('radio', { name: 'Deity' }).check();
    await page.getByRole('button', { name: 'Create this page' }).click();
    await page.getByRole('textbox', { name: 'Page title' }).waitFor();
    await waitUntil(async () => (await pageByTitle(page, 'Argent'))?.pageType === 'deity', 5000, 'the red link page');

    // A page's layout can become a type, without its values.
    await rpc(page, 'pages.update', { id: aurum.id, patch: { infobox: { fields: [{ key: 'domain', label: 'Domain', kind: 'text', value: 'Gold' }] } } });
    await openPage(page, 'Aurum');
    await page.getByRole('button', { name: /More/ }).click();
    await page.getByRole('menuitem', { name: /layout as a type/ }).click();
    const fromPage = page.getByRole('dialog', { name: 'New page type' });
    await fromPage.getByLabel('Name', { exact: true }).fill('Demigod');
    assert.equal(await fromPage.getByRole('textbox', { name: 'Label of field 1' }).inputValue(), 'Domain');
    assert.equal(await fromPage.getByRole('textbox', { name: 'Section 1' }).inputValue(), 'Worship');
    await fromPage.getByRole('button', { name: 'Save type' }).click();
    await page.getByRole('button', { name: 'Change Demigod' }).waitFor();
    const demigod = JSON.parse(await rpc(page, 'project.getMeta', { key: 'pageTypes' })).find((t) => t.label === 'Demigod');
    assert.equal(demigod.fields[0].value, '', 'values stay on the page they came from');

    // Deleting a type leaves its pages as they are.
    await page.getByRole('button', { name: 'Delete Deity' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete type' }).click();
    await page.getByRole('button', { name: 'Change Deity' }).waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Done' }).click();
    const after = await pageByTitle(page, 'Aurum');
    assert.equal(after.pageType, 'deity');
    assert.equal(after.infobox.fields.length, 1);
    await types.getByRole('button', { name: /Deity 2/ }).waitFor();
    await page.keyboard.press('Control+n');
    const options = await page.getByRole('dialog', { name: 'New page' }).getByLabel('Type').locator('option').allTextContents();
    assert.equal(options.includes('Deity'), false);
    assert.equal(options.includes('Hero'), true);
    await page.keyboard.press('Escape');

    // The list survives a crash and recovery with the rest of the project.
    await app.kill();
    app = await launch(workspace);
    page = app.page;
    await page.getByRole('button', { name: 'Recover' }).click();
    await page.locator('.topbar').waitFor();
    await page.getByRole('navigation', { name: 'Page types' }).getByRole('button', { name: /^Hero/ }).waitFor();
  });

  it('lists pages that name this one in their infobox, in Read mode', async () => {
    await start();
    await rpc(page, 'pages.create', { title: 'Silver Guard', pageType: 'faction', status: 'canon' });
    const field = (key, label, kind, value) => ({ fields: [{ key, label, kind, value }] });
    await rpc(page, 'pages.create', { title: 'Aria', pageType: 'character', status: 'canon', infobox: field('affiliation', 'Affiliation', 'pages', 'Silver Guard, Others') });
    await rpc(page, 'pages.create', { title: 'Bram', pageType: 'character', status: 'canon', infobox: field('affiliation', 'Affiliation', 'page', 'Silver Guard') });
    await rpc(page, 'pages.create', { title: 'Old Keep', pageType: 'place', status: 'canon', infobox: field('affiliation', 'Affiliation', 'pages', 'Silver Guard') });
    await rpc(page, 'pages.create', { title: 'Sword', pageType: 'item', status: 'canon', infobox: field('owner', 'Owner', 'page', 'Silver Guard') });

    await openPage(page, 'Silver Guard');
    const section = page.getByRole('region', { name: 'Linked from infoboxes' });
    await section.getByRole('term').filter({ hasText: 'Affiliation of' }).waitFor();
    await section.locator('[data-page-type="character"]').getByRole('link', { name: 'Aria' }).waitFor();
    await section.locator('[data-page-type="character"]').getByText('Characters:').waitFor();
    await section.locator('[data-page-type="place"]').getByRole('link', { name: 'Old Keep' }).waitFor();
    await section.getByRole('term').filter({ hasText: 'Owner of' }).waitFor();
    await app.screenshot('linked-from-infoboxes');

    // Read mode only, and it follows changes.
    await page.keyboard.press('Control+e');
    await page.locator('.wiki-article .ProseMirror[contenteditable="true"]').waitFor();
    assert.equal(await section.count(), 0);
    await page.keyboard.press('Control+e');
    await section.waitFor();
    await rpc(page, 'pages.create', { title: 'Cora', pageType: 'character', status: 'canon', infobox: field('affiliation', 'Affiliation', 'pages', 'Silver Guard') });
    await section.getByRole('link', { name: 'Cora' }).waitFor();
    await section.getByRole('link', { name: 'Sword' }).click();
    await page.getByRole('heading', { name: 'Sword', exact: true }).waitFor();
  });

  it('inserts a list block that fills itself in', async () => {
    await start();
    await rpc(page, 'pages.create', { title: 'Lady Morn', pageType: 'character', status: 'canon', categories: ['Nobility'] });
    await rpc(page, 'pages.create', { title: 'Lord Bram', pageType: 'character', status: 'canon', categories: ['Nobility'] });
    await rpc(page, 'pages.create', { title: 'Peasant Tam', pageType: 'character', status: 'canon' });
    await rpc(page, 'pages.create', { title: 'Noble House', pageType: 'place', status: 'canon', categories: ['Nobility'] });
    await rpc(page, 'pages.create', { title: 'Court', status: 'canon', content: doc('The court is made up of:') });

    await openPage(page, 'Court');
    await page.keyboard.press('Control+e');
    const editor = page.locator('.wiki-article .ProseMirror[contenteditable="true"]');
    await editor.waitFor();
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Insert a list of pages' }).click();
    const dialog = page.getByRole('dialog', { name: 'Insert a list of pages' });
    await dialog.getByLabel('Type').selectOption('character');
    await dialog.getByLabel('Category').selectOption('Nobility');
    await dialog.getByRole('button', { name: 'Insert' }).click();

    const list = page.locator('.page-list');
    await list.getByRole('link', { name: 'Lady Morn' }).waitFor();
    await list.getByRole('link', { name: 'Lord Bram' }).waitFor();
    assert.equal(await list.getByRole('link', { name: 'Peasant Tam' }).count(), 0);
    assert.equal(await list.getByRole('link', { name: 'Noble House' }).count(), 0);
    await list.getByText('All pages of type character in the category Nobility (2)').waitFor();
    await app.screenshot('list-block-edit');

    // Only the query is stored, and typing around it still works.
    await waitUntil(
      async () => JSON.stringify((await pageByTitle(page, 'Court')).content).includes('"pageList"'),
      5000,
      'the list to be stored',
    );
    const stored = (await pageByTitle(page, 'Court')).content.content.find((n) => n.type === 'pageList');
    assert.equal(stored.attrs.category, 'Nobility');
    assert.equal(JSON.stringify(stored).includes('Lady Morn'), false);

    // It changes the query from the block itself.
    await list.getByRole('button', { name: 'Change list' }).click();
    const change = page.getByRole('dialog', { name: 'Change this list' });
    assert.equal(await change.getByLabel('Category').inputValue(), 'Nobility');
    await change.getByLabel('Type').selectOption('');
    await change.getByRole('button', { name: 'Save' }).click();
    await list.getByRole('link', { name: 'Noble House' }).waitFor();

    // In Read mode a link goes to its page, and a new page joins the list by itself.
    await page.keyboard.press('Control+e');
    await page.getByRole('button', { name: 'Read', exact: true }).and(page.locator('.is-active')).waitFor();
    assert.equal(await list.getByRole('button', { name: 'Change list' }).isVisible(), false);
    await rpc(page, 'pages.create', { title: 'Duke Ansel', pageType: 'character', status: 'canon', categories: ['Nobility'] });
    await list.getByRole('link', { name: 'Duke Ansel' }).waitFor();
    await app.screenshot('list-block-read');
    await list.getByRole('link', { name: 'Lord Bram' }).click();
    await page.getByRole('heading', { name: 'Lord Bram', exact: true }).waitFor();
  });

  it('lists pages by an infobox field at the start of the story', async () => {
    await start();
    const home = (value) => ({ fields: [{ key: 'home', label: 'Home', kind: 'pages', value, changes: [] }] });
    await rpc(page, 'pages.create', { title: 'Ada', pageType: 'character', status: 'canon', infobox: home('Cray Landing') });
    await rpc(page, 'pages.create', { title: 'Brin', pageType: 'character', status: 'canon', infobox: home('Mor Hill') });
    await rpc(page, 'pages.create', { title: 'Town', status: 'canon', content: doc('Who lives here:') });

    await openPage(page, 'Town');
    await page.keyboard.press('Control+e');
    const editor = page.locator('.wiki-article .ProseMirror[contenteditable="true"]');
    await editor.waitFor();
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Insert a list of pages' }).click();
    const dialog = page.getByRole('dialog', { name: 'Insert a list of pages' });
    await dialog.getByLabel('Type').selectOption('character');
    await dialog.getByLabel('Infobox field').fill('home');
    await dialog.getByLabel('Field value').fill('cray landing');
    await dialog.getByRole('button', { name: 'Insert' }).click();

    const list = page.locator('.page-list');
    await list.getByRole('link', { name: 'Ada' }).waitFor();
    assert.equal(await list.getByRole('link', { name: 'Brin' }).count(), 0);
    await list.getByText('All pages of type character, where home is cray landing (1)').waitFor();
    await waitUntil(
      async () => JSON.stringify((await pageByTitle(page, 'Town')).content).includes('"fieldValue":"cray landing"'),
      5000,
      'the field filter to be stored',
    );
    // A page that moves in joins the list by itself.
    const brin = await pageByTitle(page, 'Brin');
    await rpc(page, 'pages.update', { id: brin.id, patch: { infobox: home('Cray Landing') } });
    await list.getByRole('link', { name: 'Brin' }).waitFor();
  });

  it('exports a list block as what it shows today, and keeps the query in JSON', async () => {
    await start();
    await rpc(page, 'pages.create', { title: 'Lady Morn', pageType: 'character', status: 'canon' });
    await rpc(page, 'pages.create', {
      title: 'Ada',
      pageType: 'character',
      status: 'canon',
      infobox: { fields: [{ key: 'home', label: 'Home', kind: 'text', value: 'Cray Landing', changes: [] }] },
    });
    await rpc(page, 'pages.create', {
      title: 'Court',
      status: 'canon',
      // The first list is from before field filters existed.
      content: { type: 'doc', content: [
        { type: 'pageList', attrs: { pageType: 'character', category: '', status: '', sort: 'title' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'Locals:' }] },
        { type: 'pageList', attrs: { pageType: '', category: '', status: '', sort: 'title', field: 'Home', fieldValue: 'cray landing' } },
      ] },
    });

    async function exportAs(format, name) {
      const path = workspace.file(name);
      await answerNextDialog(page, path);
      await page.getByRole('menuitem', { name: 'File' }).click();
      await page.getByRole('menuitem', { name: 'Export…', exact: true }).click();
      await page.getByRole('heading', { name: 'Export', exact: true }).waitFor();
      await page.getByRole('group', { name: 'Wiki data' }).getByRole('radio', { name: new RegExp(`^${format}\\b`) }).check();
      await page.getByRole('button', { name: 'Export…' }).click();
      await page.getByTestId('export-result').filter({ hasText: name }).waitFor({ timeout: 120_000 });
      return readFileSync(path, 'utf8');
    }

    const yaml = await exportAs('YAML', 'world.yaml');
    assert.ok(yaml.includes('[[Lady Morn]]'), 'the list holds its current results');
    assert.equal(yaml.includes('pageList'), false);
    const locals = yaml.slice(yaml.indexOf('Locals:'));
    assert.ok(locals.includes('[[Ada]]') && !locals.includes('[[Lady Morn]]'), 'the field list holds only Ada');

    const json = await exportAs('JSON', 'world.json');
    assert.ok(json.includes('"pageList"'), 'the query survives');
  });

  it('shows where a page first appears, and lets the writer set the reveal point', async () => {
    await start();
    const books = await rpc(page, 'books.list');
    const bookId = books[0].id;
    const tree = await rpc(page, 'nodes.tree', { bookId });
    const first = tree.find((n) => n.kind === 'scene');
    const chapter = await rpc(page, 'nodes.create', { bookId, kind: 'chapter', title: 'Chapter 3' });
    const second = await rpc(page, 'nodes.create', { bookId, parentId: chapter.id, kind: 'scene', title: 'Scene 2' });
    await rpc(page, 'nodes.update', { id: second.id, patch: { content: doc('Aria walked in, and Plain Page too.') } });
    await rpc(page, 'nodes.update', { id: first.id, patch: { content: doc('Nobody here yet.') } });

    await rpc(page, 'pages.create', {
      title: 'Aria',
      pageType: 'character',
      status: 'canon',
      infobox: { fields: [{ key: 'born', label: 'Born', kind: 'date', value: 'Year 1' }] },
    });
    await rpc(page, 'pages.create', { title: 'Plain Page', status: 'canon' });
    await rpc(page, 'pages.create', { title: 'Unused', status: 'canon' });

    // With an infobox, it is a row in the infobox.
    await openPage(page, 'Aria');
    const row = page.getByRole('complementary', { name: 'Infobox' }).locator('tr[data-field="firstAppearance"]');
    await row.getByRole('link', { name: /Chapter 3, Scene 2/ }).waitFor();
    assert.ok((await row.getByRole('link').innerText()).startsWith(books[0].title));
    await app.screenshot('first-appearance-infobox');

    // Without one, it is a line of its own, and with no scene, nothing at all.
    await openPage(page, 'Plain Page');
    await page.getByText('First appears:').waitFor();
    await app.screenshot('first-appearance-line');
    await openPage(page, 'Unused');
    assert.equal(await page.getByText('First appears:').count(), 0);

    // It updates when an earlier scene mentions the name, and links to that scene.
    await rpc(page, 'nodes.update', { id: first.id, patch: { content: doc('Aria arrived early.') } });
    await openPage(page, 'Aria');
    const link = row.getByRole('link');
    await waitUntil(async () => !/Chapter 3/.test(await link.innerText()), 5000, 'the earlier scene to take over');
    await link.click();
    await waitUntil(
      async () => (await page.locator('.area-tab.is-active').innerText()) === 'Write',
      5000,
      'the Write area to open',
    );

    // The AI's reveal point can be overridden on the page.
    await openPage(page, 'Aria');
    await page.keyboard.press('Control+e');
    const reveal = page.getByRole('combobox', { name: 'The AI may know about this page from' });
    await reveal.waitFor();
    assert.equal(await reveal.inputValue(), '', 'automatic by default');
    assert.match(await reveal.locator('option').first().innerText(), /Its first appearance: /);
    await reveal.selectOption(second.id);
    const aria = await pageByTitle(page, 'Aria');
    await waitUntil(async () => (await pageByTitle(page, 'Aria')).revealNodeId === second.id, 5000, 'the override');
    await reveal.selectOption('');
    await waitUntil(async () => (await rpc(page, 'pages.get', { id: aria.id })).revealNodeId === null, 5000, 'back to automatic');

    const all = await rpc(page, 'pages.firstAppearances');
    assert.equal(all[aria.id], first.id);
  });
});
