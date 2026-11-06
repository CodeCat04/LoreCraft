/**
 * What the wiki's page templates give each infobox field, so that an imported page reads
 * the same as one made in the app. The keys are listed in docs/IMPORT_FORMAT.md.
 */

import { FIELD_KINDS as WIKI_KINDS } from '../../wiki/infobox';
import { SEMANTIC_FIELDS, templateFor } from '../../wiki/templates';

export const FIELD_KINDS: string[] = WIKI_KINDS.map((k) => k.kind);

export const KNOWN_FIELDS: Record<string, { label: string; kind: string }> = SEMANTIC_FIELDS;

/** "Trade routes" from "trade_routes". */
function labelFromKey(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The name for a field the file did not name. A character's `location` reads "Home". */
export function fieldLabel(key: string, pageType?: string): string {
  const inTemplate = pageType ? templateFor(pageType).fields.find((f) => f.key === key) : undefined;
  return inTemplate?.label ?? SEMANTIC_FIELDS[key]?.label ?? labelFromKey(key);
}

/**
 * The kind for a field the file did not give one. Values that do not suit the usual kind
 * change it, so that "about 30" is not marked as a bad number, and two leaders both link.
 */
export function fieldKind(key: string, value: string, isList = false): string {
  const kind = SEMANTIC_FIELDS[key]?.kind ?? 'text';
  if (kind === 'number' && value.trim() !== '' && Number.isNaN(Number(value))) return 'text';
  return kind === 'page' && isList ? 'pages' : kind;
}
