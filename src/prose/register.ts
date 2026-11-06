import { listen } from '@tauri-apps/api/event';

import { startReading, stopReading, useReadAloud, watchVoices } from './readAloud';
import { resetProse, setProseOpen, useProse } from './store';
import { activeEditor } from '../editor/ai/registry';
import { subscribeLocale, t } from '../lib/i18n';
import { registerCommands } from '../shell/commands';
import { toast } from '../shell/toasts';
import { useNav } from '../state/nav';
import { useProject } from '../state/project';

const hasProject = () => useProject.getState().status.open;

/** The open scene's editor, when the Write area is showing one that can be edited. */
function sceneEditor() {
  const entry = activeEditor();
  return entry?.source.kind === 'node' && entry.editor.isEditable ? entry.editor : null;
}

export function registerProse() {
  registerProseCommands();
  subscribeLocale(registerProseCommands);

  void listen<{ entity: string }>('data://changed', (event) => {
    if (event.payload.entity === 'all') {
      stopReading();
      resetProse();
    }
  }).catch(() => {});
}

/** Runs again when the interface language changes, which replaces the titles. */
function registerProseCommands() {
  registerCommands([
    {
      id: 'prose.panel',
      title: t('Prose checks'),
      shortcut: 'Ctrl+Alt+P',
      menu: 'View',
      order: 74,
      when: hasProject,
      keywords: 'overused repeated words adverbs filter passive sentence length reading level write',
      run: () => {
        const { open } = useProse.getState();
        const { route, go } = useNav.getState();
        // The panel belongs to the scene view.
        const inScene = route.view === 'write' && (route.mode ?? 'scene') === 'scene';
        if (!open && !inScene) go({ view: 'write' });
        setProseOpen(!open);
      },
    },
    {
      id: 'prose.readAloud',
      title: t('Read aloud'),
      shortcut: 'Ctrl+Alt+R',
      menu: 'View',
      order: 75,
      when: () => hasProject() && useReadAloud.getState().status === 'idle',
      keywords: 'speech voice speak listen text to speech',
      run: () => {
        watchVoices();
        const editor = sceneEditor();
        if (!editor) {
          toast(t('Open a scene to read it aloud.'));
          return;
        }
        // The controls for pausing and stopping are in the panel.
        setProseOpen(true);
        if (!startReading(editor)) toast(t('There is nothing here to read.'));
      },
    },
    {
      id: 'prose.stopReading',
      title: t('Stop reading aloud'),
      shortcut: 'Ctrl+Alt+R',
      menu: 'View',
      order: 76,
      when: () => useReadAloud.getState().status !== 'idle',
      keywords: 'speech voice speak',
      run: () => stopReading(),
    },
  ]);
}
