import { t, subscribeLocale } from '../../lib/i18n';
import { registerCommands } from '../../shell/commands';
import { toast } from '../../shell/toasts';
import { activeEditor } from '../ai/registry';
import { planLink, runLinkPlan } from './actions';

export { LinkButton } from './LinkButton';
export { askForNewPage, type NewPageChoice } from './PageDialog';

export function registerMakePage() {
  registerMakePageCommands();
  // The titles are read when registered, so a new language registers them again.
  subscribeLocale(registerMakePageCommands);
}

function registerMakePageCommands() {
  registerCommands([
    {
      id: 'makePage.link',
      title: t('Link or make a page from the selection'),
      shortcut: 'Alt+L',
      menu: 'Insert',
      order: 15,
      keywords: 'wiki link create new',
      when: () => activeEditor() !== null,
      run: async () => {
        const entry = activeEditor();
        if (!entry) return;
        const { from, to, empty } = entry.editor.state.selection;
        const plan = planLink(entry.editor, entry.source, from, to);
        if (plan) await runLinkPlan(entry.editor, entry.source, plan);
        else toast(empty ? t('Select a name to link first.') : t('There is nothing to link in this selection.'));
      },
    },
  ]);
}
