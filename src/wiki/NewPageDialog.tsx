/**
 * Ctrl+N: the fastest way to start a page. Enter creates it and opens it for writing. Text
 * selected in a document, such as a name in a scene, comes in as the title.
 */

import { useRef, useState } from 'react';

import { STATUSES, createFromTemplate, openForWriting } from './actions';
import { usePageTypes } from './pageTypes';
import { DEFAULT_TYPE, templateFor, templateLabel } from './templates';
import { showDialog } from '../shell/dialogs';
import { toast } from '../shell/toasts';
import { useLocale } from '../state/language';
import { useNav } from '../state/nav';
import { useTitles } from '../state/project';
import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { titleKey } from '../lib/text';
import type { Page, PageStatus } from '../lib/types';

type Outcome = { open: Page } | { existing: string } | null;

// Worlds get built in runs of the same kind of page.
let lastType = DEFAULT_TYPE;
let lastStatus: PageStatus = 'draft';

function NewPageForm(props: { initialTitle: string; close: (outcome: Outcome) => void }) {
  useLocale();
  const [title, setTitle] = useState(props.initialTitle);
  const types = usePageTypes((s) => s.types);
  const [type, setType] = useState(() => templateFor(lastType).type);
  const [status, setStatus] = useState<PageStatus>(lastStatus);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<string[]>([]);
  const titleRef = useRef<HTMLInputElement>(null);

  const key = titleKey(title);
  const existing = useTitles((s) => (key ? s.byKey.get(key) : undefined));
  const isAlias = existing && titleKey(existing.title) !== key;

  const changeType = (next: string) => {
    lastType = next;
    setType(next);
  };

  const create = async (another: boolean) => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      const page = await createFromTemplate(title.trim(), type, status);
      if (another) {
        setAdded((list) => [...list, page.title]);
        setTitle('');
        titleRef.current?.focus();
      } else {
        props.close({ open: page });
      }
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const submit = (another: boolean) => {
    // Enter on a name that is taken goes there, which is usually what was wanted.
    if (existing) {
      if (!another) props.close({ existing: existing.id });
      return;
    }
    void create(another);
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit(false);
      }}
      onKeyDown={(e) => {
        // A focused select would otherwise open its list or do nothing.
        const inSelect = (e.target as HTMLElement).tagName === 'SELECT';
        if (e.key === 'Enter' && (inSelect || e.shiftKey)) {
          e.preventDefault();
          submit(e.shiftKey);
        }
      }}
    >
      <h2 id="dialog-title" className="dialog-title">{t('New page')}</h2>
      <label className="field">
        <span className="field-label">{t('Title')}</span>
        <input
          ref={titleRef}
          className="input"
          autoFocus
          // A title taken from the selected text is selected too, so typing replaces it.
          onFocus={(e) => {
            if (e.target.value === props.initialTitle) e.target.select();
          }}
          value={title}
          aria-describedby="new-page-hint"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || e.altKey || e.ctrlKey) return;
            e.preventDefault();
            const index = types.findIndex((t) => t.type === type);
            const step = e.key === 'ArrowDown' ? 1 : -1;
            changeType(types[(index + step + types.length) % types.length].type);
          }}
        />
      </label>
      <div className="wiki-form-row">
        <label className="field">
          <span className="field-label">{t('Type')}</span>
          <select className="select" aria-label={t('Type')} value={type} onChange={(e) => changeType(e.target.value)}>
            {types.map((template) => (
              <option key={template.type} value={template.type}>{templateLabel(template)}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">{t('Status')}</span>
          <select
            className="select"
            aria-label={t('Status')}
            value={status}
            onChange={(e) => {
              lastStatus = e.target.value as PageStatus;
              setStatus(lastStatus);
            }}
          >
            {STATUSES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </label>
      </div>
      {templateFor(type).description && <p className="field-hint">{templateFor(type).description}</p>}
      {existing && (
        <p className="wiki-form-note" role="status">
          {isAlias
            ? t('“{name}” is another name for {title}. Enter opens that page.', { name: title.trim(), title: existing.title })
            : t('A page called “{title}” already exists. Enter opens it.', { title: existing.title })}
        </p>
      )}
      <p id="new-page-hint" className="field-hint">
        {t('Enter creates the page and opens it for writing. Shift+Enter creates it and stays here for the next one. Up and Down change the type.')}
      </p>
      {added.length > 0 && (
        <p className="wiki-form-note" role="status">
          {added.length === 1
            ? t('Created 1 page, last “{title}”. Press Escape when you are done.', { title: added[added.length - 1] })
            : t('Created {count} pages, last “{title}”. Press Escape when you are done.', {
                count: added.length.toLocaleString(),
                title: added[added.length - 1],
              })}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={() => props.close(null)}>
          {added.length > 0 ? t('Done') : t('Cancel')}
        </button>
        {existing && isAlias && (
          <button type="button" className="btn" disabled={busy} onClick={() => void create(false)}>
            {t('Create anyway')}
          </button>
        )}
        <button type="submit" className="btn btn-primary" disabled={!title.trim() || busy}>
          {existing ? t('Open') : t('Create')}
        </button>
      </div>
    </form>
  );
}

let isOpen = false;

export async function openNewPageDialog(initialTitle = '') {
  if (isOpen) return;
  isOpen = true;
  const previous = document.activeElement as HTMLElement | null;
  try {
    const outcome = await showDialog<Outcome>(
      (close) => <NewPageForm initialTitle={initialTitle} close={close} />,
      null,
    );
    if (outcome && 'open' in outcome) openForWriting(outcome.open);
    else if (outcome) useNav.getState().go({ view: 'page', id: outcome.existing });
    else if (previous?.isConnected) previous.focus();
  } finally {
    isOpen = false;
  }
}
