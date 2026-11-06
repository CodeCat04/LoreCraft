/** The Writing styles screen. */

import { useEffect } from 'react';

import { t } from '../lib/i18n';
import { useLocale } from '../state/language';
import { useProject } from '../state/project';
import { BlendTab } from './BlendTab';
import { BrowseTab } from './BrowseTab';
import { BuildTab } from './BuildTab';
import { GuideTab } from './GuideTab';
import { MineTab } from './MineTab';
import { goToTab, useStylesUi, type StylesTab } from './uiStore';

const TABS: { id: StylesTab; needsProject?: boolean }[] = [
  { id: 'browse' },
  { id: 'blend' },
  { id: 'mine' },
  { id: 'guide', needsProject: true },
  { id: 'build', needsProject: true },
];

function tabLabel(id: StylesTab): string {
  switch (id) {
    case 'browse': return t('Browse');
    case 'blend': return t('Blend');
    case 'mine': return t('My styles');
    case 'guide': return t('Your style guide');
    case 'build': return t('Build from my writing');
  }
}

function isTab(tab: string | undefined): tab is StylesTab {
  return TABS.some((t) => t.id === tab);
}

export function StylesScreen({ tab }: { tab?: string }) {
  useLocale();
  const stored = useStylesUi((s) => s.tab);
  const open = useProject((s) => s.status.open);
  const active: StylesTab = isTab(tab) ? tab : stored;

  useEffect(() => {
    if (isTab(tab) && tab !== stored) useStylesUi.getState().set({ tab });
  }, [tab, stored]);

  return (
    <div className="styles-page" data-testid="styles-page">
      <header className="styles-head">
        <h1 className="styles-title">{t('Writing styles')}</h1>
        <div className="settings-tabs styles-tabs" role="tablist" aria-label={t('Writing styles')}>
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`styles-tab-${item.id}`}
              aria-selected={active === item.id}
              aria-controls="styles-panel"
              title={item.needsProject && !open ? t('Needs an open project') : undefined}
              className={`settings-tab${active === item.id ? ' is-active' : ''}`}
              onClick={() => goToTab(item.id)}
            >
              {tabLabel(item.id)}
            </button>
          ))}
        </div>
      </header>
      <div className="styles-panel" id="styles-panel" role="tabpanel" aria-labelledby={`styles-tab-${active}`}>
        {active === 'browse' && <BrowseTab />}
        {active === 'blend' && <BlendTab />}
        {active === 'mine' && <MineTab />}
        {active === 'guide' && <GuideTab />}
        {active === 'build' && <BuildTab />}
      </div>
    </div>
  );
}

/** The route's screen. Each visit starts from what the route says, or the last tab used. */
export function StylesView({ tab }: { tab?: string }) {
  return <StylesScreen tab={tab} />;
}
