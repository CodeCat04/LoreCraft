/** Things a person does to a page, shared by commands, menus and buttons. */

import { useState } from 'react';

import { wikiPages, type RenamePreview } from './api';
import { templateBody, templateFor, templateInfobox } from './templates';
import { useWikiSession } from './session';
import { flushOrStop } from '../editor/saving';
import { confirm, promptText, showDialog } from '../shell/dialogs';
import { toast } from '../shell/toasts';
import { useNav } from '../state/nav';
import { useLocale } from '../state/language';
import * as api from '../lib/api';
import { t } from '../lib/i18n';
import { RpcError, errorMessage } from '../lib/rpc';
import type { Page, PageStatus } from '../lib/types';

/** Errors that refuse the title itself, so trying it again would not help. */
export const REFUSED_TITLE = new Set(['TITLE_EXISTS', 'INVALID', 'NOT_FOUND']);

// Each label is read when shown, so it follows the interface language.
export const STATUSES: { value: PageStatus; label: string }[] = [
  { value: 'canon', get label() { return t('Canon'); } },
  { value: 'draft', get label() { return t('Draft'); } },
  { value: 'idea', get label() { return t('Idea'); } },
  { value: 'retconned', get label() { return t('Retconned'); } },
];

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

// ---- Opening a page -----------------------------------------------------------

const primedPages = new Map<string, Page>();
const bodyFocusWanted = new Set<string>();

/** A page the caller already holds, so opening it needs no second trip to the disk. */
export function primePage(page: Page) {
  primedPages.set(page.id, page);
}

export function takePrimedPage(id: string): Page | null {
  const page = primedPages.get(id) ?? null;
  primedPages.delete(id);
  return page;
}

export function takeBodyFocus(id: string): boolean {
  return bodyFocusWanted.delete(id);
}

/** Puts the cursor in the body when this page's editor next appears. */
export function requestBodyFocus(id: string) {
  bodyFocusWanted.add(id);
}

/** Opens a new page in Edit with the cursor in the body, ready for typing. */
export function openForWriting(page: Page) {
  primePage(page);
  requestBodyFocus(page.id);
  useNav.getState().go({ view: 'page', id: page.id, tab: 'edit' });
}

export function createFromTemplate(title: string, type: string, status?: PageStatus): Promise<Page> {
  const template = templateFor(type);
  return api.pages.create({
    title,
    pageType: type,
    status,
    content: templateBody(template),
    infobox: templateInfobox(template),
  });
}

// ---- Rename -------------------------------------------------------------------

function RenameConfirm(props: {
  oldTitle: string;
  preview: RenamePreview;
  onDone: (result: { keepAlias: boolean } | null) => void;
}) {
  const { oldTitle, preview, onDone } = props;
  useLocale();
  const [keepAlias, setKeepAlias] = useState(true);
  const count = preview.documents.length;
  const more = count - 8;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onDone({ keepAlias });
      }}
    >
      <h2 id="dialog-title" className="dialog-title">
        {t('Rename “{old}” to “{new}”?', { old: oldTitle, new: preview.newTitle })}
      </h2>
      <p className="dialog-message">
        {count === 1
          ? t('1 document links to this page and will be updated to use the new title.')
          : t('{count} documents link to this page and will be updated to use the new title.', { count: count.toLocaleString() })}
      </p>
      <ul className="wiki-dialog-list">
        {preview.documents.slice(0, 8).map((doc) => (
          <li key={`${doc.kind}:${doc.id}`} className="truncate">
            {doc.title || t('Untitled scene')}
            {doc.kind === 'node' && <span className="faint"> {t('(scene)')}</span>}
          </li>
        ))}
        {count > 8 && (
          <li className="faint">{more === 1 ? t('and 1 more') : t('and {count} more', { count: more.toLocaleString() })}</li>
        )}
      </ul>
      <label className="checkbox">
        <input type="checkbox" checked={keepAlias} onChange={(e) => setKeepAlias(e.target.checked)} />
        <span>{t('Keep “{title}” as another name for this page', { title: oldTitle })}</span>
      </label>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={() => onDone(null)}>{t('Cancel')}</button>
        <button type="submit" className="btn btn-primary" autoFocus>{t('Rename')}</button>
      </div>
    </form>
  );
}

/**
 * Renames a page, first saying how many documents will change. With none to change there
 * is nothing to weigh up, and an old name kept as an alias would only be clutter.
 * Returns whether the rename happened.
 */
export async function renamePage(
  id: string,
  oldTitle: string,
  newTitle: string,
  /**
   * Takes over a rename whose write failed for a reason other than the title itself, so the
   * typed title is kept and tried again. Then the rename counts as done.
   */
  retry?: (title: string, keepAlias: boolean) => void,
): Promise<boolean> {
  try {
    await flushOrStop();
    const preview = await wikiPages.renamePreview(id, newTitle);
    let keepAlias = false;
    if (preview.documents.length > 0) {
      const answer = await showDialog<{ keepAlias: boolean } | null>(
        (close) => <RenameConfirm oldTitle={oldTitle} preview={preview} onDone={close} />,
        null,
      );
      if (!answer) return false;
      keepAlias = answer.keepAlias;
    }
    let documentsChanged: number;
    try {
      ({ documentsChanged } = await api.pages.rename(id, preview.newTitle, true, keepAlias));
    } catch (e) {
      if (!retry || (e instanceof RpcError && REFUSED_TITLE.has(e.code))) throw e;
      retry(preview.newTitle, keepAlias);
      return true;
    }
    const title = preview.newTitle;
    toast(
      documentsChanged === 0
        ? t('Renamed to “{title}”.', { title })
        : documentsChanged === 1
          ? t('Renamed to “{title}”. Updated 1 document.', { title })
          : t('Renamed to “{title}”. Updated {count} documents.', { title, count: documentsChanged.toLocaleString() }),
      'success',
    );
    return true;
  } catch (e) {
    toast(errorMessage(e), 'error');
    return false;
  }
}

/** Asks for a new title, for F2 and the page's menu. */
export async function renameCurrentPage() {
  const { pageId, title } = useWikiSession.getState();
  if (!pageId) return;
  const next = await promptText({
    title: t('Rename page'),
    label: t('New title'),
    initial: title,
    confirmLabel: t('Rename'),
    validate: (v) => (v.trim() ? null : t('A page needs a title.')),
  });
  if (next !== null && next.trim() !== title) await renamePage(pageId, title, next);
  const session = useWikiSession.getState();
  if (session.tab === 'edit') session.editor?.commands.focus();
}

// ---- Delete and restore ---------------------------------------------------------

export async function trashPage(id: string, title: string) {
  const yes = await confirm({
    title: t('Move “{title}” to the trash?', { title }),
    message: t('Links to it turn red. You can restore it from the trash at any time.'),
    confirmLabel: t('Move to trash'),
    danger: true,
  });
  if (!yes) return;
  try {
    await flushOrStop();
    await api.pages.remove(id);
    // Undo puts the page back and opens it again, so a slip of the hand costs nothing.
    const dismiss = toast(t('Moved “{title}” to the trash.', { title }), 'info', {
      label: t('Undo'),
      run: () => {
        dismiss();
        void restoreFromTrash(id, title).then((ok) => {
          if (ok) useNav.getState().go({ view: 'page', id });
        });
      },
    });
    useNav.getState().go({ view: 'home' });
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

/** Moves the page on screen to the trash, unless it is the main page or already there. */
export async function trashCurrentPage() {
  const { pageId } = useWikiSession.getState();
  if (!pageId) return;
  try {
    const page = await api.pages.get(pageId);
    if (page.isHome) {
      toast(t('The main page cannot be deleted.'));
      return;
    }
    if (page.deletedAt) return;
    await trashPage(page.id, page.title);
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

export async function restoreFromTrash(id: string, title: string): Promise<boolean> {
  try {
    // A restore re-syncs family fields on other pages, so pending edits are stored first,
    // as before trashing, and an open editor's reload cannot write an older copy over them.
    await flushOrStop();
    await api.pages.restore(id);
    toast(t('Restored “{title}”.', { title }), 'success');
    return true;
  } catch (e) {
    toast(errorMessage(e), 'error');
    return false;
  }
}

export async function randomPage() {
  try {
    const id = await wikiPages.random(useWikiSession.getState().pageId ?? undefined);
    if (id) useNav.getState().go({ view: 'page', id });
    else toast(t('There are no other pages yet.'));
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}
