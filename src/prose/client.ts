/**
 * The main thread's side of the prose worker. Only the newest question is answered, since
 * an answer about text that has since changed is of no use to anyone.
 */

import type { PmNode } from '../lib/types';
import type { ProseReport } from './analyze';
import { ProseEngine, type AnalyzeRequest } from './engine';
import { WORKER_FAILED } from './messages';
import type { FromWorker, ToWorker } from './protocol';

class ProseClient {
  private worker: Worker | null = null;
  /** Used if a worker cannot run. Slower to answer, but the checks still work. */
  private local: ProseEngine | null = null;
  private versions = new Map<string, string>();
  private nextRequest = 1;
  private waiting: { id: number; resolve: (report: ProseReport | null) => void; reject: (e: Error) => void } | null = null;

  private start() {
    if (this.worker || this.local) return;
    try {
      // Vite finds and bundles the worker from this exact form.
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<FromWorker>) => this.receive(event.data);
      worker.onerror = (event) => this.fail(event.message || WORKER_FAILED);
      this.worker = worker;
    } catch {
      this.local = new ProseEngine();
    }
  }

  /** The worker has gone, and what it held went with it. */
  private fail(message: string) {
    this.worker?.terminate();
    this.worker = null;
    this.local = new ProseEngine();
    this.versions.clear();
    this.waiting?.reject(new Error(message));
    this.waiting = null;
  }

  private receive(message: FromWorker) {
    if (message.requestId !== this.waiting?.id) return;
    const { resolve, reject } = this.waiting;
    this.waiting = null;
    if (message.type === 'report') resolve(message.report);
    else reject(new Error(message.message));
  }

  private post(message: ToWorker) {
    this.worker?.postMessage(message);
  }

  /** Whether this version of a scene has been read already. */
  has(id: string, version: string): boolean {
    return this.versions.get(id) === version;
  }

  setScene(id: string, version: string, doc: PmNode) {
    this.start();
    this.versions.set(id, version);
    if (this.local) this.local.setScene(id, doc);
    else this.post({ type: 'scene', id, doc });
  }

  /** Lets go of everything, as when another project opens. */
  reset() {
    for (const id of this.versions.keys()) {
      if (this.local) this.local.forget(id);
      else this.post({ type: 'forget', id });
    }
    this.versions.clear();
  }

  /** The report, or null if a newer question took its place. */
  analyze(request: AnalyzeRequest): Promise<ProseReport | null> {
    this.start();
    this.waiting?.resolve(null);
    const id = this.nextRequest;
    this.nextRequest += 1;
    return new Promise((resolve, reject) => {
      this.waiting = { id, resolve, reject };
      if (this.local) {
        const engine = this.local;
        // On its own turn, so whatever asked can finish first.
        window.setTimeout(() => {
          if (this.waiting?.id !== id) return;
          this.waiting = null;
          try {
            resolve(engine.analyze(request));
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        }, 0);
      } else {
        this.post({ type: 'analyze', requestId: id, request });
      }
    });
  }
}

export const proseClient = new ProseClient();
