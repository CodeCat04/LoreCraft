/** Hashes a file away from the main thread, so typing stays smooth during a large upload. */

import { hashBlob } from './sha256';

self.onmessage = (event: MessageEvent<Blob>) => {
  hashBlob(event.data).then(
    (sha256) => self.postMessage({ sha256 }),
    (e) => self.postMessage({ error: String(e) }),
  );
};
