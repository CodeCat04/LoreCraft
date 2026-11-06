import '../styles/inbox.css';

import { subscribeLocale, t } from '../lib/i18n';
import { registerCommands } from '../shell/commands';
import { useNav } from '../state/nav';
import { useProject } from '../state/project';
import { openCapture } from './capture';

export { InboxView } from './InboxView';
export { ideas, useOpenIdeaCount, type Idea, type IdeaCounts, type IdeaStatus, type NewIdea } from './api';

const hasProject = () => useProject.getState().status.open;

export function registerInbox() {
  registerInboxCommands();
  subscribeLocale(registerInboxCommands);
}

/** Runs again when the interface language changes, which replaces the titles. */
function registerInboxCommands() {
  registerCommands([
    {
      id: 'inbox.capture',
      title: t('Capture an idea…'),
      shortcut: 'Ctrl+Alt+N',
      menu: 'Tools',
      order: 20,
      keywords: 'note quick inbox write down',
      when: hasProject,
      run: openCapture,
    },
    {
      id: 'inbox.open',
      title: t('Inbox'),
      menu: 'Tools',
      order: 21,
      keywords: 'ideas notes',
      when: hasProject,
      run: () => useNav.getState().go({ view: 'inbox' }),
    },
  ]);
}
