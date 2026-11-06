/**
 * Consistency checks: rule checks with no AI, and AI checks whose quotes are verified. Findings
 * are stored with the project. What other modules may want:
 * - `{ view: 'consistency' }` to go to the screen.
 * - `RPC consistency.list` for the findings, through `findings.list` in `./api`.
 */

import '../styles/consistency.css';

import { listen } from '@tauri-apps/api/event';

import { subscribeLocale, t } from '../lib/i18n';
import { registerCommands } from '../shell/commands';
import { useNav } from '../state/nav';
import { useProject } from '../state/project';
import { resetConsistency, runRules } from './store';
import { offerWhenChaptersAreFinal, suggestForCurrentChapter } from './suggest';

export { ConsistencyView } from './ConsistencyView';

const hasProject = () => useProject.getState().status.open;

/** Titles are read when registered, so this runs again when the language changes. */
function registerConsistencyCommands() {
  registerCommands([
    {
      id: 'consistency.open',
      title: t('Consistency checks'),
      menu: 'Tools',
      order: 30,
      when: hasProject,
      keywords: 'findings contradictions errors check lore canon',
      run: () => useNav.getState().go({ view: 'consistency' }),
    },
    {
      id: 'consistency.runRules',
      title: t('Run rule checks'),
      when: hasProject,
      keywords: 'consistency findings names dates links',
      run: () => {
        useNav.getState().go({ view: 'consistency' });
        return runRules();
      },
    },
    {
      id: 'consistency.wikiUpdates',
      title: t('Suggest wiki updates from this chapter'),
      menu: 'AI',
      order: 52,
      when: hasProject,
      keywords: 'propose new pages infobox lore after chapter done final',
      run: suggestForCurrentChapter,
    },
  ]);
}

export function registerConsistency() {
  registerConsistencyCommands();
  subscribeLocale(registerConsistencyCommands);
  offerWhenChaptersAreFinal();

  // Everything remembered about a project goes when another one opens.
  void listen<{ entity: string }>('data://changed', (event) => {
    if (event.payload.entity === 'all') resetConsistency();
  });
}
