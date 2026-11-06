/**
 * The worker reports in English or in codes, since it has no interface language, and the panel
 * translates. These check that what it reports stays the same, and what people see does not.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { setLocale } from '../lib/i18n';
import { analyze, type ProseSegment } from './analyze';
import { checksProblem, readAloudProblem, WORKER_FAILED } from './messages';

afterEach(async () => {
  await setLocale('en');
});

const paragraph = (text: string): ProseSegment => ({ text, from: 1 });

describe('prose messages', () => {
  it('turns codes into sentences in the interface language', async () => {
    expect(checksProblem(WORKER_FAILED)).toBe('The worker could not run.');
    expect(checksProblem('Out of memory')).toBe('Out of memory');
    expect(readAloudProblem('synthesis-failed')).toBe('The voice stopped: synthesis-failed');
    await setLocale('es');
    expect(checksProblem(WORKER_FAILED)).toBe('El proceso de revisión no pudo ejecutarse.');
    expect(readAloudProblem('synthesis-failed')).toBe('La voz se detuvo: synthesis-failed');
  });

  it('leaves what the worker reports in English, whatever the interface language', async () => {
    await setLocale('de');
    const report = analyze([paragraph(`${'The cat sat. '.repeat(12)}`)]);
    expect(report.readingLevel).toBe('Very easy');
    expect(report.sentenceLengths.map((bucket) => bucket.label)).toEqual([
      '1 to 5', '6 to 10', '11 to 15', '16 to 20', '21 to 30', '31 to 40', 'Over 40',
    ]);
  });
});
