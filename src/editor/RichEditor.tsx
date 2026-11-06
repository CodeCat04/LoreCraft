import { useEffect, useMemo, useRef } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { Placeholder, CharacterCount, Focus } from '@tiptap/extensions';
import Typography from '@tiptap/extension-typography';
import { getSchema, type Extensions } from '@tiptap/core';

import { contentProblem, readableCopy } from './contentCheck';
import { documentExtensions } from './schema';
import { wikiDecorations, refreshWikiDecorations } from './wikiDecorations';
import { linkAutocomplete } from './linkAutocomplete';
import { pageListViews } from './pageListView';
import { canvasEmbedViews } from '../canvas/embedView';
import { spellcheck } from './spellcheck';
import { editorAiExtensions, SelectionMenu } from './ai';
import { findInPage, FindBar } from './find';
import { figureExtensions } from './figure';
import { Toolbar } from './Toolbar';
import { useIsDocClaimed } from '../state/docs';
import { CommentMargin, Comments } from './comments';
import { ProseHighlights } from '../prose/highlights';
import { useTitles } from '../state/project';
import { followRoute } from '../state/nav';
import * as api from '../lib/api';
import { t } from '../lib/i18n';
import type { PmNode } from '../lib/types';

export interface EditorSource {
  kind: 'page' | 'node' | 'notes';
  id: string;
  title: string;
}

export interface RichEditorProps {
  /** Identifies the document. Changing it resets the editor and its undo history. */
  docKey: string;
  content: PmNode;
  editable: boolean;
  source: EditorSource;
  /** `article` for the wiki, `manuscript` for prose. */
  variant?: 'article' | 'manuscript';
  placeholder?: string;
  toolbar?: boolean;
  onChange?: (doc: PmNode, editor: Editor) => void;
  onReady?: (editor: Editor) => void;
  /** Extra behavior for this editor. Must not add stored nodes or marks. */
  extensions?: Extensions;
  /** Set false for a copy of a document that is not the document itself, as in history. */
  comments?: boolean;
}

/**
 * Goes to a wiki page, or to the "create this page" screen if it does not exist. With Ctrl
 * held, as passed in `event`, it opens in a new tab.
 */
export function followWikiLink(target: string, event?: { ctrlKey?: boolean; metaKey?: boolean }) {
  const entry = useTitles.getState().resolve(target);
  followRoute(entry ? { view: 'page', id: entry.id } : { view: 'missing', title: target }, event);
}

/** What a screen reader calls an editor: what it holds, and whose it is. */
export function editorName(source: EditorSource, variant: 'article' | 'manuscript'): string {
  const title = source.title.trim() || t('Untitled');
  if (source.kind === 'notes') return t('Notes: {title}', { title });
  if (variant === 'manuscript' || source.kind === 'node') return t('Scene text: {title}', { title });
  return t('Article text: {title}', { title });
}

export function RichEditor(props: RichEditorProps) {
  const {
    docKey, content, editable, source, variant = 'article', placeholder, toolbar = true,
    onChange, onReady, extensions: extra, comments = true,
  } = props;
  const withComments = comments && source.kind !== 'notes';

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const editableRef = useRef(editable);
  editableRef.current = editable;

  // The extension list is fixed for the life of a document.
  const extensions = useMemo<Extensions>(
    () => [
      ...documentExtensions(),
      Typography.configure({ oneHalf: false, oneQuarter: false, threeQuarters: false, plusMinus: false, notEqual: false, laquo: false, raquo: false, multiplication: false }),
      Placeholder.configure({ placeholder: () => placeholder ?? t('Start writing…') }),
      CharacterCount,
      Focus.configure({ className: 'has-focus', mode: 'shallowest' }),
      wikiDecorations,
      ...figureExtensions(source),
      linkAutocomplete,
      pageListViews,
      canvasEmbedViews,
      spellcheck,
      findInPage,
      ...editorAiExtensions(source),
      ...(withComments ? [Comments.configure({ canSave: () => !!onChangeRef.current })] : []),
      ProseHighlights,
      ...(extra ?? []),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [docKey],
  );

  // A document holding something this version does not know must not be blanked, and must
  // never be saved, since that would store the blank over the real text. It shows read-only,
  // as much of it as can be shown, with a notice. TipTap's own check backs this one up.
  const contentFailed = useRef<string | null>(null);
  const check = useMemo(() => {
    contentFailed.current = null;
    const schema = getSchema(extensions);
    // The problem is not logged, since its message can quote the writer's text.
    const problem = contentProblem(schema, content);
    return { problem, shown: problem ? readableCopy(schema, content) : content };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);
  const unreadable = check.problem !== null || contentFailed.current !== null;
  const unreadableRef = useRef(unreadable);
  unreadableRef.current = unreadable;
  const canEdit = editable && !unreadable;
  editableRef.current = canEdit;
  // Comments are stored in the document too, so they wait for a version that can read it.
  if (unreadable) onChangeRef.current = undefined;

  const editor = useEditor(
    {
      extensions,
      content: check.shown,
      editable: canEdit,
      enableContentCheck: true,
      onContentError: ({ editor: failed, error }) => {
        contentFailed.current = error.message;
        unreadableRef.current = true;
        failed.setEditable(false, false);
      },
      immediatelyRender: true,
      shouldRerenderOnTransaction: false,
      editorProps: {
        attributes: {
          class: `prose prose-${variant}`,
          'data-doc-key': docKey,
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': editorName(source, variant),
        },
        handleClick: (_view, _pos, event) => {
          // Other buttons on a link are dealt with by `startLinkActions`.
          if (event.button !== 0) return false;
          const el = (event.target as HTMLElement).closest('a');
          if (!el) return false;
          const target = el.getAttribute('data-wiki-target');
          if (target !== null) {
            // While editing, a plain click places the cursor. Ctrl+click opens a new tab.
            if (!editableRef.current || event.ctrlKey || event.metaKey) {
              event.preventDefault();
              followWikiLink(target, event);
              return true;
            }
            return false;
          }
          const href = el.getAttribute('href');
          if (href && (!editableRef.current || event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void api.app.openExternal(href).catch(() => {});
            return true;
          }
          event.preventDefault();
          return false;
        },
      },
      onCreate: ({ editor: e }) => {
        if (unreadableRef.current) unreadableEditors.add(e);
        onReady?.(e);
      },
      onUpdate: ({ editor: e, transaction }) => {
        // A plugin can tidy a document as it loads, such as adding a paragraph after a
        // final list. Only a transaction that changes the document itself is an edit, so
        // merely opening a page never marks the project as changed.
        if (!transaction.docChanged) return;
        // What is shown of a document this version cannot read is not the document.
        if (unreadableRef.current) return;
        onChangeRef.current?.(e.getJSON() as PmNode, e);
      },
    },
    [docKey],
  );

  // The title can change while the document stays open.
  const name = editorName(source, variant);
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.view.dom.setAttribute('aria-label', name);
  }, [editor, name]);

  useEffect(() => {
    const want = editable && !unreadableRef.current;
    if (editor.isEditable !== want) editor.setEditable(want, false);
  }, [editor, editable]);

  // Links turn blue or red as pages come and go.
  const titlesVersion = useTitles((s) => s.entries);
  useEffect(() => {
    refreshWikiDecorations(editor);
  }, [editor, titlesVersion]);

  // A read-only copy of what another pane is editing must not take edits from the AI.
  const isCopy = useIsDocClaimed(canEdit ? null : `${source.kind === 'node' ? 'node' : 'page'}:${source.id}`);
  const isUnreadable = unreadable || contentFailed.current !== null;

  return (
    <div className={`editor editor-${variant}${canEdit ? ' is-editing' : ''}`}>
      {isUnreadable && (
        <div className="doc-copy-note doc-unreadable-note" role="note" data-testid="unreadable-note">
          <span>
            {t("This text uses something this version of LoreCraft can't show. Update LoreCraft to edit it. Nothing here will be changed.")}
          </span>
        </div>
      )}
      {toolbar && canEdit && <Toolbar editor={editor} variant={variant} />}
      <EditorContent editor={editor} />
      {!isCopy && !isUnreadable && <SelectionMenu editor={editor} source={source} />}
      <FindBar editor={editor} editable={canEdit} kind={source.kind} />
      {withComments && !isUnreadable && <CommentMargin editor={editor} source={source} />}
    </div>
  );
}

const unreadableEditors = new WeakSet<Editor>();

/**
 * True for an editor showing a document this version cannot fully read. What it shows is
 * not the document, so nothing may store it or build on it, such as splitting a scene.
 */
export function isUnreadableEditor(editor: Editor): boolean {
  return unreadableEditors.has(editor);
}
