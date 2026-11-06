/** Word's style names, including the ones LoreCraft's own Word export uses. */
export const MAMMOTH_STYLE_MAP = [
  "p[style-name='Title'] => h1.doc-title:fresh",
  "p[style-name='Subtitle'] => p.doc-subtitle:fresh",
  "p[style-name='Author'] => p.doc-author:fresh",
  "p[style-name='Manuscript Head'] => p.doc-head:fresh",
  "p[style-name='Caption'] => p.doc-caption:fresh",
  "p[style-name='Quote'] => blockquote > p:fresh",
  "p[style-name='Code Block'] => pre:separator('\\n')",
  'u => u',
  'strike => s',
];
