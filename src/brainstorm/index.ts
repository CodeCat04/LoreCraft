import '../styles/brainstorm.css';

import { listen } from '@tauri-apps/api/event';

import { subscribeLocale, t } from '../lib/i18n';
import { registerCommands } from '../shell/commands';
import { useNav } from '../state/nav';
import { useProject } from '../state/project';
import { useBrainstorm } from './store';

export { BrainstormView } from './BrainstormView';

/** Runs again when the interface language changes, which replaces the titles. */
function registerBrainstormCommands() {
  registerCommands([
    // Brainstorm board. Its own block in the AI menu.
    {
      id: 'brainstorm.open',
      title: t('Brainstorm…'),
      menu: 'AI',
      order: 76,
      keywords: 'ideas names places plot twists conflicts titles objects dialogue traits suggest',
      when: () => useProject.getState().status.open,
      run: () => {
        // What is open now is what "the current scene or page" means on the board.
        useBrainstorm.getState().noteCurrent();
        useNav.getState().go({ view: 'brainstorm' });
      },
    },
  ]);
}

export function registerBrainstorm() {
  registerBrainstormCommands();
  subscribeLocale(registerBrainstormCommands);
  // The board belongs to one project.
  const forget = () => useBrainstorm.getState().reset();
  void listen<{ entity: string }>('data://changed', (event) => {
    if (event.payload.entity === 'all') forget();
  }).catch(() => {});
  useProject.subscribe((state, previous) => {
    if (previous.status.open && !state.status.open) forget();
  });
}
