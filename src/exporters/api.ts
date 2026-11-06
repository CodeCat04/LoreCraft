/** Native calls this module makes. See `rpc/snapshot.rs`, `import.rs` and `print.rs`. */

import { rpc } from '../lib/rpc';
import type { ImportPayload, ImportReport } from './import/types';
import type { ExportSnapshot, PrintDocument } from './types';

export const snapshot = {
  get: () => rpc<ExportSnapshot>('snapshot.get'),
};

export const printing = {
  /** Waits until the PDF is written. It can take a while, but does not block the UI. */
  pdf: (doc: PrintDocument, path: string) =>
    rpc<{ path: string; pages: number; size: number }>('print.pdf', { ...doc, path }),
  cancel: () => rpc<boolean>('print.cancel'),
};

export const importing = {
  preview: (payload: ImportPayload) => rpc<ImportReport>('import.preview', payload),
  apply: (payload: ImportPayload) => rpc<ImportReport>('import.apply', payload),
};
