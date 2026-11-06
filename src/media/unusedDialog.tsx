/** Lists pictures and videos no document uses, and deletes them only when asked. */

import { useEffect, useState } from 'react';

import { flushAllEditors } from '../editor/saving';
import { assetUrl } from '../lib/assets';
import { t } from '../lib/i18n';
import { errorMessage, rpc } from '../lib/rpc';
import { showDialog } from '../shell/dialogs';
import { toast } from '../shell/toasts';
import { useLocale } from '../state/language';
import { formatBytes } from './format';

interface UnusedAsset {
  id: string;
  name: string;
  mime: string;
  kind: 'image' | 'video';
  storedBytes: number;
  linked: boolean;
  createdAt: string;
}

interface UnusedList {
  items: UnusedAsset[];
  totalBytes: number;
}

function Thumbnail({ asset }: { asset: UnusedAsset }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (asset.kind !== 'image') return undefined;
    let current = true;
    void assetUrl(asset.id).then((url) => {
      if (current) setSrc(url);
    });
    return () => {
      current = false;
    };
  }, [asset]);
  if (!src) return <span className="unused-media-thumb" aria-hidden="true" />;
  return <img className="unused-media-thumb" src={src} alt="" loading="lazy" />;
}

/** The delete button's words: how many files, and how much space when they take any. */
function deleteLabel(count: number, bytes: number): string {
  if (bytes > 0) {
    const size = formatBytes(bytes);
    return count === 1 ? t('Delete 1 file, {size}', { size }) : t('Delete {count} files, {size}', { count, size });
  }
  return count === 1 ? t('Delete 1 file') : t('Delete {count} files', { count });
}

function UnusedBody({ list, close }: { list: UnusedList; close: (ids: string[] | null) => void }) {
  useLocale();
  const [checked, setChecked] = useState<Set<string>>(() => new Set(list.items.map((i) => i.id)));
  const chosen = list.items.filter((item) => checked.has(item.id));
  const bytes = chosen.reduce((sum, item) => sum + item.storedBytes, 0);
  const toggle = (id: string) =>
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      <h2 className="dialog-title">{t('Remove unused media')}</h2>
      <div className="dialog-message">
        {t(
          'No page, scene, infobox, map or saved version uses these. Deleting them cannot be undone, so anything an undo might still bring back will show as missing. The project file gets smaller the next time you save.',
        )}
      </div>
      <ul className="unused-media-list">
        {list.items.map((item) => (
          <li key={item.id}>
            <label className="unused-media-item">
              <input type="checkbox" checked={checked.has(item.id)} onChange={() => toggle(item.id)} />
              <Thumbnail asset={item} />
              <span className="unused-media-name truncate" title={item.name}>{item.name}</span>
              <span className="unused-media-size">
                {item.linked ? t('Linked file, no space in the project') : formatBytes(item.storedBytes)}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={() => close(null)}>{t('Cancel')}</button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={chosen.length === 0}
          onClick={() => close(chosen.map((item) => item.id))}
        >
          {deleteLabel(chosen.length, bytes)}
        </button>
      </div>
    </>
  );
}

/** What the toast says once they are gone. */
function removedMessage(removed: number, freedBytes: number): string {
  if (freedBytes > 0) {
    const size = formatBytes(freedBytes);
    return removed === 1
      ? t('Removed 1 file, freeing {size} at the next save.', { size })
      : t('Removed {count} files, freeing {size} at the next save.', { count: removed, size });
  }
  return removed === 1 ? t('Removed 1 file.') : t('Removed {count} files.', { count: removed });
}

export async function showUnusedMediaDialog() {
  // A figure added moments ago must have reached storage before anything is called unused.
  await flushAllEditors();
  const list = await rpc<UnusedList>('media.unused');
  if (list.items.length === 0) {
    toast(t('All the media in this project is in use.'), 'success');
    return;
  }
  const ids = await showDialog<string[] | null>((close) => <UnusedBody list={list} close={close} />, null);
  if (!ids) return;
  try {
    const result = await rpc<{ removed: number; freedBytes: number }>('media.removeUnused', { ids });
    toast(removedMessage(result.removed, result.freedBytes), 'success');
  } catch (e) {
    toast(t('Could not remove them: {reason}', { reason: errorMessage(e) }), 'error');
  }
}
