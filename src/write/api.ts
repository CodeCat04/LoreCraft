/** Native calls for the write module. The shared book and node calls live in `lib/api`. */

import { rpc } from '../lib/rpc';
import type { NodeMeta, PageStatus, PmNode } from '../lib/types';

export { books, nodes, project, type NodeCreate, type NodePatch } from '../lib/api';

export interface SceneMention {
  pageId: string;
  title: string;
  pageType: string;
  status: PageStatus;
  /** Times the page is named in the scene. */
  count: number;
}

/** The wiki pages named in a scene, most mentioned first. */
export const sceneMentions = (id: string) => rpc<SceneMention[]>('nodes.mentions', { id });

/** Cuts a scene in two. The new scene comes straight after it and is returned. */
export const splitScene = (id: string, before: PmNode, after: PmNode) =>
  rpc<NodeMeta>('nodes.split', { id, before, after });

/** Moves the next scene onto the end of this one, and puts it in the trash. */
export const mergeScene = (id: string) => rpc<NodeMeta>('nodes.merge', { id });

export interface BookPresence {
  mentions: { nodeId: string; pageId: string; count: number }[];
  cast: { nodeId: string; pageId: string }[];
}

/** Which pages each scene of a book names or has in its cast. */
export const bookPresence = (bookId: string) => rpc<BookPresence>('nodes.presence', { bookId });

export interface Thread {
  id: string;
  name: string;
  /** The name of a theme token. */
  color: string;
  description: string;
  position: number;
}

export interface ThreadLink {
  nodeId: string;
  threadId: string;
}

export const threads = {
  list: () => rpc<Thread[]>('threads.list'),
  create: (name: string, color?: string) => rpc<Thread>('threads.create', { name, color }),
  update: (id: string, patch: Partial<Pick<Thread, 'name' | 'color' | 'description'>>) =>
    rpc<boolean>('threads.update', { id, patch }),
  remove: (id: string) => rpc<boolean>('threads.delete', { id }),
  reorder: (ids: string[]) => rpc<boolean>('threads.reorder', { ids }),
  links: (bookId: string) => rpc<ThreadLink[]>('threads.links', { bookId }),
  setLink: (nodeId: string, threadId: string, on: boolean) =>
    rpc<boolean>('threads.setLink', { nodeId, threadId, on }),
};

/** Deletes an item in the trash for good, with what is inside it and its saved versions. */
export const purgeNode = (id: string) => rpc<boolean>('nodes.purge', { id });

/** Deletes everything in a book's trash for good. */
export const emptyNodeTrash = (bookId: string) => rpc<boolean>('nodes.emptyTrash', { bookId });
