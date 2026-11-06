/** The export screen: pick a format, say what to include, choose where it goes. */

import { useEffect, useMemo, useRef, useState } from 'react';

import * as api from '../lib/api';
import { t } from '../lib/i18n';
import { NO_PDF_MESSAGE, platform } from '../lib/platform';
import { formatNumber } from '../lib/text';
import { toast } from '../shell/toasts';
import { useDataVersion, useLoad } from '../state/events';
import { useLocale } from '../state/language';
import { useNav } from '../state/nav';
import { useProject } from '../state/project';
import { FORMATS, formatById, type ExportFormat, type FormatId } from './registry';
import { isCancelled, startExport, type ExportJob, type ExportProgress, type ExportResult } from './runner';
import { DEFAULT_OPTIONS, type ExportOptions, type ExportScope } from './types';
import { formatBytes, safeFileName } from './util';

/** Lets a command open this screen ready to export one page. */
let preset: { format: FormatId; pageId?: string } | null = null;

export function presetExport(format: FormatId, pageId?: string) {
  preset = { format, pageId };
}

function pageSizeLabel(size: ExportOptions['pageSize']): string {
  switch (size) {
    case 'pocket':
      return t('5 × 8 in');
    case 'digest':
      return t('5.5 × 8.5 in');
    case 'trade':
      return t('6 × 9 in, a trade paperback');
    case 'a5':
      return 'A5';
    case 'a4':
      return 'A4';
    case 'letter':
      return t('US Letter');
  }
}

/** What each kind of PDF offers. Printers work to book sizes, and screens to paper ones. */
const READING_SIZES: ExportOptions['pageSize'][] = ['trade', 'a5', 'a4', 'letter'];
const PRINT_SIZES: ExportOptions['pageSize'][] = ['pocket', 'digest', 'trade', 'a5'];

function scopeLabel(scope: ExportScope): string {
  switch (scope) {
    case 'project':
      return t('The whole project');
    case 'wiki':
      return t('The wiki');
    case 'page':
      return t('One page');
    case 'book':
      return t('One book');
    case 'books':
      return t('All books');
  }
}

/** What was written besides the path, such as "2 MB, 12 pages". */
function resultDetails(result: ExportResult): string {
  const size = result.size !== null ? formatBytes(result.size) : '';
  if (!result.pages) return size;
  const count = formatNumber(result.pages);
  if (!size) return result.pages === 1 ? t('1 page') : t('{count} pages', { count });
  return result.pages === 1 ? t('{size}, 1 page', { size }) : t('{size}, {count} pages', { size, count });
}

function FormatChooser({
  group,
  title,
  selected,
  onSelect,
}: {
  group: ExportFormat['group'];
  title: string;
  selected: FormatId;
  onSelect: (id: FormatId) => void;
}) {
  useLocale();
  return (
    <fieldset className="exporters-group">
      <legend className="exporters-legend">{title}</legend>
      {FORMATS.filter((f) => f.group === group).map((format) => {
        // Said here, before anyone has chosen a place to save.
        const unavailable = format.engine === 'print' && !platform().pdf;
        return (
          <label
            key={format.id}
            className={`exporters-format${format.id === selected ? ' is-selected' : ''}${unavailable ? ' is-unavailable' : ''}`}
          >
            <input
              type="radio"
              name="export-format"
              value={format.id}
              checked={format.id === selected}
              disabled={unavailable}
              onChange={() => onSelect(format.id)}
            />
            <span>
              <span className="exporters-format-name">{format.name}</span>
              <span className="exporters-format-description">{unavailable ? t(NO_PDF_MESSAGE) : format.description}</span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

function Check({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <span className="field-hint">{hint}</span>}
      </span>
    </label>
  );
}

export default function ExportView() {
  useLocale();
  const project = useProject((s) => s.status.name);
  const version = useDataVersion('pages', 'books');
  const { data: books } = useLoad(() => api.books.list(), [version]);
  const { data: pages } = useLoad(() => api.pages.titles(), [version]);

  const [initial] = useState(() => {
    const given = preset;
    preset = null;
    // Coming from a page, "this page" is the likely meaning of "one page".
    const previous = useNav.getState().back.at(-1);
    return {
      format: given?.format ?? ('json' as FormatId),
      pageId: given?.pageId ?? (previous?.view === 'page' ? previous.id : undefined),
    };
  });
  const [formatId, setFormatId] = useState<FormatId>(initial.format);
  const format = formatById(formatId);
  const [scope, setScope] = useState<ExportScope>(format.scopes[0]);
  const [bookId, setBookId] = useState<string>();
  const [pageId, setPageId] = useState<string | undefined>(initial.pageId);
  const [choices, setChoices] = useState<Partial<ExportOptions>>({});

  const options: ExportOptions = useMemo(() => {
    const merged = { ...DEFAULT_OPTIONS, ...format.defaults, ...choices };
    // What was chosen may have been deleted since.
    const chosenBook = books?.find((b) => b.id === bookId) ?? books?.[0];
    // A choice made for one format must not change what another one does.
    const offers = (name: ExportFormat['options'][number]) => format.options.includes(name);
    const manuscriptFormat = offers('manuscriptFormat') && merged.manuscriptFormat;
    const printReady = offers('printReady') && !manuscriptFormat && merged.printReady;
    return {
      ...merged,
      scope,
      bookId: chosenBook?.id,
      pageId: pages?.some((p) => p.id === pageId) ? pageId : pages?.[0]?.id,
      manuscriptFormat,
      printReady,
      bookMatter: offers('bookMatter') && merged.bookMatter,
      // Only formats for other AI tools leave local-only writing out. See `chooseFormat` too.
      includeLocalOnly: offers('includeLocalOnly') && merged.includeLocalOnly,
      pageSize: printReady && !PRINT_SIZES.includes(merged.pageSize) ? 'trade' : merged.pageSize,
      language: choices.language ?? (chosenBook?.publishing?.language?.trim() || merged.language),
    };
  }, [format, choices, scope, bookId, pageId, books, pages]);
  const set = <K extends keyof ExportOptions>(key: K, value: ExportOptions[K]) =>
    setChoices((c) => ({ ...c, [key]: value }));

  const [job, setJob] = useState<ExportJob | null>(null);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // An export carries on if the person goes back to work, and says when it is done.
  const onScreen = useRef(true);
  useEffect(() => {
    onScreen.current = true;
    return () => {
      onScreen.current = false;
    };
  }, []);

  const chooseFormat = (id: FormatId) => {
    const next = formatById(id);
    setFormatId(id);
    // A format like this one keeps the choice. Otherwise its usual scope is the likely one.
    if (next.scopes.join() !== format.scopes.join()) setScope(next.scopes[0]);
    // A format's own defaults apply until the person chooses otherwise for that format.
    setChoices((c) => {
      const kept = { ...c };
      const keys = Object.keys({ ...format.defaults, ...next.defaults }) as (keyof ExportOptions)[];
      for (const key of keys) delete kept[key];
      // Sending local-only writing to an AI tool is a choice made for one file at a time.
      delete kept.includeLocalOnly;
      return kept;
    });
    setResult(null);
    setFailure(null);
  };

  const suggestedName = () => {
    const page = pages?.find((p) => p.id === options.pageId);
    const book = books?.find((b) => b.id === options.bookId);
    const base = scope === 'page' ? page?.title : scope === 'book' ? book?.title : project;
    return `${safeFileName(base || project || 'LoreCraft')}.${format.extension(options)}`;
  };

  const run = async () => {
    setResult(null);
    setFailure(null);
    const path = await api.files.pickSave({
      title: t('Export {format}', { format: format.name }),
      defaultName: suggestedName(),
      filters: [{ name: format.filterName(options), extensions: [format.extension(options)] }],
    });
    if (!path) return;
    const started = startExport(formatId, options, path, setProgress);
    setJob(started);
    try {
      const finished = await started.result;
      setResult(finished);
      if (!onScreen.current) toast(t('Exported {path}', { path: finished.path }), 'success');
    } catch (error) {
      if (!isCancelled(error)) {
        const message = error instanceof Error ? error.message : String(error);
        setFailure(message);
        if (!onScreen.current) toast(t('Could not export: {message}', { message }), 'error');
      }
    } finally {
      setJob(null);
      setProgress(null);
    }
  };

  const has = (name: ExportFormat['options'][number]) => format.options.includes(name);
  const needsBook = scope === 'book';
  const needsPage = scope === 'page';
  const wikiIncluded = scope === 'project' || scope === 'wiki';
  const novelIncluded = scope === 'project' || scope === 'book' || scope === 'books';
  const running = job !== null;
  const manuscript = options.manuscriptFormat;
  const pageSizes = options.printReady ? PRINT_SIZES : READING_SIZES;

  return (
    <div className="view-pad exporters">
      <h1 className="view-title">{t('Export')}</h1>
      <div className="exporters-columns">
        <div className="exporters-chooser" role="group" aria-label={t('Format')}>
          <FormatChooser group="wiki" title={t('Wiki data')} selected={formatId} onSelect={chooseFormat} />
          <FormatChooser group="novel" title={t('Novel')} selected={formatId} onSelect={chooseFormat} />
        </div>

        <div className="exporters-options">
          <h2 className="exporters-heading">{format.name}</h2>
          {format.scopes.length > 1 && (
            <label className="field">
              <span className="field-label">{t('What to export')}</span>
              <select className="select" value={scope} onChange={(e) => setScope(e.target.value as ExportScope)}>
                {format.scopes.map((s) => (
                  <option key={s} value={s}>{scopeLabel(s)}</option>
                ))}
              </select>
            </label>
          )}
          {needsBook && (
            <label className="field">
              <span className="field-label">{t('Book')}</span>
              <select className="select" value={options.bookId ?? ''} onChange={(e) => setBookId(e.target.value)}>
                {(books ?? []).map((b) => (
                  <option key={b.id} value={b.id}>{b.title}</option>
                ))}
              </select>
            </label>
          )}
          {needsPage && (
            <label className="field">
              <span className="field-label">{t('Page')}</span>
              <select className="select" value={options.pageId ?? ''} onChange={(e) => setPageId(e.target.value)}>
                {(pages ?? []).map((p) => (
                  <option key={p.id} value={p.id}>{p.title}</option>
                ))}
              </select>
            </label>
          )}

          {has('pageFilter') && wikiIncluded && (
            <fieldset className="settings-group">
              <legend className="field-label">{t('Pages')}</legend>
              <Check label={t('Canon pages only')} checked={options.canonOnly} onChange={(v) => set('canonOnly', v)} />
              <Check label={t('Include drafts and ideas')} checked={options.includeDrafts} disabled={options.canonOnly} onChange={(v) => set('includeDrafts', v)} />
              <Check label={t('Include retconned pages')} checked={options.includeRetconned} disabled={options.canonOnly} onChange={(v) => set('includeRetconned', v)} />
            </fieldset>
          )}
          {has('sceneFilter') && novelIncluded && (
            <label className="field">
              <span className="field-label">{t('Scenes')}</span>
              <select className="select" value={options.scenes} onChange={(e) => set('scenes', e.target.value as ExportOptions['scenes'])}>
                <option value="all">{t('All scenes')}</option>
                <option value="written">{t('Leave out ideas and outlines')}</option>
                <option value="revised">{t('Revised and final only')}</option>
              </select>
            </label>
          )}
          {has('bodyFormat') && (
            <label className="field">
              <span className="field-label">{t('Write documents as')}</span>
              <select className="select" value={options.bodyFormat} onChange={(e) => set('bodyFormat', e.target.value as ExportOptions['bodyFormat'])}>
                <option value="markdown">{t('Markdown, easy to read')}</option>
                <option value="prosemirror">{t('ProseMirror JSON, nothing lost')}</option>
              </select>
            </label>
          )}
          {has('csvBundle') && (
            <Check label={t('Zip with scenes and relationships too')} checked={options.csvBundle} onChange={(v) => set('csvBundle', v)} />
          )}
          {has('csvGuardFormulas') && (
            <Check
              label={t('Stop spreadsheets from running formulas')}
              hint={t('Text starting with = + - or @ gets a leading apostrophe.')}
              checked={options.csvGuardFormulas}
              onChange={(v) => set('csvGuardFormulas', v)}
            />
          )}
          {has('infoboxInContent') && (
            <Check label={t('Start each entry with its infobox fields')} checked={options.infoboxInContent} onChange={(v) => set('infoboxInContent', v)} />
          )}
          {has('includeLocalOnly') && (
            <div data-testid="export-include-local-only">
              <Check
                label={t('Include pages and scenes marked local only')}
                hint={t('Left out unless ticked, as the AI server does, because AI tools may send this file to a cloud service.')}
                checked={options.includeLocalOnly}
                onChange={(v) => set('includeLocalOnly', v)}
              />
            </div>
          )}
          {has('manuscriptFormat') && (
            <Check
              label={t('Standard manuscript format')}
              hint={t('12 point, double spaced, with author, title and page number at the top of each page.')}
              checked={options.manuscriptFormat}
              onChange={(v) => set('manuscriptFormat', v)}
            />
          )}
          {has('bookMatter') && !manuscript && (
            <div className="field">
              <Check
                label={t('Cover, front and back matter')}
                hint={t('Dedication, copyright page, appendices and more.')}
                checked={options.bookMatter}
                onChange={(v) => set('bookMatter', v)}
              />
              <button type="button" className="link-button" onClick={() => useNav.getState().go({ view: 'publishing', bookId: options.bookId })}>
                {t('Publishing details…')}
              </button>
            </div>
          )}
          {has('printReady') && !manuscript && (
            <fieldset className="settings-group">
              <Check
                label={t('Print-ready')}
                hint={t('For a printer rather than a screen. Leaves out the cover, which printers take as a file of its own.')}
                checked={options.printReady}
                onChange={(v) => set('printReady', v)}
              />
              {options.printReady && (
                <div className="exporters-suboptions">
                  <Check
                    label={t('Mirrored margins')}
                    hint={t('A wider margin on the binding side of each page.')}
                    checked={options.mirrorMargins}
                    onChange={(v) => set('mirrorMargins', v)}
                  />
                  <Check label={t('Start chapters on right-hand pages')} checked={options.chaptersOnRight} onChange={(v) => set('chaptersOnRight', v)} />
                  <Check
                    label={t('Running headers')}
                    hint={t("The book's title on left-hand pages, and the chapter's on right-hand pages.")}
                    checked={options.runningHeaders}
                    onChange={(v) => set('runningHeaders', v)}
                  />
                </div>
              )}
            </fieldset>
          )}
          {has('sceneTitles') && (
            <Check label={t('Print scene titles')} hint={t('Otherwise a separator marks each new scene.')} checked={options.sceneTitles} onChange={(v) => set('sceneTitles', v)} />
          )}
          {has('pageSize') && !manuscript && (
            <label className="field">
              <span className="field-label">{options.printReady ? t('Trim size') : t('Page size')}</span>
              <select className="select" value={options.pageSize} onChange={(e) => set('pageSize', e.target.value as ExportOptions['pageSize'])}>
                {pageSizes.map((size) => (
                  <option key={size} value={size}>{pageSizeLabel(size)}</option>
                ))}
              </select>
            </label>
          )}
          {has('language') && (
            <label className="field">
              <span className="field-label">{t('Language code')}</span>
              <input className="input exporters-language" value={options.language} onChange={(e) => set('language', e.target.value)} />
            </label>
          )}

          <div className="exporters-actions">
            <button type="button" className="btn btn-primary" disabled={running} onClick={() => void run()}>
              {t('Export…')}
            </button>
            {running && (
              <button type="button" className="btn" onClick={() => job?.cancel()}>{t('Cancel')}</button>
            )}
          </div>

          <div className="exporters-status" role="status" aria-live="polite">
            {progress && (
              <div>
                <progress className="exporters-progress" max={1} value={progress.fraction ?? undefined} />
                <div className="muted small">{progress.label}</div>
              </div>
            )}
            {result && (
              <div className="exporters-result" data-testid="export-result">
                <p>
                  <strong>{t('Exported.')}</strong> {resultDetails(result)}
                </p>
                <p className="exporters-path">{result.path}</p>
                {result.warnings.map((warning) => (
                  <p key={warning} className="muted small">{warning}</p>
                ))}
              </div>
            )}
            {failure && (
              <p className="exporters-failure" data-testid="export-error">{t('Could not export: {message}', { message: failure })}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
