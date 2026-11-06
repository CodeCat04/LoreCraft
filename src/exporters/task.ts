/**
 * The work of one export, which runs in a worker so that the window stays free. Each
 * format's code, some of it large, loads only when that format is used.
 */

import { currentLocale, setLocale } from '../lib/i18n';
import { formatById, type FormatId } from './registry';
import { applyScope } from './scope';
import type { ExportInput, ExportOptions, ExportSnapshot, Exporter, PrintDocument } from './types';
import { bytesToBase64 } from './util';

export interface TaskRequest {
  format: FormatId;
  snapshot: ExportSnapshot;
  assetData: Map<string, string>;
  options: ExportOptions;
  exportedAt: string;
  /** The interface language, for warnings. A worker starts in English. */
  locale?: string;
}

export type TaskMessage =
  | { type: 'progress'; done: number; total: number }
  | { type: 'warning'; message: string }
  | { type: 'bytes'; base64: string; size: number }
  | { type: 'print'; document: PrintDocument }
  | { type: 'error'; message: string };

async function exporterFor(format: FormatId): Promise<Exporter> {
  switch (format) {
    case 'json':
      return (await import('./wiki/json')).exportJson;
    case 'jsonl':
      return (await import('./wiki/jsonl')).exportJsonl;
    case 'markdown':
      return (await import('./wiki/markdown')).exportMarkdown;
    case 'csv':
      return (await import('./wiki/csv')).exportCsv;
    case 'yaml':
      return (await import('./wiki/yaml')).exportYaml;
    case 'xml':
      return (await import('./wiki/xml')).exportXml;
    case 'mediawiki':
      return (await import('./wiki/mediawiki')).exportMediaWiki;
    case 'site':
      return (await import('./wiki/site')).exportSite;
    case 'sillytavern':
      return (await import('./wiki/sillytavern')).exportSillyTavern;
    case 'docx':
      return (await import('./novel/docx')).exportDocx;
    case 'epub':
      return (await import('./novel/epub')).exportEpub;
    case 'novel-markdown':
      return (await import('./novel/text')).exportNovelMarkdown;
    case 'novel-text':
      return (await import('./novel/text')).exportNovelText;
    default:
      throw new Error(`${format} is not made here.`);
  }
}

export async function runTask(request: TaskRequest, post: (message: TaskMessage) => void): Promise<void> {
  try {
    if (request.locale && request.locale !== currentLocale()) await setLocale(request.locale);
    const { snapshot, excludedPages } = applyScope(request.snapshot, request.options);
    for (const book of snapshot.books) {
      for (const message of book.matter?.warnings ?? []) post({ type: 'warning', message });
    }
    const input: ExportInput = {
      snapshot,
      excludedPages,
      assetData: request.assetData,
      options: request.options,
      exportedAt: request.exportedAt,
      progress: (done, total) => post({ type: 'progress', done, total }),
      warn: (message) => post({ type: 'warning', message }),
    };
    if (formatById(request.format).engine === 'print') {
      const { buildNovelPrintDocument, buildWikiPrintDocument } = await import('./print/document');
      const build = request.format === 'wiki-pdf' ? buildWikiPrintDocument : buildNovelPrintDocument;
      post({ type: 'print', document: build(input) });
      return;
    }
    const exporter = await exporterFor(request.format);
    const bytes = await exporter(input);
    post({ type: 'bytes', base64: bytesToBase64(bytes), size: bytes.length });
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
}
