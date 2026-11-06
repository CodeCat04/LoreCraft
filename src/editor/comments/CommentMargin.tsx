/**
 * The comments beside a document. Each card sits level with its text where there is room,
 * and the cards drop below the text when the window is too narrow for a column. Typing
 * re-renders nothing here: positions are set directly on the cards, after a short wait.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { autoUpdate, computePosition, flip, offset, shift, type VirtualElement } from '@floating-ui/dom';
import type { Editor } from '@tiptap/react';

import { addCommentAt, authorLabel, comments as commentsApi, deleteComment, type Comment, type CommentPatch } from '../../notes/api';
import { TodoTick } from '../../notes/TodoTick';
import { t } from '../../lib/i18n';
import { errorMessage } from '../../lib/rpc';
import { relativeTime } from '../../lib/text';
import { confirm } from '../../shell/dialogs';
import { toast } from '../../shell/toasts';
import { useDataVersion } from '../../state/events';
import { useLocale } from '../../state/language';
import { useProject } from '../../state/project';
import { useUi } from '../../state/ui';
import type { EditorSource } from '../RichEditor';
import { commentRanges, type TextRange } from './anchor';
import { commentState, setActiveComment, setKnownComments, setPendingComment, showComment } from './extension';

/** How long after a change the cards move to follow their text. */
const LAYOUT_DELAY_MS = 150;
const CARD_GAP_PX = 6;
/** The scroll area must be this wide, in rem, before a column fits beside the text. */
const MIN_WIDTH_FOR_COLUMN_REM = 46;

type Mode = 'beside' | 'stacked';

async function act(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (e) {
    toast(t('That did not work: {reason}', { reason: errorMessage(e) }), 'error');
  }
}

// ---------------------------------------------------------------------------
// One comment
// ---------------------------------------------------------------------------

function CommentCard(props: {
  comment: Comment;
  editor: Editor;
  active: boolean;
  /** The text it was attached to has gone. */
  removed: boolean;
  register: (id: string, el: HTMLElement | null) => void;
}) {
  useLocale();
  const { comment, editor, active, removed, register } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const update = (patch: CommentPatch) => void act(() => commentsApi.update(comment.id, patch));
  const saveEdit = () => {
    const body = draft.trim();
    if (!body) return;
    setEditing(false);
    if (body !== comment.body) update({ body });
  };
  const remove = async () => {
    const yes = await confirm({
      title: comment.isTodo ? t('Delete this to-do?') : t('Delete this comment?'),
      message: t('It cannot be brought back. The text stays as it is.'),
      confirmLabel: t('Delete'),
      danger: true,
    });
    if (yes) await act(() => deleteComment(comment));
  };

  const classes = ['comment-card'];
  if (active) classes.push('is-active');
  if (comment.isTodo && comment.done) classes.push('is-done');
  if (removed) classes.push('is-removed');

  return (
    <article
      ref={(el) => register(comment.id, el)}
      className={classes.join(' ')}
      data-comment={comment.id}
      aria-label={comment.isTodo ? t('To-do by {author}', { author: authorLabel(comment.author) }) : t('Comment by {author}', { author: authorLabel(comment.author) })}
    >
      <header className="comment-card-head">
        {comment.isTodo && <TodoTick className="comment-card-tick" done={comment.done} onChange={(done) => update({ done })} />}
        <span className="comment-card-author">{authorLabel(comment.author)}</span>
        <span className="comment-card-time">{relativeTime(comment.updatedAt)}</span>
      </header>
      {removed && (
        <p className="comment-card-removed">
          {comment.quote ? t('Text removed: “{quote}”', { quote: comment.quote }) : t('About this whole document')}
        </p>
      )}
      {editing ? (
        <textarea
          className="textarea comment-card-input"
          rows={3}
          value={draft}
          autoFocus
          aria-label={t('Edit comment')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              saveEdit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setDraft(comment.body);
              setEditing(false);
            }
          }}
          onBlur={saveEdit}
        />
      ) : (
        <button type="button" className="comment-card-body" onClick={() => showComment(editor, comment.id)} title={t('Show this text')}>
          {comment.body}
        </button>
      )}
      <div className="comment-card-actions">
        <button
          type="button"
          className="link-button"
          aria-label={comment.isTodo ? t('Edit to-do') : t('Edit comment')}
          onClick={() => {
            setDraft(comment.body);
            setEditing(true);
          }}
        >
          {t('Edit')}
        </button>
        <button
          type="button"
          className="link-button"
          aria-label={comment.isTodo ? t('Not a to-do, just a comment') : t('Make this a to-do')}
          onClick={() => update({ isTodo: !comment.isTodo })}
        >
          {comment.isTodo ? t('Not a to-do') : t('To-do')}
        </button>
        <button
          type="button"
          className="link-button"
          aria-label={comment.isTodo ? t('Resolve to-do') : t('Resolve comment')}
          onClick={() => {
            if (active) setActiveComment(editor, null);
            update({ resolved: true });
          }}
        >
          {t('Resolve')}
        </button>
        <button type="button" className="link-button" aria-label={comment.isTodo ? t('Delete to-do') : t('Delete comment')} onClick={() => void remove()}>
          {t('Delete')}
        </button>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Writing a new one
// ---------------------------------------------------------------------------

function rangeAnchor(editor: Editor, range: () => TextRange | null): VirtualElement {
  return {
    getBoundingClientRect() {
      const current = range();
      if (!current || editor.isDestroyed) return new DOMRect(0, 0, 0, 0);
      try {
        const size = editor.state.doc.content.size;
        const start = editor.view.coordsAtPos(Math.min(current.from, size));
        const end = editor.view.coordsAtPos(Math.min(current.to, size));
        return new DOMRect(start.left, start.top, Math.max(1, end.right - start.left), Math.max(1, end.bottom - start.top));
      } catch {
        return new DOMRect(0, 0, 0, 0);
      }
    },
    contextElement: editor.view.dom,
  };
}

function CommentComposer(props: { editor: Editor; source: EditorSource; range: () => TextRange | null }) {
  useLocale();
  const { editor, source, range } = props;
  const [body, setBody] = useState('');
  const [isTodo, setIsTodo] = useState(false);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const anchor = useMemo(() => rangeAnchor(editor, range), [editor, range]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    return autoUpdate(anchor, element, () => {
      void computePosition(anchor, element, {
        placement: 'bottom-start',
        strategy: 'fixed',
        middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
      }).then(({ x, y }) => {
        element.style.left = `${x}px`;
        element.style.top = `${y}px`;
      });
    });
  }, [anchor]);

  const finish = useCallback(() => {
    setPendingComment(editor, null);
    if (!editor.isDestroyed) editor.view.focus();
  }, [editor]);

  /** Back where they were, with the text still selected. */
  const cancel = useCallback(() => {
    const target = range();
    setPendingComment(editor, null);
    if (editor.isDestroyed) return;
    if (target) editor.commands.setTextSelection(target);
    editor.view.focus();
  }, [editor, range]);

  const save = async () => {
    const text = body.trim();
    if (!text || !range() || saving || editor.isDestroyed || source.kind === 'notes') return;
    setSaving(true);
    try {
      const comment = await addCommentAt(editor, { kind: source.kind, id: source.id, body: text, author: 'you', isTodo }, range);
      if (editor.isDestroyed) return;
      setActiveComment(editor, comment.id);
      finish();
    } catch (e) {
      setSaving(false);
      toast(t('The comment could not be saved: {reason}', { reason: errorMessage(e) }), 'error');
    }
  };

  return createPortal(
    <div
      ref={ref}
      className="ai-float comment-composer"
      role="dialog"
      aria-label={t('New comment')}
      // React sends clicks up through a portal, and a read-through opens the scene on one.
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
        }
      }}
    >
      <textarea
        className="textarea comment-composer-input"
        rows={2}
        value={body}
        autoFocus
        placeholder={t('Add a comment')}
        aria-label={t('Comment')}
        readOnly={saving}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void save();
          }
        }}
      />
      <div className="comment-composer-foot">
        <label className="comment-composer-todo">
          <input type="checkbox" checked={isTodo} onChange={(e) => setIsTodo(e.target.checked)} /> {t('To-do')}
        </label>
        <span className="comment-composer-spacer" />
        <button type="button" className="btn btn-sm" onClick={cancel}>{t('Cancel')}</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={!body.trim() || saving} onClick={() => void save()}>
          {t('Save')}
        </button>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// The column
// ---------------------------------------------------------------------------

/** The shape of what is on screen, so a new document object with the same anchors does nothing. */
function anchoredKey(ids: Iterable<string>): string {
  return [...ids].sort().join('\n');
}

export function CommentMargin({ editor, source }: { editor: Editor; source: EditorSource }) {
  useLocale();
  const [comments, setComments] = useState<Comment[]>([]);
  const [anchors, setAnchors] = useState('');
  const [mode, setMode] = useState<Mode>('beside');
  const [active, setActive] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const focusMode = useUi((s) => s.focusMode);
  const version = useDataVersion('comments');
  const isOpen = useProject((s) => s.status.open);
  const hostRef = useRef<HTMLDivElement>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const timer = useRef(0);
  const kind = source.kind;
  const sourceId = source.id;

  useEffect(() => {
    if (kind === 'notes' || !isOpen) return;
    let cancelled = false;
    commentsApi.of(kind, sourceId).then(
      (list) => {
        if (!cancelled) setComments(list);
      },
      () => {
        // The document has just gone, and whoever removed it is moving on too.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [kind, sourceId, version, isOpen]);

  const visible = useMemo(() => comments.filter((c) => !c.resolved), [comments]);

  // A ticked to-do is finished, so its text no longer needs a highlight.
  useEffect(() => {
    if (editor.isDestroyed) return;
    const known = new Set(comments.map((c) => c.id));
    const open = new Set(comments.filter((c) => !c.resolved && !(c.isTodo && c.done)).map((c) => c.id));
    setKnownComments(editor, known, open);
  }, [editor, comments]);

  const layout = useCallback(() => {
    timer.current = 0;
    // A document with no comments costs nothing here as it is typed in.
    if (editor.isDestroyed || cards.current.size === 0) return;
    const ranges = commentRanges(editor.state.doc);
    setAnchors((current) => {
      const next = anchoredKey(ranges.keys());
      return current === next ? current : next;
    });
    const host = hostRef.current;
    if (!host || host.dataset.mode !== 'beside') {
      cards.current.forEach((el) => {
        el.style.top = '';
      });
      return;
    }
    const hostTop = host.getBoundingClientRect().top;
    const placed: { el: HTMLElement; top: number }[] = [];
    const loose: HTMLElement[] = [];
    cards.current.forEach((el, id) => {
      const first = ranges.get(id)?.[0];
      if (!first) {
        loose.push(el);
        return;
      }
      try {
        placed.push({ el, top: editor.view.coordsAtPos(first.from).top - hostTop });
      } catch {
        loose.push(el);
      }
    });
    placed.sort((a, b) => a.top - b.top);
    let next = 0;
    for (const item of placed) {
      const top = Math.max(item.top, next);
      item.el.style.top = `${top}px`;
      next = top + item.el.offsetHeight + CARD_GAP_PX;
    }
    // Comments that have lost their text have no place of their own, so they go at the end.
    for (const el of loose) {
      el.style.top = `${next}px`;
      next += el.offsetHeight + CARD_GAP_PX;
    }
  }, [editor]);

  const schedule = useCallback(() => {
    if (!timer.current) timer.current = window.setTimeout(layout, LAYOUT_DELAY_MS);
  }, [layout]);

  useEffect(() => {
    const read = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      const state = commentState(editor);
      setActive(state?.active ?? null);
      setComposing(!!state?.pending);
      if (transaction.docChanged) schedule();
    };
    editor.on('transaction', read);
    return () => {
      editor.off('transaction', read);
      window.clearTimeout(timer.current);
      timer.current = 0;
    };
  }, [editor, schedule]);

  // Room for a column depends on the scroll area, not on the page inside it.
  useEffect(() => {
    if (editor.isDestroyed) return undefined;
    const scroller = editor.view.dom.closest<HTMLElement>('.write-scroll, main.content') ?? editor.view.dom;
    const measure = () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setMode(scroller.clientWidth >= MIN_WIDTH_FOR_COLUMN_REM * rem ? 'beside' : 'stacked');
      schedule();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    // The text reflows as sizes change, and that moves everything beside it.
    observer.observe(editor.view.dom);
    return () => observer.disconnect();
  }, [editor, schedule]);

  useLayoutEffect(() => {
    layout();
  }, [layout, comments, mode, active]);

  const register = useCallback((id: string, el: HTMLElement | null) => {
    if (el) cards.current.set(id, el);
    else cards.current.delete(id);
  }, []);

  const pendingRange = useCallback(() => commentState(editor)?.pending ?? null, [editor]);

  const anchoredNow = useMemo(() => new Set(anchors ? anchors.split('\n') : []), [anchors]);
  const showColumn = !focusMode && visible.length > 0;

  return (
    <>
      {showColumn && (
        // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
        <aside
          className="comment-margin"
          data-mode={mode}
          ref={hostRef}
          aria-label={t('Comments on this text')}
          onClick={(e) => e.stopPropagation()}
        >
          {mode === 'stacked' && <h2 className="comment-margin-title">{t('Comments')}</h2>}
          {visible.map((comment) => (
            <CommentCard
              key={comment.id}
              comment={comment}
              editor={editor}
              active={active === comment.id}
              removed={!anchoredNow.has(comment.id)}
              register={register}
            />
          ))}
        </aside>
      )}
      {composing && <CommentComposer editor={editor} source={source} range={pendingRange} />}
    </>
  );
}
