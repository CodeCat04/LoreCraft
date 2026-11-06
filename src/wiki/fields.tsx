/** Form fields with autocomplete: page titles, lists of titles and tags. */

import { useId, useRef, useState, type KeyboardEvent, type Ref } from 'react';

import { foldName, rankTitles } from '../editor/linkSuggest';
import { useLocale } from '../state/language';
import { useTitles } from '../state/project';
import { t } from '../lib/i18n';

export interface ComboOption {
  key: string;
  label: string;
  hint?: string;
}

interface ComboProps {
  value: string;
  onChange: (value: string) => void;
  /** Already filtered for the current value. */
  options: ComboOption[];
  onPick: (option: ComboOption) => void;
  /** Enter with nothing highlighted. */
  onEnter?: () => void;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  onBlur?: () => void;
  inputRef?: Ref<HTMLInputElement>;
  className?: string;
  placeholder?: string;
  label?: string;
  labelledBy?: string;
}

/** A text input with a list of suggestions, following the ARIA combobox pattern. */
export function ComboInput(props: ComboProps) {
  const { value, onChange, options, onPick } = props;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const showing = open && options.length > 0;
  const activeIndex = showing && active >= 0 ? Math.min(active, options.length - 1) : -1;
  const activeOption = activeIndex >= 0 ? options[activeIndex] : undefined;

  const pick = (option: ComboOption) => {
    onPick(option);
    setOpen(false);
    setActive(-1);
  };

  return (
    <div className="wiki-combo">
      <input
        ref={props.inputRef}
        className={`input ${props.className ?? ''}`}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showing}
        aria-controls={showing ? listId : undefined}
        aria-activedescendant={activeOption ? `${listId}-${activeIndex}` : undefined}
        aria-label={props.label}
        aria-labelledby={props.labelledBy}
        placeholder={props.placeholder}
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          setActive(-1);
          props.onBlur?.();
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setOpen(true);
            if (options.length > 0) {
              const step = e.key === 'ArrowDown' ? 1 : -1;
              const from = active < 0 && step < 0 ? 0 : active;
              setActive((from + step + options.length) % options.length);
            }
            return;
          }
          if (e.key === 'Enter') {
            if (activeOption) {
              e.preventDefault();
              pick(activeOption);
              return;
            }
            if (props.onEnter) {
              e.preventDefault();
              props.onEnter();
            }
          } else if (e.key === 'Escape' && showing) {
            setOpen(false);
            setActive(-1);
          }
          props.onKeyDown?.(e);
        }}
      />
      {showing && (
        <ul id={listId} className="wiki-combo-list" role="listbox">
          {options.map((option, index) => (
            <li
              key={option.key}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={activeOption === option}
              className={`wiki-combo-item${activeOption === option ? ' is-active' : ''}`}
              // Keeps focus in the input.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(option)}
            >
              <span className="truncate">{option.label}</span>
              {option.hint && <span className="faint truncate wiki-combo-hint">{option.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function useTitleOptions(query: string, except: string[] = []): ComboOption[] {
  const entries = useTitles((s) => s.entries);
  if (!query.trim()) return [];
  const skip = new Set(except.map(foldName));
  const options: ComboOption[] = [];
  for (const { entry, alias } of rankTitles(query, entries, 8)) {
    if (!skip.has(foldName(entry.title))) {
      options.push({ key: entry.id, label: entry.title, hint: alias ? `also ${alias}` : undefined });
    }
  }
  return options;
}

/** One page title. Anything typed is kept, since a link to a new page is allowed. */
export function TitleInput(props: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  inputRef?: Ref<HTMLInputElement>;
}) {
  useLocale();
  const options = useTitleOptions(props.value, [props.value]);
  return (
    <ComboInput
      value={props.value}
      onChange={props.onChange}
      options={options}
      onPick={(option) => props.onChange(option.label)}
      label={props.label}
      inputRef={props.inputRef}
      placeholder={t('Page name')}
    />
  );
}

/** Comma-separated page titles, with autocomplete on the one being typed. */
export function TitlesInput(props: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const { value, onChange } = props;
  useLocale();
  const comma = value.lastIndexOf(',');
  const head = comma >= 0 ? value.slice(0, comma + 1) : '';
  const current = value.slice(comma + 1);
  const listed = head.split(',').map((t) => t.trim()).filter(Boolean);
  // This field is comma-separated, so a title with a comma in it would read as two.
  const options = useTitleOptions(current, listed).filter((option) => !option.label.includes(','));
  return (
    <ComboInput
      value={value}
      onChange={onChange}
      options={options}
      onPick={(option) => onChange(`${head ? `${head} ` : ''}${option.label}, `)}
      label={props.label}
      inputRef={props.inputRef}
      placeholder={t('Page names, separated by commas')}
    />
  );
}

/** A list of short values shown as removable chips. */
export function TagInput(props: {
  values: string[];
  onChange: (values: string[]) => void;
  /** Known values to suggest. */
  suggestions?: string[];
  labelledBy: string;
  placeholder?: string;
}) {
  const { values, onChange, suggestions = [] } = props;
  useLocale();
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const add = (raw: string) => {
    const value = raw.trim().replace(/\s+/g, ' ');
    setDraft('');
    if (!value) return;
    const key = foldName(value);
    if (!values.some((v) => foldName(v) === key)) onChange([...values, value]);
  };

  const q = foldName(draft);
  const taken = new Set(values.map(foldName));
  const options: ComboOption[] = q
    ? suggestions
        .filter((s) => !taken.has(foldName(s)) && foldName(s).includes(q))
        .slice(0, 8)
        .map((s) => ({ key: s, label: s }))
    : [];

  return (
    <div className="wiki-tags">
      {values.map((value) => (
        <span key={value} className="wiki-tag">
          <span className="wiki-tag-text">{value}</span>
          <button
            type="button"
            className="wiki-tag-remove"
            aria-label={t('Remove {name}', { name: value })}
            onClick={() => {
              onChange(values.filter((v) => v !== value));
              inputRef.current?.focus();
            }}
          >
            ×
          </button>
        </span>
      ))}
      <ComboInput
        inputRef={inputRef}
        className="wiki-tags-input"
        value={draft}
        onChange={(next) => {
          // A pasted or typed comma finishes a value.
          if (next.includes(',')) {
            const parts = next.split(',');
            const last = parts.pop() ?? '';
            const merged = [...values];
            for (const part of parts) {
              const value = part.trim().replace(/\s+/g, ' ');
              if (value && !merged.some((v) => foldName(v) === foldName(value))) merged.push(value);
            }
            if (merged.length !== values.length) onChange(merged);
            setDraft(last.trimStart());
            return;
          }
          setDraft(next);
        }}
        options={options}
        onPick={(option) => add(option.label)}
        onEnter={() => add(draft)}
        onBlur={() => add(draft)}
        onKeyDown={(e) => {
          if (e.key === 'Backspace' && !draft && values.length > 0) {
            onChange(values.slice(0, -1));
          }
        }}
        labelledBy={props.labelledBy}
        placeholder={values.length === 0 ? props.placeholder : undefined}
      />
    </div>
  );
}
