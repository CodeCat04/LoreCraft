/**
 * The canvas board: an endless space of cards, groups and connections.
 *
 * The world layer moves with one CSS transform, so panning and zooming never lay out the
 * cards again, and only cards near the screen are drawn. Hit-testing for drops and boxes uses
 * `SpatialIndex`. Each change makes a new canvas, recorded for undo and saved through the same
 * queue as everything the writer types, so a force-close loses at most the last half second.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import * as api from '../lib/api';
import { uploadAsset, uploadPath } from '../lib/assets';
import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { titleKey } from '../lib/text';
import { markdownToPm } from '../editor/convert';
import { unwrittenValue, useDocSaver } from '../editor/saving';
import { CARD_FILTERS } from '../media/filters';
import { CARD_KINDS } from '../media/sniff';
import { openContextMenu, type ContextMenuItem } from '../shell/ContextMenu';
import { promptText } from '../shell/dialogs';
import { toast } from '../shell/toasts';
import { useLocale } from '../state/language';
import { useNav } from '../state/nav';
import { useTitles } from '../state/project';
import { align, arrangeGrid, distribute, lockAxis, snapMove, type AlignMode, type Guide } from './arrange';
import { canvases, type Canvas } from './api';
import { NodeView } from './cards';
import { colorVar, PRESETS, presetName } from './colors';
import { exportCanvasPng } from './exportImage';
import {
  anchor,
  boundsOf,
  chooseSides,
  drawingOrder,
  edgeMidpoint,
  edgePath,
  fitView,
  intersects,
  rectFromPoints,
  sideFacing,
  SpatialIndex,
  toWorld,
  zoomAt,
  type Point,
  type Rect,
  type Viewport,
} from './geometry';
import { History } from './history';
import { registerBoard } from './live';
import {
  edgeEnds,
  formatRef,
  newId,
  parseCanvas,
  parseRef,
  readFragment,
  safeWebUrl,
  serializeCanvas,
  youtubeEmbedUrl,
  type CanvasData,
  type CanvasEdge,
  type CanvasNode,
  type LoreRef,
  type Side,
} from './model';
import {
  addNodes,
  bringToFront,
  cloneFragment,
  copyFragment,
  duplicate,
  FIXED_SIZE,
  fitSize,
  groupAround,
  moveNodes,
  nodeById,
  removeItems,
  setPositions,
  updateEdge,
  updateNode,
  withContents,
} from './ops';

import { REF_DROP_EVENT, REF_MIME, type RefDropDetail } from './refDrag';
import { pickScene } from './scenePicker';

const SNAP_PX = 6;
const DRAW_MARGIN = 400;
/** How far each paste of the same cards lands from the last. */
const PASTE_STEP = 30;
/** A text card stops growing by itself at this height. */
const MAX_GROW_HEIGHT = 1200;
/** Parts of a card that keep their own pointer, keys and wheel. */
const OWN_INPUT = 'textarea, input, [contenteditable="true"], .canvas-doc-editor';

type Drag =
  | { kind: 'pan'; start: Point; view: Viewport; moved: boolean; button: number }
  | { kind: 'box'; start: Point; current: Point; additive: boolean; group: boolean }
  | { kind: 'move'; start: Point; ids: Set<string>; base: CanvasData; moved: boolean }
  | { kind: 'resize'; id: string; start: Point; base: CanvasData }
  | { kind: 'connect'; from: string; side: Side; current: Point; base: CanvasData }
  | { kind: 'reconnect'; edge: string; end: 'from' | 'to'; current: Point; base: CanvasData };

export function CanvasView({ id }: { id: string }) {
  useLocale();
  const [canvas, setCanvas] = useState<Canvas | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    canvases.get(id).then(
      (c) => {
        if (cancelled) return;
        // What was typed and not yet stored wins over what is stored.
        const waiting = unwrittenValue<CanvasData>(`canvas:${id}`);
        setCanvas({ ...c, data: parseCanvas(waiting ?? c.data) });
      },
      (e) => !cancelled && setFailed(errorMessage(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [id]);
  if (failed) return <div className="empty-state">{failed}</div>;
  if (!canvas) return <div className="empty-state">{t('Loading…')}</div>;
  if (canvas.deletedAt) return <TrashedCanvas canvas={canvas} />;
  return <Board key={canvas.id} canvas={canvas} />;
}

function TrashedCanvas({ canvas }: { canvas: Canvas }) {
  return (
    <div className="empty-state">
      <p>{t('This canvas is in the trash.')}</p>
      <button type="button" className="btn" onClick={() => void canvases.restore(canvas.id).then(() => location.reload())}>
        {t('Restore')}
      </button>
    </div>
  );
}

function Board({ canvas }: { canvas: Canvas }) {
  const boardRef = useRef<HTMLDivElement>(null);
  const [data, setDataState] = useState<CanvasData>(canvas.data);
  const dataRef = useRef(data);
  const [view, setViewState] = useState<Viewport>({ x: 80, y: 80, zoom: 1 });
  const viewRef = useRef(view);
  const [size, setSize] = useState({ width: 1000, height: 700 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [title, setTitle] = useState(canvas.title);
  const space = useRef(false);
  const history = useRef(new History<CanvasData>());
  const [, setTick] = useState(0);
  const titles = useTitles((s) => s.byKey);

  const saver = useDocSaver<CanvasData>((value) => canvases.update(canvas.id, value), {
    key: `canvas:${canvas.id}`,
    label: () => t('the canvas "{title}"', { title }),
  });

  const setView = useCallback((next: Viewport) => {
    viewRef.current = next;
    setViewState(next);
  }, []);

  /** Shows a canvas without recording or saving, for a drag still under way. */
  const preview = useCallback((next: CanvasData) => {
    dataRef.current = next;
    setDataState(next);
  }, []);

  /** Makes a change: recorded for undo, then saved. `before` is the state to undo to. */
  const commit = useCallback(
    (next: CanvasData, mergeKey: string | null = null, before: CanvasData = dataRef.current) => {
      if (next === before) return;
      history.current.record(before, mergeKey);
      dataRef.current = next;
      setDataState(next);
      saver.schedule(next);
      setTick((n) => n + 1);
    },
    [saver],
  );

  // Changes from elsewhere, such as an outside AI's, go through this board while it is open.
  useEffect(
    () => registerBoard(canvas.id, { data: () => dataRef.current, commit: (next) => commit(next), flush: () => saver.flush() }),
    [canvas.id, commit, saver],
  );

  const undo = useCallback(() => {
    const previous = history.current.undo(dataRef.current);
    if (!previous) return;
    preview(previous);
    saver.schedule(previous);
    setEditing(null);
  }, [preview, saver]);
  const redo = useCallback(() => {
    const next = history.current.redo(dataRef.current);
    if (!next) return;
    preview(next);
    saver.schedule(next);
  }, [preview, saver]);

  useEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    const observer = new ResizeObserver(() => setSize({ width: board.clientWidth, height: board.clientHeight }));
    observer.observe(board);
    setSize({ width: board.clientWidth, height: board.clientHeight });
    return () => observer.disconnect();
  }, []);

  // Start with everything in view.
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || size.width < 50) return;
    fitted.current = true;
    const box = boundsOf(dataRef.current.nodes);
    if (box) setView(fitView(box, size.width, size.height));
  }, [size, setView]);

  const index = useMemo(() => new SpatialIndex(data.nodes), [data.nodes]);
  const byId = useMemo(() => new Map(data.nodes.map((n) => [n.id, n])), [data.nodes]);

  const screenPoint = useCallback((e: { clientX: number; clientY: number }): Point => {
    const box = boardRef.current!.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  }, []);
  const worldPoint = useCallback((e: { clientX: number; clientY: number }) => toWorld(viewRef.current, screenPoint(e)), [screenPoint]);
  const center = useCallback((): Point => toWorld(viewRef.current, { x: size.width / 2, y: size.height / 2 }), [size]);

  const select = useCallback((ids: Iterable<string>) => {
    setSelected(new Set(ids));
    setSelectedEdge(null);
  }, []);

  // ---- Making cards ----------------------------------------------------------------------

  const place = useCallback(
    (nodes: CanvasNode[], edges: CanvasEdge[] = [], edit = false) => {
      commit(addNodes(dataRef.current, nodes, edges));
      select(nodes.map((n) => n.id));
      if (edit && nodes.length === 1) setEditing(nodes[0].id);
    },
    [commit, select],
  );

  const textNode = (at: Point, text = ''): CanvasNode => ({
    id: newId(),
    type: 'text',
    text,
    x: Math.round(at.x),
    y: Math.round(at.y),
    width: 260,
    height: text ? Math.min(400, 60 + Math.ceil(text.length / 32) * 22) : 80,
  });
  const fileNode = (at: Point, ref: LoreRef, width = 400, height = 300): CanvasNode => ({
    id: newId(),
    type: 'file',
    file: formatRef(ref),
    x: Math.round(at.x),
    y: Math.round(at.y),
    width,
    height,
  });
  const linkNode = (at: Point, url: string): CanvasNode => ({
    id: newId(),
    type: 'link',
    url,
    x: Math.round(at.x),
    y: Math.round(at.y),
    width: youtubeEmbedUrl(url) ? 480 : 400,
    height: youtubeEmbedUrl(url) ? 300 : 320,
  });

  const addText = useCallback((at: Point = center()) => place([textNode(at)], [], true), [center, place]);

  const addPage = useCallback(
    async (at: Point = center()) => {
      const byKey = useTitles.getState().byKey;
      const name = await promptText({
        title: t('Add a page'),
        label: t('Page title'),
        validate: (value) => (byKey.has(titleKey(value)) ? null : t('There is no page with that title.')),
      });
      const page = name ? useTitles.getState().byKey.get(titleKey(name)) : undefined;
      if (page) place([fileNode(at, { kind: 'page', id: page.id })]);
    },
    [center, place],
  );

  const addMedia = useCallback(
    async (at: Point = center()) => {
      const paths = await api.files.pickOpen({
        title: t('Choose pictures, videos, sounds or PDFs'),
        multiple: true,
        filters: CARD_FILTERS,
      });
      const nodes: CanvasNode[] = [];
      for (const [i, path] of paths.entries()) {
        try {
          const asset = await uploadPath(path, { kinds: CARD_KINDS });
          nodes.push(sizedAsset(fileNode({ x: at.x + i * 30, y: at.y + i * 30 }, { kind: 'asset', id: asset.id }), asset));
        } catch (e) {
          toast(errorMessage(e), 'error');
        }
      }
      if (nodes.length) place(nodes);
    },
    [center, place],
  );

  const addLink = useCallback(
    async (at: Point = center()) => {
      const url = await promptText({
        title: t('Add a web page'),
        label: t('Web address'),
        placeholder: 'https://',
        validate: (value) => (safeWebUrl(value) ? null : t('Only web addresses that start with http or https can be shown.')),
      });
      const safe = safeWebUrl(url ?? '');
      if (safe) place([linkNode(at, safe)]);
    },
    [center, place],
  );

  const addCanvasCard = useCallback(
    async (at: Point = center()) => {
      const list = await canvases.list();
      const name = await promptText({
        title: t('Add a canvas'),
        label: t('Canvas name'),
        validate: (value) => (list.some((c) => titleKey(c.title) === titleKey(value) && c.id !== canvas.id) ? null : t('There is no other canvas with that name.')),
      });
      const found = list.find((c) => name && titleKey(c.title) === titleKey(name) && c.id !== canvas.id);
      if (found) place([fileNode(at, { kind: 'canvas', id: found.id }, 300, 160)]);
    },
    [canvas.id, center, place],
  );

  const addScene = useCallback(
    async (at: Point = center()) => {
      const id = await pickScene();
      if (id) place([fileNode(at, { kind: 'scene', id })]);
    },
    [center, place],
  );

  const addFromCategory = useCallback(
    async (at: Point = center()) => {
      const name = await promptText({ title: t('Add pages from a category or page type'), label: t('Category or page type') });
      if (!name) return;
      const [byCategory, byType] = await Promise.all([api.pages.list({ category: name }), api.pages.list({ pageType: name })]);
      const pages = [...new Map([...byCategory, ...byType].map((p) => [p.id, p])).values()];
      if (pages.length === 0) return toast(t('No pages found.'));
      const columns = Math.ceil(Math.sqrt(pages.length));
      place(pages.map((p, i) => fileNode({ x: at.x + (i % columns) * 340, y: at.y + Math.floor(i / columns) * 280 }, { kind: 'page', id: p.id }, 300, 240)));
    },
    [center, place],
  );

  // ---- Changing cards ----------------------------------------------------------------------

  const removeSelected = useCallback(() => {
    if (selectedEdge) {
      commit(removeItems(dataRef.current, new Set(), new Set([selectedEdge])));
      setSelectedEdge(null);
    } else if (selected.size) {
      commit(removeItems(dataRef.current, selected));
      setSelected(new Set());
    }
  }, [commit, selected, selectedEdge]);

  const duplicateSelected = useCallback(() => {
    if (!selected.size) return;
    const out = duplicate(dataRef.current, selected);
    commit(out.data);
    select(out.ids);
  }, [commit, select, selected]);

  /** Makes cards just big enough for what they show. Groups and web cards stay as they are. */
  const fitToContent = useCallback(
    (ids: Iterable<string>) => {
      let next = dataRef.current;
      for (const id of ids) {
        const node = nodeById(next, id);
        const el = boardRef.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`);
        const body = el?.querySelector<HTMLElement>('.canvas-card-body');
        if (!node || !el || !body || node.type === 'group' || node.type === 'link') continue;
        const media = body.querySelector<HTMLImageElement | HTMLVideoElement>('img.canvas-media, video.canvas-media');
        let ratio: number | undefined;
        if (media instanceof HTMLImageElement && media.naturalWidth && media.naturalHeight) ratio = media.naturalWidth / media.naturalHeight;
        if (media instanceof HTMLVideoElement && media.videoWidth && media.videoHeight) ratio = media.videoWidth / media.videoHeight;
        const chrome = el.offsetHeight - body.offsetHeight;
        const editor = body.querySelector('textarea');
        let content: number;
        if (editor) content = body.offsetHeight + editor.scrollHeight - editor.clientHeight;
        else {
          const height = body.style.height;
          body.style.height = 'auto';
          content = body.offsetHeight;
          body.style.height = height;
        }
        const size = fitSize(node, { content, chrome, ratio });
        if (size.height !== node.height) next = updateNode(next, id, size);
      }
      commit(next);
    },
    [commit],
  );

  const groupSelected = useCallback(() => {
    const nodes = dataRef.current.nodes.filter((n) => selected.has(n.id));
    const group = groupAround(nodes);
    if (!group) return;
    // Groups draw underneath, so where it goes in the list does not matter for looks.
    commit({ ...dataRef.current, nodes: [group, ...dataRef.current.nodes] });
    select([group.id]);
    setEditing(group.id);
  }, [commit, select, selected]);

  const arrange = useCallback(
    (how: AlignMode | 'spreadX' | 'spreadY' | 'grid') => {
      const items = dataRef.current.nodes.filter((n) => selected.has(n.id));
      const out =
        how === 'spreadX' ? distribute(items, 'x') : how === 'spreadY' ? distribute(items, 'y') : how === 'grid' ? arrangeGrid(items) : align(items, how);
      commit(setPositions(dataRef.current, out));
    },
    [commit, selected],
  );

  const setColor = useCallback(
    (color: string | undefined) => {
      let next = dataRef.current;
      if (selectedEdge) next = updateEdge(next, selectedEdge, { color });
      for (const id of selected) next = updateNode(next, id, { color });
      commit(next);
    },
    [commit, selected, selectedEdge],
  );

  const customColor = useCallback(async () => {
    const value = await promptText({
      title: t('Custom color'),
      label: t('Hex color, such as #3366cc'),
      validate: (v) => (/^#[0-9a-f]{6}$/i.test(v.trim()) ? null : t('Use # and six hex digits.')),
    });
    if (value) setColor(value.trim().toLowerCase());
  }, [setColor]);

  const editEdgeLabel = useCallback(
    async (edgeId: string) => {
      const edge = dataRef.current.edges.find((e) => e.id === edgeId);
      if (!edge) return;
      const label = await promptText({ title: t('Connection label'), label: t('Label'), initial: edge.label ?? '' });
      if (label === null) return;
      commit(updateEdge(dataRef.current, edgeId, { label: label.trim() || undefined }));
    },
    [commit],
  );

  const toggleArrow = useCallback(
    (edgeId: string, end: 'from' | 'to') => {
      const edge = dataRef.current.edges.find((e) => e.id === edgeId);
      if (!edge) return;
      const ends = edgeEnds(edge);
      const key = end === 'from' ? 'fromEnd' : 'toEnd';
      commit(updateEdge(dataRef.current, edgeId, { [key]: ends[end] === 'arrow' ? 'none' : 'arrow' }));
    },
    [commit],
  );

  const turnIntoPage = useCallback(
    async (nodeId: string) => {
      const node = nodeById(dataRef.current, nodeId);
      if (node?.type !== 'text') return;
      const text = node.text ?? '';
      const first = text.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 120);
      const name = await promptText({ title: t('Make a wiki page'), label: t('Page title'), initial: first });
      if (!name?.trim()) return;
      try {
        const page = await api.pages.create({ title: name.trim(), content: markdownToPm(text), status: 'draft' } as Parameters<typeof api.pages.create>[0]);
        commit(updateNode(dataRef.current, nodeId, { type: 'file', text: undefined, file: formatRef({ kind: 'page', id: page.id }) }));
        toast(t('Made the page "{title}".', { title: page.title }), 'success');
      } catch (e) {
        toast(errorMessage(e), 'error');
      }
    },
    [commit],
  );

  const changeSource = useCallback(
    async (nodeId: string) => {
      const node = nodeById(dataRef.current, nodeId);
      if (!node) return;
      if (node.type === 'link') {
        const url = await promptText({
          title: t('Change the web address'),
          label: t('Web address'),
          initial: node.url ?? '',
          validate: (value) => (safeWebUrl(value) ? null : t('Only web addresses that start with http or https can be shown.')),
        });
        const safe = safeWebUrl(url ?? '');
        if (safe) commit(updateNode(dataRef.current, nodeId, { url: safe }));
        return;
      }
      const ref = parseRef(node.file);
      if (ref?.kind === 'page' || ref?.kind === 'scene') {
        const byKey = useTitles.getState().byKey;
        const current = ref.kind === 'page' ? useTitles.getState().byId.get(ref.id)?.title : '';
        const name = await promptText({
          title: t('Show another page'),
          label: t('Page title'),
          initial: current ?? '',
          validate: (value) => (byKey.has(titleKey(value)) ? null : t('There is no page with that title.')),
        });
        const page = name ? byKey.get(titleKey(name)) : undefined;
        if (!page) return;
        const heading = await promptText({ title: t('Show one section'), label: t('Heading (leave empty for the whole page)'), initial: '' });
        commit(updateNode(dataRef.current, nodeId, { file: formatRef({ kind: 'page', id: page.id, heading: heading?.trim() || undefined }) }));
      } else if (ref?.kind === 'asset') {
        const paths = await api.files.pickOpen({ title: t('Choose a file'), filters: CARD_FILTERS });
        if (!paths[0]) return;
        const asset = await uploadPath(paths[0], { kinds: CARD_KINDS }).catch((e) => void toast(errorMessage(e), 'error'));
        if (asset) commit(updateNode(dataRef.current, nodeId, { file: formatRef({ kind: 'asset', id: asset.id }) }));
      }
    },
    [commit],
  );

  const open = useCallback((ref: LoreRef) => {
    const nav = useNav.getState();
    if (ref.kind === 'page') nav.go({ view: 'page', id: ref.id });
    else if (ref.kind === 'canvas') nav.go({ view: 'canvas', id: ref.id });
    else if (ref.kind === 'scene') void api.nodes.get(ref.id).then((n) => nav.go({ view: 'write', bookId: n.bookId, nodeId: n.id }));
  }, []);

  /** Starts editing a card in place, or opens what it shows if it cannot be edited here. */
  const editOrOpen = useCallback(
    (node: CanvasNode | undefined) => {
      if (!node) return;
      if (node.type === 'text' || node.type === 'group') return setEditing(node.id);
      if (node.type !== 'file') return;
      const ref = parseRef(node.file);
      if (ref?.kind === 'page' || ref?.kind === 'scene') setEditing(node.id);
      else if (ref) open(ref);
    },
    [open],
  );

  // ---- The view -----------------------------------------------------------------------------

  const zoomTo = useCallback(
    (rects: Rect[]) => {
      const box = boundsOf(rects);
      if (box) setView(fitView(box, size.width, size.height, 48, 2));
    },
    [setView, size],
  );
  const zoomBy = useCallback(
    (factor: number, at: Point = { x: size.width / 2, y: size.height / 2 }) => setView(zoomAt(viewRef.current, at, viewRef.current.zoom * factor)),
    [setView, size],
  );

  useEffect(() => {
    const board = boardRef.current!;
    // Not a React handler: it has to be able to stop the page from scrolling.
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('.canvas-text-editor, .canvas-doc, .canvas-md, .canvas-doc-editor')) {
        if (!e.ctrlKey && !space.current) {
          const scroller = (e.target as HTMLElement).closest<HTMLElement>('.canvas-card-body');
          if (scroller && scroller.scrollHeight > scroller.clientHeight) return;
        }
      }
      e.preventDefault();
      const v = viewRef.current;
      if (e.ctrlKey || e.metaKey || space.current) {
        const box = board.getBoundingClientRect();
        setView(zoomAt(v, { x: e.clientX - box.left, y: e.clientY - box.top }, v.zoom * Math.exp(-e.deltaY * 0.0015)));
      } else if (e.shiftKey) {
        setView({ ...v, x: v.x - (e.deltaX || e.deltaY) });
      } else {
        setView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY });
      }
    };
    board.addEventListener('wheel', onWheel, { passive: false });
    return () => board.removeEventListener('wheel', onWheel);
  }, [setView]);

  // ---- Pointer -------------------------------------------------------------------------------

  const startDrag = (next: Drag, e: ReactPointerEvent) => {
    dragRef.current = next;
    setDrag(next);
    boardRef.current?.setPointerCapture(e.pointerId);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, input, textarea, video, audio, iframe, a, .canvas-toolbar, .canvas-edge-label, .canvas-doc-editor')) return;
    boardRef.current?.focus({ preventScroll: true });
    const p = screenPoint(e);
    const w = toWorld(viewRef.current, p);
    if (e.button === 1 || e.button === 2 || space.current) {
      e.preventDefault();
      startDrag({ kind: 'pan', start: p, view: viewRef.current, moved: false, button: e.button }, e);
      return;
    }
    if (e.button !== 0) return;
    const nodeEl = target.closest<HTMLElement>('[data-node-id]');
    const nodeId = nodeEl?.dataset.nodeId;
    const edgeEl = target.closest<SVGElement>('[data-edge-id]');
    const endEl = target.closest<SVGElement>('[data-edge-end]');
    if (endEl) {
      startDrag({ kind: 'reconnect', edge: endEl.dataset.edgeEnd!, end: endEl.dataset.end as 'from' | 'to', current: w, base: dataRef.current }, e);
      return;
    }
    if (edgeEl && !nodeId) {
      setSelected(new Set());
      setSelectedEdge(edgeEl.dataset.edgeId!);
      return;
    }
    if (!nodeId) {
      if (!e.shiftKey && !e.ctrlKey) select([]);
      setEditing(null);
      startDrag({ kind: 'box', start: w, current: w, additive: e.shiftKey || e.ctrlKey, group: e.altKey }, e);
      return;
    }
    if (editing === nodeId) return;
    if (editing) setEditing(null);
    const handle = target.dataset.handle as Side | undefined;
    if (handle) {
      startDrag({ kind: 'connect', from: nodeId, side: handle, current: w, base: dataRef.current }, e);
      return;
    }
    if (target.dataset.resize) {
      startDrag({ kind: 'resize', id: nodeId, start: w, base: dataRef.current }, e);
      return;
    }
    let ids = selected;
    if (e.shiftKey || e.ctrlKey) {
      ids = new Set(selected);
      if (ids.has(nodeId)) ids.delete(nodeId);
      else ids.add(nodeId);
      select(ids);
      if (!ids.has(nodeId)) return;
    } else if (!selected.has(nodeId)) {
      ids = new Set([nodeId]);
      select(ids);
    }
    let base = dataRef.current;
    if (e.altKey) {
      const copy = duplicate(base, ids, 0, 0);
      history.current.record(base);
      base = copy.data;
      preview(base);
      saver.schedule(base);
      ids = copy.ids;
      select(ids);
    }
    startDrag({ kind: 'move', start: w, ids: withContents(base, ids), base, moved: false }, e);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const p = screenPoint(e);
    const w = toWorld(viewRef.current, p);
    let next: Drag = d;
    if (d.kind === 'pan') {
      const moved = d.moved || Math.abs(p.x - d.start.x) + Math.abs(p.y - d.start.y) > 3;
      setView({ ...d.view, x: d.view.x + p.x - d.start.x, y: d.view.y + p.y - d.start.y });
      next = { ...d, moved };
    } else if (d.kind === 'box') {
      next = { ...d, current: w };
    } else if (d.kind === 'move') {
      let dx = w.x - d.start.x;
      let dy = w.y - d.start.y;
      if (e.shiftKey) ({ dx, dy } = lockAxis(dx, dy));
      const moving = d.base.nodes.filter((n) => d.ids.has(n.id));
      const box = boundsOf(moving);
      let shown: Guide[] = [];
      if (box && !e.altKey && !e.ctrlKey) {
        const near = index.query({ x: box.x + dx - 600, y: box.y + dy - 600, width: box.width + 1200, height: box.height + 1200 }).filter((n) => !d.ids.has(n.id));
        const snap = snapMove(box, dx, dy, near, SNAP_PX / viewRef.current.zoom);
        dx = e.shiftKey && dy === 0 ? snap.dx : e.shiftKey ? 0 : snap.dx;
        dy = e.shiftKey && dx === 0 && snap.dx === 0 ? snap.dy : e.shiftKey ? 0 : snap.dy;
        if (e.shiftKey) {
          const locked = lockAxis(w.x - d.start.x, w.y - d.start.y);
          dx = locked.dx ? snap.dx : 0;
          dy = locked.dy ? snap.dy : 0;
        }
        shown = snap.guides;
      }
      setGuides(shown);
      preview(moveNodes(d.base, d.ids, dx, dy));
      next = { ...d, moved: d.moved || dx !== 0 || dy !== 0 };
    } else if (d.kind === 'resize') {
      const node = nodeById(d.base, d.id);
      if (node) {
        const width = Math.max(80, Math.round(node.width + w.x - d.start.x));
        const height = Math.max(40, Math.round(node.height + w.y - d.start.y));
        // A text card sized by hand keeps its size while the writer types.
        preview(updateNode(d.base, d.id, node.type === 'text' ? { width, height, [FIXED_SIZE]: true } : { width, height }));
      }
    } else if (d.kind === 'connect' || d.kind === 'reconnect') {
      next = { ...d, current: w };
    }
    dragRef.current = next;
    setDrag(next);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    setGuides([]);
    if (!d) return;
    const w = worldPoint(e);
    if (d.kind === 'pan') {
      if (d.button === 2 && !d.moved) showMenu(e.clientX, e.clientY, w);
    } else if (d.kind === 'box') {
      const box = rectFromPoints(d.start, d.current);
      if (box.width < 4 && box.height < 4) return;
      if (d.group) {
        const group: CanvasNode = { id: newId(), type: 'group', label: '', ...box };
        commit({ ...dataRef.current, nodes: [group, ...dataRef.current.nodes] });
        select([group.id]);
        setEditing(group.id);
        return;
      }
      const hits = index.query(box).map((n) => n.id);
      select(d.additive ? [...selected, ...hits] : hits);
    } else if (d.kind === 'move' || d.kind === 'resize') {
      if (dataRef.current !== d.base) commit(dataRef.current, null, d.base);
    } else if (d.kind === 'connect') {
      const target = index.hit(w);
      const from = nodeById(dataRef.current, d.from);
      if (!from) return;
      if (target && target.id !== d.from) {
        commit(addNodes(dataRef.current, [], [{ id: newId(), fromNode: d.from, fromSide: d.side, toNode: target.id, toSide: sideFacing(target, anchor(from, d.side)), toEnd: 'arrow' }]));
      } else if (!target) {
        const card = textNode({ x: w.x - 130, y: w.y - 40 });
        const toSide = sideFacing(card, anchor(from, d.side));
        place([card], [{ id: newId(), fromNode: d.from, fromSide: d.side, toNode: card.id, toSide, toEnd: 'arrow' }], true);
      }
    } else if (d.kind === 'reconnect') {
      const target = index.hit(w);
      const edge = dataRef.current.edges.find((x) => x.id === d.edge);
      if (!target || !edge) return;
      const other = nodeById(dataRef.current, d.end === 'from' ? edge.toNode : edge.fromNode);
      const side = other ? sideFacing(target, { x: other.x + other.width / 2, y: other.y + other.height / 2 }) : undefined;
      commit(updateEdge(dataRef.current, d.edge, d.end === 'from' ? { fromNode: target.id, fromSide: side } : { toNode: target.id, toSide: side }));
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, input, textarea, iframe, video, .canvas-doc-editor')) return;
    const w = worldPoint(e);
    // The board holds the pointer during a press, so a double-click can land on the board
    // itself rather than the card under it.
    const nodeId = target.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId ?? (target === boardRef.current ? index.hit(w)?.id : undefined);
    if (!nodeId) {
      const edgeId = target.closest<SVGElement>('[data-edge-id]')?.dataset.edgeId;
      if (edgeId) return void editEdgeLabel(edgeId);
      addText({ x: w.x - 130, y: w.y - 40 });
      return;
    }
    const node = byId.get(nodeId);
    if (node?.type === 'group' && !target.closest('[data-group-label]')) return;
    editOrOpen(node);
  };

  // ---- Menus ---------------------------------------------------------------------------------

  const colorItems = (): ContextMenuItem[] => [
    ...PRESETS.map((p) => ({ label: t('Color: {name}', { name: presetName(p) }), run: () => setColor(p) })),
    { label: t('Custom color…'), run: () => void customColor() },
    { label: t('Remove color'), run: () => setColor(undefined) },
  ];

  const showMenu = (x: number, y: number, at: Point) => {
    const hit = index.hit(at);
    const edgeHit = selectedEdge;
    let items: ContextMenuItem[];
    if (hit) {
      const ids = selected.has(hit.id) ? selected : new Set([hit.id]);
      if (!selected.has(hit.id)) select(ids);
      items = [
        { label: t('Edit'), shortcut: 'Enter', run: () => (hit.type === 'link' ? void changeSource(hit.id) : editOrOpen(hit)) },
        ...(hit.type === 'file' && parseRef(hit.file) ? [{ label: t('Open'), run: () => open(parseRef(hit.file)!) }] : []),
        { label: t('Fit to content'), run: () => fitToContent(ids) },
        { label: t('Copy'), shortcut: 'Ctrl+C', run: () => void copySelection(false) },
        { label: t('Cut'), shortcut: 'Ctrl+X', run: () => void copySelection(true) },
        ...(hit.type === 'text' ? [{ label: t('Turn into a wiki page…'), run: () => void turnIntoPage(hit.id) }] : []),
        ...(hit.type === 'file' || hit.type === 'link' ? [{ label: t('Change what it shows…'), run: () => void changeSource(hit.id) }] : []),
        { label: t('Group'), shortcut: 'Ctrl+G', run: groupSelected },
        { label: t('Duplicate'), shortcut: 'Ctrl+D', run: duplicateSelected },
        { label: t('Bring to front'), run: () => commit(bringToFront(dataRef.current, ids)) },
        ...(ids.size > 1
          ? [
              { label: t('Align left'), run: () => arrange('left') },
              { label: t('Align right'), run: () => arrange('right') },
              { label: t('Align top'), run: () => arrange('top') },
              { label: t('Align bottom'), run: () => arrange('bottom') },
              { label: t('Align centers across'), run: () => arrange('centerX') },
              { label: t('Align centers down'), run: () => arrange('centerY') },
              { label: t('Spread out across'), run: () => arrange('spreadX') },
              { label: t('Spread out down'), run: () => arrange('spreadY') },
              { label: t('Arrange in a grid'), run: () => arrange('grid') },
            ]
          : []),
        ...colorItems(),
        { label: t('Delete'), shortcut: 'Delete', run: removeSelected },
      ];
    } else if (edgeHit) {
      items = [
        { label: t('Edit label…'), run: () => void editEdgeLabel(edgeHit) },
        { label: t('Copy'), shortcut: 'Ctrl+C', run: () => void copySelection(false) },
        { label: t('Arrow at start'), run: () => toggleArrow(edgeHit, 'from') },
        { label: t('Arrow at end'), run: () => toggleArrow(edgeHit, 'to') },
        ...colorItems(),
        { label: t('Delete'), shortcut: 'Delete', run: removeSelected },
      ];
    } else {
      items = [
        { label: t('Add text card'), run: () => addText(at) },
        { label: t('Add page…'), run: () => void addPage(at) },
        { label: t('Add scene…'), run: () => void addScene(at) },
        { label: t('Add picture, video, sound or PDF…'), run: () => void addMedia(at) },
        { label: t('Add web page…'), run: () => void addLink(at) },
        { label: t('Add canvas…'), run: () => void addCanvasCard(at) },
        { label: t('Add pages from a category…'), run: () => void addFromCategory(at) },
        { label: t('Add group'), run: () => place([{ id: newId(), type: 'group', label: '', x: Math.round(at.x), y: Math.round(at.y), width: 600, height: 400 }]) },
        { label: t('Paste'), shortcut: 'Ctrl+V', run: () => void pasteFromClipboard(at) },
      ];
    }
    openContextMenu(x, y, t('Canvas'), items);
  };

  // ---- Paste and drop --------------------------------------------------------------------

  /** The selection as a JSON Canvas fragment, which other apps can paste as text. */
  const selectionText = useCallback((): string | null => {
    if (!selected.size && !selectedEdge) return null;
    const fragment = copyFragment(dataRef.current, selected, selectedEdge ? [selectedEdge] : []);
    return fragment.nodes.length ? serializeCanvas(fragment) : null;
  }, [selected, selectedEdge]);

  /** How many times the same text has been pasted in a row, to step each paste further on. */
  const lastPaste = useRef<{ text: string; count: number } | null>(null);
  const pasteFragment = useCallback(
    (fragment: CanvasData, text: string, at: Point) => {
      const count = lastPaste.current?.text === text ? lastPaste.current.count + 1 : 1;
      lastPaste.current = { text, count };
      const box = boundsOf(fragment.nodes)!;
      const v = viewRef.current;
      const onScreen = intersects(box, { x: -v.x / v.zoom, y: -v.y / v.zoom, width: size.width / v.zoom, height: size.height / v.zoom });
      // Near the copied cards while they are in view; otherwise where the writer is looking.
      const dx = onScreen ? PASTE_STEP * count : Math.round(at.x - box.x - box.width / 2);
      const dy = onScreen ? PASTE_STEP * count : Math.round(at.y - box.y - box.height / 2);
      const copy = cloneFragment(fragment, dx, dy);
      place(copy.nodes, copy.edges);
    },
    [place, size],
  );

  const pasteText = useCallback(
    (text: string, at: Point) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const fragment = readFragment(trimmed);
      if (fragment) return pasteFragment(fragment, trimmed, at);
      const url = safeWebUrl(trimmed);
      if (url && !/\s/.test(trimmed)) place([linkNode(at, url)]);
      else place([textNode(at, trimmed)]);
    },
    [place, pasteFragment],
  );

  const copySelection = async (cut: boolean) => {
    const text = selectionText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      if (cut) removeSelected();
    } catch {
      toast(cut ? t('Press Ctrl+X to cut.') : t('Press Ctrl+C to copy.'));
    }
  };

  const pasteFromClipboard = async (at: Point) => {
    try {
      pasteText(await navigator.clipboard.readText(), at);
    } catch {
      toast(t('Press Ctrl+V to paste.'));
    }
  };

  const addFiles = useCallback(
    async (files: File[], at: Point) => {
      const nodes: CanvasNode[] = [];
      for (const [i, file] of files.entries()) {
        try {
          const asset = await uploadAsset(file, { kinds: CARD_KINDS });
          nodes.push(sizedAsset(fileNode({ x: at.x + i * 30, y: at.y + i * 30 }, { kind: 'asset', id: asset.id }), asset));
        } catch (e) {
          toast(errorMessage(e), 'error');
        }
      }
      if (nodes.length) place(nodes);
    },
    [place],
  );

  useEffect(() => {
    const board = boardRef.current!;
    const onPaste = (e: ClipboardEvent) => {
      if ((e.target as HTMLElement).closest(OWN_INPUT)) return;
      const data = e.clipboardData;
      if (!data) return;
      e.preventDefault();
      const at = center();
      const files = [...data.files];
      if (files.length) void addFiles(files, at);
      else pasteText(data.getData('text/plain'), at);
    };
    board.addEventListener('paste', onPaste);
    return () => board.removeEventListener('paste', onPaste);
  }, [addFiles, center, pasteText]);

  // With nothing selected as text, copy and cut go to the document, so listen there and act
  // only while the board has the keyboard.
  useEffect(() => {
    const onCopy = (e: ClipboardEvent) => {
      const board = boardRef.current;
      const active = document.activeElement as HTMLElement | null;
      if (!board || !active || !board.contains(active) || active.closest(OWN_INPUT)) return;
      if (window.getSelection()?.toString()) return;
      const text = selectionText();
      if (!text || !e.clipboardData) return;
      e.preventDefault();
      e.clipboardData.setData('text/plain', text);
      if (e.type === 'cut') removeSelected();
    };
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCopy);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCopy);
    };
  }, [removeSelected, selectionText]);

  // The binder moves its rows with its own pointer drag and hands over a scene let go here.
  useEffect(() => {
    const board = boardRef.current!;
    const onRefDrop = (e: Event) => {
      const { ref, clientX, clientY } = (e as CustomEvent<RefDropDetail>).detail;
      place([fileNode(worldPoint({ clientX, clientY }), ref)]);
    };
    board.addEventListener(REF_DROP_EVENT, onRefDrop);
    return () => board.removeEventListener(REF_DROP_EVENT, onRefDrop);
  }, [place, worldPoint]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const at = worldPoint(e);
    const ref = parseRef(e.dataTransfer.getData(REF_MIME));
    if (ref) return place([fileNode(at, ref)]);
    const files = [...e.dataTransfer.files];
    if (files.length) return void addFiles(files, at);
    const kind = e.dataTransfer.getData('application/x-canvas-tool');
    if (kind) return void addByTool(kind, at);
    const text = e.dataTransfer.getData('text/uri-list').split('\n')[0] || e.dataTransfer.getData('text/plain');
    if (text) pasteText(text, at);
  };

  const addByTool = (kind: string, at?: Point) => {
    if (kind === 'text') addText(at);
    else if (kind === 'page') void addPage(at);
    else if (kind === 'scene') void addScene(at);
    else if (kind === 'media') void addMedia(at);
    else if (kind === 'link') void addLink(at);
    else if (kind === 'canvas') void addCanvasCard(at);
    else if (kind === 'group') {
      if (selected.size) groupSelected();
      else {
        const p = at ?? center();
        place([{ id: newId(), type: 'group', label: '', x: Math.round(p.x), y: Math.round(p.y), width: 600, height: 400 }]);
      }
    }
  };

  // ---- Keyboard ------------------------------------------------------------------------------

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest(OWN_INPUT)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (e.key === ' ') {
      space.current = true;
      e.preventDefault();
      return;
    }
    if (ctrl && key === 'z' && !e.shiftKey) return void (e.preventDefault(), undo());
    if (ctrl && (key === 'y' || (key === 'z' && e.shiftKey))) return void (e.preventDefault(), redo());
    if (ctrl && key === 'a') return void (e.preventDefault(), select(dataRef.current.nodes.map((n) => n.id)));
    if (ctrl && key === 'd') return void (e.preventDefault(), duplicateSelected());
    if (ctrl && key === 'g') return void (e.preventDefault(), groupSelected());
    if (e.key === 'Delete' || e.key === 'Backspace') return void (e.preventDefault(), removeSelected());
    if (e.key === 'Escape') return void (select([]), setEditing(null));
    if (e.shiftKey && e.key === '!') return void zoomTo(dataRef.current.nodes);
    if (e.shiftKey && e.key === '@') return void zoomTo(dataRef.current.nodes.filter((n) => selected.has(n.id)));
    if (e.shiftKey && (e.code === 'Digit1' || e.code === 'Digit2')) {
      e.preventDefault();
      zoomTo(e.code === 'Digit1' ? dataRef.current.nodes : dataRef.current.nodes.filter((n) => selected.has(n.id)));
      return;
    }
    if (ctrl && (e.key === '=' || e.key === '+')) return void (e.preventDefault(), zoomBy(1.25));
    if (ctrl && e.key === '-') return void (e.preventDefault(), zoomBy(0.8));
    if (ctrl && e.key === '0') return void (e.preventDefault(), setView({ ...viewRef.current, zoom: 1 }));
    if (e.key === 'Enter' && selected.size === 1) {
      e.preventDefault();
      editOrOpen(byId.get([...selected][0]));
      return;
    }
    const arrows: Record<string, Point> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };
    const arrow = arrows[e.key];
    if (arrow && selected.size) {
      e.preventDefault();
      const step = e.shiftKey ? 100 : 20;
      commit(moveNodes(dataRef.current, withContents(dataRef.current, selected), arrow.x * step, arrow.y * step), 'arrows');
    } else if (arrow && !selected.size) {
      e.preventDefault();
      setView({ ...viewRef.current, x: viewRef.current.x - arrow.x * 60, y: viewRef.current.y - arrow.y * 60 });
    }
  };
  const onKeyUp = (e: React.KeyboardEvent) => {
    if (e.key === ' ') space.current = false;
  };

  // Focus moving between cards selects them, so Tab and arrows work without a mouse.
  const onFocus = (e: React.FocusEvent) => {
    const id = (e.target as HTMLElement).dataset?.nodeId;
    if (id && !selected.has(id)) select([id]);
  };

  // ---- Drawing -------------------------------------------------------------------------------

  const visibleRect: Rect = {
    x: -view.x / view.zoom - DRAW_MARGIN,
    y: -view.y / view.zoom - DRAW_MARGIN,
    width: size.width / view.zoom + DRAW_MARGIN * 2,
    height: size.height / view.zoom + DRAW_MARGIN * 2,
  };
  const shownIds = new Set(index.query(visibleRect).map((n) => n.id));
  // Selected and edited cards stay drawn, so focus is never lost to scrolling.
  for (const id of selected) shownIds.add(id);
  if (editing) shownIds.add(editing);
  const shown = drawingOrder(data.nodes.filter((n) => shownIds.has(n.id)));

  const onEditText = useCallback(
    (nodeId: string, text: string, grow: number) => {
      const node = nodeById(dataRef.current, nodeId);
      // Text cards grow while the writer types, until they are sized by hand.
      const height = node && grow > 0 && !node[FIXED_SIZE] ? Math.min(MAX_GROW_HEIGHT, node.height + grow) : 0;
      commit(updateNode(dataRef.current, nodeId, node && height > node.height ? { text, height } : { text }), `text:${nodeId}`);
    },
    [commit],
  );
  const onLabel = useCallback((nodeId: string, label: string) => commit(updateNode(dataRef.current, nodeId, { label }), `label:${nodeId}`), [commit]);
  const stopEditing = useCallback(() => setEditing(null), []);
  const callbacks = useRef(new Map<string, { text: (s: string, grow: number) => void; label: (s: string) => void }>());
  const callbacksFor = (nodeId: string) => {
    let entry = callbacks.current.get(nodeId);
    if (!entry) {
      entry = { text: (s, grow) => onEditText(nodeId, s, grow), label: (s) => onLabel(nodeId, s) };
      callbacks.current.set(nodeId, entry);
    }
    return entry;
  };

  const edgeEls = data.edges.map((edge) => {
    const from = byId.get(edge.fromNode);
    const to = byId.get(edge.toNode);
    if (!from || !to) return null;
    if (!intersects(visibleRect, boundsOf([from, to])!)) return null;
    const sides = chooseSides(from, to);
    const fromSide = edge.fromSide ?? sides.from;
    const toSide = edge.toSide ?? sides.to;
    let a = anchor(from, fromSide);
    let b = anchor(to, toSide);
    if (drag?.kind === 'reconnect' && drag.edge === edge.id) {
      if (drag.end === 'from') a = drag.current;
      else b = drag.current;
    }
    const ends = edgeEnds(edge);
    const color = colorVar(edge.color);
    const mid = edgeMidpoint(a, fromSide, b, toSide);
    const isSelected = selectedEdge === edge.id;
    return (
      <g key={edge.id} className={`canvas-edge${isSelected ? ' is-selected' : ''}`} style={color ? ({ '--edge-color': color } as React.CSSProperties) : undefined}>
        <path className="canvas-edge-hit" d={edgePath(a, fromSide, b, toSide)} data-edge-id={edge.id} />
        <path
          className="canvas-edge-line"
          d={edgePath(a, fromSide, b, toSide)}
          markerStart={ends.from === 'arrow' ? 'url(#canvas-arrow-start)' : undefined}
          markerEnd={ends.to === 'arrow' ? 'url(#canvas-arrow)' : undefined}
        />
        {edge.label && (
          <text className="canvas-edge-text" x={mid.x} y={mid.y} textAnchor="middle" dominantBaseline="middle" data-edge-id={edge.id}>
            {edge.label}
          </text>
        )}
        {isSelected && (
          <>
            <circle className="canvas-edge-end" cx={a.x} cy={a.y} r={7} data-edge-end={edge.id} data-end="from" />
            <circle className="canvas-edge-end" cx={b.x} cy={b.y} r={7} data-edge-end={edge.id} data-end="to" />
          </>
        )}
      </g>
    );
  });

  let draft: React.ReactNode = null;
  if (drag?.kind === 'connect') {
    const from = byId.get(drag.from);
    if (from) {
      const a = anchor(from, drag.side);
      draft = <path className="canvas-edge-line is-draft" d={edgePath(a, drag.side, drag.current, null)} markerEnd="url(#canvas-arrow)" />;
    }
  }
  const box = drag?.kind === 'box' ? rectFromPoints(drag.start, drag.current) : null;
  const gridSize = 20 * view.zoom;

  const exportPng = async (whole: boolean) => {
    try {
      const saved = await exportCanvasPng(boardRef.current!, dataRef.current, whole ? null : { view: viewRef.current, ...size }, title);
      if (saved) toast(t('Saved the picture.'), 'success');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const exportFile = async () => {
    const path = await api.files.pickSave({ title: t('Export canvas'), defaultName: `${title}.canvas`, filters: [{ name: t('Canvas'), extensions: ['canvas'] }] });
    if (path) await api.files.writeText(path, serializeCanvas(dataRef.current)).catch((e) => toast(errorMessage(e), 'error'));
  };

  const rename = async () => {
    const name = await promptText({ title: t('Rename canvas'), label: t('Name'), initial: title });
    if (!name?.trim()) return;
    await canvases.rename(canvas.id, name.trim());
    setTitle(name.trim());
  };

  const selectedNodes = data.nodes.filter((n) => selected.has(n.id));
  void titles;

  return (
    <div className="canvas-view">
      <div className="canvas-toolbar" role="toolbar" aria-label={t('Canvas tools')}>
        <h1 className="canvas-title" title={t('Rename canvas')} onDoubleClick={() => void rename()}>
          {title}
        </h1>
        {(
          [
            ['text', t('Text')],
            ['page', t('Page')],
            ['scene', t('Scene')],
            ['media', t('Media file')],
            ['link', t('Web page')],
            ['canvas', t('Canvas')],
            ['group', t('Group')],
          ] as const
        ).map(([kind, label]) => (
          <button
            key={kind}
            type="button"
            className="btn btn-sm"
            draggable
            data-tool={kind}
            onDragStart={(e) => e.dataTransfer.setData('application/x-canvas-tool', kind)}
            onClick={() => addByTool(kind)}
            title={t('Click to add, or drag onto the board')}
          >
            {label}
          </button>
        ))}
        <span className="canvas-toolbar-gap" />
        <button type="button" className="btn btn-sm" onClick={undo} disabled={!history.current.canUndo} aria-label={t('Undo')} title={t('Undo') + ' (Ctrl+Z)'}>
          ↶
        </button>
        <button type="button" className="btn btn-sm" onClick={redo} disabled={!history.current.canRedo} aria-label={t('Redo')} title={t('Redo') + ' (Ctrl+Y)'}>
          ↷
        </button>
        <button type="button" className="btn btn-sm" onClick={() => zoomBy(0.8)} aria-label={t('Zoom out')}>
          −
        </button>
        <span className="canvas-zoom" aria-live="polite">
          {Math.round(view.zoom * 100)}%
        </span>
        <button type="button" className="btn btn-sm" onClick={() => zoomBy(1.25)} aria-label={t('Zoom in')}>
          +
        </button>
        <button type="button" className="btn btn-sm" onClick={() => zoomTo(dataRef.current.nodes)} title="Shift+1">
          {t('Fit all')}
        </button>
        <button type="button" className="btn btn-sm" disabled={!selectedNodes.length} onClick={() => zoomTo(selectedNodes)} title="Shift+2">
          {t('Fit selection')}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={(e) =>
            openContextMenu(e.clientX, e.clientY, t('More'), [
              { label: t('Rename canvas…'), run: () => void rename() },
              { label: t('Fit selection to content'), run: () => fitToContent(selected) },
              { label: t('Export visible area as PNG…'), run: () => void exportPng(false) },
              { label: t('Export whole canvas as PNG…'), run: () => void exportPng(true) },
              { label: t('Export as .canvas file…'), run: () => void exportFile() },
            ])
          }
        >
          {t('More')}
        </button>
      </div>
      <div
        ref={boardRef}
        className={`canvas-board${drag?.kind === 'pan' ? ' is-panning' : ''}`}
        tabIndex={0}
        role="application"
        aria-label={t('Canvas board. Arrow keys move the selection, Enter edits, Ctrl+A selects all.')}
        aria-roledescription={t('canvas')}
        data-canvas-id={canvas.id}
        style={{ backgroundSize: `${gridSize}px ${gridSize}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onFocus={onFocus}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
      >
        <div className="canvas-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
          <svg className="canvas-edges" aria-hidden="true">
            <defs>
              <marker id="canvas-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" className="canvas-arrowhead" />
              </marker>
              <marker id="canvas-arrow-start" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" className="canvas-arrowhead" />
              </marker>
            </defs>
            {edgeEls}
            {draft}
            {guides.map((g, i) =>
              g.axis === 'x' ? (
                <line key={i} className="canvas-guide" x1={g.at} x2={g.at} y1={g.from - 20} y2={g.to + 20} />
              ) : (
                <line key={i} className="canvas-guide" y1={g.at} y2={g.at} x1={g.from - 20} x2={g.to + 20} />
              ),
            )}
          </svg>
          {shown.map((node) => (
            <NodeView
              key={node.id}
              node={node}
              selected={selected.has(node.id)}
              editing={editing === node.id}
              onEditText={callbacksFor(node.id).text}
              onLabel={callbacksFor(node.id).label}
              onStopEditing={stopEditing}
              onOpen={open}
            />
          ))}
          {box && <div className="canvas-box" style={{ transform: `translate(${box.x}px, ${box.y}px)`, width: box.width, height: box.height }} />}
        </div>
        {data.nodes.length === 0 && <div className="canvas-empty">{t('Double-click to add a card, or drag one from the toolbar.')}</div>}
      </div>
    </div>
  );
}

function sizedAsset(node: CanvasNode, asset: { width: number | null; height: number | null }): CanvasNode {
  if (!asset.width || !asset.height) return node;
  const width = Math.min(480, asset.width);
  return { ...node, width, height: Math.round((width * asset.height) / asset.width) };
}
