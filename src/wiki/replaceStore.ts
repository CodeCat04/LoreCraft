/**
 * The find and replace screen's state. It lives outside the view so a preview survives
 * opening a result to check it and coming back.
 */

import { create } from 'zustand';

import { findReplace, wikiPages, type FindOptions, type ReplaceChoice, type ReplacePreview } from './api';
import { flushAllEditors, flushOrStop } from '../editor/saving';
import { promptText } from '../shell/dialogs';
import { toast } from '../shell/toasts';
import { useNav } from '../state/nav';
import { t } from '../lib/i18n';
import { RpcError, errorMessage } from '../lib/rpc';
import { undoBulkChange, type BulkChange } from '../write/history/api';

export interface RenameJob {
  pageId: string;
  oldTitle: string;
  newTitle: string;
  /** Documents whose links will follow the rename whatever is ticked below. */
  linkedDocuments: number;
  keepAlias: boolean;
}

interface ReplaceState {
  find: string;
  replace: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  scope: 'all' | 'pages' | 'scenes';
  /** What the preview on screen was made with. Apply must use the same. */
  previewOptions: FindOptions | null;
  preview: ReplacePreview | null;
  /** `kind:id:index` of matches the writer unticked. */
  unticked: Set<string>;
  busy: boolean;
  problem: string | null;
  rename: RenameJob | null;
  lastResult: {
    replacements: number;
    documents: { kind: 'page' | 'node'; id: string; title: string }[];
    /** What undoing it needs. */
    undo?: BulkChange[];
  } | null;
}

const INITIAL: ReplaceState = {
  find: '',
  replace: '',
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  scope: 'all',
  previewOptions: null,
  preview: null,
  unticked: new Set(),
  busy: false,
  problem: null,
  rename: null,
  lastResult: null,
};

export const useReplace = create<ReplaceState>(() => INITIAL);

/** Longer selections are probably not what someone means to search for. */
const MAX_PREFILL_CHARS = 200;

export function matchKey(kind: string, id: string, index: number): string {
  return `${kind}:${id}:${index}`;
}

function currentOptions(state: ReplaceState): FindOptions {
  return {
    find: state.find,
    replace: state.replace,
    caseSensitive: state.caseSensitive,
    wholeWord: state.wholeWord,
    regex: state.regex,
    scope: state.scope === 'all' ? undefined : state.scope,
  };
}

/** Changing what to look for makes any preview on screen meaningless. */
export function setReplaceField(patch: Partial<ReplaceState>) {
  useReplace.setState({ ...patch, preview: null, previewOptions: null, unticked: new Set(), problem: null, lastResult: null });
}

export async function runPreview() {
  const options = currentOptions(useReplace.getState());
  useReplace.setState({ busy: true, problem: null, lastResult: null });
  try {
    // Text still waiting in an editor must be part of what gets searched.
    await flushOrStop();
    const preview = await findReplace.preview(options);
    useReplace.setState({ preview, previewOptions: options, unticked: new Set(), busy: false });
  } catch (e) {
    useReplace.setState({ preview: null, previewOptions: null, problem: errorMessage(e), busy: false });
  }
}

function chosenMatches(state: ReplaceState): ReplaceChoice[] {
  const documents: ReplaceChoice[] = [];
  for (const doc of state.preview?.documents ?? []) {
    const indexes = doc.matches
      .map((m) => m.index)
      .filter((index) => !state.unticked.has(matchKey(doc.kind, doc.id, index)));
    if (indexes.length > 0) documents.push({ kind: doc.kind, id: doc.id, hash: doc.hash, indexes });
  }
  return documents;
}

export function tickedCount(state: ReplaceState): number {
  return chosenMatches(state).reduce((total, doc) => total + doc.indexes.length, 0);
}

export async function applyReplace() {
  const state = useReplace.getState();
  if (!state.previewOptions) return;
  useReplace.setState({ busy: true, problem: null });
  try {
    await flushOrStop();
    const { rename, previewOptions } = state;
    if (rename) {
      const result = await findReplace.renameEverywhere(
        rename.pageId,
        rename.newTitle,
        rename.keepAlias,
        previewOptions,
        chosenMatches(state),
      );
      useReplace.setState({ ...INITIAL, unticked: new Set() });
      const count = result.documentsChanged;
      toast(`Renamed to “${rename.newTitle}”. Updated ${count} ${count === 1 ? 'document' : 'documents'}.`, 'success');
      useNav.getState().go({ view: 'page', id: rename.pageId });
      return;
    }
    const result = await findReplace.apply(previewOptions, chosenMatches(state));
    useReplace.setState({
      preview: null,
      previewOptions: null,
      unticked: new Set(),
      busy: false,
      lastResult: result,
    });
  } catch (e) {
    useReplace.setState({ busy: false });
    if (e instanceof RpcError && e.code === 'STALE_PREVIEW') {
      // Nothing was changed, and a fresh preview is about to replace this one.
      toast(e.message);
      await runPreview();
      return;
    }
    useReplace.setState({ problem: errorMessage(e) });
  }
}

/**
 * Puts back what the last replace changed, from the checkpoint each document got first. A
 * document edited since is left as it is.
 */
export async function undoLastReplace() {
  const changes = useReplace.getState().lastResult?.undo;
  if (!changes?.length) return;
  useReplace.setState({ busy: true });
  const done = await undoBulkChange({ changes });
  useReplace.setState(done ? { busy: false, lastResult: null } : { busy: false });
}

export function openFindReplace() {
  // A rename in progress stays on screen, since leaving it is a deliberate choice.
  const selected = window.getSelection()?.toString().trim() ?? '';
  if (selected && selected.length <= MAX_PREFILL_CHARS && !selected.includes('\n') && !useReplace.getState().rename) {
    setReplaceField({ find: selected });
  }
  useNav.getState().go({ view: 'replace' });
}

export function cancelRename() {
  useReplace.setState({ ...INITIAL, unticked: new Set() });
}

/** Asks for the new name, then shows every place the old name appears, for ticking. */
export async function startRenameEverywhere(pageId: string, oldTitle: string) {
  await flushAllEditors();
  const typed = await promptText({
    title: t('Rename “{title}” everywhere', { title: oldTitle }),
    message: t('This renames the page and updates links to it. Next you choose where the name changes in the text.'),
    label: t('New name'),
    initial: oldTitle,
    confirmLabel: t('Find the name'),
    validate: (v) => (v.trim() ? null : t('A page needs a title.')),
  });
  if (typed === null || typed.trim() === oldTitle) return;
  try {
    const preview = await wikiPages.renamePreview(pageId, typed);
    useReplace.setState({
      ...INITIAL,
      unticked: new Set(),
      find: oldTitle,
      replace: preview.newTitle,
      caseSensitive: true,
      wholeWord: true,
      rename: {
        pageId,
        oldTitle,
        newTitle: preview.newTitle,
        linkedDocuments: preview.documents.length,
        keepAlias: false,
      },
    });
    useNav.getState().go({ view: 'replace' });
    await runPreview();
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}
