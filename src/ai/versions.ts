/**
 * Versions of a conversation. Editing a message or asking for a reply again keeps what was
 * there: each message follows its parent, so a chat is a tree, and the screen shows one path
 * through it, from the first message to a leaf. Messages come in stored order, oldest first.
 */

export interface VersionNode {
  id: string;
  parentId?: string | null;
}

/** The messages that follow this one, or start the chat for null, oldest first. */
export function childrenOf<T extends VersionNode>(all: T[], parentId: string | null): T[] {
  return all.filter((m) => (m.parentId ?? null) === parentId);
}

/** The end of the newest line from here: at each fork, the latest version. */
export function newestLeaf<T extends VersionNode>(all: T[], fromId: string | null): string | null {
  let at = fromId;
  for (let guard = 0; guard <= all.length; guard += 1) {
    const children = childrenOf(all, at);
    if (children.length === 0) return at;
    at = children[children.length - 1].id;
  }
  return at;
}

/**
 * The messages on screen, first to last, for the version that ends at `leafId`. With no
 * leaf, or one that is gone, the newest message's line shows.
 */
export function activePath<T extends VersionNode>(all: T[], leafId: string | null | undefined): T[] {
  const byId = new Map(all.map((m) => [m.id, m]));
  let at: T | undefined = (leafId ? byId.get(leafId) : undefined) ?? all[all.length - 1];
  const path: T[] = [];
  const seen = new Set<string>();
  while (at && !seen.has(at.id)) {
    seen.add(at.id);
    path.push(at);
    at = at.parentId ? byId.get(at.parentId) : undefined;
  }
  return path.reverse();
}

export interface Versions {
  /** From 0. */
  index: number;
  count: number;
  ids: string[];
}

/** Which version this message is, among the others that follow the same message. */
export function versionsOf<T extends VersionNode>(all: T[], message: T): Versions {
  const ids = childrenOf(all, message.parentId ?? null).map((m) => m.id);
  return { index: Math.max(0, ids.indexOf(message.id)), count: Math.max(1, ids.length), ids };
}

/**
 * The leaf to show after moving `delta` versions from this message. The other version shows
 * as it was last continued. Null if there is no version that way.
 */
export function stepVersion<T extends VersionNode>(all: T[], message: T, delta: number): string | null {
  const { index, ids } = versionsOf(all, message);
  const target = ids[index + delta];
  return target ? newestLeaf(all, target) : null;
}
