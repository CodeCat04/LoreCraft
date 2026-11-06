/**
 * Beta-reader feedback on a scene or chapter. It reads and comments, and that is all: nothing
 * here can reach a document, and a note is only kept if its quote is really in the text.
 */

import * as coreApi from '../../lib/api';
import { t } from '../../lib/i18n';
import type { NodeMeta, PmNode } from '../../lib/types';
import { pmToPlainText } from '../../editor/convert';
import { flushAllEditors } from '../../editor/saving';
import { AiError, completeJson, profileForTask } from '../client';
import { assembleContext, buildReadingOrder, contextBudget, contextToBlocks, estimateTokens, type ContextRequest } from '../context';
import { attr, fence, READING_THE_MATERIAL } from '../prompts';
import type { ContentBlock } from '../types';
import { withheldMessage } from '../limits/localOnly';
import { confirmRun } from '../limits/confirmRun';
import { verifyNotes, type RawNote, type VerifiedNote } from './quotes';

export type BetaFocus = 'pacing' | 'clarity' | 'tension' | 'character' | 'dialogue' | 'continuity';

export const FOCUSES: { id: BetaFocus; label: string; ask: string }[] = [
  { id: 'pacing', label: 'Pacing', ask: 'Where does it drag, rush, or lose momentum? Where does the time spent on something feel right?' },
  { id: 'clarity', label: 'Clarity', ask: 'Where could a reader get lost: who is speaking, where we are, when this is, or what just happened?' },
  { id: 'tension', label: 'Tension', ask: 'Where do the stakes and suspense rise, and where do they slacken? Do you want to keep reading, and at which lines?' },
  { id: 'character', label: 'Character', ask: 'Do people act and feel in ways you believe? Where do their motives or reactions ring true, or false?' },
  { id: 'dialogue', label: 'Dialogue', ask: 'Does the speech sound like people talking? Can you tell the speakers apart? Which lines work, and which feel written?' },
  { id: 'continuity', label: 'Continuity', ask: 'What contradicts something earlier in the text or in the lore: facts, names, places, timing, who knows what?' },
];

/** These need to know the world. The others read better as a first reader would. */
const NEEDS_LORE: BetaFocus[] = ['character', 'continuity'];

export const BETA_SYSTEM = `You are a beta reader for a novelist, in LoreCraft, where they keep a wiki of their invented world beside their manuscript. You read a scene or chapter as an attentive reader, and say honestly how it lands. You give feedback and nothing else: you never rewrite the text or offer replacement sentences, and the author decides what to do with what you say.

${READING_THE_MATERIAL}

Reply with JSON in this shape: {"summary": "...", "notes": [{"quote": "...", "note": "..."}]}
- "summary" is your overall impression, in one or two plain sentences.
- Each "quote" is copied exactly, character for character, from the text in a <scene> block. Take one passage, from a phrase up to a sentence or two, and do not paraphrase it, shorten it with an ellipsis, or join separate pieces. A quote that is not in the text is thrown away.
- Each "note" says what you noticed as a reader there and why it matters, in one to three plain sentences. Say what works as well as what does not. Do not write replacement text.
- Give from three to eight notes, fewer for a very short text. Only comment on what the author asked you to focus on.`;

export const BETA_SCHEMA = {
  name: 'beta_reader_notes',
  schema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      notes: {
        type: 'array',
        items: {
          type: 'object',
          properties: { quote: { type: 'string' }, note: { type: 'string' } },
          required: ['quote', 'note'],
          additionalProperties: false,
        },
      },
    },
    required: ['summary', 'notes'],
    additionalProperties: false,
  },
};

export interface BetaReply {
  summary: string;
  notes: RawNote[];
}

/** Takes what a model sends, or says what is wrong with it so it can try again. */
export function parseBetaReply(value: unknown): BetaReply {
  const object = (Array.isArray(value) ? { notes: value } : value) as { summary?: unknown; notes?: unknown } | null;
  if (!object || typeof object !== 'object' || !Array.isArray(object.notes)) {
    throw new Error('Expected an object with a "notes" list.');
  }
  const notes = object.notes.map((item, index) => {
    const note = item as { quote?: unknown; note?: unknown } | null;
    if (!note || typeof note.quote !== 'string' || typeof note.note !== 'string' || !note.note.trim()) {
      throw new Error(`Note ${index + 1} needs a "quote" and a "note", both strings.`);
    }
    return { quote: note.quote, note: note.note.trim() };
  });
  return { summary: typeof object.summary === 'string' ? object.summary.trim() : '', notes };
}

export interface BetaScene {
  id: string;
  title: string;
  doc: PmNode;
  synopsis?: string;
  localOnly?: boolean;
}

function sceneBlock(scene: BetaScene): string {
  return `<scene title="${attr(scene.title)}">\n${fence(pmToPlainText(scene.doc) || '[No text yet.]')}\n</scene>`;
}

/** The request itself. The scenes and any lore go ahead of it, in their own blocks. */
export function betaInstruction(focus: BetaFocus, sceneCount: number): string {
  const found = FOCUSES.find((f) => f.id === focus) ?? FOCUSES[0];
  const what = sceneCount > 1 ? `these ${sceneCount} scenes, which run in this order` : 'this scene';
  return `Read ${what} as a beta reader, and give your notes as JSON. Your focus is ${found.label.toLowerCase()}. ${found.ask}`;
}

/** What goes out: lore if the focus calls for it, then as much of the text as fits. */
export async function betaMessages(
  scenes: BetaScene[],
  focus: BetaFocus,
  budgetTokens: number,
  forCloud = false,
): Promise<{ content: ContentBlock[]; read: BetaScene[]; unread: BetaScene[] }> {
  const instruction = betaInstruction(focus, scenes.length);
  const reserved = estimateTokens(BETA_SYSTEM) + estimateTokens(instruction);
  // Most of the room is for the text: leaving part of it unread is worse than having less lore.
  let room = Math.max(400, Math.floor((budgetTokens - reserved) * 0.85));
  const read: BetaScene[] = [];
  const unread: BetaScene[] = [];
  const blocks: string[] = [];
  for (const scene of scenes) {
    const block = sceneBlock(scene);
    const tokens = estimateTokens(block);
    // Whole scenes, so a quote is never cut in half, and always at least the first.
    if (unread.length === 0 && (read.length === 0 || tokens <= room)) {
      read.push(scene);
      blocks.push(block);
      room -= tokens;
    } else {
      unread.push(scene);
    }
  }
  const content: ContentBlock[] = [];
  if (NEEDS_LORE.includes(focus)) {
    const request: ContextRequest = {
      budgetTokens,
      reservedTokens: budgetTokens - Math.max(0, room),
      source: read.length === 1 ? { kind: 'node', id: read[0].id, title: read[0].title } : null,
      doc: { type: 'doc', content: read.flatMap((scene) => scene.doc.content ?? []) },
      skipDocument: true,
      instruction,
      forCloud,
    };
    content.push(...contextToBlocks(await assembleContext(request)));
  }
  blocks.forEach((text, index) => {
    content.push({ type: 'text', text, hidden: true, label: read[index].title });
  });
  content.push({ type: 'text', text: instruction });
  return { content, read, unread };
}

/** A scene, or a chapter or part with every scene in it, in reading order. */
export async function scenesOf(nodeId: string, tree: NodeMeta[]): Promise<BetaScene[]> {
  const { index } = buildReadingOrder([{ nodes: tree }]);
  const under = new Set<string>([nodeId]);
  const ordered = [...tree].sort((a, b) => (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0));
  for (const node of ordered) {
    if (node.parentId && under.has(node.parentId)) under.add(node.id);
  }
  const wanted = ordered.filter((node) => under.has(node.id) && node.kind === 'scene');
  const full = await Promise.all(wanted.map((meta) => coreApi.nodes.get(meta.id)));
  return full.map((node) => ({
    id: node.id, title: node.title || 'Untitled scene', doc: node.content, synopsis: node.synopsis, localOnly: !!node.localOnly,
  }));
}

export interface BetaResult {
  summary: string;
  notes: VerifiedNote[];
  /** Notes whose quote is not in the text. */
  dropped: number;
  /** Scenes that did not fit, and were not read. */
  unread: string[];
  /** Scenes marked local only, which a cloud profile was not sent. */
  withheld: string[];
  focus: BetaFocus;
  scope: string;
  bookId: string;
  sceneCount: number;
}

export interface BetaRequest {
  /** The scene or chapter. */
  nodeId: string;
  bookId: string;
  scope: string;
  focus: BetaFocus;
  profileId?: string;
  model?: string;
  signal?: AbortSignal;
  /** Shows the cost estimate first, for a cloud profile. */
  confirmCost?: boolean;
}

/** All the text in a request, for an estimate. */
export function contentText(content: ContentBlock[]): string {
  return content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

/** Reads and comments. Rejects with an `AiError` if no usable reply came back. */
export async function runBetaReader(request: BetaRequest): Promise<BetaResult> {
  // Whatever was typed last goes in too.
  await flushAllEditors();
  const tree = await coreApi.nodes.tree(request.bookId);
  const scenes = await scenesOf(request.nodeId, tree);
  if (scenes.length === 0 || scenes.every((scene) => !pmToPlainText(scene.doc).trim())) {
    throw new AiError('EMPTY_TEXT', t('There is nothing written here to read yet.'));
  }
  const profile = profileForTask('chat', request.profileId);
  const allowed = scenes.filter((scene) => !(profile.isCloud && scene.localOnly));
  const withheld = scenes.filter((scene) => !allowed.includes(scene)).map((scene) => scene.title);
  if (allowed.length === 0) throw new AiError('LOCAL_ONLY', withheldMessage(withheld[0], profile));
  const { content, read, unread } = await betaMessages(allowed, request.focus, contextBudget(profile), profile.isCloud);
  if (request.confirmCost && profile.isCloud) {
    const go = await confirmRun({ label: t('Get beta reader notes'), text: contentText(content), profile, outputShare: 0.1 });
    if (!go) throw new AiError('DECLINED', t('Cancelled.'));
  }

  // Asked again once if not one quote checks out, since that usually means the model did not
  // quote at all. If that fails too, the count of what was dropped is the honest answer.
  let last: BetaReply | null = null;
  let reply: BetaReply;
  try {
    reply = await completeJson(
      {
        task: 'chat',
        profileId: profile.id,
        model: request.model,
        system: BETA_SYSTEM,
        messages: [{ role: 'user', content }],
        schema: BETA_SCHEMA,
        signal: request.signal,
      },
      (value) => {
        const parsed = parseBetaReply(value);
        last = parsed;
        if (parsed.notes.length > 0 && verifyNotes(parsed.notes, read).notes.length === 0) {
          throw new Error('None of those quotes are in the text. Copy each quote exactly, character for character, from a <scene> block.');
        }
        return parsed;
      },
      { repairs: 1 },
    );
  } catch (e) {
    if (!(e instanceof AiError) || e.code !== 'BAD_JSON' || !last) throw e;
    reply = last;
  }
  const { notes, dropped } = verifyNotes(reply.notes, read);
  return {
    summary: reply.summary,
    notes,
    dropped,
    unread: unread.map((scene) => scene.title),
    withheld,
    focus: request.focus,
    scope: request.scope,
    bookId: request.bookId,
    sceneCount: read.length,
  };
}
