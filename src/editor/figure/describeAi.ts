/**
 * "Describe with AI" for a picture. It asks a profile that can read images what the picture
 * shows, and offers the answer as a suggestion the writer can edit, use or discard. Their own
 * description changes only when they choose "Use this", so nothing they wrote is replaced
 * behind their back.
 *
 * The figure popover and the media library both use this, so they behave alike. It is plain
 * DOM, because the popover is.
 */

import './describeAi.css';

import { AiError } from '../../ai/client';
import { isSourceLocalOnly } from '../../ai/limits/localOnly';
import { describeImage } from '../../ai/vision';
import * as api from '../../lib/api';
import { t } from '../../lib/i18n';
import { errorMessage } from '../../lib/rpc';
import { fetchUsage } from '../../media/libraryData';
import { useNav } from '../../state/nav';
import type { EditorSource } from '../RichEditor';

type SourceRef = Pick<EditorSource, 'kind' | 'id'>;

/**
 * Whether a picture may only go to a local profile: it is on a page or scene marked local
 * only, here or anywhere else it is used. Anything that cannot be read counts as marked,
 * since the safe mistake is to send too little.
 */
export async function pictureIsLocalOnly(assetId: string, source?: SourceRef | null): Promise<boolean> {
  if (source && (await isSourceLocalOnly(source))) return true;
  let uses: { kind: 'page' | 'node' | 'map'; id: string }[];
  try {
    uses = (await fetchUsage(assetId)).uses;
  } catch {
    return true;
  }
  for (const use of uses) {
    // Maps cannot be marked.
    if (use.kind === 'map') continue;
    if (source && use.kind === source.kind && use.id === source.id) continue;
    try {
      const found = use.kind === 'page' ? await api.pages.get(use.id) : await api.nodes.get(use.id);
      if (found.localOnly) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/** What the writer has said about the picture, read when the button is pressed. */
export interface PictureContext {
  caption?: string;
  description?: string;
  pageTitle?: string;
  /** The document it is being described from, if any. */
  source?: SourceRef | null;
}

export interface DescribeAiOptions {
  assetId: string;
  context: () => PictureContext;
  /** The writer chose the suggestion, perhaps after editing it. */
  onUse: (text: string) => void;
}

export interface DescribeAiWidget {
  /** "Describe with AI", for an actions row. */
  button: HTMLButtonElement;
  /** Progress, any problem, and the suggestion. Hidden until the button is pressed. */
  panel: HTMLElement;
  /** Whether a request is running. */
  busy: () => boolean;
  /** Stops a request that is running, and forgets the suggestion. */
  destroy: () => void;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function smallButton(text: string, primary = false): HTMLButtonElement {
  const button = element('button', `btn btn-sm${primary ? ' btn-primary' : ''}`, text);
  button.type = 'button';
  return button;
}

/** What went wrong, in words for the writer. Null for a stop they asked for. */
export function describeProblem(e: unknown): { text: string; settings: boolean } | null {
  if (e instanceof AiError) {
    if (e.code === 'CANCELLED') return null;
    const settings = ['IMAGES_NOT_SUPPORTED', 'LOCAL_ONLY', 'NO_PROFILE', 'NO_KEY', 'BAD_KEY', 'NO_MODEL'].includes(e.code);
    return { text: e.message, settings };
  }
  return { text: t('Could not describe the picture: {reason}', { reason: errorMessage(e) }), settings: false };
}

export function createDescribeAi(options: DescribeAiOptions): DescribeAiWidget {
  const button = smallButton(t('Describe with AI'));
  button.classList.add('figure-ai-button');
  button.title = t('Ask an AI that can read images to suggest a description');

  const panel = element('div', 'figure-ai');
  panel.hidden = true;
  panel.setAttribute('aria-label', t('Suggested description'));
  panel.setAttribute('role', 'group');

  const head = element('div', 'figure-ai-head');
  const status = element('p', 'figure-ai-status muted small');
  status.setAttribute('role', 'status');
  const stop = smallButton(t('Stop'));
  head.append(status, stop);

  const problem = element('p', 'figure-ai-problem small');
  problem.setAttribute('role', 'alert');
  const settings = smallButton(t('AI settings'));

  const area = element('textarea', 'textarea figure-ai-text');
  area.rows = 4;
  area.setAttribute('aria-label', t('Suggested description'));

  const choices = element('div', 'figure-ai-actions');
  const use = smallButton(t('Use this'), true);
  const discard = smallButton(t('Discard'));
  choices.append(discard, use);

  panel.append(head, problem, settings, area, choices);

  let controller: AbortController | null = null;
  let destroyed = false;

  type State = 'idle' | 'working' | 'ready' | 'problem';
  const show = (state: State) => {
    panel.hidden = state === 'idle';
    panel.dataset.state = state;
    panel.setAttribute('aria-busy', String(state === 'working'));
    // Not `disabled`, which would take the focus away, and Escape with it.
    button.setAttribute('aria-disabled', String(state === 'working'));
    head.hidden = state !== 'working';
    stop.hidden = state !== 'working';
    problem.hidden = state !== 'problem';
    settings.hidden = true;
    area.hidden = !(state === 'working' || state === 'ready') || (state === 'working' && !area.value);
    area.readOnly = state !== 'ready';
    choices.hidden = state !== 'ready';
    if (state === 'idle') area.value = '';
  };
  show('idle');

  const run = async () => {
    if (controller || destroyed) return;
    const context = options.context();
    const current = new AbortController();
    controller = current;
    area.value = '';
    status.textContent = t('Looking at the picture…');
    show('working');
    try {
      const localOnly = await pictureIsLocalOnly(options.assetId, context.source);
      if (current.signal.aborted) throw new AiError('CANCELLED', t('Stopped.'));
      const text = await describeImage(options.assetId, {
        knownAs: { caption: context.caption, description: context.description, pageTitle: context.pageTitle },
        localOnly,
        signal: current.signal,
        onText: (soFar) => {
          if (destroyed || controller !== current) return;
          status.textContent = t('Writing a description…');
          area.value = soFar;
          area.hidden = false;
        },
      });
      if (destroyed || controller !== current) return;
      area.value = text;
      show('ready');
      area.focus();
    } catch (e) {
      if (destroyed || controller !== current) return;
      const found = describeProblem(e);
      if (!found) {
        show('idle');
      } else {
        problem.textContent = found.text;
        show('problem');
        settings.hidden = !found.settings;
      }
      keepFocus();
    } finally {
      if (controller === current) controller = null;
    }
  };

  /** Once the panel hides, focus left in it, or lost, goes back to the button. */
  const keepFocus = () => {
    if (document.activeElement === document.body || panel.contains(document.activeElement)) button.focus();
  };

  button.addEventListener('click', () => void run());
  stop.addEventListener('click', () => {
    controller?.abort();
    button.focus();
  });
  use.addEventListener('click', () => {
    const text = area.value.trim();
    show('idle');
    if (text) options.onUse(text);
    keepFocus();
  });
  // In the suggestion, Ctrl+Enter means use it, rather than whatever it means around it.
  area.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !area.readOnly) {
      event.preventDefault();
      event.stopPropagation();
      use.click();
    }
  });
  discard.addEventListener('click', () => {
    show('idle');
    button.focus();
  });
  settings.addEventListener('click', () => useNav.getState().go({ view: 'settings', tab: 'ai' }));

  return {
    button,
    panel,
    busy: () => controller !== null,
    destroy: () => {
      destroyed = true;
      controller?.abort();
      controller = null;
    },
  };
}
