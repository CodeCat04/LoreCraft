import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';

import { AppShell } from './shell/AppShell';
import { StartScreen } from './shell/StartScreen';
import { DialogHost } from './shell/dialogs';
import { ToastHost, toast } from './shell/toasts';
import { CommandPalette } from './shell/CommandPalette';
import { startContextMenuGuard, startShortcuts } from './shell/commands';
import { registerCoreCommands } from './shell/coreCommands';
import { registerModules } from './shell/modules';
import { startLinkActions } from './shell/ContextMenu';
import { afterProjectChanged, handleWindowClose, openProject, reopenLastProject } from './shell/fileActions';
import { offerRecovery } from './shell/RecoveryDialog';
import { setLocale, subscribeLocale } from './lib/i18n';
import { startEventBridge } from './state/events';
import { startLanguageTracking } from './state/language';
import { useProject } from './state/project';
import { useSettings } from './state/settings';
import { useAutoSave } from './shell/useAutoSave';
import { startWorkspaceTracking, useProjectSwitching } from './shell/workspace';
import { FirstRunGuide, startFirstRunGuide } from './help';
import { HoverCardHost } from './wiki';
import { clearAssetCache } from './lib/assets';
import { setPlatform } from './lib/platform';
import * as api from './lib/api';
import { errorMessage } from './lib/rpc';

let started = false;

async function startup(): Promise<void> {
  if (started) return;
  started = true;

  const boot = await api.app.bootstrap();
  useSettings.getState().hydrate(boot.settings);
  setPlatform(boot.platform);
  await setLocale(useSettings.getState().settings.language.interface);
  useProject.getState().setStatus(boot.status);
  await startEventBridge();
  await startLanguageTracking();
  registerCoreCommands();
  subscribeLocale(registerCoreCommands);
  registerModules();
  startShortcuts();
  // Ahead of the guard, which marks every context menu as dealt with.
  startLinkActions();
  startContextMenuGuard();
  startWorkspaceTracking();
  await listen('app://close-requested', () => void handleWindowClose());
  await listen<string>('app://open-file', (event) => void openProject(event.payload));

  // Let the window appear before any dialog asks a question.
  await api.app.ready();

  // Recovering unsaved work comes first. If that was offered and put off, the person has a
  // decision to make, and the start screen is the place to make it.
  if (await offerRecovery(boot.recoverable)) {
    await afterProjectChanged();
  } else if (boot.startupFile) {
    await openProject(boot.startupFile);
  } else if (boot.recoverable.length === 0) {
    await reopenLastProject();
  }

  startFirstRunGuide(boot);
}

export function App() {
  const isOpen = useProject((s) => s.status.open);
  const [ready, setReady] = useState(false);
  const switching = useProjectSwitching((s) => s.switching);
  useAutoSave();

  // Image ids belong to one project.
  useEffect(() => {
    if (!isOpen) clearAssetCache();
  }, [isOpen]);

  useEffect(() => {
    startup()
      .catch((e) => {
        toast(`LoreCraft could not start properly: ${errorMessage(e)}`, 'error');
        void api.app.ready().catch(() => {});
      })
      .finally(() => setReady(true));
  }, []);

  return (
    <>
      {ready && !switching && (isOpen ? <AppShell /> : <StartScreen />)}
      {isOpen && <HoverCardHost />}
      <FirstRunGuide />
      <CommandPalette />
      <DialogHost />
      <ToastHost />
    </>
  );
}
