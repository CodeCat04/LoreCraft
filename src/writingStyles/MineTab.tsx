/** The person's own styles, available to every project. */

import { useMemo, useState } from 'react';

import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { toast } from '../shell/toasts';
import { useLocale } from '../state/language';
import { useSettings } from '../state/settings';
import { buildStylePrompt, countWords, PROMPT_WORD_LIMIT } from './prompt';
import { deleteStyleAsking } from './removeStyle';
import { saveCustomStyle } from './store';
import { GENRES, TRAIT_FIELDS, genreLabel, traitHint, traitLabel, type CustomStyle, type Genre, type TraitKey } from './types';
import { blankStyle, goToTab, useStylesUi } from './uiStore';

function StyleEditor({ initial, onDone }: { initial: CustomStyle; onDone: () => void }) {
  useLocale();
  const [draft, setDraft] = useState<CustomStyle>(initial);
  const [saving, setSaving] = useState(false);
  const set = useStylesUi((s) => s.set);
  const prompt = useMemo(() => buildStylePrompt(draft), [draft]);
  const words = countWords(prompt);
  const problem = draft.name.trim() ? null : t('A style needs a name.');

  const patchTrait = (key: TraitKey, value: string) => setDraft((d) => ({ ...d, traits: { ...d.traits, [key]: value } }));
  const toggleGenre = (genre: Genre) =>
    setDraft((d) => ({ ...d, genres: d.genres.includes(genre) ? d.genres.filter((g) => g !== genre) : [...d.genres, genre] }));

  const save = async () => {
    if (problem || saving) return;
    setSaving(true);
    try {
      const saved = await saveCustomStyle({ ...draft, name: draft.name.trim(), promptOverride: draft.promptOverride?.trim() || undefined });
      toast(t('Saved {name}.', { name: saved.name }), 'success');
      set({ selectedId: saved.id, kind: 'custom', query: '', genre: '', favoritesOnly: false });
      onDone();
    } catch (e) {
      toast(errorMessage(e), 'error');
      setSaving(false);
    }
  };

  const title = draft.id ? t('Edit {name}', { name: initial.name }) : t('New style');
  return (
    <form
      className="styles-editor"
      aria-label={title}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2 className="styles-editor-title">{title}</h2>
      <label className="field">
        <span className="field-label">{t('Name')}</span>
        <input className="input" autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      </label>
      <label className="field">
        <span className="field-label">{t('How it reads')}</span>
        <textarea className="textarea" rows={3} value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} />
        <span className="field-hint">{t('A few sentences for you. This is not sent to the AI.')}</span>
      </label>
      <fieldset className="settings-group">
        <legend className="field-label">{t('Genres')}</legend>
        <div className="styles-genre-grid">
          {GENRES.map((g) => (
            <label key={g.id} className="checkbox">
              <input type="checkbox" checked={draft.genres.includes(g.id)} onChange={() => toggleGenre(g.id)} />
              <span>{genreLabel(g.id)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <h3 className="styles-editor-sub">{t('What the AI is told to do')}</h3>
      {TRAIT_FIELDS.map(({ key }) => (
        <label key={key} className="field">
          <span className="field-label">{traitLabel(key)}</span>
          <textarea className="textarea" rows={2} value={draft.traits[key]} onChange={(e) => patchTrait(key, e.target.value)} />
          <span className="field-hint">{traitHint(key)}</span>
        </label>
      ))}
      <label className="field">
        <span className="field-label">{t('Your own prompt')}</span>
        <textarea
          className="textarea"
          rows={4}
          value={draft.promptOverride ?? ''}
          onChange={(e) => setDraft({ ...draft, promptOverride: e.target.value })}
        />
        <span className="field-hint">{t('Optional. If you write anything here, it is sent in place of the instructions above.')}</span>
      </label>
      <section className="styles-section">
        <div className="styles-section-head">
          <h3>{t('The full prompt')}</h3>
          <span className={`small ${words > PROMPT_WORD_LIMIT ? 'styles-over' : 'faint'}`}>
            {words > PROMPT_WORD_LIMIT
              ? t('{count} words, which is long for a local model. Under {limit} works best.', { count: words, limit: PROMPT_WORD_LIMIT })
              : words === 1
                ? t('1 word')
                : t('{count} words', { count: words })}
          </span>
        </div>
        <pre className="styles-prompt" tabIndex={0} aria-label={t('Prompt for this style')}>{prompt}</pre>
      </section>
      {problem && <div className="field-error">{problem}</div>}
      <div className="styles-actions">
        <button type="submit" className="btn btn-primary" disabled={!!problem || saving}>{t('Save style')}</button>
        <button type="button" className="btn" onClick={onDone}>{t('Cancel')}</button>
      </div>
    </form>
  );
}

export function MineTab() {
  useLocale();
  const custom = useSettings((s) => s.settings.writingStyles.custom);
  const editing = useStylesUi((s) => s.editing);
  const set = useStylesUi((s) => s.set);
  const sorted = useMemo(() => [...custom].sort((a, b) => a.name.localeCompare(b.name)), [custom]);

  if (editing) {
    return (
      <div className="styles-scroll">
        <div className="styles-narrow">
          <StyleEditor key={editing.id || editing.name} initial={editing} onDone={() => set({ editing: null })} />
        </div>
      </div>
    );
  }

  return (
    <div className="styles-scroll">
      <div className="styles-narrow">
        <div className="styles-section-head styles-mine-head">
          <p className="muted">{t('Your own styles are available in every project on this computer.')}</p>
          <button type="button" className="btn btn-primary" onClick={() => set({ editing: blankStyle() })}>{t('New style')}</button>
        </div>
        {sorted.length === 0 ? (
          <div className="styles-empty">
            <p>{t('You have no styles of your own yet.')}</p>
            <p className="muted">
              {t('Press New style to write one, choose Edit a copy on any style in Browse, or build one from your own scenes.')}
            </p>
            <button type="button" className="link-button" onClick={() => goToTab('browse')}>{t('Go to Browse')}</button>
          </div>
        ) : (
          <ul className="styles-mine-list">
            {sorted.map((style) => (
              <li key={style.id} className="styles-mine-item">
                <div className="styles-mine-text">
                  <strong className="truncate">{style.name}</strong>
                  <span className="faint small truncate">
                    {style.promptOverride?.trim() ? t('Your own prompt') : style.genres.slice(0, 3).map(genreLabel).join(', ') || t('No genres')}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    set({ selectedId: style.id, kind: 'custom', query: '', genre: '', favoritesOnly: false });
                    goToTab('browse');
                  }}
                >
                  {t('Open')}
                </button>
                <button type="button" className="btn btn-sm" aria-label={t('Edit {name}', { name: style.name })} onClick={() => set({ editing: style })}>{t('Edit')}</button>
                <button type="button" className="btn btn-sm btn-danger" aria-label={t('Delete {name}', { name: style.name })} onClick={() => void deleteStyleAsking(style)}>{t('Delete')}</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
