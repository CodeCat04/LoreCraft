/**
 * The edit level ("Make changes directly"). The MCP server stores each change as `auto` and
 * waits. This picks it up, applies it with the same code as Accept, and marks it applied or
 * failed, which the waiting tool call reports. Each change is announced, so nothing is
 * changed silently, and it shows under Applied by outside AI with Undo.
 */

import { t } from '../lib/i18n';
import { subscribeDataChanges } from '../state/events';
import { useProject } from '../state/project';
import { toast } from '../shell/toasts';
import { applyDirectly } from './actions';
import { mcp, type AnyProposal } from './api';

/** Fallback, in case a change was announced while the window was busy. */
const POLL_MS = 3000;

let running = false;
let again = false;

/** Picks up the change: false if another window or the server's timeout got there first. */
async function claim(proposal: AnyProposal): Promise<boolean> {
  return (await mcp.resolve(proposal.id, 'applying')).changed;
}

export async function applyOne(proposal: AnyProposal): Promise<boolean> {
  if (!(await claim(proposal))) return false;
  const result = await applyDirectly(proposal);
  if (result.ok) {
    toast(t('{client} changed {title}. You can undo it under Outside suggestions.', { client: proposal.client, title: proposal.title || t('Untitled') }));
  }
  return result.ok;
}

/** Applies every change waiting for this window, one at a time. */
export async function applyWaiting(): Promise<void> {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    do {
      again = false;
      if (!useProject.getState().status.open) return;
      const waiting = await mcp.proposals('auto');
      for (const proposal of waiting) await applyOne(proposal);
    } while (again);
  } catch {
    // The next change or poll tries again. A change left waiting goes back to the writer.
  } finally {
    running = false;
  }
}

let started = false;

/** Starts once, at startup. */
export function startAutoApply(): void {
  if (started) return;
  started = true;
  subscribeDataChanges(() => void applyWaiting());
  setInterval(() => void applyWaiting(), POLL_MS);
}
