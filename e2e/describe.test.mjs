/**
 * "Describe with AI" for a picture, in the figure popover and the media library, against the
 * mock AI server. The answer is a suggestion: the description changes only when the writer
 * chooses "Use this". Pictures on local-only pages go only to local profiles.
 *
 * The last test uses the local server at 127.0.0.1:8080, and skips if it is not running or
 * cannot read images.
 */

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ANTHROPIC_KEY, startMockServer } from '../scripts/mock-ai-server.mjs';
import { addAsset, createProject, createWorkspace, launch, rpc, waitUntil } from './harness.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** A 64 by 64 picture, red on the left and blue on the right. */
function redBluePng() {
  const chunk = (type, data) => {
    const name = Buffer.from(type, 'latin1');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc32(Buffer.concat([name, data])) >>> 0);
    return Buffer.concat([length, name, data, check]);
  };
  const size = 64;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 3 + 1);
    for (let x = 0; x < size; x += 1) {
      const [r, g, b] = x < size / 2 ? [220, 20, 20] : [20, 40, 220];
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const text = (value) => ({ type: 'text', text: value });
const paragraph = (value) => ({ type: 'paragraph', content: [text(value)] });

function pictureFigure(assetId, caption, description = '') {
  return {
    type: 'figure',
    attrs: { kind: 'picture', align: 'right', width: 40, description },
    content: [{ type: 'image', attrs: { assetId, alt: '' } }, { type: 'figcaption', content: caption ? [text(caption)] : [] }],
  };
}

function videoFigure(assetId) {
  return {
    type: 'figure',
    attrs: { kind: 'video', align: 'right', width: 40, description: '' },
    content: [{ type: 'video', attrs: { assetId } }, { type: 'figcaption', content: [text('The tide film')] }],
  };
}

describe('Describe with AI', () => {
  let workspace;
  let app;
  let mock;
  let problems;

  const localProfile = (extra = {}) => ({
    id: 'local', name: 'Local model', kind: 'openai-compatible', baseUrl: `${mock.url}/v1`, model: 'mock-local', isCloud: false, ...extra,
  });
  const cloudProfile = () => ({
    id: 'claude', name: 'Claude', kind: 'anthropic', baseUrl: mock.url, model: 'claude-opus-5-5', isCloud: true,
    inputCostPerMTok: 4, outputCostPerMTok: 20, effort: 'high',
  });

  const sent = async (path) => {
    const list = await (await fetch(`${mock.url}/__mock/requests`)).json();
    return list.filter((r) => r.path === path);
  };

  /** A project with these profiles, chat going to the first, and the home page holding `content`. */
  async function start(profiles, { content = [], key, consent = true } = {}) {
    app = await launch(workspace);
    const { page } = app;
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await createProject(page, 'Picture World');
    if (key) await rpc(page, 'ai.setKey', { profileId: 'claude', key });
    const routing = { chat: profiles[0].id, rewrite: profiles[0].id, extract: profiles[0].id, consistency: profiles[0].id };
    await rpc(page, 'settings.update', { patch: { ai: { profiles, routing, cloudWarningDismissed: consent } } });
    const asset = await addAsset(page, { name: 'banners.png', mime: 'image/png', base64: redBluePng().toString('base64'), width: 64, height: 64 });
    const home = await rpc(page, 'pages.home');
    const doc = { type: 'doc', content: [paragraph('Two banners hang over the gate.'), ...content.map((make) => make(asset.id))] };
    await rpc(page, 'pages.update', { id: home.id, patch: { content: doc } });
    // Settings load at startup, so a reload makes them current.
    await page.reload();
    await page.locator('.prose').first().waitFor();
    return { page, asset, home };
  }

  async function editHome(page) {
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.locator('.ProseMirror[contenteditable="true"] .figure').first().waitFor();
  }

  async function openPopover(page, index = 0) {
    const figure = page.locator('.prose .figure[data-kind]').nth(index);
    await figure.hover();
    await figure.getByRole('button', { name: 'More detail for the AI', exact: true }).click();
    const popover = page.locator('.figure-describe');
    await popover.waitFor();
    return popover;
  }

  const storedDescription = async (page) => {
    const doc = (await rpc(page, 'pages.home')).content;
    return doc.content.find((node) => node.type === 'figure')?.attrs.description;
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

  it('suggests a description that the writer can edit and use, and nothing changes until then', async () => {
    const answer = 'A red banner hangs beside a blue one.';
    const { page } = await start([localProfile({ supportsImages: true })], {
      content: [(id) => pictureFigure(id, `[mock:wait=${answer}]`, 'Painted by Aria')],
    });
    await editHome(page);
    const popover = await openPopover(page);
    const own = popover.getByRole('textbox', { name: 'More detail for the AI (optional)' });
    assert.equal(await own.inputValue(), 'Painted by Aria');

    await popover.getByRole('button', { name: 'Describe with AI' }).click();
    // Progress shows while the model works, with a way to stop it.
    await popover.getByRole('status').filter({ hasText: 'Looking at the picture…' }).waitFor();
    assert.equal(await popover.getByRole('button', { name: 'Describe with AI' }).getAttribute('aria-disabled'), 'true');
    await popover.getByRole('button', { name: 'Stop' }).waitFor();
    await app.screenshot('describe-working');

    const suggestion = popover.getByRole('textbox', { name: 'Suggested description' });
    await popover.getByRole('button', { name: 'Use this' }).waitFor({ timeout: 15_000 });
    assert.equal(await suggestion.inputValue(), answer);
    assert.equal(await own.inputValue(), 'Painted by Aria', 'the writer’s words are still there');
    assert.equal(await storedDescription(page), 'Painted by Aria', 'and nothing was stored');
    await app.screenshot('describe-suggestion');

    // What was sent: the picture, and what the writer has said about it.
    const [request] = await sent('/v1/chat/completions');
    const parts = request.body.messages[0].content;
    assert.ok(parts.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png;base64,')), 'the picture was sent');
    assert.match(parts.find((p) => p.type === 'text').text, /Painted by Aria/);

    // Discarding leaves everything as it was.
    await popover.getByRole('button', { name: 'Discard' }).click();
    await popover.getByRole('button', { name: 'Use this' }).waitFor({ state: 'detached' });
    assert.equal(await own.inputValue(), 'Painted by Aria');

    // The writer edits the suggestion, then uses it.
    await popover.getByRole('button', { name: 'Describe with AI' }).click();
    await popover.getByRole('button', { name: 'Use this' }).waitFor({ timeout: 15_000 });
    const edited = 'A red banner beside a blue one, painted by Aria.';
    await suggestion.fill(edited);
    // Ctrl+Enter in the suggestion uses it, and leaves the popover open.
    await suggestion.press('Control+Enter');
    await popover.getByRole('button', { name: 'Use this' }).waitFor({ state: 'hidden' });
    assert.equal(await own.inputValue(), edited);
    assert.equal(await popover.isVisible(), true);
    await waitUntil(async () => (await storedDescription(page)) === edited, 8000, 'the description to be stored');
    await page.keyboard.press('Escape');
    await popover.waitFor({ state: 'detached' });
    const figure = page.locator('.prose .figure[data-kind]').first();
    assert.equal(await figure.locator('.media-frame img').getAttribute('alt'), edited, 'it is the alt text');

    // One undo takes it back.
    await page.locator('.ProseMirror[contenteditable="true"] p').first().click();
    await page.keyboard.press('Control+z');
    await waitUntil(async () => (await figure.getAttribute('data-description')) === 'Painted by Aria', 5000, 'the undo');
    assert.deepEqual(problems, []);
  });

  it('can be stopped, and is not offered for a video', async () => {
    const video = readFileSync(join(FIXTURES, 'tiny-vp8.webm')).toString('base64');
    const { page } = await start([localProfile({ supportsImages: true })], {
      content: [(id) => pictureFigure(id, '[mock:hang] The gate')],
    });
    const clip = await addAsset(page, { name: 'tide.webm', mime: 'video/webm', base64: video, width: 64, height: 64 });
    const doc = (await rpc(page, 'pages.home')).content;
    doc.content.push(videoFigure(clip.id));
    await rpc(page, 'pages.update', { id: (await rpc(page, 'pages.home')).id, patch: { content: doc } });
    await page.reload();
    await page.locator('.prose').first().waitFor();
    await editHome(page);

    const popover = await openPopover(page);
    await popover.getByRole('button', { name: 'Describe with AI' }).click();
    await popover.getByRole('button', { name: 'Stop' }).click();
    await popover.getByRole('button', { name: 'Stop' }).waitFor({ state: 'hidden' });
    await waitUntil(
      async () => (await popover.getByRole('button', { name: 'Describe with AI' }).getAttribute('aria-disabled')) === 'false',
      5000,
      'the button to come back',
    );
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Describe with AI', 'the focus stays in the popover');
    assert.equal(await popover.getByRole('textbox', { name: 'Suggested description' }).isVisible(), false);
    assert.equal(await popover.getByRole('textbox', { name: 'More detail for the AI (optional)' }).inputValue(), '');
    await page.keyboard.press('Escape');
    await popover.waitFor({ state: 'detached' });

    const videoPopover = await openPopover(page, 1);
    await videoPopover.getByRole('textbox', { name: 'More detail for the AI (optional)' }).waitFor();
    assert.equal(await videoPopover.getByRole('button', { name: 'Describe with AI' }).count(), 0, 'pictures only');
    await page.keyboard.press('Escape');
  });

  it('says plainly when no profile can read images, and how to fix it', async () => {
    // The mock server has no /props, so a local profile on automatic does not read images.
    const { page } = await start([localProfile()], { content: [(id) => pictureFigure(id, 'The gate')] });
    await editHome(page);
    const popover = await openPopover(page);
    await popover.getByRole('button', { name: 'Describe with AI' }).click();
    const alert = popover.getByRole('alert');
    await alert.filter({ hasText: 'cannot read images' }).waitFor();
    assert.match(await alert.innerText(), /Settings > AI/);
    assert.equal((await sent('/v1/chat/completions')).length, 0, 'nothing was sent');
    await app.screenshot('describe-no-images');
    await popover.getByRole('button', { name: 'AI settings' }).click();
    await page.getByTestId('ai-settings').waitFor();
  });

  it('sends a picture on a local-only page only to a local profile', async () => {
    const { page, home } = await start([cloudProfile(), localProfile()], {
      key: ANTHROPIC_KEY,
      content: [(id) => pictureFigure(id, '[mock:say=A red and blue picture.]')],
    });
    await rpc(page, 'pages.update', { id: home.id, patch: { localOnly: true } });
    await editHome(page);
    let popover = await openPopover(page);
    await popover.getByRole('button', { name: 'Describe with AI' }).click();
    const alert = popover.getByRole('alert');
    await alert.filter({ hasText: 'local only' }).waitFor();
    assert.match(await alert.innerText(), /Settings > AI/);
    assert.equal((await sent('/v1/messages')).length, 0, 'nothing went to the cloud');
    assert.equal((await sent('/v1/chat/completions')).length, 0);
    await page.keyboard.press('Escape');
    await popover.waitFor({ state: 'detached' });

    // The library knows no page, so it goes by every place the picture is used.
    await page.getByRole('menuitem', { name: 'Tools' }).click();
    await page.getByRole('menuitem', { name: 'Media library' }).click();
    await page.locator('.media-tile').first().click();
    const detail = page.locator('.media-detail');
    await detail.getByRole('button', { name: 'Describe with AI' }).click();
    await detail.getByRole('alert').filter({ hasText: 'local only' }).waitFor();
    assert.equal((await sent('/v1/messages')).length, 0, 'nothing went to the cloud from the library either');

    // With a local profile that reads images, that one is used.
    await rpc(page, 'settings.update', { patch: { ai: { profiles: [cloudProfile(), localProfile({ supportsImages: true })] } } });
    await page.reload();
    await page.getByRole('menuitem', { name: 'View' }).click();
    await page.getByRole('menuitem', { name: 'Main page' }).click();
    await page.locator('.prose').first().waitFor();
    await editHome(page);
    popover = await openPopover(page);
    await popover.getByRole('button', { name: 'Describe with AI' }).click();
    await popover.getByRole('button', { name: 'Use this' }).waitFor({ timeout: 15_000 });
    assert.equal(await popover.getByRole('textbox', { name: 'Suggested description' }).inputValue(), 'A red and blue picture.');
    assert.equal((await sent('/v1/messages')).length, 0, 'still nothing went to the cloud');
    assert.equal((await sent('/v1/chat/completions')).length, 1);
  });

  it('asks before sending to a cloud profile, and keeps the popover open while it asks', async () => {
    const { page } = await start([cloudProfile(), localProfile()], {
      key: ANTHROPIC_KEY,
      consent: false,
      content: [(id) => pictureFigure(id, '[mock:say=Two banners, one red and one blue.]')],
    });
    await editHome(page);
    const popover = await openPopover(page);
    await popover.getByRole('button', { name: 'Describe with AI' }).click();
    let dialog = page.getByRole('alertdialog');
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /Send this to Anthropic\?/);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await popover.getByRole('alert').filter({ hasText: 'Nothing was sent to Anthropic.' }).waitFor();
    assert.equal((await sent('/v1/messages')).length, 0);

    await popover.getByRole('button', { name: 'Describe with AI' }).click();
    dialog = page.getByRole('alertdialog');
    await dialog.getByRole('button', { name: 'Send', exact: true }).click();
    await popover.getByRole('button', { name: 'Use this' }).waitFor({ timeout: 15_000 });
    assert.equal(await popover.getByRole('textbox', { name: 'Suggested description' }).inputValue(), 'Two banners, one red and one blue.');
    const [request] = await sent('/v1/messages');
    assert.ok(request.body.messages[0].content.some((block) => block.type === 'image'));
    assert.equal(await storedDescription(page), '', 'nothing is stored until it is used');
  });

  it('stops at the monthly cloud limit unless the writer allows more', async () => {
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const { page } = await start([cloudProfile(), localProfile()], {
      key: ANTHROPIC_KEY,
      content: [(id) => pictureFigure(id, '[mock:say=Two banners.]')],
    });
    await rpc(page, 'settings.update', { patch: { ai: { spending: { limitUsd: 1, month, spentUsd: 5, warnedMonth: month, overrideMonth: '' } } } });
    await page.reload();
    await page.locator('.prose').first().waitFor();
    await editHome(page);
    const popover = await openPopover(page);
    await popover.getByRole('button', { name: 'Describe with AI' }).click();
    let dialog = page.getByRole('alertdialog');
    await dialog.getByText('Cloud spending limit reached').waitFor();
    await dialog.getByRole('button', { name: 'Stop', exact: true }).click();
    await popover.getByRole('alert').filter({ hasText: 'nothing was sent' }).waitFor();
    assert.equal((await sent('/v1/messages')).length, 0, 'nothing was sent past the limit');

    await popover.getByRole('button', { name: 'Describe with AI' }).click();
    dialog = page.getByRole('alertdialog');
    await dialog.getByRole('button', { name: 'Allow for the rest of this month' }).click();
    await popover.getByRole('button', { name: 'Use this' }).waitFor({ timeout: 15_000 });
    assert.equal(await popover.getByRole('textbox', { name: 'Suggested description' }).inputValue(), 'Two banners.');
    assert.equal((await sent('/v1/messages')).length, 1);
  });

  it('works in the media library too, for pictures only', async () => {
    const video = readFileSync(join(FIXTURES, 'tiny-vp8.webm')).toString('base64');
    const { page } = await start([localProfile({ supportsImages: true })], {
      content: [(id) => pictureFigure(id, '[mock:say=A red banner and a blue banner.]')],
    });
    await addAsset(page, { name: 'tide.webm', mime: 'video/webm', base64: video, width: 64, height: 64 });
    await page.getByRole('menuitem', { name: 'Tools' }).click();
    await page.getByRole('menuitem', { name: 'Media library' }).click();
    await page.getByTestId('media-count').filter({ hasText: /of/ }).waitFor();
    const tiles = page.locator('.media-tile');
    await waitUntil(async () => (await tiles.count()) === 2, 8000, 'the tiles');

    await tiles.filter({ hasText: 'tide.webm' }).click();
    let detail = page.locator('.media-detail');
    await detail.getByRole('textbox', { name: 'More detail for the AI (optional)' }).waitFor();
    assert.equal(await detail.getByRole('button', { name: 'Describe with AI' }).count(), 0, 'not for a video');

    await tiles.filter({ hasText: 'mock:say' }).click();
    detail = page.locator('.media-detail');
    await detail.getByRole('button', { name: 'Describe with AI' }).click();
    await detail.getByRole('button', { name: 'Use this' }).waitFor({ timeout: 15_000 });
    assert.equal(await detail.getByRole('textbox', { name: 'More detail for the AI (optional)' }).inputValue(), '', 'not yet');
    await detail.getByRole('button', { name: 'Use this' }).click();
    await page.getByText('Updated 1 figure.').waitFor();
    assert.equal(await detail.getByRole('textbox', { name: 'More detail for the AI (optional)' }).inputValue(), 'A red banner and a blue banner.');
    assert.equal(await storedDescription(page), 'A red banner and a blue banner.');
    assert.deepEqual(problems, []);
  });
});

describe('Describe with AI, with the real local model', () => {
  let workspace;
  let app;
  let vision = false;

  before(async () => {
    try {
      const props = await (await fetch('http://127.0.0.1:8080/props', { signal: AbortSignal.timeout(3000) })).json();
      vision = props?.modalities?.vision === true;
    } catch {
      vision = false;
    }
    if (!vision) console.log('SKIPPING the real-model test: no server that reads images at 127.0.0.1:8080');
  });

  beforeEach(() => {
    workspace = createWorkspace();
  });

  afterEach(async () => {
    if (app && !app.exited) await app.kill().catch(() => {});
    workspace.cleanup();
  });

  it('describes a red and blue picture from the figure popover', async (t) => {
    if (!vision) return t.skip('no local server that reads images');
    app = await launch(workspace);
    const { page } = app;
    // The default profile is the local server, on automatic, which asks it whether it reads images.
    await createProject(page, 'Vision World');
    const asset = await addAsset(page, { name: 'colors.png', mime: 'image/png', base64: redBluePng().toString('base64'), width: 64, height: 64 });
    const home = await rpc(page, 'pages.home');
    await rpc(page, 'pages.update', {
      id: home.id,
      patch: { content: { type: 'doc', content: [paragraph('Two colors.'), pictureFigure(asset.id, 'Two halves')] } },
    });
    await page.reload();
    await page.locator('.prose').first().waitFor();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const figure = page.locator('.prose .figure[data-kind]').first();
    await figure.hover();
    await figure.getByRole('button', { name: 'More detail for the AI', exact: true }).click();
    const popover = page.locator('.figure-describe');
    await popover.getByRole('button', { name: 'Describe with AI' }).click();
    await popover.getByRole('button', { name: 'Use this' }).waitFor({ timeout: 240_000 });
    const answer = await popover.getByRole('textbox', { name: 'Suggested description' }).inputValue();
    console.log(`Description from the local server: ${answer}`);
    assert.match(answer.toLowerCase(), /red/);
    assert.match(answer.toLowerCase(), /blue/);
    assert.equal(await popover.getByRole('textbox', { name: 'More detail for the AI (optional)' }).inputValue(), '', 'not used yet');
    await popover.getByRole('button', { name: 'Use this' }).click();
    await waitUntil(async () => {
      const doc = (await rpc(page, 'pages.home')).content;
      return doc.content.find((node) => node.type === 'figure')?.attrs.description === answer;
    }, 8000, 'the description to be stored');
    await app.screenshot('describe-real-model');
  });
});
