/**
 * Every kind of proposal the app can show, apply and undo. A kind's name matches the
 * `kind` its Rust write tool stores. To add one, write `<kind>.tsx` beside this file and add
 * one line to `KINDS`. See "Adding an MCP tool" in docs/MCP.md.
 */

import type { ProposalKind } from './types';
import { newPageKind } from './newPage';
import { newChapterKind, newSceneKind } from './newScene';
import { sceneDetailsKind } from './sceneDetails';
import { styleGuideKind } from './styleGuide';
import { editKind, insertKind, rewriteKind } from './text';

export const KINDS: ProposalKind[] = [
  editKind,
  rewriteKind,
  insertKind,
  newPageKind,
  newSceneKind,
  newChapterKind,
  sceneDetailsKind,
  styleGuideKind,
];

const byName = new Map(KINDS.map((kind) => [kind.kind, kind]));

/** The kind of this name, or undefined for one this version of the app does not know. */
export function kindFor(name: string): ProposalKind | undefined {
  return byName.get(name);
}

export type { ApplyResult, ProposalKind, UndoResult } from './types';
export { defineKind } from './types';
