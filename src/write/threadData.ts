/** Loading plot threads, shared by the details panel and the board. */

import { useCallback, useEffect, useState } from 'react';

import { threads as threadsApi, type Thread, type ThreadLink } from './api';
import { THREAD_COLORS } from './charts';
import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { promptText } from '../shell/dialogs';
import { toast } from '../shell/toasts';
import { useDataVersion, useLoad } from '../state/events';

const NO_THREADS: Thread[] = [];
const NO_LINKS: ThreadLink[] = [];

function changed(links: ThreadLink[], nodeId: string, threadId: string, on: boolean): ThreadLink[] {
  const others = links.filter((l) => l.nodeId !== nodeId || l.threadId !== threadId);
  return on ? [...others, { nodeId, threadId }] : others;
}

export function useThreadData(bookId: string | null) {
  const version = useDataVersion('threads', 'nodes');
  const { data } = useLoad(
    async () => {
      const [threads, links] = await Promise.all([
        threadsApi.list(),
        bookId ? threadsApi.links(bookId) : Promise.resolve(NO_LINKS),
      ]);
      return { threads, links };
    },
    [bookId, version],
  );
  // A ticked box shows at once, ahead of the answer from the store.
  const [links, setLinks] = useState(NO_LINKS);
  useEffect(() => setLinks(data?.links ?? NO_LINKS), [data]);
  const setLink = useCallback((nodeId: string, threadId: string, on: boolean) => {
    setLinks((now) => changed(now, nodeId, threadId, on));
    threadsApi.setLink(nodeId, threadId, on).catch((e) => {
      setLinks((now) => changed(now, nodeId, threadId, !on));
      toast(t('Could not change the plot thread: {reason}', { reason: errorMessage(e) }), 'error');
    });
  }, []);
  return { threads: data?.threads ?? NO_THREADS, links, setLink };
}

/** Asks for a name and makes a thread, in the next color along. */
export async function addThread(): Promise<Thread | null> {
  const name = await promptText({
    title: t('New plot thread'),
    label: t('Name'),
    placeholder: t('The missing heir'),
    confirmLabel: t('Add'),
    validate: (v) => (v.trim() ? null : t('A thread needs a name.')),
  });
  if (!name) return null;
  try {
    const existing = await threadsApi.list();
    return await threadsApi.create(name.trim(), THREAD_COLORS[existing.length % THREAD_COLORS.length]);
  } catch (e) {
    toast(t('Could not add the thread: {reason}', { reason: errorMessage(e) }), 'error');
    return null;
  }
}
