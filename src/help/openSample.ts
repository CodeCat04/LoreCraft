/** Help > Open sample world. It is always a new project, so nothing of the writer's changes. */

import * as api from '../lib/api';
import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { afterProjectChanged, ensureSaved } from '../shell/fileActions';
import { toast } from '../shell/toasts';

let opening = false;

export async function openSampleWorld(): Promise<void> {
  // A double click must not start a second project while the first is being filled.
  if (opening) return;
  opening = true;
  try {
    await open();
  } finally {
    opening = false;
  }
}

async function open(): Promise<void> {
  if (!(await ensureSaved())) return;
  try {
    const [{ SAMPLE_WORLD, SAMPLE_WORLD_NAME }, { normalizeLorebookFile }, { importing }] = await Promise.all([
      import('./sampleWorld'),
      import('../exporters/import/lorebookFile'),
      import('../exporters/api'),
    ]);
    const { payload, problems } = normalizeLorebookFile(SAMPLE_WORLD);
    const unreadable = problems.find((p) => p.severity === 'error');
    if (unreadable) throw new Error(`${unreadable.item}, ${unreadable.field}: ${unreadable.message}`);

    await api.project.create(SAMPLE_WORLD_NAME);
    const report = await importing.apply(payload);
    await afterProjectChanged();
    const refused = report.problems.find((p) => p.severity === 'error');
    if (refused) throw new Error(`${refused.item}, ${refused.field}: ${refused.message}`);
    toast(t('Opened the sample world as a new project. Explore or change anything, and your own projects stay as they are.'), 'success');
  } catch (e) {
    toast(t('Could not open the sample world: {reason}', { reason: errorMessage(e) }), 'error');
  }
}
