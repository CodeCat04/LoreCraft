/**
 * The LoreCraft file format, shared by the JSON and YAML exports and the importer. It is
 * specified in docs/IMPORT_FORMAT.md, so an export is also a valid import.
 */

import { t } from '../../lib/i18n';
import type { Node, PmNode } from '../../lib/types';
import { childrenByParent } from '../scope';
import type { AssetMeta, ExportInput } from '../types';

export const FORMAT_NAME = 'lorebook';
export const FORMAT_VERSION = 1;

/** A document as written to the file. Importers accept ProseMirror JSON or Markdown. */
export type FileBody = PmNode | string;

const asIs = (doc: PmNode): FileBody => doc;

function scene(
  node: Node & { castPageIds?: string[] },
  render: (doc: PmNode) => FileBody,
  povTitle: (id: string | null) => string | null,
  threads: string[],
) {
  return {
    id: node.id,
    kind: node.kind,
    title: node.title,
    status: node.status,
    synopsis: node.synopsis,
    notes: node.notes,
    storyDate: node.storyDate,
    targetWords: node.targetWords,
    pov: povTitle(node.povPageId),
    location: povTitle(node.locationPageId ?? null),
    cast: (node.castPageIds ?? []).map(povTitle).filter((title): title is string => title !== null),
    threads,
    wordCount: node.wordCount,
    localOnly: node.localOnly === true,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    content: render(node.content),
  };
}

function structural(node: Node) {
  return {
    id: node.id,
    kind: node.kind,
    title: node.title,
    status: node.status,
    synopsis: node.synopsis,
    notes: node.notes,
    storyDate: node.storyDate,
    targetWords: node.targetWords,
    localOnly: node.localOnly === true,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

function assetRecord(asset: AssetMeta, input: ExportInput) {
  const base64 = input.assetData.get(asset.id);
  const { size: _size, ...fields } = asset;
  if (base64 !== undefined) return { ...fields, base64 };
  input.warn?.(t('{name} was too large to include, so documents refer to a file that is not in the export.', { name: asset.name }));
  return { ...asset, omitted: true };
}

export function buildLorebookFile(input: ExportInput, render: (doc: PmNode) => FileBody = asIs) {
  const { snapshot } = input;
  const titleOf = new Map(snapshot.pages.map((p) => [p.id, p.title]));
  const povTitle = (id: string | null) => (id ? (titleOf.get(id) ?? null) : null);
  const children = childrenByParent(snapshot.nodes);
  const threadsOf = new Map<string, string[]>();
  for (const { nodeId, threadId } of snapshot.nodeThreads) {
    threadsOf.set(nodeId, [...(threadsOf.get(nodeId) ?? []), threadId]);
  }

  const tree = (bookId: string, parentId: string | null): unknown[] =>
    (children.get(parentId) ?? [])
      .filter((n) => n.bookId === bookId)
      .map((node) =>
        node.kind === 'scene'
          ? scene(node, render, povTitle, threadsOf.get(node.id) ?? [])
          : { ...structural(node), children: tree(bookId, node.id) },
      );

  return {
    format: FORMAT_NAME,
    version: FORMAT_VERSION,
    exportedAt: input.exportedAt,
    project: { name: snapshot.meta.name ?? '', meta: snapshot.meta },
    pages: snapshot.pages.map((page) => ({
      id: page.id,
      title: page.title,
      pageType: page.pageType,
      status: page.status,
      summary: page.summary,
      aliases: page.aliases,
      categories: page.categories,
      infobox: page.infobox,
      isHome: page.isHome,
      revealNodeId: page.revealNodeId,
      localOnly: page.localOnly === true,
      wordCount: page.wordCount,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
      content: render(page.content),
      notes: page.notes ? render(page.notes) : null,
    })),
    books: snapshot.books.map((book) => ({
      id: book.id,
      title: book.title,
      subtitle: book.subtitle,
      author: book.author,
      targetWords: book.targetWords,
      createdAt: book.createdAt,
      updatedAt: book.updatedAt,
      publishing: book.publishing ?? {},
      writingLog: snapshot.writingLog
        .filter((day) => day.bookId === book.id)
        .map(({ day, wordsAdded, wordsRemoved }) => ({ day, wordsAdded, wordsRemoved })),
      children: tree(book.id, null),
    })),
    threads: snapshot.threads.map(({ id, name, color, description, position }) => ({ id, name, color, description, position })),
    relationships: snapshot.relationships.flatMap((r) => {
      const from = titleOf.get(r.fromPageId);
      const to = titleOf.get(r.toPageId);
      return from && to ? [{ from, to, kind: r.kind, note: r.note, createdAt: r.createdAt }] : [];
    }),
    assets: snapshot.assets.map((asset) => assetRecord(asset, input)),
    maps: snapshot.maps.map((map) => ({
      id: map.id,
      title: map.title,
      assetId: map.assetId,
      createdAt: map.createdAt,
      updatedAt: map.updatedAt,
      pins: map.pins.map((pin) => ({
        page: pin.pageId ? (titleOf.get(pin.pageId) ?? null) : null,
        label: pin.label,
        x: pin.x,
        y: pin.y,
        createdAt: pin.createdAt,
      })),
    })),
    dictionary: snapshot.dictionary,
    prompts: snapshot.prompts,
    canvases: (snapshot.canvases ?? []).map(({ id, title, data, createdAt, updatedAt }) => ({
      id,
      title,
      data,
      createdAt,
      updatedAt,
    })),
  };
}
