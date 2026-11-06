/** Wiki calls beyond the shared wrappers in `src/lib/api.ts`. */

import { rpc } from '../lib/rpc';
import type { PageListFilter, PagePatch } from '../lib/api';
import type { Backlinks, PageMeta, PageStatus, Revision } from '../lib/types';

export interface WikiListFilter extends Omit<PageListFilter, 'sort'> {
  /** Only pages with fewer words than this. */
  underWords?: number;
  excludeHome?: boolean;
  sort?: 'title' | 'updated' | 'created' | 'words' | 'fewestWords';
}

export interface RenamePreview {
  newTitle: string;
  documents: { kind: 'page' | 'node'; id: string; title: string }[];
}

export interface LinksTo extends Backlinks {
  /** A page with this name waiting in the trash. */
  trashedId: string | null;
}

/** Where a page first appears in the manuscript. */
export interface FirstAppearance {
  nodeId: string;
  bookId: string;
  /** For example "Book 1, Chapter 3, Scene 2". */
  label: string;
}

/** Pages of one type that name this page in one infobox field. */
export interface InfoboxLinkGroup {
  label: string;
  key: string;
  pageType: string;
  pages: { id: string; title: string; status: PageStatus }[];
}

export const wikiPages = {
  firstAppearance: (id: string) => rpc<FirstAppearance | null>('pages.firstAppearance', { id }),
  sceneOptions: () => rpc<{ id: string; label: string }[]>('pages.sceneOptions'),
  infoboxLinks: (id: string) => rpc<InfoboxLinkGroup[]>('pages.infoboxLinks', { id }),
  list: (filter: WikiListFilter = {}) => rpc<PageMeta[]>('pages.list', filter),
  /** A save from the open editor, which already shows what it writes. */
  saveFromEditor: (id: string, patch: PagePatch) =>
    rpc<PageMeta>('pages.update', { id, patch, fromEditor: true }),
  renamePreview: (id: string, newTitle: string) =>
    rpc<RenamePreview>('pages.renamePreview', { id, newTitle }),
  linksTo: (title: string) => rpc<LinksTo>('pages.linksTo', { title }),
  random: (exceptId?: string) => rpc<string | null>('pages.random', { exceptId }),
};

export interface WikiRevision extends Revision {
  extra: { infobox?: unknown; summary?: string } | null;
}

export const wikiRevisions = {
  get: (id: string) => rpc<WikiRevision>('revisions.get', { id }),
};

export interface FindOptions {
  find: string;
  replace: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** `pages`, `scenes`, or absent for both. */
  scope?: 'pages' | 'scenes';
}

export interface ReplaceMatch {
  /** Its position among the document's matches, which is how apply refers to it. */
  index: number;
  /** The kind of block it is in, such as `heading` or `reference`. */
  block: string;
  before: string;
  text: string;
  after: string;
  replacement: string;
}

export interface ReplaceDocument {
  kind: 'page' | 'node';
  id: string;
  title: string;
  bookId: string | null;
  hash: string;
  matches: ReplaceMatch[];
}

export interface ReplacePreview {
  documents: ReplaceDocument[];
  total: number;
  /** The list stopped at its limit, so more matches may exist. */
  truncated: boolean;
}

export interface ReplaceChoice {
  kind: 'page' | 'node';
  id: string;
  hash: string;
  indexes: number[];
}

export interface ReplaceResult {
  replacements: number;
  documents: { kind: 'page' | 'node'; id: string; title: string }[];
}

export const findReplace = {
  preview: (options: FindOptions) => rpc<ReplacePreview>('search.replacePreview', options),
  apply: (options: FindOptions, documents: ReplaceChoice[]) =>
    rpc<ReplaceResult>('search.replaceApply', { ...options, documents }),
  renameEverywhere: (
    id: string,
    newTitle: string,
    keepAlias: boolean,
    options: FindOptions,
    documents: ReplaceChoice[],
  ) =>
    rpc<ReplaceResult & { documentsChanged: number }>('search.renameEverywhere', {
      ...options,
      id,
      newTitle,
      keepAlias,
      documents,
    }),
};
