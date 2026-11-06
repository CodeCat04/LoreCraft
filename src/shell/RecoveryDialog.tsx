import { useState } from 'react';

import { confirm, showDialog } from './dialogs';
import { useLocale } from '../state/language';
import { toast } from './toasts';
import * as api from '../lib/api';
import { t } from '../lib/i18n';
import { errorMessage, rpc } from '../lib/rpc';
import { relativeTime } from '../lib/text';
import type { Recoverable } from '../lib/types';

function RecoveryBody(props: { items: Recoverable[]; onDone: (id: string | null) => void }) {
  useLocale();
  const [items, setItems] = useState(props.items);

  const discard = async (item: Recoverable) => {
    const sure = await confirm({
      title: t('Discard the unsaved work in {name}?', { name: item.name }),
      message: t('It goes to Backups, in the File menu, where you can get it back for 14 days.'),
      confirmLabel: t('Discard'),
      danger: true,
    });
    if (!sure) return;
    try {
      // Nothing is deleted: the work moves into the backups.
      await api.project.discardRecovery(item.sessionId);
      const rest = items.filter((i) => i.sessionId !== item.sessionId);
      setItems(rest);
      toast(t('Moved to Backups. You can get it back from there for 14 days.'), 'info');
      if (rest.length === 0) props.onDone(null);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <>
      <h2 className="dialog-title">{t('Recover your work?')}</h2>
      <p className="dialog-message">
        {t('LoreCraft did not close normally last time, and it kept your unsaved changes.')}
      </p>
      <ul className="recovery-list">
        {items.map((item) => (
          <li key={item.sessionId} className="recovery-item">
            <div className="recovery-info">
              <strong>{item.name}</strong>
              <div className="muted small">
                {item.origin
                  ? t('Last edited {time} · {file}', { time: relativeTime(item.updatedAt), file: item.origin })
                  : t('Last edited {time} · never saved to a file', { time: relativeTime(item.updatedAt) })}
              </div>
            </div>
            <button type="button" className="btn btn-danger" onClick={() => void discard(item)}>
              {t('Discard')}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => props.onDone(item.sessionId)}>
              {t('Recover')}
            </button>
          </li>
        ))}
      </ul>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={() => props.onDone(null)}>
          {t('Decide later')}
        </button>
      </div>
    </>
  );
}

/** What starting up had to do about a settings file it could not read. See `settings.takeLoadReport`. */
interface SettingsLoadReport {
  /** Whether the backup copy was used, rather than the defaults. */
  restored: boolean;
  /** Where the unreadable file was kept, if it could be. */
  brokenFile: string | null;
}

/** Tells the writer if their settings file could not be read, and what was done instead. */
async function reportSettingsRecovery(): Promise<void> {
  let report: SettingsLoadReport | null = null;
  try {
    report = await rpc<SettingsLoadReport | null>('settings.takeLoadReport');
  } catch {
    return;
  }
  if (!report) return;
  const file = report.brokenFile;
  const text = report.restored
    ? file
      ? t('Your settings file could not be read, so LoreCraft went back to its backup copy. The unreadable file is kept as {file}.', { file })
      : t('Your settings file could not be read, so LoreCraft went back to its backup copy.')
    : file
      ? t('Your settings file could not be read and had no backup, so LoreCraft is using the default settings. The unreadable file is kept as {file}.', { file })
      : t('Your settings file could not be read and had no backup, so LoreCraft is using the default settings.');
  toast(text, 'error');
}

/**
 * Offers interrupted sessions. Returns true if one was recovered and is now open.
 * "Decide later" leaves the work on disk, and it is offered again next launch.
 * It also says if the settings had to be recovered, since it runs once at startup.
 */
export async function offerRecovery(items: Recoverable[]): Promise<boolean> {
  await reportSettingsRecovery();
  if (items.length === 0) return false;
  const chosen = await showDialog<string | null>(
    (close) => <RecoveryBody items={items} onDone={close} />,
    null,
  );
  if (!chosen) return false;
  try {
    await api.project.recover(chosen);
    toast(t('Your unsaved work is back. Press Ctrl+S to save it.'), 'success');
    return true;
  } catch (e) {
    toast(t('Could not recover that work: {reason}', { reason: errorMessage(e) }), 'error');
    return false;
  }
}
