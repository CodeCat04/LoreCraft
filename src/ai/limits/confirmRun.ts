/** The question asked before anything runs over a whole book. */

import { t } from '../../lib/i18n';
import { formatNumber } from '../../lib/text';
import type { AiProfile } from '../../lib/settings';
import { choose } from '../../shell/dialogs';
import { providerLabel } from '../client';
import { estimateRunCost, type EstimateOptions } from './estimate';
import { money, spendingState } from './spending';

export interface ConfirmRunOptions extends EstimateOptions {
  /** What is about to happen, such as "Summarize this book". */
  label: string;
  /** Everything that will be sent. */
  text: string;
  profile: AiProfile;
}

/**
 * Shows the estimate and asks, for a cloud profile. A local profile costs nothing and
 * sends nothing away, so it does not ask. True means go ahead.
 */
export async function confirmRun({ label, text, profile, outputShare }: ConfirmRunOptions): Promise<boolean> {
  if (!profile.isCloud) return true;
  const estimate = estimateRunCost(text, profile, { outputShare });
  const provider = providerLabel(profile);
  const tokens = formatNumber(estimate.inputTokens + estimate.outputTokens);
  const cost =
    estimate.usd === null
      ? t('This profile has no prices set, so the cost cannot be estimated.')
      : t('It should cost about {cost}. This is an estimate, and the real cost can differ.', { cost: money(estimate.usd) });
  const spending = spendingState();
  const spent =
    spending.limitUsd > 0
      ? ` ${t('You have spent about {spent} of your {limit} limit this month.', { spent: money(spending.spentUsd), limit: money(spending.limitUsd) })}`
      : '';
  const sends = t('This sends text from your project to {provider}, about {count} tokens in all.', { provider, count: tokens });
  const choice = await choose<'no' | 'yes'>({
    title: t('{action}?', { action: label }),
    message: `${sends} ${cost}${spent}`,
    dismissValue: 'no',
    choices: [
      { label: t('Cancel'), value: 'no' },
      { label: t('Go ahead'), value: 'yes', tone: 'primary' },
    ],
  });
  return choice === 'yes';
}
