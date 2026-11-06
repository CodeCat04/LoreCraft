/** An article: reading, editing, history and talk, in one encyclopedia-style layout. */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/react';
import { Selection, TextSelection } from '@tiptap/pm/state';

import {
  STATUSES,
  primePage,
  renameCurrentPage,
  renamePage,
  requestBodyFocus,
  restoreFromTrash,
  takeBodyFocus,
  takePrimedPage,
  trashPage,
  REFUSED_TITLE,
} from './actions';
import { wikiPages, type FirstAppearance } from './api';
import { articleExtensions } from './articleExtensions';
import { ContentsBox } from './Contents';
import { TagInput } from './fields';
import { HistoryTab } from './HistoryTab';
import { InfoboxEditor } from './InfoboxEditor';
import { FirstAppearanceLink, LinkedFromInfoboxes, useFirstAppearance } from './AutoSections';
import { InfoboxView } from './InfoboxView';
import { hasVisibleInfobox, normalizeInfobox } from './infobox';
import { PageLink, RouteLink } from './links';
import { extractHeadings, extractReferences, isDocBlank, isDocEmpty } from './outline';
import { startRenameEverywhere } from './replaceStore';
import { clearSession, loadPref, publishSession, savePref, useWikiSession, type PageTab } from './session';
import { usePageTypes } from './pageTypes';
import { openPageTypes, typeDraftFromPage } from './PageTypesDialog';
import { mergeTemplateFields, templateBody, templateFor, typeLabel } from './templates';
import { TalkToCharacterButton } from '../ai';
import { EMPTY_DOC } from '../editor/convert';
import { editReferenceAt, referencePositions } from '../editor/references';
import { RichEditor, followWikiLink, isUnreadableEditor } from '../editor/RichEditor';
import { SAVE_DELAY_MS, flushAllEditors, unwrittenValue, useDocSaver } from '../editor/saving';
import { AppearsOnMaps, PageRelationships } from '../extras';
import { Toolbar } from '../editor/Toolbar';
import { docPlace, rememberCursorAt, useDocClaim } from '../state/docs';
import { useDataVersion, useLoad } from '../state/events';
import { isFocusedPane, useIsFocusedPane, useNav, usePaneId } from '../state/nav';
import { useProject, useTitles } from '../state/project';
import { useSettings } from '../state/settings';
import { useUi } from '../state/ui';
import * as api from '../lib/api';
import type { PagePatch } from '../lib/api';
import { RpcError, errorMessage } from '../lib/rpc';
import { toast } from '../shell/toasts';
import { formatNumber, relativeTime } from '../lib/text';
import type { Infobox, Page, PageStatus, PmNode } from '../lib/types';
import { t } from '../lib/i18n';
import { useLocale } from '../state/language';

/** Fields the Edit tab changes, kept here so saves never disturb what is on screen. */
interface Fields {
  summary: string;
  status: PageStatus;
  pageType: string;
  aliases: string[];
  categories: string[];
  infobox: Infobox;
  /** Where the AI may first know about this page. Empty means its first appearance. */
  revealNodeId: string;
}

function fieldsOf(page: Page): Fields {
  return {
    summary: page.summary,
    status: page.status,
    pageType: page.pageType,
    aliases: page.aliases,
    categories: page.categories,
    infobox: normalizeInfobox(page.infobox),
    revealNodeId: page.revealNodeId ?? '',
  };
}

/** The saving queues for a page's article and its talk page. */
const pageSaverKey = (id: string) => `page:${id}`;
const talkSaverKey = (id: string) => `talk:${id}`;
const titleSaverKey = (id: string) => `title:${id}`;

function mergePatches(older: PagePatch, newer: PagePatch): PagePatch {
  return { ...older, ...newer };
}

/**
 * A page as stored, with whatever was typed into it that is still waiting to be stored, so
 * that a view opening it again shows the newest text and carries on from it.
 */
function withUnwritten(page: Page): Page {
  const patch = unwrittenValue<PagePatch>(pageSaverKey(page.id));
  const notes = unwrittenValue<PmNode>(talkSaverKey(page.id));
  if (!patch && !notes) return page;
  const { localOnly: _localOnly, revealNodeId, ...fields } = patch ?? {};
  const shown: Page = { ...page, ...(fields as Partial<Page>) };
  if (revealNodeId !== undefined) shown.revealNodeId = revealNodeId || null;
  if (notes) shown.notes = notes;
  return shown;
}

const OUTLINE_DELAY_MS = 250;
const BACKLINKS_SHOWN = 12;
/** How long a read-only copy waits after a save, so that a burst of them is one reload. */
const COPY_DELAY_MS = 250;

/** The pane's scrolling area, which holds this article. */
function scrollContainer(inside: Element | null): HTMLElement | null {
  return inside?.closest<HTMLElement>('.content') ?? null;
}

// ---- Small parts ----------------------------------------------------------------

function bannerFor(status: PageStatus): { className: string; text: string } | undefined {
  switch (status) {
    case 'retconned':
      return {
        className: 'wiki-banner-retconned',
        text: t('This page has been retconned. It no longer counts as canon.'),
      };
    case 'idea':
      return {
        className: 'wiki-banner-idea',
        text: t('This page is an idea. It is not part of canon yet.'),
      };
    case 'draft':
      return {
        className: 'wiki-banner-draft',
        text: t('This page is a draft. It may change before it becomes canon.'),
      };
    default:
      return undefined;
  }
}

function StatusBanner(props: { status: PageStatus; onMakeCanon: () => void }) {
  useLocale();
  const banner = bannerFor(props.status);
  if (!banner) return null;
  return (
    <div className={`wiki-banner ${banner.className}`} role="note" data-status={props.status}>
      <span>{banner.text}</span>
      <span className="wiki-banner-actions">
        <button type="button" className="btn btn-sm" onClick={props.onMakeCanon}>{t('Mark as canon')}</button>
      </span>
    </div>
  );
}

/** Errors that say the new title cannot be used, as opposed to a write that failed. */

function TitleField(props: { id: string; title: string; onDone: () => void }) {
  useLocale();
  const { id, title, onDone } = props;
  const key = titleSaverKey(id);
  const [value, setValue] = useState(() => unwrittenValue<string>(key) ?? title);
  const [focused, setFocused] = useState(false);
  const renaming = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A rename nothing else links to goes through the saving queue, so one that cannot be
  // stored keeps the typed title and tries again. A title that is refused is not kept.
  const titleNow = useRef(title);
  titleNow.current = title;
  // A rename that needed the "update links" dialog keeps the answer about an alias for its retries.
  const keepAliasFor = useRef(new Map<string, boolean>());
  const saver = useDocSaver<string>(
    async (next) => {
      try {
        await api.pages.rename(id, next, true, keepAliasFor.current.get(next) ?? false);
      } catch (e) {
        if (!(e instanceof RpcError && REFUSED_TITLE.has(e.code))) throw e;
        toast(errorMessage(e), 'error');
        if (mounted.current) setValue(titleNow.current);
        return;
      }
      toast(t('Renamed to “{title}”.', { title: next }), 'success');
    },
    { key, label: () => t('the title of “{title}”', { title: titleNow.current }) },
  );

  // Follows renames made elsewhere, such as F2, without fighting the person typing.
  useEffect(() => {
    if (!focused && !renaming.current) setValue(unwrittenValue<string>(key) ?? title);
  }, [title, focused, key]);

  const commit = async (typed: string) => {
    const next = typed.trim().replace(/\s+/g, ' ');
    if (renaming.current) return;
    if (!next || next === title) {
      // Going back to the old title also drops a rename still waiting to be stored.
      saver.discard();
      setValue(title);
      return;
    }
    if (next === unwrittenValue<string>(key)) return;
    renaming.current = true;
    try {
      await flushAllEditors();
      const preview = await wikiPages.renamePreview(id, next);
      if (preview.documents.length > 0) {
        // Other text links here, so the writer is asked how to update it.
        saver.discard();
        // A write that fails keeps the typed title in the saving queue, which tries again.
        const renamed = await renamePage(id, title, next, (newTitle, keepAlias) => {
          keepAliasFor.current.set(newTitle, keepAlias);
          saver.schedule(newTitle);
          void saver.flush();
        });
        if (mounted.current) setValue(renamed ? next : title);
        return;
      }
      keepAliasFor.current.delete(preview.newTitle);
      saver.schedule(preview.newTitle);
      await saver.flush();
    } catch (e) {
      toast(errorMessage(e), 'error');
      if (mounted.current) setValue(title);
    } finally {
      renaming.current = false;
    }
  };

  // Ctrl+E can remove this field while it has focus, and then no blur event arrives.
  const commitOnLeave = useRef(commit);
  commitOnLeave.current = commit;
  const latestValue = useRef(value);
  latestValue.current = value;
  useEffect(() => () => void commitOnLeave.current(latestValue.current), []);

  return (
    <textarea
      className="wiki-title wiki-title-input"
      rows={1}
      aria-label={t('Page title')}
      value={value}
      onChange={(e) => setValue(e.target.value.replace(/[\r\n]+/g, ' '))}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        void commit(latestValue.current);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
          onDone();
        } else if (e.key === 'Escape') {
          // The blur below must see the old title, not what was being typed.
          latestValue.current = title;
          setValue(title);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function PageMenu(props: { id: string; title: string; isHome: boolean; trashed: boolean; saveAsType: () => void }) {
  useLocale();
  const { id, title, isHome, trashed, saveAsType } = props;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const onDown = (e: globalThis.MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...(rootRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div className="wiki-page-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`wiki-tab${open ? ' is-active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {t('More')} <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="menu-popup wiki-page-menu-popup" role="menu" onKeyDown={onMenuKey}>
          <button
            type="button"
            className="menu-item"
            role="menuitem"
            disabled={trashed}
            onClick={() => run(() => void renameCurrentPage())}
          >
            <span>{t('Rename…')}</span>
            <span className="menu-shortcut">F2</span>
          </button>
          <button
            type="button"
            className="menu-item"
            role="menuitem"
            disabled={trashed}
            onClick={() => run(() => void startRenameEverywhere(id, title))}
          >
            <span>{t('Rename everywhere…')}</span>
          </button>
          <button type="button" className="menu-item" role="menuitem" onClick={() => run(saveAsType)}>
            <span>{t('Save this page\'s layout as a type…')}</span>
          </button>
          <div className="menu-sep" />
          <button
            type="button"
            className="menu-item"
            role="menuitem"
            disabled={isHome || trashed}
            title={isHome ? t('The main page cannot be deleted.') : undefined}
            onClick={() => run(() => void trashPage(id, title))}
          >
            <span>{t('Move to trash…')}</span>
          </button>
        </div>
      )}
    </div>
  );
}

function DetailsEditor(props: {
  fields: Fields;
  firstAppearance: FirstAppearance | null;
  onChange: (patch: Partial<Fields>) => void;
  onTypeChange: (type: string) => void;
}) {
  useLocale();
  const { fields, firstAppearance, onChange, onTypeChange } = props;
  const { data: scenes } = useLoad(() => wikiPages.sceneOptions(), []);
  const [open, setOpen] = useState(() => loadPref('detailsOpen', true));
  const version = useDataVersion('pages', 'pageContent');
  const { data: categories } = useLoad(() => api.pages.categories(), [version]);
  const knownCategories = useMemo(() => (categories ?? []).map((c) => c.name), [categories]);
  const types = usePageTypes((s) => s.types);
  const typeKnown = types.some((template) => template.type === fields.pageType);
  return (
    <details
      className="wiki-details"
      open={open}
      onToggle={(e) => {
        const next = e.currentTarget.open;
        setOpen(next);
        savePref('detailsOpen', next);
      }}
    >
      <summary>{t('Page details')}</summary>
      <div className="wiki-details-grid">
        <label className="field wiki-details-wide">
          <span className="field-label">{t('Summary')}</span>
          <textarea
            className="textarea"
            rows={1}
            value={fields.summary}
            placeholder={t('One sentence, shown when someone hovers over a link to this page')}
            onChange={(e) => onChange({ summary: e.target.value })}
          />
        </label>
        <label className="field">
          <span className="field-label">{t('Status')}</span>
          <select
            className="select"
            aria-label={t('Status')}
            value={fields.status}
            onChange={(e) => onChange({ status: e.target.value as PageStatus })}
          >
            {STATUSES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">{t('Type')}</span>
          <select className="select" aria-label={t('Type')} value={fields.pageType} onChange={(e) => onTypeChange(e.target.value)}>
            {!typeKnown && <option value={fields.pageType}>{typeLabel(fields.pageType)}</option>}
            {types.map((template) => (
              <option key={template.type} value={template.type}>{typeLabel(template.type)}</option>
            ))}
          </select>
        </label>
        <label className="field wiki-details-wide">
          <span className="field-label">{t('The AI may know about this page from')}</span>
          <select
            className="select"
            aria-label={t('The AI may know about this page from')}
            value={fields.revealNodeId}
            onChange={(e) => onChange({ revealNodeId: e.target.value })}
          >
            <option value="">
              {firstAppearance
                ? t('Its first appearance: {scene}', { scene: firstAppearance.label })
                : t('Its first appearance, once it has one')}
            </option>
            {(scenes ?? []).map((scene) => (
              <option key={scene.id} value={scene.id}>{scene.label}</option>
            ))}
          </select>
        </label>
        <div className="field wiki-details-tags">
          <span className="field-label" id="wiki-aliases-label">{t('Also known as')}</span>
          <TagInput
            labelledBy="wiki-aliases-label"
            values={fields.aliases}
            onChange={(aliases) => onChange({ aliases })}
            placeholder={t('Other names for this page')}
          />
        </div>
        <div className="field wiki-details-tags">
          <span className="field-label" id="wiki-categories-label">{t('Categories')}</span>
          <TagInput
            labelledBy="wiki-categories-label"
            values={fields.categories}
            suggestions={knownCategories}
            onChange={(next) => onChange({ categories: next })}
            placeholder={t('Add a category')}
          />
        </div>
      </div>
    </details>
  );
}

function ReferencesSection(props: {
  references: string[];
  editor: Editor | null;
  editing: boolean;
}) {
  useLocale();
  const { references, editor, editing } = props;
  if (references.length === 0) return null;
  const citationAt = (index: number) =>
    editor?.view.dom.querySelectorAll<HTMLElement>('sup[data-reference]')[index];
  return (
    <section className="wiki-references" aria-labelledby="wiki-references-title">
      <h2 id="wiki-references-title" className="wiki-section-title">{t('References')}</h2>
      <ol>
        {references.map((text, index) => (
          <li key={index} id={`wiki-ref-${index}`}>
            <a
              href="#"
              className="wiki-ref-back"
              aria-label={t('Back to citation {number}', { number: index + 1 })}
              onClick={(e) => {
                e.preventDefault();
                citationAt(index)?.scrollIntoView({ block: 'center' });
              }}
            >
              ↑
            </a>{' '}
            <span>{text}</span>
            {editing && editor && (
              <button
                type="button"
                className="link-button wiki-ref-edit"
                aria-label={t('Change reference {number}', { number: index + 1 })}
                onClick={() => {
                  const pos = referencePositions(editor.state.doc)[index];
                  if (pos !== undefined) void editReferenceAt(editor, pos);
                }}
              >
                {t('Change')}
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function CategoriesFooter({ categories }: { categories: string[] }) {
  useLocale();
  if (categories.length === 0) return null;
  return (
    <nav className="wiki-catlinks" aria-label={t('Categories of this page')}>
      <RouteLink route={{ view: 'categories' }}>{t('Categories')}</RouteLink>:{' '}
      {categories.map((category, index) => (
        <span key={category}>
          {index > 0 && <span className="wiki-catlinks-sep"> | </span>}
          <RouteLink route={{ view: 'allPages', category }}>{category}</RouteLink>
        </span>
      ))}
    </nav>
  );
}

function LinksHere(props: { id: string; updatedAt: string; wordCount: number; live: boolean }) {
  useLocale();
  const { id, live } = props;
  // "Last edited" would otherwise say "just now" for as long as the page stays open.
  const [, setMinute] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setMinute((m) => m + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  // While editing, the article's own saves must not cause a reload per keystroke.
  const version = useDataVersion('pages', 'nodes', ...(live ? ['pageContent', 'nodeContent'] : []));
  const { data } = useLoad(() => api.pages.backlinks(id), [id, version]);
  const [showAll, setShowAll] = useState(false);
  const pages = data?.pages ?? [];
  const scenes = data?.scenes ?? [];
  const shownPages = showAll ? pages : pages.slice(0, BACKLINKS_SHOWN);
  const shownScenes = showAll ? scenes : scenes.slice(0, BACKLINKS_SHOWN);
  const hidden = pages.length - shownPages.length + scenes.length - shownScenes.length;
  return (
    <footer className="wiki-footer">
      <section aria-labelledby="wiki-links-here">
        <h2 id="wiki-links-here" className="wiki-footer-title">{t('What links here')}</h2>
        {data && pages.length === 0 && scenes.length === 0 && (
          <p className="muted small">{t('No pages link here, and no scenes mention it.')}</p>
        )}
        {pages.length > 0 && (
          <ul className="wiki-footer-list" aria-label={t('Pages that link here')}>
            {shownPages.map((page) => (
              <li key={page.id}>
                <PageLink id={page.id} title={page.title} />
              </li>
            ))}
          </ul>
        )}
        {scenes.length > 0 && (
          <>
            <h3 className="wiki-footer-subtitle">{t('Scenes that mention it')}</h3>
            <ul className="wiki-footer-list" aria-label={t('Scenes that mention it')}>
              {shownScenes.map((scene) => (
                <li key={scene.id}>
                  <RouteLink route={{ view: 'write', bookId: scene.bookId, nodeId: scene.id }}>
                    {scene.title || t('Untitled scene')}
                  </RouteLink>
                  {scene.count > 1 && <span className="faint"> {t('({count} times)', { count: scene.count })}</span>}
                </li>
              ))}
            </ul>
          </>
        )}
        {hidden > 0 && (
          <button type="button" className="link-button small" onClick={() => setShowAll(true)}>
            {t('Show {count} more', { count: formatNumber(hidden) })}
          </button>
        )}
      </section>
      <p className="wiki-footer-stamp">
        {props.wordCount === 1
          ? t('This page was last edited {time}. 1 word.', { time: relativeTime(props.updatedAt) })
          : t('This page was last edited {time}. {count} words.', {
              time: relativeTime(props.updatedAt),
              count: props.wordCount.toLocaleString(),
            })}
      </p>
    </footer>
  );
}

function TalkTab(props: { page: Page; active: boolean }) {
  useLocale();
  const { page, active } = props;
  const titleRef = useRef(page.title);
  titleRef.current = page.title;
  const saver = useDocSaver<PmNode>((notes) => wikiPages.saveFromEditor(page.id, { notes }), {
    key: talkSaverKey(page.id),
    label: () => t('the talk page of “{title}”', { title: titleRef.current }),
  });
  return (
    <div className="wiki-talk" hidden={!active}>
      <p className="muted small wiki-talk-intro">
        {t('Notes for yourself about this page. They are not part of the article and do not count as canon.')}
      </p>
      <RichEditor
        docKey={`notes:${page.id}`}
        content={page.notes ?? EMPTY_DOC}
        editable={active}
        source={{ kind: 'notes', id: page.id, title: page.title }}
        placeholder={t('Open questions, ideas, things to check')}
        onChange={(doc) => saver.schedule(doc)}
      />
    </div>
  );
}

// ---- The article ------------------------------------------------------------------

function Article(props: {
  page: Page;
  tab: PageTab;
  onHome: boolean;
  restoreCursor: number | null;
  /** A newer version of the page, for a read-only copy of one being edited in another pane. */
  liveCopy: Page | null;
  /** Set while another pane is editing this page. */
  editedElsewhere: (() => void) | null;
}) {
  const locale = useLocale();
  const { page, tab: requestedTab, onHome, restoreCursor, liveCopy, editedElsewhere } = props;
  const { id } = page;
  const trashed = Boolean(page.deletedAt);
  const tab: PageTab = trashed ? 'read' : requestedTab;
  const editing = tab === 'edit';
  const isHome = page.isHome;

  const projectName = useProject((s) => s.status.name);
  const showToolbar = useSettings((s) => s.settings.editor.showFormattingBar);
  const live = useTitles((s) => s.byId.get(id));
  const title = live?.title ?? page.title;

  const [fields, setFields] = useState(() => fieldsOf(page));
  const [stamp, setStamp] = useState({ updatedAt: page.updatedAt, wordCount: page.wordCount });
  const [editor, setEditor] = useState<Editor | null>(null);
  const [doc, setDoc] = useState<PmNode>(page.content);
  const [talkOpened, setTalkOpened] = useState(tab === 'talk');
  const [contentsHost] = useState(() => {
    const host = document.createElement('div');
    host.className = 'wiki-contents-host';
    // Inside the editor, but not part of what can be typed in.
    host.contentEditable = 'false';
    return host;
  });
  const articleRef = useRef<HTMLElement>(null);

  const editingRef = useRef(editing);
  editingRef.current = editing;
  const extensions = useMemo(
    () => articleExtensions({ contentsHost, isEditing: () => editingRef.current }),
    [contentsHost],
  );

  // ---- Saving. Patches build up, so a summary edit and a keystroke arriving in the
  // same half second both get written. A field leaves the batch only once a write of it
  // has worked, and a failed one is tried again.
  const titleRef = useRef(title);
  titleRef.current = title;
  const saver = useDocSaver<PagePatch>(
    (patch) =>
      wikiPages.saveFromEditor(id, patch).then((meta) => {
        setStamp({ updatedAt: meta.updatedAt, wordCount: meta.wordCount });
      }),
    {
      key: pageSaverKey(id),
      label: () => t('the page “{title}”', { title: titleRef.current }),
      merge: mergePatches,
    },
  );
  const savePatch = saver.schedule;

  const changeFields = useCallback(
    (patch: Partial<Fields>) => {
      setFields((current) => ({ ...current, ...patch }));
      savePatch(patch);
    },
    [savePatch],
  );

  const makeCanon = useCallback(() => changeFields({ status: 'canon' }), [changeFields]);

  // Reflects changes from elsewhere, such as a rename keeping the old name as an alias.
  // Never while editing, because what is on screen may be newer than the title list.
  // What is still waiting to be stored is newer than the list, so it stays on screen.
  useEffect(() => {
    if (!live || editingRef.current) return;
    const unwritten = unwrittenValue<PagePatch>(pageSaverKey(id));
    setFields((current) => ({
      ...current,
      summary: unwritten?.summary ?? live.summary,
      status: unwritten?.status ?? live.status,
      pageType: unwritten?.pageType ?? live.pageType,
      aliases: unwritten?.aliases ?? live.aliases,
    }));
  }, [live, id]);

  // ---- The document
  const latestDoc = useRef(page.content);
  const outlineTimer = useRef<number | undefined>(undefined);
  const onDocChange = useCallback(
    (next: PmNode) => {
      savePatch({ content: next });
      latestDoc.current = next;
      window.clearTimeout(outlineTimer.current);
      outlineTimer.current = window.setTimeout(() => setDoc(latestDoc.current), OUTLINE_DELAY_MS);
    },
    [savePatch],
  );
  useEffect(() => () => window.clearTimeout(outlineTimer.current), []);

  const scene = useFirstAppearance(id);
  // The main page is a front door, not part of the world, so it has no first appearance.
  const firstAppearance = isHome ? null : scene;
  const headings = useMemo(() => extractHeadings(doc), [doc]);
  const references = useMemo(() => extractReferences(doc), [doc]);
  const empty = useMemo(() => isDocEmpty(doc), [doc]);

  const changeType = useCallback(
    (pageType: string) => {
      const template = templateFor(pageType);
      changeFields({ pageType, infobox: mergeTemplateFields(fields.infobox, template) });
      // A page with nothing written yet can take the new type's starter sections.
      if (editor && template.sections.length > 0 && isDocBlank(editor.getJSON() as PmNode)) {
        editor.commands.setContent(templateBody(template), { emitUpdate: true });
        editor.commands.focus('start');
      }
    },
    [changeFields, editor, fields.infobox],
  );

  // ---- Moving between tabs. The article stays mounted, so its undo history and scroll
  // position survive a look at the history or the talk page.
  const pendingAnchor = useRef<{ element: Element; top: number; atTop: boolean } | null>(null);
  const focusAfterSwitch = useRef(false);

  const switchTab = useCallback(
    (next: PageTab) => {
      if (next === tab) return;
      pendingAnchor.current = null;
      focusAfterSwitch.current = next === 'edit';
      if ((tab === 'read' || tab === 'edit') && (next === 'read' || next === 'edit') && editor) {
        // Keeps the same text at the same height when the layout around it changes.
        const container = scrollContainer(articleRef.current);
        const viewTop = container?.getBoundingClientRect().top ?? 0;
        for (const child of editor.view.dom.children) {
          const box = child.getBoundingClientRect();
          if (box.bottom > viewTop + 8 && !child.classList.contains('ProseMirror-widget')) {
            pendingAnchor.current = { element: child, top: box.top, atTop: (container?.scrollTop ?? 0) < 8 };
            break;
          }
        }
      }
      // The route for the main page is a different screen, which starts by loading.
      if (onHome) {
        primePage({ ...page, content: latestDoc.current });
        if (next === 'edit') requestBodyFocus(id);
      }
      useNav.getState().go({ view: 'page', id, tab: next });
    },
    [editor, id, onHome, page, tab],
  );

  useEffect(() => {
    if (tab === 'talk') setTalkOpened(true);
    const anchor = pendingAnchor.current;
    pendingAnchor.current = null;
    if (editing && focusAfterSwitch.current && editor) {
      focusAfterSwitch.current = false;
      const { view } = editor;
      if (anchor) {
        const start = Selection.near(view.state.doc.resolve(view.posAtDOM(anchor.element, 0)));
        view.dispatch(view.state.tr.setSelection(start));
      }
      view.focus();
    }
    if (!editing && anchor) articleRef.current?.focus({ preventScroll: true });
    // A reader at the top of the page stays there, with the title in view.
    if (!anchor || anchor.atTop) return;
    // The shell scrolls to the top of each new route after this effect, so wait for it.
    const frame = requestAnimationFrame(() => {
      const container = scrollContainer(articleRef.current);
      if (container) container.scrollTop += anchor.element.getBoundingClientRect().top - anchor.top;
    });
    return () => cancelAnimationFrame(frame);
    // Only a change of tab should run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // ---- What commands and the sidebar can see
  const paneId = usePaneId();
  const paneFocused = useIsFocusedPane();
  useEffect(() => {
    publishSession(paneId, { pageId: id, title, editor, tab, switchTab });
  }, [paneId, id, title, editor, tab, switchTab]);
  useEffect(() => () => clearSession(paneId, id), [paneId, id]);

  const setStatusItem = useUi((s) => s.setStatusItem);
  useEffect(() => {
    if (!paneFocused) return undefined;
    setStatusItem(
      'wiki-words',
      stamp.wordCount === 1 ? t('1 word') : t('{count} words', { count: stamp.wordCount.toLocaleString() }),
    );
    return () => setStatusItem('wiki-words', null);
  }, [setStatusItem, stamp.wordCount, paneFocused, locale]);

  // A read-only copy follows what the other pane saves.
  useEffect(() => {
    if (!liveCopy || editingRef.current) return;
    setFields(fieldsOf(liveCopy));
    setStamp({ updatedAt: liveCopy.updatedAt, wordCount: liveCopy.wordCount });
    setDoc(liveCopy.content);
    latestDoc.current = liveCopy.content;
    if (!editor || editor.isDestroyed || isUnreadableEditor(editor)) return;
    let same: boolean;
    try {
      same = editor.schema.nodeFromJSON(liveCopy.content).eq(editor.state.doc);
    } catch {
      // Text this version cannot read would show as blank, so the copy keeps what it shows.
      return;
    }
    if (!same) editor.commands.setContent(liveCopy.content, { emitUpdate: false });
  }, [liveCopy, editor]);

  const handleReady = useCallback(
    (ready: Editor) => {
      setEditor(ready);
      ready.on('selectionUpdate', () => {
        if (!editingRef.current) return;
        const { anchor, head } = ready.state.selection;
        rememberCursorAt(`page:${id}`, anchor, head);
      });
      const place = docPlace(`page:${id}`);
      if (restoreCursor !== null) {
        ready.commands.focus(Math.min(restoreCursor, ready.state.doc.content.size));
      } else if (takeBodyFocus(id)) {
        ready.commands.focus('start');
      } else if (place && place.anchor > 0 && editingRef.current) {
        // Back where the writer was, in a tab coming to the front or in the app reopening.
        const { doc: current, tr } = ready.state;
        const inside = (pos: number) => current.resolve(Math.max(0, Math.min(current.content.size, pos)));
        ready.view.dispatch(tr.setSelection(TextSelection.between(inside(place.anchor), inside(place.head))));
        if (isFocusedPane(paneId)) ready.view.focus();
      }
    },
    [id, paneId, restoreCursor],
  );

  // Arriving from the search box, keys such as Page Down should scroll this page.
  useEffect(() => {
    if (document.activeElement === document.body && isFocusedPane(paneId)) {
      articleRef.current?.focus({ preventScroll: true });
    }
    // Only on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const jumpToHeading = useCallback(
    (index: number) => {
      editor?.view.dom.querySelectorAll('h1, h2, h3, h4')[index]?.scrollIntoView({ block: 'start' });
    },
    [editor],
  );

  // ---- Reading: citations jump to their reference, and links work from the keyboard.
  const onBodyClick = (e: MouseEvent<HTMLDivElement>) => {
    if (editing || !editor) return;
    const citation = (e.target as HTMLElement).closest('sup[data-reference]');
    if (!citation) return;
    const citations = [...editor.view.dom.querySelectorAll('sup[data-reference]')];
    const target = document.getElementById(`wiki-ref-${citations.indexOf(citation)}`);
    target?.scrollIntoView({ block: 'center' });
    target?.classList.remove('is-flashing');
    void target?.getBoundingClientRect();
    target?.classList.add('is-flashing');
  };
  const onBodyKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing || e.key !== 'Enter') return;
    const link = (e.target as HTMLElement).closest('.ProseMirror [data-wiki-target]');
    const target = link?.getAttribute('data-wiki-target');
    if (target) {
      e.preventDefault();
      followWikiLink(target, e);
    }
  };

  const onReadingTabs = tab === 'read' || tab === 'edit';

  return (
    <article className={`wiki-page wiki-tab-${tab}`} ref={articleRef} tabIndex={-1}>
      <header className="wiki-head">
        {editing ? (
          <TitleField id={id} title={title} onDone={() => editor?.commands.focus()} />
        ) : (
          <h1 className="wiki-title">{title}</h1>
        )}
        <div className="wiki-tabs">
          <nav className="wiki-tabs-group" aria-label={t('Page and talk')}>
            <button
              type="button"
              className={`wiki-tab${tab !== 'talk' ? ' is-active' : ''}`}
              aria-current={tab !== 'talk' ? 'page' : undefined}
              onClick={() => switchTab(tab === 'talk' ? 'read' : tab)}
            >
              {t('Article')}
            </button>
            {!trashed && (
              <button
                type="button"
                className={`wiki-tab${tab === 'talk' ? ' is-active' : ''}`}
                aria-current={tab === 'talk' ? 'page' : undefined}
                onClick={() => switchTab('talk')}
              >
                {t('Talk')}
              </button>
            )}
          </nav>
          <span className="wiki-tabs-gap" />
          <nav className="wiki-tabs-group" aria-label={t('Views of this page')}>
            <button
              type="button"
              className={`wiki-tab${tab === 'read' ? ' is-active' : ''}`}
              aria-current={tab === 'read' ? 'page' : undefined}
              onClick={() => switchTab('read')}
            >
              {t('Read')}
            </button>
            {!trashed && (
              <button
                type="button"
                className={`wiki-tab${tab === 'edit' ? ' is-active' : ''}`}
                aria-current={tab === 'edit' ? 'page' : undefined}
                onClick={() => switchTab('edit')}
              >
                {t('Edit')}
              </button>
            )}
            <button
              type="button"
              className={`wiki-tab${tab === 'history' ? ' is-active' : ''}`}
              aria-current={tab === 'history' ? 'page' : undefined}
              onClick={() => switchTab('history')}
            >
              {t('History')}
            </button>
            <PageMenu
              id={id}
              title={title}
              isHome={isHome}
              trashed={trashed}
              saveAsType={() => void openPageTypes(typeDraftFromPage(title, fields.infobox, latestDoc.current))}
            />
          </nav>
        </div>
      </header>

      {trashed && (
        <div className="wiki-banner wiki-banner-retconned" role="note">
          <span>{t('This page is in the trash. Links to it show as red until it is restored.')}</span>
          <span className="wiki-banner-actions">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void restoreFromTrash(id, title)}
            >
              {t('Restore')}
            </button>
          </span>
        </div>
      )}

      <div className="wiki-article" hidden={!onReadingTabs}>
        {editedElsewhere && (
          <div className="doc-copy-note" role="note">
            <span>{t('This page is being edited in the other pane. This copy follows along as the text is saved.')}</span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                editedElsewhere();
                switchTab('edit');
              }}
            >
              {t('Edit here')}
            </button>
          </div>
        )}
        {!trashed && !isHome && <StatusBanner status={fields.status} onMakeCanon={makeCanon} />}

        {!editing && (
          <div className="wiki-subtitle">
            <span>{t('From {project}', { project: projectName })}</span>
            {!isHome && (
              <>
                <span className="badge">{typeLabel(fields.pageType)}</span>
                {fields.status === 'canon' && <span className="badge badge-canon">{t('Canon')}</span>}
                {fields.pageType === 'character' && !trashed && <TalkToCharacterButton pageId={id} title={title} />}
              </>
            )}
          </div>
        )}
        {!editing && fields.summary && <p className="wiki-summary">{fields.summary}</p>}
        {!editing && fields.aliases.length > 0 && (
          <p className="wiki-aka">
            <span className="wiki-aka-label">{t('Also known as')}</span> {fields.aliases.join(', ')}
          </p>
        )}

        {!editing && firstAppearance && !hasVisibleInfobox(fields.infobox) && (
          <p className="wiki-aka">
            <span className="wiki-aka-label">{t('First appears:')}</span> <FirstAppearanceLink scene={firstAppearance} />
          </p>
        )}

        {editing && (
          <DetailsEditor
            fields={fields}
            firstAppearance={firstAppearance}
            onChange={changeFields}
            onTypeChange={changeType}
          />
        )}
        {editing && editor && showToolbar && (
          <div className="wiki-toolbar">
            <Toolbar editor={editor} variant="article" />
          </div>
        )}

        <div className="wiki-body" onClick={onBodyClick} onKeyDown={onBodyKeyDown}>
          {editing ? (
            <InfoboxEditor
              value={fields.infobox}
              pageType={fields.pageType}
              onChange={(infobox) => changeFields({ infobox })}
            />
          ) : (
            <InfoboxView
              title={title}
              infobox={fields.infobox}
              extraRow={
                firstAppearance && (
                  <tr data-field="firstAppearance">
                    <th scope="row">{t('First appearance')}</th>
                    <td><FirstAppearanceLink scene={firstAppearance} /></td>
                  </tr>
                )
              }
            />
          )}
          <RichEditor
            docKey={`page:${id}`}
            content={page.content}
            editable={editing}
            toolbar={false}
            source={{ kind: 'page', id, title }}
            placeholder={t('Write here. Type [[ to link to a page.')}
            onChange={onDocChange}
            onReady={handleReady}
            extensions={extensions}
          />
          {!editing && empty && !trashed && (
            <p className="wiki-empty muted">
              {t('This page is empty.')}{' '}
              <button type="button" className="link-button" onClick={() => switchTab('edit')}>
                {t('Start writing')}
              </button>
            </p>
          )}
        </div>
        {createPortal(<ContentsBox headings={headings} onJump={jumpToHeading} />, contentsHost)}

        {!editing && <LinkedFromInfoboxes id={id} />}
        {!editing && !isHome && !trashed && (
          <>
            <PageRelationships pageId={id} title={title} pageType={fields.pageType} infobox={fields.infobox} />
            <AppearsOnMaps pageId={id} />
          </>
        )}
        <ReferencesSection references={references} editor={editor} editing={editing} />
        <CategoriesFooter categories={fields.categories} />
        <LinksHere id={id} updatedAt={stamp.updatedAt} wordCount={stamp.wordCount} live={!editing} />
      </div>

      {tab === 'history' && (
        <HistoryTab
          pageId={id}
          title={title}
          updatedAt={stamp.updatedAt}
          wordCount={stamp.wordCount}
          onRestored={() => switchTab('read')}
        />
      )}
      {talkOpened && <TalkTab page={page} active={tab === 'talk'} />}
    </article>
  );
}

// ---- Loading ------------------------------------------------------------------------

/**
 * Loads a page once, and again only when something outside the editor replaces it.
 * Ordinary data events never reach the article's content, so they cannot clobber edits.
 */
export function PageView({ id, tab, onHome = false }: { id: string; tab: PageTab; onHome?: boolean }) {
  useLocale();
  const [loaded, setLoaded] = useState<{ page: Page; epoch: number; cursor: number | null; turn: number } | null>(() => {
    const primed = takePrimedPage(id);
    return primed ? { page: withUnwritten(primed), epoch: 0, cursor: null, turn: 0 } : null;
  });
  const [problem, setProblem] = useState<string | null>(null);
  const replaced = useDataVersion(`doc:page:${id}`);
  const skipFirstLoad = useRef(loaded !== null);

  // Only one pane edits a page at a time. A pane showing it while another edits is a read-only
  // copy that follows what is saved, and whenever it gets its turn it starts from a fresh load.
  const claim = useDocClaim(`page:${id}`, tab === 'edit' || tab === 'talk');
  const hasFollowed = useRef(false);
  if (claim.watchOthers) hasFollowed.current = true;
  const [turn, setTurn] = useState(0);
  const [lastClaim, setLastClaim] = useState(claim.state);
  if (lastClaim !== claim.state) {
    setLastClaim(claim.state);
    if (claim.state === 'mine' && (lastClaim === 'blocked' || hasFollowed.current)) {
      hasFollowed.current = false;
      setTurn((t) => t + 1);
    }
  }

  useEffect(() => {
    if (skipFirstLoad.current) {
      skipFirstLoad.current = false;
      return;
    }
    let cancelled = false;
    // Anything still waiting to be written goes first, so it cannot land on top. What could
    // not be written is shown over what is stored, so the writer's text never goes away.
    void flushAllEditors()
      .then(() => api.pages.get(id))
      .then(
        (stored) => {
          if (cancelled) return;
          const page = withUnwritten(stored);
          // If the writer was typing, the new copy of the text opens where they were.
          const { editor, pageId } = useWikiSession.getState();
          const cursor = pageId === id && editor?.isFocused ? editor.state.selection.from : null;
          setLoaded((previous) => ({ page, epoch: (previous?.epoch ?? 0) + 1, cursor, turn }));
          setProblem(null);
        },
        (e) => {
          if (!cancelled) setProblem(errorMessage(e));
        },
      );
    return () => {
      cancelled = true;
    };
  }, [id, replaced, turn]);

  // Following another pane's saves, and one last look after it stops, which waits for the
  // final save to have gone through.
  const [liveCopy, setLiveCopy] = useState<Page | null>(null);
  const followed = useDataVersion(...(claim.watchOthers ? ['pageContent', 'pages'] : []));
  const wasWatching = useRef(false);
  useEffect(() => {
    const watching = claim.watchOthers;
    const stopped = wasWatching.current && !watching;
    wasWatching.current = watching;
    if (!watching && !stopped) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(
      () => {
        api.pages.get(id).then(
          (page) => {
            if (!cancelled) setLiveCopy(page);
          },
          () => {
            // The page was deleted or the project closed, and whoever did that also moves on.
          },
        );
      },
      stopped ? SAVE_DELAY_MS + COPY_DELAY_MS : COPY_DELAY_MS,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [id, claim.watchOthers, followed]);

  if (problem) {
    return (
      <div className="view-pad">
        <h1 className="view-title">{t('This page could not be opened')}</h1>
        <p className="muted">{problem}</p>
      </div>
    );
  }
  if (!loaded) return null;
  // Until its turn has loaded, or while waiting for one, a view only reads.
  const mayEdit = claim.state !== 'blocked' && loaded.turn === turn;
  return (
    <Article
      key={loaded.epoch}
      page={loaded.page}
      tab={!mayEdit && (tab === 'edit' || tab === 'talk') ? 'read' : tab}
      onHome={onHome}
      restoreCursor={loaded.cursor}
      liveCopy={liveCopy}
      editedElsewhere={claim.watchOthers ? claim.takeOver : null}
    />
  );
}

export function HomeView() {
  const version = useDataVersion('all');
  const { data: home } = useLoad(() => api.pages.home(), [version]);
  if (!home) return null;
  return <PageView key={home.id} id={home.id} tab="read" onHome />;
}
