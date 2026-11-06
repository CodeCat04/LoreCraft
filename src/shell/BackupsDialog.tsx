/**
 * File > Backups. Every save keeps the previous version of the file, closing without saving
 * keeps the changes for 14 days, and a file a newer LoreCraft upgrades is kept for good. This
 * lists them, and offers the safe way back (a copy that overwrites nothing) ahead of the
 * direct one. It works with no project open, because a lost or damaged file is when it
 * matters most.
 */

import { useCallback, useEffect, useState } from 'react';

import * as api from '../lib/api';
import { errorMessage } from '../lib/rpc';
import { relativeTime } from '../lib/text';
import type { BackupInfo } from '../lib/types';
import { flushOrStop } from '../editor/saving';
import { useProject } from '../state/project';
import { useSettings } from '../state/settings';
import { confirm, showDialog } from './dialogs';
import { afterProjectChanged, ensureSaved } from './fileActions';
import { toast } from './toasts';
import { currentLocale, t } from '../lib/i18n';
import { useLocale } from '../state/language';

function formatSize(size: number): string {
  const number = (value: number, digits: number) =>
    value.toLocaleString(currentLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false });
  if (size >= 1024 * 1024) return t('{size} MB', { size: number(size / (1024 * 1024), 1) });
  return t('{size} KB', { size: number(Math.max(1, Math.round(size / 1024)), 0) });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/** What `project.listBackups` also says about each backup: why it was made, and how long it stays. */
type Backup = BackupInfo & {
  kind?: 'save' | 'beforeRestore' | 'discarded' | 'beforeUpgrade';
  /** For `beforeUpgrade`, the LoreCraft version that changed the file's format. */
  upgradeVersion?: string | null;
  /** For `discarded`, when it will be removed. */
  keepUntil?: string | null;
};

/** The row's main line and the small note under it. */
function describe(backup: Backup, when: string): { title: string; note: string | null } {
  switch (backup.kind) {
    case 'discarded':
      return {
        title: t('Changes you chose not to save, {time}', { time: when }),
        note: backup.keepUntil ? t('kept until {date}', { date: formatDay(backup.keepUntil) }) : null,
      };
    case 'beforeUpgrade':
      return {
        title: t('Before upgrading to LoreCraft {version}, {time}', { version: backup.upgradeVersion ?? '', time: when }),
        note: t('always kept'),
      };
    default:
      return { title: when, note: backup.beforeRestore ? t('kept before a restore') : null };
  }
}

function BackupsBody({ close }: { close: () => void }) {
  useLocale();
  const projectOpen = useProject((s) => s.status.open);
  const keep = useSettings((s) => s.settings.save.backupsToKeep);
  const [showAll, setShowAll] = useState(false);
  const [backups, setBackups] = useState<Backup[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.project
      .listBackups(showAll)
      .then(setBackups)
      .catch((e) => {
        setBackups([]);
        toast(t('Could not list the backups: {error}', { error: errorMessage(e) }), 'error');
      });
  }, [showAll]);

  useEffect(load, [load, projectOpen]);

  const openCopy = async (backup: Backup) => {
    if (!(await ensureSaved())) return;
    setBusy(true);
    try {
      await api.project.openBackup(backup.path);
      await afterProjectChanged();
      close();
      toast(t('Opened a copy of the backup from {time}. Your project and its backups have not changed. Use Save as to keep this copy.', { time: formatTime(backup.savedAt) }), 'success');
    } catch (e) {
      toast(t('Could not open that backup: {error}', { error: errorMessage(e) }), 'error');
      load();
    } finally {
      setBusy(false);
    }
  };

  const restore = async (backup: Backup) => {
    const when = formatTime(backup.savedAt);
    const sure = await confirm({
      title: t('Restore this backup?'),
      message: (
        <>
          <p>{t('Your project will go back to how it was on {time}.', { time: when })}</p>
          <p className="backups-note">
            {t('What you have now, including anything not saved yet, is kept as another backup first, so you can return to it. Your project file does not change until you next save.')}
          </p>
        </>
      ),
      confirmLabel: t('Restore'),
      danger: true,
    });
    if (!sure) return;
    setBusy(true);
    try {
      await flushOrStop();
      await api.project.restoreBackup(backup.path);
      await afterProjectChanged();
      close();
      toast(t('Restored the backup from {time}. What you had before is kept as a backup. Save to make this your project file.', { time: when }), 'success');
    } catch (e) {
      toast(t('Could not restore that backup, and your project has not changed. {error}', { error: errorMessage(e) }), 'error');
      load();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (backup: Backup) => {
    const when = formatTime(backup.savedAt);
    const sure = await confirm({
      title: t('Delete this backup?'),
      message: t('The backup from {time} is deleted for good. Your project does not change.', { time: when }),
      confirmLabel: t('Delete'),
      danger: true,
    });
    if (!sure) return;
    setBusy(true);
    try {
      await api.project.deleteBackup(backup.path);
      toast(t('Deleted the backup from {time}.', { time: when }));
    } catch (e) {
      toast(t('Could not delete that backup: {error}', { error: errorMessage(e) }), 'error');
    } finally {
      setBusy(false);
      load();
    }
  };

  const showProject = !projectOpen || showAll;

  return (
    <div className="dialog-sheet" data-testid="backups">
      <h2 id="dialog-title" className="dialog-title">{t('Backups')}</h2>
      <p className="dialog-message">
        {keep === 1
          ? t('Each time you save, LoreCraft keeps the previous version of your file. It keeps 1 for each project. You can change that in Settings, under Saving.')
          : keep > 0
            ? t('Each time you save, LoreCraft keeps the previous version of your file. It keeps up to {count} for each project. You can change that in Settings, under Saving.', { count: keep })
            : t('Each time you save, LoreCraft keeps the previous version of your file. This is turned off at the moment. You can change that in Settings, under Saving.')}
      </p>
      {backups === null ? null : backups.length === 0 ? (
        <p className="empty-state">
          {projectOpen
            ? t('This project has no backups yet. Saving over an earlier version of a file makes the first one.')
            : t('There are no backups yet. Saving over an earlier version of a file makes the first one.')}
        </p>
      ) : (
        <div className="backups-scroll">
          <table className="data-table backups-table" aria-label={t('Backups')}>
            <thead>
              <tr>
                {showProject && <th scope="col">{t('Project')}</th>}
                <th scope="col">{t('Time')}</th>
                <th scope="col">{t('Size')}</th>
                <th scope="col"><span className="backups-actions-head">{t('Actions')}</span></th>
              </tr>
            </thead>
            <tbody>
              {backups.map((backup) => {
                const when = formatTime(backup.savedAt);
                const { title, note } = describe(backup, when);
                return (
                  <tr key={backup.path} data-testid="backup-row" data-kind={backup.kind ?? 'save'}>
                    {showProject && <td className="backups-project">{backup.name}</td>}
                    <td>
                      <div>{title}</div>
                      <div className="muted small">
                        {relativeTime(backup.savedAt)}
                        {note && ` · ${note}`}
                      </div>
                    </td>
                    <td className="backups-size">{formatSize(backup.size)}</td>
                    <td>
                      <div className="backups-actions">
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busy}
                          aria-label={t('Open a copy of the backup from {time}', { time: when })}
                          title={t('Opens this backup as a new, unsaved project. Nothing is overwritten.')}
                          onClick={() => void openCopy(backup)}
                        >
                          {t('Open a copy')}
                        </button>
                        {backup.isCurrent && (
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={busy}
                            aria-label={t('Restore the backup from {time}', { time: when })}
                            title={t('Puts the open project back to this version, after keeping what you have now as a backup.')}
                            onClick={() => void restore(backup)}
                          >
                            {t('Restore…')}
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busy}
                          aria-label={t('Delete the backup from {time}', { time: when })}
                          onClick={() => void remove(backup)}
                        >
                          {t('Delete…')}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="backups-note muted small">
        {projectOpen
          ? t('Open a copy opens the backup as a new, unsaved project, and overwrites nothing. Restore puts this project back to that version, after keeping what you have now as another backup.')
          : t('Open a copy opens the backup as a new, unsaved project, and overwrites nothing.')}
      </p>
      <p className="backups-note muted small">
        {t('When you close without saving, your changes are kept here for 14 days.')}
      </p>
      <div className="dialog-actions backups-footer">
        {projectOpen && (
          <label className="checkbox backups-all">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            <span>{t('Show backups of other projects')}</span>
          </label>
        )}
        {busy && <span className="muted" role="status">{t('Working on it…')}</span>}
        {/* The keyboard starts here, so that Enter does not open or restore anything. */}
        <button type="button" className="btn btn-primary" autoFocus onClick={close}>
          {t('Close')}
        </button>
      </div>
    </div>
  );
}

let open = false;

export async function openBackups(): Promise<void> {
  if (open) return;
  open = true;
  try {
    await showDialog<void>((close) => <BackupsBody close={() => close()} />, undefined);
  } finally {
    open = false;
  }
}
