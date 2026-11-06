/**
 * Every scene of a chapter as one continuous read-only text. Clicking the text opens that
 * spot in the editor. Each scene loads when it comes near the screen, so a long chapter
 * opens as quickly as a short one, and space is held for it by its word count.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';

import { loadScene, newScene, openScene, openSceneAt, useWrite } from './store';
import { nameHighlightForScene, useNameHighlightSync } from './SceneEditor';
import { chapterOf, childrenOf, displayTitle, type TreeIndex } from './tree';
import { wordsText } from './WriteStatus';
import { RichEditor } from '../editor';
import { t } from '../lib/i18n';
import type { Node, NodeMeta, PmNode } from '../lib/types';
import { useLocale } from '../state/language';

/** Rough height of a word of manuscript text, in em, to hold space before it loads. */
const EM_PER_WORD = 0.135;

function ReadScene({ node, active }: { node: Node; active: boolean }) {
  const editorRef = useRef<Editor | null>(null);
  const extensions = useMemo(() => [nameHighlightForScene()], []);
  useNameHighlightSync(useCallback(() => editorRef.current, []));

  const onClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    // Links keep their own behavior, and text being selected is not a click.
    if (target.closest('a') || !window.getSelection()?.isCollapsed) return;
    if (e.ctrlKey || e.metaKey) return;
    const at = editorRef.current?.view.posAtCoords({ left: e.clientX, top: e.clientY });
    if (at) openSceneAt(node.id, at.pos);
    else openScene(node.id);
  };

  return (
    // The whole text is one big click target. The keyboard equivalent is the title button.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div className={`read-scene-text${active ? ' is-active' : ''}`} onClick={onClick}>
      <RichEditor
        docKey={`read:${node.id}:${node.updatedAt}`}
        content={node.content}
        editable={false}
        variant="manuscript"
        toolbar={false}
        source={{ kind: 'node', id: node.id, title: displayTitle(node) }}
        extensions={extensions}
        onReady={(editor) => {
          editorRef.current = editor;
        }}
      />
    </div>
  );
}

/** Loads and shows one scene once it is close to being visible. */
function ReadSection({ scene, active }: { scene: NodeMeta; active: boolean }) {
  useLocale();
  const ref = useRef<HTMLElement>(null);
  const [near, setNear] = useState(active);
  const [node, setNode] = useState<Node | null>(null);

  useEffect(() => {
    if (near) return;
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { root: el.closest('.write-scroll'), rootMargin: '100% 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [near]);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    void loadScene(scene.id).then((loaded) => {
      if (!cancelled) setNode(loaded);
    });
    return () => {
      cancelled = true;
    };
    // A saved edit elsewhere gives a new `updatedAt`, which reloads the text.
  }, [near, scene.id, scene.updatedAt]);

  const holdEm = Math.max(4, scene.wordCount * EM_PER_WORD);

  return (
    <section ref={ref} className="read-scene" data-scene-id={scene.id}>
      <header className="read-scene-head">
        <button type="button" className="link-button read-scene-title" onClick={() => openScene(scene.id)}>
          {displayTitle(scene)}
        </button>
        <span className="read-scene-words">{wordsText(scene.wordCount)}</span>
      </header>
      {node && isEmptyDoc(node.content) && (
        <button type="button" className="link-button read-scene-empty" onClick={() => openScene(scene.id)}>
          {t('Nothing written yet')}
        </button>
      )}
      {node && !isEmptyDoc(node.content) && <ReadScene node={node} active={active} />}
      {!node && <div className="read-scene-hold" style={{ minHeight: `${holdEm}em` }} />}
    </section>
  );
}

function isEmptyDoc(doc: PmNode): boolean {
  const blocks = doc.content ?? [];
  return blocks.length === 0 || (blocks.length === 1 && blocks[0].type === 'paragraph' && !blocks[0].content?.length);
}

/** The chapter to show for whatever is selected: its own, or the first in the book. */
function chapterToRead(index: TreeIndex, nodeId: string | undefined): NodeMeta | undefined {
  if (nodeId) {
    const found = chapterOf(index, nodeId);
    if (found) return found;
    const node = index.byId.get(nodeId);
    if (node?.kind === 'part') {
      const first = childrenOf(index, node.id).find((c) => c.kind === 'chapter');
      if (first) return first;
    }
  }
  return index.chapters[0];
}

export function ReadThrough({ nodeId }: { nodeId?: string }) {
  useLocale();
  const index = useWrite((s) => s.index);
  const chapter = chapterToRead(index, nodeId);
  const scenes = chapter ? childrenOf(index, chapter.id).filter((c) => c.kind === 'scene') : [];
  const scrollerRef = useRef<HTMLDivElement>(null);
  const scrollTo = nodeId && index.byId.get(nodeId)?.kind === 'scene' ? nodeId : null;

  // A selected scene is where the reader wants to start.
  useLayoutEffect(() => {
    if (!scrollTo) return;
    scrollerRef.current
      ?.querySelector(`[data-scene-id="${scrollTo}"]`)
      ?.scrollIntoView({ block: 'start' });
  }, [scrollTo]);

  if (!chapter) {
    return (
      <div className="write-empty">
        <h1 className="write-empty-title">{t('No chapters yet')}</h1>
        <p className="muted">{t('Add a scene and a chapter will be made to hold it.')}</p>
        <button type="button" className="btn btn-primary" onClick={() => void newScene()}>
          {t('Add a scene')}
        </button>
      </div>
    );
  }

  return (
    <div className="write-scroll" ref={scrollerRef}>
      <article className="write-page read-page">
        <h1 className="read-chapter-title">{displayTitle(chapter)}</h1>
        {scenes.length === 0 && (
          <div className="write-empty">
            <p className="muted">{t('This chapter has no scenes yet.')}</p>
            <button type="button" className="btn" onClick={() => void newScene(chapter.id)}>
              {t('Add a scene')}
            </button>
          </div>
        )}
        {scenes.map((scene) => (
          <ReadSection key={scene.id} scene={scene} active={scene.id === nodeId} />
        ))}
      </article>
    </div>
  );
}
