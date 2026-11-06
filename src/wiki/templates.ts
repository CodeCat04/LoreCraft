/**
 * What a new page of each type starts with. Field keys are semantic: the consistency
 * checker reads them, so a key must keep its meaning even if its label changes.
 */

import { t } from '../lib/i18n';
import type { Infobox, InfoboxField, InfoboxFieldKind, PmNode } from '../lib/types';

/** Every field with a meaning the app relies on. */
export const SEMANTIC_FIELDS: Record<string, { label: string; kind: InfoboxFieldKind }> = {
  born: { label: 'Born', kind: 'date' },
  died: { label: 'Died', kind: 'date' },
  age: { label: 'Age', kind: 'number' },
  species: { label: 'Species', kind: 'page' },
  gender: { label: 'Gender', kind: 'text' },
  affiliation: { label: 'Affiliation', kind: 'pages' },
  location: { label: 'Location', kind: 'page' },
  founded: { label: 'Founded', kind: 'date' },
  dissolved: { label: 'Dissolved', kind: 'date' },
  date: { label: 'Date', kind: 'date' },
  start: { label: 'Began', kind: 'date' },
  end: { label: 'Ended', kind: 'date' },
  parents: { label: 'Parents', kind: 'pages' },
  spouse: { label: 'Spouse', kind: 'pages' },
  children: { label: 'Children', kind: 'pages' },
  leader: { label: 'Leader', kind: 'page' },
  members: { label: 'Members', kind: 'pages' },
  owner: { label: 'Owner', kind: 'page' },
  creator: { label: 'Creator', kind: 'page' },
  height: { label: 'Height', kind: 'text' },
  eyes: { label: 'Eyes', kind: 'text' },
  hair: { label: 'Hair', kind: 'text' },
};

/** A semantic field, optionally with a label that suits the page type. */
function field(key: string, label?: string): InfoboxField {
  const known = SEMANTIC_FIELDS[key];
  return { key, label: label ?? known.label, kind: known.kind, value: '' };
}

export interface PageTemplate {
  /** Stored as the page's type. */
  type: string;
  /** Singular, for a menu of types. */
  label: string;
  /** Plural, for a list of pages of this type. */
  plural: string;
  /** Says what the type is for, in the writer's words. Custom types only. */
  description?: string;
  fields: InfoboxField[];
  sections: string[];
}

export const TEMPLATES: PageTemplate[] = [
  {
    type: 'article',
    label: 'Blank article',
    plural: 'Articles',
    fields: [],
    sections: [],
  },
  {
    type: 'character',
    label: 'Character',
    plural: 'Characters',
    fields: [
      field('born'),
      field('died'),
      field('age'),
      field('species'),
      field('gender'),
      field('height'),
      field('eyes'),
      field('hair'),
      field('location', 'Home'),
      field('affiliation'),
      field('parents'),
      field('spouse'),
      field('children'),
    ],
    sections: ['Appearance', 'Personality', 'Biography', 'Relationships'],
  },
  {
    type: 'place',
    label: 'Place',
    plural: 'Places',
    fields: [
      field('location', 'Part of'),
      field('founded'),
      field('dissolved', 'Abandoned'),
      field('leader', 'Ruler'),
      field('affiliation', 'Controlled by'),
    ],
    sections: ['Geography', 'History', 'Society', 'Notable places'],
  },
  {
    type: 'faction',
    label: 'Faction',
    plural: 'Factions',
    fields: [
      field('founded'),
      field('dissolved'),
      field('leader'),
      field('members', 'Notable members'),
      field('location', 'Headquarters'),
      field('affiliation', 'Allies'),
    ],
    sections: ['History', 'Goals', 'Structure', 'Notable members'],
  },
  {
    type: 'item',
    label: 'Item',
    plural: 'Items',
    fields: [
      field('creator'),
      field('date', 'Created'),
      field('owner'),
      field('location'),
    ],
    sections: ['Description', 'History', 'Powers and properties'],
  },
  {
    type: 'event',
    label: 'Event',
    plural: 'Events',
    fields: [
      field('date'),
      field('start'),
      field('end'),
      field('location'),
      field('members', 'Participants'),
    ],
    sections: ['Background', 'Course of events', 'Aftermath'],
  },
  {
    type: 'concept',
    label: 'Concept',
    plural: 'Concepts',
    fields: [
      field('creator', 'Originator'),
      field('date', 'First recorded'),
    ],
    sections: ['Definition', 'Origins', 'In practice'],
  },
  {
    type: 'species',
    label: 'Species',
    plural: 'Species',
    fields: [
      field('location', 'Native to'),
      field('height', 'Typical height'),
      field('eyes'),
      field('hair', 'Hair or fur'),
    ],
    sections: ['Description', 'Biology', 'Habitat', 'Behavior'],
  },
  {
    type: 'culture',
    label: 'Culture',
    plural: 'Cultures',
    fields: [
      field('location', 'Region'),
      field('species', 'People'),
      field('founded', 'Emerged'),
      field('leader'),
    ],
    sections: ['History', 'Beliefs', 'Customs', 'Language'],
  },
  {
    type: 'organization',
    label: 'Organization',
    plural: 'Organizations',
    fields: [
      field('founded'),
      field('dissolved'),
      field('leader'),
      field('members'),
      field('location', 'Headquarters'),
      field('owner', 'Parent body'),
      field('affiliation'),
    ],
    sections: ['History', 'Structure', 'Activities', 'Notable members'],
  },
];

export const DEFAULT_TYPE = 'article';

/**
 * The built-in names and field labels in the interface language. The English in TEMPLATES
 * stays as it is, because keys and stored pages depend on it. Read at the moment of use.
 */
function builtInText(): Record<string, string> {
  return {
    // Field labels.
    Born: t('Born'),
    Died: t('Died'),
    Age: t('Age'),
    Species: t('Species'),
    Gender: t('Gender'),
    Affiliation: t('Affiliation'),
    Location: t('Location'),
    Founded: t('Founded'),
    Dissolved: t('Dissolved'),
    Date: t('Date'),
    Began: t('Began'),
    Ended: t('Ended'),
    Parents: t('Parents'),
    Spouse: t('Spouse'),
    Children: t('Children'),
    Leader: t('Leader'),
    Members: t('Members'),
    Owner: t('Owner'),
    Creator: t('Creator'),
    Height: t('Height'),
    Eyes: t('Eyes'),
    Hair: t('Hair'),
    Home: t('Home'),
    'Part of': t('Part of'),
    Abandoned: t('Abandoned'),
    Ruler: t('Ruler'),
    'Controlled by': t('Controlled by'),
    'Notable members': t('Notable members'),
    Headquarters: t('Headquarters'),
    Allies: t('Allies'),
    Created: t('Created'),
    Participants: t('Participants'),
    Originator: t('Originator'),
    'First recorded': t('First recorded'),
    'Native to': t('Native to'),
    'Typical height': t('Typical height'),
    'Hair or fur': t('Hair or fur'),
    Region: t('Region'),
    People: t('People'),
    Emerged: t('Emerged'),
    'Parent body': t('Parent body'),
  };
}

/** A built-in field label in the interface language. A label the writer typed is kept. */
export function fieldLabel(label: string): string {
  return builtInText()[label] ?? label;
}

/** The name and plural of each built-in type, in the interface language. */
function builtInTypeNames(): Record<string, { label: string; plural: string }> {
  return {
    article: { label: t('Blank article'), plural: t('Articles') },
    character: { label: t('Character'), plural: t('Characters') },
    place: { label: t('Place'), plural: t('Places') },
    faction: { label: t('Faction'), plural: t('Factions') },
    item: { label: t('Item'), plural: t('Items') },
    event: { label: t('Event'), plural: t('Events') },
    concept: { label: t('Concept'), plural: t('Concepts') },
    species: { label: t('Species'), plural: t('Species') },
    culture: { label: t('Culture'), plural: t('Cultures') },
    organization: { label: t('Organization'), plural: t('Organizations') },
  };
}

/** A template's name for a menu of types, in the interface language for a built-in type. */
export function templateLabel(template: PageTemplate): string {
  return isBuiltInType(template.type) ? (builtInTypeNames()[template.type]?.label ?? template.label) : template.label;
}

// The writer's own types. `pageTypes.ts` keeps this up to date from the project.
let customTemplates: PageTemplate[] = [];

export function setCustomTemplates(list: PageTemplate[]) {
  customTemplates = list;
}

/** Every type a new page can have: the built-in ones, then the writer's own. */
export function allTemplates(): PageTemplate[] {
  return [...TEMPLATES, ...customTemplates];
}

export function isBuiltInType(type: string): boolean {
  return TEMPLATES.some((t) => t.type === type);
}

export function templateFor(type: string): PageTemplate {
  return allTemplates().find((t) => t.type === type) ?? TEMPLATES[0];
}

/** A page keeps its type when that type is deleted, so any stored type must have a name. */
function humanize(type: string): string {
  const words = type.replace(/_/g, ' ');
  return words ? words[0].toUpperCase() + words.slice(1) : t('Article');
}

export function typeLabel(type: string): string {
  if (type === 'home') return t('Main page');
  if (type === DEFAULT_TYPE) return t('Article');
  if (isBuiltInType(type)) return builtInTypeNames()[type]?.label ?? humanize(type);
  return allTemplates().find((t) => t.type === type)?.label ?? humanize(type);
}

export function typePlural(type: string): string {
  if (isBuiltInType(type)) return builtInTypeNames()[type]?.plural ?? typeLabel(type);
  return allTemplates().find((t) => t.type === type)?.plural ?? typeLabel(type);
}

/** A reasonable plural for a name the writer typed. They can change it. */
export function pluralOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  if (/(s|x|z|ch|sh)$/i.test(trimmed)) return `${trimmed}es`;
  if (/[^aeiou]y$/i.test(trimmed)) return `${trimmed.slice(0, -1)}ies`;
  return `${trimmed}s`;
}

/** A lead paragraph, then each section heading with room to write under it. */
export function templateBody(template: PageTemplate): PmNode {
  const content: PmNode[] = [{ type: 'paragraph' }];
  for (const section of template.sections) {
    content.push(
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: section }] },
      { type: 'paragraph' },
    );
  }
  return { type: 'doc', content };
}

/** A new page's labels are in the interface language. Its keys never change. */
export function templateInfobox(template: PageTemplate): Infobox {
  return { fields: template.fields.map((f) => ({ ...f, label: fieldLabel(f.label) })) };
}

/** Adds a template's fields that the infobox lacks, keeping everything already there. */
export function mergeTemplateFields(infobox: Infobox, template: PageTemplate): Infobox {
  const have = new Set(infobox.fields.map((f) => f.key));
  const missing = template.fields.filter((f) => !have.has(f.key)).map((f) => ({ ...f, label: fieldLabel(f.label) }));
  return missing.length > 0 ? { ...infobox, fields: [...infobox.fields, ...missing] } : infobox;
}
