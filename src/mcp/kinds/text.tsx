/** Changes to the text of a page or scene: edit, rewrite and insert. Undo puts back the revision saved before. */

import { useMemo } from 'react';

import { t } from '../../lib/i18n';
import { useLocale } from '../../state/language';
import { compareTexts } from '../../wiki/diff';
import { applyTextProposal } from '../apply';
import type { AnyProposal, EditPayload, InsertPayload, RewritePayload, TextProposal } from '../api';
import { currentDocument, flushFirst, LongDiff, targetRoute, undoText, useOpenRoute, withElement, writeText } from './shared';
import { defineKind, type ApplyResult } from './types';

type TextPayload = EditPayload | RewritePayload | InsertPayload;

function insertPlace(payload: InsertPayload): string {
  if (payload.at === 'start') return t('Adds text at the start.');
  if (payload.at === 'end') return t('Adds text at the end.');
  const quote = (payload.quote ?? '').slice(0, 120);
  return payload.at === 'after' ? t('Adds text after “{quote}”.', { quote }) : t('Adds text before “{quote}”.', { quote });
}

function TextCard({ proposal: raw }: { proposal: AnyProposal<TextPayload> }) {
  useLocale();
  const proposal = raw as unknown as TextProposal;
  const openRoute = useOpenRoute();
  const lines = useMemo(() => {
    if (proposal.kind === 'edit') return compareTexts(proposal.payload.quote, proposal.payload.replacement);
    if (proposal.kind === 'insert') return compareTexts('', proposal.payload.text);
    return compareTexts(proposal.payload.original ?? '', proposal.payload.replacement);
  }, [proposal]);
  const sentence = proposal.targetKind === 'page' ? t('Change to the page {title}') : t('Change to the scene {title}');
  return (
    <>
      <p className="mcp-proposal-title">
        {withElement(
          sentence,
          'title',
          <button type="button" className="link-button" onClick={() => openRoute(targetRoute(proposal))}>
            {proposal.title || t('Untitled')}
          </button>,
        )}
      </p>
      {proposal.kind === 'insert' && <p className="muted small">{insertPlace(proposal.payload)}</p>}
      {proposal.kind === 'rewrite' && (
        <p className="muted small">{proposal.payload.mode === 'whole' ? t('Rewrites the whole text.') : t('Rewrites a passage.')}</p>
      )}
      {lines.length > 0 ? <LongDiff lines={lines} /> : <p className="muted">{t('Removes the quoted text.')}</p>}
    </>
  );
}

/** Applies a text suggestion to the stored document, with the old version in History first. */
export async function applyText(raw: AnyProposal<TextPayload>): Promise<ApplyResult> {
  const proposal = raw as unknown as TextProposal;
  const { targetKind, targetId } = proposal;
  const problem = await flushFirst();
  if (problem) return { ok: false, reason: problem };
  const content = await currentDocument(targetKind, targetId);
  if (!content) return { ok: false, reason: t('What this suggestion changes has been deleted.') };
  const result = applyTextProposal(content, proposal);
  if ('stale' in result) return { ok: false, reason: result.stale };
  const undo = await writeText(targetKind, targetId, result.doc);
  return { ok: true, target: { targetKind, targetId }, undo };
}

const textKind = (kind: 'edit' | 'rewrite' | 'insert') =>
  defineKind<TextPayload>({
    kind,
    Card: TextCard,
    apply: applyText,
    undo: (_proposal, undo) => undoText(undo),
    accepted: () => t('Suggestion applied. The old version is in History.'),
    reviewable: true,
  });

export const editKind = textKind('edit');
export const rewriteKind = textKind('rewrite');
export const insertKind = textKind('insert');
