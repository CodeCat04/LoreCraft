/**
 * A scene's history, in a dialog: every snapshot with its reason, a comparison with the
 * current text, and restore. It is the wiki's page history, shown for a scene.
 */

import { flushAllEditors } from '../../editor/saving';
import * as api from '../../lib/api';
import { t } from '../../lib/i18n';
import { errorMessage } from '../../lib/rpc';
import { showDialog } from '../../shell/dialogs';
import { toast } from '../../shell/toasts';
import { useDataVersion, useLoad } from '../../state/events';
import { useLocale } from '../../state/language';
import { VersionHistory } from '../../wiki/HistoryTab';
import { displayTitle } from '../tree';

function SceneHistoryDialog(props: { id: string; close: () => void }) {
  useLocale();
  const { id, close } = props;
  const version = useDataVersion(`doc:node:${id}`, 'nodeContent', 'nodes');
  const { data: node, error } = useLoad(() => api.nodes.get(id), [id, version]);
  const title = node ? displayTitle(node) : '';
  return (
    // A sheet, so the dialog is wide enough for the table and scrolls inside.
    <div className="dialog-sheet scene-history">
      <h2 id="dialog-title" className="dialog-title">
        {node ? t('History of “{title}”', { title }) : t('Scene history')}
      </h2>
      {error && <p role="alert" className="field-error">{errorMessage(error)}</p>}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {node && (
          <VersionHistory
            kind="node"
            id={id}
            title={title}
            updatedAt={node.updatedAt}
            wordCount={node.wordCount}
            // The scene's editor reloads by itself, and the writer wants to see the result.
            onRestored={close}
          />
        )}
      </div>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={close}>{t('Close')}</button>
      </div>
    </div>
  );
}

/** Shows a scene's history. Typing is saved first, so the current version is up to date. */
export async function openSceneHistory(id: string): Promise<void> {
  try {
    await flushAllEditors();
    const node = await api.nodes.get(id);
    if (node.kind !== 'scene') {
      toast(t('Only scenes have a history.'));
      return;
    }
  } catch (e) {
    toast(errorMessage(e), 'error');
    return;
  }
  await showDialog<null>((close) => <SceneHistoryDialog id={id} close={() => close(null)} />, null);
}
