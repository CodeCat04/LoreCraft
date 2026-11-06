/** Messages between the editor and the spellcheck worker. */

import type { DictionaryFiles } from './dictionaries';
import type { SpellRange } from './engine';
import type { SpellScript } from './tokenize';

export type ToWorker =
  | { type: 'load'; files: DictionaryFiles; script: SpellScript }
  | { type: 'names'; names: string[] }
  | { type: 'ignore'; word: string }
  | { type: 'clearIgnored' }
  | { type: 'check'; id: number; texts: string[] }
  | { type: 'suggest'; id: number; word: string };

export type FromWorker =
  | { type: 'ready'; loadMs: number }
  | { type: 'failed'; message: string }
  | { type: 'checked'; id: number; results: SpellRange[][]; workerMs: number }
  | { type: 'suggested'; id: number; suggestions: string[] };
