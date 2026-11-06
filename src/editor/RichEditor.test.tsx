import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Editor } from '@tiptap/react';
import { describe, expect, it, vi } from 'vitest';

import { RichEditor, editorName, isUnreadableEditor } from './RichEditor';
import type { PmNode } from '../lib/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout, so nothing is ever resized.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const fromNewerVersion: PmNode = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Mira opened the gate.' }] },
    { type: 'spellCircle', attrs: { power: 3 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'It hummed.' }] }] },
  ],
};

async function show(content: PmNode, editable = true) {
  const onChange = vi.fn();
  let ready: Editor | null = null;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <RichEditor
        docKey="node:test"
        content={content}
        editable={editable}
        source={{ kind: 'node', id: 'test', title: 'Test' }}
        onChange={onChange}
        onReady={(editor) => {
          ready = editor;
        }}
      />,
    ),
  );
  // TipTap says it is ready a moment after it mounts.
  await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
  return {
    host,
    onChange,
    get editor() {
      return ready!;
    },
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe('RichEditor with text this version cannot read', () => {
  it('shows the text read-only with a notice, and never saves it', async () => {
    const view = await show(fromNewerVersion);
    expect(view.host.querySelector('[data-testid="unreadable-note"]')?.textContent).toMatch(
      /can't show\. Update LoreCraft to edit it\. Nothing here will be changed\./,
    );
    expect(view.host.textContent).toContain('Mira opened the gate.');
    expect(view.host.textContent).toContain('It hummed.');
    expect(view.editor.isEditable).toBe(false);
    expect(isUnreadableEditor(view.editor)).toBe(true);

    // Even a change made by a command, as a plugin or the AI might, is never stored.
    act(() => {
      view.editor.commands.insertContent('typed');
    });
    expect(view.onChange).not.toHaveBeenCalled();
    view.unmount();
  });

  it('edits and saves an ordinary document as before', async () => {
    const view = await show({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }] });
    expect(view.host.querySelector('[data-testid="unreadable-note"]')).toBeNull();
    expect(view.editor.isEditable).toBe(true);
    act(() => {
      view.editor.commands.insertContent('!');
    });
    expect(view.onChange).toHaveBeenCalled();
    view.unmount();
  });
});

describe('editorName', () => {
  it('names an editor by what it holds', () => {
    expect(editorName({ kind: 'page', id: '1', title: 'Harbor' }, 'article')).toBe('Article text: Harbor');
    expect(editorName({ kind: 'node', id: '2', title: 'Dawn' }, 'manuscript')).toBe('Scene text: Dawn');
    expect(editorName({ kind: 'notes', id: '3', title: 'Dawn' }, 'article')).toBe('Notes: Dawn');
  });
});
