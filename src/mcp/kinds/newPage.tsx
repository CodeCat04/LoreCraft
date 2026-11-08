/** A new wiki page, created as a draft. Undo moves it to the trash. */

import { useMemo } from 'react';

import * as api from '../../lib/api';
import { t } from '../../lib/i18n';
import { errorMessage } from '../../lib/rpc';
import { renderMarkdownSafe } from '../../editor/convert';
import { followRenderedLink } from '../../editor/renderedLinks';
import { useLocale } from '../../state/language';
import { keyFromLabel } from '../../wiki/infobox';
import type { Infobox } from '../../lib/types';
import type { AnyProposal, NewPagePayload } from '../api';
import { markdownDoc, undoCreated, withElement, type CreatedUndo } from './shared';
import { defineKind, type ApplyResult } from './types';

function newPageInfobox(fields: { label: string; value: string }[] | undefined): Infobox {
  const taken: string[] = [];
  return {
    fields: (fields ?? []).map(({ label, value }) => {
      const key = keyFromLabel(label, taken);
      taken.push(key);
      return { key, label, kind: 'text', value };
    }),
  };
}

function NewPageCard({ proposal }: { proposal: AnyProposal<NewPagePayload> }) {
  useLocale();
  const { payload } = proposal;
  const html = useMemo(() => renderMarkdownSafe(payload.body), [payload.body]);
  // Each part is a whole sentence, so they join with a full stop.
  const facts = [
    t('Type: {type}', { type: payload.pageType }),
    t('Starts as a draft'),
    payload.aliases?.length ? t('Also known as {names}', { names: payload.aliases.join(', ') }) : '',
    payload.categories?.length ? t('Categories: {names}', { names: payload.categories.join(', ') }) : '',
  ].filter(Boolean);
  return (
    <>
      <p className="mcp-proposal-title">{withElement(t('New page: {title}'), 'title', <strong>{payload.title}</strong>)}</p>
      <p className="muted small">{facts.join('. ')}</p>
      {payload.summary && <p>{payload.summary}</p>}
      {payload.infobox && payload.infobox.length > 0 && (
        <dl className="mcp-infobox">
          {payload.infobox.map((field) => (
            <div key={field.label}>
              <dt>{field.label}</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {/* renderMarkdownSafe escapes all HTML, since this text came from an outside AI. */}
      <div className="mcp-new-page prose" onClick={followRenderedLink} dangerouslySetInnerHTML={{ __html: html }} />
    </>
  );
}

async function apply(proposal: AnyProposal<NewPagePayload>): Promise<ApplyResult> {
  const { payload } = proposal;
  try {
    const page = await api.pages.create({
      title: payload.title,
      pageType: payload.pageType,
      status: 'draft',
      summary: payload.summary ?? '',
      content: markdownDoc(payload.body),
      infobox: newPageInfobox(payload.infobox),
      aliases: payload.aliases ?? [],
      categories: payload.categories ?? [],
    });
    const undo: CreatedUndo = { kind: 'page', id: page.id, updatedAt: (await api.pages.get(page.id)).updatedAt };
    return { ok: true, undo };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

export const newPageKind = defineKind<NewPagePayload>({
  kind: 'newPage',
  Card: NewPageCard,
  apply,
  undo: (_proposal, undo) => undoCreated(undo),
  accepted: () => t('Page created as a draft.'),
});
