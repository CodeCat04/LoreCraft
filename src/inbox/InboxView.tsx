/** Everything captured with Ctrl+Alt+N, to work through when there is time. */

import { useEffect, useRef, useState } from 'react';

import { askForNewPage } from '../editor/makePage';
import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import * as api from '../lib/api';
import { relativeTime } from '../lib/text';
import { confirm } from '../shell/dialogs';
import { toast } from '../shell/toasts';
import { useDataVersion, useLoad } from '../state/events';
import { useLocale } from '../state/language';
import { useNav } from '../state/nav';
import { openForWriting } from '../wiki/actions';
import { templateBody, templateFor, templateInfobox } from '../wiki/templates';
import { ideas, type Idea, type IdeaStatus } from './api';
import { openCapture } from './capture';
import { bodyFromIdea, titleFromIdea } from './ideaToPage';

async function act(work: () => Promise<unknown>) {
  try {
    await work();
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

/** Asks for a title and a type, makes the page with status `idea`, and opens it. */
async function turnIntoPage(idea: Idea) {
  const page = await askForNewPage({
    heading: t('Turn this idea into a page'),
    initialTitle: titleFromIdea(idea.text),
    confirmLabel: t('Create page'),
    create: async ({ title, type }) => {
      const template = templateFor(type);
      const created = await api.pages.create({
        title,
        pageType: type,
        status: 'idea',
        content: bodyFromIdea(templateBody(template), idea.text, title),
        infobox: templateInfobox(template),
      });
      await ideas.update(idea.id, { status: 'done' });
      return created;
    },
  });
  if (page) openForWriting(page);
}

/**
 * Makes a scene from the idea, at the end of the book it was captured in, or else the first
 * book, and opens it. The idea's words become the scene's opening text.
 */
async function turnIntoScene(idea: Idea) {
  const books = await api.books.list();
  const bookId = (idea.sourceBookId && books.some((b) => b.id === idea.sourceBookId) ? idea.sourceBookId : books[0]?.id) ?? null;
  if (!bookId) {
    toast(t('Make a book first, then the idea can become a scene in it.'));
    return;
  }
  const tree = await api.nodes.tree(bookId);
  const chapters = tree.filter((node) => node.kind === 'chapter');
  let parentId = chapters.at(-1)?.id;
  if (!parentId) {
    parentId = (await api.nodes.create({ bookId, parentId: null, kind: 'chapter', title: t('Chapter {number}', { number: 1 }) })).id;
  }
  const afterId = tree.filter((node) => node.parentId === parentId).at(-1)?.id;
  const title = titleFromIdea(idea.text) || t('Scene {number}', { number: 1 });
  const scene = await api.nodes.create({
    bookId,
    parentId,
    kind: 'scene',
    title,
    afterId,
    content: bodyFromIdea({ type: 'doc', content: [{ type: 'paragraph' }] }, idea.text, ''),
  });
  await ideas.update(idea.id, { status: 'done' });
  useNav.getState().go({ view: 'write', bookId, nodeId: scene.id });
}

function SourceLink({ idea }: { idea: Idea }) {
  useLocale();
  const go = useNav((s) => s.go);
  const { sourceKind, sourceId, sourceTitle, sourceBookId } = idea;
  if (!sourceKind || !sourceId) return null;
  if (sourceTitle === null) {
    return (
      <span className="faint">
        {sourceKind === 'page' ? t('From a page that has been deleted') : t('From a scene that has been deleted')}
      </span>
    );
  }
  const name = sourceTitle || t('Untitled scene');
  return (
    <button
      type="button"
      className="link-button inbox-source"
      title={t('Go to {name}', { name })}
      onClick={() =>
        go(
          sourceKind === 'page'
            ? { view: 'page', id: sourceId }
            : { view: 'write', bookId: sourceBookId ?? undefined, nodeId: sourceId },
        )
      }
    >
      {t('From {name}', { name })}
    </button>
  );
}

function IdeaEditor(props: { idea: Idea; onDone: () => void }) {
  useLocale();
  const { idea, onDone } = props;
  const [text, setText] = useState(idea.text);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const box = boxRef.current;
    box?.focus();
    box?.setSelectionRange(box.value.length, box.value.length);
  }, []);
  const save = () => {
    if (!text.trim()) return;
    void act(() => ideas.update(idea.id, { text })).then(onDone);
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <textarea
        ref={boxRef}
        className="textarea inbox-edit-box"
        rows={2}
        value={text}
        aria-label={t('Idea text')}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            save();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onDone();
          }
        }}
      />
      <div className="inbox-actions">
        <button type="submit" className="btn btn-sm btn-primary" disabled={!text.trim()}>{t('Save')}</button>
        <button type="button" className="btn btn-sm" onClick={onDone}>{t('Cancel')}</button>
      </div>
    </form>
  );
}

function IdeaRow({ idea }: { idea: Idea }) {
  useLocale();
  const [editing, setEditing] = useState(false);
  const rowRef = useRef<HTMLLIElement>(null);
  const done = idea.status === 'done';

  /** This row is about to go, so the keyboard moves on to its neighbor rather than nowhere. */
  const leaveRow = () => {
    const row = rowRef.current;
    const next = row?.nextElementSibling ?? row?.previousElementSibling;
    next?.querySelector('button')?.focus({ preventScroll: true });
  };

  const remove = async () => {
    const yes = await confirm({
      title: t('Delete this idea?'),
      message: idea.text.length > 120 ? `${idea.text.slice(0, 120)}…` : idea.text,
      confirmLabel: t('Delete'),
      danger: true,
    });
    if (!yes) return;
    leaveRow();
    await act(() => ideas.remove(idea.id));
  };
  return (
    <li ref={rowRef} className={`inbox-item${done ? ' is-done' : ''}`}>
      {editing ? (
        <IdeaEditor idea={idea} onDone={() => setEditing(false)} />
      ) : (
        <>
          <p className="inbox-text">{idea.text}</p>
          <div className="inbox-meta small">
            <SourceLink idea={idea} />
            <span className="faint">{relativeTime(idea.createdAt)}</span>
          </div>
          <div className="inbox-actions">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                leaveRow();
                void act(() => ideas.update(idea.id, { status: done ? 'open' : 'done' }));
              }}
            >
              {done ? t('Put back') : t('Mark done')}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>{t('Edit')}</button>
            <button type="button" className="btn btn-sm" onClick={() => void turnIntoPage(idea)}>{t('Turn into a page')}</button>
            <button type="button" className="btn btn-sm" onClick={() => void act(() => turnIntoScene(idea))}>{t('Turn into a scene')}</button>
            <button type="button" className="btn btn-sm" onClick={() => void remove()}>{t('Delete')}</button>
          </div>
        </>
      )}
    </li>
  );
}

export function InboxView() {
  useLocale();
  const [showing, setShowing] = useState<IdeaStatus>('open');
  const version = useDataVersion('ideas');
  const { data: list } = useLoad(() => ideas.list(showing), [showing, version]);
  const { data: counts } = useLoad(() => ideas.count(), [version]);
  return (
    <div className="view-pad inbox">
      <h1 className="view-title">{t('Inbox')}</h1>
      <p className="muted">
        {t('Ideas you wrote down while doing something else. Press {shortcut} anywhere to add one.', { shortcut: 'Ctrl+Alt+N' })}
      </p>
      <div className="inbox-bar">
        <div className="inbox-tabs" role="group" aria-label={t('Which ideas to show')}>
          <button
            type="button"
            className={`btn btn-sm${showing === 'open' ? ' is-active' : ''}`}
            aria-pressed={showing === 'open'}
            onClick={() => setShowing('open')}
          >
            {t('Open ({count})', { count: (counts?.open ?? 0).toLocaleString() })}
          </button>
          <button
            type="button"
            className={`btn btn-sm${showing === 'done' ? ' is-active' : ''}`}
            aria-pressed={showing === 'done'}
            onClick={() => setShowing('done')}
          >
            {t('Done ({count})', { count: (counts?.done ?? 0).toLocaleString() })}
          </button>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => void openCapture()}>{t('New idea')}</button>
      </div>
      {list && list.length === 0 && (
        <p className="empty-state">
          {showing === 'open' ? t('Nothing waiting. Your next idea will show up here.') : t('No finished ideas yet.')}
        </p>
      )}
      {list && list.length > 0 && (
        <ul className="inbox-list">
          {list.map((idea) => (
            <IdeaRow key={idea.id} idea={idea} />
          ))}
        </ul>
      )}
    </div>
  );
}
