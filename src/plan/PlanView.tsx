/**
 * Plan a story: braindump, synopsis, characters, world, structure, outline and review. The AI
 * suggests at each step and the writer edits. Nothing is made until Create on the last step.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { AiError } from '../ai/client';
import * as api from '../lib/api';
import { t } from '../lib/i18n';
import { errorMessage } from '../lib/rpc';
import type { Book } from '../lib/types';
import { confirm } from '../shell/dialogs';
import { toast } from '../shell/toasts';
import { useLocale } from '../state/language';
import { useNav } from '../state/nav';
import { useTitles } from '../state/project';
import { allPageTypes } from '../wiki/pageTypes';
import { typeLabel } from '../wiki/templates';
import { selectBook, syncNow } from '../write/store';
import { askCharacters, askOutline, askSynopsis, askWorld } from './ai';
import { createFromPlan, undoCreated, type Created } from './create';
import {
  buildCreationPlan,
  chaptersFromBeats,
  findExisting,
  mergeSuggestions,
  newKey,
  STEPS,
  type ExistingPage,
  type PlanChapter,
  type PlanEntity,
  type PlanScene,
  type PlanState,
  type StepId,
} from './plan';
import { loadPlan, savePlanNow, startOver, updatePlan, usePlan } from './store';
import { structureById, structures } from './templates';

function stepTitle(step: StepId): string {
  switch (step) {
    case 'braindump': return t('Braindump');
    case 'synopsis': return t('Synopsis');
    case 'characters': return t('Characters');
    case 'world': return t('World');
    case 'structure': return t('Structure');
    case 'outline': return t('Outline');
    case 'review': return t('Review');
  }
}

const AI_STEPS: StepId[] = ['synopsis', 'characters', 'world', 'outline'];

/** Page types for places, groups and things: everything but characters and plain articles. */
function worldTypes(): string[] {
  const types = allPageTypes().map((p) => p.type).filter((type) => type !== 'character' && type !== 'article');
  return types.length > 0 ? types : ['place'];
}

function existingPages(): ExistingPage[] {
  return useTitles.getState().entries.map((e) => ({ id: e.id, title: e.title, aliases: e.aliases, pageType: e.pageType }));
}

/** Marks suggestions that are already wiki pages, to link to rather than make again. */
function markExisting(list: PlanEntity[]): PlanEntity[] {
  const pages = existingPages();
  return list.map((e) => {
    const found = findExisting(e.name, pages);
    return found ? { ...e, name: found.title, existingId: found.id } : { ...e, existingId: undefined };
  });
}

function hasContent(plan: PlanState, step: StepId): boolean {
  switch (step) {
    case 'synopsis': return !!plan.synopsis.trim();
    case 'characters': return plan.characters.length > 0;
    case 'world': return plan.world.length > 0;
    case 'outline': return plan.chapters.length > 0;
    default: return false;
  }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function EntityList(props: {
  list: PlanEntity[];
  types: string[] | null;
  label: string;
  addLabel: string;
  onChange: (list: PlanEntity[]) => void;
}) {
  const { list, types, label, addLabel, onChange } = props;
  const set = (key: string, patch: Partial<PlanEntity>) =>
    onChange(list.map((e) => (e.key === key ? { ...e, ...patch, touched: true, ...(patch.name !== undefined ? { existingId: undefined } : {}) } : e)));
  return (
    <div className="plan-entities">
      {list.length === 0 && <p className="muted">{t('Nothing here yet.')}</p>}
      <ul className="plan-list" aria-label={label}>
        {list.map((entity, i) => {
          const name = entity.name || t('Item {number}', { number: i + 1 });
          return (
            <li key={entity.key} className="plan-card" data-plan-entity={entity.name}>
              <div className="plan-row">
                <input
                  className="input plan-name"
                  aria-label={t('Name of {name}', { name })}
                  placeholder={t('Name')}
                  value={entity.name}
                  onChange={(e) => set(entity.key, { name: e.target.value })}
                  onBlur={() => onChange(markExisting(list))}
                />
                {types && (
                  <select
                    className="select"
                    aria-label={t('Type of {name}', { name })}
                    value={entity.pageType}
                    onChange={(e) => set(entity.key, { pageType: e.target.value })}
                  >
                    {[...new Set([...types, entity.pageType])].map((type) => (
                      <option key={type} value={type}>{typeLabel(type)}</option>
                    ))}
                  </select>
                )}
                {entity.existingId && (
                  <span className="chip plan-existing" title={t('This page is already in the wiki. It will be linked, not made again.')}>
                    {t('In the wiki')}
                  </span>
                )}
                <button
                  type="button"
                  className="btn btn-sm"
                  aria-label={t('Remove {name}', { name })}
                  onClick={() => onChange(list.filter((e) => e.key !== entity.key))}
                >
                  {t('Remove')}
                </button>
              </div>
              <input
                className="input"
                aria-label={t('Role of {name}', { name })}
                placeholder={t('Their role in the story, in one line')}
                value={entity.role}
                onChange={(e) => set(entity.key, { role: e.target.value })}
              />
              {!entity.existingId && (
                <textarea
                  className="textarea"
                  rows={2}
                  aria-label={t('Description of {name}', { name })}
                  placeholder={t('Description')}
                  value={entity.description}
                  onChange={(e) => set(entity.key, { description: e.target.value })}
                />
              )}
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="btn"
        onClick={() => onChange([...list, { key: newKey(), name: '', pageType: types?.[0] ?? 'character', role: '', description: '', touched: true }])}
      >
        {addLabel}
      </button>
    </div>
  );
}

function move<T>(list: T[], from: number, by: number): T[] {
  const to = from + by;
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

const castText = (cast: string[]) => cast.join(', ');
const castList = (text: string) => text.split(',').map((s) => s.trim()).filter(Boolean);

function SceneRow(props: {
  scene: PlanScene;
  index: number;
  count: number;
  chapterName: string;
  people: string[];
  onChange: (scene: PlanScene) => void;
  onMove: (by: number) => void;
  onRemove: () => void;
}) {
  const { scene, index, count, chapterName, people, onChange, onMove, onRemove } = props;
  const name = t('{chapter}, scene {number}', { chapter: chapterName, number: index + 1 });
  const [cast, setCast] = useState(castText(scene.cast));
  useEffect(() => setCast(castText(scene.cast)), [scene.cast]);
  return (
    <li className="plan-scene" data-plan-scene={index + 1}>
      <div className="plan-row">
        <input
          className="input plan-name"
          aria-label={t('Title of {name}', { name })}
          placeholder={t('Scene title')}
          value={scene.title}
          onChange={(e) => onChange({ ...scene, title: e.target.value })}
        />
        <select
          className="select"
          aria-label={t('Point of view of {name}', { name })}
          value={scene.pov}
          onChange={(e) => onChange({ ...scene, pov: e.target.value })}
        >
          <option value="">{t('No point of view')}</option>
          {[...new Set([...people, ...(scene.pov ? [scene.pov] : [])])].map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <button type="button" className="btn btn-sm" aria-label={t('Move {name} up', { name })} disabled={index === 0} onClick={() => onMove(-1)}>↑</button>
        <button type="button" className="btn btn-sm" aria-label={t('Move {name} down', { name })} disabled={index === count - 1} onClick={() => onMove(1)}>↓</button>
        <button type="button" className="btn btn-sm" aria-label={t('Delete {name}', { name })} onClick={onRemove}>{t('Delete')}</button>
      </div>
      <textarea
        className="textarea"
        rows={2}
        aria-label={t('Synopsis of {name}', { name })}
        placeholder={t('What happens, in a sentence or two')}
        value={scene.synopsis}
        onChange={(e) => onChange({ ...scene, synopsis: e.target.value })}
      />
      <input
        className="input"
        aria-label={t('Cast of {name}', { name })}
        placeholder={t('Who is in it, separated by commas')}
        value={cast}
        onChange={(e) => setCast(e.target.value)}
        onBlur={() => onChange({ ...scene, cast: castList(cast) })}
      />
    </li>
  );
}

function OutlineEditor({ plan }: { plan: PlanState }) {
  const chapters = plan.chapters;
  const people = useMemo(() => {
    const wiki = useTitles.getState().entries.filter((e) => e.pageType === 'character').map((e) => e.title);
    return [...new Set([...plan.characters.map((c) => c.name.trim()).filter(Boolean), ...wiki])];
  }, [plan.characters]);
  const setChapters = (next: PlanChapter[]) => updatePlan({ chapters: next });
  const setChapter = (key: string, patch: Partial<PlanChapter>) => setChapters(chapters.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  const structure = structureById(plan.structureId);
  return (
    <div className="plan-outline">
      {chapters.length === 0 && structure && (
        <p>
          <button type="button" className="btn" onClick={() => setChapters(chaptersFromBeats(structure.beats))}>
            {t('Start from the beats of {name}', { name: structure.name })}
          </button>
        </p>
      )}
      <ol className="plan-list" aria-label={t('Chapters')}>
        {chapters.map((chapter, i) => {
          const name = chapter.title || t('Chapter {number}', { number: i + 1 });
          return (
            <li key={chapter.key} className="plan-card plan-chapter" data-plan-chapter={i + 1}>
              <div className="plan-row">
                <input
                  className="input plan-name"
                  aria-label={t('Title of chapter {number}', { number: i + 1 })}
                  placeholder={t('Chapter title')}
                  value={chapter.title}
                  onChange={(e) => setChapter(chapter.key, { title: e.target.value })}
                />
                <button type="button" className="btn btn-sm" aria-label={t('Move {name} up', { name })} disabled={i === 0} onClick={() => setChapters(move(chapters, i, -1))}>↑</button>
                <button type="button" className="btn btn-sm" aria-label={t('Move {name} down', { name })} disabled={i === chapters.length - 1} onClick={() => setChapters(move(chapters, i, 1))}>↓</button>
                <button type="button" className="btn btn-sm" aria-label={t('Delete {name}', { name })} onClick={() => setChapters(chapters.filter((c) => c.key !== chapter.key))}>
                  {t('Delete')}
                </button>
              </div>
              <textarea
                className="textarea"
                rows={2}
                aria-label={t('Synopsis of chapter {number}', { number: i + 1 })}
                placeholder={t('What this chapter does')}
                value={chapter.synopsis}
                onChange={(e) => setChapter(chapter.key, { synopsis: e.target.value })}
              />
              <ol className="plan-scenes">
                {chapter.scenes.map((scene, j) => (
                  <SceneRow
                    key={scene.key}
                    scene={scene}
                    index={j}
                    count={chapter.scenes.length}
                    chapterName={name}
                    people={people}
                    onChange={(s) => setChapter(chapter.key, { scenes: chapter.scenes.map((x) => (x.key === s.key ? s : x)) })}
                    onMove={(by) => setChapter(chapter.key, { scenes: move(chapter.scenes, j, by) })}
                    onRemove={() => setChapter(chapter.key, { scenes: chapter.scenes.filter((x) => x.key !== scene.key) })}
                  />
                ))}
              </ol>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setChapter(chapter.key, { scenes: [...chapter.scenes, { key: newKey(), title: '', synopsis: '', pov: '', cast: [] }] })}
              >
                {t('Add a scene to {name}', { name })}
              </button>
            </li>
          );
        })}
      </ol>
      <button
        type="button"
        className="btn"
        onClick={() => setChapters([...chapters, { key: newKey(), title: '', synopsis: '', scenes: [{ key: newKey(), title: '', synopsis: '', pov: '', cast: [] }] }])}
      >
        {t('Add a chapter')}
      </button>
    </div>
  );
}

function StructurePicker({ plan }: { plan: PlanState }) {
  const list = structures();
  return (
    <fieldset className="plan-structures">
      <legend className="plan-hidden">{t('Structure')}</legend>
      <label className="plan-structure">
        <input type="radio" name="plan-structure" checked={!plan.structureId} onChange={() => updatePlan({ structureId: null })} />
        <span>
          <strong>{t('None')}</strong>
          <span className="muted small"> {t('Plan the chapters freely.')}</span>
        </span>
      </label>
      {list.map((s) => (
        <label key={s.id} className="plan-structure">
          <input type="radio" name="plan-structure" checked={plan.structureId === s.id} onChange={() => updatePlan({ structureId: s.id })} />
          <span>
            <strong>{s.name}</strong>
            <span className="muted small"> {s.description}</span>
            {plan.structureId === s.id && (
              <ol className="plan-beats small">
                {s.beats.map((b) => (
                  <li key={b.name}>
                    <strong>{b.name}</strong> <span className="muted">({b.at}%)</span> {b.guidance}
                  </li>
                ))}
              </ol>
            )}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function Review({ plan, books, created, onCreated }: { plan: PlanState; books: Book[]; created: Created | null; onCreated: (c: Created | null) => void }) {
  const [busy, setBusy] = useState(false);
  const entries = useTitles((s) => s.entries);
  const creation = useMemo(
    () => buildCreationPlan(plan, entries.map((e) => ({ id: e.id, title: e.title, aliases: e.aliases, pageType: e.pageType }))),
    [plan, entries],
  );
  const go = useNav((s) => s.go);
  const target = plan.target;
  const sceneCount = creation.chapters.reduce((n, c) => n + c.scenes.length, 0);
  const bookTitle = target.kind === 'existing' ? (books.find((b) => b.id === target.bookId)?.title ?? '') : target.title.trim() || t('Untitled book');

  const run = async () => {
    setBusy(true);
    try {
      const result = await createFromPlan(creation, existingPages());
      await useTitles.getState().refresh();
      await syncNow();
      onCreated(result);
    } catch (e) {
      const partial = (e as { created?: Created }).created;
      toast(t('Could not finish making the plan: {reason}', { reason: errorMessage(e) }), 'error');
      if (partial && (partial.pageIds.length || partial.chapterIds.length || partial.newBook)) onCreated(partial);
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (!created) return;
    setBusy(true);
    try {
      await undoCreated(created);
      await useTitles.getState().refresh();
      await syncNow();
      onCreated(null);
      toast(t('Everything the plan made is in the trash.'));
    } catch (e) {
      toast(t('Could not take it back: {reason}', { reason: errorMessage(e) }), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <section className="plan-done" role="status" aria-label={t('Made from the plan')}>
        <h2>{t('Done')}</h2>
        <p>
          {t('Made {pages} draft pages, {chapters} chapters and {scenes} scenes in “{book}”. Linked {linked} existing pages.', {
            pages: created.pageIds.length,
            chapters: created.chapterIds.length,
            scenes: created.sceneCount,
            book: bookTitle,
            linked: created.linkedCount,
          })}
        </p>
        <p className="muted small">{t('Each scene has its synopsis, ready to draft from.')}</p>
        <div className="plan-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              selectBook(created.bookId);
              go({ view: 'write', bookId: created.bookId, mode: 'outline' });
            }}
          >
            {t('Open the book')}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void undo()}>
            {t('Undo: move it all to the trash')}
          </button>
        </div>
      </section>
    );
  }

  return (
    <div className="plan-review">
      <fieldset className="plan-target">
        <legend>{t('Where it goes')}</legend>
        <label className="plan-structure">
          <input
            type="radio"
            name="plan-target"
            checked={target.kind === 'new'}
            onChange={() => updatePlan({ target: { kind: 'new', title: '' } })}
          />
          <span>{t('A new book')}</span>
        </label>
        {target.kind === 'new' && (
          <input
            className="input"
            aria-label={t('Title of the new book')}
            placeholder={t('Untitled book')}
            value={target.title}
            onChange={(e) => updatePlan({ target: { kind: 'new', title: e.target.value } })}
          />
        )}
        {books.length > 0 && (
          <label className="plan-structure">
            <input
              type="radio"
              name="plan-target"
              checked={target.kind === 'existing'}
              onChange={() => updatePlan({ target: { kind: 'existing', bookId: books[0].id } })}
            />
            <span>{t('The end of an existing book')}</span>
          </label>
        )}
        {target.kind === 'existing' && (
          <select
            className="select"
            aria-label={t('Book')}
            value={target.bookId}
            onChange={(e) => updatePlan({ target: { kind: 'existing', bookId: e.target.value } })}
          >
            {books.map((b) => (
              <option key={b.id} value={b.id}>{b.title}</option>
            ))}
          </select>
        )}
      </fieldset>

      {creation.synopsis && (
        <section aria-label={t('Synopsis')}>
          <h3>{t('Synopsis')}</h3>
          <p className="plan-pre">{creation.synopsis}</p>
        </section>
      )}
      <section aria-label={t('New pages')}>
        <h3>{t('New pages, as drafts ({count})', { count: creation.pages.length })}</h3>
        {creation.pages.length === 0 ? (
          <p className="muted">{t('None.')}</p>
        ) : (
          <ul>
            {creation.pages.map((p) => (
              <li key={p.name}>
                <strong>{p.name}</strong> <span className="muted">({typeLabel(p.pageType)})</span>
                {p.summary && <> {p.summary}</>}
              </li>
            ))}
          </ul>
        )}
      </section>
      {creation.linked.length > 0 && (
        <section aria-label={t('Existing pages')}>
          <h3>{t('Existing pages, linked as they are ({count})', { count: creation.linked.length })}</h3>
          <ul>
            {creation.linked.map((p) => (
              <li key={p.pageId}>{p.name}</li>
            ))}
          </ul>
        </section>
      )}
      <section aria-label={t('Chapters and scenes')}>
        <h3>{t('{chapters} chapters and {scenes} scenes in “{book}”', { chapters: creation.chapters.length, scenes: sceneCount, book: bookTitle })}</h3>
        <ol>
          {creation.chapters.map((c, i) => (
            <li key={i}>
              <strong>{c.title || t('Chapter {number}', { number: i + 1 })}</strong>
              {c.scenes.length > 0 && (
                <ul>
                  {c.scenes.map((s, j) => (
                    <li key={j}>
                      {s.title || t('Scene {number}', { number: j + 1 })}
                      {s.pov && <span className="muted"> · {t('Point of view: {name}', { name: s.pov })}</span>}
                      {s.synopsis && <span className="muted"> · {s.synopsis}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      </section>
      <p className="muted small">{t('Nothing is made until you press Create. Nothing already in the project is changed.')}</p>
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy || (creation.pages.length === 0 && creation.chapters.length === 0)}
        onClick={() => void run()}
      >
        {busy ? t('Making it…') : t('Create')}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The wizard
// ---------------------------------------------------------------------------

export function PlanView({ bookId }: { bookId?: string }) {
  useLocale();
  const loaded = usePlan((s) => s.loaded);
  const plan = usePlan((s) => s.plan);
  const [books, setBooks] = useState<Book[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [created, setCreated] = useState<Created | null>(null);
  const stopper = useRef<AbortController | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    void loadPlan().then(() => {
      const { plan: p } = usePlan.getState();
      // Opened from a book with nothing planned yet: plan into that book.
      if (bookId && p.step === 'braindump' && !p.braindump.trim() && !(p.target.kind === 'existing' && p.target.bookId === bookId)) {
        updatePlan({ target: { kind: 'existing', bookId } });
      }
    });
    void api.books.list().then(setBooks, () => {});
    // Names already in the wiki are linked rather than made again, so the list must be current.
    void useTitles.getState().refresh().catch(() => {});
    return () => {
      stopper.current?.abort();
      void savePlanNow();
    };
  }, [bookId]);

  const index = STEPS.indexOf(plan.step);
  const step = plan.step;

  const ask = async (which: StepId, current: PlanState) => {
    if (!AI_STEPS.includes(which)) return;
    stopper.current?.abort();
    const controller = new AbortController();
    stopper.current = controller;
    setBusy(true);
    setProblem('');
    updatePlan((p) => ({ asked: p.asked.includes(which) ? p.asked : [...p.asked, which] }));
    const entries = useTitles.getState().entries;
    try {
      if (which === 'synopsis') {
        const text = await askSynopsis(current, entries, controller.signal);
        if (!controller.signal.aborted) updatePlan({ synopsis: text });
      } else if (which === 'characters') {
        const list = markExisting(await askCharacters(current, entries, controller.signal));
        if (!controller.signal.aborted) updatePlan((p) => ({ characters: mergeSuggestions(p.characters, list) }));
      } else if (which === 'world') {
        const list = markExisting(await askWorld(current, entries, worldTypes(), controller.signal));
        if (!controller.signal.aborted) updatePlan((p) => ({ world: mergeSuggestions(p.world, list) }));
      } else if (which === 'outline') {
        const chapters = await askOutline(current, entries, structureById(current.structureId), controller.signal);
        if (!controller.signal.aborted) updatePlan({ chapters });
      }
    } catch (e) {
      if (controller.signal.aborted || (e instanceof AiError && e.code === 'CANCELLED')) return;
      setProblem(t('The AI could not help with this step: {reason} You can fill it in yourself.', { reason: errorMessage(e) }));
    } finally {
      if (stopper.current === controller) {
        stopper.current = null;
        setBusy(false);
      }
    }
  };

  const goTo = (next: StepId) => {
    stopper.current?.abort();
    setBusy(false);
    setProblem('');
    updatePlan({ step: next });
    headingRef.current?.focus();
    const current = { ...usePlan.getState().plan, step: next };
    if (current.useAi && AI_STEPS.includes(next) && !current.asked.includes(next) && !hasContent(current, next)) {
      void ask(next, current);
    }
  };

  const askAgain = async () => {
    const current = usePlan.getState().plan;
    if ((step === 'synopsis' || step === 'outline') && hasContent(current, step)) {
      const yes = await confirm({
        title: t('Replace what is here?'),
        message: t('New suggestions will take the place of this step’s text.'),
        confirmLabel: t('Replace'),
      });
      if (!yes) return;
    }
    void ask(step, current);
  };

  const restart = async () => {
    const yes = await confirm({
      title: t('Start over?'),
      message: t('This clears the plan. Nothing already made in the project is touched.'),
      confirmLabel: t('Start over'),
      danger: true,
    });
    if (!yes) return;
    stopper.current?.abort();
    setBusy(false);
    setProblem('');
    setCreated(null);
    await startOver();
    headingRef.current?.focus();
  };

  if (!loaded) return <div className="view-pad" />;

  return (
    <div className="view-pad plan-view" data-testid="plan-view">
      <header className="plan-head">
        <h1 className="view-title">{t('Plan a story')}</h1>
        <div className="plan-head-actions">
          <label className="plan-toggle">
            <input type="checkbox" checked={plan.useAi} onChange={(e) => updatePlan({ useAi: e.target.checked })} />
            {t('Use AI suggestions')}
          </label>
          <button type="button" className="btn btn-sm" onClick={() => void restart()}>
            {t('Start over')}
          </button>
        </div>
      </header>

      <nav aria-label={t('Steps')}>
        <ol className="plan-steps">
          {STEPS.map((s, i) => (
            <li key={s}>
              <button
                type="button"
                className={`plan-step${s === step ? ' is-current' : ''}${i < index ? ' is-done' : ''}`}
                aria-current={s === step ? 'step' : undefined}
                onClick={() => goTo(s)}
              >
                {i + 1}. {stepTitle(s)}
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <section className="plan-body" aria-labelledby="plan-step-title">
        <h2 id="plan-step-title" className="plan-step-title" tabIndex={-1} ref={headingRef}>
          {t('Step {number} of {count}: {name}', { number: index + 1, count: STEPS.length, name: stepTitle(step) })}
        </h2>

        {step === 'braindump' && (
          <>
            <p className="muted">{t('Write down anything you have: ideas, scenes, people, a mood, a question. It does not need to be tidy.')}</p>
            <textarea
              className="textarea plan-big"
              rows={12}
              aria-label={t('Braindump')}
              value={plan.braindump}
              onChange={(e) => updatePlan({ braindump: e.target.value })}
            />
          </>
        )}
        {step === 'synopsis' && (
          <>
            <p className="muted">{t('What the story is, from start to end, in a few paragraphs.')}</p>
            <textarea
              className="textarea plan-big"
              rows={10}
              aria-label={t('Synopsis')}
              value={plan.synopsis}
              onChange={(e) => updatePlan({ synopsis: e.target.value })}
            />
          </>
        )}
        {step === 'characters' && (
          <>
            <p className="muted">{t('The main characters. Names already in the wiki are linked, not made again.')}</p>
            <EntityList
              list={plan.characters}
              types={null}
              label={t('Characters')}
              addLabel={t('Add a character')}
              onChange={(characters) => updatePlan({ characters })}
            />
          </>
        )}
        {step === 'world' && (
          <>
            <p className="muted">{t('Key places, groups and things. Names already in the wiki are linked, not made again.')}</p>
            <EntityList
              list={plan.world}
              types={worldTypes()}
              label={t('World')}
              addLabel={t('Add a place, group or thing')}
              onChange={(world) => updatePlan({ world })}
            />
          </>
        )}
        {step === 'structure' && (
          <>
            <p className="muted">{t('A shape to plan the chapters around. You can also go without one.')}</p>
            <StructurePicker plan={plan} />
          </>
        )}
        {step === 'outline' && (
          <>
            <p className="muted">{t('Chapters with a few scenes each. Edit, reorder, add and delete as you like.')}</p>
            <OutlineEditor plan={plan} />
          </>
        )}
        {step === 'review' && <Review plan={plan} books={books} created={created} onCreated={setCreated} />}

        {busy && (
          <p className="plan-busy" role="status">
            {t('Asking the AI…')}{' '}
            <button type="button" className="btn btn-sm" onClick={() => { stopper.current?.abort(); setBusy(false); }}>
              {t('Stop')}
            </button>
          </p>
        )}
        {problem && (
          <p className="field-error" role="alert">
            {problem}
          </p>
        )}
      </section>

      <footer className="plan-actions">
        <button type="button" className="btn" disabled={index === 0} onClick={() => goTo(STEPS[index - 1])}>
          {t('Back')}
        </button>
        <span className="plan-spacer" />
        {AI_STEPS.includes(step) && plan.useAi && (
          <button type="button" className="btn btn-ai" disabled={busy} onClick={() => void askAgain()}>
            {plan.asked.includes(step) || hasContent(plan, step) ? t('Ask again') : t('Ask the AI')}
          </button>
        )}
        {step !== 'review' && (
          <>
            <button
              type="button"
              className="btn"
              onClick={() => {
                // Skipped steps are not asked about on their own when you come back.
                updatePlan((p) => ({ asked: p.asked.includes(step) ? p.asked : [...p.asked, step] }));
                goTo(STEPS[index + 1]);
              }}
            >
              {t('Skip')}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => goTo(STEPS[index + 1])}>
              {t('Next')}
            </button>
          </>
        )}
      </footer>
    </div>
  );
}
