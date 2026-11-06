/** The writer's own rules for a project, with optional overrides for each book. */

import { useCallback, useEffect, useRef, useState } from 'react';

import * as api from '../lib/api';
import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { toast } from '../shell/toasts';
import { useDataVersion, useLoad } from '../state/events';
import { useLocale } from '../state/language';
import { useProject } from '../state/project';
import type { Book } from '../lib/types';
import { GUIDE_FIELDS, SAMPLE_WORD_LIMIT, type GuideFieldInfo } from './guide';
import { countWords } from './prompt';
import { loadGuideAfterSaves, resolveStyleInstructions, saveGuide } from './store';
import type { GuideField, StyleGuide } from './types';

const OTHER = '__other__';

/** The field's name on screen. `GUIDE_FIELDS` keeps the English. */
function fieldLabel(key: GuideField): string {
  switch (key) {
    case 'tense': return t('Tense');
    case 'pov': return t('Point of view');
    case 'distance': return t('Narrative distance');
    case 'spelling': return t('Spelling');
    case 'dialogue': return t('Dialogue punctuation');
    case 'content': return t('Content and tone');
    case 'voice': return t('Voice notes');
    case 'avoid': return t('Words and phrases to avoid');
    case 'prefer': return t('Words and phrases to prefer');
    case 'sample': return t('Sample of your prose to match');
  }
}

function fieldHint(key: GuideField): string | undefined {
  switch (key) {
    case 'content': return t('For example how much violence or swearing, or how dark it gets.');
    case 'voice': return t('Anything else about how this book should sound.');
    case 'avoid':
    case 'prefer':
      return t('One per line, or separated by commas.');
    case 'sample': return t('A short passage in your own voice. Only the first 300 words are sent.');
    default: return undefined;
  }
}

/** A common answer on screen. The stored value, which the AI reads, stays in English. */
function optionText(option: string): string {
  switch (option) {
    case 'Past tense': return t('Past tense');
    case 'Present tense': return t('Present tense');
    case 'Future tense': return t('Future tense');
    case 'First person': return t('First person');
    case 'Second person': return t('Second person');
    case 'Third person limited': return t('Third person limited');
    case 'Third person omniscient': return t('Third person omniscient');
    case 'Multiple viewpoints, one per chapter': return t('Multiple viewpoints, one per chapter');
    case 'Deep, right inside one mind': return t('Deep, right inside one mind');
    case 'Close, with some narration of its own': return t('Close, with some narration of its own');
    case 'Moderate, like a storyteller nearby': return t('Moderate, like a storyteller nearby');
    case 'Distant, like a historian': return t('Distant, like a historian');
    case 'US English': return t('US English');
    case 'UK English': return t('UK English');
    case 'Canadian English': return t('Canadian English');
    case 'Australian English': return t('Australian English');
    case 'Irish English': return t('Irish English');
    case 'Indian English': return t('Indian English');
    case 'Double quotation marks': return t('Double quotation marks');
    case 'Single quotation marks, double inside': return t('Single quotation marks, double inside');
    case 'Em dashes to open speech': return t('Em dashes to open speech');
    case 'No quotation marks': return t('No quotation marks');
    default: return option;
  }
}

/** A list of common answers, with a text box for anything else. */
function ChoiceField(props: {
  info: GuideFieldInfo;
  value: string;
  inherited: string;
  bookScope: boolean;
  onChange: (value: string) => void;
}) {
  useLocale();
  const { info, value, inherited, bookScope, onChange } = props;
  const options = info.options ?? [];
  const isListed = value === '' || options.includes(value);
  const [typing, setTyping] = useState(!isListed);
  const showBox = typing || !isListed;
  const emptyLabel = bookScope
    ? inherited
      ? t('Same as the project: {value}', { value: optionText(inherited) })
      : t('Same as the project: not set')
    : t('Not set');
  const label = fieldLabel(info.key);
  return (
    <label className="field styles-guide-choice">
      <span className="field-label">{label}</span>
      <select
        className="select"
        value={showBox ? OTHER : value}
        onChange={(e) => {
          if (e.target.value === OTHER) {
            setTyping(true);
          } else {
            setTyping(false);
            onChange(e.target.value);
          }
        }}
      >
        <option value="">{emptyLabel}</option>
        {options.map((option) => <option key={option} value={option}>{optionText(option)}</option>)}
        <option value={OTHER}>{t('Other…')}</option>
      </select>
      {showBox && (
        <input
          className="input styles-guide-other"
          aria-label={t('{field}, in your own words', { field: label })}
          placeholder={t('In your own words')}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  );
}

function GuideForm({ bookId, initial, inherited }: { bookId: string | null; initial: StyleGuide; inherited: StyleGuide }) {
  useLocale();
  const [guide, setGuide] = useState<StyleGuide>(initial);
  const [state, setState] = useState<'saved' | 'saving'>('saved');
  const latest = useRef(guide);
  latest.current = guide;
  const pending = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    if (!pending.current) return;
    pending.current = false;
    try {
      await saveGuide(latest.current, bookId);
      if (!pending.current) setState('saved');
    } catch (e) {
      toast(t('Could not save the style guide: {reason}', { reason: errorMessage(e) }), 'error');
    }
  }, [bookId]);

  // Whatever is still waiting goes when the form closes, such as on changing tabs.
  useEffect(() => () => void flush(), [flush]);

  const change = (key: GuideField, value: string) => {
    const next = { ...latest.current };
    if (value) next[key] = value;
    else delete next[key];
    setGuide(next);
    latest.current = next;
    pending.current = true;
    setState('saving');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), 400);
  };

  const sampleWords = countWords(guide.sample ?? '');
  return (
    <form className="styles-guide-form" onSubmit={(e) => e.preventDefault()} onBlur={() => void flush()} aria-label={bookId ? t('Style guide for this book') : t('Style guide for this project')}>
      <div className="styles-guide-choices">
        {GUIDE_FIELDS.filter((f) => f.control === 'choice').map((info) => (
          <ChoiceField
            key={info.key}
            info={info}
            value={guide[info.key] ?? ''}
            inherited={inherited[info.key] ?? ''}
            bookScope={!!bookId}
            onChange={(value) => change(info.key, value)}
          />
        ))}
      </div>
      {GUIDE_FIELDS.filter((f) => f.control !== 'choice').map((info) => {
        const hint = fieldHint(info.key);
        return (
          <label key={info.key} className="field">
            <span className="field-label">{fieldLabel(info.key)}</span>
            <textarea
              className="textarea"
              rows={info.key === 'sample' ? 6 : 3}
              value={guide[info.key] ?? ''}
              placeholder={bookId && inherited[info.key] ? t('Same as the project: {value}', { value: inherited[info.key] ?? '' }) : undefined}
              onChange={(e) => change(info.key, e.target.value)}
            />
            {hint && <span className="field-hint">{hint}</span>}
            {info.key === 'sample' && sampleWords > SAMPLE_WORD_LIMIT && (
              <span className="field-hint styles-over">
                {t('This is {count} words, so only the first {limit} are sent.', { count: sampleWords, limit: SAMPLE_WORD_LIMIT })}
              </span>
            )}
          </label>
        );
      })}
      <p className="faint small" role="status" data-testid="guide-save-state">{state === 'saved' ? t('Saved in this project') : t('Saving…')}</p>
    </form>
  );
}

function Preview({ bookId }: { bookId: string | null }) {
  const locale = useLocale();
  const version = useDataVersion('meta');
  const { data } = useLoad(() => resolveStyleInstructions({ bookId }), [version, bookId, locale]);
  const words = data?.text ? countWords(data.text) : 0;
  return (
    <section className="styles-section styles-guide-preview" aria-label={t('What the AI receives')}>
      <div className="styles-section-head">
        <h3>{t('What the AI receives')}</h3>
        {data && data.text && <span className="faint small">{words === 1 ? t('1 word') : t('{count} words', { count: words })}</span>}
      </div>
      {data && !data.text && <p className="muted">{t('Nothing yet. Fill in a rule, or choose a style in Browse, and it appears here.')}</p>}
      {data && data.text && (
        <>
          <pre className="styles-prompt" tabIndex={0} aria-label={t('Text given to the AI')} data-testid="style-instructions">{data.text}</pre>
          <p className="faint small" data-testid="style-sources">{data.sources.join(' · ')}</p>
        </>
      )}
    </section>
  );
}

export function GuideTab() {
  useLocale();
  const isOpen = useProject((s) => s.status.open);
  const bookVersion = useDataVersion('books');
  const [bookId, setBookId] = useState<string>('');
  const { data: books } = useLoad(() => (isOpen ? api.books.list() : Promise.resolve([] as Book[])), [isOpen, bookVersion]);
  // The form keeps its own draft. This only decides what it starts from.
  const [loaded, setLoaded] = useState<{ project: StyleGuide; book: StyleGuide; key: string } | null>(null);
  const key = bookId || 'project';

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    void loadGuideAfterSaves().then((stored) => {
      if (!cancelled) setLoaded({ project: stored.project ?? {}, book: bookId ? stored.books?.[bookId] ?? {} : {}, key });
    });
    return () => {
      cancelled = true;
    };
    // Reloads on changing scope, not on this form's own saves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, isOpen]);

  if (!isOpen) {
    return (
      <div className="styles-empty">
        <p>{t('A style guide belongs to a project.')}</p>
        <p className="muted">{t('Open or create a project to set its tense, point of view, words to avoid and more.')}</p>
      </div>
    );
  }

  return (
    <div className="styles-scroll">
      <div className="styles-guide">
        <div className="styles-guide-main">
          <p className="muted styles-intro">
            {t('Your rules for this project. The AI follows them over any style. Empty fields add nothing.')}
          </p>
          <label className="field styles-guide-scope">
            <span className="field-label">{t('Rules for')}</span>
            <select className="select" value={bookId} onChange={(e) => setBookId(e.target.value)}>
              <option value="">{t('The whole project')}</option>
              {(books ?? []).map((book) => <option key={book.id} value={book.id}>{t('Only {book}', { book: book.title })}</option>)}
            </select>
            {bookId && <span className="field-hint">{t("Anything you fill in here replaces the project's rule for this book.")}</span>}
          </label>
          {loaded && loaded.key === key && (
            <GuideForm
              key={key}
              bookId={bookId || null}
              initial={bookId ? loaded.book : loaded.project}
              inherited={bookId ? loaded.project : {}}
            />
          )}
        </div>
        <Preview bookId={bookId || null} />
      </div>
    </div>
  );
}
