/** Book settings' point of view and tense. Each saves as soon as it is chosen, like the style. */

import { useEffect, useState } from 'react';

import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { toast } from '../shell/toasts';
import { useLocale } from '../state/language';
import {
  loadBookVoice,
  POV_OPTIONS,
  povLabel,
  saveBookVoice,
  TENSE_OPTIONS,
  tenseLabel,
  type BookPov,
  type BookTense,
  type BookVoice,
} from './bookVoice';

export function BookVoiceField({ bookId }: { bookId: string }) {
  useLocale();
  const [voice, setVoice] = useState<BookVoice>({});
  useEffect(() => {
    let live = true;
    void loadBookVoice(bookId).then((stored) => {
      if (live) setVoice(stored);
    }, () => {});
    return () => {
      live = false;
    };
  }, [bookId]);

  const change = (next: BookVoice) => {
    setVoice(next);
    void saveBookVoice(bookId, next).catch((e) =>
      toast(t('Could not save the book settings: {reason}', { reason: errorMessage(e) }), 'error'),
    );
  };

  return (
    <div className="book-voice">
      <label className="field">
        <span className="field-label">{t('Point of view')}</span>
        <select
          className="select"
          value={voice.pov ?? ''}
          onChange={(e) => change({ ...voice, pov: (e.target.value || undefined) as BookPov | undefined })}
        >
          <option value="">{t('Not set')}</option>
          {POV_OPTIONS.map((pov) => (
            <option key={pov} value={pov}>{povLabel(pov)}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field-label">{t('Tense')}</span>
        <select
          className="select"
          value={voice.tense ?? ''}
          onChange={(e) => change({ ...voice, tense: (e.target.value || undefined) as BookTense | undefined })}
        >
          <option value="">{t('Not set')}</option>
          {TENSE_OPTIONS.map((tense) => (
            <option key={tense} value={tense}>{tenseLabel(tense)}</option>
          ))}
        </select>
      </label>
      <span className="field-hint book-voice-hint">
        {t('The AI writes this book in them. A scene’s point-of-view character still applies.')}
      </span>
    </div>
  );
}
