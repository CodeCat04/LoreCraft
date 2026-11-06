// Records the README trailer: drives the real app through the sample world and saves
// screenshots as frames, with a manifest that scripts/make-apng.mjs turns into an APNG.
//
//   node e2e/trailer.mjs            (or `npm run trailer`, which also assembles it)
//
// Build first with `npm run app:debug`. The AI step uses the stand-in server from
// scripts/mock-ai-server.mjs, so no real model is needed.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startMockServer } from '../scripts/mock-ai-server.mjs';
import { ARTIFACTS, createWorkspace, launch, rpc, waitUntil } from './harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ARTIFACTS, 'trailer');
const ONLY = process.argv[2] ? Number(process.argv[2]) : null;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const frames = [];
let scene = 0;
let page;

/** Saves what is on screen, to be shown for `ms`. */
async function shot(ms) {
  const file = `f${String(frames.length).padStart(4, '0')}.png`;
  await page.screenshot({ path: join(OUT, file) });
  frames.push({ file, ms, scene });
}

const pause = (ms) => page.waitForTimeout(ms);

/** A small caption banner drawn in the page, in the theme's own colors. */
async function caption(text, { top = false } = {}) {
  await page.evaluate(([text, top]) => {
    let el = document.getElementById('trailer-caption');
    if (!el) {
      el = document.createElement('div');
      el.id = 'trailer-caption';
      el.setAttribute('aria-hidden', 'true');
      Object.assign(el.style, {
        position: 'fixed', left: '50%', bottom: '28px', transform: 'translateX(-50%)', zIndex: '2147483647',
        padding: '10px 22px', borderRadius: '10px', pointerEvents: 'none',
        background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border-strong)',
        borderLeft: '5px solid var(--accent)', boxShadow: '0 6px 24px var(--shadow)',
        font: '600 22px/1.3 var(--font-ui, var(--font-body, sans-serif))', whiteSpace: 'nowrap',
      });
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.top = top ? '70px' : '';
    el.style.bottom = top ? '' : '28px';
    el.style.display = text ? 'block' : 'none';
  }, [text, top]);
}

function newScene() {
  scene += 1;
}

/** Moves the mouse onto an element, with a few steps so the hover reads as motion. */
async function hoverOn(locator) {
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
}

/** Types text a few characters per frame. */
async function typeFilmed(locator, text, per = 3, ms = 90) {
  for (let i = 0; i < text.length; i += per) {
    await locator.pressSequentially(text.slice(i, i + per));
    await shot(ms);
  }
}

/** Selects a phrase in an editor, the way dragging across it would. */
async function selectText(phrase, scope) {
  const at = await page.evaluate(
    ([needle, selector]) => {
      const root = document.querySelector(selector);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const i = node.data.indexOf(needle);
        if (i < 0) continue;
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + needle.length);
        range.startContainer.parentElement.scrollIntoView({ block: 'center' });
        const rects = range.getClientRects();
        const first = rects[0];
        const last = rects[rects.length - 1];
        return { x1: first.left + 1, y1: first.top + first.height / 2, x2: last.right - 1, y2: last.top + last.height / 2 };
      }
      return null;
    },
    [phrase, scope],
  );
  if (!at) throw new Error(`Could not find "${phrase}"`);
  await page.mouse.move(at.x1, at.y1);
  await page.mouse.down();
  for (let s = 1; s <= 4; s += 1) {
    await page.mouse.move(at.x1 + ((at.x2 - at.x1) * s) / 4, at.y1 + ((at.y2 - at.y1) * s) / 4, { steps: 3 });
    await shot(80);
  }
  await page.mouse.up();
}

const area = (name) => page.getByRole('button', { name, exact: true }).click();

const mock = await startMockServer();
const workspace = createWorkspace();
const app = await launch(workspace);
page = app.page;

try {
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'encyclopedia';
    document.documentElement.dataset.mode = 'dark';
  });
  // The AI talks to the stand-in, so the trailer does not depend on a real model.
  const profile = { id: 'local', name: 'Local model', kind: 'openai-compatible', baseUrl: `${mock.url}/v1`, model: 'mock-local', isCloud: false };
  await rpc(page, 'settings.update', {
    patch: {
      appearance: { theme: 'encyclopedia', mode: 'dark' },
      ai: { cloudWarningDismissed: true, profiles: [profile], routing: { chat: 'local', rewrite: 'local', extract: 'local', consistency: 'local' } },
    },
  });
  await page.reload();
  await page.getByRole('button', { name: 'Open sample world' }).waitFor();
  await pause(600);

  // 1. The start screen, then the main page.
  await shot(1600);
  await hoverOn(page.getByRole('button', { name: 'Open sample world' }));
  await shot(500);
  await page.getByRole('button', { name: 'Open sample world' }).click();
  await page.getByText(/Opened the sample world/).waitFor({ timeout: 60_000 });
  await page.getByRole('heading', { name: 'The Saltmarch' }).waitFor();
  await page.locator('.toast').getByRole('button').last().click().catch(() => {});
  await page.mouse.move(5, 300);
  await pause(800);
  newScene();
  await caption('A wiki for your world');
  await shot(2600);

  if (ONLY === 1) throw new Error('stop');

  // 2. A character page with its infobox, and a link's hover card.
  newScene();
  await page.getByRole('link', { name: 'Wren Halloway' }).first().click();
  await page.getByRole('heading', { name: 'Wren Halloway' }).waitFor();
  await caption('Every character, place and thing has a page');
  await pause(600);
  await shot(1800);
  const link = page.locator('.prose a[data-wiki-target]').first();
  await hoverOn(link);
  await page.locator('.wiki-hovercard').waitFor({ state: 'visible' });
  await pause(500);
  await caption('Hover a link to see its card');
  await shot(2200);
  await page.mouse.move(5, 300);

  if (ONLY === 2) throw new Error('stop');

  // 3. A page from a red link, and its infobox.
  newScene();
  await page.locator('.nav-link', { hasText: 'Main page' }).first().click();
  await page.getByRole('heading', { name: 'The Saltmarch' }).waitFor();
  const red = page.locator('.prose a[data-wiki-target="The Tithe Barges"]').first();
  await red.scrollIntoViewIfNeeded();
  await caption('Build lore fast');
  await hoverOn(red);
  await pause(400);
  await shot(1400);
  await red.click();
  await page.locator('.toast').getByRole('button').last().click().catch(() => {});
  await pause(700);
  await shot(900);
  // The cursor is already in the body.
  await typeFilmed(page.locator('.ProseMirror[contenteditable="true"]').first(), 'Flat barges that carry the Lamp Tithe in oil casks across the marsh.', 6, 70);
  await shot(600);
  const add = page.getByRole('combobox', { name: 'Add a field' });
  const options = await add.locator('option').evaluateAll((list) => list.map((o) => ({ value: o.value, label: o.textContent })));
  const pick = (labels) => options.find((o) => labels.includes(o.label)) ?? options.find((o) => o.value && o.value !== options.at(-1).value);
  const fields = [
    [pick(['Owner', 'Owned by', 'Affiliation']), 'The Lamplighters Guild'],
    [pick(['Location', 'Region', 'Home']), 'Cray Landing'],
  ];
  for (const [option, value] of fields) {
    if (!option) continue;
    await add.selectOption(option.value);
    await pause(300);
    await shot(400);
    await page.keyboard.type(value, { delay: 15 });
    await shot(500);
    await page.keyboard.press('Tab');
  }
  await pause(500);
  await shot(1600);
  if (ONLY === 3) throw new Error('stop');

  // 4. The writing view, with names recognized.
  newScene();
  await area('Write');
  await page.getByRole('treeitem', { name: /^Eleven Dark Posts,/ }).click();
  const manuscript = page.locator('.prose-manuscript');
  await manuscript.getByText(/lamps along the causeway/).waitFor();
  await page.mouse.move(5, 400);
  await caption('Write your book beside it');
  await pause(700);
  await shot(1800);
  const mention = manuscript.locator('.name-mention').first();
  await hoverOn(mention);
  await page.locator('.wiki-hovercard').waitFor({ state: 'visible' });
  await pause(400);
  await caption('Names link to your wiki as you write');
  await shot(2200);
  await page.mouse.move(5, 400);
  if (ONLY === 4) throw new Error('stop');

  // 5. Ask AI on a selection, and accept its tracked suggestion.
  newScene();
  await caption('AI that suggests, never overwrites', { top: true });
  const sentence = await manuscript.evaluate((root) => {
    const p = [...root.querySelectorAll('p')].find((el) => el.textContent.includes('lamps along the causeway'));
    return p.textContent.split(/(?<=[.!?])\s+/).find((s) => s.includes('lamps along the causeway'));
  });
  await selectText(sentence, '.prose-manuscript');
  await page.getByRole('button', { name: 'Ask AI' }).click();
  const box = page.getByRole('textbox', { name: 'What should change?' });
  await box.waitFor();
  const ask = 'Make the lamps feel weaker';
  for (let i = 4; i <= ask.length; i += 4) {
    await box.fill(ask.slice(0, i));
    await shot(70);
  }
  await box.fill(ask);
  await shot(900);
  // The stand-in reads this marker to know what to change.
  await box.fill(`${ask} [rewrite:lamps|last guttering lamps]`);
  await box.press('Enter');
  await page.getByRole('region', { name: 'Suggested changes' }).waitFor({ timeout: 30_000 });
  await page.locator('.ai-ins').first().waitFor();
  // The review bar quotes the request; show it as the person typed it, without the marker.
  // It may be shortened there, so this takes off whatever part of the marker shows.
  await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.data.includes('[rewrite:')) node.data = node.data.replace(/\s*\[rewrite:[^\]”"]*\]?/g, '');
    }
  });
  await page.mouse.move(5, 400);
  await pause(500);
  await shot(2600);
  await page.getByRole('button', { name: 'Accept all' }).click();
  await page.getByRole('region', { name: 'Suggested changes' }).waitFor({ state: 'detached' });
  await pause(500);
  await shot(1600);
  if (ONLY === 5) throw new Error('stop');

  // 6. Consistency checks find the planted mistakes.
  newScene();
  await area('Consistency');
  await page.getByRole('heading', { name: 'Consistency', level: 1 }).waitFor();
  await caption('Catch contradictions');
  const run = page.getByRole('button', { name: 'Run rule checks' });
  if (await run.count()) {
    await hoverOn(run.first());
    await shot(700);
    await run.first().click();
  }
  await page.getByTestId('findings').getByRole('article').first().waitFor({ timeout: 30_000 });
  await page.getByTestId('findings').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.mouse.move(5, 400);
  await pause(800);
  await shot(3200);
  if (ONLY === 6) throw new Error('stop');

  // 7. Atlas: the relationship graph, the family tree and the timeline.
  newScene();
  await area('Atlas');
  await caption('See how it all connects');
  await page.getByRole('button', { name: 'Relationship graph' }).click();
  await pause(1800);
  await shot(2400);
  await page.getByRole('button', { name: 'Family tree' }).click();
  await page.locator('.family-card').first().waitFor();
  await pause(800);
  await shot(2200);
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await page.getByText('The Long Flood').first().waitFor();
  await caption('A timeline from the dates on your pages');
  await pause(800);
  await shot(2400);
  if (ONLY === 7) throw new Error('stop');

  // 8. A canvas: cards, a connection, a group, and zoom.
  newScene();
  await page.getByRole('button', { name: 'New canvas', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('The missing oil');
  await dialog.getByLabel('Name').press('Enter');
  const board = page.locator('.canvas-board');
  await board.waitFor();
  await caption('Brainstorm on an infinite canvas');
  await shot(900);
  const b = await board.boundingBox();
  // A picture, dropped in as a file would be: a little map drawn in the page.
  await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 360;
    c.height = 240;
    const g = c.getContext('2d');
    g.fillStyle = '#20415e';
    g.fillRect(0, 0, 360, 240);
    g.fillStyle = '#b29e84';
    g.beginPath();
    g.ellipse(130, 120, 95, 70, 0.4, 0, Math.PI * 2);
    g.ellipse(270, 90, 60, 40, -0.3, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#f2d16b';
    g.lineWidth = 4;
    g.setLineDash([10, 8]);
    g.beginPath();
    g.moveTo(60, 200);
    g.bezierCurveTo(140, 140, 200, 150, 290, 80);
    g.stroke();
    const png = await new Promise((r) => c.toBlob(r, 'image/png'));
    const data = new DataTransfer();
    data.items.add(new File([png], 'causeway-map.png', { type: 'image/png' }));
    const el = document.querySelector('.canvas-board');
    const rect = el.getBoundingClientRect();
    const init = { dataTransfer: data, bubbles: true, cancelable: true, clientX: rect.left + rect.width * 0.62, clientY: rect.top + rect.height * 0.5 };
    el.dispatchEvent(new DragEvent('dragover', init));
    el.dispatchEvent(new DragEvent('drop', init));
  });
  await page.locator('img.canvas-media').waitFor();
  await pause(600);
  await shot(900);
  // A text card, typed in place.
  await page.mouse.dblclick(b.x + b.width * 0.15, b.y + b.height * 0.25);
  const cardText = page.getByLabel('Card text');
  await cardText.waitFor();
  await typeFilmed(cardText, '# Who took the oil?\nThe casks were light at Cray Landing.', 8, 70);
  await page.keyboard.press('Escape');
  await shot(700);
  // A wiki page as a card, as dragging it from a list would drop it.
  const pageCard = await rpc(page, 'pages.getByTitle', { title: 'Wren Halloway' });
  await page.evaluate((id) => {
    const data = new DataTransfer();
    data.setData('text/plain', '');
    data.setData('application/x-lorecraft-ref', `lorecraft:page/${id}`);
    const el = document.querySelector('.canvas-board');
    const rect = el.getBoundingClientRect();
    const init = { dataTransfer: data, bubbles: true, cancelable: true, clientX: rect.left + rect.width * 0.15, clientY: rect.top + rect.height * 0.6 };
    el.dispatchEvent(new DragEvent('dragover', init));
    el.dispatchEvent(new DragEvent('drop', init));
  }, pageCard.id);
  await pause(1200);
  await shot(900);
  // Connect the text card to the picture.
  const cards = page.locator('.canvas-card');
  const first = cards.filter({ hasText: 'Who took the oil' }).first();
  const pic = page.locator('.canvas-card', { has: page.locator('img.canvas-media') }).first();
  await first.hover();
  const handle = await first.locator('.canvas-handle-right').boundingBox();
  const target = await pic.boundingBox();
  await page.mouse.move(handle.x + 6, handle.y + 6);
  await page.mouse.down();
  for (let s = 1; s <= 5; s += 1) {
    await page.mouse.move(handle.x + 6 + ((target.x + 60 - handle.x) * s) / 5, handle.y + 6 + ((target.y + 60 - handle.y) * s) / 5, { steps: 3 });
    await shot(80);
  }
  await page.mouse.up();
  await pause(400);
  await shot(800);
  // Group them all.
  await board.focus();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+g');
  await page.getByLabel('Group name').fill('Act one: the oil');
  await page.keyboard.press('Enter');
  await page.mouse.click(b.x + b.width - 30, b.y + b.height - 80);
  await pause(500);
  await shot(1200);
  // Zoom toward the cursor.
  await page.mouse.move(b.x + b.width * 0.4, b.y + b.height * 0.45);
  for (let s = 0; s < 6; s += 1) {
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -120);
    await page.keyboard.up('Control');
    await pause(120);
    await shot(140);
  }
  await shot(900);
  await page.getByRole('button', { name: 'Fit all' }).click();
  await pause(500);
  await shot(1400);
  if (ONLY === 8) throw new Error('stop');

  // 9. Themes: Lorekeeper for a moment, then back.
  newScene();
  await area('Wiki');
  await page.locator('.nav-link', { hasText: 'Main page' }).first().click();
  await page.getByRole('heading', { name: 'The Saltmarch' }).waitFor();
  await caption('Themes');
  const theme = (t, m) =>
    page.evaluate(([t, m]) => {
      document.documentElement.dataset.theme = t;
      document.documentElement.dataset.mode = m;
    }, [t, m]);
  await theme('lorekeeper', 'dark');
  await pause(500);
  await caption('Themes, like Lorekeeper');
  await shot(2400);
  await theme('encyclopedia', 'light');
  await caption('Themes, light or dark');
  await pause(300);
  await shot(1500);
  await theme('encyclopedia', 'dark');
  await pause(300);
  await shot(900);

  // 10. The end card.
  newScene();
  await caption('');
  const icon = readFileSync(join(ROOT, 'docs', 'brand', 'lorecraft-icon.png')).toString('base64');
  await page.evaluate((icon) => {
    const card = document.createElement('div');
    Object.assign(card.style, {
      position: 'fixed', inset: '0', zIndex: '2147483647', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: '18px', background: 'var(--bg)', color: 'var(--text)',
      fontFamily: 'var(--font-ui, var(--font-body, sans-serif))', textAlign: 'center',
    });
    card.innerHTML = `
      <img src="data:image/png;base64,${icon}" width="220" height="220" alt="" style="border-radius:36px;box-shadow:0 10px 40px var(--shadow)">
      <div style="font:600 84px/1.1 var(--font-heading, serif);margin-top:14px">LoreCraft</div>
      <div style="font-style:italic;font-size:30px;color:var(--text-muted)">“You will own everything, and you will be happy.”</div>
      <div style="font-size:24px;color:var(--accent);margin-top:18px">Free and open source · AGPL-3.0</div>`;
    document.body.appendChild(card);
  }, icon);
  await pause(800);
  await shot(4200);
  console.log(`${frames.length} frames in ${scene + 1} scenes`);
} finally {
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ poster: Math.max(0, frames.findIndex((f) => f.scene === 1)), frames }, null, 1));
  await app.kill().catch(() => {});
  workspace.cleanup();
  await mock.close();
}
