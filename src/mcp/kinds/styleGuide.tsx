/**
 * The project's style guide, from set_style_guide. It is applied through the style store's
 * own `saveGuide`, so the plain copy the MCP server reads and the Style guide screen stay in
 * step. The payload keeps each field's old value, which Undo puts back.
 */

import { t } from '../../lib/i18n';
import { errorMessage } from '../../lib/rpc';
import { useLocale } from '../../state/language';
import { compareTexts } from '../../wiki/diff';
import { GUIDE_FIELDS } from '../../writingStyles/guide';
import { loadGuideAfterSaves, saveGuide } from '../../writingStyles/store';
import type { GuideField, StyleGuide } from '../../writingStyles/types';
import type { AnyProposal } from '../api';
import { changedSince, DiffView } from './shared';
import { defineKind, type ApplyResult, type UndoResult } from './types';

export interface StyleGuidePayload {
  mode: 'replace' | 'append';
  changes: StyleGuide;
  before: StyleGuide;
}

function StyleGuideCard({ proposal }: { proposal: AnyProposal<StyleGuidePayload> }) {
  useLocale();
  const { changes, before } = proposal.payload;
  const fields = GUIDE_FIELDS.filter(({ key }) => changes[key] !== undefined);
  return (
    <>
      <p className="mcp-proposal-title">{t('Change to the style guide')}</p>
      <dl className="mcp-infobox mcp-details">
        {fields.map(({ key, label }) => (
          <div key={key}>
            <dt>{t(label)}</dt>
            <dd>
              <DiffView lines={compareTexts(before[key] ?? '', changes[key] ?? '')} />
            </dd>
          </div>
        ))}
      </dl>
    </>
  );
}

const fieldKeys = (guide: StyleGuide) => Object.keys(guide).filter((key) => GUIDE_FIELDS.some((f) => f.key === key)) as GuideField[];

async function apply(proposal: AnyProposal<StyleGuidePayload>): Promise<ApplyResult> {
  try {
    const stored = await loadGuideAfterSaves();
    const next: StyleGuide = { ...stored.project };
    for (const key of fieldKeys(proposal.payload.changes)) next[key] = proposal.payload.changes[key];
    await saveGuide(next);
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
  return { ok: true };
}

async function undo(proposal: AnyProposal<StyleGuidePayload>): Promise<UndoResult> {
  try {
    const stored = await loadGuideAfterSaves();
    const now: StyleGuide = { ...stored.project };
    const { changes, before } = proposal.payload;
    for (const key of fieldKeys(changes)) {
      if ((now[key] ?? '') !== (changes[key] ?? '')) return { ok: false, reason: changedSince() };
    }
    for (const key of fieldKeys(changes)) now[key] = before[key] ?? '';
    await saveGuide(now);
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
  return { ok: true };
}

export const styleGuideKind = defineKind<StyleGuidePayload>({
  kind: 'styleGuide',
  Card: StyleGuideCard,
  apply,
  undo,
  accepted: () => t('Style guide changed.'),
});
