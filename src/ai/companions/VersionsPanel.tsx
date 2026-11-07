/** Several versions of a rewrite, side by side, in place of the Ask AI box. */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';

import { renderMarkdownSafe } from '../../editor/convert';
import { followRenderedLink } from '../../editor/renderedLinks';
import type { EditorSource } from '../../editor/RichEditor';
import { planRewrite } from '../../editor/ai/hunks';
import { trackedRange } from '../../editor/ai/suggestions';
import { t } from '../../lib/i18n';
import { toast } from '../../shell/toasts';
import { useLocale } from '../../state/language';
import { profileForTask, providerLabel } from '../client';
import { useSettings } from '../../state/settings';
import { isBusy, versionCount, VersionRun, type VersionsRequest, type VersionState } from './versions';

function statusText(state: VersionState, others: VersionState[]): string {
  switch (state.status) {
    case 'queued':
      return others.some((other) => other.status !== 'queued' && isBusy(other.status)) ? t('Waiting its turn…') : t('Starting…');
    case 'starting':
      return t('Starting…');
    case 'thinking':
      return t('Thinking…');
    case 'writing':
      return t('Writing…');
    case 'stopped':
      return t('Stopped');
    case 'failed':
      return t('Could not be used');
    default:
      return t('Ready');
  }
}

function VersionText({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdownSafe(text), [text]);
  return <div className="ai-md" onClick={followRenderedLink} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function VersionsPanel(props: {
  editor: Editor;
  source: EditorSource;
  targetId: string;
  request: VersionsRequest;
  /** Goes back to the box, with what was asked for still in it. */
  onBack: () => void;
  /** `finished` means a suggestion is showing, so the selection is not handed back. */
  onClose: (finished: boolean) => void;
  /** How many to write, in place of the number in the settings. */
  count?: number;
}) {
  useLocale();
  const { editor, source, targetId, request, onBack, onClose } = props;
  const profile = useMemo(() => profileForTask('rewrite', request.profileId), [request.profileId]);
  // Read once, so a change in settings does not reshape a run under way.
  const [count] = useState(() => props.count ?? versionCount(useSettings.getState().settings.ai.rewriteVersions));
  const [states, setStates] = useState<VersionState[]>([]);
  const runRef = useRef<VersionRun | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const run = new VersionRun(
      { editor, source, action: request.action, instruction: request.instruction, label: request.label, styleId: request.styleId },
      profile,
      targetId,
      setStates,
      count,
      request.angles,
    );
    runRef.current = run;
    setStates(run.states);
    run.start();
    // In the panel, so Escape works and Tab goes through its buttons, but on none of them.
    rootRef.current?.focus();
    // Leaving, by any route, leaves nothing running.
    return () => run.stopAll();
    // One run for each time this opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const anyBusy = states.some((state) => isBusy(state.status));

  const figures = useMemo(() => {
    const range = trackedRange(editor, targetId);
    const plan = range && !editor.isDestroyed ? planRewrite(editor.state.doc, range.from, range.to) : null;
    return plan?.kept.length ?? 0;
  }, [editor, targetId]);

  const choose = (index: number) => {
    const run = runRef.current;
    if (!run) return;
    const outcome = run.choose(index);
    switch (outcome.kind) {
      case 'suggested':
      case 'stale':
        onClose(true);
        break;
      case 'unchanged':
        toast(t('That version is the same as what is there.'));
        break;
      case 'cutoff':
      case 'refused':
      case 'failed':
        toast(outcome.message, 'error');
        break;
      default:
        break;
    }
  };

  return (
    <div
      ref={rootRef}
      className="ai-versions-body"
      data-testid="ai-versions"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        if (anyBusy) runRef.current?.stopAll();
        else onClose(false);
      }}
    >
      <div className="ai-versions-head">
        <strong className="truncate">{t('{count} versions: {label}', { count, label: request.label })}</strong>
        <span className="faint">
          {profile.isCloud ? t('Sent to {provider}, one request each', { provider: providerLabel(profile) }) : t('Stays on this computer, one at a time')}
        </span>
        <span className="ai-ask-spacer" />
        {anyBusy && <button type="button" className="btn btn-sm" onClick={() => runRef.current?.stopAll()}>{t('Stop')}</button>}
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            runRef.current?.stopAll();
            onBack();
          }}
        >
          {t('Back')}
        </button>
        <button type="button" className="btn btn-sm" onClick={() => onClose(false)}>{t('Close')}</button>
      </div>
      {figures > 0 && <p className="faint small">{t('Figures in the selection stay where they are in every version.')}</p>}
      <div className="ai-versions-grid">
        {states.map((state) => (
          <section
            key={state.index}
            className="ai-version"
            data-testid="ai-version"
            data-status={state.status}
            aria-label={t('Version {number}', { number: state.index + 1 })}
          >
            <header className="ai-version-head">
              <h3 className="ai-version-title">{t('Version {number}', { number: state.index + 1 })}</h3>
              <span className="faint small" role="status">
                {isBusy(state.status) && state.status !== 'queued' && <span className="ai-pulse" aria-hidden="true" />}
                {statusText(state, states)}
              </span>
            </header>
            <div className="ai-version-text" data-testid="ai-version-text">
              {state.text && <VersionText text={state.text} />}
              {state.problem && <p className="ai-note" role="alert">{state.problem}</p>}
            </div>
            <footer className="ai-version-foot">
              <button type="button" className="btn btn-sm btn-primary" disabled={state.status !== 'done'} onClick={() => choose(state.index)}>
                {t('Use this one')}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => runRef.current?.regenerate(state.index)}>
                {t('Regenerate')}
              </button>
            </footer>
          </section>
        ))}
      </div>
    </div>
  );
}
