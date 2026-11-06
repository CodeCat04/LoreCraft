/**
 * Ctrl+Alt+N from anywhere: a small box, type, Enter, gone. It is a dialog underneath, so
 * Escape and Tab behave and the keyboard goes back to exactly where it was afterwards.
 * The box waits for the save, so words that could not be stored are still there to retry.
 */

import { useEffect, useRef, useState } from 'react';

import { activeEditor } from '../editor/ai';
import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { showDialog } from '../shell/dialogs';
import { toast } from '../shell/toasts';
import { useLocale } from '../state/language';
import { useNav } from '../state/nav';
import { ideas, type IdeaSourceKind } from './api';

interface Place {
  kind: IdeaSourceKind;
  id: string;
  title: string;
}

/** The page or scene on screen. A page's talk notes count as the page. */
function currentPlace(): Place | null {
  const entry = activeEditor();
  if (entry) {
    const { kind, id, title } = entry.source;
    return { kind: kind === 'node' ? 'node' : 'page', id, title };
  }
  const { route } = useNav.getState();
  if (route.view === 'page') return { kind: 'page', id: route.id, title: '' };
  if (route.view === 'write' && route.nodeId) return { kind: 'node', id: route.nodeId, title: '' };
  return null;
}

/**
 * What was typed but not saved, in case Escape or a stray click closed the box. It comes
 * back selected, so it is one Enter away, and typing over it costs nothing.
 */
let unsaved = '';

function CaptureBox(props: { place: Place | null; onDone: () => void }) {
  useLocale();
  const { place, onDone } = props;
  const [text, setText] = useState(unsaved);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    boxRef.current?.focus();
    boxRef.current?.select();
  }, []);

  const save = async () => {
    if (busy) return;
    const value = text.trim();
    if (!value) {
      onDone();
      return;
    }
    setBusy(true);
    try {
      await ideas.add({ text: value, sourceKind: place?.kind, sourceId: place?.id });
      unsaved = '';
      onDone();
      toast(t('Idea saved to the inbox.'));
    } catch (e) {
      // The box stays with the words in it, so nothing is lost.
      setProblem(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <form
      className="inbox-capture"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2 id="dialog-title" className="inbox-capture-title">{t('New idea')}</h2>
      <textarea
        ref={boxRef}
        className="textarea inbox-capture-box"
        rows={2}
        value={text}
        aria-labelledby="dialog-title"
        aria-describedby="inbox-capture-hint"
        placeholder={t('Write it down before it gets away')}
        onChange={(e) => {
          unsaved = e.target.value;
          setText(e.target.value);
          setProblem(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void save();
          }
        }}
      />
      {problem && <div className="field-error" role="alert">{problem}</div>}
      <p id="inbox-capture-hint" className="field-hint">
        {place?.title
          ? t('Enter saves it to the inbox. Shift+Enter starts a new line. It will remember you were in {place}.', {
              place: place.title,
            })
          : t('Enter saves it to the inbox. Shift+Enter starts a new line.')}
      </p>
    </form>
  );
}

let isOpen = false;

export async function openCapture() {
  if (isOpen) return;
  isOpen = true;
  const place = currentPlace();
  try {
    await showDialog<void>((close) => <CaptureBox place={place} onDone={() => close()} />, undefined);
  } finally {
    isOpen = false;
  }
}
