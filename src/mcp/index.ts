import '../styles/mcp.css';

import { subscribeLocale, t } from '../lib/i18n';
import { registerCommands } from '../shell/commands';
import { useNav } from '../state/nav';
import { useProject } from '../state/project';
import { useSettings } from '../state/settings';
import { startAutoApply } from './auto';
import { showPinnedList } from './ProposalsView';

export { McpSettings } from './McpSettings';
export { ProposalsBadge, ProposalsView } from './ProposalsView';

/** Runs again when the interface language changes, which replaces the titles. */
function registerMcpCommands() {
  registerCommands([
    {
      id: 'mcp.proposals',
      title: t('Outside suggestions'),
      menu: 'AI',
      order: 80,
      keywords: 'mcp proposals claude code opencode review',
      when: () => useProject.getState().status.open,
      // Pinned, the list opens beside the writing, as from the badge.
      run: () => (useSettings.getState().settings.mcp.pinned ? showPinnedList() : useNav.getState().go({ view: 'proposals' })),
    },
    {
      id: 'mcp.settings',
      title: t('AI tools outside LoreCraft…'),
      menu: 'AI',
      order: 81,
      keywords: 'mcp claude code opencode connect',
      run: () => useNav.getState().go({ view: 'settings', tab: 'mcp' }),
    },
  ]);
}

export function registerMcp() {
  registerMcpCommands();
  startAutoApply();
  subscribeLocale(registerMcpCommands);
}
