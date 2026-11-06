/** What the status bar says during a save, and the warning about skipped backups. */

import { listen } from '@tauri-apps/api/event';

import { subscribeLocale, t } from '../lib/i18n';
import { toast } from '../shell/toasts';
import { useProject } from '../state/project';
import { useUi } from '../state/ui';
import { formatBytes } from './format';

/** Short saves finish before anyone could read the words, so they do not flash them. */
const SHOW_AFTER_MS = 150;

/** What the status bar says for a phase, in the current language. */
function phaseText(phase: string): string {
  return phase === 'backup' ? t('Saving: keeping a backup…') : t('Saving…');
}

let started = false;

export async function startMediaStatus() {
  if (started) return;
  started = true;

  let timer: number | undefined;
  let phase: string | null = null;
  const show = () => useUi.getState().setStatusItem('saving', phase ? phaseText(phase) : null);
  // A save still under way when the language changes says so in the new one.
  subscribeLocale(() => {
    if (phase !== null && useUi.getState().statusItems.saving !== undefined) show();
  });

  await listen<{ active: boolean; phase?: string }>('project://saving', ({ payload }) => {
    window.clearTimeout(timer);
    if (payload.active) {
      const shown = phase !== null && useUi.getState().statusItems.saving !== undefined;
      phase = payload.phase ?? 'saving';
      if (shown) show();
      else timer = window.setTimeout(show, SHOW_AFTER_MS);
    } else {
      phase = null;
      show();
    }
  });

  // Once per project in a run. Every save of a project that large would say the same.
  const warned = new Set<string>();
  await listen<{ size: number }>('project://backup-skipped', ({ payload }) => {
    const project = useProject.getState().status.path ?? useProject.getState().status.name;
    if (warned.has(project)) return;
    warned.add(project);
    toast(
      t(
        'This project is {size}, more than the space set aside for its backups, so no backup is being kept. Your saves are not affected. Removing unused media or linking large videos can bring it back under the limit.',
        { size: formatBytes(payload.size) },
      ),
      'info',
    );
  });
}
