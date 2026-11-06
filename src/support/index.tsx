/** Logs, diagnostics and update checks: what someone needs when reporting a problem. */

import { subscribeLocale, t } from '../lib/i18n';
import { registerCommands } from '../shell/commands';
import { useSettings } from '../state/settings';
import '../styles/support.css';
import { copyDiagnostics, openLogFolder } from './actions';
import { checkForUpdatesQuietly, registerUpdateCommand } from './updates';

export { SupportSettings } from './SupportSettings';

/** Long enough for the window, and any recovery question, to come first. */
const STARTUP_CHECK_DELAY_MS = 4000;

/** The Help menu's commands. Registered again when the language changes, so titles follow it. */
function registerSupportCommands() {
  registerUpdateCommand();
  registerCommands([
    {
      id: 'help.openLogFolder',
      title: t('Open log folder'),
      menu: 'Help',
      order: 30,
      keywords: 'logs errors problem bug report',
      run: openLogFolder,
    },
    {
      id: 'help.copyDiagnostics',
      title: t('Copy diagnostics'),
      menu: 'Help',
      order: 31,
      keywords: 'version system bug report',
      run: copyDiagnostics,
    },
  ]);
}

let followingLocale = false;

export function registerSupport() {
  registerSupportCommands();
  if (!followingLocale) {
    followingLocale = true;
    subscribeLocale(registerSupportCommands);
  }
  if (useSettings.getState().settings.updates.checkAtStartup) {
    window.setTimeout(() => void checkForUpdatesQuietly(), STARTUP_CHECK_DELAY_MS);
  }
}
