/** Typed wrappers over the native RPC. Each group matches a Rust module. */

import { rpc } from './rpc';
import type {
  BackupInfo,
  Backlinks,
  Book,
  Bootstrap,
  Infobox,
  Node,
  NodeKind,
  NodeMeta,
  NodeStatus,
  Page,
  PageMeta,
  PageStatus,
  PickOptions,
  PmNode,
  ProjectStatus,
  Recoverable,
  Revision,
  RevisionMeta,
  SearchHit,
  Snapshot,
  TitleEntry,
  WantedPage,
  WritingStats,
} from './types';

export const app = {
  bootstrap: () => rpc<Bootstrap>('app.bootstrap'),
  ready: () => rpc<boolean>('app.ready'),
  setTheme: (dark: boolean) => rpc<boolean>('app.setTheme', { dark }),
  closeAck: () => rpc<boolean>('app.closeAck'),
  quit: () => rpc<boolean>('app.quit'),
  openExternal: (url: string) => rpc<boolean>('app.openExternal', { url }),
};

export const project = {
  status: () => rpc<ProjectStatus>('project.status'),
  create: (name?: string) => rpc<ProjectStatus>('project.new', { name }),
  open: (path: string) => rpc<ProjectStatus>('project.open', { path }),
  save: (force = false) => rpc<ProjectStatus>('project.save', { force }),
  saveAs: (path: string) => rpc<ProjectStatus>('project.saveAs', { path }),
  exportCopy: (path: string) => rpc<{ path: string }>('project.exportCopy', { path }),
  close: () => rpc<ProjectStatus>('project.close'),
  listRecoverable: () => rpc<Recoverable[]>('project.listRecoverable'),
  recover: (sessionId: string) => rpc<ProjectStatus>('project.recover', { sessionId }),
  discardRecovery: (sessionId: string) => rpc<boolean>('project.discardRecovery', { sessionId }),
  /** The open project's backups, newest first. With `all`, or no project open, everyone's. */
  listBackups: (all = false) => rpc<BackupInfo[]>('project.listBackups', { all }),
  /** Opens a backup as a new project with no file. Refused while there is unsaved work. */
  openBackup: (path: string) => rpc<ProjectStatus>('project.openBackup', { path }),
  /** Puts the open project back to its own backup, keeping the current state as a backup first. */
  restoreBackup: (path: string) => rpc<ProjectStatus>('project.restoreBackup', { path }),
  /** Removes one backup file for good. */
  deleteBackup: (path: string) => rpc<boolean>('project.deleteBackup', { path }),
  getMeta: (key: string) => rpc<string | null>('project.getMeta', { key }),
  setMeta: (key: string, value: string) => rpc<boolean>('project.setMeta', { key, value }),
};

export const settings = {
  get: () => rpc<unknown>('settings.get'),
  update: (patch: unknown) => rpc<unknown>('settings.update', { patch }),
  removeRecent: (path: string) => rpc<unknown>('settings.removeRecent', { path }),
};

/** Paths must come from one of the `pick` calls in this run. */
export const files = {
  pickSave: (options: PickOptions) => rpc<string | null>('files.pickSave', options),
  pickOpen: (options: PickOptions) => rpc<string[]>('files.pickOpen', options),
  pickFolder: (options: PickOptions) => rpc<string | null>('files.pickFolder', options),
  writeBytes: (path: string, base64: string) => rpc<boolean>('files.writeBytes', { path, base64 }),
  writeText: (path: string, text: string) => rpc<boolean>('files.writeText', { path, text }),
  readBytes: (path: string) => rpc<{ base64: string }>('files.readBytes', { path }),
  readText: (path: string) => rpc<{ text: string }>('files.readText', { path }),
  listDir: (path: string) => rpc<string[]>('files.listDir', { path }),
};

export interface PageListFilter {
  pageType?: string;
  status?: PageStatus;
  category?: string;
  deleted?: boolean;
  /** An infobox field by key or label, with the value it holds at the start of the story. */
  field?: string;
  fieldValue?: string;
  sort?: 'title' | 'updated' | 'created' | 'words';
  limit?: number;
}

export interface PageCreate {
  title: string;
  pageType?: string;
  status?: PageStatus;
  summary?: string;
  content?: PmNode;
  infobox?: Infobox;
  aliases?: string[];
  categories?: string[];
}

export interface PagePatch {
  localOnly?: boolean;
  pageType?: string;
  status?: PageStatus;
  summary?: string;
  content?: PmNode;
  infobox?: Infobox;
  notes?: PmNode | null;
  aliases?: string[];
  categories?: string[];
  /** An empty string clears it. */
  revealNodeId?: string;
}

export const pages = {
  list: (filter: PageListFilter = {}) => rpc<PageMeta[]>('pages.list', filter),
  titles: () => rpc<TitleEntry[]>('pages.titles'),
  /** Page id to the first scene it appears in, by reading order. */
  firstAppearances: () => rpc<Record<string, string>>('pages.firstAppearances'),
  get: (id: string) => rpc<Page>('pages.get', { id }),
  getByTitle: (title: string) => rpc<Page | null>('pages.getByTitle', { title }),
  home: () => rpc<Page | null>('pages.home'),
  create: (input: PageCreate) => rpc<Page>('pages.create', input),
  update: (id: string, patch: PagePatch) => rpc<PageMeta>('pages.update', { id, patch }),
  rename: (id: string, newTitle: string, updateLinks = true, keepAlias = true) =>
    rpc<{ documentsChanged: number }>('pages.rename', { id, newTitle, updateLinks, keepAlias }),
  remove: (id: string) => rpc<boolean>('pages.delete', { id }),
  restore: (id: string) => rpc<boolean>('pages.restore', { id }),
  purge: (id: string) => rpc<boolean>('pages.purge', { id }),
  backlinks: (id: string) => rpc<Backlinks>('pages.backlinks', { id }),
  wanted: () => rpc<WantedPage[]>('pages.wanted'),
  orphans: () => rpc<PageMeta[]>('pages.orphans'),
  random: () => rpc<string | null>('pages.random'),
  categories: () => rpc<{ name: string; count: number }[]>('pages.categories'),
};

export const books = {
  list: () => rpc<Book[]>('books.list'),
  trash: () => rpc<Book[]>('books.trash'),
  create: (title: string) => rpc<{ id: string }>('books.create', { title }),
  update: (id: string, patch: Partial<Pick<Book, 'title' | 'subtitle' | 'author' | 'targetWords' | 'publishing'>>) =>
    rpc<boolean>('books.update', { id, patch }),
  remove: (id: string) => rpc<boolean>('books.delete', { id }),
  restore: (id: string) => rpc<boolean>('books.restore', { id }),
  reorder: (ids: string[]) => rpc<boolean>('books.reorder', { ids }),
};

export interface NodeCreate {
  bookId: string;
  parentId?: string | null;
  kind: NodeKind;
  title: string;
  afterId?: string;
  content?: PmNode;
  synopsis?: string;
  status?: NodeStatus;
}

export interface NodePatch {
  localOnly?: boolean;
  title?: string;
  status?: NodeStatus;
  /** An empty string clears it. */
  povPageId?: string;
  /** An empty string clears it. */
  locationPageId?: string;
  synopsis?: string;
  notes?: string;
  content?: PmNode;
  targetWords?: number;
  storyDate?: string;
}

export const nodes = {
  tree: (bookId: string) => rpc<NodeMeta[]>('nodes.tree', { bookId }),
  get: (id: string) => rpc<Node>('nodes.get', { id }),
  create: (input: NodeCreate) => rpc<NodeMeta>('nodes.create', input),
  update: (id: string, patch: NodePatch) => rpc<NodeMeta>('nodes.update', { id, patch }),
  move: (id: string, parentId: string | null, index?: number) =>
    rpc<boolean>('nodes.move', { id, parentId, index }),
  remove: (id: string) => rpc<boolean>('nodes.delete', { id }),
  restore: (id: string) => rpc<boolean>('nodes.restore', { id }),
  trash: (bookId: string) => rpc<NodeMeta[]>('nodes.trash', { bookId }),
  stats: (bookId: string) => rpc<WritingStats>('nodes.stats', { bookId }),
  /** The ids of the pages in a scene's cast. */
  cast: (id: string) => rpc<string[]>('nodes.cast', { id }),
  setCast: (id: string, pageIds: string[]) => rpc<boolean>('nodes.setCast', { id, pageIds }),
};

export const search = {
  query: (q: string, kind?: 'page' | 'node', limit?: number) =>
    rpc<SearchHit[]>('search.query', { q, kind, limit }),
};

export const revisions = {
  list: (kind: 'page' | 'node', id: string) => rpc<RevisionMeta[]>('revisions.list', { kind, id }),
  get: (id: string) => rpc<Revision>('revisions.get', { id }),
  checkpoint: (kind: 'page' | 'node', id: string, reason?: string) =>
    rpc<string | null>('revisions.checkpoint', { kind, id, reason }),
  restore: (id: string) => rpc<{ kind: 'page' | 'node'; id: string }>('revisions.restore', { id }),
  retention: () => rpc<Retention>('revisions.retention'),
  setRetention: (value: Retention) => rpc<Retention>('revisions.setRetention', value),
};

/** How long this project keeps its history. See "History retention" in docs/ARCHITECTURE.md. */
export interface Retention {
  enabled: boolean;
  keepAllDays: number;
  dailyForDays: number;
  keepLatest: number;
}

export const snapshot = {
  get: () => rpc<Snapshot>('snapshot.get'),
};
