/** The story planning wizard's commands, for the menus and the palette. */

import { registerCommands } from '../shell/commands';
import { subscribeLocale, t } from '../lib/i18n';
import { areaOf, useNav } from '../state/nav';
import { useProject } from '../state/project';
import { useWrite } from '../write/store';
import { openApplyStructure } from './ApplyStructure';
import { registerPlanStore } from './store';

const hasProject = () => useProject.getState().status.open;
const hasBook = () => hasProject() && !!useWrite.getState().bookId && areaOf(useNav.getState().route) === 'write';

export function openPlanWizard(bookId?: string) {
  useNav.getState().go(bookId ? { view: 'plan', bookId } : { view: 'plan' });
}

function registerPlanCommands() {
  // Story planning: one block, kept apart from the other drafting help.
  registerCommands([
    {
      id: 'plan.wizard',
      title: t('Plan a story…'),
      menu: 'Insert',
      order: 16,
      when: hasProject,
      keywords: 'wizard outline braindump synopsis characters world structure new book plan',
      run: () => openPlanWizard(),
    },
    {
      id: 'plan.applyStructure',
      title: t('Apply a story structure…'),
      menu: 'Insert',
      order: 17,
      when: hasBook,
      keywords: 'template beats three act hero journey story circle seven point beat sheet romance mystery outline corkboard',
      run: () => void openApplyStructure(),
    },
  ]);
}

export function registerPlan() {
  registerPlanStore();
  registerPlanCommands();
  subscribeLocale(registerPlanCommands);
}
