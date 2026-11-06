import { describe, expect, it } from 'vitest';

import { describeError, stackFrames } from './errorReporting';

describe('stackFrames', () => {
  it('reads the stacks WebView2 writes, without the message line', () => {
    const stack = [
      'TypeError: Vaelthrix burned Ashmoor',
      '    at render (http://tauri.localhost/assets/index-abc123.js:10:20)',
      '    at http://tauri.localhost/assets/index-abc123.js:1:2',
      '    at async Promise.all (index 0)',
    ].join('\n');
    expect(stackFrames(stack)).toEqual(['render index-abc123.js:10:20', 'index-abc123.js:1:2']);
  });

  it('reads the stacks WebKit writes, on macOS and Linux', () => {
    const stack = ['render@tauri://localhost/assets/index-abc123.js:10:20', '@tauri://localhost/assets/index-abc123.js:1:2'].join('\n');
    expect(stackFrames(stack)).toEqual(['render index-abc123.js:10:20', 'index-abc123.js:1:2']);
  });

  it('keeps nothing from a multi-line message', () => {
    const stack = 'Error: first line of a story\nsecond line: 12:3\nthird line of it\n    at f (http://x/a.js:1:1)';
    expect(stackFrames(stack)).toEqual(['f a.js:1:1']);
  });

  it('copes with no stack and limits how many frames it keeps', () => {
    expect(stackFrames(undefined)).toEqual([]);
    const deep = Array.from({ length: 30 }, (_, i) => `    at f${i} (http://x/a.js:${i}:1)`).join('\n');
    expect(stackFrames(deep)).toHaveLength(12);
  });
});

describe('describeError', () => {
  it('carries the code of a native error', () => {
    const error = Object.assign(new Error('Not there'), { name: 'RpcError', code: 'NOT_FOUND' });
    expect(describeError('rejection', error)).toMatchObject({ origin: 'rejection', name: 'RpcError', code: 'NOT_FOUND' });
  });

  it('accepts things that are not errors', () => {
    expect(describeError('rejection', 'plain text').message).toBe('plain text');
    expect(describeError('rejection', { any: 'object' }).message).toBe('');
    expect(describeError('rejection', undefined).name).toBe('Error');
  });
});
