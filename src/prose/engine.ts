/**
 * Holds what has been read of each scene and answers questions about groups of them. It
 * normally lives in a worker, so a whole book can be read while the writer keeps typing.
 */

import type { PmNode } from '../lib/types';
import { analyze, countText, mergeCounts, segmentsFromDoc, type ProseOptions, type ProseReport, type ProseSegment, type TextCounts } from './analyze';

interface SceneData {
  segments: ProseSegment[];
  counts: TextCounts;
  /** Bumps each time the scene's text changes. */
  stamp: number;
}

export interface AnalyzeRequest {
  /** Scenes to report on, in reading order. */
  scope: string[];
  /** The rest of the text, which `scope` is compared with. */
  rest: string[];
  names: string[];
  options?: Omit<ProseOptions, 'names' | 'rest'>;
}

const EMPTY: TextCounts = { total: 0, counts: new Map() };

export class ProseEngine {
  private scenes = new Map<string, SceneData>();
  private stamps = 0;
  /** Typing changes only the scene in hand, so what is added up for the rest can stay. */
  private rest: { key: string; counts: TextCounts } | null = null;

  setScene(id: string, doc: PmNode) {
    const segments = segmentsFromDoc(doc, id);
    this.stamps += 1;
    this.scenes.set(id, { segments, counts: countText(segments), stamp: this.stamps });
  }

  forget(id: string) {
    this.scenes.delete(id);
  }

  private restCounts(ids: string[]): TextCounts {
    const parts: { id: string; data: SceneData }[] = [];
    for (const id of ids) {
      const data = this.scenes.get(id);
      if (data) parts.push({ id, data });
    }
    const key = parts.map((part) => `${part.id}:${part.data.stamp}`).join(',');
    if (this.rest?.key === key) return this.rest.counts;
    const counts = parts.length > 0 ? mergeCounts(parts.map((part) => part.data.counts)) : EMPTY;
    this.rest = { key, counts };
    return counts;
  }

  analyze(request: AnalyzeRequest): ProseReport {
    const segments = request.scope.flatMap((id) => this.scenes.get(id)?.segments ?? []);
    return analyze(segments, { ...request.options, names: request.names, rest: this.restCounts(request.rest) });
  }
}
