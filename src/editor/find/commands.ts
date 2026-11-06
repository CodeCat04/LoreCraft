/** Commands that only make sense with Find. Ctrl+F itself is shared with project search. */

import { t, subscribeLocale } from '../../lib/i18n';
import { registerCommands } from '../../shell/commands';
import { useProject } from '../../state/project';
import { currentFindEditor, openFind, openFindInCurrentEditor } from './controller';

const hasProject = () => useProject.getState().status.open;

export function registerFind() {
  registerFindCommands();
  // The titles are read when registered, so a new language registers them again.
  subscribeLocale(registerFindCommands);
}

function registerFindCommands() {
  registerCommands([
    {
      id: 'find.next',
      title: t('Next match'),
      shortcut: 'F3',
      menu: 'Edit',
      order: 23,
      when: () => openFind() !== null,
      run: () => openFind()?.step(1),
    },
    {
      id: 'find.previous',
      title: t('Previous match'),
      shortcut: 'Shift+F3',
      menu: 'Edit',
      order: 24,
      when: () => openFind() !== null,
      run: () => openFind()?.step(-1),
    },
    {
      id: 'find.replace',
      title: t('Replace in this page'),
      shortcut: 'Ctrl+H',
      menu: 'Edit',
      order: 25,
      keywords: 'find substitute',
      when: () => hasProject() && !!currentFindEditor()?.isEditable,
      run: () => {
        openFindInCurrentEditor({ replace: true });
      },
    },
  ]);
}
