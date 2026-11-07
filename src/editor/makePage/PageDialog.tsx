/**
 * A small dialog for making a page without leaving what is on screen. Used for selected text
 * and for ideas in the inbox. The page is made while the dialog is still up, so a failure
 * leaves it open with what was typed.
 */

import { useState } from 'react';

import { t } from '../../lib/i18n';
import { errorMessage } from '../../lib/rpc';
import { titleKey } from '../../lib/text';
import type { Page, TitleEntry } from '../../lib/types';
import { showDialog } from '../../shell/dialogs';
import { toast } from '../../shell/toasts';
import { useLocale } from '../../state/language';
import { useTitles } from '../../state/project';
import { usePageTypes } from '../../wiki/pageTypes';
import { DEFAULT_TYPE, templateFor } from '../../wiki/templates';

export interface NewPageChoice {
  title: string;
  type: string;
  alsoLink: boolean;
  draftWithAi: boolean;
}

export interface NewPageOptions {
  heading: string;
  initialTitle: string;
  /** The page type to start with. The last one used, if left out. */
  initialType?: string;
  confirmLabel: string;
  /** How many other mentions could be linked. With more than zero, offers to. */
  mentions?: number;
  /** Offers to have the AI write a first draft. */
  offerDraft?: boolean;
  /** Called when the title belongs to a page already. Without it, the title must be new. */
  useExisting?: (page: TitleEntry, choice: NewPageChoice) => Promise<void>;
  create: (choice: NewPageChoice) => Promise<Page>;
}

// Worlds get built in runs of the same kind of page.
let lastType = DEFAULT_TYPE;

function PageForm(props: NewPageOptions & { close: (page: Page | null) => void }) {
  const { heading, initialTitle, initialType, confirmLabel, mentions = 0, offerDraft = false, useExisting, create, close } = props;
  useLocale();
  const [title, setTitle] = useState(initialTitle);
  const types = usePageTypes((s) => s.types);
  // The last type may have been deleted since it was used.
  const [type, setType] = useState(() => templateFor(initialType ?? lastType).type);
  const [alsoLink, setAlsoLink] = useState(false);
  const [draftWithAi, setDraftWithAi] = useState(false);
  const [busy, setBusy] = useState(false);

  const key = titleKey(title);
  const taken = useTitles((s) => (key ? s.byKey.get(key) : undefined));
  // While saving, the page being made shows up in the list of titles.
  const existing = busy ? undefined : taken;
  const blocked = !title.trim() || busy || (!!existing && !useExisting);

  const changeType = (next: string) => {
    lastType = next;
    setType(next);
  };

  const submit = async () => {
    if (blocked) return;
    setBusy(true);
    const choice: NewPageChoice = { title: title.trim(), type, alsoLink, draftWithAi: draftWithAi && !existing };
    try {
      if (existing && useExisting) {
        await useExisting(existing, choice);
        close(null);
      } else {
        close(await create(choice));
      }
    } catch (e) {
      toast(errorMessage(e), 'error');
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onKeyDown={(e) => {
        // A focused select would otherwise do nothing, and Enter should do the obvious.
        if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'SELECT') {
          e.preventDefault();
          void submit();
        }
      }}
    >
      <h2 id="dialog-title" className="dialog-title">{heading}</h2>
      <label className="field">
        <span className="field-label">{t('Title')}</span>
        <input
          className="input"
          autoFocus
          value={title}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || e.altKey || e.ctrlKey) return;
            e.preventDefault();
            const index = types.findIndex((option) => option.type === type);
            const step = e.key === 'ArrowDown' ? 1 : -1;
            changeType(types[(index + step + types.length) % types.length].type);
          }}
        />
      </label>
      <label className="field">
        <span className="field-label">{t('Type')}</span>
        <select className="select" aria-label={t('Type')} value={type} onChange={(e) => changeType(e.target.value)}>
          {types.map((option) => (
            <option key={option.type} value={option.type}>{option.label}</option>
          ))}
        </select>
      </label>
      {templateFor(type).description && <p className="field-hint">{templateFor(type).description}</p>}
      {existing && (
        <p className="wiki-form-note" role="status">
          {useExisting
            ? t('“{title}” already exists, so this will link to it.', { title: existing.title })
            : t('A page called “{title}” already exists. Choose another title.', { title: existing.title })}
        </p>
      )}
      {mentions > 0 && (
        <label className="checkbox">
          <input type="checkbox" checked={alsoLink} onChange={(e) => setAlsoLink(e.target.checked)} />
          <span>
            {mentions === 1
              ? t('Also link the other mention in this document')
              : t('Also link the other {count} mentions in this document', { count: mentions.toLocaleString() })}
          </span>
        </label>
      )}
      {offerDraft && !existing && (
        <label className="checkbox">
          <input type="checkbox" checked={draftWithAi} onChange={(e) => setDraftWithAi(e.target.checked)} />
          <span>{t('Draft it with AI, which opens the new page and suggests text for you to review')}</span>
        </label>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={() => close(null)}>{t('Cancel')}</button>
        <button type="submit" className="btn btn-primary" disabled={blocked}>
          {existing && useExisting ? t('Link to it') : confirmLabel}
        </button>
      </div>
    </form>
  );
}

/** Returns the page that was made, or null if the dialog ended any other way. */
export function askForNewPage(options: NewPageOptions): Promise<Page | null> {
  return showDialog<Page | null>((close) => <PageForm {...options} close={close} />, null);
}
