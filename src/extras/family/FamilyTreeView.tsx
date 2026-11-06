/**
 * Families as trees, generations top to bottom, with the same information as a list.
 * Plain buttons over one SVG, so nothing here runs while the view sits idle.
 */

import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { create } from 'zustand';

import * as extras from '../api';
import { PageAutocomplete, matchTitles } from '../common/PageAutocomplete';
import { openRelationshipDialog } from '../graph/relationships';
import { t } from '../../lib/i18n';
import { errorMessage } from '../../lib/rpc';
import { useDataVersion, useLoad } from '../../state/events';
import { useLocale } from '../../state/language';
import { useNav } from '../../state/nav';
import { useTitles } from '../../state/project';
import { CARD_HEIGHT, CARD_WIDTH, layoutFamilies, moveInFamily, type FamilyKey, type PlacedFamily } from './layout';

type FamilyMode = 'tree' | 'list';

interface SavedScroll {
  /** Whose tree it was. Another person's tree opens on that person instead. */
  key: string;
  left: number;
  top: number;
}

interface FamilyUi {
  mode: FamilyMode;
  scroll: SavedScroll | null;
  patch: (next: Partial<Pick<FamilyUi, 'mode' | 'scroll'>>) => void;
}

const useFamilyUi = create<FamilyUi>((set) => ({
  mode: 'tree',
  scroll: null,
  patch: (next) => set(next),
}));

export function resetFamilyUi() {
  useFamilyUi.getState().patch({ mode: 'tree', scroll: null });
}

const FAMILY_KEYS = new Set<string>(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

function openPerson(person: extras.FamilyPerson) {
  useNav
    .getState()
    .go(person.missing ? { view: 'missing', title: person.title } : { view: 'page', id: person.id });
}

/**
 * A name whose page is in the trash shows as missing, the way a link to it reads, but it is
 * not a page still to be written. Opening it offers to restore it.
 */
function inTrash(person: extras.FamilyPerson): boolean {
  return person.missing && person.trashed === true;
}

function missingNote(person: extras.FamilyPerson): string {
  return inTrash(person) ? t('In the trash') : t('No page yet');
}

function lifeDates(person: extras.FamilyPerson): string {
  if (person.born && person.died) return t('{born} to {died}', { born: person.born, died: person.died });
  if (person.born) return t('Born {date}', { date: person.born });
  if (person.died) return t('Died {date}', { date: person.died });
  return '';
}

function titlesOf(ids: string[] | undefined, people: Map<string, extras.FamilyPerson>): string[] {
  return (ids ?? []).map((id) => people.get(id)?.title ?? '').filter(Boolean);
}

/** A card's whole meaning, since a screen reader cannot see the lines. */
function describePerson(family: PlacedFamily, person: extras.FamilyPerson, people: Map<string, extras.FamilyPerson>): string {
  const parts = [person.title];
  const dates = lifeDates(person);
  if (dates) parts.push(dates);
  if (person.missing) parts.push(inTrash(person) ? t('in the trash') : t('no page yet'));
  const say = (phrase: (names: string) => string, ids?: string[]) => {
    const names = titlesOf(ids, people);
    if (names.length > 0) parts.push(phrase(names.join(', ')));
  };
  say((names) => t('child of {names}', { names }), family.parentsOf.get(person.id));
  say((names) => t('spouse of {names}', { names }), family.spousesOf.get(person.id));
  say((names) => t('parent of {names}', { names }), family.childrenOf.get(person.id));
  return parts.join(', ');
}

function FamilyChart({
  family,
  focusId,
  people,
}: {
  family: PlacedFamily;
  focusId?: string;
  people: Map<string, extras.FamilyPerson>;
}) {
  useLocale();
  const host = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const known = current !== null && family.cards.some((card) => card.person.id === current);
  const tabStop = known ? current : (focusId && family.cards.find((c) => c.person.id === focusId)?.person.id) || family.cards[0]?.person.id;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Alt with an arrow is going back, which belongs to the whole app.
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (!FAMILY_KEYS.has(e.key) || !tabStop) return;
    e.preventDefault();
    const next = moveInFamily(family, tabStop, e.key as FamilyKey);
    if (!next) return;
    setCurrent(next);
    const target = [...(host.current?.querySelectorAll<HTMLElement>('[data-person-id]') ?? [])].find(
      (element) => element.dataset.personId === next,
    );
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  return (
    <div
      ref={host}
      className="family-canvas"
      role="group"
      aria-label={t('Family of {name}. Arrow keys move between people.', { name: family.label })}
      style={{ width: `${family.width}rem`, height: `${family.height}rem` }}
      onKeyDown={onKeyDown}
    >
      <svg
        className="family-lines"
        aria-hidden="true"
        viewBox={`0 0 ${family.width} ${family.height}`}
        preserveAspectRatio="xMinYMin meet"
      >
        <path className="family-parent-lines" d={family.parentLines} />
        <path className="family-spouse-lines" d={family.spouseLines} />
      </svg>
      {family.cards.map(({ person, x, y }) => {
        const dates = lifeDates(person);
        return (
          <button
            key={person.id}
            type="button"
            className={`family-card${person.missing ? ' is-missing' : ''}${person.id === focusId ? ' is-focus' : ''}`}
            style={{ left: `${x}rem`, top: `${y}rem`, width: `${CARD_WIDTH}rem`, height: `${CARD_HEIGHT}rem` }}
            tabIndex={person.id === tabStop ? 0 : -1}
            data-person-id={person.id}
            data-person={person.title}
            data-wiki-target={person.missing ? undefined : person.title}
            title={person.title}
            aria-label={describePerson(family, person, people)}
            aria-current={person.id === focusId ? 'true' : undefined}
            onFocus={() => setCurrent(person.id)}
            onClick={() => openPerson(person)}
          >
            <span className="family-card-title truncate">{person.title}</span>
            {(dates || person.missing) && (
              <span className="family-card-dates truncate">{person.missing ? missingNote(person) : dates}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function PersonLinks({ ids, people }: { ids: string[] | undefined; people: Map<string, extras.FamilyPerson> }) {
  const listed = (ids ?? []).flatMap((id) => {
    const person = people.get(id);
    return person ? [person] : [];
  });
  return (
    <>
      {listed.map((person, index) => (
        <span key={person.id}>
          <button
            type="button"
            className={`link-button${person.missing ? ' family-missing-link' : ''}`}
            data-wiki-target={person.missing ? undefined : person.title}
            onClick={() => openPerson(person)}
          >
            {person.title}
          </button>
          {index < listed.length - 1 && ', '}
        </span>
      ))}
    </>
  );
}

function FamilyList({
  family,
  focusId,
  people,
}: {
  family: PlacedFamily;
  focusId?: string;
  people: Map<string, extras.FamilyPerson>;
}) {
  useLocale();
  return (
    <div className="family-list">
      {family.rows.map((row, generation) => (
        <section key={generation} aria-label={t('Generation {number}', { number: generation + 1 })}>
          <h3 className="family-generation">{t('Generation {number}', { number: generation + 1 })}</h3>
          <ul className="family-people">
            {row.map((id) => {
              const person = people.get(id);
              if (!person) return null;
              const dates = lifeDates(person);
              const relatives: [string, string[] | undefined][] = [
                [t('Parents'), family.parentsOf.get(id)],
                [t('Spouse'), family.spousesOf.get(id)],
                [t('Children'), family.childrenOf.get(id)],
              ];
              return (
                <li key={id} className={`family-person${id === focusId ? ' is-focus' : ''}`} data-family-person={person.title}>
                  <PersonLinks ids={[id]} people={people} />
                  {person.missing && (
                    <span className="muted"> ({inTrash(person) ? t('in the trash') : t('no page yet')})</span>
                  )}
                  {dates && <span className="muted"> ({dates})</span>}
                  {relatives.map(
                    ([label, ids]) =>
                      ids &&
                      ids.length > 0 && (
                        <div key={label} className="family-person-detail">
                          <span className="muted">{label}:</span> <PersonLinks ids={ids} people={people} />
                        </div>
                      ),
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function LoopNotice({ families }: { families: PlacedFamily[] }) {
  useLocale();
  const loops = families.flatMap((family) => family.loops);
  if (loops.length === 0) return null;
  const shown = loops.slice(0, 5);
  return (
    <div className="family-loops" role="note">
      <p>
        {loops.length === 1
          ? t('One tie is left out of the tree, because a person cannot be drawn above themselves. Check these pages:')
          : t('{count} ties are left out of the tree, because a person cannot be drawn above themselves. Check these pages:', {
              count: loops.length,
            })}
      </p>
      <ul>
        {shown.map(({ parent, child }) => (
          <li key={`${parent.id}>${child.id}`}>
            {/* One sentence, with each name a button where the translation puts it. */}
            {t('{parent} is listed as a parent of {child}')
              .split(/(\{parent\}|\{child\})/)
              .map((piece, index) =>
                piece === '{parent}' || piece === '{child}' ? (
                  <button
                    key={index}
                    type="button"
                    className="link-button"
                    onClick={() => openPerson(piece === '{parent}' ? parent : child)}
                  >
                    {piece === '{parent}' ? parent.title : child.title}
                  </button>
                ) : (
                  piece
                ),
              )}
          </li>
        ))}
      </ul>
      {loops.length > shown.length && (
        <p className="muted">{t('And {count} more.', { count: loops.length - shown.length })}</p>
      )}
    </div>
  );
}

function peopleText(count: number): string {
  return count === 1 ? t('1 person') : t('{count} people', { count });
}

export function FamilyTreeView({ pageId }: { pageId?: string }) {
  useLocale();
  const version = useDataVersion('extras', 'pages', 'pageContent');
  const go = useNav((s) => s.go);
  const { mode, patch } = useFamilyUi();
  const [findText, setFindText] = useState('');
  const { data, error } = useLoad(() => extras.familyData(), [version]);

  const everyone = useMemo(() => (data ? layoutFamilies(data) : []), [data]);
  const people = useMemo(() => new Map(data?.people.map((person) => [person.id, person])), [data]);
  const families = useMemo(
    () => (pageId ? everyone.filter((family) => family.cards.some((card) => card.person.id === pageId)) : everyone),
    [everyone, pageId],
  );
  const pageTitle = useTitles((s) => (pageId ? s.byId.get(pageId)?.title : undefined));

  // Back from a page returns to the same place. A new person opens centered on them.
  const scroller = useRef<HTMLDivElement>(null);
  const scrollKey = `${pageId ?? ''}:${mode}`;
  const ready = data !== undefined;
  const hasFamilies = families.length > 0;
  // Layout effects, because by the time a passive cleanup runs the element is gone.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || !ready) return;
    const saved = useFamilyUi.getState().scroll;
    if (saved?.key === scrollKey) {
      element.scrollTo(saved.left, saved.top);
    } else {
      const box = element.getBoundingClientRect();
      const focus = element.querySelector('.is-focus');
      // With nobody chosen, a wide tree opens on its oldest generation, which would
      // otherwise be off to the side with nothing but empty space in view.
      const start = focus ?? element.querySelector('.family-card');
      if (start) {
        const rect = start.getBoundingClientRect();
        element.scrollBy(
          rect.left + rect.width / 2 - (box.left + box.width / 2),
          focus ? rect.top + rect.height / 2 - (box.top + box.height / 2) : 0,
        );
      }
    }
    return () => {
      useFamilyUi.getState().patch({
        scroll: { key: scrollKey, left: element.scrollLeft, top: element.scrollTop },
      });
    };
  }, [ready, scrollKey, hasFamilies]);

  if (error) {
    return (
      <div className="view-pad">
        <h1 className="view-title">{t('Family tree')}</h1>
        <p className="error-detail">{t('Could not load families: {error}', { error: errorMessage(error) })}</p>
      </div>
    );
  }
  if (!data) return <div className="atlas-view" />;

  const focus = pageId && pageTitle ? { id: pageId, title: pageTitle } : undefined;
  const addRelationship = () => void openRelationshipDialog({ from: focus, kind: 'parent of' });
  // A parent is the "from" side of "parent of", so the chosen person goes on the other side.
  const addParent = () => void openRelationshipDialog({ to: focus, kind: 'parent of' });
  const addChild = () => void openRelationshipDialog({ from: focus, kind: 'parent of' });
  const addSpouse = () => void openRelationshipDialog({ from: focus, kind: 'spouse' });
  const peopleShown = families.reduce((sum, family) => sum + family.cards.length, 0);

  return (
    <div className="atlas-view" data-testid="family-tree-view">
      <header className="atlas-header">
        <h1 className="atlas-title">{t('Family tree')}</h1>
        {families.length > 0 && (
          <p className="atlas-summary" role="status">
            {families.length > 1
              ? t('{people} in {count} families', { people: peopleText(peopleShown), count: families.length })
              : peopleText(peopleShown)}
          </p>
        )}
        <span className="atlas-toolbar-spacer" />
        {everyone.length > 0 && (
          <div className="segmented" role="group" aria-label={t('View as')}>
            {(
              [
                ['tree', t('Tree')],
                ['list', t('List')],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`btn btn-sm${mode === value ? ' btn-primary' : ''}`}
                aria-pressed={mode === value}
                onClick={() => patch({ mode: value })}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {focus ? (
          <div className="family-add" role="group" aria-label={t('Add to the family of {title}', { title: focus.title })}>
            <button type="button" className="btn btn-sm" onClick={addParent}>{t('Add parent')}</button>
            <button type="button" className="btn btn-sm" onClick={addChild}>{t('Add child')}</button>
            <button type="button" className="btn btn-sm" onClick={addSpouse}>{t('Add spouse')}</button>
          </div>
        ) : (
          <button type="button" className="btn btn-sm" onClick={addRelationship}>
            {t('Add relationship')}
          </button>
        )}
      </header>

      {everyone.length > 0 && (
        <div className="atlas-toolbar" role="group" aria-label={t('Whose family to show')}>
          <div className="family-find">
            <PageAutocomplete
              label={t('Show the family of')}
              placeholder={t('Show the family of')}
              value={findText}
              onChange={setFindText}
              onPick={(entry) => {
                setFindText('');
                go({ view: 'familyTree', pageId: entry.id });
              }}
              onEnter={(text) => {
                const best = matchTitles(useTitles.getState().entries, text)[0];
                if (!best) return;
                setFindText('');
                go({ view: 'familyTree', pageId: best.id });
              }}
            />
          </div>
          {pageId && (
            <>
              {pageTitle && (
                <button type="button" className="btn btn-sm" onClick={() => go({ view: 'page', id: pageId })}>
                  {t('Open {title}', { title: pageTitle })}
                </button>
              )}
              <button type="button" className="btn btn-sm" onClick={() => go({ view: 'familyTree' })}>
                {t('Show all families')}
              </button>
            </>
          )}
        </div>
      )}

      {families.length === 0 ? (
        <div className="empty-state atlas-empty">
          <h2 className="atlas-empty-title">
            {pageId
              ? pageTitle
                ? t('{title} has no family recorded', { title: pageTitle })
                : t('This page has no family recorded')
              : t('No families yet')}
          </h2>
          <p>
            {t("Fill in Parents, Spouse or Children on a character page, or add a relationship such as parent of or spouse. Both people's pages stay in step.")}
          </p>
          <div className="atlas-empty-actions">
            <button type="button" className="btn btn-primary" onClick={addRelationship}>
              {t('Add relationship')}
            </button>
            {pageId && everyone.length > 0 && (
              <button type="button" className="btn" onClick={() => go({ view: 'familyTree' })}>
                {t('Show all families')}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div ref={scroller} className="family-scroll">
          <LoopNotice families={families} />
          {families.map((family) => (
            <section key={family.key} className="family-block" aria-label={t('Family of {name}', { name: family.label })}>
              <h2 className="family-block-title">
                {t('Family of {name}', { name: family.label })}{' '}
                <span className="muted">({peopleText(family.cards.length)})</span>
              </h2>
              {mode === 'tree' ? (
                <FamilyChart family={family} focusId={pageId} people={people} />
              ) : (
                <FamilyList family={family} focusId={pageId} people={people} />
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
