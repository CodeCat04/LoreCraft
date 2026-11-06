/** What the media library reads, and what it does to documents when a label changes. */

import * as api from '../lib/api';
import type { AssetInfo } from '../lib/assets';
import { rpc } from '../lib/rpc';
import type { PmNode } from '../lib/types';
import { relabelFigures, type LabelChange } from './relabel';

export interface LibraryItem extends AssetInfo {
  /** The label of the first figure showing it, or the one set here if there is none. */
  label: string;
  description: string;
  /** How many live pages, scenes and maps show it. */
  uses: number;
  /** Whether anything at all mentions it, including the trash and saved versions. */
  inUse: boolean;
}

export interface MediaUse {
  kind: 'page' | 'node' | 'map';
  id: string;
  title: string;
  bookId: string | null;
  /** In the trash. It still counts, because it can come back. */
  deleted: boolean;
  where: 'content' | 'infobox' | 'notes' | 'map';
  /** The document, when the use is in one. */
  content: PmNode | null;
}

export interface MediaUsage {
  uses: MediaUse[];
  /** Also mentioned somewhere that is not listed, such as a saved version of a page. */
  elsewhere: boolean;
}

export type LibraryFilter = 'all' | 'image' | 'video' | 'audio' | 'pdf' | 'unused';

export const fetchLibrary = () => rpc<{ items: LibraryItem[] }>('media.library').then((result) => result.items);

export const fetchUsage = (id: string) => rpc<MediaUsage>('media.usage', { id });

export function filterLibrary(items: LibraryItem[], filter: LibraryFilter, query: string): LibraryItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    if (filter === 'unused' ? item.inUse : filter !== 'all' && item.kind !== filter) return false;
    if (words.length === 0) return true;
    const text = `${item.name} ${item.label} ${item.description}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/**
 * Stores a new label and description, and updates the figures that should follow it.
 * Trashed documents and saved versions stay as they were.
 */
export async function saveLabels(item: LibraryItem, label: string, description: string) {
  const change: LabelChange = {
    oldLabel: item.label,
    newLabel: label,
    oldDescription: item.description,
    newDescription: description,
  };
  const { uses } = await fetchUsage(item.id);
  let changed = 0;
  let kept = 0;
  for (const use of uses) {
    if (use.deleted || !use.content) continue;
    const result = relabelFigures(use.content, item.id, change);
    kept += result.kept;
    if (result.changed === 0) continue;
    if (use.kind === 'page') await api.pages.update(use.id, { content: result.doc });
    else await api.nodes.update(use.id, { content: result.doc });
    changed += result.changed;
  }
  await rpc('media.setLabel', { id: item.id, label, description });
  return { changed, kept };
}
