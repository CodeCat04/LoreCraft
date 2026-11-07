/** The AI pane, settings, and the commands that reach them. */

import '../styles/ai.css';

import { listen } from '@tauri-apps/api/event';

import * as coreApi from '../lib/api';
import { subscribeLocale, t } from '../lib/i18n';
import { registerCommands } from '../shell/commands';
import { toast } from '../shell/toasts';
import { useProject } from '../state/project';
import { useSettings } from '../state/settings';
import {
  acceptChanges,
  activeChange,
  activeEditor,
  clearParkedSuggestions,
  hasRunningActions,
  openAskFor,
  pendingSuggestions,
  rejectChanges,
  rewriteInMyStyleFor,
  sendSelectionToPane,
  stepChange,
  stopRunningActions,
} from '../editor/ai';
import {
  continueScene,
  describeSynopsis,
  fleshOutPage,
  hasOpenPage,
  hasOpenScene,
  suggestInfobox,
  summarizePage,
} from './docActions';
import { characterOnScreen, startCharacterChat } from './companions/actions';
import { watchAiActivity } from './companions/AiStatus';
import { resetBeta } from './companions/BetaPanel';
import { installE2eBench } from './e2eBench';
import { deleteOpenChat, renameOpenChat, usePane } from './store';
import { isSourceLocalOnly, setSourceLocalOnly } from './limits/localOnly';
import { watchForSummaries } from './summaries/worker';
import { useNav } from '../state/nav';
import { profileForTask } from './client';
import { confirmRun } from './limits/confirmRun';
import { registerDraftingCommands } from './drafting';
import { openSensesForSelection } from './drafting/store';

/** Flesh out, after the cost estimate when the model is a cloud one. */
async function fleshOutWithEstimate(): Promise<void> {
  const entry = activeEditor();
  const profile = profileForTask('rewrite');
  if (entry && profile.isCloud) {
    // The page goes out with lore around it, and comes back longer than it went.
    const text = entry.editor.getText();
    const go = await confirmRun({ label: t('Flesh out this page'), text: `${text}
${text}`, profile, outputShare: 1 });
    if (!go) return;
  }
  await fleshOutPage();
}

function openPaneView(view: 'story'): Promise<void> {
  usePane.getState().setView(view);
  return useSettings.getState().update({ ai: { paneOpen: true } });
}

export { AiPane } from './AiPane';
export { AiSettings } from './AiSettings';
export { AiStatus } from './companions/AiStatus';
export { TalkToCharacterButton } from './companions/CharacterUi';
export { describeImage, profileSupportsImages, assetToImageBlock, type DescribeImageOptions } from './vision';
export { getStorySoFar, type StoryEntry, type StoryParams, type StorySoFar } from './summaries/api';
export { canSendTo } from './limits/localOnly';
export { draftSceneFromSynopsis, firstDraft } from './drafting';
export { confirmRun } from './limits/confirmRun';
export { estimateRunCost, type RunCostEstimate } from './limits/estimate';
export {
  AiError,
  complete,
  completeJson,
  stream,
  type AiRequest,
  type AiResult,
  type CompleteJsonOptions,
  type StreamHandle,
  type StreamHandlers,
} from './client';

function hasPending(): boolean {
  const entry = activeEditor();
  return !!entry && pendingSuggestions(entry.editor).some((s) => !s.stale);
}

/** Runs again when the interface language changes, which replaces the titles. */
function registerAiCommands() {
  registerCommands([
    {
      id: 'ai.togglePane',
      title: t('Toggle AI pane'),
      shortcut: 'Ctrl+Shift+A',
      menu: 'AI',
      order: 10,
      run: () => {
        const { settings, update } = useSettings.getState();
        return update({ ai: { paneOpen: !settings.ai.paneOpen } });
      },
    },
    {
      id: 'ai.ask',
      title: t('Ask AI about the selection…'),
      shortcut: 'Ctrl+Shift+K',
      menu: 'AI',
      order: 20,
      when: () => !!activeEditor(),
      keywords: 'rewrite edit change selection',
      run: () => {
        const entry = activeEditor();
        if (entry && !openAskFor(entry.editor)) toast(t('Select some text first.'));
      },
    },
    {
      id: 'ai.rewriteInMyStyle',
      title: t('Rewrite the selection in my style'),
      shortcut: 'Ctrl+Shift+Y',
      menu: 'AI',
      order: 20.5,
      when: () => !!activeEditor(),
      keywords: 'writing style default rewrite voice',
      run: () => {
        const entry = activeEditor();
        if (!entry) return;
        const result = rewriteInMyStyleFor(entry.editor);
        if (result === 'no-selection') toast(t('Select some text first.'));
        else if (result === 'no-style') toast(t('Choose a writing style first, for the project, book or scene.'));
      },
    },
    {
      id: 'ai.sendToPane',
      title: t('Send the selection to the AI pane'),
      shortcut: 'Ctrl+Shift+M',
      menu: 'AI',
      order: 21,
      when: () => !!activeEditor(),
      run: () => {
        const entry = activeEditor();
        if (entry && !sendSelectionToPane(entry.editor)) toast(t('Select some text first.'));
      },
    },
    { id: 'ai.stopAction', title: t('Stop the running AI action'), menu: 'AI', order: 22, when: hasRunningActions, run: stopRunningActions },
    {
      id: 'ai.localOnly',
      title: t('Mark or unmark this document as local only'),
      menu: 'AI',
      order: 23,
      when: () => !!activeEditor() && activeEditor()?.source.kind !== 'notes',
      keywords: 'private cloud withhold',
      run: async () => {
        const entry = activeEditor();
        if (!entry) return;
        const next = !(await isSourceLocalOnly(entry.source));
        await setSourceLocalOnly(entry.source, next);
        toast(
          next
            ? t('"{title}" is now local only. It is never sent to a cloud provider.', { title: entry.source.title })
            : t('"{title}" is no longer local only.', { title: entry.source.title }),
        );
      },
    },

    // On a suggestion. These only apply while one is showing.
    {
      id: 'ai.acceptChange',
      title: t('Accept this suggested change'),
      shortcut: 'Alt+A',
      menu: 'AI',
      order: 30,
      when: hasPending,
      run: async () => {
        const entry = activeEditor();
        const change = entry && activeChange(entry.editor);
        if (entry && change) await acceptChanges(entry.editor, entry.source, change.suggestion.id, [change.hunk.id]);
      },
    },
    {
      id: 'ai.rejectChange',
      title: t('Reject this suggested change'),
      shortcut: 'Alt+R',
      menu: 'AI',
      order: 31,
      when: hasPending,
      run: () => {
        const entry = activeEditor();
        const change = entry && activeChange(entry.editor);
        if (entry && change) rejectChanges(entry.editor, change.suggestion.id, [change.hunk.id]);
      },
    },
    {
      id: 'ai.nextChange',
      title: t('Next suggested change'),
      shortcut: 'Alt+N',
      menu: 'AI',
      order: 32,
      when: hasPending,
      run: () => {
        const entry = activeEditor();
        if (entry) stepChange(entry.editor, 1);
      },
    },
    {
      id: 'ai.previousChange',
      title: t('Previous suggested change'),
      shortcut: 'Alt+P',
      menu: 'AI',
      order: 33,
      when: hasPending,
      run: () => {
        const entry = activeEditor();
        if (entry) stepChange(entry.editor, -1);
      },
    },
    {
      id: 'ai.acceptAll',
      title: t('Accept all suggested changes'),
      shortcut: 'Alt+Shift+A',
      menu: 'AI',
      order: 34,
      when: hasPending,
      run: async () => {
        const entry = activeEditor();
        if (!entry) return;
        for (const suggestion of pendingSuggestions(entry.editor).filter((s) => !s.stale)) {
          await acceptChanges(entry.editor, entry.source, suggestion.id);
        }
      },
    },
    {
      id: 'ai.rejectAll',
      title: t('Reject all suggested changes'),
      shortcut: 'Alt+Shift+R',
      menu: 'AI',
      order: 35,
      when: hasPending,
      run: () => {
        const entry = activeEditor();
        if (!entry) return;
        pendingSuggestions(entry.editor).filter((s) => !s.stale).forEach((s) => rejectChanges(entry.editor, s.id));
      },
    },

    // Whole documents. All of these end in a suggestion to review.
    { id: 'ai.fleshOut', title: t('Flesh out this page'), menu: 'AI', order: 40, when: hasOpenPage, keywords: 'write expand article', run: fleshOutWithEstimate },
    { id: 'ai.infobox', title: t('Suggest infobox fields'), menu: 'AI', order: 41, when: hasOpenPage, run: suggestInfobox },
    { id: 'ai.summary', title: t('Write a summary'), menu: 'AI', order: 42, when: hasOpenPage, run: summarizePage },
    { id: 'ai.continue', title: t('Continue writing'), menu: 'AI', order: 50, when: hasOpenScene, keywords: 'scene next', run: continueScene },
    { id: 'ai.synopsis', title: t("Describe this scene's synopsis"), menu: 'AI', order: 51, when: hasOpenScene, run: describeSynopsis },

    // Drafting help: Describe with the senses, on the selection.
    {
      id: 'ai.describeSenses',
      title: t('Describe with the senses'),
      menu: 'AI',
      order: 52,
      when: () => !!activeEditor() && activeEditor()?.source.kind !== 'notes',
      keywords: 'sight sound smell touch taste metaphor sensory detail',
      run: () => {
        const entry = activeEditor();
        if (entry && !openSensesForSelection(entry.editor, entry.source)) toast(t('Select some text first.'));
      },
    },

    // Help that gives something to read rather than something to accept.
    {
      id: 'ai.feedback',
      title: t('Get beta-reader feedback…'),
      menu: 'AI',
      order: 60,
      keywords: 'notes critique review pacing tension dialogue clarity continuity character',
      run: () => {
        usePane.getState().setView('feedback');
        return useSettings.getState().update({ ai: { paneOpen: true } });
      },
    },
    {
      id: 'ai.newChat',
      title: t('New AI chat'),
      menu: 'AI',
      order: 63,
      keywords: 'conversation start',
      run: () => {
        usePane.getState().newChat();
        return useSettings.getState().update({ ai: { paneOpen: true } });
      },
    },
    {
      id: 'ai.renameChat',
      title: t('Rename this AI chat'),
      menu: 'AI',
      order: 64,
      when: () => !!usePane.getState().conversation,
      keywords: 'conversation name title',
      run: renameOpenChat,
    },
    {
      id: 'ai.deleteChat',
      title: t('Delete this AI chat'),
      menu: 'AI',
      order: 65,
      when: () => !!usePane.getState().conversation,
      keywords: 'conversation remove',
      run: deleteOpenChat,
    },
    {
      id: 'ai.storySoFar',
      title: t('Show the story-so-far summaries'),
      menu: 'AI',
      order: 62,
      keywords: 'summary summaries recap chapters',
      run: () => openPaneView('story'),
    },
    {
      id: 'ai.settings',
      title: t('Open AI settings'),
      menu: 'AI',
      order: 90,
      keywords: 'model provider profile key server preferences',
      run: () => useNav.getState().go({ view: 'settings', tab: 'ai' }),
    },
    {
      id: 'ai.talkToCharacter',
      title: t('Talk to this character'),
      menu: 'AI',
      order: 61,
      when: () => !!characterOnScreen(),
      keywords: 'voice roleplay chat persona',
      run: () => {
        const character = characterOnScreen();
        if (character) startCharacterChat(character);
      },
    },
  ]);
}

export function registerAi() {
  registerAiCommands();
  subscribeLocale(registerAiCommands);

  // Drafting a scene from notes, a synopsis or a premise.
  registerDraftingCommands();
  subscribeLocale(registerDraftingCommands);

  watchAiActivity();

  // Conversations and suggestions belong to one project, and must not outlive it. This
  // runs here rather than in the pane, because the pane may not be open.
  const forgetProject = () => {
    clearParkedSuggestions();
    usePane.getState().reset();
    resetBeta();
  };
  void listen<{ entity: string }>('data://changed', (event) => {
    if (event.payload.entity === 'all') forgetProject();
  });
  useProject.subscribe((state, previous) => {
    if (previous.status.open && !state.status.open) forgetProject();
  });

  void coreApi.app.bootstrap().then((boot) => {
    if (boot.e2e) {
      // Tests start summaries themselves, so that no other test wakes the model.
      installE2eBench();
      return;
    }
    watchForSummaries((listener) => {
      void listen<{ entity: string }>('data://changed', (event) => listener(event.payload.entity));
    });
  }).catch(() => {});
}
