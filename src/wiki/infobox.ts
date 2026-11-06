/** Rules for reading and editing infobox data. */

import { normalizeChanges } from '../lib/facts';
import { t } from '../lib/i18n';
import type { Infobox, InfoboxField, InfoboxFieldKind } from '../lib/types';

// Each label is read when shown, so it follows the interface language.
export const FIELD_KINDS: { kind: InfoboxFieldKind; label: string }[] = [
  { kind: 'text', get label() { return t('Text'); } },
  { kind: 'longtext', get label() { return t('Long text'); } },
  { kind: 'date', get label() { return t('Date'); } },
  { kind: 'number', get label() { return t('Number'); } },
  { kind: 'page', get label() { return t('Page link'); } },
  { kind: 'pages', get label() { return t('Page links'); } },
];

const KINDS = new Set(FIELD_KINDS.map((k) => k.kind));

/** Stored data comes from older versions and imports, so nothing about it is assumed. */
export function normalizeInfobox(raw: unknown): Infobox {
  const data = (raw && typeof raw === 'object' ? raw : {}) as Partial<Infobox>;
  const fields = Array.isArray(data.fields) ? data.fields : [];
  const box: Infobox = {
    fields: fields
      .filter((f): f is InfoboxField => Boolean(f) && typeof f === 'object')
      .map(({ changes: stored, ...f }) => {
        const field: InfoboxField = {
          ...f,
          key: String(f.key ?? ''),
          label: String(f.label ?? f.key ?? ''),
          kind: KINDS.has(f.kind) ? f.kind : 'text',
          value: String(f.value ?? ''),
        };
        const changes = normalizeChanges(stored);
        return changes ? { ...field, changes } : field;
      }),
  };
  if (data.imageAssetId) box.imageAssetId = String(data.imageAssetId);
  if (data.caption) box.caption = String(data.caption);
  return box;
}

/** The titles in a `pages` field. */
export function splitTitles(value: string): string[] {
  return value.split(',').map((t) => t.trim()).filter(Boolean);
}

/** What a reader sees: empty fields stay out of the article, unless they gain a value later. */
export function visibleFields(infobox: Infobox): InfoboxField[] {
  return infobox.fields.filter((f) => f.value.trim() !== '' || (f.changes?.length ?? 0) > 0);
}

export function hasVisibleInfobox(infobox: Infobox): boolean {
  return Boolean(infobox.imageAssetId) || visibleFields(infobox).length > 0;
}

/** A stable key for a field the user named, unique among the keys given. */
export function keyFromLabel(label: string, taken: Iterable<string>): string {
  const base =
    label
      .normalize('NFD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '_')
      .replace(/^_+|_+$/g, '') || 'field';
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

/** Moves one item, leaving the array alone if that would go past either end. */
export function moved<T>(items: T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** Lines for comparing two versions of an infobox as text. */
export function infoboxLines(infobox: Infobox): string[] {
  return visibleFields(infobox).flatMap((f) => [
    `${f.label}: ${f.value}`,
    ...(f.changes ?? []).map((c) => `${f.label} changes to ${c.value}${c.date ? ` on ${c.date}` : ''}${c.note ? ` (${c.note})` : ''}`),
  ]);
}
