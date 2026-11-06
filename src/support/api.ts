/** Native calls for logs, diagnostics and update checks. See `rpc/app.rs` and `updates.rs`. */

import { rpc } from '../lib/rpc';

export type UpdateStatus = 'current' | 'available' | 'noReleases' | 'offline' | 'rateLimited' | 'failed';

export interface UpdateCheck {
  status: UpdateStatus;
  current: string;
  latest: string | null;
  /** Markdown written on GitHub. Untrusted, so render it with `renderMarkdownSafe`. */
  notes: string | null;
  /** The release page, or the list of releases. */
  url: string;
  publishedAt: string | null;
}

export const support = {
  checkForUpdates: () => rpc<UpdateCheck>('app.checkForUpdates'),
  openLogFolder: () => rpc<boolean>('app.openLogFolder'),
  diagnostics: () => rpc<{ text: string }>('app.diagnostics'),
};
