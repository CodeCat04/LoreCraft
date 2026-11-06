/**
 * Search by meaning in the real app: a passage found with no words in common, indexing that
 * leaves a saved project saved, and picking up again after a restart. The last test runs
 * the real built-in model over a whole book, through the same download a writer would see,
 * prints how long it took, and requires most of fourteen planted passages near the top. It
 * keeps the model in e2e/artifacts/model-cache, or in LORECRAFT_TEST_MODEL_DIR if set, so it
 * downloads once. CI sets that folder and caches it under the revision in MODEL_BASE, which it
 * reads from this file, so keep the address in the form .../resolve/<revision>.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';

import { ARTIFACTS, answerNextDialog, createProject, createWorkspace, launch, rpc, waitUntil } from './harness.mjs';

const MODEL_BASE =
  'https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/1110a243fdf4706b3f48f1d95db1a4f5529b4d41';
const MODEL_FILES = ['model.safetensors', 'vocab.txt'];

function writeSettings(workspace, embeddings) {
  mkdirSync(workspace.dataDir, { recursive: true });
  writeFileSync(join(workspace.dataDir, 'settings.json'), JSON.stringify({ ai: { embeddings } }));
}

function doc(paragraphs) {
  return {
    type: 'doc',
    content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
  };
}

async function addPage(page, title, paragraphs) {
  const created = await rpc(page, 'pages.create', { title });
  await rpc(page, 'pages.update', { id: created.id, patch: { content: doc(paragraphs) } });
  return created;
}

const status = (page) => rpc(page, 'embeddings.status');

async function waitForReady(page, timeoutMs = 60_000, atLeast = 0) {
  return waitUntil(
    async () => {
      const now = await status(page);
      if (now.state === 'failed') throw new Error(now.message);
      return now.state === 'ready' && now.done >= atLeast ? now : null;
    },
    timeoutMs,
    'the index to be ready',
  );
}

async function searchFromTopBar(page, q) {
  const box = page.getByRole('combobox', { name: 'Search this project' });
  await box.fill(q);
  await box.press('Enter');
  await page.getByRole('heading', { name: 'Search results' }).waitFor();
}

test('a passage is found with no words in common, and a saved project stays saved', async () => {
  const workspace = createWorkspace();
  writeSettings(workspace, { enabled: true, source: 'fake', profileId: '', model: '' });
  let app = await launch(workspace);
  try {
    const { page } = app;
    await createProject(page, 'Northern Keep');
    // The main page is indexed first, in a few passages, and the new pages count on top of it.
    const first = await waitForReady(page);
    await addPage(page, 'Aria', ['Aria guarded the northern door.']);
    await addPage(page, 'Soup', ['Boil two onions with barley until soft.']);

    const file = workspace.file('keep.lorecraft');
    await answerNextDialog(page, file);
    await page.keyboard.press('Control+Shift+S');
    await page.locator('[data-testid="save-state"]', { hasText: 'All changes saved' }).waitFor();
    const savedSize = statSync(file).size;

    // Saving is not what starts it: the loop notices the new pages by itself.
    const ready = await waitForReady(page, 60_000, first.done + 2);
    assert.ok(ready.done >= first.done + 2, `indexed ${ready.done}`);
    assert.equal(ready.done, ready.total);
    assert.equal((await rpc(page, 'project.status')).dirty, false, 'indexing is not an edit');
    await page.locator('[data-testid="save-state"]', { hasText: 'All changes saved' }).waitFor();
    assert.equal(statSync(file).size, savedSize, 'the file on disk is untouched');

    await searchFromTopBar(page, 'the knight at the gate');
    const related = page.getByTestId('meaning-related');
    await related.getByRole('heading', { name: 'Related by meaning' }).waitFor();
    await related.getByText('Aria guarded the northern door.').waitFor();
    assert.equal(await related.getByText('Boil two onions').count(), 0);
    // The keyword results are as they were.
    await page.getByText('Nothing matches “the knight at the gate”.').waitFor();
    await app.screenshot('meaning-related');

    await related.getByRole('link', { name: 'Aria' }).click();
    await page.getByRole('heading', { name: 'Aria', level: 1 }).waitFor();

    // A restart with nothing saved since indexing: the work is not done twice.
    const embeddedBefore = ready.embedded;
    assert.ok(embeddedBefore >= 2);
    await app.kill();
    app = await launch(workspace, { args: [file] });
    await app.page.locator('.topbar').waitFor();
    const again = await waitForReady(app.page, 60_000, ready.done);
    assert.equal(again.done, ready.done);
    assert.equal(again.embedded, 0, 'nothing went through the model again');
    assert.equal((await rpc(app.page, 'project.status')).dirty, false);
    const hits = await rpc(app.page, 'embeddings.search', { q: 'the knight at the gate' });
    assert.equal(hits[0].title, 'Aria');
  } finally {
    await app.kill().catch(() => {});
    workspace.cleanup();
  }
});

test('a provider profile, starting with a server that has no embeddings service', async () => {
  // Like the author's local server at first, which answers 404. Then like LM Studio.
  let hasEmbeddings = false;
  const sent = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (d) => {
      body += d;
    });
    request.on('end', () => {
      if (!hasEmbeddings || !request.url.endsWith('/embeddings')) {
        response.writeHead(404);
        response.end();
        return;
      }
      const { input, model } = JSON.parse(body);
      sent.push(...input);
      const data = input.map((text, index) => {
        const embedding = new Array(32).fill(0);
        for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
          embedding[[...word].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 32] += 1;
        }
        return { index, embedding };
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ model, data }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

  const workspace = createWorkspace();
  mkdirSync(workspace.dataDir, { recursive: true });
  writeFileSync(
    join(workspace.dataDir, 'settings.json'),
    JSON.stringify({ ai: { profiles: [{ id: 'local', name: 'Local model', kind: 'openai-compatible', baseUrl, model: '', isCloud: false }] } }),
  );
  const app = await launch(workspace);
  try {
    const { page } = app;
    await createProject(page, 'Profile World');
    await addPage(page, 'Aria', ['Aria guarded the northern door.']);
    await page.getByRole('button', { name: /^Text \d+%/ }).click();
    // Exact, because Settings also has an "AI tools (MCP)" tab.
    await page.getByRole('tab', { name: 'AI', exact: true }).click();
    const settings = page.getByTestId('meaning-settings');
    await settings.getByRole('checkbox').check();
    await settings.getByRole('radio', { name: /provider profile/ }).check();
    await settings.getByTestId('meaning-state').getByText('Not set up').waitFor();
    await settings.getByRole('textbox', { name: 'Embeddings model' }).fill('embed-small');
    await settings.getByRole('button', { name: 'Test this model' }).click();
    await settings.getByTestId('meaning-test-result').getByText(/no embeddings service/).waitFor();
    await settings.getByRole('textbox', { name: 'Embeddings model' }).press('Enter');
    await settings.getByTestId('meaning-state').getByText(/Failed\. .*no embeddings service/).waitFor();
    await page.getByTestId('meaning-status').getByRole('button', { name: 'Search by meaning failed' }).waitFor();
    assert.deepEqual(sent, []);
    await app.screenshot('meaning-settings-no-service');

    hasEmbeddings = true;
    await settings.getByRole('button', { name: 'Test this model' }).click();
    await settings.getByTestId('meaning-test-result').getByText(/It works/).waitFor();
    await settings.getByRole('button', { name: 'Try again' }).click();
    await settings.getByTestId('meaning-state').getByText(/Ready\. .* indexed with embed-small/).waitFor({ timeout: 30_000 });
    assert.ok(sent.some((text) => text.includes('Aria guarded the northern door')));

    const hits = await rpc(page, 'embeddings.search', { q: 'aria guarded the northern door' });
    assert.equal(hits[0].title, 'Aria');
    assert.equal((await status(page)).isCloud, false);
    await app.screenshot('meaning-settings-ready');
  } finally {
    await app.kill().catch(() => {});
    workspace.cleanup();
    server.close();
  }
});

// ---- A whole book, with the real model ------------------------------------------------------

/** Sentences that vary, so every passage is different, about anything but gates and guards. */
function bookOfWords(totalWords) {
  let seed = 12345;
  const random = (n) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return Math.floor((seed / 4294967296) * n);
  };
  const pick = (list) => list[random(list.length)];
  const people = ['Lyra', 'Tomas', 'Old Berrin', 'The miller', 'Sefa', 'Her brother', 'The ferryman', 'Ansel'];
  const verbs = ['carried', 'mended', 'counted', 'traded', 'painted', 'sold', 'folded', 'cleaned', 'weighed', 'hid'];
  const things = ['the fishing nets', 'a basket of plums', 'the copper kettle', 'his winter boots', 'the blue wool', 'a sack of barley', 'the ledger', 'the old map', 'a jar of honey', 'the rope'];
  const places = ['by the river', 'in the market', 'under the willow', 'at the mill', 'along the canal', 'in the orchard', 'behind the bakery', 'on the hillside', 'near the bridge', 'in the attic'];
  const times = ['before the rain came', 'as the sun went down', 'while the bells rang', 'early in the spring', 'after the long harvest', 'when the snow melted', 'during the fair', 'at first light'];
  const thoughts = [
    'Nobody spoke of the money again.',
    'The smell of woodsmoke hung over everything.',
    'It had been a poor year for apples.',
    'She laughed and said it did not matter.',
    'He wondered whether the letter would ever arrive.',
    'The children ran ahead, shouting about the geese.',
    'There was still bread on the table.',
    'The water was higher than anyone remembered.',
  ];
  const sentence = () => `${pick(people)} ${pick(verbs)} ${pick(things)} ${pick(places)} ${pick(times)}. ${pick(thoughts)}`;
  const scenes = [];
  let written = 0;
  while (written < totalWords) {
    const paragraphs = [];
    let words = 0;
    while (words < 1000) {
      let paragraph = '';
      const sentences = 2 + random(5);
      for (let i = 0; i < sentences; i += 1) paragraph += `${sentence()} `;
      paragraph = paragraph.trim();
      paragraphs.push(paragraph);
      words += paragraph.split(/\s+/).length;
    }
    scenes.push(paragraphs);
    written += words;
  }
  return { scenes, written };
}

/**
 * Questions and the passages that answer them, the same as `PLANTED` in
 * src-tauri/src/embeddings/bench.rs, which measures them. The first twelve share no words with
 * their passage beyond small ones like "the".
 */
const PLANTED = [
  ['the knight at the gate', 'Aria guarded the northern door. All night she stood there with her spear, and nobody passed her.'],
  ['a ship lost in a storm', 'The waves rose higher than the masts, and by morning the Swallow had gone under with all her crew.'],
  ["someone poisoned the king's wine", 'Ansel tipped the vial of nightshade into the royal cup while the old man was looking away.'],
  ['a wedding feast', "The bride wore her mother's veil, and the tables groaned under roast goose and sweet cakes until midnight."],
  ['afraid of the dark', 'Even grown, Sefa could not sleep unless a candle burned beside her bed, because the black corners of the room still frightened her.'],
  ['a dragon attacked the village', 'Fire rained from the great wings, and by dawn every thatched roof in Millbrook was ash.'],
  ['learning to read', 'Old Berrin traced each letter with his finger, sounding out the words of the primer one slow syllable at a time.'],
  ['a secret tunnel under the castle', 'Behind the tapestry a narrow stair went down into the rock, far below the fortress walls, to a passage nobody had mapped.'],
  ['the healer saved the sick child', "The herb woman pressed willow bark and honey to the boy's lips, and by morning his fever had broken."],
  ['a sword fight at dawn', 'At first light the two men faced each other on the frozen field, blades drawn, while their seconds looked on.'],
  ['betrayed by a friend', 'Tomas had trusted him for twenty years, and still he sold their hiding place to the soldiers for a handful of silver.'],
  ['grief after a funeral', 'When the last mourner had gone, Lyra sat alone by the fresh grave and wept until her voice gave out.'],
  ['the crown of Eldoria', 'The crown of Eldoria was lost the night the old queen died, and no smith since has been able to copy it.'],
  ['where the old map was hidden', 'The old map was hidden beneath the floorboards of the chapel, wrapped in oilcloth.'],
];

/** Whether a result shows some of a planted passage: any of its sentences. */
function shows(snippet, passage) {
  return passage
    .split('. ')
    .map((s) => s.replace(/\.$/, ''))
    .filter((s) => s.length >= 12)
    .some((s) => snippet.includes(s));
}

async function fetchModelInto(dir) {
  mkdirSync(dir, { recursive: true });
  for (const name of MODEL_FILES) {
    if (existsSync(join(dir, name))) continue;
    const response = await fetch(`${MODEL_BASE}/${name}`);
    assert.ok(response.ok, `downloading ${name}: ${response.status}`);
    writeFileSync(join(dir, name), Buffer.from(await response.arrayBuffer()));
  }
}

/** Serves the model as the real server would, and can serve a damaged one first. */
function serveModel(dir, { damagedFirst = false } = {}) {
  let damage = damagedFirst;
  const server = createServer((request, response) => {
    const name = decodeURIComponent(new URL(request.url, 'http://x').pathname.slice(1));
    if (!MODEL_FILES.includes(name)) {
      response.writeHead(404);
      response.end();
      return;
    }
    const path = join(dir, name);
    if (damage && name === 'vocab.txt') {
      damage = false;
      const size = statSync(path).size;
      response.writeHead(200, { 'content-length': size });
      response.end(Buffer.alloc(size, 0x41));
      return;
    }
    response.writeHead(200, { 'content-length': statSync(path).size });
    createReadStream(path).pipe(response);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('the real model, from download to a whole book', { timeout: 20 * 60_000 }, async () => {
  const cache = process.env.LORECRAFT_TEST_MODEL_DIR ?? join(ARTIFACTS, 'model-cache');
  await fetchModelInto(cache);
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(join(cache, 'vocab.txt')).on('data', (d) => hash.update(d)).on('end', resolve).on('error', reject);
  });
  assert.equal(hash.digest('hex'), '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3');

  const { server, url } = await serveModel(cache, { damagedFirst: true });
  const workspace = createWorkspace();
  const app = await launch(workspace, { env: { LORECRAFT_MODEL_URL: url } });
  try {
    const { page } = app;
    await createProject(page, 'A Whole Book');

    // Off until the writer turns it on, and the model comes only after a yes with a size.
    assert.equal((await status(page)).state, 'off');
    await page.getByRole('button', { name: /^Text \d+%/ }).click();
    await page.getByRole('tab', { name: 'AI', exact: true }).click();
    const settings = page.getByTestId('meaning-settings');
    await settings.getByRole('checkbox').check();
    await settings.getByRole('radio', { name: /built-in model/ }).waitFor();
    const state = settings.getByTestId('meaning-state');
    await state.getByText('Not set up').waitFor();
    assert.equal((await status(page)).builtinPresent, false);
    const download = settings.getByRole('button', { name: 'Download the model (91 MB)' });
    await download.waitFor();
    await app.screenshot('meaning-settings-before-download');

    // First the server sends a damaged file, which is refused with a reason.
    await download.click();
    await state.getByText(/arrived damaged/).waitFor({ timeout: 120_000 });
    assert.equal((await status(page)).state, 'failed');
    await app.screenshot('meaning-settings-failed');

    await state.getByRole('button', { name: 'Try again' }).click();
    await settings.getByRole('button', { name: 'Download the model (91 MB)' }).click();
    await waitUntil(async () => (await status(page)).builtinPresent, 120_000, 'the model to arrive');
    assert.ok(existsSync(join(workspace.dataDir, 'models', 'all-MiniLM-L6-v2', 'model.safetensors')));

    // A book of 100,000 words, with passages to find in it, planted where the benchmark plants them.
    const { scenes, written } = bookOfWords(100_000);
    const books = await rpc(page, 'books.list');
    const tree = await rpc(page, 'nodes.tree', { bookId: books[0].id });
    const chapter = tree.find((node) => node.kind === 'chapter');
    const targets = PLANTED.map(([, passage], i) => {
      const scene = (Math.floor(scenes.length / 2) + i * 7) % scenes.length;
      scenes[scene].splice(3, 0, passage);
      return scene;
    });
    await rpc(page, 'embeddings.cancel');
    const sceneIds = [];
    for (const [i, paragraphs] of scenes.entries()) {
      const scene = await rpc(page, 'nodes.create', { bookId: books[0].id, parentId: chapter.id, kind: 'scene', title: `Scene ${i + 1}` });
      await rpc(page, 'nodes.update', { id: scene.id, patch: { content: doc(paragraphs) } });
      sceneIds.push(scene.id);
    }
    await rpc(page, 'embeddings.resume');

    // Indexing runs from the status bar, and can be stopped and resumed from there.
    const started = Date.now();
    // Any change wakes the indexing loop, a few seconds later.
    await rpc(page, 'pages.create', { title: 'A first page' });
    const bar = page.getByTestId('meaning-status');
    await bar.getByText(/Indexing [\d,]+ of [\d,]+/).waitFor({ timeout: 60_000 });
    await app.screenshot('meaning-status-indexing');
    await bar.getByRole('button', { name: 'Stop' }).click();
    await bar.getByText(/Indexing stopped at/).waitFor();
    await bar.getByRole('button', { name: 'Resume' }).click();
    await bar.getByText(/Indexing [\d,]+ of [\d,]+/).waitFor();

    // While it runs, the project answers quickly and saving works.
    const latencies = [];
    for (let i = 0; i < 20; i += 1) {
      const before = Date.now();
      await rpc(page, 'pages.list', { limit: 5 });
      latencies.push(Date.now() - before);
      await new Promise((r) => setTimeout(r, 200));
    }
    const slowest = Math.max(...latencies);
    const file = workspace.file('book.lorecraft');
    await answerNextDialog(page, file);
    const saveStart = Date.now();
    await page.keyboard.press('Control+Shift+S');
    await page.locator('[data-testid="save-state"]', { hasText: 'All changes saved' }).waitFor({ timeout: 30_000 });
    const saveWhileIndexing = Date.now() - saveStart;

    const ready = await waitForReady(page, 15 * 60_000, 500);
    const seconds = (Date.now() - started) / 1000;
    const size = statSync(file).size;
    console.log(
      `\nModel all-MiniLM-L6-v2: ${written.toLocaleString()} words, ${ready.done} passages, indexed in ${seconds.toFixed(0)} s, ` +
        `about ${((seconds * 1000) / ready.embedded).toFixed(0)} ms per passage. Reads took at most ${slowest} ms while indexing, ` +
        `and a save during indexing took ${saveWhileIndexing} ms.`,
    );
    assert.ok(ready.done > 500, `passages: ${ready.done}`);
    assert.equal((await rpc(page, 'project.status')).dirty, false);

    // It finds the passages among everything else, most sharing no words with their question.
    // The bars are one below what `book_scale_through_the_app` in
    // src-tauri/src/embeddings/bench.rs measures on this book (8 of 14 first, 12 of 14 in the
    // first five), so a real loss fails here. "The knight at the gate" is one the built-in model
    // still misses: the made-up book is all market towns, mills and bells, which it finds about
    // as close to knights and gates as the passage. So its place is reported, not required.
    const places = [];
    for (const [i, [q, passage]] of PLANTED.entries()) {
      const hits = await rpc(page, 'embeddings.search', { q, limit: 10 });
      const place = hits.findIndex((h) => h.id === sceneIds[targets[i]] && shows(h.snippet, passage));
      places.push(place);
      console.log(`"${q}": ${place >= 0 ? `place ${place + 1}` : 'not in the first ten'}`);
    }
    const within = (n) => places.filter((p) => p >= 0 && p < n).length;
    console.log(`Found first ${within(1)} of ${PLANTED.length}, in the first five ${within(5)}, in the first ten ${within(10)}.`);
    assert.ok(within(1) >= 7, `found first: ${within(1)} of ${PLANTED.length}`);
    assert.ok(within(5) >= 11, `found in the first five: ${within(5)} of ${PLANTED.length}`);
    await searchFromTopBar(page, 'the knight at the gate');
    const related = page.getByTestId('meaning-related');
    await related.getByRole('heading', { name: 'Related by meaning' }).waitFor();
    await app.screenshot('meaning-book-results');

    // Saving the whole thing stays quick.
    await page.locator('.topbar').waitFor();
    await rpc(page, 'pages.create', { title: 'A small edit' });
    const before = Date.now();
    await rpc(page, 'project.save');
    const saveMs = Date.now() - before;
    console.log(`Saving ${(statSync(file).size / 1_000_000).toFixed(1)} MB with the index took ${saveMs} ms, and the file was ${(size / 1_000_000).toFixed(1)} MB before it.`);
    assert.ok(saveMs < 5000, `saving took ${saveMs} ms`);
  } finally {
    await app.kill().catch(() => {});
    workspace.cleanup();
    server.close();
  }
});
