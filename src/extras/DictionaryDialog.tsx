/** Shows and edits the words the project's spellchecker accepts. */

import { useMemo, useState } from 'react';

import { t } from '../lib/i18n';
import { rpc, errorMessage } from '../lib/rpc';
import { showDialog } from '../shell/dialogs';
import { toast } from '../shell/toasts';
import { useDataVersion, useLoad } from '../state/events';
import { useLocale } from '../state/language';

function DictionaryEditor({ close }: { close: (value: null) => void }) {
  useLocale();
  const version = useDataVersion('dictionary');
  const { data: words } = useLoad(() => rpc<string[]>('extras.dictionaryList'), [version]);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const shown = useMemo(() => {
    const needle = text.trim().toLowerCase();
    return (words ?? []).filter((word) => word.toLowerCase().includes(needle));
  }, [words, text]);

  const add = async () => {
    const word = text.trim();
    if (!word) return;
    try {
      await rpc('extras.dictionaryAdd', { word });
      setText('');
      setProblem(null);
    } catch (e) {
      setProblem(errorMessage(e));
    }
  };

  return (
    <div className="dictionary-editor">
      <h2 className="dialog-title">{t('Custom dictionary')}</h2>
      <p className="dialog-message">
        {t('Spellcheck accepts these words in this project, along with every page title and alias, which never need adding.')}
      </p>
      <form
        className="dictionary-add"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input
          className="input"
          autoFocus
          aria-label={t('Word to add or find')}
          placeholder={t('Add or find a word')}
          spellCheck={false}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setProblem(null);
          }}
        />
        <button type="submit" className="btn" disabled={!text.trim()}>{t('Add')}</button>
      </form>
      {problem && <div className="field-error" role="alert">{problem}</div>}
      {words && words.length === 0 && (
        <p className="muted dictionary-empty">
          {t('No words yet. Right-click a word with a red underline and choose Add to dictionary.')}
        </p>
      )}
      {words && words.length > 0 && shown.length === 0 && (
        <p className="muted dictionary-empty">{t('No words match. Press Enter to add it.')}</p>
      )}
      {shown.length > 0 && (
        <ul className="dictionary-list">
          {shown.map((word) => (
            <li key={word} className="dictionary-word">
              <span className="truncate">{word}</span>
              <button
                type="button"
                className="btn btn-sm"
                aria-label={t('Remove {word}', { word })}
                onClick={() => {
                  rpc('extras.dictionaryRemove', { word }).catch((e) => {
                    toast(t('Could not remove the word: {error}', { error: errorMessage(e) }), 'error');
                  });
                }}
              >
                {t('Remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn btn-primary" onClick={() => close(null)}>{t('Done')}</button>
      </div>
    </div>
  );
}

export function openDictionaryDialog(): Promise<null> {
  return showDialog<null>((close) => <DictionaryEditor close={close} />, null);
}
