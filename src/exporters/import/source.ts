/** Reads what the person picked from disk, and turns it into an import. */

import { parse as parseYaml } from 'yaml';

import * as api from '../../lib/api';
import { t } from '../../lib/i18n';
import { base64ToBytes } from '../util';
import { normalizeDocxHtml, type DocxOptions } from './docx';
import { normalizeLorebookFile } from './lorebookFile';
import { extensionOf, normalizeMarkdownFiles, type MarkdownFile, type MarkdownOptions } from './markdownFiles';
import { decodeText, normalizeText, type TextOptions } from './text';
import type { Normalized } from './types';
import { unpacksTooLarge } from './zipLimits';

export type SourceKind = 'lorebook' | 'markdown' | 'docx' | 'text' | 'folder';

export interface Source {
  kind: SourceKind;
  /** Full path to the file or folder. */
  path: string;
  name: string;
  /** More than one file picked: only Markdown files can go together. */
  paths?: string[];
}

export function sourceKindOf(path: string): SourceKind | null {
  switch (extensionOf(path.replace(/\\/g, '/'))) {
    case 'json':
    case 'yaml':
    case 'yml':
      return 'lorebook';
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'docx':
      return 'docx';
    case 'txt':
    case 'text':
      return 'text';
    default:
      return null;
  }
}

function nameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function titleFromPath(path: string): string {
  return nameOf(path).replace(/\.[^.]+$/, '');
}

/** Several files can come in together only if they are Markdown. */
export function sourceFromFiles(paths: string[]): Source | null {
  if (paths.length === 0) return null;
  const kind = sourceKindOf(paths[0]);
  if (!kind || (paths.length > 1 && paths.some((path) => sourceKindOf(path) !== 'markdown'))) return null;
  return { kind, path: paths[0], name: paths.length > 1 ? `${paths.length} files` : nameOf(paths[0]), paths };
}

async function readAsText(path: string): Promise<string> {
  const { base64 } = await api.files.readBytes(path);
  return decodeText(base64ToBytes(base64));
}

/** Lets the window breathe between files. */
const breathe = () => new Promise((resolve) => setTimeout(resolve, 0));

async function readFolder(root: string, options: MarkdownOptions, onProgress: (text: string) => void): Promise<Normalized> {
  const entries = await api.files.listDir(root);
  const markdown = entries.filter((path) => ['md', 'markdown'].includes(extensionOf(path)));
  const others = entries.filter((path) => !['md', 'markdown'].includes(extensionOf(path)));
  const files: MarkdownFile[] = [];
  for (let i = 0; i < markdown.length; i += 1) {
    if (i % 20 === 0) {
      onProgress(t('Reading {number} of {count} files…', { number: i + 1, count: markdown.length }));
      await breathe();
    }
    files.push({ path: markdown[i], text: await readAsText(`${root}/${markdown[i]}`) });
  }
  onProgress(t('Converting…'));
  await breathe();
  return normalizeMarkdownFiles(files, others, root, options);
}

async function readLooseMarkdown(paths: string[], options: MarkdownOptions): Promise<Normalized> {
  const files: MarkdownFile[] = [];
  for (const path of paths) files.push({ path: nameOf(path), text: await readAsText(path) });
  return normalizeMarkdownFiles(files, [], '', options);
}

/** A failure in the worker is reported as a failed file rather than a crash. */
async function docxToHtml(bytes: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./docxWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ html?: string; error?: string }>) => {
      worker.terminate();
      if (event.data.error !== undefined) reject(new Error(event.data.error));
      else resolve(event.data.html ?? '');
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || t('That file could not be read.')));
    };
    const copy = bytes.slice().buffer as ArrayBuffer;
    worker.postMessage(copy, [copy]);
  });
}

export interface ReadOptions {
  markdown: MarkdownOptions;
  docx: Omit<DocxOptions, 'fallbackTitle'>;
  text: Omit<TextOptions, 'title'>;
  onProgress: (text: string) => void;
}

export async function readSource(source: Source, options: ReadOptions): Promise<Normalized> {
  switch (source.kind) {
    case 'lorebook': {
      const text = await readAsText(source.path);
      options.onProgress(t('Checking the file…'));
      await breathe();
      let data: unknown;
      try {
        data = extensionOf(source.path.replace(/\\/g, '/')) === 'json' ? JSON.parse(text) : parseYaml(text);
      } catch (error) {
        return {
          payload: normalizeLorebookFile({ format: 'lorebook', version: 1 }).payload,
          problems: [{ severity: 'error', item: source.name, field: '', message: t('could not be read: {error}', { error: error instanceof Error ? error.message : String(error) }) }],
        };
      }
      return normalizeLorebookFile(data);
    }
    case 'folder':
      return readFolder(source.path, options.markdown, options.onProgress);
    case 'markdown':
      return readLooseMarkdown(source.paths ?? [source.path], options.markdown);
    case 'docx': {
      const { base64 } = await api.files.readBytes(source.path);
      const bytes = base64ToBytes(base64);
      if (unpacksTooLarge(bytes)) {
        return {
          payload: normalizeLorebookFile({ format: 'lorebook', version: 1 }).payload,
          problems: [{
            severity: 'error', item: source.name, field: '',
            message: t('would unpack to more than is safe to read, so it was not opened. The file may be damaged.'),
          }],
        };
      }
      options.onProgress(t('Reading the Word document…'));
      const html = await docxToHtml(bytes);
      options.onProgress(t('Converting…'));
      await breathe();
      return normalizeDocxHtml(html, { ...options.docx, fallbackTitle: titleFromPath(source.path) });
    }
    case 'text': {
      const text = await readAsText(source.path);
      return normalizeText(text, { ...options.text, title: titleFromPath(source.path) });
    }
  }
}
