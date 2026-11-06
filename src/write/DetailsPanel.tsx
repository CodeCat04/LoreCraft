/** Status, point of view, place, cast, date, synopsis, target, threads and notes for a scene. */

import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { nodes, sceneMentions, type NodePatch, type SceneMention } from './api';
import { threadColor } from './charts';
import { statuses } from './shared';
import { addThread, useThreadData } from './threadData';
import { useLive, useWrite } from './store';
import { wordsText } from './WriteStatus';
import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { formatNumber, titleKey } from '../lib/text';
import { useDateContext, WhosHere } from '../facts';
import { parseStoryDate } from '../lib/storyDate';
import type { Node, NodeStatus, TitleEntry } from '../lib/types';
import { toast } from '../shell/toasts';
import { useDataVersion, useLoad } from '../state/events';
import { useLocale } from '../state/language';
import { useNav } from '../state/nav';
import { useTitles } from '../state/project';
import { SceneStyleField } from '../writingStyles/SceneStyleField';

const MAX_SUGGESTIONS = 8;

function pagesOfType(entries: TitleEntry[], pageType: string): TitleEntry[] {
  return entries.filter((e) => e.pageType.toLowerCase() === pageType);
}

/** A text box that suggests pages of one type as you type. */
function PageField(props: {
  label: string;
  pageType: string;
  placeholder: string;
  emptyHint: string;
  value: string | null;
  onChange: (pageId: string) => void;
  /** Pages not to offer, such as those already chosen. */
  exclude?: readonly string[];
}) {
  useLocale();
  const { label, pageType, placeholder, emptyHint, value, onChange, exclude } = props;
  const entries = useTitles((s) => s.entries);
  const byId = useTitles((s) => s.byId);
  const go = useNav((s) => s.go);
  const current = value ? byId.get(value) : undefined;
  const [text, setText] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const listId = useId();
  const open = text !== null;
  // Arrow keys mean the highlighted name was chosen, even with nothing typed.
  const navigated = useRef(false);
  // A choice made by key or click has already been dealt with when focus leaves.
  const settled = useRef(false);

  const options = useMemo(() => {
    const pages = pagesOfType(entries, pageType).filter((p) => !exclude?.includes(p.id));
    // The name already there is not a search.
    const key = text === (current?.title ?? '') ? '' : titleKey(text ?? '');
    const matching = key
      ? pages.filter((c) => [c.title, ...c.aliases].some((name) => titleKey(name).includes(key)))
      : pages;
    return matching.slice(0, MAX_SUGGESTIONS);
  }, [entries, pageType, exclude, text, current]);

  const close = () => {
    settled.current = true;
    setText(null);
  };

  const choose = (page: TitleEntry | undefined) => {
    if (page && page.id !== value) onChange(page.id);
    close();
  };

  const commitTyped = () => {
    if (text === null) return;
    if (!text.trim()) {
      if (value) onChange('');
      close();
      return;
    }
    // An exact name counts even when the page is filed under another type.
    choose(useTitles.getState().resolve(text));
  };

  return (
    <div className="field details-pov">
      <label className="field-label" htmlFor={`${listId}-input`}>{label}</label>
      <div className="details-pov-box">
        <input
          id={`${listId}-input`}
          className="input"
          role="combobox"
          aria-expanded={open && options.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && options[active] ? `${listId}-${options[active].id}` : undefined}
          autoComplete="off"
          placeholder={placeholder}
          value={text ?? current?.title ?? ''}
          onFocus={(e) => {
            e.target.select();
            setText(e.target.value);
            setActive(0);
            navigated.current = false;
            settled.current = false;
          }}
          onChange={(e) => {
            setText(e.target.value);
            setActive(0);
            navigated.current = false;
          }}
          onBlur={() => {
            if (settled.current) settled.current = false;
            else commitTyped();
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && options.length > 0) {
              e.preventDefault();
              navigated.current = true;
              setActive((a) => (a + 1) % options.length);
            } else if (e.key === 'ArrowUp' && options.length > 0) {
              e.preventDefault();
              navigated.current = true;
              setActive((a) => (a - 1 + options.length) % options.length);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const typed = text !== null && text.trim() !== '' && text !== (current?.title ?? '');
              if ((navigated.current || typed) && options[active]) choose(options[active]);
              else commitTyped();
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              e.stopPropagation();
              close();
              e.currentTarget.blur();
            }
          }}
        />
        {open && options.length > 0 && (
          <div className="details-pov-list" id={listId} role="listbox" aria-label={label}>
            {options.map((option, i) => (
              <button
                key={option.id}
                id={`${listId}-${option.id}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={i === active}
                className={`menu-item${i === active ? ' is-active' : ''}`}
                // Keep focus in the box, so its blur does not close the list first.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  choose(option);
                  (document.activeElement as HTMLElement | null)?.blur();
                }}
                onMouseEnter={() => setActive(i)}
              >
                <span className="truncate">{option.title}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {pagesOfType(entries, pageType).length === 0 && <span className="field-hint">{emptyHint}</span>}
      {current && !open && (
        <button
          type="button"
          className="link-button small details-pov-link"
          data-wiki-target={current.title}
          onClick={() => go({ view: 'page', id: current.id })}
        >
          {t('Open page')}
        </button>
      )}
    </div>
  );
}

/** The wiki pages named in this scene, kept current as the scene is saved. */
function useSceneMentions(sceneId: string): SceneMention[] | undefined {
  const content = useDataVersion('nodeContent', 'pages');
  // Waits for a pause, since saving while typing changes `content` often.
  const [settled, setSettled] = useState(content);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(content), 250);
    return () => window.clearTimeout(timer);
  }, [content]);
  return useLoad(() => sceneMentions(sceneId), [sceneId, settled]).data;
}

function SceneMentions({ mentions }: { mentions: SceneMention[] | undefined }) {
  useLocale();
  const go = useNav((s) => s.go);
  return (
    <section className="details-section" aria-labelledby="details-mentions">
      <h3 id="details-mentions" className="details-heading">{t('In this scene')}</h3>
      {mentions && mentions.length === 0 && <p className="muted small">{t('No wiki pages are named in this scene yet.')}</p>}
      <ul className="details-mentions">
        {(mentions ?? []).map((m) => (
          <li key={m.pageId}>
            <button
              type="button"
              className="link-button details-mention"
              data-wiki-target={m.title}
              onClick={() => go({ view: 'page', id: m.pageId })}
            >
              <span className="truncate">{m.title}</span>
            </button>
            <span className="details-mention-count" title={m.count === 1 ? t('Named 1 time') : t('Named {count} times', { count: m.count })}>
              {formatNumber(m.count)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One-click additions, from the pages this scene already names. */
function Suggestions(props: {
  label: string;
  pages: SceneMention[];
  actionLabel: (title: string) => string;
  onPick: (pageId: string) => void;
}) {
  if (props.pages.length === 0) return null;
  return (
    <div className="details-suggest" role="group" aria-label={props.label}>
      <span className="details-suggest-label">{props.label}</span>
      {props.pages.slice(0, MAX_SUGGESTIONS).map((page) => (
        <button
          key={page.pageId}
          type="button"
          className="details-chip details-chip-add"
          aria-label={props.actionLabel(page.title)}
          title={props.actionLabel(page.title)}
          onClick={() => props.onPick(page.pageId)}
        >
          <span aria-hidden="true">+ </span>
          {page.title}
        </button>
      ))}
    </div>
  );
}

function CastField({ sceneId, mentions }: { sceneId: string; mentions: SceneMention[] | undefined }) {
  useLocale();
  const version = useDataVersion('nodes');
  const { data } = useLoad(() => nodes.cast(sceneId), [sceneId, version]);
  const [local, setLocal] = useState<string[] | null>(null);
  const byId = useTitles((s) => s.byId);
  const go = useNav((s) => s.go);
  const cast = local ?? data ?? [];
  useEffect(() => setLocal(null), [data]);

  const save = (pageIds: string[]) => {
    setLocal(pageIds);
    nodes.setCast(sceneId, pageIds).catch((e) => {
      setLocal(null);
      toast(t('Could not change the cast: {reason}', { reason: errorMessage(e) }), 'error');
    });
  };

  const suggested = (mentions ?? []).filter((m) => m.pageType.toLowerCase() === 'character' && !cast.includes(m.pageId));

  return (
    <div className="details-cast">
      <PageField
        label={t('Cast')}
        pageType="character"
        placeholder={t('Add a character')}
        emptyHint={t('Pages made with the character template are listed here.')}
        value={null}
        exclude={cast}
        onChange={(pageId) => {
          if (pageId && !cast.includes(pageId)) save([...cast, pageId]);
        }}
      />
      {cast.length > 0 && (
        <ul className="details-chips" aria-label={t('In the cast')}>
          {cast.map((pageId) => {
            const page = byId.get(pageId);
            const title = page?.title ?? t('Unknown page');
            return (
              <li key={pageId} className="details-chip">
                <button
                  type="button"
                  className="link-button details-chip-name"
                  data-wiki-target={page ? title : undefined}
                  onClick={() => page && go({ view: 'page', id: page.id })}
                >
                  {title}
                </button>
                <button
                  type="button"
                  className="toast-close details-chip-remove"
                  aria-label={t('Take {title} out of the cast', { title })}
                  onClick={() => save(cast.filter((id) => id !== pageId))}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <Suggestions
        label={t('Characters named in this scene')}
        pages={suggested}
        actionLabel={(title) => t('Add {title} to the cast', { title })}
        onPick={(pageId) => save([...cast, pageId])}
      />
    </div>
  );
}

/** Which plot threads run through this scene. The board shows them across the book. */
function SceneThreads({ sceneId }: { sceneId: string }) {
  useLocale();
  const bookId = useWrite((s) => s.bookId);
  const { threads, links, setLink } = useThreadData(bookId);
  const inScene = new Set(links.filter((l) => l.nodeId === sceneId).map((l) => l.threadId));
  return (
    <section className="details-section" aria-labelledby="details-threads">
      <h3 id="details-threads" className="details-heading">{t('Plot threads')}</h3>
      {threads.map((thread) => (
        <label key={thread.id} className="checkbox details-thread">
          <input
            type="checkbox"
            checked={inScene.has(thread.id)}
            onChange={(e) => setLink(sceneId, thread.id, e.target.checked)}
          />
          <span className="thread-swatch" style={{ background: threadColor(thread.color) }} aria-hidden="true" />
          <span>{thread.name}</span>
        </label>
      ))}
      <button
        type="button"
        className="link-button small"
        onClick={() => {
          void addThread().then((made) => {
            if (made) setLink(sceneId, made.id, true);
          });
        }}
      >
        {t('Add a thread')}
      </button>
    </section>
  );
}

export function DetailsPanel(props: {
  node: Node;
  /** Notes are not part of the tree, and they must outlive this panel being put away. */
  notesRef: React.RefObject<string>;
  patch: (change: NodePatch) => void;
}) {
  useLocale();
  const { node, notesRef, patch } = props;
  const meta = useWrite((s) => s.index.byId.get(node.id)) ?? node;
  const liveWords = useLive((s) => (s.sceneId === node.id ? s.words : null));
  const words = liveWords ?? meta.wordCount;
  const [notes, setNotes] = useState(notesRef.current);
  const { eras, calendar } = useDateContext();
  const mentions = useSceneMentions(node.id);
  const dateProblem = meta.storyDate.trim() !== '' && parseStoryDate(meta.storyDate, eras, calendar) === null;
  const firstMonth = calendar?.months[0]?.name;
  const placesNamed = (mentions ?? []).filter((m) => m.pageType.toLowerCase() === 'place' && m.pageId !== meta.locationPageId);

  return (
    <aside className="scene-details" aria-label={t('Scene details')}>
      <h2 className="details-title">{t('Scene details')}</h2>

      <label className="field">
        <span className="field-label">{t('Status')}</span>
        <select
          className="select"
          value={meta.status}
          onChange={(e) => patch({ status: e.target.value as NodeStatus })}
        >
          {statuses().map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
      </label>

      <PageField
        label={t('Point of view')}
        pageType="character"
        placeholder={t('Choose a character')}
        emptyHint={t('Pages made with the character template are listed here.')}
        value={meta.povPageId}
        onChange={(povPageId) => patch({ povPageId })}
      />

      <PageField
        label={t('Location')}
        pageType="place"
        placeholder={t('Choose a place')}
        emptyHint={t('Pages made with the place template are listed here.')}
        value={meta.locationPageId}
        onChange={(locationPageId) => patch({ locationPageId })}
      />
      <Suggestions
        label={t('Places named in this scene')}
        pages={placesNamed}
        actionLabel={(title) => t('Set the location to {title}', { title })}
        onPick={(locationPageId) => patch({ locationPageId })}
      />

      <CastField sceneId={node.id} mentions={mentions} />

      <SceneStyleField nodeId={node.id} />

      <label className="field">
        <span className="field-label">{t('In-world date')}</span>
        <input
          className="input"
          value={meta.storyDate}
          placeholder={firstMonth ? `15 ${firstMonth} 312` : '312-04-15'}
          aria-describedby={dateProblem ? 'details-date-hint' : undefined}
          onChange={(e) => patch({ storyDate: e.target.value })}
        />
        {dateProblem && (
          <span id="details-date-hint" className="field-hint details-date-hint">
            {t("This can't be put in order on the timeline. Forms like 312, 312-04-15 or {example} can.", {
              example: firstMonth ? `15 ${firstMonth} 312` : 'Year 312',
            })}
          </span>
        )}
      </label>

      <WhosHere node={meta} />

      <label className="field">
        <span className="field-label">{t('Synopsis')}</span>
        <textarea
          className="textarea"
          rows={4}
          value={meta.synopsis}
          placeholder={t('What happens in this scene')}
          onChange={(e) => patch({ synopsis: e.target.value })}
        />
      </label>

      <label className="field">
        <span className="field-label">{t('Target words')}</span>
        <input
          className="input"
          type="number"
          min={0}
          step={100}
          value={meta.targetWords || ''}
          placeholder={t('None')}
          onChange={(e) => patch({ targetWords: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
        />
        {meta.targetWords > 0 && (
          <span className="field-hint">
            {t('{words} of {target}', { words: wordsText(words), target: formatNumber(meta.targetWords) })}
          </span>
        )}
      </label>

      <label className="field">
        <span className="field-label">{t('Notes')}</span>
        <textarea
          className="textarea"
          rows={5}
          value={notes}
          placeholder={t('Notes to yourself, not part of the book')}
          onChange={(e) => {
            notesRef.current = e.target.value;
            setNotes(e.target.value);
            patch({ notes: e.target.value });
          }}
        />
      </label>

      <SceneThreads sceneId={node.id} />
      <SceneMentions mentions={mentions} />
    </aside>
  );
}
