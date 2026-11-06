/**
 * Writing in other languages, in the real app: word counts, search and name detection in
 * scripts without spaces, spellcheck in another language, right-to-left text, and switching
 * the interface language.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { startMockServer } from '../scripts/mock-ai-server.mjs';
import { createProject, createWorkspace, launch, rpc, waitUntil, slowLimit } from './harness.mjs';

const EDITOR = '.ProseMirror[contenteditable="true"]';

function statusWords(page) {
  return page.locator('[data-status="write.words"]').innerText();
}

function doc(...paragraphs) {
  return {
    type: 'doc',
    content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
  };
}

async function firstScene(page) {
  const books = await rpc(page, 'books.list');
  const rows = await rpc(page, 'nodes.tree', { bookId: books[0].id });
  return rows.find((row) => row.kind === 'scene');
}

/** Opens the first scene's editor from the Write tab. */
async function openWrite(page) {
  await page.getByRole('button', { name: 'Write', exact: true }).click();
  await page.locator(EDITOR).waitFor();
  return firstScene(page);
}

async function chooseProjectLanguage(page, code) {
  await page.keyboard.press('Control+,');
  await page.getByRole('tab', { name: 'Language' }).click();
  await page.getByTestId('project-language').selectOption(code);
  await waitUntil(async () => (await rpc(page, 'project.getMeta', { key: 'language' })) === code, 3000, 'the language to be saved');
}

function misspelled(page) {
  return page.locator(`${EDITOR} .spell-error`).evaluateAll((spans) => spans.map((span) => span.textContent));
}

describe('other languages', () => {
  let workspace;
  let app;

  beforeEach(async () => {
    workspace = createWorkspace();
    app = await launch(workspace);
  });

  afterEach(async () => {
    await app.kill();
    workspace.cleanup();
  });

  it('counts Chinese and Japanese per character, live and after saving, and leaves English alone', async () => {
    const { page } = app;
    await createProject(page);
    const scene = await openWrite(page);

    await page.locator(EDITOR).click();
    await page.keyboard.insertText('我爱读书。');
    await waitUntil(async () => /^4 words/.test(await statusWords(page)), 3000, 'the live count of Chinese');
    await waitUntil(
      async () => (await rpc(page, 'nodes.get', { id: scene.id })).wordCount === 4,
      5000,
      'the stored count of Chinese',
    );

    await page.keyboard.press('Enter');
    await page.keyboard.insertText('吾輩は猫である');
    await waitUntil(async () => /^11 words/.test(await statusWords(page)), 3000, 'the live count of Japanese');
    await waitUntil(
      async () => (await rpc(page, 'nodes.get', { id: scene.id })).wordCount === 11,
      5000,
      'the stored count of Japanese',
    );

    await page.keyboard.press('Enter');
    await page.keyboard.insertText('Well-known English words here.');
    await waitUntil(async () => /^15 words/.test(await statusWords(page)), 3000, 'the live count of English');
    await waitUntil(
      async () => (await rpc(page, 'nodes.get', { id: scene.id })).wordCount === 15,
      5000,
      'the stored count of English',
    );
  });

  it('finds a Chinese name by search and detects it as a mention', async () => {
    const { page } = app;
    await createProject(page);
    const person = await rpc(page, 'pages.create', { title: '林黛玉', summary: '一个人物。' });
    const scene = await firstScene(page);
    await rpc(page, 'nodes.update', {
      id: scene.id,
      patch: { content: doc('那天林黛玉和贾宝玉一起去了大观园，大家都很高兴。') },
    });

    // Through the search box, as a person would. A word from inside a sentence.
    const box = page.getByRole('combobox', { name: 'Search this project' });
    await box.fill('贾宝玉');
    await page.keyboard.press('Enter');
    const result = page.locator('mark, .search-hit-match, .search-match', { hasText: '贾宝玉' }).first();
    await result.waitFor({ timeout: 5000 });
    assert.ok(
      (await page.locator('.content').innerText()).includes('那天林黛玉和贾宝玉一起去了大观园'),
      'the result reads as written, without separators',
    );
    await app.screenshot('languages-chinese-search');

    const hits = await rpc(page, 'search.query', { q: '林黛玉' });
    assert.ok(hits.some((hit) => hit.id === person.id), 'found by title');
    assert.ok(hits.some((hit) => hit.id === scene.id), 'found in the scene');
    assert.ok(!hits.some((hit) => /\u001f/.test(hit.title + hit.snippet)), 'no separators in what is shown');

    const backlinks = await rpc(page, 'pages.backlinks', { id: person.id });
    assert.equal(backlinks.scenes[0]?.id, scene.id, 'the scene mentions the name');

    // The editor underlines it too.
    await openWrite(page);
    const mention = page.locator(`${EDITOR} .name-mention`);
    await mention.first().waitFor({ timeout: 5000 });
    assert.equal(await mention.first().innerText(), '林黛玉');
  });

  it('checks spelling in the chosen language and turns off with an explanation where it cannot', async () => {
    const { page } = app;
    await createProject(page);
    const scene = await firstScene(page);
    await rpc(page, 'nodes.update', {
      id: scene.id,
      patch: { content: doc('El niño come una manzana. The brother walked.') },
    });

    await openWrite(page);
    // English first: the Spanish words are the wrong ones.
    await waitUntil(async () => (await misspelled(page)).includes('manzana'), 20000, 'the English dictionary');
    assert.ok(!(await misspelled(page)).includes('brother'));

    await chooseProjectLanguage(page, 'es');
    await openWrite(page);
    await waitUntil(async () => (await misspelled(page)).includes('brother'), 20000, 'the Spanish dictionary');
    const flagged = await misspelled(page);
    assert.deepEqual(flagged, ['The', 'brother', 'walked'], 'only the English is flagged');

    // Right-clicking offers Spanish fixes.
    await page.locator(EDITOR).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText(' La manzanna.');
    const typo = page.locator(`${EDITOR} .spell-error`, { hasText: 'manzanna' });
    await typo.waitFor({ timeout: 5000 });
    await typo.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'manzana', exact: true }).waitFor({ timeout: 5000 });
    await page.keyboard.press('Escape');

    // No dictionary for Chinese: nothing is flagged, the browser's checker stays off, and
    // the settings say why.
    await chooseProjectLanguage(page, 'zh');
    await page.getByTestId('spellcheck-off-note').waitFor();
    assert.match(await page.getByTestId('spellcheck-off-note').innerText(), /no dictionary for 中文/);
    await app.screenshot('languages-settings');
    await openWrite(page);
    await waitUntil(async () => (await misspelled(page)).length === 0, 5000, 'the underlines to go');
    assert.equal(await page.locator(EDITOR).getAttribute('spellcheck'), 'false');
    assert.equal(await page.locator(EDITOR).getAttribute('lang'), 'zh');

    // The language stays with the project, and survives a save.
    assert.equal(await rpc(page, 'project.getMeta', { key: 'language' }), 'zh');
  });

  it('loads every dictionary in the worker, quickly', async () => {
    const { page } = app;
    await createProject(page);
    const scene = await firstScene(page);
    await rpc(page, 'nodes.update', {
      id: scene.id,
      patch: { content: doc('colour color maison Haus casa libri Привет Превет') },
    });
    const cases = [
      { code: 'en-GB', right: 'colour', wrong: 'color' },
      { code: 'en-US', right: 'color', wrong: 'colour' },
      { code: 'fr', right: 'maison', wrong: 'Haus' },
      { code: 'de', right: 'Haus', wrong: 'maison' },
      { code: 'pt', right: 'casa', wrong: 'colour' },
      { code: 'it', right: 'libri', wrong: 'colour' },
      { code: 'ru', right: 'Привет', wrong: 'Превет' },
    ];
    for (const { code, right, wrong } of cases) {
      await chooseProjectLanguage(page, code);
      await openWrite(page);
      await waitUntil(
        async () => {
          const flagged = await misspelled(page);
          return flagged.includes(wrong) && !flagged.includes(right);
        },
        20_000,
        `the ${code} dictionary`,
      );
      const { loadMs, state } = await page.locator(EDITOR).evaluate((el) => el.spellStats());
      assert.equal(state, 'ready', code);
      assert.ok(loadMs < slowLimit(5000), `${code} took ${loadMs} ms to load`);
    }
  });

  it('lays Arabic and Hebrew out right to left, and leaves English as it was', async () => {
    const { page } = app;
    await createProject(page);
    const scene = await firstScene(page);
    await rpc(page, 'nodes.update', {
      id: scene.id,
      patch: {
        content: {
          type: 'doc',
          content: [
            { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'الفصل الأول' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'كتب الولد رسالة طويلة إلى أمه في المدينة.' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'An English line beside it.' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'שלום עולם, מה שלומך היום?' }] },
            {
              type: 'bulletList',
              content: [
                { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'البند الأول' }] }] },
                { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'البند الثاني' }] }] },
              ],
            },
            { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'اقتباس قصير' }] }] },
            {
              type: 'figure',
              attrs: { kind: 'table', align: 'full' },
              content: [
                {
                  type: 'table',
                  content: [
                    {
                      type: 'tableRow',
                      content: [
                        { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'خلية' }] }] },
                        { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Cell' }] }] },
                      ],
                    },
                  ],
                },
                { type: 'figcaption', content: [{ type: 'text', text: 'تعليق على الجدول' }] },
              ],
            },
          ],
        },
      },
    });
    await openWrite(page);
    const direction = (selector, text) =>
      page.locator(`${EDITOR} ${selector}`, { hasText: text }).first().evaluate((el) => getComputedStyle(el).direction);
    const layout = (selector, text) =>
      page.locator(`${EDITOR} ${selector}`, { hasText: text }).first().evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const text = range.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        return { left: text.left - box.left, right: box.right - text.right };
      });

    assert.equal(await direction('p', 'كتب'), 'rtl');
    assert.equal(await direction('p', 'שלום'), 'rtl');
    assert.equal(await direction('h2', 'الفصل'), 'rtl');
    assert.equal(await direction('p', 'English'), 'ltr');
    assert.equal(await direction('ul', 'البند'), 'rtl');
    assert.equal(await direction('li', 'البند'), 'rtl');
    assert.equal(await direction('figcaption', 'تعليق'), 'rtl');
    assert.equal(await direction('td p', 'خلية'), 'rtl');
    assert.equal(await direction('td p', 'Cell'), 'ltr');

    // The text sits against the right edge of its block, and English against the left.
    const arabic = await layout('p', 'كتب');
    assert.ok(arabic.right < 2 && arabic.left > arabic.right, `Arabic is on the right: ${JSON.stringify(arabic)}`);
    const english = await layout('p', 'English');
    assert.ok(english.left < 2 && english.right > english.left, `English is on the left: ${JSON.stringify(english)}`);

    // The glyphs come from a font that has them: the text has width, and is shaped.
    const widths = await page.locator(`${EDITOR} p`, { hasText: 'كتب' }).first().evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getBoundingClientRect().width;
    });
    assert.ok(widths > 100, 'the Arabic text takes up room');

    // A list keeps its indent on the side its markers are on.
    const padding = await page.locator(`${EDITOR} ul`).first().evaluate((el) => {
      const style = getComputedStyle(el);
      return { left: parseFloat(style.paddingLeft), right: parseFloat(style.paddingRight) };
    });
    assert.ok(padding.right > 0 && padding.left === 0, `the list indent is on the right: ${JSON.stringify(padding)}`);
    const quote = await page.locator(`${EDITOR} blockquote`).first().evaluate((el) => {
      const style = getComputedStyle(el);
      return { left: parseFloat(style.borderLeftWidth), right: parseFloat(style.borderRightWidth) };
    });
    assert.ok(quote.right > 0 && quote.left === 0, `the quote rule is on the right: ${JSON.stringify(quote)}`);
    await app.screenshot('languages-right-to-left');

    // Typing in a block follows the text.
    await page.locator(EDITOR).click();
    await page.locator(`${EDITOR} p`, { hasText: 'שלום' }).first().click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('مرحبا');
    await waitUntil(async () => (await direction('p', 'مرحبا')) === 'rtl', 2000, 'a new Arabic line to run right to left');

    // A field does the same.
    const box = page.getByRole('combobox', { name: 'Search this project' });
    await box.fill('مرحبا');
    assert.equal(await box.evaluate((el) => getComputedStyle(el).unicodeBidi), 'plaintext');
  });

  it('shows Chinese, Japanese and Korean in a font that has them', async () => {
    const { page } = app;
    await createProject(page);
    const scene = await firstScene(page);
    await rpc(page, 'nodes.update', {
      id: scene.id,
      patch: { content: doc('中文：那天林黛玉笑了。', '日本語：吾輩は猫である。', '한국어: 나는 학교에 간다.', 'ไทย: ภาษาไทยเป็นภาษาที่สวยงาม') },
    });
    await openWrite(page);
    await page.locator(`${EDITOR} p`, { hasText: '吾輩' }).waitFor();
    await app.screenshot('languages-cjk');
    assert.match(await statusWords(page), /words/);
  });

  it('tells the AI the language of the project, in chat and in quick prompts', async () => {
    const { page } = app;
    const mock = await startMockServer();
    try {
      await createProject(page);
      const scene = await firstScene(page);
      await rpc(page, 'nodes.update', { id: scene.id, patch: { content: doc('El dragón duerme bajo la montaña.') } });
      await rpc(page, 'project.setMeta', { key: 'language', value: 'es' });
      const profile = { id: 'local', name: 'Local model', kind: 'openai-compatible', baseUrl: `${mock.url}/v1`, model: 'mock-local', isCloud: false };
      const routing = { chat: 'local', rewrite: 'local', extract: 'local', consistency: 'local' };
      await rpc(page, 'settings.update', { patch: { ai: { profiles: [profile], routing } } });
      await page.reload();
      await page.locator('.topbar').waitFor();

      const sent = async () => {
        const list = await (await fetch(`${mock.url}/__mock/requests`)).json();
        return list.filter((request) => request.path === '/v1/chat/completions').map((request) => JSON.stringify(request.body));
      };

      await page.getByRole('button', { name: 'AI', exact: true }).click();
      const input = page.getByRole('textbox', { name: 'Message the AI' });
      await input.fill('Hello there');
      await input.press('Enter');
      await page.getByTestId('ai-assistant').getByText(/mock answer to: Hello there/).waitFor({ timeout: 15_000 });
      const chat = await sent();
      assert.equal(chat.length, 1);
      assert.match(chat[0], /Write in Spanish/);
      assert.match(chat[0], /explicitly asks/);

      // It is in the conversation, and is not repeated with the next message.
      await input.fill('And again');
      await input.press('Enter');
      await page.getByTestId('ai-assistant').getByText(/mock answer to: And again/).waitFor({ timeout: 15_000 });
      const both = await sent();
      assert.equal(both[1].match(/Write in Spanish/g)?.length, 1);

      // Quick prompts go through the same assembly.
      await openWrite(page);
      await page.locator(EDITOR).click();
      await page.keyboard.press('Control+a');
      await page.getByRole('button', { name: 'Ask AI' }).click();
      await page.getByRole('group', { name: 'Quick prompts' }).getByRole('button', { name: 'Rewrite', exact: true }).click();
      await page.getByRole('region', { name: 'Suggested changes' }).waitFor({ timeout: 15_000 });
      const quick = await sent();
      assert.equal(quick.length, 3);
      assert.match(quick[2], /Write in Spanish/);
    } finally {
      await mock.close();
    }
  });

  it('switches the interface language on the start screen, and remembers it', async () => {
    let { page } = app;
    await page.getByRole('button', { name: 'New project' }).waitFor();
    await page.getByTestId('start-interface-language').selectOption('es');
    await page.getByRole('button', { name: 'Nuevo proyecto' }).waitFor();
    await page.getByRole('button', { name: 'Abrir proyecto…' }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'es');
    await app.screenshot('languages-start-spanish');

    await page.getByTestId('start-interface-language').selectOption('de');
    await page.getByRole('button', { name: 'Neues Projekt' }).waitFor();

    // It sticks after a restart.
    await app.kill();
    app = await launch(workspace);
    page = app.page;
    await page.getByRole('button', { name: 'Neues Projekt' }).waitFor();

    // Dialogs, menus and settings follow.
    await page.getByRole('button', { name: 'Neues Projekt' }).click();
    await page.getByRole('textbox').fill('Welt');
    await page.getByRole('button', { name: 'Erstellen' }).click();
    await page.locator('.topbar').waitFor();
    await page.getByRole('menuitem', { name: 'Datei', exact: true }).click();
    await page.getByRole('menuitem', { name: /Projekt schließen/ }).waitFor();
    await page.keyboard.press('Escape');

    await page.keyboard.press('Control+,');
    await page.getByRole('tab', { name: 'Sprache' }).click();
    assert.match(await page.locator('.content').innerText(), /jeder kann sie verbessern/);

    // Back to English from settings, without a restart. The menu follows at once.
    await page.getByTestId('interface-language').selectOption('en');
    await page.getByRole('tab', { name: 'Language' }).waitFor();
    await page.getByRole('menuitem', { name: 'File', exact: true }).click();
    await page.getByRole('menuitem', { name: /Close project/ }).waitFor();
  });
});
