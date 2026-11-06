/**
 * On a hover card in the manuscript: someone's age and what has changed about them, as of the
 * scene being written. Elsewhere there is no scene to speak of, so it shows nothing.
 */

import { useEffect } from 'react';

import * as api from '../lib/api';
import { ageFactFromFields } from '../lib/facts';
import { useLoad } from '../state/events';
import { useNav } from '../state/nav';
import { useStoryIndex, useStoryNames } from './hooks';
import { ageText, keyFacts } from './sceneFacts';
import { sceneMoment } from './storyIndex';

export function HoverFacts({ pageId, onShown }: { pageId: string; onShown?: () => void }) {
  const nodeId = useNav((s) => (s.route.view === 'write' ? s.route.nodeId : undefined));
  const index = useStoryIndex(!!nodeId);
  const names = useStoryNames(index);
  const { data: page } = useLoad(
    () => (nodeId ? api.pages.get(pageId).catch(() => null) : Promise.resolve(null)),
    [pageId, nodeId],
  );

  const node = nodeId ? index?.nodes.get(nodeId) : undefined;
  const ready = !!page && !!index && !!names && node?.kind === 'scene';

  // The card has to be placed again once it is taller.
  useEffect(() => {
    if (ready) onShown?.();
    // Only when the facts arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  if (!ready) return null;
  const fields = page.infobox?.fields ?? [];
  const moment = sceneMoment(index, node.id);
  const age = ageText(fields, moment, index.resolve, index.dates);
  const changed = keyFacts(fields, moment, names, ageFactFromFields(fields, moment, index.resolve, index.dates))
    .filter((fact) => (fields.find((f) => f.key === fact.key)?.changes?.length ?? 0) > 0);
  if (!age && changed.length === 0) return null;
  return (
    <p className="wiki-hovercard-summary facts-hover" data-testid="hover-facts">
      {[age, ...changed.map((fact) => `${fact.label}: ${fact.value}`)].filter(Boolean).join('. ')}.
    </p>
  );
}
