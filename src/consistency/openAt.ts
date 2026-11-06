/** Takes the writer to the words a finding quotes. */

import type { Node as PmDoc } from '@tiptap/pm/model';

import { waitForEditor, type EditorEntry } from '../editor/ai';
import { useNav } from '../state/nav';
import { cleanQuote, indexOfWhole, normalizeWithMap } from './quotes';
import type { Evidence } from './types';

export interface DocRange {
  from: number;
  to: number;
}

/** Where a quote is in a document, within one block of text. Null if it is not there. */
export function locateQuote(doc: PmDoc, quote: string): DocRange | null {
  const needle = cleanQuote(quote);
  if (!needle) return null;
  let found: DocRange | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (!node.isTextblock) return true;
    let text = '';
    const positions: number[] = [];
    node.forEach((child, offset) => {
      const start = pos + 1 + offset;
      if (child.isText) {
        const piece = child.text ?? '';
        for (let i = 0; i < piece.length; i += 1) {
          text += piece[i];
          positions.push(start + i);
        }
      } else {
        text += ' ';
        positions.push(start);
      }
    });
    const normalized = normalizeWithMap(text);
    const at = indexOfWhole(normalized.text, needle);
    if (at >= 0) {
      found = {
        from: positions[normalized.map[at]],
        to: positions[normalized.map[at + needle.length - 1]] + 1,
      };
    }
    return false;
  });
  return found;
}

function nextFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (left: number) => {
      if (left <= 0) resolve();
      else requestAnimationFrame(() => step(left - 1));
    };
    step(count);
  });
}

/** Selects the range and brings it to the middle of the screen. */
export async function showRange(entry: EditorEntry, range: DocRange): Promise<void> {
  // The shell scrolls each new screen to its top just after it appears, so wait for that.
  await nextFrames(2);
  const { editor } = entry;
  if (editor.isDestroyed) return;
  editor.commands.setTextSelection(range);
  const { node } = editor.view.domAtPos(range.from);
  const element = node instanceof Element ? node : node.parentElement;
  element?.scrollIntoView({ block: 'center' });
  if (editor.isEditable) editor.view.focus();
}

/**
 * Opens a page or scene at a quote. A quote from an infobox or a scene's details is not in the
 * document's text, so that opens the document at its top, or at the infobox on a page.
 */
export async function openEvidence(evidence: Evidence, options: { edit?: boolean } = {}): Promise<{ entry: EditorEntry | null; range: DocRange | null }> {
  const { go } = useNav.getState();
  if (evidence.sourceKind === 'node') {
    go({ view: 'write', nodeId: evidence.sourceId });
  } else {
    go({ view: 'page', id: evidence.sourceId, tab: options.edit ? 'edit' : 'read' });
  }
  const entry = await waitForEditor(evidence.sourceKind, evidence.sourceId, 5000);
  if (!entry) return { entry: null, range: null };
  const range = locateQuote(entry.editor.state.doc, evidence.quote);
  if (range) await showRange(entry, range);
  else if (evidence.sourceKind === 'page') {
    await nextFrames(2);
    document.querySelector('.wiki-infobox')?.scrollIntoView({ block: 'center' });
  }
  return { entry, range };
}
