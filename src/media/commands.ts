/** The Insert menu's media commands, and "Remove unused media". */

import type { Editor } from '@tiptap/core';

import {
  activeEditableEditor,
  addExistingMedia,
  addLabel,
  addLinkedVideo,
  addPaths,
  addVideoLink,
  createFigure,
  createTable,
  insertFigureTr,
  nearestFigurePos,
  removeLabel,
} from '../editor/figure';
import * as api from '../lib/api';
import { subscribeLocale, t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { registerCommands } from '../shell/commands';
import { choose, promptText } from '../shell/dialogs';
import { toast } from '../shell/toasts';
import { useNav } from '../state/nav';
import { useProject } from '../state/project';
import { PICTURE_FILTERS, VIDEO_FILTERS } from './filters';
import { pickFromLibrary } from './library';
import { parseWebUrl } from './urls';
import { showUnusedMediaDialog } from './unusedDialog';

const canInsert = () => activeEditableEditor() !== null;

function runOnActive(run: (editor: Editor) => void | Promise<void>) {
  return async () => {
    const editor = activeEditableEditor();
    if (!editor) return;
    try {
      await run(editor);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
}

function insertionPoint(editor: Editor): number {
  return nearestFigurePos(editor.state.doc, editor.state.selection.from);
}

async function insertPicture(editor: Editor) {
  const pos = insertionPoint(editor);
  const pick = await pickFromLibrary('image', t('Insert a picture'), t('Choose a file…'));
  if (pick === null || editor.isDestroyed) return;
  if (pick !== 'file') {
    addExistingMedia(editor.view, pick, pos);
    return;
  }
  const paths = await api.files.pickOpen({ title: t('Choose pictures'), multiple: true, filters: PICTURE_FILTERS });
  if (paths.length > 0 && !editor.isDestroyed) addPaths(editor.view, paths, pos);
}

async function insertVideo(editor: Editor) {
  const pos = insertionPoint(editor);
  const pick = await pickFromLibrary('video', t('Insert a video'), t('Choose a file…'));
  if (pick === null || editor.isDestroyed) return;
  if (pick !== 'file') {
    addExistingMedia(editor.view, pick, pos);
    return;
  }
  const how = await choose<'embed' | 'link' | 'cancel'>({
    title: t('Insert a video'),
    message: t(
      'Embedding stores a copy in the project, so it travels with it but makes the project file and every save larger. Linking keeps the project small and plays the file from where it is, but a linked file will not travel with the project.',
    ),
    dismissValue: 'cancel',
    choices: [
      { label: t('Cancel'), value: 'cancel' },
      { label: t('Link to the file…'), value: 'link' },
      { label: t('Embed in project…'), value: 'embed', tone: 'primary' },
    ],
  });
  if (how === 'cancel') return;
  const paths = await api.files.pickOpen({
    title: how === 'embed' ? t('Choose a video to embed') : t('Choose a video to link to'),
    filters: VIDEO_FILTERS,
  });
  if (paths.length === 0 || editor.isDestroyed) return;
  if (how === 'embed') addPaths(editor.view, paths, pos);
  else addLinkedVideo(editor.view, paths[0], pos);
}

async function insertVideoLink(editor: Editor) {
  const pos = insertionPoint(editor);
  const url = await promptText({
    title: t('Video link'),
    label: t('Web address'),
    placeholder: 'https://',
    confirmLabel: t('Insert'),
    message: t('This adds a card that opens the video in your browser. Nothing is loaded from the web.'),
    validate: (value) => (parseWebUrl(value) ? null : t('Enter a complete web address, starting with https://')),
  });
  if (url && !editor.isDestroyed) addVideoLink(editor.view, url.trim(), pos);
}

function insertTable(editor: Editor) {
  const { state, view } = editor;
  const figure = createFigure(state.schema, {
    kind: 'table',
    align: 'full',
    media: { type: 'table', node: createTable(state.schema) },
  });
  view.dispatch(insertFigureTr(state.tr, insertionPoint(editor), figure, true));
  view.focus();
}

function canRun(command: typeof addLabel): boolean {
  const editor = activeEditableEditor();
  return !!editor && command(editor.state);
}

function runCommandOn(command: typeof addLabel) {
  return runOnActive((editor) => {
    command(editor.state, editor.view.dispatch);
    editor.view.focus();
  });
}

async function removeUnusedMedia() {
  try {
    await showUnusedMediaDialog();
  } catch (e) {
    toast(t('Could not look for unused media: {reason}', { reason: errorMessage(e) }), 'error');
  }
}

let followingLocale = false;

/** Registers the commands, and again whenever the language changes, so titles follow it. */
export function registerMediaCommands() {
  registerMediaCommandTitles();
  if (!followingLocale) {
    followingLocale = true;
    subscribeLocale(registerMediaCommandTitles);
  }
}

function registerMediaCommandTitles() {
  registerCommands([
    {
      id: 'insert.picture',
      title: t('Picture…'),
      menu: 'Insert',
      order: 10,
      keywords: 'image photo figure',
      when: canInsert,
      run: runOnActive(insertPicture),
    },
    {
      id: 'insert.video',
      title: t('Video…'),
      menu: 'Insert',
      order: 11,
      keywords: 'movie clip embed link',
      when: canInsert,
      run: runOnActive(insertVideo),
    },
    {
      id: 'insert.videoLink',
      title: t('Video link…'),
      menu: 'Insert',
      order: 12,
      keywords: 'youtube vimeo web address url',
      when: canInsert,
      run: runOnActive(insertVideoLink),
    },
    {
      id: 'insert.table',
      title: t('Table'),
      menu: 'Insert',
      order: 13,
      keywords: 'grid rows columns',
      when: canInsert,
      run: runOnActive(insertTable),
    },
    {
      id: 'insert.addLabel',
      title: t('Add a label'),
      menu: 'Insert',
      order: 20,
      keywords: 'caption figure table',
      when: () => canRun(addLabel),
      run: runCommandOn(addLabel),
    },
    {
      id: 'insert.removeLabel',
      title: t('Remove label'),
      menu: 'Insert',
      order: 21,
      keywords: 'caption figure table unwrap',
      when: () => canRun(removeLabel),
      run: runCommandOn(removeLabel),
    },
    {
      id: 'tools.mediaLibrary',
      title: t('Media library'),
      menu: 'Tools',
      order: 60,
      keywords: 'pictures videos images browse reuse assets',
      when: () => useProject.getState().status.open,
      run: () => useNav.getState().go({ view: 'media' }),
    },
    {
      // Lives in the library. Here it is only for the palette.
      id: 'tools.removeUnusedMedia',
      title: t('Remove unused media…'),
      keywords: 'clean pictures videos assets size',
      when: () => useProject.getState().status.open,
      run: removeUnusedMedia,
    },
  ]);
}
