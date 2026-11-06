/** Prose checks for a scene, chapter or book, beside the text. Nothing here changes the text. */

import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';

import { CHECKS, type CheckId, type LengthBucket, type ProseReport, type ReadingLevel } from './analyze';
import { clearProseHighlights, setCurrentMatch } from './highlights';
import { checksProblem, readAloudProblem } from './messages';
import { pauseReading, RATES, resumeReading, setRate, setVoice, startReading, stopReading, useReadAloud, watchVoices } from './readAloud';
import { runChecks, setCheckEnabled, setProseOpen, setProseScope, showHighlights, stepKey, stepMatch, useProse, type ProseScope } from './store';
import { waitForEditor } from '../editor/ai/registry';
import { t } from '../lib/i18n';
import { formatNumber } from '../lib/text';
import { useDataVersion } from '../state/events';
import { useLocale } from '../state/language';
import { useTitles } from '../state/project';
import { useUi } from '../state/ui';

interface CheckInfo {
  label: string;
  hint: string;
  /** The checkbox, for a screen reader. */
  highlight: string;
  /** The count button, for a screen reader. */
  count: (count: number) => string;
}

/** Built when shown, so it is in the current interface language. Each sentence is whole. */
function checkInfo(): Record<CheckId, CheckInfo> {
  return {
    overused: {
      label: t('Overused words and phrases'),
      hint: t('Said more often here than in the rest of the text. Names do not count.'),
      highlight: t('Highlight overused words and phrases'),
      count: (count) => t('{count} overused words and phrases. Show the next one', { count }),
    },
    repeated: {
      label: t('Repeated close together'),
      hint: t('The same word again within a few words.'),
      highlight: t('Highlight repeated close together'),
      count: (count) => t('{count} repeated close together. Show the next one', { count }),
    },
    doubled: {
      label: t('Doubled words'),
      hint: t('The same word twice in a row, as in "the the".'),
      highlight: t('Highlight doubled words'),
      count: (count) => t('{count} doubled words. Show the next one', { count }),
    },
    longSentence: {
      label: t('Very long sentences'),
      hint: t('Sentences over 35 words.'),
      highlight: t('Highlight very long sentences'),
      count: (count) => t('{count} very long sentences. Show the next one', { count }),
    },
    adverb: {
      label: t('Adverbs'),
      hint: t("Words ending in -ly that may be doing a stronger verb's job."),
      highlight: t('Highlight adverbs'),
      count: (count) => t('{count} adverbs. Show the next one', { count }),
    },
    filter: {
      label: t('Filter words'),
      hint: t('Words like felt, saw and seemed, which put distance between the reader and the event.'),
      highlight: t('Highlight filter words'),
      count: (count) => t('{count} filter words. Show the next one', { count }),
    },
    passive: {
      label: t('Passive-looking phrases'),
      hint: t('Phrases like "was opened". Some are fine, so this is only a prompt to look.'),
      highlight: t('Highlight passive-looking phrases'),
      count: (count) => t('{count} passive-looking phrases. Show the next one', { count }),
    },
  };
}

function scopes(): { scope: ProseScope; label: string }[] {
  return [
    { scope: 'scene', label: t('Scene') },
    { scope: 'chapter', label: t('Chapter') },
    { scope: 'book', label: t('Book') },
  ];
}

/** The worker names a reading level in English, which serves as its code. */
function readingLevelLabel(level: ReadingLevel): string {
  switch (level) {
    case 'Very easy':
      return t('Very easy');
    case 'Easy':
      return t('Easy');
    case 'Average':
      return t('Average');
    case 'Difficult':
      return t('Difficult');
    default:
      return t('Very difficult');
  }
}

/** The worker labels a row of the chart in English, so the row is named again from its range. */
function bucketLabel(bucket: LengthBucket): string {
  return Number.isFinite(bucket.max)
    ? t('{min} to {max}', { min: bucket.min, max: bucket.max })
    : t('Over {count}', { count: bucket.min - 1 });
}

/** How long after the last change the checks run again. */
const RUN_DELAY_MS = 500;

function minutes(value: number): string {
  if (value < 1) return t('under a minute');
  const rounded = Math.round(value);
  if (rounded < 60) return rounded === 1 ? t('1 minute') : t('{count} minutes', { count: rounded });
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return t('{hours} h {minutes} min', { hours, minutes: rest });
}

function CheckRow({ check, report, sceneId }: { check: CheckId; report: ProseReport; sceneId: string }) {
  useLocale();
  const on = useProse((s) => s.enabled[check]);
  const step = useProse((s) => s.steps[check]);
  const info = checkInfo()[check];
  const count = report.matches[check].length;
  return (
    <li className="prose-check">
      <label className="prose-check-label" title={info.hint}>
        <input type="checkbox" checked={on} aria-label={info.highlight} onChange={(e) => setCheckEnabled(check, e.target.checked)} />
        <span className={`prose-swatch prose-swatch-${check}`} aria-hidden="true" />
        <span>{info.label}</span>
      </label>
      {step !== undefined && count > 0 && (
        <span className="prose-check-step">{t('{number} of', { number: Math.min(step, count - 1) + 1 })}</span>
      )}
      <button
        type="button"
        className="btn btn-sm prose-check-count"
        disabled={count === 0}
        data-check={check}
        title={count === 0 ? t('None found') : t('Show the next one. Hold Shift for the one before.')}
        aria-label={info.count(count)}
        onClick={(e) => void stepMatch(check, e.shiftKey ? -1 : 1, sceneId)}
      >
        {formatNumber(count)}
      </button>
    </li>
  );
}

function OverusedList({ report, sceneId }: { report: ProseReport; sceneId: string }) {
  useLocale();
  const steps = useProse((s) => s.steps);
  if (report.overused.length === 0) return null;
  return (
    <details className="prose-terms">
      <summary>{t('Which words and phrases')}</summary>
      <ul className="prose-term-list">
        {report.overused.map((term) => {
          const step = steps[stepKey('overused', term.text)];
          return (
            <li key={term.text}>
              <button
                type="button"
                className="prose-term"
                title={
                  term.restPerThousand === null
                    ? t('{rate} per 1,000 words', { rate: term.perThousand.toFixed(1) })
                    : t('{rate} per 1,000 words here, {rest} in the rest of the text', {
                        rate: term.perThousand.toFixed(1),
                        rest: term.restPerThousand.toFixed(1),
                      })
                }
                onClick={(e) => void stepMatch('overused', e.shiftKey ? -1 : 1, sceneId, term.text)}
              >
                <span className="prose-term-text">{term.text}</span>
                {step !== undefined && <span className="prose-check-step">{t('{number} of', { number: step + 1 })}</span>}
                <span className="prose-term-count">{formatNumber(term.count)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function LengthChart({ buckets }: { buckets: LengthBucket[] }) {
  useLocale();
  const largest = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <table className="prose-lengths">
      <caption>{t('Sentence length, in words')}</caption>
      <thead className="visually-hidden">
        <tr>
          <th scope="col">{t('Words')}</th>
          <th scope="col">{t('Share')}</th>
          <th scope="col">{t('Sentences')}</th>
        </tr>
      </thead>
      <tbody>
        {buckets.map((bucket) => (
          <tr
            key={bucket.label}
            title={
              bucket.count === 1
                ? t('{range} words: 1 sentence', { range: bucketLabel(bucket) })
                : t('{range} words: {count} sentences', { range: bucketLabel(bucket), count: bucket.count })
            }
          >
            <th scope="row">{bucketLabel(bucket)}</th>
            <td className="prose-lengths-bar-cell" aria-hidden="true">
              {bucket.count > 0 && <span className="prose-lengths-bar" style={{ width: `${(bucket.count / largest) * 100}%` }} />}
            </td>
            <td className="prose-lengths-count">{formatNumber(bucket.count)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ReadAloud({ editor }: { editor: Editor | null }) {
  useLocale();
  const supported = useReadAloud((s) => s.supported);
  const voices = useReadAloud((s) => s.voices);
  const voicesKnown = useReadAloud((s) => s.voicesKnown);
  const voiceUri = useReadAloud((s) => s.voiceUri);
  const rate = useReadAloud((s) => s.rate);
  const status = useReadAloud((s) => s.status);
  const problem = useReadAloud((s) => s.problem);
  useEffect(() => watchVoices(), []);

  const unavailable = !supported
    ? t('Reading aloud is not available in this version of the system.')
    : voicesKnown && voices.length === 0
      ? t('This computer has no speech voices installed, so nothing can be read aloud. Voices can be added in the system’s speech settings.')
      : null;

  return (
    <section className="prose-section" aria-labelledby="prose-read-title">
      <h3 id="prose-read-title" className="prose-heading">{t('Read aloud')}</h3>
      {unavailable ? (
        <p className="muted small" role="status">{unavailable}</p>
      ) : (
        <>
          <p className="muted small prose-read-hint">{t('Reads the selection, or from the cursor to the end of the scene.')}</p>
          <label className="field prose-field">
            <span className="field-label">{t('Voice')}</span>
            <select className="select prose-select" value={voiceUri ?? ''} onChange={(e) => setVoice(e.target.value)}>
              <option value="">{t('System default')}</option>
              {voices.map((voice) => (
                <option key={voice.uri} value={voice.uri}>{voice.name}</option>
              ))}
            </select>
          </label>
          <label className="field prose-field">
            <span className="field-label">{t('Speed')}</span>
            <select className="select prose-select" value={rate} onChange={(e) => setRate(Number(e.target.value))}>
              {RATES.map((value) => (
                <option key={value} value={value}>{value === 1 ? t('Normal') : t('{rate} times', { rate: value })}</option>
              ))}
            </select>
          </label>
          <div className="prose-read-buttons">
            {status === 'idle' && (
              <button type="button" className="btn btn-sm btn-primary" disabled={!editor} onClick={() => editor && startReading(editor)}>
                {t('Read aloud')}
              </button>
            )}
            {status === 'speaking' && <button type="button" className="btn btn-sm" onClick={pauseReading}>{t('Pause')}</button>}
            {status === 'paused' && <button type="button" className="btn btn-sm btn-primary" onClick={resumeReading}>{t('Resume')}</button>}
            {status !== 'idle' && <button type="button" className="btn btn-sm" onClick={stopReading}>{t('Stop')}</button>}
          </div>
          {problem && <p className="small" role="alert">{readAloudProblem(problem)}</p>}
        </>
      )}
    </section>
  );
}

function ProsePanel({ sceneId }: { sceneId: string }) {
  useLocale();
  const scope = useProse((s) => s.scope);
  const report = useProse((s) => s.report);
  const reportScope = useProse((s) => s.reportScope);
  const enabled = useProse((s) => s.enabled);
  const busy = useProse((s) => s.busy);
  const problem = useProse((s) => s.problem);
  const titles = useTitles((s) => s.entries);
  const otherScenes = useDataVersion('nodes', 'nodeContent');
  const [editor, setEditor] = useState<Editor | null>(null);
  const timer = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void waitForEditor('node', sceneId).then((entry) => {
      if (!cancelled && entry) setEditor(entry.editor);
    });
    return () => {
      cancelled = true;
    };
  }, [sceneId]);

  // Typing here starts a new reading once it pauses, and never holds up the keystroke.
  useEffect(() => {
    if (!editor) return undefined;
    const schedule = () => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void runChecks(sceneId, editor), RUN_DELAY_MS);
    };
    const onTransaction = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (transaction.docChanged) schedule();
    };
    editor.on('transaction', onTransaction);
    return () => {
      editor.off('transaction', onTransaction);
      window.clearTimeout(timer.current);
    };
  }, [editor, sceneId]);

  // Run at once when the panel opens, the scope changes or the names change.
  useEffect(() => {
    if (editor) void runChecks(sceneId, editor);
  }, [editor, sceneId, scope, titles, otherScenes]);

  useEffect(() => {
    if (editor) showHighlights(sceneId, editor);
  }, [editor, sceneId, enabled]);

  useEffect(
    () => () => {
      if (editor && !editor.isDestroyed) clearProseHighlights(editor);
    },
    [editor],
  );

  const shown = report && reportScope === scope ? report : null;

  return (
    <aside className="prose-panel" aria-label={t('Prose checks')}>
      <header className="prose-panel-head">
        <h2 className="prose-title">{t('Prose')}</h2>
        <button type="button" className="btn btn-sm" aria-label={t('Close prose checks')} onClick={() => setProseOpen(false)}>
          {t('Close')}
        </button>
      </header>
      <div className="prose-scopes" role="group" aria-label={t('What to check')}>
        {scopes().map((item) => (
          <button
            key={item.scope}
            type="button"
            aria-pressed={scope === item.scope}
            className={`write-mode${scope === item.scope ? ' is-active' : ''}`}
            onClick={() => {
              setProseScope(item.scope);
              // Stepping starts over, so nothing should look as if it is still there.
              if (editor) setCurrentMatch(editor, null);
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      {problem && <p className="small" role="alert">{t('The checks could not run: {reason}', { reason: checksProblem(problem) })}</p>}
      {!shown && !problem && <p className="muted small" role="status">{busy ? t('Reading…') : t('Nothing to check yet.')}</p>}
      {shown && (
        <>
          <section className="prose-section" aria-label={t('Overall')}>
            <dl className="prose-figures">
              <div><dt>{t('Words')}</dt><dd data-prose="words">{formatNumber(shown.words)}</dd></div>
              <div><dt>{t('Sentences')}</dt><dd>{formatNumber(shown.sentences)}</dd></div>
              <div><dt>{t('Average sentence')}</dt><dd>{t('{count} words', { count: shown.averageSentenceWords.toFixed(1) })}</dd></div>
              <div><dt>{t('Longest sentence')}</dt><dd>{t('{count} words', { count: formatNumber(shown.longestSentenceWords) })}</dd></div>
              <div>
                <dt>{t('Reading level')}</dt>
                <dd>
                  {shown.readingLevel
                    ? t('{level}, grade {grade}', { level: readingLevelLabel(shown.readingLevel), grade: Math.round(shown.gradeLevel ?? 0) })
                    : t('Not enough text')}
                </dd>
              </div>
              <div><dt>{t('Reading time')}</dt><dd>{minutes(shown.readingMinutes)}</dd></div>
              <div><dt>{t('Read aloud')}</dt><dd>{minutes(shown.speakingMinutes)}</dd></div>
            </dl>
          </section>
          <section className="prose-section" aria-labelledby="prose-checks-title">
            <h3 id="prose-checks-title" className="prose-heading">{t('Checks')}</h3>
            <p className="muted small prose-read-hint">{t('Tick one to highlight it. A number steps through the places.')}</p>
            <ul className="prose-checks">
              {CHECKS.map((check) => (
                <CheckRow key={check} check={check} report={shown} sceneId={sceneId} />
              ))}
            </ul>
            <OverusedList report={shown} sceneId={sceneId} />
          </section>
          <section className="prose-section" aria-label={t('Sentence lengths')}>
            <LengthChart buckets={shown.sentenceLengths} />
          </section>
        </>
      )}
      <ReadAloud editor={editor} />
    </aside>
  );
}

/** The panel, while it is open. Goes in the scene's layout beside the text. */
export function ProsePanelHost({ sceneId }: { sceneId: string }) {
  const open = useProse((s) => s.open);
  const focusMode = useUi((s) => s.focusMode);
  if (!open || focusMode) return null;
  return <ProsePanel sceneId={sceneId} />;
}
