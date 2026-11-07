/**
 * The story planning wizard's data, with no UI and no calls: what is stored, how model
 * replies are read, and what Create will make.
 */

import type { Beat } from './templates';

export const STEPS = ['braindump', 'synopsis', 'characters', 'world', 'structure', 'outline', 'review'] as const;
export type StepId = (typeof STEPS)[number];

/** A character, place, group or thing the story needs. */
export interface PlanEntity {
  key: string;
  name: string;
  /** A page type, such as `character` or `place`. */
  pageType: string;
  /** One line: who or what it is in this story. */
  role: string;
  description: string;
  /** Set when it is an existing wiki page, which is linked to rather than made again. */
  existingId?: string;
  /** Added or edited by the writer. Asking the AI again never replaces it. */
  touched?: boolean;
}

export interface PlanScene {
  key: string;
  title: string;
  synopsis: string;
  /** A character's name, from the plan or the wiki. */
  pov: string;
  cast: string[];
}

export interface PlanChapter {
  key: string;
  title: string;
  synopsis: string;
  scenes: PlanScene[];
}

export type PlanTarget = { kind: 'new'; title: string } | { kind: 'existing'; bookId: string };

export interface PlanState {
  version: 1;
  step: StepId;
  /** Off means every step is done by hand, and nothing is sent anywhere. */
  useAi: boolean;
  braindump: string;
  synopsis: string;
  characters: PlanEntity[];
  world: PlanEntity[];
  structureId: string | null;
  chapters: PlanChapter[];
  /** Steps the AI has been asked about, so it is not asked again on its own. */
  asked: StepId[];
  target: PlanTarget;
}

export function emptyPlan(): PlanState {
  return {
    version: 1,
    step: 'braindump',
    useAi: true,
    braindump: '',
    synopsis: '',
    characters: [],
    world: [],
    structureId: null,
    chapters: [],
    asked: [],
    target: { kind: 'new', title: '' },
  };
}

let counter = 0;
/** A key for a list item, unique within a session and stable once stored. */
export function newKey(): string {
  counter += 1;
  return `k${Date.now().toString(36)}${counter.toString(36)}`;
}

const str = (value: unknown, max = 4000): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '').trim().slice(0, max);

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Reads stored progress, keeping whatever is usable from an older or damaged copy. */
export function parseStored(text: string | null): PlanState | null {
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const value = record(raw);
  if (value.version !== 1) return null;
  const base = emptyPlan();
  const step = STEPS.includes(value.step as StepId) ? (value.step as StepId) : base.step;
  const entities = (list: unknown, fallbackType: string) =>
    (Array.isArray(list) ? list : []).map((item) => {
      const r = record(item);
      return {
        key: str(r.key) || newKey(),
        name: str(r.name, 200),
        pageType: str(r.pageType, 60) || fallbackType,
        role: str(r.role, 400),
        description: str(r.description),
        ...(str(r.existingId) ? { existingId: str(r.existingId) } : {}),
        ...(r.touched === true ? { touched: true } : {}),
      };
    });
  const target = record(value.target);
  return {
    version: 1,
    step,
    useAi: value.useAi !== false,
    braindump: str(value.braindump, 100_000),
    synopsis: str(value.synopsis, 100_000),
    characters: entities(value.characters, 'character'),
    world: entities(value.world, 'place'),
    structureId: str(value.structureId) || null,
    chapters: parseChapterList(value.chapters, true),
    asked: (Array.isArray(value.asked) ? value.asked : []).filter((s): s is StepId => STEPS.includes(s as StepId)),
    target: target.kind === 'existing' && str(target.bookId)
      ? { kind: 'existing', bookId: str(target.bookId) }
      : { kind: 'new', title: str(target.title, 200) },
  };
}

// ---------------------------------------------------------------------------
// Reading what a model wrote. Small models put things in odd places, so this is generous.
// ---------------------------------------------------------------------------

/** The first array in a value: the value itself, or the first array-valued field. */
function firstArray(value: unknown, preferred: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  const r = record(value);
  for (const key of preferred) if (Array.isArray(r[key])) return r[key] as unknown[];
  for (const key of Object.keys(r)) if (Array.isArray(r[key])) return r[key] as unknown[];
  return [];
}

const nameOf = (r: Record<string, unknown>) => str(r.name, 200) || str(r.title, 200);

const listOfNames = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v.trim() : nameOf(record(v)))).filter(Boolean);
  if (typeof value === 'string') return value.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  return [];
};

/**
 * Characters or world items from a reply. `allowedTypes` are the page types a model may use;
 * anything else becomes `fallbackType`. Throws if there is nothing usable, which asks again.
 */
export function parseEntities(value: unknown, allowedTypes: string[], fallbackType: string): PlanEntity[] {
  const items = firstArray(value, ['characters', 'items', 'world', 'places', 'entries']);
  const out: PlanEntity[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const r = typeof item === 'string' ? { name: item } : record(item);
    const name = nameOf(r);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const wanted = (str(r.type, 60) || str(r.kind, 60) || str(r.pageType, 60)).toLowerCase();
    out.push({
      key: newKey(),
      name,
      pageType: allowedTypes.includes(wanted) ? wanted : fallbackType,
      role: str(r.role, 400),
      description: str(r.description) || str(r.summary),
    });
  }
  if (out.length === 0) throw new Error('Give a JSON object with a list of items, each with "name", "role" and "description".');
  return out;
}

function parseChapterList(value: unknown, keepKeys: boolean): PlanChapter[] {
  return (Array.isArray(value) ? value : []).map((item, i) => {
    const r = typeof item === 'string' ? { title: item } : record(item);
    const scenes = firstArray(r.scenes ?? [], ['scenes']).map((s, j) => {
      const sr = typeof s === 'string' ? { synopsis: s } : record(s);
      return {
        key: (keepKeys && str(sr.key)) || newKey(),
        title: str(sr.title, 200) || str(sr.name, 200) || `${j + 1}`,
        synopsis: str(sr.synopsis) || str(sr.summary) || str(sr.description),
        pov: str(sr.pov, 200) || str(sr.pointOfView, 200),
        cast: listOfNames(sr.cast ?? sr.characters),
      };
    });
    return {
      key: (keepKeys && str(r.key)) || newKey(),
      title: str(r.title, 200) || str(r.name, 200) || `${i + 1}`,
      synopsis: str(r.synopsis) || str(r.summary) || str(r.description),
      scenes,
    };
  });
}

/**
 * Fresh suggestions into a list. Everything the writer added or edited stays where it is.
 * Untouched suggestions from before are replaced, and a new one whose name is already kept
 * is left out.
 */
export function mergeSuggestions(current: PlanEntity[], suggested: PlanEntity[]): PlanEntity[] {
  const kept = current.filter((e) => e.touched);
  const names = new Set(kept.map((e) => nameKey(e.name)).filter(Boolean));
  const added: PlanEntity[] = [];
  for (const entity of suggested) {
    const key = nameKey(entity.name);
    if (!key || names.has(key)) continue;
    names.add(key);
    added.push({ ...entity, touched: undefined });
  }
  return [...kept, ...added];
}

/** Chapters with their scenes from a reply. Throws if there are none, which asks again. */
export function parseOutline(value: unknown): PlanChapter[] {
  const chapters = parseChapterList(firstArray(value, ['chapters', 'outline']), false);
  if (chapters.length === 0) {
    throw new Error('Give a JSON object {"chapters": [...]}, each chapter with "title", "synopsis" and "scenes".');
  }
  return chapters;
}

// ---------------------------------------------------------------------------
// What Create will make
// ---------------------------------------------------------------------------

export interface ExistingPage {
  id: string;
  title: string;
  aliases: string[];
  pageType: string;
}

export const nameKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

/** The existing page a name means, by title or alias. */
export function findExisting(name: string, pages: ExistingPage[]): ExistingPage | undefined {
  const key = nameKey(name);
  if (!key) return undefined;
  return pages.find((p) => nameKey(p.title) === key) ?? pages.find((p) => p.aliases.some((a) => nameKey(a) === key));
}

export interface PlannedPage {
  name: string;
  pageType: string;
  summary: string;
  description: string;
}

export interface PlannedScene {
  title: string;
  synopsis: string;
  /** A name to look up once the pages exist. Empty for none. */
  pov: string;
  cast: string[];
}

export interface PlannedChapter {
  title: string;
  synopsis: string;
  scenes: PlannedScene[];
}

export interface CreationPlan {
  target: PlanTarget;
  /** New wiki pages, all made as drafts. */
  pages: PlannedPage[];
  /** Plan entries that are already in the wiki, linked to as they are. */
  linked: { name: string; pageId: string }[];
  chapters: PlannedChapter[];
  /** The story's synopsis. A book has no field for it, so it is shown and kept with the plan. */
  synopsis: string;
}

/**
 * Works out what Create will do. Empty names are dropped, each name is made once, and a name
 * that is already a page links to it instead of making another.
 */
export function buildCreationPlan(state: PlanState, existing: ExistingPage[]): CreationPlan {
  const pages: PlannedPage[] = [];
  const linked: { name: string; pageId: string }[] = [];
  const seen = new Set<string>();
  for (const entity of [...state.characters, ...state.world]) {
    const name = entity.name.trim();
    const key = nameKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const found = (entity.existingId && existing.find((p) => p.id === entity.existingId)) || findExisting(name, existing);
    if (found) {
      linked.push({ name: found.title, pageId: found.id });
      continue;
    }
    pages.push({ name, pageType: entity.pageType, summary: entity.role.trim(), description: entity.description.trim() });
  }
  const chapters = state.chapters
    .map((c) => ({
      title: c.title.trim(),
      synopsis: c.synopsis.trim(),
      scenes: c.scenes
        .map((s) => ({
          title: s.title.trim(),
          synopsis: s.synopsis.trim(),
          pov: s.pov.trim(),
          cast: [...new Set(s.cast.map((n) => n.trim()).filter(Boolean))],
        }))
        .filter((s) => s.title || s.synopsis),
    }))
    .filter((c) => c.title || c.synopsis || c.scenes.length > 0);
  return { target: state.target, pages, linked, chapters, synopsis: state.synopsis.trim() };
}

/** True if Create would make nothing at all. */
export function isEmptyPlan(plan: CreationPlan): boolean {
  return plan.pages.length === 0 && plan.chapters.length === 0 && plan.target.kind === 'existing';
}

/** Page ids by name: the pages just made, then the wiki's. */
export function resolveName(name: string, made: Map<string, string>, existing: ExistingPage[]): string | undefined {
  const key = nameKey(name);
  if (!key) return undefined;
  return made.get(key) ?? findExisting(name, existing)?.id;
}

// ---------------------------------------------------------------------------
// Structures on their own
// ---------------------------------------------------------------------------

/** Chapters with one empty scene each, one per beat, for an outline started by hand. */
export function chaptersFromBeats(beats: Beat[]): PlanChapter[] {
  return beats.map((b) => ({
    key: newKey(),
    title: b.name,
    synopsis: b.guidance,
    scenes: [{ key: newKey(), title: '1', synopsis: '', pov: '', cast: [] }],
  }));
}

export interface BeatToApply {
  beat: Beat;
  /** False when a chapter of that name is already in the book, so it is left out at first. */
  wanted: boolean;
}

/** The beats to add to a book as chapters. Ones already there by name start unticked. */
export function beatsToApply(beats: Beat[], chapterTitles: string[]): BeatToApply[] {
  const have = new Set(chapterTitles.map(nameKey));
  return beats.map((beat) => ({ beat, wanted: !have.has(nameKey(beat.name)) }));
}
