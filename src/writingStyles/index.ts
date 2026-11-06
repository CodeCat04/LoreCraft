/**
 * Writing styles: a library of author styles and techniques, the writer's own styles and
 * blends, and a per-project style guide. This is the stable API for other modules.
 *
 *   resolveStyleInstructions({ bookId?, nodeId?, styleId? })
 *       The text block for the AI: the style guide's rules plus the active style's prompt.
 *       The style is the explicit `styleId` (a chat's choice), then the scene's, the book's,
 *       the project's. Deterministic, since it sits in a cached prompt prefix.
 *   getActiveStyle(scope), setActiveStyle(scope, styleId | null)
 *       Read or change the choice at exactly one scope. Null clears it, so the wider scope
 *       applies. `scope` is { kind: 'project' }, { kind: 'book', bookId } or
 *       { kind: 'scene', nodeId }.
 *   listStyles(), getStyle(id)
 *       Everything in the library plus this person's own styles.
 *   buildStylePrompt(style), blendStyles(parts)
 *       The one place a style turns into text for the AI.
 *   StylePicker
 *       A searchable dropdown of every style, for embedding.
 */

import '../styles/writingStyles.css';

export { getActiveStyle, getStyle, listStyles, resolveEffectiveStyle, resolveStyleInstructions, setActiveStyle } from './store';
export type { ActiveStyle } from './store';
export type { EffectiveStyle, StyleInstructions, StyleLevel, StyleRequest } from './resolve';
export { blendStyles, buildStylePrompt } from './prompt';
export { StylePicker } from './StylePicker';
export { StylesView } from './StylesView';
export { openStylesPage, registerWritingStyles } from './register';
export { RewriteInStylePicker, rewriteInstruction } from './rewrite';
export type { BlendPart, BlendWeight, CustomStyle, StyleGuide, StyleScope, WritingStyle } from './types';
