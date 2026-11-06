/**
 * What an in-document request will send, shown before it goes to a cloud provider. It is
 * built by the same code as the request itself, so it shows exactly what goes.
 */

import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/react';

import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { formatNumber } from '../lib/text';
import type { AiProfile } from '../lib/settings';
import { useLocale } from '../state/language';
import type { EditorSource } from '../editor/RichEditor';
import { editPrompt, planEdit, type EditAction } from '../editor/ai/flow';
import { trackedRange } from '../editor/ai/suggestions';
import { providerLabel } from './client';
import { estimateTokens } from './context';
import { isSourceLocalOnly, withheldMessage } from './limits/localOnly';
import type { ContentBlock } from './types';

export interface SentPart {
  label: string;
  text: string;
  tokens: number;
}

/** The parts of a request, in order, each with a name for a person. */
export function sentParts(system: string, content: ContentBlock[]): SentPart[] {
  const parts: SentPart[] = [{ label: t('Instructions for the model'), text: system, tokens: estimateTokens(system) }];
  content.forEach((block, index) => {
    if (block.type !== 'text') return;
    const last = index === content.length - 1;
    const label = block.label ?? (last ? t('Your request') : t('Text'));
    parts.push({ label, text: block.text, tokens: estimateTokens(block.text) });
  });
  return parts;
}

function tokenCount(count: number): string {
  return count === 1 ? t('1 token') : t('{count} tokens', { count: formatNumber(count) });
}

export function SentPreview(props: {
  editor: Editor;
  source: EditorSource;
  targetId: string;
  instruction: string;
  action: EditAction;
  styleId?: string;
  profile: AiProfile;
}) {
  useLocale();
  const { editor, source, targetId, instruction, action, styleId, profile } = props;
  const [parts, setParts] = useState<SentPart[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setParts(null);
    setProblem(null);
    // Waits for a pause in typing, since gathering the lore takes a moment.
    const timer = window.setTimeout(() => void (async () => {
      try {
        if (profile.isCloud && (await isSourceLocalOnly(source))) {
          if (live) setProblem(withheldMessage(source.title, profile));
          return;
        }
        const range = trackedRange(editor, targetId);
        const planned = range ? planEdit(editor.state.doc, action, range.from, range.to) : null;
        if (!planned) {
          if (live) setProblem(t('There is no text there to change.'));
          return;
        }
        const { system, content } = await editPrompt({ editor, source, action, instruction, styleId }, profile, planned.targetText);
        if (live) setParts(sentParts(system, content));
      } catch (e) {
        if (live) setProblem(errorMessage(e));
      }
    })(), 300);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [editor, source, targetId, instruction, action, styleId, profile]);

  const total = parts?.reduce((sum, part) => sum + part.tokens, 0) ?? 0;
  return (
    <div className="ai-sent-preview" data-testid="ai-sent-preview">
      <p className="small muted">
        {t('This goes to {provider} when you ask.', { provider: providerLabel(profile) })}
        {parts && ` ${t('About {count} in all.', { count: tokenCount(total) })}`}
      </p>
      {problem && <p className="small" role="alert">{problem}</p>}
      {!parts && !problem && <p className="small faint">{t('Working out what is sent…')}</p>}
      {parts?.map((part, index) => (
        <div key={index} className="ai-context-item">
          <div className="ai-context-line">
            <span className="ai-context-title truncate">{part.label}</span>
            <span className="faint small ai-context-tokens">{tokenCount(part.tokens)}</span>
          </div>
          <details className="ai-context-text">
            <summary>{t('Show the text')}</summary>
            <pre>{part.text}</pre>
          </details>
        </div>
      ))}
    </div>
  );
}
