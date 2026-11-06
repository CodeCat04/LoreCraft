/**
 * "Suggest wiki updates from this chapter", from the command palette and offered when a chapter
 * is marked final. The proposals appear on the Consistency screen, and nothing changes until
 * the writer approves it. A cloud profile asks first, with the cost estimate, as other runs do.
 */

import { listen } from '@tauri-apps/api/event';

import { activeEditor } from '../editor/ai/registry';
import * as coreApi from '../lib/api';
import { t } from '../lib/i18n';
import type { NodeMeta } from '../lib/types';
import { toast } from '../shell/toasts';
import { useNav } from '../state/nav';
import { useProject } from '../state/project';
import { startWikiUpdates } from './store';

/** Goes to the Consistency screen, where the proposals appear, and starts. */
export function suggestWikiUpdates(chapterId: string, chapterTitle: string): Promise<void> {
  useNav.getState().go({ view: 'consistency' });
  return startWikiUpdates(chapterId, chapterTitle || t('Untitled chapter'));
}

/** The chapter holding a node, walking up through parts and scenes. */
export function chapterOf(tree: NodeMeta[], nodeId: string): NodeMeta | null {
  const byId = new Map(tree.map((node) => [node.id, node]));
  let node = byId.get(nodeId);
  while (node && node.kind !== 'chapter') node = node.parentId ? byId.get(node.parentId) : undefined;
  return node ?? null;
}

/** The chapter of the scene on screen, if there is one. */
async function currentChapter(): Promise<NodeMeta | null> {
  const route = useNav.getState().route;
  const entry = activeEditor();
  const nodeId = route.view === 'write' && route.nodeId ? route.nodeId : entry?.source.kind === 'node' ? entry.source.id : null;
  if (!nodeId) return null;
  const node = await coreApi.nodes.get(nodeId).catch(() => null);
  if (!node) return null;
  return chapterOf(await coreApi.nodes.tree(node.bookId), nodeId);
}

export async function suggestForCurrentChapter(): Promise<void> {
  const chapter = await currentChapter();
  if (chapter) return suggestWikiUpdates(chapter.id, chapter.title);
  // The Consistency screen has a chapter picker.
  useNav.getState().go({ view: 'consistency' });
  toast(t('Pick a scene in the chapter, then choose Suggest wiki updates from this chapter.'));
}

/** Chapters that are final now, which ones newly marked final are found against. */
async function finalChapters(): Promise<Map<string, NodeMeta>> {
  const found = new Map<string, NodeMeta>();
  for (const book of await coreApi.books.list()) {
    for (const node of await coreApi.nodes.tree(book.id)) {
      if (node.kind === 'chapter' && node.status === 'final') found.set(node.id, node);
    }
  }
  return found;
}

/** Offers suggestions when the writer marks a chapter final. Runs once at startup. */
export function offerWhenChaptersAreFinal(): void {
  let known: Map<string, NodeMeta> | null = null;
  /** Goes up when another project opens, so chapters from the last one never count. */
  let epoch = 0;
  let timer: number | undefined;
  let checking = false;
  let again = false;

  const forget = () => {
    known = null;
    epoch += 1;
  };

  const check = async (): Promise<void> => {
    if (checking) {
      again = true;
      return;
    }
    if (!useProject.getState().status.open) return;
    checking = true;
    const at = epoch;
    try {
      const now = await finalChapters();
      if (at !== epoch) {
        again = true;
        return;
      }
      const before = known;
      known = now;
      if (!before) return;
      for (const [id, chapter] of now) {
        if (before.has(id)) continue;
        const title = chapter.title || t('Untitled chapter');
        toast(t('“{chapter}” is marked final. The AI can suggest wiki updates from it.', { chapter: title }), 'info', {
          label: t('Suggest wiki updates'),
          run: () => void suggestWikiUpdates(id, title),
        });
      }
    } catch {
      // The project closed meanwhile. The next change starts over.
    } finally {
      checking = false;
      if (again) {
        again = false;
        void check();
      }
    }
  };

  useProject.subscribe((state, previous) => {
    if (state.status.open === previous.status.open) return;
    forget();
    if (state.status.open) void check();
  });
  void listen<{ entity: string }>('data://changed', (event) => {
    if (event.payload.entity === 'all') {
      forget();
      void check();
      return;
    }
    if (event.payload.entity !== 'nodes') return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void check(), 800);
  }).catch(() => {});
}
