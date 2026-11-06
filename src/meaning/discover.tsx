/** Ways to find search by meaning while it is off: a command, and a hint beside results. */

import { promptText } from '../shell/dialogs';
import { t } from '../lib/i18n';
import { useLocale } from '../state/language';
import { useNav } from '../state/nav';

/** When focus was asked for. A screen that does not appear soon after does not take it later. */
let focusWantedAt = 0;

/**
 * Opens Settings at search by meaning. Turning it on, and agreeing to the download or to a
 * provider, stay there, where the size and where text goes are explained.
 */
export function openMeaningSettings() {
  focusWantedAt = Date.now();
  useNav.getState().go({ view: 'settings', tab: 'ai' });
  // Settings already on screen do not mount again, so the section is found here instead.
  window.requestAnimationFrame(() => {
    const toggle = document.querySelector<HTMLInputElement>('[data-testid="meaning-settings"] input[type="checkbox"]');
    if (!toggle || !takeMeaningFocus()) return;
    toggle.closest('section')?.scrollIntoView({ block: 'start' });
    toggle.focus();
  });
}

/** True once, soon after `openMeaningSettings`, for the settings section to take focus. */
export function takeMeaningFocus(): boolean {
  const wanted = Date.now() - focusWantedAt < 2000;
  focusWantedAt = 0;
  return wanted;
}

/** Asks what to look for, then shows the search page with results by meaning. */
export async function searchByMeaning() {
  const q = await promptText({
    title: t('Search by meaning'),
    label: t('What are you looking for?'),
    placeholder: t('For example, the night the bridge fell'),
    confirmLabel: t('Search'),
  });
  if (q?.trim()) useNav.getState().go({ view: 'search', q: q.trim() });
}

/** Shown with search results while search by meaning is off. */
export function MeaningOffHint() {
  useLocale();
  return (
    <aside className="meaning-hint" data-testid="meaning-off-hint">
      <p>
        {t('Search by meaning is off. It finds passages by what they say, even when they share no words with your search.')}
      </p>
      <button type="button" className="btn btn-sm" onClick={openMeaningSettings}>
        {t('Turn on search by meaning…')}
      </button>
    </aside>
  );
}
