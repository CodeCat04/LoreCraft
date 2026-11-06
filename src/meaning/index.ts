/** Search by meaning: indexing in the background, its settings and its results. */

import '../styles/meaning.css';

import { subscribeLocale, t } from '../lib/i18n';
import { registerCommands } from '../shell/commands';
import { toast } from '../shell/toasts';
import { useProject } from '../state/project';
import { useSettings } from '../state/settings';
import { openMeaningSettings, searchByMeaning } from './discover';
import { startIndexing } from './store';

export { MeaningSettings } from './MeaningSettings';
export { MeaningStatusItem } from './StatusItem';
export { RelatedByMeaning } from './Related';
export { MeaningOffHint, openMeaningSettings, searchByMeaning } from './discover';
export { searchForAi } from './lore';

/** Runs again when the interface language changes, which replaces the titles. */
function registerMeaningCommands() {
  registerCommands([
    {
      id: 'meaning.search',
      title: t('Search by meaning…'),
      menu: 'Edit',
      order: 23,
      keywords: 'semantic similar passages ideas embeddings find',
      when: () => useProject.getState().status.open,
      run: () => {
        if (useSettings.getState().settings.ai.embeddings.enabled) return searchByMeaning();
        openMeaningSettings();
        toast(t('Search by meaning is off. Turn it on here first.'));
      },
    },
  ]);
}

export function registerMeaning() {
  registerMeaningCommands();
  subscribeLocale(registerMeaningCommands);
  startIndexing();
}
