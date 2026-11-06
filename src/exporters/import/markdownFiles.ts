/**
 * Reads a folder of Markdown files, including an Obsidian vault and LoreCraft's own
 * Markdown export. Pure: the caller reads the files and says what else is in the folder.
 */

import { parse as parseYaml } from 'yaml';

import { markdownToPm } from '../../editor/convert';
import { t } from '../../lib/i18n';
import { titleKey } from '../../lib/text';
import type { PmNode } from '../../lib/types';
import { categoryToTag } from '../util';
import { fieldKind, fieldLabel, KNOWN_FIELDS } from './infoboxFields';
import { documentProblem } from './schemaCheck';
import {
  emptyPayload,
  type ImportProblem,
  type Normalized,
  type PayloadAsset,
  type PayloadBook,
  type PayloadInfobox,
  type PayloadNode,
  type PayloadPage,
} from './types';

export interface MarkdownFile {
  /** Relative to the chosen folder, with `/` separators. */
  path: string;
  text: string;
}

export interface MarkdownOptions {
  /** Each folder a page is in becomes a category. */
  foldersAsCategories: boolean;
  /** `#tags` in the text become categories. Tags in front matter always do. */
  tagsAsCategories: boolean;
}

export const DEFAULT_MARKDOWN_OPTIONS: MarkdownOptions = {
  foldersAsCategories: false,
  tagsAsCategories: true,
};

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
};

/** File names that do not name anything in particular. */
const GENERIC_NAME = /^(readme|index|untitled( \d+)?|notes?)$/i;

const VIDEO_HOSTS = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be|vimeo\.com)\//i;

export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function baseName(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function decodePath(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

/** Works out `../Assets/x.png` from a file's folder. */
function resolveRelative(fromFile: string, relative: string): string {
  const parts = fromFile.split('/').slice(0, -1);
  for (const part of relative.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

/** Splits off front matter. If it cannot be read, that is reported and the text kept. */
function splitFrontMatter(
  text: string,
  file: string,
  problems: ImportProblem[],
): { fields: Record<string, unknown>; body: string } {
  const match = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { fields: {}, body: text.replace(/^﻿/, '') };
  try {
    const parsed: unknown = parseYaml(match[1]);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { fields: parsed as Record<string, unknown>, body: text.slice(match[0].length) };
    }
    return { fields: {}, body: text.slice(match[0].length) };
  } catch (error) {
    problems.push({
      severity: 'warning',
      item: file,
      field: 'front matter',
      message: t('could not be read, so it stays as text: {error}', { error: error instanceof Error ? error.message : String(error) }),
    });
    return { fields: {}, body: text.replace(/^﻿/, '') };
  }
}

/** Obsidian accepts a list, or text separated by commas or spaces for tags. */
function textList(value: unknown, splitter: RegExp): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(splitter).map((v) => v.trim()).filter(Boolean);
  if (typeof value === 'number') return [String(value)];
  return [];
}

function asTime(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'string') return undefined;
  return Number.isNaN(Date.parse(value)) ? undefined : new Date(value).toISOString();
}

/**
 * `local_only: true` in front matter, as LoreCraft's export writes it, or `localOnly` or
 * `local-only`. Only ever sets the mark: an import never clears one.
 */
function localOnly(fields: Record<string, unknown>): true | undefined {
  const value = fields.local_only ?? fields.localOnly ?? fields['local-only'];
  return value === true || (typeof value === 'string' && /^(true|yes)$/i.test(value.trim())) ? true : undefined;
}

function asText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return undefined;
}

interface Scan {
  /** Lower-cased file name without extension -> the title it stands for. */
  titles: Map<string, string>;
  /** Files in the folder that are not Markdown, by full path and by lower-cased name. */
  byPath: Map<string, string>;
  byName: Map<string, string>;
  /** Files found to be used, as assets to bring in. */
  assets: Map<string, PayloadAsset>;
  root: string;
  nextKey: () => string;
  /** Pictures and videos named by a note and not found. */
  missing: { file: string; target: string }[];
}

/** The stored name for a file, adding it to the import the first time it is used. */
function assetKey(path: string, scan: Scan): string | null {
  const extension = extensionOf(path);
  const mime = MIME_BY_EXTENSION[extension];
  if (!mime) return null;
  const existing = scan.assets.get(path);
  if (existing) return existing.id;
  const id = scan.nextKey();
  scan.assets.set(path, { id, name: fileName(path), mime, path: `${scan.root}/${path}` });
  return id;
}

/** Finds a file the way Obsidian does: by path from here, then by name anywhere. */
function findFile(target: string, from: string, scan: Scan): string | null {
  const clean = decodePath(target).replace(/^\.\//, '');
  const relative = resolveRelative(from, clean);
  if (scan.byPath.has(relative.toLowerCase())) return scan.byPath.get(relative.toLowerCase()) ?? null;
  if (scan.byPath.has(clean.toLowerCase())) return scan.byPath.get(clean.toLowerCase()) ?? null;
  return scan.byName.get(fileName(clean).toLowerCase()) ?? null;
}

/** `Page#Heading`, `folder/Page` and `Page^block` all point at a page. */
function linkParts(inner: string, scan: Scan): { target: string; label: string } {
  const split = inner.indexOf('|');
  const rawTarget = (split >= 0 ? inner.slice(0, split) : inner).trim();
  const label = split >= 0 ? inner.slice(split + 1).trim() : '';
  const hash = rawTarget.search(/[#^]/);
  const pagePart = (hash >= 0 ? rawTarget.slice(0, hash) : rawTarget).trim();
  const section = hash >= 0 ? rawTarget.slice(hash + 1).trim() : '';
  const page = fileName(pagePart.replace(/\.md$/i, ''));
  const target = scan.titles.get(page.toLowerCase()) ?? page;
  const shown = label || (section ? `${target} > ${section}` : target);
  return { target, label: shown };
}

function wikiLink(target: string, label: string): string {
  const safe = (text: string, pipe: boolean) => text.replace(pipe ? /([\\[\]|])/g : /([\\[\]])/g, '\\$1');
  return target === label ? `[[${safe(target, true)}]]` : `[[${safe(target, true)}|${safe(label, false)}]]`;
}

const TAG = /(?<=^|[\s(])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)[ \t]*/gmu;

/** Runs on text outside code. */
function convertInline(text: string, from: string, scan: Scan, tags: Set<string>, options: MarkdownOptions): string {
  let out = text
    // Comments.
    .replace(/%%[\s\S]*?%%/g, '')
    // Highlights have no equivalent here, and the words matter more than the color.
    .replace(/==(?=\S)([^=\n]*\S)==/g, '$1')
    // Embeds. A picture or video comes in as a file, and a note becomes a link to it.
    .replace(/!\[\[([^\]\n]+)\]\]/g, (_all, inner: string) => {
      const split = inner.indexOf('|');
      const target = (split >= 0 ? inner.slice(0, split) : inner).trim();
      const caption = split >= 0 ? inner.slice(split + 1).trim() : '';
      const file = findFile(target, from, scan);
      const key = file ? assetKey(file, scan) : null;
      if (!file && MIME_BY_EXTENSION[extensionOf(target)]) scan.missing.push({ file: from, target });
      // A size such as `|300` is layout, not a label.
      const alt = /^\d+(x\d+)?$/.test(caption) ? '' : caption.replace(/[[\]]/g, '');
      if (key && file) {
        const prefix = MIME_BY_EXTENSION[extensionOf(file)].startsWith('video/') ? 'video:' : '';
        return `![${alt}](${prefix}asset:${key})`;
      }
      const { target: page, label } = linkParts(inner, scan);
      return wikiLink(page, label);
    })
    // Ordinary images, which may point at files in the folder or at a video.
    .replace(/!\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(\s+"[^"\n]*")?\s*\)/g, (all, alt: string, target: string, title = '') => {
      if (target.startsWith('asset:') || target.startsWith('video:')) return all;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
        const video = VIDEO_HOSTS.test(target) || MIME_BY_EXTENSION[extensionOf(target.split(/[?#]/)[0])]?.startsWith('video/');
        return video ? `![${alt}](video:${target}${title})` : all;
      }
      const file = findFile(target, from, scan);
      const key = file ? assetKey(file, scan) : null;
      if (!file) scan.missing.push({ file: from, target });
      if (!key || !file) return all;
      const prefix = MIME_BY_EXTENSION[extensionOf(file)].startsWith('video/') ? 'video:' : '';
      return `![${alt}](${prefix}asset:${key}${title})`;
    })
    // Wiki links. A backslash-escaped one is literal text and stays so.
    .replace(/(^|[^\\])\[\[([^[\]\n]+)\]\]/g, (_all, before: string, inner: string) => {
      const { target, label } = linkParts(inner, scan);
      return `${before}${wikiLink(target, label)}`;
    });
  if (options.tagsAsCategories) {
    out = out.replace(TAG, (_all, tag: string) => {
      tags.add(tag);
      return '';
    });
  }
  return out;
}

/** Everything that is Obsidian's own rather than Markdown, leaving code alone. */
function convertBody(body: string, from: string, scan: Scan, tags: Set<string>, options: MarkdownOptions): string {
  const blocks = body.split(/^(```[\s\S]*?^```[ \t]*$|~~~[\s\S]*?^~~~[ \t]*$)/m);
  const converted = blocks.map((block, i) => {
    if (i % 2 === 1) return block;
    // Callouts become an ordinary quote with a bold title.
    const callouts = block.replace(
      /^(>\s*)\[!(\w+)\][+-]?[ \t]*(.*)$/gm,
      (_all, quote: string, kind: string, title: string) =>
        `${quote}**${kind.charAt(0).toUpperCase()}${kind.slice(1).toLowerCase()}${title ? `: ${title}` : ''}**\n${quote}`,
    );
    const pieces = callouts.split(/(`+[^`\n]*`+)/);
    return pieces.map((piece, j) => (j % 2 === 1 ? piece : convertInline(piece, from, scan, tags, options))).join('');
  });
  // A line that held only tags or a comment should not leave a gap behind.
  return converted.join('').replace(/^[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

function infoboxFrom(fields: Record<string, unknown>, scan: Scan, file: string): PayloadInfobox | undefined {
  const given = fields.infobox;
  const pageType = asText(fields.type);
  const out: PayloadInfobox = { fields: [] };
  if (given && typeof given === 'object' && !Array.isArray(given)) {
    const box = given as { caption?: unknown; image?: unknown; fields?: unknown };
    if (typeof box.caption === 'string') out.caption = box.caption;
    if (typeof box.image === 'string') {
      const path = findFile(box.image, file, scan);
      const key = path ? assetKey(path, scan) : null;
      if (key) out.imageAssetId = key;
    }
    if (Array.isArray(box.fields)) {
      for (const field of box.fields as Record<string, unknown>[]) {
        if (typeof field?.key !== 'string') continue;
        const value = Array.isArray(field.value) ? field.value.map(String).join(', ') : (asText(field.value) ?? '');
        out.fields.push({
          key: field.key,
          label: typeof field.label === 'string' ? field.label : fieldLabel(field.key, pageType),
          kind: typeof field.kind === 'string' ? field.kind : fieldKind(field.key, value, Array.isArray(field.value)),
          value,
        });
      }
    }
  }
  // Notes often keep these as plain properties.
  for (const key of Object.keys(KNOWN_FIELDS)) {
    if (fields[key] === undefined || fields[key] === null) continue;
    const isList = Array.isArray(fields[key]);
    const value = isList ? (fields[key] as unknown[]).map(String).join(', ') : asText(fields[key]);
    if (value !== undefined) out.fields.push({ key, label: fieldLabel(key, pageType), kind: fieldKind(key, value, isList), value });
  }
  return out.fields.length > 0 || out.caption || out.imageAssetId ? out : undefined;
}

/** The export puts the infobox picture first so it shows in Obsidian. It is not body text. */
function withoutLeadingImage(body: string, imagePath: unknown, file: string): string {
  if (typeof imagePath !== 'string') return body;
  const match = /^\s*!\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?\s*\)\s*/.exec(body);
  if (!match) return body;
  const same = resolveRelative(file, decodePath(match[1])).toLowerCase() === imagePath.toLowerCase();
  return same ? body.slice(match[0].length) : body;
}

function parseDoc(markdown: string, item: string, field: string, problems: ImportProblem[]): PmNode | undefined {
  const doc = markdownToPm(markdown);
  const problem = documentProblem(doc);
  if (problem) {
    problems.push({ severity: 'error', item, field, message: problem });
    return undefined;
  }
  return doc;
}

interface SceneFile {
  book: string;
  part?: string;
  chapter: string;
  chapterOrder: number;
  order: number;
  node: PayloadNode;
}

function assembleBooks(scenes: SceneFile[], bookFields: Map<string, PayloadBook>): PayloadBook[] {
  const titles = [...new Set([...bookFields.keys(), ...scenes.map((s) => s.book)])];
  return titles.map((title) => {
    const own = scenes.filter((s) => s.book === title).sort((a, b) => a.chapterOrder - b.chapterOrder || a.order - b.order);
    const top: PayloadNode[] = [];
    const parts = new Map<string, PayloadNode>();
    const chapters = new Map<string, PayloadNode>();
    for (const scene of own) {
      const chapterKey = `${scene.part ?? ''}\u0000${scene.chapter}\u0000${scene.chapterOrder}`;
      let chapter = chapters.get(chapterKey);
      if (!chapter) {
        chapter = { kind: 'chapter', title: scene.chapter, children: [] };
        chapters.set(chapterKey, chapter);
        if (scene.part) {
          let part = parts.get(scene.part);
          if (!part) {
            part = { kind: 'part', title: scene.part, children: [] };
            parts.set(scene.part, part);
            top.push(part);
          }
          part.children?.push(chapter);
        } else {
          top.push(chapter);
        }
      }
      chapter.children?.push(scene.node);
    }
    return { ...(bookFields.get(title) ?? { title }), children: top };
  });
}

export function normalizeMarkdownFiles(
  files: MarkdownFile[],
  otherFiles: string[],
  root: string,
  options: MarkdownOptions = DEFAULT_MARKDOWN_OPTIONS,
): Normalized {
  const problems: ImportProblem[] = [];
  const payload = emptyPayload();
  let assetNumber = 0;
  const stamp = Date.now().toString(36);
  const scan: Scan = {
    titles: new Map(),
    byPath: new Map(otherFiles.map((path) => [path.toLowerCase(), path])),
    byName: new Map(otherFiles.map((path) => [fileName(path).toLowerCase(), path])),
    assets: new Map(),
    root,
    missing: [],
    nextKey: () => {
      assetNumber += 1;
      return `import-${stamp}-${assetNumber}`;
    },
  };

  const parsed = files
    .map((file) => ({ file, ...splitFrontMatter(file.text, file.path, problems) }))
    .sort((a, b) => a.file.path.localeCompare(b.file.path));

  // Links name files, so every file's title must be known before reading any of them.
  // In a vault the file name is the note's name. A heading only stands in for one that
  // says nothing, because notes often start with a heading like "Overview".
  for (const { file, fields, body } of parsed) {
    if (fields.kind === 'scene' || fields.kind === 'book') continue;
    const name = baseName(file.path);
    const heading = GENERIC_NAME.test(name)
      ? /^\s*#\s+(.+?)\s*#*\s*$/.exec(body.split(/\r?\n/).find((line) => line.trim()) ?? '')?.[1]
      : undefined;
    const title = asText(fields.title) ?? heading ?? name;
    scan.titles.set(name.toLowerCase(), title.trim() || name);
  }

  const taken = new Map<string, string>();
  const scenes: SceneFile[] = [];
  const bookFields = new Map<string, PayloadBook>();

  for (const { file, fields, body } of parsed) {
    if (fields.kind === 'book') {
      const title = asText(fields.title) ?? baseName(file.path);
      bookFields.set(title, {
        source: file.path,
        title,
        subtitle: asText(fields.subtitle),
        author: asText(fields.author),
        targetWords: typeof fields.target_words === 'number' ? fields.target_words : undefined,
        createdAt: asTime(fields.created),
        updatedAt: asTime(fields.updated),
      });
      continue;
    }

    const tags = new Set<string>();
    if (fields.kind === 'scene') {
      const markdown = convertBody(body, file.path, scan, tags, { ...options, tagsAsCategories: false });
      const content = parseDoc(markdown, file.path, 'body', problems);
      const book = asText(fields.book) ?? 'Imported book';
      scenes.push({
        book,
        part: asText(fields.part),
        chapter: asText(fields.chapter) ?? 'Chapter',
        chapterOrder: typeof fields.chapter_order === 'number' ? fields.chapter_order : 0,
        order: typeof fields.order === 'number' ? fields.order : 0,
        node: {
          source: file.path,
          kind: 'scene',
          title: asText(fields.title) ?? baseName(file.path),
          status: asText(fields.status),
          synopsis: asText(fields.synopsis),
          notes: asText(fields.notes),
          storyDate: asText(fields.story_date),
          targetWords: typeof fields.target_words === 'number' ? fields.target_words : undefined,
          pov: asText(fields.pov),
          content,
          localOnly: localOnly(fields),
          createdAt: asTime(fields.created),
          updatedAt: asTime(fields.updated),
        },
      });
      continue;
    }

    const titleFromFile = scan.titles.get(baseName(file.path).toLowerCase()) ?? baseName(file.path);
    let title = titleFromFile;
    let text = body;
    const firstLine = body.split(/\r?\n/).find((line) => line.trim()) ?? '';
    const heading = /^\s*#\s+(.+?)\s*#*\s*$/.exec(firstLine);
    // The first heading is the page's name, so it should not appear twice.
    if (heading && titleKey(heading[1]) === titleKey(title)) text = body.replace(firstLine, '');

    // Two notes in different folders may share a name. Only one can have the title.
    const key = titleKey(title);
    const clash = taken.get(key);
    if (clash) {
      const folder = file.path.split('/').slice(-2, -1)[0] ?? 'another folder';
      title = `${title} (${folder})`;
      problems.push({ severity: 'warning', item: file.path, field: 'title', message: t('has the same name as {other}, so it was called "{title}".', { other: clash, title }) });
    }
    taken.set(titleKey(title), file.path);

    const box = fields.infobox as { image?: unknown } | undefined;
    text = withoutLeadingImage(text, box?.image, file.path);
    const infobox = infoboxFrom(fields, scan, file.path);
    const markdown = convertBody(text, file.path, scan, tags, options);
    const content = parseDoc(markdown, file.path, 'body', problems);
    const notes = typeof fields.talk === 'string' ? parseDoc(convertBody(fields.talk, file.path, scan, new Set(), { ...options, tagsAsCategories: false }), file.path, 'talk', problems) : undefined;

    const categories = new Set<string>(textList(fields.categories ?? fields.category, /,/));
    // LoreCraft's own export writes each category as a tag too, as far as tags can hold it.
    const asTags = new Set([...categories].map(categoryToTag));
    for (const tag of textList(fields.tags ?? fields.tag, /[,\s]+/)) {
      const name = tag.replace(/^#/, '');
      if (!asTags.has(name)) categories.add(name);
    }
    tags.forEach((tag) => categories.add(tag));
    if (options.foldersAsCategories) {
      file.path.split('/').slice(0, -1).forEach((folder) => categories.add(folder));
    }

    const page: PayloadPage = {
      source: file.path,
      title,
      pageType: asText(fields.type) ?? asText(fields.pageType),
      status: ['canon', 'draft', 'idea', 'retconned'].includes(String(fields.status)) ? String(fields.status) : undefined,
      summary: asText(fields.summary) ?? asText(fields.description),
      aliases: textList(fields.aliases ?? fields.alias, /,/),
      categories: [...categories],
      infobox,
      content,
      notes,
      isHome: fields.home === true ? true : undefined,
      localOnly: localOnly(fields),
      createdAt: asTime(fields.created),
      updatedAt: asTime(fields.updated),
    };
    payload.pages.push(page);
  }

  for (const { file, target } of scan.missing) {
    problems.push({ severity: 'warning', item: file, field: 'body', message: t('shows {target}, which is not in the chosen folder.', { target }) });
  }
  payload.books = assembleBooks(scenes, bookFields);
  payload.assets = [...scan.assets.values()];
  return { payload, problems };
}
