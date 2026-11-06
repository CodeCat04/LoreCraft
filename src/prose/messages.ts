/**
 * The prose worker has no interface language, and neither does the speech engine, so they
 * report codes or English, and these put that in the reader's language when it is shown.
 * The worker's English names, such as a reading level, stay as they were, since they are
 * also its codes.
 */

import { t } from '../lib/i18n';

/** Stands for "the worker could not run", which the client reports with no words of its own. */
export const WORKER_FAILED = 'prose:worker-failed';

/** Why the checks could not run. A message from the browser itself is passed on as it is. */
export function checksProblem(problem: string): string {
  return problem === WORKER_FAILED ? t('The worker could not run.') : problem;
}

/** The speech engine's error code, such as `synthesis-failed`, as a sentence. */
export function readAloudProblem(code: string): string {
  return t('The voice stopped: {reason}', { reason: code });
}
