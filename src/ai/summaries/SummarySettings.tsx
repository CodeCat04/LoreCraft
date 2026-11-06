/** Whether summaries are kept, and whether a cloud profile may make them. */

import { t } from '../../lib/i18n';
import { useLocale } from '../../state/language';
import { useSettings } from '../../state/settings';
import { profileForTask, providerLabel } from '../client';
import { confirmRun } from '../limits/confirmRun';
import * as coreApi from '../../lib/api';
import { resumeSummaries } from './worker';

export function SummarySettings() {
  useLocale();
  const summaries = useSettings((s) => s.settings.ai.summaries);
  useSettings((s) => s.settings.ai.routing.extract);
  const update = useSettings((s) => s.update);
  const profile = profileForTask('extract');

  const allowCloud = async (allow: boolean) => {
    if (allow) {
      // Turning this on sends a whole book there, so the cost is shown first.
      const books = await coreApi.books.list().catch(() => []);
      const trees = await Promise.all(books.map((book) => coreApi.nodes.tree(book.id).catch(() => [])));
      const words = trees.flat().reduce((sum, node) => sum + (node.kind === 'scene' ? node.wordCount : 0), 0);
      const go = await confirmRun({ label: t('Summarize your books with a cloud profile'), text: 'word '.repeat(words), profile, outputShare: 0.15 });
      if (!go) return;
    }
    await update({ ai: { summaries: { allowCloud: allow } } });
    if (allow) resumeSummaries();
  };

  return (
    <div className="ai-settings-card" data-testid="ai-summary-settings">
      <label className="checkbox">
        <input type="checkbox" checked={summaries.enabled} onChange={(e) => void update({ ai: { summaries: { enabled: e.target.checked } } })} />
        <span>{t('Keep short summaries of each scene, chapter and book, for the AI to follow the story')}</span>
      </label>
      <p className="field-hint">
        {t('They are made in the background by the profile chosen for Extracting, and only what changed is done again. You can read and edit them in the AI pane\'s "Story so far" tab.')}
      </p>
      {profile.isCloud && (
        <label className="checkbox">
          <input type="checkbox" checked={summaries.allowCloud} onChange={(e) => void allowCloud(e.target.checked)} />
          <span>{t('Allow this to send my book to {provider} in the background', { provider: providerLabel(profile) })}</span>
        </label>
      )}
    </div>
  );
}
