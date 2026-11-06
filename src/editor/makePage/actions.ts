/**
 * Selected text to wiki link: one click if the name has a page, otherwise a small dialog
 * that makes the page. Either way the writer stays where they are, and one undo takes the
 * link back. The new page stays, since it may be wanted anyway.
 */

import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

import { t } from '../../lib/i18n';
import type { Page, TitleEntry } from '../../lib/types';
import { getCommand, runCommand } from '../../shell/commands';
import { toast } from '../../shell/toasts';
import { useTitles } from '../../state/project';
import { createFromTemplate, openForWriting } from '../../wiki/actions';
import { useWikiSession } from '../../wiki/session';
import { openSceneAt } from '../../write/store';
import { trackRange, trackedRange, untrack } from '../ai/suggestions';
import { editorFor, subscribeEditors, waitForEditor } from '../ai/registry';
import type { EditorSource } from '../RichEditor';
import { flushAllEditors } from '../saving';
import { addLinks, linkableRange, linkedTarget, nameCandidates, otherMentions, type LinkRange } from './linking';
import { askForNewPage } from './PageDialog';

export type LinkPlan =
  /** The name has a page, so one click links it. */
  | { kind: 'link'; range: LinkRange; page: TitleEntry }
  /** The name has no page. */
  | { kind: 'make'; range: LinkRange }
  /** Already a link, but the same name appears unlinked elsewhere. */
  | { kind: 'mentions'; range: LinkRange; target: string; count: number };

const DRAFT_COMMAND = 'ai.fleshOut';
const SCENE_OPEN_TIMEOUT_MS = 4000;

function namesFor(page: TitleEntry | undefined, range: LinkRange): string[] {
  return page ? [range.text, page.title, ...page.aliases] : [range.text];
}

/**
 * Where a link can be added, so that it is kept. Every editable document saves itself. In
 * Read mode the article's editor still saves, so that works without leaving Read. The
 * chapter read-through saves nothing, so a scene has to open in its editor first. An old
 * revision, or a page in the trash, is not to be changed at all.
 */
function whereToLink(editor: Editor, source: EditorSource): 'here' | 'scene editor' | null {
  if (editor.isEditable) return 'here';
  if (source.kind === 'node') return 'scene editor';
  const isArticle = source.kind === 'page' && useWikiSession.getState().editor === editor;
  return isArticle && useTitles.getState().byId.has(source.id) ? 'here' : null;
}

export function resolveName(text: string): TitleEntry | undefined {
  const { resolve } = useTitles.getState();
  for (const name of nameCandidates(text)) {
    const page = resolve(name);
    if (page) return page;
  }
  return undefined;
}

/** What linking this selection would do, or null if it does not apply. */
export function planLink(editor: Editor, source: EditorSource, from: number, to: number): LinkPlan | null {
  if (editor.isDestroyed || !whereToLink(editor, source)) return null;
  const { doc } = editor.state;
  const range = linkableRange(doc, from, to);
  if (!range) return null;
  const target = linkedTarget(doc, range);
  if (target !== null) {
    const count = otherMentions(doc, namesFor(useTitles.getState().resolve(target), range), range).length;
    return count > 0 ? { kind: 'mentions', range, target, count } : null;
  }
  const page = resolveName(range.text);
  // A page has no need to link to itself.
  if (page && source.kind !== 'node' && page.id === source.id) return null;
  return page ? { kind: 'link', range, page } : { kind: 'make', range };
}

function applyLinks(editor: Editor, ranges: { from: number; to: number }[], target: string) {
  const { view, state } = editor;
  view.dispatch(addLinks(state.tr, ranges, target));
}

/** Waits for this scene's real editor, since read-through may still have its own on screen. */
function sceneEditorFor(id: string): Promise<Editor | null> {
  const ready = () => {
    const entry = editorFor('node', id);
    return entry?.editor.isEditable ? entry.editor : null;
  };
  return new Promise((resolve) => {
    const now = ready();
    if (now) {
      resolve(now);
      return;
    }
    const stop = subscribeEditors(() => {
      const found = ready();
      if (!found) return;
      window.clearTimeout(timer);
      stop();
      resolve(found);
    });
    const timer = window.setTimeout(() => {
      stop();
      resolve(null);
    }, SCENE_OPEN_TIMEOUT_MS);
  });
}

/** Runs a plan. Resolves once it is finished, including anything a dialog asked for. */
export async function runLinkPlan(editor: Editor, source: EditorSource, plan: LinkPlan): Promise<void> {
  if (whereToLink(editor, source) === 'scene editor') {
    const { from, to, text } = plan.range;
    openSceneAt(source.id, from);
    const real = await sceneEditorFor(source.id);
    const fresh = real && planLink(real, source, from, to);
    if (!real || !fresh || fresh.range.text !== text) {
      toast(t('This scene could not be opened for editing. Try again from the scene itself.'), 'error');
      return;
    }
    real.commands.setTextSelection({ from, to });
    await applyPlan(real, fresh);
    return;
  }
  await applyPlan(editor, plan);
}

async function applyPlan(editor: Editor, plan: LinkPlan): Promise<void> {
  switch (plan.kind) {
    case 'link':
      applyLinks(editor, [plan.range], plan.page.title);
      return;
    case 'mentions': {
      const names = namesFor(useTitles.getState().resolve(plan.target), plan.range);
      applyLinks(editor, otherMentions(editor.state.doc, names, plan.range), plan.target);
      return;
    }
    case 'make':
      await makePageFrom(editor, plan.range);
  }
}

async function makePageFrom(editor: Editor, range: LinkRange): Promise<void> {
  // The text shows as selected while the dialog has the keyboard, and follows any change.
  const tracked = trackRange(editor, range.from, range.to, true);

  /** The link and the mentions go in together, so one undo takes back both. */
  const link = (target: string, also: boolean) => {
    if (editor.isDestroyed) return;
    const current = trackedRange(editor, tracked);
    if (!current) return;
    const { doc } = editor.state;
    const others = also ? otherMentions(doc, namesFor(useTitles.getState().resolve(target), range), current) : [];
    const tr = addLinks(editor.state.tr, [current, ...others], target);
    // Writing goes on after the link, and a stray key should not replace it.
    if (editor.isEditable) tr.setSelection(TextSelection.create(tr.doc, current.to));
    editor.view.dispatch(tr);
  };

  let toDraft: Page | null = null;
  try {
    await askForNewPage({
      heading: t('Make a page'),
      initialTitle: range.text,
      confirmLabel: t('Create and link'),
      mentions: otherMentions(editor.state.doc, [range.text], range).length,
      offerDraft: getCommand(DRAFT_COMMAND) !== undefined,
      useExisting: async (existing, choice) => link(existing.title, choice.alsoLink),
      create: async (choice) => {
        const created = await createFromTemplate(choice.title, choice.type, 'draft');
        // The list of names comes back with this write's event, a moment later. The link
        // should be blue from the start, and finding mentions needs the page to be known.
        await useTitles.getState().refresh();
        link(created.title, choice.alsoLink);
        if (choice.draftWithAi) toDraft = created;
        else toast(t('Made a draft page for “{title}” and linked to it.', { title: created.title }), 'success');
        return created;
      },
    });
  } finally {
    if (!editor.isDestroyed) untrack(editor, tracked);
  }
  if (toDraft) await draftWithAi(toDraft);
}

/** Opens the new page and asks the AI for a first draft, which arrives as suggestions. */
async function draftWithAi(page: Page): Promise<void> {
  await flushAllEditors();
  openForWriting(page);
  const entry = await waitForEditor('page', page.id);
  if (entry) await runCommand(DRAFT_COMMAND);
}
