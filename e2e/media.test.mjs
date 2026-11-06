import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, copyFileSync, ftruncateSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { pmToPlainText, describeFigures } from '../src/editor/convert.ts';
import { allowPath, answerNextDialog, createProject, createWorkspace, launch, rpc, waitUntil } from './harness.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => readFileSync(join(FIXTURES, name)).toString('base64');

const WORDS =
  'The road from the Silver Vale climbs through old orchards before it reaches the gate, and travellers tell of lanterns that move on their own after dark. ';

function paragraphs(count, repeat = 6) {
  return {
    type: 'doc',
    content: Array.from({ length: count }, (_, i) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: `${i + 1}. ${WORDS.repeat(repeat)}` }],
    })),
  };
}

/** Runs in the page: makes real files, then drops them on an element as the OS would. */
async function dropFiles(page, specs, { selector = '.ProseMirror', x = 0.5, y = 0.1 } = {}) {
  await page.evaluate(
    async ({ specs, selector, x, y }) => {
      const make = async (spec) => {
        if (spec.png) {
          const canvas = document.createElement('canvas');
          canvas.width = spec.png.width;
          canvas.height = spec.png.height;
          const g = canvas.getContext('2d');
          g.fillStyle = spec.png.color ?? '#4a7';
          g.fillRect(0, 0, canvas.width, canvas.height);
          g.fillStyle = '#fff';
          g.font = '32px sans-serif';
          g.fillText(spec.name, 16, 48);
          const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
          return new File([blob], spec.name, { type: spec.type ?? 'image/png' });
        }
        const bytes = Uint8Array.from(atob(spec.base64), (c) => c.charCodeAt(0));
        return new File([bytes], spec.name, { type: spec.type ?? '' });
      };
      const data = new DataTransfer();
      for (const spec of specs) data.items.add(await make(spec));
      const target = document.querySelector(selector);
      const rect = target.getBoundingClientRect();
      const init = {
        dataTransfer: data,
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width * x,
        clientY: rect.top + rect.height * y,
      };
      target.dispatchEvent(new DragEvent('dragenter', init));
      target.dispatchEvent(new DragEvent('dragover', init));
      window.__lastDropLine = document.querySelector('.figure-drop-line')?.getBoundingClientRect().toJSON() ?? null;
      target.dispatchEvent(new DragEvent('drop', init));
    },
    { specs, selector, x, y },
  );
}

/**
 * Drops a real file from disk. The file input gives the page a disk-backed `File`, which
 * is the same kind an OS drop carries, so its bytes take the real road.
 */
async function dropDiskFile(page, path, { x = 0.02, y = 0.02 } = {}) {
  const session = await page.context().newCDPSession(page);
  const { result } = await session.send('Runtime.evaluate', {
    expression: `(() => {
      const element = document.createElement('input');
      element.type = 'file';
      element.hidden = true;
      document.body.append(element);
      window.__dropInput = element;
      return element;
    })()`,
  });
  await session.send('DOM.setFileInputFiles', { files: [path], objectId: result.objectId });
  await session.detach();
  return page.evaluate(
    ([x, y]) => {
      const element = window.__dropInput;
      const data = new DataTransfer();
      data.items.add(element.files[0]);
      element.remove();
      const target = document.querySelector('.ProseMirror');
      const rect = target.getBoundingClientRect();
      const started = performance.now();
      target.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: data,
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width * x,
          clientY: rect.top + rect.height * y,
        }),
      );
      return started;
    },
    [x, y],
  );
}

/**
 * Drags a file from disk into the page through the browser's own drag handling, as near as
 * a test gets to a drag from Explorer. The events are trusted and the data is read-only
 * until the drop, as with a real one. The page's own handling decides what becomes of it.
 */
async function realDrag(page, path, x, y) {
  const session = await page.context().newCDPSession(page);
  const data = { items: [], files: [path], dragOperationsMask: 1 };
  await session.send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data });
  await session.send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data });
  const line = await page.evaluate(() => document.querySelector('.figure-drop-line')?.getBoundingClientRect().toJSON() ?? null);
  await session.send('Input.dispatchDragEvent', { type: 'drop', x, y, data });
  await session.detach();
  return line;
}

/** Writes a file of `size` bytes: `head`, then pseudo-random bytes in a box players skip. */
function writeBigVideo(path, size) {
  const head = readFileSync(join(FIXTURES, 'tiny-h264.mp4'));
  const padding = size - head.length;
  const box = Buffer.alloc(8);
  box.writeUInt32BE(padding, 0);
  box.write('free', 4, 'latin1');
  const fd = openSync(path, 'w');
  writeSync(fd, head);
  writeSync(fd, box);
  const block = randomBytes(1024 * 1024);
  let left = padding - 8;
  for (; left >= block.length; left -= block.length) writeSync(fd, block);
  writeSync(fd, block, 0, left);
  closeSync(fd);
}

/** A file that only starts like a video, instantly, however large. */
function writeSparseVideo(path, size) {
  const fd = openSync(path, 'w');
  writeSync(fd, Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]));
  ftruncateSync(fd, size);
  closeSync(fd);
}

/** Goes to Edit on the home page and fills it with text. */
async function editHome(page, doc = paragraphs(6)) {
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('.ProseMirror[contenteditable="true"]').waitFor();
  await page.evaluate((json) => {
    document.querySelector('.ProseMirror').editor.commands.setContent(json, { emitUpdate: true });
  }, doc);
}

const editorJson = (page) => page.evaluate(() => document.querySelector('.ProseMirror').editor.getJSON());

async function storedHome(page) {
  return (await rpc(page, 'pages.home')).content;
}

async function waitForStored(page, predicate, label) {
  return waitUntil(
    async () => {
      const content = await storedHome(page);
      return predicate(content) ? content : null;
    },
    8000,
    label,
  );
}

/** The figures of a page, once it has this many stored. */
function waitForStored2(page, id, count) {
  return waitUntil(
    async () => {
      const figures = describeFigures((await rpc(page, 'pages.get', { id })).content);
      return figures.length === count ? figures : null;
    },
    8000,
    `${count} figures to be stored`,
  );
}

async function selectionInfo(page) {
  return page.evaluate(() => {
    const { editor } = document.querySelector('.ProseMirror');
    const { selection } = editor.state;
    return {
      parent: selection.$from.parent.type.name,
      nodeSelected: selection.node?.type.name ?? null,
      focused: editor.view.hasFocus(),
      empty: selection.empty,
    };
  });
}

/** Where a figure is, and where the text in the block after it runs. */
function layoutOfFigure(page, index = 0) {
  return page.evaluate((index) => {
    const figure = document.querySelectorAll('.prose .figure[data-kind]')[index];
    const box = figure.getBoundingClientRect();
    const lines = [];
    for (let next = figure.nextElementSibling; next; next = next.nextElementSibling) {
      if (next.tagName !== 'P') continue;
      const range = document.createRange();
      range.selectNodeContents(next);
      for (const r of range.getClientRects()) lines.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
    }
    const column = document.querySelector('.prose').getBoundingClientRect();
    return {
      float: getComputedStyle(figure).float,
      figure: { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width },
      lines,
      column: { left: column.left, right: column.right, width: column.width },
    };
  }, index);
}

/** Text beside the figure must stay clear of it, and text below must use the full column. */
function assertTextWraps(layout, side) {
  const { figure, lines, column } = layout;
  const beside = lines.filter((l) => l.top < figure.bottom - 2 && l.bottom > figure.top + 2);
  const below = lines.filter((l) => l.top >= figure.bottom + 2);
  assert.ok(beside.length >= 2, `some lines run beside the figure: ${JSON.stringify(layout)}`);
  assert.ok(below.length >= 1, `some lines run below the figure: ${JSON.stringify(layout)}`);
  for (const line of beside) {
    if (side === 'right') assert.ok(line.right <= figure.left + 1, `line clear of a right figure: ${JSON.stringify(line)} ${JSON.stringify(figure)}`);
    else assert.ok(line.left >= figure.right - 1, `line clear of a left figure: ${JSON.stringify(line)} ${JSON.stringify(figure)}`);
  }
  const widest = Math.max(...below.map((l) => l.right - l.left));
  assert.ok(widest > column.width * 0.8, 'below the figure, text gets the whole column back');
  assert.ok(figure.width < column.width * 0.8);
}

async function clickFigureTool(page, name, index = 0) {
  const figure = page.locator('.prose .figure[data-kind]').nth(index);
  await figure.hover();
  await figure.getByRole('button', { name, exact: true }).click();
}

async function imageLoaded(page, locator) {
  await waitUntil(() => locator.evaluate((i) => i.complete && i.naturalWidth > 0), 8000, 'the picture to load');
  return locator.evaluate((i) => i.naturalWidth);
}

/**
 * Whether the web view can play H.264, the usual codec in .mp4 and .mov files. Windows plays it
 * through its own media features, which Windows Server leaves out, and so do the N editions
 * until the Media Feature Pack is added. GitHub's Windows machines may have none.
 *
 * canPlayType answers first. In case it says yes without a decoder behind it, the small fixture
 * is opened too, and an error there also means no. Waiting with no answer counts as yes, so a
 * slow machine still runs the playback checks and reports what really happened.
 */
function canPlayH264(page) {
  return page.evaluate(async (base64) => {
    const video = document.createElement('video');
    if (video.canPlayType('video/mp4; codecs="avc1.42E01E"') === '') return false;
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
    try {
      return await new Promise((resolve) => {
        setTimeout(() => resolve(true), 15000);
        video.addEventListener('loadeddata', () => resolve(true), { once: true });
        video.addEventListener('error', () => resolve(false), { once: true });
        video.muted = true;
        video.preload = 'auto';
        video.src = url;
      });
    } finally {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    }
  }, fixture('tiny-h264.mp4'));
}

/** Plays a video from the start and jumps within it. Returns what happened. */
function playAndSeek(locator, to = 1.5) {
  return locator.evaluate(async (video, to) => {
    const wait = (event, ms = 8000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${event}`)), ms);
        video.addEventListener(event, () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    if (video.readyState < 2) await wait('loadeddata');
    const first = { readyState: video.readyState, duration: video.duration, width: video.videoWidth };
    video.muted = true;
    await video.play();
    const start = performance.now();
    while (video.currentTime < 0.2 && performance.now() - start < 8000) await new Promise((r) => setTimeout(r, 20));
    const playedTo = video.currentTime;
    video.pause();
    const seeked = wait('seeked');
    video.currentTime = to;
    await seeked;
    return { ...first, playedTo, seekedTo: video.currentTime, readyAfterSeek: video.readyState };
  }, to);
}

describe('media', () => {
  let workspace;
  let app;
  let problems;

  beforeEach(() => {
    workspace = createWorkspace();
    problems = [];
  });

  afterEach(async () => {
    if (app && !app.exited) await app.kill().catch(() => {});
    workspace.cleanup();
  });

  function watchForProblems(page) {
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text())) problems.push(m.text());
    });
    return page;
  }

  async function start() {
    app = await launch(workspace);
    return watchForProblems(app.page);
  }

  function assertNoProblems() {
    assert.deepEqual(problems, [], 'no script errors or blocked resources');
  }

  it('drops a picture, labels it, wraps text around it, and keeps it through a reopen', async () => {
    const page = await start();
    await createProject(page, 'Media World');
    await editHome(page);

    await dropFiles(page, [{ png: { width: 640, height: 360 }, name: 'dawn.png' }], { y: 0.3 });
    const line = await page.evaluate(() => window.__lastDropLine);
    assert.ok(line && line.width > 100, `a drop line showed while dragging: ${JSON.stringify(line)}`);
    assert.equal(await page.locator('.figure-drop-line').count(), 0, 'it goes when the drop lands');

    const figure = page.locator('.prose .figure[data-kind]');
    await figure.waitFor();
    assert.equal(await figure.getAttribute('data-kind'), 'picture');
    assert.equal(await imageLoaded(page, figure.locator('.media-frame img')), 640);
    assert.equal(await figure.getAttribute('data-align'), 'right');

    // The label is focused and says what it is for.
    await waitUntil(async () => (await selectionInfo(page)).parent === 'figcaption', 8000, 'the label to get the cursor');
    assert.equal((await selectionInfo(page)).focused, true);
    assert.match(await figure.locator('.figure-hint').innerText(), /Label this picture so the AI knows what it shows/);
    await app.screenshot('media-label-prompt');

    await page.keyboard.type('Aria at the gate at dawn');
    assert.equal(await figure.locator('.figure-hint').count(), 0, 'the hint gives way to the label');
    const caption = await figure.locator('figcaption').evaluate((c) => ({
      text: c.textContent,
      name: getComputedStyle(c, '::before').content,
    }));
    assert.equal(caption.text, 'Aria at the gate at dawn');
    assert.match(caption.name, /Picture.*counter\(fig-picture\)/, 'numbered by CSS, not stored');

    // Text wraps on the left of a right-aligned figure, and the label reaches the AI.
    assertTextWraps(await layoutOfFigure(page), 'right');
    const stored = await waitForStored(
      page,
      (doc) => JSON.stringify(doc).includes('Aria at the gate at dawn'),
      'the label to be stored',
    );
    assert.match(pmToPlainText(stored), /\[Picture 1: Aria at the gate at dawn\]/);
    assert.equal(describeFigures(stored)[0].caption, 'Aria at the gate at dawn');
    const found = await rpc(page, 'search.query', { q: 'gate dawn' });
    assert.ok(found.length > 0, 'labels are searchable');
    await app.screenshot('media-wrap-right');

    // More detail for the AI, which also becomes the alt text.
    await clickFigureTool(page, 'More detail for the AI');
    const area = page.getByRole('textbox', { name: 'More detail for the AI (optional)' });
    await area.fill('Aria stands alone under a pale sky.');
    await app.screenshot('media-describe-popover');
    await page.keyboard.press('Escape');
    await waitUntil(async () => (await page.locator('.figure-describe').count()) === 0, 8000, 'the popover to close');
    assert.equal(await figure.getAttribute('data-description'), 'Aria stands alone under a pale sky.');
    assert.equal(await figure.locator('.media-frame img').getAttribute('alt'), 'Aria stands alone under a pale sky.');
    const withDetail = await waitForStored(page, (doc) => JSON.stringify(doc).includes('pale sky'), 'the description');
    assert.match(pmToPlainText(withDetail), /\[Picture 1: Aria at the gate at dawn \(Aria stands alone under a pale sky\.\)\]/);

    // Wrap the other way.
    await clickFigureTool(page, 'Wrap left');
    assert.equal(await figure.getAttribute('data-align'), 'left');
    const left = await layoutOfFigure(page);
    assert.equal(left.float, 'left');
    assertTextWraps(left, 'left');
    await app.screenshot('media-wrap-left');

    // Drag the corner to resize, which is one edit stored as a percent of the column.
    const before = (await layoutOfFigure(page)).figure.width;
    await figure.hover();
    const handle = figure.locator('.figure-resize');
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 40, { steps: 5 });
    await page.mouse.up();
    const resized = await layoutOfFigure(page);
    assert.ok(resized.figure.width > before + 80, `${resized.figure.width} is wider than ${before}`);
    const percent = Number(await figure.getAttribute('data-width'));
    assert.ok(Math.abs(percent - (resized.figure.width / resized.column.width) * 100) < 1.5, `${percent}% of the column`);
    assertTextWraps(resized, 'left');

    // It will not go below the minimum, and that drag undoes in one step.
    await figure.hover();
    const box2 = await handle.boundingBox();
    await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
    await page.mouse.down();
    await page.mouse.move(box2.x - 2000, box2.y, { steps: 3 });
    await page.mouse.up();
    assert.equal(await figure.getAttribute('data-width'), '15');
    await page.keyboard.press('Control+z');
    assert.equal(Number(await figure.getAttribute('data-width')), percent);

    // Center and full width do not wrap.
    await clickFigureTool(page, 'Center');
    assert.equal((await layoutOfFigure(page)).float, 'none');
    await clickFigureTool(page, 'Full width');
    const full = await layoutOfFigure(page);
    assert.equal(await figure.getAttribute('data-width'), null);
    assert.ok(full.figure.width > full.column.width - 2);
    await clickFigureTool(page, 'Wrap right');
    assert.equal(await figure.getAttribute('data-align'), 'right');

    // Kind changes the name and number.
    await figure.hover();
    await figure.getByRole('combobox', { name: 'Kind' }).selectOption('figure');
    const relabeled = await figure.locator('figcaption').evaluate((c) => getComputedStyle(c, '::before').content);
    assert.match(relabeled, /Figure.*counter\(fig-figure\)/);

    await waitForStored(page, (doc) => doc.content.some((n) => n.type === 'figure' && n.attrs.kind === 'figure'), 'the kind to be stored');

    // Save, close and reopen. The picture has to actually load from the saved file.
    const path = workspace.file('media.lorecraft');
    await allowPath(page, path);
    await rpc(page, 'project.saveAs', { path });
    await rpc(page, 'project.close');
    await page.getByRole('heading', { name: 'LoreCraft' }).waitFor();
    await page.getByRole('button', { name: /^media/ }).first().click();
    const reopened = page.locator('.prose .figure[data-kind]');
    await reopened.waitFor();
    const image = reopened.locator('.media-frame img');
    assert.ok((await imageLoaded(page, image)) > 0);
    assert.equal(await image.evaluate((i) => new URL(i.src).hostname), 'lbasset.localhost');
    assert.equal(await reopened.locator('figcaption').innerText(), 'Aria at the gate at dawn');
    assert.equal(await reopened.getAttribute('data-kind'), 'figure');
    assertTextWraps(await layoutOfFigure(page), 'right');
    await app.screenshot('media-read-mode');
    assertNoProblems();
  });

  it('takes a file dragged from disk with real drag events', async () => {
    const page = await start();
    await createProject(page);
    await editHome(page, paragraphs(3));
    const before = page.url();

    const path = workspace.file('from-disk.webm');
    copyFileSync(join(FIXTURES, 'tiny-vp9.webm'), path);
    const box = await page.locator('.ProseMirror > p').nth(1).boundingBox();

    const line = await realDrag(page, path, box.x + 100, box.y + 10);
    assert.ok(line && line.width > 100, `the drop line showed: ${JSON.stringify(line)}`);
    const figure = page.locator('.prose .figure[data-kind="video"]');
    await figure.waitFor();
    assert.equal(page.url(), before, 'the window did not navigate to the file');
    assert.equal(await page.locator('.figure-drop-line').count(), 0);
    const json = await editorJson(page);
    assert.equal(json.content.findIndex((n) => n.type === 'figure'), 1, 'it landed between the paragraphs it was dropped between');
    const outcome = await playAndSeek(figure.locator('video'));
    assert.ok(outcome.playedTo > 0);

    // Off the side of the text, and on something that takes no drops, the file still goes in.
    await realDrag(page, path, 40, 300);
    await waitUntil(async () => (await figure.count()) === 2, 8000, 'the sidebar drop to land');
    assert.equal(page.url(), before);

    // Dropped on the Read view, the window must not navigate away from the app.
    await page.getByRole('button', { name: 'Read', exact: true }).click();
    await page.locator('.ProseMirror[contenteditable="false"]').waitFor();
    const reading = await page.locator('.ProseMirror').boundingBox();
    await realDrag(page, path, reading.x + 50, reading.y + 20);
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
    assert.equal(page.url(), before);
    assertNoProblems();
  });

  it('works the same in a manuscript scene, without counting the label as prose', async () => {
    const page = await start();
    await createProject(page);
    const [book] = await rpc(page, 'books.list');
    const scene = (await rpc(page, 'nodes.tree', { bookId: book.id })).find((n) => n.kind === 'scene');
    await rpc(page, 'nodes.update', { id: scene.id, patch: { content: paragraphs(4, 4) } });
    const words = (await rpc(page, 'nodes.get', { id: scene.id })).wordCount;

    await page.getByRole('button', { name: 'Write', exact: true }).click();
    const editor = page.locator('.ProseMirror[contenteditable="true"]');
    await editor.waitFor();
    assert.ok(await editor.evaluate((e) => e.classList.contains('prose-manuscript')));

    await dropFiles(page, [{ png: { width: 400, height: 300 }, name: 'scene.png' }], { selector: '.ProseMirror[contenteditable="true"]', y: 0.2 });
    const figure = page.locator('.prose .figure[data-kind]');
    await figure.waitFor();
    assert.ok((await imageLoaded(page, figure.locator('.media-frame img'))) > 0);
    await waitUntil(async () => (await selectionInfo(page)).parent === 'figcaption', 8000, 'the label to get the cursor');
    await page.keyboard.type('The hall at night');
    assertTextWraps(await layoutOfFigure(page), 'right');
    await app.screenshot('media-scene');

    const stored = await waitUntil(
      async () => {
        const node = await rpc(page, 'nodes.get', { id: scene.id });
        return JSON.stringify(node.content).includes('The hall at night') ? node : null;
      },
      8000,
      'the label to be stored',
    );
    assert.match(pmToPlainText(stored.content), /\[Picture 1: The hall at night\]/);
    assert.equal(stored.wordCount, words, 'a label is not prose');

    await page.keyboard.press('Enter');
    await page.keyboard.type('Back in the text.');
    assert.equal((await selectionInfo(page)).parent, 'paragraph');
    assertNoProblems();
  });

  it('shows every allowed picture type, and stores what a file really is', async () => {
    const page = await start();
    await createProject(page);
    await editHome(page, paragraphs(2, 2));

    const pictures = [
      { file: 'tiny.jpg', type: 'image/jpeg', mime: 'image/jpeg' },
      { file: 'tiny.gif', type: 'image/gif', mime: 'image/gif' },
      { file: 'tiny.webp', type: 'image/webp', mime: 'image/webp' },
      { file: 'tiny.avif', type: 'image/avif', mime: 'image/avif' },
    ];
    for (const spec of pictures) {
      await dropFiles(page, [{ base64: fixture(spec.file), name: spec.file, type: spec.type }], { y: 0.95 });
      const asset = await waitUntil(
        async () => (await rpc(page, 'media.list')).find((a) => a.name === spec.file),
        8000,
        `${spec.file} to be stored`,
      );
      assert.equal(asset.mime, spec.mime);
      assert.equal(asset.kind, 'image');
      assert.equal(asset.width, 48, `${spec.file} was measured`);
      const image = page.locator(`.media-frame img[src$="${asset.id}"]`);
      await image.waitFor({ state: 'attached' });
      await image.scrollIntoViewIfNeeded();
      assert.equal(await imageLoaded(page, image), 48, spec.file);
    }

    // A JPEG name on PNG bytes shows fine and is stored as a PNG. An empty type is fine too.
    await dropFiles(page, [{ png: { width: 33, height: 22 }, name: 'misnamed.jpg', type: 'image/jpeg' }], { y: 0.95 });
    const misnamed = await waitUntil(
      async () => (await rpc(page, 'media.list')).find((a) => a.name === 'misnamed.jpg'),
      8000,
      'the misnamed file',
    );
    assert.equal(misnamed.mime, 'image/png');

    // The same bytes again make a second figure, but are stored once.
    const before = (await rpc(page, 'media.list')).length;
    await dropFiles(page, [{ base64: fixture('tiny.gif'), name: 'again.gif', type: 'image/gif' }], { y: 0.95 });
    await waitUntil(async () => (await page.locator('.prose .figure[data-kind]').count()) === pictures.length + 2, 8000, 'the extra figure');
    assert.equal((await rpc(page, 'media.list')).length, before);
    assertNoProblems();
  });

  it('plays stored videos and seeks in them, and says so when it cannot play one', async (t) => {
    const page = await start();
    await createProject(page);
    await editHome(page, paragraphs(3));

    // Without H.264 the .mp4 and .mov files must still be added and stored, and must say they
    // cannot be played. Playing them is left out, and so is their length, which the web view
    // reads by opening them. The figure names MP4 when canPlayType admits it has no H.264, and
    // gives the general reason when it does not, so either is accepted.
    const h264 = await canPlayH264(page);
    if (!h264) t.diagnostic('This machine cannot play H.264, so the .mp4 and .mov fixtures are stored but not played.');
    const playable = [
      { file: 'tiny-h264.mp4', type: 'video/mp4', mime: 'video/mp4', h264: true },
      { file: 'tiny-vp9.webm', type: 'video/webm', mime: 'video/webm' },
      { file: 'tiny-vp8.webm', type: 'video/webm', mime: 'video/webm' },
      { file: 'tiny-h264.mov', type: 'video/quicktime', mime: 'video/quicktime', h264: true },
    ];
    const results = {};
    let unplayable = 0;
    for (const [index, spec] of playable.entries()) {
      await dropFiles(page, [{ base64: fixture(spec.file), name: spec.file, type: spec.type }], { y: 0.95 });
      const figures = page.locator('.prose .figure[data-kind="video"]');
      await waitUntil(async () => (await figures.count()) === index + 1, 8000, `${spec.file} to be added`);
      // Stored newest-last at the same spot, so find it by its asset.
      const info = await rpc(page, 'media.list');
      const asset = info.find((a) => a.name === spec.file);
      assert.equal(asset.mime, spec.mime, spec.file);
      assert.equal(asset.kind, 'video');
      if (spec.h264 && !h264) {
        unplayable += 1;
        await waitUntil(
          () =>
            page.evaluate(
              (count) =>
                [...document.querySelectorAll('.prose .figure[data-kind="video"] .media-notice')].filter((n) =>
                  /cannot be played/.test(n.textContent),
                ).length >= count,
              unplayable,
            ),
          10000,
          `${spec.file} to say it cannot be played`,
        );
        results[spec.file] = 'not played, as this machine has no H.264, and the figure says so';
        continue;
      }
      assert.ok(asset.duration > 2.5, `${spec.file} was measured: ${asset.duration}`);
      const video = page.locator(`video[src$="${asset.id}"]`);
      await video.waitFor();
      const outcome = await playAndSeek(video);
      results[spec.file] = outcome;
      assert.ok(outcome.readyState >= 2, `${spec.file} loaded`);
      assert.ok(outcome.playedTo > 0, `${spec.file} played`);
      assert.ok(Math.abs(outcome.seekedTo - 1.5) < 0.2, `${spec.file} seeked to ${outcome.seekedTo}`);
      assert.ok(outcome.width > 0);
    }
    console.log('Played and seeked:', JSON.stringify(results));
    await app.screenshot('media-videos');

    // These fixtures use codecs a current WebView2 may not have. Either they play, or the
    // figure says so. A blank box is the only wrong answer.
    const outcomes = {};
    for (const spec of [
      { file: 'tiny-theora.ogv', type: 'video/ogg' },
      { file: 'tiny-mpeg4.mp4', type: 'video/mp4' },
    ]) {
      await dropFiles(page, [{ base64: fixture(spec.file), name: spec.file, type: spec.type }], { y: 0.95 });
      const asset = await waitUntil(
        async () => (await rpc(page, 'media.list')).find((a) => a.name === spec.file),
        8000,
        `${spec.file} to be stored`,
      );
      const state = await waitUntil(
        async () =>
          page.evaluate((id) => {
            const video = document.querySelector(`video[src$="${id}"]`);
            if (video && video.readyState >= 2) return { played: true };
            const notice = [...document.querySelectorAll('.media-notice')].map((n) => n.textContent).find((t) => /cannot be played/.test(t));
            return notice ? { notice } : null;
          }, asset.id),
        10000,
        `${spec.file} to play or explain itself`,
      );
      outcomes[spec.file] = state.played ? 'played' : 'explained';
    }
    console.log('Unusual codecs:', JSON.stringify(outcomes));
    await app.screenshot('media-video-cannot-play');
    assertNoProblems();
  });

  it('lets the writer keep typing during an upload, and keeps the upload out of the document', async () => {
    const page = await start();
    await createProject(page);
    await editHome(page, paragraphs(3));

    const source = workspace.file('during.mp4');
    writeSparseVideo(source, 480 * 1024 * 1024);
    await dropDiskFile(page, source);

    // Let Playwright go at once. Whatever it does during an upload waits behind its copies of
    // the request bodies, on a busy machine for long enough that the upload ends first.
    await app.disconnect();
    await waitUntil(() => app.quietEvaluate(`!!document.querySelector('.figure-upload')`), 8000, 'the upload to show');
    await app.quietScreenshot('media-upload-progress');

    await app.quietEvaluate(`document.querySelector('.ProseMirror').editor.commands.focus('end'); true`);
    await app.quietSend('Input.insertText', { text: ' Typed during the upload.' });
    const stored = `window.__TAURI_INTERNALS__.invoke('rpc', { method: 'pages.home', params: null }).then((p) => JSON.stringify(p.content))`;
    const during = await waitUntil(
      async () => {
        const json = await app.quietEvaluate(stored);
        return json.includes('Typed during the upload.') ? json : null;
      },
      8000,
      'typing to be stored during the upload',
    );
    const state = await app.quietEvaluate(`JSON.stringify({
      uploading: document.querySelectorAll('.figure-upload').length,
      landed: document.querySelectorAll('.figure[data-kind="video"]').length,
      toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
    })`);
    assert.equal(JSON.parse(state).uploading, 1, `the upload was still going: ${state}`);
    assert.ok(!during.includes('figure'), 'the upload state is not in the document');
    assert.equal(await app.quietEvaluate(`JSON.stringify(document.querySelector('.ProseMirror').editor.getJSON()).includes('figure')`), false);

    await waitUntil(() => app.quietEvaluate(`!!document.querySelector('.figure[data-kind="video"]')`), 120_000, 'the figure to land');
    await app.reconnect();
    const after = watchForProblems(app.page);
    assert.equal(await after.locator('.figure-upload').count(), 0);

    // The cursor stayed where the writer was typing, and they can carry on.
    assert.equal((await selectionInfo(after)).parent, 'paragraph');
    await after.keyboard.type(' And after.');
    assert.ok(JSON.stringify(await editorJson(after)).includes('Typed during the upload. And after.'));
    assertNoProblems();
  });

  it('carries a large video through the real upload path, and saves and reopens it', async (t) => {
    let page = await start();
    const h264 = await canPlayH264(page);
    if (!h264) t.diagnostic('This machine cannot play H.264, so the large .mp4 is carried and saved but not played.');
    await createProject(page);
    await editHome(page, paragraphs(3));

    // A real MP4 with a large `free` box after it, which players skip. Big, valid and seekable.
    const size = 120 * 1024 * 1024;
    const source = workspace.file('long-take.mp4');
    writeBigVideo(source, size);

    // Watched from inside the page: how long the main thread ever stalled, how long a save
    // of a document had to wait, and when the figure landed.
    const { id: homeId } = await rpc(page, 'pages.home');
    await page.evaluate((homeId) => {
      const watch = { stall: 0, slowestSave: 0, saves: 0, doneAt: null };
      window.__watch = watch;
      let last = performance.now();
      const clock = setInterval(() => {
        const now = performance.now();
        watch.stall = Math.max(watch.stall, now - last);
        last = now;
      }, 20);
      let saving = false;
      const saver = setInterval(async () => {
        if (saving) return;
        saving = true;
        const t = performance.now();
        // As the open editor saves. Any other write to this page reloads it, which closes the
        // editor and with it the upload.
        await window.__TAURI_INTERNALS__.invoke('rpc', { method: 'pages.update', params: { id: homeId, fromEditor: true, patch: { summary: `at ${t}` } } });
        watch.slowestSave = Math.max(watch.slowestSave, performance.now() - t);
        watch.saves += 1;
        saving = false;
      }, 100);
      const observer = new MutationObserver(() => {
        if (document.querySelector('.figure[data-kind="video"]')) {
          watch.doneAt = performance.now();
          clearInterval(clock);
          clearInterval(saver);
          observer.disconnect();
        }
      });
      observer.observe(document.querySelector('.ProseMirror'), { childList: true, subtree: true });
    }, homeId);

    const started = await dropDiskFile(page, source);
    await app.disconnect();
    await waitUntil(() => app.quietEvaluate('window.__watch.doneAt'), 300_000, 'the figure to land');
    await app.reconnect();
    page = watchForProblems(app.page);

    const watch = await page.evaluate(() => window.__watch);
    const seconds = (watch.doneAt - started) / 1000;
    console.log(
      `Upload: ${size / 1024 / 1024} MiB of random data in ${seconds.toFixed(2)} s, ${(size / 1024 / 1024 / seconds).toFixed(0)} MiB/s.`,
      `Longest main-thread stall ${watch.stall.toFixed(0)} ms. ${watch.saves} document saves during it, the slowest ${watch.slowestSave.toFixed(0)} ms.`,
    );
    assert.ok(watch.stall < 3000, `the main thread kept running: ${watch.stall} ms`);
    assert.ok(watch.saves > 3, 'documents kept saving');
    assert.ok(watch.slowestSave < 5000, `a save waited ${watch.slowestSave} ms`);

    const figure = page.locator('.prose .figure[data-kind="video"]');
    await figure.waitFor();
    assert.equal(await page.locator('.figure-upload').count(), 0);
    const assets = await rpc(page, 'media.list');
    assert.equal(assets[0].size, size);
    assert.equal(assets[0].kind, 'video');

    // What an exporter reads is what was on disk, without base64 on the way.
    const original = readFileSync(source);
    const samples = await page.evaluate(async (id) => {
      const read = async (offset, length) => {
        const buffer = await window.__TAURI_INTERNALS__.invoke('media_read', { id, offset, length });
        return Array.from(new Uint8Array(buffer));
      };
      return [await read(0, 64), await read(4 * 1024 * 1024 - 32, 64), await read(120 * 1024 * 1024 - 16, 64)];
    }, assets[0].id);
    assert.deepEqual(samples[0], [...original.subarray(0, 64)]);
    assert.deepEqual(samples[1], [...original.subarray(4 * 1024 * 1024 - 32, 4 * 1024 * 1024 + 32)]);
    assert.deepEqual(samples[2], [...original.subarray(120 * 1024 * 1024 - 16)]);
    assert.equal(assets[0].sha256, createHash('sha256').update(original).digest('hex'));

    if (h264) {
      const outcome = await playAndSeek(figure.locator('video'));
      console.log('Large file played and seeked:', JSON.stringify(outcome));
      assert.ok(outcome.playedTo > 0);
      assert.ok(Math.abs(outcome.seekedTo - 1.5) < 0.2);
    }

    await waitForStored(page, (doc) => JSON.stringify(doc).includes('"video"'), 'the figure to be stored');

    // A large save says so in the status bar, and the app keeps answering.
    await page.evaluate(() => {
      window.__statusSeen = [];
      new MutationObserver(() => {
        const item = document.querySelector('[data-status="saving"]');
        if (item) window.__statusSeen.push(item.textContent);
      }).observe(document.querySelector('.statusbar'), { subtree: true, childList: true, characterData: true });
    });
    const path = workspace.file('large.lorecraft');
    await allowPath(page, path);
    const saveStart = Date.now();
    await rpc(page, 'project.saveAs', { path });
    const firstSave = Date.now() - saveStart;
    const fileSize = statSync(path).size;
    console.log(`First save: ${(fileSize / 1024 / 1024).toFixed(0)} MiB file in ${(firstSave / 1000).toFixed(2)} s`);
    assert.ok(fileSize > size);

    await page.locator('.ProseMirror > p').last().click();
    await page.keyboard.type(' More.');
    await waitForStored(page, (doc) => JSON.stringify(doc).includes('More.'), 'the second edit');
    const secondStart = Date.now();
    await page.keyboard.press('Control+s');
    await waitUntil(async () => /All changes saved/.test(await page.getByTestId('save-state').innerText()), 120_000, 'the save with a backup');
    console.log(`Second save, with a backup: ${((Date.now() - secondStart) / 1000).toFixed(2)} s`);
    const seen = await page.evaluate(() => [...new Set(window.__statusSeen)]);
    console.log('Status bar said:', JSON.stringify(seen));
    assert.ok(seen.includes('Saving…'), `the status bar said so: ${JSON.stringify(seen)}`);
    assert.equal(await page.locator('[data-status="saving"]').count(), 0, 'and stopped when it finished');

    // And it is all there after opening the file again.
    const openStart = Date.now();
    await rpc(page, 'project.close');
    await rpc(page, 'project.open', { path });
    console.log(`Reopen: ${((Date.now() - openStart) / 1000).toFixed(2)} s`);
    if (h264) {
      const again = page.locator('.prose .figure[data-kind="video"] video');
      await again.waitFor();
      const reopened = await playAndSeek(again, 2);
      assert.ok(Math.abs(reopened.seekedTo - 2) < 0.2);
    } else {
      await page.locator('.prose .figure[data-kind="video"]').waitFor();
    }
    assertNoProblems();
  });

  it('cancels an upload and removes a failed one, leaving nothing behind', async () => {
    const first = await start();
    await createProject(first);
    await editHome(first, paragraphs(2));

    // Large enough that it cannot finish before the click, even on a quiet machine.
    const source = workspace.file('cancel-me.mp4');
    writeSparseVideo(source, 400 * 1024 * 1024);
    await dropDiskFile(first, source);

    // A real click, over a bare connection: Playwright's copies of the request bodies would
    // keep its own click waiting until the upload had finished.
    await app.disconnect();
    await waitUntil(() => app.quietEvaluate(`!!document.querySelector('.figure-upload-cancel')`), 8000, 'the upload to show');
    const point = JSON.parse(
      await app.quietEvaluate(`(() => {
        const box = document.querySelector('.figure-upload-cancel').getBoundingClientRect();
        return JSON.stringify({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
      })()`),
    );
    const mouse = { ...point, button: 'left', clickCount: 1 };
    await app.quietSend('Input.dispatchMouseEvent', { ...mouse, type: 'mousePressed' });
    await app.quietSend('Input.dispatchMouseEvent', { ...mouse, type: 'mouseReleased' });
    await waitUntil(() => app.quietEvaluate(`!document.querySelector('.figure-upload')`), 8000, 'the placeholder to go');
    await app.reconnect();
    const page = watchForProblems(app.page);
    const placeholder = page.locator('.figure-upload');
    await waitUntil(async () => (await rpc(page, 'media.list')).length === 0, 8000, 'nothing to be kept');
    assert.ok(!JSON.stringify(await editorJson(page)).includes('figure'));

    // A file that lies about its type never gets a figure.
    await dropFiles(page, [{ base64: Buffer.from('<html><script>alert(1)</script></html>').toString('base64'), name: 'sneaky.png', type: 'image/png' }]);
    await page.getByText(/The contents of sneaky.png are not a supported type/).waitFor();
    await dropFiles(page, [{ base64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'), name: 'drawing.svg', type: 'image/svg+xml' }]);
    await page.getByText(/drawing.svg cannot be embedded/).waitFor();
    await dropFiles(page, [{ base64: Buffer.from('%PDF-1.7').toString('base64'), name: 'notes.pdf', type: 'application/pdf' }]);
    await page.getByText(/notes.pdf cannot be embedded/).waitFor();
    // Sound files go on canvases, not pages, even with no type to give them away.
    await dropFiles(page, [{ base64: Buffer.from('ID3\x04\0\0\0\0\0\0'.padEnd(200, '\0'), 'latin1').toString('base64'), name: 'theme.mp3', type: '' }]);
    await page.getByText(/The contents of theme.mp3 are not a supported type/).waitFor();
    assert.ok(!JSON.stringify(await editorJson(page)).includes('figure'));
    assert.equal(await placeholder.count(), 0);
    assert.equal((await rpc(page, 'media.list')).length, 0);
    assertNoProblems();
  });

  it('recovers a figure after a force-kill during editing', async () => {
    const page = await start();
    await createProject(page, 'Crash Media');
    await editHome(page);
    await dropFiles(page, [{ png: { width: 320, height: 240 }, name: 'survivor.png' }]);
    await page.locator('.prose .figure[data-kind]').waitFor();
    await waitUntil(async () => (await selectionInfo(page)).parent === 'figcaption', 8000, 'the label to get the cursor');
    await page.keyboard.type('It survives');
    await waitForStored(page, (doc) => JSON.stringify(doc).includes('It survives'), 'the label');

    await app.kill();

    const next = await start();
    await next.getByRole('heading', { name: 'Recover your work?' }).waitFor();
    await next.getByRole('button', { name: 'Recover' }).click();
    const figure = next.locator('.prose .figure[data-kind]');
    await figure.waitFor();
    assert.equal(await figure.locator('figcaption').innerText(), 'It survives');
    assert.ok((await imageLoaded(next, figure.locator('.media-frame img'))) > 0);
    assertNoProblems();
  });

  it('removes an upload interrupted by a force-kill when the session is recovered', async () => {
    const page = await start();
    await createProject(page, 'Crash Upload');
    await editHome(page, paragraphs(2));
    const source = workspace.file('interrupted.mp4');
    writeSparseVideo(source, 400 * 1024 * 1024);
    await dropDiskFile(page, source);
    await app.disconnect();
    await waitUntil(
      () => app.quietEvaluate(`Number(document.querySelector('.figure-upload [role="progressbar"]')?.getAttribute('aria-valuenow') ?? 0) > 2`),
      20000,
      'some of it to be stored',
    );
    await app.kill();

    const next = await start();
    await next.getByRole('heading', { name: 'Recover your work?' }).waitFor();
    await next.getByRole('button', { name: 'Recover' }).click();
    await next.locator('.prose').waitFor();
    assert.equal((await rpc(next, 'media.list')).length, 0);
    assert.ok(!JSON.stringify((await rpc(next, 'pages.home')).content).includes('figure'));
    assertNoProblems();
  });

  it('labels from the keyboard: Enter, Backspace, Escape, Delete, undo and redo', async () => {
    const page = await start();
    await createProject(page);
    await editHome(page, paragraphs(1));
    await dropFiles(page, [{ png: { width: 200, height: 100 }, name: 'keys.png' }]);
    const figure = page.locator('.prose .figure[data-kind]');
    await figure.waitFor();
    await waitUntil(async () => (await selectionInfo(page)).parent === 'figcaption', 8000, 'the label to get the cursor');

    // Backspace in an empty label does nothing at all.
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Control+Backspace');
    assert.equal(await figure.count(), 1);
    assert.equal((await selectionInfo(page)).parent, 'figcaption');

    // And clearing a label down to nothing does not take the figure with it.
    await page.keyboard.type('abc');
    for (let i = 0; i < 6; i += 1) await page.keyboard.press('Backspace');
    assert.equal(await figure.count(), 1);
    assert.equal(await figure.locator('figcaption').evaluate((c) => c.querySelector('.figure-hint') !== null), true);

    // Delete at the end of a label does not join anything either.
    await page.keyboard.press('Delete');
    assert.equal(await figure.count(), 1);

    // Composing text with an input method in an empty label comes through whole.
    const session = await page.context().newCDPSession(page);
    await session.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
    await session.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 });
    await session.send('Input.insertText', { text: '日本' });
    await session.detach();
    assert.equal(await figure.locator('figcaption').evaluate((c) => c.textContent), '日本');
    for (let i = 0; i < 2; i += 1) await page.keyboard.press('Backspace');
    assert.equal(await figure.locator('figcaption').evaluate((c) => c.querySelector('.figure-hint') !== null), true);

    // Wiki links work in a label, by the same typed rule as in text.
    await page.keyboard.type('Aria at [[Silver Gate]] today');
    const stored = await waitForStored(page, (doc) => JSON.stringify(doc).includes('today'), 'the label');
    const marks = stored.content.find((n) => n.type === 'figure').content[1].content;
    const linked = marks.find((n) => n.marks?.some((m) => m.type === 'wikiLink'));
    assert.equal(linked.text, 'Silver Gate');
    assert.equal(linked.marks[0].attrs.target, 'Silver Gate');
    assert.ok(await figure.locator('figcaption a.wiki-link').count());

    // The [[ list works in a label too, and its keys come first: Enter picks a page rather
    // than leaving the label, and Escape closes the list rather than selecting the figure.
    await page.keyboard.type(' [[Main');
    const suggestions = page.getByRole('listbox', { name: 'Link to a page' });
    await suggestions.waitFor();
    await page.keyboard.press('Escape');
    await waitUntil(async () => !(await suggestions.isVisible()), 8000, 'the list to close');
    assert.equal((await selectionInfo(page)).parent, 'figcaption', 'Escape only closed the list');
    for (let i = 0; i < 6; i += 1) await page.keyboard.press('Backspace');
    await page.keyboard.type(' [[Main');
    await suggestions.waitFor();
    await page.keyboard.press('Enter');
    await waitUntil(async () => !(await suggestions.isVisible()), 8000, 'the list to close');
    assert.equal((await selectionInfo(page)).parent, 'figcaption', 'Enter picked a page');
    const picked = (await editorJson(page)).content.find((n) => n.type === 'figure').content[1].content;
    assert.ok(picked.some((n) => n.marks?.some((m) => m.type === 'wikiLink' && m.attrs.target === 'Main Page')), JSON.stringify(picked));

    // Enter goes to the paragraph after, and does not split the label.
    await page.keyboard.press('Enter');
    let info = await selectionInfo(page);
    assert.equal(info.parent, 'paragraph');
    await page.keyboard.type('X');
    const after = await editorJson(page);
    const at = after.content.findIndex((n) => n.type === 'figure');
    assert.equal(after.content[at + 1].content[0].text.startsWith('X'), true, 'the cursor was at the start of the next paragraph');
    await page.keyboard.press('Backspace');

    // With nothing after it, Enter makes a paragraph.
    await page.evaluate(() => {
      const { editor } = document.querySelector('.ProseMirror');
      const doc = editor.getJSON();
      doc.content = [{ type: 'paragraph' }, doc.content.find((n) => n.type === 'figure')];
      editor.commands.setContent(doc, { emitUpdate: true });
    });
    await page.evaluate(() => {
      const { editor } = document.querySelector('.ProseMirror');
      let captionPos = 0;
      editor.state.doc.descendants((n, p) => {
        if (n.type.name === 'figcaption') captionPos = p + 1;
      });
      editor.commands.focus(captionPos);
    });
    await page.keyboard.press('Enter');
    info = await selectionInfo(page);
    assert.equal(info.parent, 'paragraph');
    const last = await editorJson(page);
    assert.equal(last.content[last.content.length - 1].type, 'paragraph');
    assert.equal(last.content[last.content.length - 2].type, 'figure');

    // Escape in the label selects the figure, and Delete removes it.
    await page.evaluate(() => {
      const { editor } = document.querySelector('.ProseMirror');
      let captionPos = 0;
      editor.state.doc.descendants((n, p) => {
        if (n.type.name === 'figcaption') captionPos = p + 1;
      });
      editor.commands.focus(captionPos);
    });
    await page.keyboard.press('Escape');
    info = await selectionInfo(page);
    assert.equal(info.nodeSelected, 'figure');
    assert.ok(await figure.evaluate((f) => f.classList.contains('ProseMirror-selectednode')));
    await app.screenshot('media-selected');

    // Typing on a selected figure labels it, rather than replacing it.
    await page.keyboard.type('!');
    assert.equal(await figure.count(), 1);
    assert.match(await figure.locator('figcaption').innerText(), /Main Page!/);
    await page.keyboard.press('Escape');

    // Tab reaches the toolbar, which works by keyboard, and Escape comes back.
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Wrap left');
    await page.keyboard.press('Enter');
    assert.equal(await figure.getAttribute('data-align'), 'left');
    assert.equal((await selectionInfo(page)).focused, true);
    await page.keyboard.press('Control+z');
    assert.equal(await figure.getAttribute('data-align'), 'right');

    // The width handle is a slider too.
    const handle = figure.locator('.figure-resize');
    await handle.focus();
    const widthBefore = Number(await handle.getAttribute('aria-valuenow'));
    await page.keyboard.press('ArrowRight');
    assert.ok(Number(await handle.getAttribute('aria-valuenow')) > widthBefore);
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const { editor } = document.querySelector('.ProseMirror');
      let pos = 0;
      editor.state.doc.descendants((n, p) => {
        if (n.type.name === 'figure') pos = p;
      });
      editor.commands.setNodeSelection(pos);
      editor.view.focus();
    });

    await page.keyboard.press('Delete');
    assert.equal(await figure.count(), 0);
    await page.keyboard.press('Control+z');
    assert.equal(await figure.count(), 1, 'undo brings it back');
    await page.keyboard.press('Control+y');
    assert.equal(await figure.count(), 0, 'redo removes it again');
    await page.keyboard.press('Control+z');

    // Backspace at the start of the paragraph after selects the figure before deleting it.
    await page.evaluate(() => {
      const { editor } = document.querySelector('.ProseMirror');
      const doc = editor.getJSON();
      const index = doc.content.findIndex((n) => n.type === 'figure');
      doc.content[index + 1] = { type: 'paragraph', content: [{ type: 'text', text: 'Next' }] };
      editor.commands.setContent(doc, { emitUpdate: true });
      let pos = 0;
      editor.state.doc.descendants((n, p) => {
        if (n.type.name === 'paragraph' && n.textContent === 'Next') pos = p + 1;
      });
      editor.commands.setTextSelection(pos);
      editor.view.focus();
    });
    await page.keyboard.press('Backspace');
    assert.equal((await selectionInfo(page)).nodeSelected, 'figure');
    assert.equal(await figure.count(), 1);

    // Clicking the picture selects the figure, not the picture inside it.
    await page.locator('.ProseMirror > p').last().click();
    await figure.locator('.media-frame img').click();
    assert.equal((await selectionInfo(page)).nodeSelected, 'figure');
    // Enter from there goes back into the label.
    await page.keyboard.press('Enter');
    assert.equal((await selectionInfo(page)).parent, 'figcaption');

    // Changes to attributes undo as ordinary edits.
    await clickFigureTool(page, 'Wrap left');
    assert.equal(await figure.getAttribute('data-align'), 'left');
    await page.keyboard.press('Control+z');
    assert.equal(await figure.getAttribute('data-align'), 'right');
    assertNoProblems();
  });

  it('moves a figure by dragging, keeps its asset through copy and paste, and takes pasted pictures', async () => {
    const page = await start();
    await createProject(page);
    await editHome(page, paragraphs(4, 2));
    await dropFiles(page, [{ png: { width: 300, height: 200 }, name: 'moving.png' }], { y: 0.02 });
    const figure = page.locator('.prose .figure[data-kind]');
    await figure.waitFor();
    await imageLoaded(page, figure.locator('.media-frame img'));
    // Fold the page details away, so the figure and where it goes both fit on screen.
    await page.locator('summary', { hasText: 'Page details' }).click();

    // Drag by the picture itself, down past the third paragraph.
    const box = await figure.locator('.media-frame img').boundingBox();
    const target = await page.locator('.ProseMirror > p').nth(2).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 20, box.y + box.height / 2 + 20, { steps: 4 });
    await page.mouse.move(target.x + 50, target.y + target.height - 2, { steps: 8 });
    await page.mouse.up();
    const moved = await waitUntil(
      async () => {
        const json = await editorJson(page);
        return json.content.findIndex((n) => n.type === 'figure') > 0 ? json : null;
      },
      5000,
      'the figure to move',
    );
    assert.equal(moved.content.filter((n) => n.type === 'figure').length, 1, 'moved, not copied');
    assert.ok(moved.content.findIndex((n) => n.type === 'figure') >= 2);
    const assetId = moved.content.find((n) => n.type === 'figure').content[0].attrs.assetId;
    assert.ok(assetId);

    // A video has no bare surface to grab, so the toolbar's grip moves a figure too.
    await page.locator('.ProseMirror > p').first().click();
    const gripped = page.locator('.prose .figure[data-kind]');
    await gripped.hover();
    const grip = gripped.locator('.figure-grip');
    const gripBox = await grip.boundingBox();
    const firstParagraph = await page.locator('.ProseMirror > p').first().boundingBox();
    await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(gripBox.x - 10, gripBox.y - 10, { steps: 4 });
    await page.mouse.move(firstParagraph.x + 50, firstParagraph.y + 3, { steps: 8 });
    await page.mouse.up();
    const movedAgain = await waitUntil(
      async () => {
        const json = await editorJson(page);
        return json.content.findIndex((n) => n.type === 'figure') === 0 ? json : null;
      },
      5000,
      'the grip to move it',
    );
    assert.equal(movedAgain.content.filter((n) => n.type === 'figure').length, 1);

    // Copy and paste through the clipboard events, which keeps real clipboards out of the test.
    await page.evaluate(() => {
      const { editor } = document.querySelector('.ProseMirror');
      let pos = 0;
      editor.state.doc.descendants((n, p) => {
        if (n.type.name === 'figure') pos = p;
      });
      editor.commands.setNodeSelection(pos);
      editor.view.focus();
      const data = new DataTransfer();
      editor.view.dom.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
      window.__copied = { html: data.getData('text/html'), text: data.getData('text/plain') };
    });
    const copied = await page.evaluate(() => window.__copied);
    assert.match(copied.html, /data-asset-id/);
    await page.evaluate((copied) => {
      const { editor } = document.querySelector('.ProseMirror');
      editor.commands.setTextSelection(1);
      const data = new DataTransfer();
      data.setData('text/html', copied.html);
      data.setData('text/plain', copied.text);
      editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, copied);
    const pasted = await editorJson(page);
    const figures = pasted.content.filter((n) => n.type === 'figure');
    assert.equal(figures.length, 2, 'a second figure from the paste');
    assert.equal(figures[0].content[0].attrs.assetId, assetId, 'with the same asset');
    await waitUntil(() => page.locator('.prose .figure[data-kind] .media-frame img').evaluateAll((all) => all.every((i) => i.complete && i.naturalWidth > 0)), 8000, 'both to show');

    // A picture on the clipboard takes the same road as a dropped one.
    await page.evaluate(async () => {
      const { editor } = document.querySelector('.ProseMirror');
      const canvas = document.createElement('canvas');
      canvas.width = 150;
      canvas.height = 150;
      canvas.getContext('2d').fillRect(0, 0, 150, 150);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      editor.commands.setTextSelection(editor.state.doc.content.size - 2);
      editor.view.focus();
      const data = new DataTransfer();
      data.items.add(new File([blob], 'image.png', { type: 'image/png' }));
      editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await waitUntil(async () => (await figure.count()) === 3, 8000, 'the pasted picture');
    await waitUntil(async () => (await selectionInfo(page)).parent === 'figcaption', 8000, 'its label to get the cursor');

    // Word puts a picture of the text beside the text. That stays a text paste.
    const figureCount = await figure.count();
    await page.evaluate(async () => {
      const { editor } = document.querySelector('.ProseMirror');
      const canvas = document.createElement('canvas');
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      editor.commands.setTextSelection(1);
      const data = new DataTransfer();
      data.items.add(new File([blob], 'image.png', { type: 'image/png' }));
      data.setData('text/plain', 'Words from Word');
      data.setData('text/html', '<p>Words from Word</p>');
      editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    assert.ok(JSON.stringify(await editorJson(page)).includes('Words from Word'));
    assert.equal(await figure.count(), figureCount);

    // Several lines pasted into a label join up, and the figure stays whole.
    await page.evaluate(() => {
      const { editor } = document.querySelector('.ProseMirror');
      let pos = 0;
      editor.state.doc.descendants((n, p) => {
        if (n.type.name === 'figcaption' && !pos) pos = p + 1;
      });
      editor.commands.setTextSelection(pos);
      const data = new DataTransfer();
      data.setData('text/plain', 'First line\nSecond line');
      data.setData('text/html', '<p>First line</p><p>Second line</p>');
      editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    const labeled = await editorJson(page);
    assert.equal(labeled.content.filter((n) => n.type === 'figure').length, figureCount);
    assert.ok(JSON.stringify(labeled).includes('First line Second line'));
    assertNoProblems();
  });

  it('turns video addresses into cards that open in the browser and load nothing', async () => {
    const page = await start();
    await createProject(page);
    await editHome(page, paragraphs(3, 2));

    // Nothing may reach the network, so watch for any request that tries.
    const requests = [];
    page.on('request', (r) => {
      if (!/^(http:\/\/(tauri|ipc|lbasset)\.localhost|data:|blob:)/.test(r.url())) requests.push(r.url());
    });

    // Dropped from a browser's address bar.
    await page.evaluate(() => {
      const target = document.querySelector('.ProseMirror');
      const rect = target.getBoundingClientRect();
      const data = new DataTransfer();
      data.setData('text/uri-list', 'https://www.youtube.com/watch?v=abc123XYZ_0');
      data.setData('text/plain', 'https://www.youtube.com/watch?v=abc123XYZ_0');
      target.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true, clientX: rect.left + 30, clientY: rect.top + 10 }));
    });
    const card = page.locator('.prose .figure[data-kind] .video-card');
    await card.waitFor();
    assert.match(await card.innerText(), /YouTube/);
    assert.match(await card.innerText(), /youtube\.com\/watch\?v=abc123XYZ_0/);
    assert.equal(await page.locator('.prose .figure[data-kind]').first().getAttribute('data-kind'), 'video');
    assert.equal((await selectionInfo(page)).parent, 'figcaption', 'ready to label');
    assert.match(await page.locator('.figure-hint').innerText(), /Label this video/);
    await page.keyboard.type('The storm scene reference');
    await app.screenshot('media-video-card');

    // Pasted.
    await page.evaluate(() => {
      const { editor } = document.querySelector('.ProseMirror');
      editor.commands.setTextSelection(editor.state.doc.content.size - 2);
      const data = new DataTransfer();
      data.setData('text/plain', 'https://vimeo.com/76979871');
      editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await waitUntil(async () => (await card.count()) === 2, 8000, 'the pasted card');
    assert.match(await card.nth(1).innerText(), /Vimeo/);

    // A link to some other page is still just text.
    await page.evaluate(() => {
      const { editor } = document.querySelector('.ProseMirror');
      editor.commands.setTextSelection(editor.state.doc.content.size - 2);
      const data = new DataTransfer();
      data.setData('text/plain', 'https://example.com/an-article');
      editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    assert.equal(await card.count(), 2);
    assert.ok(JSON.stringify(await editorJson(page)).includes('example.com/an-article'));

    const stored = await waitForStored(page, (doc) => JSON.stringify(doc).includes('storm scene'), 'the card');
    const figures = describeFigures(stored);
    assert.equal(figures[0].url, 'https://www.youtube.com/watch?v=abc123XYZ_0');
    assert.equal(figures[0].assetId, null);
    assert.match(pmToPlainText(stored), /\[Video 1: The storm scene reference\]/);

    // The button goes to the default browser, through the native side. Under the E2E flag
    // the app notes the address rather than opening one.
    await card.first().getByRole('button', { name: 'Open in browser' }).click();
    await waitUntil(async () => (await rpc(page, 'media.e2eOpened')).length === 1, 8000, 'the address to be opened');
    assert.deepEqual(await rpc(page, 'media.e2eOpened'), ['https://www.youtube.com/watch?v=abc123XYZ_0']);

    assert.deepEqual(requests, [], 'nothing tried to reach the network');
    assert.equal(await page.locator('iframe').count(), 0, 'no embedded player');
    assertNoProblems();
  });

  it('inserts through the menus: tables with labels, and adding and removing a label', async () => {
    const page = await start();
    await createProject(page);
    await editHome(page, paragraphs(2, 2));
    await page.locator('.ProseMirror > p').first().click();

    const menu = async (name) => {
      await page.getByRole('menuitem', { name: 'Insert' }).click();
      await page.getByRole('menuitem', { name, exact: true }).click();
    };

    await menu('Table');
    const figure = page.locator('.prose .figure[data-kind="table"]');
    await figure.waitFor();
    assert.equal(await figure.getAttribute('data-align'), 'full');
    assert.equal(await figure.locator('table tr').count(), 3);
    assert.equal((await selectionInfo(page)).parent, 'figcaption');
    assert.match(await figure.locator('.figure-hint').innerText(), /Label this table/);
    await page.keyboard.type('The noble houses');
    await app.screenshot('media-table');

    // Cells hold text, and the toolbar adds rows and columns.
    await figure.locator('td').first().click();
    await page.keyboard.type('House Vale');
    await figure.hover();
    await figure.getByRole('button', { name: 'Add a row' }).click();
    assert.equal(await figure.locator('table tr').count(), 4);
    await figure.getByRole('button', { name: 'Add a column' }).click();
    assert.equal(await figure.locator('table tr').first().locator('th').count(), 4);
    await figure.locator('tr').last().locator('td').first().click();
    await figure.getByRole('button', { name: 'Delete this row' }).click();
    assert.equal(await figure.locator('table tr').count(), 3);

    const stored = await waitForStored(page, (doc) => JSON.stringify(doc).includes('House Vale') && JSON.stringify(doc).includes('noble'), 'the table');
    assert.match(pmToPlainText(stored), /\[Table 1: The noble houses\]/);
    assert.match(pmToPlainText(stored), /House Vale/);

    // Remove label leaves the plain table.
    await figure.locator('td').first().click();
    await menu('Remove label');
    await waitUntil(async () => (await figure.count()) === 0, 8000, 'the figure to go');
    const plain = await editorJson(page);
    assert.ok(plain.content.some((n) => n.type === 'table'));
    assert.ok(!plain.content.some((n) => n.type === 'figure'));
    assert.ok(JSON.stringify(plain).includes('House Vale'));

    // Add a label wraps it again.
    await page.locator('.ProseMirror table td').first().click();
    await menu('Add a label');
    await figure.waitFor();
    assert.equal((await selectionInfo(page)).parent, 'figcaption');
    await page.keyboard.type('Again');
    const wrapped = await editorJson(page);
    assert.ok(wrapped.content.some((n) => n.type === 'figure' && n.content[0].type === 'table'));
    assert.ok(JSON.stringify(wrapped).includes('House Vale'));

    // Those two are hidden when they do not apply.
    await page.locator('.ProseMirror > p').first().click();
    await page.getByRole('menuitem', { name: 'Insert' }).click();
    assert.equal(await page.getByRole('menuitem', { name: 'Add a label', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('menuitem', { name: 'Remove label', exact: true }).isDisabled(), true);
    await page.keyboard.press('Escape');

    // Video link asks for an address.
    await menu('Video link…');
    const dialog = page.getByRole('textbox', { name: 'Web address' });
    await dialog.fill('not an address');
    assert.equal(await page.getByRole('button', { name: 'Insert', exact: true }).isDisabled(), true);
    await dialog.fill('https://www.youtube.com/watch?v=abc');
    await page.getByRole('button', { name: 'Insert', exact: true }).click();
    await page.locator('.prose .figure[data-kind] .video-card').waitFor();

    // Picture through the dialog, which a test answers through the E2E seam.
    const path = workspace.file('chosen.png');
    const png = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 111;
      canvas.height = 77;
      canvas.getContext('2d').fillRect(0, 0, 111, 77);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return btoa(String.fromCharCode(...bytes));
    });
    writeFileSync(path, Buffer.from(png, 'base64'));
    await answerNextDialog(page, path);
    await menu('Picture…');
    const picture = page.locator('.prose .figure[data-kind="picture"]');
    await picture.waitFor();
    assert.equal(await imageLoaded(page, picture.locator('.media-frame img')), 111);
    const asset = (await rpc(page, 'media.list')).find((a) => a.name === 'chosen.png');
    assert.equal(asset.width, 111, 'measured from the stored copy');
    assert.equal(asset.linked, false);
    assertNoProblems();
  });

  it('links a video on disk, says when the file is missing, and relinks it', async () => {
    const page = await start();
    await createProject(page);
    await editHome(page, paragraphs(2, 2));
    await page.locator('.ProseMirror > p').first().click();

    // Embedding from the same menu stores a copy, read from disk by the native side.
    const chosen = workspace.file('embedded.webm');
    copyFileSync(join(FIXTURES, 'tiny-vp8.webm'), chosen);
    await answerNextDialog(page, chosen);
    await page.getByRole('menuitem', { name: 'Insert' }).click();
    await page.getByRole('menuitem', { name: 'Video…', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Embed in project…' }).click();
    const stored = page.locator('.prose .figure[data-kind="video"] video');
    await stored.waitFor();
    assert.ok((await playAndSeek(stored)).playedTo > 0, 'played from the project');
    const embedded = (await rpc(page, 'media.list')).find((a) => a.name === 'embedded.webm');
    assert.equal(embedded.linked, false);
    assert.ok(embedded.duration > 2.5);
    await page.evaluate(() => document.querySelector('.ProseMirror').editor.commands.undo());
    await rpc(page, 'media.removeUnused', { ids: [embedded.id] });
    await waitForStored(page, (doc) => !JSON.stringify(doc).includes(embedded.id), 'the undo to be stored');
    await rpc(page, 'media.removeUnused', { ids: [embedded.id] });
    assert.equal((await rpc(page, 'media.list')).length, 0);
    await page.locator('.ProseMirror > p').first().click();

    const path = workspace.file('elsewhere.webm');
    copyFileSync(join(FIXTURES, 'tiny-vp9.webm'), path);
    await answerNextDialog(page, path);

    await page.getByRole('menuitem', { name: 'Insert' }).click();
    await page.getByRole('menuitem', { name: 'Video…', exact: true }).click();
    const dialog = page.getByRole('alertdialog');
    assert.match(await dialog.innerText(), /will not travel with the project/);
    await app.screenshot('media-insert-video-dialog');
    await dialog.getByRole('button', { name: 'Link to the file…' }).click();

    const figure = page.locator('.prose .figure[data-kind="video"]');
    await figure.waitFor();
    const video = figure.locator('video');
    await video.waitFor();
    const outcome = await playAndSeek(video);
    assert.ok(outcome.playedTo > 0, 'played from disk');
    assert.ok(Math.abs(outcome.seekedTo - 1.5) < 0.2);
    await figure.locator('.media-linked').waitFor();
    await page.getByText(/will not travel with the project/).first().waitFor();
    const [asset] = await rpc(page, 'media.list');
    assert.equal(asset.linked, true);
    assert.equal(asset.path, path);
    assert.ok(asset.duration > 2.5);

    const saved = workspace.file('linked.lorecraft');
    await allowPath(page, saved);
    await waitForStored(page, (doc) => JSON.stringify(doc).includes(asset.id), 'the figure');
    await rpc(page, 'project.saveAs', { path: saved });
    assert.ok(statSync(saved).size < 2 * 1024 * 1024, 'the project stays small');

    // Closing and reopening drops the live video's hold on the file, so it can go away.
    await rpc(page, 'project.close');
    await rmSync(path);
    await rpc(page, 'project.open', { path: saved });
    const again = page.locator('.prose .figure[data-kind="video"]');
    await again.waitFor();
    const notice = again.locator('.media-notice');
    await notice.waitFor();
    assert.match(await notice.innerText(), /linked file is missing/);
    assert.ok((await notice.innerText()).includes('elsewhere.webm'));
    await app.screenshot('media-linked-missing');

    const moved = workspace.file('moved.webm');
    copyFileSync(join(FIXTURES, 'tiny-vp9.webm'), moved);
    await answerNextDialog(page, moved);
    await again.getByRole('button', { name: 'Relink…' }).click();
    const relinked = again.locator('video');
    await relinked.waitFor();
    const after = await playAndSeek(relinked);
    assert.ok(after.playedTo > 0, 'plays from the new place');
    assert.equal((await rpc(page, 'media.get', { id: asset.id })).path, moved);
    assertNoProblems();
  });

  it('asks before embedding a very large video', async () => {
    const page = await start();
    await createProject(page);
    await editHome(page, paragraphs(2, 2));

    const dropped = workspace.file('epic.mp4');
    writeSparseVideo(dropped, 501 * 1024 * 1024);
    await dropDiskFile(page, dropped);
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor({ timeout: 30_000 });
    const text = await dialog.innerText();
    assert.match(text, /epic\.mp4 is 501 MB/);
    assert.match(text, /every save/);
    assert.match(text, /will not travel with the project/);
    await app.screenshot('media-large-video-dialog');

    // Cancel leaves nothing behind.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await waitUntil(async () => (await page.locator('.figure-upload').count()) === 0, 8000, 'the placeholder to go');
    assert.equal((await rpc(page, 'media.list')).length, 0);

    // Choosing to link opens the file dialog, because a drop gives no path.
    await dropDiskFile(page, dropped);
    await dialog.waitFor();
    const path = workspace.file('epic-real.mp4');
    copyFileSync(join(FIXTURES, 'tiny-h264.mp4'), path);
    await answerNextDialog(page, path);
    await dialog.getByRole('button', { name: 'Link to the file…' }).click();
    const figure = page.locator('.prose .figure[data-kind="video"]');
    await figure.waitFor();
    assert.equal(await page.locator('.figure-upload').count(), 0);
    const [asset] = await rpc(page, 'media.list');
    assert.equal(asset.linked, true);
    assert.equal(asset.path, path);
    assertNoProblems();

    // Choosing to embed really does take it all: over 500 MB, through the same chunks.
    await dropDiskFile(page, dropped);
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Embed anyway' }).click();
    await page.locator('.figure-upload').waitFor();
    const embedStart = Date.now();
    await app.disconnect();
    await waitUntil(() => app.quietEvaluate(`!document.querySelector('.figure-upload')`), 300_000, 'the embed to finish');
    console.log(`Embedded 501 MiB in ${((Date.now() - embedStart) / 1000).toFixed(1)} s`);
    await app.reconnect();
    const after = await rpc(app.page, 'media.list');
    const embedded = after.find((a) => a.name === 'epic.mp4' && !a.linked);
    assert.equal(embedded.size, 501 * 1024 * 1024);
    assert.equal(await app.page.locator('.prose .figure[data-kind="video"]').count(), 2);
  });

  it('warns once when a project is too large for its backups, and keeps saving', async () => {
    const page = await start();
    await createProject(page);
    await rpc(page, 'settings.update', { patch: { save: { backupBudgetBytes: 1024 } } });
    const path = workspace.file('budget.lorecraft');
    await allowPath(page, path);
    await rpc(page, 'project.saveAs', { path });
    const home = await rpc(page, 'pages.home');
    const warning = page.getByText(/more than the space set aside for its backups/);
    for (let i = 0; i < 3; i += 1) {
      await rpc(page, 'pages.update', { id: home.id, patch: { summary: `Edit ${i}` } });
      await rpc(page, 'project.save');
    }
    await waitUntil(async () => (await warning.count()) > 0, 8000, 'the warning');
    assert.equal(await warning.count(), 1, 'only once');
    assert.ok(/All changes saved/.test(await page.getByTestId('save-state').innerText()));
    assertNoProblems();
  });

  it('asks to switch to Edit when something is dropped on the read view', async () => {
    const page = await start();
    await createProject(page);
    await page.locator('.prose').waitFor();
    assert.equal(await page.locator('.ProseMirror[contenteditable="true"]').count(), 0, 'starts in Read mode');

    const before = page.url();
    await dropFiles(page, [{ png: { width: 200, height: 100 }, name: 'read.png' }]);
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /Switch to Edit/);
    await app.screenshot('media-read-drop');
    assert.equal(page.url(), before, 'the window did not navigate to the file');

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    assert.equal(await page.locator('.prose .figure[data-kind]').count(), 0);

    await dropFiles(page, [{ png: { width: 200, height: 100 }, name: 'read.png' }]);
    await page.getByRole('alertdialog').getByRole('button', { name: 'Switch to Edit' }).click();
    await page.locator('.ProseMirror[contenteditable="true"]').waitFor();
    const figure = page.locator('.prose .figure[data-kind]');
    await figure.waitFor();
    assert.ok((await imageLoaded(page, figure.locator('.media-frame img'))) > 0);

    // Dropped well outside the text, it lands in the editor rather than navigating away.
    await dropFiles(page, [{ png: { width: 90, height: 90 }, name: 'margin.png' }], { selector: '.sidebar' });
    await waitUntil(async () => (await page.locator('.prose .figure[data-kind]').count()) === 2, 8000, 'the second figure');
    assert.equal(page.url(), before);

    // With no document on screen, it explains.
    await page.getByRole('button', { name: 'Atlas' }).click();
    await dropFiles(page, [{ png: { width: 90, height: 90 }, name: 'nowhere.png' }], { selector: '.content' });
    await page.getByText(/Open a page or a scene for editing/).waitFor();
    assert.equal(page.url(), before);
    assertNoProblems();
  });

  it('shows pictures full size in Read mode, with no editing chrome', async () => {
    const page = await start();
    await createProject(page);
    await editHome(page, paragraphs(4));
    await dropFiles(page, [{ png: { width: 800, height: 500 }, name: 'view.png' }]);
    const figure = page.locator('.prose .figure[data-kind]');
    await figure.waitFor();
    await waitUntil(async () => (await selectionInfo(page)).parent === 'figcaption', 8000, 'the label to get the cursor');
    await page.keyboard.type('A wide view');
    await waitForStored(page, (doc) => JSON.stringify(doc).includes('A wide view'), 'the label');

    await page.getByRole('button', { name: 'Read', exact: true }).click();
    await page.locator('.ProseMirror[contenteditable="false"]').waitFor();
    await figure.hover();
    assert.equal(await figure.locator('.figure-toolbar').isVisible(), false, 'no toolbar');
    assert.equal(await figure.locator('.figure-resize').isVisible(), false, 'no handle');
    assertTextWraps(await layoutOfFigure(page), 'right');

    await figure.locator('.media-frame img').click();
    const viewer = page.getByRole('dialog', { name: 'A wide view' });
    await viewer.waitFor();
    assert.equal(await viewer.locator('img').evaluate((i) => i.naturalWidth), 800);
    await app.screenshot('media-viewer');
    await page.keyboard.press('Escape');
    await waitUntil(async () => (await viewer.count()) === 0, 8000, 'Escape to close it');

    // By keyboard too.
    await figure.locator('.media-frame img').focus();
    await page.keyboard.press('Enter');
    await viewer.waitFor();
    await page.getByRole('button', { name: 'Close' }).click();
    await waitUntil(async () => (await viewer.count()) === 0, 8000, 'the button to close it');
    assertNoProblems();
  });

  it('renders a bare picture from an imported document, and refuses to fetch a remote one', async () => {
    const page = await start();
    await createProject(page);
    await editHome(page, paragraphs(1, 1));
    await dropFiles(page, [{ png: { width: 123, height: 45 }, name: 'bare.png' }]);
    await page.locator('.prose .figure[data-kind]').waitFor();
    const [asset] = await rpc(page, 'media.list');

    const requests = [];
    page.on('request', (r) => {
      if (/example\.com/.test(r.url())) requests.push(r.url());
    });
    await page.evaluate((id) => {
      document.querySelector('.ProseMirror').editor.commands.setContent(
        {
          type: 'doc',
          content: [
            { type: 'image', attrs: { assetId: id, alt: 'A bare one' } },
            { type: 'paragraph', content: [{ type: 'text', text: 'Between them.' }] },
            { type: 'image', attrs: { src: 'https://example.com/tracker.png', alt: 'Remote' } },
          ],
        },
        { emitUpdate: true },
      );
    }, asset.id);
    const bare = page.locator('.ProseMirror > .media-frame img').first();
    assert.equal(await imageLoaded(page, bare), 123);
    assert.equal(await bare.getAttribute('alt'), 'A bare one');
    await page.getByText(/This picture is on the web, so it is not shown here/).waitFor();
    assert.deepEqual(requests, []);

    // A figure whose asset has gone says that, rather than showing a broken image.
    await page.evaluate(() => {
      document.querySelector('.ProseMirror').editor.commands.setContent(
        {
          type: 'doc',
          content: [
            {
              type: 'figure',
              attrs: { kind: 'picture', align: 'right' },
              content: [{ type: 'image', attrs: { assetId: '00000000-0000-7000-8000-000000000000' } }, { type: 'figcaption' }],
            },
            { type: 'paragraph' },
          ],
        },
        { emitUpdate: true },
      );
    });
    await page.getByText(/This picture is no longer in the project/).waitFor();
    assertNoProblems();
  });

  it('removes unused media only when confirmed, and never what a document uses', async () => {
    const page = await start();
    await createProject(page);
    await editHome(page, paragraphs(2, 2));
    await dropFiles(page, [
      { png: { width: 64, height: 64, color: '#a33' }, name: 'kept.png' },
      { png: { width: 65, height: 65, color: '#3a3' }, name: 'dropped.png' },
    ]);
    await waitUntil(async () => (await page.locator('.prose .figure[data-kind]').count()) === 2, 8000, 'both figures');
    assert.equal((await rpc(page, 'media.list')).length, 2, 'several files at once');

    // Delete the second figure, so its picture is only held by nothing. Saved undo history
    // and revisions are checked by the Rust tests.
    await clickFigureTool(page, 'Delete', 1);
    assert.equal(await page.locator('.prose .figure[data-kind]').count(), 1);
    await waitForStored(page, (doc) => doc.content.filter((n) => n.type === 'figure').length === 1, 'the edit');

    // It lives in the media library.
    const openDialog = async () => {
      await page.getByRole('menuitem', { name: 'Tools' }).click();
      await page.getByRole('menuitem', { name: 'Media library' }).click();
      await page.getByRole('button', { name: 'Remove unused media…' }).click();
    };

    await openDialog();
    let dialog = page.getByRole('dialog');
    await dialog.getByText('dropped.png').waitFor();
    assert.equal(await dialog.getByText('kept.png').count(), 0);
    await app.screenshot('media-remove-unused');

    // Cancel changes nothing.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    assert.equal((await rpc(page, 'media.list')).length, 2);

    await openDialog();
    dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: /^Delete 1 file/ }).click();
    await page.getByText(/Removed 1 file/).waitFor();
    const left = await rpc(page, 'media.list');
    assert.deepEqual(left.map((a) => a.name), ['kept.png']);

    await waitUntil(() => page.locator('.media-tile img').evaluate((i) => i.naturalWidth > 0), 8000, 'the one still in use to show');
    await openDialog();
    await page.getByText('All the media in this project is in use.').waitFor();
    assertNoProblems();
  });

  it('replaces a picture in use everywhere, and deletes one after naming its pages', async () => {
    const page = await start();
    await createProject(page);
    await editHome(page, paragraphs(2, 2));
    await dropFiles(page, [{ png: { width: 64, height: 64, color: '#a33' }, name: 'old.png' }]);
    await waitUntil(async () => (await page.locator('.prose .figure[data-kind]').count()) === 1, 8000, 'the figure');
    const [old] = await rpc(page, 'media.list');
    await rpc(page, 'pages.create', {
      title: 'Harbor',
      content: { type: 'doc', content: [{ type: 'figure', attrs: { kind: 'picture', description: '' }, content: [
        { type: 'image', attrs: { assetId: old.id } }, { type: 'figcaption' },
      ] }] },
    });

    await page.getByRole('menuitem', { name: 'Tools' }).click();
    await page.getByRole('menuitem', { name: 'Media library' }).click();
    await page.locator('.media-tile').first().click();
    let detail = page.getByRole('complementary', { name: 'Details of old.png' });
    await detail.waitFor();
    await detail.getByLabel('Replace old.png with another file').setInputFiles({
      name: 'new.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(fixture('tiny.jpg'), 'base64'),
    });
    await page.getByText(/^Replaced old\.png/).waitFor();
    const after = await rpc(page, 'media.list');
    assert.equal(after.length, 1, 'the new file takes the place of the old one');
    assert.equal(after[0].id, old.id, 'so every use keeps it');
    assert.equal(after[0].name, 'new.jpg');

    // The same id now holds other bytes, and the web view shows them without a reload.
    detail = page.getByRole('complementary', { name: 'Details of new.jpg' });
    await waitUntil(() => detail.locator('img').first().evaluate((i) => i.complete && i.naturalWidth === 48), 8000, 'the preview to show the new picture');
    await detail.getByRole('button', { name: 'Main Page', exact: true }).click();
    const shown = page.locator('.prose .figure[data-kind] img').first();
    await shown.waitFor();
    await waitUntil(() => shown.evaluate((i) => i.complete && i.naturalWidth === 48), 8000, 'the figure to show the new picture');

    await page.getByRole('menuitem', { name: 'Tools' }).click();
    await page.getByRole('menuitem', { name: 'Media library' }).click();
    await page.locator('.media-tile').first().click();
    await detail.getByRole('button', { name: 'Delete…' }).click();
    const confirm = page.getByRole('alertdialog');
    await confirm.getByText('Harbor').waitFor();
    await confirm.getByText('Main Page').waitFor();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    assert.equal((await rpc(page, 'media.list')).length, 1, 'cancelling keeps it');
    await detail.getByRole('button', { name: 'Delete…' }).click();
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await waitUntil(async () => (await rpc(page, 'media.list')).length === 0, 4000, 'the delete');
    assertNoProblems();
  });

  it('browses the library, relabels figures, and reuses media without storing it twice', async () => {
    const page = await start();
    await createProject(page, 'Library World');
    await editHome(page, paragraphs(2, 2));
    const figures = page.locator('.prose .figure[data-kind]');

    await dropFiles(page, [{ png: { width: 120, height: 90, color: '#a33' }, name: 'gate.png' }]);
    await figures.first().waitFor();
    await waitUntil(async () => (await selectionInfo(page)).parent === 'figcaption', 8000, 'the label to get the cursor');
    await page.keyboard.type('The Silver Gate');

    await dropFiles(page, [{ base64: fixture('tiny-vp9.webm'), name: 'storm.webm', type: 'video/webm' }], { y: 0.95 });
    await waitUntil(async () => (await figures.count()) === 2, 8000, 'the video');
    await dropFiles(page, [{ png: { width: 64, height: 64, color: '#3a3' }, name: 'spare.png' }], { y: 0.95 });
    await waitUntil(async () => (await figures.count()) === 3, 8000, 'the spare picture');
    await clickFigureTool(page, 'Delete', 2);
    await waitForStored(page, (doc) => JSON.stringify(doc).includes('The Silver Gate') && doc.content.filter((n) => n.type === 'figure').length === 2, 'the edits');

    const assets = await rpc(page, 'media.list');
    assert.equal(assets.length, 3);
    const gate = assets.find((a) => a.name === 'gate.png');
    const figureOf = (id, label) => ({
      type: 'doc',
      content: [
        { type: 'figure', attrs: { kind: 'picture', align: 'right', width: null, description: '' }, content: [
          { type: 'image', attrs: { assetId: id, width: 120, height: 90 } },
          { type: 'figcaption', content: [{ type: 'text', text: label }] },
        ] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Some words beside it.' }] },
      ],
    });
    const second = await rpc(page, 'pages.create', { title: 'Second', content: figureOf(gate.id, 'The Silver Gate') });
    const third = await rpc(page, 'pages.create', { title: 'Third', content: figureOf(gate.id, 'Seen from the road') });
    const [book] = await rpc(page, 'books.list');
    const scene = (await rpc(page, 'nodes.tree', { bookId: book.id })).find((n) => n.kind === 'scene');
    await rpc(page, 'nodes.update', { id: scene.id, patch: { content: figureOf(gate.id, 'The Silver Gate') } });

    const openLibrary = async () => {
      await page.getByRole('menuitem', { name: 'Tools' }).click();
      await page.getByRole('menuitem', { name: 'Media library' }).click();
      await page.getByTestId('media-count').filter({ hasText: /of/ }).waitFor();
    };
    await openLibrary();
    const tiles = page.locator('.media-tile');
    const count = page.getByTestId('media-count');
    await waitUntil(async () => (await tiles.count()) === 3, 8000, 'the tiles');
    assert.equal(await count.innerText(), '3 of 3');
    const gateTile = tiles.filter({ hasText: 'The Silver Gate' });
    assert.ok(await gateTile.textContent());
    await waitUntil(() => gateTile.locator('img').evaluate((i) => i.naturalWidth > 0), 8000, 'the thumbnail');
    await app.screenshot('media-library');

    // Search and filters.
    const search = page.getByRole('searchbox', { name: 'Search media' });
    await search.fill('silver');
    await waitUntil(async () => (await count.innerText()) === '1 of 3', 3000, 'the search');
    await search.fill('storm');
    await waitUntil(async () => (await count.innerText()) === '1 of 3', 3000, 'the search by name');
    assert.match(await tiles.first().textContent(), /storm\.webm/);
    await search.fill('nothing like this');
    await page.getByText('Nothing matches.').waitFor();
    await search.fill('');
    const show = page.getByRole('group', { name: 'Show' });
    await show.getByRole('button', { name: 'Videos' }).click();
    await waitUntil(async () => (await count.innerText()) === '1 of 3', 3000, 'the Videos filter');
    await show.getByRole('button', { name: 'Pictures' }).click();
    await waitUntil(async () => (await count.innerText()) === '2 of 3', 3000, 'the Pictures filter');
    await show.getByRole('button', { name: 'Unused' }).click();
    await waitUntil(async () => (await count.innerText()) === '1 of 3', 3000, 'the Unused filter');
    assert.match(await tiles.first().textContent(), /spare\.png/);
    await show.getByRole('button', { name: 'All' }).click();

    // Choosing one shows it, and everywhere it is used.
    await gateTile.click();
    const detail = page.getByRole('complementary', { name: 'Details of gate.png' });
    await detail.waitFor();
    await waitUntil(() => detail.locator('img').evaluate((i) => i.naturalWidth === 120), 8000, 'the preview');
    await detail.getByRole('button', { name: 'Second' }).waitFor();
    for (const title of ['Main Page', 'Second', 'Third', scene.title]) {
      assert.equal(await detail.getByRole('button', { name: title, exact: true }).count(), 1, title);
    }
    assert.match(await detail.innerText(), /Picture 1: Seen from the road/);
    await app.screenshot('media-library-detail');

    // A new label follows through the figures that shared the old one, and not the other.
    await detail.getByRole('textbox', { name: 'Label' }).fill('The Gate at Dawn');
    await page.keyboard.press('Enter');
    await page.getByText('Updated 3 figures. 1 figure kept its own words.').waitFor();
    assert.match(pmToPlainText((await rpc(page, 'pages.home')).content), /\[Picture 1: The Gate at Dawn\]/);
    assert.match(pmToPlainText((await rpc(page, 'pages.get', { id: second.id })).content), /\[Picture 1: The Gate at Dawn\]/);
    assert.match(pmToPlainText((await rpc(page, 'pages.get', { id: third.id })).content), /\[Picture 1: Seen from the road\]/);
    assert.match(pmToPlainText((await rpc(page, 'nodes.get', { id: scene.id })).content), /\[Picture 1: The Gate at Dawn\]/);
    await tiles.filter({ hasText: 'The Gate at Dawn' }).waitFor();
    // Search finds the new words, because the documents' own text was updated properly.
    assert.ok((await rpc(page, 'search.query', { q: 'gate dawn' })).some((hit) => hit.id === second.id));

    // No figure has a description yet, so all of them take it.
    await detail.getByRole('textbox', { name: 'More detail for the AI (optional)' }).fill('A pale morning');
    await detail.getByRole('textbox', { name: 'Label' }).focus();
    await page.getByText('Updated 4 figures.').waitFor();
    assert.match(pmToPlainText((await rpc(page, 'pages.get', { id: third.id })).content), /\[Picture 1: Seen from the road \(A pale morning\)\]/);

    // A use is a link that opens the page.
    await detail.getByRole('button', { name: 'Second', exact: true }).click();
    await page.getByRole('heading', { name: 'Second', level: 1 }).waitFor();

    // Back in the library, this page is the current document. Inserting adds a figure with
    // the label, and stores nothing new.
    await openLibrary();
    await tiles.filter({ hasText: 'The Gate at Dawn' }).click();
    const insert = page.getByRole('button', { name: 'Insert into Second' });
    await insert.click();
    await page.locator('.ProseMirror[contenteditable="true"]').waitFor();
    await waitUntil(async () => (await figures.count()) === 2, 8000, 'the inserted figure');
    assert.equal((await rpc(page, 'media.list')).length, 3, 'nothing stored twice');
    assert.equal((await selectionInfo(page)).parent, 'figcaption');
    const inserted = await waitForStored2(page, second.id, 2);
    assert.deepEqual(inserted.map((f) => [f.assetId, f.caption, f.description]), [
      [gate.id, 'The Gate at Dawn', 'A pale morning'],
      [gate.id, 'The Gate at Dawn', 'A pale morning'],
    ]);

    // The picker, from Insert Picture.
    await page.locator('.ProseMirror > p').first().click();
    const menu = async (name) => {
      await page.getByRole('menuitem', { name: 'Insert' }).click();
      await page.getByRole('menuitem', { name, exact: true }).click();
    };
    await menu('Picture…');
    const picker = page.getByRole('dialog');
    await picker.locator('.media-tile').first().waitFor();
    assert.equal(await picker.locator('.media-tile').count(), 2, 'pictures only');
    await app.screenshot('media-library-picker');
    await picker.getByRole('searchbox', { name: 'Search media' }).fill('spare');
    await waitUntil(async () => (await picker.locator('.media-tile').count()) === 1, 3000, 'the search in the picker');
    await picker.locator('.media-tile').click();
    await waitUntil(async () => (await figures.count()) === 3, 8000, 'the picked figure');
    assert.equal((await rpc(page, 'media.list')).length, 3, 'still nothing stored twice');
    assert.equal(await page.getByRole('dialog').count(), 0);

    // Cancel does nothing, and choosing a file still works from there.
    await page.locator('.ProseMirror > p').first().click();
    await menu('Picture…');
    await picker.getByRole('button', { name: 'Cancel' }).click();
    assert.equal(await figures.count(), 3);

    const path = workspace.file('new-one.png');
    copyFileSync(join(FIXTURES, 'tiny.gif'), path);
    await answerNextDialog(page, path);
    await menu('Picture…');
    await picker.getByRole('button', { name: 'Choose a file…' }).click();
    await waitUntil(async () => (await figures.count()) === 4, 8000, 'the chosen file');
    assert.equal((await rpc(page, 'media.list')).length, 4);

    // Insert Video offers stored videos the same way.
    await page.locator('.ProseMirror > p').first().click();
    await menu('Video…');
    await picker.locator('.media-tile').filter({ hasText: 'storm.webm' }).click();
    await waitUntil(async () => (await page.locator('.prose .figure[data-kind="video"]').count()) === 1, 8000, 'the reused video');
    assert.equal((await rpc(page, 'media.list')).length, 4);

    // A scene is a link too, and shows the label changed from the library. From there,
    // inserting goes into the scene.
    await openLibrary();
    await tiles.filter({ hasText: 'The Gate at Dawn' }).click();
    await detail.getByRole('button', { name: scene.title, exact: true }).click();
    const inScene = page.locator('.ProseMirror figcaption').filter({ hasText: 'The Gate at Dawn' });
    await inScene.waitFor();
    assert.equal(await page.evaluate(() => document.querySelector('.ProseMirror').isContentEditable), true);
    await openLibrary();
    await tiles.filter({ hasText: 'The Gate at Dawn' }).click();
    await page.getByRole('button', { name: `Insert into ${scene.title}` }).click();
    await waitUntil(
      async () => describeFigures((await rpc(page, 'nodes.get', { id: scene.id })).content).length === 2,
      8000,
      'the figure in the scene',
    );
    assert.equal((await rpc(page, 'media.list')).length, 4);
    assertNoProblems();
  });

  it('lists sound files and PDFs in the library, plays and opens them', async () => {
    const page = await start();
    await createProject(page, 'Sound World');
    const board = await rpc(page, 'canvases.create', { title: 'Board', data: { nodes: [], edges: [] } });
    await page.getByRole('button', { name: 'Atlas', exact: true }).click();
    await page.locator('.nav-link', { hasText: 'Board' }).click();
    await page.locator('.canvas-board').waitFor();
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
    // A real WAV: 8 kHz, 8-bit mono, a tenth of a second of silence.
    const wav = Buffer.alloc(44 + 800, 128);
    wav.write('RIFF', 0, 'latin1');
    wav.writeUInt32LE(36 + 800, 4);
    wav.write('WAVEfmt ', 8, 'latin1');
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24);
    wav.writeUInt32LE(8000, 28);
    wav.writeUInt16LE(1, 32);
    wav.writeUInt16LE(8, 34);
    wav.write('data', 36, 'latin1');
    wav.writeUInt32LE(800, 40);
    await dropFiles(
      page,
      [
        { base64: pdf.toString('base64'), name: 'letter.pdf', type: 'application/pdf' },
        { base64: wav.toString('base64'), name: 'bells.wav', type: 'audio/wav' },
      ],
      { selector: '.canvas-board', x: 0.3, y: 0.3 },
    );
    await waitUntil(async () => (await rpc(page, 'media.list')).length === 2, 8000, 'both files');
    const assets = await rpc(page, 'media.list');
    assert.deepEqual(assets.map((a) => `${a.kind} ${a.mime}`).sort(), ['audio audio/wav', 'pdf application/pdf']);
    await waitUntil(async () => (await rpc(page, 'canvases.get', { id: board.id })).data.nodes.length === 2, 5000, 'two cards');

    // The sound card plays from the scheme. A broken PDF says so and still offers Open.
    await page.locator('audio.canvas-audio-player[controls]').waitFor();
    await page.locator('.canvas-pdf[data-pdf-state="failed"]').waitFor({ timeout: 15000 });

    await page.getByRole('menuitem', { name: 'Tools' }).click();
    await page.getByRole('menuitem', { name: 'Media library' }).click();
    const count = page.getByTestId('media-count');
    await count.filter({ hasText: /of/ }).waitFor();
    const show = page.getByRole('group', { name: 'Show' });
    await show.getByRole('button', { name: 'Sounds' }).click();
    await waitUntil(async () => (await count.innerText()) === '1 of 2', 3000, 'the Sounds filter');
    await page.locator('.media-tile', { hasText: 'bells.wav' }).click();
    const sound = page.getByRole('complementary', { name: 'Details of bells.wav' });
    await sound.locator('audio[controls]').waitFor();
    await sound.getByText('Drag this onto a canvas to show it there.').waitFor();
    await show.getByRole('button', { name: 'PDFs' }).click();
    await waitUntil(async () => (await count.innerText()) === '1 of 2', 3000, 'the PDFs filter');
    await page.locator('.media-tile', { hasText: 'letter.pdf' }).click();
    const letter = page.getByRole('complementary', { name: 'Details of letter.pdf' });
    await letter.getByRole('button', { name: 'Open', exact: true }).click();
    await waitUntil(async () => (await rpc(page, 'media.e2eOpened')).some((p) => p.endsWith('.pdf')), 8000, 'the PDF to open');
    assert.equal(await page.locator('.media-tile[draggable="true"]').count(), 1);
    assertNoProblems();
  });

  it('stays quick with 500 items, loading only the thumbnails near the screen', async () => {
    const page = await start();
    await createProject(page);

    // 500 small pictures through the real upload calls, each one different.
    const seeded = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 24;
      canvas.getContext('2d').fillRect(0, 0, 32, 24);
      const base = new Uint8Array(await (await new Promise((r) => canvas.toBlob(r, 'image/png'))).arrayBuffer());
      const { invoke } = window.__TAURI_INTERNALS__;
      const addOne = async (n) => {
        // Bytes after a PNG's end are ignored by decoders, and make each file distinct.
        const bytes = new Uint8Array(base.length + 4);
        bytes.set(base);
        new DataView(bytes.buffer).setUint32(base.length, n);
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        const sha256 = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
        const { id } = await invoke('rpc', { method: 'media.uploadBegin', params: { name: `picture ${n}.png`, mime: 'image/png', size: bytes.length } });
        await invoke('media_upload_chunk', bytes, { headers: { 'x-asset-id': id, 'x-chunk-index': '0' } });
        await invoke('rpc', { method: 'media.uploadFinish', params: { id, sha256, width: 32, height: 24 } });
      };
      const started = performance.now();
      const batch = 8;
      for (let n = 0; n < 500; n += batch) {
        await Promise.all(Array.from({ length: Math.min(batch, 500 - n) }, (_, i) => addOne(n + i)));
      }
      return performance.now() - started;
    });
    console.log(`Seeded 500 pictures in ${(seeded / 1000).toFixed(1)} s`);

    const measured = await page.evaluate(async () => {
      const started = performance.now();
      const { items } = await window.__TAURI_INTERNALS__.invoke('rpc', { method: 'media.library', params: null });
      return { ms: performance.now() - started, items: items.length };
    });
    assert.equal(measured.items, 500);

    await page.getByRole('menuitem', { name: 'Tools' }).click();
    const opened = Date.now();
    await page.getByRole('menuitem', { name: 'Media library' }).click();
    await page.getByTestId('media-count').filter({ hasText: '500 of 500' }).waitFor({ timeout: 30_000 });
    const openMs = Date.now() - opened;
    await new Promise((r) => setTimeout(r, 500));

    const images = () =>
      page.evaluate(() => {
        const all = [...document.querySelectorAll('.media-tile img')];
        return { tiles: all.length, loaded: all.filter((i) => i.complete && i.naturalWidth > 0).length };
      });
    const first = await images();
    assert.equal(first.tiles, 500);
    assert.ok(first.loaded < 200, `only those near the screen loaded: ${JSON.stringify(first)}`);

    // Searching is immediate, and so is choosing one.
    const searchMs = await page.evaluate(async () => {
      const input = document.querySelector('.media-library-search');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      const started = performance.now();
      set.call(input, 'picture 123');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      while (document.querySelector('[data-testid="media-count"]').textContent !== '1 of 500') {
        await new Promise((r) => requestAnimationFrame(r));
      }
      const took = performance.now() - started;
      set.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return took;
    });
    await page.getByTestId('media-count').filter({ hasText: '500 of 500' }).waitFor();

    const scroll = await page.evaluate(async () => {
      const content = document.querySelector('.content');
      const frames = [];
      let last = performance.now();
      const total = content.scrollHeight - content.clientHeight;
      const started = performance.now();
      await new Promise((resolve) => {
        const step = (now) => {
          frames.push(now - last);
          last = now;
          const t = (now - started) / 3000;
          content.scrollTop = total * Math.min(1, t);
          if (t < 1) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });
      frames.shift();
      frames.sort((a, b) => a - b);
      return { median: frames[Math.floor(frames.length / 2)], p95: frames[Math.floor(frames.length * 0.95)] };
    });
    console.log(
      `500 items: library call ${measured.ms.toFixed(0)} ms, screen open ${openMs} ms, search ${searchMs.toFixed(0)} ms,`,
      `${first.loaded} thumbnails loaded at first, scrolling ${JSON.stringify(scroll)}`,
    );
    assert.ok(measured.ms < 5000, `library call ${measured.ms} ms`);
    assert.ok(openMs < 15_000, `opening took ${openMs} ms`);
    assert.ok(searchMs < 3000, `search took ${searchMs} ms`);
    assert.ok(scroll.p95 < 400, `scrolling: ${JSON.stringify(scroll)}`);
    const after = await images();
    assert.ok(after.loaded > first.loaded, 'scrolling brings more in');
    await page.locator('.media-tile').nth(250).click();
    await page.getByRole('complementary', { name: /^Details of/ }).waitFor();
    await app.screenshot('media-library-500');
    assertNoProblems();
  });

  it('keeps a page of 30 pictures light: only what is near the screen loads, and scrolling stays smooth', async () => {
    const page = await start();
    await createProject(page);
    await editHome(page, paragraphs(30, 3));

    // Thirty files in one drop, at the end, so they stack down the page.
    const specs = Array.from({ length: 30 }, (_, i) => ({
      png: { width: 900, height: 600, color: `hsl(${i * 12} 60% 40%)` },
      name: `p${i}.png`,
    }));
    await dropFiles(page, specs, { y: 0.01 });
    await waitUntil(async () => (await page.locator('.prose .figure[data-kind]').count()) === 30, 60_000, 'thirty figures');
    assert.equal((await rpc(page, 'media.list')).length, 30);
    const stored = await waitForStored(page, (doc) => doc.content.filter((n) => n.type === 'figure').length === 30, 'the figures');

    // Spread them through the text, as an article would have them.
    const spread = { type: 'doc', content: [] };
    const figures = stored.content.filter((n) => n.type === 'figure');
    const texts = stored.content.filter((n) => n.type === 'paragraph');
    for (let i = 0; i < 30; i += 1) {
      spread.content.push(figures[i], texts[i] ?? { type: 'paragraph' });
    }
    await rpc(page, 'pages.update', { id: (await rpc(page, 'pages.home')).id, patch: { content: spread } });

    // Fresh, in Read mode: how much loads with nothing scrolled?
    const path = workspace.file('thirty.lorecraft');
    await allowPath(page, path);
    await rpc(page, 'project.saveAs', { path });
    await rpc(page, 'project.close');
    await rpc(page, 'project.open', { path });
    await page.locator('.prose .figure[data-kind]').first().waitFor();
    await waitUntil(() => page.locator('.prose .figure[data-kind] .media-frame img').first().evaluate((i) => i.naturalWidth > 0), 8000, 'the first picture');
    await new Promise((r) => setTimeout(r, 500));
    const counts = () =>
      page.evaluate(() => {
        const images = [...document.querySelectorAll('.prose .figure[data-kind] .media-frame img')];
        return { all: images.length, loaded: images.filter((i) => i.complete && i.naturalWidth > 0).length };
      });
    const start1 = await counts();
    console.log('On opening:', JSON.stringify(start1));
    assert.equal(start1.all, 30);
    assert.ok(start1.loaded < 30, `lazy loading held some back: ${JSON.stringify(start1)}`);
    const sizes = await page.evaluate(() => {
      const last = [...document.querySelectorAll('.prose .figure[data-kind] .media-frame img')].pop();
      return { height: last.getBoundingClientRect().height, loaded: last.complete && last.naturalWidth > 0 };
    });
    assert.ok(sizes.height > 40, `a picture not yet loaded holds its space: ${JSON.stringify(sizes)}`);

    // A scripted scroll through the whole page, timing each frame.
    const scroll = await page.evaluate(async () => {
      const content = document.querySelector('.content');
      const frames = [];
      let last = performance.now();
      const total = content.scrollHeight - content.clientHeight;
      const started = performance.now();
      const duration = 4000;
      await new Promise((resolve) => {
        const step = (now) => {
          frames.push(now - last);
          last = now;
          const t = (now - started) / duration;
          content.scrollTop = total * Math.min(1, t);
          if (t < 1) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });
      frames.shift();
      frames.sort((a, b) => a - b);
      return {
        scrollHeight: content.scrollHeight,
        frames: frames.length,
        median: frames[Math.floor(frames.length / 2)],
        p95: frames[Math.floor(frames.length * 0.95)],
        worst: frames[frames.length - 1],
      };
    });
    console.log('Scrolling 30 pictures:', JSON.stringify(scroll));
    assert.ok(scroll.median < 100, `median frame ${scroll.median} ms`);
    assert.ok(scroll.p95 < 400, `95th percentile frame ${scroll.p95} ms`);
    await waitUntil(async () => (await counts()).loaded === 30, 10_000, 'all of them to load after scrolling');
    await app.screenshot('media-thirty');
    assertNoProblems();
  });

  it('wraps properly in dark and light, in article and manuscript type', async () => {
    const page = await start();
    await createProject(page);
    await editHome(page, paragraphs(5, 5));
    await dropFiles(page, [{ png: { width: 640, height: 400, color: '#567' }, name: 'theme.png' }]);
    await page.locator('.prose .figure[data-kind]').waitFor();
    await waitUntil(async () => (await selectionInfo(page)).parent === 'figcaption', 8000, 'the label to get the cursor');
    await page.keyboard.type('The hall at Silver Vale');
    await dropFiles(page, [{ png: { width: 300, height: 400, color: '#a85' }, name: 'other.png' }], { y: 0.6 });
    await waitUntil(async () => (await page.locator('.prose .figure[data-kind]').count()) === 2, 8000, 'the second figure');
    await clickFigureTool(page, 'Wrap left', 1);

    for (const [theme, mode] of [
      ['encyclopedia', 'dark'],
      ['encyclopedia', 'light'],
      ['parchment', 'light'],
      ['parchment', 'dark'],
      ['midnight', 'dark'],
      ['typewriter', 'light'],
    ]) {
      await page.evaluate(([t, m]) => {
        document.documentElement.dataset.theme = t;
        document.documentElement.dataset.mode = m;
      }, [theme, mode]);
      await new Promise((r) => setTimeout(r, 100));
      assertTextWraps(await layoutOfFigure(page), 'right');
      await page.locator('.prose .figure[data-kind]').first().hover();
      await app.screenshot(`media-theme-${theme}-${mode}`);
    }

    // The manuscript's type settings, on the same editor. The Write area is another module.
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'parchment';
      document.documentElement.dataset.mode = 'light';
      const prose = document.querySelector('.ProseMirror');
      prose.classList.replace('prose-article', 'prose-manuscript');
    });
    assertTextWraps(await layoutOfFigure(page), 'right');
    await app.screenshot('media-manuscript');

    // Figures scale with the writing-text setting, separately from the interface.
    await page.keyboard.press('Control+=');
    await page.keyboard.press('Control+=');
    assertTextWraps(await layoutOfFigure(page), 'right');
    assertNoProblems();
  });
});
