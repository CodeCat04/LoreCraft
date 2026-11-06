/** What the AI proposes adding to the wiki from a chapter. Nothing changes without approval. */

import { useEffect, useState } from 'react';

import { t } from '../lib/i18n';
import { useLocale } from '../state/language';
import type { FieldProposal, Proposal } from './ai/wikiUpdates';
import { openEvidence } from './openAt';
import { applyApproved, cancelWikiUpdates, closeWikiUpdates, useConsistency } from './store';

function describe(proposal: Proposal): string {
  switch (proposal.kind) {
    case 'newPage':
      return t('New {type} page: {title}', { type: proposal.pageType, title: proposal.title });
    case 'field':
      return t('{page}: {field} is {value}', { page: proposal.pageTitle, field: proposal.label, value: proposal.value });
    case 'addition':
      return t('Add to {page}', { page: proposal.pageTitle });
  }
}

function ConflictChoice({ proposal, how, onChange }: { proposal: FieldProposal; how: 'change' | 'replace'; onChange: (how: 'change' | 'replace') => void }) {
  useLocale();
  const name = `cons-how-${proposal.id}`;
  // The value is left in the sentence to be shown in bold, wherever the language puts it.
  const [before, after = ''] = t('The wiki says {field} is {value} at this point in the story.', { field: proposal.label.toLowerCase() }).split('{value}');
  return (
    <fieldset className="cons-conflict">
      <legend>
        {before}<strong>{proposal.existing}</strong>{after}
      </legend>
      <label>
        <input type="radio" name={name} checked={how === 'change'} onChange={() => onChange('change')} />
        {' '}{t('It changes here: keep {existing} until this scene, then {value}', { existing: proposal.existing, value: proposal.value })}
      </label>
      <label>
        <input type="radio" name={name} checked={how === 'replace'} onChange={() => onChange('replace')} />
        {' '}{t('It was always {value}: replace {existing}', { existing: proposal.existing, value: proposal.value })}
      </label>
    </fieldset>
  );
}

export function WikiUpdatesPanel() {
  useLocale();
  const updates = useConsistency((s) => s.updates);
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [how, setHow] = useState<Record<string, 'change' | 'replace'>>({});
  const [applying, setApplying] = useState(false);
  const result = updates?.result ?? null;
  const proposals = result?.proposals ?? [];

  useEffect(() => {
    if (updates?.running) {
      setChosen({});
      setHow({});
    }
  }, [updates?.running]);
  useEffect(() => {
    setChosen({});
    setHow({});
  }, [updates?.chapterId]);

  if (!updates) return null;

  const selected = proposals.filter((proposal) => chosen[proposal.id]);

  const apply = async () => {
    setApplying(true);
    await applyApproved(selected.map((proposal) => ({ proposal, how: how[proposal.id] ?? 'change' })));
    setApplying(false);
  };

  return (
    <section className="cons-panel" aria-label={t('Wiki updates')} data-testid="wiki-updates">
      <h2 className="cons-panel-title">{t('Wiki updates from {chapter}', { chapter: updates.chapterTitle })}</h2>
      {updates.running && (
        <div className="cons-progress-row">
          <span role="status">{t('Reading the chapter… a local model can take a few minutes')}</span>
          <button type="button" className="btn btn-sm" onClick={cancelWikiUpdates}>{t('Stop')}</button>
        </div>
      )}
      {updates.error && <p className="cons-error" role="alert">{updates.error}</p>}
      {result && (
        <>
          <p className="muted" data-testid="updates-counts">
            {result.proposed === 1 ? t('1 proposed.') : t('{count} proposed.', { count: result.proposed })}{' '}
            {result.discarded === 1
              ? t('1 discarded because the quote was not really in the chapter.')
              : t('{count} discarded because the quote was not really in the chapter.', { count: result.discarded })}
            {result.dropped > 0 &&
              ` ${result.dropped === 1 ? t('1 dropped as already known or about a page that does not exist.') : t('{count} dropped as already known or about a page that does not exist.', { count: result.dropped })}`}
            {result.skippedLocalOnly > 0 &&
              ` ${result.skippedLocalOnly === 1 ? t('1 local-only scene left out for this cloud profile.') : t('{count} local-only scenes left out for this cloud profile.', { count: result.skippedLocalOnly })}`}
          </p>
          {proposals.length === 0 && <p>{t('Nothing to add from this chapter.')}</p>}
          {proposals.length > 0 && (
            <>
              <p>{t('Tick what you want. Nothing changes until you apply it.')}</p>
              <ul className="cons-proposals">
                {proposals.map((proposal) => (
                  <li key={proposal.id} className="cons-proposal" data-proposal={proposal.kind}>
                    <label className="cons-proposal-head">
                      <input
                        type="checkbox"
                        checked={!!chosen[proposal.id]}
                        onChange={(e) => setChosen((c) => ({ ...c, [proposal.id]: e.target.checked }))}
                      />
                      <strong>{describe(proposal)}</strong>
                    </label>
                    {proposal.kind === 'newPage' && proposal.summary && <p>{proposal.summary}</p>}
                    {proposal.kind === 'addition' && <p>{proposal.text}</p>}
                    {proposal.kind === 'field' && proposal.existing && (
                      <ConflictChoice proposal={proposal} how={how[proposal.id] ?? 'change'} onChange={(next) => setHow((h) => ({ ...h, [proposal.id]: next }))} />
                    )}
                    <blockquote>{proposal.quote}</blockquote>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => void openEvidence({ sourceKind: 'node', sourceId: proposal.sceneId, title: proposal.sceneTitle, quote: proposal.quote })}
                    >
                      {t('From {scene}', { scene: proposal.sceneTitle })}
                    </button>
                  </li>
                ))}
              </ul>
              <div className="cons-buttons">
                <button type="button" className="btn btn-primary" disabled={selected.length === 0 || applying} onClick={() => void apply()}>
                  {selected.length === 1 ? t('Apply 1 selected') : t('Apply {count} selected', { count: selected.length })}
                </button>
                <button type="button" className="btn" onClick={() => setChosen(Object.fromEntries(proposals.map((p) => [p.id, true])))}>{t('Select all')}</button>
                <button type="button" className="btn" onClick={() => void closeWikiUpdates()}>{t('Close')}</button>
              </div>
            </>
          )}
          {proposals.length === 0 && (
            <div className="cons-buttons">
              <button type="button" className="btn" onClick={() => void closeWikiUpdates()}>{t('Close')}</button>
            </div>
          )}
        </>
      )}
      {updates.error && (
        <div className="cons-buttons">
          <button type="button" className="btn" onClick={() => void closeWikiUpdates()}>{t('Close')}</button>
        </div>
      )}
    </section>
  );
}
