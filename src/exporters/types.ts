/** Shapes shared by the exporters. An exporter is a pure function of `ExportInput`. */

import type { Book, BookPublishing, Snapshot } from '../lib/types';
import type { BookMatter } from './novel/matter';

export interface AssetMeta {
  id: string;
  name: string;
  mime: string;
  width: number | null;
  height: number | null;
  createdAt: string;
  size: number;
}

export interface MapPinInfo {
  pageId: string | null;
  label: string;
  x: number;
  y: number;
  createdAt?: string;
}

/** A canvas as `snapshot.get` gives it: `data` is JSON Canvas (`{ nodes, edges }`). */
export interface CanvasInfo {
  id: string;
  title: string;
  data: { nodes: unknown[]; edges: unknown[] };
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface MapInfo {
  id: string;
  title: string;
  assetId: string | null;
  createdAt?: string;
  updatedAt?: string;
  pins: MapPinInfo[];
}

export interface WritingDayInfo {
  day: string;
  bookId: string;
  wordsAdded: number;
  wordsRemoved: number;
}

/** A plot thread. Which scenes it runs through is in `ExportSnapshot.nodeThreads`. */
export interface ThreadInfo {
  id: string;
  name: string;
  color: string;
  description: string;
  position: number;
}

export interface PromptInfo {
  name: string;
  description: string;
  template: string;
  scope: string;
  position: number;
}

export type SnapshotBook = Pick<Book, 'id' | 'title' | 'subtitle' | 'author' | 'position' | 'targetWords'> & {
  createdAt?: string;
  updatedAt?: string;
  publishing?: BookPublishing;
  /** What surrounds the chapters, worked out for this export. Absent means a plain book. */
  matter?: BookMatter;
};

export interface SnapshotRelationship {
  fromPageId: string;
  toPageId: string;
  kind: string;
  note: string;
  createdAt?: string;
}

/** What `snapshot.get` returns. */
export interface ExportSnapshot extends Omit<Snapshot, 'books' | 'relationships'> {
  books: SnapshotBook[];
  relationships: SnapshotRelationship[];
  assets: AssetMeta[];
  maps: MapInfo[];
  dictionary: string[];
  writingLog: WritingDayInfo[];
  prompts: PromptInfo[];
  threads: ThreadInfo[];
  nodeThreads: { nodeId: string; threadId: string }[];
  /** Absent in snapshots made before canvases. */
  canvases?: CanvasInfo[];
}

export type ExportScope =
  /** Everything. */
  | 'project'
  /** Pages, relationships and maps. */
  | 'wiki'
  /** One wiki page. */
  | 'page'
  /** One book. */
  | 'book'
  /** Every book and no pages. */
  | 'books';

/** Which scenes go into a novel export. Scenes with other statuses are left out. */
export type SceneFilter = 'all' | 'written' | 'revised';

export interface ExportOptions {
  scope: ExportScope;
  bookId?: string;
  pageId?: string;

  /** Only pages marked canon. Overrides the two below. */
  canonOnly: boolean;
  /** Pages marked draft or idea. */
  includeDrafts: boolean;
  /** Pages marked retconned. */
  includeRetconned: boolean;
  scenes: SceneFilter;

  /** YAML and XML: how documents are written. */
  bodyFormat: 'markdown' | 'prosemirror';
  /** CSV: a zip of pages, scenes and relationships rather than one pages table. */
  csvBundle: boolean;
  /** CSV: stop spreadsheets from running text that looks like a formula. */
  csvGuardFormulas: boolean;
  /** SillyTavern: start each entry with the page's infobox fields. */
  infoboxInContent: boolean;
  /**
   * Formats made for other AI tools: pages and scenes marked local only go in. Off unless
   * the writer ticks it, as the MCP server does. Other formats ignore it and keep them.
   */
  includeLocalOnly: boolean;

  /** Novel: standard manuscript format rather than book typography. */
  manuscriptFormat: boolean;
  /** Novel: print scene titles rather than only a separator between scenes. */
  sceneTitles: boolean;
  /** Novel: a language code for EPUB and PDF. */
  language: string;
  /** PDF page size. */
  pageSize: 'pocket' | 'digest' | 'trade' | 'a5' | 'a4' | 'letter';
  /** Novel: the book's cover, front and back matter, and appendices. */
  bookMatter: boolean;
  /** Novel PDF: laid out for a printer rather than for reading on a screen. */
  printReady: boolean;
  /** Print-ready PDF: a wider margin on the binding side of each page. */
  mirrorMargins: boolean;
  /** Print-ready PDF: chapters start on right-hand pages. */
  chaptersOnRight: boolean;
  /** Print-ready PDF: the book's title and the chapter's title at the top of pages. */
  runningHeaders: boolean;
}

export const DEFAULT_OPTIONS: ExportOptions = {
  scope: 'project',
  canonOnly: false,
  includeDrafts: true,
  includeRetconned: true,
  scenes: 'all',
  bodyFormat: 'markdown',
  csvBundle: false,
  csvGuardFormulas: true,
  infoboxInContent: true,
  includeLocalOnly: false,
  manuscriptFormat: false,
  sceneTitles: false,
  language: 'en',
  pageSize: 'trade',
  bookMatter: true,
  printReady: false,
  mirrorMargins: true,
  chaptersOnRight: true,
  runningHeaders: true,
};

export interface ExportInput {
  /** Already narrowed to the chosen scope and filters. */
  snapshot: ExportSnapshot;
  /** Base64 file contents by asset id, for those that were loaded. */
  assetData: Map<string, string>;
  options: ExportOptions;
  /** The time to record in the file, so output depends only on the input. */
  exportedAt: string;
  /** Title and alias keys of live pages the filters left out. */
  excludedPages: Set<string>;
  progress?: (done: number, total: number) => void;
  warn?: (message: string) => void;
}

export type Exporter = (input: ExportInput) => Uint8Array | Promise<Uint8Array>;

/**
 * A document for the print window to lay out. It holds no image bytes: the print page
 * fetches those itself, so they never pass through this window or the worker.
 */
export interface PrintDocument {
  title: string;
  author: string;
  language: string;
  /** The page rules for this document, such as size and running heads. */
  css: string;
  html: string;
}
