/** What the buttons on a finding do. */

import { useState } from 'react';

import { profileForTask } from '../ai/client';
import { fence } from '../ai/prompts';
import { startEdit, whileRunning } from '../editor/ai';
import * as coreApi from '../lib/api';
import { allFieldValues } from '../lib/facts';
import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import type { InfoboxField, Page } from '../lib/types';
import { showDialog } from '../shell/dialogs';
import { toast } from '../shell/toasts';
import { useLocale } from '../state/language';
import { withFieldValue, type FieldProposal } from './ai/wikiUpdates';
import * as api from './api';
import { openEvidence } from './openAt';
import { cleanQuote } from './quotes';
import { runRules } from './store';
import type { Evidence, Finding } from './types';

export function sceneEvidenceOf(finding: Finding): Evidence | undefined {
  return finding.evidence.find((evidence) => evidence.sourceKind === 'node');
}

export function pageEvidenceOf(finding: Finding): Evidence | undefined {
  return finding.evidence.find((evidence) => evidence.sourceKind === 'page');
}

function instructionFor(finding: Finding, target: Evidence): string {
  const others = finding.evidence
    .filter((evidence) => evidence !== target)
    .map((evidence) => {
      const tag = evidence.sourceKind === 'page' ? 'page' : 'scene';
      return `<${tag} title="${evidence.title.replace(/"/g, "'")}">\n${fence(evidence.quote)}\n</${tag}>`;
    })
    .join('\n');
  return `This passage contradicts other parts of the project and needs correcting. Change as little as you can so that it no longer does, and keep everything else as it is. What is wrong: ${fence(finding.title)}. ${fence(finding.detail)}\n\nThe passage should agree with:\n${others}`;
}

/** A finding can come from a local model, and its quotes must not then go to a cloud one. */
async function citesLocalOnly(finding: Finding): Promise<boolean> {
  const flags = await Promise.all(
    finding.evidence.map(async (evidence) => {
      const source = evidence.sourceKind === 'page' ? await coreApi.pages.get(evidence.sourceId) : await coreApi.nodes.get(evidence.sourceId);
      return !!(source as { localOnly?: boolean }).localOnly;
    }),
  );
  return flags.some(Boolean);
}

/**
 * Opens the scene at the quote and, where a model can be reached, asks for a correction as
 * tracked changes. Those are only a suggestion, for the writer to accept or reject there.
 */
export async function fixInManuscript(finding: Finding): Promise<void> {
  const target = sceneEvidenceOf(finding);
  if (!target) return;
  const { entry, range } = await openEvidence(target);
  if (!entry) {
    toast(t('That scene could not be opened. It may have been deleted.'), 'error');
    return;
  }
  if (!range) {
    toast(t('The scene is open. This finding is about its details, so change them there.'));
    return;
  }
  const { editor, source } = entry;
  const $from = editor.state.doc.resolve(range.from);
  const label = t('Fix inconsistency');
  try {
    if (profileForTask('rewrite').isCloud && (await citesLocalOnly(finding))) {
      toast(t('The scene is open. This finding quotes text marked local only, so no edit was asked of a cloud profile.'));
      return;
    }
    const edit = startEdit({
      editor,
      source,
      from: $from.start(),
      to: $from.end(),
      label,
      action: 'replace',
      instruction: instructionFor(finding, target),
    });
    const outcome = await whileRunning(editor, label, edit.cancel, () => edit.done);
    switch (outcome.kind) {
      case 'suggested':
        toast(t('A suggested edit is in the scene. Accept or reject it there.'), 'success');
        break;
      case 'unchanged':
        toast(t('The model suggested no change, so edit the passage yourself.'));
        break;
      case 'cancelled':
        break;
      case 'stale':
        toast(t('The text changed while the AI was working, so its suggestion cannot be applied.'));
        break;
      default:
        toast(t('The scene is open, but no edit could be suggested. {reason}', { reason: outcome.message }));
    }
  } catch (e) {
    toast(t('The scene is open, but no edit could be suggested. {reason}', { reason: errorMessage(e) }));
  }
}

/** The infobox field a quote is the line of, as in "Eyes: green". */
export function quotedField(page: Pick<Page, 'infobox'>, quote: string): InfoboxField | undefined {
  const wanted = cleanQuote(quote);
  return (page.infobox?.fields ?? []).find((field) =>
    allFieldValues(field).some((value) => cleanQuote(`${field.label}: ${value}`) === wanted),
  );
}

type FieldAnswer = { how: 'change' | 'replace'; value: string } | 'edit' | null;

function FieldUpdateDialog(props: {
  pageTitle: string;
  field: InfoboxField;
  scene: Evidence;
  close: (answer: FieldAnswer) => void;
}) {
  useLocale();
  const { pageTitle, field, scene, close } = props;
  const [value, setValue] = useState('');
  const [how, setHow] = useState<'change' | 'replace'>('change');
  const name = field.label.toLowerCase();
  const held = allFieldValues(field).join(t(', then '));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) close({ how, value: value.trim() });
      }}
    >
      <h2 id="dialog-title" className="dialog-title">{t('Update {field} on {page}', { field: name, page: pageTitle })}</h2>
      <div className="dialog-message">
        <p>{t('The wiki says {value}. {scene} says:', { value: held, scene: scene.title })}</p>
        <blockquote className="cons-dialog-quote">{scene.quote}</blockquote>
      </div>
      <label className="field">
        <span className="field-label">{t('New value')}</span>
        <input className="input" autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      <fieldset className="cons-conflict">
        <legend>{t('Is this a change during the story?')}</legend>
        <label>
          <input type="radio" name="cons-how" checked={how === 'change'} onChange={() => setHow('change')} />
          {' '}{t('It changes at this scene: keep the old value until then')}
        </label>
        <label>
          <input type="radio" name="cons-how" checked={how === 'replace'} onChange={() => setHow('replace')} />
          {' '}{t('The wiki was wrong: replace the value')}
        </label>
      </fieldset>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={() => close('edit')}>{t('Edit the page instead')}</button>
        <button type="button" className="btn" onClick={() => close(null)}>{t('Cancel')}</button>
        <button type="submit" className="btn btn-primary" disabled={!value.trim()}>{t('Update the field')}</button>
      </div>
    </form>
  );
}

/**
 * Opens the page for editing at the quote. If the quote is an infobox field set against a scene,
 * it first offers to record the new value, including as a change at that scene, so that a fact
 * which changes during the story stops reading as a contradiction.
 */
export async function updateWiki(finding: Finding): Promise<void> {
  const target = pageEvidenceOf(finding);
  if (!target) return;
  const scene = sceneEvidenceOf(finding);
  try {
    const page = scene ? await coreApi.pages.get(target.sourceId).catch(() => null) : null;
    const field = page ? quotedField(page, target.quote) : undefined;
    if (page && field && scene) {
      const answer = await showDialog<FieldAnswer>(
        (close) => <FieldUpdateDialog pageTitle={page.title} field={field} scene={scene} close={close} />,
        null,
      );
      if (answer === null) return;
      if (answer !== 'edit') {
        const node = await coreApi.nodes.get(scene.sourceId);
        const proposal: FieldProposal = {
          kind: 'field',
          id: finding.id,
          pageId: page.id,
          pageTitle: page.title,
          key: field.key,
          label: field.label,
          fieldKind: field.kind,
          value: answer.value,
          existing: field.value,
          quote: scene.quote,
          sceneId: scene.sourceId,
          sceneTitle: scene.title,
          sceneDate: node.storyDate?.trim() ?? '',
        };
        await coreApi.revisions.checkpoint('page', page.id, 'manual').catch(() => null);
        await coreApi.pages.update(page.id, { infobox: withFieldValue(page.infobox, proposal, answer.how) });
        await api.findings.setStatus(finding.id, 'fixed');
        toast(t('{field} on {page} updated.', { field: field.label, page: page.title }), 'success');
        void runRules();
        return;
      }
    }
    const { entry } = await openEvidence(target, { edit: true });
    if (!entry) toast(t('That page could not be opened. It may have been deleted.'), 'error');
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}
