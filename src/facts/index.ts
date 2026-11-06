/**
 * Facts that change during the story. What other modules may want:
 * - `factsForPrompt(page, moment)` with `promptMoment(index, nodeId)`, for an AI's prompt.
 * - `loadStoryIndex()`, for where everything falls in reading order.
 * - `ageAt`, `fieldValueAt` and friends from `src/lib/facts.ts`, which hold the rules.
 */

import '../styles/facts.css';

export { FieldChangesEditor } from './FieldChangesEditor';
export { HoverFacts } from './HoverFacts';
export { useDateContext, useStoryIndex, useStoryNames } from './hooks';
export { historyText } from './history';
export { useInfoboxFacts } from './InfoboxFacts';
export { factsForPrompt, promptMoment, wholeStoryMoment, type PromptMoment } from './prompt';
export { loadStoryIndex, momentOf, nodeLabel, type StoryIndex } from './storyIndex';
export { WhosHere } from './WhosHere';
