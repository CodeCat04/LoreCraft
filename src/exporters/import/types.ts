/** What importers produce and what the native import reports. See `rpc/import.rs`. */

import type { BookPublishing, PmNode } from '../../lib/types';

export type ConflictPolicy = 'skip' | 'rename' | 'overwrite';

export interface ImportProblem {
  severity: 'error' | 'warning';
  /** Which item, such as `pages[3] "Aria Vale"`. */
  item: string;
  /** Which field of it, such as `status`. Empty when it is about the whole item. */
  field: string;
  message: string;
}

export interface PayloadField {
  key: string;
  label: string;
  kind: string;
  value: string;
}

export interface PayloadInfobox {
  imageAssetId?: string;
  caption?: string;
  fields: PayloadField[];
}

export interface PayloadPage {
  /** Where this came from, for messages about it. */
  source?: string;
  id?: string;
  title: string;
  pageType?: string;
  status?: string;
  summary?: string;
  aliases?: string[];
  categories?: string[];
  infobox?: PayloadInfobox;
  content?: PmNode;
  notes?: PmNode | null;
  isHome?: boolean;
  revealNodeId?: string | null;
  /** Marks the page as never sent to a cloud AI. An import sets the mark but never clears it. */
  localOnly?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface PayloadNode {
  source?: string;
  id?: string;
  kind: 'part' | 'chapter' | 'scene';
  title: string;
  status?: string;
  synopsis?: string;
  notes?: string;
  storyDate?: string;
  targetWords?: number;
  pov?: string | null;
  location?: string | null;
  cast?: string[];
  threads?: string[];
  content?: PmNode;
  /** As on a page. */
  localOnly?: boolean;
  createdAt?: string;
  updatedAt?: string;
  children?: PayloadNode[];
}

export interface PayloadBook {
  source?: string;
  title?: string;
  subtitle?: string;
  author?: string;
  targetWords?: number;
  createdAt?: string;
  updatedAt?: string;
  publishing?: BookPublishing;
  /** Adds to a book already in the project, instead of making one. */
  intoBookId?: string;
  intoParentId?: string;
  writingLog?: { day: string; wordsAdded: number; wordsRemoved: number }[];
  children?: PayloadNode[];
}

/** Either the bytes, or a path the person chose in a dialog, which the native side reads. */
export interface PayloadAsset {
  id: string;
  name: string;
  mime: string;
  base64?: string;
  path?: string;
  width?: number | null;
  height?: number | null;
  createdAt?: string;
}

export interface ImportPayload {
  policy: ConflictPolicy;
  pages: PayloadPage[];
  books: PayloadBook[];
  relationships: { from: string; to: string; kind?: string; note?: string; createdAt?: string }[];
  assets: PayloadAsset[];
  maps: unknown[];
  dictionary: string[];
  prompts: unknown[];
  /** Optional, so payloads from before canvases still type-check. */
  canvases?: unknown[];
  threads: { id?: string; name: string; color?: string; description?: string; position?: number }[];
  meta: Record<string, string>;
}

export function emptyPayload(policy: ConflictPolicy = 'skip'): ImportPayload {
  return { policy, pages: [], books: [], relationships: [], assets: [], maps: [], dictionary: [], prompts: [], threads: [], meta: {} };
}

export interface Normalized {
  payload: ImportPayload;
  /** Problems found reading the source, before the native side sees anything. */
  problems: ImportProblem[];
}

export interface ImportItem {
  kind: 'page' | 'book';
  source: string;
  title: string;
  action: 'create' | 'rename' | 'overwrite' | 'skip' | 'extend';
  finalTitle: string;
  id?: string;
  chapters: number;
  scenes: number;
}

export interface ImportCounts {
  pagesCreated: number;
  pagesRenamed: number;
  pagesOverwritten: number;
  pagesSkipped: number;
  booksCreated: number;
  booksRenamed: number;
  booksOverwritten: number;
  booksSkipped: number;
  booksExtended: number;
  nodesCreated: number;
  nodesUpdated: number;
  nodesRemoved: number;
  assetsCreated: number;
  assetsReused: number;
  relationshipsCreated: number;
  relationshipsSkipped: number;
  mapsCreated: number;
  mapsOverwritten: number;
  mapsSkipped: number;
  dictionaryAdded: number;
  promptsCreated: number;
  threadsCreated: number;
  revisionsTaken: number;
}

export interface ImportReport {
  applied: boolean;
  counts: ImportCounts;
  items: ImportItem[];
  problems: ImportProblem[];
  notes: string[];
}
