/**
 * Facts that change during the story, in the real app: adding a change, reading its history,
 * looking at the infobox as of a chapter, seeing who is here in a scene, ordering dates with a
 * custom calendar, and all of that surviving a save and reopen.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { allowPath, createProject, createWorkspace, launch, rpc, waitUntil } from './harness.mjs';

const dateField = (key, label, value) => ({ key, label, kind: 'date', value });
const textField = (key, label, value) => ({ key, label, kind: 'text', value });

async function openArea(page, label) {
  await page.locator('.area-tabs').getByRole('button', { name: label, exact: true }).click();
}

async function openPage(page, title) {
  await page.getByRole('combobox', { name: 'Search this project' }).fill(title);
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
}

const fieldRow = (page, key) => page.locator(`.wiki-infobox tr[data-field="${key}"]`);
const editRow = (page, key) => page.locator(`.wiki-ibe-row[data-key="${key}"]`);

function savedState(page) {
  return page.getByTestId('save-state').innerText();
}

async function saveAndReopen(page, workspace, name) {
  const path = workspace.file(`${name}.lorecraft`);
  await allowPath(page, path);
  await rpc(page, 'project.saveAs', { path });
  await rpc(page, 'project.close');
  await page.getByRole('heading', { name: 'LoreCraft' }).waitFor();
  await rpc(page, 'project.open', { path });
  await page.locator('.topbar').waitFor();
}

async function storedField(page, title, key) {
  const stored = await rpc(page, 'pages.getByTitle', { title });
  return stored.infobox.fields.find((f) => f.key === key);
}

async function waitForStoredChange(page, title, key, matches) {
  await waitUntil(
    async () => matches((await storedField(page, title, key))?.changes ?? []),
    5000,
    `a change to ${key} to be stored`,
  );
}

/** Opens the calendar settings and enters months, from the timeline's own button. */
async function setCalendarInSettings(page, months) {
  await openArea(page, 'Atlas');
  await page.getByRole('button', { name: 'Era settings' }).first().click();
  await page.getByRole('heading', { name: 'Era settings' }).waitFor();
  for (const [index, [name, days]] of months.entries()) {
    await page.getByRole('button', { name: 'Add month' }).click();
    await page.getByRole('textbox', { name: `Name of month ${index + 1}` }).fill(name);
    await page.getByRole('textbox', { name: `Days in month ${index + 1}` }).fill(String(days));
  }
}

/** The story: a character born late in a year, and chapters either side of her changes. */
async function seedStory(page) {
  const [book] = await rpc(page, 'books.list');
  const rows = await rpc(page, 'nodes.tree', { bookId: book.id });
  const firstScene = rows.find((n) => n.kind === 'scene');
  const scene = async (chapterTitle, title, storyDate) => {
    const chapter = await rpc(page, 'nodes.create', { bookId: book.id, kind: 'chapter', title: chapterTitle });
    const made = await rpc(page, 'nodes.create', { bookId: book.id, parentId: chapter.id, kind: 'scene', title });
    await rpc(page, 'nodes.update', { id: made.id, patch: { storyDate } });
    return made;
  };
  await rpc(page, 'nodes.update', { id: firstScene.id, patch: { title: 'Opening', storyDate: '3 Thawing 312' } });
  const dye = await scene('Chapter 10', 'The Dye', '15 Frostmoot 312');
  const later = await scene('Chapter 11', 'Later', '20 Frostmoot 312');
  const afterward = await scene('Chapter 12', 'Afterward', 'Thawing 330');
  // Told last, but it happens first.
  const flashback = await scene('Chapter 13', 'Flashback', '1 Frostmoot 300');
  const undated = await scene('Chapter 14', 'Undated', '');
  const aria = await rpc(page, 'pages.create', {
    title: 'Aria Vale',
    pageType: 'character',
    infobox: {
      fields: [
        dateField('born', 'Born', '20 Frostmoot 290'),
        dateField('died', 'Died', '320'),
        textField('hair', 'Hair', 'blonde'),
        textField('rank', 'Rank', 'Squire'),
      ],
    },
  });
  for (const made of [firstScene, dye, later, afterward, flashback, undated]) {
    await rpc(page, 'nodes.update', { id: made.id, patch: { povPageId: aria.id } });
  }
  // In one scene's cast, and not its point of view.
  const bram = await rpc(page, 'pages.create', {
    title: 'Bram Reed',
    pageType: 'character',
    infobox: { fields: [dateField('born', 'Born', '300'), textField('hair', 'Hair', 'red')] },
  });
  await rpc(page, 'nodes.setCast', { id: dye.id, pageIds: [bram.id] });
  await rpc(page, 'pages.create', {
    title: 'Midwinter Feast',
    pageType: 'event',
    infobox: { fields: [dateField('date', 'Date', '312-01-20')] },
  });
  return { book, firstScene, dye, later, afterward, flashback, aria };
}

const here = (page) => page.getByTestId('whos-here').locator('[data-person="Aria Vale"]');
const fact = (page, name) => here(page).locator(`[data-fact="${name}"]`);

async function openScene(page, title) {
  await page.getByRole('treeitem', { name: new RegExp(`^${title},`) }).click();
  await waitUntil(
    async () => (await page.locator('.scene-details').count()) > 0,
    5000,
    'the scene details',
  );
  await here(page).waitFor();
}

async function expectFact(page, name, pattern) {
  await waitUntil(
    async () => {
      const element = fact(page, name);
      return (await element.count()) > 0 && pattern.test(await element.innerText());
    },
    5000,
    `${name} to match ${pattern}, and it says "${await fact(page, name).innerText().catch(() => 'nothing')}"`,
  );
}

async function timelineTitles(page) {
  return page.locator('[data-timeline-item]').evaluateAll((rows) =>
    rows.map((row) => `${row.querySelector('.tl-date')?.textContent}|${row.querySelector('.tl-title')?.textContent}|${row.querySelector('.tl-detail')?.textContent}`),
  );
}

describe('facts that change during the story', () => {
  let workspace;
  let app;

  beforeEach(() => {
    workspace = createWorkspace();
  });

  afterEach(async (t) => {
    if (t.passed === false && app && !app.exited) await app.screenshot('facts-last-failure').catch(() => {});
    if (app && !app.exited) await app.kill().catch(() => {});
    workspace.cleanup();
  });

  async function start() {
    app = await launch(workspace);
    const { page } = app;
    page.setDefaultTimeout(12_000);
    app.problems = [];
    page.on('pageerror', (e) => app.problems.push(e.message));
    await createProject(page, 'Facts World');
    return page;
  }

  it('keeps a change, its history, the as-of view, scene facts and calendar dates through a reopen', async () => {
    const page = await start();
    await openArea(page, 'Write');
    await page.locator('.ProseMirror[contenteditable="true"]').waitFor();

    // ---- A custom calendar, through its settings.
    await setCalendarInSettings(page, [['Thawing', 30], ['Greenmoot', 31], ['Frostmoot', 30]]);
    await page.getByRole('textbox', { name: 'Try a date' }).fill('15 Frostmoot 312');
    await page.getByText('Sorts at 312.0315. Reads as 15 Frostmoot 312.').waitFor();
    await page.getByRole('textbox', { name: 'Try a date' }).fill('31 Frostmoot 312');
    await page.getByText('Frostmoot has 30 days').waitFor();
    await app.screenshot('facts-calendar-settings');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('heading', { name: 'Era settings' }).waitFor({ state: 'detached' });
    assert.deepEqual(JSON.parse(await rpc(page, 'project.getMeta', { key: 'calendar' })), {
      months: [{ name: 'Thawing', days: 30 }, { name: 'Greenmoot', days: 31 }, { name: 'Frostmoot', days: 30 }],
    });

    const { aria } = await seedStory(page);

    // ---- Adding a change tied to a scene, by hand.
    await openArea(page, 'Wiki');
    await openPage(page, 'Aria Vale');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await editRow(page, 'hair').waitFor();
    await page.getByLabel('Changes during the story to Hair').click();
    await page.getByRole('button', { name: 'Add a change to Hair' }).click();
    const sceneChoice = page.getByRole('combobox', { name: 'Scene of change 1 to Hair' });
    assert.ok(await sceneChoice.evaluate((el) => el === document.activeElement), 'a new change is ready to fill in');
    await sceneChoice.selectOption({ label: 'The Dye' });
    await page.getByRole('textbox', { name: 'New value of change 1 to Hair' }).fill('black');
    await page.getByRole('textbox', { name: 'Note on change 1 to Hair' }).fill('Dyed it to hide');
    await waitForStoredChange(page, 'Aria Vale', 'hair', (c) => c[0]?.value === 'black' && c[0]?.note === 'Dyed it to hide');
    assert.deepEqual(Object.keys((await storedField(page, 'Aria Vale', 'hair')).changes[0]).sort(), ['nodeId', 'note', 'value'], 'nothing empty is stored');
    await app.screenshot('facts-editor');

    // ---- And one tied only to a date, which is flagged until it is a real date.
    await page.getByLabel('Changes during the story to Rank').click();
    await page.getByRole('button', { name: 'Add a change to Rank' }).click();
    await page.getByRole('textbox', { name: 'New value of change 1 to Rank' }).fill('Knight');
    await editRow(page, 'rank').getByText('Give this a scene or a date').waitFor();
    await page.getByRole('textbox', { name: 'In-world date of change 1 to Rank' }).fill('15 Frostmot 312');
    await editRow(page, 'rank').getByText('"Frostmot" is not a month').waitFor();
    await page.getByRole('textbox', { name: 'In-world date of change 1 to Rank' }).fill('18 Frostmoot 312');
    await waitForStoredChange(page, 'Aria Vale', 'rank', (c) => c[0]?.date === '18 Frostmoot 312' && c[0]?.value === 'Knight');
    assert.equal((await storedField(page, 'Aria Vale', 'hair')).value, 'blonde', 'the starting value stays');

    // ---- The history, in plain words.
    await page.getByRole('button', { name: 'Read', exact: true }).click();
    await fieldRow(page, 'hair').waitFor();
    await waitUntil(
      async () => /blonde, then black from Chapter 10/.test(await fieldRow(page, 'hair').innerText()),
      5000,
      'the history of the hair',
    );
    assert.match(await fieldRow(page, 'hair').innerText(), /Dyed it to hide/);
    assert.match(await fieldRow(page, 'rank').innerText(), /Squire, then Knight from 18 Frostmoot 312/);
    await app.screenshot('facts-history');

    // ---- Saved, and then looking "as of" a chapter changes nothing in the project.
    const path = workspace.file('facts.lorecraft');
    await allowPath(page, path);
    await rpc(page, 'project.saveAs', { path });
    await waitUntil(async () => /All changes saved/.test(await savedState(page)), 5000, 'the saved state');
    const before = JSON.stringify((await rpc(page, 'pages.get', { id: aria.id })).infobox);

    const asOf = page.getByLabel('As of');
    await asOf.selectOption({ label: 'Chapter 1' });
    await waitUntil(async () => /^\s*Hair\s+blonde\s*$/.test(await fieldRow(page, 'hair').innerText()), 3000, 'blonde as of Chapter 1');
    assert.match(await fieldRow(page, 'rank').innerText(), /^\s*Rank\s+Squire\s*$/);
    await page.getByText('Shown as of the end of Chapter 1.').waitFor();
    assert.match(await fieldRow(page, 'age').innerText(), /^\s*Age\s+21\s*$/, 'her age as of then');
    assert.equal(await fieldRow(page, 'died').count(), 0, 'she has not died by then');
    await app.screenshot('facts-as-of-early');

    await asOf.selectOption({ label: 'Chapter 11' });
    await waitUntil(async () => /black\s+since Chapter 10/.test(await fieldRow(page, 'hair').innerText()), 3000, 'black as of Chapter 11');
    assert.doesNotMatch(await fieldRow(page, 'hair').innerText(), /blonde/);
    assert.match(await fieldRow(page, 'rank').innerText(), /Knight\s+since 18 Frostmoot 312/);
    assert.match(await fieldRow(page, 'age').innerText(), /22/);

    // Before her date-only change takes effect, even though the chapter after it is later.
    await asOf.selectOption({ label: 'Chapter 10' });
    await waitUntil(async () => /black/.test(await fieldRow(page, 'hair').innerText()), 3000, 'black as of Chapter 10');
    assert.match(await fieldRow(page, 'rank').innerText(), /^\s*Rank\s+Squire\s*$/);

    await asOf.selectOption({ label: 'Whole story' });
    await waitUntil(async () => /blonde, then black/.test(await fieldRow(page, 'hair').innerText()), 3000, 'the whole history again');
    assert.equal(await fieldRow(page, 'age').count(), 0, 'no age is typed in, and the whole story has none');
    assert.equal(await fieldRow(page, 'died').count(), 1);
    assert.equal(JSON.stringify((await rpc(page, 'pages.get', { id: aria.id })).infobox), before, 'nothing stored changed');
    assert.match(await savedState(page), /All changes saved/, 'the project is not dirty');

    // ---- The scene panel, before and after the change, with age by the calendar.
    await openArea(page, 'Write');
    await openScene(page, 'Opening');
    await expectFact(page, 'hair', /Hair\s+blonde/);
    await expectFact(page, 'rank', /Rank\s+Squire/);
    await expectFact(page, 'age', /^Age 21$/);
    await app.screenshot('facts-scene-before');

    await openScene(page, 'The Dye');
    await expectFact(page, 'hair', /Hair\s+black since Chapter 10/);
    await expectFact(page, 'rank', /Rank\s+Squire/);
    await expectFact(page, 'age', /^Age 21$/);
    const bram = page.getByTestId('whos-here').locator('[data-person="Bram Reed"]');
    await bram.waitFor();
    assert.match(await bram.innerText(), /Age 12/);
    assert.match(await bram.innerText(), /Hair\s+red/);
    assert.doesNotMatch(await bram.innerText(), /Point of view/);
    assert.match(await here(page).innerText(), /Point of view/);
    await app.screenshot('facts-scene-after');

    await openScene(page, 'Later');
    await page.getByTestId('whos-here').locator('[data-person="Bram Reed"]').waitFor({ state: 'detached' });
    await expectFact(page, 'hair', /black/);
    await expectFact(page, 'rank', /Rank\s+Knight since 18 Frostmoot 312/);
    await expectFact(page, 'age', /^Age 22$/);

    // A flashback told last sees the world as it then was.
    await openScene(page, 'Flashback');
    await expectFact(page, 'hair', /Hair\s+blonde/);
    await expectFact(page, 'age', /^Age 9$/);

    // Dead by then, so it says when rather than an age.
    await openScene(page, 'Afterward');
    await expectFact(page, 'age', /^Died in 320, aged 30$/);

    // The panel follows the scene's date as it is typed.
    const date = page.getByLabel('In-world date');
    await date.fill('1 Thawing 319');
    await expectFact(page, 'age', /^Age 28$/);
    await page.locator('.details-date-hint').waitFor({ state: 'detached' });
    await date.fill('the long winter');
    await page.locator('.details-date-hint').waitFor();
    await waitUntil(async () => (await fact(page, 'age').count()) === 0, 3000, 'no age to be guessed at');
    await page.getByTestId('whos-here').getByText('Give this scene an in-world date').waitFor();
    await date.fill('Thawing 330');
    await expectFact(page, 'age', /^Died in 320/);
    await waitUntil(
      async () => (await rpc(page, 'nodes.tree', { bookId: (await rpc(page, 'books.list'))[0].id })).find((n) => n.title === 'Afterward').storyDate === 'Thawing 330',
      3000,
      'the date to be stored',
    );

    // A scene with no date of its own still sees changes the story has reached, but no age.
    await openScene(page, 'Undated');
    await expectFact(page, 'rank', /Rank\s+Knight/);
    await waitUntil(async () => (await fact(page, 'age').count()) === 0, 3000, 'no age for a scene with no date');

    // The hover card in the manuscript says the same, as of the scene.
    await openScene(page, 'The Dye');
    await here(page).getByRole('button', { name: 'Aria Vale' }).hover();
    await page.getByTestId('hover-facts').waitFor();
    await waitUntil(
      async () => /Age 21\. Hair: black\. Rank: Squire\./.test(await page.getByTestId('hover-facts').innerText()),
      3000,
      'the hover card to give facts as of this scene',
    );
    await app.screenshot('facts-hover');
    await page.mouse.move(600, 600);

    // ---- What goes to the AI is true as of the open scene, and it is told what changed.
    await page.getByRole('button', { name: 'AI', exact: true }).click();
    await page.getByTestId('ai-pane').waitFor();
    await page.getByRole('textbox', { name: 'Message the AI' }).fill('What about Aria Vale?');
    await page.getByRole('tab', { name: 'What is sent' }).click();
    const aiFacts = async () => {
      const item = page.getByTestId('ai-context-item').filter({ has: page.locator('.ai-context-title', { hasText: 'Aria Vale' }) });
      await item.getByText('Show the text').click();
      return item.locator('pre').innerText();
    };
    const atDye = await aiFacts();
    assert.match(atDye, /Facts as of Chapter 10 \(scene 2 of 6 in reading order, in-world date 15 Frostmoot 312\):/);
    assert.match(atDye, /Hair: black\./);
    assert.match(atDye, /Changed during the story: blonde at first, then black from Chapter 10 \(Dyed it to hide\)/);
    assert.match(atDye, /Rank: Squire\. Later, and not yet true here: Knight from 18 Frostmoot 312\./);
    assert.match(atDye, /Age at this point: 21\./);
    await app.screenshot('facts-ai-context');
    await page.getByRole('button', { name: 'AI', exact: true }).click();
    await page.getByTestId('ai-pane').waitFor({ state: 'detached' });

    // ---- The timeline puts them all in order, by the calendar, and lists the changes.
    const checkTimeline = async () => {
      await openArea(page, 'Atlas');
      await page.locator('[data-timeline-item]').first().waitFor();
      const rows = await timelineTitles(page);
      const titled = rows.map((row) => row.split('|')[1]);
      const expected = ['Aria Vale', 'Flashback', 'Opening', 'Midwinter Feast', 'The Dye'];
      for (let i = 1; i < expected.length; i += 1) {
        assert.ok(titled.indexOf(expected[i - 1]) < titled.indexOf(expected[i]), `${expected[i - 1]} before ${expected[i]} in ${rows.join('\n')}`);
      }
      const dye = rows.findIndex((row) => row.includes('|The Dye|'));
      const later = rows.findIndex((row) => row.includes('|Later|'));
      const hair = rows.findIndex((row) => row.includes('Hair: black'));
      const rank = rows.findIndex((row) => row.includes('Rank: Knight'));
      assert.ok(hair >= 0 && rank >= 0, `the changes are listed in ${rows.join('\n')}`);
      assert.ok(rows[hair].startsWith('15 Frostmoot 312|'), `a scene's change takes its date: ${rows[hair]}`);
      assert.ok(dye < rank && rank < later, `18 Frostmoot falls between: ${rows.join('\n')}`);
      assert.equal(await page.getByTestId('timeline-unplaced').count(), 0, 'every date can be placed');
    };
    await checkTimeline();
    await app.screenshot('facts-timeline');

    // ---- All of it after saving and reopening.
    await saveAndReopen(page, workspace, 'facts-reopened');
    assert.ok((await rpc(page, 'project.getMeta', { key: 'calendar' })).includes('Frostmoot'));
    await checkTimeline();

    await openArea(page, 'Wiki');
    await openPage(page, 'Aria Vale');
    await waitUntil(
      async () => /blonde, then black from Chapter 10/.test(await fieldRow(page, 'hair').innerText().catch(() => '')),
      5000,
      'the history after reopening',
    );
    await page.getByLabel('As of').selectOption({ label: 'Chapter 1' });
    await waitUntil(async () => /^\s*Hair\s+blonde\s*$/.test(await fieldRow(page, 'hair').innerText()), 3000, 'the as-of view after reopening');

    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await editRow(page, 'hair').getByText('Changes during the story (1)').waitFor();

    await openArea(page, 'Write');
    await openScene(page, 'Opening');
    await expectFact(page, 'hair', /Hair\s+blonde/);
    await expectFact(page, 'age', /^Age 21$/);
    await openScene(page, 'Later');
    await expectFact(page, 'hair', /black/);
    await expectFact(page, 'age', /^Age 22$/);

    assert.deepEqual(app.problems, []);
  });

  it('counts a change to a page field as a link, and renaming follows it', async () => {
    const page = await start();
    await openArea(page, 'Wiki');
    const aria = await rpc(page, 'pages.create', {
      title: 'Aria Vale',
      pageType: 'character',
      infobox: { fields: [{ key: 'location', label: 'Home', kind: 'page', value: 'Silver Keep' }] },
    });
    await openPage(page, 'Aria Vale');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByLabel('Changes during the story to Home').click();
    await page.getByRole('button', { name: 'Add a change to Home' }).click();
    await page.getByRole('textbox', { name: 'In-world date of change 1 to Home' }).fill('312');
    await page.getByRole('combobox', { name: 'New value of change 1 to Home' }).fill('Dark Harbor');
    await waitForStoredChange(page, 'Aria Vale', 'location', (c) => c[0]?.value === 'Dark Harbor');
    await waitUntil(
      async () => (await rpc(page, 'pages.wanted')).some((w) => w.title === 'Dark Harbor'),
      5000,
      'the later value to be a wanted page',
    );

    const harbor = await rpc(page, 'pages.create', { title: 'Dark Harbor' });
    const back = await rpc(page, 'pages.backlinks', { id: harbor.id });
    assert.deepEqual(back.pages.map((p) => p.id), [aria.id]);

    await rpc(page, 'pages.rename', { id: harbor.id, newTitle: 'Bright Harbor' });
    const moved = await storedField(page, 'Aria Vale', 'location');
    assert.equal(moved.changes[0].value, 'Bright Harbor');
    assert.equal(moved.value, 'Silver Keep');
    assert.deepEqual(app.problems, []);
  });

  it('keeps changes when only the arrangement of fields changes', async () => {
    const page = await start();
    await openArea(page, 'Wiki');
    await rpc(page, 'pages.create', {
      title: 'Aria Vale',
      pageType: 'character',
      infobox: {
        fields: [
          textField('hair', 'Hair', 'blonde'),
          { ...textField('rank', 'Rank', 'Squire'), changes: [{ date: '312', value: 'Knight', note: 'After the siege' }] },
        ],
      },
    });
    await openPage(page, 'Aria Vale');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('button', { name: 'Arrange fields' }).click();
    await page.getByRole('button', { name: 'Move Rank up' }).click();
    await page.getByRole('button', { name: 'Done arranging' }).click();
    await waitUntil(async () => (await rpc(page, 'pages.getByTitle', { title: 'Aria Vale' })).infobox.fields[0].key === 'rank', 5000, 'the new order');
    assert.deepEqual((await storedField(page, 'Aria Vale', 'rank')).changes, [{ date: '312', value: 'Knight', note: 'After the siege' }]);

    // Removing every change leaves no trace of them.
    await page.getByLabel('Changes during the story to Rank').click();
    await page.getByRole('button', { name: 'Remove change 1 to Rank' }).click();
    await waitUntil(async () => !('changes' in (await storedField(page, 'Aria Vale', 'rank'))), 5000, 'the change to go');
    assert.deepEqual(app.problems, []);
  });
});
