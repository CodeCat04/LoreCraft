/**
 * Every export format, with what the export screen needs to know about it. This stays
 * small: the code that writes each format loads only when that format is used.
 */

import { t } from '../lib/i18n';
import type { ExportOptions, ExportScope } from './types';

export type FormatId =
  | 'json' | 'jsonl' | 'markdown' | 'csv' | 'yaml' | 'xml' | 'mediawiki' | 'site' | 'sillytavern' | 'sqlite' | 'wiki-pdf'
  | 'docx' | 'epub' | 'novel-pdf' | 'novel-markdown' | 'novel-text';

export type OptionName =
  | 'pageFilter' | 'sceneFilter' | 'bodyFormat' | 'csvBundle' | 'csvGuardFormulas' | 'infoboxInContent'
  | 'manuscriptFormat' | 'sceneTitles' | 'language' | 'pageSize' | 'bookMatter' | 'printReady'
  /** For formats meant for other AI tools, which leave out local-only material unless asked. */
  | 'includeLocalOnly';

export interface ExportFormat {
  id: FormatId;
  group: 'wiki' | 'novel';
  /** In the interface language, so read it when it is shown. */
  readonly name: string;
  /** One line for the chooser, in the interface language. */
  readonly description: string;
  /** The first is the default. */
  scopes: ExportScope[];
  options: OptionName[];
  defaults?: Partial<ExportOptions>;
  /** What stored files the format writes into its output. */
  files: 'none' | 'images' | 'all';
  /** How it is produced. */
  engine: 'worker' | 'print' | 'database';
  extension: (options: ExportOptions) => string;
  filterName: (options: ExportOptions) => string;
}

const fixed = (extension: string) => () => extension;
const named = (name: string) => () => name;

const DATA_SCOPES: ExportScope[] = ['project', 'wiki', 'book'];

export const FORMATS: ExportFormat[] = [
  {
    id: 'json',
    group: 'wiki',
    name: 'JSON',
    get description() {
      return t('The whole project with nothing lost. LoreCraft can import it back.');
    },
    scopes: DATA_SCOPES,
    options: ['pageFilter', 'sceneFilter'],
    files: 'all',
    engine: 'worker',
    extension: fixed('json'),
    filterName: named('JSON'),
  },
  {
    id: 'jsonl',
    group: 'wiki',
    name: 'JSONL',
    get description() {
      return t('One line of plain text per page or scene, for AI and search pipelines.');
    },
    scopes: DATA_SCOPES,
    options: ['pageFilter', 'sceneFilter', 'includeLocalOnly'],
    files: 'none',
    engine: 'worker',
    extension: fixed('jsonl'),
    filterName: named('JSON Lines'),
  },
  {
    id: 'markdown',
    group: 'wiki',
    name: 'Markdown',
    get description() {
      return t('A zip of Markdown files with front matter and wiki links. Opens as an Obsidian vault.');
    },
    scopes: DATA_SCOPES,
    options: ['pageFilter', 'sceneFilter'],
    files: 'all',
    engine: 'worker',
    extension: fixed('zip'),
    filterName: () => t('Zip archive'),
  },
  {
    id: 'csv',
    group: 'wiki',
    name: 'CSV',
    get description() {
      return t('A table of pages for spreadsheets, or a zip with scenes and relationships as well.');
    },
    scopes: DATA_SCOPES,
    options: ['csvBundle', 'csvGuardFormulas', 'pageFilter', 'sceneFilter'],
    files: 'none',
    engine: 'worker',
    extension: (o) => (o.csvBundle ? 'zip' : 'csv'),
    filterName: (o) => (o.csvBundle ? t('Zip archive') : 'CSV'),
  },
  {
    id: 'yaml',
    group: 'wiki',
    name: 'YAML',
    get description() {
      return t('The same data as JSON, in a form that is easy to read and edit by hand.');
    },
    scopes: DATA_SCOPES,
    options: ['bodyFormat', 'pageFilter', 'sceneFilter'],
    files: 'all',
    engine: 'worker',
    extension: fixed('yaml'),
    filterName: named('YAML'),
  },
  {
    id: 'xml',
    group: 'wiki',
    name: 'XML',
    get description() {
      return t('Pages, books and relationships as XML, with the structure documented.');
    },
    scopes: DATA_SCOPES,
    options: ['bodyFormat', 'pageFilter', 'sceneFilter'],
    files: 'none',
    engine: 'worker',
    extension: fixed('xml'),
    filterName: named('XML'),
  },
  {
    id: 'mediawiki',
    group: 'wiki',
    name: 'MediaWiki XML',
    get description() {
      return t('Wikitext pages for Special:Import. Upload picture files to the wiki separately.');
    },
    scopes: ['wiki'],
    options: ['pageFilter'],
    files: 'none',
    engine: 'worker',
    extension: fixed('xml'),
    filterName: named('MediaWiki XML'),
  },
  {
    id: 'site',
    group: 'wiki',
    get name() {
      return t('Website');
    },
    get description() {
      return t('A zip that works offline by opening index.html, with search, images and categories.');
    },
    scopes: ['wiki'],
    options: ['pageFilter'],
    files: 'all',
    engine: 'worker',
    extension: fixed('zip'),
    filterName: () => t('Zip archive'),
  },
  {
    id: 'sillytavern',
    group: 'wiki',
    name: 'SillyTavern World Info',
    get description() {
      return t('A world book that triggers on page titles and aliases. Leaves out retconned pages unless asked.');
    },
    scopes: ['wiki'],
    options: ['pageFilter', 'infoboxInContent', 'includeLocalOnly'],
    defaults: { includeRetconned: false },
    files: 'none',
    engine: 'worker',
    extension: fixed('json'),
    filterName: named('JSON'),
  },
  {
    id: 'sqlite',
    group: 'wiki',
    get name() {
      return t('SQLite database');
    },
    get description() {
      return t('An exact copy of the project file, including history. Opens in any SQLite tool.');
    },
    scopes: ['project'],
    options: [],
    files: 'none',
    engine: 'database',
    extension: fixed('sqlite'),
    filterName: () => t('SQLite database'),
  },
  {
    id: 'wiki-pdf',
    group: 'wiki',
    name: 'PDF',
    get description() {
      return t('One page or the whole wiki, laid out like the app, with links that work inside the PDF.');
    },
    scopes: ['page', 'wiki'],
    options: ['pageFilter', 'pageSize'],
    defaults: { pageSize: 'letter' },
    files: 'images',
    engine: 'print',
    extension: fixed('pdf'),
    filterName: named('PDF'),
  },
  {
    id: 'docx',
    group: 'novel',
    get name() {
      return t('Word document');
    },
    get description() {
      return t('A DOCX with real headings, as a book or in standard manuscript format.');
    },
    scopes: ['book', 'books'],
    options: ['bookMatter', 'manuscriptFormat', 'sceneTitles', 'sceneFilter', 'language'],
    files: 'images',
    engine: 'worker',
    extension: fixed('docx'),
    filterName: () => t('Word document'),
  },
  {
    id: 'epub',
    group: 'novel',
    name: 'EPUB',
    get description() {
      return t('An ebook with a working table of contents.');
    },
    scopes: ['book', 'books'],
    options: ['bookMatter', 'sceneTitles', 'sceneFilter', 'language'],
    files: 'images',
    engine: 'worker',
    extension: fixed('epub'),
    filterName: named('EPUB'),
  },
  {
    id: 'novel-pdf',
    group: 'novel',
    name: 'PDF',
    get description() {
      return t('A typeset book with contents and page numbers, ready for a printer if asked, or a double-spaced manuscript.');
    },
    scopes: ['book', 'books'],
    options: ['bookMatter', 'manuscriptFormat', 'printReady', 'pageSize', 'sceneTitles', 'sceneFilter', 'language'],
    files: 'images',
    engine: 'print',
    extension: fixed('pdf'),
    filterName: named('PDF'),
  },
  {
    id: 'novel-markdown',
    group: 'novel',
    name: 'Markdown',
    get description() {
      return t('One Markdown file with the book in reading order.');
    },
    scopes: ['book', 'books'],
    options: ['sceneTitles', 'sceneFilter'],
    files: 'none',
    engine: 'worker',
    extension: fixed('md'),
    filterName: named('Markdown'),
  },
  {
    id: 'novel-text',
    group: 'novel',
    get name() {
      return t('Plain text');
    },
    get description() {
      return t('One text file with the book in reading order.');
    },
    scopes: ['book', 'books'],
    options: ['sceneTitles', 'sceneFilter'],
    files: 'none',
    engine: 'worker',
    extension: fixed('txt'),
    filterName: () => t('Text'),
  },
];

export function formatById(id: FormatId): ExportFormat {
  return FORMATS.find((f) => f.id === id) as ExportFormat;
}
