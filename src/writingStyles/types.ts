/** Shapes shared by the style library, the prompt builder and the page. */

import { t } from '../lib/i18n';

/** The fixed list of genres, so that filters work and typos fail the data tests. */
export const GENRES = [
  { id: 'hard-sf', label: 'Hard SF' },
  { id: 'classic-sf', label: 'Classic SF' },
  { id: 'space-opera', label: 'Space opera' },
  { id: 'military-sf', label: 'Military SF' },
  { id: 'cyberpunk', label: 'Cyberpunk' },
  { id: 'dystopian', label: 'Dystopian' },
  { id: 'technothriller', label: 'Technothriller' },
  { id: 'thriller', label: 'Thriller' },
  { id: 'espionage', label: 'Espionage' },
  { id: 'epic-fantasy', label: 'Epic fantasy' },
  { id: 'fantasy', label: 'Other fantasy' },
  { id: 'young-adult', label: 'Young adult' },
  { id: 'childrens', label: "Children's" },
  { id: 'horror', label: 'Horror' },
  { id: 'gothic', label: 'Gothic' },
  { id: 'crime', label: 'Crime' },
  { id: 'mystery', label: 'Mystery' },
  { id: 'literary', label: 'Literary' },
  { id: 'classics', label: 'Classics' },
  { id: 'romance', label: 'Romance' },
  { id: 'historical', label: 'Historical' },
  { id: 'humor', label: 'Humor' },
  { id: 'western', label: 'Western' },
  { id: 'pov', label: 'Point of view' },
  { id: 'voice', label: 'Voice and tone' },
  { id: 'structure', label: 'Structure' },
] as const;

export type Genre = (typeof GENRES)[number]['id'];

const GENRE_LABELS = new Map<string, string>(GENRES.map((g) => [g.id, g.label]));

/** The genre's English name, as the library's search uses it. */
export function genreName(id: string): string {
  return GENRE_LABELS.get(id) ?? id;
}

/** The genre's name in the interface language, for the screen. */
export function genreLabel(id: string): string {
  switch (id) {
    case 'hard-sf': return t('Hard SF');
    case 'classic-sf': return t('Classic SF');
    case 'space-opera': return t('Space opera');
    case 'military-sf': return t('Military SF');
    case 'cyberpunk': return t('Cyberpunk');
    case 'dystopian': return t('Dystopian');
    case 'technothriller': return t('Technothriller');
    case 'thriller': return t('Thriller');
    case 'espionage': return t('Espionage');
    case 'epic-fantasy': return t('Epic fantasy');
    case 'fantasy': return t('Other fantasy');
    case 'young-adult': return t('Young adult');
    case 'childrens': return t("Children's");
    case 'horror': return t('Horror');
    case 'gothic': return t('Gothic');
    case 'crime': return t('Crime');
    case 'mystery': return t('Mystery');
    case 'literary': return t('Literary');
    case 'classics': return t('Classics');
    case 'romance': return t('Romance');
    case 'historical': return t('Historical');
    case 'humor': return t('Humor');
    case 'western': return t('Western');
    case 'pov': return t('Point of view');
    case 'voice': return t('Voice and tone');
    case 'structure': return t('Structure');
    default: return genreName(id);
  }
}

/** Concrete craft instructions, written so they can be given to a model as they stand. */
export interface StyleTraits {
  /** Point of view and narrative distance. */
  narration: string;
  /** Length, rhythm and structure. */
  sentences: string;
  /** Word choice, register and jargon. */
  diction: string;
  dialogue: string;
  /** What gets described, how much, and how. */
  description: string;
  /** Scene and chapter structure, and how tension is built. */
  pacing: string;
  /** The devices that make it recognizably this style. */
  signature: string;
  /** What would break this voice. */
  avoid: string;
}

export type TraitKey = keyof StyleTraits;

/** The one order traits appear in, on screen and in every prompt. */
export const TRAIT_FIELDS: { key: TraitKey; label: string; hint: string }[] = [
  { key: 'narration', label: 'Narration', hint: 'Point of view and narrative distance.' },
  { key: 'sentences', label: 'Sentences', hint: 'Length, rhythm and structure.' },
  { key: 'diction', label: 'Word choice', hint: 'Vocabulary, register and jargon.' },
  { key: 'dialogue', label: 'Dialogue', hint: 'How people talk, and what talk is for.' },
  { key: 'description', label: 'Description', hint: 'What gets described, how much, and how.' },
  { key: 'pacing', label: 'Pacing', hint: 'Scene and chapter structure, and how tension builds.' },
  { key: 'signature', label: 'Signature moves', hint: 'The devices that make it recognizable.' },
  { key: 'avoid', label: 'Avoid', hint: 'What would break this voice.' },
];

/** A trait's name in the interface language. `TRAIT_FIELDS` keeps the English the prompts use. */
export function traitLabel(key: TraitKey): string {
  switch (key) {
    case 'narration': return t('Narration');
    case 'sentences': return t('Sentences');
    case 'diction': return t('Word choice');
    case 'dialogue': return t('Dialogue');
    case 'description': return t('Description');
    case 'pacing': return t('Pacing');
    case 'signature': return t('Signature moves');
    case 'avoid': return t('Avoid');
  }
}

export function traitHint(key: TraitKey): string {
  switch (key) {
    case 'narration': return t('Point of view and narrative distance.');
    case 'sentences': return t('Length, rhythm and structure.');
    case 'diction': return t('Vocabulary, register and jargon.');
    case 'dialogue': return t('How people talk, and what talk is for.');
    case 'description': return t('What gets described, how much, and how.');
    case 'pacing': return t('Scene and chapter structure, and how tension builds.');
    case 'signature': return t('The devices that make it recognizable.');
    case 'avoid': return t('What would break this voice.');
  }
}

export type StyleKind = 'author' | 'technique' | 'custom';

interface StyleBase {
  id: string;
  name: string;
  genres: Genre[];
  /** Two to four sentences on how this is written. What the reader sees first. */
  summary: string;
  traits: StyleTraits;
}

export interface AuthorStyle extends StyleBase {
  kind: 'author';
  /** Two or three titles, titles only. */
  knownFor: string[];
}

export interface TechniqueStyle extends StyleBase {
  kind: 'technique';
}

export interface CustomStyle extends StyleBase {
  kind: 'custom';
  /** Free text that replaces the prompt built from the traits. */
  promptOverride?: string;
  /** How blended traits rank against each other. Set by `blendStyles`. */
  priority?: string;
  /** The style this began as a copy of. */
  basedOn?: string;
  /** This style's styles came from people's names, so its prompt must keep them off the page. */
  namesAuthors?: boolean;
}

export type WritingStyle = AuthorStyle | TechniqueStyle | CustomStyle;

/** Library data files leave out `kind`. Their aggregators add it. */
export type AuthorData = Omit<AuthorStyle, 'kind'>;
export type TechniqueData = Omit<TechniqueStyle, 'kind'>;

/** How much of a style goes into a blend. */
export type BlendWeight = 'mostly' | 'some' | 'touch';

export const BLEND_WEIGHTS: { id: BlendWeight; label: string }[] = [
  { id: 'mostly', label: 'Mostly' },
  { id: 'some', label: 'Some' },
  { id: 'touch', label: 'A touch' },
];

/** A blend weight's name in the interface language. `BLEND_WEIGHTS` keeps the prompt's English. */
export function blendWeightLabel(id: BlendWeight): string {
  switch (id) {
    case 'mostly': return t('Mostly');
    case 'some': return t('Some');
    case 'touch': return t('A touch');
  }
}

export interface BlendPart {
  style: WritingStyle;
  weight: BlendWeight;
}

/** Where a style choice applies. */
export type StyleScope =
  | { kind: 'project' }
  | { kind: 'book'; bookId: string }
  | { kind: 'scene'; nodeId: string };

/**
 * A style choice as a project stores it. A custom style also carries its name and prompt,
 * so the project still works on a computer where that custom style does not exist.
 */
export interface StoredStyleChoice {
  styleId: string;
  name?: string;
  prompt?: string;
}

/** Every style choice in a project. Lives in project meta, so it saves with the project. */
export interface StoredChoices {
  project?: StoredStyleChoice;
  books?: Record<string, StoredStyleChoice>;
  scenes?: Record<string, StoredStyleChoice>;
}

/** The writer's rules for a project or book. Every field is optional. */
export interface StyleGuide {
  tense?: string;
  pov?: string;
  distance?: string;
  spelling?: string;
  dialogue?: string;
  content?: string;
  voice?: string;
  /** One word or phrase per line or comma. */
  avoid?: string;
  /** One word or phrase per line or comma. */
  prefer?: string;
  sample?: string;
}

export type GuideField = keyof StyleGuide;

/** The project's rules and each book's overrides. */
export interface StoredGuide {
  project?: StyleGuide;
  books?: Record<string, StyleGuide>;
}
