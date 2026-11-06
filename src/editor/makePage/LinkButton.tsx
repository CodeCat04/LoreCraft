/** The selection menu's button: Link to page, which becomes Make a page if no page has the name. */

import { useMemo, useState } from 'react';
import type { Editor } from '@tiptap/core';

import { t } from '../../lib/i18n';
import { useLocale } from '../../state/language';
import { useTitles } from '../../state/project';
import type { EditorSource } from '../RichEditor';
import { planLink, runLinkPlan, type LinkPlan } from './actions';

function describe(plan: LinkPlan): { label: string; title: string } {
  switch (plan.kind) {
    case 'link':
      return { label: t('Link to page'), title: t('Link this text to {title} ({shortcut})', { title: plan.page.title, shortcut: 'Alt+L' }) };
    case 'make':
      return { label: t('Make a page'), title: t('Make a new page with this name and link to it ({shortcut})', { shortcut: 'Alt+L' }) };
    case 'mentions':
      return {
        label: plan.count === 1 ? t('Link 1 other mention') : t('Link {count} other mentions', { count: plan.count.toLocaleString() }),
        title: t('Link the other places this document mentions {name} ({shortcut})', { name: plan.target, shortcut: 'Alt+L' }),
      };
  }
}

export function LinkButton(props: {
  editor: Editor;
  source: EditorSource;
  from: number;
  to: number;
  /** A dialog is about to take over, so the menu should go. */
  onDialog: () => void;
}) {
  const { editor, source, from, to, onDialog } = props;
  useLocale();
  const [done, setDone] = useState(0);
  const entries = useTitles((s) => s.entries);
  const plan = useMemo(
    () => planLink(editor, source, from, to),
    // After a link, the same selection offers what is left to do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, source, from, to, entries, done],
  );
  if (!plan) return null;
  const { label, title } = describe(plan);
  return (
    <button
      type="button"
      className="btn btn-sm"
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        if (plan.kind === 'make') onDialog();
        void runLinkPlan(editor, source, plan).then(() => setDone((n) => n + 1));
      }}
    >
      {label}
    </button>
  );
}
