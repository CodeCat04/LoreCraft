/** The story's index and the project's dates, kept current for the screens that show them. */

import { useEffect, useMemo, useState } from 'react';

import { getDateContext, type DateContext } from '../lib/storyDate';
import { useDataVersion, useLoad } from '../state/events';
import { loadStoryIndex, nodeLabel, type StoryIndex } from './storyIndex';
import type { StoryNames } from './history';

/** The story's index. Null while it loads, or when not needed. */
export function useStoryIndex(needed = true): StoryIndex | null {
  const version = useDataVersion('nodes', 'books', 'meta');
  const [index, setIndex] = useState<StoryIndex | null>(null);
  useEffect(() => {
    if (!needed) return undefined;
    let cancelled = false;
    void loadStoryIndex().then(
      (next) => {
        if (!cancelled) setIndex(next);
      },
      () => {
        if (!cancelled) setIndex(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [needed, version]);
  return needed ? index : null;
}

/** The last dates read, so that a screen opening does not flash a warning about a good date. */
let lastDates: DateContext = { eras: [], calendar: null };

/** The project's eras and calendar, kept current. */
export function useDateContext(): DateContext {
  const version = useDataVersion('meta');
  const { data } = useLoad(() => getDateContext(), [version]);
  if (data) lastDates = data;
  return data ?? lastDates;
}

export function useStoryNames(index: StoryIndex | null): StoryNames | null {
  return useMemo(
    () => (index ? { resolve: index.resolve, nodeLabel: (id: string) => nodeLabel(index, id) } : null),
    [index],
  );
}
