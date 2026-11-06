/** What an article shows without being written: first appearance and infobox back-links. */

import { useMemo } from 'react';

import { wikiPages, type FirstAppearance, type InfoboxLinkGroup } from './api';
import { PageLink, RouteLink } from './links';
import { typePlural } from './templates';
import { useDataVersion, useLoad } from '../state/events';
import { t } from '../lib/i18n';
import { useLocale } from '../state/language';

/** Where a page first appears in the manuscript, or null if it does not yet. */
export function useFirstAppearance(id: string): FirstAppearance | null {
  const version = useDataVersion('pages', 'nodes', 'nodeContent', 'books');
  const { data } = useLoad(() => wikiPages.firstAppearance(id), [id, version]);
  return data ?? null;
}

export function FirstAppearanceLink({ scene }: { scene: FirstAppearance }) {
  return (
    <RouteLink route={{ view: 'write', bookId: scene.bookId, nodeId: scene.nodeId }}>
      {scene.label}
    </RouteLink>
  );
}

/** "Affiliation of: Characters: Aria, Bram", built from other pages' infobox fields. */
export function LinkedFromInfoboxes({ id }: { id: string }) {
  useLocale();
  const version = useDataVersion('pages', 'pageContent');
  const { data: groups } = useLoad(() => wikiPages.infoboxLinks(id), [id, version]);

  const byLabel = useMemo(() => {
    const labels = new Map<string, InfoboxLinkGroup[]>();
    for (const group of groups ?? []) {
      const list = labels.get(group.label);
      if (list) list.push(group);
      else labels.set(group.label, [group]);
    }
    return [...labels];
  }, [groups]);

  if (byLabel.length === 0) return null;
  return (
    <section className="wiki-linked" aria-labelledby="wiki-linked-title">
      <h2 id="wiki-linked-title" className="wiki-section-title">{t('Linked from infoboxes')}</h2>
      <dl className="wiki-linked-list">
        {byLabel.map(([label, list]) => (
          <div key={label} className="wiki-linked-row">
            <dt>{t('{label} of', { label })}</dt>
            <dd>
              {list.map((group) => (
                <p key={group.pageType} data-page-type={group.pageType}>
                  {list.length > 1 && <span className="wiki-linked-type">{typePlural(group.pageType)}: </span>}
                  {group.pages.map((page, index) => (
                    <span key={page.id}>
                      <PageLink id={page.id} title={page.title} />
                      {index < group.pages.length - 1 && ', '}
                    </span>
                  ))}
                </p>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
