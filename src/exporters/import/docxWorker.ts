/// <reference lib="webworker" />

/** Runs `mammoth` away from the window, because a long book takes it a while. */

import { docxBytesToHtml } from './mammoth';

self.onmessage = async (event: MessageEvent<ArrayBuffer>) => {
  try {
    const html = await docxBytesToHtml(event.data);
    self.postMessage({ html });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
