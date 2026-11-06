import type { Calendar } from '../lib/storyDate';
import type { Infobox, InfoboxField, NodeMeta } from '../lib/types';
import { historySteps, historyText, whenOf } from './history';
import { factLines, factsForPrompt, promptMoment, wholeStoryMoment } from './prompt';
import { fieldsAsOf } from './InfoboxFacts';
import { ageText, keyFacts } from './sceneFacts';
import { buildStoryIndex, chapterEndMoment, momentOf, nodeLabel, sceneCount, sceneMoment, type StoryIndex } from './storyIndex';

let position = 0;

function node(id: string, kind: NodeMeta['kind'], parentId: string | null, storyDate = '', title = id, bookId = 'b1'): NodeMeta {
  position += 1;
  return {
    id, bookId, parentId, kind, title, position, status: 'draft', povPageId: null, locationPageId: null, synopsis: '', wordCount: 0,
    targetWords: 0, storyDate, createdAt: '', updatedAt: '', deletedAt: null,
  };
}

const calendar: Calendar = { months: [{ name: 'Thawing', days: 30 }, { name: 'Frostmoot', days: 30 }] };

function story(extra: { secondBook?: boolean } = {}): StoryIndex {
  const trees = new Map<string, NodeMeta[]>([
    ['b1', [
      node('Chapter 1', 'chapter', null),
      node('s1', 'scene', 'Chapter 1', '300', 'Scene 1'),
      node('s2', 'scene', 'Chapter 1', '305', 'Scene 2'),
      node('Chapter 2', 'chapter', null),
      node('s3', 'scene', 'Chapter 2', '310', 'Scene 1'),
      node('s4', 'scene', 'Chapter 2', '', 'Scene 2'),
      node('Chapter 3', 'chapter', null),
      node('s5', 'scene', 'Chapter 3', '15 Frostmoot 320', 'Scene 1'),
      node('s6', 'scene', 'Chapter 3', '290', 'Flashback'),
      node('Chapter 4', 'chapter', null),
    ]],
    ['b2', [
      node('Chapter 5', 'chapter', null, '', 'Chapter 1', 'b2'),
      node('s7', 'scene', 'Chapter 5', '330', 'Scene 1', 'b2'),
    ]],
  ]);
  const books = extra.secondBook
    ? [{ id: 'b2', title: 'Book Two', position: 1 }, { id: 'b1', title: 'Book One', position: 0 }]
    : [{ id: 'b1', title: 'Book One', position: 0 }];
  return buildStoryIndex(books, (id) => trees.get(id) ?? [], { eras: [], calendar });
}

function hair(changes: InfoboxField['changes']): InfoboxField {
  return { key: 'hair', label: 'Hair', kind: 'text', value: 'blonde', changes };
}

function box(...fields: InfoboxField[]): { infobox: Infobox } {
  return { infobox: { fields } };
}

describe('the story index', () => {
  it('walks the books in order, whatever order they arrive in', () => {
    const index = story({ secondBook: true });
    expect(index.scenes.map((s) => s.id)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7']);
    expect(index.chapters.map((c) => c.id)).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3', 'Chapter 4', 'Chapter 5']);
    expect(index.order.get('s1')!).toBeLessThan(index.order.get('s2')!);
    expect(index.order.get('s6')!).toBeLessThan(index.order.get('s7')!);
  });

  it('names a first scene by its chapter and a later one in full', () => {
    const index = story();
    expect(nodeLabel(index, 's3')).toBe('Chapter 2');
    expect(nodeLabel(index, 's4')).toBe('Chapter 2, Scene 2');
    expect(nodeLabel(index, 'Chapter 2')).toBe('Chapter 2');
    expect(nodeLabel(index, 'gone')).toBeNull();
  });

  it('names the book only when there are several', () => {
    const index = story({ secondBook: true });
    expect(nodeLabel(index, 's7')).toBe('Book Two, Chapter 1');
    expect(nodeLabel(index, 's3')).toBe('Book One, Chapter 2');
  });

  it('gives a scene its own moment', () => {
    const index = story();
    expect(sceneMoment(index, 's3')).toEqual({ nodeOrder: index.order.get('s3'), dateSort: 310 });
    expect(sceneMoment(index, 's1').dateInferred).toBeUndefined();
    expect(sceneMoment(index, 's4', '311')).toEqual({ nodeOrder: index.order.get('s4'), dateSort: 311 });
    expect(sceneMoment(index, 'gone')).toEqual({ nodeOrder: null, dateSort: null });
  });

  it('lets a scene with no date take the latest date before it, marked as such', () => {
    const index = story();
    expect(sceneMoment(index, 's4')).toEqual({ nodeOrder: index.order.get('s4'), dateSort: 310, dateInferred: true });
    expect(sceneMoment(index, 's4', 'the long winter').dateSort).toBe(310);
    // After a flashback, the story has still reached its latest date.
    const trees: NodeMeta[] = [
      node('late', 'scene', null, '320'),
      node('back', 'scene', null, '290'),
      node('then', 'scene', null, ''),
    ];
    const told = buildStoryIndex([{ id: 'b1', title: 'B', position: 0 }], () => trees, { eras: [], calendar: null });
    expect(sceneMoment(told, 'then').dateSort).toBe(320);
  });

  it('has no date before any scene has one', () => {
    const trees: NodeMeta[] = [node('a', 'scene', null), node('b', 'scene', null, '300')];
    const told = buildStoryIndex([{ id: 'b1', title: 'B', position: 0 }], () => trees, { eras: [], calendar: null });
    expect(sceneMoment(told, 'a')).toEqual({ nodeOrder: told.order.get('a'), dateSort: null });
  });

  it('gives a chapter its end, at the latest date any scene in it reaches', () => {
    const index = story();
    expect(chapterEndMoment(index, 'Chapter 2')).toEqual({ nodeOrder: index.order.get('s4'), dateSort: 310 });
    // The flashback closing Chapter 3 does not undo it.
    expect(chapterEndMoment(index, 'Chapter 3').dateSort).toBeCloseTo(320.0215, 8);
    expect(chapterEndMoment(index, 'Chapter 3').nodeOrder).toBe(index.order.get('s6'));
    const empty = chapterEndMoment(index, 'Chapter 4');
    expect(empty.nodeOrder).toBe(index.order.get('Chapter 4'));
    expect(empty.dateSort).toBeCloseTo(320.0215, 8);
    expect(empty.dateInferred).toBe(true);
    expect(chapterEndMoment(index, 'gone')).toEqual({ nodeOrder: null, dateSort: null });
  });

  it('chooses the right kind of moment for a node', () => {
    const index = story();
    expect(momentOf(index, 's1').dateSort).toBe(300);
    expect(momentOf(index, 'Chapter 1').dateSort).toBe(305);
  });

  it('counts the scenes read by a point', () => {
    const index = story();
    expect(sceneCount(index, 's1')).toEqual({ scene: 1, of: 6 });
    expect(sceneCount(index, 's3')).toEqual({ scene: 3, of: 6 });
    expect(sceneCount(index, 'Chapter 2')).toEqual({ scene: 4, of: 6 });
    expect(sceneCount(index, 'gone')).toBeNull();
  });
});

describe('the history of a field', () => {
  const index = story();
  const names = { resolve: index.resolve, nodeLabel: (id: string) => nodeLabel(index, id) };

  it('reads as a sentence', () => {
    expect(historyText(hair([{ nodeId: 's3', value: 'black' }]), names)).toBe('blonde, then black from Chapter 2');
    expect(historyText(hair(undefined), names)).toBe('blonde');
  });

  it('goes in story order, with the date and any note', () => {
    const field = hair([
      { nodeId: 's5', date: '15 Frostmoot 320', value: 'grey', note: 'Age' },
      { nodeId: 's3', value: 'black' },
    ]);
    expect(historyText(field, names)).toBe('blonde, then black from Chapter 2, then grey from Chapter 3 (15 Frostmoot 320) (Age)');
  });

  it('starts with the first change if the field starts empty', () => {
    const field = { ...hair([{ date: '320', value: 'grey' }]), value: '' };
    expect(historyText(field, names)).toBe('grey from 320');
  });

  it('says when nothing places a change', () => {
    expect(historyText(hair([{ value: 'black' }]), names)).toBe('blonde, then black (not yet placed in the story)');
    expect(historySteps(hair([{ value: 'black' }]), names)[0].from).toBeNull();
  });

  it('puts when into words', () => {
    expect(whenOf({ value: 'x' }, names.nodeLabel)).toBeNull();
    expect(whenOf({ value: 'x', date: ' 312 ' }, names.nodeLabel)).toBe('312');
    expect(whenOf({ value: 'x', nodeId: 's3' }, names.nodeLabel)).toBe('Chapter 2');
    expect(whenOf({ value: 'x', nodeId: 's3', date: '312' }, names.nodeLabel)).toBe('Chapter 2 (312)');
    expect(whenOf({ value: 'x', nodeId: 'gone', date: '312' }, names.nodeLabel)).toBe('312');
  });
});

describe('factsForPrompt', () => {
  const index = story();
  const changing = box(
    hair([{ nodeId: 's3', value: 'black', note: 'Dyed it to hide' }, { nodeId: 's5', value: 'grey' }]),
    { key: 'species', label: 'Species', kind: 'page', value: 'Human' },
  );

  it('keeps plain lines for a page that never changes, the same at every point', () => {
    const page = box({ key: 'species', label: 'Species', kind: 'page', value: 'Human' }, { key: 'x', label: 'Empty', kind: 'text', value: '' });
    expect(factsForPrompt(page)).toBe('Species: Human');
    expect(factsForPrompt(page, promptMoment(index, 's1'))).toBe('Species: Human');
    expect(factsForPrompt(page, promptMoment(index, 's5'))).toBe('Species: Human');
    expect(factsForPrompt(page, wholeStoryMoment(index))).toBe('Species: Human');
    expect(factsForPrompt({ infobox: null })).toBe('');
  });

  it('gives the value as of the scene, with its reading order and date', () => {
    const lines = factLines(changing, promptMoment(index, 's3'));
    expect(lines[0]).toBe('Facts as of Chapter 2 (scene 3 of 6 in reading order, in-world date 310):');
    expect(lines[1]).toContain('Hair: black.');
    expect(lines[1]).toContain('Changed during the story: blonde at first, then black from Chapter 2 (Dyed it to hide).');
    expect(lines[2]).toBe('Species: Human');
  });

  it('gives the starting value before any change, and says what is to come', () => {
    const lines = factLines(changing, promptMoment(index, 's1'));
    expect(lines[1]).toContain('Hair: blonde.');
    expect(lines[1]).not.toContain('Changed during the story');
    expect(lines[1]).toContain('Later, and not yet true here: black from Chapter 2, then grey from Chapter 3.');
  });

  it('leaves out what comes later under a spoiler limit', () => {
    const text = factsForPrompt(changing, promptMoment(index, 's1', { omitLater: true }));
    expect(text).toContain('Hair: blonde.');
    expect(text).not.toContain('black');
    expect(text).not.toContain('grey');
  });

  it('gives the whole history when there is no point in the story', () => {
    expect(factsForPrompt(changing, wholeStoryMoment(index))).toBe(
      'Hair: blonde, then black from Chapter 2 (Dyed it to hide), then grey from Chapter 3\nSpecies: Human',
    );
  });

  it('gives what it can with no story to go on', () => {
    expect(factsForPrompt(box(hair([{ date: '312', value: 'black' }, { nodeId: 'x', value: 'grey' }])))).toBe(
      'Hair: blonde, then black from 312, then grey',
    );
  });

  it('says a field has no value yet, if that is so', () => {
    const rank: InfoboxField = { key: 'rank', label: 'Rank', kind: 'text', value: '', changes: [{ nodeId: 's3', value: 'Knight' }] };
    expect(factsForPrompt(box(rank), promptMoment(index, 's1'))).toContain('Rank: not set yet.');
    expect(factsForPrompt(box(rank), promptMoment(index, 's3'))).toContain('Rank: Knight.');
    expect(factsForPrompt(box(rank), promptMoment(index, 's1', { omitLater: true }))).not.toContain('Rank');
  });

  it('works out the age at the scene in place of a typed one', () => {
    const page = box(
      { key: 'born', label: 'Born', kind: 'date', value: '290' },
      { key: 'age', label: 'Age', kind: 'number', value: '99' },
    );
    const text = factsForPrompt(page, promptMoment(index, 's3'));
    expect(text).toContain('Facts as of Chapter 2');
    expect(text).toContain('Age at this point: 20.');
    expect(text).toContain('Born: 290');
    expect(text).not.toContain('99');
    expect(factsForPrompt(page)).toContain('Age: 99');
  });

  it('says when someone has died or is not born yet', () => {
    const page = box(
      { key: 'born', label: 'Born', kind: 'date', value: '302' },
      { key: 'died', label: 'Died', kind: 'date', value: '309' },
    );
    expect(factsForPrompt(page, promptMoment(index, 's1'))).toContain('Not born yet at this point (born 302).');
    expect(factsForPrompt(page, promptMoment(index, 's3'))).toContain('Died in 309, aged 7, so not alive at this point.');
    expect(factsForPrompt(page, promptMoment(index, 's2'))).toContain('Age at this point: 3.');
  });

  it('hides a death still to come under a spoiler limit', () => {
    const page = box(
      { key: 'born', label: 'Born', kind: 'date', value: '290' },
      { key: 'died', label: 'Died', kind: 'date', value: '309' },
    );
    expect(factsForPrompt(page, promptMoment(index, 's2'))).toContain('Died: 309');
    expect(factsForPrompt(page, promptMoment(index, 's2', { omitLater: true }))).not.toContain('309');
    expect(factsForPrompt(page, promptMoment(index, 's3', { omitLater: true }))).toContain('309');
  });

  it('gives a chapter as a point in the story too', () => {
    const lines = factLines(changing, promptMoment(index, 'Chapter 2'));
    expect(lines[0]).toBe('Facts as of Chapter 2 (scene 4 of 6 in reading order, in-world date 310):');
    expect(lines[1]).toContain('Hair: black.');
  });
});

describe('the infobox as of a point in the story', () => {
  const index = story();
  const fields: InfoboxField[] = [
    { key: 'born', label: 'Born', kind: 'date', value: '290' },
    { key: 'died', label: 'Died', kind: 'date', value: '309' },
    { key: 'age', label: 'Aged', kind: 'number', value: '99' },
    hair([{ nodeId: 's3', value: 'black' }]),
  ];
  const view = (at: string) => fieldsAsOf(fields, chapterEndMoment(index, at), index.resolve, index.dates);

  it('gives the value then, with no changes left to draw', () => {
    const shown = view('Chapter 1');
    expect(shown.find((f) => f.key === 'hair')).toEqual({ key: 'hair', label: 'Hair', kind: 'text', value: 'blonde' });
  });

  it('works out the age, in place of a typed one, right after the birth date', () => {
    expect(view('Chapter 1').map((f) => [f.key, f.label, f.value])).toEqual([
      ['born', 'Born', '290'],
      ['age', 'Aged', '15'],
      ['hair', 'Hair', 'blonde'],
    ]);
  });

  it('leaves out a death still to come, and shows it once it has happened', () => {
    expect(view('Chapter 1').some((f) => f.key === 'died')).toBe(false);
    expect(view('Chapter 2').map((f) => f.key)).toEqual(['born', 'died', 'hair']);
    expect(view('Chapter 2').find((f) => f.key === 'hair')?.value).toBe('black');
  });

  it('says so before they are born', () => {
    const later: InfoboxField[] = [{ key: 'born', label: 'Born', kind: 'date', value: '400' }];
    expect(fieldsAsOf(later, chapterEndMoment(index, 'Chapter 1'), index.resolve, index.dates)).toEqual([
      { key: 'born', label: 'Born', kind: 'date', value: '400' },
      { key: 'age', label: 'Age', kind: 'text', value: 'not born yet' },
    ]);
  });

  it('never works out an age from a date it inferred, and keeps a typed one then', () => {
    const shown = fieldsAsOf(
      [{ key: 'born', label: 'Born', kind: 'date', value: '290' }, { key: 'age', label: 'Age', kind: 'number', value: '30' }],
      chapterEndMoment(index, 'Chapter 4'),
      index.resolve,
      index.dates,
    );
    expect(shown.find((f) => f.key === 'age')?.value).toBe('30');
  });
});

describe('key facts beside a scene', () => {
  const index = story();
  const names = { resolve: index.resolve, nodeLabel: (id: string) => nodeLabel(index, id) };
  const fields: InfoboxField[] = [
    { key: 'born', label: 'Born', kind: 'date', value: '290' },
    { key: 'species', label: 'Species', kind: 'page', value: 'Human' },
    { key: 'bio', label: 'Bio', kind: 'longtext', value: 'A long story' },
    { key: 'empty', label: 'Empty', kind: 'text', value: '' },
    hair([{ nodeId: 's3', value: 'black' }]),
  ];

  it('shows changed facts first, as of the scene, and leaves out what the age covers', () => {
    const moment = sceneMoment(index, 's3');
    const facts = keyFacts(fields, moment, names, { state: 'alive', years: 20 });
    expect(facts.map((f) => [f.key, f.value, f.since])).toEqual([
      ['hair', 'black', 'since Chapter 2'],
      ['species', 'Human', null],
    ]);
    expect(keyFacts(fields, sceneMoment(index, 's1'), names, { state: 'alive', years: 10 })[0]).toEqual({
      key: 'hair', label: 'Hair', value: 'blonde', since: null,
    });
  });

  it('keeps a typed age only when nothing better takes its place', () => {
    const typed: InfoboxField[] = [{ key: 'age', label: 'Age', kind: 'number', value: '30' }];
    expect(keyFacts(typed, { nodeOrder: 1 }, names, { state: 'unknown' }).map((f) => f.key)).toEqual(['age']);
    expect(keyFacts(typed, { nodeOrder: 1 }, names, { state: 'alive', years: 3 })).toEqual([]);
  });

  it('shows at most a few', () => {
    const many = Array.from({ length: 10 }, (_, i): InfoboxField => ({ key: `k${i}`, label: `K${i}`, kind: 'text', value: 'v' }));
    expect(keyFacts(many, { nodeOrder: 1 }, names, { state: 'unknown' })).toHaveLength(6);
  });

  it('puts the age into words', () => {
    const at = sceneMoment(index, 's5');
    expect(ageText(fields, at, index.resolve, index.dates)).toBe('Age 30');
    expect(ageText([], at, index.resolve, index.dates)).toBeNull();
    expect(ageText([{ key: 'born', label: 'Born', kind: 'date', value: '330' }], at, index.resolve, index.dates)).toBe('Not born yet (born 330)');
    const dead: InfoboxField = { key: 'died', label: 'Died', kind: 'date', value: '312' };
    expect(ageText([fields[0], dead], at, index.resolve, index.dates)).toBe('Died in 312, aged 22');
    expect(ageText(fields, sceneMoment(index, 's4'), index.resolve, index.dates)).toBeNull();
  });
});
