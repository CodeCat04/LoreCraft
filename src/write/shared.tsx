/** Small pieces used by several Write screens. */

import { useEffect, useRef, useState } from 'react';

import type { NodePatch } from './api';
import { contentChanged, requestSync, showPatch, useWrite, writeNode } from './store';
import { displayTitle } from './tree';
import { useDocSaver } from '../editor/saving';
import { t } from '../lib/i18n';
import type { NodeStatus } from '../lib/types';
import { useDataVersion } from '../state/events';
import { useProject } from '../state/project';

const STATUS_LABELS: { value: NodeStatus; label: () => string }[] = [
  { value: 'idea', label: () => t('Idea') },
  { value: 'outline', label: () => t('Outline') },
  { value: 'draft', label: () => t('Draft') },
  { value: 'revised', label: () => t('Revised') },
  { value: 'final', label: () => t('Final') },
];

/** The statuses in order, named in the interface language. Call it while rendering. */
export function statuses(): { value: NodeStatus; label: string }[] {
  return STATUS_LABELS.map((s) => ({ value: s.value, label: s.label() }));
}

export function statusLabel(status: NodeStatus): string {
  return STATUS_LABELS.find((s) => s.value === status)?.label() ?? status;
}

/** The small colored marker for a scene's status. The shape changes with it too. */
export function StatusMarker({ status }: { status: NodeStatus }) {
  return <span className={`node-status node-status-${status}`} title={statusLabel(status)} aria-hidden="true" />;
}

/** Keeps the shared tree current. Mount it in anything that shows the book. */
export function WriteDataSync() {
  const structure = useDataVersion('books', 'nodes');
  const content = useDataVersion('nodeContent');
  const isOpen = useProject((s) => s.status.open);
  useEffect(() => {
    if (isOpen) requestSync(0);
  }, [structure, isOpen]);
  useEffect(() => {
    contentChanged(content);
  }, [content]);
  return null;
}

/** The saving queue for a scene's text, which a view opening it again carries on from. */
export const sceneSaverKey = (id: string) => `node:${id}`;
/** The saving queue for a scene's title and details. */
export const nodeFieldsSaverKey = (id: string) => `node-fields:${id}`;

/** Names a scene for the message when something in it could not be stored. */
export function sceneLabel(id: string): string {
  const node = useWrite.getState().index.byId.get(id);
  return t('the scene “{title}”', { title: node ? displayTitle(node) : t('Untitled scene') });
}

function mergeNodePatches(older: NodePatch, newer: NodePatch): NodePatch {
  return { ...older, ...newer };
}

/**
 * Batches field edits to one node and shows them at once. The fields can change one
 * after another inside the save delay, and each write must carry all of them. A field
 * stays in the batch until a write of it has succeeded, and a failed write is tried again.
 */
export function useNodePatcher(id: string) {
  const { schedule, flush } = useDocSaver<NodePatch>(
    async (patch) => {
      await writeNode(id, patch, { keepOnFailure: true });
    },
    { key: nodeFieldsSaverKey(id), label: () => sceneLabel(id), merge: mergeNodePatches },
  );
  const scheduleRef = useRef(schedule);
  scheduleRef.current = schedule;
  const patch = useRef((change: NodePatch) => {
    showPatch(id, change);
    scheduleRef.current(change);
  });
  return { patch: patch.current, flush };
}

/**
 * Text that is edited in place and written when it loses focus or Enter is pressed. It
 * follows changes from elsewhere unless it is being edited.
 */
export function InlineText(props: {
  value: string;
  label: string;
  placeholder?: string;
  className?: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      className={`input inline-text ${props.className ?? ''}`}
      aria-label={props.label}
      placeholder={props.placeholder}
      title={props.value || undefined}
      value={draft ?? props.value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft !== props.value) props.onCommit(draft);
        setDraft(null);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setDraft(null);
          e.stopPropagation();
        }
      }}
    />
  );
}
