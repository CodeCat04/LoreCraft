/** Adding, editing and listing explicit relationships between pages. */

import { useId, useState } from 'react';

import * as extras from '../api';
import { PageAutocomplete } from '../common/PageAutocomplete';
import { flushAllEditors } from '../../editor/saving';
import { t } from '../../lib/i18n';
import { errorMessage } from '../../lib/rpc';
import { confirm, showDialog } from '../../shell/dialogs';
import { toast } from '../../shell/toasts';
import { useDataVersion, useLoad } from '../../state/events';
import { useLocale } from '../../state/language';
import { useNav } from '../../state/nav';
import { useTitles } from '../../state/project';
import type { Infobox } from '../../lib/types';
import { isFamilyKind, kindLabel, kindSides, kindSuggestions, readRelationship } from './relationKinds';

interface PageRef {
  id: string;
  title: string;
}

export interface RelationshipDraft {
  id?: string;
  from?: PageRef;
  to?: PageRef;
  kind?: string;
  note?: string;
}

const FAMILY_FIELDS = new Set(['parents', 'spouse', 'children']);

/** Text in a page box only counts once it names a real page. */
function resolvePage(text: string): PageRef | null {
  const entry = useTitles.getState().resolve(text);
  return entry ? { id: entry.id, title: entry.title } : null;
}

function RelationshipForm({ draft, close }: { draft: RelationshipDraft; close: (changed: boolean) => void }) {
  useLocale();
  const kindListId = useId();
  const [fromText, setFromText] = useState(draft.from?.title ?? '');
  const [toText, setToText] = useState(draft.to?.title ?? '');
  const [kind, setKind] = useState(draft.kind ?? '');
  /** What the writer typed for the other side. Null shows what is already declared. */
  const [inverseText, setInverseText] = useState<string | null>(null);
  const [note, setNote] = useState(draft.note ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const editing = !!draft.id;
  const { data: kinds } = useLoad(() => extras.relationKinds(), []);

  const from = resolvePage(fromText);
  const to = resolvePage(toText);
  const typedKind = kind.trim();
  const ready = !!from && !!to && !!typedKind;
  const sides = kindSides(kinds ?? [], typedKind);
  const inverse = (inverseText ?? sides.other ?? '').trim();
  // Only a kind the app knows nothing about can be given another side here.
  const canDeclare = !!kinds && !!typedKind && !sides.builtin;
  const symmetric = !!inverse && inverse.toLowerCase() === typedKind.toLowerCase();

  const submit = async () => {
    if (!from || !to) {
      setProblem(t('There is no page called "{title}".', { title: from ? toText : fromText }));
      return;
    }
    if (!kind.trim()) {
      setProblem(t('Choose a kind, such as ally or parent of.'));
      return;
    }
    setBusy(true);
    setProblem(null);
    const input = { fromPageId: from.id, toPageId: to.id, kind, note };
    try {
      // A family relationship writes to the infobox of the page being edited.
      await flushAllEditors();
      if (canDeclare && inverse.toLowerCase() !== (sides.other ?? '').toLowerCase()) {
        await extras.relationKindSet(typedKind, inverse);
      }
      if (draft.id) await extras.relationshipUpdate(draft.id, input);
      else await extras.relationshipAdd(input);
      close(true);
    } catch (e) {
      setBusy(false);
      setProblem(errorMessage(e));
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2 className="dialog-title">{editing ? t('Edit relationship') : t('Add relationship')}</h2>
      <label className="field">
        <span className="field-label">{t('From page')}</span>
        <PageAutocomplete
          label={t('From page')}
          autoFocus={!draft.from}
          value={fromText}
          onChange={setFromText}
          onPick={(entry) => setFromText(entry.title)}
          onEnter={() => void submit()}
        />
      </label>
      <label className="field">
        <span className="field-label">{t('Kind')}</span>
        <input
          className="input"
          list={kindListId}
          autoFocus={!!draft.from && !editing}
          placeholder={t('ally, parent of, located in…')}
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setInverseText(null);
          }}
        />
        <datalist id={kindListId}>
          {kindSuggestions(kinds ?? []).map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
      </label>
      {canDeclare && (
        <label className="field">
          <span className="field-label">{t('From the other page, this reads')}</span>
          <input
            className="input"
            placeholder={t('Optional: student of, vassal of…')}
            value={inverseText ?? sides.other ?? ''}
            onChange={(e) => setInverseText(e.target.value)}
          />
        </label>
      )}
      <label className="field">
        <span className="field-label">{t('To page')}</span>
        <PageAutocomplete
          label={t('To page')}
          value={toText}
          excludeId={from?.id}
          onChange={setToText}
          onPick={(entry) => setToText(entry.title)}
          onEnter={() => void submit()}
        />
      </label>
      <label className="field">
        <span className="field-label">{t('Note')}</span>
        <input className="input" value={note} placeholder={t('Optional')} onChange={(e) => setNote(e.target.value)} />
      </label>
      {ready && from && to && (
        <p className="muted rel-preview" role="status">
          {symmetric
            ? t('{first} and {second}: {kind}', { first: from.title, second: to.title, kind: typedKind })
            : `${from.title} ${typedKind} ${to.title}`}
          {!symmetric && inverse && (
            <>
              <br />
              {to.title} {inverse} {from.title}
            </>
          )}
        </p>
      )}
      {problem && <div className="field-error" role="alert">{problem}</div>}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={() => close(false)}>{t('Cancel')}</button>
        <button type="submit" className="btn btn-primary" disabled={!ready || busy}>
          {editing ? t('Save') : t('Add')}
        </button>
      </div>
    </form>
  );
}

/** Opens the form. Resolves true if something was saved. */
export function openRelationshipDialog(draft: RelationshipDraft = {}): Promise<boolean> {
  return showDialog<boolean>((close) => <RelationshipForm draft={draft} close={close} />, false);
}

export function editRelationship(rel: extras.Relationship): Promise<boolean> {
  return openRelationshipDialog({
    id: rel.id,
    from: { id: rel.fromPageId, title: rel.fromTitle },
    to: { id: rel.toPageId, title: rel.toTitle },
    kind: rel.kind,
    note: rel.note,
  });
}

export async function deleteRelationship(rel: extras.Relationship): Promise<void> {
  const relationship = `${rel.fromTitle} ${kindLabel(rel.kind)} ${rel.toTitle}`;
  const yes = await confirm({
    title: t('Delete this relationship?'),
    message: isFamilyKind(rel.kind)
      ? t('{relationship}. It also comes off their infoboxes. The pages themselves stay.', { relationship })
      : t('{relationship}. The pages stay as they are.', { relationship }),
    confirmLabel: t('Delete'),
    danger: true,
  });
  if (!yes) return;
  try {
    await flushAllEditors();
    await extras.relationshipDelete(rel.id);
    // Undo adds it back as it was, which also puts it back on any infobox it came off.
    const dismiss = toast(t('Deleted {relationship}.', { relationship }), 'info', {
      label: t('Undo'),
      run: () => {
        dismiss();
        void flushAllEditors()
          .then(() => extras.relationshipAdd({ fromPageId: rel.fromPageId, toPageId: rel.toPageId, kind: rel.kind, note: rel.note }))
          .catch((e: unknown) => toast(t('Could not add the relationship back: {error}', { error: errorMessage(e) }), 'error'));
      },
    });
  } catch (e) {
    toast(t('Could not delete the relationship: {error}', { error: errorMessage(e) }), 'error');
  }
}

/**
 * A page's relationships, for showing on the page itself. Reads each one from this
 * page's side, so a parent's child shows "Child of".
 */
export function PageRelationships({
  pageId,
  title,
  pageType,
  infobox,
}: {
  pageId: string;
  title?: string;
  pageType?: string;
  infobox?: Infobox;
}) {
  useLocale();
  const version = useDataVersion('extras', 'pages');
  const go = useNav((s) => s.go);
  const { data, error } = useLoad(() => extras.relationshipList(pageId), [pageId, version]);
  const list = data ?? [];
  // A writer's own page type can have family fields too.
  const hasFamily = pageType === 'character' || !!infobox?.fields.some((field) => FAMILY_FIELDS.has(field.key));
  return (
    <section className="page-relationships" aria-label={t('Recorded relationships')}>
      <div className="page-extra-head">
        {/* A character's article has its own Relationships heading, written by the writer. */}
        <h2 className="page-extra-title">{t('Recorded relationships')}</h2>
        <span className="page-extra-actions">
          {hasFamily && (
            <button type="button" className="btn btn-sm" onClick={() => go({ view: 'familyTree', pageId })}>
              {t('Family tree')}
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm"
            aria-label={t('Add relationship')}
            onClick={() =>
              void openRelationshipDialog({
                from: { id: pageId, title: title ?? useTitles.getState().byId.get(pageId)?.title ?? '' },
              })
            }
          >
            {t('Add')}
          </button>
        </span>
      </div>
      {error && <p className="field-error">{t('Could not load relationships: {error}', { error: errorMessage(error) })}</p>}
      {!error && data && list.length === 0 && (
        <p className="muted">{t('None yet. Add one to say how this page connects to another.')}</p>
      )}
      {list.length > 0 && (
        <ul className="page-relationship-list">
          {list.map((rel) => {
            const reading = readRelationship(rel, pageId);
            return (
              <li key={rel.id} className="page-relationship">
                <span className="page-relationship-text">
                  {reading.before}
                  <button
                    type="button"
                    className="link-button"
                    data-wiki-target={reading.otherTitle}
                    onClick={() => go({ view: 'page', id: reading.otherId })}
                  >
                    {reading.otherTitle}
                  </button>
                  {reading.after}
                  {rel.note && <span className="muted"> ({rel.note})</span>}
                </span>
                <button
                  type="button"
                  className="btn btn-sm"
                  aria-label={t('Edit relationship with {title}', { title: reading.otherTitle })}
                  onClick={() => void editRelationship(rel)}
                >
                  {t('Edit')}
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  aria-label={t('Delete relationship with {title}', { title: reading.otherTitle })}
                  onClick={() => void deleteRelationship(rel)}
                >
                  {t('Delete')}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
