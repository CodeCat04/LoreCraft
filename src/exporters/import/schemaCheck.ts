/** Holds a document up against the editor's schema, so a bad one is caught at import. */

import { getSchema } from '@tiptap/core';
import { Node as ProseNode } from '@tiptap/pm/model';

import { documentExtensions } from '../../editor/schema';
import { t } from '../../lib/i18n';
import type { PmNode } from '../../lib/types';

let schema: ReturnType<typeof getSchema> | null = null;

export function documentSchema() {
  schema ??= getSchema(documentExtensions());
  return schema;
}

/** JSON nested deeper than this cannot cross to the native side. */
const DEEPEST_DOCUMENT = 110;

function depthOf(value: unknown, limit: number): number {
  if (limit <= 0 || value === null || typeof value !== 'object') return 0;
  let deepest = 0;
  for (const child of Object.values(value)) {
    deepest = Math.max(deepest, depthOf(child, limit - 1));
    if (deepest >= limit - 1) break;
  }
  return deepest + 1;
}

/** The reason a document cannot be stored, or null if it can. */
export function documentProblem(doc: PmNode): string | null {
  if (depthOf(doc, DEEPEST_DOCUMENT + 1) > DEEPEST_DOCUMENT) {
    return 'is nested too deeply to store';
  }
  try {
    ProseNode.fromJSON(documentSchema(), doc).check();
    return null;
  } catch (error) {
    return t('is not a valid document: {error}', { error: error instanceof Error ? error.message : String(error) });
  }
}
