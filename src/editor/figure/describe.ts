/**
 * The small popover for a figure's description: more detail for the AI, also used as alt
 * text. For a picture stored in the project, the actions row offers "Describe with AI", whose
 * answer is a suggestion shown apart from the writer's own words until they use it.
 */

import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom';

import { t } from '../../lib/i18n';
import type { EditorSource } from '../RichEditor';
import { createDescribeAi, type DescribeAiWidget } from './describeAi';

let closeCurrent: (() => void) | null = null;

export interface DescribeOptions {
  anchor: HTMLElement;
  value: string;
  onChange: (value: string) => void;
  onClose?: () => void;
  /** Set for a picture stored in the project, which can be described with AI. Never for a video. */
  picture?: {
    assetId: string;
    /** The figure's label as it is now. */
    caption: () => string;
    /** The document the figure is in, if known. */
    source: EditorSource | null;
  };
}

/** How long after typing stops a description is stored. */
const COMMIT_DELAY_MS = 500;

/** Clicks in the app's own dialogs, such as asking before a cloud send, leave the popover open. */
function inAppDialog(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('.dialog, [role="alertdialog"]');
}

export function openDescribePopover({ anchor, value, onChange, onClose, picture }: DescribeOptions): () => void {
  closeCurrent?.();

  const pop = document.createElement('div');
  pop.className = 'figure-describe';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', t('Figure description'));

  const label = document.createElement('label');
  label.className = 'field';
  const title = document.createElement('span');
  title.className = 'field-label';
  title.textContent = t('More detail for the AI (optional)');
  const area = document.createElement('textarea');
  area.className = 'textarea';
  area.rows = 4;
  area.value = value;
  area.placeholder = t('What it shows, who is in it, when it happens');
  const hint = document.createElement('span');
  hint.className = 'field-hint';
  hint.textContent = t('Also used as the alt text.');
  label.append(title, area, hint);

  const actions = document.createElement('div');
  actions.className = 'figure-describe-actions';
  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'btn btn-sm btn-primary';
  done.textContent = t('Done');
  actions.append(done);

  let committed = value;
  let timer: number | undefined;
  const commit = () => {
    window.clearTimeout(timer);
    if (area.value !== committed) {
      committed = area.value;
      onChange(committed);
    }
  };
  area.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(commit, COMMIT_DELAY_MS);
  });

  let ai: DescribeAiWidget | null = null;
  if (picture) {
    ai = createDescribeAi({
      assetId: picture.assetId,
      context: () => ({
        caption: picture.caption().trim() || undefined,
        description: area.value.trim() || undefined,
        pageTitle: picture.source?.kind === 'page' ? picture.source.title : undefined,
        source: picture.source,
      }),
      // The writer chose it, so it takes the place of what is in the field, as one change.
      onUse: (text) => {
        area.value = text;
        commit();
        area.focus();
        area.setSelectionRange(area.value.length, area.value.length);
      },
    });
    actions.prepend(ai.button);
    pop.append(label, ai.panel, actions);
  } else {
    pop.append(label, actions);
  }

  const onPointerDown = (event: PointerEvent) => {
    if (inAppDialog(event.target)) return;
    if (!pop.contains(event.target as Node) && !anchor.contains(event.target as Node)) finish();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finish();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      finish();
    }
  };
  done.addEventListener('click', () => finish());
  document.addEventListener('pointerdown', onPointerDown, true);
  pop.addEventListener('keydown', onKey);

  document.body.append(pop);
  const stop = autoUpdate(anchor, pop, () => {
    void computePosition(anchor, pop, {
      placement: 'bottom-start',
      strategy: 'fixed',
      middleware: [offset(6), flip(), shift({ padding: 8 })],
    }).then(({ x, y }) => {
      pop.style.left = `${x}px`;
      pop.style.top = `${y}px`;
    });
  });
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);

  function finish() {
    commit();
    // A suggestion nobody used goes with the popover, and so does a request still running.
    ai?.destroy();
    stop();
    document.removeEventListener('pointerdown', onPointerDown, true);
    pop.remove();
    closeCurrent = null;
    onClose?.();
  }
  closeCurrent = finish;
  return finish;
}
