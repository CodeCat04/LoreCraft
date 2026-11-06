/** The "Related by meaning" part of the search results. */

import { useEffect, useState } from 'react';

import { t } from '../lib/i18n';
import { useLocale } from '../state/language';
import { useSettings } from '../state/settings';
import { useDataVersion } from '../state/events';
import { PageLink, RouteLink } from '../wiki/links';
import { errorMessage } from '../lib/rpc';
import { meaningApi, type MeaningHit } from './api';
import { MeaningOffHint } from './discover';
import { useMeaning } from './store';

const LIMIT = 12;

export function RelatedByMeaning({ q, kind }: { q: string; kind: 'page' | 'node' | '' }) {
  useLocale();
  const enabled = useSettings((s) => s.settings.ai.embeddings.enabled);
  const state = useMeaning((s) => s.status?.state);
  const version = useDataVersion('pages', 'pageContent', 'nodeContent');
  const [hits, setHits] = useState<MeaningHit[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const indexing = state === 'indexing';
  // While indexing, new results appear as passages arrive, but not on every batch.
  const done = useMeaning((s) => (indexing ? Math.floor((s.status?.done ?? 0) / 200) : -1));

  useEffect(() => {
    if (!enabled) {
      setHits(null);
      setProblem(null);
      return;
    }
    let cancelled = false;
    meaningApi
      .hybrid({ q, limit: LIMIT * 2, kinds: kind ? [kind] : undefined })
      .then(({ results, problem: reason }) => {
        if (cancelled) return;
        setHits(results.filter((hit) => hit.matchedBy?.includes('meaning')).slice(0, LIMIT));
        setProblem(reason);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setHits([]);
        setProblem(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [q, kind, enabled, version, state, done]);

  if (!enabled) return <MeaningOffHint />;
  if (hits === null) return null;
  if (hits.length === 0 && !problem && !indexing) return null;
  return (
    <section className="meaning-related" aria-label={t('Related by meaning')} data-testid="meaning-related">
      <h2 className="meaning-related-head">{t('Related by meaning')}</h2>
      {problem && <p className="field-error" role="alert">{problem}</p>}
      {indexing && <p className="muted small">{t('The index is still being built, so this may not be everything.')}</p>}
      <ul className="wiki-search-results">
        {hits.map((hit) => (
          <li key={`${hit.kind}:${hit.id}`} className="wiki-search-hit">
            <div className="wiki-search-title">
              {hit.kind === 'page' ? (
                <PageLink id={hit.id} title={hit.title} />
              ) : (
                <RouteLink route={{ view: 'write', bookId: hit.bookId ?? undefined, nodeId: hit.id }}>
                  {hit.title || t('Untitled scene')}
                </RouteLink>
              )}
              {hit.kind === 'node' && <span className="badge">{t('Scene')}</span>}
            </div>
            <p className="wiki-search-snippet meaning-passage">{hit.snippet}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
