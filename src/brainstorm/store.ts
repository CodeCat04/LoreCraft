/**
 * The brainstorm board. It lives for the session, outside the view, so going to another
 * screen and back finds it as it was. Nothing on it is saved until the writer keeps a card,
 * which sends it to the Inbox.
 */

import { create } from 'zustand';

import { AiError, completeJson, profileForTask } from '../ai/client';
import { asOfSource, assembleContext, bookOutline, contextBudget, contextToBlocks, estimateTokens } from '../ai/context';
import { isSourceLocalOnly, withheldMessage } from '../ai/limits/localOnly';
import { fence } from '../ai/prompts';
import { usePane } from '../ai/store';
import type { ContentBlock } from '../ai/types';
import { activeEditor } from '../editor/ai/registry';
import type { EditorSource } from '../editor/RichEditor';
import * as coreApi from '../lib/api';
import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import type { PmNode } from '../lib/types';
import { ideas } from '../inbox/api';
import {
  BRAINSTORM_SCHEMA,
  BRAINSTORM_SYSTEM,
  ideaPrompt,
  inboxText,
  insertAfter,
  parseIdeas,
  withoutRepeats,
  type BrainstormCategoryId,
  type IdeaCard,
} from './ideas';

/** What the board is about: nothing in particular, what was open, or a chosen page. */
export type FocusKind = 'none' | 'current' | 'page';

export interface FocusSource {
  kind: 'page' | 'node';
  id: string;
  title: string;
}

/** The choices one request was made with, kept so "More" can ask again the same way. */
interface Asked {
  category: BrainstormCategoryId;
  note: string;
  focus: FocusSource | null;
}

interface BrainstormState {
  category: BrainstormCategoryId;
  note: string;
  focusKind: FocusKind;
  /** The page or scene that was open when the board was last opened. */
  current: FocusSource | null;
  chosenPage: FocusSource | null;
  cards: IdeaCard[];
  /** Every title this board has shown, kept or discarded, so none comes back. */
  seen: string[];
  asked: Asked | null;
  /** `board` while the whole board is asking, or the id of the card asking for more. */
  busy: string | null;
  error: string;
  /** Read out to screen readers after each change. */
  status: string;
  set: (patch: Partial<Pick<BrainstormState, 'category' | 'note' | 'focusKind' | 'chosenPage'>>) => void;
  /** Remembers what is open, before the board takes its place on screen. */
  noteCurrent: () => void;
  brainstorm: () => Promise<void>;
  more: () => Promise<void>;
  moreLike: (card: IdeaCard) => Promise<void>;
  keep: (card: IdeaCard) => Promise<void>;
  discard: (card: IdeaCard) => void;
  clear: () => void;
  stop: () => void;
  reset: () => void;
}

let controller: AbortController | null = null;
let nextId = 1;

function openSource(): FocusSource | null {
  const source = activeEditor()?.source;
  return source && source.kind !== 'notes' ? { kind: source.kind, id: source.id, title: source.title } : null;
}

/** The focus as chosen now. */
function focusFor(state: Pick<BrainstormState, 'focusKind' | 'current' | 'chosenPage'>): FocusSource | null {
  if (state.focusKind === 'current') return state.current;
  if (state.focusKind === 'page') return state.chosenPage;
  return null;
}

/** The text of the focus: from the editor if it is still open, which has the latest typing. */
async function focusDoc(focus: FocusSource): Promise<PmNode | null> {
  const entry = activeEditor();
  if (entry && entry.source.kind === focus.kind && entry.source.id === focus.id) return entry.editor.getJSON() as PmNode;
  try {
    return focus.kind === 'page' ? (await coreApi.pages.get(focus.id)).content : (await coreApi.nodes.get(focus.id)).content;
  } catch {
    return null;
  }
}

/** One request to the model, and the ideas that come back. */
async function askForIdeas(asked: Asked, existing: string[], like: IdeaCard | undefined, signal: AbortSignal) {
  const profile = profileForTask('chat');
  const source = asked.focus as EditorSource | null;
  if (source && profile.isCloud && (await isSourceLocalOnly(source))) {
    throw new AiError('LOCAL_ONLY', withheldMessage(source.title, profile));
  }
  const instruction = ideaPrompt({ category: asked.category, note: asked.note, focusTitle: asked.focus?.title, existing, like });
  // A scene knows only the story up to itself. Otherwise the chat's own limit, if it has one.
  const asOfNodeId = asOfSource(source) ?? usePane.getState().conversation?.context.asOfNodeId ?? null;
  const budget = contextBudget(profile);
  const reserved = estimateTokens(BRAINSTORM_SYSTEM) + estimateTokens(instruction) + 1200;
  const blocks: ContentBlock[] = [];
  // The outline tells the whole story, so it goes only where nothing is hidden.
  if (!asOfNodeId) {
    const outline = await bookOutline(undefined, profile.isCloud).catch(() => '');
    if (outline.trim() && estimateTokens(outline) < budget / 5) {
      blocks.push({ type: 'text', text: `<book kind="outline">\n${fence(outline)}\n</book>` });
    }
  }
  const context = await assembleContext({
    budgetTokens: budget,
    reservedTokens: reserved + blocks.reduce((sum, block) => sum + estimateTokens(block.type === 'text' ? block.text : ''), 0),
    source,
    doc: source ? await focusDoc(asked.focus as FocusSource) : null,
    instruction: `${asked.note} ${instruction}`,
    forCloud: profile.isCloud,
    asOfNodeId,
  });
  const content: ContentBlock[] = [...contextToBlocks(context), ...blocks, { type: 'text', text: instruction }];
  return completeJson(
    { task: 'chat', profileId: profile.id, system: BRAINSTORM_SYSTEM, messages: [{ role: 'user', content }], schema: BRAINSTORM_SCHEMA, maxTokens: 1500, signal },
    parseIdeas,
    { repairs: 1 },
  );
}

const initial = {
  category: 'names' as BrainstormCategoryId,
  note: '',
  focusKind: 'none' as FocusKind,
  current: null,
  chosenPage: null,
  cards: [] as IdeaCard[],
  seen: [] as string[],
  asked: null,
  busy: null,
  error: '',
  status: '',
};

export const useBrainstorm = create<BrainstormState>((set, get) => {
  /** Asks, and puts what comes back on the board. `fresh` replaces the board. */
  async function run(asked: Asked, options: { fresh?: boolean; like?: IdeaCard }) {
    if (get().busy) return;
    controller?.abort();
    const stopper = new AbortController();
    controller = stopper;
    set({ busy: options.like?.id ?? 'board', error: '', status: t('Thinking of ideas…') });
    try {
      const board = options.fresh ? [] : get().cards;
      const seen = options.fresh ? [] : get().seen;
      const found = await askForIdeas(asked, seen, options.like, stopper.signal);
      const cards = withoutRepeats(found, seen.map((title) => ({ title }))).map((idea) => ({ ...idea, id: `idea-${nextId++}`, category: asked.category }));
      if (stopper.signal.aborted) return;
      set({
        cards: insertAfter(board, options.like?.id ?? null, cards),
        seen: [...seen, ...cards.map((card) => card.title)],
        asked,
        status: cards.length === 1 ? t('1 new idea.') : t('{count} new ideas.', { count: cards.length }),
        error: cards.length === 0 ? t('The model only repeated ideas already on the board. Try again, or add a note.') : '',
      });
    } catch (e) {
      if (e instanceof AiError && (e.code === 'CANCELLED' || e.code === 'DECLINED')) set({ status: t('Stopped.') });
      else set({ error: errorMessage(e), status: '' });
    } finally {
      if (controller === stopper) controller = null;
      set({ busy: null });
    }
  }

  const askedNow = (): Asked => {
    const state = get();
    return { category: state.category, note: state.note.trim(), focus: focusFor(state) };
  };

  return {
    ...initial,
    set: (patch) => set(patch),
    noteCurrent: () => {
      const open = openSource();
      if (open) set({ current: open });
    },
    brainstorm: () => run(askedNow(), { fresh: true }),
    more: () => run(get().asked ?? askedNow(), {}),
    moreLike: (card) => {
      const asked = get().asked ?? askedNow();
      return run({ ...asked, category: card.category }, { like: card });
    },
    keep: async (card) => {
      try {
        const focus = get().asked?.focus;
        await ideas.add({ text: inboxText(card), ...(focus ? { sourceKind: focus.kind, sourceId: focus.id } : {}) });
        set({ cards: get().cards.filter((c) => c.id !== card.id), status: t('“{idea}” is in the Inbox.', { idea: card.title }), error: '' });
      } catch (e) {
        set({ error: errorMessage(e) });
      }
    },
    discard: (card) => set({ cards: get().cards.filter((c) => c.id !== card.id), status: t('Discarded “{idea}”.', { idea: card.title }) }),
    clear: () => set({ cards: [], seen: [], asked: null, error: '', status: t('The board is clear.') }),
    stop: () => controller?.abort(),
    reset: () => {
      controller?.abort();
      set({ ...initial });
    },
  };
});
