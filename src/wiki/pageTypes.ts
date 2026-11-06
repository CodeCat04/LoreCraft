/**
 * The page types in a project: the built-in ones plus the writer's own, stored in project
 * meta so they travel with the file. Other modules read them through `usePageTypes` or
 * `allPageTypes`. Changing or deleting a type never changes existing pages.
 */

import { useEffect } from 'react';
import { create } from 'zustand';

import { normalizeInfobox } from './infobox';
import { TEMPLATES, allTemplates, pluralOf, setCustomTemplates, type PageTemplate } from './templates';
import { useDataVersion } from '../state/events';
import * as api from '../lib/api';

const META_KEY = 'pageTypes';

interface PageTypesStore {
  /** Built-in types first, then the writer's own. */
  types: PageTemplate[];
  custom: PageTemplate[];
}

export const usePageTypes = create<PageTypesStore>(() => ({ types: TEMPLATES, custom: [] }));

/** Every page type, for code outside React. */
export function allPageTypes(): PageTemplate[] {
  return allTemplates();
}

/** Stored data can come from anywhere, so nothing about it is assumed. */
export function parseCustomTypes(stored: string | null): PageTemplate[] {
  if (!stored) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(stored);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const taken = new Set(TEMPLATES.map((t) => t.type));
  const types: PageTemplate[] = [];
  for (const item of raw as Partial<PageTemplate>[]) {
    const type = typeof item?.type === 'string' ? item.type.trim() : '';
    const label = typeof item?.label === 'string' ? item.label.trim() : '';
    if (!type || !label || taken.has(type)) continue;
    taken.add(type);
    types.push({
      type,
      label,
      plural: typeof item.plural === 'string' && item.plural.trim() ? item.plural.trim() : pluralOf(label),
      description: typeof item.description === 'string' ? item.description : '',
      fields: normalizeInfobox({ fields: item.fields }).fields.map(({ key, label, kind }) => ({ key, label, kind, value: '' })),
      sections: Array.isArray(item.sections) ? item.sections.map(String).filter((s) => s.trim()) : [],
    });
  }
  return types;
}

function apply(custom: PageTemplate[]) {
  setCustomTemplates(custom);
  usePageTypes.setState({ custom, types: [...TEMPLATES, ...custom] });
}

export async function loadPageTypes() {
  apply(parseCustomTypes(await api.project.getMeta(META_KEY)));
}

/** Keeps the list in step with the open project. */
export function useSyncPageTypes() {
  const version = useDataVersion('meta');
  useEffect(() => {
    void loadPageTypes().catch(() => {});
  }, [version]);
}

async function store(custom: PageTemplate[]) {
  await api.project.setMeta(META_KEY, JSON.stringify(custom));
  apply(custom);
}

/** Adds a type, or replaces the one with the same `type`. */
export async function savePageType(type: PageTemplate) {
  const { custom } = usePageTypes.getState();
  const exists = custom.some((t) => t.type === type.type);
  await store(exists ? custom.map((t) => (t.type === type.type ? type : t)) : [...custom, type]);
}

export async function deletePageType(type: string) {
  await store(usePageTypes.getState().custom.filter((t) => t.type !== type));
}
