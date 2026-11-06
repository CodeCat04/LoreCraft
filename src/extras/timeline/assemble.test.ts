import type { InfoboxField } from '../../lib/types';
import type { TimelinePageSource, TimelineSceneSource, TimelineSources } from '../api';
import {
  assembleTimeline,
  dateRange,
  filterTimeline,
  indexOfYear,
  overviewRows,
  startsNewYear,
  zoomSteps,
  type TimelineItem,
  type TimelineKind,
} from './assemble';

function field(key: string, value: string, kind: InfoboxField['kind'] = 'date'): InfoboxField {
  return { key, label: '', kind, value };
}

function page(title: string, pageType: string, ...fields: InfoboxField[]): TimelinePageSource {
  return { id: title, title, pageType, status: 'draft', fields };
}

function scene(title: string, storyDate: string, order: number, bookId = 'b1'): TimelineSceneSource {
  return {
    id: title,
    title,
    bookId,
    bookTitle: 'Book One',
    chapterTitle: 'Chapter 1',
    storyDate,
    povPageId: null,
    order,
  };
}

function sources(pages: TimelinePageSource[], scenes: TimelineSceneSource[] = []): TimelineSources {
  return { pages, scenes, books: [{ id: 'b1', title: 'Book One' }] };
}

const titles = (items: { title: string }[]) => items.map((item) => item.title);

describe('assembleTimeline', () => {
  it('collects births, deaths, foundings, events and scenes in date order', () => {
    const { items, unplaced } = assembleTimeline(
      sources(
        [
          page('Aria', 'character', field('born', '312'), field('died', '380')),
          page('Silver Vale', 'place', field('founded', '120')),
          page('The Guild', 'faction', field('founded', '200'), field('dissolved', '400')),
          page('Fall of Vale', 'event', field('date', '340')),
        ],
        [scene('Opening', '341', 1)],
      ),
      [],
    );
    expect(unplaced).toEqual([]);
    expect(items.map((i) => [i.title, i.kind, i.detail])).toEqual([
      ['Silver Vale', 'founding', 'Founded'],
      ['The Guild', 'founding', 'Founded'],
      ['Aria', 'birth', 'Born'],
      ['Fall of Vale', 'event', 'Event'],
      ['Opening', 'scene', 'Book One, Chapter 1'],
      ['Aria', 'death', 'Died'],
      ['The Guild', 'dissolution', 'Dissolved'],
    ]);
  });

  it('treats a start and end as a span placed at its start', () => {
    const { items, unplaced } = assembleTimeline(
      sources([
        page('The Long War', 'event', field('start', '300'), field('end', '310')),
        page('Treaty', 'event', field('date', '305')),
      ]),
      [],
    );
    expect(unplaced).toEqual([]);
    expect(titles(items)).toEqual(['The Long War', 'Treaty']);
    expect(items[0].endSort).toBe(310);
    expect(dateRange(items[0])).toBe('300 to 310');
    expect(dateRange(items[1])).toBe('305');
  });

  it('flags a span that ends before it starts, without moving it', () => {
    const { items } = assembleTimeline(
      sources([page('Backwards', 'event', field('start', '310'), field('end', '300'))]),
      [],
    );
    expect(items[0].sort).toBe(310);
    expect(items[0].problem).toBe('Ends before it starts');
  });

  it('lists what it cannot order instead of dropping or guessing', () => {
    const { items, unplaced } = assembleTimeline(
      sources(
        [
          page('Good', 'event', field('date', '10')),
          page('Vague', 'event', field('date', 'the long winter')),
          page('Era Born', 'character', field('born', '312 AE')),
          page('No Date', 'event'),
          page('Half Span', 'event', field('start', '5'), field('end', 'soon after')),
          page('Bad Start', 'event', field('start', 'long ago'), field('end', '9')),
        ],
        [scene('Foggy', 'a Tuesday', 1)],
      ),
      [],
    );
    expect(titles(items)).toEqual(['Half Span', 'Bad Start', 'Good']);
    expect(unplaced.map((u) => [u.title, u.dateText])).toEqual([
      ['Bad Start', 'long ago'],
      ['Era Born', '312 AE'],
      ['Foggy', 'a Tuesday'],
      ['Half Span', 'soon after'],
      ['No Date', ''],
      ['Vague', 'the long winter'],
    ]);
    const reasons = Object.fromEntries(unplaced.map((u) => [u.title, u.reason]));
    expect(reasons['Era Born']).toContain('"AE" is not a known era');
    expect(reasons['No Date']).toContain('no date');
    expect(reasons['Vague']).toContain('Use a year');
  });

  it('links an unplaced scene to the scene, so it can be fixed', () => {
    const { unplaced } = assembleTimeline(sources([], [scene('Foggy', 'a Tuesday', 1)]), []);
    expect(unplaced[0].link).toEqual({ kind: 'scene', id: 'Foggy', bookId: 'b1' });
  });

  it('uses project eras when ordering', () => {
    const eras = [
      { name: 'BE', offset: 0, negative: true },
      { name: 'AE', offset: 0 },
    ];
    const data = sources([
      page('After', 'event', field('date', '12 AE')),
      page('Before', 'event', field('date', '40 BE')),
    ]);
    expect(titles(assembleTimeline(data, eras).items)).toEqual(['Before', 'After']);
    // Without the eras neither date means anything.
    const without = assembleTimeline(data, []);
    expect(without.items).toEqual([]);
    expect(without.unplaced).toHaveLength(2);
  });

  it('keeps scenes on one date in reading order, ahead of later kinds', () => {
    const { items } = assembleTimeline(
      sources(
        [page('Aria', 'character', field('born', '50'), field('died', '50'))],
        [scene('Second', '50', 2), scene('First', '50', 1)],
      ),
      [],
    );
    expect(items.map((i) => `${i.title}:${i.kind}`)).toEqual([
      'Aria:birth',
      'First:scene',
      'Second:scene',
      'Aria:death',
    ]);
  });

  it('places other date fields, but ignores page fields that happen to share a key', () => {
    const { items, unplaced } = assembleTimeline(
      sources([
        page('Queen', 'character', { key: 'crowned', label: 'Crowned', kind: 'date', value: '20' }),
        page('Odd', 'article', field('born', 'Some Page', 'page')),
        page('Blank', 'character', field('born', '   ')),
        page('Numbered', 'place', field('founded', '33', 'number')),
      ]),
      [],
    );
    expect(items.map((i) => [i.title, i.kind, i.detail])).toEqual([
      ['Queen', 'other', 'Crowned'],
      ['Numbered', 'founding', 'Founded'],
    ]);
    expect(unplaced).toEqual([]);
  });

  it('reads a date as the start of a span with no start of its own', () => {
    const { items, unplaced } = assembleTimeline(
      sources([page('Siege', 'event', field('date', '340'), field('end', '350'))]),
      [],
    );
    expect(unplaced).toEqual([]);
    expect(items).toHaveLength(1);
    expect(dateRange(items[0])).toBe('340 to 350');
  });

  it('never loses a date on an event that also has a start', () => {
    const unreadable = assembleTimeline(
      sources([page('Siege', 'event', field('date', 'the long winter'), field('start', '300'))]),
      [],
    );
    expect(unreadable.items.map((i) => i.dateText)).toEqual(['300']);
    expect(unreadable.unplaced.map((u) => u.dateText)).toEqual(['the long winter']);

    const different = assembleTimeline(
      sources([page('Siege', 'event', field('date', '340'), field('start', '300'), field('end', '310'))]),
      [],
    );
    expect(different.items.map((i) => dateRange(i))).toEqual(['300 to 310', '340']);

    const same = assembleTimeline(
      sources([page('Siege', 'event', field('date', '300'), field('start', '300'), field('end', '310'))]),
      [],
    );
    expect(same.items.map((i) => dateRange(i))).toEqual(['300 to 310']);
  });

  it('keeps both of two fields with one key, each with its own key', () => {
    const { items } = assembleTimeline(
      sources([
        page('Twice', 'character', field('born', '10'), field('born', '20')),
        page('Crowned', 'character', field('crowned', '30'), field('crowned', '40')),
      ]),
      [],
    );
    expect(items.map((i) => [i.title, i.dateText])).toEqual([
      ['Twice', '10'],
      ['Twice', '20'],
      ['Crowned', '30'],
      ['Crowned', '40'],
    ]);
    expect(new Set(items.map((i) => i.key)).size).toBe(4);
  });

  it('is not fooled by keys that JavaScript objects already have', () => {
    const { items } = assembleTimeline(sources([page('Odd', 'article', field('constructor', '5'))]), []);
    expect(items.map((i) => i.kind)).toEqual(['other']);
  });

  it('does not call an event undated when its only date has another key', () => {
    const { items, unplaced } = assembleTimeline(sources([page('Crowning', 'event', field('crowned', '30'))]), []);
    expect(items).toHaveLength(1);
    expect(unplaced).toEqual([]);
  });

  it('calls untitled scenes something', () => {
    const { items } = assembleTimeline(sources([], [scene('   ', '1', 1)]), []);
    expect(items[0].title).toBe('Untitled scene');
  });

  it('assembles 2,000 items quickly', () => {
    const pages = Array.from({ length: 2000 }, (_, i) =>
      page(`Event ${i}`, 'event', field('date', `${(i * 7919) % 3000}-${(i % 12) + 1}`)),
    );
    const started = performance.now();
    const { items } = assembleTimeline(sources(pages), []);
    expect(items).toHaveLength(2000);
    expect(performance.now() - started).toBeLessThan(200);
    for (let i = 1; i < items.length; i += 1) {
      expect(items[i].sort).toBeGreaterThanOrEqual(items[i - 1].sort);
    }
  });
});

function item(title: string, sort: number, kind: TimelineKind = 'event'): TimelineItem {
  return { key: title, kind, title, detail: '', dateText: String(sort), sort, link: { kind: 'page', id: title } };
}

describe('filterTimeline', () => {
  const timeline = assembleTimeline(
    sources(
      [
        page('Aria', 'character', field('born', '312')),
        page('Bran', 'character', field('born', 'unknown')),
        page('Vale', 'place', field('founded', '100')),
      ],
      [scene('Opening', '320', 1), scene('Closing', '330', 2)],
    ),
    [],
  );

  it('hides kinds, in both lists', () => {
    const out = filterTimeline(timeline, { hidden: new Set(['birth']), scopes: [] });
    expect(titles(out.items)).toEqual(['Vale', 'Opening', 'Closing']);
    expect(out.unplaced).toEqual([]);
  });

  it('keeps only what is in scope, and what is in every scope', () => {
    const page = { pageIds: new Set(['Aria', 'Bran']), sceneIds: new Set(['Opening']) };
    const out = filterTimeline(timeline, { hidden: new Set(), scopes: [page] });
    expect(titles(out.items)).toEqual(['Aria', 'Opening']);
    expect(titles(out.unplaced)).toEqual(['Bran']);

    const book = { pageIds: new Set(['Aria']), sceneIds: new Set(['Opening', 'Closing']) };
    const both = filterTimeline(timeline, { hidden: new Set(), scopes: [page, book] });
    expect(titles(both.items)).toEqual(['Aria', 'Opening']);
    expect(both.unplaced).toEqual([]);
  });
});

describe('years in the detailed list', () => {
  const items = [item('a', -40.5), item('b', -40), item('c', 12), item('d', 12.04), item('e', 300)];

  it('marks the first item of each year, including years before zero', () => {
    expect(items.map((_, index) => startsNewYear(items, index))).toEqual([true, true, true, false, true]);
  });

  it('finds where a year starts, or the next year that has anything', () => {
    expect(indexOfYear(items, -40)).toBe(1);
    expect(indexOfYear(items, 12)).toBe(2);
    expect(indexOfYear(items, 13)).toBe(4);
    expect(indexOfYear(items, 301)).toBe(-1);
  });
});

describe('zoom', () => {
  it('skips the overview when there is too little to summarize', () => {
    expect(zoomSteps([item('a', 1), item('b', 2)])).toEqual([]);
  });

  it('offers wider steps for wider histories, finest last', () => {
    const items = Array.from({ length: 2000 }, (_, i) => item(`e${i}`, i * 3));
    const steps = zoomSteps(items);
    expect(steps).toEqual([200, 20, 2]);
    const widest = overviewRows(items, steps[0], []);
    expect(widest.length).toBeLessThanOrEqual(30);
  });

  it('still summarizes a short list that covers a long time', () => {
    const items = [10, 12, 300, 310, 900, 905, 1400].map((year) => item(`y${year}`, year));
    const steps = zoomSteps(items);
    expect(steps[0]).toBe(500);
    expect(overviewRows(items, steps[0], []).filter((r) => r.type === 'bucket').length).toBeLessThanOrEqual(6);
  });

  it('stops at single years', () => {
    expect(zoomSteps([item('a', 5), item('b', 5.02), item('c', 6)])).toEqual([1]);
  });

  it('counts each item once, by kind, in the right bucket', () => {
    const rows = overviewRows(
      [item('a', 301), item('b', 305, 'birth'), item('c', 309, 'birth'), item('d', 311)],
      10,
      [],
    );
    expect(rows).toEqual([
      {
        type: 'bucket',
        from: 300,
        to: 310,
        label: '300 to 309',
        count: 3,
        byKind: { event: 1, birth: 2 },
        titles: ['a', 'b', 'c'],
      },
      { type: 'bucket', from: 310, to: 320, label: '310 to 319', count: 1, byKind: { event: 1 }, titles: ['d'] },
    ]);
  });

  it('marks stretches where nothing happens', () => {
    const rows = overviewRows([item('a', 301), item('b', 355)], 10, []);
    expect(rows.map((r) => (r.type === 'gap' ? `gap ${r.years}` : r.label))).toEqual([
      '300 to 309',
      'gap 40',
      '350 to 359',
    ]);
  });

  it('labels single years in their era', () => {
    const rows = overviewRows([item('a', -40)], 1, [{ name: 'BE', offset: 0, negative: true }]);
    expect(rows[0].type === 'bucket' && rows[0].label).toBe('40 BE');
  });
});

describe('a custom calendar', () => {
  const calendar = { months: [{ name: 'Thawing', days: 30 }, { name: 'Frostmoot', days: 30 }] };

  it('orders named months with everything else', () => {
    const { items, unplaced } = assembleTimeline(
      sources(
        [page('Feast', 'event', field('date', '312-01-20')), page('Aria', 'character', field('born', 'Frostmoot 290'))],
        [scene('Late', '15 Frostmoot 312', 2), scene('Early', '3 Thawing 312', 1), scene('Plain', '312', 3)],
      ),
      [],
      calendar,
    );
    expect(unplaced).toEqual([]);
    expect(titles(items)).toEqual(['Aria', 'Plain', 'Early', 'Feast', 'Late']);
  });

  it('cannot place a named month without it, or a day the month lacks, and says why', () => {
    const noCalendar = assembleTimeline(sources([], [scene('Late', '15 Frostmoot 312', 1)]), []);
    expect(titles(noCalendar.unplaced)).toEqual(['Late']);
    const tooLate = assembleTimeline(sources([], [scene('Late', '31 Frostmoot 312', 1)]), [], calendar);
    expect(tooLate.unplaced[0].reason).toContain('Frostmoot has 30 days');
  });
});

describe('changes during the story', () => {
  const changing = (changes: InfoboxField['changes'], kind: InfoboxField['kind'] = 'text'): InfoboxField => ({
    key: 'rank', label: 'Rank', kind, value: 'Squire', changes,
  });

  it('get an entry at their own date, among everything else', () => {
    const { items } = assembleTimeline(
      sources([page('Aria', 'character', changing([{ date: '312', value: 'Knight' }]))], [scene('A', '300', 1), scene('B', '320', 2)]),
      [],
    );
    expect(items.map((i) => [i.title, i.kind, i.detail, i.dateText])).toEqual([
      ['A', 'scene', 'Book One, Chapter 1', '300'],
      ['Aria', 'change', 'Rank: Knight', '312'],
      ['B', 'scene', 'Book One, Chapter 1', '320'],
    ]);
    expect(items[1].link).toEqual({ kind: 'page', id: 'Aria' });
  });

  it('take the date of their scene if they have none', () => {
    const { items } = assembleTimeline(
      sources([page('Aria', 'character', changing([{ nodeId: 'A', value: 'Knight' }]))], [scene('A', '300', 1)]),
      [],
    );
    expect(items.find((i) => i.kind === 'change')?.dateText).toBe('300');
  });

  it('fall back on their scene if their own date cannot be read', () => {
    const { items, unplaced } = assembleTimeline(
      sources([page('Aria', 'character', changing([{ nodeId: 'A', date: 'the long winter', value: 'Knight' }]))], [scene('A', '300', 1)]),
      [],
    );
    expect(items.find((i) => i.kind === 'change')?.dateText).toBe('300');
    expect(unplaced).toEqual([]);
  });

  it('leave a scene with an unreadable date to report that itself', () => {
    const { unplaced } = assembleTimeline(
      sources([page('Aria', 'character', changing([{ nodeId: 'A', value: 'Knight' }]))], [scene('A', 'the long winter', 1)]),
      [],
    );
    expect(unplaced.map((u) => u.kind)).toEqual(['scene']);
  });

  it('keep their keys apart when two fields share a key', () => {
    const { items } = assembleTimeline(
      sources([page('Aria', 'character', changing([{ date: '1', value: 'A' }]), changing([{ date: '2', value: 'B' }]))]),
      [],
    );
    expect(new Set(items.map((i) => i.key)).size).toBe(2);
  });

  it('are left out with no date to go on, and reported when the date cannot be read', () => {
    const { items, unplaced } = assembleTimeline(
      sources([page('Aria', 'character', changing([{ nodeId: 'gone', value: 'Knight' }, { value: 'Lord' }, { date: 'the long winter', value: 'King' }]))]),
      [],
    );
    expect(items).toEqual([]);
    expect(unplaced.map((u) => [u.kind, u.detail, u.dateText])).toEqual([['change', 'Rank: King', 'the long winter']]);
  });

  it('work on any kind of field, and leave the field itself alone', () => {
    const { items } = assembleTimeline(
      sources([page('Aria', 'character', { ...changing([{ date: '312', value: 'Dark Harbor' }], 'page'), key: 'location', label: 'Home' })]),
      [],
    );
    expect(items.map((i) => [i.kind, i.detail])).toEqual([['change', 'Home: Dark Harbor']]);
  });
});
