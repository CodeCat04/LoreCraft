/** What the Help menu and the settings tab both offer. */

import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { showDialog } from '../shell/dialogs';
import { toast } from '../shell/toasts';
import { useLocale } from '../state/language';
import { support } from './api';

function DiagnosticsBody({ text, close }: { text: string; close: () => void }) {
  useLocale();
  return (
    <>
      <h2 id="dialog-title" className="dialog-title">{t('Diagnostics')}</h2>
      <p className="dialog-message">{t('LoreCraft could not reach the clipboard. Select this text and copy it.')}</p>
      <label className="field">
        <span className="field-label">{t('Version and platform')}</span>
        <textarea className="input support-diagnostics" readOnly rows={6} value={text} autoFocus onFocus={(e) => e.target.select()} />
      </label>
      <div className="dialog-actions">
        <button type="button" className="btn btn-primary" onClick={() => close()}>{t('Close')}</button>
      </div>
    </>
  );
}

function showDiagnostics(text: string): Promise<void> {
  return showDialog<void>((close) => <DiagnosticsBody text={text} close={() => close()} />, undefined);
}

export async function copyDiagnostics(): Promise<void> {
  try {
    const { text } = await support.diagnostics();
    try {
      await navigator.clipboard.writeText(text);
      toast(t('Diagnostics copied. They hold the version and platform, and nothing from your projects.'), 'success');
    } catch {
      // Some web views only allow this straight after a click, and this waited for an answer.
      await showDiagnostics(text);
    }
  } catch (e) {
    toast(t('Could not gather diagnostics: {reason}', { reason: errorMessage(e) }), 'error');
  }
}

export async function openLogFolder(): Promise<void> {
  try {
    await support.openLogFolder();
  } catch (e) {
    toast(t('Could not open the log folder: {reason}', { reason: errorMessage(e) }), 'error');
  }
}
