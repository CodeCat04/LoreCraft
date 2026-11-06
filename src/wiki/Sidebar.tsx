/** The wiki's sidebar: navigation first, then tools, then every kind of page. */

import { useMemo, type ReactNode } from 'react';

import { randomPage } from './actions';
import { openNewPageDialog } from './NewPageDialog';
import { openPageTypes } from './PageTypesDialog';
import { usePageTypes } from './pageTypes';
import { isBuiltInType, typeLabel, typePlural } from './templates';
import { useOpenIdeaCount } from '../inbox/api';
import { useLocale } from '../state/language';
import { useNav, type Route } from '../state/nav';
import { useProject, useTitles } from '../state/project';
import { t } from '../lib/i18n';
import { refDragProps } from '../canvas/refDrag';
import type { LoreRef } from '../canvas/model';

function NavLink(props: { route: Route; children: ReactNode; active?: boolean; count?: number; dragRef?: LoreRef }) {
  const current = useNav((s) => s.route);
  const go = useNav((s) => s.go);
  const active = props.active ?? JSON.stringify(current) === JSON.stringify(props.route);
  return (
    <button
      type="button"
      className={`nav-link${active ? ' is-active' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={() => go(props.route)}
      {...refDragProps(props.dragRef ?? (props.route.view === 'page' ? { kind: 'page', id: props.route.id } : null))}
    >
      {props.children}
      {props.count !== undefined && <span className="wiki-nav-count"> {props.count.toLocaleString()}</span>}
    </button>
  );
}

function NavAction({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="nav-link" onClick={onClick}>
      {children}
    </button>
  );
}

export function WikiSidebar() {
  useLocale();
  const name = useProject((s) => s.status.name);
  const entries = useTitles((s) => s.entries);
  const openIdeas = useOpenIdeaCount();
  const homeId = entries.find((e) => e.pageType === 'home')?.id;
  const types = usePageTypes((s) => s.types);
  const counts = useMemo(() => {
    const byType = new Map<string, number>();
    for (const entry of entries) byType.set(entry.pageType, (byType.get(entry.pageType) ?? 0) + 1);
    return byType;
  }, [entries]);
  // A deleted type, or one from an import, still has its pages.
  const otherTypes = [...counts.keys()]
    .filter((type) => type !== 'home' && !types.some((t) => t.type === type))
    .sort();

  return (
    <>
      <div className="nav-title">{name}</div>
      <nav className="nav-section" aria-label={t('Wiki')}>
        <NavLink route={{ view: 'home' }} dragRef={homeId ? { kind: 'page', id: homeId } : undefined}>{t('Main page')}</NavLink>
        <NavLink route={{ view: 'allPages' }}>{t('All pages')}</NavLink>
        <NavLink route={{ view: 'categories' }}>{t('Categories')}</NavLink>
        <NavLink route={{ view: 'recent' }}>{t('Recent changes')}</NavLink>
        <NavAction onClick={() => void randomPage()}>{t('Random page')}</NavAction>
        <NavAction onClick={() => void openNewPageDialog()}>{t('New page')}</NavAction>
      </nav>
      <nav className="nav-section" aria-label={t('Tools')}>
        <div className="nav-heading">{t('Tools')}</div>
        <NavLink route={{ view: 'wanted' }}>{t('Wanted pages')}</NavLink>
        <NavLink route={{ view: 'orphans' }}>{t('Orphaned pages')}</NavLink>
        <NavLink route={{ view: 'stubs' }}>{t('Short pages')}</NavLink>
        <NavLink route={{ view: 'replace' }}>{t('Find and replace')}</NavLink>
        <NavLink route={{ view: 'notes' }}>{t('Comments and to-dos')}</NavLink>
        <NavLink route={{ view: 'trash' }}>{t('Trash')}</NavLink>
        <NavLink route={{ view: 'inbox' }} count={openIdeas}>{t('Inbox')}</NavLink>
        <NavAction onClick={() => void openPageTypes()}>{t('Page types')}</NavAction>
      </nav>
      <nav className="nav-section" aria-label={t('Page types')}>
        <div className="nav-heading">{t('Page types')}</div>
        {types.map((template) => (
          <NavLink
            key={template.type}
            route={{ view: 'allPages', pageType: template.type }}
            count={counts.get(template.type) ?? 0}
          >
            {isBuiltInType(template.type) ? typePlural(template.type) : template.plural}
          </NavLink>
        ))}
        {otherTypes.map((type) => (
          <NavLink key={type} route={{ view: 'allPages', pageType: type }} count={counts.get(type)}>
            {typeLabel(type)}
          </NavLink>
        ))}
      </nav>
    </>
  );
}
