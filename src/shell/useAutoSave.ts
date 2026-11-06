import { useEffect } from 'react';

import { flushOrStop } from '../editor/saving';
import * as api from '../lib/api';
import { errorMessage } from '../lib/rpc';
import { useProject } from '../state/project';
import { useSettings } from '../state/settings';
import { toast } from './toasts';
import { t } from '../lib/i18n';

/** The optional timed save to the project file, from Settings. Off by default. */
export function useAutoSave() {
  const minutes = useSettings((s) => s.settings.save.autoSaveMinutes);

  useEffect(() => {
    if (minutes <= 0) return;
    const timer = window.setInterval(() => {
      const { open, dirty, path } = useProject.getState().status;
      // A project with no file still needs the user to choose where it goes.
      if (!open || !dirty || !path) return;
      void flushOrStop()
        .then(() => api.project.save())
        .catch((e) => {
          // A conflict with another program is for the user to resolve on a manual save.
          toast(t('Auto-save did not run: {error}', { error: errorMessage(e) }), 'error');
        });
    }, minutes * 60_000);
    return () => window.clearInterval(timer);
  }, [minutes]);
}
