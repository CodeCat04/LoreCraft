/** New, open, save and close, with the prompts people expect from a word processor. */

import { useProject, useTitles } from '../state/project';
import { useSettings } from '../state/settings';
import * as api from '../lib/api';
import { RpcError, errorMessage } from '../lib/rpc';
import { flushAllEditors } from '../editor/saving';
import { t } from '../lib/i18n';
import { choose, promptText } from './dialogs';
import { toast } from './toasts';
import { forgetLastProject, saveWorkspace, setProjectSwitching, startWorkspace } from './workspace';

/** Opening also accepts `.lorebook`, from before the app was renamed. */
const filters = () => [{ name: t('LoreCraft project'), extensions: ['lorecraft', 'lorebook'] }];
const saveFilters = () => [{ name: t('LoreCraft project'), extensions: ['lorecraft'] }];

/**
 * Sets up the window for the project now open. Its remembered tabs come back unless `restore`
 * says otherwise, as for a project that has only just been made.
 */
export async function afterProjectChanged(options: { restore?: boolean } = {}): Promise<void> {
  setProjectSwitching(true);
  try {
    await useTitles.getState().refresh();
    await startWorkspace(options.restore ?? true);
  } finally {
    setProjectSwitching(false);
  }
}

/** At startup: opens the project in use last time. A missing file is no cause for a message. */
export async function reopenLastProject(): Promise<void> {
  const { save, session } = useSettings.getState().settings;
  if (!save.reopenLast || !session.lastProject) return;
  setProjectSwitching(true);
  try {
    await api.project.open(session.lastProject);
    await afterProjectChanged();
  } catch {
    // The file may be on a drive that is not there today. The start screen lists it.
  } finally {
    setProjectSwitching(false);
  }
}

function showError(e: unknown, what: string) {
  toast(t('{what}: {reason}', { what, reason: errorMessage(e) }), 'error');
}

/**
 * Makes sure everything typed has reached the project's working copy. If some of it could
 * not be stored, it says what and lets the writer try again. Returns false if they would
 * rather keep editing, in which case the caller must stop, since going on would lose it.
 */
export async function ensureWritten(): Promise<boolean> {
  for (;;) {
    const result = await flushAllEditors();
    if (result.ok) return true;
    const answer = await choose<'retry' | 'keep'>({
      title: t('Some changes could not be stored'),
      message: (
        <div data-testid="unwritten-message">
          <p>{t('LoreCraft could not store: {list}.', { list: result.unwritten.join(', ') })}</p>
          <p>{t('Your text is still on screen. Nothing was saved or closed.')}</p>
          {result.reason && <p className="muted">{t('Reason: {reason}', { reason: result.reason })}</p>}
        </div>
      ),
      dismissValue: 'keep',
      choices: [
        { label: t('Keep editing'), value: 'keep' },
        { label: t('Try again'), value: 'retry', tone: 'primary' },
      ],
    });
    if (answer !== 'retry') return false;
  }
}

/**
 * Makes sure unsaved work is dealt with. Returns false if the user cancelled, in
 * which case the caller must stop.
 */
export async function ensureSaved(): Promise<boolean> {
  if (!(await ensureWritten())) return false;
  await saveWorkspace();
  const status = await api.project.status();
  if (!status.open || !status.dirty) return true;
  const answer = await choose<'save' | 'discard' | 'cancel'>({
    title: t('Save changes to {name}?', { name: status.name }),
    message: t("If you don't save, your changes are kept in Backups for 14 days."),
    dismissValue: 'cancel',
    choices: [
      { label: t('Cancel'), value: 'cancel' },
      { label: t("Don't save"), value: 'discard', tone: 'danger' },
      { label: t('Save'), value: 'save', tone: 'primary' },
    ],
  });
  if (answer === 'cancel') return false;
  if (answer === 'save') return saveProject();
  // The native side refuses to replace a dirty session, so drop it explicitly.
  await api.project.close();
  return true;
}

export async function newProject(): Promise<void> {
  if (!(await ensureSaved())) return;
  const name = await promptText({
    title: t('New project'),
    label: t('Name of your world or series'),
    initial: t('Untitled'),
    confirmLabel: t('Create'),
    validate: (v) => (v.trim() ? null : t('A project needs a name.')),
  });
  if (name === null) return;
  setProjectSwitching(true);
  try {
    await api.project.create(name.trim());
    await afterProjectChanged({ restore: false });
  } catch (e) {
    showError(e, t('Could not create the project'));
  } finally {
    setProjectSwitching(false);
  }
}

export async function openProject(path?: string): Promise<void> {
  if (!(await ensureSaved())) return;
  let target = path;
  if (!target) {
    const picked = await api.files.pickOpen({ title: t('Open project'), filters: filters() });
    if (picked.length === 0) return;
    target = picked[0];
  }
  setProjectSwitching(true);
  try {
    await api.project.open(target);
    await afterProjectChanged();
  } catch (e) {
    showError(e, t('Could not open the project'));
  } finally {
    setProjectSwitching(false);
  }
}

/** Returns true if the project is now saved. */
export async function saveProject(): Promise<boolean> {
  if (!(await ensureWritten())) return false;
  try {
    await api.project.save();
    toast(t('Saved'), 'success');
    return true;
  } catch (e) {
    if (e instanceof RpcError && e.code === 'NEEDS_PATH') return saveProjectAs();
    if (e instanceof RpcError && e.code === 'EXTERNAL_CHANGE') {
      const answer = await choose<'overwrite' | 'saveAs' | 'cancel'>({
        title: t('The file changed outside LoreCraft'),
        message: t(
          'Another program changed this file after you opened it. It may be a sync tool. You can overwrite those changes or keep both by saving a copy.',
        ),
        dismissValue: 'cancel',
        choices: [
          { label: t('Cancel'), value: 'cancel' },
          { label: t('Overwrite'), value: 'overwrite', tone: 'danger' },
          { label: t('Save a copy'), value: 'saveAs', tone: 'primary' },
        ],
      });
      if (answer === 'saveAs') return saveProjectAs();
      if (answer === 'overwrite') {
        try {
          await api.project.save(true);
          toast(t('Saved'), 'success');
          return true;
        } catch (e2) {
          showError(e2, t('Could not save'));
        }
      }
      return false;
    }
    showError(e, t('Could not save'));
    return false;
  }
}

export async function saveProjectAs(): Promise<boolean> {
  if (!(await ensureWritten())) return false;
  const status = useProject.getState().status;
  const picked = await api.files.pickSave({
    title: t('Save project as'),
    defaultName: `${status.name || t('Untitled')}.lorecraft`,
    filters: saveFilters(),
  });
  if (!picked) return false;
  try {
    await api.project.saveAs(picked);
    toast(t('Saved'), 'success');
    return true;
  } catch (e) {
    showError(e, t('Could not save'));
    return false;
  }
}

export async function closeProject(): Promise<void> {
  if (!(await ensureSaved())) return;
  try {
    await api.project.close();
    forgetLastProject();
  } catch (e) {
    showError(e, t('Could not close the project'));
  }
}

/** Handles the window's close button. */
export async function handleWindowClose(): Promise<void> {
  await api.app.closeAck();
  if (await ensureSaved()) await api.app.quit();
}
