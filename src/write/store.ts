/**
 * State for the Write area. The sidebar and the main view are separate parts of the
 * shell, and either can unmount (focus mode hides the sidebar), so what they share lives
 * here. Screen changes come first and the native side confirms: an edit shows at once,
 * and the next reload of the tree reconciles.
 */

import { create } from 'zustand';

import * as api from './api';
import {
  EMPTY_INDEX,
  ancestorsOf,
  applyMove,
  displayTitle,
  indexTree,
  isInside,
  neighborScene,
  nextTitle,
  planNewChapter,
  planNewScene,
  scenesUnder,
  type TreeIndex,
} from './tree';
import type { SplitParts } from './splitDoc';
import { MERGED_TEXT_CHANGED, sceneUndo } from './history/api';
import { openSceneHistory } from './history/SceneHistory';
import { flushAllEditors } from '../editor/saving';
import { t } from '../lib/i18n';
import { errorMessage, RpcError } from '../lib/rpc';
import type { Book, NodeKind, NodeMeta, PmNode, WritingStats } from '../lib/types';
import { confirm, promptText } from '../shell/dialogs';
import { toast } from '../shell/toasts';
import { docPlace, rememberCursorAt, rememberScrollAt, setDocPlace, type DocPlace } from '../state/docs';
import { useNav, type WriteMode } from '../state/nav';
import { useProject } from '../state/project';
import type { PaneId } from '../state/tabs';

export interface UndoEntry {
  /** `node` and `book` come back from the trash. `split` joins `original` and `id` again. */
  kind: 'node' | 'book' | 'split';
  id: string;
  label: string;
  original?: string;
}

const DETAILS_KEY = 'lorebook.write.detailsOpen';

function storedDetailsOpen(): boolean {
  try {
    const value = localStorage.getItem(DETAILS_KEY);
    if (value !== null) return value === '1';
  } catch {
    // Storage can be unavailable. The default is fine.
  }
  return typeof window === 'undefined' || window.innerWidth >= 1280;
}

interface WriteState {
  books: Book[];
  bookId: string | null;
  /** True once `books` and the tree describe the open project. */
  ready: boolean;
  /** The rows as the native side last sent them. */
  base: NodeMeta[];
  /** `base` with edits in progress applied, for everything on screen. */
  index: TreeIndex;
  collapsed: ReadonlySet<string>;
  stats: WritingStats | null;
  undo: UndoEntry | null;
  detailsOpen: boolean;
}

export const useWrite = create<WriteState>(() => ({
  books: [],
  bookId: null,
  ready: false,
  base: [],
  index: EMPTY_INDEX,
  collapsed: new Set<string>(),
  stats: null,
  undo: null,
  detailsOpen: storedDetailsOpen(),
}));

// Beside a second pane, a scene needs the room for its text. The details stay one click away,
// and the writer's own choice comes back with the single pane.
let wasSplit = false;
useNav.subscribe((nav) => {
  const split = nav.panes.length > 1;
  if (split === wasSplit) return;
  wasSplit = split;
  useWrite.setState({ detailsOpen: split ? false : storedDetailsOpen() });
});

interface LiveCounts {
  sceneId: string | null;
  words: number;
  selected: number;
}

/** Counts for the scene being edited. Separate so that a change re-renders very little. */
export const useLive = create<LiveCounts>(() => ({ sceneId: null, words: 0, selected: 0 }));

// ---------------------------------------------------------------------------
// Edits in progress
// ---------------------------------------------------------------------------

/** Fields changed on screen and not yet confirmed. A tree reload must not undo them. */
const overlays = new Map<string, Partial<NodeMeta>>();
/** Word counts of scenes being edited, which are newer than anything stored. */
const liveWords = new Map<string, number>();
/** The `updatedAt` of this window's own last write, to notice changes made elsewhere. */
const knownUpdates = new Map<string, string>();
const writesInFlight = new Map<string, number>();
const dirtyScenes = new Set<string>();
/** Writes that must finish before a scene is read again. */
const flushes = new Map<string, Promise<unknown>>();

function withOverlays(base: NodeMeta[]): TreeIndex {
  if (overlays.size === 0 && liveWords.size === 0) return indexTree(base);
  return indexTree(
    base.map((node) => {
      const overlay = overlays.get(node.id);
      const words = liveWords.get(node.id);
      if (!overlay && words === undefined) return node;
      return { ...node, ...overlay, ...(words === undefined ? null : { wordCount: words }) };
    }),
  );
}

function reindex() {
  useWrite.setState((s) => ({ index: withOverlays(s.base) }));
}

function overlayFields(patch: api.NodePatch): Partial<NodeMeta> {
  const fields: Partial<NodeMeta> = {};
  if (patch.title !== undefined) fields.title = patch.title;
  if (patch.status !== undefined) fields.status = patch.status;
  if (patch.synopsis !== undefined) fields.synopsis = patch.synopsis;
  if (patch.targetWords !== undefined) fields.targetWords = patch.targetWords;
  if (patch.storyDate !== undefined) fields.storyDate = patch.storyDate;
  if (patch.povPageId !== undefined) fields.povPageId = patch.povPageId || null;
  if (patch.locationPageId !== undefined) fields.locationPageId = patch.locationPageId || null;
  return fields;
}

/** Shows a change on screen right away. `writeNode` makes it stick. */
export function showPatch(id: string, patch: api.NodePatch) {
  const fields = overlayFields(patch);
  if (Object.keys(fields).length === 0) return;
  overlays.set(id, { ...overlays.get(id), ...fields });
  reindex();
}

function settleOverlay(id: string, sent: Partial<NodeMeta>) {
  const overlay = overlays.get(id);
  if (!overlay) return;
  const remaining = { ...overlay } as Record<string, unknown>;
  const sentFields = sent as Record<string, unknown>;
  // Anything typed since this write went out stays on screen.
  for (const key of Object.keys(sentFields)) {
    if (remaining[key] === sentFields[key]) delete remaining[key];
  }
  if (Object.keys(remaining).length === 0) overlays.delete(id);
  else overlays.set(id, remaining as Partial<NodeMeta>);
}

/** Goes up with each local change, so a reload can tell if it read something older. */
let changeCount = 0;

function noteChange() {
  changeCount += 1;
}

/**
 * Writes to a node. Every write in this module goes through here. A caller that will try
 * again passes `keepOnFailure`. Otherwise the screen should not keep showing something
 * that was not stored.
 */
export async function writeNode(
  id: string,
  patch: api.NodePatch,
  options: { keepOnFailure?: boolean } = {},
): Promise<NodeMeta> {
  writesInFlight.set(id, (writesInFlight.get(id) ?? 0) + 1);
  noteChange();
  try {
    const meta = await api.nodes.update(id, patch);
    noteChange();
    knownUpdates.set(id, meta.updatedAt);
    settleOverlay(id, overlayFields(patch));
    useWrite.setState((s) => {
      const base = s.base.map((n) => (n.id === id ? meta : n));
      return { base, index: withOverlays(base) };
    });
    return meta;
  } catch (e) {
    noteChange();
    if (!options.keepOnFailure) {
      settleOverlay(id, overlayFields(patch));
      reindex();
    }
    throw e;
  } finally {
    writesInFlight.set(id, (writesInFlight.get(id) ?? 1) - 1);
  }
}

export function markSceneDirty(id: string) {
  dirtyScenes.add(id);
}

/** Saves on their way, whose announcements are not news to this window. */
let ownContentWrites = 0;
let seenContentVersion: number | null = null;

export async function saveSceneContent(id: string, content: PmNode): Promise<void> {
  dirtyScenes.delete(id);
  ownContentWrites += 1;
  try {
    await writeNode(id, { content });
  } catch (e) {
    // Nothing was announced. What is on screen is still newer than what is stored.
    ownContentWrites = Math.max(0, ownContentWrites - 1);
    dirtyScenes.add(id);
    throw e;
  }
  refreshStatsSoon();
}

/**
 * Called when the stored text of any scene changes. This window's own saves already
 * returned what they changed, so the reload can wait for a quiet moment. A change from
 * anywhere else shows right away.
 */
export function contentChanged(version: number) {
  if (seenContentVersion === null) {
    seenContentVersion = version;
    return;
  }
  const announcements = version - seenContentVersion;
  if (announcements <= 0) return;
  seenContentVersion = version;
  const own = Math.min(announcements, ownContentWrites);
  ownContentWrites -= own;
  requestSync(announcements > own ? 100 : 1500);
}

export function sceneHasUnsavedWork(id: string): boolean {
  return dirtyScenes.has(id) || (writesInFlight.get(id) ?? 0) > 0;
}

/** The editor has closed, so whatever was going to be saved has now had its last try. */
export function forgetSceneWork(id: string) {
  dirtyScenes.delete(id);
}

export function rememberKnownUpdate(id: string, updatedAt: string) {
  knownUpdates.set(id, updatedAt);
}

export function knownUpdate(id: string): string | undefined {
  return knownUpdates.get(id);
}

/** Records that a view closed with this write still running. */
export function trackFlush(id: string, flush: Promise<unknown>) {
  const all = Promise.allSettled([flushes.get(id), flush]);
  flushes.set(id, all);
  void all.then(() => {
    if (flushes.get(id) === all) flushes.delete(id);
  });
}

/** Reads a scene, after any write to it still on its way, so a quick return sees it. */
export async function loadScene(id: string) {
  await flushes.get(id);
  return api.nodes.get(id);
}

export function setLiveCounts(sceneId: string, words: number, selected: number) {
  const live = useLive.getState();
  if (live.sceneId !== sceneId || live.words !== words) {
    if (liveWords.get(sceneId) !== words) {
      liveWords.set(sceneId, words);
      reindex();
    }
  }
  if (live.sceneId !== sceneId || live.words !== words || live.selected !== selected) {
    useLive.setState({ sceneId, words, selected });
  }
}

export function clearLiveCounts(sceneId: string) {
  liveWords.delete(sceneId);
  if (useLive.getState().sceneId === sceneId) useLive.setState({ sceneId: null, words: 0, selected: 0 });
}

// ---------------------------------------------------------------------------
// Session memory
// ---------------------------------------------------------------------------

export type ScenePlace = DocPlace;

const lastScenes = new Map<string, string>();

export function scenePlace(id: string): ScenePlace | undefined {
  return docPlace(`node:${id}`);
}

export function rememberCursor(id: string, anchor: number, head: number) {
  rememberCursorAt(`node:${id}`, anchor, head);
}

export function rememberScroll(id: string, scrollTop: number) {
  rememberScrollAt(`node:${id}`, scrollTop);
}

/** Opens a scene at this point, scrolled to wherever that is. */
export function openSceneAt(id: string, pos: number) {
  setDocPlace(`node:${id}`, { anchor: pos, head: pos, scrollTop: -1 });
  openScene(id);
}

export function rememberScene(bookId: string, sceneId: string) {
  lastScenes.set(bookId, sceneId);
}

export function lastScene(bookId: string): string | undefined {
  return lastScenes.get(bookId);
}

/** Forgets everything tied to one project. */
export function resetForNewProject() {
  // A read still on its way belongs to the old project.
  noteChange();
  ownContentWrites = 0;
  overlays.clear();
  liveWords.clear();
  knownUpdates.clear();
  writesInFlight.clear();
  dirtyScenes.clear();
  lastScenes.clear();
  useWrite.setState({
    books: [],
    bookId: null,
    ready: false,
    base: [],
    index: EMPTY_INDEX,
    collapsed: new Set(),
    stats: null,
    undo: null,
  });
  useLive.setState({ sceneId: null, words: 0, selected: 0 });
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

let syncTimer: number | undefined;
let syncDue = Number.POSITIVE_INFINITY;
let syncRun: Promise<void> | null = null;
let syncAgain = false;

function reportUnlessClosed(e: unknown) {
  // A project closing while a read is on its way is not a problem worth showing.
  if (e instanceof RpcError && e.code === 'NO_PROJECT') return;
  toast(errorMessage(e), 'error');
}

/** How many times a reload is retried because something kept changing as it read. */
const MAX_SYNC_PASSES = 5;

async function runSync(): Promise<void> {
  let passes = 0;
  do {
    syncAgain = false;
    passes += 1;
    if (!useProject.getState().status.open) return;
    const startedAt = changeCount;
    const current = useWrite.getState().bookId;
    const books = await api.books.list();
    const bookId = current && books.some((b) => b.id === current) ? current : (books[0]?.id ?? null);
    const base = bookId ? await api.nodes.tree(bookId) : [];
    // What was read may be older than something already on screen, or be for the wrong
    // book by now. Showing it would make a move jump back for a moment, so read again.
    const otherBook = useWrite.getState().bookId !== current;
    const stale = syncAgain || startedAt !== changeCount;
    if (otherBook || (stale && passes < MAX_SYNC_PASSES)) {
      syncAgain = true;
    } else {
      const changedBook = bookId !== current || useWrite.getState().stats === null;
      syncAgain = false;
      useWrite.setState({ books, bookId, base, index: withOverlays(base), ready: true });
      if (changedBook) void refreshStats();
      else refreshStatsSoon();
    }
  } while (syncAgain);
}

/**
 * Reloads the books and the current tree. Only one reload runs at a time, and whoever
 * asks while one is running waits for a pass that started after they asked, so they can
 * count on seeing what they just wrote.
 */
export function syncNow(): Promise<void> {
  window.clearTimeout(syncTimer);
  syncDue = Number.POSITIVE_INFINITY;
  if (syncRun) {
    syncAgain = true;
    return syncRun;
  }
  syncRun = runSync()
    .catch(reportUnlessClosed)
    .finally(() => {
      syncRun = null;
    });
  return syncRun;
}

/** Asks for a reload. Requests close together become one, at the earliest time asked for. */
export function requestSync(delayMs = 0) {
  const due = performance.now() + delayMs;
  if (due >= syncDue) return;
  syncDue = due;
  window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => void syncNow(), delayMs);
}

export function selectBook(bookId: string) {
  if (useWrite.getState().bookId === bookId) return;
  useWrite.setState({ bookId, ready: false, base: [], index: EMPTY_INDEX, stats: null, undo: null });
  void syncNow();
}

export async function refreshStats() {
  const bookId = useWrite.getState().bookId;
  if (!bookId) return;
  try {
    const stats = await api.nodes.stats(bookId);
    if (useWrite.getState().bookId === bookId) useWrite.setState({ stats });
  } catch (e) {
    reportUnlessClosed(e);
  }
}

let statsTimer: number | undefined;

function refreshStatsSoon() {
  window.clearTimeout(statsTimer);
  statsTimer = window.setTimeout(() => void refreshStats(), 600);
}

// ---------------------------------------------------------------------------
// Going places
// ---------------------------------------------------------------------------

export function routeState(): { nodeId: string | null; mode: WriteMode } {
  const { route } = useNav.getState();
  if (route.view === 'write') return { nodeId: route.nodeId ?? null, mode: route.mode ?? 'scene' };
  return { nodeId: null, mode: 'scene' };
}

/** The node actions apply to: the one on screen, or the last scene written in. */
export function currentNodeId(): string | null {
  const { nodeId } = routeState();
  if (nodeId) return nodeId;
  const { bookId } = useWrite.getState();
  return bookId ? (lastScenes.get(bookId) ?? null) : null;
}

let leaveFocusAlone = false;

/** True once for a scene opened as a side effect, where focus should stay where it is. */
export function takeLeaveFocusAlone(): boolean {
  const value = leaveFocusAlone;
  leaveFocusAlone = false;
  return value;
}

const editorFocusers = new Map<PaneId | null, () => void>();

/**
 * An open scene editor registers here, so the rest of the area can hand focus back. There can
 * be one in each pane, and the focused pane's is the one that gets it.
 */
export function registerEditorFocuser(paneId: PaneId | null, focuser: (() => void) | null) {
  if (focuser) editorFocusers.set(paneId, focuser);
  else editorFocusers.delete(paneId);
}

export function focusOpenEditor() {
  (editorFocusers.get(useNav.getState().focusedPaneId) ?? editorFocusers.get(null))?.();
}

export function openScene(id: string, options: { keepFocus?: boolean } = {}) {
  const here = routeState();
  // Asking for the scene already open means: back to writing.
  if (here.nodeId === id && here.mode === 'scene' && useNav.getState().route.view === 'write') {
    if (!options.keepFocus) focusOpenEditor();
    return;
  }
  leaveFocusAlone = options.keepFocus ?? false;
  const { bookId } = useWrite.getState();
  useNav.getState().go({ view: 'write', bookId: bookId ?? undefined, nodeId: id });
}

export function goToMode(mode: WriteMode, nodeId?: string | null) {
  const { bookId } = useWrite.getState();
  useNav.getState().go({
    view: 'write',
    bookId: bookId ?? undefined,
    nodeId: nodeId ?? undefined,
    mode: mode === 'scene' ? undefined : mode,
  });
}

/** What a click in the binder does: scenes open in the editor, the rest as an overview. */
export function openNode(id: string) {
  const node = useWrite.getState().index.byId.get(id);
  if (!node) return;
  if (node.kind === 'scene') {
    openScene(id);
    return;
  }
  const { mode } = routeState();
  if (node.kind === 'part') goToMode('cork', id);
  else goToMode(mode === 'cork' ? 'cork' : 'read', id);
}

export function stepScene(direction: 1 | -1) {
  const { index } = useWrite.getState();
  const current = currentNodeId();
  const scenes = index.scenes;
  if (scenes.length === 0) return;
  const node = current ? index.byId.get(current) : undefined;
  if (node?.kind === 'scene') {
    const at = scenes.findIndex((s) => s.id === node.id);
    const next = scenes[at + direction];
    if (next) openScene(next.id);
    return;
  }
  // From an overview, go to the first or last scene under it.
  const under = node ? scenesUnder(index, node.id) : scenes;
  const target = direction === 1 ? under[0] : under[under.length - 1];
  if (target) openScene(target.id);
}

// ---------------------------------------------------------------------------
// Binder actions
// ---------------------------------------------------------------------------

export function toggleCollapsed(id: string, open?: boolean) {
  useWrite.setState((s) => {
    const collapsed = new Set(s.collapsed);
    const shouldOpen = open ?? collapsed.has(id);
    if (shouldOpen) collapsed.delete(id);
    else collapsed.add(id);
    return { collapsed };
  });
}

/** Opens every branch above a node, so its row can be seen. */
export function expandTo(id: string) {
  const { index, collapsed } = useWrite.getState();
  const closed = ancestorsOf(index, id).filter((a) => collapsed.has(a.id));
  if (closed.length === 0) return;
  const next = new Set(collapsed);
  for (const node of closed) next.delete(node.id);
  useWrite.setState({ collapsed: next });
}

export function setDetailsOpen(detailsOpen: boolean) {
  useWrite.setState({ detailsOpen });
  try {
    localStorage.setItem(DETAILS_KEY, detailsOpen ? '1' : '0');
  } catch {
    // It still applies for this session.
  }
}

async function createNode(kind: NodeKind, parentId: string | null, afterId?: string): Promise<NodeMeta> {
  const { bookId, index } = useWrite.getState();
  if (!bookId) throw new Error(t('Add a book first.'));
  return api.nodes.create({ bookId, parentId, kind, title: nextTitle(index, kind, parentId), afterId });
}

async function readyToEdit(): Promise<boolean> {
  if (!useWrite.getState().ready) await syncNow();
  if (useWrite.getState().bookId) return true;
  toast(t('Add a book first.'));
  return false;
}

function reportFailure(what: string, e: unknown) {
  toast(t('{what}: {reason}', { what, reason: errorMessage(e) }), 'error');
}

/** Makes a scene and opens it. Pressing the shortcut twice quickly makes only one. */
let creatingScene = false;

export async function newScene(fromId: string | null = currentNodeId()): Promise<void> {
  if (creatingScene) return;
  creatingScene = true;
  try {
    if (!(await readyToEdit())) return;
    const plan = planNewScene(useWrite.getState().index, fromId);
    let chapterId: string;
    let afterId: string | undefined;
    if ('chapter' in plan) {
      const chapter = await createNode('chapter', plan.chapter.parentId, plan.chapter.afterId);
      chapterId = chapter.id;
    } else {
      chapterId = plan.chapterId;
      afterId = plan.afterId;
    }
    const scene = await createNode('scene', chapterId, afterId);
    await syncNow();
    expandTo(scene.id);
    openScene(scene.id);
  } catch (e) {
    reportFailure(t('Could not add a scene'), e);
  } finally {
    creatingScene = false;
  }
}

/** Makes a chapter with its first scene, and opens the scene ready to write in. */
export async function newChapter(fromId: string | null = currentNodeId()): Promise<void> {
  if (!(await readyToEdit())) return;
  try {
    const plan = planNewChapter(useWrite.getState().index, fromId);
    const chapter = await createNode('chapter', plan.parentId, plan.afterId);
    const scene = await api.nodes.create({
      bookId: chapter.bookId,
      parentId: chapter.id,
      kind: 'scene',
      title: t('Scene {number}', { number: 1 }),
    });
    await syncNow();
    expandTo(scene.id);
    openScene(scene.id);
  } catch (e) {
    reportFailure(t('Could not add a chapter'), e);
  }
}

export async function newPart(): Promise<void> {
  if (!(await readyToEdit())) return;
  try {
    const part = await createNode('part', null);
    await syncNow();
    goToMode('cork', part.id);
  } catch (e) {
    reportFailure(t('Could not add a part'), e);
  }
}

export async function newBook(): Promise<void> {
  const title = await promptText({
    title: t('New book'),
    label: t('Title'),
    confirmLabel: t('Create'),
    validate: (v) => (v.trim() ? null : t('A book needs a title.')),
  });
  if (!title) return;
  try {
    await flushAllEditors();
    const { id } = await api.books.create(title.trim());
    selectBook(id);
    useNav.getState().go({ view: 'write', bookId: id });
  } catch (e) {
    reportFailure(t('Could not add the book'), e);
  }
}

/** Puts the books in this order. First appearances and spoiler limits follow it. */
export async function reorderBooks(ids: string[]): Promise<void> {
  const before = useWrite.getState().books;
  const byId = new Map(before.map((b) => [b.id, b]));
  const next = ids.map((id) => byId.get(id)).filter((b): b is Book => !!b);
  if (next.length !== before.length) return;
  useWrite.setState({ books: next });
  try {
    await api.books.reorder(ids);
    await syncNow();
  } catch (e) {
    useWrite.setState({ books: before });
    reportFailure(t('Could not move the book'), e);
  }
}

/** Moves a book one place earlier or later in the series. */
export async function moveBook(id: string, by: -1 | 1): Promise<void> {
  const ids = useWrite.getState().books.map((b) => b.id);
  const from = ids.indexOf(id);
  const to = from + by;
  if (from < 0 || to < 0 || to >= ids.length) return;
  [ids[from], ids[to]] = [ids[to], ids[from]];
  await reorderBooks(ids);
}

export async function renameNode(id: string, title: string): Promise<void> {
  const clean = title.trim();
  const node = useWrite.getState().index.byId.get(id);
  if (!clean || !node || clean === node.title) return;
  showPatch(id, { title: clean });
  try {
    await writeNode(id, { title: clean });
  } catch (e) {
    reportFailure(t('Could not rename it'), e);
  }
}

export async function moveNode(id: string, parentId: string | null, index: number): Promise<void> {
  noteChange();
  useWrite.setState((s) => {
    const base = applyMove(s.base, id, parentId, index);
    const collapsed = new Set(s.collapsed);
    if (parentId) collapsed.delete(parentId);
    return { base, index: withOverlays(base), collapsed };
  });
  try {
    await api.nodes.move(id, parentId, index);
    noteChange();
  } catch (e) {
    noteChange();
    reportFailure(t('Could not move it'), e);
    await syncNow();
  }
}

/** What the open scene editor offers to the rest of the area. */
export interface OpenSceneControls {
  id: string;
  /** Stops typing, so that nothing is written over the result of what is about to happen. */
  pause: () => void;
  resume: () => void;
  /** The text cut in two at the cursor, or null if one side would be empty. */
  partsAtCursor: () => SplitParts | null;
  flush: () => Promise<unknown>;
  /** Shows what is stored now, in place of what the editor holds. */
  reload: () => void;
}

/** There can be a scene editor in each pane. */
const openControls = new Map<PaneId | null, OpenSceneControls>();

export function registerOpenScene(paneId: PaneId | null, controls: OpenSceneControls | null) {
  if (controls) openControls.set(paneId, controls);
  else openControls.delete(paneId);
}

function focusedControls(): OpenSceneControls | null {
  return openControls.get(useNav.getState().focusedPaneId) ?? openControls.get(null) ?? null;
}

export function openSceneId(): string | null {
  return focusedControls()?.id ?? null;
}

/** Cuts the open scene in two at the cursor, and goes to the new second half. */
export async function splitOpenScene(): Promise<void> {
  const controls = focusedControls();
  if (!controls) {
    toast(t('Open a scene and put the cursor where the new one should begin.'));
    return;
  }
  const parts = controls.partsAtCursor();
  if (!parts) {
    toast(t('Put the cursor inside the text, where the new scene should begin.'));
    return;
  }
  controls.pause();
  try {
    await controls.flush();
    // A save still waiting to be retried would later write the whole text over the first half.
    if (sceneHasUnsavedWork(controls.id)) throw new Error('the latest changes have not been saved yet');
    const original = controls.id;
    const made = await api.splitScene(original, parts.before, parts.after);
    await syncNow();
    openScene(made.id);
    useWrite.setState({ undo: { kind: 'split', id: made.id, original, label: t('Split the scene in two.') } });
  } catch (e) {
    controls.resume();
    reportFailure(t('Could not split the scene'), e);
  }
}

/**
 * Joins a split scene back together. If neither half has changed since, the text comes
 * back exactly as it was. Otherwise it is a merge, which keeps every word.
 */
export async function undoSplit(original: string, made: string): Promise<void> {
  const { index, undo } = useWrite.getState();
  if (undo?.kind === 'split' && undo.id === made) useWrite.setState({ undo: null });
  if (neighborScene(index, original, 1)?.id !== made) {
    toast(t('The two halves are no longer next to each other, so the split cannot be undone here. Each half has its history.'));
    return;
  }
  await mergeWithNext(original, { undoingSplit: true });
}

/** Moves the next scene onto the end of this one. The next scene goes to the trash. */
export async function mergeWithNext(id: string, options: { undoingSplit?: boolean } = {}): Promise<void> {
  const { index } = useWrite.getState();
  const next = neighborScene(index, id, 1);
  if (!next) {
    toast(t('This is the last scene in the book, so there is nothing to merge it with.'));
    return;
  }
  // The two scenes may be open side by side, and neither may keep typing through this.
  const involved = [...openControls.values()].filter((c) => c.id === id || c.id === next.id);
  involved.forEach((c) => c.pause());
  try {
    await flushAllEditors();
    if (sceneHasUnsavedWork(id) || sceneHasUnsavedWork(next.id)) throw new Error('the latest changes have not been saved yet');
    await api.mergeScene(id);
    await syncNow();
    const focused = focusedControls();
    // The pane on the scene that has gone moves to the one that remains. If that pane is not
    // the focused one, it finds out for itself that its scene is in the trash.
    involved.forEach((c) => {
      if (c.id !== next.id) c.reload();
      else if (c === focused) openScene(id);
    });
    if (options.undoingSplit) {
      toast(t('The scene is whole again.'), 'success');
      return;
    }
    const kept = index.byId.get(id);
    // Bringing the merged scene back from the trash takes its text back out of this one.
    useWrite.setState({
      undo: { kind: 'node', id: next.id, label: t('Merged “{next}”.', { next: displayTitle(next) }) },
    });
    toast(
      kept
        ? t('Merged “{next}” into “{kept}”. The earlier text of both is in their history, and the old scene is in the trash.', {
            next: displayTitle(next),
            kept: displayTitle(kept),
          })
        : t('Merged “{next}” into “the scene before it”. The earlier text of both is in their history, and the old scene is in the trash.', {
            next: displayTitle(next),
          }),
      'info',
      { label: t('Show history'), run: () => void openSceneHistory(id) },
    );
  } catch (e) {
    involved.forEach((c) => c.resume());
    reportFailure(t('Could not merge the scenes'), e);
  }
}

function describeDeleted(index: TreeIndex, node: NodeMeta): string {
  const count = scenesUnder(index, node.id).length;
  const title = displayTitle(node);
  if (node.kind === 'scene' || count === 0) return t('Deleted “{title}”.', { title });
  if (count === 1) return t('Deleted “{title}” and its scene.', { title });
  return t('Deleted “{title}” and its {count} scenes.', { title, count });
}

/** The nearest scene outside a branch about to go, to move to in its place. */
function sceneOutside(index: TreeIndex, id: string): NodeMeta | undefined {
  const gone = new Set(scenesUnder(index, id).map((s) => s.id));
  const first = index.scenes.findIndex((s) => gone.has(s.id));
  if (first < 0) return index.scenes[0];
  const after = index.scenes.slice(first).find((s) => !gone.has(s.id));
  return after ?? index.scenes.slice(0, first).at(-1);
}

export async function deleteNode(id: string): Promise<void> {
  const { index, bookId } = useWrite.getState();
  const node = index.byId.get(id);
  if (!node) return;
  try {
    await flushAllEditors();
    const { nodeId, mode } = routeState();
    if (nodeId && (nodeId === id || isInside(index, nodeId, id))) {
      const next = sceneOutside(index, id);
      // Someone working through the binder from the keyboard stays there.
      if (mode === 'scene' && next) openScene(next.id, { keepFocus: true });
      else goToMode(mode, undefined);
      if (next && lastScenes.get(bookId ?? '') === nodeId) lastScenes.set(bookId ?? '', next.id);
    }
    await api.nodes.remove(id);
    await syncNow();
    useWrite.setState({ undo: { kind: 'node', id, label: describeDeleted(index, node) } });
  } catch (e) {
    reportFailure(t('Could not delete it'), e);
  }
}

/**
 * Brings a node back from the trash. A scene that was merged into another takes its text back
 * out of that scene, so its words are not there twice. If that text has changed since, the
 * writer decides whether to bring the scene back anyway.
 */
export async function restoreNode(id: string): Promise<void> {
  try {
    // The scene it was merged into may be open, and its typing must be saved first.
    await flushAllEditors();
    try {
      await sceneUndo.restore(id);
    } catch (e) {
      if (!(e instanceof RpcError && e.code === MERGED_TEXT_CHANGED)) throw e;
      const node = await api.nodes.get(id);
      const yes = await confirm({
        title: t('Restore this scene?'),
        message: t('“{title}” was merged into another scene, which has changed since. Its text may now be in both scenes. Check the other scene after restoring it.', {
          title: displayTitle(node),
        }),
        confirmLabel: t('Restore anyway'),
      });
      if (!yes) return;
      await sceneUndo.restore(id, true);
    }
    if (useWrite.getState().undo?.id === id) useWrite.setState({ undo: null });
    await syncNow();
    const { index } = useWrite.getState();
    const first = index.byId.has(id) ? scenesUnder(index, id)[0] : undefined;
    if (first) {
      expandTo(first.id);
      if (routeState().mode === 'scene') openScene(first.id);
    }
  } catch (e) {
    reportFailure(t('Could not restore it'), e);
  }
}

/** Deletes one item in the trash for good, after asking. */
export async function purgeNode(node: NodeMeta): Promise<void> {
  const yes = await confirm({
    title: t('Delete “{title}” forever?', { title: displayTitle(node) }),
    message: t('It and its saved versions will be gone for good. This can’t be undone.'),
    confirmLabel: t('Delete forever'),
    danger: true,
  });
  if (!yes) return;
  try {
    await api.purgeNode(node.id);
    if (useWrite.getState().undo?.id === node.id) useWrite.setState({ undo: null });
  } catch (e) {
    reportFailure(t('Could not delete it'), e);
  }
}

/** Deletes everything in this book's trash for good, after asking. */
export async function emptyNodeTrash(bookId: string, count: number): Promise<void> {
  const yes = await confirm({
    title: t('Empty the trash?'),
    message:
      count === 1
        ? t('1 item and its saved versions will be gone for good. This can’t be undone.')
        : t('{count} items and their saved versions will be gone for good. This can’t be undone.', { count }),
    confirmLabel: t('Empty trash'),
    danger: true,
  });
  if (!yes) return;
  try {
    await api.emptyNodeTrash(bookId);
    useWrite.setState({ undo: null });
  } catch (e) {
    reportFailure(t('Could not empty the trash'), e);
  }
}

export async function deleteBook(book: Book): Promise<void> {
  try {
    await flushAllEditors();
    await api.books.remove(book.id);
    await syncNow();
    useWrite.setState({ undo: { kind: 'book', id: book.id, label: t('Deleted “{title}”.', { title: book.title }) } });
    const { bookId } = useWrite.getState();
    useNav.getState().go({ view: 'write', bookId: bookId ?? undefined });
  } catch (e) {
    reportFailure(t('Could not delete the book'), e);
  }
}

export async function restoreBook(id: string): Promise<void> {
  try {
    await api.books.restore(id);
    if (useWrite.getState().undo?.id === id) useWrite.setState({ undo: null });
    selectBook(id);
    useNav.getState().go({ view: 'write', bookId: id });
  } catch (e) {
    reportFailure(t('Could not restore the book'), e);
  }
}

export function undoLastDelete() {
  const entry = useWrite.getState().undo;
  if (!entry) return;
  if (entry.kind === 'split') void undoSplit(entry.original ?? '', entry.id);
  else if (entry.kind === 'node') void restoreNode(entry.id);
  else void restoreBook(entry.id);
}

export function dismissUndo() {
  useWrite.setState({ undo: null });
}
