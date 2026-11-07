/**
 * Makes what the wizard planned, and can take it all back. Pages and scenes go to the trash
 * on Undo, never deleted for good, so nothing the writer added since is lost.
 */

import * as api from '../lib/api';
import { purgeNode } from '../write/api';
import { flushAllEditors } from '../editor/saving';
import { t } from '../lib/i18n';
import type { PmNode } from '../lib/types';
import { templateBody, templateFor, templateInfobox } from '../wiki/templates';
import { nameKey, resolveName, type CreationPlan, type ExistingPage } from './plan';
import type { Beat } from './templates';

export interface Created {
  bookId: string;
  /** Set when the wizard made the book itself. */
  newBook: boolean;
  pageIds: string[];
  /** Top-level chapters only: their scenes go with them. */
  chapterIds: string[];
  sceneCount: number;
  linkedCount: number;
}

function bodyWith(description: string, pageType: string): PmNode {
  const body = templateBody(templateFor(pageType));
  if (!description) return body;
  const [first, ...rest] = body.content ?? [];
  const lead: PmNode = { type: 'paragraph', content: [{ type: 'text', text: description }] };
  return { ...body, content: first?.type === 'paragraph' && !first.content?.length ? [lead, ...rest] : [lead, ...(body.content ?? [])] };
}

/** The last top-level item of a book, to add after. */
async function lastTopLevel(bookId: string): Promise<string | undefined> {
  const tree = await api.nodes.tree(bookId);
  return tree.filter((n) => n.parentId === null).sort((a, b) => a.position - b.position).at(-1)?.id;
}

/**
 * Makes the pages, then the chapters and scenes at the end of the book. If something fails
 * part way, what was made so far is returned with the error, so it can be taken back.
 */
export async function createFromPlan(plan: CreationPlan, existing: ExistingPage[]): Promise<Created> {
  await flushAllEditors();
  const created: Created = { bookId: '', newBook: false, pageIds: [], chapterIds: [], sceneCount: 0, linkedCount: plan.linked.length };
  try {
    if (plan.target.kind === 'new') {
      const { id } = await api.books.create(plan.target.title.trim() || t('Untitled book'));
      created.bookId = id;
      created.newBook = true;
      // A new book starts with an empty chapter and scene. The plan's chapters take their place.
      const starter = await api.nodes.tree(id);
      if (plan.chapters.length > 0 && starter.every((n) => n.wordCount === 0 && !n.synopsis)) {
        for (const node of starter.filter((n) => n.parentId === null)) {
          await api.nodes.remove(node.id);
          await purgeNode(node.id);
        }
      }
    } else {
      created.bookId = plan.target.bookId;
    }

    const made = new Map<string, string>();
    for (const page of plan.pages) {
      const template = templateFor(page.pageType);
      const result = await api.pages.create({
        title: page.name,
        pageType: page.pageType,
        status: 'draft',
        summary: page.summary,
        content: bodyWith(page.description, page.pageType),
        infobox: templateInfobox(template),
      });
      created.pageIds.push(result.id);
      made.set(nameKey(page.name), result.id);
    }

    let after = await lastTopLevel(created.bookId);
    for (const chapter of plan.chapters) {
      const node = await api.nodes.create({
        bookId: created.bookId,
        parentId: null,
        kind: 'chapter',
        title: chapter.title,
        synopsis: chapter.synopsis,
        afterId: after,
      });
      created.chapterIds.push(node.id);
      after = node.id;
      let sceneAfter: string | undefined;
      for (const scene of chapter.scenes) {
        const made_ = await api.nodes.create({
          bookId: created.bookId,
          parentId: node.id,
          kind: 'scene',
          title: scene.title,
          synopsis: scene.synopsis,
          status: 'outline',
          afterId: sceneAfter,
        });
        sceneAfter = made_.id;
        created.sceneCount += 1;
        const pov = resolveName(scene.pov, made, existing);
        if (pov) await api.nodes.update(made_.id, { povPageId: pov });
        const cast = [...new Set([...(pov ? [pov] : []), ...scene.cast.map((n) => resolveName(n, made, existing)).filter((id): id is string => !!id)])];
        if (cast.length > 0) await api.nodes.setCast(made_.id, cast);
      }
    }
    return created;
  } catch (e) {
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { created });
  }
}

/** Puts everything the wizard made in the trash. */
export async function undoCreated(created: Created): Promise<void> {
  await flushAllEditors();
  if (created.newBook && created.bookId) {
    await api.books.remove(created.bookId);
  } else {
    for (const id of [...created.chapterIds].reverse()) await api.nodes.remove(id);
  }
  for (const id of [...created.pageIds].reverse()) await api.pages.remove(id);
}

/** Adds beats to a book as chapters at its end, with the guidance as their synopsis. */
export async function applyBeats(bookId: string, beats: Beat[]): Promise<string[]> {
  await flushAllEditors();
  let after = await lastTopLevel(bookId);
  const ids: string[] = [];
  for (const beat of beats) {
    const node = await api.nodes.create({ bookId, parentId: null, kind: 'chapter', title: beat.name, synopsis: beat.guidance, afterId: after });
    ids.push(node.id);
    after = node.id;
  }
  return ids;
}
