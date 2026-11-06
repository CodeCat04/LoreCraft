import { getSchema } from '@tiptap/core';
import { Editor } from '@tiptap/core';
import { describe, expect, it } from 'vitest';

import { contentProblem, readableCopy } from './contentCheck';
import { documentExtensions } from './schema';
import type { PmNode } from '../lib/types';

/** A scene from a newer LoreCraft, with a node and a mark this version has never heard of. */
const fromNewerVersion: PmNode = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'The first line survives.' }] },
    {
      type: 'timelineMarker',
      attrs: { when: 'Year 312' },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Inside a new kind of block.' }] }],
    },
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'Glowing words.', marks: [{ type: 'glow' }] }],
    },
  ],
};

describe('content this version cannot read', () => {
  const schema = getSchema(documentExtensions());

  it('is found, where TipTap alone would show an empty document', () => {
    expect(contentProblem(schema, fromNewerVersion)).toMatch(/timelineMarker|glow/);
    // What TipTap does without the check: the text is gone, and an edit would store that.
    const editor = new Editor({ extensions: documentExtensions(), content: fromNewerVersion });
    expect(editor.getText()).toBe('');
    editor.destroy();
  });

  it('passes for an ordinary document', () => {
    const plain: PmNode = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }] };
    expect(contentProblem(schema, plain)).toBeNull();
  });

  it('can still be read, with every word in view', () => {
    const copy = readableCopy(schema, fromNewerVersion);
    expect(contentProblem(schema, copy)).toBeNull();
    const text = JSON.stringify(copy);
    expect(text).toContain('The first line survives.');
    expect(text).toContain('Inside a new kind of block.');
    expect(text).toContain('Glowing words.');
  });

  it('turns on the check in TipTap, which reports the problem', () => {
    let reported: string | null = null;
    const editor = new Editor({
      extensions: documentExtensions(),
      content: fromNewerVersion,
      enableContentCheck: true,
      onContentError: ({ error }) => {
        reported = error.message;
      },
    });
    expect(reported).toMatch(/Invalid JSON content/);
    editor.destroy();
  });
});
