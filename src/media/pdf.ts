/**
 * PDFs in the project. The web view cannot show one in a frame: the CSP's `frame-src` allows
 * only web addresses, and the `lbasset` scheme sends `sandbox`, which turns off the built-in
 * viewer. So a PDF card draws its first page with pdf.js, from bytes read through
 * `media_read`, and "Open" hands a copy to the system's own viewer (`media.open`).
 *
 * pdf.js is loaded only when a PDF is first drawn, and runs in its own worker with no
 * scripts from the document: forms, XFA and embedded JavaScript stay off.
 */

import { readAssetBytes } from '../lib/assets';
import { rpc } from '../lib/rpc';

type PdfJs = typeof import('pdfjs-dist');

let loading: Promise<PdfJs> | null = null;

function pdfjs(): Promise<PdfJs> {
  loading ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(
    ([lib, worker]) => {
      lib.GlobalWorkerOptions.workerSrc = worker.default;
      return lib;
    },
  );
  return loading;
}

export interface PdfPreview {
  pages: number;
}

/**
 * Draws page one of a PDF asset into `canvas`, at most `width` CSS pixels wide.
 * Throws if the file cannot be read or is not a PDF pdf.js understands.
 */
export async function drawFirstPage(id: string, canvas: HTMLCanvasElement, width: number): Promise<PdfPreview> {
  const lib = await pdfjs();
  const data = await readAssetBytes(id);
  const task = lib.getDocument({ data, enableXfa: false, disableAutoFetch: true, stopAtErrors: false });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const unscaled = page.getViewport({ scale: 1 });
    const ratio = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: (Math.max(50, width) / unscaled.width) * ratio });
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    canvas.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
    await page.render({ canvas, viewport }).promise;
    return { pages: doc.numPages };
  } finally {
    void task.destroy();
  }
}

/** Opens a PDF or sound file in the program the system uses for it. */
export function openInSystemViewer(id: string): Promise<boolean> {
  return rpc<boolean>('media.open', { id });
}
