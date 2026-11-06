/** Reads prose off the main thread, so typing never waits for it. */

import { ProseEngine } from './engine';
import type { FromWorker, ToWorker } from './protocol';

const engine = new ProseEngine();

function send(message: FromWorker) {
  (self as unknown as { postMessage: (message: FromWorker) => void }).postMessage(message);
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  switch (message.type) {
    case 'scene':
      engine.setScene(message.id, message.doc);
      break;
    case 'forget':
      engine.forget(message.id);
      break;
    case 'analyze':
      try {
        send({ type: 'report', requestId: message.requestId, report: engine.analyze(message.request) });
      } catch (e) {
        send({ type: 'failed', requestId: message.requestId, message: e instanceof Error ? e.message : String(e) });
      }
      break;
  }
};
