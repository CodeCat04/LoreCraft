/**
 * The media library: every picture, video, sound file and PDF in the project, with where each
 * is used. Sound files and PDFs go on canvases, so they drag onto one rather than insert.
 * Thumbnails load only as they scroll near the screen, so a project with hundreds of
 * items opens at once.
 */

import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { addExistingMedia, rememberedDocument, waitForEditableEditor, type RememberedDocument } from '../editor/figure';
import { createDescribeAi } from '../editor/figure/describeAi';
import { ICONS } from '../editor/figure/icons';
import { describeFigures, type FigureInfo } from '../editor/convert';
import { flushAllEditors } from '../editor/saving';
import * as api from '../lib/api';
import { assetUrlNow, noteAssetChanged, uploadAsset } from '../lib/assets';
import { t } from '../lib/i18n';
import { errorMessage, rpc } from '../lib/rpc';
import { confirm, showDialog } from '../shell/dialogs';
import { toast } from '../shell/toasts';
import { useDataVersion, useLoad } from '../state/events';
import { useLocale } from '../state/language';
import { useNav } from '../state/nav';
import { refDragProps } from '../canvas/refDrag';
import { formatBytes } from './format';
import { drawFirstPage, openInSystemViewer } from './pdf';
import { CARD_KINDS } from './sniff';
import {
  fetchLibrary,
  fetchUsage,
  filterLibrary,
  saveLabels,
  type LibraryFilter,
  type LibraryItem,
  type MediaUse,
} from './libraryData';
import { showUnusedMediaDialog } from './unusedDialog';

const filters = (): { id: LibraryFilter; label: string }[] => [
  { id: 'all', label: t('All') },
  { id: 'image', label: t('Pictures') },
  { id: 'video', label: t('Videos') },
  { id: 'audio', label: t('Sounds') },
  { id: 'pdf', label: t('PDFs') },
  { id: 'unused', label: t('Unused') },
];

function formatDuration(seconds: number): string {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

const lineIcon = (body: string) =>
  `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">${body}</svg>`;
/** Icons for kinds the figure toolbar has none for. */
const KIND_ICONS = {
  audio: lineIcon('<path d="M6 11.5V3.5L13 2V10"/><circle cx="4.5" cy="11.5" r="1.6"/><circle cx="11.5" cy="10" r="1.6"/>'),
  pdf: lineIcon('<path d="M4 1.8H9.5L12.5 4.8V14.2H4Z"/><path d="M9.5 1.8V4.8H12.5M6 8H10.5M6 10.5H10.5"/>'),
};

/** What the Replace file dialog offers for each kind. */
const ACCEPT: Record<LibraryItem['kind'], string> = {
  image: 'image/*',
  video: 'video/*',
  audio: 'audio/*',
  pdf: 'application/pdf',
};

/** Lets an item be dragged onto a canvas. The same type as `REF_MIME` in `src/canvas`. */
const CANVAS_REF_MIME = 'application/x-lorecraft-ref';

function Icon({ svg }: { svg: string }) {
  return <span className="media-tile-icon" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** One entry in the grid. Memoized, because choosing one should not redraw hundreds. */
const Tile = memo(function Tile(props: {
  item: LibraryItem;
  selected: boolean;
  onChoose: (item: LibraryItem) => void;
}) {
  useLocale();
  const { item, selected, onChoose } = props;
  // A list of facts, each one standing on its own: "2.1 MB, 0:42, unused".
  const facts = [
    item.linked ? t('Linked file') : formatBytes(item.size),
    item.duration ? formatDuration(item.duration) : null,
    !item.inUse ? t('unused') : null,
  ].filter(Boolean);
  return (
    <li className="media-tile-cell">
      <button
        type="button"
        className={`media-tile${selected ? ' is-selected' : ''}`}
        aria-pressed={selected}
        title={item.label || item.name}
        draggable
        onDragStart={(event) => event.dataTransfer.setData(CANVAS_REF_MIME, `lorecraft:asset/${item.id}`)}
        onClick={() => onChoose(item)}
        {...refDragProps({ kind: 'asset', id: item.id })}
      >
        <span className="media-tile-thumb">
          {item.kind === 'image' ? (
            <img src={assetUrlNow(item.id)} alt="" loading="lazy" decoding="async" />
          ) : (
            <Icon svg={item.kind === 'video' ? ICONS.video : KIND_ICONS[item.kind]} />
          )}
        </span>
        <span className="media-tile-label truncate">{item.label || item.name}</span>
        <span className="media-tile-facts truncate">{facts.join(', ')}</span>
      </button>
    </li>
  );
});

function Grid(props: {
  items: LibraryItem[];
  selectedId: string | null;
  onChoose: (item: LibraryItem) => void;
}) {
  useLocale();
  return (
    <ul className="media-grid" aria-label={t('Media files')}>
      {props.items.map((item) => (
        <Tile key={item.id} item={item} selected={item.id === props.selectedId} onChoose={props.onChoose} />
      ))}
    </ul>
  );
}

function Search(props: { value: string; onChange: (value: string) => void; autoFocus?: boolean }) {
  useLocale();
  return (
    <input
      className="input media-library-search"
      type="search"
      placeholder={t('Search names, labels and descriptions')}
      aria-label={t('Search media')}
      autoFocus={props.autoFocus}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    />
  );
}

function PdfFirstPage({ id, name }: { id: string; name: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    drawFirstPage(id, ref.current!, 360).catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [id]);
  return (
    <>
      <canvas ref={ref} className="media-detail-preview" role="img" aria-label={t('First page of {name}', { name })} hidden={failed} />
      {failed && <p className="muted small">{t('The first page cannot be shown. Open it to read it.')}</p>}
    </>
  );
}

function Preview({ item }: { item: LibraryItem }) {
  useLocale();
  const [failed, setFailed] = useState(false);
  if (item.missing || failed) {
    return (
      <div className="media-notice" role="status">
        <p>
          {item.missing
            ? t('The linked file is missing: {path}', { path: item.path ?? item.name })
            : t('This cannot be shown here, possibly because of an unusual format.')}
        </p>
      </div>
    );
  }
  const url = assetUrlNow(item.id);
  const onError = () => setFailed(true);
  if (item.kind === 'pdf') {
    return (
      <div className="media-detail-pdf">
        <PdfFirstPage id={item.id} name={item.label || item.name} />
        <button type="button" className="btn btn-sm" onClick={() => void openInSystemViewer(item.id).catch((e) => toast(errorMessage(e), 'error'))}>
          {t('Open')}
        </button>
      </div>
    );
  }
  if (item.kind === 'audio') {
    return <audio className="media-detail-audio" src={url} controls preload="metadata" aria-label={item.label || item.name} onError={onError} />;
  }
  return item.kind === 'image' ? (
    <img className="media-detail-preview" src={url} alt={item.description || item.label} onError={onError} />
  ) : (
    <video className="media-detail-preview" src={url} controls preload="metadata" onError={onError} />
  );
}

function openUse(use: MediaUse) {
  const { go } = useNav.getState();
  if (use.kind === 'map') go({ view: 'maps', mapId: use.id });
  else if (use.kind === 'node') go({ view: 'write', bookId: use.bookId ?? undefined, nodeId: use.id });
  else go({ view: 'page', id: use.id, tab: use.where === 'notes' ? 'talk' : undefined });
}

/** What a use is, in the words of the document: "Picture 2: the label". */
function useDetail(use: MediaUse, assetId: string): string {
  if (use.where === 'infobox') return t('In its infobox');
  if (use.where === 'notes') return t('On its talk page');
  if (use.where === 'map') return t('The map image');
  const figures: FigureInfo[] = use.content ? describeFigures(use.content).filter((f) => f.assetId === assetId) : [];
  if (figures.length === 0) return t('Without a label');
  return figures
    .map((f) =>
      f.caption ? t('{figure}: {label}', { figure: f.name, label: f.caption }) : t('{figure}, no label', { figure: f.name }),
    )
    .join('; ');
}

function UseList({ item }: { item: LibraryItem }) {
  useLocale();
  const version = useDataVersion('media', 'pageContent', 'nodeContent', 'pages', 'nodes');
  const { data } = useLoad(() => fetchUsage(item.id), [item.id, version]);
  if (!data) return <p className="muted">{t('Looking…')}</p>;
  if (data.uses.length === 0) {
    return (
      <p className="muted">
        {data.elsewhere ? t('Only saved versions or other project data mention this.') : t('Nothing uses this yet.')}
      </p>
    );
  }
  return (
    <ul className="media-use-list">
      {data.uses.map((use) => (
        <li key={`${use.kind}-${use.id}-${use.where}`}>
          <button type="button" className="link-button" onClick={() => openUse(use)}>
            {use.title || t('Untitled')}
          </button>
          {use.deleted && <span className="badge media-use-badge">{t('In the trash')}</span>}
          <span className="media-use-detail">{useDetail(use, item.id)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Opens a document for editing, then adds the figure where its cursor last was. */
async function insertInto(document: RememberedDocument, item: LibraryItem) {
  try {
    const { kind, id } = document.source;
    const { go } = useNav.getState();
    if (kind === 'page') {
      go({ view: 'page', id, tab: 'edit' });
    } else {
      const node = await api.nodes.get(id);
      go({ view: 'write', bookId: node.bookId, nodeId: id });
    }
    const editor = await waitForEditableEditor(id);
    if (!editor) {
      toast(t('{title} did not open for editing, so nothing was added.', { title: document.source.title }), 'error');
      return;
    }
    addExistingMedia(editor.view, item, document.pos ?? editor.state.doc.content.size);
  } catch (e) {
    toast(t('Could not add it: {reason}', { reason: errorMessage(e) }), 'error');
  }
}

/** What saving a label did to the figures that use it, in whole sentences. */
function savedMessage(changed: number, kept: number): string {
  const sentences: string[] = [];
  if (changed > 0) sentences.push(changed === 1 ? t('Updated 1 figure.') : t('Updated {count} figures.', { count: changed }));
  if (kept > 0) {
    sentences.push(kept === 1 ? t('1 figure kept its own words.') : t('{count} figures kept their own words.', { count: kept }));
  }
  return sentences.join(' ') || t('Saved. New figures will start with this label.');
}

/**
 * "Describe with AI" for a picture, the same control as in a figure's popover. Its answer is
 * a suggestion, and only "Use this" puts it in the description.
 */
function DescribeWithAi(props: { assetId: string; label: string; description: string; onUse: (text: string) => void }) {
  const locale = useLocale();
  const buttonSlot = useRef<HTMLDivElement>(null);
  const panelSlot = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    const widget = createDescribeAi({
      assetId: props.assetId,
      context: () => ({
        caption: latest.current.label.trim() || undefined,
        description: latest.current.description.trim() || undefined,
      }),
      onUse: (text) => latest.current.onUse(text),
    });
    buttonSlot.current?.append(widget.button);
    panelSlot.current?.append(widget.panel);
    return () => {
      widget.destroy();
      widget.button.remove();
      widget.panel.remove();
    };
  }, [props.assetId, locale]);
  return (
    <>
      <div className="media-detail-ai" ref={buttonSlot} />
      <div ref={panelSlot} />
    </>
  );
}

/** Puts a new file in place of this one, so every page, scene and map that shows it shows the new one. */
async function replaceWith(item: LibraryItem, file: File) {
  try {
    const uploaded = await uploadAsset(file, { kinds: CARD_KINDS });
    if (uploaded.id === item.id) {
      toast(t('That is the same file.'));
      return;
    }
    await rpc('media.replace', { id: item.id, with: uploaded.id });
    noteAssetChanged(item.id);
    toast(t('Replaced {name}. Everything that showed it shows the new file.', { name: item.name }), 'success');
  } catch (e) {
    toast(t('Could not replace that: {reason}', { reason: errorMessage(e) }), 'error');
  }
}

/** Deletes it after saying which pages, scenes and maps will lose it. */
async function deleteItem(item: LibraryItem) {
  try {
    const usage = await fetchUsage(item.id);
    const titles = [...new Set(usage.uses.map((use) => use.title))];
    const sure = await confirm({
      title: t('Delete {name}?', { name: item.name }),
      message: (
        <>
          {titles.length > 0 ? (
            <>
              <p>{t('These show it, and will show a missing file instead:')}</p>
              <ul className="media-delete-uses">
                {titles.map((title) => (
                  <li key={title}>{title}</li>
                ))}
              </ul>
            </>
          ) : (
            <p>{t('Nothing shows it.')}</p>
          )}
          {usage.elsewhere && <p>{t('Saved versions of pages also mention it.')}</p>}
          <p>{t('This cannot be undone.')}</p>
        </>
      ),
      confirmLabel: t('Delete'),
      danger: true,
    });
    if (!sure) return;
    await rpc('media.delete', { id: item.id });
    toast(t('Deleted {name}.', { name: item.name }));
  } catch (e) {
    toast(t('Could not delete that: {reason}', { reason: errorMessage(e) }), 'error');
  }
}

function Detail({ item }: { item: LibraryItem }) {
  useLocale();
  const [label, setLabel] = useState(item.label);
  const [description, setDescription] = useState(item.description);
  const document = rememberedDocument();
  // What the fields were last saved as. Enter and then leaving the field must save once, and
  // the list reloads a moment after a save, so `item` can be behind.
  const saved = useRef({ label: item.label, description: item.description });

  // A change saved elsewhere replaces what is in the fields.
  useEffect(() => {
    saved.current = { label: item.label, description: item.description };
    setLabel(item.label);
    setDescription(item.description);
  }, [item.label, item.description]);

  const save = async (next: { description?: string } = {}) => {
    const previous = saved.current;
    const newLabel = label.trim();
    const newDescription = (next.description ?? description).trim();
    if (newLabel === previous.label && newDescription === previous.description) return;
    saved.current = { label: newLabel, description: newDescription };
    try {
      const { changed, kept } = await saveLabels({ ...item, ...previous }, newLabel, newDescription);
      toast(savedMessage(changed, kept), 'success');
    } catch (e) {
      toast(t('Could not save that: {reason}', { reason: errorMessage(e) }), 'error');
    }
  };

  const facts: ReactNode[] = [
    item.mime,
    item.linked ? t('Linked file, not stored in the project') : formatBytes(item.size),
    item.width && item.height ? `${item.width} × ${item.height}` : null,
    item.duration ? formatDuration(item.duration) : null,
  ].filter(Boolean);

  return (
    <aside className="media-detail" aria-label={t('Details of {name}', { name: item.name })}>
      <Preview item={item} />
      <h2 className="media-detail-name">{item.name}</h2>
      <p className="muted small">{facts.join(', ')}</p>
      {item.linked && item.path && <p className="muted small media-detail-path">{item.path}</p>}

      <label className="field">
        <span className="field-label">{t('Label')}</span>
        <input
          className="input"
          value={label}
          placeholder={t('What the AI should know this is')}
          onChange={(event) => setLabel(event.target.value)}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void save();
          }}
        />
      </label>
      <label className="field">
        <span className="field-label">{t('More detail for the AI (optional)')}</span>
        <textarea
          className="textarea"
          rows={3}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          onBlur={() => void save()}
        />
        <span className="field-hint">
          {t('Figures that share these words follow a change. One with its own keeps them.')}
        </span>
      </label>
      {item.kind === 'image' && !item.missing && (
        <DescribeWithAi
          assetId={item.id}
          label={label}
          description={description}
          onUse={(text) => {
            setDescription(text);
            void save({ description: text });
          }}
        />
      )}

      <div className="media-detail-actions">
        {item.kind === 'audio' || item.kind === 'pdf' ? (
          <p className="muted small">{t('Drag this onto a canvas to show it there.')}</p>
        ) : document ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void insertInto(document, { ...item, label: label.trim(), description: description.trim() })}
          >
            {document.source.title
              ? t('Insert into {title}', { title: document.source.title })
              : t('Insert into the current document')}
          </button>
        ) : (
          <p className="muted small">{t('Open a page or a scene first, to insert this into it.')}</p>
        )}
      </div>

      <h3 className="media-detail-heading">{t('Used in')}</h3>
      <UseList item={item} />

      <div className="media-detail-actions">
        <label className="btn btn-sm">
          {t('Replace…')}
          <input
            type="file"
            hidden
            aria-label={t('Replace {name} with another file', { name: item.name })}
            accept={ACCEPT[item.kind]}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void replaceWith(item, file);
            }}
          />
        </label>
        <button type="button" className="btn btn-sm" onClick={() => void deleteItem(item)}>
          {t('Delete…')}
        </button>
      </div>
    </aside>
  );
}

export function MediaLibraryView() {
  useLocale();
  const version = useDataVersion('media', 'pageContent', 'nodeContent', 'pages', 'nodes');
  const { data: items, error } = useLoad(async () => {
    // The document just left may have a change still on its way to storage.
    await flushAllEditors();
    return fetchLibrary();
  }, [version]);
  const [filter, setFilter] = useState<LibraryFilter>('all');
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const shown = useMemo(() => filterLibrary(items ?? [], filter, deferredQuery), [items, filter, deferredQuery]);
  const selected = items?.find((item) => item.id === selectedId) ?? null;
  const choose = useCallback((item: LibraryItem) => setSelectedId(item.id), []);

  return (
    <div className="view-pad media-library">
      <h1 className="view-title">{t('Media library')}</h1>
      <div className="media-library-bar">
        <Search value={query} onChange={setQuery} />
        <div className="segmented" role="group" aria-label={t('Show')}>
          {filters().map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className={`btn btn-sm${filter === id ? ' btn-primary' : ''}`}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="muted small" data-testid="media-count">
          {items ? t('{shown} of {total}', { shown: shown.length, total: items.length }) : ''}
        </span>
        <span className="topbar-spacer" />
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void showUnusedMediaDialog().catch((e) => toast(errorMessage(e), 'error'))}
        >
          {t('Remove unused media…')}
        </button>
      </div>

      {error && <p className="field-error">{t('Could not read the media: {reason}', { reason: error.message })}</p>}
      {items && items.length === 0 && (
        <div className="empty-state">
          {t('No pictures or videos yet. Drop one on a page or a scene while editing, and it will appear here.')}
        </div>
      )}
      {items && items.length > 0 && shown.length === 0 && <div className="empty-state">{t('Nothing matches.')}</div>}

      <div className={`media-library-body${selected ? ' has-detail' : ''}`}>
        <Grid items={shown} selectedId={selectedId} onChoose={choose} />
        {selected && <Detail key={selected.id} item={selected} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The picker, for reusing something from an Insert command
// ---------------------------------------------------------------------------

export type LibraryPick = LibraryItem | 'file' | null;

function Picker(props: { items: LibraryItem[]; close: (pick: LibraryPick) => void; fileLabel: string; title: string }) {
  useLocale();
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const shown = useMemo(() => filterLibrary(props.items, 'all', deferredQuery), [props.items, deferredQuery]);
  return (
    <>
      <h2 className="dialog-title">{props.title}</h2>
      <div className="dialog-message">{t('Already in this project, so reusing one stores nothing new.')}</div>
      <Search value={query} onChange={setQuery} autoFocus />
      <div className="media-picker-grid">
        <Grid items={shown} selectedId={null} onChoose={props.close} />
        {shown.length === 0 && <div className="empty-state">{t('Nothing matches.')}</div>}
      </div>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={() => props.close(null)}>{t('Cancel')}</button>
        <button type="button" className="btn btn-primary" onClick={() => props.close('file')}>{props.fileLabel}</button>
      </div>
    </>
  );
}

/**
 * Offers what the project already has of a kind. Returns the chosen item, `file` to go on
 * to the file dialog, which is also the answer when there is nothing to offer, or null.
 */
export async function pickFromLibrary(kind: 'image' | 'video', title: string, fileLabel: string): Promise<LibraryPick> {
  const items = (await fetchLibrary()).filter((item) => item.kind === kind && !item.missing);
  if (items.length === 0) return 'file';
  return showDialog<LibraryPick>(
    (close) => <Picker items={items} close={close} title={title} fileLabel={fileLabel} />,
    null,
  );
}
