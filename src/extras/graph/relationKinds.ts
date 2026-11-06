/** What relationship kinds mean when read from either end. */

import { currentLocale, t } from '../../lib/i18n';
import type { RelationKind, Relationship } from '../api';

/** Whether it reads the same from both pages, so one direction is as good as the other. */
export function isSymmetric(rel: Pick<Relationship, 'kind' | 'inverse'>): boolean {
  return !!rel.inverse && rel.inverse.toLowerCase() === rel.kind.toLowerCase();
}

/** Every name a kind goes by, for suggesting as the writer types. */
export function kindSuggestions(kinds: RelationKind[]): string[] {
  const names = new Set<string>();
  for (const { kind, inverse } of kinds) {
    names.add(kind);
    names.add(inverse);
  }
  return [...names];
}

export interface KindSides {
  /** What it reads as from the other page, if known. */
  other: string | null;
  /** The app fixes what this one means, so the project cannot redeclare it. */
  builtin: boolean;
}

/** What a typed kind is known to mean. Either name of a pair will do. */
export function kindSides(kinds: RelationKind[], typed: string): KindSides {
  // The backend tidies spaces the same way before it compares.
  const lowered = typed.trim().replace(/\s+/g, ' ').toLowerCase();
  for (const { kind, inverse, builtin } of kinds) {
    if (kind.toLowerCase() === lowered) return { other: inverse, builtin };
    if (inverse.toLowerCase() === lowered) return { other: kind, builtin };
  }
  return { other: null, builtin: false };
}

/** The app's own kinds, as people read them. Read each time, so they follow the interface language. */
const BUILTIN_LABELS: Record<string, () => string> = {
  'parent of': () => t('parent of'),
  'child of': () => t('child of'),
  spouse: () => t('spouse'),
  sibling: () => t('sibling'),
  ally: () => t('ally'),
  enemy: () => t('enemy'),
  rival: () => t('rival'),
  friend: () => t('friend'),
  related: () => t('related'),
  'mentor of': () => t('mentor of'),
  'student of': () => t('student of'),
  'member of': () => t('member of'),
  'has member': () => t('has member'),
  'leader of': () => t('leader of'),
  'led by': () => t('led by'),
  'located in': () => t('located in'),
  contains: () => t('contains'),
  'part of': () => t('part of'),
  includes: () => t('includes'),
  'owner of': () => t('owner of'),
  'owned by': () => t('owned by'),
  'creator of': () => t('creator of'),
  'created by': () => t('created by'),
  'ruler of': () => t('ruler of'),
  'ruled by': () => t('ruled by'),
};

/**
 * How a kind reads on screen. The kind itself is data and stays as stored. In English
 * it shows as the writer typed it, and a writer's own kinds do in every language.
 */
export function kindLabel(kind: string): string {
  if (currentLocale() === 'en') return kind;
  const key = kind.trim().replace(/\s+/g, ' ').toLowerCase();
  return Object.hasOwn(BUILTIN_LABELS, key) ? BUILTIN_LABELS[key]() : kind;
}

/** Parent and spouse relationships also appear in infobox fields. */
export function isFamilyKind(kind: string): boolean {
  const lowered = kind.trim().toLowerCase();
  return lowered === 'parent of' || lowered === 'child of' || lowered === 'spouse';
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/** How a relationship reads from one page, as text around the other page's name. */
export interface RelationReading {
  before: string;
  otherId: string;
  otherTitle: string;
  after: string;
}

export function readRelationship(rel: Relationship, pageId: string): RelationReading {
  const isFrom = rel.fromPageId === pageId;
  const otherId = isFrom ? rel.toPageId : rel.fromPageId;
  const otherTitle = isFrom ? rel.toTitle : rel.fromTitle;
  if (isSymmetric(rel)) {
    return { before: `${capitalize(kindLabel(rel.kind))}: `, otherId, otherTitle, after: '' };
  }
  if (isFrom) return { before: `${capitalize(kindLabel(rel.kind))} `, otherId, otherTitle, after: '' };
  if (rel.inverse) return { before: `${capitalize(kindLabel(rel.inverse))} `, otherId, otherTitle, after: '' };
  // An unknown word has no known opposite, so it is reported from the other side.
  return { before: '', otherId, otherTitle, after: ` ${t('({kind} this page)', { kind: kindLabel(rel.kind) })}` };
}
