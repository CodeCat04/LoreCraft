/**
 * What a book needs to be published: its cover, details, front and back matter, and
 * appendices filled from the wiki. Changes save themselves as they are made.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { RichEditor } from '../editor/RichEditor';
import { useDocSaver } from '../editor/saving';
import * as api from '../lib/api';
import { addAsset, assetUrl } from '../lib/assets';
import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import type { AppendixSpec, Book, BookPublishing, MatterPage, PmNode } from '../lib/types';
import { useDataVersion, useLoad } from '../state/events';
import { useLocale } from '../state/language';
import { useNav } from '../state/nav';
import { usePageTypes } from '../wiki/pageTypes';
import { isbnLooksRight } from './util';

type MatterName = 'copyright' | 'dedication' | 'epigraph' | 'acknowledgments' | 'aboutAuthor';

const EMPTY_DOC: PmNode = { type: 'doc', content: [{ type: 'paragraph' }] };

// Functions rather than constants, so the text is in the language chosen when it is shown.
const frontMatter = (): { name: MatterName; label: string; hint: string; placeholder: string }[] => [
  {
    name: 'copyright',
    label: t('Copyright page'),
    hint: t('Left empty, it gets a standard notice made from the details above.'),
    placeholder: t('Write the copyright page here.'),
  },
  { name: 'dedication', label: t('Dedication'), hint: t('Its own page, centered.'), placeholder: t('Write the dedication here.') },
  {
    name: 'epigraph',
    label: t('Epigraph'),
    hint: t('A quotation that sets the tone, on its own page.'),
    placeholder: t('Write the epigraph here.'),
  },
];

const backMatter = (): { name: MatterName; label: string; hint: string; placeholder: string }[] => [
  {
    name: 'acknowledgments',
    label: t('Acknowledgments'),
    hint: t('After the appendices.'),
    placeholder: t('Write the acknowledgments here.'),
  },
  { name: 'aboutAuthor', label: t('About the author'), hint: t('The very last page.'), placeholder: t('Write the about the author here.') },
];

// The headings are written into the book, so they stay as the writer's own words once chosen.
const APPENDIX_KINDS: { kind: AppendixSpec['kind']; title: string; pageTypes: string[] }[] = [
  { kind: 'cast', title: 'Cast of Characters', pageTypes: ['character'] },
  { kind: 'glossary', title: 'Glossary', pageTypes: ['concept'] },
  { kind: 'maps', title: 'Maps', pageTypes: [] },
];

function appendixKindLabel(kind: AppendixSpec['kind']): string {
  if (kind === 'cast') return t('Cast list');
  if (kind === 'glossary') return t('Glossary');
  return t('Maps');
}

function MatterEditor({
  bookId,
  name,
  label,
  hint,
  placeholder,
  page,
  onChange,
}: {
  bookId: string;
  name: MatterName;
  label: string;
  hint: string;
  placeholder: string;
  page: MatterPage | undefined;
  onChange: (page: MatterPage) => void;
}) {
  useLocale();
  const included = page?.include ?? false;
  return (
    <div className="publishing-matter" data-matter={name}>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={included}
          onChange={(e) => onChange({ include: e.target.checked, content: page?.content ?? null })}
        />
        <span>
          {label}
          <span className="field-hint">{hint}</span>
        </span>
      </label>
      {included && (
        <div className="publishing-editor">
          <RichEditor
            docKey={`publishing:${bookId}:${name}`}
            content={page?.content ?? EMPTY_DOC}
            editable
            variant="article"
            source={{ kind: 'notes', id: bookId, title: label }}
            placeholder={placeholder}
            onChange={(doc) => onChange({ include: true, content: doc })}
          />
        </div>
      )}
    </div>
  );
}

function toggled(list: string[], value: string, on: boolean): string[] {
  return on ? [...new Set([...list, value])] : list.filter((v) => v !== value);
}

function AppendixEditor({
  spec,
  index,
  count,
  categories,
  onChange,
  onMove,
  onRemove,
}: {
  spec: AppendixSpec;
  index: number;
  count: number;
  categories: string[];
  onChange: (spec: AppendixSpec) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  useLocale();
  const known = usePageTypes((s) => s.types);
  const pageTypes = useMemo(() => [...new Set([...known.map((t) => t.type), ...spec.pageTypes])], [known, spec.pageTypes]);
  const labelOf = (type: string) => known.find((t) => t.type === type)?.plural ?? type;
  const number = index + 1;
  return (
    <fieldset className="publishing-appendix" data-testid="appendix">
      <legend className="field-label">{t('Appendix {number}', { number })}</legend>
      <div className="publishing-row">
        <label className="field">
          <span className="field-label">{t('Kind')}</span>
          <select
            className="select"
            value={spec.kind}
            onChange={(e) => {
              const next = APPENDIX_KINDS.find((k) => k.kind === e.target.value) ?? APPENDIX_KINDS[0];
              const usual = APPENDIX_KINDS.some((k) => k.title === spec.title);
              onChange({ ...spec, kind: next.kind, title: usual || !spec.title ? next.title : spec.title, pageTypes: next.pageTypes });
            }}
          >
            {APPENDIX_KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>{appendixKindLabel(k.kind)}</option>
            ))}
          </select>
        </label>
        <label className="field publishing-grow">
          <span className="field-label">{t('Heading')}</span>
          <input className="input" value={spec.title} onChange={(e) => onChange({ ...spec, title: e.target.value })} />
        </label>
      </div>
      {spec.kind === 'maps' ? (
        <p className="field-hint">{t('Every map with a picture, each listing the places pinned on it.')}</p>
      ) : (
        <>
          <fieldset className="publishing-choices">
            <legend className="field-label">{t('Pages of these types')}</legend>
            {pageTypes.map((type) => (
              <label key={type} className="checkbox">
                <input
                  type="checkbox"
                  checked={spec.pageTypes.includes(type)}
                  onChange={(e) => onChange({ ...spec, pageTypes: toggled(spec.pageTypes, type, e.target.checked) })}
                />
                <span>{labelOf(type)}</span>
              </label>
            ))}
          </fieldset>
          {categories.length > 0 && (
            <fieldset className="publishing-choices">
              <legend className="field-label">{t('Or in these categories')}</legend>
              {categories.map((category) => (
                <label key={category} className="checkbox">
                  <input
                    type="checkbox"
                    checked={spec.categories.includes(category)}
                    onChange={(e) => onChange({ ...spec, categories: toggled(spec.categories, category, e.target.checked) })}
                  />
                  <span>{category}</span>
                </label>
              ))}
            </fieldset>
          )}
        </>
      )}
      <label className="checkbox">
        <input type="checkbox" checked={spec.canonOnly} onChange={(e) => onChange({ ...spec, canonOnly: e.target.checked })} />
        <span>
          {t('Canon pages only')}
          <span className="field-hint">{t('Retconned pages never go in.')}</span>
        </span>
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={spec.hideSpoilers} onChange={(e) => onChange({ ...spec, hideSpoilers: e.target.checked })} />
        <span>
          {t('Leave out spoilers')}
          <span className="field-hint">{t('Pages set to be revealed in a later book.')}</span>
        </span>
      </label>
      <div className="publishing-buttons">
        <button type="button" className="btn btn-sm" disabled={index === 0} onClick={() => onMove(-1)}>{t('Move up')}</button>
        <button type="button" className="btn btn-sm" disabled={index === count - 1} onClick={() => onMove(1)}>{t('Move down')}</button>
        <button type="button" className="btn btn-sm" onClick={onRemove}>{t('Remove')}</button>
      </div>
    </fieldset>
  );
}

function CoverChooser({ assetId, onChange }: { assetId: string | undefined; onChange: (id: string | undefined) => void }) {
  useLocale();
  const [url, setUrl] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setUrl(null);
    if (!assetId) return undefined;
    let current = true;
    assetUrl(assetId).then(
      (next) => {
        if (current) setUrl(next);
      },
      () => {
        if (current) setProblem(t('The cover picture could not be read.'));
      },
    );
    return () => {
      current = false;
    };
  }, [assetId]);

  return (
    <div className="publishing-cover">
      {url ? (
        <img className="publishing-cover-image" src={url} alt={t("The book's cover")} data-testid="cover-image" />
      ) : (
        <div className="publishing-cover-image publishing-cover-empty">{t('No cover')}</div>
      )}
      <div>
        <div className="publishing-buttons">
          <button type="button" className="btn" onClick={() => fileRef.current?.click()}>{t('Choose picture…')}</button>
          {assetId && <button type="button" className="btn" onClick={() => onChange(undefined)}>{t('Remove')}</button>}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          hidden
          data-testid="cover-file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            setProblem(null);
            addAsset(file).then(onChange, (error: unknown) => setProblem(errorMessage(error)));
          }}
        />
        <p className="field-hint">
          {t(
            'Shown first in EPUB, Word and PDF. Ebook stores want a tall picture, about 1600 by 2560 pixels. A print-ready PDF leaves it out, because printers take the cover as a file of its own.',
          )}
        </p>
        {problem && <p className="field-error">{problem}</p>}
      </div>
    </div>
  );
}

interface Names {
  title: string;
  subtitle: string;
  author: string;
}

function PublishingForm({ book }: { book: Book }) {
  useLocale();
  const go = useNav((s) => s.go);
  const [details, setDetails] = useState<BookPublishing>(book.publishing ?? {});
  const [names, setNames] = useState<Names>({ title: book.title, subtitle: book.subtitle, author: book.author });
  const latest = useRef({ details, names });
  const version = useDataVersion('pages');
  const { data: categoryList } = useLoad(() => api.pages.categories(), [version]);
  const categories = useMemo(() => (categoryList ?? []).map((c) => c.name), [categoryList]);

  const saver = useDocSaver<{ details: BookPublishing; names: Names }>((value) =>
    api.books.update(book.id, {
      // A book must keep a title, even while this box is being retyped.
      title: value.names.title.trim() || book.title,
      subtitle: value.names.subtitle.trim(),
      author: value.names.author.trim(),
      publishing: value.details,
    }),
  );

  const changeDetails = (patch: BookPublishing) => {
    const next = { ...latest.current.details, ...patch };
    latest.current = { ...latest.current, details: next };
    setDetails(next);
    saver.schedule(latest.current);
  };
  const changeNames = (patch: Partial<Names>) => {
    const next = { ...latest.current.names, ...patch };
    latest.current = { ...latest.current, names: next };
    setNames(next);
    saver.schedule(latest.current);
  };

  const textField = (label: string, name: 'series' | 'seriesNumber' | 'publisher' | 'isbn' | 'copyrightYear' | 'language', placeholder?: string) => (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        className="input"
        value={details[name] ?? ''}
        placeholder={placeholder}
        onChange={(e) => changeDetails({ [name]: e.target.value })}
      />
    </label>
  );

  const appendices = details.appendices ?? [];
  const setAppendices = (next: AppendixSpec[]) => changeDetails({ appendices: next });
  const addAppendix = () => {
    const first = APPENDIX_KINDS[0];
    setAppendices([...appendices, { title: first.title, kind: first.kind, categories: [], pageTypes: first.pageTypes, canonOnly: true, hideSpoilers: true }]);
  };
  const isbnProblem = details.isbn?.trim() && !isbnLooksRight(details.isbn);

  return (
    <div className="publishing-form">
      <section className="publishing-section">
        <h2 className="exporters-heading">{t('Cover')}</h2>
        <CoverChooser assetId={details.coverAssetId} onChange={(id) => changeDetails({ coverAssetId: id })} />
      </section>

      <section className="publishing-section">
        <h2 className="exporters-heading">{t('Details')}</h2>
        <label className="field">
          <span className="field-label">{t('Title')}</span>
          <input className="input" value={names.title} onChange={(e) => changeNames({ title: e.target.value })} />
        </label>
        {!names.title.trim() && <div className="field-error">{t('A book needs a title.')}</div>}
        <label className="field">
          <span className="field-label">{t('Subtitle')}</span>
          <input className="input" value={names.subtitle} onChange={(e) => changeNames({ subtitle: e.target.value })} />
        </label>
        <label className="field">
          <span className="field-label">{t('Author')}</span>
          <input className="input" value={names.author} onChange={(e) => changeNames({ author: e.target.value })} />
        </label>
        <div className="publishing-row">
          <div className="publishing-grow">{textField(t('Series'), 'series')}</div>
          {textField(t('Number in series'), 'seriesNumber')}
        </div>
        <label className="field">
          <span className="field-label">{t('Description')}</span>
          <textarea
            className="textarea"
            rows={3}
            value={details.description ?? ''}
            onChange={(e) => changeDetails({ description: e.target.value })}
          />
        </label>
        <div className="publishing-row">
          <div className="publishing-grow">{textField(t('Publisher'), 'publisher')}</div>
          {textField(t('Language code'), 'language', 'en')}
        </div>
        <div className="publishing-row">
          <div className="publishing-grow">{textField(t('ISBN'), 'isbn')}</div>
          {textField(t('Copyright year'), 'copyrightYear')}
        </div>
        {isbnProblem && <div className="field-error">{t('That does not look like a valid ISBN. Check the digits.')}</div>}
      </section>

      <section className="publishing-section">
        <h2 className="exporters-heading">{t('Front matter')}</h2>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={details.titlePage !== false}
            onChange={(e) => changeDetails({ titlePage: e.target.checked })}
          />
          <span>
            {t('Title page')}
            <span className="field-hint">{t('The title, subtitle and author from the details above.')}</span>
          </span>
        </label>
        {frontMatter().map((matter) => (
          <MatterEditor
            key={matter.name}
            bookId={book.id}
            {...matter}
            page={details[matter.name]}
            onChange={(page) => changeDetails({ [matter.name]: page })}
          />
        ))}
      </section>

      <section className="publishing-section">
        <h2 className="exporters-heading">{t('Back matter')}</h2>
        {backMatter().map((matter) => (
          <MatterEditor
            key={matter.name}
            bookId={book.id}
            {...matter}
            page={details[matter.name]}
            onChange={(page) => changeDetails({ [matter.name]: page })}
          />
        ))}
      </section>

      <section className="publishing-section">
        <h2 className="exporters-heading">{t('Appendices from the wiki')}</h2>
        <p className="muted">
          {t('Sections at the back of the book, filled from the wiki each time you export, and placed before the acknowledgments.')}
        </p>
        {appendices.map((spec, index) => (
          <AppendixEditor
            // The list only changes through these buttons, so position identifies an entry.
            key={index}
            spec={spec}
            index={index}
            count={appendices.length}
            categories={categories}
            onChange={(next) => setAppendices(appendices.map((s, i) => (i === index ? next : s)))}
            onMove={(delta) => {
              const next = [...appendices];
              [next[index], next[index + delta]] = [next[index + delta], next[index]];
              setAppendices(next);
            }}
            onRemove={() => setAppendices(appendices.filter((_, i) => i !== index))}
          />
        ))}
        <button type="button" className="btn" onClick={addAppendix}>{t('Add an appendix')}</button>
      </section>

      <div className="exporters-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void saver.flush().then(() => go({ view: 'export' }))}
        >
          {t('Export…')}
        </button>
        <span className="muted small">{t('Changes save themselves.')}</span>
      </div>
    </div>
  );
}

export default function PublishingView({ bookId }: { bookId?: string }) {
  useLocale();
  const version = useDataVersion('books');
  const { data: books } = useLoad(() => api.books.list(), [version]);
  const [chosen, setChosen] = useState(bookId);
  const book = books?.find((b) => b.id === chosen) ?? books?.[0];
  return (
    <div className="view-pad exporters publishing">
      <h1 className="view-title">{t('Publishing details')}</h1>
      {(books?.length ?? 0) > 1 && book && (
        <label className="field publishing-book">
          <span className="field-label">{t('Book')}</span>
          <select className="select" value={book.id} onChange={(e) => setChosen(e.target.value)}>
            {books?.map((b) => (
              <option key={b.id} value={b.id}>{b.title}</option>
            ))}
          </select>
        </label>
      )}
      {book ? (
        <PublishingForm key={book.id} book={book} />
      ) : (
        books && <p className="muted">{t('This project has no books yet.')}</p>
      )}
    </div>
  );
}
