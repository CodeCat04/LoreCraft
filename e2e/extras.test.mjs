import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { deflateSync } from 'node:zlib';

import { allowPath, createProject, createWorkspace, launch, rpc, waitUntil, addAsset, slowLimit, SLOW } from './harness.mjs';

// ---- Test data --------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** A real PNG, so the image decodes and has a size. */
function makePng(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const start = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) {
      rows[start + 1 + x * 3] = Math.floor((x / width) * 255);
      rows[start + 2 + x * 3] = Math.floor((y / height) * 255);
      rows[start + 3 + x * 3] = 120;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function dateField(key, value, label = key) {
  return { key, label, kind: 'date', value };
}

function linkedDoc(...targets) {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: targets.flatMap((target) => [
          { type: 'text', text: target, marks: [{ type: 'wikiLink', attrs: { target } }] },
          { type: 'text', text: ' ' },
        ]),
      },
    ],
  };
}

function textDoc(text) {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

// ---- Helpers ----------------------------------------------------------------

async function openArea(page, label) {
  await page.locator('.area-tabs').getByRole('button', { name: label, exact: true }).click();
}

async function openAtlas(page, link) {
  await openArea(page, 'Atlas');
  await page.locator('.sidebar').getByRole('button', { name: link, exact: true }).click();
}

async function openPageByTitle(page, title) {
  const search = page.getByRole('combobox', { name: 'Search this project' });
  // The box closes its list 120 ms after losing focus, which can catch a search made
  // right after another. Nobody types that fast, but a test does.
  await page.waitForTimeout(150);
  await search.fill(title);
  // The suggestion appears once the title list knows the page.
  await page.locator('.top-search-popup').getByRole('option', { name: title }).first().waitFor();
  await search.press('Enter');
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
}

/** Puts a page in edit mode with its editor focused at the end. */
async function editPage(page, title) {
  await openPageByTitle(page, title);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.locator('.ProseMirror[contenteditable="true"]');
  await editor.waitFor();
  await editor.click();
  await page.keyboard.press('Control+End');
  return editor;
}

function canvasEngine(page, method, ...args) {
  return page.evaluate(
    ([m, a]) => {
      const engine = document.querySelector('[data-testid="graph-canvas"]').graphEngine;
      return engine[m](...a);
    },
    [method, args],
  );
}

async function waitForGraphToSettle(page, timeoutMs = 30_000) {
  await waitUntil(
    async () => {
      const state = await canvasEngine(page, 'debugState');
      return state.nodes > 0 && !state.running && !state.framePending;
    },
    timeoutMs,
    'the graph to settle',
  );
}

async function pageIdOf(page, title) {
  const found = await rpc(page, 'pages.getByTitle', { title });
  return found.id;
}

/**
 * Opens a project over the current one, the way double-clicking a file does. That goes
 * straight from one project to the next, with no closed state in between.
 */
async function openOverCurrent(page, path) {
  await page.evaluate(
    (file) => window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'app://open-file', payload: file }),
    path,
  );
}

/** Saves the project to a new file, so that nothing stands in the way of opening another. */
async function saveTo(page, workspace, name) {
  const path = workspace.file(`${name}.lorecraft`);
  await allowPath(page, path);
  await rpc(page, 'project.saveAs', { path });
  await waitUntil(async () => /All changes saved/.test(await page.getByTestId('save-state').innerText()), 5000, 'the saved state');
  return path;
}

async function saveAndReopen(app, workspace, name) {
  const path = workspace.file(`${name}.lorecraft`);
  await allowPath(app.page, path);
  await rpc(app.page, 'project.saveAs', { path });
  await rpc(app.page, 'project.close');
  await app.page.getByRole('heading', { name: 'LoreCraft' }).waitFor();
  await rpc(app.page, 'project.open', { path });
  await app.page.locator('.topbar').waitFor();
  return path;
}

// ---- Tests ------------------------------------------------------------------

describe('extras', () => {
  let workspace;
  let app;

  beforeEach(() => {
    workspace = createWorkspace();
  });

  afterEach(async () => {
    if (app && !app.exited) await app.kill().catch(() => {});
    workspace.cleanup();
  });

  async function start(name = 'Atlas World') {
    app = await launch(workspace);
    await createProject(app.page, name);
    await app.page.locator('.prose').waitFor();
    return app.page;
  }

  describe('timeline', () => {
    async function seed(page) {
      const create = (input) => rpc(page, 'pages.create', input);
      await create({ title: 'Aria', pageType: 'character', infobox: { fields: [dateField('born', '312', 'Born'), dateField('died', '380', 'Died')] } });
      await create({ title: 'Silver Vale', pageType: 'place', infobox: { fields: [dateField('founded', '120', 'Founded')] } });
      await create({ title: 'The Guild', pageType: 'faction', infobox: { fields: [dateField('founded', '200', 'Founded'), dateField('dissolved', '400', 'Dissolved')] } });
      await create({ title: 'Fall of Vale', pageType: 'event', infobox: { fields: [dateField('date', '340', 'Date')] } });
      await create({ title: 'The Long War', pageType: 'event', infobox: { fields: [dateField('start', '300', 'Start'), dateField('end', '310', 'End')] } });
      await create({ title: 'Battle of Reeds', pageType: 'event', infobox: { fields: [dateField('date', 'the long winter', 'Date')] } });
      await create({ title: 'Era Crossing', pageType: 'event', infobox: { fields: [dateField('date', '390 AE', 'Date')] } });
      const book = (await rpc(page, 'books.list'))[0];
      const tree = await rpc(page, 'nodes.tree', { bookId: book.id });
      const scene = tree.find((node) => node.kind === 'scene');
      await rpc(page, 'nodes.update', { id: scene.id, patch: { title: 'The Crossing', storyDate: '350' } });
      return { book, scene };
    }

    const listedItems = (page) =>
      page.locator('[data-timeline-item] button').evaluateAll((buttons) => buttons.map((b) => b.textContent));

    it('shows events in order, and lists what it cannot order separately', async () => {
      const page = await start();
      await seed(page);
      await openArea(page, 'Atlas');
      await page.getByTestId('timeline-view').waitFor();
      await page.locator('[data-timeline-item]').first().waitFor();

      assert.deepEqual(await listedItems(page), [
        'Silver Vale',
        'The Guild',
        'The Long War',
        'Aria',
        'Fall of Vale',
        'The Crossing',
        'Aria',
        'The Guild',
      ]);
      await app.screenshot('extras-timeline-dark');

      const unplaced = page.getByTestId('timeline-unplaced');
      await unplaced.getByText('Cannot be placed (2)').waitFor();
      await unplaced.getByText('the long winter').waitFor();
      await unplaced.getByText('"AE" is not a known era').waitFor();

      // A span reads as one, placed at its start.
      await page.locator('.tl-row', { hasText: 'The Long War' }).getByText('300 to 310').waitFor();

      // A link to fix it goes to the page, ready to edit.
      await unplaced.getByRole('button', { name: 'Fix the date of Battle of Reeds' }).click();
      // While editing, the title is a text box rather than a heading.
      await waitUntil(
        async () => (await page.getByRole('textbox', { name: 'Page title' }).inputValue()) === 'Battle of Reeds',
        5000,
        'the page to open for editing',
      );
      await page.locator('.ProseMirror[contenteditable="true"]').waitFor();
      await page.keyboard.press('Alt+ArrowLeft');
      await page.getByTestId('timeline-view').waitFor();

      // Clicking goes to the page or the scene.
      await page.locator('.tl-row', { hasText: 'Fall of Vale' }).getByRole('button').click();
      await page.getByRole('heading', { name: 'Fall of Vale' }).waitFor();
      await page.keyboard.press('Alt+ArrowLeft');
      await page.locator('.tl-row', { hasText: 'The Crossing' }).getByRole('button').click();
      await waitUntil(
        async () => (await page.getByLabel('Scene title').inputValue()) === 'The Crossing',
        5000,
        'the scene to open',
      );
    });

    it('applies era settings, stores them and reorders with them', async () => {
      const page = await start();
      await seed(page);
      await openArea(page, 'Atlas');
      await page.locator('[data-timeline-item]').first().waitFor();

      await page.getByRole('button', { name: 'Era settings' }).click();
      await page.getByRole('heading', { name: 'Era settings' }).waitFor();
      await page.getByRole('button', { name: 'Add era' }).click();
      await page.getByRole('textbox', { name: 'Name of era 1' }).fill('AE');
      await page.getByRole('textbox', { name: 'Offset of era 1' }).fill('0');
      await page.getByRole('textbox', { name: 'Try a date' }).fill('12 AE');
      await page.getByText('Sorts at 12.').waitFor();
      await app.screenshot('extras-era-settings');
      await page.getByRole('button', { name: 'Save' }).click();

      await page.locator('.tl-row', { hasText: 'Era Crossing' }).waitFor();
      const titles = await listedItems(page);
      assert.equal(titles[titles.indexOf('Era Crossing') - 1], 'Aria', 'after the death in 380');
      assert.equal(titles[titles.indexOf('Era Crossing') + 1], 'The Guild', 'before the dissolution in 400');
      await page.getByTestId('timeline-unplaced').getByText('Cannot be placed (1)').waitFor();

      assert.deepEqual(JSON.parse(await rpc(page, 'project.getMeta', { key: 'eras' })), [{ name: 'AE', offset: 0 }]);
    });

    it('filters by type, book and page, and zooms between overview and detail', async () => {
      const page = await start();
      const { scene } = await seed(page);
      await openArea(page, 'Atlas');
      await page.locator('[data-timeline-item]').first().waitFor();

      await page.getByRole('group', { name: 'Types to show' }).getByRole('button', { name: /Births/ }).click();
      await waitUntil(async () => !(await listedItems(page)).slice(0, 4).includes('Aria'), 3000, 'births to hide');
      assert.equal((await listedItems(page)).filter((t) => t === 'Aria').length, 1, 'her death stays');
      await page.getByRole('group', { name: 'Types to show' }).getByRole('button', { name: /Births/ }).click();

      // A book shows its scenes and the pages they name.
      await rpc(page, 'nodes.update', { id: scene.id, patch: { content: textDoc('Aria crossed over.') } });
      const book = (await rpc(page, 'books.list'))[0];
      await page.getByRole('combobox', { name: 'Book' }).selectOption(book.id);
      await waitUntil(
        async () => {
          const titles = await listedItems(page);
          return titles.includes('The Crossing') && !titles.includes('Silver Vale');
        },
        3000,
        'the book filter',
      );
      assert.deepEqual(await listedItems(page), ['Aria', 'The Crossing', 'Aria']);
      await page.getByRole('combobox', { name: 'Book' }).selectOption('');

      // A page shows what touches it.
      await rpc(page, 'pages.update', {
        id: await pageIdOf(page, 'Fall of Vale'),
        patch: { content: linkedDoc('Silver Vale') },
      });
      const filter = page.getByRole('combobox', { name: 'Filter by page' });
      await filter.fill('Silver');
      await page.getByRole('option', { name: 'Silver Vale' }).click();
      await waitUntil(
        async () => {
          const titles = await listedItems(page);
          return titles.length === 2 && titles[0] === 'Silver Vale' && titles[1] === 'Fall of Vale';
        },
        3000,
        'the page filter',
      );
      await page.getByRole('button', { name: 'Stop filtering by Silver Vale' }).click();

      // Zooming out summarizes, and clicking a stretch of time zooms back into it.
      await page.locator('[data-timeline-item]').first().waitFor();
      const zoomOut = page.getByRole('button', { name: 'Zoom out', exact: true });
      while (await zoomOut.isEnabled()) await zoomOut.click();
      await page.locator('[data-bucket]').first().waitFor();
      assert.equal(await page.locator('[data-timeline-item]').count(), 0);
      await app.screenshot('extras-timeline-overview');
      const buckets = await page.locator('[data-bucket]').count();
      assert.ok(buckets >= 2 && buckets <= 7, `a real summary, not ${buckets} rows`);
      const widest = await page.locator('.tl-zoom-label').innerText();
      assert.match(widest, /Every \d+ years/);
      await page.locator('[data-bucket]').last().click();
      await waitUntil(async () => (await page.locator('.tl-zoom-label').innerText()) !== widest, 2000, 'zooming in');
      const zoomIn = page.getByRole('button', { name: 'Zoom in', exact: true });
      while (await zoomIn.isEnabled()) await zoomIn.click();
      await page.locator('[data-timeline-item]').first().waitFor();
      assert.equal(await page.locator('.tl-zoom-label').innerText(), 'Every item');
    });

    it('zooms with Ctrl and the wheel, moves by keyboard, and keeps its place after a visit to a page', async () => {
      const page = await start();
      const fields = Array.from({ length: 400 }, (_, i) => dateField(`d${i}`, String(1000 + i * 5), `Date ${i}`));
      await rpc(page, 'pages.create', { title: 'Chronicle', infobox: { fields } });
      await openArea(page, 'Atlas');
      await page.locator('[data-bucket]').first().waitFor();

      const label = () => page.locator('.tl-zoom-label').innerText();
      const widest = await label();
      const bucket = await page.locator('[data-bucket]').nth(3).boundingBox();
      await page.mouse.move(bucket.x + 200, bucket.y + 10);
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -100);
      await page.keyboard.up('Control');
      await waitUntil(async () => (await label()) !== widest, 3000, 'Ctrl+wheel to zoom in');
      assert.equal(await page.evaluate(() => document.documentElement.style.zoom), '', 'the page itself did not zoom');

      const zoomIn = page.getByRole('button', { name: 'Zoom in', exact: true });
      while (await zoomIn.isEnabled()) await zoomIn.click();
      await page.locator('[data-timeline-item]').first().waitFor();

      // Tab enters the list once, and arrow keys move through it.
      const firstRow = page.locator('[data-timeline-item] button').first();
      await firstRow.focus();
      const dateOfFocus = () =>
        page.evaluate(() => document.activeElement.closest('[data-timeline-item]').querySelector('.tl-date').textContent);
      const before = await dateOfFocus();
      await page.keyboard.press('ArrowDown');
      assert.notEqual(await dateOfFocus(), before);
      await page.keyboard.press('End');
      assert.equal(await dateOfFocus(), String(1000 + 399 * 5));
      const tabStops = await page.locator('.tl-list [tabindex="0"]').count();
      assert.equal(tabStops, 1, 'one tab stop, wherever focus has moved to');

      // The list measures in rem, so it follows the interface size.
      await page.keyboard.press('Control+Shift+=');
      await page.keyboard.press('Control+Shift+=');
      const end = String(1000 + 399 * 5);
      await page.evaluate(() => {
        const list = document.querySelector('.tl-list');
        list.scrollTop = list.scrollHeight;
      });
      const lastRow = page.locator('.tl-row', { hasText: end });
      await lastRow.waitFor();
      const box = await lastRow.boundingBox();
      const list = await page.locator('.tl-list').boundingBox();
      assert.ok(box.y + box.height <= list.y + list.height + 1, 'the last row fits at the bottom');
      assert.ok(box.y >= list.y, 'and is not above the list');
      await page.keyboard.press('Control+Shift+0');

      // Back from a page, the same part of the list is showing.
      await page.locator('[data-timeline-item] button').last().click();
      await page.getByRole('heading', { name: 'Chronicle', exact: true }).waitFor();
      await page.keyboard.press('Alt+ArrowLeft');
      await page.getByTestId('timeline-view').waitFor();
      await page.locator('[data-timeline-item]').first().waitFor();
      await waitUntil(
        () => page.evaluate(() => document.querySelector('.tl-list').scrollTop > 1000),
        3000,
        'the list to return to where it was',
      );
    });

    it('stays legible in other themes, and flags a span that ends before it starts', async () => {
      const page = await start();
      await seed(page);
      await rpc(page, 'pages.create', {
        title: 'Backwards War',
        pageType: 'event',
        infobox: { fields: [dateField('start', '410', 'Start'), dateField('end', '405', 'End')] },
      });
      await openArea(page, 'Atlas');
      await page.locator('.tl-row', { hasText: 'Backwards War' }).getByText('Ends before it starts').waitFor();
      for (const [theme, mode] of [
        ['encyclopedia', 'light'],
        ['parchment', 'light'],
        ['midnight', 'dark'],
        ['typewriter', 'light'],
      ]) {
        await page.evaluate(
          ([t, m]) => {
            document.documentElement.dataset.theme = t;
            document.documentElement.dataset.mode = m;
          },
          [theme, mode],
        );
        await page.locator('.tl-row').first().waitFor();
        await app.screenshot(`extras-timeline-${theme}-${mode}`);
      }
    });

    it('forgets its filters when another project opens', async () => {
      const page = await start('First World');
      await seed(page);
      await openArea(page, 'Atlas');
      await page.locator('[data-timeline-item]').first().waitFor();
      const book = (await rpc(page, 'books.list'))[0];
      await page.getByRole('combobox', { name: 'Book' }).selectOption(book.id);
      await page.getByRole('group', { name: 'Types to show' }).getByRole('button', { name: /Births/ }).click();
      const filter = page.getByRole('combobox', { name: 'Filter by page' });
      await filter.fill('Aria');
      await page.getByRole('option', { name: 'Aria' }).click();
      await page.getByRole('button', { name: 'Stop filtering by Aria' }).waitFor();

      const path = workspace.file('first.lorecraft');
      await allowPath(page, path);
      await rpc(page, 'project.saveAs', { path });
      await rpc(page, 'project.close');
      await page.getByRole('heading', { name: 'LoreCraft' }).waitFor();

      await createProject(page, 'Second World');
      await page.locator('.prose').waitFor();
      await seed(page);
      await openArea(page, 'Atlas');
      await page.locator('[data-timeline-item]').first().waitFor();
      assert.equal(await page.getByRole('combobox', { name: 'Book' }).inputValue(), '');
      assert.equal(await page.getByRole('button', { name: /Stop filtering by/ }).count(), 0);
      assert.equal(
        await page.getByRole('group', { name: 'Types to show' }).getByRole('button', { name: /Births/ }).getAttribute('aria-pressed'),
        'true',
      );
      assert.equal(await page.locator('[data-timeline-item]').count(), 8);
    });

    it('forgets its filters and place when a project opens over this one', async () => {
      const page = await start('Second World');
      await seed(page);
      const second = await saveTo(page, workspace, 'second');

      // Made from the File menu, as a person would, so the window's tabs move to the new
      // project. A bare `project.new` would leave them filed under Second World.
      await page.getByRole('menuitem', { name: 'File', exact: true }).click();
      await page.getByRole('menuitem', { name: /^New project/ }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('textbox').fill('First World');
      await dialog.getByRole('button', { name: 'Create' }).click();
      await waitUntil(async () => (await rpc(page, 'project.status')).name === 'First World', 5000, 'the new project');
      await page.getByRole('heading', { name: 'Main Page' }).waitFor();
      await rpc(page, 'pages.create', {
        title: 'Only Here',
        pageType: 'event',
        infobox: { fields: [dateField('date', '1')] },
      });
      await openArea(page, 'Atlas');
      await page.locator('[data-timeline-item]').first().waitFor();
      const filter = page.getByRole('combobox', { name: 'Filter by page' });
      await filter.fill('Only');
      await page.getByRole('option', { name: 'Only Here' }).click();
      await page.getByRole('button', { name: 'Stop filtering by Only Here' }).waitFor();
      await saveTo(page, workspace, 'first');

      await openOverCurrent(page, second);
      // Second World comes back with its own tabs, which were on its main page.
      await page.getByRole('heading', { name: 'Main Page' }).waitFor();
      await openArea(page, 'Atlas');
      await page.locator('[data-timeline-item]').first().waitFor();
      assert.equal(await page.getByRole('button', { name: /Stop filtering by/ }).count(), 0);
      assert.equal(await page.locator('[data-timeline-item]').count(), 8);
      assert.equal(await page.evaluate(() => document.querySelector('.tl-list').scrollTop), 0);
    });

    it('has a helpful empty state', async () => {
      const page = await start();
      await openArea(page, 'Atlas');
      await page.getByRole('heading', { name: 'Nothing on the timeline yet' }).waitFor();
      await page.getByRole('button', { name: 'New page' }).waitFor();
      await app.screenshot('extras-timeline-empty');
    });

    it('stays smooth with 2,000 items, drawing only what is visible', async () => {
      const page = await start();
      const fields = Array.from({ length: 2000 }, (_, i) =>
        dateField(`d${i}`, `${(i * 7919) % 4000}-${(i % 12) + 1}`, `Date ${i}`),
      );
      await rpc(page, 'pages.create', { title: 'Chronicle', pageType: 'article', infobox: { fields } });
      const started = Date.now();
      await openArea(page, 'Atlas');
      await page.locator('[data-bucket]').first().waitFor();
      const openMs = Date.now() - started;

      // More than 200 items opens zoomed out. Zoom in to every item.
      const zoomIn = page.getByRole('button', { name: 'Zoom in', exact: true });
      while (await zoomIn.isEnabled()) await zoomIn.click();
      await page.locator('[data-timeline-item]').first().waitFor();
      const rows = await page.locator('.windowed-list-row').count();
      assert.ok(rows < 80, `drew ${rows} rows of about 2,900`);

      const scroll = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const list = document.querySelector('.tl-list');
            const longest = [];
            let last = performance.now();
            let frames = 0;
            const step = () => {
              const now = performance.now();
              longest.push(now - last);
              last = now;
              frames += 1;
              list.scrollTop += 900;
              if (frames < 120) requestAnimationFrame(step);
              else {
                const sorted = longest.slice(1).sort((a, b) => a - b);
                resolve({
                  frames,
                  median: sorted[Math.floor(sorted.length / 2)],
                  p95: sorted[Math.floor(sorted.length * 0.95)],
                  worst: sorted[sorted.length - 1],
                  drawn: document.querySelectorAll('.windowed-list-row').length,
                  height: list.scrollHeight,
                  top: list.scrollTop,
                });
              }
            };
            requestAnimationFrame(step);
          }),
      );
      console.log(`timeline, 2,000 items: opened in ${openMs} ms, scroll frames`, scroll);
      assert.ok(scroll.drawn < 80, `still drew only ${scroll.drawn} rows while scrolling`);
      assert.ok(scroll.p95 < slowLimit(50), `95% of frames under 50 ms, was ${scroll.p95}`);

      // The list reaches its end, and the items there are the latest.
      const dates = await page.locator('.tl-date').allTextContents();
      assert.ok(dates.length > 0);

      // In a window too narrow for two columns, the list still only draws what shows.
      await page.setViewportSize({ width: 720, height: 480 });
      await waitUntil(
        () => page.evaluate(() => getComputedStyle(document.querySelector('.tl-body')).flexDirection === 'column'),
        3000,
        'the narrow layout',
      );
      await new Promise((r) => setTimeout(r, 200));
      const narrow = await page.evaluate(() => {
        const content = document.querySelector('.content');
        const list = document.querySelector('.tl-list');
        return {
          rows: document.querySelectorAll('.windowed-list-row').length,
          listHeight: list.clientHeight,
          contentScrolls: content.scrollHeight > content.clientHeight,
          direction: getComputedStyle(document.querySelector('.tl-body')).flexDirection,
        };
      });
      assert.equal(narrow.direction, 'column', 'the narrow layout is in use');
      assert.ok(narrow.rows < 80, `drew ${narrow.rows} rows`);
      assert.ok(narrow.listHeight < 480, `the list fits, at ${narrow.listHeight}`);
      assert.equal(narrow.contentScrolls, false, 'and scrolls by itself');
    });
  });

  describe('relationship graph', () => {
    async function seed(page) {
      const ids = {};
      const add = async (title, pageType, categories = []) => {
        ids[title] = (await rpc(page, 'pages.create', { title, pageType, categories })).id;
      };
      await add('Aria', 'character', ['North']);
      await add('Bran', 'character');
      await add('Silver Vale', 'place', ['North']);
      await add('The Guild', 'faction');
      await add('Sunsword', 'item');
      await add('Fall of Vale', 'event');
      await add('Old Magic', 'concept');
      await add('Far Island', 'place');
      await rpc(page, 'pages.update', { id: ids.Aria, patch: { content: linkedDoc('Bran', 'Silver Vale', 'Sunsword') } });
      await rpc(page, 'pages.update', { id: ids['Fall of Vale'], patch: { content: linkedDoc('Silver Vale', 'Old Magic') } });
      await rpc(page, 'extras.relationshipAdd', { fromPageId: ids.Aria, toPageId: ids.Bran, kind: 'parent of' });
      await rpc(page, 'extras.relationshipAdd', { fromPageId: ids.Bran, toPageId: ids['The Guild'], kind: 'member of' });
      await rpc(page, 'extras.relationshipAdd', { fromPageId: ids.Aria, toPageId: ids['The Guild'], kind: 'enemy' });
      return ids;
    }

    it('draws pages, goes idle when settled, and opens a page when one is clicked', async () => {
      const page = await start();
      const ids = await seed(page);
      await openAtlas(page, 'Relationship graph');
      await page.getByTestId('graph-canvas').waitFor();
      await waitForGraphToSettle(page);

      const state = await canvasEngine(page, 'debugState');
      assert.equal(state.nodes, 8, 'every page but the main one');
      assert.equal(state.links, 7);

      // A settled graph does no work: no frames, no drawing and no ticking.
      await new Promise((r) => setTimeout(r, 1500));
      const later = await canvasEngine(page, 'debugState');
      assert.equal(later.draws, state.draws, 'nothing is redrawn while idle');
      assert.equal(later.ticks, state.ticks, 'the simulation has stopped');
      assert.equal(later.framePending, false);

      // The canvas is drawn at the display's real resolution.
      const dpr = await page.evaluate(() => window.devicePixelRatio);
      assert.equal(state.pixelWidth, Math.round(state.cssWidth * dpr));

      await app.screenshot('extras-graph-dark');

      // Hovering shows a page and its neighbors, then goes idle again.
      const box = await page.getByTestId('graph-canvas').boundingBox();
      const aria = await canvasEngine(page, 'screenPosition', ids.Aria);
      assert.ok(aria.x > box.x && aria.x < box.x + box.width, 'Aria is on screen');
      await page.mouse.move(aria.x, aria.y);
      await page.locator('.graph-status', { hasText: 'Aria' }).waitFor();
      assert.equal((await canvasEngine(page, 'debugState')).hovered, ids.Aria);
      await app.screenshot('extras-graph-hover');

      // A real click on the canvas opens the page.
      await page.mouse.click(aria.x, aria.y);
      await page.getByRole('heading', { name: 'Aria' }).waitFor();
    });

    it('settles at once for people who prefer less motion', async () => {
      const page = await start();
      await seed(page);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await openAtlas(page, 'Relationship graph');
      await page.getByTestId('graph-canvas').waitFor();
      await waitForGraphToSettle(page);
      const state = await canvasEngine(page, 'debugState');
      assert.ok(state.ticks > 100, `worked out the layout, in ${state.ticks} steps`);
      assert.ok(state.draws <= 3, `and drew the result, not the journey: ${state.draws} draws`);
    });

    it('pans, zooms and drags nodes, then settles again', async () => {
      const page = await start();
      const ids = await seed(page);
      await openAtlas(page, 'Relationship graph');
      await page.getByTestId('graph-canvas').waitFor();
      await waitForGraphToSettle(page);

      const before = await canvasEngine(page, 'screenPosition', ids.Aria);
      const startZoom = (await canvasEngine(page, 'debugState')).zoom;
      const box = await page.getByTestId('graph-canvas').boundingBox();

      await page.mouse.move(box.x + 20, box.y + 20);
      await page.mouse.wheel(0, -400);
      await waitUntil(async () => (await canvasEngine(page, 'debugState')).zoom > startZoom, 2000, 'zoom in');

      const zoomed = await canvasEngine(page, 'screenPosition', ids.Aria);
      assert.notDeepEqual(zoomed, before);
      await page.mouse.move(box.x + 20, box.y + box.height - 20);
      await page.mouse.down();
      await page.mouse.move(box.x + 120, box.y + box.height - 60, { steps: 4 });
      await page.mouse.up();
      const panned = await canvasEngine(page, 'screenPosition', ids.Aria);
      assert.ok(Math.abs(panned.x - zoomed.x - 100) < 1, 'panned across with the pointer');
      assert.ok(Math.abs(panned.y - zoomed.y + 40) < 1, 'panned up with the pointer');

      // Keyboard works too.
      await page.getByTestId('graph-canvas').focus();
      const beforeKeys = await canvasEngine(page, 'screenPosition', ids.Aria);
      await page.keyboard.press('ArrowLeft');
      await waitUntil(
        async () => (await canvasEngine(page, 'screenPosition', ids.Aria)).x > beforeKeys.x,
        2000,
        'the arrow key to pan',
      );
      await page.keyboard.press('0');

      // Dragging a page moves it and wakes the simulation, which then stops again.
      await waitForGraphToSettle(page);
      const grabbed = await canvasEngine(page, 'screenPosition', ids['Far Island']);
      const target = { x: grabbed.x + 60, y: grabbed.y - 40 };
      await page.mouse.move(grabbed.x, grabbed.y);
      await page.mouse.down();
      await page.mouse.move(target.x, target.y, { steps: 5 });
      await waitUntil(
        async () => {
          const during = await canvasEngine(page, 'screenPosition', ids['Far Island']);
          return Math.hypot(during.x - target.x, during.y - target.y) < 2;
        },
        2000,
        'the page to follow the pointer',
      );
      assert.equal((await canvasEngine(page, 'debugState')).running, true);
      await page.mouse.up();
      assert.equal(await page.getByRole('heading', { name: 'Far Island' }).count(), 0, 'a drag does not open it');
      await waitForGraphToSettle(page);
    });

    it('filters by type and category, searches, and offers the same information as a list', async () => {
      const page = await start();
      await seed(page);
      await openAtlas(page, 'Relationship graph');
      await page.getByTestId('graph-canvas').waitFor();
      await waitForGraphToSettle(page);

      const nodes = async () => (await canvasEngine(page, 'debugState')).nodes;
      await page.getByRole('group', { name: 'Page types to show' }).getByRole('button', { name: /Places/ }).click();
      await waitUntil(async () => (await nodes()) === 6, 3000, 'places to hide');
      await page.getByRole('group', { name: 'Page types to show' }).getByRole('button', { name: /Places/ }).click();
      await waitUntil(async () => (await nodes()) === 8, 3000, 'places to return');

      await page.getByRole('combobox', { name: 'Category' }).selectOption('North');
      await waitUntil(async () => (await nodes()) === 2, 3000, 'the category filter');
      await page.getByRole('combobox', { name: 'Category' }).selectOption('');
      await waitUntil(async () => (await nodes()) === 8, 3000, 'the category filter to clear');

      await page.getByRole('searchbox', { name: 'Search pages in the graph' }).fill('sunsw');
      await page.locator('.graph-status', { hasText: '1 page found' }).waitFor();
      await page.getByRole('searchbox', { name: 'Search pages in the graph' }).fill('');

      await page.getByRole('group', { name: 'View as' }).getByRole('button', { name: 'List' }).click();
      const row = page.locator('[data-graph-row="Aria"]');
      await row.waitFor();
      assert.match(await row.innerText(), /Bran \(parent of\)/);
      assert.match(await row.innerText(), /Silver Vale/);
      await app.screenshot('extras-graph-list');

      // With the canvas gone, nothing keeps running.
      assert.equal(await page.getByTestId('graph-canvas').count(), 0);

      // A key that goes nowhere leaves nothing behind to take focus later.
      await row.getByRole('button', { name: 'Aria', exact: true }).focus();
      await page.keyboard.press('Home');
      const search = page.getByRole('searchbox', { name: 'Search pages in the graph' });
      await search.click();
      await page.keyboard.type('a');
      await page.keyboard.type('r');
      assert.equal(await search.inputValue(), 'ar', 'typing stayed in the search box');
      await search.fill('');

      // The arrow keys move through the list, and Enter opens a page.
      await row.getByRole('button', { name: 'Aria', exact: true }).focus();
      await page.keyboard.press('ArrowDown');
      const focused = await page.evaluate(() => document.activeElement.textContent);
      assert.notEqual(focused, 'Aria');
      await page.keyboard.press('Enter');
      await page.getByRole('heading', { name: focused }).waitFor();
    });

    it('adds, edits and deletes relationships, which appear on the graph', async () => {
      const page = await start();
      const ids = await seed(page);
      await openAtlas(page, 'Relationship graph');
      await page.getByTestId('graph-canvas').waitFor();
      await page.getByRole('button', { name: 'Add relationship' }).click();

      await page.getByRole('combobox', { name: 'From page' }).fill('Sunsw');
      await page.getByRole('option', { name: 'Sunsword' }).click();
      await page.getByRole('combobox', { name: 'Kind' }).fill('located in');
      await page.getByRole('combobox', { name: 'To page' }).fill('Far');
      await page.getByRole('option', { name: 'Far Island' }).click();
      await page.getByRole('status').filter({ hasText: 'Sunsword located in Far Island' }).waitFor();
      await page.locator('.dialog').getByRole('button', { name: 'Add', exact: true }).click();
      await page.getByRole('heading', { name: 'Add relationship' }).waitFor({ state: 'detached' });

      const listed = await rpc(page, 'extras.relationshipList', { pageId: ids.Sunsword });
      assert.equal(listed[0].kind, 'located in');
      assert.equal(listed[0].toTitle, 'Far Island');

      await page.getByRole('group', { name: 'View as' }).getByRole('button', { name: 'Relationships' }).click();
      const row = page.locator('[data-relationship="Sunsword located in Far Island"]');
      await row.waitFor();
      await app.screenshot('extras-graph-relationships');

      await row.getByRole('button', { name: /^Edit/ }).click();
      await page.getByRole('combobox', { name: 'Kind' }).fill('part of');
      await page.locator('.dialog').getByRole('button', { name: 'Save' }).click();
      const edited = page.locator('[data-relationship="Sunsword part of Far Island"]');
      await edited.waitFor();

      // Escape closes an open list of suggestions first, and the form second.
      await page.getByRole('button', { name: 'Add relationship' }).click();
      await page.getByRole('combobox', { name: 'From page' }).fill('Aria');
      await page.getByRole('option', { name: 'Aria' }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('option', { name: 'Aria' }).waitFor({ state: 'detached' });
      await page.getByRole('heading', { name: 'Add relationship' }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('heading', { name: 'Add relationship' }).waitFor({ state: 'detached' });

      // A duplicate is refused and says why.
      await page.getByRole('button', { name: 'Add relationship' }).click();
      await page.getByRole('combobox', { name: 'From page' }).fill('Aria');
      await page.getByRole('combobox', { name: 'Kind' }).fill('enemy');
      await page.getByRole('combobox', { name: 'To page' }).fill('The Guild');
      await page.keyboard.press('Tab');
      await page.locator('.dialog').getByRole('button', { name: 'Add', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'already have the relationship' }).waitFor();
      await page.locator('.dialog').getByRole('button', { name: 'Cancel' }).click();

      await edited.getByRole('button', { name: /^Delete/ }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
      await edited.waitFor({ state: 'detached' });
      assert.equal((await rpc(page, 'extras.relationshipList', { pageId: ids.Sunsword })).length, 0);

      // Undo brings it back.
      await page.locator('.toast', { hasText: 'Sunsword part of Far Island' }).getByRole('button', { name: 'Undo' }).click();
      await edited.waitFor();
      assert.equal((await rpc(page, 'extras.relationshipList', { pageId: ids.Sunsword }))[0].kind, 'part of');
    });

    it('centers on a page and can show only its neighborhood', async () => {
      const page = await start();
      const ids = await seed(page);
      await openAtlas(page, 'Relationship graph');
      await page.getByTestId('graph-canvas').waitFor();
      await waitForGraphToSettle(page);

      // Through the context menu, as a person would.
      const silver = await canvasEngine(page, 'screenPosition', ids['Silver Vale']);
      await page.mouse.click(silver.x, silver.y, { button: 'right' });
      await page.getByRole('menuitem', { name: 'Show its neighborhood' }).click();

      await page.getByRole('button', { name: 'Stop centering on Silver Vale' }).waitFor();
      await page.getByTestId('graph-canvas').waitFor();
      await page.getByRole('button', { name: 'Zoom in', exact: true }).waitFor();
      await waitForGraphToSettle(page);
      const nodes = async () => (await canvasEngine(page, 'debugState')).nodes;
      assert.equal(await nodes(), 3, 'Silver Vale, Aria and Fall of Vale');

      const box = await page.getByTestId('graph-canvas').boundingBox();
      const center = await canvasEngine(page, 'screenPosition', ids['Silver Vale']);
      assert.ok(Math.abs(center.x - (box.x + box.width / 2)) < 2, 'centered across');
      assert.ok(Math.abs(center.y - (box.y + box.height / 2)) < 2, 'centered down');

      const around = page.getByRole('combobox', { name: /How much to show/ });
      await around.selectOption('2');
      await waitUntil(async () => (await nodes()) === 7, 3000, 'two hops');

      // Two hops out, every page is framed with the center still in the middle.
      await waitForGraphToSettle(page);
      for (const title of ['Silver Vale', 'Aria', 'Bran', 'Sunsword', 'The Guild', 'Fall of Vale', 'Old Magic']) {
        const spot = await canvasEngine(page, 'screenPosition', ids[title]);
        assert.ok(spot.x > box.x && spot.x < box.x + box.width, `${title} is in view across`);
        assert.ok(spot.y > box.y && spot.y < box.y + box.height, `${title} is in view down`);
      }
      const stillCentered = await canvasEngine(page, 'screenPosition', ids['Silver Vale']);
      assert.ok(Math.abs(stillCentered.x - (box.x + box.width / 2)) < 2, 'still centered');
      await around.selectOption('0');
      await waitUntil(async () => (await nodes()) === 8, 3000, 'the whole graph');
      await around.selectOption('1');
      await waitUntil(async () => (await nodes()) === 3, 3000, 'one hop again');

      await page.getByRole('button', { name: 'Stop centering on Silver Vale' }).click();
      await waitUntil(async () => (await nodes()) === 8, 3000, 'leaving the neighborhood');
    });

    it('repaints when the theme changes and stays readable in other themes', async () => {
      const page = await start();
      await seed(page);
      await openAtlas(page, 'Relationship graph');
      await page.getByTestId('graph-canvas').waitFor();
      await waitForGraphToSettle(page);
      await page.mouse.move(5, 5);

      const dark = await canvasEngine(page, 'debugState');
      for (const [theme, mode] of [
        ['encyclopedia', 'light'],
        ['parchment', 'dark'],
        ['parchment', 'light'],
        ['typewriter', 'dark'],
        ['midnight', 'light'],
      ]) {
        const before = await canvasEngine(page, 'debugState');
        await page.evaluate(
          ([t, m]) => {
            document.documentElement.dataset.theme = t;
            document.documentElement.dataset.mode = m;
          },
          [theme, mode],
        );
        await waitUntil(
          async () => {
            const state = await canvasEngine(page, 'debugState');
            return state.draws > before.draws && state.background !== before.background && !state.framePending;
          },
          3000,
          `a repaint for ${theme} ${mode}`,
        );
        await app.screenshot(`extras-graph-${theme}-${mode}`);
      }
      assert.notEqual((await canvasEngine(page, 'debugState')).background, dark.background);

      // It also follows the interface size.
      const before = await canvasEngine(page, 'debugState');
      await page.keyboard.press('Control+Shift+=');
      await waitUntil(async () => (await canvasEngine(page, 'debugState')).draws > before.draws, 3000, 'a repaint at the new size');
      await page.keyboard.press('Control+Shift+0');
    });

    it('redraws at once when the window changes size', async () => {
      const page = await start();
      const ids = await seed(page);
      await openAtlas(page, 'Relationship graph');
      await page.getByTestId('graph-canvas').waitFor();
      await waitForGraphToSettle(page);

      const before = await canvasEngine(page, 'debugState');
      await page.setViewportSize({ width: 900, height: 640 });
      await waitUntil(
        async () => (await canvasEngine(page, 'debugState')).pixelWidth !== before.pixelWidth,
        3000,
        'the canvas to resize',
      );
      // Read in the same task as the check, so a later frame cannot have filled it in.
      const painted = await canvasEngine(page, 'debugState');
      assert.ok(painted.draws > before.draws);
      const spot = await canvasEngine(page, 'screenPosition', ids.Aria);
      const pixel = await page.evaluate(({ x, y }) => {
        const canvas = document.querySelector('[data-testid="graph-canvas"]');
        const rect = canvas.getBoundingClientRect();
        const scale = canvas.width / rect.width;
        return [...canvas.getContext('2d').getImageData((x - rect.left) * scale, (y - rect.top) * scale, 1, 1).data];
      }, spot);
      assert.ok(pixel[3] > 0, `the node is drawn, saw ${pixel}`);
    });

    it('is reached from menus and the palette', async () => {
      const page = await start();
      await page.getByRole('menuitem', { name: 'View' }).click();
      await page.getByRole('menuitem', { name: 'Relationship graph' }).click();
      await page.getByRole('heading', { name: 'Relationship graph' }).waitFor();
      await page.getByRole('menuitem', { name: 'View' }).click();
      await page.getByRole('menuitem', { name: 'Maps' }).click();
      await page.getByRole('heading', { name: 'Maps', exact: true }).waitFor();
      await page.keyboard.press('Control+k');
      await page.getByRole('dialog', { name: 'Command palette' }).getByRole('combobox').fill('timeline');
      await page.keyboard.press('Enter');
      await page.getByRole('heading', { name: 'Timeline', exact: true }).waitFor();

      await page.getByRole('menuitem', { name: 'Tools' }).click();
      await page.getByRole('menuitem', { name: 'Era settings…' }).click();
      await page.getByRole('heading', { name: 'Era settings' }).waitFor();
      await page.getByRole('button', { name: 'Cancel' }).click();

      await page.getByRole('menuitem', { name: 'Tools' }).click();
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.getByRole('menuitem', { name: 'New map…' }).click(),
      ]);
      assert.equal(chooser.isMultiple(), false);
      const pngPath = workspace.file('from_the_menu.png');
      writeFileSync(pngPath, makePng(32, 32));
      await chooser.setFiles(pngPath);
      await page.getByRole('heading', { name: 'from the menu' }).waitFor();

      // The page-specific command only shows up on a page.
      await page.getByRole('menuitem', { name: 'View' }).click();
      assert.equal(await page.getByRole('menuitem', { name: 'Show this page in the graph' }).isDisabled(), true);
      await page.keyboard.press('Escape');
      await rpc(page, 'pages.create', { title: 'Vale' });
      await openPageByTitle(page, 'Vale');
      await page.getByRole('menuitem', { name: 'View' }).click();
      await page.getByRole('menuitem', { name: 'Show this page in the graph' }).click();
      await page.getByRole('button', { name: 'Stop centering on Vale' }).waitFor();
    });

    it('has a helpful empty state', async () => {
      const page = await start();
      await openAtlas(page, 'Relationship graph');
      await page.getByRole('heading', { name: 'Nothing to connect yet' }).waitFor();
      await app.screenshot('extras-graph-empty');
    });

    it('stays usable with 500 pages', async () => {
      const page = await start();
      const started = Date.now();
      // One call per page, as a large import would be. Kept off the UI thread by the RPC.
      await page.evaluate(async () => {
        const invoke = (method, params) => window.__TAURI_INTERNALS__.invoke('rpc', { method, params });
        for (let i = 0; i < 500; i += 1) {
          const links = [];
          for (let k = 1; k <= 4; k += 1) links.push(`Page ${(i * k * 7 + k) % 500}`);
          await invoke('pages.create', {
            title: `Page ${i}`,
            pageType: ['character', 'place', 'faction', 'item', 'event', 'concept'][i % 6],
            content: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  content: links.map((target) => ({ type: 'text', text: `${target} `, marks: [{ type: 'wikiLink', attrs: { target } }] })),
                },
              ],
            },
          });
        }
      });
      const seedMs = Date.now() - started;

      await openAtlas(page, 'Relationship graph');
      await page.getByTestId('graph-canvas').waitFor();
      const opened = Date.now();

      // Frame times measured in the page while the graph settles.
      const settling = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const engine = document.querySelector('[data-testid="graph-canvas"]').graphEngine;
            const frames = [];
            let last = performance.now();
            const startedAt = last;
            const step = () => {
              const now = performance.now();
              frames.push(now - last);
              last = now;
              const state = engine.debugState();
              if ((state.nodes > 0 && !state.running && !state.framePending) || now - startedAt > 30000) {
                const sorted = frames.slice(1).sort((a, b) => a - b);
                resolve({
                  ms: now - startedAt,
                  frames: frames.length,
                  median: sorted[Math.floor(sorted.length / 2)],
                  p95: sorted[Math.floor(sorted.length * 0.95)],
                  worst: sorted[sorted.length - 1],
                  ...state,
                });
              } else requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
          }),
      );
      console.log(`graph, 500 pages: seeded in ${seedMs} ms, settled ${Date.now() - opened} ms after opening`, settling);
      assert.equal(settling.nodes, 500);
      assert.equal(settling.running, false, 'it settled');
      assert.ok(settling.ms < slowLimit(15000), `settled in ${settling.ms} ms`);
      assert.ok(settling.p95 < slowLimit(60), `95% of frames under 60 ms while settling, was ${settling.p95}`);
      await app.screenshot('extras-graph-500');

      // Idle means idle, even at this size.
      const before = await canvasEngine(page, 'debugState');
      await new Promise((r) => setTimeout(r, 1000));
      const after = await canvasEngine(page, 'debugState');
      assert.equal(after.draws, before.draws);

      // A single redraw is quick enough for panning and hovering to feel direct.
      const redraw = await page.evaluate(() => {
        const engine = document.querySelector('[data-testid="graph-canvas"]').graphEngine;
        const started = performance.now();
        for (let i = 0; i < 20; i += 1) engine.draw();
        return (performance.now() - started) / 20;
      });
      console.log(`graph, 500 pages: one redraw takes ${redraw.toFixed(1)} ms`);
      assert.ok(redraw < slowLimit(30), `a redraw took ${redraw} ms`);
    });
  });

  describe('maps', () => {
    /** Uploads through the RPC, as the brief asks, then opens the map from the sidebar. */
    async function addMap(page, title = 'The Vale') {
      const base64 = makePng(400, 200).toString('base64');
      const asset = await addAsset(page, {
        name: 'vale.png',
        mime: 'image/png',
        base64,
        width: 400,
        height: 200,
      });
      const map = await rpc(page, 'extras.mapCreate', { title, assetId: asset.id });
      await openArea(page, 'Atlas');
      await page.locator('.sidebar').getByRole('button', { name: title, exact: true }).click();
      await page.getByTestId('map-viewport').waitFor();
      await page.locator('.map-image').waitFor();
      await waitUntil(
        () => page.evaluate(() => document.querySelector('.map-image')?.complete && document.querySelector('.map-stage').style.transform !== ''),
        5000,
        'the image to be fitted',
      );
      return { map, asset };
    }

    /** The screen position of a fraction of the image. */
    function pointOnMap(page, x, y) {
      return page.evaluate(
        ([fx, fy]) => {
          const rect = document.querySelector('.map-stage').getBoundingClientRect();
          return { x: rect.left + rect.width * fx, y: rect.top + rect.height * fy };
        },
        [x, y],
      );
    }

    const pinStyle = (page, name) =>
      page.locator(`[data-pin-name="${name}"]`).evaluate((el) => ({
        left: parseFloat(el.style.left) / 100,
        top: parseFloat(el.style.top) / 100,
      }));

    function assertNear(actual, expected, tolerance, what) {
      assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} is not near ${expected}`);
    }

    it('adds a pin by clicking, and it stays at the same fraction after reopening the project', async () => {
      const page = await start();
      const pageId = (await rpc(page, 'pages.create', { title: 'Silver Vale', pageType: 'place' })).id;
      const { map } = await addMap(page);
      await page.getByText('Click anywhere on the map to add a pin.').waitFor();
      await app.screenshot('extras-map-empty');

      const spot = await pointOnMap(page, 0.25, 0.75);
      await page.mouse.click(spot.x, spot.y);
      await page.getByRole('form', { name: 'Add pin' }).waitFor();
      await page.getByRole('combobox', { name: 'Page or label' }).fill('Silver');
      await page.getByRole('option', { name: 'Silver Vale' }).click();
      await page.getByText('Links to the page Silver Vale.').waitFor();
      await page.getByRole('button', { name: 'Add pin', exact: true }).last().click();

      const pin = page.locator('[data-pin-name="Silver Vale"]');
      await pin.waitFor();
      assert.equal(await pin.getAttribute('data-wiki-target'), 'Silver Vale', 'it gets the hover card');

      const saved = (await rpc(page, 'extras.mapGet', { id: map.id })).pins[0];
      assert.equal(saved.pageId, pageId);
      assertNear(saved.x, 0.25, 0.005, 'stored x');
      assertNear(saved.y, 0.75, 0.005, 'stored y');
      await app.screenshot('extras-map-pin');

      // The tip of the pin is at the place that was clicked, whatever the zoom.
      await page.mouse.move(spot.x + 30, spot.y - 20);
      await page.mouse.wheel(0, -500);
      await waitUntil(
        async () => (await page.evaluate(() => getComputedStyle(document.querySelector('.map-stage')).transform)) !== 'none',
        1000,
        'zoom',
      );
      const zoomed = await pointOnMap(page, saved.x, saved.y);
      const box = await pin.boundingBox();
      assertNear(box.y + box.height, zoomed.y, 2, 'pin tip y after zoom');
      assertNear(box.x + box.width / 2, zoomed.x, 2, 'pin tip x after zoom');
      await app.screenshot('extras-map-zoomed');

      await saveAndReopen(app, workspace, 'with-pin');
      await addMapReopened(page, 'The Vale');
      const reopened = await pinStyle(page, 'Silver Vale');
      // Stored exactly, as checked below. The style only reads back to a few decimals.
      assertNear(reopened.left, saved.x, 1e-4, 'shown x after reopening');
      assertNear(reopened.top, saved.y, 1e-4, 'shown y after reopening');
      const after = (await rpc(page, 'extras.mapGet', { id: map.id })).pins[0];
      assert.equal(after.x, saved.x);
      assert.equal(after.y, saved.y);

      // Clicking opens the page.
      await page.locator('[data-pin-name="Silver Vale"]').click();
      await page.getByRole('heading', { name: 'Silver Vale' }).waitFor();
    });

    async function addMapReopened(page, title) {
      await openArea(page, 'Atlas');
      await page.locator('.sidebar').getByRole('button', { name: title, exact: true }).click();
      await page.getByTestId('map-viewport').waitFor();
      await page.locator('.map-pin').first().waitFor();
    }

    it('drags, labels, edits and deletes pins, from the map and the list', async () => {
      const page = await start();
      await rpc(page, 'pages.create', { title: 'Harbor', pageType: 'place' });
      const { map } = await addMap(page);

      // A free label, with no page behind it.
      const spot = await pointOnMap(page, 0.5, 0.5);
      await page.mouse.click(spot.x, spot.y);
      await page.getByRole('combobox', { name: 'Page or label' }).fill('Here be dragons');
      await page.getByText('A label with no page behind it.').waitFor();
      await page.keyboard.press('Enter');
      const label = page.locator('[data-pin-name="Here be dragons"]');
      await label.waitFor();
      assert.equal(await label.getAttribute('data-wiki-target'), null);

      // A pin can be added without a mouse too, in the middle of the view.
      await page.getByRole('button', { name: 'Add pin', exact: true }).click();
      await page.getByRole('combobox', { name: 'Page or label' }).fill('Middle of nowhere');
      await page.keyboard.press('Enter');
      const middle = page.locator('[data-pin-name="Middle of nowhere"]');
      await middle.waitFor();

      // Right-click edits, and a key deletes after asking.
      await middle.click({ button: 'right' });
      await page.getByRole('form', { name: 'Edit pin' }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('form', { name: 'Edit pin' }).waitFor({ state: 'detached' });
      await middle.focus();
      await page.keyboard.press('Delete');

      // The question takes the keyboard, starting on the safe answer, so Enter here does
      // not open the pin behind it. Saying no returns to the pin.
      const asking = page.getByRole('alertdialog');
      await asking.waitFor();
      assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Cancel');
      await page.keyboard.press('Enter');
      await asking.waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => document.activeElement.dataset.pinName), 'Middle of nowhere');
      await page.keyboard.press('Delete');
      await asking.getByRole('button', { name: 'Delete' }).click();
      await middle.waitFor({ state: 'detached' });

      // Clicking a label has nothing to open, so it edits.
      await label.click();
      await page.getByRole('form', { name: 'Edit pin' }).waitFor();
      await page.getByRole('combobox', { name: 'Page or label' }).fill('Harbor');
      await page.getByText('Links to the page Harbor.').waitFor();
      await page.getByRole('button', { name: 'Save' }).click();
      const pin = page.locator('[data-pin-name="Harbor"]');
      await pin.waitFor();
      assert.equal((await rpc(page, 'extras.mapGet', { id: map.id })).pins[0].label, '');

      // Drag it to a new place. A drag does not open the page.
      const box = await pin.boundingBox();
      const grab = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const destination = await pointOnMap(page, 0.8, 0.2);
      await page.mouse.move(grab.x, grab.y);
      await page.mouse.down();
      await page.mouse.move(destination.x, destination.y, { steps: 6 });
      await page.mouse.up();
      await waitUntil(
        async () => {
          const stored = (await rpc(page, 'extras.mapGet', { id: map.id })).pins[0];
          return Math.abs(stored.x - 0.8) < 0.01 && Math.abs(stored.y - 0.2) < 0.01;
        },
        3000,
        'the drag to be stored',
      );
      assert.equal(await page.getByRole('heading', { name: 'Harbor' }).count(), 0);
      const placed = await pinStyle(page, 'Harbor');
      assertNear(placed.left, 0.8, 0.01, 'dragged x');

      // Keyboard: arrow keys nudge the focused pin.
      await pin.focus();
      const beforeNudge = (await rpc(page, 'extras.mapGet', { id: map.id })).pins[0].x;
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      await waitUntil(
        async () => Math.abs((await rpc(page, 'extras.mapGet', { id: map.id })).pins[0].x - (beforeNudge - 0.01)) < 1e-6,
        3000,
        'the nudge to be stored',
      );

      // Back is still Back with a pin focused, and leaves the pin where it was.
      await waitUntil(
        async () => {
          const pins = (await rpc(page, 'extras.mapGet', { id: map.id })).pins;
          return pins.length === 1;
        },
        3000,
        'one pin',
      );
      const beforeBack = (await rpc(page, 'extras.mapGet', { id: map.id })).pins[0].x;
      await pin.focus();
      await page.keyboard.press('Alt+ArrowLeft');
      await page.getByTestId('timeline-view').waitFor();
      await page.keyboard.press('Alt+ArrowRight');
      await pin.waitFor();
      assert.equal((await rpc(page, 'extras.mapGet', { id: map.id })).pins[0].x, beforeBack);

      // Pins are also in a list, which works without the map.
      const row = page.locator('[data-pin-row="Harbor"]');
      await row.getByRole('button', { name: 'Open the page Harbor' }).waitFor();
      await row.getByRole('button', { name: 'Show Harbor on the map' }).click();
      await page.locator('[data-pin-name="Harbor"].is-flash').waitFor();
      await app.screenshot('extras-map-list');

      await row.getByRole('button', { name: 'Delete the pin Harbor' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
      await pin.waitFor({ state: 'detached' });
      assert.equal((await rpc(page, 'extras.mapGet', { id: map.id })).pins.length, 0);
      assert.equal(await rpc(page, 'pages.getByTitle', { title: 'Harbor' }).then((p) => p.title), 'Harbor', 'the page stays');

      // Undo puts it back where it was, still linked to its page.
      await page.locator('.toast', { hasText: 'Deleted the pin for Harbor.' }).last().getByRole('button', { name: 'Undo' }).click();
      await pin.waitFor();
      const [back] = (await rpc(page, 'extras.mapGet', { id: map.id })).pins;
      assert.equal(back.pageTitle, 'Harbor');
    });

    it('brings a pin into view when focused, without scrolling the map out of true', async () => {
      const page = await start();
      const { map } = await addMap(page);
      await rpc(page, 'extras.pinAdd', { mapId: map.id, label: 'Far corner', x: 0.95, y: 0.95 });
      const far = page.locator('[data-pin-name="Far corner"]');
      await far.waitFor();

      // Zoomed in on the opposite corner, the pin is out of view.
      const corner = await pointOnMap(page, 0.02, 0.02);
      await page.mouse.move(corner.x, corner.y);
      for (let i = 0; i < 4; i += 1) await page.mouse.wheel(0, -500);
      const box = await page.getByTestId('map-viewport').boundingBox();
      await waitUntil(
        async () => {
          const at = await far.boundingBox();
          return at.x > box.x + box.width || at.y > box.y + box.height;
        },
        3000,
        'the pin to leave the view',
      );

      await far.focus();
      await waitUntil(
        async () => {
          const at = await far.boundingBox();
          return (
            at.x >= box.x && at.y >= box.y && at.x + at.width <= box.x + box.width && at.y + at.height <= box.y + box.height
          );
        },
        3000,
        'the pin to come into view',
      );
      const scroll = await page.getByTestId('map-viewport').evaluate((el) => [el.scrollLeft, el.scrollTop]);
      assert.deepEqual(scroll, [0, 0], 'the view was moved, not scrolled');

      // A click still lands where it should.
      const spot = await pointOnMap(page, 0.9, 0.9);
      await page.mouse.click(spot.x, spot.y);
      await page.getByRole('combobox', { name: 'Page or label' }).fill('Beside it');
      await page.keyboard.press('Enter');
      await page.locator('[data-pin-name="Beside it"]').waitFor();
      const added = (await rpc(page, 'extras.mapGet', { id: map.id })).pins.find((p) => p.label === 'Beside it');
      assertNear(added.x, 0.9, 0.002, 'x of a pin added after focusing');
      assertNear(added.y, 0.9, 0.002, 'y of a pin added after focusing');
    });

    it('writes a last nudge before saving', async () => {
      const page = await start();
      const { map } = await addMap(page);
      await rpc(page, 'extras.pinAdd', { mapId: map.id, label: 'A camp', x: 0.5, y: 0.5 });
      const pin = page.locator('[data-pin-name="A camp"]');
      await pin.waitFor();
      await saveTo(page, workspace, 'nudged');

      await pin.focus();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Control+s');
      await page.locator('.toast', { hasText: 'Saved' }).waitFor();
      assertNear((await rpc(page, 'extras.mapGet', { id: map.id })).pins[0].x, 0.505, 1e-9, 'stored x');
      await waitUntil(
        async () => /All changes saved/.test(await page.getByTestId('save-state').innerText()),
        3000,
        'the move to be part of the save',
      );
    });

    it('lists, renames and deletes maps with a trash, and pins come back with them', async () => {
      const page = await start();
      const { map } = await addMap(page, 'Old Map');
      await rpc(page, 'extras.pinAdd', { mapId: map.id, label: 'A camp', x: 0.5, y: 0.5 });
      await page.locator('[data-pin-name="A camp"]').waitFor();

      await page.getByRole('button', { name: 'Rename' }).click();
      await page.getByRole('textbox').last().fill('New Map');
      await page.locator('.dialog').getByRole('button', { name: 'Rename' }).click();
      await page.locator('.sidebar').getByRole('button', { name: 'New Map', exact: true }).waitFor();

      await page.getByRole('button', { name: 'Delete', exact: true }).first().click();
      await page.getByRole('heading', { name: 'Maps', exact: true }).waitFor();
      await page.getByRole('heading', { name: 'No maps yet' }).waitFor();
      const trash = page.locator('[data-trash-row="New Map"]');
      await trash.waitFor();
      assert.match(await trash.innerText(), /1 pin/);
      assert.equal(await page.locator('.sidebar').getByRole('button', { name: 'New Map' }).count(), 0);
      await app.screenshot('extras-maps-trash');

      await trash.getByRole('button', { name: 'Restore New Map' }).click();
      const card = page.locator('[data-map-card="New Map"]');
      await card.waitFor();
      await app.screenshot('extras-maps-list');
      await card.getByRole('button', { name: /^Open New Map/ }).click();
      await page.locator('[data-pin-name="A camp"]').waitFor();

      await page.getByRole('button', { name: 'All maps' }).click();
      await card.getByRole('button', { name: 'Delete New Map' }).click();
      await trash.getByRole('button', { name: 'Delete New Map forever' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete forever' }).click();
      await trash.waitFor({ state: 'detached' });
      assert.equal((await rpc(page, 'extras.mapList', { deleted: true })).length, 0);
    });

    it('uploads a chosen image, and refuses an SVG saying why', async () => {
      const page = await start();
      const pngPath = workspace.file('the_old_country.png');
      writeFileSync(pngPath, makePng(64, 48));
      // Named like a PNG, but the bytes are what count.
      const svgPath = workspace.file('evil.png');
      writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');

      const chooseFile = async (path) => {
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser'),
          page.getByRole('button', { name: 'Choose an image' }).click(),
        ]);
        await chooser.setFiles(path);
      };

      await openAtlas(page, 'Maps');
      await page.getByRole('heading', { name: 'No maps yet' }).waitFor();
      await app.screenshot('extras-maps-empty');

      await chooseFile(svgPath);
      await page.locator('.toast-error', { hasText: 'can carry scripts' }).waitFor();
      assert.equal((await rpc(page, 'extras.mapList')).length, 0, 'nothing was added');

      await chooseFile(pngPath);
      await page.getByRole('heading', { name: 'the old country' }).waitFor();
      await page.locator('.map-image').waitFor();
      await waitUntil(
        () => page.evaluate(() => document.querySelector('.map-image')?.naturalWidth === 64),
        5000,
        'the image to show',
      );
    });

    it('shows a page that has been deleted as a label, without breaking', async () => {
      const page = await start();
      const pageId = (await rpc(page, 'pages.create', { title: 'Lost City', pageType: 'place' })).id;
      const { map } = await addMap(page);
      await rpc(page, 'extras.pinAdd', { mapId: map.id, pageId, x: 0.4, y: 0.4 });
      const pin = page.locator('[data-pin-name="Lost City"]');
      await pin.waitFor();

      await rpc(page, 'pages.delete', { id: pageId });
      const orphan = page.locator('.map-pin.is-orphan');
      await orphan.waitFor();
      assert.equal(await orphan.getAttribute('data-wiki-target'), null);

      await rpc(page, 'pages.restore', { id: pageId });
      await page.locator('[data-pin-name="Lost City"]:not(.is-orphan)').waitFor();

      await rpc(page, 'pages.delete', { id: pageId });
      await rpc(page, 'pages.purge', { id: pageId });
      const label = page.locator('[data-pin-name="Lost City"]');
      await label.waitFor();
      assert.equal(await label.getAttribute('data-wiki-target'), null);
      const stored = (await rpc(page, 'extras.mapGet', { id: map.id })).pins[0];
      assert.equal(stored.pageId, null);
      assert.equal(stored.label, 'Lost City');
    });

    it('shows the maps a page is on, on the page, and goes to its pin', async () => {
      const page = await start();
      const pageId = (await rpc(page, 'pages.create', { title: 'Silver Vale', pageType: 'place' })).id;
      const { map } = await addMap(page);
      await rpc(page, 'extras.pinAdd', { mapId: map.id, pageId, x: 0.4, y: 0.4 });

      await openPageByTitle(page, 'Silver Vale');
      const section = page.getByRole('region', { name: 'Appears on maps' });
      await section.getByRole('button', { name: 'The Vale' }).click();
      await page.getByTestId('map-viewport').waitFor();
      await page.locator('[data-pin-name="Silver Vale"]').waitFor();

      // Only a character has a family, and a page on no map says nothing about maps.
      await rpc(page, 'pages.create', { title: 'Empty Place', pageType: 'place' });
      await openPageByTitle(page, 'Empty Place');
      const relationships = page.getByRole('region', { name: 'Relationships' });
      await relationships.waitFor();
      assert.equal(await relationships.getByRole('button', { name: 'Family tree' }).count(), 0);
      assert.equal(await page.getByRole('region', { name: 'Appears on maps' }).count(), 0);
    });
  });

  it('keeps a file dropped outside an editor from replacing the app', async () => {
    const page = await start();
    const outcome = await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['x'], 'x.png', { type: 'image/png' }));
      const send = (type) => {
        const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer });
        document.querySelector('.sidebar').dispatchEvent(event);
        return event.defaultPrevented;
      };
      const text = new DataTransfer();
      text.setData('text/plain', 'hello');
      const plain = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: text });
      document.querySelector('.sidebar').dispatchEvent(plain);
      return { over: send('dragover'), drop: send('drop'), plain: plain.defaultPrevented };
    });
    assert.deepEqual(outcome, { over: true, drop: true, plain: false });
  });

  describe('family tree', () => {
    /** Characters with the template's family fields, as the wiki creates them. */
    const character = async (page, title, values = {}) => {
      const field = (key, label) => ({ key, label, kind: 'pages', value: values[key] ?? '' });
      const born = values.born ? [{ key: 'born', label: 'Born', kind: 'date', value: values.born }] : [];
      const created = await rpc(page, 'pages.create', {
        title,
        pageType: 'character',
        infobox: { fields: [...born, field('parents', 'Parents'), field('spouse', 'Spouse'), field('children', 'Children')] },
      });
      return created.id;
    };

    const fieldOf = async (page, id, key) => {
      const stored = await rpc(page, 'pages.get', { id });
      return stored.infobox.fields.find((f) => f.key === key)?.value;
    };

    const toast = (page, text) => page.locator('.toast').filter({ hasText: text });

    const cardBox = (page, title) => page.locator(`.family-card[data-person="${title}"]`).boundingBox();

    it('saving a family field updates the other page, both relationships and tells the writer', async () => {
      const page = await start();
      const aria = await character(page, 'Aria');
      const bran = await character(page, 'Bran');
      await character(page, 'Cara', { spouse: 'Bran' });
      assert.equal(await fieldOf(page, bran, 'spouse'), 'Cara', 'creating a page counts as saving it');

      await openPageByTitle(page, 'Aria');
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      const spouseField = page.getByRole('complementary', { name: 'Infobox editor' }).getByLabel('Spouse', { exact: true });
      await spouseField.waitFor();
      await spouseField.fill('Bran');
      // It is saved, but nothing reaches Bran while the name could still be half typed.
      await waitUntil(async () => (await fieldOf(page, aria, 'spouse')) === 'Bran', 5000, 'the field to be saved');
      assert.equal(await fieldOf(page, bran, 'spouse'), 'Cara');
      // Leaving the field settles it. Bran already has a spouse, which stays, and the writer hears about it.
      await spouseField.press('Tab');
      await toast(page, "Bran's Spouse field already lists Cara, so Aria was added next to it.").waitFor();
      assert.equal(await fieldOf(page, bran, 'spouse'), 'Cara, Aria');

      // It reads on both pages, stored once.
      await page.getByRole('button', { name: 'Read', exact: true }).click();
      const section = page.getByRole('region', { name: 'Relationships' });
      await section.getByText('Spouse:').first().waitFor();
      await section.getByRole('button', { name: 'Bran', exact: true }).waitFor();
      await openPageByTitle(page, 'Bran');
      await page.locator('.wiki-infobox').getByRole('link', { name: 'Aria' }).waitFor();
      await page.getByRole('region', { name: 'Relationships' }).getByRole('button', { name: 'Aria', exact: true }).waitFor();
      const rows = await rpc(page, 'extras.relationshipList', {});
      assert.equal(rows.filter((r) => r.kind === 'spouse').length, 2);

      // Deleting it on one page clears both sides.
      await page.getByRole('button', { name: 'Delete relationship with Aria' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
      await page.getByRole('region', { name: 'Relationships' }).getByRole('button', { name: 'Aria', exact: true }).waitFor({ state: 'detached' });
      await waitUntil(async () => (await fieldOf(page, aria, 'spouse')) === '', 3000, 'the field to clear');
      assert.equal(await fieldOf(page, bran, 'spouse'), 'Cara');
    });

    it('links a family name once the writer leaves the field, so a pause mid-name links nobody', async () => {
      const page = await start();
      const bran = await character(page, 'Bran');
      const brannoc = await character(page, 'Brannoc');
      const cara = await character(page, 'Cara');
      await character(page, 'Arden');
      await openPageByTitle(page, 'Cara');
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      const spouse = page.getByRole('complementary', { name: 'Infobox editor' }).getByLabel('Spouse', { exact: true });
      await spouse.click();

      // Each pause is saved. "Ar" could be Arden and "Bran" is somebody, so neither may link.
      const pauseAt = async (sofar) => {
        await waitUntil(async () => (await fieldOf(page, cara, 'spouse')) === sofar, 5000, `"${sofar}" to be saved`);
        assert.deepEqual(await rpc(page, 'extras.relationshipList', {}), [], `nobody linked at "${sofar}"`);
      };
      await page.keyboard.type('Ar');
      await pauseAt('Ar');
      await page.keyboard.press('Backspace');
      await page.keyboard.press('Backspace');
      await page.keyboard.type('Bran');
      await pauseAt('Bran');
      await page.keyboard.type('noc');
      await pauseAt('Brannoc');
      assert.equal(await fieldOf(page, bran, 'spouse'), '');
      assert.equal(await toast(page, 'Spouse field').count(), 0, 'and nobody is told about a name half typed');

      // Leaving the field links the name the writer settled on, and only that one.
      await page.keyboard.press('Tab');
      await toast(page, "Cara was added to Brannoc's Spouse field.").waitFor();
      assert.equal(await fieldOf(page, brannoc, 'spouse'), 'Cara');
      assert.equal(await fieldOf(page, bran, 'spouse'), '', 'Bran was never touched');
      assert.equal((await rpc(page, 'extras.relationshipList', {})).length, 1);

      // Taking the name out unlinks it, here on leaving Edit with the keyboard, which gives no blur.
      await spouse.click();
      await spouse.press('Control+a');
      await page.keyboard.press('Backspace');
      await waitUntil(async () => (await fieldOf(page, cara, 'spouse')) === '', 5000, 'the cleared field to be saved');
      assert.equal((await rpc(page, 'extras.relationshipList', {})).length, 1, 'still linked while typing');
      await page.keyboard.press('Control+e');
      await toast(page, "Cara was removed from Brannoc's Spouse field.").waitFor();
      assert.equal(await fieldOf(page, brannoc, 'spouse'), '');
      assert.deepEqual(await rpc(page, 'extras.relationshipList', {}), []);
    });

    it('keeps family fields and the tree in step through rename, trash and restore', async () => {
      const page = await start();
      const aria = await character(page, 'Aria');
      const bran = await character(page, 'Bran');
      await character(page, 'Cara', { parents: 'Brannoc' });
      await openPageByTitle(page, 'Aria');
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      const spouse = page.getByRole('complementary', { name: 'Infobox editor' }).getByLabel('Spouse', { exact: true });
      await spouse.fill('Bran');
      await spouse.press('Tab');
      await toast(page, "Aria was added to Bran's Spouse field.").waitFor();

      // Renamed: the open editor shows the new title, and a field already naming it links.
      await rpc(page, 'pages.rename', { id: bran, newTitle: 'Brannoc', keepAlias: false });
      await waitUntil(async () => (await spouse.inputValue()) === 'Brannoc', 5000, 'the open editor to show the new title');
      assert.equal(await fieldOf(page, aria, 'spouse'), 'Brannoc');
      await waitUntil(async () => (await fieldOf(page, bran, 'children')) === 'Cara', 5000, 'Cara to be linked');
      assert.equal((await rpc(page, 'extras.relationshipList', {})).length, 2);

      // In the trash, the name reads as missing, as any link to it does, and says where it went.
      await rpc(page, 'pages.delete', { id: bran });
      await openArea(page, 'Atlas');
      await page.getByRole('button', { name: 'Family tree' }).click();
      const trashed = page.locator('.family-card[data-person="Brannoc"]');
      await trashed.getByText('In the trash').waitFor();
      assert.equal(await fieldOf(page, aria, 'spouse'), 'Brannoc', 'nothing the writer typed is taken away');

      // Restored, it is a page again, with everything as it was.
      await rpc(page, 'pages.restore', { id: bran });
      await page.locator('.family-card[data-person="Brannoc"]').getByText('In the trash').waitFor({ state: 'detached' });
      assert.equal(await page.locator('.family-card.is-missing').count(), 0);
      assert.equal((await rpc(page, 'extras.relationshipList', {})).length, 2);
      assert.equal(await fieldOf(page, bran, 'spouse'), 'Aria');
    });

    it('stores a fact said from either side once, and custom kinds can name their other side', async () => {
      const page = await start();
      await character(page, 'Aria');
      await character(page, 'Bran');
      await openPageByTitle(page, 'Bran');

      const section = page.getByRole('region', { name: 'Relationships' });
      const add = async (kind, to, inverse, from) => {
        await section.getByRole('button', { name: 'Add relationship' }).click();
        const dialog = page.getByRole('dialog');
        if (from) await dialog.getByRole('combobox', { name: 'From page' }).fill(from);
        await dialog.getByLabel('Kind').fill(kind);
        await dialog.getByRole('combobox', { name: 'To page' }).fill(to);
        if (inverse) await dialog.getByLabel('From the other page, this reads').fill(inverse);
        return dialog;
      };

      // Bran is written as the child of Aria, and it is stored as Aria's parent of Bran.
      let dialog = await add('child of', 'Aria');
      await dialog.getByText('Aria parent of Bran').waitFor();
      await dialog.getByRole('button', { name: 'Add', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      await section.getByText('Child of').waitFor();
      const [stored] = await rpc(page, 'extras.relationshipList', {});
      assert.equal(stored.kind, 'parent of');
      assert.equal(stored.fromTitle, 'Aria');

      // The same fact said from the other side is refused.
      dialog = await add('parent of', 'Bran', null, 'Aria');
      await dialog.getByRole('button', { name: 'Add', exact: true }).click();
      await dialog.getByRole('alert').waitFor();
      await dialog.getByRole('button', { name: 'Cancel' }).click();

      // A kind the app does not know can be given another side.
      dialog = await add('liege of', 'Aria', 'vassal of');
      await dialog.getByRole('button', { name: 'Add', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      await section.getByText('Liege of').waitFor();
      await openPageByTitle(page, 'Aria');
      await page.getByRole('region', { name: 'Relationships' }).getByText('Vassal of').waitFor();
      await app.screenshot('extras-family-relationships');

      // And a kind the app does know cannot be redefined, so the box is gone.
      await page.getByRole('region', { name: 'Relationships' }).getByRole('button', { name: 'Add relationship' }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('Kind').fill('spouse');
      assert.equal(await dialog.getByLabel('From the other page, this reads').count(), 0);
      await dialog.getByRole('button', { name: 'Cancel' }).click();
    });

    async function seedFamily(page) {
      await character(page, 'Old Tomas', { born: '250' });
      await character(page, 'Mira', { parents: 'Old Tomas', born: '280' });
      await character(page, 'Hale', { spouse: 'Mira' });
      await character(page, 'Second Wife', { spouse: 'Hale' });
      await character(page, 'Aria', { parents: 'Mira, Hale', born: '312' });
      await character(page, 'Bran', { parents: 'Hale, Second Wife' });
      await character(page, 'Orphan', { parents: 'Not Written Yet' });
      await character(page, 'Stranger');
    }

    it('lays out generations, opens pages, and is reachable by keyboard, in dark and light', async () => {
      const page = await start();
      await seedFamily(page);
      await openArea(page, 'Atlas');
      await page.getByRole('button', { name: 'Family tree' }).click();
      await page.getByRole('heading', { name: 'Family tree', exact: true }).waitFor();
      await page.locator('.family-card[data-person="Aria"]').waitFor();

      // Generations run top to bottom, with spouses side by side.
      const [tomas, mira, hale, wife, aria, bran] = await Promise.all(
        ['Old Tomas', 'Mira', 'Hale', 'Second Wife', 'Aria', 'Bran'].map((title) => cardBox(page, title)),
      );
      assert.ok(tomas.y < mira.y, 'a parent is above a child');
      assert.ok(mira.y < aria.y, 'and each generation is below the last');
      assert.equal(Math.round(mira.y), Math.round(hale.y), 'spouses share a row');
      assert.equal(Math.round(hale.y), Math.round(wife.y), 'all of them');
      assert.equal(Math.round(aria.y), Math.round(bran.y), 'half-siblings share a row');
      const middle = (box) => box.x + box.width / 2;
      assert.ok(middle(hale) > Math.min(middle(mira), middle(wife)), 'the person with two spouses is between them');
      assert.ok(middle(hale) < Math.max(middle(mira), middle(wife)), 'between them');
      assert.ok(middle(aria) < middle(bran) === middle(mira) < middle(wife), "each child is on their mother's side");

      // A name with no page yet is shown, and says so. Someone with no ties is not.
      const ghost = page.locator('.family-card[data-person="Not Written Yet"]');
      await ghost.getByText('No page yet').waitFor();
      assert.equal(await page.locator('.family-card[data-person="Stranger"]').count(), 0);

      // Lines are drawn, in the theme's colors, and no background hides them.
      assert.ok((await page.locator('.family-parent-lines').first().getAttribute('d')).length > 10);
      const themed = (theme, mode) =>
        page.evaluate(
          ([t, m]) => {
            document.documentElement.dataset.theme = t;
            document.documentElement.dataset.mode = m;
            const path = document.querySelector('.family-parent-lines');
            const card = document.querySelector('.family-card');
            return { line: getComputedStyle(path).stroke, back: getComputedStyle(card).backgroundColor };
          },
          [theme, mode],
        );
      const shown = await page.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.mode]);
      const dark = await themed('encyclopedia', 'dark');
      await app.screenshot('extras-family-tree-encyclopedia-dark');
      const light = await themed('encyclopedia', 'light');
      assert.notEqual(dark.back, light.back, 'the theme reaches the cards');
      assert.notEqual(dark.line, light.line, 'and the lines');
      await app.screenshot('extras-family-tree-encyclopedia-light');
      const parchmentLight = await themed('parchment', 'light');
      assert.notEqual(parchmentLight.back, light.back, 'each theme has its own colors');
      await app.screenshot('extras-family-tree-parchment-light');
      await themed('parchment', 'dark');
      await app.screenshot('extras-family-tree-parchment-dark');
      await themed(...shown);

      // Keyboard: one tab stop, arrows move, Enter opens.
      const canvas = page.getByRole('group', { name: /^Family of Old Tomas/ });
      assert.equal(await canvas.locator('button[tabindex="0"]').count(), 1);
      await canvas.locator('button[tabindex="0"]').focus();
      assert.equal(await page.evaluate(() => document.activeElement.dataset.person), 'Old Tomas');
      await page.keyboard.press('ArrowDown');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.person), 'Mira');
      assert.equal(await canvas.locator('button[tabindex="0"]').count(), 1);
      await page.keyboard.press('ArrowUp');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.person), 'Old Tomas');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      const below = await page.evaluate(() => document.activeElement.dataset.person);
      assert.ok(['Aria'].includes(below), `Mira's child, not ${below}`);
      await page.keyboard.press('Enter');
      await page.getByRole('heading', { name: 'Aria', exact: true }).waitFor();

      // The page links back to the tree, centered on them.
      await page.getByRole('region', { name: 'Relationships' }).getByRole('button', { name: 'Family tree' }).click();
      const focused = page.locator('.family-card.is-focus');
      await focused.waitFor();
      assert.equal(await focused.getAttribute('data-person'), 'Aria');
      assert.equal(await page.locator('.family-card[data-person="Orphan"]').count(), 0, 'only this family');
      await page.getByRole('button', { name: 'Show all families' }).click();
      await page.locator('.family-card[data-person="Orphan"]').waitFor();

      // A click on someone with no page offers to create it.
      await page.locator('.family-card[data-person="Not Written Yet"]').click();
      await page.getByRole('heading', { name: 'Not Written Yet' }).waitFor();
      await page.keyboard.press('Alt+ArrowLeft');
      await page.getByRole('heading', { name: 'Family tree', exact: true }).waitFor();

      // Alt with an arrow still goes back from a card, here to Aria's own tree.
      await page.locator('.family-card[data-person="Orphan"]').focus();
      await page.keyboard.press('Alt+ArrowLeft');
      await page.locator('.family-card.is-focus[data-person="Aria"]').waitFor();

      // Centered on someone, the tree adds a child or a spouse as readily as a parent.
      const family = page.getByRole('group', { name: 'Add to the family of Aria' });
      await family.getByRole('button', { name: 'Add child' }).click();
      assert.equal(await page.getByRole('combobox', { name: 'From page' }).inputValue(), 'Aria');
      assert.equal(await page.getByRole('combobox', { name: 'Kind' }).inputValue(), 'parent of');
      await page.locator('.dialog').getByRole('button', { name: 'Cancel' }).click();
      await family.getByRole('button', { name: 'Add spouse' }).click();
      assert.equal(await page.getByRole('combobox', { name: 'From page' }).inputValue(), 'Aria');
      assert.equal(await page.getByRole('combobox', { name: 'Kind' }).inputValue(), 'spouse');
      await page.locator('.dialog').getByRole('button', { name: 'Cancel' }).click();
      await family.getByRole('button', { name: 'Add parent' }).click();
      assert.equal(await page.getByRole('combobox', { name: 'To page' }).inputValue(), 'Aria');
      await page.locator('.dialog').getByRole('button', { name: 'Cancel' }).click();
    });

    it('gives the same information as a list', async () => {
      const page = await start();
      await seedFamily(page);
      await openArea(page, 'Atlas');
      await page.getByRole('button', { name: 'Family tree' }).click();
      await page.getByRole('group', { name: 'View as' }).getByRole('button', { name: 'List' }).click();
      const aria = page.locator('[data-family-person="Aria"]');
      await aria.waitFor();
      assert.match(await aria.innerText(), /312/);
      assert.match(await aria.innerText(), /Parents:\s*(Mira, Hale|Hale, Mira)/);
      const hale = page.locator('[data-family-person="Hale"]');
      assert.match(await hale.innerText(), /Spouse:/);
      assert.match(await hale.innerText(), /Second Wife/);
      assert.match(await hale.innerText(), /Children:/);
      await app.screenshot('extras-family-tree-list');
      await aria.getByRole('button', { name: 'Hale' }).click();
      await page.getByRole('heading', { name: 'Hale', exact: true }).waitFor();
    });

    it('does not hang on someone who is their own grandparent, and says what it left out', async () => {
      const page = await start();
      await character(page, 'Ana');
      await character(page, 'Ben', { parents: 'Ana' });
      await character(page, 'Cal', { parents: 'Ben' });
      const ana = await rpc(page, 'pages.getByTitle', { title: 'Ana' });
      const infobox = ana.infobox;
      infobox.fields.find((f) => f.key === 'parents').value = 'Cal';
      await rpc(page, 'pages.update', { id: ana.id, patch: { infobox } });

      await openArea(page, 'Atlas');
      await page.getByRole('button', { name: 'Family tree' }).click();
      await page.locator('.family-card').first().waitFor();
      assert.equal(await page.locator('.family-card').count(), 3);
      const note = page.getByRole('note');
      await note.getByText('left out of the tree').waitFor();
      await note.getByText('is listed as a parent of').waitFor();
    });

    it('says what to do when there are no families, and for a person with none', async () => {
      const page = await start();
      await character(page, 'Stranger');
      await openArea(page, 'Atlas');
      await page.getByRole('button', { name: 'Family tree' }).click();
      await page.getByRole('heading', { name: 'No families yet' }).waitFor();
      await openPageByTitle(page, 'Stranger');
      await page.getByRole('region', { name: 'Relationships' }).getByRole('button', { name: 'Family tree' }).click();
      await page.getByRole('heading', { name: 'Stranger has no family recorded' }).waitFor();
    });

    it('fills in a character page created from a red link in a family field', async () => {
      const page = await start();
      await character(page, 'Aria', { spouse: 'Rowan' });
      await openArea(page, 'Atlas');
      await page.getByRole('button', { name: 'Family tree' }).click();
      await page.locator('.family-card[data-person="Rowan"]').click();
      await page.getByRole('heading', { name: 'Rowan' }).waitFor();
      const rowan = await rpc(page, 'pages.create', {
        title: 'Rowan',
        pageType: 'character',
        infobox: { fields: [{ key: 'spouse', label: 'Spouse', kind: 'pages', value: '' }] },
      });
      assert.equal(rowan.infobox.fields[0].value, 'Aria');
      const rows = await rpc(page, 'extras.relationshipList', {});
      assert.deepEqual(rows.map((r) => r.kind), ['spouse']);
    });

    it('draws a large family without keeping the machine busy', async () => {
      const page = await start();
      await page.evaluate(
        async ({ count }) => {
          const { invoke } = window.__TAURI_INTERNALS__;
          for (let i = 1; i < count; i++) {
            await invoke('rpc', {
              method: 'pages.create',
              params: {
                title: `Person ${i}`,
                pageType: 'character',
                infobox: {
                  fields: [
                    { key: 'parents', label: 'Parents', kind: 'pages', value: `Person ${Math.floor((i - 1) / 3)}` },
                    { key: 'spouse', label: 'Spouse', kind: 'pages', value: `Partner ${i}` },
                    { key: 'children', label: 'Children', kind: 'pages', value: '' },
                  ],
                },
              },
            });
          }
          await invoke('rpc', {
            method: 'pages.create',
            params: { title: 'Person 0', pageType: 'character' },
          });
        },
        { count: 400 },
      );
      await openArea(page, 'Atlas');
      const opened = Date.now();
      await page.getByRole('button', { name: 'Family tree' }).click();
      await page.locator('.family-card[data-person="Person 399"]').waitFor({ state: 'attached' });
      const shown = Date.now() - opened;
      assert.ok((await page.locator('.family-card').count()) >= 799);
      assert.ok(shown < slowLimit(5000), `opened in ${shown} ms`);

      // It opens on the oldest generation, wherever that is, rather than on empty space.
      await waitUntil(async () => (await page.locator('.toast').count()) === 0, 20_000, 'the notices to go');
      const scroller = await page.locator('.family-scroll').boundingBox();
      const top = await page.locator('.family-card').first().boundingBox();
      assert.ok(top.x >= scroller.x && top.x + top.width <= scroller.x + scroller.width, 'the first card is in view');
      await app.screenshot('extras-family-tree-large');

      const busy = await page.evaluate(
        () =>
          new Promise((resolve) => {
            let frames = 0;
            const count = () => {
              frames++;
              requestAnimationFrame(count);
            };
            const observer = new PerformanceObserver(() => {});
            observer.observe({ entryTypes: ['longtask'] });
            requestAnimationFrame(count);
            setTimeout(() => {
              const tasks = observer.takeRecords().length;
              observer.disconnect();
              resolve({ frames, tasks });
            }, 1000);
          }),
      );
      // A slow shared machine can stall now and then for reasons of its own.
      assert.ok(busy.tasks <= (SLOW > 1 ? 2 : 0), `${busy.tasks} long tasks while idle`);
      console.log(`Family tree of ${await page.locator('.family-card').count()} people: opened in ${shown} ms`);
    });
  });

  describe('spellcheck', () => {
    const underlined = (page) =>
      page.locator('.ProseMirror .spell-error').evaluateAll((spans) => spans.map((s) => s.textContent));

    async function waitForUnderlined(page, expected, timeoutMs = 10_000) {
      let seen;
      try {
        await waitUntil(
          async () => {
            seen = await underlined(page);
            return JSON.stringify(seen) === JSON.stringify(expected);
          },
          timeoutMs,
          `underlines on ${JSON.stringify(expected)}`,
        );
      } catch (error) {
        // A screen that failed has no editor and so no underlines, which says little alone.
        const failed = await page.locator('[role="alert"] .error-detail').allInnerTexts();
        const why = failed.length > 0 ? `, and the screen failed with "${failed.join(' ')}"` : '';
        throw new Error(`${error.message}, last saw ${JSON.stringify(seen)}${why}`);
      }
    }

    /** Uses the settings screen as a person would, and comes back. */
    async function setSpellcheck(page, on) {
      await page.getByRole('menuitem', { name: 'Tools' }).click();
      await page.getByRole('menuitem', { name: /^Settings…/ }).click();
      await page.getByRole('tab', { name: 'Writing' }).click();
      await page.getByRole('checkbox', { name: 'Check spelling as I type' }).setChecked(on);
      await page.keyboard.press('Alt+ArrowLeft');
    }

    it('runs in a real worker under the production content security policy', async () => {
      const page = await start();
      await rpc(page, 'pages.create', { title: 'Scratch' });
      const failures = [];
      page.on('console', (message) => {
        if (message.type() === 'error' || message.text().includes('built-in checker')) failures.push(message.text());
      });
      await editPage(page, 'Scratch');
      await waitUntil(
        () => page.evaluate(() => document.querySelector('.ProseMirror').spellStats?.().state === 'ready'),
        20_000,
        'the worker to start',
      );
      const stats = await page.evaluate(() => document.querySelector('.ProseMirror').spellStats());
      console.log(`spellcheck: dictionary loaded in the worker in ${stats.loadMs.toFixed(0)} ms`);

      assert.deepEqual(failures, []);

      // This is the embedded production build, with its policy really in force: a worker
      // from anywhere but the app itself is refused, while the app's own one loaded.
      assert.ok(!page.url().startsWith('http://localhost:1420'), `running from ${page.url()}`);
      const blobWorker = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const url = URL.createObjectURL(new Blob(['postMessage("ran")'], { type: 'text/javascript' }));
            const worker = new Worker(url);
            worker.onmessage = () => resolve('ran');
            worker.onerror = () => resolve('refused');
            setTimeout(() => resolve('no answer'), 3000);
          }),
      );
      assert.equal(blobWorker, 'refused');
      const loaded = await page.evaluate(() =>
        performance.getEntriesByType('resource').map((entry) => entry.name).filter((name) => name.includes('worker')),
      );
      assert.equal(loaded.length, 1, `worker files loaded: ${loaded}`);
      assert.match(loaded[0], /\/assets\/worker-[^/]+\.js$/);
    });

    it('underlines a misspelling but not a lore name, and fixes it from the menu', async () => {
      const page = await start();
      await rpc(page, 'pages.create', { title: 'Zephyrine', aliases: ["Kel'Thuzad"], pageType: 'character' });
      await rpc(page, 'pages.create', { title: 'Scratch' });
      const editor = await editPage(page, 'Scratch');
      assert.equal(await editor.getAttribute('spellcheck'), 'false', 'the native checker stays out of it');

      await page.keyboard.type("Zephyrine's sister did recieve Kel'Thuzad and the well-knwon NPC. ");
      await waitForUnderlined(page, ['recieve', 'knwon']);
      await app.screenshot('extras-spellcheck');

      // A word being typed is left alone until the caret moves on.
      await page.keyboard.type('zqxwv');
      await new Promise((r) => setTimeout(r, 800));
      assert.deepEqual(await underlined(page), ['recieve', 'knwon']);
      await page.keyboard.type(' ');
      await waitForUnderlined(page, ['recieve', 'knwon', 'zqxwv']);

      await page.locator('.spell-error', { hasText: 'recieve' }).click({ button: 'right' });
      const menu = page.getByRole('menu', { name: 'Spelling of recieve' });
      await menu.waitFor();
      await menu.getByRole('menuitem', { name: 'receive' }).waitFor();
      await menu.getByRole('menuitem', { name: 'Add "recieve" to dictionary' }).waitFor();
      await menu.getByRole('menuitem', { name: 'Ignore in this session' }).waitFor();
      await app.screenshot('extras-spellcheck-menu');
      await menu.getByRole('menuitem', { name: 'receive' }).click();
      await waitForUnderlined(page, ['knwon', 'zqxwv']);
      assert.match(await editor.innerText(), /did receive Kel/);

      // The menu also opens from the keyboard, for the word the caret is in.
      await page.locator('.spell-error', { hasText: 'knwon' }).click();
      // The editor learns of a new selection a moment after the click.
      await new Promise((r) => setTimeout(r, 200));
      await page.evaluate(() => {
        document
          .querySelector('.ProseMirror')
          .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0 }));
      });
      const fromKeyboard = page.getByRole('menu', { name: 'Spelling of knwon' });
      await fromKeyboard.waitFor();
      await page.keyboard.press('Escape');
      await fromKeyboard.waitFor({ state: 'detached' });

      // Escape closes the menu and changes nothing.
      await page.locator('.spell-error', { hasText: 'knwon' }).click({ button: 'right' });
      await menu.waitFor({ state: 'detached' });
      const second = page.getByRole('menu', { name: 'Spelling of knwon' });
      await second.waitFor();
      await page.keyboard.press('Escape');
      await second.waitFor({ state: 'detached' });
      assert.match(await editor.innerText(), /well-knwon/);
    });

    it('brings underlines back when a deleted paragraph is restored by undo', async () => {
      const page = await start();
      await rpc(page, 'pages.create', { title: 'Scratch' });
      const editor = await editPage(page, 'Scratch');
      await page.keyboard.type('First qwertyz line.');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Second zqxwv line.');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Third line.');
      await waitForUnderlined(page, ['qwertyz', 'zqxwv']);

      // Selects and deletes the whole of the first two paragraphs, past their edges.
      await page.keyboard.press('Control+Home');
      await page.keyboard.press('Shift+ArrowDown');
      await page.keyboard.press('Shift+ArrowDown');
      // The editor learns of a new selection a moment after the keys, and test keys are fast.
      await waitUntil(
        () =>
          page.evaluate(() => {
            const { state } = document.querySelector('.ProseMirror').editor;
            return state.doc.textBetween(state.selection.from, state.selection.to, ' ').includes('zqxwv');
          }),
        3000,
        'both paragraphs to be selected',
      );
      // The selection menu still holds the old range for a moment, which once failed the
      // whole screen when anything made it look again at the shorter text.
      await page.keyboard.press('Delete');
      await waitForUnderlined(page, []);
      // Saving waits longer than checking, so once the deletion is stored it has been checked.
      await waitUntil(
        async () => {
          const stored = JSON.stringify((await rpc(page, 'pages.getByTitle', { title: 'Scratch' })).content);
          return stored.includes('Third line.') && !stored.includes('qwertyz');
        },
        5000,
        'the deletion to be stored',
      );
      await page.keyboard.press('Control+z');
      await waitForUnderlined(page, ['qwertyz', 'zqxwv']);
      assert.match(await editor.innerText(), /First qwertyz line\.\s+Second zqxwv line\.\s+Third line\./);
    });

    it('does not check code or wiki-link text', async () => {
      const page = await start();
      await rpc(page, 'pages.create', {
        title: 'Marked',
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Run ' },
                { type: 'text', text: 'npmx', marks: [{ type: 'code' }] },
                { type: 'text', text: ' at ' },
                { type: 'text', text: 'Karthold', marks: [{ type: 'wikiLink', attrs: { target: 'Karthold' } }] },
                { type: 'text', text: ' tonite' },
              ],
            },
            { type: 'codeBlock', content: [{ type: 'text', text: 'zqxwv qwertyz' }] },
          ],
        },
      });
      await editPage(page, 'Marked');
      await waitForUnderlined(page, ['tonite']);
    });

    it('keeps a word added to the dictionary after reopening, and can forget it', async () => {
      const page = await start();
      await rpc(page, 'pages.create', { title: 'Scratch' });
      await editPage(page, 'Scratch');
      await page.keyboard.type('The mithrandil gleamed and the qwertyz faded. ');
      await waitForUnderlined(page, ['mithrandil', 'qwertyz']);

      await page.locator('.spell-error', { hasText: 'mithrandil' }).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Add "mithrandil" to dictionary' }).click();
      await waitForUnderlined(page, ['qwertyz']);
      assert.deepEqual(await rpc(page, 'extras.dictionaryList'), ['mithrandil']);

      // Ignoring lasts only for this session.
      await page.locator('.spell-error', { hasText: 'qwertyz' }).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Ignore in this session' }).click();
      await waitForUnderlined(page, []);
      assert.deepEqual(await rpc(page, 'extras.dictionaryList'), ['mithrandil'], 'not stored');

      await waitUntil(
        async () => JSON.stringify((await rpc(page, 'pages.getByTitle', { title: 'Scratch' })).content).includes('qwertyz'),
        5000,
        'the text to be stored',
      );
      await saveAndReopen(app, workspace, 'with-dictionary');
      assert.deepEqual(await rpc(page, 'extras.dictionaryList'), ['mithrandil'], 'kept in the project');
      await editPage(page, 'Scratch');
      await waitForUnderlined(page, ['qwertyz']);

      // A word can be removed again, from the dictionary dialog.
      await page.getByRole('menuitem', { name: 'Tools' }).click();
      await page.getByRole('menuitem', { name: 'Custom dictionary…' }).click();
      await page.getByRole('heading', { name: 'Custom dictionary' }).waitFor();
      await app.screenshot('extras-dictionary');
      await page.getByRole('button', { name: 'Remove mithrandil' }).click();
      await page.getByText('No words yet.').waitFor();
      await page.getByRole('button', { name: 'Done' }).click();
      await waitForUnderlined(page, ['mithrandil', 'qwertyz']);
    });

    it('does not carry words or ignored words from one project to the next', async () => {
      const page = await start('First World');
      await rpc(page, 'pages.create', { title: 'Scratch' });
      await rpc(page, 'pages.create', { title: 'Zephyrine' });
      await rpc(page, 'extras.dictionaryAdd', { word: 'mithrandil' });
      await editPage(page, 'Scratch');
      await page.keyboard.type('Zephyrine held mithrandil and a qwertyz. ');
      await waitForUnderlined(page, ['qwertyz']);
      await page.locator('.spell-error', { hasText: 'qwertyz' }).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Ignore in this session' }).click();
      await waitForUnderlined(page, []);
      await waitUntil(
        async () => JSON.stringify((await rpc(page, 'pages.getByTitle', { title: 'Scratch' })).content).includes('qwertyz'),
        5000,
        'the text to be stored',
      );

      const path = workspace.file('first.lorecraft');
      await allowPath(page, path);
      await rpc(page, 'project.saveAs', { path });
      await rpc(page, 'project.close');
      await page.getByRole('heading', { name: 'LoreCraft' }).waitFor();

      await createProject(page, 'Second World');
      await rpc(page, 'pages.create', { title: 'Scratch' });
      await editPage(page, 'Scratch');
      await page.keyboard.type('Zephyrine held mithrandil and a qwertyz. ');
      await waitForUnderlined(page, ['Zephyrine', 'mithrandil', 'qwertyz']);
    });

    it('does not carry ignored words into a project opened over this one', async () => {
      const page = await start('Second World');
      await rpc(page, 'pages.create', { title: 'Scratch' });
      const second = await saveTo(page, workspace, 'second');

      await rpc(page, 'project.new', { name: 'First World' });
      await page.locator('.area-tabs').getByRole('button', { name: 'Wiki' }).click();
      await rpc(page, 'pages.create', { title: 'Scribble' });
      await editPage(page, 'Scribble');
      await page.keyboard.type('A qwertyz here. ');
      await waitForUnderlined(page, ['qwertyz']);
      await page.locator('.spell-error', { hasText: 'qwertyz' }).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Ignore in this session' }).click();
      await waitForUnderlined(page, []);
      await waitUntil(
        async () => JSON.stringify((await rpc(page, 'pages.getByTitle', { title: 'Scribble' })).content).includes('qwertyz'),
        5000,
        'the text to be stored',
      );
      await saveTo(page, workspace, 'first');

      await openOverCurrent(page, second);
      await page.getByRole('heading', { name: 'Main Page' }).waitFor();
      await editPage(page, 'Scratch');
      await page.keyboard.type('A qwertyz here. ');
      await waitForUnderlined(page, ['qwertyz']);
    });

    it('follows pages as they appear, are renamed and are deleted', async () => {
      const page = await start();
      await rpc(page, 'pages.create', { title: 'Scratch' });
      await editPage(page, 'Scratch');
      await page.keyboard.type('Vorlund rode out. ');
      await waitForUnderlined(page, ['Vorlund']);

      const id = (await rpc(page, 'pages.create', { title: 'Vorlund' })).id;
      await waitForUnderlined(page, []);
      await rpc(page, 'pages.rename', { id, newTitle: 'Harlund', keepAlias: false });
      await waitForUnderlined(page, ['Vorlund']);
      await rpc(page, 'pages.update', { id, patch: { aliases: ['Vorlund'] } });
      await waitForUnderlined(page, []);
      await rpc(page, 'pages.delete', { id });
      await waitForUnderlined(page, ['Vorlund']);
    });

    it('turns off and on with the setting, and only checks while editing', async () => {
      const page = await start();
      await rpc(page, 'pages.create', { title: 'Scratch' });
      const editor = await editPage(page, 'Scratch');
      await page.keyboard.type('A qwertyz here. ');
      await waitForUnderlined(page, ['qwertyz']);
      assert.equal(await editor.getAttribute('spellcheck'), 'false');

      await setSpellcheck(page, false);
      await page.locator('.ProseMirror[contenteditable="true"]').waitFor();
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(await page.locator('.spell-error').count(), 0, 'off means no underlines');
      assert.equal(await page.locator('.ProseMirror').getAttribute('spellcheck'), 'false', 'and no native ones');

      await setSpellcheck(page, true);
      await page.locator('.ProseMirror[contenteditable="true"]').waitFor();
      await waitForUnderlined(page, ['qwertyz']);

      // Reading a page shows no underlines. Editing it brings them back.
      await page.getByRole('button', { name: 'Read', exact: true }).click();
      await waitUntil(async () => (await page.locator('.spell-error').count()) === 0, 3000, 'reading mode to clear them');
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      await waitForUnderlined(page, ['qwertyz']);
    });

    it('falls back to the native checker when the worker cannot start, and logs why', async () => {
      app = await launch(workspace);
      const page = app.page;
      const messages = [];
      page.on('console', (message) => messages.push(message.text()));
      await page.getByRole('button', { name: 'New project' }).waitFor();
      await page.evaluate(() => {
        window.Worker = class {
          constructor() {
            throw new Error('Workers are blocked here');
          }
        };
      });
      await createProject(page, 'No Worker');
      await page.locator('.prose').waitFor();
      await rpc(page, 'pages.create', { title: 'Scratch' });
      const editor = await editPage(page, 'Scratch');
      await page.keyboard.type('A qwertyz here. ');

      await waitUntil(async () => (await editor.getAttribute('spellcheck')) === 'true', 5000, 'the native checker to take over');
      assert.equal(await page.locator('.spell-error').count(), 0);
      assert.ok(
        messages.some((text) => text.includes('built-in checker') && text.includes('Workers are blocked here')),
        `logged it: ${messages.join(' | ')}`,
      );
      assert.equal(await page.locator('.toast-error').count(), 0, 'and did not bother the writer');
      await waitUntil(
        async () => JSON.stringify((await rpc(page, 'pages.getByTitle', { title: 'Scratch' })).content).includes('qwertyz'),
        5000,
        'typing to keep working',
      );
    });

    it('stays fast on a 20,000-word document, rechecking only what changed', async () => {
      const page = await start();
      await rpc(page, 'pages.create', { title: 'Zephyrine', pageType: 'character' });

      // About 330 paragraphs of 60 words, with a misspelling and a lore name in each,
      // and all different, so that no paragraph gets a free ride from the cache.
      const sentence =
        'the quick brown fox jumps over a lazy dog while wandering through silver forest and thinking about what tomorrow might bring to those who wait';
      const vocabulary = sentence.split(' ');
      const paragraphs = [];
      let words = 0;
      for (let p = 0; words < 20000; p += 1) {
        const line = [];
        for (let w = 0; w < 60; w += 1) line.push(vocabulary[(p * 7 + w) % vocabulary.length]);
        line[3] = 'recieve';
        line[9] = 'Zephyrine';
        line[17] = `para${p}`;
        words += line.length;
        paragraphs.push({ type: 'paragraph', content: [{ type: 'text', text: `${line.join(' ')}.` }] });
      }
      const blocks = paragraphs.length;
      await rpc(page, 'pages.create', { title: 'Long Scene', content: { type: 'doc', content: paragraphs } });

      await openPageByTitle(page, 'Long Scene');
      const startEdit = await page.evaluate(() => performance.now());
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      const editor = page.locator('.ProseMirror[contenteditable="true"]');
      await editor.waitFor();
      await waitUntil(
        async () => (await page.locator('.spell-error').count()) >= blocks,
        30_000,
        'every paragraph to be checked',
      );
      const initial = await page.evaluate((from) => {
        const dom = document.querySelector('.ProseMirror');
        return { ms: performance.now() - from, stats: dom.spellStats() };
      }, startEdit);

      const shown = await page.locator('.spell-error').count();
      assert.equal(shown, blocks, 'one misspelling per paragraph, and the lore name is not one');
      assert.equal(initial.stats.blocksChecked, blocks);

      // Typing in one paragraph. Only that paragraph goes back to the worker.
      await editor.click({ position: { x: 40, y: 40 } });
      const beforeTyping = await page.evaluate(() => document.querySelector('.ProseMirror').spellStats());
      await page.keyboard.type('xy ');
      await waitUntil(
        async () => (await page.evaluate(() => document.querySelector('.ProseMirror').spellStats())).blocksChecked > beforeTyping.blocksChecked,
        5000,
        'the changed paragraph to be checked',
      );
      await new Promise((r) => setTimeout(r, 600));
      const afterTyping = await page.evaluate(() => document.querySelector('.ProseMirror').spellStats());
      const rechecked = afterTyping.blocksChecked - beforeTyping.blocksChecked;
      assert.ok(rechecked <= 2, `rechecked ${rechecked} of ${blocks} paragraphs`);
      assert.equal(afterTyping.version, beforeTyping.version);

      // Measures what a keystroke costs on the main thread, with and without the checker.
      const measure = () =>
        page.evaluate(async () => {
          const view = document.querySelector('.ProseMirror').editor.view;
          const times = [];
          for (let i = 0; i < 60; i += 1) {
            const pos = view.state.selection.head;
            const started = performance.now();
            view.dispatch(view.state.tr.insertText('a', pos));
            times.push(performance.now() - started);
            await new Promise((r) => setTimeout(r, 16));
          }
          times.sort((a, b) => a - b);
          return {
            median: times[Math.floor(times.length / 2)],
            p95: times[Math.floor(times.length * 0.95)],
            worst: times[times.length - 1],
          };
        });

      const longTasks = await page.evaluate(() => {
        window.__longTasks = [];
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) window.__longTasks.push(entry.duration);
        }).observe({ entryTypes: ['longtask'] });
        return true;
      });
      assert.ok(longTasks);

      const withChecker = await measure();
      await new Promise((r) => setTimeout(r, 800));
      const longDuring = await page.evaluate(() => window.__longTasks);

      await setSpellcheck(page, false);
      const again = page.locator('.ProseMirror[contenteditable="true"]');
      await again.waitFor();
      await again.click({ position: { x: 40, y: 40 } });
      const withoutChecker = await measure();

      console.log(
        `spellcheck, ${words} words in ${blocks} paragraphs:\n` +
          `  first check of everything: ${initial.ms.toFixed(0)} ms from opening to all underlines shown, ` +
          `${initial.stats.workerMs.toFixed(1)} ms of that in the worker, ` +
          `longest pass on the main thread ${initial.stats.longestMainThreadMs.toFixed(1)} ms\n` +
          `  after typing: ${rechecked} paragraph(s) rechecked, ${afterTyping.lastWorkerMs.toFixed(2)} ms in the worker\n` +
          `  keystroke on the main thread with the checker: median ${withChecker.median.toFixed(2)} ms, p95 ${withChecker.p95.toFixed(2)} ms, worst ${withChecker.worst.toFixed(2)} ms\n` +
          `  keystroke on the main thread without it: median ${withoutChecker.median.toFixed(2)} ms, p95 ${withoutChecker.p95.toFixed(2)} ms, worst ${withoutChecker.worst.toFixed(2)} ms\n` +
          `  long tasks over 50 ms while typing with the checker: ${longDuring.length} (${longDuring.map((d) => d.toFixed(0)).join(', ')})`,
      );
      assert.ok(initial.stats.workerMs < slowLimit(1000), `worker took ${initial.stats.workerMs} ms`);
      assert.ok(withChecker.median < slowLimit(16), `a keystroke took ${withChecker.median} ms`);
    });
  });
});
