/**
 * "Who's here" in the scene details: the point of view and cast, with their age and key facts
 * as of this scene. It works from the scene as it stands on screen, so changing the scene's
 * date updates it at once.
 */

import { useMemo } from 'react';

import * as api from '../lib/api';
import { t } from '../lib/i18n';
import { ageFactFromFields, type StoryMoment } from '../lib/facts';
import type { NodeMeta, Page } from '../lib/types';
import { useDataVersion, useLoad } from '../state/events';
import { useLocale } from '../state/language';
import { useNav } from '../state/nav';
import { useStoryIndex, useStoryNames } from './hooks';
import { ageText, keyFacts } from './sceneFacts';
import { sceneMoment, type StoryIndex } from './storyIndex';

function useCast(sceneId: string): string[] {
  const version = useDataVersion('nodes', 'pages');
  const { data } = useLoad(() => api.nodes.cast(sceneId).catch(() => [] as string[]), [sceneId, version]);
  return data ?? [];
}

function PersonFacts(props: { page: Page; isPov: boolean; moment: StoryMoment; index: StoryIndex }) {
  useLocale();
  const { page, isPov, moment, index } = props;
  const go = useNav((s) => s.go);
  const names = useStoryNames(index);
  const fields = page.infobox?.fields ?? [];
  if (!names) return null;
  const age = ageText(fields, moment, index.resolve, index.dates);
  const facts = keyFacts(fields, moment, names, ageFactFromFields(fields, moment, index.resolve, index.dates));
  return (
    <li className="facts-person" data-person={page.title}>
      <div className="facts-person-head">
        <button
          type="button"
          className="link-button facts-person-name"
          data-wiki-target={page.title}
          onClick={() => go({ view: 'page', id: page.id })}
        >
          <span className="truncate">{page.title}</span>
        </button>
        {isPov && <span className="faint small">{t('Point of view')}</span>}
      </div>
      {age && <p className="facts-age" data-fact="age">{age}</p>}
      {facts.length > 0 && (
        <dl className="facts-list">
          {facts.map((fact) => (
            <div key={fact.key} className="facts-list-row" data-fact={fact.key}>
              <dt>{fact.label}</dt>
              <dd>
                {fact.value}
                {fact.since && <span className="faint"> {fact.since}</span>}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {!age && facts.length === 0 && <p className="faint small">{t('Nothing recorded on this page yet.')}</p>}
    </li>
  );
}

export function WhosHere({ node }: { node: NodeMeta }) {
  useLocale();
  const cast = useCast(node.id);
  const pov = node.povPageId;
  const ids = useMemo(() => [...new Set([...(pov ? [pov] : []), ...cast])], [pov, cast]);
  const index = useStoryIndex(ids.length > 0);
  const pagesVersion = useDataVersion('pages', 'pageContent');
  const { data: pages } = useLoad(
    () => Promise.all(ids.map((id) => api.pages.get(id).catch(() => null))),
    [ids.join(), pagesVersion],
  );
  const moment = useMemo<StoryMoment | null>(
    () => (index ? sceneMoment(index, node.id, node.storyDate) : null),
    [index, node.id, node.storyDate],
  );
  const people = (pages ?? []).filter((page): page is Page => !!page && !page.deletedAt);

  return (
    <section className="details-section facts-here" aria-labelledby="details-whos-here" data-testid="whos-here">
      <h3 id="details-whos-here" className="details-heading">{t("Who's here")}</h3>
      {ids.length === 0 && <p className="muted small">{t('Choose a point of view or cast to see their facts as of this scene.')}</p>}
      {index && moment && people.length > 0 && (
        <ul className="facts-people">
          {people.map((page) => (
            <PersonFacts key={page.id} page={page} isPov={page.id === pov} moment={moment} index={index} />
          ))}
        </ul>
      )}
      {moment && people.length > 0 && (moment.dateSort === null || moment.dateInferred) && (
        <p className="muted small">{t('Give this scene an in-world date to see ages.')}</p>
      )}
    </section>
  );
}
