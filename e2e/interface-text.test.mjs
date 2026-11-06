/**
 * Text that used to stay in English whatever the interface language: the Prose panel, with what
 * its worker reports, and an infobox field's changes during the story, with what the date reader
 * says about a date it cannot place.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createProject, createWorkspace, launch, rpc, waitUntil } from './harness.mjs';

const doc = (...texts) => ({ type: 'doc', content: texts.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })) });

describe('interface text in another language', () => {
  let workspace;
  let app;

  beforeEach(() => {
    workspace = createWorkspace();
  });

  afterEach(async () => {
    if (app && !app.exited) await app.kill().catch(() => {});
    workspace.cleanup();
  });

  async function inSpanish(page) {
    await page.keyboard.press('Control+,');
    await page.getByRole('tab', { name: 'Language' }).click();
    await page.getByTestId('interface-language').selectOption('es');
    await waitUntil(() => page.evaluate(() => document.documentElement.lang === 'es'), 5000, 'the interface to be in Spanish');
  }

  it('shows the Prose panel, and what its worker found, in Spanish', async () => {
    app = await launch(workspace);
    const { page } = app;
    page.setDefaultTimeout(15_000);
    await createProject(page, 'Mundo');
    const [book] = await rpc(page, 'books.list');
    const scene = (await rpc(page, 'nodes.tree', { bookId: book.id })).find((n) => n.kind === 'scene');
    const text = 'She felt the cold. The cat sat on the mat. The dog ran to the gate. The sun was low. The wind was up. They saw it all.';
    await rpc(page, 'nodes.update', { id: scene.id, patch: { content: doc(text, text) } });
    await inSpanish(page);

    await page.locator('.area-tabs').getByRole('button', { name: 'Escribir', exact: true }).click();
    await page.locator('.ProseMirror[contenteditable="true"]').waitFor();
    await page.keyboard.press('Control+Alt+P');
    const panel = page.getByRole('complementary', { name: 'Revisión de estilo' });
    await panel.waitFor();
    await panel.getByRole('heading', { name: 'Estilo' }).waitFor();
    await panel.getByRole('checkbox', { name: 'Resaltar palabras filtro' }).waitFor();
    await panel.getByRole('group', { name: 'Qué revisar' }).getByRole('button', { name: 'Capítulo' }).waitFor();
    // The reading level and the chart rows come from the worker, in English, and are shown in Spanish.
    await panel.getByText(/^Muy fácil, nivel escolar \d+$/).waitFor();
    await panel.locator('.prose-lengths caption').filter({ hasText: 'Longitud de las frases, en palabras' }).waitFor();
    const rows = await panel.locator('.prose-lengths tbody th').allInnerTexts();
    assert.deepEqual(rows, ['1 a 5', '6 a 10', '11 a 15', '16 a 20', '21 a 30', '31 a 40', 'Más de 40']);
    const filter = panel.locator('.prose-check-count[data-check="filter"]');
    await waitUntil(async () => (await filter.getAttribute('aria-label')) === '4 palabras filtro. Mostrar la siguiente', 5000, 'the count');
    await panel.getByRole('heading', { name: 'Leer en voz alta' }).waitFor();
    const body = await panel.innerText();
    for (const english of ['Reading level', 'Sentence length', 'Overused words', 'Read aloud', 'words', 'minute']) {
      assert.ok(!body.includes(english), `no "${english}" left in English`);
    }
    await app.screenshot('interface-text-prose-spanish');
  });

  it('shows changes during the story, and a date it cannot place, in Spanish', async () => {
    app = await launch(workspace);
    const { page } = app;
    page.setDefaultTimeout(15_000);
    await createProject(page, 'Mundo');
    await rpc(page, 'pages.create', {
      title: 'Aria Vale',
      pageType: 'character',
      infobox: { fields: [{ key: 'hair', label: 'Pelo', kind: 'text', value: 'rubio' }] },
    });
    await inSpanish(page);

    await page.locator('.area-tabs').getByRole('button', { name: 'Wiki', exact: true }).click();
    await page.getByRole('combobox', { name: 'Buscar en este proyecto' }).fill('Aria Vale');
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Aria Vale', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Editar', exact: true }).click();
    await page.getByLabel('Cambios de Pelo durante la historia').click();
    await page.getByText('El valor de arriba vale hasta el primer cambio.').waitFor();
    await page.getByRole('button', { name: 'Añadir un cambio a Pelo' }).click();
    await page.getByRole('combobox', { name: 'Escena del cambio 1 de Pelo' }).waitFor();
    await page.getByText('Dale una escena o una fecha, o nunca tendrá efecto.').waitFor();
    await page.getByRole('textbox', { name: 'Fecha en el mundo del cambio 1 de Pelo' }).fill('312 AE');
    await page.getByText('«AE» no es una era conocida. Añádela en los ajustes de eras, o cambia la fecha.').waitFor();
    await page.getByRole('button', { name: 'Quitar el cambio 1 de Pelo' }).waitFor();
    await app.screenshot('interface-text-changes-spanish');
  });
});
