/**
 * Background indexing. The native side does one small batch per call, so this loop is what
 * makes it background work: it runs while there is something to do, and it stops as soon as
 * the writer stops it, the project closes, or indexing is turned off.
 */

import { listen } from '@tauri-apps/api/event';
import { create } from 'zustand';

import { toast } from '../shell/toasts';
import { errorMessage } from '../lib/rpc';
import type { Settings } from '../lib/settings';
import { useProject } from '../state/project';
import { useSettings } from '../state/settings';
import { meaningApi, type MeaningStatus } from './api';

interface MeaningStore {
  status: MeaningStatus | null;
}

export const useMeaning = create<MeaningStore>(() => ({ status: null }));

function publish(status: MeaningStatus | null) {
  useMeaning.setState({ status });
}

/** Rests between batches, so the rest of the app always gets a turn. */
const BETWEEN_BATCHES_MS = 30;
/** After the last keystroke, so a paragraph being written is not embedded word by word. */
const AFTER_EDIT_MS = 4000;
const DOWNLOAD_POLL_MS = 400;

let pumping = false;
let wakeAgain = false;

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function enabled(): boolean {
  return useSettings.getState().settings.ai.embeddings.enabled;
}

async function pump() {
  if (pumping) {
    wakeAgain = true;
    return;
  }
  pumping = true;
  try {
    for (;;) {
      wakeAgain = false;
      if (!useProject.getState().status.open) {
        publish(enabled() ? await meaningApi.status() : null);
        break;
      }
      const status = await meaningApi.step();
      publish(status);
      if (status.state === 'indexing') {
        await sleep(BETWEEN_BATCHES_MS);
        continue;
      }
      if (!wakeAgain) break;
    }
  } catch (e) {
    // The app is closing or the project has gone, and the next wake starts over.
    console.warn('search by meaning:', errorMessage(e));
  } finally {
    pumping = false;
  }
}

export function wakeIndexing() {
  void pump();
}

/** Stops indexing for now. Passages already done are kept. */
export async function stopIndexing() {
  publish(await meaningApi.cancel());
}

/** Carries on after a stop, or tries again after a failure. */
export async function resumeIndexing() {
  publish(await meaningApi.resume());
  wakeIndexing();
}

/** Empties the index, which builds again if search by meaning is on. */
export async function clearIndex() {
  publish(await meaningApi.clear());
  wakeIndexing();
}

/** Changes the settings. The native side must have them before it is asked to act on them. */
export async function saveMeaningSettings(patch: Partial<Settings['ai']['embeddings']>) {
  await useSettings.getState().update({ ai: { embeddings: patch } });
  wakeIndexing();
}

let downloading = false;

/** Downloads the built-in model. Call only after the writer has agreed to its size. */
export async function downloadModel() {
  if (downloading) return;
  downloading = true;
  const poll = window.setInterval(() => {
    void meaningApi.status().then(publish).catch(() => {});
  }, DOWNLOAD_POLL_MS);
  try {
    publish(await meaningApi.download());
  } catch (e) {
    toast(errorMessage(e), 'error');
    publish(await meaningApi.status().catch(() => null));
  } finally {
    window.clearInterval(poll);
    downloading = false;
    wakeIndexing();
  }
}

export async function stopDownload() {
  publish(await meaningApi.cancelDownload());
}

/** Deletes the downloaded model, to free the space or to replace a damaged one. */
export async function removeModel() {
  publish(await meaningApi.removeModel());
}

let started = false;

/** Starts watching for reasons to index. Runs once at startup. */
export function startIndexing() {
  if (started) return;
  started = true;
  let lastOpen = useProject.getState().status.open;
  useProject.subscribe((state) => {
    if (state.status.open !== lastOpen) {
      lastOpen = state.status.open;
      wakeIndexing();
    }
  });
  let timer: number | undefined;
  void listen<{ entity: string }>('data://changed', (event) => {
    if (!enabled() || !['pages', 'pageContent', 'nodeContent', 'nodes', 'books', 'all'].includes(event.payload.entity)) return;
    if (useMeaning.getState().status?.state === 'failed') return;
    window.clearTimeout(timer);
    timer = window.setTimeout(wakeIndexing, event.payload.entity === 'all' ? 0 : AFTER_EDIT_MS);
  });
  wakeIndexing();
}
