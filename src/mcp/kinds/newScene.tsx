/** A new scene, or a new chapter with its first scene. Undo moves what was made to the trash. */

import * as api from '../../lib/api';
import { t } from '../../lib/i18n';
import { errorMessage } from '../../lib/rpc';
import { useLocale } from '../../state/language';
import type { AnyProposal, NewChapterPayload, NewScenePayload, PageRef } from '../api';
import { isLiveNode, markdownDoc, MarkdownPreview, undoCreated, withElement, type CreatedUndo } from './shared';
import { defineKind, type ApplyResult } from './types';

interface NewSceneFields {
  title: string;
  synopsis?: string;
  pov?: PageRef;
  location?: PageRef;
  cast?: PageRef[];
  text?: string;
}

function peopleFacts(scene: { pov?: PageRef | null; location?: PageRef | null; cast?: PageRef[] }): string[] {
  return [
    scene.pov ? t('Point of view: {name}', { name: scene.pov.title }) : '',
    scene.location ? t('Location: {name}', { name: scene.location.title }) : '',
    scene.cast?.length ? t('Cast: {names}', { names: scene.cast.map((p) => p.title).join(', ') }) : '',
  ].filter(Boolean);
}

function NewSceneCard({ proposal }: { proposal: AnyProposal<NewScenePayload | NewChapterPayload> }) {
  useLocale();
  const isChapter = proposal.kind === 'newChapter';
  const chapter = proposal.payload as NewChapterPayload;
  const sceneOnly = proposal.payload as NewScenePayload;
  const scene: NewSceneFields = isChapter ? chapter.scene : sceneOnly;
  let place: string;
  if (isChapter) {
    place = chapter.afterTitle
      ? t('After the chapter {name}, in {book}.', { name: chapter.afterTitle, book: chapter.bookTitle })
      : t('At the end of {book}.', { book: chapter.bookTitle });
  } else {
    place = sceneOnly.afterTitle
      ? t('After the scene {name}, in {chapter}.', { name: sceneOnly.afterTitle, chapter: sceneOnly.chapterTitle })
      : t('At the end of the chapter {chapter}.', { chapter: sceneOnly.chapterTitle });
  }
  const facts = [place, isChapter ? t('First scene: {name}', { name: scene.title }) : '', ...peopleFacts(scene)].filter(Boolean);
  return (
    <>
      <p className="mcp-proposal-title">
        {withElement(isChapter ? t('New chapter: {title}') : t('New scene: {title}'), 'title', <strong>{proposal.payload.title}</strong>)}
      </p>
      <p className="muted small">{facts.join(' ')}</p>
      {proposal.payload.synopsis && <p>{proposal.payload.synopsis}</p>}
      {isChapter && scene.synopsis && <p>{scene.synopsis}</p>}
      <MarkdownPreview text={scene.text} />
    </>
  );
}

async function createScene(bookId: string, chapterId: string, scene: NewSceneFields, afterId?: string): Promise<string> {
  const made = await api.nodes.create({
    bookId,
    parentId: chapterId,
    kind: 'scene',
    title: scene.title,
    afterId,
    content: markdownDoc(scene.text),
    synopsis: scene.synopsis ?? '',
  });
  if (scene.pov || scene.location) {
    await api.nodes.update(made.id, {
      ...(scene.pov ? { povPageId: scene.pov.id } : {}),
      ...(scene.location ? { locationPageId: scene.location.id } : {}),
    });
  }
  if (scene.cast?.length) await api.nodes.setCast(made.id, scene.cast.map((p) => p.id));
  return made.id;
}

async function created(id: string): Promise<CreatedUndo> {
  return { kind: 'node', id, updatedAt: (await api.nodes.get(id)).updatedAt };
}

async function applyScene(proposal: AnyProposal<NewScenePayload>): Promise<ApplyResult> {
  const { payload } = proposal;
  if (!(await isLiveNode(payload.chapterId))) return { ok: false, reason: t('The chapter this scene goes in has been deleted.') };
  try {
    const id = await createScene(payload.bookId, payload.chapterId, payload, payload.afterId);
    return { ok: true, undo: await created(id) };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

async function applyChapter(proposal: AnyProposal<NewChapterPayload>): Promise<ApplyResult> {
  const { payload } = proposal;
  if (payload.parentId && !(await isLiveNode(payload.parentId))) return { ok: false, reason: t('The part this chapter goes in has been deleted.') };
  try {
    const chapter = await api.nodes.create({
      bookId: payload.bookId,
      parentId: payload.parentId ?? null,
      kind: 'chapter',
      title: payload.title,
      afterId: payload.afterId,
      synopsis: payload.synopsis ?? '',
    });
    await createScene(payload.bookId, chapter.id, payload.scene);
    // The chapter goes to the trash with its scene in it.
    return { ok: true, undo: await created(chapter.id) };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

export const newSceneKind = defineKind<NewScenePayload>({
  kind: 'newScene',
  Card: NewSceneCard,
  apply: applyScene,
  undo: (_proposal, undo) => undoCreated(undo),
  accepted: () => t('Scene added.'),
});

export const newChapterKind = defineKind<NewChapterPayload>({
  kind: 'newChapter',
  Card: NewSceneCard,
  apply: applyChapter,
  undo: (_proposal, undo) => undoCreated(undo),
  accepted: () => t('Chapter added.'),
});
