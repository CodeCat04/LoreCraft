/**
 * Where style data lives. Choices and the style guide are in project meta, so they save with
 * the project. Custom styles and favorites are in app settings, available to every project.
 * A project also keeps a copy of any custom style's prompt it uses, so it still works on a
 * computer where that custom style does not exist.
 */

import * as api from '../lib/api';
import { useProject } from '../state/project';
import { useSettings } from '../state/settings';
import { hasGuide } from './guide';
import { LIBRARY, builtInStyle, compareStyles } from './library';
import { buildStylePrompt } from './prompt';
import { composeInstructions, pickStyle, type EffectiveStyle, type StyleInstructions, type StyleRequest } from './resolve';
import type { CustomStyle, StoredChoices, StoredGuide, StoredStyleChoice, StyleGuide, StyleScope, WritingStyle } from './types';

const CHOICES_KEY = 'writingStyles.choices';
const GUIDE_KEY = 'writingStyles.guide';
/** A plain-text copy for the MCP server, which is written in Rust and cannot call this code. */
export const RESOLVED_TEXT_KEY = 'styleGuide.text';

const hasProject = () => useProject.getState().status.open;

function parseJson<T>(stored: string | null): T {
  if (!stored) return {} as T;
  try {
    const parsed = JSON.parse(stored) as unknown;
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}) as T;
  } catch {
    return {} as T;
  }
}

export async function loadChoices(): Promise<StoredChoices> {
  return hasProject() ? parseJson<StoredChoices>(await api.project.getMeta(CHOICES_KEY)) : {};
}

export async function loadGuide(): Promise<StoredGuide> {
  return hasProject() ? parseJson<StoredGuide>(await api.project.getMeta(GUIDE_KEY)) : {};
}

// Writes are read-change-write, and replies can overtake each other, so they run one by one.
let queue: Promise<unknown> = Promise.resolve();
function inOrder<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work, work);
  queue = result.catch(() => {});
  return result;
}

const changeListeners = new Set<() => void>();

/** Called after any change to a style choice. Returns a function that stops listening. */
export function onStyleChoicesChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function announce() {
  changeListeners.forEach((listener) => listener());
}

// ---------------------------------------------------------------------------
// The library, plus this person's own styles
// ---------------------------------------------------------------------------

function customStyles(): CustomStyle[] {
  return useSettings.getState().settings.writingStyles.custom;
}

/** Every style available right now: the library and this person's own, sorted for browsing. */
export function listStyles(): WritingStyle[] {
  return [...LIBRARY, ...customStyles()].sort(compareStyles);
}

export function getStyle(id: string): WritingStyle | undefined {
  return builtInStyle(id) ?? customStyles().find((style) => style.id === id);
}

export function newStyleId(): string {
  return `custom-${crypto.randomUUID()}`;
}

/** Adds or replaces a custom style, and refreshes the open project's copy of its prompt. */
export async function saveCustomStyle(style: CustomStyle): Promise<CustomStyle> {
  const saved: CustomStyle = style.id ? style : { ...style, id: newStyleId() };
  const { settings, update } = useSettings.getState();
  const others = settings.writingStyles.custom.filter((s) => s.id !== saved.id);
  await update({ writingStyles: { custom: [...others, saved] } });
  await refreshProjectCopies(saved);
  return saved;
}

/** Projects that use it keep their own copy of the prompt. */
export async function deleteCustomStyle(id: string): Promise<void> {
  const { settings, update } = useSettings.getState();
  await update({
    writingStyles: {
      custom: settings.writingStyles.custom.filter((s) => s.id !== id),
      favorites: settings.writingStyles.favorites.filter((f) => f !== id),
    },
  });
  announce();
}

export async function toggleFavorite(id: string): Promise<void> {
  const { settings, update } = useSettings.getState();
  const favorites = settings.writingStyles.favorites;
  await update({
    writingStyles: { favorites: favorites.includes(id) ? favorites.filter((f) => f !== id) : [...favorites, id] },
  });
}

// ---------------------------------------------------------------------------
// Which style applies where
// ---------------------------------------------------------------------------

function storedChoice(styleId: string): StoredStyleChoice {
  const style = getStyle(styleId);
  if (style?.kind !== 'custom') return { styleId };
  return { styleId, name: style.name, prompt: buildStylePrompt(style) };
}

function choiceAt(choices: StoredChoices, scope: StyleScope): StoredStyleChoice | undefined {
  if (scope.kind === 'project') return choices.project;
  if (scope.kind === 'book') return choices.books?.[scope.bookId];
  return choices.scenes?.[scope.nodeId];
}

export interface ActiveStyle {
  styleId: string;
  /** Null only for a custom style with no name stored, which should not happen. */
  name: string | null;
  /** The style itself, unless it is a custom style not on this computer. */
  style: WritingStyle | null;
}

/** The style chosen at exactly this scope, with no inheritance. Null if none is. */
export async function getActiveStyle(scope: StyleScope): Promise<ActiveStyle | null> {
  const choice = choiceAt(await loadChoices(), scope);
  if (!choice) return null;
  const style = getStyle(choice.styleId) ?? null;
  return { styleId: choice.styleId, name: style?.name ?? choice.name ?? null, style };
}

/** Sets or, with null, clears the style for this scope. Null means the wider scope applies. */
export async function setActiveStyle(scope: StyleScope, styleId: string | null): Promise<void> {
  await inOrder(async () => {
    const choices = await loadChoices();
    const value = styleId ? storedChoice(styleId) : undefined;
    if (scope.kind === 'project') {
      if (value) choices.project = value;
      else delete choices.project;
    } else if (scope.kind === 'book') {
      const books = { ...choices.books };
      if (value) books[scope.bookId] = value;
      else delete books[scope.bookId];
      choices.books = books;
    } else {
      const scenes = { ...choices.scenes };
      if (value) scenes[scope.nodeId] = value;
      else delete scenes[scope.nodeId];
      choices.scenes = scenes;
    }
    await api.project.setMeta(CHOICES_KEY, JSON.stringify(choices));
    if (scope.kind === 'project') await writeResolvedText();
  });
  announce();
}

/** A style that names its source by id needs no copy. A custom one must keep this current. */
async function refreshProjectCopies(style: CustomStyle): Promise<void> {
  if (!hasProject()) return;
  await inOrder(async () => {
    const choices = await loadChoices();
    const prompt = buildStylePrompt(style);
    let changed = false;
    const refresh = (choice: StoredStyleChoice | undefined) => {
      if (choice?.styleId === style.id && (choice.prompt !== prompt || choice.name !== style.name)) {
        choice.prompt = prompt;
        choice.name = style.name;
        changed = true;
      }
    };
    refresh(choices.project);
    Object.values(choices.books ?? {}).forEach(refresh);
    Object.values(choices.scenes ?? {}).forEach(refresh);
    if (changed) {
      await api.project.setMeta(CHOICES_KEY, JSON.stringify(choices));
      await writeResolvedText();
    }
  });
  announce();
}

/** The style that applies to this request, and the level it was chosen at. */
export async function resolveEffectiveStyle(request: StyleRequest = {}): Promise<EffectiveStyle | null> {
  return pickStyle(await loadChoices(), { ...request, bookId: await bookIdFor(request) }, getStyle);
}

// ---------------------------------------------------------------------------
// The style guide
// ---------------------------------------------------------------------------

/** The stored rules, once any save still on its way has landed. */
export function loadGuideAfterSaves(): Promise<StoredGuide> {
  return inOrder(loadGuide);
}

/** Replaces the rules for the project, or for one book when `bookId` is given. */
export async function saveGuide(guide: StyleGuide, bookId?: string | null): Promise<void> {
  await inOrder(async () => {
    const stored = await loadGuide();
    if (bookId) {
      const books = { ...stored.books };
      if (hasGuide(guide)) books[bookId] = guide;
      else delete books[bookId];
      stored.books = books;
    } else {
      stored.project = guide;
    }
    await api.project.setMeta(GUIDE_KEY, JSON.stringify(stored));
    if (!bookId) await writeResolvedText();
  });
}

// ---------------------------------------------------------------------------
// What the AI receives
// ---------------------------------------------------------------------------

async function bookIdFor(request: StyleRequest): Promise<string | null> {
  if (request.bookId) return request.bookId;
  if (!request.nodeId || !hasProject()) return null;
  try {
    return (await api.nodes.get(request.nodeId)).bookId;
  } catch {
    // A scene that has since been deleted has no book.
    return null;
  }
}

/**
 * The text block for the AI: the style guide rules plus the active style's prompt. The style
 * is the explicit `styleId` (a chat's choice), then the scene's, the book's, the project's.
 * The same inputs give the same output, since it sits in a cached prompt prefix.
 */
export async function resolveStyleInstructions(request: StyleRequest = {}): Promise<StyleInstructions> {
  const [choices, guide, bookId] = await Promise.all([loadChoices(), loadGuide(), bookIdFor(request)]);
  return composeInstructions(choices, guide, { ...request, bookId }, getStyle);
}

/**
 * Stores the project's resolved text for the MCP server. Runs only after a change the person
 * made, which has already marked the project as changed, and writes only if the text differs.
 * It must never run on opening a project, which would mark a clean project dirty.
 */
async function writeResolvedText(): Promise<void> {
  const [choices, guide, current] = await Promise.all([loadChoices(), loadGuide(), api.project.getMeta(RESOLVED_TEXT_KEY)]);
  const { text } = composeInstructions(choices, guide, {}, getStyle);
  if ((current ?? '') !== text) await api.project.setMeta(RESOLVED_TEXT_KEY, text);
}
