/**
 * Prompt files, for sharing saved prompts between projects and people. The format is small
 * and versioned, and described in docs/IMPORT_FORMAT.md:
 *
 *   { "lorecraft_prompts": 1, "prompts": [{ "name", "description", "template", "scope", "action" }] }
 *
 * Reading a file checks every prompt. Importing skips prompts the project already has
 * exactly, and gives a new name to one whose name is taken by a different prompt.
 */

import type { PromptAction, PromptScope, PromptTemplate } from './types';

export const PROMPT_FILE_VERSION = 1;
export const PROMPT_SCOPES: PromptScope[] = ['selection', 'page', 'scene', 'chat'];
export const PROMPT_ACTIONS: PromptAction[] = ['replace', 'insert', 'chat', 'metadata'];
const MAX_PROMPTS = 500;

export interface PromptFileEntry {
  name: string;
  description: string;
  template: string;
  scope: PromptScope;
  action: PromptAction;
}

export class PromptFileError extends Error {}

/** The file for these prompts, as text to save. */
export function promptFileText(prompts: Pick<PromptTemplate, 'name' | 'description' | 'template' | 'scope' | 'action'>[]): string {
  const file = {
    lorecraft_prompts: PROMPT_FILE_VERSION,
    prompts: prompts.map(({ name, description, template, scope, action }) => ({ name, description, template, scope, action })),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** A file name from a prompt's name, safe on every system. */
export function promptFileName(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60);
  return `${base || 'prompt'}.prompts.json`;
}

export interface ReadPromptFile {
  prompts: PromptFileEntry[];
  /** One line for each prompt left out, saying why. Numbered from 1, as a person counts. */
  problems: { index: number; name: string; message: string }[];
}

/**
 * Reads a prompt file. Throws `PromptFileError` if it is not one at all, or is a newer
 * version. Prompts that are wrong on their own are left out and listed in `problems`.
 */
export function readPromptFile(text: string): ReadPromptFile {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new PromptFileError('not-json');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PromptFileError('not-prompts');
  const root = value as Record<string, unknown>;
  const version = root.lorecraft_prompts;
  if (typeof version !== 'number' || !Array.isArray(root.prompts)) throw new PromptFileError('not-prompts');
  if (!Number.isInteger(version) || version < 1) throw new PromptFileError('not-prompts');
  if (version > PROMPT_FILE_VERSION) throw new PromptFileError('newer');

  const prompts: PromptFileEntry[] = [];
  const problems: ReadPromptFile['problems'] = [];
  root.prompts.slice(0, MAX_PROMPTS).forEach((item, at) => {
    const index = at + 1;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      problems.push({ index, name: '', message: 'not-a-prompt' });
      return;
    }
    const record = item as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    const template = typeof record.template === 'string' ? record.template : '';
    const description = typeof record.description === 'string' ? record.description.trim() : '';
    const scope = record.scope;
    if (!name) return void problems.push({ index, name, message: 'no-name' });
    if (!template.trim()) return void problems.push({ index, name, message: 'no-text' });
    if (typeof scope !== 'string' || !PROMPT_SCOPES.includes(scope as PromptScope)) {
      return void problems.push({ index, name, message: 'bad-scope' });
    }
    // As when saving: a chat prompt answers in the pane, and the others replace by default.
    const action = record.action ?? (scope === 'chat' ? 'chat' : 'replace');
    if (typeof action !== 'string' || !PROMPT_ACTIONS.includes(action as PromptAction)) {
      return void problems.push({ index, name, message: 'bad-action' });
    }
    prompts.push({ name, description, template, scope: scope as PromptScope, action: action as PromptAction });
  });
  if (root.prompts.length > MAX_PROMPTS) problems.push({ index: MAX_PROMPTS + 1, name: '', message: 'too-many' });
  return { prompts, problems };
}

export type ImportOutcome = 'add' | 'rename' | 'skip';

export interface PlannedPrompt {
  entry: PromptFileEntry;
  outcome: ImportOutcome;
  /** The name it will be saved under. */
  name: string;
}

const nameKey = (name: string) => name.trim().toLowerCase();
/** A name without the " (2)" an earlier import may have given it. */
const baseKey = (name: string) => nameKey(name.trim().replace(/\s*\((\d+)\)$/, ''));

function sameContent(a: Omit<PromptFileEntry, 'name'>, b: Omit<PromptFileEntry, 'name'>): boolean {
  return a.template === b.template && a.scope === b.scope && a.action === b.action && a.description.trim() === b.description.trim();
}

/**
 * What importing these would do, given the prompts the project has: an exact copy of one
 * already there, or earlier in the file, is skipped, even if an earlier import renamed it.
 * A name already taken by something different becomes "Name (2)", or the next number free.
 */
export function planPromptImport(incoming: PromptFileEntry[], existing: PromptFileEntry[]): PlannedPrompt[] {
  const known: PromptFileEntry[] = [...existing];
  const taken = new Set(existing.map((prompt) => nameKey(prompt.name)));
  const plan: PlannedPrompt[] = [];
  for (const entry of incoming) {
    const duplicate = known.some((prompt) => baseKey(prompt.name) === baseKey(entry.name) && sameContent(prompt, entry));
    if (duplicate) {
      plan.push({ entry, outcome: 'skip', name: entry.name });
      continue;
    }
    let name = entry.name;
    if (taken.has(nameKey(name))) {
      // "Name (2)" from "Name", and "Name (3)" from "Name (2)", rather than "Name (2) (2)".
      const base = entry.name.replace(/\s*\((\d+)\)$/, '');
      let n = 2;
      while (taken.has(nameKey(`${base} (${n})`))) n += 1;
      name = `${base} (${n})`;
    }
    taken.add(nameKey(name));
    known.push({ ...entry, name });
    plan.push({ entry, outcome: name === entry.name ? 'add' : 'rename', name });
  }
  return plan;
}
