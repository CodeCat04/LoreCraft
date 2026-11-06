import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { allowPath, createProject, createWorkspace, launch, rpc, waitUntil } from './harness.mjs';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==',
  'base64',
);

const editable = (page) => page.locator('.wiki-article .ProseMirror[contenteditable="true"]');
const reading = (page) => page.locator('.wiki-article .ProseMirror');
const titleField = (page) => page.getByRole('textbox', { name: 'Page title' });
const tab = (page, name) => page.getByRole('button', { name, exact: true });

function doc(...paragraphs) {
  return {
    type: 'doc',
    content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
  };
}

function linkDoc(label, target) {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: label, marks: [{ type: 'wikiLink', attrs: { target } }] }],
      },
    ],
  };
}

/** Waits until the editor has focus, which is when typing lands in the article. */
async function waitForBodyFocus(page) {
  await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror'));
}

/** Ctrl+N, a title, Down until the type is reached, Enter. */
async function newPage(page, title, typeSteps = 0) {
  await page.keyboard.press('Control+n');
  await page.getByRole('dialog', { name: 'New page' }).waitFor();
  await page.keyboard.type(title);
  for (let i = 0; i < typeSteps; i += 1) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await waitUntil(async () => (await titleField(page).inputValue().catch(() => '')) === title, 5000, `the page ${title}`);
  await waitForBodyFocus(page);
}

const pageByTitle = (page, title) => rpc(page, 'pages.getByTitle', { title });

const searchBox = (page) => page.getByRole('combobox', { name: 'Search this project' });

/** Opens a page by typing its exact title in the search box. */
async function openPage(page, title) {
  await searchBox(page).fill(title);
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
}

function textOf(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text;
  return (node.content ?? []).map(textOf).join(node.type === 'doc' ? '\n' : '');
}

function linksIn(node, found = []) {
  for (const mark of node.marks ?? []) {
    if (mark.type === 'wikiLink') found.push({ text: node.text, target: mark.attrs.target });
  }
  for (const child of node.content ?? []) linksIn(child, found);
  return found;
}

async function storedText(page, title) {
  const stored = await pageByTitle(page, title);
  return stored ? textOf(stored.content) : null;
}

async function waitForStoredText(page, title, text) {
  await waitUntil(async () => (await storedText(page, title))?.includes(text), 5000, `"${text}" to be stored in ${title}`);
}

async function firstScene(page) {
  const books = await rpc(page, 'books.list');
  const tree = await rpc(page, 'nodes.tree', { bookId: books[0].id });
  return tree.find((n) => n.kind === 'scene');
}

async function goTo(page, command) {
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.waitFor();
  await palette.getByRole('combobox').fill(command);
  await page.keyboard.press('Enter');
}

describe('wiki', () => {
  let workspace;
  let app;
  let page;
  let problems;

  async function start(name = 'Silver World') {
    app = await launch(workspace);
    page = app.page;
    problems = [];
    page.on('pageerror', (e) => problems.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(m.text());
    });
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
    assert.deepEqual(problems, [], 'the page logged no errors');
  });

  it('creates a page from a template in a few keystrokes, with the cursor in the body', async () => {
    await start();
    await page.keyboard.press('Control+n');
    await page.getByRole('dialog', { name: 'New page' }).waitFor();
    await app.screenshot('wiki-new-page-dialog');
    await page.keyboard.type('Aria');
    await page.keyboard.press('ArrowDown'); // Blank article to Character.
    await page.keyboard.press('Enter');
    await waitForBodyFocus(page);
    await page.keyboard.type('Aria walks the northern road.');
    await waitForStoredText(page, 'Aria', 'walks the northern road');

    const stored = await pageByTitle(page, 'Aria');
    assert.equal(stored.pageType, 'character');
    assert.equal(stored.status, 'draft');
    assert.equal(stored.content.content[0].type, 'paragraph', 'the lead comes first');
    assert.equal(textOf(stored.content.content[0]), 'Aria walks the northern road.');
    assert.deepEqual(
      stored.content.content.filter((n) => n.type === 'heading').map(textOf),
      ['Appearance', 'Personality', 'Biography', 'Relationships'],
    );
    const fields = Object.fromEntries(stored.infobox.fields.map((f) => [f.key, f.kind]));
    assert.equal(fields.born, 'date');
    assert.equal(fields.died, 'date');
    assert.equal(fields.species, 'page');
    assert.equal(fields.parents, 'pages');
    await app.screenshot('wiki-edit-new-character');

    // The last type used is the default for the next page, and Enter on a taken title opens it.
    await page.keyboard.press('Control+n');
    await page.getByRole('dialog', { name: 'New page' }).waitFor();
    assert.equal(await page.getByRole('dialog').getByLabel('Type').inputValue(), 'character');
    await page.keyboard.type('aria');
    await page.getByText('already exists').waitFor();
    await page.keyboard.press('Escape');

    // Shift+Enter adds a run of pages without leaving the dialog.
    await page.keyboard.press('Control+n');
    await page.getByRole('dialog', { name: 'New page' }).waitFor();
    await page.keyboard.type('Morn');
    await page.keyboard.press('Shift+Enter');
    await page.getByText('Created 1 page').waitFor();
    await page.keyboard.type('Dusk');
    await page.keyboard.press('Shift+Enter');
    await page.getByText('Created 2 pages').waitFor();
    await page.keyboard.press('Escape');
    assert.ok(await pageByTitle(page, 'Morn'));
    assert.equal((await pageByTitle(page, 'Dusk')).pageType, 'character');
  });

  it('links with [[ autocomplete, by title, by alias and to new names', async () => {
    await start();
    await rpc(page, 'pages.create', { title: 'Silver Vale', pageType: 'place', summary: 'A hidden valley.' });
    await rpc(page, 'pages.create', { title: 'Aria Vale', aliases: ['The Ranger'] });
    await newPage(page, 'Story');

    await page.keyboard.type('She reached [[sil');
    const list = page.getByRole('listbox', { name: 'Link to a page' });
    await list.waitFor();
    await list.getByRole('option', { name: /Silver Vale/ }).waitFor();
    await app.screenshot('wiki-link-autocomplete');
    await page.keyboard.press('Enter');
    await list.waitFor({ state: 'hidden' });
    await page.keyboard.type(' at dawn, met [[the ran');
    await list.getByRole('option', { name: /Aria Vale/ }).waitFor();
    await page.keyboard.press('Tab');
    await page.keyboard.type(' and went to [[Nowhere Yet');
    await list.getByRole('option', { name: /Create/ }).waitFor();
    // Arrow keys move through the list, and the create option is last.
    await page.keyboard.press('Enter');
    await page.keyboard.type(' by [[Silver Vale|the vale');
    await list.getByRole('option', { name: /Silver Vale/ }).waitFor();
    await page.keyboard.press('Enter');
    await page.keyboard.type('. Then [[Aria');
    await page.keyboard.press('Escape');
    await list.waitFor({ state: 'hidden' });
    await page.keyboard.type(' stayed]] and [[Morning Star]] ok');
    await waitForStoredText(page, 'Story', 'ok');

    const stored = await pageByTitle(page, 'Story');
    assert.deepEqual(linksIn(stored.content), [
      { text: 'Silver Vale', target: 'Silver Vale' },
      { text: 'The Ranger', target: 'Aria Vale' },
      { text: 'Nowhere Yet', target: 'Nowhere Yet' },
      { text: 'the vale', target: 'Silver Vale' },
      { text: 'Aria stayed', target: 'Aria stayed' },
      { text: 'Morning Star', target: 'Morning Star' },
    ]);
    assert.ok(textOf(stored.content).startsWith('She reached Silver Vale at dawn, met The Ranger and went to Nowhere Yet by the vale.'));

    // Red and blue follow whether the page exists.
    assert.equal(await page.locator('.ProseMirror a[data-wiki-target="Nowhere Yet"] .wiki-link-red').count(), 1);
    assert.equal(await page.locator('.ProseMirror a[data-wiki-target="Silver Vale"] .wiki-link-ok').count(), 2);
    await rpc(page, 'pages.create', { title: 'Nowhere Yet' });
    await page.locator('.ProseMirror a[data-wiki-target="Nowhere Yet"] .wiki-link-ok').waitFor();

    // The shortcut starts a link too, and while editing Ctrl+click follows one. Ctrl+Shift+K
    // stays Ask AI, which comes first wherever text is selected.
    await page.keyboard.press('Control+Alt+K');
    await list.waitFor();
    await page.keyboard.press('Escape');
    await editable(page).locator('a[data-wiki-target="Nowhere Yet"]').click({ modifiers: ['Control'] });
    await page.getByRole('heading', { name: 'Nowhere Yet', exact: true }).waitFor();
    await openPage(page, 'Story');
    await page.keyboard.press('Control+e');
    await waitForBodyFocus(page);

    // The toolbar turns selected text into a link's label.
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('the brave ranger');
    await page.keyboard.press('Shift+ArrowLeft');
    for (let i = 0; i < 5; i += 1) await page.keyboard.press('Shift+ArrowLeft');
    await page.getByRole('button', { name: /Link to a page/ }).click();
    await list.waitFor();
    await page.keyboard.type('aria');
    await page.keyboard.press('Enter');
    await waitUntil(
      async () => linksIn((await pageByTitle(page, 'Story')).content).some((l) => l.text === 'ranger' && l.target === 'Aria Vale'),
      5000,
      'the selection to become a link',
    );
    assert.equal(await storedText(page, 'Story'), 'the brave ranger');
  });

  it('creates a page from a red link in one click, undoes it, and shows what links there', async () => {
    await start();
    await rpc(page, 'pages.create', { title: 'Story', status: 'canon', content: linkDoc('the Argent Keep', 'Argent Keep') });
    const scene = await firstScene(page);
    await rpc(page, 'nodes.update', { id: scene.id, patch: { title: 'Arrival', content: linkDoc('the keep', 'Argent Keep') } });
    await openPage(page, 'Story');

    // One click makes the page and opens it for writing, with Undo in the toast.
    await page.locator('.ProseMirror a[data-wiki-target="Argent Keep"]').click();
    await waitForBodyFocus(page);
    await waitUntil(async () => (await pageByTitle(page, 'Argent Keep'))?.pageType === 'article', 5000, 'the page from the red link');
    await page.locator('.toast').getByRole('button', { name: 'Undo', exact: true }).click();
    // Undo takes an untouched page out for good, and shows where the link leads instead.
    await page.getByText('no page called').waitFor();
    assert.equal(await pageByTitle(page, 'Argent Keep'), null);
    assert.equal((await rpc(page, 'pages.list', { deleted: true })).some((p) => p.title === 'Argent Keep'), false);
    await page.getByRole('heading', { name: 'Argent Keep', exact: true }).waitFor();
    await page.getByText('no page called').waitFor();
    await page.getByRole('link', { name: 'Story', exact: true }).waitFor();
    await page.getByRole('link', { name: 'Arrival', exact: true }).waitFor();
    await app.screenshot('wiki-missing-page');

    await page.getByRole('radio', { name: 'Place' }).check();
    await page.getByRole('button', { name: 'Create this page' }).click();
    await waitForBodyFocus(page);
    await page.keyboard.type('A fortress of pale stone.');
    await waitForStoredText(page, 'Argent Keep', 'pale stone');
    assert.equal((await pageByTitle(page, 'Argent Keep')).pageType, 'place');
    assert.deepEqual(await rpc(page, 'pages.wanted'), []);

    // Back on the first page, the link is blue and What links here knows about it.
    await searchBox(page).fill('Story');
    await page.keyboard.press('Enter');
    await page.locator('.ProseMirror a[data-wiki-target="Argent Keep"] .wiki-link-ok').waitFor();
    await page.locator('.ProseMirror a[data-wiki-target="Argent Keep"]').click();
    await page.getByRole('heading', { name: 'Argent Keep', exact: true }).waitFor();
    const links = page.getByRole('list', { name: 'Pages that link here' });
    await links.getByRole('link', { name: 'Story' }).waitFor();
    await page.getByRole('list', { name: 'Scenes that mention it' }).getByRole('link', { name: 'Arrival' }).waitFor();
  });

  it('leads to search by meaning from the search box, the results and the palette', async () => {
    await start();
    await rpc(page, 'pages.create', { title: 'Silver Vale', content: linkDoc('the keep', 'Argent Keep') });

    // A title that matches exactly still offers the search page, and Shift+Enter goes there.
    await searchBox(page).fill('Silver Vale');
    await page.getByRole('option', { name: /Search all text for “Silver Vale”/ }).waitFor();
    await page.keyboard.press('Shift+Enter');
    await page.getByRole('heading', { name: 'Search results' }).waitFor();

    // While it is off, the results say so and offer to turn it on in Settings.
    const hint = page.getByTestId('meaning-off-hint');
    await hint.getByText('Search by meaning is off.').waitFor();
    await hint.getByRole('button', { name: 'Turn on search by meaning…' }).click();
    await page.getByTestId('meaning-settings').waitFor();
    await page.waitForFunction(() => document.activeElement?.closest('[data-testid="meaning-settings"]') !== null);
    const settings = await rpc(page, 'settings.get');
    assert.notEqual(settings.ai?.embeddings?.enabled, true, 'the hint turns nothing on by itself');

    // The palette has the command too, which goes to the same place while it is off.
    await goTo(page, 'Search by meaning');
    await page.getByText('Turn it on here first').waitFor();
  });

  it('renames with a count of documents, updates links, and keeps the editor intact', async () => {
    await start();
    const target = await rpc(page, 'pages.create', { title: 'Silver Vale' });
    const linking = await rpc(page, 'pages.create', { title: 'Notes', content: linkDoc('the Vale', 'Silver Vale') });
    const scene = await firstScene(page);
    await rpc(page, 'nodes.update', { id: scene.id, patch: { content: linkDoc('the valley', 'Silver Vale') } });
    await rpc(page, 'pages.create', {
      title: 'Aria',
      infobox: { fields: [{ key: 'location', label: 'Home', kind: 'page', value: 'Silver Vale' }] },
    });

    await openPage(page, 'Silver Vale');
    await page.keyboard.press('Control+e');
    await editable(page).waitFor();
    await waitForBodyFocus(page);
    await page.keyboard.type('Unsaved words. ');

    // Editing the title asks first, and says how many documents will change.
    await titleField(page).fill('Argent Vale');
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: /Rename “Silver Vale” to “Argent Vale”/ });
    await dialog.waitFor();
    await dialog.getByText('3 documents link to this page').waitFor();
    await app.screenshot('wiki-rename-confirm');
    await dialog.getByRole('button', { name: 'Rename' }).click();
    await page.getByText('Updated 3 documents').waitFor();

    assert.deepEqual(linksIn((await rpc(page, 'pages.get', { id: linking.id })).content), [
      { text: 'the Vale', target: 'Argent Vale' },
    ]);
    assert.deepEqual(linksIn((await rpc(page, 'nodes.get', { id: scene.id })).content), [
      { text: 'the valley', target: 'Argent Vale' },
    ]);
    assert.equal((await pageByTitle(page, 'Aria')).infobox.fields[0].value, 'Argent Vale');
    const renamed = await rpc(page, 'pages.get', { id: target.id });
    assert.equal(renamed.title, 'Argent Vale');
    assert.deepEqual(renamed.aliases, ['Silver Vale'], 'the old name stays as an alias');
    assert.ok(textOf(renamed.content).includes('Unsaved words.'), 'pending edits were saved first');

    // Escape puts the title back and renames nothing.
    await titleField(page).fill('Never Mind');
    await page.keyboard.press('Escape');
    await waitUntil(async () => (await titleField(page).inputValue()) === 'Argent Vale', 2000, 'the title to go back');
    await page.waitForTimeout(100);
    assert.equal((await rpc(page, 'pages.get', { id: target.id })).title, 'Argent Vale');

    // Taken names are refused and the field goes back.
    await titleField(page).fill('notes');
    await page.keyboard.press('Enter');
    await page.getByText('A page called "notes" already exists').waitFor();
    await waitUntil(async () => (await titleField(page).inputValue()) === 'Argent Vale', 2000, 'the title to revert');

    // Leaving Edit with the keyboard while the title has focus keeps what was typed.
    await rpc(page, 'pages.create', { title: 'Quick Change' });
    await openPage(page, 'Quick Change');
    await page.keyboard.press('Control+e');
    await waitForBodyFocus(page);
    await titleField(page).fill('Quick Changed');
    await page.keyboard.press('Control+e');
    await page.getByRole('heading', { name: 'Quick Changed', exact: true }).waitFor();

    // F2 works too, and with nothing linking there is nothing to confirm.
    await rpc(page, 'pages.create', { title: 'Lonely', status: 'canon' });
    await openPage(page, 'Lonely');
    await page.keyboard.press('F2');
    const prompt = page.getByRole('dialog', { name: 'Rename page' });
    await prompt.waitFor();
    await page.keyboard.type('Solitary');
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Solitary', exact: true }).waitFor();
    assert.deepEqual((await pageByTitle(page, 'Solitary')).aliases, [], 'no alias for a page nothing links to');
  });

  it('compares history at word level and restores, refreshing the open editor', async () => {
    await start();
    await newPage(page, 'Chronicle');
    await page.keyboard.type('The river runs north past the keep.');
    await waitForStoredText(page, 'Chronicle', 'runs north');

    await tab(page, 'History').click();
    await page.getByRole('button', { name: 'Save a checkpoint' }).click();
    await page.getByRole('dialog', { name: 'Save a checkpoint' }).getByRole('textbox').fill('First draft');
    await page.keyboard.press('Enter');
    await page.getByText('Checkpoint saved').waitFor();
    await page.getByRole('cell', { name: 'First draft' }).waitFor();

    await tab(page, 'Edit').click();
    await waitForBodyFocus(page);
    await page.keyboard.press('Control+a');
    await page.keyboard.type('The river runs south past the keep.');
    await waitForStoredText(page, 'Chronicle', 'runs south');

    await tab(page, 'History').click();
    const row = page.getByRole('row', { name: /First draft/ });
    await row.getByRole('button', { name: /^Compare/ }).click();
    const comparison = page.getByRole('region', { name: 'Comparison' });
    await comparison.locator('ins', { hasText: 'south' }).waitFor();
    await comparison.locator('del', { hasText: 'north' }).waitFor();
    await comparison.getByText('1 word added').waitFor();
    assert.equal(await comparison.locator('del').count(), 1, 'only the changed word is marked');
    await app.screenshot('wiki-history-compare');

    // Two old versions can be compared with each other.
    await tab(page, 'Edit').click();
    await waitForBodyFocus(page);
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' Then it stops.');
    await waitForStoredText(page, 'Chronicle', 'it stops');
    await tab(page, 'History').click();
    await page.getByRole('button', { name: 'Save a checkpoint' }).click();
    await page.getByRole('dialog', { name: 'Save a checkpoint' }).getByRole('textbox').fill('Third');
    await page.keyboard.press('Enter');
    await page.getByRole('cell', { name: 'Third', exact: true }).waitFor();
    await page.getByRole('row', { name: /First draft/ }).getByRole('radio', { name: /older/ }).check();
    await page.getByRole('row', { name: /Third/ }).getByRole('radio', { name: /newer/ }).check();
    await page.getByRole('button', { name: 'Compare selected versions' }).click();
    await comparison.locator('ins', { hasText: 'Then it stops' }).waitFor();

    // View an old version without changing anything.
    await page.getByRole('row', { name: /First draft/ }).getByRole('button', { name: /^View/ }).click();
    const old = page.getByRole('region', { name: 'Old version' });
    await old.getByText('runs north').waitFor();
    await old.getByRole('button', { name: 'Close', exact: true }).click();

    // Restore, with the article left open in the Edit tab first.
    await tab(page, 'Edit').click();
    await waitForBodyFocus(page);
    await tab(page, 'History').click();
    await page.getByRole('row', { name: /First draft/ }).getByRole('button', { name: /^Restore/ }).click();
    const confirm = page.getByRole('alertdialog');
    await confirm.getByText(/goes back to how it was/).waitFor();
    await confirm.getByRole('button', { name: 'Restore' }).click();
    await page.getByText('Restored that version').waitFor();
    await reading(page).getByText('The river runs north past the keep.').waitFor();
    assert.equal(await storedText(page, 'Chronicle'), 'The river runs north past the keep.');

    // Editing now continues from the restored text, not from what the editor held before.
    await tab(page, 'Edit').click();
    await waitForBodyFocus(page);
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' Restored and extended.');
    await waitForStoredText(page, 'Chronicle', 'Restored and extended.');
    assert.equal(await storedText(page, 'Chronicle'), 'The river runs north past the keep. Restored and extended.');

    // The version replaced by the restore can still be reached. It was the "Third" checkpoint.
    const list = await rpc(page, 'revisions.list', { kind: 'page', id: (await pageByTitle(page, 'Chronicle')).id });
    const third = list.find((r) => r.reason === 'Third');
    assert.ok(textOf((await rpc(page, 'revisions.get', { id: third.id })).content).includes('it stops'));

    // Restoring text with no checkpoint yet leaves a revision of its own.
    await tab(page, 'History').click();
    await page.getByRole('row', { name: /First draft/ }).getByRole('button', { name: /^Restore/ }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Restore' }).click();
    await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
    const chronicleId = (await pageByTitle(page, 'Chronicle')).id;
    const before = await waitUntil(
      async () => (await rpc(page, 'revisions.list', { kind: 'page', id: chronicleId })).find((r) => r.reason === 'restore'),
      5000,
      'the revision from before the restore',
    );
    assert.ok(textOf((await rpc(page, 'revisions.get', { id: before.id })).content).includes('Restored and extended.'));
    await tab(page, 'History').click();
    await page.getByRole('cell', { name: 'Before a restore' }).waitFor();
  });

  it('finds and replaces across pages and scenes with a preview and unticked matches', async () => {
    await start();
    const notes = await rpc(page, 'pages.create', { title: 'Notes', content: doc('Aria met Aria and Ariadne.') });
    const other = await rpc(page, 'pages.create', { title: 'Other', content: doc('Nothing about her here.') });
    const spanning = await rpc(page, 'pages.create', {
      title: 'Styled',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Ar', marks: [{ type: 'bold' }] },
              { type: 'text', text: 'ia' },
              { type: 'text', text: ' left.' },
            ],
          },
        ],
      },
    });
    const scene = await firstScene(page);
    await rpc(page, 'nodes.update', { id: scene.id, patch: { title: 'Dawn', content: doc('Aria drew her bow.') } });

    await page.keyboard.press('Control+Shift+F');
    await page.getByRole('heading', { name: 'Find and replace' }).waitFor();
    await page.getByLabel('Find', { exact: true }).fill('Aria');
    await page.getByLabel('Replace with').fill('Lyra');
    await page.getByLabel('Whole word').check();
    await page.getByLabel('Match case').check();
    await page.getByLabel('Find', { exact: true }).press('Enter');

    const preview = page.getByRole('region', { name: 'Preview' });
    await preview.getByText('4 matches in 3 documents').waitFor();
    await preview.locator('del', { hasText: 'Aria' }).first().waitFor();
    await preview.locator('ins', { hasText: 'Lyra' }).first().waitFor();
    assert.equal(await preview.getByRole('region', { name: 'Other' }).count(), 0);
    await app.screenshot('wiki-replace-preview');

    // Untick the second match in Notes.
    await preview.getByRole('region', { name: 'Notes' }).getByRole('checkbox', { name: /before “ and Ariadne/ }).uncheck();
    await preview.getByText('3 ticked').waitFor();
    await page.getByRole('button', { name: 'Replace 3 matches' }).click();
    await page.getByRole('alertdialog').getByText('This changes 3 documents').waitFor();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Replace' }).click();
    await page.getByText('Replaced 3 matches in 3 documents').waitFor();

    assert.equal(textOf((await rpc(page, 'pages.get', { id: notes.id })).content), 'Lyra met Aria and Ariadne.');
    assert.equal(textOf((await rpc(page, 'pages.get', { id: other.id })).content), 'Nothing about her here.');
    assert.equal(textOf((await rpc(page, 'nodes.get', { id: scene.id })).content), 'Lyra drew her bow.');
    const styled = (await rpc(page, 'pages.get', { id: spanning.id })).content.content[0].content;
    assert.deepEqual(styled, [
      { type: 'text', text: 'Lyra', marks: [{ type: 'bold' }] },
      { type: 'text', text: ' left.' },
    ]);

    // Every changed document has a checkpoint from just before.
    const revisions = await rpc(page, 'revisions.list', { kind: 'page', id: notes.id });
    assert.equal(revisions[0].reason, 'replace');
    assert.equal(textOf((await rpc(page, 'revisions.get', { id: revisions[0].id })).content), 'Aria met Aria and Ariadne.');

    // Selected text is offered as what to find.
    await openPage(page, 'Other');
    await page.locator('.wiki-article .ProseMirror p').first().selectText();
    await page.evaluate(() => {
      const paragraph = document.querySelector('.wiki-article .ProseMirror p');
      const range = document.createRange();
      range.setStart(paragraph.firstChild, 0);
      range.setEnd(paragraph.firstChild, 7);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.press('Control+Shift+F');
    await waitUntil(async () => (await page.getByLabel('Find', { exact: true }).inputValue()) === 'Nothing', 2000, 'the selection to be used');

    // Regular expressions work, and a bad one says so instead of failing silently.
    await page.getByLabel('Whole word').uncheck();
    await page.getByLabel('Match case').uncheck();
    await page.getByLabel('Regular expression').check();
    await page.getByLabel('Find', { exact: true }).fill('(');
    await page.getByLabel('Find', { exact: true }).press('Enter');
    await page.getByRole('alert').getByText('not valid').waitFor();
    await page.getByLabel('Find', { exact: true }).fill('L(y)ra');
    await page.getByLabel('Replace with').fill('L$1re');
    await page.getByLabel('Find', { exact: true }).press('Enter');
    await preview.locator('ins', { hasText: 'Lyre' }).first().waitFor();
  });

  it('refreshes an open page after find and replace, and reports a stale preview', async () => {
    await start();
    await newPage(page, 'Open Page');
    await page.keyboard.type('The cat sat.');
    await waitForStoredText(page, 'Open Page', 'cat sat');

    await page.keyboard.press('Control+Shift+F');
    await page.getByLabel('Find', { exact: true }).fill('cat');
    await page.getByLabel('Replace with').fill('dog');
    await page.getByLabel('Find', { exact: true }).press('Enter');
    await page.getByText('1 match in 1 document').waitFor();

    // Something else changes the text between preview and apply.
    const stored = await pageByTitle(page, 'Open Page');
    await rpc(page, 'pages.update', { id: stored.id, patch: { content: doc('The cat sat. Twice the cat.') } });
    await page.getByRole('button', { name: 'Replace 1 match' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Replace' }).click();
    await page.getByText('changed since this preview').waitFor();
    await page.getByText('2 matches in 1 document').waitFor();
    await page.getByRole('button', { name: 'Replace 2 matches' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Replace' }).click();
    await page.getByText('Replaced 2 matches').waitFor();

    await page.getByRole('region', { name: 'Preview' }).waitFor({ state: 'hidden' });
    await searchBox(page).fill('Open Page');
    await page.keyboard.press('Enter');
    await reading(page).getByText('The dog sat. Twice the dog.').waitFor();
  });

  it('renames everywhere: the page, its links, and the name in text after a preview', async () => {
    await start();
    const aria = await rpc(page, 'pages.create', { title: 'Aria', content: doc('Aria is the hero.') });
    await rpc(page, 'pages.create', {
      title: 'Story',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Aria', marks: [{ type: 'wikiLink', attrs: { target: 'Aria' } }] },
              { type: 'text', text: ' met Ariadne and aria.' },
            ],
          },
          { type: 'paragraph', content: [{ type: 'text', text: 'Aria slept, as Aria does.' }] },
        ],
      },
    });
    const scene = await firstScene(page);
    await rpc(page, 'nodes.update', { id: scene.id, patch: { title: 'Dusk', content: doc('Aria rode on.') } });

    await openPage(page, 'Aria');
    await page.getByRole('button', { name: /More/ }).click();
    await page.getByRole('menuitem', { name: 'Rename everywhere…' }).click();
    const dialog = page.getByRole('dialog', { name: /Rename “Aria” everywhere/ });
    await dialog.waitFor();
    await page.keyboard.type('Lyra');
    await page.keyboard.press('Enter');

    await page.getByRole('heading', { name: 'Rename “Aria” everywhere' }).waitFor();
    await page.getByText('Links in 1 document follow automatically').waitFor();
    const preview = page.getByRole('region', { name: 'Preview' });
    await preview.getByText('5 matches in 3 documents').waitFor();
    assert.equal(await preview.getByText('Ariadne').count() > 0, true, 'context is shown');
    await app.screenshot('wiki-rename-everywhere');

    // Keep one mention as it is: someone said it before the rename.
    await preview.getByRole('region', { name: 'Story' }).getByRole('checkbox', { name: /, as Aria does/ }).uncheck();
    await page.getByRole('button', { name: 'Rename and replace 4 matches' }).click();
    await page.getByRole('heading', { name: 'Lyra', exact: true }).waitFor();

    const renamed = await rpc(page, 'pages.get', { id: aria.id });
    assert.equal(renamed.title, 'Lyra');
    assert.deepEqual(renamed.aliases, [], 'no alias unless asked for');
    assert.equal(textOf(renamed.content), 'Lyra is the hero.');
    const story = await pageByTitle(page, 'Story');
    assert.deepEqual(linksIn(story.content), [{ text: 'Lyra', target: 'Lyra' }]);
    assert.ok(textOf(story.content).includes('Lyra met Ariadne and aria.'));
    assert.ok(textOf(story.content).includes('Aria slept, as Lyra does.'));
    assert.equal(textOf((await rpc(page, 'nodes.get', { id: scene.id })).content), 'Lyra rode on.');
    assert.deepEqual(await rpc(page, 'pages.wanted'), []);
  });

  it('edits the infobox: values with Tab, page links with autocomplete, fields and an image', async () => {
    await start();
    await rpc(page, 'pages.create', { title: 'Human', pageType: 'species' });
    await rpc(page, 'pages.create', { title: 'Morn' });
    await newPage(page, 'Aria', 1);
    const box = page.getByRole('complementary', { name: 'Infobox editor' });

    await box.getByRole('textbox', { name: 'Born' }).click();
    await page.keyboard.type('Year 312');
    // Each value is followed by its "changes during the story" button, which keeps it reachable.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Year 380');
    assert.equal(await box.getByRole('textbox', { name: 'Died' }).inputValue(), 'Year 380', 'Tab goes to the next value');

    // Species is a page link, with autocomplete from titles.
    await box.getByRole('combobox', { name: 'Species' }).click();
    await page.keyboard.type('hum');
    await box.getByRole('option', { name: 'Human' }).waitFor();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.equal(await box.getByRole('combobox', { name: 'Species' }).inputValue(), 'Human');

    // Parents holds several, some not written yet.
    await box.getByRole('combobox', { name: 'Parents' }).click();
    await page.keyboard.type('mor');
    await box.getByRole('option', { name: 'Morn' }).click();
    await page.keyboard.type('Unknown Mother');

    // A field of your own, then move it to the top and remove another.
    await box.getByRole('combobox', { name: 'Add a field' }).selectOption({ label: 'A field of your own' });
    await page.keyboard.type('Rank');
    await box.getByRole('textbox', { name: /Name of field/ }).last().waitFor();
    for (let i = 0; i < 13; i += 1) {
      await box.getByRole('button', { name: 'Move Rank up' }).click();
    }
    await box.getByRole('button', { name: 'Remove Hair' }).click();
    await box.getByRole('combobox', { name: 'Kind of Rank' }).selectOption('number');
    await app.screenshot('wiki-infobox-arrange');
    await box.getByRole('button', { name: 'Done arranging' }).click();
    await box.getByRole('textbox', { name: 'Rank' }).fill('7');

    // A known field for this page type can be added back.
    await box.getByRole('combobox', { name: 'Add a field' }).selectOption({ label: 'Hair' });
    await page.keyboard.type('Silver');

    await page.locator('input[type="file"]').setInputFiles({
      name: 'portrait.png',
      mimeType: 'image/png',
      buffer: ONE_PIXEL_PNG,
    });
    await box.getByRole('textbox', { name: 'Image caption' }).fill('Aria in winter');
    await app.screenshot('wiki-infobox-edit');

    await waitUntil(
      async () => (await pageByTitle(page, 'Aria')).infobox.caption === 'Aria in winter',
      5000,
      'the infobox to be stored',
    );
    const stored = await pageByTitle(page, 'Aria');
    const fields = Object.fromEntries(stored.infobox.fields.map((f) => [f.key, f]));
    assert.equal(stored.infobox.fields[0].key, 'rank', 'moved to the top');
    assert.equal(fields.rank.kind, 'number');
    assert.equal(fields.born.value, 'Year 312');
    assert.equal(fields.species.value, 'Human');
    assert.equal(fields.parents.value, 'Morn, Unknown Mother');
    assert.equal(fields.hair.value, 'Silver');
    assert.equal(stored.infobox.fields.at(-1).key, 'hair', 'added back at the end');
    assert.ok(stored.infobox.imageAssetId);

    // Infobox links count as links.
    assert.deepEqual((await rpc(page, 'pages.wanted')).map((w) => w.title), ['Unknown Mother']);

    await tab(page, 'Read').click();
    const view = page.getByRole('complementary', { name: 'Infobox' });
    await view.locator('img[alt="Aria in winter"]').waitFor();
    await view.getByRole('link', { name: 'Human' }).waitFor();
    assert.equal(await view.locator('a.wiki-link-red', { hasText: 'Unknown Mother' }).count(), 1);
    assert.equal(await view.locator('a.wiki-link-ok', { hasText: 'Morn' }).count(), 1);
    assert.equal(await view.getByText('Gender').count(), 0, 'empty fields are hidden while reading');
    await app.screenshot('wiki-infobox-read');
    const loaded = await view.locator('img').evaluate((img) => img.complete && img.naturalWidth > 0);
    assert.ok(loaded, 'the image displays');

    await view.getByRole('link', { name: 'Human' }).click();
    await page.getByRole('heading', { name: 'Human', exact: true }).waitFor();
  });

  it('adds an infobox image without undoing what changed while it uploaded', async () => {
    await start();
    await newPage(page, 'Aria', 1);
    const box = page.getByRole('complementary', { name: 'Infobox editor' });
    const stored = async (key) => (await pageByTitle(page, 'Aria')).infobox.fields.find((f) => f.key === key)?.value;

    // Chooses a picture whose bytes are only read once the test lets the upload finish.
    const upload = async () => {
      await page.evaluate((base64) => {
        let release = () => {};
        const gate = new Promise((resolve) => {
          release = resolve;
        });
        window.__finishUpload = () => release();
        class HeldBlob extends Blob {
          arrayBuffer() {
            return gate.then(() => super.arrayBuffer());
          }
        }
        class HeldFile extends File {
          slice(start, end, type) {
            const part = super.slice(start, end, type);
            // Looking at the first bytes to see what it is goes ahead. Uploading them waits.
            return end !== undefined && end <= 4096 ? part : new HeldBlob([part]);
          }
        }
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const file = new HeldFile([bytes], 'portrait.png', { type: 'image/png' });
        const input = document.querySelector('.wiki-infobox-edit input[type="file"]');
        Object.defineProperty(input, 'files', { configurable: true, get: () => [file] });
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }, ONE_PIXEL_PNG.toString('base64'));
      await box.getByRole('button', { name: 'Adding…' }).waitFor();
    };
    // A late save of an older copy would come within the save delay, so give it that long.
    const noLateSave = () => page.waitForTimeout(1000);

    // Typed while the image uploads.
    await upload();
    await box.getByRole('textbox', { name: 'Born' }).fill('Year 312');
    await waitUntil(async () => (await stored('born')) === 'Year 312', 5000, 'the typing to be saved');
    assert.equal(await box.getByRole('button', { name: 'Adding…' }).count(), 1, 'still uploading');
    await page.evaluate(() => window.__finishUpload());
    await waitUntil(async () => Boolean((await pageByTitle(page, 'Aria')).infobox.imageAssetId), 5000, 'the image to be stored');
    await noLateSave();
    assert.equal(await stored('born'), 'Year 312', 'the image did not bring back the empty field');

    // Filled in from another page while it uploads, which reloads this one.
    await box.getByRole('button', { name: 'Remove image' }).click();
    await waitUntil(async () => !(await pageByTitle(page, 'Aria')).infobox.imageAssetId, 5000, 'the image to be removed');
    await upload();
    await rpc(page, 'pages.create', {
      title: 'Bran',
      pageType: 'character',
      infobox: { fields: [{ key: 'spouse', label: 'Spouse', kind: 'pages', value: 'Aria' }] },
    });
    await waitUntil(async () => (await box.getByLabel('Spouse', { exact: true }).inputValue()) === 'Bran', 5000, 'the editor to reload');
    await page.evaluate(() => window.__finishUpload());
    await waitUntil(async () => Boolean((await pageByTitle(page, 'Aria')).infobox.imageAssetId), 5000, 'the image to be stored');
    await box.locator('.wiki-ibe-image img').waitFor();
    await noLateSave();
    assert.equal(await stored('spouse'), 'Bran', 'the sync was not undone');
    assert.equal(await stored('born'), 'Year 312');
    assert.equal((await rpc(page, 'extras.relationshipList', {})).length, 1);
  });

  it('keeps focus and the cursor through saves and data events while editing', async () => {
    await start();
    await newPage(page, 'Busy Page');
    await page.keyboard.type('Alpha gamma');
    for (let i = 0; i < 5; i += 1) await page.keyboard.press('ArrowLeft');
    await page.keyboard.type('beta ');
    await waitForStoredText(page, 'Busy Page', 'Alpha beta gamma');

    // None of these may reload the article or move the cursor.
    const stored = await pageByTitle(page, 'Busy Page');
    await rpc(page, 'pages.create', { title: 'Another page' });
    const other = await pageByTitle(page, 'Another page');
    await rpc(page, 'pages.update', { id: other.id, patch: { content: linkDoc('Busy', 'Busy Page') } });
    await rpc(page, 'pages.update', { id: stored.id, fromEditor: true, patch: { categories: ['People'] } });
    await page.waitForTimeout(700);
    assert.ok(await page.evaluate(() => document.activeElement?.classList.contains('ProseMirror')), 'focus stays');
    await page.keyboard.type('delta ');
    await waitForStoredText(page, 'Busy Page', 'Alpha beta delta gamma');

    // Fields save without disturbing each other, even within one save delay.
    await page.getByLabel('Summary').fill('A busy page.');
    await page.keyboard.press('Tab');
    await page.getByRole('combobox', { name: 'Status' }).selectOption('idea');
    await waitUntil(async () => (await pageByTitle(page, 'Busy Page')).status === 'idea', 5000, 'the status');
    const saved = await pageByTitle(page, 'Busy Page');
    assert.equal(saved.summary, 'A busy page.');

    // Tags autocomplete from categories in use.
    await rpc(page, 'pages.update', { id: other.id, patch: { categories: ['Heroes of the Vale'] } });
    await page.getByRole('combobox', { name: 'Categories' }).click();
    await page.keyboard.type('hero');
    await page.getByRole('option', { name: 'Heroes of the Vale' }).click();
    await page.keyboard.type('Second category,');
    await page.getByRole('combobox', { name: 'Also known as' }).click();
    await page.keyboard.type('The Busy One');
    await page.keyboard.press('Enter');
    await waitUntil(
      async () => (await pageByTitle(page, 'Busy Page')).aliases.includes('The Busy One'),
      5000,
      'the alias',
    );
    assert.deepEqual((await pageByTitle(page, 'Busy Page')).categories, ['Heroes of the Vale', 'Second category']);
    assert.equal(textOf((await pageByTitle(page, 'Busy Page')).content).startsWith('Alpha beta delta gamma'), true);

    // Ctrl+E leaves edit mode without marking anything as code.
    await editable(page).click();
    await page.keyboard.press('Control+e');
    await tab(page, 'Read').and(page.locator('.is-active')).waitFor();
    assert.equal(JSON.stringify((await pageByTitle(page, 'Busy Page')).content).includes('"code"'), false);

    // Banner, aliases, summary and categories show while reading.
    await page.getByRole('note').getByText('This page is an idea').waitFor();
    await page.getByText('The Busy One').waitFor();
    await page.locator('.wiki-summary', { hasText: 'A busy page.' }).waitFor();
    await page.getByRole('navigation', { name: 'Categories of this page' }).getByRole('link', { name: 'Second category' }).waitFor();
    await page.getByText(/This page was last edited/).waitFor();
    await app.screenshot('wiki-read-banner');
  });

  it('never changes a page just by opening it, reading it or entering Edit', async () => {
    await start();
    const path = workspace.file('quiet.lorecraft');
    await allowPath(page, path);
    // The main page ends in a list, which the editor tidies with a trailing paragraph.
    await rpc(page, 'project.saveAs', { path });
    const state = page.getByTestId('save-state');
    await waitUntil(async () => /All changes saved/.test(await state.innerText()), 3000, 'the saved state');
    const before = await rpc(page, 'pages.home');

    await tab(page, 'Edit').click();
    await waitForBodyFocus(page);
    await page.waitForTimeout(800);
    await tab(page, 'History').click();
    await tab(page, 'Talk').click();
    await tab(page, 'Read').click();
    await page.waitForTimeout(800);

    const after = await rpc(page, 'pages.home');
    assert.equal(after.updatedAt, before.updatedAt);
    assert.match(await state.innerText(), /All changes saved/);
  });

  it('keeps autosaved work through a force-kill', async () => {
    await start('Crash World');
    await newPage(page, 'Survivor', 1);
    await page.keyboard.type('Words that must survive.');
    await page.getByRole('complementary', { name: 'Infobox editor' }).getByRole('textbox', { name: 'Born' }).fill('Year 9');
    await page.getByLabel('Summary').fill('Hard to kill.');
    await waitUntil(async () => {
      const stored = await pageByTitle(page, 'Survivor');
      return textOf(stored.content).includes('must survive') && stored.summary === 'Hard to kill.'
        && stored.infobox.fields.find((f) => f.key === 'born').value === 'Year 9';
    }, 5000, 'the edits to be stored');

    await app.kill();
    app = await launch(workspace);
    page = app.page;
    await page.getByRole('heading', { name: 'Recover your work?' }).waitFor();
    await page.getByRole('button', { name: 'Recover' }).click();
    await page.locator('.topbar').waitFor();
    await openPage(page, 'Survivor');
    await reading(page).getByText('Words that must survive.').waitFor();
    await page.getByRole('complementary', { name: 'Infobox' }).getByText('Year 9').waitFor();
    await page.locator('.wiki-summary', { hasText: 'Hard to kill.' }).waitFor();
  });

  it('shows hover cards for anything with data-wiki-target, including elements added later', async () => {
    await start();
    await rpc(page, 'pages.create', {
      title: 'Silver Vale',
      pageType: 'place',
      status: 'canon',
      summary: 'A hidden valley of moonlit rivers.',
    });
    await rpc(page, 'pages.create', { title: 'Story', status: 'canon', content: linkDoc('the Vale', 'silver vale') });
    await openPage(page, 'Story');

    const card = page.getByRole('tooltip');
    await page.locator('.ProseMirror a[data-wiki-target]').hover();
    await card.getByText('A hidden valley of moonlit rivers.').waitFor();
    await card.getByText('Silver Vale').waitFor();
    await card.getByText('Place').waitFor();
    await card.getByText('Canon').waitFor();
    await app.screenshot('wiki-hovercard');

    await page.locator('h1').hover();
    await card.waitFor({ state: 'hidden' });

    // The way the write module highlights a name in the manuscript.
    await page.evaluate(() => {
      const mark = document.createElement('mark');
      mark.id = 'injected';
      mark.textContent = 'Morn';
      mark.dataset.wikiTarget = 'No Such Page';
      document.querySelector('.wiki-footer').append(mark);
    });
    await page.locator('#injected').hover();
    await card.getByText('does not exist yet').waitFor();
    await page.locator('h1').hover();
    await card.waitFor({ state: 'hidden' });
  });

  it('lays out an article: contents, references, talk, long titles and empty pages', async () => {
    await start();
    const long = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'The lead comes first.' }] },
        ...Array.from({ length: 8 }, (_, i) => [
          { type: 'heading', attrs: { level: i % 2 === 0 ? 2 : 3 }, content: [{ type: 'text', text: `Section ${i + 1}` }] },
          ...Array.from({ length: 6 }, () => ({
            type: 'paragraph',
            content: [{ type: 'text', text: 'A paragraph long enough to fill some of the page and make it scroll a little further down. '.repeat(3) }],
          })),
        ]).flat(),
      ],
    };
    await rpc(page, 'pages.create', { title: 'Long Read', status: 'canon', content: long, categories: ['Reference'] });
    await openPage(page, 'Long Read');

    // Contents sits between the lead and the first heading.
    const contents = page.getByRole('navigation', { name: 'Contents' });
    await contents.waitFor();
    const order = await page.evaluate(() => {
      const prose = document.querySelector('.wiki-article .ProseMirror');
      return [...prose.children].slice(0, 3).map((el) => el.tagName + (el.className ? `.${el.className}` : ''));
    });
    assert.deepEqual(order, ['P', 'DIV.wiki-contents-host ProseMirror-widget', 'H2']);
    await contents.getByRole('link', { name: '1.1 Section 2' }).waitFor();
    await app.screenshot('wiki-article-read');

    // Its links scroll to the heading.
    await contents.getByRole('link', { name: /Section 7/ }).click();
    await waitUntil(
      () =>
        page.evaluate(() => {
          const heading = [...document.querySelectorAll('.ProseMirror h2')].find((h) => h.textContent === 'Section 7');
          const top = heading.getBoundingClientRect().top;
          return top >= 0 && top < 250;
        }),
      2000,
      'the heading to scroll into view',
    );

    // Collapses, and stays collapsed on the next page.
    await page.locator('main.content').evaluate((el) => el.scrollTo(0, 0));
    await contents.getByRole('button', { name: 'hide' }).click();
    assert.equal(await contents.getByRole('link').count(), 0);
    await contents.getByRole('button', { name: 'show' }).click();
    await contents.getByRole('link', { name: /Section 7/ }).waitFor();

    // Toggling to Edit keeps the reader's place and the same layout.
    await contents.getByRole('link', { name: /Section 5/ }).click();
    await page.waitForTimeout(100);
    await page.keyboard.press('Control+e');
    await editable(page).waitFor();
    await waitForBodyFocus(page);
    await waitUntil(
      () =>
        page.evaluate(() => {
          const heading = [...document.querySelectorAll('.ProseMirror h2')].find((h) => h.textContent === 'Section 5');
          const top = heading.getBoundingClientRect().top;
          return top >= 0 && top < 300;
        }),
      2000,
      'the same section to stay on screen',
    );
    await app.screenshot('wiki-article-edit-scrolled');
    await page.getByRole('toolbar', { name: 'Formatting' }).waitFor();
    assert.ok(
      await page.getByRole('toolbar', { name: 'Formatting' }).evaluate((el) => {
        const top = el.getBoundingClientRect().top;
        // Measured from the content area, which now starts below the tab strip.
        const contentTop = document.querySelector('main.content').getBoundingClientRect().top;
        return top >= contentTop && top < contentTop + 80;
      }),
      'the toolbar stays on screen',
    );

    // Arrow keys pass over the contents box, and typing near it works.
    await page.locator('main.content').evaluate((el) => el.scrollTo(0, 0));
    await editable(page).locator('p').first().click();
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.type('X');
    await waitUntil(
      async () => textOf((await pageByTitle(page, 'Long Read')).content).includes('Section 1X') || textOf((await pageByTitle(page, 'Long Read')).content).includes('XSection 1'),
      5000,
      'the cursor to reach the first heading',
    );
    await page.keyboard.press('Backspace');

    // References come from the text. Add one, and it appears, numbered, under the article.
    await editable(page).locator('p').first().click();
    await page.keyboard.press('End');
    await page.keyboard.press('Control+Shift+R');
    const dialog = page.getByRole('dialog', { name: 'Add a reference' });
    await dialog.waitFor();
    await page.keyboard.type('Annals of the Vale, p. 12');
    await page.keyboard.press('Enter');
    const references = page.getByRole('region', { name: 'References' });
    await references.getByText('Annals of the Vale, p. 12').waitFor();
    await waitForBodyFocus(page);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type(' More after.');
    await page.getByRole('button', { name: 'Add a reference' }).click();
    await dialog.waitFor();
    await page.keyboard.type('Second source');
    await page.keyboard.press('Enter');
    await references.getByText('Second source').waitFor();
    await waitUntil(
      async () => JSON.stringify((await pageByTitle(page, 'Long Read')).content).includes('Second source'),
      5000,
      'the reference to be stored',
    );

    await page.getByRole('button', { name: 'Change reference 2' }).click();
    await page.getByRole('dialog', { name: 'Edit reference' }).waitFor();
    await page.keyboard.type('Second source, revised');
    await page.keyboard.press('Enter');
    await references.getByText('Second source, revised').waitFor();
    await editable(page).locator('sup[data-reference]').first().dblclick();
    await page.getByRole('dialog', { name: 'Edit reference' }).waitFor();
    await page.keyboard.press('Escape');
    await waitUntil(
      async () => JSON.stringify((await pageByTitle(page, 'Long Read')).content).includes('Second source, revised'),
      5000,
      'the changed reference to be stored',
    );

    await tab(page, 'Read').click();
    await reading(page).locator('sup[data-reference]').first().click();
    await waitUntil(
      () => page.locator('#wiki-ref-0').evaluate((el) => {
        const box = el.getBoundingClientRect();
        return box.top >= 0 && box.bottom <= window.innerHeight;
      }),
      2000,
      'the citation to jump to its reference',
    );
    await app.screenshot('wiki-references');
    await page.getByRole('navigation', { name: 'Categories of this page' }).getByRole('link', { name: 'Reference' }).click();
    await page.getByRole('heading', { name: 'Category: Reference' }).waitFor();

    // Talk: stored in notes, separate from the article.
    await page.getByRole('link', { name: 'Long Read' }).click();
    await page.getByRole('heading', { name: 'Long Read', exact: true }).waitFor();
    await tab(page, 'Talk').click();
    const talk = page.locator('.wiki-talk .ProseMirror[contenteditable="true"]');
    await talk.click();
    await page.keyboard.type('Check the river name against book two.');
    await waitUntil(
      async () => JSON.stringify((await pageByTitle(page, 'Long Read')).notes ?? '').includes('Check the river name'),
      5000,
      'the note to be stored',
    );
    assert.equal(textOf((await pageByTitle(page, 'Long Read')).content).includes('Check the river name'), false);
    await app.screenshot('wiki-talk');
    await tab(page, 'Article').click();
    await tab(page, 'Talk').click();
    await page.locator('.wiki-talk').getByText('Check the river name against book two.').waitFor();

    // A very long title wraps, and nothing scrolls sideways.
    await newPage(page, 'Averylongtitlewithnospaces'.repeat(12), 0);
    await app.screenshot('wiki-long-title-edit');
    assert.ok(await page.locator('main.content').evaluate((el) => el.scrollWidth <= el.clientWidth), 'no sideways scroll while editing');
    await tab(page, 'Read').click();
    await page.getByText('This page is empty.').waitFor();
    await app.screenshot('wiki-long-title-read');
    assert.ok(await page.locator('main.content').evaluate((el) => el.scrollWidth <= el.clientWidth), 'no sideways scroll while reading');
    await page.getByRole('button', { name: 'Start writing' }).click();
    await waitForBodyFocus(page);
  });

  it('provides the special pages', async () => {
    await start();
    const make = (title, extra) => rpc(page, 'pages.create', { title, status: 'canon', ...extra });
    await make('Aria', { pageType: 'character', categories: ['Heroes', 'People'], content: linkDoc('the keep', 'Argent Keep') });
    await make('Bram', { pageType: 'character', categories: ['People'], status: 'draft', content: doc('One two three four five six seven eight nine ten.') });
    await make('Silver Vale', { pageType: 'place', status: 'idea', content: linkDoc('Aria', 'Aria') });
    await make('Old Fort', { pageType: 'place' });
    await make('Gone Page', {});

    // All pages, with filters reflected in the route.
    await page.getByRole('navigation', { name: 'Wiki' }).getByRole('button', { name: 'All pages' }).click();
    await page.getByRole('heading', { name: 'All pages' }).waitFor();
    const rows = page.locator('.wiki-page-table tbody tr');
    await page.getByText('6 pages').waitFor();
    await app.screenshot('wiki-all-pages');
    await page.getByLabel('Type', { exact: true }).selectOption('character');
    await page.getByRole('heading', { name: 'Characters' }).waitFor();
    await page.getByText('2 pages').waitFor();
    await page.getByLabel('Status', { exact: true }).selectOption('draft');
    await page.getByText('1 page', { exact: true }).waitFor();
    assert.equal(await rows.first().getAttribute('data-page'), 'Bram');
    await page.getByLabel('Status', { exact: true }).selectOption('');
    await page.getByLabel('Type', { exact: true }).selectOption('');
    await page.getByLabel('Sort by').selectOption('words');
    await waitUntil(async () => (await rows.first().getAttribute('data-page')) === 'Main Page', 2000, 'the longest page first');
    await page.getByLabel('Sort by').selectOption('title');
    await page.getByLabel('Name', { exact: true }).fill('ver');
    await page.getByText('1 page', { exact: true }).waitFor();
    assert.equal(await rows.first().getAttribute('data-page'), 'Silver Vale');

    // The sidebar's page types go to the same filter.
    await page.getByRole('navigation', { name: 'Page types' }).getByRole('button', { name: /Places/ }).click();
    await page.getByRole('heading', { name: 'Places' }).waitFor();

    // Categories and a category page.
    await page.getByRole('navigation', { name: 'Wiki' }).getByRole('button', { name: 'Categories' }).click();
    await page.getByRole('heading', { name: 'Categories', exact: true }).waitFor();
    await page.getByRole('link', { name: 'People' }).click();
    await page.getByRole('heading', { name: 'Category: People' }).waitFor();
    await page.locator('.wiki-letter-group', { hasText: 'A' }).getByRole('link', { name: 'Aria' }).waitFor();
    await page.getByRole('link', { name: 'Bram' }).waitFor();
    await app.screenshot('wiki-category');

    // Recent changes, newest first.
    await page.getByRole('navigation', { name: 'Wiki' }).getByRole('button', { name: 'Recent changes' }).click();
    await page.getByRole('heading', { name: 'Recent changes' }).waitFor();
    await page.locator('.wiki-recent-list li').first().getByRole('link', { name: 'Gone Page' }).waitFor();
    await app.screenshot('wiki-recent');

    // Wanted, orphaned and short pages.
    await page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name: 'Wanted pages' }).click();
    await page.getByRole('heading', { name: 'Wanted pages' }).waitFor();
    await page.locator('.wiki-wanted-list a.wiki-link-red', { hasText: 'Argent Keep' }).waitFor();

    await page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name: 'Orphaned pages' }).click();
    await page.getByRole('heading', { name: 'Orphaned pages' }).waitFor();
    await page.locator('tr[data-page="Old Fort"]').waitFor();
    assert.equal(await page.locator('tr[data-page="Aria"]').count(), 0, 'Aria is linked from Silver Vale');

    await page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name: 'Short pages' }).click();
    await page.getByRole('heading', { name: 'Short pages' }).waitFor();
    await page.locator('tr[data-page="Bram"]').waitFor();
    assert.equal(await page.locator('tr[data-page="Main Page"]').count(), 0, 'the main page is not a stub');
    await page.getByLabel('Under this many words').fill('5');
    await page.locator('tr[data-page="Bram"]').waitFor({ state: 'hidden' });
    await page.locator('tr[data-page="Old Fort"]').waitFor();

    // Search, with highlighted snippets and a way to create what is missing.
    await page.keyboard.press('Control+f');
    assert.ok(await page.evaluate(() => document.activeElement?.classList.contains('top-search-input')));
    await page.keyboard.type('seven eight');
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Search results' }).waitFor();
    await page.locator('.wiki-search-hit', { hasText: 'Bram' }).locator('mark', { hasText: 'seven' }).waitFor();
    await page.getByText('There is no page called').waitFor();
    await app.screenshot('wiki-search');
    await page.keyboard.press('Control+l');
    await page.keyboard.type('nothingmatchesthis');
    await page.keyboard.press('Enter');
    await page.getByText('Nothing matches').waitFor();

    // Arrow keys choose a suggestion in the search box.
    await page.keyboard.press('Control+f');
    await page.keyboard.type('Sil');
    await page.getByRole('option', { name: /Silver Vale/ }).waitFor();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Silver Vale', exact: true }).waitFor();

    // Escape leaves the search box and goes back to the editor, cursor intact.
    await openPage(page, 'Old Fort');
    await page.keyboard.press('Control+e');
    await waitForBodyFocus(page);
    await page.keyboard.type('Before ');
    await page.keyboard.press('Control+l');
    assert.ok(await page.evaluate(() => document.activeElement?.classList.contains('top-search-input')));
    await page.keyboard.press('Escape');
    await waitForBodyFocus(page);
    await page.keyboard.type('after.');
    await waitForStoredText(page, 'Old Fort', 'Before after.');

    // Random page goes somewhere else each time.
    await page.getByRole('navigation', { name: 'Wiki' }).getByRole('button', { name: 'Random page' }).click();
    await waitUntil(async () => (await page.locator('h1.wiki-title').innerText()) !== 'Old Fort', 2000, 'another page');

    // The sidebar starts a new page too.
    await page.getByRole('navigation', { name: 'Wiki' }).getByRole('button', { name: 'New page' }).click();
    await page.getByRole('dialog', { name: 'New page' }).waitFor();
    await page.keyboard.press('Escape');

    // Trash: move, restore, and delete permanently only after confirming.
    await openPage(page, 'Gone Page');
    await page.getByRole('button', { name: /More/ }).click();
    await page.getByRole('menuitem', { name: 'Move to trash…' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Move to trash' }).click();
    await page.getByRole('heading', { name: 'Main Page', exact: true }).waitFor();
    assert.equal(await pageByTitle(page, 'Gone Page'), null);

    await goTo(page, 'Trash');
    await page.getByRole('heading', { name: 'Trash' }).waitFor();
    await page.getByRole('button', { name: 'Restore Gone Page' }).click();
    await page.getByText('The trash is empty.').waitFor();
    assert.ok(await pageByTitle(page, 'Gone Page'));

    // The shortcut trashes the page on screen, and Undo in the toast brings it back and opens it.
    await openPage(page, 'Gone Page');
    // In the top search box, keys that edit text still edit it, and the global shortcut still runs.
    const search = page.getByRole('combobox', { name: 'Search this project' });
    await search.click();
    await search.fill('one two');
    await page.keyboard.press('Control+Backspace');
    assert.equal(await search.inputValue(), 'one ', 'Ctrl+Backspace deletes a word in the search box');
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    assert.equal(await search.inputValue(), '', 'Ctrl+A selects the search text');
    await page.keyboard.type('Gone');
    await page.keyboard.press('Control+Shift+Delete');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Move to trash' }).click();
    await page.getByRole('heading', { name: 'Main Page', exact: true }).waitFor();
    assert.equal(await pageByTitle(page, 'Gone Page'), null);
    await page.locator('.toast', { hasText: 'Moved “Gone Page” to the trash.' }).last().getByRole('button', { name: 'Undo' }).click();
    await page.locator('h1.wiki-title', { hasText: 'Gone Page' }).waitFor();
    assert.ok(await pageByTitle(page, 'Gone Page'), 'Undo restores the page');
    await goTo(page, 'Trash');
    await page.getByRole('heading', { name: 'Trash' }).waitFor();

    // A trashed page can be read, and restored from where it is shown.
    await rpc(page, 'pages.delete', { id: (await pageByTitle(page, 'Gone Page')).id });
    await page.getByRole('link', { name: 'Gone Page' }).click();
    await page.getByRole('note').getByText('in the trash').waitFor();
    assert.equal(await tab(page, 'Edit').count(), 0, 'a trashed page cannot be edited');
    await app.screenshot('wiki-trashed-page');
    await page.getByRole('note').getByRole('button', { name: 'Restore' }).click();
    await tab(page, 'Edit').waitFor();
    assert.equal(await page.getByText('in the trash').count(), 0);
    await goTo(page, 'Trash');
    await page.getByRole('heading', { name: 'Trash' }).waitFor();

    const again = await pageByTitle(page, 'Gone Page');
    await rpc(page, 'pages.delete', { id: again.id });
    await page.getByRole('button', { name: 'Delete Gone Page permanently' }).click();
    const confirm = page.getByRole('alertdialog');
    await confirm.getByText('cannot be undone').waitFor();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    assert.equal((await rpc(page, 'pages.list', { deleted: true })).length, 1, 'cancelling keeps it');
    await page.getByRole('button', { name: 'Delete Gone Page permanently' }).click();
    await confirm.getByRole('button', { name: 'Delete permanently' }).click();
    await page.getByText('The trash is empty.').waitFor();
    assert.equal((await rpc(page, 'pages.list', { deleted: true })).length, 0);
    await app.screenshot('wiki-trash');

    // The main page cannot be trashed.
    await page.getByRole('navigation', { name: 'Wiki' }).getByRole('button', { name: 'Main page' }).click();
    await page.getByRole('heading', { name: 'Main Page', exact: true }).waitFor();
    await page.getByRole('button', { name: /More/ }).click();
    assert.ok(await page.getByRole('menuitem', { name: 'Move to trash…' }).isDisabled());
    await page.keyboard.press('Escape');
  });

  it('has working menu entries and works with only the keyboard', async () => {
    await start();
    await rpc(page, 'pages.create', { title: 'Keyboard Page', status: 'canon', content: linkDoc('the wanted one', 'Wanted One') });

    await page.getByRole('menuitem', { name: 'Tools' }).click();
    await page.getByRole('menuitem', { name: 'Wanted pages' }).click();
    await page.getByRole('heading', { name: 'Wanted pages' }).waitFor();
    await page.getByRole('menuitem', { name: 'View' }).click();
    await page.getByRole('menuitem', { name: 'All pages' }).click();
    await page.getByRole('heading', { name: 'All pages' }).waitFor();
    await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Find and replace…' }).click();
    await page.getByRole('heading', { name: 'Find and replace' }).waitFor();

    // The menus work from the keyboard: Alt or F10, the arrow keys, Enter and Escape.
    const focused = () => page.evaluate(() => document.activeElement?.textContent ?? '');
    await page.keyboard.press('F10');
    assert.equal(await focused(), 'File');
    await page.keyboard.press('ArrowRight');
    assert.equal(await focused(), 'Edit');
    await page.keyboard.press('ArrowDown');
    await page.getByRole('menu', { name: 'Edit' }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('menu').waitFor({ state: 'detached' });
    assert.equal(await focused(), 'Edit');
    await page.keyboard.press('Escape');
    assert.notEqual(await page.evaluate(() => document.activeElement?.closest('[role="menubar"]') !== null), true);
    await page.keyboard.press('Alt');
    assert.equal(await focused(), 'File');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await focused(), 'Help');
    await page.keyboard.press('Enter');
    await page.getByRole('menu', { name: 'Help' }).waitFor();
    for (let i = 0; i < 6 && !(await focused()).startsWith('Keyboard shortcuts'); i += 1) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.getByRole('dialog', { name: /Keyboard shortcuts/ }).waitFor();
    await page.keyboard.press('Escape');

    // Tab from the search box's page into the article, follow a link with Enter.
    await page.keyboard.press('Control+f');
    await page.keyboard.type('Keyboard Page');
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Keyboard Page', exact: true }).waitFor();
    const activeRole = () => page.evaluate(() => document.activeElement?.getAttribute('role'));
    for (let i = 0; i < 12 && (await activeRole()) !== 'link'; i += 1) await page.keyboard.press('Tab');
    assert.equal(await activeRole(), 'link', 'Tab reaches links in the article');
    await page.keyboard.press('Enter');
    // Following a red link creates its page and puts the cursor in the body.
    await waitForBodyFocus(page);
    await page.getByRole('textbox', { name: 'Page title' }).waitFor();
    assert.ok(await pageByTitle(page, 'Wanted One'));

    // The More menu opens and moves with the arrow keys.
    await page.keyboard.press('Control+e');
    await tab(page, 'Read').and(page.locator('.is-active')).waitFor();
    await page.getByRole('button', { name: /More/ }).focus();
    await page.keyboard.press('ArrowDown');
    await page.getByRole('menu').waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Rename…F2');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Rename everywhere…');
    await page.keyboard.press('Escape');
    await page.getByRole('menu').waitFor({ state: 'hidden' });

    // Tab stays inside a dialog.
    await page.keyboard.press('Control+n');
    await page.getByRole('dialog', { name: 'New page' }).waitFor();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Cancel');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'INPUT');
    await page.keyboard.press('Escape');
  });

  it('works in every theme and follows both text-size settings', async () => {
    await start();
    await rpc(page, 'pages.create', {
      title: 'Aria Vale',
      pageType: 'character',
      status: 'retconned',
      summary: 'A ranger of the north.',
      aliases: ['The Ranger'],
      categories: ['Heroes'],
      infobox: {
        fields: [
          { key: 'born', label: 'Born', kind: 'date', value: 'Year 312' },
          { key: 'location', label: 'Home', kind: 'page', value: 'Silver Vale' },
        ],
      },
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Aria Vale is a ranger from ' },
              { type: 'text', text: 'the Silver Vale', marks: [{ type: 'wikiLink', attrs: { target: 'Silver Vale' } }] },
              { type: 'text', text: '.' },
              { type: 'reference', attrs: { text: 'Annals of the Vale' } },
            ],
          },
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Early life' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Born in the north.' }] },
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Later life' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Went south.' }] },
        ],
      },
    });
    await openPage(page, 'Aria Vale');
    await page.getByRole('note').getByText('retconned').waitFor();

    const setTheme = (theme, mode) =>
      page.evaluate(([t, m]) => {
        document.documentElement.dataset.theme = t;
        document.documentElement.dataset.mode = m;
      }, [theme, mode]);
    for (const [theme, mode] of [['encyclopedia', 'dark'], ['encyclopedia', 'light'], ['parchment', 'dark'], ['parchment', 'light'], ['typewriter', 'light'], ['midnight', 'dark']]) {
      await setTheme(theme, mode);
      await app.screenshot(`wiki-theme-read-${theme}-${mode}`);
    }
    await page.keyboard.press('Control+e');
    await editable(page).waitFor();
    for (const [theme, mode] of [['encyclopedia', 'dark'], ['encyclopedia', 'light'], ['parchment', 'light'], ['midnight', 'dark']]) {
      await setTheme(theme, mode);
      await app.screenshot(`wiki-theme-edit-${theme}-${mode}`);
    }
    await setTheme('encyclopedia', 'dark');
    await page.keyboard.press('Control+e');
    await tab(page, 'Read').and(page.locator('.is-active')).waitFor();

    const sizes = () =>
      page.evaluate(() => ({
        article: parseFloat(getComputedStyle(document.querySelector('.wiki-article')).fontSize),
        title: parseFloat(getComputedStyle(document.querySelector('.wiki-title')).fontSize),
        infobox: parseFloat(getComputedStyle(document.querySelector('.wiki-infobox')).fontSize),
        tab: parseFloat(getComputedStyle(document.querySelector('.wiki-tab')).fontSize),
        sidebar: parseFloat(getComputedStyle(document.querySelector('.nav-link')).fontSize),
      }));
    const initial = await sizes();
    await page.keyboard.press('Control+=');
    await waitUntil(async () => (await sizes()).article > initial.article, 2000, 'larger writing text');
    const bigger = await sizes();
    assert.ok(bigger.title > initial.title, 'the title follows the text size');
    assert.ok(bigger.infobox > initial.infobox, 'the infobox follows the text size');
    assert.equal(bigger.tab, initial.tab, 'the tabs keep their size');
    await page.keyboard.press('Control+0');
    await waitUntil(async () => (await sizes()).article === initial.article, 2000, 'the text size to reset');

    await page.keyboard.press('Control+Shift+=');
    await waitUntil(async () => (await sizes()).sidebar > initial.sidebar, 2000, 'a larger interface');
    const ui = await sizes();
    assert.ok(ui.tab > initial.tab, 'the tabs follow the interface size');
    assert.equal(ui.article, initial.article, 'the article keeps its size');
    assert.equal(ui.title, initial.title, 'the title keeps its size');
    await page.keyboard.press('Control+Shift+0');
  });

  it('stays responsive with 500 pages and a very long article', async () => {
    await start();
    const many = 500;
    let last = null;
    const seedStart = Date.now();
    for (let i = 0; i < many; i += 1) {
      last = await rpc(page, 'pages.create', {
        title: `World page ${String(i).padStart(3, '0')}`,
        pageType: i % 2 ? 'character' : 'place',
        status: 'canon',
        categories: [`Group ${i % 7}`],
        content: doc(`Text of page ${i}.`),
      });
    }
    console.log(`[perf] seeded ${many} pages through pages.create in ${Date.now() - seedStart} ms`);

    const timed = async (label, action) => {
      const started = Date.now();
      await action();
      const ms = Date.now() - started;
      console.log(`[perf] ${label}: ${ms} ms`);
      return ms;
    };

    await page.getByRole('navigation', { name: 'Wiki' }).getByRole('button', { name: 'All pages' }).click();
    await timed('All pages with 500 pages', async () => {
      await page.locator('tr[data-page="World page 000"]').waitFor();
    });
    await page.getByText('501 pages').waitFor();
    assert.equal(await page.locator('.wiki-page-table tbody tr').count(), 200, 'a long list is shown in steps');
    await page.getByRole('button', { name: /Show 200 more/ }).click();
    assert.equal(await page.locator('.wiki-page-table tbody tr').count(), 400);

    await openPage(page, 'World page 250');
    await page.keyboard.press('Control+e');
    await waitForBodyFocus(page);
    await page.keyboard.press('Control+End');
    await timed('[[ autocomplete across 500 titles', async () => {
      await page.keyboard.type(' [[world page 49');
      await page.getByRole('option', { name: 'World page 490' }).waitFor();
    });
    await page.keyboard.press('Enter');
    await waitForStoredText(page, 'World page 250', 'World page 490');

    // A very long article: about 100,000 words.
    const paragraphs = Array.from({ length: 2500 }, (_, i) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: `Paragraph ${i} `.padEnd(240, 'word ') }],
    }));
    const headings = paragraphs.flatMap((p, i) => (i % 100 === 0 ? [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: `Part ${i / 100}` }] }, p] : [p]));
    const big = await rpc(page, 'pages.create', { title: 'Very Long Article', status: 'canon', content: { type: 'doc', content: headings } });
    console.log(`[perf] very long article: ${big.wordCount} words`);
    await searchBox(page).fill('Very Long Article');
    await page.keyboard.press('Enter');
    await timed('opening the very long article', async () => {
      await reading(page).getByText('Paragraph 2499').waitFor();
    });
    await page.keyboard.press('Control+e');
    await waitForBodyFocus(page);
    await page.keyboard.press('Control+Home');
    const typing = await timed('typing 30 characters into the very long article', async () => {
      await page.keyboard.type('Typing at the top of the page ');
    });
    assert.ok(typing < 15000, 'typing keeps up');
    await timed('autosaving the very long article', async () => {
      await waitForStoredText(page, 'Very Long Article', 'Typing at the top of the page');
    });

    await timed('history tab', async () => {
      await tab(page, 'History').click();
      await page.getByRole('button', { name: /^Compare/ }).first().click();
      await page.getByRole('region', { name: 'Comparison' }).locator('ins').first().waitFor();
    });

    await timed('find and replace preview', async () => {
      await page.keyboard.press('Control+Shift+F');
      await page.getByLabel('Find', { exact: true }).fill('Text of page');
      await page.getByLabel('Find', { exact: true }).press('Enter');
      await page.getByText('500 matches in 500 documents').waitFor();
    });
    assert.ok(last);
  });

  it('builds a 50-page world through the real interface, quickly', async () => {
    await start('Fifty');
    const TYPES = ['Blank article', 'Character', 'Place', 'Faction', 'Item', 'Event', 'Concept', 'Species', 'Culture', 'Organization'];
    const started = Date.now();
    let previous = 'Main Page';
    for (let i = 1; i <= 50; i += 1) {
      const title = `${TYPES[i % TYPES.length].split(' ').pop()} ${i}`;
      await newPage(page, title, 1);
      // A lead sentence with a link made through [[ autocomplete, as a person would write it.
      await page.keyboard.type(`${title} is connected to [[${previous}`);
      await page.keyboard.press('Enter');
      await page.keyboard.type(' in some way.');
      previous = title;
    }
    const elapsed = Date.now() - started;
    console.log(`[perf] built 50 pages through the UI in ${elapsed} ms (${Math.round(elapsed / 50)} ms per page)`);

    await waitForStoredText(page, previous, 'in some way.');
    const titles = await rpc(page, 'pages.titles');
    assert.equal(titles.length, 51);
    const types = new Set(titles.map((t) => t.pageType));
    assert.equal(types.size, TYPES.length + 1, 'every template was used');
    assert.deepEqual(await rpc(page, 'pages.wanted'), []);
    const orphans = await rpc(page, 'pages.orphans');
    assert.deepEqual(orphans.map((p) => p.title), [previous], 'only the newest page has nothing linking to it');
    const sample = await pageByTitle(page, titles[10].title);
    assert.ok(sample.wordCount > 0);
    assert.ok(elapsed < 120_000, `50 pages took ${elapsed} ms`);
  });
});
