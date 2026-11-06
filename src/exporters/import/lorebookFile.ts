/**
 * Reads the format in docs/IMPORT_FORMAT.md, which is also what LoreCraft's JSON and YAML
 * exports write. Bodies may be Markdown or ProseMirror JSON and leave here as the latter.
 * Every problem names the item and the field, so whoever wrote the file can fix it.
 */

import { markdownToPm } from '../../editor/convert';
import { t } from '../../lib/i18n';
import type { AppendixSpec, BookPublishing, MatterPage, PmNode } from '../../lib/types';
import { FORMAT_NAME, FORMAT_VERSION } from '../wiki/lorebookFile';
import { FIELD_KINDS, fieldKind, fieldLabel } from './infoboxFields';
import { documentProblem } from './schemaCheck';
import {
  emptyPayload,
  type ImportProblem,
  type ImportPayload,
  type Normalized,
  type PayloadBook,
  type PayloadInfobox,
  type PayloadNode,
  type PayloadPage,
} from './types';

const PAGE_STATUSES = ['canon', 'draft', 'idea', 'retconned'];
const NODE_STATUSES = ['idea', 'outline', 'draft', 'revised', 'final'];

const TOP_FIELDS = new Set([
  'format', 'version', 'exportedAt', 'project', 'pages', 'books', 'relationships', 'assets', 'maps', 'dictionary', 'prompts', 'threads', 'canvases',
]);
const PAGE_FIELDS = new Set([
  'id', 'title', 'pageType', 'status', 'summary', 'aliases', 'categories', 'infobox', 'content', 'notes', 'isHome',
  'revealNodeId', 'localOnly', 'createdAt', 'updatedAt', 'wordCount',
]);
const BOOK_FIELDS = new Set([
  'id', 'title', 'subtitle', 'author', 'targetWords', 'createdAt', 'updatedAt', 'writingLog', 'children', 'publishing',
]);
const PUBLISHING_TEXT = ['coverAssetId', 'series', 'seriesNumber', 'description', 'language', 'publisher', 'isbn', 'copyrightYear'] as const;
const MATTER_PAGES = ['copyright', 'dedication', 'epigraph', 'acknowledgments', 'aboutAuthor'] as const;
const APPENDIX_KINDS = ['cast', 'glossary', 'maps'];
const NODE_FIELDS = new Set([
  'id', 'kind', 'title', 'status', 'synopsis', 'notes', 'storyDate', 'targetWords', 'pov', 'location', 'cast', 'threads', 'content',
  'localOnly', 'createdAt', 'updatedAt', 'wordCount', 'children',
]);

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

class Reader {
  constructor(
    private readonly item: string,
    private readonly fields: Json,
    private readonly problems: ImportProblem[],
    known: Set<string>,
  ) {
    for (const name of Object.keys(fields)) {
      if (!known.has(name)) this.warn(name, t('is not a field LoreCraft knows, so it was ignored. It knows {fields}.', { fields: [...known].join(', ') }));
    }
  }

  error(field: string, message: string) {
    this.problems.push({ severity: 'error', item: this.item, field, message });
  }

  warn(field: string, message: string) {
    this.problems.push({ severity: 'warning', item: this.item, field, message });
  }

  private value(field: string): unknown {
    const value = this.fields[field];
    return value === null ? undefined : value;
  }

  text(field: string): string | undefined {
    const value = this.value(field);
    if (value === undefined) return undefined;
    if (typeof value === 'string') return value;
    this.error(field, t('must be text, not {type}', { type: typeof value }));
    return undefined;
  }

  whole(field: string): number | undefined {
    const value = this.value(field);
    if (value === undefined) return undefined;
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    this.error(field, t('must be a whole number'));
    return undefined;
  }

  flag(field: string): boolean | undefined {
    const value = this.value(field);
    if (value === undefined) return undefined;
    if (typeof value === 'boolean') return value;
    this.error(field, t('must be true or false'));
    return undefined;
  }

  texts(field: string): string[] | undefined {
    const value = this.value(field);
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
      this.error(field, t('must be a list of text'));
      return undefined;
    }
    const out: string[] = [];
    value.forEach((entry, i) => {
      if (typeof entry === 'string') out.push(entry);
      else this.error(`${field}[${i}]`, t('must be text'));
    });
    return out;
  }

  oneOf(field: string, allowed: string[]): string | undefined {
    const value = this.text(field);
    if (value !== undefined && !allowed.includes(value)) {
      this.error(field, t('"{value}" is not one of {allowed}', { value: String(value), allowed: allowed.join(', ') }));
    }
    return value;
  }

  /** Markdown or ProseMirror JSON, returned as a checked document. */
  body(field: string): PmNode | undefined {
    const value = this.value(field);
    if (value === undefined) return undefined;
    let doc: PmNode;
    if (typeof value === 'string') doc = markdownToPm(value);
    else if (isObject(value)) doc = value as unknown as PmNode;
    else {
      this.error(field, t('must be Markdown text or a ProseMirror document'));
      return undefined;
    }
    if (doc.type !== 'doc') {
      this.error(field, t('must be Markdown text or a ProseMirror document with type "doc"'));
      return undefined;
    }
    const problem = documentProblem(doc);
    if (problem) {
      this.error(field, problem);
      return undefined;
    }
    return doc;
  }

  infobox(pageType: string | undefined): PayloadInfobox | undefined {
    const value = this.value('infobox');
    if (value === undefined) return undefined;
    if (!isObject(value)) {
      this.error('infobox', t('must be an object with a fields list'));
      return undefined;
    }
    // Anything else stored in an infobox comes through, so that nothing is lost by a
    // round trip if the wiki adds to it later.
    const out = { ...value, fields: [] } as PayloadInfobox;
    for (const name of ['imageAssetId', 'caption'] as const) {
      if (value[name] === undefined || value[name] === null) delete out[name];
      else if (typeof value[name] !== 'string') {
        delete out[name];
        this.error(`infobox.${name}`, t('must be text'));
      }
    }
    const fields = value.fields;
    if (fields === undefined || fields === null) return out;
    if (!Array.isArray(fields)) {
      this.error('infobox.fields', t('must be a list of objects with key and value'));
      return undefined;
    }
    fields.forEach((field: unknown, i) => {
      const at = `infobox.fields[${i}]`;
      if (!isObject(field)) {
        this.error(at, t('must be an object with key and value'));
        return;
      }
      const key = typeof field.key === 'string' ? field.key.trim() : '';
      if (!key) {
        this.error(`${at}.key`, t('is required'));
        return;
      }
      let text: string;
      if (Array.isArray(field.value) && field.value.every((v) => typeof v === 'string')) text = field.value.join(', ');
      else if (typeof field.value === 'string') text = field.value;
      else if (typeof field.value === 'number' || typeof field.value === 'boolean') text = String(field.value);
      else if (field.value === undefined || field.value === null) text = '';
      else {
        this.error(`${at}.value`, t('must be text'));
        return;
      }
      const kind = typeof field.kind === 'string' ? field.kind : fieldKind(key, text, Array.isArray(field.value));
      if (!FIELD_KINDS.includes(kind)) {
        this.error(`${at}.kind`, t('"{value}" is not one of {allowed}', { value: String(kind), allowed: FIELD_KINDS.join(', ') }));
        return;
      }
      const label = typeof field.label === 'string' && field.label ? field.label : fieldLabel(key, pageType);
      out.fields.push({ ...field, key, label, kind, value: text });
    });
    return out;
  }
}

function readPages(list: unknown, problems: ImportProblem[]): PayloadPage[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) {
    problems.push({ severity: 'error', item: t('the file'), field: 'pages', message: t('must be a list') });
    return [];
  }
  const out: PayloadPage[] = [];
  list.forEach((value: unknown, index) => {
    const base = `pages[${index}]`;
    if (!isObject(value)) {
      problems.push({ severity: 'error', item: base, field: '', message: t('must be an object') });
      return;
    }
    const titleText = typeof value.title === 'string' ? value.title : '';
    const item = titleText ? `${base} "${titleText}"` : base;
    const before = problems.length;
    const reader = new Reader(item, value, problems, PAGE_FIELDS);
    const title = reader.text('title');
    if (!title?.trim()) reader.error('title', t('is required'));
    const page: PayloadPage = {
      source: item,
      id: reader.text('id'),
      title: title ?? '',
      pageType: reader.text('pageType'),
      status: reader.oneOf('status', PAGE_STATUSES),
      summary: reader.text('summary'),
      aliases: reader.texts('aliases'),
      categories: reader.texts('categories'),
      infobox: reader.infobox(typeof value.pageType === 'string' ? value.pageType : undefined),
      content: reader.body('content'),
      notes: reader.body('notes'),
      isHome: reader.flag('isHome'),
      revealNodeId: reader.text('revealNodeId'),
      localOnly: reader.flag('localOnly'),
      createdAt: reader.text('createdAt'),
      updatedAt: reader.text('updatedAt'),
    };
    if (!problems.slice(before).some((p) => p.severity === 'error')) out.push(page);
  });
  return out;
}

/** A year or series number is often written as a number, and means the same as text. */
function asText(value: unknown): unknown {
  return typeof value === 'number' ? String(value) : value;
}

function readPublishing(value: unknown, item: string, problems: ImportProblem[]): BookPublishing | undefined {
  if (value === undefined || value === null) return undefined;
  const error = (field: string, message: string) => problems.push({ severity: 'error', item, field: `publishing${field}`, message });
  if (!isObject(value)) {
    error('', t('must be an object'));
    return undefined;
  }
  const out: BookPublishing = {};
  for (const name of PUBLISHING_TEXT) {
    const text = asText(value[name]);
    if (text === undefined || text === null) continue;
    if (typeof text === 'string') out[name] = text;
    else error(`.${name}`, t('must be text'));
  }
  if (typeof value.titlePage === 'boolean') out.titlePage = value.titlePage;
  else if (value.titlePage !== undefined && value.titlePage !== null) error('.titlePage', t('must be true or false'));
  for (const name of MATTER_PAGES) {
    const page = value[name];
    if (page === undefined || page === null) continue;
    // Plain text or Markdown alone means the page is wanted.
    const fields: Json = typeof page === 'string' ? { include: true, content: page } : isObject(page) ? page : {};
    if (typeof page !== 'string' && !isObject(page)) {
      error(`.${name}`, t('must be Markdown text, or an object with include and content'));
      continue;
    }
    const reader = new Reader(item, { [`publishing.${name}.content`]: fields.content }, problems, new Set([`publishing.${name}.content`]));
    const content = reader.body(`publishing.${name}.content`);
    const matter: MatterPage = { include: fields.include !== false, content: content ?? null };
    out[name] = matter;
  }
  if (Array.isArray(value.appendices)) {
    const appendices: AppendixSpec[] = [];
    value.appendices.forEach((entry: unknown, index) => {
      const at = `.appendices[${index}]`;
      if (!isObject(entry)) {
        error(at, t('must be an object with title and kind'));
        return;
      }
      if (typeof entry.kind !== 'string' || !APPENDIX_KINDS.includes(entry.kind)) {
        error(`${at}.kind`, t('must be one of {allowed}', { allowed: APPENDIX_KINDS.join(', ') }));
        return;
      }
      const texts = (list: unknown) => (Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : []);
      appendices.push({
        title: typeof entry.title === 'string' ? entry.title : '',
        kind: entry.kind as AppendixSpec['kind'],
        categories: texts(entry.categories),
        pageTypes: texts(entry.pageTypes),
        canonOnly: entry.canonOnly !== false,
        hideSpoilers: entry.hideSpoilers !== false,
      });
    });
    out.appendices = appendices;
  } else if (value.appendices !== undefined && value.appendices !== null) {
    error('.appendices', t('must be a list'));
  }
  return out;
}

function placementAllowed(parentKind: string | null, kind: string): boolean {
  if (kind === 'part') return parentKind === null;
  if (kind === 'chapter') return parentKind === null || parentKind === 'part';
  return kind === 'scene' && parentKind === 'chapter';
}

function readNodes(list: unknown, path: string, parentKind: string | null, problems: ImportProblem[]): PayloadNode[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) {
    problems.push({ severity: 'error', item: path, field: 'children', message: t('must be a list') });
    return [];
  }
  const out: PayloadNode[] = [];
  list.forEach((value: unknown, index) => {
    const base = `${path}.children[${index}]`;
    if (!isObject(value)) {
      problems.push({ severity: 'error', item: base, field: '', message: t('must be an object') });
      return;
    }
    const titleText = typeof value.title === 'string' ? value.title : '';
    const item = titleText ? `${base} "${titleText}"` : base;
    const before = problems.length;
    const reader = new Reader(item, value, problems, NODE_FIELDS);
    const kind = reader.oneOf('kind', ['part', 'chapter', 'scene']);
    if (kind === undefined) reader.error('kind', t('is required, and is one of part, chapter, scene'));
    else if (['part', 'chapter', 'scene'].includes(kind) && !placementAllowed(parentKind, kind)) {
      const inside = parentKind ? `a ${parentKind}` : 'the top level of a book';
      reader.error('kind', t('a {kind} cannot go inside {inside}. Books hold parts and chapters, parts hold chapters, chapters hold scenes.', { kind: String(kind), inside: String(inside) }));
    }
    if (kind !== 'scene' && value.content !== undefined && value.content !== null) {
      reader.error('content', t('only scenes hold text, and this is a {kind}', { kind: kind ?? 'node' }));
    }
    if (kind === 'scene' && Array.isArray(value.children) && value.children.length > 0) {
      reader.error('children', t('a scene cannot contain anything'));
    }
    const node: PayloadNode = {
      source: item,
      id: reader.text('id'),
      kind: (kind ?? 'scene') as PayloadNode['kind'],
      title: reader.text('title') ?? '',
      status: reader.oneOf('status', NODE_STATUSES),
      synopsis: reader.text('synopsis'),
      notes: reader.text('notes'),
      storyDate: reader.text('storyDate'),
      targetWords: reader.whole('targetWords'),
      pov: reader.text('pov'),
      location: reader.text('location'),
      cast: reader.texts('cast'),
      threads: reader.texts('threads'),
      content: kind === 'scene' ? reader.body('content') : undefined,
      localOnly: reader.flag('localOnly'),
      createdAt: reader.text('createdAt'),
      updatedAt: reader.text('updatedAt'),
    };
    if (kind && kind !== 'scene') node.children = readNodes(value.children, item, kind, problems);
    if (!problems.slice(before).some((p) => p.severity === 'error')) out.push(node);
  });
  return out;
}

function readThreads(list: unknown, problems: ImportProblem[]): ImportPayload['threads'] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) {
    problems.push({ severity: 'error', item: t('the file'), field: 'threads', message: t('must be a list') });
    return [];
  }
  const out: ImportPayload['threads'] = [];
  list.forEach((value: unknown, index) => {
    const base = `threads[${index}]`;
    if (!isObject(value)) {
      problems.push({ severity: 'error', item: base, field: '', message: t('must be an object with a name') });
      return;
    }
    const before = problems.length;
    const reader = new Reader(typeof value.name === 'string' ? `${base} "${value.name}"` : base, value, problems, new Set(['id', 'name', 'color', 'description', 'position']));
    const name = reader.text('name');
    if (!name?.trim()) reader.error('name', t('is required'));
    const thread = {
      id: reader.text('id'),
      name: name ?? '',
      color: reader.text('color'),
      description: reader.text('description'),
      position: reader.whole('position'),
    };
    if (!problems.slice(before).some((p) => p.severity === 'error')) out.push(thread);
  });
  return out;
}

function readBooks(list: unknown, problems: ImportProblem[]): PayloadBook[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) {
    problems.push({ severity: 'error', item: t('the file'), field: 'books', message: t('must be a list') });
    return [];
  }
  const out: PayloadBook[] = [];
  list.forEach((value: unknown, index) => {
    const base = `books[${index}]`;
    if (!isObject(value)) {
      problems.push({ severity: 'error', item: base, field: '', message: t('must be an object') });
      return;
    }
    const titleText = typeof value.title === 'string' ? value.title : '';
    const item = titleText ? `${base} "${titleText}"` : base;
    const before = problems.length;
    const reader = new Reader(item, value, problems, BOOK_FIELDS);
    const title = reader.text('title');
    if (!title?.trim()) reader.error('title', t('is required'));
    const log = value.writingLog;
    const book: PayloadBook = {
      source: item,
      title,
      subtitle: reader.text('subtitle'),
      author: reader.text('author'),
      targetWords: reader.whole('targetWords'),
      createdAt: reader.text('createdAt'),
      updatedAt: reader.text('updatedAt'),
      publishing: readPublishing(value.publishing, item, problems),
      writingLog: Array.isArray(log) ? (log as PayloadBook['writingLog']) : undefined,
      children: readNodes(value.children, item, null, problems),
    };
    if (!problems.slice(before).some((p) => p.severity === 'error')) out.push(book);
  });
  return out;
}

/** The value read from a JSON or YAML file. */
export function normalizeLorebookFile(data: unknown): Normalized {
  const problems: ImportProblem[] = [];
  const payload = emptyPayload();
  const fail = (field: string, message: string) => problems.push({ severity: 'error', item: t('the file'), field, message });

  if (!isObject(data)) {
    fail('', t('must hold one object, with format, version, pages and books. See docs/IMPORT_FORMAT.md.'));
    return { payload, problems };
  }
  if (data.format !== FORMAT_NAME) {
    fail('format', t('must be "{format}"', { format: FORMAT_NAME }));
    return { payload, problems };
  }
  if (data.version !== FORMAT_VERSION) {
    const newer = typeof data.version === 'number' && data.version > FORMAT_VERSION;
    fail('version', newer ? t('this file was made by a newer version of LoreCraft') : t('must be {version}', { version: FORMAT_VERSION }));
    return { payload, problems };
  }
  for (const name of Object.keys(data)) {
    if (!TOP_FIELDS.has(name)) {
      problems.push({ severity: 'warning', item: t('the file'), field: name, message: t('is not a field LoreCraft knows, so it was ignored. It knows {fields}.', { fields: [...TOP_FIELDS].join(', ') }) });
    }
  }

  payload.pages = readPages(data.pages, problems);
  payload.threads = readThreads(data.threads, problems);
  payload.books = readBooks(data.books, problems);

  if (Array.isArray(data.relationships)) payload.relationships = data.relationships as typeof payload.relationships;
  else if (data.relationships !== undefined && data.relationships !== null) fail('relationships', t('must be a list'));

  if (Array.isArray(data.assets)) {
    data.assets.forEach((asset: unknown, index) => {
      const item = `assets[${index}]`;
      if (!isObject(asset)) {
        problems.push({ severity: 'error', item, field: '', message: t('must be an object') });
        return;
      }
      if (asset.omitted) {
        problems.push({ severity: 'warning', item: `${item} "${String(asset.name)}"`, field: '', message: t('was too large for the export, so anything that shows it will have nothing to show.') });
        return;
      }
      // A file cannot name other files to read. Only the person's own dialogs can.
      const { path: _path, omitted: _omitted, size: _size, ...fields } = asset;
      payload.assets.push(fields as unknown as (typeof payload.assets)[number]);
    });
  } else if (data.assets !== undefined && data.assets !== null) fail('assets', t('must be a list'));

  if (Array.isArray(data.maps)) payload.maps = data.maps;
  if (Array.isArray(data.prompts)) payload.prompts = data.prompts;
  if (Array.isArray(data.canvases)) payload.canvases = data.canvases;
  if (Array.isArray(data.dictionary)) payload.dictionary = data.dictionary.filter((w): w is string => typeof w === 'string');
  if (isObject(data.project) && isObject(data.project.meta)) {
    payload.meta = Object.fromEntries(
      Object.entries(data.project.meta).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  }
  return { payload, problems };
}
