import type { PmNode } from '../lib/types';
import type { ProseReport } from './analyze';
import type { AnalyzeRequest } from './engine';

export type ToWorker =
  | { type: 'scene'; id: string; doc: PmNode }
  | { type: 'forget'; id: string }
  | { type: 'analyze'; requestId: number; request: AnalyzeRequest };

export type FromWorker =
  | { type: 'report'; requestId: number; report: ProseReport }
  | { type: 'failed'; requestId: number; message: string };
