/** Shapes returned by the native side. Field names match the Rust serde output. */

import type { FieldChange } from './facts';

/** A ProseMirror document as JSON. */
export interface PmNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PmNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}

export type PageStatus = 'canon' | 'draft' | 'idea' | 'retconned';

export interface PageMeta {
  id: string;
  title: string;
  pageType: string;
  status: PageStatus;
  summary: string;
  wordCount: number;
  isHome: boolean;
  revealNodeId: string | null;
  /** Never sent to a cloud AI profile. */
  localOnly?: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  aliases: string[];
  categories: string[];
}

export type InfoboxFieldKind = 'text' | 'longtext' | 'date' | 'number' | 'page' | 'pages';

export interface InfoboxField {
  key: string;
  label: string;
  kind: InfoboxFieldKind;
  /** Comma-separated titles when kind is `pages`. */
  value: string;
  /** Changes during the story. `value` is what holds before the first. See `lib/facts.ts`. */
  changes?: FieldChange[];
}

export interface Infobox {
  imageAssetId?: string;
  caption?: string;
  fields: InfoboxField[];
}

export interface Page extends PageMeta {
  content: PmNode;
  infobox: Infobox;
  notes: PmNode | null;
}

/** The small per-page record the UI keeps in memory for links and hover cards. */
export interface TitleEntry {
  id: string;
  title: string;
  pageType: string;
  status: PageStatus;
  summary: string;
  aliases: string[];
  /** Never sent to a cloud AI profile. */
  localOnly?: boolean;
}

/** An optional page of front or back matter. */
export interface MatterPage {
  include: boolean;
  content: PmNode | null;
}

/** A section at the back of a book, filled from the wiki when it is exported. */
export interface AppendixSpec {
  title: string;
  kind: 'cast' | 'glossary' | 'maps';
  /** Pages of these categories or page types go in. Maps ignore both. */
  categories: string[];
  pageTypes: string[];
  canonOnly: boolean;
  /** Leaves out pages whose reveal comes in a later book. */
  hideSpoilers: boolean;
}

/** What a book needs to be published. Everything is optional. */
export interface BookPublishing {
  coverAssetId?: string;
  series?: string;
  seriesNumber?: string;
  description?: string;
  language?: string;
  publisher?: string;
  isbn?: string;
  copyrightYear?: string;
  /** On unless turned off. */
  titlePage?: boolean;
  copyright?: MatterPage;
  dedication?: MatterPage;
  epigraph?: MatterPage;
  acknowledgments?: MatterPage;
  aboutAuthor?: MatterPage;
  appendices?: AppendixSpec[];
}

export interface Book {
  id: string;
  title: string;
  subtitle: string;
  author: string;
  position: number;
  targetWords: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  publishing: BookPublishing;
}

export type NodeKind = 'part' | 'chapter' | 'scene';
export type NodeStatus = 'idea' | 'outline' | 'draft' | 'revised' | 'final';

export interface NodeMeta {
  id: string;
  bookId: string;
  parentId: string | null;
  kind: NodeKind;
  title: string;
  position: number;
  status: NodeStatus;
  povPageId: string | null;
  locationPageId: string | null;
  synopsis: string;
  wordCount: number;
  targetWords: number;
  storyDate: string;
  /** Never sent to a cloud AI profile. */
  localOnly?: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface Node extends NodeMeta {
  content: PmNode;
  notes: string;
}

export interface WritingStats {
  words: number;
  writtenToday: number;
  days: { day: string; added: number; removed: number }[];
}

export interface Backlinks {
  pages: { id: string; title: string; status: PageStatus }[];
  scenes: { id: string; title: string; bookId: string; count: number }[];
}

export interface WantedPage {
  key: string;
  title: string;
  count: number;
}

export interface SearchHit {
  kind: 'page' | 'node';
  id: string;
  title: string;
  /** Matches are wrapped in \u0002 and \u0003. Use `snippetParts`. */
  snippet: string;
  bookId: string | null;
}

export interface RevisionMeta {
  id: string;
  title: string;
  reason: string;
  wordCount: number;
  createdAt: string;
}

export interface Revision extends RevisionMeta {
  entityKind: 'page' | 'node';
  entityId: string;
  content: PmNode;
  contentText: string;
}

export interface ProjectStatus {
  open: boolean;
  name: string;
  path: string | null;
  dirty: boolean;
}

export interface Recoverable {
  sessionId: string;
  name: string;
  origin: string | null;
  updatedAt: string;
}

export interface Bootstrap {
  version: string;
  dataDir: string;
  settings: unknown;
  recoverable: Recoverable[];
  startupFile: string | null;
  status: ProjectStatus;
  e2e: boolean;
  /** A test run that wants the first-run guide, which test runs otherwise skip. */
  e2eGuide: boolean;
  platform: Platform;
}

export interface Platform {
  /** `windows`, `macos` or `linux`. */
  os: string;
  /** Whether this platform's browser engine can make PDFs. */
  pdf: boolean;
}

/** One kept version of a project file. See `project.listBackups`. */
export interface BackupInfo {
  path: string;
  /** The project's name when the backup was taken. */
  name: string;
  projectId: string;
  savedAt: string;
  size: number;
  /** Taken automatically, just before a restore replaced this version. */
  beforeRestore: boolean;
  /** Belongs to the open project, so it can be restored. */
  isCurrent: boolean;
}

export interface Snapshot {
  meta: Record<string, string>;
  pages: Page[];
  books: Pick<Book, 'id' | 'title' | 'subtitle' | 'author' | 'position' | 'targetWords'>[];
  /** `snapshot.get` always gives the cast. A backup made before casts existed has none. */
  nodes: (Node & { castPageIds?: string[] })[];
  relationships: { fromPageId: string; toPageId: string; kind: string; note: string }[];
  mentions: { sourceKind: 'page' | 'node'; sourceId: string; pageId: string; count: number }[];
}

export interface PickFilter {
  name: string;
  extensions: string[];
}

export interface PickOptions {
  title?: string;
  defaultName?: string;
  filters?: PickFilter[];
  multiple?: boolean;
}
