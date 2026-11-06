/**
 * Spellchecking off the main thread, so typing is never held up. A worker holds one
 * language, and the client starts a new worker for another, which frees the memory of the
 * dictionary it had.
 */

import type { DictionaryFiles } from './dictionaries';
import { SpellEngine } from './engine';
import { Hunspell } from './hunspell';
import type { FromWorker, ToWorker } from './protocol';
import type { SpellScript } from './tokenize';

function send(message: FromWorker) {
  (self as unknown as { postMessage: (message: FromWorker) => void }).postMessage(message);
}

let engine: SpellEngine | null = null;

/** The client reads the files, since only the window can call Rust. This reads the rules. */
function load(files: DictionaryFiles, script: SpellScript) {
  try {
    const started = performance.now();
    engine = new SpellEngine(new Hunspell(files), script);
    send({ type: 'ready', loadMs: performance.now() - started });
  } catch (e) {
    send({ type: 'failed', message: e instanceof Error ? e.message : String(e) });
  }
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  if (message.type === 'load') {
    load(message.files, message.script);
    return;
  }
  if (!engine) return;
  switch (message.type) {
    case 'names':
      engine.setNames(message.names);
      break;
    case 'ignore':
      engine.ignore(message.word);
      break;
    case 'clearIgnored':
      engine.clearIgnored();
      break;
    case 'check': {
      const started = performance.now();
      const results = message.texts.map((text) => (engine as SpellEngine).check(text));
      send({ type: 'checked', id: message.id, results, workerMs: performance.now() - started });
      break;
    }
    case 'suggest':
      send({ type: 'suggested', id: message.id, suggestions: engine.suggest(message.word) });
      break;
  }
};
