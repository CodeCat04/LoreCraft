/**
 * What a kind of proposal declares. A kind matches the `kind` a Rust write tool puts in its
 * `Draft` (see `src-tauri/src/mcp/write.rs`). One file per kind, in this folder, listed once
 * in `index.ts`. See "Adding an MCP tool" in docs/MCP.md.
 */

import type { ComponentType } from 'react';

import type { AnyProposal } from '../api';

export type ApplyResult =
  | {
      ok: true;
      /** A document this replaced, so an open editor reloads it. */
      target?: { targetKind: string; targetId: string };
      /** What `undo` needs later: a revision id, created ids, a stamp to compare. Kept as JSON. */
      undo?: unknown;
    }
  | { ok: false; reason: string };

export type UndoResult = { ok: true } | { ok: false; reason: string };

export interface ProposalKind<P = object> {
  kind: string;
  /** The card body in Outside suggestions, for a waiting suggestion and an applied change. */
  Card: ComponentType<{ proposal: AnyProposal<P> }>;
  /**
   * Makes the change. Accept and the edit level both run this, so open editors, History,
   * figure safety and stores stay right either way. It must not resolve the proposal: the
   * caller does. Return `{ ok: false, reason }` rather than throwing for an expected problem.
   */
  apply: (proposal: AnyProposal<P>) => Promise<ApplyResult>;
  /**
   * Takes an applied change back, from the `undo` its apply returned (in `payload.undo`) and
   * the old values in the payload. Must refuse, with a clear reason, if the target has
   * changed since. Without it, the applied change shows with no Undo button.
   */
  undo?: (proposal: AnyProposal<P>, undo: unknown) => Promise<UndoResult>;
  /** The toast once accepted, such as "Page created as a draft." */
  accepted: () => string;
  /** Text kinds can also be reviewed inside the document, change by change. */
  reviewable?: boolean;
}

/** Keeps a kind's payload type checked inside its own file, and erases it for the registry. */
export function defineKind<P>(kind: ProposalKind<P>): ProposalKind {
  return kind as unknown as ProposalKind;
}
