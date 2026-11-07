/**
 * The boxes for drafting help, shown by the editor they belong to: Guided Continue, and
 * Describe with the senses. Neither touches the document. What they make arrives as a
 * tracked change, for the writer to accept or reject.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';

import { Floating, rangeAnchor } from '../../editor/ai/SelectionMenu';
import type { EditorSource } from '../../editor/RichEditor';
import { addSuggestion, trackedRange } from '../../editor/ai/suggestions';
import { t } from '../../lib/i18n';
import { errorMessage } from '../../lib/rpc';
import { toast } from '../../shell/toasts';
import { useLocale } from '../../state/language';
import { AiError, profileForTask, providerLabel } from '../client';
import { VersionsPanel } from '../companions/VersionsPanel';
import type { VersionsRequest } from '../companions/versions';
import { askSenses } from './askSenses';
import { CONTINUE_ANGLES, continueVersions, guidedInstruction, MAX_CONTINUE_VERSIONS } from './guided';
import {
  emptyOptions,
  freshOptions,
  joinOptions,
  moreRequest,
  parseOneSense,
  parseSenses,
  countOptions,
  sensesInsertion,
  sensesRequest,
  SENSES,
  type Sense,
  type SenseOptions,
} from './senses';
import { closeDrafting, useDrafting, type DraftingBox } from './store';

export function DraftingPanels({ editor, source }: { editor: Editor; source: EditorSource }) {
  const open = useDrafting((s) => (s.open?.editor === editor ? s.open : null));
  // A box does not outlive its editor.
  useEffect(() => () => {
    if (useDrafting.getState().open?.editor === editor) closeDrafting(false);
  }, [editor]);
  if (!open || open.source.id !== source.id) return null;
  if (open.kind === 'continue') return <GuidedContinue key={open.targetId} box={open} />;
  return <SensesPanel key={open.targetId} box={open} />;
}

// ---------------------------------------------------------------------------
// Guided Continue
// ---------------------------------------------------------------------------

/** The last count chosen, so a writer who compares versions need not choose it every time. */
let lastCount = 1;

function GuidedContinue({ box }: { box: Extract<DraftingBox, { kind: 'continue' }> }) {
  useLocale();
  const { editor, source, targetId, runner } = box;
  const [text, setText] = useState('');
  const [count, setCount] = useState(lastCount);
  const [versions, setVersions] = useState<VersionsRequest | null>(null);
  const [preparing, setPreparing] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const profile = profileForTask('rewrite');
  const anchor = useMemo(() => rangeAnchor(editor, () => trackedRange(editor, targetId)), [editor, targetId]);

  useEffect(() => {
    if (!versions) inputRef.current?.focus();
  }, [versions]);

  const run = async () => {
    if (preparing) return;
    lastCount = count;
    if (count === 1) {
      closeDrafting();
      await runner.runOne(text);
      return;
    }
    setPreparing(true);
    try {
      const base = await runner.template();
      setVersions({ instruction: guidedInstruction(base, text), label: t('Continue writing'), action: 'insert', angles: CONTINUE_ANGLES });
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setPreparing(false);
    }
  };

  if (versions) {
    return (
      <Floating anchor={anchor} label={t('Versions of what comes next')} className="ai-versions">
        <VersionsPanel
          editor={editor}
          source={source}
          targetId={targetId}
          request={versions}
          count={count}
          onBack={() => setVersions(null)}
          onClose={() => closeDrafting()}
        />
      </Floating>
    );
  }

  return (
    <Floating
      anchor={anchor}
      label={t('Continue writing')}
      className="ai-ask ai-guided"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        closeDrafting();
      }}
    >
      <textarea
        ref={inputRef}
        className="textarea ai-ask-input"
        rows={2}
        value={text}
        aria-label={t('What should happen next?')}
        placeholder={t('What should happen next? Leave it empty to just continue.')}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void run();
          }
        }}
      />
      <div className="ai-guided-count" role="radiogroup" aria-label={t('How many versions')}>
        <span className="faint">{t('Versions')}</span>
        {Array.from({ length: MAX_CONTINUE_VERSIONS }, (_, i) => i + 1).map((n) => (
          <label key={n} className="checkbox">
            <input type="radio" name={`guided-count-${targetId}`} checked={count === n} onChange={() => setCount(continueVersions(n))} />
            <span>{n === 1 ? t('1 version') : t('{count} versions', { count: n })}</span>
          </label>
        ))}
      </div>
      <div className="ai-ask-foot">
        <span className="faint truncate">{profile.name}</span>
        <span className="faint ai-ask-where">
          {profile.isCloud ? t('Sent to {provider}', { provider: providerLabel(profile) }) : t('Stays on this computer')}
        </span>
        <span className="ai-ask-spacer" />
        <button type="button" className="btn btn-sm" onClick={() => closeDrafting()}>{t('Cancel')}</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={preparing} onClick={() => void run()}>
          {t('Continue')}
        </button>
      </div>
    </Floating>
  );
}

// ---------------------------------------------------------------------------
// Describe with the senses
// ---------------------------------------------------------------------------

function senseLabel(sense: Sense): string {
  switch (sense) {
    case 'sight':
      return t('Sight');
    case 'sound':
      return t('Sound');
    case 'smell':
      return t('Smell');
    case 'touch':
      return t('Touch');
    case 'taste':
      return t('Taste');
    default:
      return t('Metaphor');
  }
}

function problemOf(e: unknown): string | null {
  if (e instanceof AiError && (e.code === 'CANCELLED' || e.code === 'DECLINED')) return null;
  return e instanceof AiError ? e.message : errorMessage(e);
}

function SensesPanel({ box }: { box: Extract<DraftingBox, { kind: 'senses' }> }) {
  useLocale();
  const { editor, source, targetId } = box;
  const [options, setOptions] = useState<SenseOptions>(emptyOptions);
  const [ticked, setTicked] = useState<Set<string>>(() => new Set());
  /** What is being asked for: every group, one group, or nothing. */
  const [asking, setAsking] = useState<'all' | Sense | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const stopper = useRef<AbortController | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const profile = profileForTask('rewrite');
  const anchor = useMemo(() => rangeAnchor(editor, () => trackedRange(editor, targetId)), [editor, targetId]);
  const key = (sense: Sense, option: string) => `${sense}\u0000${option}`;

  const stop = useCallback(() => stopper.current?.abort(), []);

  /** A button that goes away or waits leaves the focus nowhere, so Escape and Tab need it back here. */
  const keepFocus = () => {
    const active = document.activeElement;
    if (!active || active === document.body) rootRef.current?.focus();
  };

  const askAll = useCallback(async () => {
    stopper.current?.abort();
    const controller = new AbortController();
    stopper.current = controller;
    setAsking('all');
    setProblem(null);
    try {
      const reply = await askSenses({ editor, source, targetId, request: sensesRequest(), signal: controller.signal });
      const parsed = parseSenses(reply);
      if (countOptions(parsed) === 0) setProblem(t('The model gave no options. Try again, or try another profile.'));
      else {
        setOptions(parsed);
        setTicked(new Set());
      }
    } catch (e) {
      setProblem(problemOf(e));
    } finally {
      if (stopper.current === controller) {
        stopper.current = null;
        setAsking(null);
        window.setTimeout(keepFocus, 0);
      }
    }
  }, [editor, source, targetId]);

  const askMore = async (sense: Sense) => {
    if (asking) return;
    stopper.current?.abort();
    const controller = new AbortController();
    stopper.current = controller;
    setAsking(sense);
    setProblem(null);
    try {
      const reply = await askSenses({ editor, source, targetId, request: moreRequest(sense, options[sense]), signal: controller.signal });
      const fresh = freshOptions(options[sense], parseOneSense(reply, sense));
      if (fresh.length === 0) {
        setProblem(t('The model had nothing new for {sense}.', { sense: senseLabel(sense) }));
      } else {
        // What is ticked stays. The rest makes way for the new ones.
        setOptions((current) => ({ ...current, [sense]: [...current[sense].filter((o) => ticked.has(key(sense, o))), ...fresh] }));
      }
    } catch (e) {
      setProblem(problemOf(e));
    } finally {
      if (stopper.current === controller) {
        stopper.current = null;
        setAsking(null);
        window.setTimeout(keepFocus, 0);
      }
    }
  };

  useEffect(() => {
    void askAll();
    rootRef.current?.focus();
    return () => stopper.current?.abort();
    // One request each time this opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chosen = SENSES.flatMap((sense) => options[sense].filter((option) => ticked.has(key(sense, option))));

  const insert = () => {
    const range = trackedRange(editor, targetId);
    if (!range || editor.isDestroyed) {
      toast(t('That document is no longer open.'), 'error');
      return;
    }
    const text = joinOptions(chosen);
    try {
      const hunks = sensesInsertion(editor.state.doc, range.to, text);
      if (hunks.length === 0) return;
      addSuggestion(editor, { label: t('Describe with the senses'), from: hunks[0].from, to: hunks[0].to, hunks, reply: text, instruction: '' });
      closeDrafting();
      // A selection left over the text would hide the change behind its highlight.
      editor.commands.setTextSelection(range.to);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const toggle = (sense: Sense, option: string) => {
    setTicked((current) => {
      const next = new Set(current);
      const k = key(sense, option);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  return (
    <Floating anchor={anchor} label={t('Describe with the senses')} className="ai-senses">
      <div
        ref={rootRef}
        className="ai-senses-body"
        data-testid="ai-senses"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          e.stopPropagation();
          if (asking) stop();
          else closeDrafting();
        }}
      >
        <div className="ai-versions-head">
          <strong>{t('Describe with the senses')}</strong>
          <span className="faint">{profile.isCloud ? t('Sent to {provider}', { provider: providerLabel(profile) }) : t('Stays on this computer')}</span>
          <span className="ai-ask-spacer" />
          {asking && (
            <span className="faint small" role="status">
              <span className="ai-pulse" aria-hidden="true" />
              {asking === 'all' ? t('Thinking…') : t('Asking for more {sense}…', { sense: senseLabel(asking) })}
            </span>
          )}
          {asking && <button type="button" className="btn btn-sm" onClick={stop}>{t('Stop')}</button>}
          <button type="button" className="btn btn-sm" onClick={() => closeDrafting()}>{t('Close')}</button>
        </div>
        {problem && (
          <div className="ai-ask-failure" role="alert">
            <p>{problem}</p>
            {countOptions(options) === 0 && !asking && (
              <div className="ai-ask-failure-actions">
                <button type="button" className="btn btn-sm" onClick={() => void askAll()}>{t('Try again')}</button>
              </div>
            )}
          </div>
        )}
        <div className="ai-senses-grid">
          {SENSES.map((sense) => (
            <fieldset key={sense} className="ai-senses-group" data-testid="ai-senses-group" data-sense={sense}>
              <legend className="ai-senses-legend">{senseLabel(sense)}</legend>
              {options[sense].length === 0 && <p className="faint small">{asking === 'all' ? t('Waiting…') : t('No options yet.')}</p>}
              {options[sense].map((option) => (
                <label key={option} className="checkbox ai-senses-option">
                  <input type="checkbox" checked={ticked.has(key(sense, option))} onChange={() => toggle(sense, option)} />
                  <span>{option}</span>
                </label>
              ))}
              <button
                type="button"
                className="btn btn-sm ai-senses-more"
                aria-disabled={!!asking}
                aria-label={t('More for {sense}', { sense: senseLabel(sense) })}
                onClick={() => void askMore(sense)}
              >
                {t('More')}
              </button>
            </fieldset>
          ))}
        </div>
        <div className="ai-ask-foot">
          <span className="faint">
            {chosen.length === 1 ? t('1 ticked') : t('{count} ticked', { count: chosen.length })}
          </span>
          <span className="ai-ask-spacer" />
          <button type="button" className="btn btn-sm btn-primary" disabled={chosen.length === 0} onClick={insert}>
            {t('Insert')}
          </button>
        </div>
      </div>
    </Floating>
  );
}
