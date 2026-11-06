import { t } from '../lib/i18n';
import { hashBlob } from './sha256';

export interface FileHash {
  done: Promise<string>;
  cancel: () => void;
}

/** Starts hashing a file in a worker, alongside its upload. */
export function hashFile(file: Blob): FileHash {
  let worker: Worker | undefined;
  const done = new Promise<string>((resolve, reject) => {
    // If a worker cannot start, hashing here is slower for typing but still correct.
    const fallback = () => hashBlob(file).then(resolve, reject);
    try {
      worker = new Worker(new URL('./hash.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      void fallback();
      return;
    }
    worker.onmessage = (event: MessageEvent<{ sha256?: string; error?: string }>) => {
      worker?.terminate();
      if (event.data.sha256) resolve(event.data.sha256);
      else reject(new Error(event.data.error ?? t('Could not read that file.')));
    };
    worker.onerror = () => {
      worker?.terminate();
      void fallback();
    };
    worker.postMessage(file);
  });
  // An abandoned upload may never ask for the result.
  done.catch(() => {});
  return { done, cancel: () => worker?.terminate() };
}
