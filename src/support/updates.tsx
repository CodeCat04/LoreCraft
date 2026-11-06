/** "Check for updates": shows what GitHub says. Nothing is ever installed from here. */

import { useMemo, type MouseEvent } from 'react';

import { renderMarkdownSafe } from '../editor/convert';
import * as lib from '../lib/api';
import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { registerCommand } from '../shell/commands';
import { choose, showDialog } from '../shell/dialogs';
import { toast } from '../shell/toasts';
import { useLocale } from '../state/language';
import { support, type UpdateCheck, type UpdateStatus } from './api';

export const UPDATE_COMMAND_ID = 'help.checkForUpdates';

/** What a check that did not find an update has to say to someone who asked for it. */
export function statusMessage(check: Pick<UpdateCheck, 'status' | 'current'>): { title: string; message: string } {
  const answers: Record<Exclude<UpdateStatus, 'available'>, () => { title: string; message: string }> = {
    current: () => ({
      title: t('LoreCraft is up to date'),
      message: t('You have the latest version, {version}.', { version: check.current }),
    }),
    noReleases: () => ({
      title: t('No releases found'),
      message: t('No releases have been published on GitHub yet, or the project is private there.'),
    }),
    offline: () => ({
      title: t('Could not check for updates'),
      message: t('GitHub could not be reached. Check your internet connection and try again.'),
    }),
    rateLimited: () => ({
      title: t('Could not check for updates'),
      message: t('GitHub is limiting requests from this network. Try again in an hour or so.'),
    }),
    failed: () => ({
      title: t('Could not check for updates'),
      message: t('GitHub sent an answer LoreCraft could not read. Try again later.'),
    }),
  };
  return check.status === 'available'
    ? { title: t('An update is available'), message: '' }
    : answers[check.status]();
}

function openLink(url: string) {
  lib.app.openExternal(url).catch((e) => toast(errorMessage(e), 'error'));
}

/** Links in the notes open in a browser, and never navigate the app window. */
function handleLinks(e: MouseEvent) {
  const link = (e.target as HTMLElement).closest('a');
  if (!link) return;
  e.preventDefault();
  const href = link.getAttribute('href');
  if (href && /^https?:\/\//i.test(href)) openLink(href);
}

function ReleaseNotes({ notes }: { notes: string }) {
  useLocale();
  const html = useMemo(() => renderMarkdownSafe(notes), [notes]);
  // Focusable so the keys can scroll it. Pressing Enter on a link inside arrives as a click.
  return (
    <div
      className="support-notes"
      role="region"
      tabIndex={0}
      aria-label={t('Release notes')}
      onClick={handleLinks}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function AvailableBody({ check, close }: { check: UpdateCheck; close: () => void }) {
  useLocale();
  return (
    <>
      <h2 id="dialog-title" className="dialog-title">
        {t('LoreCraft {version} is available', { version: check.latest ?? '' })}
      </h2>
      <p className="dialog-message">
        {t(
          'You have version {version}. LoreCraft does not install updates itself. Download the new version from the release page.',
          { version: check.current },
        )}
      </p>
      {check.notes?.trim() ? <ReleaseNotes notes={check.notes} /> : <p className="muted">{t('This release has no notes.')}</p>}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={() => close()}>{t('Close')}</button>
        <button
          type="button"
          className="btn btn-primary"
          autoFocus
          onClick={() => {
            openLink(check.url);
            close();
          }}
        >
          {t('Open the release page')}
        </button>
      </div>
    </>
  );
}

function showAvailable(check: UpdateCheck): Promise<void> {
  return showDialog<void>((close) => <AvailableBody check={check} close={() => close()} />, undefined);
}

/** Someone asked, so every outcome gets a clear answer. */
export async function checkForUpdatesByHand(): Promise<void> {
  const stopWaiting = toast(t('Checking for updates…'));
  let check: UpdateCheck;
  try {
    check = await support.checkForUpdates();
  } catch (e) {
    toast(t('Could not check for updates: {reason}', { reason: errorMessage(e) }), 'error');
    return;
  } finally {
    stopWaiting();
  }
  if (check.status === 'available') {
    await showAvailable(check);
    return;
  }
  const { title, message } = statusMessage(check);
  await choose<void>({
    title,
    message,
    dismissValue: undefined,
    choices: [{ label: t('OK'), value: undefined, tone: 'primary' }],
  });
}

/** The update the quiet check found, which the Help menu then offers. */
let foundUpdate: UpdateCheck | null = null;

/** The Help menu's update command: a check, or the update a quiet check found. */
export function registerUpdateCommand() {
  const check = foundUpdate;
  registerCommand(
    check
      ? {
          id: UPDATE_COMMAND_ID,
          title: t('Update available: {version}…', { version: check.latest ?? '' }),
          menu: 'Help',
          order: 20,
          keywords: 'new version release',
          run: () => showAvailable(check),
        }
      : {
          id: UPDATE_COMMAND_ID,
          title: t('Check for updates…'),
          menu: 'Help',
          order: 20,
          keywords: 'new version release',
          run: checkForUpdatesByHand,
        },
  );
}

/**
 * The check a person turned on in Settings. It stays quiet unless there is an update, and
 * then it only says so, because this runs while they are getting back to their writing.
 */
export async function checkForUpdatesQuietly(): Promise<void> {
  const check = await support.checkForUpdates().catch(() => null);
  if (check?.status !== 'available') return;
  toast(t('LoreCraft {version} is available.', { version: check.latest ?? '' }), 'info', {
    label: t("See what's new"),
    run: () => void showAvailable(check),
  });
  foundUpdate = check;
  registerUpdateCommand();
}
