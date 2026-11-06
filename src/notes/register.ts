import { addComment } from './api';
import { activeEditor } from '../editor/ai/registry';
import { startComment } from '../editor/comments/extension';
import * as api from '../lib/api';
import { subscribeLocale, t } from '../lib/i18n';
import { registerCommands } from '../shell/commands';
import { toast } from '../shell/toasts';
import { useNav } from '../state/nav';
import { useProject } from '../state/project';

const hasProject = () => useProject.getState().status.open;

export function registerNotes() {
  // The API has no screen of its own, so the tests reach it directly.
  void api.app.bootstrap().then(
    (boot) => {
      if (boot.e2e) (window as unknown as { __notesE2e?: unknown }).__notesE2e = { addComment };
    },
    () => {},
  );
  registerNotesCommands();
  subscribeLocale(registerNotesCommands);
}

/** Runs again when the interface language changes, which replaces the titles. */
function registerNotesCommands() {
  registerCommands([
    {
      id: 'notes.comment',
      title: t('Comment'),
      shortcut: 'Ctrl+Alt+C',
      menu: 'Insert',
      order: 40,
      // An article stays mounted behind its Talk tab, where it cannot be commented on.
      when: () => {
        const entry = activeEditor();
        return hasProject() && !!entry && entry.source.kind !== 'notes' && entry.editor.view.dom.offsetParent !== null;
      },
      keywords: 'note annotate to-do todo margin',
      run: () => {
        const entry = activeEditor();
        if (!entry || !startComment(entry.editor)) toast(t('Select some text to comment on.'));
      },
    },
    {
      id: 'notes.open',
      title: t('Comments and to-dos'),
      shortcut: 'Ctrl+Alt+Shift+C',
      menu: 'View',
      order: 50,
      when: hasProject,
      keywords: 'notes annotations todo list open items',
      run: () => useNav.getState().go({ view: 'notes' }),
    },
  ]);
}
