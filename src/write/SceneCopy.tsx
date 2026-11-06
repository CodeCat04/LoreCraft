/**
 * A read-only copy of a scene, for a pane that cannot edit it: the scene is being edited in the
 * other pane, or it belongs to a book other than the one the Write area is on. It follows the
 * stored text and never writes anything, so it cannot overwrite the real editor's work.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';

import * as api from './api';
import { nameHighlightForScene, useNameHighlightSync } from './SceneEditor';
import { displayTitle } from './tree';
import { RichEditor } from '../editor';
import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import type { Node } from '../lib/types';
import { useDataVersion } from '../state/events';
import { useLocale } from '../state/language';

/** How long the copy waits after a save, so that a burst of them is one reload. */
const FOLLOW_DELAY_MS = 250;

export function SceneCopy(props: { sceneId: string; note: string; action?: { label: string; run: () => void } }) {
  useLocale();
  const { sceneId, note, action } = props;
  const [node, setNode] = useState<Node | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const changed = useDataVersion('nodeContent', 'nodes', `doc:node:${sceneId}`);
  const loadedId = useRef<string | null>(null);
  const extensions = useMemo(() => [nameHighlightForScene()], []);
  useNameHighlightSync(useCallback(() => editorRef.current, []));

  useEffect(() => {
    let cancelled = false;
    const first = loadedId.current !== sceneId;
    const timer = window.setTimeout(
      () => {
        api.nodes.get(sceneId).then(
          (fresh) => {
            if (cancelled) return;
            setProblem(null);
            const editor = editorRef.current;
            if (loadedId.current === sceneId && editor && !editor.isDestroyed) {
              // In place, so the reader keeps their spot in the text.
              if (!editor.schema.nodeFromJSON(fresh.content).eq(editor.state.doc)) {
                editor.commands.setContent(fresh.content, { emitUpdate: false });
              }
            }
            loadedId.current = sceneId;
            setNode(fresh);
          },
          (e) => {
            if (!cancelled) setProblem(errorMessage(e));
          },
        );
      },
      first ? 0 : FOLLOW_DELAY_MS,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [sceneId, changed]);

  if (problem) {
    return (
      <div className="view-pad" role="alert">
        <p>{t('This scene could not be opened: {reason}', { reason: problem })}</p>
      </div>
    );
  }
  if (!node) return <div className="write-loading" />;
  const title = displayTitle(node);
  return (
    <div className="scene-layout">
      <div className="write-scroll">
        <div className="write-page scene-copy">
          <div className="doc-copy-note" role="note">
            <span>{note}</span>
            {action && (
              <button type="button" className="btn btn-sm" onClick={action.run}>
                {action.label}
              </button>
            )}
          </div>
          <h1 className="scene-title">{title}</h1>
          <RichEditor
            docKey={`copy:${node.id}`}
            content={node.content}
            editable={false}
            variant="manuscript"
            toolbar={false}
            source={{ kind: 'node', id: node.id, title }}
            extensions={extensions}
            onReady={(editor) => {
              editorRef.current = editor;
            }}
          />
        </div>
      </div>
    </div>
  );
}
