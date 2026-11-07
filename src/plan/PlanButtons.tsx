/** Ways into story planning from the Write area: an empty book, the Outline and the Corkboard. */

import { t } from '../lib/i18n';
import { useLocale } from '../state/language';
import { useNav } from '../state/nav';
import { openApplyStructure } from './ApplyStructure';

/** For an empty book, or no book at all. */
export function PlanButtons({ bookId }: { bookId?: string }) {
  useLocale();
  const go = useNav((s) => s.go);
  return (
    <div className="write-empty-plan">
      <button type="button" className="btn" onClick={() => go(bookId ? { view: 'plan', bookId } : { view: 'plan' })}>
        {t('Plan a story…')}
      </button>
      {bookId && (
        <button type="button" className="btn" onClick={() => void openApplyStructure()}>
          {t('Apply a story structure…')}
        </button>
      )}
    </div>
  );
}

/** A small button for the Outline and Corkboard headings. */
export function ApplyStructureButton() {
  useLocale();
  return (
    <button type="button" className="btn btn-sm" onClick={() => void openApplyStructure()}>
      {t('Apply structure…')}
    </button>
  );
}
