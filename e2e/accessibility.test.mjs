// Accessibility checks on the main screens, with Playwright role queries and plain DOM
// checks. No outside checker is used, so the rules are the few that matter most:
// everything you can press has a name, every dialog is named and modal, every field has a
// label, and no element jumps the tab order.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createProject, createWorkspace, launch, rpc, waitUntil } from './harness.mjs';

/** Runs in the page. Returns a list of problems on what is visible now. */
function audit() {
  const visible = (el) => {
    if (!(el instanceof Element)) return false;
    if (el.closest('[aria-hidden="true"], [inert]')) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    return el.getClientRects().length > 0;
  };
  const describe = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return `<${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}${el.id ? `#${el.id}` : ''}>`;
  };
  const byIds = (ids) =>
    ids.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim() ?? '').join(' ').trim();
  const name = (el) => {
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby && byIds(labelledby)) return byIds(labelledby);
    const label = el.getAttribute('aria-label')?.trim();
    if (label) return label;
    if (el.labels?.length) {
      const text = [...el.labels].map((l) => l.textContent.trim()).join(' ').trim();
      if (text) return text;
    }
    const text = (el.innerText ?? el.textContent ?? '').trim();
    if (text && !['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) return text;
    const img = el.querySelector?.('img[alt]:not([alt=""]), svg[aria-label], [role="img"][aria-label]');
    if (img) return img.getAttribute('alt') || img.getAttribute('aria-label');
    if (el.title?.trim()) return el.title.trim();
    if (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type) && el.value) return el.value;
    return '';
  };

  const problems = [];
  for (const el of document.querySelectorAll('button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"]')) {
    if (visible(el) && !name(el)) problems.push(`no name: ${describe(el)} ${el.outerHTML.slice(0, 120)}`);
  }
  for (const el of document.querySelectorAll('[role="dialog"], [role="alertdialog"]')) {
    if (!visible(el)) continue;
    // A dialog takes its name from a label or a heading, never from all of its text.
    const labelledby = el.getAttribute('aria-labelledby');
    if (!el.getAttribute('aria-label')?.trim() && !(labelledby && byIds(labelledby))) {
      problems.push(`dialog has no name: ${describe(el)}`);
    }
    // Popups that stay beside the work are not modal. A dialog over a backdrop is.
    if (el.closest('.dialog-backdrop') && el.getAttribute('aria-modal') !== 'true') problems.push(`dialog not modal: ${describe(el)}`);
  }
  const ids = new Map();
  for (const el of document.querySelectorAll('[id]')) ids.set(el.id, (ids.get(el.id) ?? 0) + 1);
  for (const [id, count] of ids) if (count > 1 && id === 'dialog-title') problems.push(`id ${id} is used ${count} times`);
  for (const el of document.querySelectorAll(
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea, [contenteditable="true"], [role="textbox"], [role="combobox"], [role="searchbox"], [role="slider"], [role="switch"], [role="checkbox"]',
  )) {
    if (!visible(el)) continue;
    // A field inside an editor's own text, such as a figure caption, is named by its editor.
    if (el.parentElement?.closest('[contenteditable="true"]')) continue;
    if (!name(el)) problems.push(`field has no label: ${describe(el)} ${el.outerHTML.slice(0, 120)}`);
  }
  for (const el of document.querySelectorAll('[tabindex]')) {
    if (Number(el.getAttribute('tabindex')) > 0) problems.push(`positive tabindex: ${describe(el)}`);
  }
  return [...new Set(problems)];
}

describe('accessibility', () => {
  let workspace;
  let app;
  let page;

  beforeEach(() => {
    workspace = createWorkspace();
  });

  afterEach(async (t) => {
    if (t.passed === false && app && !app.exited) await app.screenshot('a11y-last-failure').catch(() => {});
    if (app && !app.exited) await app.kill().catch(() => {});
    workspace.cleanup();
  });

  async function check(where) {
    const problems = await page.evaluate(audit);
    assert.deepEqual(problems, [], `${where} has no accessibility problems`);
  }

  it('names, labels and dialogs on the main screens', async () => {
    app = await launch(workspace);
    page = app.page;
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.getByRole('button', { name: 'New project' }).waitFor();
    // The checks themselves catch what they look for.
    const caught = await page.evaluate((source) => {
      const probe = document.createElement('div');
      probe.innerHTML = '<button></button><input><span tabindex="3">x</span><div class="dialog-backdrop"><div role="dialog">x</div></div>';
      document.body.append(probe);
      const found = new Function(`return (${source})()`)();
      probe.remove();
      return found.map((p) => p.split(':')[0]);
    }, audit.toString());
    for (const kind of ['no name', 'field has no label', 'positive tabindex', 'dialog has no name', 'dialog not modal']) {
      assert.ok(caught.includes(kind), `the audit finds "${kind}"`);
    }
    await check('the start screen');

    await createProject(page, 'Open World');
    await rpc(page, 'pages.create', { title: 'Harbor' });
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await palette.waitFor();
    const combo = palette.getByRole('combobox', { name: 'Search pages and commands' });
    await combo.fill('Harbor');
    const list = palette.getByRole('listbox');
    assert.equal(await combo.getAttribute('aria-controls'), await list.getAttribute('id'), 'the box names its list');
    const active = await combo.getAttribute('aria-activedescendant');
    assert.ok(active, 'the box points at the chosen option');
    assert.equal(await page.locator(`#${active}`).getAttribute('role'), 'option');
    assert.equal(await palette.getAttribute('aria-modal'), 'true');
    await check('the palette');
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Harbor', exact: true }).waitFor();
    await check('a wiki page');

    await page.keyboard.press('Control+e');
    const article = page.getByRole('textbox', { name: 'Article text: Harbor' });
    await article.waitFor();
    await check('edit mode');

    // The palette gives the keyboard back to where it was.
    await article.focus();
    await page.keyboard.press('Control+k');
    await palette.waitFor();
    await page.keyboard.press('Escape');
    await palette.waitFor({ state: 'hidden' });
    await waitUntil(() => page.evaluate(() => document.activeElement?.classList.contains('ProseMirror')), 3000, 'focus back in the article');

    // A dialog is named, modal, and the app behind it is out of reach.
    await page.keyboard.press('Control+n');
    const dialog = page.getByRole('dialog', { name: 'New page' });
    await dialog.waitFor();
    assert.equal(await dialog.getAttribute('aria-modal'), 'true');
    assert.equal(await page.locator('.topbar').evaluate((el) => !!el.closest('[inert]')), true, 'the app is inert');
    await check('a dialog');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('[inert]').count(), 0, 'nothing stays inert');

    await page.getByRole('button', { name: 'Write', exact: true }).click();
    await page.locator('.ProseMirror[contenteditable="true"]').waitFor();
    assert.ok(await page.getByRole('textbox', { name: /^Scene text: / }).count(), 'the scene editor is named');
    await check('the writing view');

    await page.getByRole('button', { name: 'AI', exact: true }).click();
    await page.getByTestId('ai-pane').waitFor();
    const log = page.getByRole('log', { name: 'Conversation' });
    assert.equal(await log.getAttribute('aria-live'), 'off', 'streamed text is not announced');
    assert.equal(await page.getByTestId('ai-reply-status').getAttribute('role'), 'status');
    await check('the AI pane');

    await page.keyboard.press('Control+k');
    await palette.getByRole('combobox').fill('Settings');
    await page.keyboard.press('Enter');
    await page.getByRole('tab').first().waitFor();
    await check('Settings');
  });
});
