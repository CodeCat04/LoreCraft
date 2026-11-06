/**
 * The canvas: making one, cards, connections, groups, panning and zooming, undo, export,
 * a page shown on a card, a canvas embedded in a page, saving and reopening, and recovery
 * after a force-close.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { allowPath, answerNextDialog, createProject, createWorkspace, launch, rpc, waitUntil } from './harness.mjs';

const BOARD = '.canvas-board';

/** A real one-page PDF: a 200-point page with a blue square in the middle. */
function onePagePdf() {
  const content = '0 0 1 rg 20 20 160 160 re f';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) out += `${String(at).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function storedCanvas(page) {
  const [meta] = await rpc(page, 'canvases.list');
  return meta ? rpc(page, 'canvases.get', { id: meta.id }) : null;
}

async function waitStored(page, check, what) {
  await waitUntil(async () => {
    const c = await storedCanvas(page);
    return c && check(c.data);
  }, 5000, what);
}

describe('canvas', () => {
  let workspace;
  let app;

  beforeEach(() => {
    workspace = createWorkspace();
  });

  afterEach(async (t) => {
    if (t.passed === false && app && !app.exited) await app.screenshot('canvas-last-failure').catch(() => {});
    if (app && !app.exited) await app.kill().catch(() => {});
    workspace.cleanup();
  });

  async function start(name) {
    app = await launch(workspace);
    const page = app.page;
    const problems = [];
    page.on('pageerror', (e) => problems.push(e.message));
    app.problems = problems;
    await createProject(page, name);
    return page;
  }

  async function newCanvasFromSidebar(page, name) {
    await page.getByRole('button', { name: 'Atlas', exact: true }).click();
    await page.getByRole('button', { name: 'New canvas', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill(name);
    await dialog.getByLabel('Name').press('Enter');
    await page.locator(BOARD).waitFor();
  }

  async function boardBox(page) {
    return page.locator(BOARD).boundingBox();
  }

  it('makes cards, connects and groups them, pans, zooms, undoes and exports', async () => {
    const page = await start('Canvas World');
    await newCanvasFromSidebar(page, 'Plot board');
    assert.ok(page.locator('.nav-link', { hasText: 'Plot board' }));
    const box = await boardBox(page);

    // Double-click makes a text card, edited in place.
    await page.mouse.dblclick(box.x + 200, box.y + 200);
    await page.getByLabel('Card text').fill('# The heist\nThey go in at midnight.');
    await page.keyboard.press('Escape');
    await page.mouse.dblclick(box.x + 650, box.y + 200);
    await page.getByLabel('Card text').fill('The vault');
    await page.keyboard.press('Escape');
    await waitStored(page, (d) => d.nodes.length === 2 && d.nodes.some((n) => n.text === 'The vault'), 'two text cards stored');
    await page.locator('.canvas-card .canvas-md h1', { hasText: 'The heist' }).waitFor();

    // Drag from the first card's right handle onto the second card.
    const [first, second] = await page.locator('.canvas-card').all();
    await first.hover();
    const handle = await first.locator('.canvas-handle-right').boundingBox();
    const target = await second.boundingBox();
    await page.mouse.move(handle.x + 6, handle.y + 6);
    await page.mouse.down();
    await page.mouse.move(target.x + 40, target.y + 30, { steps: 8 });
    await page.mouse.up();
    await waitStored(page, (d) => d.edges.length === 1, 'the connection stored');
    assert.equal(await page.locator('.canvas-edge').count(), 1);

    // Dropping a connection on empty space makes a new card there, joined to it.
    await second.hover();
    const h2 = await second.locator('.canvas-handle-bottom').boundingBox();
    await page.mouse.move(h2.x + 6, h2.y + 6);
    await page.mouse.down();
    await page.mouse.move(h2.x + 6, h2.y + 260, { steps: 8 });
    await page.mouse.up();
    await page.getByLabel('Card text').fill('Escape route');
    await page.keyboard.press('Escape');
    await waitStored(page, (d) => d.nodes.length === 3 && d.edges.length === 2, 'the new card and its connection');

    // Select all and group.
    await page.locator(BOARD).focus();
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+g');
    await page.getByLabel('Group name').fill('Act one');
    await page.keyboard.press('Enter');
    await waitStored(page, (d) => d.nodes.some((n) => n.type === 'group' && n.label === 'Act one'), 'the group');

    // Undo takes the group back, and redo returns it.
    await page.locator(BOARD).focus();
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await waitStored(page, (d) => !d.nodes.some((n) => n.type === 'group'), 'the group undone');
    await page.keyboard.press('Control+y');
    await page.keyboard.press('Control+y');
    await waitStored(page, (d) => d.nodes.some((n) => n.type === 'group' && n.label === 'Act one'), 'the group redone');

    // Zoom toward the cursor with Ctrl+wheel, and pan with the wheel.
    const zoomText = () => page.locator('.canvas-zoom').innerText();
    const before = await zoomText();
    await page.mouse.move(box.x + 300, box.y + 300);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -400);
    await page.keyboard.up('Control');
    await waitUntil(async () => (await zoomText()) !== before, 3000, 'the zoom to change');
    const transform = () => page.locator('.canvas-world').evaluate((el) => el.style.transform);
    const t1 = await transform();
    await page.mouse.wheel(0, 200);
    await waitUntil(async () => (await transform()) !== t1, 3000, 'the view to scroll');
    // Middle-drag pans.
    const t2 = await transform();
    await page.mouse.move(box.x + 50, box.y + 400);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(box.x + 150, box.y + 450, { steps: 5 });
    await page.mouse.up({ button: 'middle' });
    assert.notEqual(await transform(), t2);
    // Fit all puts every card back on screen.
    await page.getByRole('button', { name: 'Fit all' }).click();

    // Export the whole canvas as a PNG, and as a .canvas file.
    const png = workspace.file('board.png');
    await answerNextDialog(page, png);
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Export whole canvas as PNG…' }).click();
    await waitUntil(() => existsSync(png), 8000, 'the PNG');
    assert.deepEqual([...readFileSync(png).subarray(1, 4)], [0x50, 0x4e, 0x47]);
    const file = workspace.file('board.canvas');
    await answerNextDialog(page, file);
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Export as .canvas file…' }).click();
    await waitUntil(() => existsSync(file), 5000, 'the .canvas file');
    const exported = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(exported.nodes.length, 4);
    assert.equal(exported.edges.length, 2);
    await app.screenshot('canvas-board');
    assert.deepEqual(app.problems, []);
  });

  it('shows a page on a card, embeds the canvas in a page, saves and reopens', async () => {
    const page = await start('Embed World');
    const home = await rpc(page, 'pages.home');
    const made = await rpc(page, 'canvases.create', {
      title: 'Map of motives',
      data: {
        nodes: [
          { id: 'p1', type: 'file', file: `lorecraft:page/${home.id}`, x: 0, y: 0, width: 400, height: 300 },
          { id: 't1', type: 'text', text: 'Why?', x: 500, y: 0, width: 200, height: 80, color: '3' },
          { id: 'w1', type: 'link', url: 'https://example.com/', x: 0, y: 400, width: 300, height: 200 },
        ],
        edges: [{ id: 'e1', fromNode: 'p1', toNode: 't1', label: 'asks' }],
      },
    });
    await page.getByRole('button', { name: 'Atlas', exact: true }).click();
    await page.locator('.nav-link', { hasText: 'Map of motives' }).click();
    await page.locator(BOARD).waitFor();
    // The page card shows the live page.
    await page.locator('.canvas-card-file .canvas-card-title', { hasText: home.title }).waitFor();
    await page.locator('.canvas-edge-text', { hasText: 'asks' }).waitFor();
    // The web card loads nothing until asked, and then only in a sandboxed frame.
    assert.equal(await page.locator('iframe').count(), 0);
    await page.getByRole('button', { name: 'Load this page' }).click();
    const frame = page.locator('iframe.canvas-frame');
    await frame.waitFor({ state: 'attached' });
    assert.equal(await frame.getAttribute('sandbox'), 'allow-scripts allow-forms');
    assert.equal(await frame.getAttribute('referrerpolicy'), 'no-referrer');

    // Embed the canvas in the home page.
    await rpc(page, 'pages.update', {
      id: home.id,
      patch: { content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'See the board.' }] }, { type: 'canvasEmbed', attrs: { canvasId: made.id } }] } },
    });
    await page.getByRole('button', { name: 'Wiki', exact: true }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const embed = page.locator('.canvas-embed');
    await embed.getByText('Canvas: Map of motives').waitFor();
    assert.equal(await embed.locator('.canvas-embed-card').count(), 3);
    await embed.getByRole('button', { name: 'Open canvas' }).click();
    await page.locator(BOARD).waitFor();

    // Save, close and open again: the canvas comes back.
    const path = workspace.file('embed.lorecraft');
    await allowPath(page, path);
    await rpc(page, 'project.saveAs', { path });
    await rpc(page, 'project.close');
    await rpc(page, 'project.open', { path });
    const back = await storedCanvas(page);
    assert.equal(back.title, 'Map of motives');
    assert.equal(back.data.nodes.length, 3);
    assert.equal(back.data.nodes[1].color, '3');
    assert.deepEqual(app.problems, []);
  });

  it('shows PDF and sound cards from a drop, opens a PDF, and exports pictures and wrapped text', async () => {
    const page = await start('Media Board');
    await newCanvasFromSidebar(page, 'Evidence');
    // A PNG made in the page, a one-page PDF with a blue square, and an MP3 header.
    await page.evaluate(
      async ({ pdf, mp3 }) => {
        const canvas = document.createElement('canvas');
        canvas.width = 80;
        canvas.height = 60;
        const g = canvas.getContext('2d');
        g.fillStyle = '#ff0000';
        g.fillRect(0, 0, 80, 60);
        const png = await new Promise((r) => canvas.toBlob(r, 'image/png'));
        const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const data = new DataTransfer();
        data.items.add(new File([png], 'red.png', { type: 'image/png' }));
        data.items.add(new File([bytes(pdf)], 'map.pdf', { type: 'application/pdf' }));
        data.items.add(new File([bytes(mp3)], 'theme.mp3', { type: 'audio/mpeg' }));
        const board = document.querySelector('.canvas-board');
        const rect = board.getBoundingClientRect();
        const init = { dataTransfer: data, bubbles: true, cancelable: true, clientX: rect.left + 100, clientY: rect.top + 100 };
        board.dispatchEvent(new DragEvent('dragover', init));
        board.dispatchEvent(new DragEvent('drop', init));
      },
      { pdf: onePagePdf().toString('base64'), mp3: Buffer.concat([Buffer.from('ID3\x04\0\0\0\0\0\0', 'latin1'), Buffer.alloc(400)]).toString('base64') },
    );
    await page.locator('.canvas-pdf[data-pdf-state="ready"]').waitFor({ timeout: 15000 });
    await page.locator('.canvas-pdf', { hasText: 'One page' }).waitFor();
    const player = page.locator('audio.canvas-audio-player');
    await player.waitFor();
    assert.equal(await player.getAttribute('controls'), '');
    assert.match(await player.getAttribute('src'), /lbasset/);
    await waitUntil(() => page.locator('img.canvas-media').evaluate((i) => i.naturalWidth === 80), 8000, 'the picture');
    // The first page really is drawn: its middle is the PDF's blue.
    const blue = await page.locator('.canvas-pdf-page canvas').evaluate((c) => {
      const [r, g, b] = c.getContext('2d').getImageData(c.width / 2, c.height / 2, 1, 1).data;
      return b > 200 && r < 60 && g < 60;
    });
    assert.ok(blue, 'the PDF preview shows its page');

    await page.locator('.canvas-pdf').getByRole('button', { name: 'Open', exact: true }).click();
    await waitUntil(async () => (await rpc(page, 'media.e2eOpened')).some((p) => p.endsWith('.pdf')), 8000, 'the PDF to be opened');
    await waitStored(page, (d) => d.nodes.length === 3, 'the three cards');

    // A text card beside them, then export: the picture is drawn, not its name, and the text wraps.
    const red = (await rpc(page, 'media.list')).find((a) => a.name === 'red.png');
    await rpc(page, 'canvases.create', {
      title: 'Export check',
      data: {
        nodes: [
          { id: 'pic', type: 'file', file: `lorecraft:asset/${red.id}`, x: 0, y: 0, width: 80, height: 60 },
          { id: 'txt', type: 'text', text: '# Siege\n\nThe walls fall on the third day and the river rises.\n\n- Aria flees\n- Bran stays', x: 200, y: 0, width: 200, height: 400 },
        ],
        edges: [],
      },
    });
    await page.getByRole('button', { name: 'Atlas', exact: true }).click();
    await page.locator('.nav-link', { hasText: 'Export check' }).click();
    await page.locator('.canvas-card-text').waitFor();
    const out = workspace.file('media.png');
    await answerNextDialog(page, out);
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Export whole canvas as PNG…' }).click();
    await waitUntil(() => existsSync(out), 15000, 'the PNG');
    const report = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      // The export has a 40-unit margin and a scale of 2.
      const at = (x, y) => [...g.getImageData((x + 40) * 2, (y + 40) * 2, 1, 1).data];
      const [r, gg, b] = at(40, 30);
      // Rows of the text card that hold ink unlike the card's own background.
      const [br, bg, bb] = at(395, 395);
      let rows = 0;
      let inRow = false;
      for (let y = 0; y < 400; y += 1) {
        let ink = false;
        for (let x = 210; x < 390; x += 2) {
          const [pr, pg, pb] = at(x, y);
          if (Math.abs(pr - br) + Math.abs(pg - bg) + Math.abs(pb - bb) > 120) {
            ink = true;
            break;
          }
        }
        if (ink && !inRow) rows += 1;
        inRow = ink;
      }
      return { red: r > 200 && gg < 60 && b < 60, rows };
    }, readFileSync(out).toString('base64'));
    assert.ok(report.red, 'the picture is drawn into the PNG');
    // Heading, at least two wrapped lines of the paragraph, and two list items.
    assert.ok(report.rows >= 5, `the text card has ${report.rows} lines`);
    assert.deepEqual(app.problems, []);
  });

  it('stays smooth with 500 cards', async (t) => {
    const page = await start('Big Canvas');
    const nodes = Array.from({ length: 500 }, (_, i) => ({
      id: `n${i}`,
      type: 'text',
      text: `Card ${i}\n\nSome **notes** about it.`,
      x: (i % 25) * 300,
      y: Math.floor(i / 25) * 200,
      width: 260,
      height: 140,
    }));
    const edges = nodes.slice(1).map((n, i) => ({ id: `e${i}`, fromNode: nodes[i].id, toNode: n.id }));
    await rpc(page, 'canvases.create', { title: 'Big', data: { nodes, edges } });
    await page.getByRole('button', { name: 'Atlas', exact: true }).click();
    await page.locator('.nav-link', { hasText: 'Big' }).click();
    await page.locator('.canvas-card').first().waitFor();
    const measure = (kind) =>
      page.evaluate(async (kind) => {
        const board = document.querySelector('.canvas-board');
        const box = board.getBoundingClientRect();
        const frames = [];
        for (let i = 0; i < 40; i++) {
          const started = performance.now();
          board.dispatchEvent(
            new WheelEvent('wheel', { deltaY: kind === 'zoom' ? (i < 20 ? -60 : 60) : 80, deltaX: kind === 'pan' ? 40 : 0, ctrlKey: kind === 'zoom', clientX: box.left + 400, clientY: box.top + 300, bubbles: true, cancelable: true }),
          );
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          frames.push(performance.now() - started);
        }
        frames.sort((a, b) => a - b);
        return { median: frames[20], p90: frames[36] };
      }, kind);
    const pan = await measure('pan');
    // Zoomed out far enough to show every card at once.
    await page.getByRole('button', { name: 'Fit all' }).click();
    const zoom = await measure('zoom');
    t.diagnostic(`500 cards: pan median ${pan.median.toFixed(1)} ms, p90 ${pan.p90.toFixed(1)} ms; zoom (all shown) median ${zoom.median.toFixed(1)} ms, p90 ${zoom.p90.toFixed(1)} ms`);
    // Two frames are about 33 ms at 60 Hz. Allow for a busy shared machine.
    assert.ok(pan.median < 80, `pan median ${pan.median}`);
    assert.ok(zoom.median < 120, `zoom median ${zoom.median}`);
  });

  it('keeps canvas changes through a force-close', async () => {
    const page = await start('Crash Canvas');
    await newCanvasFromSidebar(page, 'Unsaved board');
    const box = await boardBox(page);
    await page.mouse.dblclick(box.x + 200, box.y + 200);
    await page.getByLabel('Card text').fill('Do not lose me');
    await page.keyboard.press('Escape');
    await waitStored(page, (d) => d.nodes.some((n) => n.text === 'Do not lose me'), 'the card stored');
    await app.kill();

    app = await launch(workspace);
    await app.page.getByRole('heading', { name: 'Recover your work?' }).waitFor();
    await app.page.getByRole('button', { name: 'Recover' }).click();
    await app.page.locator('.topbar').waitFor();
    const recovered = await storedCanvas(app.page);
    assert.equal(recovered.title, 'Unsaved board');
    assert.ok(recovered.data.nodes.some((n) => n.text === 'Do not lose me'));
  });

  async function openCanvas(page, title) {
    await page.getByRole('button', { name: 'Atlas', exact: true }).click();
    await page.locator('.nav-link', { hasText: title }).click();
    await page.locator(`${BOARD}[data-canvas-id]`).waitFor();
  }

  const para = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
  const heading = (level, text) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });
  const docText = (doc) => JSON.stringify(doc);

  it('edits a page narrowed to one heading in place, and a scene', async () => {
    const page = await start('Edit World');
    const home = await rpc(page, 'pages.home');
    await rpc(page, 'pages.update', {
      id: home.id,
      patch: { content: { type: 'doc', content: [para('Opening words.'), heading(2, 'Past'), para('Long ago.'), heading(2, 'Now'), para('Today.')] } },
    });
    const [book] = await rpc(page, 'books.list');
    const chapter = await rpc(page, 'nodes.create', { bookId: book.id, kind: 'chapter', title: 'Chapter X' });
    const scene = await rpc(page, 'nodes.create', { bookId: book.id, parentId: chapter.id, kind: 'scene', title: 'The bridge' });
    await rpc(page, 'canvases.create', {
      title: 'Edit board',
      data: {
        nodes: [
          { id: 'p1', type: 'file', file: `lorecraft:page/${home.id}#Past`, x: 0, y: 0, width: 400, height: 300 },
          { id: 's1', type: 'file', file: `lorecraft:scene/${scene.id}`, x: 500, y: 0, width: 400, height: 300 },
        ],
        edges: [],
      },
    });
    await openCanvas(page, 'Edit board');
    const card = page.locator('[data-node-id="p1"]');
    await card.locator('.canvas-doc', { hasText: 'Long ago.' }).waitFor();
    // Double-click edits the section right on the card.
    await card.locator('.canvas-doc p', { hasText: 'Long ago.' }).dblclick();
    const editor = card.locator('.canvas-doc-editor .ProseMirror');
    await editor.waitFor();
    assert.equal(await editor.locator('h2').count(), 1, 'only the narrowed section is edited');
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' Before the war.');
    await page.keyboard.press('Escape');
    await card.locator('.canvas-doc-editor').waitFor({ state: 'detached' });
    await waitUntil(async () => docText((await rpc(page, 'pages.get', { id: home.id })).content).includes('Before the war.'), 5000, 'the page saved');
    const stored = (await rpc(page, 'pages.get', { id: home.id })).content;
    // The rest of the page is still there, in order.
    const text = docText(stored);
    assert.ok(text.indexOf('Opening words.') < text.indexOf('Before the war.'));
    assert.ok(text.indexOf('Before the war.') < text.indexOf('Today.'));

    // Enter on a focused scene card edits it too.
    const sceneCard = page.locator('[data-node-id="s1"]');
    await sceneCard.focus();
    await page.keyboard.press('Enter');
    await sceneCard.locator('.canvas-doc-editor .ProseMirror').waitFor();
    await page.keyboard.type('They cross at dawn.');
    await page.keyboard.press('Escape');
    await waitUntil(async () => docText((await rpc(page, 'nodes.get', { id: scene.id })).content).includes('They cross at dawn.'), 5000, 'the scene saved');
    assert.deepEqual(app.problems, []);
  });

  it('fits cards to their content and grows text cards while typing', async () => {
    const page = await start('Fit World');
    await rpc(page, 'canvases.create', {
      title: 'Fit board',
      data: { nodes: [{ id: 'tall', type: 'text', text: 'Short.', x: 0, y: 0, width: 260, height: 600 }], edges: [] },
    });
    await openCanvas(page, 'Fit board');
    const tall = await page.locator('[data-node-id="tall"]').boundingBox();
    await page.mouse.click(tall.x + 100, tall.y + 300, { button: 'right' });
    await page.getByRole('menuitem', { name: 'Fit to content' }).click();
    await waitStored(page, (d) => d.nodes[0].height < 150, 'the card fitted');

    const box = await boardBox(page);
    await page.mouse.dblclick(box.x + box.width - 300, box.y + 120);
    await page.getByLabel('Card text').fill(Array.from({ length: 14 }, (_, i) => `Line ${i}`).join('\n'));
    await page.keyboard.press('Escape');
    await waitStored(page, (d) => d.nodes.some((n) => n.text?.startsWith('Line 0') && n.height > 200), 'the text card grew');
  });

  it('copies, cuts and pastes cards and connections, between canvases too', async () => {
    const page = await start('Clip World');
    await rpc(page, 'canvases.create', {
      title: 'Source',
      data: {
        nodes: [
          { id: 'a', type: 'text', text: 'Alpha', x: 0, y: 0, width: 200, height: 80 },
          { id: 'b', type: 'text', text: 'Beta', x: 300, y: 0, width: 200, height: 80 },
        ],
        edges: [{ id: 'ab', fromNode: 'a', toNode: 'b', label: 'leads to' }],
      },
    });
    await rpc(page, 'canvases.create', { title: 'Target', data: { nodes: [], edges: [] } });
    await openCanvas(page, 'Source');
    await page.locator(BOARD).focus();
    await page.keyboard.press('Control+a');
    // Clipboard events with their own data, which keeps the real clipboard out of the test.
    const copy = (type) =>
      page.evaluate((type) => {
        const data = new DataTransfer();
        document.dispatchEvent(new ClipboardEvent(type, { clipboardData: data, bubbles: true, cancelable: true }));
        return data.getData('text/plain');
      }, type);
    const paste = (text) =>
      page.evaluate((text) => {
        const data = new DataTransfer();
        data.setData('text/plain', text);
        document.querySelector('.canvas-board').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      }, text);
    const copied = await copy('copy');
    const fragment = JSON.parse(copied);
    assert.equal(fragment.nodes.length, 2);
    assert.equal(fragment.edges.length, 1);
    await paste(copied);
    await waitStored(page, (d) => d.nodes.length === 4 && d.edges.length === 2, 'the pasted copy');
    const source = (await rpc(page, 'canvases.list')).find((c) => c.title === 'Source');
    const data = (await rpc(page, 'canvases.get', { id: source.id })).data;
    assert.equal(new Set(data.nodes.map((n) => n.id)).size, 4, 'pasted cards get new ids');
    const alphas = data.nodes.filter((n) => n.text === 'Alpha');
    assert.notEqual(alphas[0].x, alphas[1].x, 'the copy is offset');
    const pastedEdge = data.edges.find((e) => e.id !== 'ab');
    assert.ok(!['a', 'b'].includes(pastedEdge.fromNode) && !['a', 'b'].includes(pastedEdge.toNode), 'the copy is joined to the copies');

    // Cut takes the selection away, and it pastes into another canvas.
    await page.locator(BOARD).focus();
    await page.keyboard.press('Control+a');
    const cut = await copy('cut');
    await waitStored(page, (d) => d.nodes.length === 0, 'the cut');
    await openCanvas(page, 'Target');
    await page.locator(BOARD).focus();
    await paste(cut);
    const target = (await rpc(page, 'canvases.list')).find((c) => c.title === 'Target');
    await waitUntil(async () => (await rpc(page, 'canvases.get', { id: target.id })).data.nodes.length === 4, 5000, 'pasted into the other canvas');
    assert.equal((await rpc(page, 'canvases.get', { id: target.id })).data.edges.length, 2);
    assert.deepEqual(app.problems, []);
  });

  it('takes pages and canvases dragged from the sidebars, and adds a picked scene', async () => {
    const page = await start('Drag World');
    const home = await rpc(page, 'pages.home');
    const [book] = await rpc(page, 'books.list');
    const chapter = await rpc(page, 'nodes.create', { bookId: book.id, kind: 'chapter', title: 'Chapter Seven' });
    const scene = await rpc(page, 'nodes.create', { bookId: book.id, parentId: chapter.id, kind: 'scene', title: 'The lighthouse' });
    await rpc(page, 'canvases.create', { title: 'Other board', data: { nodes: [], edges: [] } });
    await rpc(page, 'canvases.create', { title: 'Drop board', data: { nodes: [], edges: [] } });
    const drop = await (await rpc(page, 'canvases.list')).find((c) => c.title === 'Drop board');
    const stored = async () => (await rpc(page, 'canvases.get', { id: drop.id })).data;

    // A native drag: the sidebar's own dragstart fills the data, and the board takes the drop.
    const startDrag = (locator) =>
      locator.evaluate((el) => {
        window.__canvasDrag = new DataTransfer();
        el.dispatchEvent(new DragEvent('dragstart', { dataTransfer: window.__canvasDrag, bubbles: true, cancelable: true }));
        return window.__canvasDrag.types.includes('application/x-lorecraft-ref') && el.draggable;
      });
    const dropOnBoard = () =>
      page.evaluate(() => {
        const board = document.querySelector('.canvas-board');
        const r = board.getBoundingClientRect();
        const init = { dataTransfer: window.__canvasDrag, clientX: r.left + 200, clientY: r.top + 200, bubbles: true, cancelable: true };
        board.dispatchEvent(new DragEvent('dragover', init));
        board.dispatchEvent(new DragEvent('drop', init));
      });

    await openCanvas(page, 'Drop board');
    assert.ok(await startDrag(page.locator('.nav-link', { hasText: 'Other board' })), 'the Atlas canvas link is draggable');
    await dropOnBoard();
    await waitUntil(async () => (await stored()).nodes.some((n) => n.file?.startsWith('lorecraft:canvas/')), 5000, 'the canvas card');

    await page.getByRole('button', { name: 'Wiki', exact: true }).click();
    assert.ok(await startDrag(page.locator('.nav-link', { hasText: 'Main page' })), 'the wiki page link is draggable');
    await openCanvas(page, 'Drop board');
    await dropOnBoard();
    await waitUntil(async () => (await stored()).nodes.some((n) => n.file === `lorecraft:page/${home.id}`), 5000, 'the page card');

    // "Add scene…" lists scenes with their book and chapter.
    const box = await boardBox(page);
    await page.mouse.click(box.x + box.width - 200, box.y + box.height - 120, { button: 'right' });
    await page.getByRole('menuitem', { name: 'Add scene…' }).click();
    await page.getByRole('combobox', { name: 'Search scenes' }).fill('lighthouse');
    const option = page.getByRole('option', { name: /Chapter Seven.*The lighthouse/ });
    await option.waitFor();
    await page.keyboard.press('Enter');
    await waitUntil(async () => (await stored()).nodes.some((n) => n.file === `lorecraft:scene/${scene.id}`), 5000, 'the scene card');
    assert.deepEqual(app.problems, []);
  });
});
