/**
 * Sends uncaught errors to the log files, because an installed app has no console anyone
 * can read. The native side scrubs what arrives, and this sends as little as it can: see
 * `src-tauri/src/logs.rs` for the privacy rule.
 */

import { invoke } from '@tauri-apps/api/core';

const MAX_REPORTS = 100;
const MAX_FRAMES = 12;
/** The browser reports this harmless layout notice as if it were an error. */
const NOISE = /ResizeObserver loop/;

let reports = 0;
let last = '';

/** `at name (url:1:2)` or `at url:1:2`, as WebView2 writes them. */
const V8_FRAME = /^\s*at\s+(?:(.+?)\s+\()?(\S+):(\d+):(\d+)\)?\s*$/;
/** `name@url:1:2`, as WebKit writes them on macOS and Linux. */
const WEBKIT_FRAME = /^([^\s@]*)@(\S+):(\d+):(\d+)\s*$/;

/**
 * Reduces a stack to `name file:line:col` per frame. A line in neither form is dropped, and
 * that includes the start of a V8 stack, which repeats the error message.
 */
export function stackFrames(stack: string | undefined): string[] {
  if (!stack) return [];
  const frames: string[] = [];
  for (const line of stack.split('\n')) {
    const match = V8_FRAME.exec(line) ?? WEBKIT_FRAME.exec(line);
    if (!match) continue;
    const [, name, url, row, column] = match;
    const file = url.split(/[/\\]/).pop();
    const label = name && /^[\w$.<>-]{1,80}$/.test(name) ? `${name} ` : '';
    frames.push(`${label}${file}:${row}:${column}`);
    if (frames.length === MAX_FRAMES) break;
  }
  return frames;
}

export interface ClientErrorReport {
  origin: string;
  name: string;
  code?: string;
  message: string;
  frames: string[];
}

/** What gets sent for one thrown value. */
export function describeError(origin: string, thrown: unknown): ClientErrorReport {
  if (thrown instanceof Error) {
    const code = (thrown as { code?: unknown }).code;
    return {
      origin,
      name: thrown.name,
      code: typeof code === 'string' ? code : undefined,
      message: thrown.message,
      frames: stackFrames(thrown.stack),
    };
  }
  return { origin, name: 'Error', message: typeof thrown === 'string' ? thrown : '', frames: [] };
}

/** Reports one error. It never throws, since it runs while something is already wrong. */
export function reportError(origin: string, thrown: unknown): void {
  try {
    const report = describeError(origin, thrown);
    const key = `${report.name}|${report.message}|${report.frames[0] ?? ''}`;
    // A render loop can throw thousands of times, and only the first few say anything.
    if (key === last || reports >= MAX_REPORTS) return;
    last = key;
    reports += 1;
    void invoke('rpc', { method: 'app.logClientError', params: report }).catch(() => {});
  } catch {
    // There is nowhere left to report this to.
  }
}

/** Call once, as early as possible. */
export function startErrorReporting(): void {
  window.addEventListener('error', (event) => {
    if (NOISE.test(event.message ?? '')) return;
    reportError('error', event.error ?? event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    reportError('rejection', event.reason);
  });
}
