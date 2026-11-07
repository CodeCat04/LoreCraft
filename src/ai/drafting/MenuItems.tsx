/** "Write as a scene" and its length, in the menu over selected text in a scene. */

import { useState } from 'react';
import type { Editor } from '@tiptap/core';

import { t } from '../../lib/i18n';
import { getCommand } from '../../shell/commands';
import { useLocale } from '../../state/language';
import type { EditorSource } from '../../editor/RichEditor';
import { lastDraftLength, lengthHint, lengthLabel, rememberDraftLength } from './DraftDialog';
import { DRAFT_LENGTHS, isDraftLength, type DraftLength } from './prompts';
import { writeSelectionAsScene } from './run';

export function WriteAsSceneItems(props: {
  editor: Editor;
  source: EditorSource;
  range: { from: number; to: number };
  canEdit: boolean;
  /** The menu closes once the draft starts. */
  onStart: () => void;
}) {
  useLocale();
  const { editor, source, range, canEdit, onStart } = props;
  const [length, setLength] = useState<DraftLength>(lastDraftLength);
  if (source.kind !== 'node') return null;
  const shortcut = getCommand('ai.writeAsScene')?.shortcut ?? 'Ctrl+Shift+E';
  return (
    <>
      <button
        type="button"
        className="btn btn-sm"
        disabled={!canEdit}
        aria-keyshortcuts={shortcut}
        title={
          canEdit
            ? t('Turn these notes into a finished scene, as suggested changes ({shortcut})', { shortcut })
            : t('Select some text to change. Figures stay as they are.')
        }
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          onStart();
          void writeSelectionAsScene(editor, source, range, length);
        }}
      >
        {t('Write as a scene')}
      </button>
      <select
        className="select ai-draft-length"
        aria-label={t('Length of the scene')}
        disabled={!canEdit}
        value={length}
        onChange={(e) => {
          if (!isDraftLength(e.target.value)) return;
          setLength(e.target.value);
          rememberDraftLength(e.target.value);
        }}
      >
        {DRAFT_LENGTHS.map((option) => (
          <option key={option} value={option} title={lengthHint(option)}>{lengthLabel(option)}</option>
        ))}
      </select>
    </>
  );
}
