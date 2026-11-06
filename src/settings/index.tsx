import { useState } from 'react';

import { useNav } from '../state/nav';
import { MAX_SCALE, MIN_SCALE, useSettings } from '../state/settings';
import { LINE_SPACING, PAGE_WIDTH, THEMES, WRITING_FONTS, type ParagraphStyle } from '../lib/settings';
import { t } from '../lib/i18n';
import { useLocale } from '../state/language';
import { AiSettings } from '../ai';
import { McpSettings } from '../mcp';
import { openBackups } from '../shell/BackupsDialog';
import { SupportSettings } from '../support';
import { LanguageSettings, SpellcheckLanguageNote } from './LanguageSettings';
import { HistoryRetention } from './HistoryRetention';

const tabs = () => [
  { id: 'appearance', label: t('Appearance') },
  { id: 'editor', label: t('Writing') },
  { id: 'language', label: t('Language') },
  { id: 'saving', label: t('Saving') },
  { id: 'ai', label: t('AI') },
  { id: 'support', label: t('Updates and logs') },
  { id: 'mcp', label: t('AI tools (MCP)') },
];

/** Theme names and descriptions in the interface language. The theme's own is the fallback. */
function themeText(id: string): { name: string; description: string } | null {
  const text: Record<string, { name: string; description: string }> = {
    encyclopedia: { name: t('Encyclopedia'), description: t('Clean reference-book styling, the default') },
    parchment: { name: t('Parchment'), description: t('Warm paper and old-style serif type') },
    typewriter: { name: t('Typewriter'), description: t('Stark contrast and monospaced type') },
    midnight: { name: t('Midnight Ink'), description: t('Deep blue tones and a modern serif') },
    lorekeeper: { name: t('Lorekeeper'), description: t('Sepia ink, parchment and terracotta') },
    contrast: { name: t('High contrast'), description: t('The strongest text contrast, and clear borders') },
  };
  return text[id] ?? null;
}

/** Font names that say what the font is for, in the interface language. */
function fontName(font: { id: string; name: string }): string {
  if (font.id === 'opendyslexic') return t('OpenDyslexic (dyslexia-friendly)');
  if (font.id === 'atkinson') return t('Atkinson Hyperlegible (letters easy to tell apart)');
  return font.name;
}

function ScaleRow(props: { label: string; hint: string; value: number; onChange: (v: number) => void }) {
  useLocale();
  return (
    <label className="field">
      <span className="field-label">
        {t('{setting}: {percent}%', { setting: props.label, percent: Math.round(props.value * 100) })}
      </span>
      <input
        type="range"
        min={MIN_SCALE}
        max={MAX_SCALE}
        step={0.05}
        value={props.value}
        aria-label={props.label}
        style={{ width: '20rem', accentColor: 'var(--accent)' }}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      <span className="field-hint">{props.hint}</span>
    </label>
  );
}

function Appearance() {
  useLocale();
  const appearance = useSettings((s) => s.settings.appearance);
  const update = useSettings((s) => s.update);
  return (
    <section>
      <fieldset className="settings-group">
        <legend className="field-label">{t('Theme')}</legend>
        <div className="theme-grid">
          {THEMES.map((theme) => (
            <button
              key={theme.id}
              type="button"
              className={`theme-card${appearance.theme === theme.id ? ' is-active' : ''}`}
              aria-pressed={appearance.theme === theme.id}
              onClick={() => void update({ appearance: { theme: theme.id } })}
            >
              <strong>{themeText(theme.id)?.name ?? theme.name}</strong>
              <span className="muted small">{themeText(theme.id)?.description ?? theme.description}</span>
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="settings-group">
        <legend className="field-label">{t('Mode')}</legend>
        <div className="segmented" role="group">
          {(['dark', 'light'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`btn${appearance.mode === mode ? ' btn-primary' : ''}`}
              aria-pressed={appearance.mode === mode}
              onClick={() => void update({ appearance: { mode } })}
            >
              {mode === 'dark' ? t('Dark') : t('Light')}
            </button>
          ))}
        </div>
      </fieldset>
      <ScaleRow
        label={t('Writing text size')}
        hint={t('Articles and your manuscript. {bigger} and {smaller} also change it.', {
          bigger: 'Ctrl+=',
          smaller: 'Ctrl+-',
        })}
        value={appearance.contentScale}
        onChange={(contentScale) => void update({ appearance: { contentScale } })}
      />
      <ScaleRow
        label={t('Interface size')}
        hint={t('Menus, panels and buttons. {bigger} and {smaller} also change it.', {
          bigger: 'Ctrl+Shift+=',
          smaller: 'Ctrl+Shift+-',
        })}
        value={appearance.uiScale}
        onChange={(uiScale) => void update({ appearance: { uiScale } })}
      />
    </section>
  );
}

function RangeRow(props: {
  label: string;
  shown: string;
  hint: string;
  value: number;
  range: { min: number; max: number; step: number };
  onChange: (v: number) => void;
}) {
  useLocale();
  return (
    <label className="field">
      <span className="field-label">
        {t('{setting}: {value}', { setting: props.label, value: props.shown })}
      </span>
      <input
        type="range"
        min={props.range.min}
        max={props.range.max}
        step={props.range.step}
        value={props.value}
        aria-label={props.label}
        style={{ width: '20rem', maxWidth: '100%', accentColor: 'var(--accent)' }}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      <span className="field-hint">{props.hint}</span>
    </label>
  );
}

const paragraphStyles = (): { id: ParagraphStyle; label: string }[] => [
  { id: 'spaced', label: t('Spaced paragraphs') },
  { id: 'indented', label: t('First-line indents') },
];

/** How the manuscript looks while writing. Exports keep their own formatting. */
function ManuscriptPage() {
  useLocale();
  const editor = useSettings((s) => s.settings.editor);
  const update = useSettings((s) => s.update);
  return (
    <fieldset className="settings-group">
      <legend className="settings-legend">{t('The manuscript page')}</legend>
      <label className="field">
        <span className="field-label">{t('Writing font')}</span>
        <select
          className="select"
          value={editor.writingFont}
          onChange={(e) => void update({ editor: { writingFont: e.target.value } })}
        >
          <option value="">{t("The theme's own font")}</option>
          <optgroup label={t('Comes with LoreCraft')}>
            {WRITING_FONTS.filter((f) => f.source === 'bundled').map((f) => (
              <option key={f.id} value={f.id}>{fontName(f)}</option>
            ))}
          </optgroup>
          <optgroup label={t('On this computer')}>
            {WRITING_FONTS.filter((f) => f.source === 'system').map((f) => (
              <option key={f.id} value={f.id}>{fontName(f)}</option>
            ))}
          </optgroup>
        </select>
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={editor.writingFontInWiki}
          onChange={(e) => void update({ editor: { writingFontInWiki: e.target.checked } })}
        />
        <span>{t('Use this font for wiki articles too')}</span>
      </label>
      <RangeRow
        label={t('Line spacing')}
        shown={Number(editor.lineSpacing).toFixed(2)}
        hint={t('The space from one line to the next, as a multiple of the text size.')}
        value={editor.lineSpacing}
        range={LINE_SPACING}
        onChange={(lineSpacing) => void update({ editor: { lineSpacing } })}
      />
      <RangeRow
        label={t('Page width')}
        shown={t('{width} em', { width: editor.pageWidth })}
        hint={t('In ems, a unit that grows with the text, so the page keeps its shape at any text size.')}
        value={editor.pageWidth}
        range={PAGE_WIDTH}
        onChange={(pageWidth) => void update({ editor: { pageWidth } })}
      />
      <div className="field">
        <span className="field-label" id="paragraph-style-label">{t('Paragraphs')}</span>
        <div className="segmented" role="group" aria-labelledby="paragraph-style-label">
          {paragraphStyles().map((style) => (
            <button
              key={style.id}
              type="button"
              className={`btn${editor.paragraphStyle === style.id ? ' btn-primary' : ''}`}
              aria-pressed={editor.paragraphStyle === style.id}
              onClick={() => void update({ editor: { paragraphStyle: style.id } })}
            >
              {style.label}
            </button>
          ))}
        </div>
      </div>
      <div className="writing-preview-label field-label" id="writing-preview-label">{t('Preview')}</div>
      <div className="prose prose-manuscript writing-preview" role="group" aria-labelledby="writing-preview-label" data-testid="writing-preview">
        <p>{t('The lamps along the causeway had burned out one by one, and nobody had come to fill them.')}</p>
        <p>
          {t(
            'She counted eleven dark posts between the gate and the water. The twelfth still held a little light, low and blue, like something trying not to be noticed.',
          )}
        </p>
        <p>{t('"Leave it," said the ferryman. She went on walking.')}</p>
      </div>
      <button
        type="button"
        className="btn writing-reset"
        onClick={() =>
          void update({
            editor: {
              writingFont: '',
              writingFontInWiki: false,
              lineSpacing: LINE_SPACING.standard,
              pageWidth: PAGE_WIDTH.standard,
              paragraphStyle: 'spaced',
            },
          })
        }
      >
        {t('Go back to the standard page')}
      </button>
    </fieldset>
  );
}

function Writing() {
  useLocale();
  const editor = useSettings((s) => s.settings.editor);
  const update = useSettings((s) => s.update);
  return (
    <section>
      <ManuscriptPage />
      <label className="checkbox">
        <input
          type="checkbox"
          checked={editor.spellcheck}
          onChange={(e) => void update({ editor: { spellcheck: e.target.checked } })}
        />
        <span>{t('Check spelling as I type')}</span>
      </label>
      <SpellcheckLanguageNote />
      <label className="checkbox">
        <input
          type="checkbox"
          checked={editor.typewriterScroll}
          onChange={(e) => void update({ editor: { typewriterScroll: e.target.checked } })}
        />
        <span>{t('Keep the current line in the middle of the screen while writing')}</span>
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={editor.highlightNames}
          onChange={(e) => void update({ editor: { highlightNames: e.target.checked } })}
        />
        <span>{t('Underline the names of wiki pages in the manuscript')}</span>
      </label>
      <label className="field" style={{ maxWidth: '14rem' }}>
        <span className="field-label">{t('Daily word goal')}</span>
        <input
          className="input"
          type="number"
          min={0}
          step={50}
          value={editor.dailyWordGoal}
          onChange={(e) => void update({ editor: { dailyWordGoal: Math.max(0, Number(e.target.value) || 0) } })}
        />
      </label>
    </section>
  );
}

function Saving() {
  useLocale();
  const save = useSettings((s) => s.settings.save);
  const update = useSettings((s) => s.update);
  return (
    <section>
      <p className="muted" style={{ marginBottom: '1rem', maxWidth: '40rem' }}>
        {t(
          'Every edit goes straight to a recovery copy, so a crash does not lose your work. Your project file changes only when you save, as in Word.',
        )}
      </p>
      <label className="field" style={{ maxWidth: '20rem' }}>
        <span className="field-label">{t('Save to the file automatically')}</span>
        <select
          className="select"
          value={save.autoSaveMinutes}
          onChange={(e) => void update({ save: { autoSaveMinutes: Number(e.target.value) } })}
        >
          <option value={0}>{t("Off, I'll save myself")}</option>
          <option value={1}>{t('Every minute')}</option>
          <option value={5}>{t('Every {count} minutes', { count: 5 })}</option>
          <option value={15}>{t('Every {count} minutes', { count: 15 })}</option>
        </select>
      </label>
      <label className="field" style={{ maxWidth: '14rem' }}>
        <span className="field-label">{t('Backups to keep per project')}</span>
        <input
          className="input"
          type="number"
          min={0}
          max={200}
          value={save.backupsToKeep}
          onChange={(e) => void update({ save: { backupsToKeep: Math.max(0, Number(e.target.value) || 0) } })}
        />
        <span className="field-hint">{t('Each save keeps a copy of the previous file. 0 turns this off.')}</span>
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={save.reopenLast}
          onChange={(e) => void update({ save: { reopenLast: e.target.checked } })}
        />
        <span>{t('Reopen the last project at startup, with its tabs and your place in each document')}</span>
      </label>
      <button type="button" className="btn" onClick={() => void openBackups()}>
        {t('Browse backups…')}
      </button>
      <HistoryRetention />
    </section>
  );
}

export function SettingsView({ tab }: { tab?: string }) {
  useLocale();
  const replace = useNav((s) => s.replace);
  const [fallback] = useState('appearance');
  const active = tab ?? fallback;
  return (
    <div className="view-pad">
      <h1 className="view-title">{t('Settings')}</h1>
      <div className="settings-tabs" role="tablist">
        {tabs().map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active === item.id}
            className={`settings-tab${active === item.id ? ' is-active' : ''}`}
            onClick={() => replace({ view: 'settings', tab: item.id })}
          >
            {item.label}
          </button>
        ))}
      </div>
      {active === 'appearance' && <Appearance />}
      {active === 'editor' && <Writing />}
      {active === 'language' && <LanguageSettings />}
      {active === 'saving' && <Saving />}
      {active === 'ai' && <AiSettings />}
      {active === 'support' && <SupportSettings />}
      {active === 'mcp' && <McpSettings />}
    </div>
  );
}
