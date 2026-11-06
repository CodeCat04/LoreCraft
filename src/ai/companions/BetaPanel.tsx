/** The Feedback tab of the AI pane: a beta reader's notes on a scene or chapter. */

import { useMemo } from 'react';
import { create } from 'zustand';

import * as coreApi from '../../lib/api';
import { t } from '../../lib/i18n';
import { errorMessage } from '../../lib/rpc';
import type { Book, NodeMeta, PmNode } from '../../lib/types';
import { renderMarkdownSafe } from '../../editor/convert';
import { followRenderedLink } from '../../editor/renderedLinks';
import { editorFor, waitForEditor, type EditorEntry } from '../../editor/ai/registry';
import { toast } from '../../shell/toasts';
import { useDataVersion, useLoad } from '../../state/events';
import { useLocale } from '../../state/language';
import { useNav } from '../../state/nav';
import { AiError, providerLabel } from '../client';
import { buildReadingOrder } from '../context';
import { usePane, usePaneProfile } from '../store';
import { FOCUSES, runBetaReader, type BetaFocus, type BetaResult } from './betaReader';
import { locateQuote, type VerifiedNote } from './quotes';

/** Lives outside the panel, so notes are still there after a look at another tab. */
interface BetaStore {
  result: BetaResult | null;
  problem: string | null;
  running: AbortController | null;
  focus: BetaFocus;
  /** The scene or chapter chosen. Until then, whatever is on screen. */
  picked: string | null;
}

export const useBeta = create<BetaStore>(() => ({ result: null, problem: null, running: null, focus: 'pacing', picked: null }));

export function resetBeta(): void {
  useBeta.getState().running?.abort();
  useBeta.setState({ result: null, problem: null, running: null, picked: null });
}

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdownSafe(text), [text]);
  return <div className="ai-md" onClick={followRenderedLink} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Selects the passage in its editor and brings it into view. */
function showPassage(entry: EditorEntry, note: VerifiedNote): void {
  const { editor } = entry;
  const { schema } = editor.state;
  const range = locateQuote(editor.getJSON() as PmNode, note.quote, (type) => schema.nodes[type]?.isLeaf ?? false);
  if (!range) {
    toast(t('That passage has changed since these notes were written.'));
    return;
  }
  editor.commands.setTextSelection(range);
  editor.view.focus();
  const { node } = editor.view.domAtPos(range.from);
  (node instanceof Element ? node : node.parentElement)?.scrollIntoView({ block: 'center' });
}

export async function jumpToNote(note: VerifiedNote, bookId: string): Promise<void> {
  const open = editorFor('node', note.sceneId);
  if (open) {
    showPassage(open, note);
    return;
  }
  useNav.getState().go({ view: 'write', bookId, nodeId: note.sceneId });
  const entry = await waitForEditor('node', note.sceneId);
  if (entry) showPassage(entry, note);
  else toast(t('That scene could not be opened.'), 'error');
}

interface Option {
  id: string;
  bookId: string;
  kind: NodeMeta['kind'];
  /** As the list shows it, saying what kind of thing it is. */
  label: string;
  /** As the notes refer to it. */
  title: string;
}

/** Each book's chapters and scenes, in reading order. */
function toOptions(books: Book[], trees: NodeMeta[][]): Option[] {
  const options: Option[] = [];
  const many = books.length > 1;
  books.forEach((book, index) => {
    const nodes = trees[index];
    const { index: order } = buildReadingOrder([{ nodes }]);
    const sorted = [...nodes].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    for (const node of sorted) {
      if (node.kind === 'part') continue;
      const name = node.title || (node.kind === 'scene' ? t('Untitled scene') : t('Untitled chapter'));
      const vars = { book: book.title, name };
      let label: string;
      if (node.kind === 'chapter') label = many ? t('{book}: Chapter: {name}', vars) : t('Chapter: {name}', vars);
      else label = many ? t('{book}: Scene: {name}', vars) : t('Scene: {name}', vars);
      options.push({ id: node.id, bookId: book.id, kind: node.kind, title: name, label });
    }
  });
  return options;
}

/** What to look for, as the list shows it. The model is told in English, from `FOCUSES`. */
function focusLabel(focus: BetaFocus): string {
  switch (focus) {
    case 'pacing':
      return t('Pacing');
    case 'clarity':
      return t('Clarity');
    case 'tension':
      return t('Tension');
    case 'character':
      return t('Character');
    case 'dialogue':
      return t('Dialogue');
    case 'continuity':
      return t('Continuity');
    default:
      return focus;
  }
}

function notesHeading(focus: BetaFocus, scope: string): string {
  switch (focus) {
    case 'pacing':
      return t('Pacing notes on {scope}', { scope });
    case 'clarity':
      return t('Clarity notes on {scope}', { scope });
    case 'tension':
      return t('Tension notes on {scope}', { scope });
    case 'character':
      return t('Character notes on {scope}', { scope });
    case 'dialogue':
      return t('Dialogue notes on {scope}', { scope });
    case 'continuity':
      return t('Continuity notes on {scope}', { scope });
    default:
      return scope;
  }
}

export function BetaPanel() {
  const locale = useLocale();
  const version = useDataVersion('nodes', 'books');
  const { data } = useLoad(async () => {
    const books = [...(await coreApi.books.list())].sort((a, b) => a.position - b.position);
    const trees = await Promise.all(books.map((book) => coreApi.nodes.tree(book.id)));
    return toOptions(books, trees);
  }, [version, locale]);
  const options = useMemo(() => data ?? [], [data]);

  // What is on screen is the natural default, until the person picks something.
  const routeNode = useNav((s) => (s.route.view === 'write' ? s.route.nodeId : undefined));
  const { result, problem, running, focus, picked } = useBeta();
  const target =
    options.find((o) => o.id === picked) ??
    options.find((o) => o.id === routeNode) ??
    options.find((o) => o.kind === 'scene') ??
    options[0];
  const targetId = target?.id ?? '';

  const profile = usePaneProfile();
  const model = usePane((s) => s.conversation?.context.model ?? s.pendingSettings.model);

  const run = async () => {
    if (!target || running) return;
    const controller = new AbortController();
    useBeta.setState({ running: controller, problem: null, result: null });
    try {
      const next = await runBetaReader({
        nodeId: target.id,
        bookId: target.bookId,
        scope: target.title,
        focus,
        profileId: profile.id,
        model,
        signal: controller.signal,
        confirmCost: true,
      });
      // A reset while this was out means the project it belongs to has gone.
      if (useBeta.getState().running === controller) useBeta.setState({ result: next });
    } catch (e) {
      const quiet = e instanceof AiError && (e.code === 'CANCELLED' || e.code === 'DECLINED');
      if (!quiet && useBeta.getState().running === controller) useBeta.setState({ problem: errorMessage(e) });
    } finally {
      if (useBeta.getState().running === controller) useBeta.setState({ running: null });
    }
  };

  return (
    <div className="ai-beta" data-testid="ai-feedback">
      <p className="small muted">
        {t("A beta reader's notes on your text, each tied to a passage. It only gives feedback, and changes nothing.")}
      </p>
      <label className="field ai-beta-field">
        <span className="field-label">{t('What to read')}</span>
        <select className="select" value={targetId} onChange={(e) => useBeta.setState({ picked: e.target.value })} disabled={!!running}>
          {options.length === 0 && <option value="">{t('No scenes yet')}</option>}
          {options.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>
      </label>
      <label className="field ai-beta-field">
        <span className="field-label">{t('What to look for')}</span>
        <select className="select" value={focus} onChange={(e) => useBeta.setState({ focus: e.target.value as BetaFocus })} disabled={!!running}>
          {FOCUSES.map((option) => (
            <option key={option.id} value={option.id}>{focusLabel(option.id)}</option>
          ))}
        </select>
      </label>
      <div className="ai-beta-run">
        {running ? (
          <>
            <span role="status" className="ai-waiting"><span className="ai-pulse" aria-hidden="true" />{t('Reading…')}</span>
            <button type="button" className="btn btn-sm" onClick={() => running.abort()}>{t('Stop')}</button>
          </>
        ) : (
          <button type="button" className="btn btn-sm btn-primary" disabled={!target} onClick={() => void run()}>{t('Get feedback')}</button>
        )}
        <span className="faint small truncate">
          {profile.isCloud ? t('Sent to {provider}', { provider: providerLabel(profile) }) : t('Stays on this computer')}
        </span>
      </div>

      {problem && <div className="ai-error" role="alert" data-testid="ai-beta-problem">{problem}</div>}

      {result && (
        <div className="ai-beta-result" data-testid="ai-beta-result">
          <h3 className="ai-context-head">{notesHeading(result.focus, result.scope)}</h3>
          {result.summary && <Markdown text={result.summary} />}
          {result.notes.length === 0 && result.dropped === 0 && <p className="muted small">{t('The reader had no notes on this.')}</p>}
          <ul className="ai-beta-notes">
            {result.notes.map((note) => (
              <li key={note.id}>
                <button
                  type="button"
                  className="ai-beta-note"
                  data-testid="ai-beta-note"
                  title={t('Show this passage in the text')}
                  onClick={() => void jumpToNote(note, result.bookId)}
                >
                  <span className="ai-beta-quote">{note.quote}</span>
                  {result.sceneCount > 1 && <span className="faint small">{note.sceneTitle}</span>}
                  <Markdown text={note.note} />
                </button>
              </li>
            ))}
          </ul>
          {result.dropped > 0 && (
            <p className="ai-note" data-testid="ai-beta-dropped">
              {result.dropped === 1
                ? t('1 note was left out, because the passage quoted is not in your text.')
                : t('{count} notes were left out, because the passage quoted is not in your text.', { count: result.dropped })}
            </p>
          )}
          {result.unread.length > 0 && (
            <p className="ai-note">{t('Did not fit, and was not read: {scenes}. Try these scenes on their own.', { scenes: result.unread.join(', ') })}</p>
          )}
          {result.withheld.length > 0 && (
            <p className="ai-note">{t('Marked local only, so not sent to this profile: {scenes}.', { scenes: result.withheld.join(', ') })}</p>
          )}
        </div>
      )}
    </div>
  );
}
