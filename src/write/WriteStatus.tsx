/** Word counts and the daily goal in the status bar. Renders nothing itself. */

import { useEffect } from 'react';

import { useLive, useWrite } from './store';
import { t } from '../lib/i18n';
import { formatNumber } from '../lib/text';
import { useLocale } from '../state/language';
import { useSettings } from '../state/settings';
import { useUi } from '../state/ui';

export function wordsText(words: number): string {
  return words === 1 ? t('{count} word', { count: formatNumber(words) }) : t('{count} words', { count: formatNumber(words) });
}

export function WriteStatus() {
  const locale = useLocale();
  const sceneId = useLive((s) => s.sceneId);
  const sceneWords = useLive((s) => s.words);
  const selected = useLive((s) => s.selected);
  const bookWords = useWrite((s) => s.index.words);
  const ready = useWrite((s) => s.ready);
  const written = useWrite((s) => s.stats?.writtenToday ?? null);
  const goal = useSettings((s) => s.settings.editor.dailyWordGoal);
  const setStatusItem = useUi((s) => s.setStatusItem);

  useEffect(() => {
    let text: string | null = null;
    if (selected > 0) {
      text = selected === 1
        ? t('{count} word selected', { count: formatNumber(selected) })
        : t('{count} words selected', { count: formatNumber(selected) });
    } else if (sceneId) {
      text = sceneWords === 1
        ? t('{count} word in scene · {book} in book', { count: formatNumber(sceneWords), book: formatNumber(bookWords) })
        : t('{count} words in scene · {book} in book', { count: formatNumber(sceneWords), book: formatNumber(bookWords) });
    } else if (ready) {
      text = bookWords === 1
        ? t('{count} word in book', { count: formatNumber(bookWords) })
        : t('{count} words in book', { count: formatNumber(bookWords) });
    }
    setStatusItem('write.words', text);
  }, [selected, sceneId, sceneWords, bookWords, ready, setStatusItem, locale]);

  useEffect(() => {
    const text =
      goal > 0 && written !== null
        ? t('Today {written} of {goal} words', { written: formatNumber(written), goal: formatNumber(goal) })
        : null;
    setStatusItem('write.goal', text);
  }, [written, goal, setStatusItem, locale]);

  useEffect(
    () => () => {
      setStatusItem('write.words', null);
      setStatusItem('write.goal', null);
    },
    [setStatusItem],
  );

  return null;
}
