/**
 * Editing a page or scene right on its card. It saves through the same queues as the page and
 * scene editors (`page:<id>`, `node:<id>`), so whichever view wrote last is what is waiting,
 * and a view opened later carries on from it. A card narrowed to one heading edits only that
 * section; the blocks around it are taken once when editing starts and put back on each save.
 */

import { useEffect, useRef, useState } from 'react';

import * as api from '../lib/api';
import { t } from '../lib/i18n';
import type { PmNode } from '../lib/types';
import { RichEditor } from '../editor/RichEditor';
import { unwrittenValue, useDocSaver } from '../editor/saving';
import { wikiPages } from '../wiki/api';
import { markSceneDirty, saveSceneContent } from '../write/store';
import { sceneLabel, sceneSaverKey } from '../write/shared';
import { headingRange, spliceRange } from './cards';
import type { LoreRef } from './model';

interface Loaded {
  title: string;
  full: PmNode;
  range: [number, number] | null;
}

type PagePatch = Parameters<typeof wikiPages.saveFromEditor>[1];

export function DocCardEditor({ loreRef, onStop }: { loreRef: LoreRef; onStop: () => void }) {
  const [loaded, setLoaded] = useState<Loaded | null | 'missing'>(null);
  useEffect(() => {
    let cancelled = false;
    const load =
      loreRef.kind === 'page'
        ? api.pages.get(loreRef.id).then((p) => ({ deleted: !!p.deletedAt, title: p.title, content: unwrittenValue<PagePatch>(`page:${p.id}`)?.content ?? p.content }))
        : api.nodes.get(loreRef.id).then((n) => ({ deleted: !!n.deletedAt, title: n.title, content: unwrittenValue<PmNode>(sceneSaverKey(n.id)) ?? n.content }));
    load.then(
      (doc) => {
        if (cancelled) return;
        if (doc.deleted) return setLoaded('missing');
        setLoaded({ title: doc.title || t('Untitled scene'), full: doc.content as PmNode, range: headingRange(doc.content as PmNode, loreRef.heading) });
      },
      () => !cancelled && setLoaded('missing'),
    );
    return () => {
      cancelled = true;
    };
  }, [loreRef.kind, loreRef.id, loreRef.heading]);
  if (loaded === 'missing') return <div className="canvas-placeholder">{t('This was deleted or is in the trash.')}</div>;
  if (!loaded) return <div className="canvas-placeholder">{t('Loading…')}</div>;
  return loreRef.kind === 'page' ? (
    <PageCardEditor id={loreRef.id} loaded={loaded} onStop={onStop} />
  ) : (
    <SceneCardEditor id={loreRef.id} loaded={loaded} onStop={onStop} />
  );
}

function PageCardEditor({ id, loaded, onStop }: { id: string; loaded: Loaded; onStop: () => void }) {
  const saver = useDocSaver<PagePatch>((patch) => wikiPages.saveFromEditor(id, patch), {
    key: `page:${id}`,
    label: () => t('the page “{title}”', { title: loaded.title }),
    merge: (older, newer) => ({ ...older, ...newer }),
  });
  return <Editing kind="page" id={id} loaded={loaded} onStop={onStop} onDoc={(content) => saver.schedule({ content } as PagePatch)} />;
}

function SceneCardEditor({ id, loaded, onStop }: { id: string; loaded: Loaded; onStop: () => void }) {
  const saver = useDocSaver<PmNode>((doc) => saveSceneContent(id, doc), { key: sceneSaverKey(id), label: () => sceneLabel(id) });
  return (
    <Editing
      kind="node"
      id={id}
      loaded={loaded}
      onStop={onStop}
      onDoc={(doc) => {
        markSceneDirty(id);
        saver.schedule(doc);
      }}
    />
  );
}

function Editing(props: { kind: 'page' | 'node'; id: string; loaded: Loaded; onStop: () => void; onDoc: (doc: PmNode) => void }) {
  const { kind, id, loaded, onStop, onDoc } = props;
  const part = useRef(loaded.range ? { ...loaded.full, content: (loaded.full.content ?? []).slice(...loaded.range) } : loaded.full);
  return (
    <div
      className="canvas-doc-editor"
      data-editing-kind={kind}
      onKeyDown={(e) => {
        e.stopPropagation();
        // Popups in the editor that close on Escape stop it before it gets here.
        if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          onStop();
        }
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <RichEditor
        docKey={`canvas-card:${kind}:${id}`}
        content={part.current}
        editable
        source={{ kind, id, title: loaded.title }}
        toolbar={false}
        comments={false}
        onReady={(editor) => editor.commands.focus('end')}
        onChange={(doc) => onDoc(spliceRange(loaded.full, loaded.range, doc))}
      />
    </div>
  );
}
