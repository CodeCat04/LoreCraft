/** Title, subtitle, author and word target for a book. */

import { useState } from 'react';

import * as api from './api';
import { deleteBook, useWrite } from './store';
import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import type { Book } from '../lib/types';
import { confirm, showDialog } from '../shell/dialogs';
import { useLocale } from '../state/language';
import { useNav } from '../state/nav';
import { toast } from '../shell/toasts';
import { BookStyleField } from '../writingStyles/BookStyleField';
import { BookVoiceField } from './BookVoiceField';

function BookForm({ book, close }: { book: Book; close: (changed: boolean) => void }) {
  useLocale();
  const [title, setTitle] = useState(book.title);
  const [subtitle, setSubtitle] = useState(book.subtitle);
  const [author, setAuthor] = useState(book.author);
  const [target, setTarget] = useState(String(book.targetWords || ''));
  const clean = title.trim();

  return (
    <form
      // The target's step only sets how far its arrows move. Any number is a fine target.
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!clean) return;
        void api.books
          .update(book.id, {
            title: clean,
            subtitle: subtitle.trim(),
            author: author.trim(),
            targetWords: Math.max(0, Math.round(Number(target) || 0)),
          })
          .then(
            () => close(true),
            (err) => toast(t('Could not save the book settings: {reason}', { reason: errorMessage(err) }), 'error'),
          );
      }}
    >
      <h2 id="dialog-title" className="dialog-title">{t('Book settings')}</h2>
      <label className="field">
        <span className="field-label">{t('Title')}</span>
        <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      {!clean && <div className="field-error">{t('A book needs a title.')}</div>}
      <label className="field">
        <span className="field-label">{t('Subtitle')}</span>
        <input className="input" value={subtitle} onChange={(e) => setSubtitle(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">{t('Author')}</span>
        <input className="input" value={author} onChange={(e) => setAuthor(e.target.value)} />
      </label>
      <label className="field" style={{ maxWidth: '14rem' }}>
        <span className="field-label">{t('Target words')}</span>
        <input
          className="input"
          type="number"
          min={0}
          step={1000}
          value={target}
          placeholder={t('None')}
          onChange={(e) => setTarget(e.target.value)}
        />
      </label>
      <BookStyleField bookId={book.id} />
      <BookVoiceField bookId={book.id} />
      <div className="dialog-actions book-settings-actions">
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => {
            void confirm({
              title: t('Delete “{title}”?', { title: book.title }),
              message: t('You can bring it back from the Trash.'),
              confirmLabel: t('Delete book'),
              danger: true,
            }).then((yes) => {
              if (!yes) return;
              close(false);
              void deleteBook(book);
            });
          }}
        >
          {t('Delete book')}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            close(false);
            useNav.getState().go({ view: 'publishing', bookId: book.id });
          }}
        >
          {t('Publishing details…')}
        </button>
        <span className="binder-spacer" />
        <button type="button" className="btn" onClick={() => close(false)}>
          {t('Cancel')}
        </button>
        <button type="submit" className="btn btn-primary" disabled={!clean}>
          {t('Save')}
        </button>
      </div>
    </form>
  );
}

export async function openBookSettings(): Promise<void> {
  const { books, bookId } = useWrite.getState();
  const book = books.find((b) => b.id === bookId);
  if (!book) return;
  await showDialog<boolean>((close) => <BookForm book={book} close={close} />, false);
}
