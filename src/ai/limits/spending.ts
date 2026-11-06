/**
 * The monthly limit on cloud spending. The running total is kept in settings, not in a
 * project, because the limit covers everything this person sends, whichever file is open.
 * It counts what the app's cost figures say, so a profile with no prices set counts as free.
 */

import { t } from '../../lib/i18n';
import { choose } from '../../shell/dialogs';
import { toast } from '../../shell/toasts';
import { useSettings } from '../../state/settings';
import type { AiProfile } from '../../lib/settings';

export const WARN_AT = 0.8;

export function currentMonth(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function money(usd: number): string {
  return usd > 0 && usd < 0.01 ? t('under $0.01') : `$${usd.toFixed(2)}`;
}

export interface SpendingState {
  month: string;
  spentUsd: number;
  /** 0 means there is no limit. */
  limitUsd: number;
  /** The writer chose to go past the limit this month. */
  overridden: boolean;
}

export function spendingState(now = new Date()): SpendingState {
  const stored = useSettings.getState().settings.ai.spending;
  const month = currentMonth(now);
  return {
    month,
    spentUsd: stored.month === month ? stored.spentUsd : 0,
    limitUsd: stored.limitUsd > 0 ? stored.limitUsd : 0,
    overridden: stored.overrideMonth === month,
  };
}

/** The state, if the limit stands in the way of sending to this profile. */
export function limitReached(profile: AiProfile): SpendingState | null {
  if (!profile.isCloud) return null;
  const state = spendingState();
  return state.limitUsd > 0 && state.spentUsd >= state.limitUsd && !state.overridden ? state : null;
}

export function limitMessage(state: SpendingState): string {
  return t('You have spent about {spent} of your {limit} cloud limit this month, so nothing was sent. Raise the limit in Settings > AI, or use a local profile.', {
    spent: money(state.spentUsd),
    limit: money(state.limitUsd),
  });
}

/** True if the writer chooses to go on, which holds for the rest of the month. */
export async function askToOverride(state: SpendingState): Promise<boolean> {
  const choice = await choose<'stop' | 'allow'>({
    title: t('Cloud spending limit reached'),
    message: t('You have spent about {spent} of your {limit} limit this month. Nothing has been sent. You can raise the limit in Settings > AI, or use a local profile.', {
      spent: money(state.spentUsd),
      limit: money(state.limitUsd),
    }),
    dismissValue: 'stop',
    choices: [
      { label: t('Stop'), value: 'stop' },
      { label: t('Allow for the rest of this month'), value: 'allow', tone: 'primary' },
    ],
  });
  if (choice !== 'allow') return false;
  await useSettings.getState().update({ ai: { spending: { overrideMonth: state.month } } });
  return true;
}

/** Adds what a response cost, and warns once a month on passing 80 percent. */
export function recordSpend(profile: AiProfile, costUsd: number | null): void {
  if (!profile.isCloud || !costUsd || costUsd <= 0) return;
  const { settings, update } = useSettings.getState();
  const state = spendingState();
  const spentUsd = state.spentUsd + costUsd;
  const warn = state.limitUsd > 0 && !state.overridden && spentUsd >= state.limitUsd * WARN_AT && settings.ai.spending.warnedMonth !== state.month;
  void update({ ai: { spending: { month: state.month, spentUsd, ...(warn ? { warnedMonth: state.month } : {}) } } }).catch(() => {});
  if (warn) {
    toast(
      t('You have used {percent}% of your {limit} cloud spending limit this month.', {
        percent: Math.min(100, Math.round((spentUsd / state.limitUsd) * 100)),
        limit: money(state.limitUsd),
      }),
    );
  }
}
