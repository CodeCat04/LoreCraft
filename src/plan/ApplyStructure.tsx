/**
 * Apply structure: adds a template's beats to an existing book as placeholder chapters at its
 * end. The writer reviews the list first, and nothing already there is changed or removed.
 */

import { useState } from 'react';

import { nodes } from '../lib/api';
import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { showDialog } from '../shell/dialogs';
import { toast } from '../shell/toasts';
import { useLocale } from '../state/language';
import { syncNow, useWrite } from '../write/store';
import { applyBeats } from './create';
import { beatsToApply } from './plan';
import { structures, type Beat } from './templates';

function ApplyForm({ chapterTitles, bookTitle, close }: { chapterTitles: string[]; bookTitle: string; close: (beats: Beat[] | null) => void }) {
  useLocale();
  const list = structures();
  const [id, setId] = useState(list[0].id);
  const structure = list.find((s) => s.id === id) ?? list[0];
  const [wanted, setWanted] = useState<Record<string, boolean>>({});
  const rows = beatsToApply(structure.beats, chapterTitles);
  const isWanted = (name: string, initial: boolean) => wanted[`${id}:${name}`] ?? initial;
  const chosen = rows.filter((r) => isWanted(r.beat.name, r.wanted)).map((r) => r.beat);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (chosen.length > 0) close(chosen);
      }}
    >
      <h2 id="dialog-title" className="dialog-title">{t('Apply a story structure')}</h2>
      <p className="dialog-message">
        {t('Each beat you tick becomes an empty chapter at the end of “{book}”, with its guidance as the synopsis. Nothing already in the book is changed.', { book: bookTitle })}
      </p>
      <label className="field">
        <span className="field-label">{t('Structure')}</span>
        <select className="select" value={id} onChange={(e) => setId(e.target.value)}>
          {list.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </label>
      <p className="muted small">{structure.description}</p>
      <ul className="plan-apply-list" aria-label={t('Beats to add')}>
        {rows.map((r) => (
          <li key={r.beat.name}>
            <label>
              <input
                type="checkbox"
                checked={isWanted(r.beat.name, r.wanted)}
                onChange={(e) => setWanted((w) => ({ ...w, [`${id}:${r.beat.name}`]: e.target.checked }))}
              />{' '}
              <strong>{r.beat.name}</strong> <span className="muted">({r.beat.at}%)</span> {r.beat.guidance}
              {!r.wanted && <span className="muted small"> {t('(a chapter of this name is already there)')}</span>}
            </label>
          </li>
        ))}
      </ul>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={() => close(null)}>{t('Cancel')}</button>
        <button type="submit" className="btn btn-primary" disabled={chosen.length === 0}>
          {chosen.length === 1 ? t('Add 1 chapter') : t('Add {count} chapters', { count: chosen.length })}
        </button>
      </div>
    </form>
  );
}

/** Shows the review and adds what was ticked to the current book. */
export async function openApplyStructure(): Promise<void> {
  const { bookId, books } = useWrite.getState();
  const book = books.find((b) => b.id === bookId);
  if (!bookId || !book) {
    toast(t('Open a book first.'));
    return;
  }
  // Read afresh, so a chapter made a moment ago counts.
  const tree = await nodes.tree(bookId).catch(() => useWrite.getState().base);
  const chapterTitles = tree.filter((n) => n.kind === 'chapter').map((n) => n.title);
  const beats = await showDialog<Beat[] | null>((close) => <ApplyForm chapterTitles={chapterTitles} bookTitle={book.title} close={close} />, null);
  if (!beats) return;
  try {
    await applyBeats(bookId, beats);
    await syncNow();
    toast(beats.length === 1 ? t('Added 1 chapter.') : t('Added {count} chapters.', { count: beats.length }));
  } catch (e) {
    toast(t('Could not add the chapters: {reason}', { reason: errorMessage(e) }), 'error');
  }
}
