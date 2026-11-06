/** The import screen: pick a source, see what would happen, then do it. */

import { useEffect, useMemo, useState } from 'react';

import { flushAllEditors } from '../editor/saving';
import * as api from '../lib/api';
import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import { confirm } from '../shell/dialogs';
import { useDataVersion, useLoad } from '../state/events';
import { canUndo, undoBulkChange, type BulkUndo } from '../write/history/api';
import { useLocale } from '../state/language';
import { useNav } from '../state/nav';
import { importing } from './api';
import { DEFAULT_MARKDOWN_OPTIONS, type MarkdownOptions } from './import/markdownFiles';
import { readSource, sourceFromFiles, type Source } from './import/source';
import type { ConflictPolicy, ImportCounts, ImportProblem, ImportReport, Normalized } from './import/types';

// Functions rather than constants, so the text is in the language chosen when it is shown.
const policies = (): { value: ConflictPolicy; label: string; hint: string }[] => [
  { value: 'skip', label: t('Skip'), hint: t('Keep what is here and leave out anything with the same name.') },
  { value: 'rename', label: t('Rename'), hint: t('Keep both, adding a number to the new one, as in “Aria (2)”.') },
  { value: 'overwrite', label: t('Overwrite'), hint: t('Replace what is here, saving its current text in History first.') },
];

const actionLabels = (): Record<string, string> => ({
  create: t('Add'),
  rename: t('Add with a new name'),
  overwrite: t('Overwrite'),
  skip: t('Skip'),
  extend: t('Add to the book'),
});

const sourceLabels = (): Record<Source['kind'], string> => ({
  lorebook: t('LoreCraft file'),
  markdown: t('Markdown'),
  docx: t('Word document'),
  text: t('Plain text'),
  folder: t('Folder of Markdown'),
});

function hasWorkToDo(counts: ImportCounts): boolean {
  return (
    counts.pagesCreated + counts.pagesRenamed + counts.pagesOverwritten +
    counts.booksCreated + counts.booksRenamed + counts.booksOverwritten + counts.booksExtended +
    counts.assetsCreated + counts.relationshipsCreated +
    counts.mapsCreated + counts.mapsOverwritten + counts.dictionaryAdded + counts.promptsCreated + counts.threadsCreated > 0
  );
}

/** The count as people read it, for a `{count}` placeholder. */
function counted(n: number): { count: string } {
  return { count: n.toLocaleString() };
}

function countSentence(counts: ImportCounts, applied: boolean): string {
  const parts: string[] = [];
  // Each part is a whole phrase with its own count, translated for one and for more than one.
  const add = (n: number, one: string, many: string) => {
    if (n > 0) parts.push(n === 1 ? one : many);
  };
  const books = counts.booksCreated + counts.booksRenamed;
  const maps = counts.mapsCreated + counts.mapsOverwritten;
  add(counts.pagesCreated, t('1 new page'), t('{count} new pages', counted(counts.pagesCreated)));
  add(counts.pagesRenamed, t('1 renamed page'), t('{count} renamed pages', counted(counts.pagesRenamed)));
  add(counts.pagesOverwritten, t('1 overwritten page'), t('{count} overwritten pages', counted(counts.pagesOverwritten)));
  add(counts.pagesSkipped, t('1 skipped page'), t('{count} skipped pages', counted(counts.pagesSkipped)));
  add(books, t('1 new book'), t('{count} new books', counted(books)));
  add(counts.booksOverwritten, t('1 overwritten book'), t('{count} overwritten books', counted(counts.booksOverwritten)));
  add(counts.booksSkipped, t('1 skipped book'), t('{count} skipped books', counted(counts.booksSkipped)));
  add(counts.nodesCreated, t('1 new chapter or scene'), t('{count} new chapters and scenes', counted(counts.nodesCreated)));
  add(counts.nodesUpdated, t('1 updated chapter or scene'), t('{count} updated chapters and scenes', counted(counts.nodesUpdated)));
  add(
    counts.nodesRemoved,
    t('1 chapter or scene moved to the trash'),
    t('{count} chapters and scenes moved to the trash', counted(counts.nodesRemoved)),
  );
  add(counts.assetsCreated, t('1 new picture'), t('{count} new pictures', counted(counts.assetsCreated)));
  add(counts.relationshipsCreated, t('1 relationship'), t('{count} relationships', counted(counts.relationshipsCreated)));
  add(maps, t('1 map'), t('{count} maps', counted(maps)));
  add(counts.threadsCreated, t('1 plot thread'), t('{count} plot threads', counted(counts.threadsCreated)));
  if (parts.length === 0) return applied ? t('Nothing changed.') : t('Nothing to import.');
  const list = parts.join(', ');
  return applied ? t('Imported: {list}.', { list }) : t('This will bring in: {list}.', { list });
}

/** What a book in the preview holds, as in “Book, 3 chapters, 12 scenes”. */
function bookSummary(chapters: number, scenes: number): string {
  return t('Book, {chapters}, {scenes}', {
    chapters: chapters === 1 ? t('1 chapter') : t('{count} chapters', counted(chapters)),
    scenes: scenes === 1 ? t('1 scene') : t('{count} scenes', counted(scenes)),
  });
}

function Problems({ problems }: { problems: ImportProblem[] }) {
  useLocale();
  if (problems.length === 0) return null;
  const errors = problems.filter((p) => p.severity === 'error');
  // Errors first, because they are what stops the import.
  const ordered = [...errors, ...problems.filter((p) => p.severity !== 'error')];
  return (
    <ul className="importer-problems" data-testid="import-problems">
      {ordered.slice(0, 200).map((p, i) => (
        <li key={`${p.item}-${p.field}-${i}`} className={`importer-problem${p.severity === 'error' ? ' is-error' : ''}`}>
          <span className="importer-problem-where">
            {p.item}
            {p.field ? `, ${p.field}` : ''}
          </span>{' '}
          {p.message}
        </li>
      ))}
      {ordered.length > 200 && (
        <li className="muted small">
          {ordered.length - 200 === 1 ? t('And 1 more.') : t('And {count} more.', counted(ordered.length - 200))}
        </li>
      )}
    </ul>
  );
}

export default function ImportView() {
  useLocale();
  const go = useNav((s) => s.go);
  const [source, setSource] = useState<Source | null>(null);
  const [policy, setPolicy] = useState<ConflictPolicy>('skip');
  const [markdown, setMarkdown] = useState<MarkdownOptions>(DEFAULT_MARKDOWN_OPTIONS);
  const [docxMode, setDocxMode] = useState<'page' | 'pages' | 'book'>('page');
  const [splitLevel, setSplitLevel] = useState(1);
  const [textMode, setTextMode] = useState<'page' | 'scene'>('page');
  const [textBook, setTextBook] = useState('');
  const [textChapter, setTextChapter] = useState('');

  const [normalized, setNormalized] = useState<Normalized | null>(null);
  const [preview, setPreview] = useState<ImportReport | null>(null);
  const [result, setResult] = useState<ImportReport | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const version = useDataVersion('books', 'nodes');
  const { data: books } = useLoad(() => api.books.list(), [version]);
  const { data: tree } = useLoad(() => (textBook ? api.nodes.tree(textBook) : Promise.resolve([])), [textBook, version]);
  const chapters = useMemo(() => (tree ?? []).filter((n) => n.kind === 'chapter'), [tree]);

  const readOptions = useMemo(
    () => ({
      markdown,
      docx: { mode: docxMode, splitLevel },
      text: { mode: textMode, bookId: textBook || undefined, chapterId: textChapter || undefined },
    }),
    [markdown, docxMode, splitLevel, textMode, textBook, textChapter],
  );

  // Reading again whenever an option changes means the preview is always of what would happen.
  useEffect(() => {
    if (!source) return undefined;
    let current = true;
    setBusy(true);
    setFailure(null);
    setResult(null);
    setNormalized(null);
    setPreview(null);
    setStatus(t('Reading…'));
    readSource(source, { ...readOptions, onProgress: (text) => current && setStatus(text) })
      .then((read) => {
        if (current) setNormalized(read);
      })
      .catch((error: unknown) => {
        if (current) {
          setFailure(errorMessage(error));
          setBusy(false);
          setStatus(null);
        }
      });
    return () => {
      current = false;
    };
  }, [source, readOptions]);

  useEffect(() => {
    if (!normalized) return undefined;
    let current = true;
    setBusy(true);
    setStatus(t('Working out what would happen…'));
    // An editor's unsaved text is part of what an import compares with, and could overwrite it.
    flushAllEditors()
      .then(() => importing.preview({ ...normalized.payload, policy }))
      .then((report) => {
        if (current) setPreview(report);
      })
      .catch((error: unknown) => {
        if (current) setFailure(errorMessage(error));
      })
      .finally(() => {
        if (current) {
          setBusy(false);
          setStatus(null);
        }
      });
    return () => {
      current = false;
    };
  }, [normalized, policy]);

  const pickFile = async () => {
    const picked = await api.files.pickOpen({
      title: t('Choose a file to import'),
      multiple: true,
      filters: [
        { name: t('Files LoreCraft can import'), extensions: ['json', 'yaml', 'yml', 'md', 'markdown', 'docx', 'txt'] },
      ],
    });
    if (picked.length === 0) return;
    const chosen = sourceFromFiles(picked);
    if (!chosen) {
      setFailure(
        t('LoreCraft can import JSON, YAML, Markdown, Word and text files, one at a time. Only Markdown files can be chosen together.'),
      );
      return;
    }
    setSource(chosen);
  };

  const pickFolder = async () => {
    const picked = await api.files.pickFolder({ title: t('Choose a folder of Markdown files, or an Obsidian vault') });
    if (picked) {
      setSource({ kind: 'folder', path: picked, name: picked.split(/[\\/]/).pop() ?? picked });
    }
  };

  const allProblems = useMemo(() => {
    const seen = new Set<string>();
    const out: ImportProblem[] = [];
    for (const p of [...(normalized?.problems ?? []), ...(preview?.problems ?? [])]) {
      const key = `${p.item}|${p.field}|${p.message}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(p);
      }
    }
    return out;
  }, [normalized, preview]);
  const hasErrors = allProblems.some((p) => p.severity === 'error');

  const apply = async () => {
    if (!normalized) return;
    setBusy(true);
    setFailure(null);
    setStatus(t('Importing…'));
    try {
      await flushAllEditors();
      const report = await importing.apply({ ...normalized.payload, policy });
      if (report.applied) {
        // What came up reading the file still matters once it is in.
        setResult({ ...report, problems: [...normalized.problems, ...report.problems] });
        setNormalized(null);
        setPreview(null);
        setSource(null);
      } else {
        setPreview(report);
      }
    } catch (error) {
      setFailure(t('Nothing was imported, and the project is as it was. {error}', { error: errorMessage(error) }));
    } finally {
      setBusy(false);
      setStatus(null);
    }
  };

  // What the native side returns for taking the import back.
  const resultUndo = (result as (ImportReport & { undo?: BulkUndo }) | null)?.undo;

  const undoImport = async () => {
    if (!canUndo(resultUndo)) return;
    const yes = await confirm({
      title: t('Undo this import?'),
      message: t('Pages and scenes it changed go back to how they were, and what it added goes to the trash. Anything edited since stays as it is. Pictures, maps and other things it brought in stay.'),
      confirmLabel: t('Undo the import'),
    });
    if (!yes) return;
    setBusy(true);
    const done = await undoBulkChange(resultUndo);
    setBusy(false);
    if (done) setResult(null);
  };

  const items = preview?.items ?? [];
  const labels = actionLabels();

  return (
    <div className="view-pad exporters">
      <h1 className="view-title">{t('Import')}</h1>
      <p className="muted importer-section">
        {t(
          'Bring in a LoreCraft JSON or YAML file, Markdown files, an Obsidian vault, a Word document or plain text. The format for converting your own notes is described in docs/IMPORT_FORMAT.md.',
        )}
      </p>

      <div className="importer-source">
        <button type="button" className="btn" disabled={busy} onClick={() => void pickFile()}>{t('Choose file…')}</button>
        <button type="button" className="btn" disabled={busy} onClick={() => void pickFolder()}>{t('Choose folder…')}</button>
        {source && (
          <span className="importer-chosen" data-testid="import-source">
            {t('{format}: {name}', { format: sourceLabels()[source.kind], name: source.name })}
          </span>
        )}
      </div>

      {source && (source.kind === 'folder' || source.kind === 'markdown') && (
        <div className="importer-section">
          {source.kind === 'folder' && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={markdown.foldersAsCategories}
                onChange={(e) => setMarkdown((m) => ({ ...m, foldersAsCategories: e.target.checked }))}
              />
              <span>{t('Turn folder names into categories')}</span>
            </label>
          )}
          <label className="checkbox">
            <input
              type="checkbox"
              checked={markdown.tagsAsCategories}
              onChange={(e) => setMarkdown((m) => ({ ...m, tagsAsCategories: e.target.checked }))}
            />
            <span>{t('Turn #tags in the text into categories')}</span>
          </label>
        </div>
      )}

      {source?.kind === 'docx' && (
        <div className="importer-section">
          <label className="field">
            <span className="field-label">{t('Import this document as')}</span>
            <select className="select" value={docxMode} onChange={(e) => setDocxMode(e.target.value as typeof docxMode)}>
              <option value="page">{t('One wiki page')}</option>
              <option value="pages">{t('A wiki page for each heading')}</option>
              <option value="book">{t('A book, with chapters at Heading 1 and scenes at Heading 2')}</option>
            </select>
          </label>
          {docxMode === 'pages' && (
            <label className="field">
              <span className="field-label">{t('Start a new page at')}</span>
              <select className="select" value={splitLevel} onChange={(e) => setSplitLevel(Number(e.target.value))}>
                <option value={1}>{t('Heading 1')}</option>
                <option value={2}>{t('Heading 1 and Heading 2')}</option>
                <option value={3}>{t('Headings 1 to 3')}</option>
              </select>
            </label>
          )}
        </div>
      )}

      {source?.kind === 'text' && (
        <div className="importer-section">
          <label className="field">
            <span className="field-label">{t('Import this text as')}</span>
            <select className="select" value={textMode} onChange={(e) => setTextMode(e.target.value as typeof textMode)}>
              <option value="page">{t('A wiki page')}</option>
              <option value="scene">{t('A scene')}</option>
            </select>
          </label>
          {textMode === 'scene' && (
            <>
              <label className="field">
                <span className="field-label">{t('Book')}</span>
                <select
                  className="select"
                  value={textBook}
                  onChange={(e) => {
                    setTextBook(e.target.value);
                    setTextChapter('');
                  }}
                >
                  <option value="">{t('A new book')}</option>
                  {(books ?? []).map((b) => (
                    <option key={b.id} value={b.id}>{b.title}</option>
                  ))}
                </select>
              </label>
              {textBook && (
                <label className="field">
                  <span className="field-label">{t('Chapter')}</span>
                  <select className="select" value={textChapter} onChange={(e) => setTextChapter(e.target.value)}>
                    <option value="">{t('A new chapter')}</option>
                    {chapters.map((c) => (
                      <option key={c.id} value={c.id}>{c.title}</option>
                    ))}
                  </select>
                </label>
              )}
            </>
          )}
        </div>
      )}

      {source && (
        <fieldset className="settings-group importer-section">
          <legend className="field-label">{t('When something with the same name already exists')}</legend>
          {policies().map((p) => (
            <label key={p.value} className="checkbox">
              <input type="radio" name="import-policy" value={p.value} checked={policy === p.value} onChange={() => setPolicy(p.value)} />
              <span>
                {p.label}
                <span className="field-hint">{p.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}

      <div role="status" aria-live="polite">
        {status && (
          <div className="importer-section">
            <progress className="exporters-progress" />
            <div className="muted small">{status}</div>
          </div>
        )}
        {failure && <p className="exporters-failure importer-section" data-testid="import-error">{failure}</p>}
      </div>

      {preview && (
        <section className="importer-section" aria-label={t('Preview')}>
          <p className="importer-counts" data-testid="import-preview-counts">{countSentence(preview.counts, false)}</p>
          {preview.notes.map((note) => (
            <p key={note} className="muted small">{note}</p>
          ))}
          <Problems problems={allProblems} />
          {items.length > 0 && (
            <div className="importer-table-wrap" tabIndex={0}>
              <table className="data-table" data-testid="import-preview">
                <thead>
                  <tr>
                    <th scope="col">{t('Item')}</th>
                    <th scope="col">{t('Type')}</th>
                    <th scope="col">{t('What will happen')}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, index) => (
                    <tr key={`${item.source}-${index}`}>
                      <td>
                        {item.title || item.finalTitle}
                        {item.finalTitle !== item.title && item.action === 'rename' && (
                          <span className="muted small"> {t('as {name}', { name: item.finalTitle })}</span>
                        )}
                      </td>
                      <td className="muted">{item.kind === 'book' ? bookSummary(item.chapters, item.scenes) : t('Page')}</td>
                      <td className={`importer-action importer-action-${item.action}`}>{labels[item.action] ?? item.action}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="exporters-actions">
            <button type="button" className="btn btn-primary" disabled={busy || hasErrors || !preview || !hasWorkToDo(preview.counts)} onClick={() => void apply()}>
              {t('Import')}
            </button>
          </div>
          {hasErrors && (
            <p className="muted small">{t('Fix the problems marked above in the file, then choose it again. Nothing has been imported.')}</p>
          )}
        </section>
      )}

      {result && (
        <section className="importer-result importer-section" data-testid="import-result" aria-label={t('Result')}>
          <p><strong>{countSentence(result.counts, true)}</strong></p>
          {result.counts.revisionsTaken > 0 && (
            <p className="muted small">{t('The text that was replaced is saved in the History of each page and scene.')}</p>
          )}
          {canUndo(resultUndo) && (
            <p>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void undoImport()}>
                {t('Undo this import')}
              </button>
            </p>
          )}
          {result.notes.map((note) => (
            <p key={note} className="muted small">{note}</p>
          ))}
          <Problems problems={result.problems} />
          <ul>
            {result.items
              .filter((i) => i.kind === 'page' && i.action !== 'skip' && i.id)
              .slice(0, 50)
              .map((i) => (
                <li key={i.id}>
                  <button type="button" className="link-button" onClick={() => go({ view: 'page', id: i.id as string })}>
                    {i.finalTitle}
                  </button>
                </li>
              ))}
          </ul>
        </section>
      )}
    </div>
  );
}
