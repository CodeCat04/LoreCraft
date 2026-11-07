/**
 * What appears around selected text: a small menu with Ask AI and Send to pane, the text
 * box Ask AI opens in place, and the bar for accepting or rejecting what comes back.
 * Works the same in Read and Edit modes.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { autoUpdate, computePosition, flip, offset, shift, type VirtualElement } from '@floating-ui/dom';
import type { Editor } from '@tiptap/react';

import * as aiApi from '../../ai/api';
import { allProfiles, profileForTask, providerLabel } from '../../ai/client';
import { usePane } from '../../ai/store';
import { nextMaxTokens } from '../../ai/limits';
import { VersionsPanel } from '../../ai/companions/VersionsPanel';
import { versionCount, type VersionsRequest } from '../../ai/companions/versions';
import { SentPreview } from '../../ai/SentPreview';
import type { PromptTemplate } from '../../ai/types';
import { useProject } from '../../state/project';
import { useNav } from '../../state/nav';
import { useSettings } from '../../state/settings';
import { useLocale } from '../../state/language';
import { t } from '../../lib/i18n';
import { toast } from '../../shell/toasts';
import { getCommand } from '../../shell/commands';
import { RewriteInStylePicker, rewriteInstruction, useRewriteDefault } from '../../writingStyles/rewrite';
import { recordRecentStyle } from '../../writingStyles/store';
import { WriteAsSceneItems } from '../../ai/drafting/MenuItems';
import { LinkButton } from '../makePage/LinkButton';
import { commentState, startComment } from '../comments/extension';
import type { EditorSource } from '../RichEditor';
import { canEditRange, startEdit, type EditAction, type EditOutcome, type EditStatus, type RunningEdit } from './flow';
import { hasText, planRewrite, planToMarkdown, planToPlainText } from './hunks';
import { useRunningActions, type RunningAction } from './running';
import { acceptChanges, activeChange, dismissSuggestion, pendingSuggestions, rejectChanges, stepChange, trackRange, trackedRange, untrack, type Suggestion } from './suggestions';

// ---------------------------------------------------------------------------
// Reaching a menu from a command
// ---------------------------------------------------------------------------

/** How "Rewrite in my style" went: started, or why not. */
export type MyStyleResult = 'started' | 'no-selection' | 'no-style';

interface MenuControls {
  ask: () => boolean;
  sendToPane: () => boolean;
  rewriteInMyStyle: () => MyStyleResult;
}

const controls = new Map<Editor, MenuControls>();

/** Opens Ask AI on this editor's selection. False if nothing suitable is selected. */
export function openAskFor(editor: Editor): boolean {
  return controls.get(editor)?.ask() ?? false;
}

/** Rewrites this editor's selection in the default style at once, as suggestions. */
export function rewriteInMyStyleFor(editor: Editor): MyStyleResult {
  return controls.get(editor)?.rewriteInMyStyle() ?? 'no-selection';
}

/** Sends this editor's selection to the pane. False if nothing is selected. */
export function sendSelectionToPane(editor: Editor): boolean {
  return controls.get(editor)?.sendToPane() ?? false;
}

// ---------------------------------------------------------------------------
// Positioning
// ---------------------------------------------------------------------------

function rangeAnchor(editor: Editor, range: () => { from: number; to: number } | null): VirtualElement {
  return {
    getBoundingClientRect() {
      const current = range();
      const view = editor.view;
      if (!current || editor.isDestroyed) return new DOMRect(0, 0, 0, 0);
      try {
        const size = view.state.doc.content.size;
        const start = view.coordsAtPos(Math.min(current.from, size));
        const end = view.coordsAtPos(Math.min(current.to, size));
        const left = Math.min(start.left, end.left);
        // Under the last line of the selection, starting from its left edge.
        return new DOMRect(start.top === end.top ? left : start.left, start.top, Math.max(1, Math.abs(end.right - left)), Math.max(1, end.bottom - start.top));
      } catch {
        return new DOMRect(0, 0, 0, 0);
      }
    },
    contextElement: editor.view.dom,
  };
}

function Floating(props: {
  anchor: VirtualElement;
  label: string;
  className: string;
  children: ReactNode;
  onKeyDown?: (e: ReactKeyboardEvent) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    return autoUpdate(props.anchor, element, () => {
      void computePosition(props.anchor, element, {
        placement: 'bottom-start',
        strategy: 'fixed',
        middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
      }).then(({ x, y }) => {
        element.style.left = `${x}px`;
        element.style.top = `${y}px`;
      });
    });
  }, [props.anchor]);
  return createPortal(
    <div ref={ref} className={`ai-float ${props.className}`} role="dialog" aria-label={props.label} onKeyDown={props.onKeyDown}>
      {props.children}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Ask AI
// ---------------------------------------------------------------------------

const QUICK_ORDER = ['builtin:rewrite', 'builtin:tighten', 'builtin:expand', 'builtin:grammar', 'builtin:vivid', 'builtin:continue'];

function usePrompts(open: boolean): PromptTemplate[] {
  const [prompts, setPrompts] = useState<PromptTemplate[]>([]);
  const isOpen = useProject((s) => s.status.open);
  useEffect(() => {
    if (!open || !isOpen) return;
    void aiApi.prompts.list('selection').then(setPrompts).catch(() => {});
  }, [open, isOpen]);
  return prompts;
}

interface Failure {
  code: string;
  message: string;
  /** Another profile might do it. */
  canSwitch: boolean;
  /** Worth trying again with more room. */
  maxTokens?: number;
}

function statusLine(status: EditStatus | null): string {
  if (!status || status.phase === 'starting') return t('Starting…');
  if (status.phase === 'thinking') return t('Thinking…');
  if (status.phase === 'writing') return t('Writing…');
  return t('The server is busy. Trying again in {seconds} s…', { seconds: Math.ceil(status.delayMs / 1000) });
}

function AskBox(props: {
  editor: Editor;
  source: EditorSource;
  targetId: string;
  anchor: VirtualElement;
  initial: string;
  /** Opens on the list of writing styles, for "Rewrite in a style…". */
  pickStyle?: boolean;
  /** Rewrites in this style as soon as it opens, for "Rewrite in my style". */
  autoStyle?: { styleId: string; name: string | null };
  /** `finished` means a result is showing, so the selection is not handed back. */
  onClose: (finished: boolean) => void;
  /** Asks for several versions to compare, in place of one result. */
  onVersions: (request: VersionsRequest) => void;
}) {
  useLocale();
  const { editor, source, targetId, anchor, onClose, onVersions } = props;
  const [text, setText] = useState(props.initial);
  const [several, setSeveral] = useState(false);
  const [showSent, setShowSent] = useState(false);
  const versions = useSettings((s) => versionCount(s.settings.ai.rewriteVersions));
  const [picking, setPicking] = useState(!!props.pickStyle);
  const [styleId, setStyleId] = useState<string | undefined>(undefined);
  const [running, setRunning] = useState<RunningEdit | null>(null);
  const [status, setStatus] = useState<EditStatus | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [profileId, setProfileId] = useState<string | undefined>(undefined);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const prompts = usePrompts(true);
  const showThinking = useSettings((s) => s.settings.ai.showThinking);
  const profiles = useSettings((s) => s.settings.ai.profiles);
  const profile = profileForTask('rewrite', profileId);
  const go = useNav((s) => s.go);

  useEffect(() => {
    if (props.pickStyle || props.autoStyle) return;
    inputRef.current?.focus();
    inputRef.current?.select();
    // Only on opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = useCallback(
    (outcome: EditOutcome, action: EditAction) => {
      setRunning(null);
      setStatus(null);
      switch (outcome.kind) {
        case 'suggested':
        case 'stale':
          onClose(true);
          break;
        case 'unchanged':
          toast(action === 'insert' ? t('The model had nothing to add.') : t('The model suggested no changes.'));
          onClose(false);
          break;
        case 'cancelled':
          inputRef.current?.focus();
          break;
        case 'refused':
          setFailure({ code: 'REFUSAL', message: outcome.message, canSwitch: true });
          break;
        case 'cutoff':
          setFailure({ code: 'MAX_TOKENS', message: outcome.message, canSwitch: false, maxTokens: nextMaxTokens(outcome.maxTokens, profile) });
          break;
        case 'failed':
          setFailure({ code: outcome.code, message: outcome.message, canSwitch: true });
          break;
      }
    },
    [onClose, profile],
  );

  const submit = useCallback(
    (instruction: string, label: string, action: EditAction, maxTokens?: number, style: string | undefined = styleId) => {
      const range = trackedRange(editor, targetId);
      if (!range || !instruction.trim() || running) return;
      setFailure(null);
      if (several) {
        onVersions({ instruction, label, action, profileId, styleId: style });
        return;
      }
      setStatus({ phase: 'starting' });
      const edit = startEdit({
        editor, source, from: range.from, to: range.to, instruction, label, action, profileId, maxTokens,
        styleId: style,
        targetId,
        onStatus: setStatus,
      });
      setRunning(edit);
      void edit.done.then((outcome) => finish(outcome, action));
    },
    [editor, finish, onVersions, profileId, running, several, source, styleId, targetId],
  );

  const rewriteInStyle = (id: string, name: string | null = null) => {
    const rewrite = rewriteInstruction(id, name);
    setPicking(false);
    if (!rewrite) return;
    setStyleId(id);
    setText(rewrite.instruction);
    void recordRecentStyle(id).catch(() => {});
    submit(rewrite.instruction, rewrite.label, 'replace', undefined, id);
  };

  // "Rewrite in my style" starts at once. A ref, so a second run of this effect starts nothing.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!props.autoStyle || autoStarted.current) return;
    autoStarted.current = true;
    rewriteInStyle(props.autoStyle.styleId, props.autoStyle.name);
    // Only on opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const quick = useMemo(() => {
    const byId = new Map(prompts.map((p) => [p.id, p]));
    return QUICK_ORDER.flatMap((id) => byId.get(id) ?? []);
  }, [prompts]);
  const others = useMemo(() => prompts.filter((p) => !QUICK_ORDER.includes(p.id)), [prompts]);

  const usePrompt = (prompt: PromptTemplate) => {
    setText(prompt.template);
    submit(prompt.template, prompt.name, prompt.action === 'insert' ? 'insert' : 'replace');
  };

  return (
    <Floating
      anchor={anchor}
      label={t('Ask AI about the selected text')}
      className="ai-ask"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        if (running) running.cancel();
        else onClose(false);
      }}
    >
      <textarea
        ref={inputRef}
        className="textarea ai-ask-input"
        rows={2}
        value={text}
        readOnly={!!running}
        aria-label={t('What should change?')}
        placeholder={t('What should change? For example: make this more tense')}
        onChange={(e) => {
          setText(e.target.value);
          setFailure(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit(text, text.trim().slice(0, 40), 'replace');
          }
        }}
      />
      {!running && (
        <div className="ai-quick" role="group" aria-label={t('Quick prompts')}>
          {quick.map((prompt) => (
            <button key={prompt.id} type="button" className="btn btn-sm" title={prompt.description} onClick={() => usePrompt(prompt)}>
              {prompt.name}
            </button>
          ))}
          <button
            type="button"
            className="btn btn-sm"
            aria-expanded={picking}
            // The open list closes on any press outside it, which would undo this toggle.
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => setPicking(!picking)}
          >
            {t('In a style…')}
          </button>
          {others.length > 0 && (
            <select
              className="select ai-more"
              aria-label={t('More prompts')}
              value=""
              onChange={(e) => {
                const prompt = others.find((p) => p.id === e.target.value);
                if (prompt) usePrompt(prompt);
              }}
            >
              <option value="">{t('More…')}</option>
              {others.map((prompt) => (
                <option key={prompt.id} value={prompt.id}>{prompt.name}</option>
              ))}
            </select>
          )}
          <label className="checkbox ai-ask-several" title={t('Write {count} versions to compare side by side, and choose one', { count: versions })}>
            <input type="checkbox" checked={several} onChange={(e) => setSeveral(e.target.checked)} />
            <span>{t('Show {count} versions', { count: versions })}</span>
          </label>
        </div>
      )}
      {!running && picking && (
        <RewriteInStylePicker
          nodeId={source.kind === 'node' ? source.id : null}
          onChoose={rewriteInStyle}
          onClose={() => setPicking(false)}
        />
      )}

      {running && (
        <div className="ai-ask-status" role="status">
          <span className="ai-pulse" aria-hidden="true" />
          <span className="ai-ask-status-text">{statusLine(status)}</span>
          <button type="button" className="btn btn-sm" onClick={() => running.cancel()}>{t('Stop')}</button>
        </div>
      )}
      {running && showThinking && status?.phase === 'thinking' && status.thinking && (
        <div className="ai-ask-thinking">{status.thinking.slice(-400)}</div>
      )}

      {failure && (
        <div className="ai-ask-failure" role="alert">
          <p>{failure.message}</p>
          <div className="ai-ask-failure-actions">
            {failure.maxTokens !== undefined && (
              <button type="button" className="btn btn-sm" onClick={() => submit(text, text.trim().slice(0, 40), 'replace', failure.maxTokens)}>
                {t('Try again with more room')}
              </button>
            )}
            {failure.code !== 'MAX_TOKENS' && (
              <button type="button" className="btn btn-sm" onClick={() => submit(text, text.trim().slice(0, 40), 'replace')}>{t('Try again')}</button>
            )}
            <button type="button" className="btn btn-sm" onClick={() => go({ view: 'settings', tab: 'ai' })}>{t('AI settings')}</button>
          </div>
        </div>
      )}

      {showSent && profile.isCloud && !running && (
        <SentPreview editor={editor} source={source} targetId={targetId} instruction={text} action="replace" styleId={styleId} profile={profile} />
      )}

      <div className="ai-ask-foot">
        {profiles.length > 1 || failure?.canSwitch ? (
          <label className="ai-ask-profile">
            <span className="faint">{t('Using')}</span>
            <select
              className="select"
              value={profile.id}
              disabled={!!running}
              onChange={(e) => {
                setProfileId(e.target.value);
                setFailure(null);
              }}
            >
              {allProfiles().map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
        ) : (
          <span className="faint truncate">{profile.name}</span>
        )}
        <span className="faint ai-ask-where">
          {profile.isCloud ? t('Sent to {provider}', { provider: providerLabel(profile) }) : t('Stays on this computer')}
        </span>
        {profile.isCloud && !running && (
          <button
            type="button"
            className="btn btn-sm"
            aria-expanded={showSent}
            data-testid="ai-ask-what-sent"
            onClick={() => setShowSent((open) => !open)}
          >
            {t('What will be sent')}
          </button>
        )}
        <span className="ai-ask-spacer" />
        {!running && <button type="button" className="btn btn-sm" onClick={() => onClose(false)}>{t('Cancel')}</button>}
        {!running && (
          <button type="button" className="btn btn-sm btn-primary" disabled={!text.trim()} onClick={() => submit(text, text.trim().slice(0, 40), 'replace')}>
            {t('Ask')}
          </button>
        )}
      </div>
    </Floating>
  );
}

// ---------------------------------------------------------------------------
// The bar under a document with suggestions
// ---------------------------------------------------------------------------

function useSuggestionState(editor: Editor): { pending: Suggestion[]; activeId: string | null } {
  const [state, setState] = useState<{ pending: Suggestion[]; activeId: string | null }>({ pending: [], activeId: null });
  useEffect(() => {
    const read = () => {
      if (editor.isDestroyed) return;
      const pending = pendingSuggestions(editor);
      const activeId = activeChange(editor)?.hunk.id ?? null;
      setState((current) => (current.pending === pending && current.activeId === activeId ? current : { pending, activeId }));
    };
    read();
    editor.on('transaction', read);
    return () => {
      editor.off('transaction', read);
    };
  }, [editor]);
  return state;
}

function SuggestionBar(props: { editor: Editor; source: EditorSource; pending: Suggestion[]; onRetry: (suggestion: Suggestion) => void }) {
  useLocale();
  const { editor, source, pending, onRetry } = props;
  const stale = pending.filter((s) => s.stale);
  const live = pending.filter((s) => !s.stale);
  const count = live.reduce((sum, s) => sum + s.hunks.length, 0);
  const acceptAll = async () => {
    for (const suggestion of live) await acceptChanges(editor, source, suggestion.id);
  };
  const rejectAll = () => live.forEach((suggestion) => rejectChanges(editor, suggestion.id));
  return (
    <div className="ai-bar" role="region" aria-label={t('Suggested changes')}>
      {stale.map((suggestion) => (
        <div key={suggestion.id} className="ai-bar-row ai-bar-stale">
          <span className="ai-bar-text">
            {t('This text changed after the AI read it, so its suggestion can no longer be applied.')}
          </span>
          <button type="button" className="btn btn-sm" onClick={() => onRetry(suggestion)}>{t('Ask again')}</button>
          <button type="button" className="btn btn-sm" onClick={() => dismissSuggestion(editor, suggestion.id)}>{t('Discard')}</button>
        </div>
      ))}
      {count > 0 && (
        <div className="ai-bar-row">
          <span className="ai-bar-text">
            <strong>{count === 1 ? t('1 suggested change') : t('{count} suggested changes', { count })}</strong>
            {live.length === 1 && live[0].label ? (
              <span className="faint truncate">{` ${t('from “{label}”', { label: live[0].label })}`}</span>
            ) : null}
          </span>
          <button type="button" className="btn btn-sm" title={t('Previous change ({shortcut})', { shortcut: 'Alt+P' })} onClick={() => stepChange(editor, -1)}>
            {t('Previous')}
          </button>
          <button type="button" className="btn btn-sm" title={t('Next change ({shortcut})', { shortcut: 'Alt+N' })} onClick={() => stepChange(editor, 1)}>
            {t('Next')}
          </button>
          <button type="button" className="btn btn-sm" title={t('Reject all ({shortcut})', { shortcut: 'Alt+Shift+R' })} onClick={rejectAll}>
            {t('Reject all')}
          </button>
          <button type="button" className="btn btn-sm btn-primary" title={t('Accept all ({shortcut})', { shortcut: 'Alt+Shift+A' })} onClick={() => void acceptAll()}>
            {t('Accept all')}
          </button>
        </div>
      )}
    </div>
  );
}

function RunningBar({ actions }: { actions: RunningAction[] }) {
  useLocale();
  return (
    <div className="ai-bar" role="status" aria-label={t('AI at work')}>
      {actions.map((action) => (
        <div key={action.id} className="ai-bar-row">
          <span className="ai-bar-text">{t('AI: {label}…', { label: action.label })}</span>
          <button type="button" className="btn btn-sm" onClick={action.stop}>{t('Stop')}</button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The menu
// ---------------------------------------------------------------------------

interface Selected {
  from: number;
  to: number;
  canEdit: boolean;
}

function readSelection(editor: Editor): Selected | null {
  if (editor.isDestroyed) return null;
  const { from, to, empty } = editor.state.selection;
  if (empty) return null;
  const hasAnyText = editor.state.doc.textBetween(from, to, ' ', '\u0001').trim().length > 0;
  if (!hasAnyText) return null;
  return { from, to, canEdit: canEditRange(editor, from, to) };
}

export function SelectionMenu({ editor, source }: { editor: Editor; source: EditorSource }) {
  useLocale();
  const [selected, setSelected] = useState<Selected | null>(null);
  const [ask, setAsk] = useState<{ targetId: string; initial: string; pickStyle?: boolean; autoStyle?: { styleId: string; name: string | null } } | null>(null);
  const myStyle = useRewriteDefault(source.kind === 'node' ? source.id : null);
  const myStyleRef = useRef(myStyle);
  myStyleRef.current = myStyle;
  const [versions, setVersions] = useState<VersionsRequest | null>(null);
  const pointerDown = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const { pending } = useSuggestionState(editor);
  const allRunning = useRunningActions((state) => state.actions);
  const running = allRunning.filter((action) => action.editor === editor);
  const askRef = useRef(ask);
  askRef.current = ask;

  const refresh = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (!pointerDown.current) setSelected(readSelection(editor));
    }, 120);
  }, [editor]);

  useEffect(() => {
    const dom = editor.view.dom;
    const down = () => {
      pointerDown.current = true;
      setSelected(null);
    };
    const up = () => {
      if (pointerDown.current) {
        pointerDown.current = false;
        refresh();
      }
    };
    // A range read before the text changed may no longer fit it, so the menu hides at once and
    // reads the selection again, instead of offering its buttons for the old range meanwhile.
    const changed = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (!transaction.docChanged) return;
      setSelected(null);
      refresh();
    };
    editor.on('selectionUpdate', refresh);
    editor.on('transaction', changed);
    dom.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    return () => {
      editor.off('selectionUpdate', refresh);
      editor.off('transaction', changed);
      dom.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
      window.clearTimeout(timer.current);
    };
  }, [editor, refresh]);

  const closeAsk = useCallback(
    (finished: boolean) => {
      const current = askRef.current;
      setAsk(null);
      if (!current || editor.isDestroyed) return;
      const range = trackedRange(editor, current.targetId);
      untrack(editor, current.targetId);
      if (range) {
        try {
          // After cancelling, the person is back where they were. With a result showing,
          // a selection left over the text would hide the changes behind its highlight.
          editor.commands.setTextSelection(finished ? range.to : { from: range.from, to: range.to });
        } catch {
          // The range no longer resolves, so there is nothing to put back.
        }
        if (!finished) refresh();
      }
      editor.view.focus();
    },
    [editor, refresh],
  );

  const openAsk = useCallback(
    (range: { from: number; to: number }, initial = '', pickStyle = false, autoStyle?: { styleId: string; name: string | null }) => {
      if (askRef.current) return;
      const targetId = trackRange(editor, range.from, range.to, true);
      setAsk({ targetId, initial, pickStyle, autoStyle });
      setSelected(null);
    },
    [editor],
  );

  const sendToPane = useCallback(
    (range: { from: number; to: number }) => {
      const doc = editor.state.doc;
      const plan = planRewrite(doc, range.from, range.to);
      // A figure on its own still has a line to describe it, and that is what gets sent.
      const text = plan ? planToPlainText(doc, plan) : doc.textBetween(range.from, range.to, '\n\n');
      const markdown = plan && hasText(doc, plan) ? planToMarkdown(doc, plan) : text;
      const anchorId = trackRange(editor, range.from, range.to, false);
      usePane.getState().attachSelection({
        title: source.title, text, markdown, source, anchorId,
        editable: !!plan && hasText(doc, plan),
      });
      setSelected(null);
    },
    [editor, source],
  );

  useEffect(() => {
    controls.set(editor, {
      ask: () => {
        const now = readSelection(editor);
        if (!now?.canEdit) return false;
        openAsk(now);
        return true;
      },
      sendToPane: () => {
        const now = readSelection(editor);
        if (!now) return false;
        sendToPane(now);
        return true;
      },
      rewriteInMyStyle: () => {
        const now = readSelection(editor);
        if (!now?.canEdit) return 'no-selection';
        const style = myStyleRef.current;
        if (!style) return 'no-style';
        openAsk(now, '', false, { styleId: style.styleId, name: style.name });
        return 'started';
      },
    });
    return () => {
      controls.delete(editor);
    };
  }, [editor, openAsk, sendToPane]);

  const selectionAnchor = useMemo(
    () => (selected ? rangeAnchor(editor, () => selected) : null),
    [editor, selected],
  );
  const askAnchor = useMemo(() => {
    if (!ask) return null;
    return rangeAnchor(editor, () => trackedRange(editor, ask.targetId));
  }, [editor, ask]);

  const retry = useCallback(
    (suggestion: Suggestion) => {
      const range = { from: suggestion.from, to: suggestion.to };
      dismissSuggestion(editor, suggestion.id);
      openAsk(range, suggestion.instruction);
    },
    [editor, openAsk],
  );

  return (
    <>
      {(running.length > 0 || pending.length > 0) && (
        <div className="ai-bars">
          {running.length > 0 && <RunningBar actions={running} />}
          {pending.length > 0 && <SuggestionBar editor={editor} source={source} pending={pending} onRetry={retry} />}
        </div>
      )}
      {selected && selectionAnchor && !ask && (
        <Floating anchor={selectionAnchor} label={t('AI actions for the selected text')} className="ai-menu">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={!selected.canEdit}
            title={
              selected.canEdit
                ? t('Ask for a change to this text ({shortcut})', { shortcut: getCommand('ai.ask')?.shortcut ?? 'Ctrl+Shift+K' })
                : t('Select some text to change. Figures stay as they are.')
            }
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => openAsk(selected)}
          >
            {t('Ask AI')}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!selected.canEdit}
            title={selected.canEdit ? t('Suggest this text rewritten in a writing style') : t('Select some text to change. Figures stay as they are.')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => openAsk(selected, '', true)}
          >
            {t('Rewrite in a style…')}
          </button>
          {myStyle && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={!selected.canEdit}
              aria-keyshortcuts={getCommand('ai.rewriteInMyStyle')?.shortcut}
              title={
                selected.canEdit
                  ? t('Suggest this text rewritten in {name} ({shortcut})', {
                    name: myStyle.name ?? myStyle.styleId,
                    shortcut: getCommand('ai.rewriteInMyStyle')?.shortcut ?? 'Ctrl+Shift+Y',
                  })
                  : t('Select some text to change. Figures stay as they are.')
              }
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => openAsk(selected, '', false, { styleId: myStyle.styleId, name: myStyle.name })}
            >
              {t('Rewrite in my style')}
            </button>
          )}
          {/* Drafting: selected notes into a finished scene. */}
          <WriteAsSceneItems editor={editor} source={source} range={selected} canEdit={selected.canEdit} onStart={() => setSelected(null)} />
          <button
            type="button"
            className="btn btn-sm"
            title={t('Attach this text to a message in the AI pane ({shortcut})', { shortcut: 'Ctrl+Shift+M' })}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => sendToPane(selected)}
          >
            {t('Send to pane')}
          </button>
          <LinkButton editor={editor} source={source} from={selected.from} to={selected.to} onDialog={() => setSelected(null)} />
          {commentState(editor) && (
            <button
              type="button"
              className="btn btn-sm"
              title={t('Leave a comment on this text ({shortcut})', { shortcut: 'Ctrl+Alt+C' })}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                // A read-through opens the scene on a click, and this is not one on the text.
                e.stopPropagation();
                if (startComment(editor)) setSelected(null);
              }}
            >
              {t('Comment')}
            </button>
          )}
        </Floating>
      )}
      {ask && askAnchor && !versions && (
        <AskBox
          editor={editor}
          source={source}
          targetId={ask.targetId}
          anchor={askAnchor}
          initial={ask.initial}
          pickStyle={ask.pickStyle}
          autoStyle={ask.autoStyle}
          onClose={closeAsk}
          onVersions={setVersions}
        />
      )}
      {ask && askAnchor && versions && (
        <Floating anchor={askAnchor} label={t('Versions of the selected text')} className="ai-versions">
          <VersionsPanel
            editor={editor}
            source={source}
            targetId={ask.targetId}
            request={versions}
            onBack={() => {
              // Back to the box to edit the request, not to start it again.
              setAsk({ ...ask, initial: versions.instruction, autoStyle: undefined });
              setVersions(null);
            }}
            onClose={(finished) => {
              setVersions(null);
              closeAsk(finished);
            }}
          />
        </Floating>
      )}
    </>
  );
}
