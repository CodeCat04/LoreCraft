/** Pictures, videos and tables in documents. See docs/ARCHITECTURE.md, "Media". */

import '../styles/media.css';

import { errorMessage } from '../lib/rpc';
import { toast } from '../shell/toasts';
import { registerMediaCommands } from './commands';
import { startDropGuard } from './dropGuard';
import { startMediaStatus } from './status';

export function registerMedia() {
  registerMediaCommands();
  startDropGuard();
  void startMediaStatus().catch((e) => toast(errorMessage(e), 'error'));
}
