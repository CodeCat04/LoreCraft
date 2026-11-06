/**
 * Markdown: a zip that opens as an Obsidian vault. One `.md` per page with YAML front
 * matter and `[[wiki links]]`, scenes in folders by book and chapter, and images beside
 * them. Importing the folder again brings back pages, scenes and images.
 */

import { strToU8, zipSync, type Zippable } from 'fflate';
import { stringify } from 'yaml';

import { describeFigures, figureToLine, pmToMarkdown } from '../../editor/convert';
import { t } from '../../lib/i18n';
import { titleKey } from '../../lib/text';
import type { Node, Page, PmNode } from '../../lib/types';
import { childrenByParent } from '../scope';
import type { AssetMeta, ExportInput } from '../types';
import { assetFileName, assetsInDoc, base64ToBytes, categoryToTag, formatBytes, mapDoc, NameKeeper, pageResolver, safeFileName } from '../util';

const WIKI_DIR = 'Wiki';
const BOOKS_DIR = 'Manuscript';
const ASSETS_DIR = 'Assets';

function frontMatter(fields: Record<string, unknown>): string {
  const present = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)),
  );
  return `---\n${stringify(present, { aliasDuplicateObjects: false, lineWidth: 0 })}---\n`;
}

interface Vault {
  input: ExportInput;
  /** Page id -> file name without extension, which is what Obsidian links by. */
  fileOf: Map<string, string>;
  resolve: (target: string) => Page | undefined;
  /** Asset id -> path under the vault, for those included. */
  assetPath: Map<string, string>;
  assetOf: Map<string, AssetMeta>;
}

function upTo(root: number): string {
  return '../'.repeat(root);
}

/** A video cannot be embedded here and there is no file to link to, so say what it was. */
function missingVideoLine(node: PmNode, vault: Vault, doc: PmNode): PmNode {
  const figures = describeFigures(doc);
  const assetId = node.content?.find((c) => c.type === 'video')?.attrs?.assetId;
  const info = figures.find((f) => f.assetId === assetId);
  const asset = vault.assetOf.get(String(assetId));
  const size = asset ? `, ${formatBytes(asset.size)}, not included` : '';
  const line = info ? `${figureToLine(info).slice(0, -1)}${size}]` : '[Video]';
  return { type: 'paragraph', content: [{ type: 'text', text: line }] };
}

/** Points links at file names and images at files, without changing the labels. */
function prepareDoc(doc: PmNode, vault: Vault, depth: number): PmNode {
  return mapDoc(doc, (node) => {
    if (node.type === 'figure') {
      const media = node.content?.find((c) => c.type !== 'figcaption');
      if (media?.type === 'video' && media.attrs?.assetId && !vault.assetPath.has(String(media.attrs.assetId))) {
        return missingVideoLine(node, vault, doc);
      }
    }
    if ((node.type === 'image' || node.type === 'video') && (node.attrs?.assetId || node.attrs?.url)) {
      // Obsidian plays a video through ordinary image syntax, and the importer tells
      // them apart by the file type.
      const assetId = node.attrs?.assetId ? String(node.attrs.assetId) : null;
      const path = assetId ? vault.assetPath.get(assetId) : null;
      const src = path ? `${upTo(depth)}${path}` : String(node.attrs?.url ?? '');
      return { type: 'image', attrs: { alt: node.attrs?.alt ?? '', assetId: null, src } };
    }
    const wiki = node.marks?.find((m) => m.type === 'wikiLink');
    if (!wiki) return node;
    const target = String(wiki.attrs?.target ?? '');
    const page = vault.resolve(target);
    const file = page ? vault.fileOf.get(page.id) : safeFileName(target);
    return {
      ...node,
      marks: node.marks?.map((m) => (m === wiki ? { ...m, attrs: { ...m.attrs, target: file ?? target } } : m)),
    };
  }) as PmNode;
}

function pageFile(page: Page, vault: Vault): string {
  const box = page.infobox;
  const image = box?.imageAssetId ? vault.assetPath.get(box.imageAssetId) : undefined;
  const body = pmToMarkdown(prepareDoc(page.content, vault, 1));
  const infoboxImage = image ? `![${(box.caption ?? '').replace(/[[\]]/g, '')}](${encodeURI(`${upTo(1)}${image}`)})\n\n` : '';
  const talk = page.notes ? pmToMarkdown(prepareDoc(page.notes, vault, 1)) : '';
  return (
    frontMatter({
      title: page.title,
      aliases: page.aliases,
      tags: page.categories.map(categoryToTag).filter(Boolean),
      categories: page.categories,
      type: page.pageType === 'article' ? undefined : page.pageType,
      status: page.status,
      summary: page.summary,
      home: page.isHome || undefined,
      local_only: page.localOnly || undefined,
      infobox: box?.fields?.length || box?.caption ? { caption: box.caption, image, fields: box.fields } : undefined,
      talk: talk || undefined,
      created: page.createdAt,
      updated: page.updatedAt,
    }) +
    `\n${infoboxImage}${body}\n`
  );
}

function sceneFile(
  node: Node,
  order: { scene: number; chapter: number },
  parents: { book: string; chapter: string; part?: string; localOnly: boolean },
  vault: Vault,
  depth: number,
): string {
  const pov = node.povPageId ? vault.input.snapshot.pages.find((p) => p.id === node.povPageId)?.title : undefined;
  return (
    frontMatter({
      title: node.title,
      kind: 'scene',
      book: parents.book,
      part: parents.part,
      chapter: parents.chapter,
      chapter_order: order.chapter,
      order: order.scene,
      status: node.status,
      pov,
      synopsis: node.synopsis,
      notes: node.notes,
      story_date: node.storyDate,
      target_words: node.targetWords || undefined,
      // Chapters and parts are folders here, so a scene carries their mark too.
      local_only: node.localOnly || parents.localOnly || undefined,
      created: node.createdAt,
      updated: node.updatedAt,
    }) + `\n${pmToMarkdown(prepareDoc(node.content, vault, depth))}\n`
  );
}

function numbered(index: number, name: string): string {
  return `${String(index + 1).padStart(2, '0')} ${safeFileName(name || 'Untitled')}`;
}

function addBooks(files: Zippable, vault: Vault) {
  const { snapshot } = vault.input;
  const children = childrenByParent(snapshot.nodes);
  const bookFolders = new NameKeeper();
  for (const book of snapshot.books) {
    const folder = `${BOOKS_DIR}/${bookFolders.take(safeFileName(book.title))}`;
    files[`${folder}/_book.md`] = strToU8(
      `${frontMatter({
        title: book.title,
        kind: 'book',
        subtitle: book.subtitle,
        author: book.author,
        target_words: book.targetWords || undefined,
        created: book.createdAt,
        updated: book.updatedAt,
      })}`,
    );
    const top = (children.get(null) ?? []).filter((n) => n.bookId === book.id);
    let chapterIndex = 0;
    const addChapter = (chapter: Node, base: string, part?: Node) => {
      const chapterFolder = `${base}/${numbered(chapterIndex, chapter.title)}`;
      chapterIndex += 1;
      (children.get(chapter.id) ?? []).forEach((scene, sceneIndex) => {
        // Folder depth decides how far back to the images.
        const depth = chapterFolder.split('/').length;
        files[`${chapterFolder}/${numbered(sceneIndex, scene.title)}.md`] = strToU8(
          sceneFile(
            scene,
            { scene: sceneIndex + 1, chapter: chapterIndex },
            { book: book.title, chapter: chapter.title, part: part?.title, localOnly: !!(chapter.localOnly || part?.localOnly) },
            vault,
            depth,
          ),
        );
      });
    };
    let partIndex = 0;
    for (const node of top) {
      if (node.kind === 'part') {
        const partFolder = `${folder}/${numbered(partIndex, node.title)}`;
        (children.get(node.id) ?? []).forEach((chapter) => addChapter(chapter, partFolder, node));
        partIndex += 1;
      } else {
        addChapter(node, folder);
      }
    }
  }
}

export function exportMarkdown(input: ExportInput): Uint8Array {
  const { snapshot, assetData } = input;
  const files: Zippable = {};

  const assetOf = new Map(snapshot.assets.map((a) => [a.id, a]));
  const used = new Set<string>();
  for (const page of snapshot.pages) {
    assetsInDoc(page.content, used);
    assetsInDoc(page.notes, used);
    if (page.infobox?.imageAssetId) used.add(page.infobox.imageAssetId);
  }
  for (const node of snapshot.nodes) assetsInDoc(node.content, used);

  const assetPath = new Map<string, string>();
  const assetNames = new NameKeeper();
  for (const id of used) {
    const asset = assetOf.get(id);
    const data = assetData.get(id);
    if (!asset) continue;
    if (data === undefined) {
      input.warn?.(t('{name} was too large to include, so a line of text stands in for it.', { name: asset.name }));
      continue;
    }
    const path = `${ASSETS_DIR}/${assetFileName(asset, assetNames)}`;
    assetPath.set(id, path);
    // Images and videos are already compressed.
    files[path] = [base64ToBytes(data), { level: 0 }];
  }

  const pageNames = new NameKeeper();
  const fileOf = new Map<string, string>();
  for (const page of snapshot.pages) {
    fileOf.set(page.id, pageNames.take(safeFileName(page.title)));
  }
  const vault: Vault = {
    input,
    fileOf,
    resolve: pageResolver(snapshot.pages, titleKey),
    assetPath,
    assetOf,
  };

  snapshot.pages.forEach((page, index) => {
    files[`${WIKI_DIR}/${fileOf.get(page.id)}.md`] = strToU8(pageFile(page, vault));
    input.progress?.(index + 1, snapshot.pages.length);
  });
  addBooks(files, vault);
  return zipSync(files);
}
