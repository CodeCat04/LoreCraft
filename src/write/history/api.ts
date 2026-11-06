/** Calls that make big changes to pages and scenes reversible. */

import { flushAllEditors } from '../../editor/saving';
import { t } from '../../lib/i18n';
import { errorMessage, rpc } from '../../lib/rpc';
import { toast } from '../../shell/toasts';

/** The code `nodes.restore` fails with when a merged scene's text has changed in the other scene. */
export const MERGED_TEXT_CHANGED = 'MERGED_TEXT_CHANGED';

export const sceneUndo = {
  /**
   * Brings a scene back from the trash. A scene that was merged into another one takes its
   * text back out of that scene, so it is not there twice. `force` restores it even when that
   * text has changed since the merge, and leaves the other scene as it is.
   */
  restore: (id: string, force = false) => rpc<boolean>('nodes.restore', { id, force }),
};

/** One document a project-wide replace or an import wrote, as its result lists it. */
export interface BulkChange {
  kind: 'page' | 'node';
  id: string;
  revisionId: string | null;
  after: string | null;
}

/** Something an import made or put in the trash. */
export interface BulkItem {
  kind: 'page' | 'node' | 'book';
  id: string;
}

/** What a replace or an import returns for undoing it. */
export interface BulkUndo {
  changes?: BulkChange[];
  created?: BulkItem[];
  removed?: BulkItem[];
}

export interface BulkUndone {
  restored: number;
  trashed: number;
  /** Edited since the change, so left as they are. */
  kept: { kind: 'page' | 'node'; id: string; title: string }[];
}

export const undoBulk = (undo: BulkUndo) => rpc<BulkUndone>('revisions.undo', undo);

/** True if undoing would do anything. */
export function canUndo(undo: BulkUndo | undefined | null): undo is BulkUndo {
  return !!undo && ((undo.changes?.length ?? 0) + (undo.created?.length ?? 0) + (undo.removed?.length ?? 0)) > 0;
}

/**
 * Takes back a replace or an import, and says what happened. A document edited since stays as
 * it is, so newer writing is never lost. Returns false if it failed.
 */
export async function undoBulkChange(undo: BulkUndo): Promise<boolean> {
  try {
    await flushAllEditors();
    const done = await undoBulk(undo);
    const kept = done.kept.map((k) => `“${k.title}”`).join(', ');
    if (done.kept.length === 0) {
      toast(t('Undone.'), 'success');
    } else if (done.kept.length === 1) {
      toast(t('Undone, except for {titles}, which was edited since. Its History has the earlier text.', { titles: kept }));
    } else {
      toast(t('Undone, except for {titles}, which were edited since. Their History has the earlier text.', { titles: kept }));
    }
    return true;
  } catch (e) {
    toast(t('Could not undo it: {reason}', { reason: errorMessage(e) }), 'error');
    return false;
  }
}
