/**
 * The status bar's word on the AI: which profile and model are active, and whether it has
 * answered lately. This only ever changes because AI was used or the person clicked to check.
 * Nothing here polls the server, and the timer only rewords "2 minutes ago".
 */

import { useEffect, useState } from 'react';
import { create } from 'zustand';

import { t } from '../../lib/i18n';
import { relativeTime } from '../../lib/text';
import { toast } from '../../shell/toasts';
import { useLocale } from '../../state/language';
import { useSettings } from '../../state/settings';
import * as api from '../api';
import { onAiActivity, type AiActivity } from '../client';
import { usePane, usePaneProfile } from '../store';

type LastSeen = Pick<AiActivity, 'state' | 'at' | 'model'>;

/** What is shown, and the last real answer or failure to go back to if a request is stopped. */
export interface SeenRecord {
  shown?: LastSeen;
  settled?: LastSeen;
}

export function nextSeen(record: SeenRecord | undefined, seen: LastSeen): SeenRecord {
  // A model name only the server knows stays known after a check that does not report one.
  const model = seen.model || record?.shown?.model || '';
  const next = { ...seen, model };
  if (seen.state === 'asking') return { ...record, shown: next };
  if (seen.state === 'stopped') return { ...record, shown: record?.settled && { ...record.settled, model } };
  return { shown: next, settled: next };
}

const useLastSeen = create<{ byProfile: Record<string, SeenRecord> }>(() => ({ byProfile: {} }));

function remember(profileId: string, seen: LastSeen): void {
  useLastSeen.setState((s) => ({ byProfile: { ...s.byProfile, [profileId]: nextSeen(s.byProfile[profileId], seen) } }));
}

/** Starts listening. Called once, when the module registers. */
export function watchAiActivity(): void {
  onAiActivity((activity) => remember(activity.profileId, activity));
}

/** The words for what is known. Exported for its tests. */
export function statusWords(seen: LastSeen | undefined, now = new Date()): string {
  if (!seen) return t('not used yet');
  switch (seen.state) {
    case 'asking':
      return t('waiting for an answer');
    case 'failed':
      return t('did not answer, {time}', { time: relativeTime(new Date(seen.at).toISOString(), now) });
    default:
      return t('answered {time}', { time: relativeTime(new Date(seen.at).toISOString(), now) });
  }
}

/** The status bar is outside any error boundary, so with no profile it simply says nothing. */
export function AiStatus() {
  const hasProfile = useSettings((s) => s.settings.ai.profiles.length > 0);
  return hasProfile ? <AiStatusLine /> : null;
}

function AiStatusLine() {
  useLocale();
  const profile = usePaneProfile();
  const chosen = usePane((s) => s.conversation?.context.model ?? s.pendingSettings.model);
  const seen = useLastSeen((s) => s.byProfile[profile.id]?.shown);
  const [checking, setChecking] = useState(false);
  const [, setMinute] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setMinute((m) => m + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const model = chosen || profile.model || seen?.model || t('whichever is loaded');
  const words = checking ? t('checking…') : statusWords(seen);

  const check = async () => {
    setChecking(true);
    const at = Date.now();
    try {
      const result = await api.provider.testConnection(profile.id);
      remember(profile.id, { state: result.ok ? 'answered' : 'failed', at, model: '' });
      if (!result.ok) toast(result.message, 'error');
    } catch (e) {
      remember(profile.id, { state: 'failed', at, model: '' });
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setChecking(false);
    }
  };

  return (
    <button
      type="button"
      className={`link-button status-item ai-status${seen?.state === 'failed' ? ' is-failed' : ''}`}
      data-testid="ai-status"
      data-state={seen?.state ?? 'unknown'}
      title={t('Check whether this profile answers now')}
      disabled={checking}
      onClick={() => void check()}
    >
      {t('AI: {name}, {model}, {status}', { name: profile.name, model, status: words })}
    </button>
  );
}
