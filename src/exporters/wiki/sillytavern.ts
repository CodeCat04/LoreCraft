/**
 * SillyTavern World Info. The entry shape follows `newWorldInfoEntryDefinition` in
 * SillyTavern's public/scripts/world-info.js, and its importer requires only `entries`.
 */

import { pmToPlainText } from '../../editor/convert';
import type { Page } from '../../lib/types';
import { forAiTools } from '../localOnly';
import type { ExportInput } from '../types';
import { utf8 } from '../util';

function entryContent(page: Page, input: ExportInput): string {
  const parts: string[] = [];
  if (input.options.infoboxInContent) {
    const fields = (page.infobox?.fields ?? []).filter((f) => f.value.trim());
    if (fields.length > 0) parts.push(fields.map((f) => `${f.label || f.key}: ${f.value}`).join('\n'));
  }
  const text = pmToPlainText(page.content);
  if (text) parts.push(text);
  // A page with only a one-line summary still tells the model something.
  else if (page.summary) parts.push(page.summary);
  return parts.join('\n\n');
}

export function exportSillyTavern(input: ExportInput): Uint8Array {
  const entries: Record<string, unknown> = {};
  // The main page is a front door to the wiki, not lore. Pages marked local only stay out
  // unless the writer asked, since SillyTavern may send any entry to a cloud model.
  const pages = forAiTools(input).pages.filter((p) => !p.isHome);
  let uid = 0;
  for (const page of pages) {
    // SillyTavern trims each key before matching, and a key that trims to nothing matches
    // every message (`matchKeys` in world-info.js).
    const keys = [...new Set([page.title, ...page.aliases].map((k) => k.trim()).filter(Boolean))];
    const content = entryContent(page, input);
    // An entry with no content is skipped when the prompt is built, so it would only clutter the book.
    if (keys.length === 0 || !content.trim()) continue;
    // The object's key and the entry's own uid must agree: the editor finds entries by uid.
    entries[String(uid)] = {
      uid,
      key: keys,
      keysecondary: [],
      comment: page.title,
      content,
      constant: false,
      vectorized: false,
      selective: true,
      selectiveLogic: 0,
      addMemo: true,
      order: 100,
      position: 0,
      disable: false,
      ignoreBudget: false,
      excludeRecursion: false,
      preventRecursion: false,
      matchPersonaDescription: false,
      matchCharacterDescription: false,
      matchCharacterPersonality: false,
      matchCharacterDepthPrompt: false,
      matchScenario: false,
      matchCreatorNotes: false,
      delayUntilRecursion: 0,
      probability: 100,
      useProbability: true,
      depth: 4,
      outletName: '',
      group: '',
      groupOverride: false,
      groupWeight: 100,
      scanDepth: null,
      caseSensitive: null,
      matchWholeWords: null,
      useGroupScoring: null,
      automationId: '',
      role: 0,
      sticky: null,
      cooldown: null,
      delay: null,
      triggers: [],
      displayIndex: uid,
    };
    uid += 1;
  }
  return utf8(JSON.stringify({ entries }, null, 2));
}
