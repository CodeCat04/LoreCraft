/** The Write area's commands, for the menus, shortcuts and palette. */

import { listen } from '@tauri-apps/api/event';

import { openBookSettings } from './BookSettings';
import { openSceneHistory } from './history/SceneHistory';
import {
  mergeWithNext,
  moveBook,
  newBook,
  newChapter,
  newPart,
  newScene,
  openSceneId,
  resetForNewProject,
  setDetailsOpen,
  splitOpenScene,
  stepScene,
  useWrite,
} from './store';
import { switchMode, toggleFocusMode } from './WriteView';
import { registerCommands } from '../shell/commands';
import { toast } from '../shell/toasts';
import { subscribeLocale, t } from '../lib/i18n';
import { areaOf, useNav, type WriteMode } from '../state/nav';
import { useProject } from '../state/project';
import { useSettings } from '../state/settings';

const hasProject = () => useProject.getState().status.open;
const inWrite = () => hasProject() && areaOf(useNav.getState().route) === 'write';

const bookIndex = () => {
  const { books, bookId } = useWrite.getState();
  return books.findIndex((b) => b.id === bookId);
};

function moveCurrentBook(by: -1 | 1) {
  const { bookId } = useWrite.getState();
  if (bookId) void moveBook(bookId, by);
}

let keyRepeating = false;

/** For commands where a held-down shortcut must act once, not thirty times a second. */
function once(run: () => void | Promise<void>) {
  return () => (keyRepeating ? undefined : run());
}

function viewCommand(mode: WriteMode, title: string, shortcut: string, order: number) {
  return {
    id: `write.view.${mode}`,
    title,
    shortcut,
    menu: 'View' as const,
    order,
    when: hasProject,
    keywords: 'write novel book manuscript view',
    run: () => switchMode(mode),
  };
}

export function registerWrite() {
  // Runs ahead of the shell's shortcut handler, which listens later in the same event.
  window.addEventListener(
    'keydown',
    (e) => {
      keyRepeating = e.repeat;
    },
    true,
  );
  // Once the key is up, a click on a menu item is not a repeat of anything.
  window.addEventListener(
    'keyup',
    () => {
      keyRepeating = false;
    },
    true,
  );

  registerWriteCommands();
  subscribeLocale(registerWriteCommands);

  // Everything remembered about a project goes when another one opens.
  void listen<{ entity: string }>('data://changed', (event) => {
    if (event.payload.entity === 'all') resetForNewProject();
  });
}

/** Runs again when the interface language changes, which replaces the titles. */
function registerWriteCommands() {
  registerCommands([
    {
      id: 'write.open',
      title: t('Go to Write'),
      shortcut: 'Ctrl+Shift+W',
      menu: 'View',
      order: 2,
      when: hasProject,
      keywords: 'novel book manuscript',
      run: () => useNav.getState().go({ view: 'write' }),
    },

    // Adding things
    { id: 'write.newScene', title: t('New scene'), shortcut: 'Ctrl+Alt+Enter', menu: 'Insert', order: 10, when: hasProject, keywords: 'write novel', run: once(() => newScene()) },
    { id: 'write.newChapter', title: t('New chapter'), shortcut: 'Ctrl+Alt+Shift+N', menu: 'Insert', order: 11, when: hasProject, keywords: 'write novel', run: once(() => newChapter()) },
    { id: 'write.newPart', title: t('New part'), menu: 'Insert', order: 12, when: hasProject, keywords: 'write novel', run: () => newPart() },
    { id: 'write.newBook', title: t('New book…'), menu: 'Insert', order: 13, when: hasProject, keywords: 'write novel series', run: () => newBook() },
    { id: 'write.moveBookUp', title: t('Move book up'), menu: 'Insert', order: 14, when: () => hasProject() && bookIndex() > 0, keywords: 'write novel series order reorder', run: () => moveCurrentBook(-1) },
    { id: 'write.moveBookDown', title: t('Move book down'), menu: 'Insert', order: 15, when: () => hasProject() && bookIndex() >= 0 && bookIndex() < useWrite.getState().books.length - 1, keywords: 'write novel series order reorder', run: () => moveCurrentBook(1) },

    // Cutting and joining
    {
      id: 'write.splitScene',
      title: t('Split scene at the cursor'),
      shortcut: 'Ctrl+Alt+S',
      menu: 'Edit',
      order: 40,
      when: inWrite,
      keywords: 'write divide cut two scenes',
      run: once(() => splitOpenScene()),
    },
    {
      id: 'write.mergeScene',
      title: t('Merge scene with the next one'),
      shortcut: 'Ctrl+Alt+M',
      menu: 'Edit',
      order: 41,
      when: inWrite,
      keywords: 'write join combine scenes',
      run: once(() => {
        const id = openSceneId();
        if (id) return mergeWithNext(id);
        toast(t('Open a scene to merge it with the next one.'));
        return undefined;
      }),
    },
    {
      id: 'write.sceneHistory',
      title: t('Scene history'),
      menu: 'Edit',
      order: 42,
      when: inWrite,
      keywords: 'write versions revisions snapshots compare restore undo',
      run: once(() => {
        const id = openSceneId();
        if (id) return openSceneHistory(id);
        toast(t('Open a scene to see its history.'));
        return undefined;
      }),
    },

    // Moving around
    { id: 'write.previousScene', title: t('Previous scene'), shortcut: 'Ctrl+Alt+ArrowUp', menu: 'View', order: 60, when: inWrite, keywords: 'write', run: () => stepScene(-1) },
    { id: 'write.nextScene', title: t('Next scene'), shortcut: 'Ctrl+Alt+ArrowDown', menu: 'View', order: 61, when: inWrite, keywords: 'write', run: () => stepScene(1) },

    // Views
    viewCommand('scene', t('Scene view'), 'Ctrl+Alt+1', 62),
    viewCommand('read', t('Chapter read-through'), 'Ctrl+Alt+2', 63),
    viewCommand('cork', t('Corkboard'), 'Ctrl+Alt+3', 64),
    viewCommand('outline', t('Outline'), 'Ctrl+Alt+4', 65),
    viewCommand('threads', t('Plot threads'), 'Ctrl+Alt+5', 65),
    viewCommand('presence', t('Character presence'), 'Ctrl+Alt+6', 65),
    {
      id: 'write.stats',
      title: t('Writing stats'),
      menu: 'View',
      order: 66,
      when: hasProject,
      keywords: 'progress goal streak words',
      run: () => useNav.getState().go({ view: 'stats', bookId: useWrite.getState().bookId ?? undefined }),
    },
    {
      id: 'write.trash',
      title: t('Manuscript trash'),
      menu: 'View',
      order: 67,
      when: hasProject,
      keywords: 'deleted restore scene chapter book',
      run: () => useNav.getState().go({ view: 'write', mode: 'trash' }),
    },

    // How the page behaves
    { id: 'write.focus', title: t('Focus mode'), shortcut: 'F11', menu: 'View', order: 70, when: hasProject, keywords: 'distraction free zen write fullscreen', run: once(toggleFocusMode) },
    {
      id: 'write.toggleDetails',
      title: t('Scene details'),
      shortcut: 'Ctrl+Alt+D',
      menu: 'View',
      order: 71,
      when: inWrite,
      keywords: 'status pov synopsis notes',
      run: once(() => setDetailsOpen(!useWrite.getState().detailsOpen)),
    },
    {
      id: 'write.toggleNames',
      title: t('Underline page names in the manuscript'),
      menu: 'View',
      order: 72,
      keywords: 'highlight wiki mentions',
      run: () => {
        const { settings, update } = useSettings.getState();
        return update({ editor: { highlightNames: !settings.editor.highlightNames } });
      },
    },
    {
      id: 'write.toggleTypewriter',
      title: t('Typewriter scrolling'),
      menu: 'View',
      order: 73,
      keywords: 'center current line write',
      run: () => {
        const { settings, update } = useSettings.getState();
        return update({ editor: { typewriterScroll: !settings.editor.typewriterScroll } });
      },
    },

    { id: 'write.bookSettings', title: t('Book settings…'), menu: 'Tools', order: 20, when: inWrite, keywords: 'title author target words', run: () => openBookSettings() },
    {
      id: 'write.focusBinder',
      title: t('Go to the book contents'),
      shortcut: 'Ctrl+Alt+B',
      when: inWrite,
      keywords: 'binder tree sidebar',
      run: () => {
        document.querySelector<HTMLElement>('.binder-tree [tabindex="0"]')?.focus();
      },
    },
  ]);
}
