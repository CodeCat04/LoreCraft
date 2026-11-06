/**
 * Drops that land outside an editor. The web view's default is to navigate to a dropped
 * file, which would throw away the whole app, so that is stopped everywhere. The file then
 * goes to the nearest sensible place: the document on screen, after switching to Edit if
 * it is being read.
 */

import type { Editor } from '@tiptap/core';

import {
  activeEditableEditor,
  addFiles,
  addVideoLink,
  carriesMedia,
  editorAt,
  mainEditor,
  positionAtPoint,
  waitForEditableEditor,
} from '../editor/figure';
import { t } from '../lib/i18n';
import { choose } from '../shell/dialogs';
import { toast } from '../shell/toasts';
import { useNav } from '../state/nav';
import { recognizeVideoUrl, singleUrlFrom } from './urls';

interface Dropped {
  files: File[];
  url: string | null;
  x: number;
  y: number;
}

function place(editor: Editor, dropped: Dropped) {
  const pos = positionAtPoint(editor.view, dropped.x, dropped.y);
  if (dropped.url) addVideoLink(editor.view, dropped.url, pos);
  else addFiles(editor.view, dropped.files, pos);
}

function askTitle(dropped: Dropped): string {
  if (dropped.url) return t('Switch to Edit to add this video link?');
  return dropped.files.length === 1 ? t('Switch to Edit to add this file?') : t('Switch to Edit to add these files?');
}

async function askToEdit(title: string, pageId: string, dropped: Dropped) {
  const answer = await choose({
    title: askTitle(dropped),
    message: t('Pictures and videos can only be added while editing. {title} is open for reading.', { title }),
    dismissValue: false,
    choices: [
      { label: t('Cancel'), value: false },
      { label: t('Switch to Edit'), value: true, tone: 'primary' as const },
    ],
  });
  if (!answer) return;
  useNav.getState().go({ view: 'page', id: pageId, tab: 'edit' });
  const editor = await waitForEditableEditor(pageId);
  if (editor) place(editor, dropped);
  else toast(t('The editor did not open, so nothing was added. Please try again.'), 'error');
}

function route(event: DragEvent, dropped: Dropped) {
  const under = editorAt(event.target);
  const editable = under?.editor.isEditable ? under.editor : activeEditableEditor();
  if (editable) {
    place(editable, dropped);
    return;
  }
  const reading = under ?? mainEditor();
  if (reading?.source.kind === 'page') {
    void askToEdit(reading.source.title, reading.source.id, dropped);
    return;
  }
  if (reading) {
    toast(t('Pictures and videos can only be added while editing. Switch this document to Edit first.'), 'info');
    return;
  }
  toast(t('Open a page or a scene for editing, then drop it there.'), 'info');
}

let started = false;

/** Call once at startup. */
export function startDropGuard() {
  if (started) return;
  started = true;

  // A drag from inside the app is its own business: dragging a figure, say. A dragged
  // element can be gone by the end, and then its `dragend` never gets here, so a drop
  // has to end the drag too.
  let internal = false;
  window.addEventListener('dragstart', () => {
    internal = true;
  });
  window.addEventListener('dragend', () => {
    internal = false;
  });
  window.addEventListener(
    'drop',
    () => {
      window.setTimeout(() => {
        internal = false;
      });
    },
    true,
  );

  const inField = (target: EventTarget | null) =>
    target instanceof Element && !!target.closest('input, textarea');

  window.addEventListener('dragover', (event) => {
    if (event.defaultPrevented || !carriesMedia(event.dataTransfer)) return;
    if (event.dataTransfer?.types.includes('Files') || !inField(event.target)) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    }
  });

  window.addEventListener('drop', (event) => {
    if (event.defaultPrevented) return;
    const data = event.dataTransfer;
    if (!data) return;
    const files = [...data.files];
    // Text dropped in a text box is the one thing the default is good for.
    if (files.length === 0 && inField(event.target)) return;
    event.preventDefault();
    if (internal) return;
    const url = files.length === 0 ? recognizeVideoUrl(singleUrlFrom(data) ?? '')?.url ?? null : null;
    if (files.length > 0 || url) route(event, { files, url, x: event.clientX, y: event.clientY });
  });
}
