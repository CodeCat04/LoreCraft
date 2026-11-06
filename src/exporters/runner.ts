/**
 * Runs an export from start to finish: gathers the data, hands the heavy work to a
 * worker so the window stays responsive, and writes the result where the person chose.
 */

import * as lib from '../lib/api';
import { flushOrStop } from '../editor/saving';
import { currentLocale, t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { printing, snapshot as snapshotApi } from './api';
import { expandPageLists } from '../editor/convert';
import { LARGEST_VIDEO_TO_EMBED, readAssetBase64 } from './assets';
import { formatById, type FormatId } from './registry';
import { applyScope } from './scope';
import type { TaskMessage, TaskRequest } from './task';
import type { ExportOptions, PrintDocument } from './types';

export interface ExportProgress {
  /** What is happening, in words. */
  label: string;
  /** From 0 to 1, or null when there is no way to tell. */
  fraction: number | null;
}

export interface ExportResult {
  path: string;
  size: number | null;
  pages?: number;
  warnings: string[];
}

export interface ExportJob {
  result: Promise<ExportResult>;
  cancel: () => void;
}

class Cancelled extends Error {}

export function isCancelled(error: unknown): boolean {
  return error instanceof Cancelled || (error as { code?: string })?.code === 'CANCELLED';
}

function runInBackground(
  request: TaskRequest,
  onMessage: (message: TaskMessage) => void,
): { stop: () => void } {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<TaskMessage>) => onMessage(event.data);
  worker.onerror = (event) => onMessage({ type: 'error', message: event.message || t('The export stopped unexpectedly.') });
  worker.postMessage(request);
  return { stop: () => worker.terminate() };
}

export function startExport(
  formatId: FormatId,
  options: ExportOptions,
  path: string,
  onProgress: (progress: ExportProgress) => void,
): ExportJob {
  const format = formatById(formatId);
  let cancelled = false;
  let stopWorker = () => {};
  let laidOut = false;

  const check = () => {
    if (cancelled) throw new Cancelled('Cancelled.');
  };

  const work = async (): Promise<ExportResult> => {
    onProgress({ label: t('Saving what you were typing…'), fraction: null });
    await flushOrStop();
    check();

    if (format.engine === 'database') {
      onProgress({ label: t('Copying the project…'), fraction: null });
      await lib.project.exportCopy(path);
      return { path, size: null, warnings: [] };
    }

    onProgress({ label: t('Reading the project…'), fraction: null });
    const everything = await snapshotApi.get();
    check();
    // A list block's query means nothing outside the app, so formats get what it shows today.
    // JSON is the format that reimports with nothing lost, so it keeps the query.
    if (formatId !== 'json' && options.bodyFormat !== 'prosemirror') {
      for (const page of everything.pages) page.content = expandPageLists(page.content, everything.pages);
      for (const node of everything.nodes) node.content = expandPageLists(node.content, everything.pages);
    }

    const warnings: string[] = [];
    const assetData = new Map<string, string>();
    if (format.files !== 'none' && format.engine !== 'print') {
      const { snapshot } = applyScope(everything, options);
      const wanted = snapshot.assets.filter((asset) => {
        // A very large video would have to fit in memory. Each format says what it did instead.
        const video = asset.mime.startsWith('video/');
        return !video || (format.files === 'all' && asset.size <= LARGEST_VIDEO_TO_EMBED);
      });
      for (let i = 0; i < wanted.length; i += 1) {
        check();
        onProgress({ label: t('Reading files: {name}', { name: wanted[i].name }), fraction: i / wanted.length });
        const base64 = await readAssetBase64(wanted[i].id);
        if (base64 !== null) assetData.set(wanted[i].id, base64);
        else warnings.push(t('{name} could not be read, so it was left out.', { name: wanted[i].name }));
      }
    }
    check();

    onProgress({ label: t('Writing {format}…', { format: format.name }), fraction: null });
    const outcome = await new Promise<{ base64: string; size: number } | { document: PrintDocument }>((resolve, reject) => {
      const { stop } = runInBackground(
        {
          format: formatId,
          snapshot: everything,
          assetData,
          options,
          exportedAt: new Date().toISOString(),
          locale: currentLocale(),
        },
        (message) => {
          switch (message.type) {
            case 'progress':
              onProgress({ label: t('Writing {format}…', { format: format.name }), fraction: message.done / Math.max(1, message.total) });
              break;
            case 'warning':
              if (!warnings.includes(message.message)) warnings.push(message.message);
              break;
            case 'bytes':
              stop();
              resolve(message);
              break;
            case 'print':
              stop();
              resolve(message);
              break;
            case 'error':
              stop();
              reject(new Error(message.message));
              break;
          }
        },
      );
      stopWorker = () => {
        stop();
        reject(new Cancelled('Cancelled.'));
      };
    });
    stopWorker = () => {};
    check();

    if ('document' in outcome) {
      onProgress({ label: t('Laying out pages…'), fraction: null });
      laidOut = true;
      const done = await printing.pdf(outcome.document, path);
      laidOut = false;
      return { path, size: done.size, pages: done.pages, warnings };
    }
    onProgress({ label: t('Saving the file…'), fraction: null });
    await lib.files.writeBytes(path, outcome.base64);
    return { path, size: outcome.size, warnings };
  };

  return {
    result: work().catch((error: unknown) => {
      if (isCancelled(error)) throw error;
      throw new Error(errorMessage(error));
    }),
    cancel: () => {
      cancelled = true;
      stopWorker();
      if (laidOut) void printing.cancel();
    },
  };
}
